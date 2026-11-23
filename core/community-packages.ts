/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { PluginPackages, type PackageEntry, type PackageRelease } from "./official-plugins.ts";
import { directoryAt, isPackageDataPath, verifiedPackageManifests } from "./official-package-files.ts";
import { reviewedCommunityEntries, isReservedPluginId } from "./community-reviews.ts";
import { readPackageInstalls } from "./community-install-receipts.ts";
import { assertPluginCompatibility } from "./plugin-compatibility.ts";
import { validPluginId } from "./plugin-state.ts";
import type { Runtime } from "./runtime.ts";

export type ReviewedCommunityRelease = Pick<PackageRelease,
  "version" | "hostRange" | "platform" | "arch" | "dependencies" | "sha256" | "bundledPluginIds"> & {
    assetUrl: string; sizeBytes: number;
  };
export type ReviewedCommunityEntry = {
  id: string; name: string; repository: string; installation: string; description: string;
  dependencies: string[]; verifiedReleases?: ReviewedCommunityRelease[];
};
const directory = (id: string) => "plugins/" + id.split("/").join("/sub/");
const officialRegistry = JSON.parse(readFileSync(new URL("../market/official-releases.json", import.meta.url), "utf8"));
const official: PackageEntry[] = officialRegistry.plugins;
const catalog = JSON.parse(readFileSync(new URL("../market/catalog.json", import.meta.url), "utf8"));
const cards: ReviewedCommunityEntry[] = catalog.official;
const shippedCommunity = reviewedCommunityEntries(catalog, error => console.warn(error.message));
const officialId = (entry: PackageEntry) => entry.parentId ? entry.parentId + "/" + entry.id : entry.id;
const officialAliases = new Map(official.map(e => [e.id, officialId(e)]));

function reviewedPackage(record: ReviewedCommunityEntry): PackageEntry {
  return {id:record.id, name:record.name, repository:record.repository, parentId:null, community:true,
    requiredPlugins:record.dependencies, verifiedReleases:record.verifiedReleases ?? []};
}
/** Only preserved data (including data belonging to a previously removed child) can occupy a fresh target. */
async function available(root: string, id: string) {
  const base = await directoryAt(root, directory(id));
  if (!base) return;
  async function inspect(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const name = item.name.toLowerCase();
      if (item.isSymbolicLink()) throw Error("插件目录含有链接，无法确认文件归属。");
      if (isPackageDataPath(name)) continue;
      if (name !== "sub" || !item.isDirectory()) throw Error("目标目录已有程序文件或归属不明，已保留原文件。");
      for (const child of await readdir(join(dir, item.name), { withFileTypes: true })) {
        if (!child.isDirectory() || !validPluginId(child.name)) throw Error("现有子插件目录归属不明。");
        await inspect(join(dir, item.name, child.name));
      }
    }
  }
  await inspect(base);
}

async function verify(root: string, entry: PackageEntry, release: PackageRelease) {
  const { paths, manifests } = await verifiedPackageManifests(root, { directory: directory(entry.id), sha256: release.sha256 });
  const declared = new Set([entry.id, ...(release.bundledPluginIds ?? [])]);
  const seen = new Map<string, {sub?: string[]}>();
  for (const [path, bytes] of manifests) {
    const prefix = path.slice(0, -"plugin.yaml".length), ids = prefix.split("/").filter((_,i) => i % 2 === 1);
    const id = [entry.id, ...ids].join("/");
    const m = parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes));
    if (!declared.has(id) || !paths.has(prefix + "index.ts") || !m || m.id !== id.split("/").at(-1) ||
        typeof m.name !== "string" || typeof m.description !== "string" || typeof m.version !== "string" ||
        (id === entry.id && m.version !== release.version) ||
        (m.sub !== undefined && (!Array.isArray(m.sub) || m.sub.some((v: unknown) => !validPluginId(v) || v.includes("/")))))
      throw Error("发行包插件清单与审核记录不一致：" + id);
    assertPluginCompatibility(m);
    seen.set(id, m);
  }
  if (seen.size !== declared.size) throw Error("发行包缺少已审核的子插件。");
  for (const path of paths.keys()) {
    const parts = path.split("/");
    let id = entry.id;
    for (let i = 0; parts[i] === "sub"; i += 2) {
      const name = parts[i+1], parent = seen.get(id);
      id += "/" + name;
      if (!parts[i+2] || !seen.has(id) || !parent || (parent.sub && !parent.sub.includes(name)))
        throw Error("发行包含有未审核或不可加载的子插件文件：" + path);
    }
  }
}

