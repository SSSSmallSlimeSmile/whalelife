/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFileSync } from "node:fs";
import { readPublishedCommunityReviews } from "./community-reviews.ts";
import { readOfficialRegistry } from "./official-update-registry.ts";
import type { ReviewedCommunityEntry } from "./community-packages.ts";
import { compatibleHostFloor } from "./package-host-range.ts";

type Entry = { id: string; repository: string };
type Installed = { id: string; version?: string; builtin?: boolean; repository?: unknown };
type Recognition = { plugins: { runtimeId: string; installedVersion: string | null; installed: boolean }[]; recognizedRuntimeIds: string[]; incomplete?: boolean };
type Notice = Entry & { runtimeId: string; source: "official" | "community"; installedVersion: string; latestVersion: string; url: string };
type Target = { version: string; url: string };
type Metadata = Record<string, any>;
type CommunityVersions = (reviews: ReviewedCommunityEntry[], ids: ReadonlySet<string>, registry?: Metadata | null) => Promise<Map<string, string>>;

const repoPattern = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/?$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const bundled = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));

function repoPath(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return;
  const path = repoPattern.exec(value)?.[1];
  if (path && ![".", ".."].includes(path.split("/")[1])) return path;
}

function installationKey(plugins: Installed[]) {
  return JSON.stringify(plugins.filter(p => !p.builtin && parseVersion(p.version))
    .map(p => [p.id, p.version, p.repository]).sort());
}

function parseVersion(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return;
  const match = semver.exec(value);
  if (match && !match[4]?.split(".").some(part => /^0\d+$/.test(part))) {
    return { parts: match.slice(1, 4).map(part => BigInt(part)), prerelease: !!match[4] };
  }
}

// Only stable targets can be advertised. Build metadata has no SemVer precedence.
function newer(target: string, installed: string) {
  const next = parseVersion(target), current = parseVersion(installed);
  if (!next || next.prerelease || !current) return false;
  for (let i = 0; i < next.parts.length; i++) {
    if (next.parts[i] !== current.parts[i]) return next.parts[i] > current.parts[i];
  }
  return current.prerelease;
}

function verifiedTarget(entry: Metadata, installed: string, host: string, platform: string, arch: string): Target | undefined {
  let best: Target | undefined;
  for (const release of Array.isArray(entry.verifiedReleases) ? entry.verifiedReleases : []) {
    if (!release || release.recognitionOnly || release.delivery !== "github-release" || release.platform !== platform ||
        release.arch !== arch || !compatibleHostFloor(release.hostRange, host) || !newer(release.version, best?.version ?? installed) ||
        !/^[0-9a-f]{64}$/.test(release.sha256) || !/^[0-9a-f]{64}$/.test(release.inventorySha256) ||
        !Number.isSafeInteger(release.sizeBytes) || release.sizeBytes <= 0) continue;
    const tag = "v" + release.version, asset = release.composition?.packagePart?.assetUrl ?? release.assetUrl;
    const base = entry.repository + "/releases/download/" + tag + "/";
    if (typeof asset !== "string" || !asset.startsWith(base) || !/^[\w.-]+$/.test(asset.slice(base.length))) continue;
    best = { version: release.version, url: entry.repository + "/releases/tag/" + encodeURIComponent(tag) };
  }
  return best;
}

async function readCommunityUpdates(signal: AbortSignal) {
  let incomplete = false;
  const reviews = await readPublishedCommunityReviews(signal, fetch, () => { incomplete = true; });
  return { reviews, incomplete };
}

export class PluginUpdates {
  private registry: Metadata;
  private host: string = bundled("../package.json").version;
  private officialReview?: Promise<Metadata | null>;
  private last?: { key: string; updates: Notice[]; incomplete?: boolean };
  private lastCheck = 0;
  private signal: AbortSignal;
  private reviewing?: ReturnType<typeof readCommunityUpdates>;
  private communityVersions: CommunityVersions;

  constructor(signal: AbortSignal, communityVersions: CommunityVersions, registry = bundled("../market/official-releases.json")) {
    this.signal = signal;
    this.communityVersions = communityVersions;
    this.registry = registry;
  }

  snapshot(installed: Installed[]) {
    if (!this.last) return { updates: [] };
    const updates = this.last.updates.filter(row => installed.some(plugin =>
      !plugin.builtin && plugin.id === row.runtimeId && plugin.version === row.installedVersion &&
      (plugin.repository == null || repoPath(plugin.repository)?.toLowerCase() === repoPath(row.repository)?.toLowerCase())));
    if (this.last.key === installationKey(installed)) return { updates, checked: true, incomplete: this.last.incomplete };
    // An installed dependency may no longer satisfy a previously recommended community release.
    return { updates: updates.filter(row => row.source === "official") };
  }

