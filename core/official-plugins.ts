/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectOfficialFiles, installOfficialFiles, replaceOfficialFiles, uninstallOfficialFiles } from "./official-package-files.ts";
import { ensureCachedPackage, ensureOfficialPackage } from "./official-package-download.ts";
import { compareVersions as compare, compatibleHostFloor, stableVersion } from "./package-host-range.ts";
import type { Runtime } from "./runtime.ts";
import { readPackageInstalls, recordPackageInstalls, type CommunityInstallReceipt, type OfficialInstallReceipt } from "./community-install-receipts.ts";

export type PackageRelease = {
  version: string; hostRange: string; platform: string; arch: string; sha256: string;
  assetUrl?: string; sizeBytes?: number; inventorySha256?: string;
  composition?: Pick<Parameters<typeof import("./official-package-composition.ts").ensureComposedOfficialPackage>[1], "packagePart" | "zipPart"> & { name: string; version: string };
  dependencies: Record<string, string>; bundledPluginIds?: string[]; recognitionOnly?: boolean;
};
type Release = PackageRelease;
export type PackageEntry = { id: string; name: string; repository: string; parentId: string | null; requiredPlugins: string[]; preserve?: string[]; verifiedReleases: Release[];
  community?: boolean; readInventory?: (sha256: string) => Promise<Buffer> };
type Entry = PackageEntry;
type InstalledBuild = { runtimeId: string; version: string; platform: string; arch: string; sha256: string; sourceCommit: string };
type Card = { id: string; description: string; installation: string };
type CommunityPolicy = {
  available(root: string, id: string): Promise<void>;
  verify(root: string, entry: Entry, release: Release): Promise<void>;
};
type Step = { action: "install" | "enable" | "reuse" | "uninstall" | "update"; id: string; name: string; version: string };
type Item = { entry: Entry; pathId: string; eligible: Release[]; target?: Release; existing?: Release; installedVersion?: string; installed: boolean; reason: string; enabled: boolean; active: boolean; inventoryUnavailable?: boolean };
const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const registry: { plugins: Entry[]; installedBuilds?: InstalledBuild[] } = read("../market/official-releases.json");
const cards: Card[] = read("../market/catalog.json").official;
const hostVersion: string = read("../package.json").version;
type Requirement = { version: string; minimum: boolean };
const satisfies = (version: string, required: Requirement) => version === required.version ||
  (required.minimum && stableVersion.test(required.version) && compare(version, required.version) > 0);

const parentOf = (pathId: string) => pathId.split("/").slice(0, -1).join("/");

function dependencyOrder(root: Item, items: Map<string, Item>, updating: boolean) {
  const ordered = new Map<Item, Map<string, Item>>(), visiting = new Set<Item>();
  const byPath = new Map([...items.values()].map(item => [item.pathId, item]));
  function visit(part: Item) {
    if (ordered.has(part)) return;
    if (visiting.has(part)) throw Error("发行清单包含循环依赖。");
    visiting.add(part);
    // Installed releases can predate changes to the current catalog's required plugins.
    const ids = part.existing && !(updating && part === root)
      ? Object.keys(part.existing.dependencies) : part.entry.requiredPlugins;
    const dependencies = new Map<string, Item>();
    for (const id of ids) {
      const dependency = items.get(id) ?? byPath.get(id);
      if (!dependency) throw Error("发行清单缺少依赖版本：" + id);
      dependencies.set(id, dependency);
      visit(dependency);
    }
    visiting.delete(part);
    ordered.set(part, dependencies);
  }
  visit(root);
  return [...ordered];
}
const spec = (item: Item, release: Release) => ({ directory: "plugins/" + item.pathId.split("/").join("/sub/"),
  sha256: release.sha256, recognitionOnly: release.recognitionOnly, preserve: item.entry.preserve });