/** Only the host's reviewed catalog can construct this registry. Request bodies never contribute delivery metadata. */
export class CommunityPackages {
  private ids: Set<string>;
  private manager: PluginPackages;
  constructor(runtime: Runtime, records: readonly ReviewedCommunityEntry[], officialEntries = official) {
    const entries: PackageEntry[] = [];
    for (const record of reviewedCommunityEntries({ official: [], community: records })) {
      if (runtime.records.get(record.id.split("/")[0])?.manifest.builtin || !record.verifiedReleases?.length) continue;
      entries.push(reviewedPackage(record));
    }
    this.ids = new Set(entries.map(e => e.id));
    // The public official registry uses short UI IDs. A community dependency always names the actual runtime ID.
    const required = new Set(entries.flatMap(e => e.requiredPlugins));
    function include(e: PackageEntry) {
      const id = officialId(e);
      if (entries.some(item => item.id === id)) return;
      entries.push({...e, id, parentId:null, requiredPlugins:e.requiredPlugins.map(d => officialAliases.get(d) ?? d),
        verifiedReleases:e.verifiedReleases.map(r => ({...r, dependencies:Object.fromEntries(
          Object.entries(r.dependencies).map(([d,v]) => [officialAliases.get(d) ?? d,v]))}))});
      for (const dep of e.requiredPlugins) { const item = officialEntries.find(p => p.id === dep); if (item) include(item); }
    }
    for (const e of officialEntries) if (required.has(officialId(e))) include(e);
    this.manager = new PluginPackages(runtime, entries, [], [...records, ...cards.map(c => ({...c, id:officialAliases.get(c.id) ?? c.id}))], {
      available, verify,
    });
  }

  compatibleUpdateVersions(ids: ReadonlySet<string>) {
    return this.manager.compatibleUpdateVersions(ids);
  }

  updatePlan(id: string, version: string) {
    if (!this.ids.has(id)) throw Object.assign(Error("这个插件的发行包已撤回或尚未通过审核。"), {status:409});
    return this.manager.updatePlan(id, version);
  }

  applyUpdate(input: {id: string; version: string; planKey: string}) {
    if (!this.ids.has(input.id)) throw Object.assign(Error("这个插件的发行包已撤回或尚未通过审核。"), {status:409});
    return this.manager.apply({...input, action:"update"});
  }

  async list() {
    const { plugins } = await this.manager.list();
    return { plugins: plugins.filter(p => this.ids.has(p.id)).map(p => {
      const recognized = p.installed && p.recognized;
      const action = recognized ? "installed" : !p.installed && p.action === "install" ? "install" : "blocked";
      const reason = recognized ? "" : p.installed ? "已发现同名插件，无法确认文件归属，原文件已保留。" + p.reason : p.reason;
      return { ...p, action, reason, buttonLabel: recognized ? "已安装" : p.label || "无法安装",
        steps: action === "install" ? p.steps : [], planKey: action === "install" ? p.planKey : "" };
    }) };
  }

  async apply(input: {id?: unknown; action?: unknown; planKey?: unknown}) {
    if (typeof input?.id !== "string" || !this.ids.has(input.id) || input.action !== "install")
      throw Object.assign(Error("请选择已审核发行包的社区插件并确认安装。"), {status:409});
    return this.manager.apply(input);
  }
}