  async list(installed: Installed[], recognize: (registry?: Metadata | null) => Promise<Recognition>,
      officialVersions?: (registry: Metadata, ids: ReadonlySet<string>) => Promise<Map<string,string>>) {
    const check = ++this.lastCheck;
    const local = new Map(installed.filter(p => !p.builtin && parseVersion(p.version)).map(p => [p.id, p]));
    if (!local.size) {
      this.last = { key: installationKey(installed), updates: [] };
      return { updates: [] };
    }
    const hasOfficial = this.registry.plugins.some((entry: Metadata) =>
      local.has(entry.parentId ? entry.parentId + "/" + entry.id : entry.id));
    // Coalesce simultaneous clicks. Each later manual check can see a maintainer's withdrawal.
    const publicRegistry = hasOfficial ? await (this.officialReview ??= readOfficialRegistry(this.signal)
      .catch(() => null).finally(() => { this.officialReview = undefined; })) : null;
    const publicPlugins = publicRegistry?.schemaVersion === 1 && Array.isArray(publicRegistry.plugins) ? publicRegistry.plugins : null;
    let incomplete = false;
    const updates: Notice[] = [];
    const reserved = new Set<string>();
    const officialCandidates: Notice[] = [];
    for (const entry of this.registry.plugins) {
      const { id, repository } = entry, runtimeId = entry.parentId ? entry.parentId + "/" + id : id;
      reserved.add(id);
      reserved.add(runtimeId);
      const installedVersion = local.get(runtimeId)?.version;
      if (!installedVersion) continue;
      if (!publicPlugins) incomplete = true;
      const matches = publicPlugins?.filter((other: Metadata) => other?.id === id && other.repository === repository &&
          other.parentId === entry.parentId && other.name === entry.name) ?? [];
      let target = verifiedTarget(entry, installedVersion, this.host, process.platform, process.arch);
      if (matches.length === 1) target = verifiedTarget(matches[0], installedVersion, this.host, process.platform, process.arch);
      if (target) officialCandidates.push({ id, runtimeId, repository, installedVersion, latestVersion: target.version, url: target.url, source: "official" });
    }
    const official = async () => {
      if (!officialCandidates.length) return;
      if (officialVersions && !publicPlugins) { incomplete = true; return; }
      const recognition = await recognize(publicRegistry).catch(() => null);
      if (!recognition) { incomplete = true; return; }
      if (recognition.incomplete) incomplete = true;
      const compatible = officialVersions && publicRegistry ? await officialVersions(publicRegistry,
        new Set(officialCandidates.map(row => row.id))).catch(() => null) : undefined;
      if (compatible === null) { incomplete = true; return; }
      for (const item of officialCandidates) {
        if (compatible) {
          const version = compatible.get(item.id);
          if (!version || !newer(version,item.installedVersion)) continue;
          item.latestVersion = version;
          item.url = item.repository + "/releases/tag/v" + version;
        }
        if (recognition.recognizedRuntimeIds.includes(item.runtimeId) && recognition.plugins.some(plan =>
          plan.installed && plan.runtimeId === item.runtimeId && plan.installedVersion === item.installedVersion)) updates.push(item);
      }
    };
    const community = async () => {
      if (![...local.keys()].some(id => !reserved.has(id))) return;
      try {
        // Recheck the published approvals on each manual check, including revocations.
        this.reviewing ??= readCommunityUpdates(this.signal).finally(() => { this.reviewing = undefined; });
        const result = await this.reviewing;
        incomplete ||= result.incomplete;
        const reviews = result.reviews;
        const candidates = reviews.filter(entry => {
          const plugin = local.get(entry.id);
          return plugin?.version && !reserved.has(entry.id) && (plugin.repository == null ||
            repoPath(plugin.repository)?.toLowerCase() === repoPath(entry.repository)?.toLowerCase()) &&
            entry.verifiedReleases?.some(release => newer(release.version, plugin.version!));
        });
        if (!candidates.length) return;
        const targets = await this.communityVersions(reviews, new Set(candidates.map(entry => entry.id)), publicRegistry);
        for (const { id, repository } of candidates) {
          const version = targets.get(id), installedVersion = local.get(id)!.version!;
          if (!version || !newer(version, installedVersion)) continue;
          updates.push({ id, runtimeId: id, repository, source: "community", installedVersion, latestVersion: version,
            url: repository.replace(/\/$/, "") + "/releases/tag/v" + version });
        }
      } catch {
        incomplete = true;
      }
    };
    await Promise.all([official(), community()]);
    updates.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId, "en"));
    if (check === this.lastCheck) this.last = { key: installationKey(installed), updates, incomplete };
    return incomplete ? { updates, incomplete: true } : { updates };
  }
}
