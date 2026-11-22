/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { reviewedCommunityEntries } from "../../core/community-reviews.ts";
import { parseHostRange } from "../../core/package-host-range.ts";
import { officialUpdateEntries } from "../../core/official-update-registry.ts";
import { inspectCommunityIcon } from "./review-community-icon.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const context = { window: {}, URL };
runInNewContext(read("../assets/catalog-validation.js"), context);
export const catalog = JSON.parse(read("../catalog.json"));
assert.ok(context.window.isWhaleLifeCatalog(catalog), "Invalid plugin catalog");
for (const entry of catalog.community) {
  if (entry.icon === undefined) continue;
  assert.ok(context.window.whaleLifeCommunityIconURL(entry), entry.id + ": invalid reviewed icon path");
  const bytes = readFileSync(new URL("../" + entry.icon, import.meta.url));
  assert.equal(entry.icon, "assets/community-icons/" + inspectCommunityIcon(bytes).sha256 + ".png", entry.id + ": icon digest mismatch");
}
const reviewedCommunity = reviewedCommunityEntries(catalog);
const packagedIds = new Set(reviewedCommunity.map(entry => entry.id));
for (const entry of catalog.community) {
  // This listing predates the package requirement and only provides manual instructions.
  if (entry.id === "color-note" && entry.repository === "https://github.com/iinukami/whalelife-community-color-note") continue;
  assert.ok(packagedIds.has(entry.id), entry.id + ": 新收录社区插件至少需要一个已审核发行包");
}
function checkDisplayVersion(card, releases) {
  const versions = releases.filter(release => !release.recognitionOnly).map(release => release.version);
  if (versions.length) assert.equal(card.version, versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0],
    card.id + ": catalog display version differs from the newest reviewed release");
}
for (const entry of reviewedCommunity) {
  checkDisplayVersion(catalog.community.find(card => card.id === entry.id), entry.verifiedReleases);
}
const { official } = catalog;
const manifest = JSON.parse(read("../official-releases.json"));

assert.equal(manifest.schemaVersion, 1);
// Validate with the same rules as a host reading this candidate during a manual update.
officialUpdateEntries(manifest, manifest.plugins);
const ids = Array.from(official, plugin => plugin.id);
assert.equal(new Set(ids).size, ids.length, "Duplicate official plugin id");
assert.deepEqual(manifest.plugins.map(plugin => plugin.id), ids, "Catalog and manifest order differ");

function checkInventory(digest, preserved = []) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const raw = readFileSync(new URL("../inventories/" + digest + ".json", import.meta.url));
  assert.equal(createHash("sha256").update(raw).digest("hex"), digest);
  const inventory = JSON.parse(raw);
  assert.equal(inventory.format, 1);
  assert.ok(Array.isArray(inventory.files) && inventory.files.length > 0);
  const paths = new Set();
  for (const { path, size, sha256 } of inventory.files) {
    assert.ok(typeof path === "string" && path.length <= 4096 && path.normalize("NFC") === path &&
      !/[\\<>:"|?*\x00-\x1f]/u.test(path) && path.split("/").every(part => part && !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) && !/~\d+(?:\.|$)/.test(part)));
    const lower = path.toLowerCase();
    assert.ok(!paths.has(lower), "Duplicate inventory path");
    assert.ok(!/^(?:sub\/[^/]+\/)*(?:data|config|config\.(?:json|ya?ml)|settings\.json|\.env(?:\.[^/]*)?)(?:\/|$)/.test(lower) &&
      !preserved.some(p => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase() + "/")), "Persistent file in inventory");
    paths.add(lower);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.match(sha256, /^[a-f0-9]{64}$/);
  }
  assert.ok(inventory.files.some(file => file.path === "plugin.yaml"), "Missing plugin.yaml");
  return { sizeBytes: raw.length, fileCount: inventory.files.length };
}

