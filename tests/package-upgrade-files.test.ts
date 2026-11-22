import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { inspectOfficialFiles, installOfficialFiles, recoverPendingPluginReplacements,
  replaceOfficialFiles, rollbackInterruptedInstall } from "../core/official-package-files.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
import { boot, prepareHostTrial } from "../core/index.ts";
import { beginUpdateDependencies } from "../core/package-update-journal.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function put(base: string, path: string, data: string | Buffer) {
  const destination = join(base, path);
  await mkdir(dirname(destination), {recursive:true});
  await writeFile(destination, data);
}
async function archive(root: string, files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, value]) => ({path, bytes:Buffer.from(value)}));
  const header = Buffer.from(JSON.stringify({format:1, files:entries.map(({path,bytes}) => ({path, size:bytes.length, sha256:hash(bytes)}))}));
  const bytes = gzipSync(Buffer.concat([header, Buffer.from("\n"), ...entries.map(f => f.bytes)]));
  const spec = {directory:"plugins/demo", sha256:hash(bytes)};
  await put(root, ".artifacts/official-packages/" + spec.sha256 + ".wlpkg.gz", bytes);
  return {header, spec};
}
async function fixture(extra: Record<string,string> = {}) {
  const root = await temporaryDirectory("whale-upgrade-files-");
  const manifest = "id: demo\nname: Demo\ndescription: Package upgrade fixture\nversion: ";
  const old = await archive(root, {"plugin.yaml":manifest + "1.0.0", "old/entry.ts":"original"});
  const next = await archive(root, {"plugin.yaml":manifest + "1.1.0", "new/entry.ts":"replacement", ...extra});
  await installOfficialFiles(root, old.spec);
  return { root, base:join(root, old.spec.directory), cache:join(root, ".artifacts/official-packages"), old, next };
}

test("确认新版本仅保留新程序、原配置、二进制图片、标签和独立子插件", async () => {
  const {root, base, cache, old, next} = await fixture();
  const picture = Buffer.from([0, 255, 7, 0, 117]);
  await put(base, "data/images/image.png", picture);
  await put(base, "data/tags.json", '["猫"]');
  await put(base, "config.yaml", "lang: zh");
  await put(base, "sub/independent/plugin.yaml", "id: independent");
  const transaction = await replaceOfficialFiles(root, old.spec, next.spec);
  assert.equal((await inspectOfficialFiles(root, next.spec)).state, "installed");
  await assert.rejects(installOfficialFiles(root, old.spec), /更新事务/);
  await transaction.commit();
  await transaction.commit();
  assert.deepEqual(await readFile(join(base, "data/images/image.png")), picture);
  assert.equal(await readFile(join(base, "data/tags.json"), "utf8"), '["猫"]');
  assert.equal(await readFile(join(base, "config.yaml"), "utf8"), "lang: zh");
  assert.equal(await readFile(join(base, "sub/independent/plugin.yaml"), "utf8"), "id: independent");
  await assert.rejects(readFile(join(base, "old/entry.ts")), {code:"ENOENT"});
  assert.equal((await readdir(cache)).length, 2);
});

test("新版迁移写坏、删除和新增资料时回滚快照，独立子插件在此期间的写入仍保留", async () => {
  const {root, base, cache, old, next} = await fixture();
  await put(base, "data/image", "old image");
  await put(base, "settings.json", '{"color":"blue"}');
  await put(base, "sub/other/data/events", "original");
  const transaction = await replaceOfficialFiles(root, old.spec, next.spec);
  await put(base, "data/image", "corrupted by migration");
  await rename(join(base, "settings.json"), join(base, "data/new-settings"));
  await put(base, "data/new", "partial result");
  await put(base, "sub/other/data/events", "concurrent sibling activity");
  await transaction.rollback();
  await transaction.rollback();
  assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
  assert.equal(await readFile(join(base, "data/image"), "utf8"), "old image");
  assert.equal(await readFile(join(base, "settings.json"), "utf8"), '{"color":"blue"}');
  assert.equal(await readFile(join(base, "sub/other/data/events"), "utf8"), "concurrent sibling activity");
  assert.deepEqual(await readdir(join(base, "data")), ["image"]);
  assert.equal((await readdir(cache)).length, 2);
});

