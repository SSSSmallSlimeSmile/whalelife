/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../core/index.ts";
import { digestFile } from "../core/official-package-files.ts";
import { OfficialPlugins } from "../core/official-plugins.ts";
import { officialUpdateEntries } from "../core/official-update-registry.ts";
import { compareVersions, stableVersion } from "../core/package-host-range.ts";

const [catalogFile, id, from, to, ...archives] = process.argv.slice(2);
if (!catalogFile || !id || !stableVersion.test(from) || !stableVersion.test(to) || compareVersions(to, from) <= 0)
  throw Error("用法：node tools/trial-official-update.mjs <official-releases.json> <目录 ID> <旧版本> <新版> [本地发行包…]");
const entries = officialUpdateEntries(JSON.parse(await readFile(catalogFile, "utf8")));
const target = entries.find(entry => entry.id === id);
for (const version of [from, to]) {
  if (!target?.verifiedReleases.some(r => !r.recognitionOnly && r.version === version))
    throw Error("待验目录缺少正式发行包：" + id + " v" + version);
}
const oldEntries = entries.map(entry => entry !== target ? entry : {
  ...entry, verifiedReleases: entry.verifiedReleases.filter(r => r.version === from),
});
const runtimeId = target.parentId ? target.parentId + "/" + id : id;
const localFiles = archives.map(p => resolve(p));
const originalDirectory = process.cwd();
const base = fileURLToPath(new URL("../.artifacts/official-update-trials", import.meta.url));
await mkdir(base, {recursive:true});
if (await realpath(base) !== base) throw Error("验收目录使用了链接。");
const root = await mkdtemp(join(base, "trial-"));
let app;
try {
  process.chdir(root);
  const cache = join(root, ".artifacts", "official-packages");
  await mkdir(cache, {recursive:true});
  const allowed = new Set(entries.flatMap(entry => entry.verifiedReleases.filter(r => !r.recognitionOnly).map(r => r.sha256)));
  for (const archive of localFiles) {
    const sha = await digestFile(archive);
    if (!allowed.has(sha)) throw Error("本地包的 SHA-256 未登记在待验目录：" + archive);
    await copyFile(archive, join(cache, sha + ".wlpkg.gz"));
  }
  const config = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
  config.web = {host:"127.0.0.1", port:0};
  config.providers = [];
  config.models = [];
  config.log = {level:"error"};
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify(config), {flag:"wx"});
  app = await boot(root);
  const old = new OfficialPlugins(app.runtime, oldEntries);
  const install = (await old.list()).plugins.find(p => p.id === id);
  assert.equal(install?.action, "install", install?.reason);
  assert.equal(install.version, from);
  assert.ok(install.planKey);
  await old.apply({id, action:"install", planKey:install.planKey});
  const running = () => app.runtime.list().find(p => p.id === runtimeId);
  assert.equal(running()?.version, from);
  assert.equal(running()?.status, "active");

  const pluginDir = join(root, "plugins", runtimeId.split("/").join("/sub/"));
  const markers = [];
  for (const name of ["config", "data"]) {
    const directory = join(pluginDir, name);
    const file = join(directory, "trial-" + randomUUID() + ".txt");
    const content = randomUUID();
    await mkdir(directory, {recursive:true});
    await writeFile(file, content, {flag:"wx"});
    markers.push({name, file, content});
  }
  const candidate = new OfficialPlugins(app.runtime, entries);
  const update = await candidate.updatePlan(id, to);
  assert.equal(update.action, "update", update.reason);
  assert.equal(update.installedVersion, from);
  assert.equal(update.version, to);
  assert.ok(update.planKey);
  let failure;
  try { await candidate.apply({id, action:"update", version:to, planKey:update.planKey}); }
  catch (error) { failure = error; }
  const plugins = app.runtime.list().filter(p => p.id === runtimeId || p.id.startsWith(runtimeId + "/"))
    .map(({id, version, status}) => ({id, version, status}));
  const preserved = {};
  for (const {name, file, content} of markers)
    preserved[name] = await readFile(file, "utf8").then(value => value === content, () => false);
  console.log(JSON.stringify({id:runtimeId, from, to, action:"update", plugins, preserved}));
  const expected = failure ? from : to;
  if (running()?.version !== expected || running()?.status !== "active" || !preserved.config || !preserved.data)
    throw Error(failure ? "原地更新失败，回滚后的版本、运行状态或持久资料未通过核对。" :
      "更新后的版本、运行状态或持久资料未通过核对。", {cause:failure});
  if (failure) throw failure;
} finally {
  try { await app?.close(); }
  finally {
    process.chdir(originalDirectory);
    if (dirname(root) !== base || await realpath(base) !== base || await realpath(root) !== root)
      throw Error("验收目录路径已变更，已停止清理。");
    await rm(root, {recursive:true, force:true, maxRetries:3, retryDelay:100});
  }
}