for (const [index, plugin] of manifest.plugins.entries()) {
  const card = official[index];
  assert.equal(plugin.name, card.name);
  assert.equal(plugin.repository, card.repository);
  assert.deepEqual(plugin.requiredPlugins, Array.from(card.dependencies));
  const repo = new URL(plugin.repository);
  assert.ok(plugin.requiredPlugins.every(id => ids.includes(id) && id !== plugin.id));
  assert.ok(plugin.parentId === null || plugin.requiredPlugins.includes(plugin.parentId));
  const preserved = plugin.preserve ?? [];
  assert.ok(Array.isArray(preserved) && new Set(preserved).size === preserved.length);
  for (const path of preserved) {
    assert.ok(typeof path === "string" && !/[\\:\x00-\x1f]/u.test(path) &&
      path.split("/").every(part => part && part !== "." && part !== ".."));
  }
  assert.ok(Array.isArray(plugin.verifiedReleases));
  checkDisplayVersion(card, plugin.verifiedReleases);
  const hashes = new Set();
  for (const release of plugin.verifiedReleases) {
    for (const key of ["version", "hostRange", "platform", "arch", "verification"]) {
      assert.ok(typeof release[key] === "string" && release[key].trim(), plugin.id + ": missing " + key);
    }
    assert.match(release.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(parseHostRange(release.hostRange), plugin.id + ": invalid hostRange");
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!hashes.has(release.sha256), "Duplicate official asset");
    hashes.add(release.sha256);
    assert.ok(Number.isSafeInteger(release.fileCount) && release.fileCount > 0);
    assert.ok(Number.isSafeInteger(release.sizeBytes) && release.sizeBytes > 0);
    if (release.recognitionOnly === true) {
      assert.equal(release.delivery, "inventory");
      assert.equal(release.inventoryPath, "market/inventories/" + release.sha256 + ".json");
      assert.deepEqual(checkInventory(release.sha256, preserved), { sizeBytes: release.sizeBytes, fileCount: release.fileCount });
    } else if (release.delivery === "github-release") {
      assert.equal(checkInventory(release.inventorySha256, preserved).fileCount, release.fileCount);
      const base = repo.href + "/releases/download/v" + release.version + "/" +
        [plugin.id, release.version, release.platform, release.arch].join("-");
      if (release.composition) {
        const { packagePart, zipPart, name, version } = release.composition;
        assert.ok(name?.trim() && version?.trim());
        assert.equal(release.assetUrl, undefined);
        assert.equal(packagePart.repository, plugin.repository);
        assert.equal(packagePart.assetUrl, base + "-plugin-only.wlpkg.gz");
        for (const part of [packagePart, zipPart]) {
          assert.match(part.sha256, /^[a-f0-9]{64}$/);
          assert.ok(Number.isSafeInteger(part.sizeBytes) && part.sizeBytes > 0);
        }
        assert.match(zipPart.repository, /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
        const prefix = zipPart.repository + "/releases/download/";
        assert.ok(zipPart.assetUrl.startsWith(prefix) && /^[\w.-]+\/[\w.-]+\.zip$/.test(zipPart.assetUrl.slice(prefix.length)));
        const inventory = JSON.parse(read("../inventories/" + release.inventorySha256 + ".json"));
        const files = new Set(inventory.files.map(file => file.path));
        assert.ok(Array.isArray(zipPart.files) && zipPart.files.length > 0);
        const members = new Set();
        for (const { path, member } of zipPart.files) {
          assert.ok(files.delete(path), "Missing or duplicate component file");
          assert.ok(typeof member === "string" && member.split("/").every(part => /^[A-Za-z0-9_-][\w.-]*$/.test(part)));
          assert.ok(!members.has(member), "Duplicate upstream ZIP member");
          members.add(member);
        }
      } else {
        assert.equal(release.assetUrl, base + ".wlpkg.gz");
      }
    } else {
      assert.equal(release.delivery, "local-build");
      assert.ok(!release.assetUrl && !release.composition);
    }
    assert.ok(release.dependencies && typeof release.dependencies === "object" && !Array.isArray(release.dependencies));
    for (const [dep, range] of Object.entries(release.dependencies)) {
      assert.ok(ids.includes(dep) && dep !== plugin.id && typeof range === "string" && range.trim());
      if (dep === plugin.parentId)
        assert.match(range, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, plugin.id + ": expected a minimum stable parent version");
    }
    assert.deepEqual(Object.keys(release.dependencies).sort(), [...plugin.requiredPlugins].sort());
  }
}
const managedIds = new Set(manifest.plugins.map(p => p.parentId ? p.parentId + "/" + p.id : p.id));
const builds = new Set();
assert.ok(Array.isArray(manifest.installedBuilds ?? []));
for (const build of manifest.installedBuilds ?? []) {
  assert.match(build.runtimeId, /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/);
  assert.ok(!managedIds.has(build.runtimeId), "Installed build duplicates a managed plugin");
  for (const field of ["version", "platform", "arch"]) {
    assert.ok(typeof build[field] === "string" && build[field].length && build[field] === build[field].trim());
  }
  assert.match(build.sourceCommit, /^[a-f0-9]{40}$/);
  checkInventory(build.sha256);
  const key = JSON.stringify([build.runtimeId, build.version, build.platform, build.arch, build.sha256]);
  assert.ok(!builds.has(key), "Duplicate installed build");
  builds.add(key);
}
console.log("Official entries checked:", ids.join(", "));