test("程序归属有疑问、被替换或新版包被篡改时保留原目录", async () => {
  const {root, base, old, next, cache} = await fixture();
  await put(base, "old/entry.ts", "user modified");
  await assert.rejects(replaceOfficialFiles(root, old.spec, next.spec), /old\/entry.ts/);
  assert.equal(await readFile(join(base, "old/entry.ts"), "utf8"), "user modified");
  await put(base, "old/entry.ts", "original");
  await put(base, "personal.ts", "unknown");
  await assert.rejects(replaceOfficialFiles(root, old.spec, next.spec), /personal.ts/);
  await rename(join(base, "personal.ts"), join(root, "personal.ts"));
  await put(cache, next.spec.sha256 + ".wlpkg.gz", "tampered");
  await assert.rejects(replaceOfficialFiles(root, old.spec, next.spec), /SHA-256/);
  assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
});

test("遇到新版抢占独立子插件时保留原目录和其他子插件", async () => {
  const {root, base, cache, old, next} = await fixture({"sub/z/plugin.yaml":"id: z"});
  await put(base, "sub/a/data/index", "sibling data");
  await put(base, "sub/z/plugin.yaml", "independent program");
  await assert.rejects(replaceOfficialFiles(root, old.spec, next.spec), /独立子插件目录冲突/);
  assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
  assert.equal(await readFile(join(base, "sub/a/data/index"), "utf8"), "sibling data");
  assert.equal(await readFile(join(base, "sub/z/plugin.yaml"), "utf8"), "independent program");
  assert.equal((await readdir(cache)).length, 2);
});

test("新包开始携带子插件时可沿用先前卸载留下的资料，回滚后资料仍可复用", async () => {
  const {root, base, old, next} = await fixture({"sub/z/plugin.yaml":"id: z", "sub/z/index.ts":"new"});
  await put(base, "sub/z/data/labels", "old labels");
  await put(base, "sub/z/sub/sibling/data/events", "old activity");
  const transaction = await replaceOfficialFiles(root, old.spec, next.spec);
  assert.equal(await readFile(join(base, "sub/z/data/labels"), "utf8"), "old labels");
  await put(base, "sub/z/data/labels", "partial migration");
  await put(base, "sub/z/sub/sibling/data/events", "new activity");
  await transaction.rollback();
  assert.equal(await readFile(join(base, "sub/z/data/labels"), "utf8"), "old labels");
  assert.equal(await readFile(join(base, "sub/z/sub/sibling/data/events"), "utf8"), "new activity");
  await assert.rejects(readFile(join(base, "sub/z/plugin.yaml")), {code:"ENOENT"});
});

test("回滚将试运行期间新增的未知文件隔离保留，同时正常恢复旧插件", async () => {
  const {root, base, cache, old, next} = await fixture();
  const transaction = await replaceOfficialFiles(root, old.spec, next.spec);
  await put(base, "unexpected.txt", "local edit");
  await transaction.rollback();
  assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
  const saved = (await readdir(cache)).find(name => name.startsWith("settled-"));
  assert.ok(saved);
  assert.ok(transaction.cleanupWarning.includes(saved));
  assert.equal(await readFile(join(cache, saved, "trial/unexpected.txt"), "utf8"), "local edit");
});

test("资料中的链接阻止切换且不改写链接目标", async () => {
  const {root, base, cache, old, next} = await fixture();
  await put(root, "elsewhere/value", "external");
  await mkdir(join(base, "data"));
  await symlink(join(root, "elsewhere"), join(base, "data/link"), "junction");
  await assert.rejects(replaceOfficialFiles(root, old.spec, next.spec), /链接/);
  assert.equal(await readFile(join(root, "elsewhere/value"), "utf8"), "external");
  assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
  assert.equal((await readdir(cache)).length, 2);
});

test("仅有历史清单、没有旧包缓存的手动安装也可以更新并还原", async () => {
  const root = await temporaryDirectory("whale-upgrade-inventory-");
  const {header, spec} = await archive(root, {"plugin.yaml":"version: 1.0.0", "index.ts":"original"});
  const next = await archive(root, {"plugin.yaml":"version: 1.1.0", "index.ts":"new"});
  const sha256 = hash(header);
  await put(root, "market/inventories/" + sha256 + ".json", header);
  await mkdir(join(root, "core"));
  // Load a private copy of this standalone reader so its immutable inventory path uses the test fixture.
  const modulePath = join(root, "core/official-package-files.ts");
  await copyFile(new URL("../core/official-package-files.ts", import.meta.url), modulePath);
  await copyFile(new URL("../core/instance-directory.ts", import.meta.url), join(root, "core/instance-directory.ts"));
  await copyFile(new URL("../core/plugin-replacement-recovery.ts", import.meta.url), join(root, "core/plugin-replacement-recovery.ts"));
  await rename(join(root, ".artifacts/official-packages", spec.sha256 + ".wlpkg.gz"), join(root, "unused.gz"));
  const old = {directory:spec.directory, recognitionOnly:true, sha256};
  await put(root, "plugins/demo/plugin.yaml", "version: 1.0.0");
  await put(root, "plugins/demo/index.ts", "original");
  const mod: typeof import("../core/official-package-files.ts") = await import(pathToFileURL(modulePath).href);
  const transaction = await mod.replaceOfficialFiles(root, old, next.spec);
  assert.equal(await readFile(join(root, "plugins/demo/index.ts"), "utf8"), "new");
  await transaction.rollback();
  assert.equal(await readFile(join(root, "plugins/demo/index.ts"), "utf8"), "original");
});

