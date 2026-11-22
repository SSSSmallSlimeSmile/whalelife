/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PackageEntry, PackageRelease } from "./official-plugins.ts";
import { parseHostRange } from "./package-host-range.ts";
import { validPluginId } from "./plugin-state.ts";

const market = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/";
const digest = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const stableVersion = (v: unknown) => typeof v === "string" && version.test(v);
const local: { plugins: PackageEntry[] } = JSON.parse(await readFile(new URL("../market/official-releases.json", import.meta.url), "utf8"));

async function published(file: string, signal: AbortSignal, limit: number) {
  const response = await fetch(market + file, { redirect: "error", cache: "no-store", credentials: "omit",
    referrerPolicy: "no-referrer", signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error("暂时无法核对主仓的官方发行记录，请稍后重试。");
  }
  const reader = response.body.getReader(), blocks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(blocks);
      size += chunk.value.length;
      if (size > limit) { await reader.cancel(); throw Error("主仓的发行资料超过大小限制。"); }
      blocks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
}

export async function readOfficialInventory(sha256: string, signal: AbortSignal) {
  if (!digest.test(sha256)) throw Error("官方文件清单摘要无效。");
  const file = "inventories/" + sha256 + ".json";
  let bytes: Buffer;
  try { bytes = await readFile(new URL("../market/" + file, import.meta.url)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    bytes = await published(file, signal, 32 * 1024 ** 2);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw Error("官方文件清单 SHA-256 校验失败。");
  return bytes;
}

function validAsset(asset: any, repo: string) {
  return asset && asset.repository === repo && typeof asset.assetUrl === "string" &&
    asset.assetUrl.startsWith(repo + "/releases/download/") && typeof asset.sha256 === "string" && digest.test(asset.sha256) &&
    Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0 && asset.sizeBytes <= 2 * 1024 ** 3;
}

/** Only the maintainer's current published approvals may authorize a replacement. Local
 * historical inventories remain useful to prove ownership of the version being replaced. */
export function officialUpdateEntries(registry: any, known = local.plugins, signal?: AbortSignal): PackageEntry[] {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.plugins)) throw Error("官方发行清单格式无效。");
  // One manual operation may inspect the same version for recognition and dependency planning.
  // Different inventories share one download slot. A later click gets a fresh retry after a failure.
  const reads = new Map<string, Promise<Buffer>>();
  let previous = Promise.resolve();
  const readInventory = signal && ((sha256: string) => {
    let result = reads.get(sha256);
    if (!result) {
      result = previous.then(() => readOfficialInventory(sha256, signal));
      reads.set(sha256, result);
      previous = result.then(() => { reads.delete(sha256); }, () => {});
    }
    return result;
  });
  return known.map(entry => {
    const matches = registry.plugins.filter((p: any) => p?.id === entry.id);
    const remote = matches[0];
    const history = entry.verifiedReleases.flatMap(r => r.recognitionOnly ? [r] : r.inventorySha256
      ? [{ ...r, sha256: r.inventorySha256, recognitionOnly: true }] : []);
    if (!matches.length) return { ...entry, verifiedReleases: history };
    if (matches.length !== 1 || remote.repository !== entry.repository || remote.parentId !== entry.parentId || remote.name !== entry.name ||
        !Array.isArray(remote.requiredPlugins) || !remote.requiredPlugins.every((id: string) => known.some(e => e.id === id)) ||
        !Array.isArray(remote.preserve ?? []) || !(remote.preserve ?? []).every((p: unknown) => typeof p === "string") ||
        !Array.isArray(remote.verifiedReleases) || remote.verifiedReleases.length > 512)
      throw Error("官方插件归属或依赖清单无效：" + entry.id);
    const releases: PackageRelease[] = [], targets = new Set<string>();
    const seenInventory = new Set<string>();
    for (const r of remote.verifiedReleases) {
      if (!r || (!r.recognitionOnly && r.delivery !== "github-release" && r.delivery !== "inventory")) continue;
      const scope = (entry.parentId ? entry.parentId + "/" : "") + entry.id + "/";
      if (!stableVersion(r.version) || !parseHostRange(r.hostRange) ||
          typeof r.platform !== "string" || !/^[a-z0-9]{1,16}$/.test(r.platform) ||
          typeof r.arch !== "string" || !/^[a-z0-9]{1,16}$/.test(r.arch) ||
          !Array.isArray(r.bundledPluginIds ?? []) || !(r.bundledPluginIds ?? []).every((id: unknown) =>
            validPluginId(id) && id.startsWith(scope)) ||
          !r.dependencies || typeof r.dependencies !== "object" || Array.isArray(r.dependencies) ||
          !Object.entries(r.dependencies).every(([id,v]) => known.some(e => e.id === id && id !== entry.id) && stableVersion(v)))
        throw Error("官方发行包审核资料无效：" + entry.id);
      if (r.recognitionOnly || r.delivery === "inventory") {
        if (r.recognitionOnly !== true || r.delivery !== "inventory" || typeof r.sha256 !== "string" || !digest.test(r.sha256) ||
            r.inventoryPath !== "market/inventories/" + r.sha256 + ".json" ||
            !Number.isSafeInteger(r.sizeBytes) || r.sizeBytes < 1 || r.sizeBytes > 32 * 1024 ** 2 ||
            !Number.isSafeInteger(r.fileCount) || r.fileCount < 1 || r.fileCount > 150_000 ||
            typeof r.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(r.sourceCommit))
          throw Error("官方历史文件清单审核资料无效：" + entry.id);
        const key = JSON.stringify([r.version,r.platform,r.arch,r.sha256]);
        if (!seenInventory.has(key)) {
          seenInventory.add(key);
          releases.push({version:r.version, hostRange:r.hostRange, platform:r.platform, arch:r.arch,
            dependencies:r.dependencies, bundledPluginIds:r.bundledPluginIds, sha256:r.sha256, recognitionOnly:true});
        }
        continue;
      }
      const asset = r.composition?.packagePart ?? { ...r, repository: entry.repository };
      const prefix = entry.repository + "/releases/download/v" + r.version + "/";
      const hostRange = parseHostRange(r.hostRange);
      if (!hostRange || typeof r.inventorySha256 !== "string" || !digest.test(r.inventorySha256) ||
          !validAsset(asset, entry.repository) || !asset.assetUrl.startsWith(prefix) ||
          !/^[\w.+-]+\.wlpkg\.gz$/.test(asset.assetUrl.slice(prefix.length)) ||
          typeof r.sha256 !== "string" || !digest.test(r.sha256) || !Number.isSafeInteger(r.sizeBytes) || r.sizeBytes < 1 || r.sizeBytes > 2 * 1024 ** 3 ||
          !remote.requiredPlugins.every((id: string) => Object.hasOwn(r.dependencies,id)) ||
          Object.keys(r.dependencies).length !== remote.requiredPlugins.length)
        throw Error("官方发行包审核资料无效：" + entry.id);
      if (r.composition) {
        const zip = r.composition.zipPart;
        if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(zip?.repository) || !validAsset(zip, zip.repository) ||
            !Array.isArray(zip.files) || !zip.files.length || !zip.files.every((f: any) => typeof f?.path === "string" && typeof f.member === "string"))
          throw Error("官方组件审核资料无效：" + entry.id);
      }
      const key = JSON.stringify([r.version,hostRange.minimum,r.platform,r.arch]);
      if (targets.has(key)) throw Error("官方发行包的版本与平台重复：" + entry.id);
      targets.add(key);
      releases.push(r);
    }
    return { ...entry, requiredPlugins: remote.requiredPlugins, preserve: [...new Set<string>([...(entry.preserve ?? []), ...(remote.preserve ?? [])])],
      readInventory,
      verifiedReleases: [...releases, ...history.filter(r => !seenInventory.has(JSON.stringify([r.version,r.platform,r.arch,r.sha256])))] };
  });
}

export async function readOfficialUpdateEntries(signal: AbortSignal) {
  return officialUpdateEntries(await readOfficialRegistry(signal), local.plugins, signal);
}

export async function readOfficialRegistry(signal: AbortSignal): Promise<Record<string, any>> {
  const bytes = await published("official-releases.json", signal, 2 * 1024 ** 2);
  const registry = JSON.parse(bytes.toString("utf8"));
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw Error("官方发行清单格式无效。");
  return registry;
}