function inventorySpec(item: Item, release: Release) {
  const files = spec(item, release);
  return release.inventorySha256 ? { ...files, sha256: release.inventorySha256, recognitionOnly: true } : files;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const releaseFor = (part: Item, version: string) => part.existing?.version === version ? part.existing : part.eligible.find(r => r.version === version)!;

export class PluginPackages {
  private communityReceipts = new Map<string, CommunityInstallReceipt>();
  private officialReceipts = new Map<string, OfficialInstallReceipt>();
  private receiptError = "";
  private runtime: Runtime;
  private entries: Entry[];
  private installedBuilds: InstalledBuild[];
  private cards: Card[];
  private community?: CommunityPolicy;
  constructor(runtime: Runtime, entries = registry.plugins, installedBuilds = registry.installedBuilds ?? [],
    catalogCards = cards, community?: CommunityPolicy) {
    this.runtime = runtime;
    this.entries = entries;
    this.installedBuilds = installedBuilds;
    this.cards = catalogCards;
    this.community = community;
  }

  private async inspect(entry: Entry, updating: boolean): Promise<Item> {
    const runtime = this.runtime;
    const pathId = entry.parentId ? entry.parentId + "/" + entry.id : entry.id;
    const record = runtime.records.get(pathId);
    const releases = entry.verifiedReleases.filter(r => (r.platform === process.platform || (entry.community && r.platform === "any")) &&
      (r.arch === process.arch || (entry.community && r.arch === "any")))
      .sort((a, b) => compare(b.version, a.version) || compare(
        compatibleHostFloor(b.hostRange, hostVersion) ?? "", compatibleHostFloor(a.hostRange, hostVersion) ?? ""));
    const eligible = releases.filter(r => !r.recognitionOnly && compatibleHostFloor(r.hostRange, hostVersion));
    const target = eligible[0];
    const item: Item = { entry, pathId, eligible, target, installedVersion: record?.manifest.version, installed: !!record,
      enabled: runtime.pluginState.enabled(pathId), active: record?.status === "active", reason: "" };
    const candidates = record ? releases.filter(r => r.version === item.installedVersion) : target ? [target] : [];
    const official = !entry.community && this.officialReceipts.get(pathId);
    if (official && record && official.version === record.manifest.version && official.repository === entry.repository &&
        official.platform === process.platform && official.arch === process.arch) {
      // A receipt restores offline ownership only, never a target or URL for installing into an empty directory.
      // The cached archive and every installed program file must still match its pinned digest below.
      item.entry = {...entry, preserve:[...new Set([...(entry.preserve ?? []), ...official.preserve])]};
      const reviewed = candidates.find(r => r.sha256 === official.sha256);
      candidates.push({version:official.version, hostRange:reviewed?.hostRange ?? official.hostRange ?? "",
        platform:official.platform, arch:official.arch,
        sha256:official.sha256, dependencies:official.dependencyVersions ?? {}, bundledPluginIds:official.bundledPluginIds});
    }
    const receipt = entry.community && this.communityReceipts.get(pathId);
    const repository = record?.manifest.repository;
    const sameRepository = repository == null || (typeof repository === "string" &&
      repository.replace(/\/$/, "").toLowerCase() === entry.repository.replace(/\/$/, "").toLowerCase());
    if (updating && entry.community && !sameRepository) {
      item.reason = "已安装插件声明的仓库与社区审核记录不同，请核对来源。";
      return item;
    }
    if (updating && record) {
      const historical = {version: record.manifest.version, platform: process.platform, arch: process.arch, hostRange: "", dependencies: {}};
      if (receipt && receipt.version === item.installedVersion) {
        // A review may retain only the newest version. A receipt pins the package that actually ran here.
        const approved = candidates.filter(r => r.sha256 === receipt.sha256);
        candidates.splice(0, candidates.length, ...approved);
        if (!approved.length) candidates.push({...historical, sha256: receipt.sha256,
          hostRange:receipt.hostRange ?? "", dependencies:receipt.dependencyVersions ?? {}});
      }
      for (const build of this.installedBuilds) {
        if (build.runtimeId === pathId && build.platform === process.platform && build.arch === process.arch &&
            build.version === item.installedVersion) candidates.push({...historical, sha256: build.sha256, recognitionOnly: true});
      }
    }
    if (!candidates.length) {
      item.reason = record ? "当前安装版本未匹配已验证的发行包，无法确认程序文件归属。"
        : releases.length ? "此插件没有适用于当前 WhaleLife 版本的发行包。" : "此平台还没有验证过的发行包。";
      return item;
    }
    if (entry.community && !record) {
      try { await this.community!.available(runtime.root, pathId); }
      catch (error) { item.reason = errorText(error); }
      return item;
    }
    for (const release of candidates) try {
      let candidate = release;
      const ownership = inventorySpec(item, release);
      let inspection = await inspectOfficialFiles(runtime.root, ownership);
      if (ownership.recognitionOnly && inspection.state === "blocked" && inspection.reason?.includes("ENOENT")) {
        if (release.inventorySha256 && !release.recognitionOnly) {
          candidate = {...release, inventorySha256: undefined};
          inspection = await inspectOfficialFiles(runtime.root, spec(item, candidate));
        }
        // Only a reviewed update operation can provide a reader, and only an already installed
        // version needs a remote inventory. Store it for confirmation and offline crash recovery.
        if (record && entry.readInventory && (candidate === release || inspection.reason === "尚未取得已验证的发行包")) {
          try {
            const bytes = await entry.readInventory(ownership.sha256);
            await ensureCachedPackage(runtime.root, {sha256:ownership.sha256, sizeBytes:bytes.length},
              write => write(bytes), ".inventory.json");
          } catch (error) {
            item.inventoryUnavailable = true;
            throw error;
          }
          candidate = release;
          inspection = await inspectOfficialFiles(runtime.root, ownership);
        }
      }
      if (updating && record && entry.community && candidate.assetUrl &&
          (receipt ? receipt.sha256 === candidate.sha256 : new Set(candidates.map(r => r.sha256)).size === 1) &&
          inspection.reason === "尚未取得已验证的发行包") {
        // A receipt or a single reviewed hash for the installed version identifies the archive to fetch.
        // apply checks the complete on-disk inventory again before stopping the old version.
        item.existing = candidate;
        item.reason = "";
        break;
      }
      if (updating && !record && candidate.assetUrl && inspection.reason === "尚未取得已验证的发行包") {
        // A newer, approved dependency may have no bundled inventory or local archive yet.
        // Its verified package is acquired before mutation; installOfficialFiles checks the destination then.
        item.reason = "";
        break;
      }
      if (inspection.state === "installed") {
        item.installed = true;
        item.installedVersion = candidate.version;
        item.existing = candidate;
        item.reason = "";
        break;
      } else if (inspection.state === "blocked") item.reason = inspection.reason || "无法确认发行包的程序文件。";
      else if (record) item.reason = "运行中的记录与磁盘文件不一致，请重新扫描后再操作。";
    } catch (error) { item.reason = errorText(error); }
    return item;
  }

  private dependents(item: Item, restored?: Item) {
    const runtime = this.runtime, owned = new Set([item.pathId, ...(item.existing?.bundledPluginIds ?? [])]);
    const services = new Set([item.entry.id]);
    if (!item.pathId.includes("/"))
      for (const name of runtime.records.get(item.pathId)?.provided ?? []) services.add(name);
    const result = new Set<string>();
    for (const record of runtime.records.values()) {
      if (record.manifest.builtin || owned.has(record.id)) continue;
      const stored = this.communityReceipts.get(record.id) ?? this.officialReceipts.get(record.id);
      const receipt = stored?.version === record.manifest.version ? stored : undefined;
      if (receipt?.dependencies.includes(item.pathId)) {
        result.add(receipt.name);
        continue;
      }
      const declared = this.entries.find(e => (e.parentId ? e.parentId + "/" + e.id : e.id) === record.id);
      // The restored release may predate a dependency just added in the new catalog metadata.
      const needs = restored && restored.pathId === record.id ? Object.hasOwn(restored.existing!.dependencies, item.entry.id) :
        !receipt && declared?.requiredPlugins.includes(item.entry.id);
      if (record.id.startsWith(item.pathId + "/") || needs ||
          [...(record.manifest.depends ?? []), ...(record.dependencies ?? [])].some(n => services.has(n)))
        result.add(declared?.name ?? record.manifest.name ?? record.id);
    }
    return [...result];
  }

  private plan(item: Item, items: Map<string, Item>, updateVersion?: string) {
    const steps: Step[] = [];
    let reason = item.reason, upgradeUrl = "";
    const card = this.cards.find(card => card.id === item.entry.id);
    const add = (part: Item, action: Step["action"], release: Release) =>
      steps.push({ id: part.entry.id, name: part.entry.name, version: release.version, action });
    const update = updateVersion !== undefined;
    const selected = update ? item.eligible.find(r => r.version === updateVersion) : item.target;
    if (update) {
      if (!item.installed || !item.existing) reason ||= "无法确认已安装的程序文件归属，保留当前版本。";
      else if (!selected || compare(selected.version, item.installedVersion!) <= 0) reason = "没有此已审核且适合本机的新版。";
      else reason ||= this.reverseConstraint(item, selected, items);
    }
    if (!update && item.installed && item.existing) {
      const used = this.dependents(item);
      if (this.receiptError) reason = this.receiptError;
      else if (used.length) reason = "请先卸载依赖它的插件：" + used.join("、") + "。";
      if (!reason) add(item, "uninstall", item.existing);
    } else if (!reason && selected) {
      try {
        const requirements = new Map<Item, Requirement[]>();
        // Gather all consumers' constraints before choosing a shared dependency's release.
        for (const [part, dependencies] of dependencyOrder(item, items, update).reverse()) {
          const replacing = update && part === item;
          const required = requirements.get(part) ?? [];
          const installed = part.installedVersion;
          const mismatch = installed && required.find(r => !satisfies(installed, r));
          if (mismatch) {
            upgradeUrl = this.cards.find(c => c.id === part.entry.id)?.installation ?? part.entry.repository;
            const instruction = compare(installed, mismatch.version) < 0 ? "请先升级" + part.entry.name + "至 " + mismatch.version + (mismatch.minimum ? " 或更高版本" : " 版本")
              : part.entry.name + "与本插件的已验证组合要求 " + mismatch.version;
            throw Error(instruction + "（当前 " + installed + "）。");
          }
          const release = replacing ? selected : part.installed ? part.existing
            : part.eligible.find(r => required.every(rule => satisfies(r.version, rule)));
          if (part.reason || !release) throw Error(part.entry.name + "：" + (part.reason || "没有同时符合依赖要求的已验证发行包。"));
          if (part.installed && !compatibleHostFloor(release.hostRange, hostVersion))
            throw Error(part.entry.name + "的已安装版本尚未验证适用于当前 WhaleLife。");
          if (!replacing && part.installed && part.enabled && !part.active)
            throw Error("请先在插件管理中恢复" + part.entry.name + "，再重试。");
          add(part, replacing ? "update" : !part.installed ? "install" : part.enabled ? "reuse" : "enable", release);
          for (const [id, dependency] of dependencies) {
            const version = release.dependencies[id];
            if (!version) throw Error("发行清单缺少依赖版本：" + id);
            const rules = requirements.get(dependency) ?? [];
            rules.push({ version, minimum: !part.entry.community && parentOf(part.pathId) === dependency.pathId });
            requirements.set(dependency, rules);
          }
        }
        steps.reverse();
      } catch (error) { reason = errorText(error); steps.length = 0; }
    }
    const action = reason || !steps.length ? null : update ? "update" : item.installed ? "uninstall" : "install";
    const components = steps.flatMap(step => {
      const parts = (step.action === "install" || step.action === "update") && releaseFor(items.get(step.id)!, step.version).composition;
      return parts ? [{ name: parts.name, version: parts.version, repository: parts.zipPart.repository }] : [];
    });
    const verbs = { install: "安装", uninstall: "卸载", enable: "启用", reuse: "沿用", update: "更新" };
    const label = steps.filter(s => s.action !== "reuse").map(s =>
      verbs[s.action] + (/^[A-Za-z]/.test(s.name) ? " " : "") + s.name + (s.id === "bilibili" ? "插件" : "")).join("并");
    const planKey = action ? createHash("sha256").update(JSON.stringify([item.entry.id, action,
      ...(update ? [item.existing?.sha256, item.installedVersion, item.pathId, item.entry.repository] : []),
      steps.map(s => { const p = items.get(s.id)!, r = releaseFor(p, s.version); return [s, p.enabled, p.active, r?.sha256,
        ...(p.entry.community || update ? [p.entry.repository, r] : [])]; })])).digest("hex") : "";
    return { id: item.entry.id, runtimeId: item.pathId, name: item.entry.name, description: card?.description, repository: item.entry.repository,
      installation: card?.installation, version: updateVersion ?? item.target?.version ?? item.installedVersion ?? null,
      installedVersion: item.installedVersion ?? null, installed: item.installed, recognized: Boolean(item.existing),
      enabled: item.installed && item.enabled,
      status: this.runtime.records.get(item.pathId)?.status ?? null,
      action, label, steps, components, reason, upgradeUrl, planKey };
  }

  private reverseConstraint(item: Item, target: Release, items: Map<string, Item>) {
    if (this.receiptError) return "无法读取社区插件的安装记录，确认依赖关系后才能更新。";
    for (const record of this.runtime.records.values()) {
      if (record.id === item.pathId || item.existing?.bundledPluginIds?.includes(record.id)) continue;
      const stored = this.communityReceipts.get(record.id) ?? this.officialReceipts.get(record.id);
      const receipt = stored?.version === record.manifest.version ? stored : undefined;
      const dependent = [...items.values()].find(p => p.pathId === record.id);
      if (!(receipt ? receipt.dependencies.includes(item.pathId) : dependent?.entry.requiredPlugins.includes(item.entry.id))) continue;
      const releases = dependent?.entry.verifiedReleases.filter(r => r.version === record.manifest.version &&
        (!receipt || r.sha256 === receipt.sha256) && (r.platform === process.platform || r.platform === "any") &&
        (r.arch === process.arch || r.arch === "any")) ?? [];
      const recorded = receipt?.dependencyVersions?.[item.pathId];
      const pins = recorded ? new Set([recorded]) : new Set(releases.map(r => r.dependencies[item.entry.id] ?? r.dependencies[item.pathId]));
      const official = receipt ? receipt === this.officialReceipts.get(record.id) : dependent && !dependent.entry.community;
      const minimum = !!official && parentOf(record.id) === item.pathId;
      const [version] = pins;
      if (pins.size !== 1 || !version || !satisfies(target.version, {version, minimum})) {
        const name = receipt?.name ?? dependent?.entry.name ?? record.id;
        return name + "依赖当前插件，尚未验证它能配合 v" + target.version + " 使用。";
      }
    }
    return "";
  }

  private async snapshot(updating = false) {
    await this.runtime.pluginState.load();
    try {
      const receipts = await readPackageInstalls(this.runtime.root);
      this.communityReceipts = receipts.community;
      this.officialReceipts = receipts.official;
      this.receiptError = "";
    } catch {
      this.communityReceipts.clear();
      this.officialReceipts.clear();
      this.receiptError = "无法读取社区插件的安装记录，确认依赖关系后才能卸载。";
    }
    const items = await Promise.all(this.entries.map(entry => this.inspect(entry, updating)));
    return new Map(items.map(item => [item.entry.id, item]));
  }

  private async resumeAffected(ids: string[]) {
    const runtime = this.runtime;
    let waiting = ids.filter(id => runtime.records.get(id)?.status !== "active");
    while (waiting.length) {
      const pending: string[] = [];
      for (const id of waiting) {
        const record = runtime.records.get(id);
        if (!record) throw Error("更新前运行的插件未被重新加载：" + id);
        if (record.status === "active") continue;
        const loaded = await runtime.loadPath(id);
        if (loaded.status === "failed") throw Error(id + "：" + loaded.error);
        if (loaded.status !== "active") pending.push(id);
      }
      if (pending.length === waiting.length) throw Error("无法恢复更新前运行的插件：" + pending.join("、"));
      waiting = pending;
    }
  }

  async updatePlan(id: string, version: string) {
    return this.runtime.managePackages(async () => {
      const items = await this.snapshot(true), item = items.get(id);
      if (!item) throw Object.assign(Error("未找到可更新的插件。"), {status:409});
      return this.plan(item, items, version);
    });
  }

  async compatibleUpdateVersions(ids: ReadonlySet<string>) {
    return this.runtime.managePackages(async () => {
      const items = await this.snapshot(true);
      const versions = new Map<string, string>();
      for (const id of ids) {
        const current = items.get(id);
        if (!current?.installed) continue;
        // Preview the replacement using the install planner's host, platform and dependency checks.
        // This plan stays local to the query and never authorizes replacing the installed files.
        const replacement = { ...current, installed: false, installedVersion: undefined, existing: undefined, reason: "" };
        const preview = new Map(items).set(id, replacement);
        const checked = new Set<string>();
        for (const target of current.eligible) {
          // Confirmation selects the first eligible build of the requested version.
          if (checked.has(target.version)) continue;
          checked.add(target.version);
          replacement.eligible = [target];
          replacement.target = target;
          if (!this.reverseConstraint(current, target, items) && this.plan(replacement, preview).action === "install") {
            versions.set(id, target.version);
            break;
          }
        }
      }
      return versions;
    });
  }

  async list() {
    return this.runtime.managePackages(async () => {
      const items = await this.snapshot();
      const plugins = [...items.values()].map(item => this.plan(item, items));
      const recognized = new Set(plugins.filter(p => p.installed && p.recognized).map(p => p.runtimeId));
      // Manually distributed builds can prove authorship without supplying a package management plan.
      for (const build of this.installedBuilds) {
        const record = this.runtime.records.get(build.runtimeId);
        if (!record || record.manifest.version !== build.version || build.platform !== process.platform ||
          build.arch !== process.arch || recognized.has(build.runtimeId)) continue;
        const files = await inspectOfficialFiles(this.runtime.root, {
          directory: "plugins/" + build.runtimeId.split("/").join("/sub/"), sha256: build.sha256, recognitionOnly: true,
        });
        if (files.state === "installed") recognized.add(build.runtimeId);
      }
      const incomplete = [...items.values()].some(item => item.inventoryUnavailable && !recognized.has(item.pathId));
      return { plugins, recognizedRuntimeIds: [...recognized], ...(incomplete && {incomplete:true}) };
    });
  }
  async apply(input: { id?: unknown; action?: unknown; version?: unknown; planKey?: unknown }) {
    return this.runtime.managePackages(async () => {
      const signal = this.runtime.packageSignal;
      signal.throwIfAborted();
      const updating = input?.action === "update";
      if (updating && typeof input?.version !== "string") throw Object.assign(Error("请确认目标版本。"), {status:409});
      const runtime = this.runtime, items = await this.snapshot(updating);
      const item = typeof input?.id === "string" && items.get(input.id);
      if (!item) throw Error("请选择官方目录内的插件。");
      const plan = this.plan(item, items, updating ? input.version as string : undefined);
      if (!plan.action || input.action !== plan.action || input.planKey !== plan.planKey)
        throw Object.assign(Error(plan.reason || "安装状态已变化，请刷新并确认新的操作。"), { status: 409 });
      const undo: Array<{ label: string; run: () => Promise<void> }> = [];
      let stage = "";
      let finishCommit: (() => void) | undefined;
      let replacement: Awaited<ReturnType<typeof replaceOfficialFiles>> | undefined;
      const transactionId = updating ? randomUUID() : undefined;
      let journal: Awaited<ReturnType<typeof import("./package-update-journal.ts").beginUpdateDependencies>>;
      const finishJournal = async () => {
        if (journal) await journal.finish().catch(error => runtime.logger.warn("插件事务记录清理失败", {id:item.pathId, error}));
      };
      const stop = async (p: Item) => { if (runtime.records.has(p.pathId)) await runtime.stop(p.pathId); };
      const activate = async (p: Item) => {
        const loaded = await runtime.loadPath(p.pathId);
        if (loaded?.status !== "active") throw Error(loaded?.error ?? "插件未能启用");
      };
      const forget = (p: Item, release: Release) => {
        for (const id of [p.pathId, ...(release.bundledPluginIds ?? [])]) runtime.records.delete(id);
      };
      try {
        // Acquire all missing packages before enabling dependencies or touching the plugin directories.
        for (const step of plan.steps) {
          if (step.action !== "install" && step.action !== "update") continue;
          const p = items.get(step.id)!;
          const target = releaseFor(p, step.version);
          if (target.composition) {
            stage = step.name + " · 下载并校验发行包和 " + target.composition.name;
            if (!target.sizeBytes || !target.inventorySha256 || !/^[a-f0-9]{64}$/.test(target.inventorySha256))
              throw Error("发行清单缺少完整安装包的校验信息。");
            let inventory: Buffer;
            try { inventory = readFileSync(new URL("../market/inventories/" + target.inventorySha256 + ".json", import.meta.url)); }
            catch (error: any) {
              if (error.code !== "ENOENT") throw error;
              const { readOfficialInventory } = await import("./official-update-registry.ts");
              inventory = await readOfficialInventory(target.inventorySha256, signal);
            }
            if (createHash("sha256").update(inventory).digest("hex") !== target.inventorySha256) throw Error("发行文件清单校验失败。");
            const { ensureComposedOfficialPackage } = await import("./official-package-composition.ts");
            await ensureComposedOfficialPackage(runtime.root, { ...target.composition, inventory, sha256: target.sha256, sizeBytes: target.sizeBytes }, signal);
          } else if (target.assetUrl) {
            stage = step.name + " · 下载并校验发行包";
            if (!target.sizeBytes) throw Error("发行清单缺少安装包大小。");
            await ensureOfficialPackage(runtime.root, { repository: p.entry.repository, assetUrl: target.assetUrl,
              sha256: target.sha256, sizeBytes: target.sizeBytes }, signal);
          }
          if (p.entry.community) await this.community!.verify(runtime.root, p.entry, target);
        }
        if (updating) {
          stage = item.entry.name + " · 核对原版本";
          const old = item.existing!;
          if (item.entry.community && old.assetUrl && old.sizeBytes) {
            await ensureOfficialPackage(runtime.root, {repository:item.entry.repository, assetUrl:old.assetUrl,
              sha256:old.sha256, sizeBytes:old.sizeBytes}, signal);
            await this.community!.verify(runtime.root,item.entry,old);
          }
          const before = await inspectOfficialFiles(runtime.root, inventorySpec(item, old));
          if (before.state !== "installed") throw Error(before.reason || "已安装文件发生变化，请重新确认。");
        }
        // Downloads may take minutes. Recheck the files of dependencies before enabling or relying on them.
        for (const step of plan.steps) {
          if (step.action !== "enable" && step.action !== "reuse") continue;
          const part = items.get(step.id)!, release = releaseFor(part, step.version);
          stage = step.name + " · 核对已安装依赖";
          const state = await inspectOfficialFiles(runtime.root, inventorySpec(part, release));
          if (state.state !== "installed") throw Error(state.reason || "已安装文件发生变化，请重新确认。");
          if (part.entry.community) await this.community!.verify(runtime.root, part.entry, release);
        }
        signal.throwIfAborted();
        finishCommit = runtime.beginPackageCommit();
        if (transactionId) {
          const changes = plan.steps.flatMap(step => {
            if (step.action !== "install" && step.action !== "enable") return [];
            const p = items.get(step.id)!, r = releaseFor(p, step.version);
            return [{id:p.pathId, action:step.action, enabled:p.enabled, mayRemove:!this.dependents(p,item).length,
              files:spec(p,r), dependencies:Object.keys(r.dependencies).map(id => items.get(id)?.pathId ?? id),
              bundled:r.bundledPluginIds ?? []}];
          });
          if (changes.length) {
            stage = item.entry.name + " · 保存依赖恢复记录";
            const {beginUpdateDependencies} = await import("./package-update-journal.ts");
            journal = await beginUpdateDependencies(runtime.root,transactionId,item.pathId,
              releaseFor(item,input.version as string).sha256,changes);
          }
        }
        for (const step of plan.steps) {
          signal.throwIfAborted();
          if (step.action === "reuse") continue;
          const p = items.get(step.id)!;
          const release = releaseFor(p, step.version);
          const files = spec(p, release);
          if (journal && (step.action === "enable" || step.action === "install")) await journal.start(p.pathId);
          stage = step.name + " · " + ({ install: "安装程序文件", enable: "启用依赖", uninstall: "卸载程序文件", update: "替换程序文件" }[step.action]);
          if (step.action === "update") {
            const old = p.existing!;
            const active = [...runtime.records.values()].filter(record => record.status === "active").map(record => record.id as string);
            const independentChildren = [...runtime.records.keys()].filter(id =>
              id.startsWith(p.pathId + "/") && !old.bundledPluginIds?.includes(id));
            let affected: string[] = [];
            const clearTree = () => {
              for (const id of runtime.records.keys()) if (id === p.pathId || id.startsWith(p.pathId + "/")) runtime.records.delete(id);
            };
            undo.push({label: "恢复" + step.name + " v" + old.version + "和原启停状态", run: async () => {
              await stop(p);
              clearTree();
              if (replacement) {
                await replacement.rollback();
                if (replacement.cleanupWarning) runtime.logger.warn("插件已恢复，备份清理提示", {id:p.pathId, message:replacement.cleanupWarning});
              }
              const restored = await runtime.loadPath(p.pathId);
              if (restored?.manifest.version !== old.version || (p.active && restored.status !== "active"))
                throw Error(restored?.error || "原版本未能恢复。");
              await this.resumeAffected(affected);
            }});
            try { await stop(p); }
            finally { affected = active.filter(id => id !== p.pathId && runtime.records.get(id)?.status !== "active"); }
            clearTree();
            replacement = await replaceOfficialFiles(runtime.root, inventorySpec(p, old), files, transactionId);
            signal.throwIfAborted();
            stage = step.name + " · 加载新版";
            const loaded = await runtime.loadPath(p.pathId);
            if (loaded?.manifest.version !== release.version || loaded.status !== (p.enabled ? "active" : "stopped"))
              throw Error(loaded?.error ?? "新版未能按原启停状态加载。");
            for (const id of independentChildren) {
              if (!runtime.records.has(id)) throw Error("新版无法继续加载已安装的独立子插件：" + id);
            }
            for (const id of release.bundledPluginIds ?? []) {
              const child = runtime.records.get(id);
              if (!child || (p.enabled && runtime.pluginState.enabled(id) && child.status !== "active"))
                throw Error("子插件未就绪：" + id + " " + (child?.error || ""));
            }
            // Children explicitly retired by the verified bundle disappear. Every independent consumer must return.
            const retired = (old.bundledPluginIds ?? []).filter(id => !release.bundledPluginIds?.includes(id));
            await this.resumeAffected(affected.filter(id => !retired.includes(id)));
            signal.throwIfAborted();
            continue;
          }
          if (step.action === "uninstall") {
            if (p.active) undo.push({ label: "恢复启用" + step.name, run: () => activate(p) });
            await stop(p);
            await uninstallOfficialFiles(runtime.root, inventorySpec(p, release));
            forget(p, release);
            continue;
          }
          if (step.action === "install") {
            if (p.entry.community) {
              await this.community!.available(runtime.root, p.pathId);
              const slash = p.pathId.lastIndexOf("/");
              if (slash >= 0) {
                const parent = runtime.records.get(p.pathId.slice(0, slash)), leaf = p.pathId.slice(slash + 1);
                if (parent?.status !== "active" || (Array.isArray(parent.manifest.sub) && !parent.manifest.sub.includes(leaf)))
                  throw Error("父插件尚未启用或没有声明可加载这个子插件。");
              }
            }
            await installOfficialFiles(runtime.root, files);
            undo.push({ label: "撤回新装的" + step.name, run: async () => {
              const used = this.dependents({ ...p, existing: release }, updating ? item : undefined);
              if (used.length) throw Error("仍有插件依赖：" + used.join("、"));
              await stop(p);
              await uninstallOfficialFiles(runtime.root, files);
              forget(p, release);
            } });
          }
          if (!p.enabled) {
            await runtime.pluginState.setEnabled(p.pathId, true);
            undo.push({ label: "恢复" + step.name + "的停用状态", run: async () => {
              await runtime.pluginState.setEnabled(p.pathId, false);
              await stop(p);
              if (p.installed) await runtime.loadPath(p.pathId);
            } });
          }
          stage = step.name + " · 启用插件";
          signal.throwIfAborted();
          await activate(p);
          if (p.entry.community) for (const id of release.bundledPluginIds ?? []) {
            const child = runtime.records.get(id);
            if (!child || (runtime.pluginState.enabled(id) && child.status !== "active"))
              throw Error(`子插件 ${id} 未就绪：${child?.error || "未能加载"}`);
          }
          signal.throwIfAborted();
        }
        if (plan.action === "install" || updating) {
          if (!updating) await runtime.resumeBlocked();
          stage = item.entry.name + " · 保存安装记录";
          const community: CommunityInstallReceipt[] = [], official: OfficialInstallReceipt[] = [];
          for (const step of plan.steps) {
            if (step.action !== "install" && step.action !== "update") continue;
            const p = items.get(step.id)!, release = releaseFor(p, step.version);
            const dependencyVersions = Object.fromEntries(Object.entries(release.dependencies)
              .map(([id, version]) => [items.get(id)?.pathId ?? id, version]));
            const receipt = {id:p.pathId, name:p.entry.name, version:step.version, sha256:release.sha256, hostRange:release.hostRange,
              dependencies:Object.keys(dependencyVersions), dependencyVersions, ...(transactionId ? {transactionId} : {})};
            if (p.entry.community) community.push(receipt);
            else official.push({...receipt, repository:p.entry.repository, platform:process.platform, arch:process.arch,
              bundledPluginIds:release.bundledPluginIds ?? [], preserve:p.entry.preserve ?? []});
          }
          await recordPackageInstalls(runtime.root, community, official);
        }
        if (replacement) {
          // The receipt and runtime have committed; a leftover backup is a cleanup issue, not a failed update.
          await replacement.commit().catch(error => runtime.logger.warn("插件更新后备份清理失败", {id:item.pathId, error}));
          await finishJournal();
          return {ok:true, message:item.entry.name + "已更新到 v" + plan.version + "，配置和数据已保留。"};
        }
        return { ok: true, message: item.entry.name + (plan.action === "install" ? "已安装并启用。" : "已卸载，配置和数据已保留。") };
      } catch (error) {
        const rolledBack: string[] = [], failed: string[] = [];
        for (const change of undo.reverse()) {
          try { await change.run(); rolledBack.push(change.label); }
          catch (failure) { failed.push(change.label + "：" + errorText(failure)); }
        }
        const detail = failed.length ? "。以下改动未能自动撤回：" + failed.join("；") : "";
        if (!failed.length) await finishJournal();
        throw Object.assign(Error(stage + "失败：" + errorText(error) + detail), { rolledBack });
      } finally {
        finishCommit?.();
      }
    });
  }
}

export class OfficialPlugins extends PluginPackages {}