test("上次进程在换名间中断时保留备份，阻止把空缺位置作为新安装", async () => {
  const {root, base, cache, old, next} = await fixture();
  const interrupted = join(cache, "updating-plugins.demo");
  await mkdir(interrupted);
  await rename(base, join(interrupted, "original"));
  assert.match((await inspectOfficialFiles(root, next.spec)).reason!, /更新事务/);
  await assert.rejects(installOfficialFiles(root, next.spec), /更新事务/);
  assert.equal(await readFile(join(interrupted, "original/old/entry.ts"), "utf8"), "original");
  await assert.rejects(readdir(base), {code:"ENOENT"});
  assert.equal(old.spec.directory, next.spec.directory);
});

const transactionId = "63438f75-f3e3-44a1-87db-875ad41e2df5";
async function interruptFixture(prepared?: Awaited<ReturnType<typeof fixture>>) {
  const fixtureState = prepared ?? await fixture();
  const {root, old, next, base, cache} = fixtureState;
  await put(base, "data/config.json", "before migration");
  await put(base, "sub/other/data/events", "original events");
  const script = [
    "const [source, root, previous, next, token] = process.argv.slice(1);",
    "const {replaceOfficialFiles} = await import(source);",
    "await replaceOfficialFiles(root, JSON.parse(previous), JSON.parse(next), token);",
    "process.exit(0);",
  ].join("\n");
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script,
    new URL("../core/official-package-files.ts", import.meta.url).href, root, JSON.stringify(old.spec), JSON.stringify(next.spec), transactionId]);
  return {...fixtureState, stage:join(cache, "updating-plugins.demo")};
}

test("宿主升级预检保留中断的插件更新和依赖记录，正式启动后恢复一次", async () => {
  const prepared = await fixture();
  const {root, base, cache, next} = prepared;
  await put(root, "config/config.json", JSON.stringify({
    log: {level:"error"}, web: {host:"127.0.0.1", port:0}, providers:[], models:[],
    model_bindings:{}, personas:{}, channels:{}, memory:{root:"memory", budget_tokens:6000},
  }));
  await put(root, "plugins/helper/plugin.yaml", "id: helper\nname: Helper\ndescription: Recovery dependency\nversion: 1.0.0");
  await put(root, "config/plugins.json", JSON.stringify({version:1, disabled:["demo", "helper"]}));
  const transaction = await beginUpdateDependencies(root, transactionId, "demo", next.spec.sha256, [{
    id:"helper", action:"enable", enabled:false, mayRemove:false,
    files:{directory:"plugins/helper", sha256:next.spec.sha256}, dependencies:[], bundled:[],
  }]);
  await transaction!.start("helper");
  await put(root, "config/plugins.json", JSON.stringify({version:1, disabled:["demo"]}));
  await interruptFixture(prepared);
  const journal = join(cache, "update-dependencies-" + transactionId + ".json");
  const before = await readFile(journal);
  const trial = await prepareHostTrial(root);
  try {
    assert.deepEqual(await readFile(journal), before);
    assert.equal(await readFile(join(base,"new/entry.ts"), "utf8"), "replacement");
    assert.deepEqual(JSON.parse(await readFile(join(root,"config/plugins.json"),"utf8")).disabled, ["demo"]);
  } finally { await trial.close(); }
  const active = await boot(root);
  try {
    assert.equal(await readFile(join(base,"old/entry.ts"), "utf8"), "original");
    assert.equal(active.runtime.pluginState.enabled("helper"), false);
    await assert.rejects(readFile(journal), {code:"ENOENT"});
    assert.deepEqual(await recoverPendingPluginReplacements(root), []);
  } finally { await active.close(); }
});

test("重启恢复已切换但未提交的程序和资料，同时保留独立子插件的新写入", async () => {
  const {root, base, old, cache} = await interruptFixture();
  await put(base, "data/config.json", "partial migration");
  await put(base, "sub/other/data/events", "recent events");
  const result = await recoverPendingPluginReplacements(root);
  assert.deepEqual(result.map(r => [r.directory,r.status]), [["plugins/demo","restored"]], JSON.stringify(result));
  assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
  assert.equal(await readFile(join(base, "data/config.json"), "utf8"), "before migration");
  assert.equal(await readFile(join(base, "sub/other/data/events"), "utf8"), "recent events");
  assert.equal((await readdir(cache)).length, 2);
  assert.deepEqual(await recoverPendingPluginReplacements(root), []);
});