/** Resolve installed package owners offline. Only an explicit preview inspects program files. */
export async function installedCommunityPackages(runtime: Runtime, reviews: readonly ReviewedCommunityEntry[] = shippedCommunity) {
  const known = new Map(reviews.map(record => [record.id, reviewedPackage(record)]));
  // An unreadable receipt blocks the package engine too. Keep known owners visible so their dialog
  // can explain the problem, even when the user's local installation record is damaged.
  let receipts: Awaited<ReturnType<typeof readPackageInstalls>> | undefined;
  try { receipts = await readPackageInstalls(runtime.root); }
  catch { /* The confirmation path re-reads the receipt and fails closed. */ }
  for (const receipt of receipts?.community.values() ?? []) {
    // Follow the installed artifact even when the current catalog drops it or changes repositories.
    const review = known.get(receipt.id);
    const releases = review?.verifiedReleases.filter(release => release.sha256 === receipt.sha256) ?? [];
    known.set(receipt.id, {id:receipt.id, name:receipt.name, parentId:null, community:true,
      repository:receipt.repository ?? (releases.length ? review!.repository : ""),
      requiredPlugins:receipt.dependencies, verifiedReleases:releases});
  }
  const ancestors = new Map<string, PackageEntry>();
  const entries = [...known.values()].filter(entry => {
    const record = runtime.records.get(entry.id);
    if (!record || record.manifest.builtin || runtime.records.get(entry.id.split("/")[0])?.manifest.builtin ||
        isReservedPluginId(entry.id) || receipts?.official.has(entry.id)) return false;
    const parts = entry.id.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const parentId = parts.slice(0, depth).join("/");
      const source = known.get(parentId) ?? official.find(item => officialId(item) === parentId);
      const installedParent = runtime.records.get(parentId);
      const stored = receipts?.community.get(parentId) ?? receipts?.official.get(parentId);
      const parent = stored?.version === installedParent?.manifest.version ? stored : undefined;
      // The engine also checks ancestors outside the management list. An unknown parent supplies
      // no ownership evidence; a recognized official parent can prove its child's independence.
      ancestors.set(parentId, source ? {...source, id:parentId, parentId:null} : {id:parentId, name:parent?.name ?? installedParent?.manifest.name ?? parentId,
        parentId:null, repository:parent?.repository ?? "", requiredPlugins:[], verifiedReleases:[],
        community:!receipts?.official.has(parentId)});
      const releases = source?.verifiedReleases ?? [];
      const matches = parent ? releases.filter(r => r.sha256 === parent.sha256) :
        releases.filter(r => r.version === installedParent?.manifest.version &&
          (r.platform === "any" || r.platform === process.platform) && (r.arch === "any" || r.arch === process.arch));
      const children = parent?.bundledPluginIds ?? (matches.length ? matches.flatMap(r => r.bundledPluginIds ?? []) : undefined);
      // Matching a child's files cannot establish independent ownership under an unknown parent build.
      if (children?.includes(entry.id) || (!children && !receipts?.community.has(entry.id))) return false;
    }
    return true;
  });
  const ids = new Set(entries.map(entry => entry.id));
  const parents = [...ancestors].filter(([id]) => !ids.has(id)).map(([, entry]) => entry);
  const manager = new PluginPackages(runtime, [...entries, ...parents], officialRegistry.installedBuilds ?? [], [], {available, verify});
  function requireOwner(id: string) {
    if (!ids.has(id)) throw Object.assign(Error("未找到这个已安装的独立社区发行包。随包子插件请从所属插件卸载。"), {status:409});
  }
  return {
    plugins:entries.map(entry => ({id:entry.id, name:entry.name, version:runtime.records.get(entry.id)!.manifest.version})),
    async preview(id: string) {
      requireOwner(id);
      const plan = await manager.uninstallPlan(id);
      return {id, name:plan.name, installedVersion:plan.installedVersion, bundledPlugins:plan.bundledPlugins,
        action:plan.action === "uninstall" ? plan.action : null, reason:plan.reason,
        planKey:plan.action === "uninstall" ? plan.planKey : ""};
    },
    async apply(id: string, planKey: string) {
      requireOwner(id);
      return manager.apply({id, action:"uninstall", planKey});
    },
  };
}