test("重启区分同版本的旧回执与本次已提交的回执，社区和官方均可从确认间隙继续", async () => {
  for (const kind of ["community", "official", "stale"]) {
    const {root, base, old, next} = await interruptFixture();
    const receipt = {id:"demo", name:"demo", version:"1.1.0", sha256:next.spec.sha256, dependencies:[],
      transactionId: kind === "stale" ? "88f7e6a4-d2d1-4453-beaf-957a29ba96c4" : transactionId,
      repository:"https://github.com/example/demo", platform:process.platform, arch:process.arch, bundledPluginIds:[], preserve:[]};
    await put(root, "config/community-installs.json", JSON.stringify({format:1,
      installs:kind === "official" ? [] : [receipt], officialInstalls:kind === "official" ? [receipt] : []}));
    await put(base, "data/config.json", "healthy new data");
    const result = await recoverPendingPluginReplacements(root);
    assert.equal(result[0].status, kind === "stale" ? "restored" : "committed", JSON.stringify(result));
    assert.equal((await inspectOfficialFiles(root, kind === "stale" ? old.spec : next.spec)).state, "installed");
    assert.equal(await readFile(join(base, "data/config.json"), "utf8"), kind === "stale" ? "before migration" : "healthy new data");
    assert.deepEqual(await recoverPendingPluginReplacements(root), []);
  }
});

test("进程在磁盘切换或回滚的两次换名之间退出时，依据目录身份接续", async () => {
  for (const step of ["candidate","trial", "independent-restored", "original-restored"]) {
    const {root, base, stage, old} = await interruptFixture();
    const donor = join(stage, step === "candidate" ? "candidate" : "trial");
    await rename(base, donor);
    if (step === "independent-restored" || step === "original-restored") {
      await rename(join(donor, "sub/other"), join(stage, "original/sub/other"));
      if (step === "original-restored") await rename(join(stage, "original"), base);
    }
    const result = await recoverPendingPluginReplacements(root);
    assert.equal(result[0].status, "restored", step + ": " + JSON.stringify(result));
    assert.equal((await inspectOfficialFiles(root, old.spec)).state, "installed");
    assert.equal(await readFile(join(base, "sub/other/data/events"), "utf8"), "original events");
    assert.deepEqual(await recoverPendingPluginReplacements(root), []);
  }
});

test("身份不符或独立子插件归属不明时保留现场，也继续检查其他备份", async () => {
  const {root, base, cache, stage} = await interruptFixture();
  await mkdir(join(cache, "updating-plugins.another"));
  await rename(join(base, "sub/other"), join(root, "externally-moved"));
  await put(base, "sub/other/data/events", "different directory");
  const result = await recoverPendingPluginReplacements(root);
  assert.equal(result.length, 2);
  assert.ok(result.every(r => r.status === "pending"), JSON.stringify(result));
  assert.equal(await readFile(join(stage, "original/old/entry.ts"), "utf8"), "original");
  assert.equal(await readFile(join(base, "sub/other/data/events"), "utf8"), "different directory");
  assert.equal(await readFile(join(root, "externally-moved/data/events"), "utf8"), "original events");
});

test("中断安装的新依赖只撤销实际发布且摘要吻合的程序，遇到未知文件时不动", async () => {
  const root = await temporaryDirectory("whale-partial-install-");
  const {spec} = await archive(root, {"plugin.yaml":"version: 1.0.0", "bin/first.ts":"first", "bin/second.ts":"second"});
  const base = join(root, spec.directory);
  // An install publishes the manifest last; a hard stop can leave executable files and no manifest.
  await put(base, "bin/first.ts", "first");
  await put(base, "data/kept", "user data");
  await put(base, "unknown", "local edit");
  await assert.rejects(rollbackInterruptedInstall(root, spec), /unknown/);
  assert.equal(await readFile(join(base, "bin/first.ts"), "utf8"), "first");
  await rename(join(base, "unknown"), join(root, "unknown"));
  await put(base, "bin/first.ts", "modified");
  await assert.rejects(rollbackInterruptedInstall(root, spec), /first.ts/);
  await put(base, "bin/first.ts", "first");
  await rollbackInterruptedInstall(root, spec);
  await rollbackInterruptedInstall(root, spec);
  assert.deepEqual(await readdir(base), ["data"]);
  assert.equal(await readFile(join(base, "data/kept"), "utf8"), "user data");
});
