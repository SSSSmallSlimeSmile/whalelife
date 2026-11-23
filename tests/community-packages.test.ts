import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CommunityPackages, installedCommunityPackages, type ReviewedCommunityEntry, type ReviewedCommunityRelease } from "../core/community-packages.ts";
import { Runtime } from "../core/runtime.ts";
import { startWeb } from "../core/web.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
import { compatibleHostFloor } from "../core/package-host-range.ts";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const program = "export function apply(){}";
test("reviewed host ranges accept newer stable hosts and enforce numeric lower and upper bounds", () => {
  for (const host of ["0.1.0", "0.1.1", "0.1.10", "1.0.0"]) assert.equal(compatibleHostFloor("0.1.0", host), "0.1.0");
  assert.equal(compatibleHostFloor("0.1.10", "0.1.2"), undefined);
  assert.equal(compatibleHostFloor(">=0.1.0 <=0.1.10", "0.1.10"), "0.1.0");
  assert.equal(compatibleHostFloor(">=0.1.0 <0.1.10", "0.1.10"), undefined);
  assert.equal(compatibleHostFloor("=0.1.0", "0.1.1"), undefined);
  assert.equal(compatibleHostFloor("=0.1.0", "0.1.0"), "0.1.0");
  assert.equal(compatibleHostFloor("0.1.0", "0.1.1-preview"), undefined);
});
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-community-install-");
  const runtime = new Runtime(root, {info() {}, error() {}, warn() {}} as any);
  t.after(() => runtime.bus.stop());
  await runtime.bus.start();
  await runtime.scan();
  const assets = new Map<string, Buffer>(), downloads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL | string) => {
    const href = String(url);
    downloads.push(href);
    const bytes = assets.get(href);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, {status:404});
  });
  function plugin(id: string, version = "1.0.0", options: {deps?: Record<string,string>; extra?: Record<string,string>;
    children?: string[]; source?: string; manifest?: Record<string,unknown>} = {}) {
    const repository = "https://github.com/testing/" + id.replaceAll("/", "-");
    const assetUrl = repository + "/releases/download/v" + version + "/plugin.wlpkg.gz";
    const manifest = {id:id.split("/").at(-1), name:id, version, description:"test", ...options.manifest};
    const files = Object.entries({"plugin.yaml":JSON.stringify(manifest), "index.ts":options.source ?? program, ...options.extra})
      .map(([path, text]) => ({path, bytes:Buffer.from(text)}));
    const inventory = files.map(f => ({path:f.path, size:f.bytes.length, sha256:hash(f.bytes)}));
    const packed = gzipSync(Buffer.concat([Buffer.from(JSON.stringify({format:1, files:inventory}) + "\n"), ...files.map(f => f.bytes)]));
    assets.set(assetUrl, packed);
    const release: ReviewedCommunityRelease = {version, platform:"any", arch:"any", hostRange:"0.1.0",
      sha256:hash(packed), sizeBytes:packed.length, assetUrl, dependencies:options.deps ?? {}, bundledPluginIds:options.children};
    const entry: ReviewedCommunityEntry = {id, name:id, description:"fixture", repository, installation:repository,
      dependencies:Object.keys(release.dependencies), verifiedReleases:[release]};
    return {entry, release, packed, files};
  }
  return {root, runtime, assets, downloads, plugin, manager:(entries: ReviewedCommunityEntry[]) => new CommunityPackages(runtime, entries)};
}
async function row(manager: CommunityPackages, id: string) {
  const result = (await manager.list()).plugins.find(p => p.id === id);
  assert.ok(result);
  return result;
}

test("the web confirmation rejects a withdrawn or changed approval and cannot bypass the manual check", async t => {
  const localFetch = globalThis.fetch;
  const f = await fixture(t), old = f.plugin("notes"), next = f.plugin("notes","1.1.0");
  const manager = f.manager([old.entry]);
  await manager.apply(await row(manager,"notes"));
  const catalog = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
  const publish = (community: unknown[]) => f.assets.set(catalog,Buffer.from(JSON.stringify({official:[],community})));
  publish([next.entry]);
  const web = await startWeb({web:{port:0}}, {channels:{},logger:{info(){},error(){}}}, f.runtime);
  t.after(() => web.close());
  const origin = "http://127.0.0.1:" + (web.server.address() as {port:number}).port;
  const cookie = (await localFetch(origin+"/api/login",{method:"POST",body:"{}"})).headers.get("set-cookie")!.split(";")[0];
  const post = (route: string, body: unknown) => localFetch(origin+route,{method:"POST",
    headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify(body)});
  const input = {id:"notes",source:"community",version:"1.1.0"};
  assert.equal((await post("/api/plugin-updates/preview",input)).status,409);
  const check = await post("/api/plugin-updates/check",{});
  assert.equal((await check.json()).updates[0].latestVersion,"1.1.0");
  const preview = await (await post("/api/plugin-updates/preview",input)).json();
  assert.ok(preview.planKey,preview.reason);
  const confirmed = {...input,planKey:preview.planKey};
  assert.equal((await post("/api/official-plugins/apply",{...confirmed,action:"update"})).status,409);
  assert.equal((await post("/api/plugin-updates/apply",{...confirmed,assetUrl:next.release.assetUrl})).status,400);
  publish([]);
  assert.equal((await post("/api/plugin-updates/apply",confirmed)).status,409);
  publish([{...next.entry,verifiedReleases:[{...next.release,sha256:"e".repeat(64)}]}]);
  assert.equal((await post("/api/plugin-updates/apply",confirmed)).status,409);
  assert.equal(f.runtime.records.get("notes").manifest.version,"1.0.0");
  assert.ok(!f.downloads.includes(next.release.assetUrl));
  publish([next.entry]);
  const saved = await post("/api/plugin-updates/apply",confirmed);
  assert.equal(saved.status,200,await saved.text());
  assert.equal(f.runtime.records.get("notes").manifest.version,"1.1.0");
  assert.equal((await post("/api/plugin-updates/apply",confirmed)).status,409);
});

test("a matching reviewed child cannot be removed separately from an unrecognized manual parent build", async t => {
  const f = await fixture(t);
  const child = f.plugin("manual-studio/brush", "1.0.0", {deps:{"manual-studio":"1.0.0"}});
  const parent = f.plugin("manual-studio", "1.0.0", {children:[child.entry.id],
    extra:Object.fromEntries(child.files.map(file => ["sub/brush/" + file.path, file.bytes.toString()]))});
  const store = f.manager([parent.entry]);
  await store.apply(await row(store, parent.entry.id));
  // Simulate a manual installation which included byte-identical reviewed child files.
  await writeFile(join(f.root,"config/community-installs.json"),JSON.stringify({format:1,installs:[]}));
  await writeFile(join(f.root,".artifacts/official-packages",child.release.sha256 + ".wlpkg.gz"),child.packed);
  const newer = f.plugin(parent.entry.id,"1.1.0");
  for (const reviews of [[child.entry], [newer.entry,child.entry]]) {
    const managed = await installedCommunityPackages(f.runtime,reviews);
    assert.ok(!managed.plugins.some(p => p.id === child.entry.id));
    await assert.rejects(managed.preview(child.entry.id), /独立社区发行包/);
    await assert.rejects(managed.apply(child.entry.id,"0".repeat(64)), /独立社区发行包/);
  }
  const otherBuild = f.plugin(parent.entry.id);
  const managed = await installedCommunityPackages(f.runtime,[otherBuild.entry,child.entry]);
  const unverified = await managed.preview(child.entry.id);
  assert.equal(unverified.action,null);
  assert.match(unverified.reason,/不能确认|无法核对/);
  await assert.rejects(managed.apply(child.entry.id,"0".repeat(64)));
  await writeFile(join(f.root,"config/community-installs.json"),JSON.stringify({format:1,installs:[{
    id:child.entry.id, name:child.entry.name, version:child.release.version, sha256:child.release.sha256,
    dependencies:[parent.entry.id], repository:child.entry.repository,
  }]}));
  const orphan = await installedCommunityPackages(f.runtime,[]);
  assert.ok(orphan.plugins.some(p => p.id === child.entry.id));
  assert.equal((await orphan.preview(child.entry.id)).action,null);
  await assert.rejects(orphan.apply(child.entry.id,"0".repeat(64)));
  assert.equal(f.runtime.records.get(child.entry.id).status,"active");
  assert.equal(await readFile(join(f.root,"plugins/manual-studio/sub/brush/index.ts"),"utf8"),program);
});

test("an independently installed community add-on under an official parent uses the current parent's ownership", async t => {
  const f = await fixture(t);
  const repository = "https://github.com/iinukami/whalelife-plugin-surf";
  const parent = f.plugin("surf", "7.0.1", {manifest:{repository}});
  const child = f.plugin("surf/douyin", "1.0.0", {deps:{surf:"7.0.0"}});
  const cache = join(f.root,".artifacts/official-packages"), base = join(f.root,"plugins/surf"), sub = join(base,"sub/douyin");
  await mkdir(cache,{recursive:true});
  await mkdir(sub,{recursive:true});
  for (const [plugin,dir] of [[parent,base], [child,sub]] as const) {
    await writeFile(join(cache,plugin.release.sha256 + ".wlpkg.gz"),plugin.packed);
    for (const file of plugin.files) await writeFile(join(dir,file.path),file.bytes);
  }
  await f.runtime.loadPath("surf");
  assert.equal(f.runtime.records.get(child.entry.id).status,"active");
  const receipts = {format:1, installs:[{id:child.entry.id,name:"抖音",version:child.release.version,sha256:child.release.sha256,
    repository:child.entry.repository,dependencies:["surf"],dependencyVersions:{surf:"7.0.0"}}],
    officialInstalls:[{id:"surf",name:"网上冲浪",version:parent.release.version,sha256:parent.release.sha256,
      repository,platform:process.platform,arch:process.arch,bundledPluginIds:[],preserve:[],dependencies:[]}]};
  const receiptFile = join(f.root,"config/community-installs.json");
  await mkdir(join(f.root,"config"),{recursive:true});
  await writeFile(receiptFile,JSON.stringify(receipts));
  const independent = await installedCommunityPackages(f.runtime,[]);
  assert.deepEqual(independent.plugins.map(p => p.id),[child.entry.id]);
  const approved = await independent.preview(child.entry.id);
  assert.equal(approved.action,"uninstall",approved.reason);

  // A previous receipt of the child cannot authorize changing another, unknown build of its parent.
  await writeFile(receiptFile,JSON.stringify({...receipts,officialInstalls:[]}));
  const unknown = await installedCommunityPackages(f.runtime,[]);
  assert.equal((await unknown.preview(child.entry.id)).action,null);
  await assert.rejects(unknown.apply(child.entry.id,approved.planKey));
  assert.equal(f.runtime.records.get(child.entry.id).status,"active");

  await writeFile(receiptFile,JSON.stringify(receipts));
  const confirmed = await installedCommunityPackages(f.runtime,[]);
  await confirmed.apply(child.entry.id,(await confirmed.preview(child.entry.id)).planKey);
  assert.equal(f.runtime.records.get("surf").status,"active");
  assert.equal(await readFile(join(base,"index.ts"),"utf8"),program);
  assert.ok(!f.runtime.records.has(child.entry.id));
});

test("management can preview and remove delisted packages offline, with separate ownership for independent children", async t => {
  const localFetch = globalThis.fetch;
  const f = await fixture(t);
  const studio = f.plugin("studio-tools", "1.0.0", {children:["studio-tools/brush"],
    manifest:{repository:"https://github.com/testing/studio-tools"}, extra:{
    "sub/brush/plugin.yaml":JSON.stringify({id:"brush",name:"Brush",description:"fixture",version:"0.3.0"}),
    "sub/brush/index.ts":program,
  }});
  const pen = f.plugin("studio-tools/pen", "1.0.0", {deps:{"studio-tools":"1.0.0"}});
  const store = f.manager([studio.entry, pen.entry]);
  await store.apply(await row(store, pen.entry.id));
  const receiptFile = join(f.root,"config/community-installs.json");
  const receipts = JSON.parse(await readFile(receiptFile,"utf8"));
  for (const receipt of receipts.installs) { delete receipt.repository; delete receipt.bundledPluginIds; }
  await writeFile(receiptFile, JSON.stringify(receipts)); // Older builds did not save these fields.
  const installed = await row(store, studio.entry.id);
  assert.equal(installed.action, "installed");
  assert.equal(installed.planKey, "");

  const web = await startWeb({web:{port:0}}, {channels:{},logger:{info(){},error(){}}}, f.runtime);
  t.after(() => web.close());
  const origin = "http://127.0.0.1:" + (web.server.address() as {port:number}).port;
  const cookie = (await localFetch(origin+"/api/login",{method:"POST",body:"{}"})).headers.get("set-cookie")!.split(";")[0];
  const manage = "/api/community-plugins/manage", uninstall = "/api/community-plugins/uninstall/";
  const get = () => localFetch(origin+manage, {headers:{cookie}});
  const post = (op: string, data: unknown) => localFetch(origin+uninstall+op, {method:"POST",
    headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify(data)});
  const preview = (id: string) => post("preview",{id}).then(r => r.json());
  const remove = (id: string, planKey: string) => post("apply",{id,planKey});
  const downloads = [...f.downloads];
  assert.equal((await localFetch(origin+manage)).status,401);
  assert.deepEqual((await (await get()).json()).plugins.map((p:any) => p.id).sort(),["studio-tools","studio-tools/pen"]);
  let owner = await preview(studio.entry.id);
  assert.equal(owner.action,null);
  assert.match(owner.reason,/studio-tools\/pen/);
  for (const id of ["studio-tools/brush","qq","unrelated"]) {
    assert.equal((await post("preview",{id})).status,409);
    assert.equal((await remove(id,"0".repeat(64))).status,409);
  }
  assert.equal((await post("preview",{id:studio.entry.id,directory:"plugins"})).status,400);
  assert.equal((await remove(studio.entry.id,"fake-key")).status,400);
  const child = await preview(pen.entry.id);
  assert.equal(child.action,"uninstall",child.reason);
  const archive = join(f.root,".artifacts/official-packages",studio.release.sha256 + ".wlpkg.gz");
  await writeFile(archive, Buffer.from("damaged ancestor"));
  assert.match((await preview(pen.entry.id)).reason,/不能确认此子插件可单独卸载/);
  assert.equal((await remove(pen.entry.id,child.planKey)).status,409);
  await writeFile(archive,studio.packed);
  assert.equal((await remove(pen.entry.id,child.planKey)).status,200);
  assert.equal((await remove(pen.entry.id,child.planKey)).status,409);
  await writeFile(archive, Buffer.from("damaged cache"));
  const unverifiable = await preview(studio.entry.id);
  assert.equal(unverifiable.action,null);
  assert.equal(unverifiable.planKey,"");
  assert.ok(unverifiable.reason);
  await writeFile(archive,studio.packed);
  owner = await preview(studio.entry.id);
  assert.equal(owner.action,"uninstall",owner.reason);
  assert.deepEqual(owner.bundledPlugins,[{id:"studio-tools/brush",name:"Brush"}]);
  const script = join(f.root,"plugins/studio-tools/sub/brush/index.ts");
  await writeFile(script,program+" // edited");
  const stale = await remove(studio.entry.id,owner.planKey);
  assert.equal(stale.status,409);
  assert.ok((await stale.json()).error);
  assert.equal(await readFile(script,"utf8"),program+" // edited");
  await writeFile(script,program);
  const saved = await remove(studio.entry.id,(await preview(studio.entry.id)).planKey);
  assert.equal(saved.status,200,await saved.text());
  assert.equal(f.runtime.records.has("studio-tools/brush"),false);
  assert.deepEqual(JSON.parse(await readFile(receiptFile,"utf8")).installs,[]);
  assert.deepEqual((await (await get()).json()).plugins,[]);
  assert.deepEqual(f.downloads,downloads);
});

test("cold install uses reviewed bytes only on confirmation, keeps old data, and serializes double clicks", async t => {
  const f = await fixture(t), top = f.plugin("notes"), manual = {...f.plugin("manual").entry, verifiedReleases:undefined};
  const manager = f.manager([top.entry, manual]);
  await mkdir(join(f.root, "plugins/notes/data"), {recursive:true});
  await writeFile(join(f.root, "plugins/notes/data/entry"), "old note");
  const plan = await row(manager, "notes");
  assert.equal(plan.action, "install");
  assert.deepEqual((await manager.list()).plugins.map(p => p.id), ["notes"]);
  await assert.rejects(manager.apply({id:"notes",action:"install",planKey:"stale"}), /重新确认|状态已变化/);
  await assert.rejects(manager.apply({id:"manual",action:"install",planKey:plan.planKey}), /审核/);
  assert.deepEqual(f.downloads, []);
  const result = await Promise.allSettled([manager.apply(plan), manager.apply(plan)]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
  assert.deepEqual(f.downloads, [top.release.assetUrl]);
  assert.equal(f.runtime.records.get("notes").status, "active");
  assert.equal(await readFile(join(f.root,"plugins/notes/data/entry"),"utf8"), "old note");
  assert.equal((await row(manager,"notes")).action,"installed");
  const receipts = JSON.parse(await readFile(join(f.root,"config/community-installs.json"),"utf8")).installs;
  assert.deepEqual(receipts.map((r:any) => [r.id,r.sha256]), [["notes",top.release.sha256]]);
});

test("a same-ID manual installation with different code is neither adopted nor overwritten", async t => {
  const f = await fixture(t), note = f.plugin("notes"), manager = f.manager([note.entry]);
  await mkdir(join(f.root,"plugins/notes"), {recursive:true});
  await writeFile(join(f.root,"plugins/notes/plugin.yaml"), JSON.stringify({id:"notes",name:"other",description:"other",version:"1.0.0"}));
  await writeFile(join(f.root,"plugins/notes/index.ts"), program + " // local");
  await f.runtime.loadPath("notes");
  const plan = await row(manager,"notes");
  assert.equal(plan.action,"blocked"); assert.match(plan.reason,/归属/);
  await assert.rejects(manager.apply({...plan,action:"install"}));
  assert.deepEqual(f.downloads,[]);
  assert.equal(await readFile(join(f.root,"plugins/notes/index.ts"),"utf8"),program + " // local");
});

test("manual community upgrades verify a missing old archive before replacing any installed file", async t => {
  for (const changed of [false,true]) {
    const f = await fixture(t), old = f.plugin("manual-note"), next = f.plugin("manual-note","1.1.0");
    const dir = join(f.root,"plugins",old.entry.id);
    await mkdir(dir);
    for (const file of old.files) await writeFile(join(dir,file.path),file.bytes);
    if (changed) await writeFile(join(dir,"index.ts"),program + " // local customization");
    await f.runtime.loadPath(old.entry.id);
    assert.equal((await f.manager([next.entry]).updatePlan(old.entry.id,"1.1.0")).planKey,"");
    next.entry.verifiedReleases!.push(old.release);
    const manager = f.manager([next.entry]), plan = await manager.updatePlan(old.entry.id,"1.1.0");
    assert.equal(plan.action,"update");
    assert.deepEqual(f.downloads,[]);
    const apply = manager.applyUpdate({id:old.entry.id,version:"1.1.0",planKey:plan.planKey});
    if (changed) {
      await assert.rejects(apply,/不一致/);
      assert.equal(await readFile(join(dir,"index.ts"),"utf8"),program + " // local customization");
      assert.equal(f.runtime.records.get(old.entry.id).manifest.version,"1.0.0");
    } else {
      await apply;
      assert.equal(f.runtime.records.get(old.entry.id).manifest.version,"1.1.0");
    }
    assert.deepEqual(new Set(f.downloads),new Set([old.release.assetUrl,next.release.assetUrl]));
  }
});

test("pin a dependency's reviewed version; reuse or explicitly enable it and restore its old state after failed activation", async t => {
  const f = await fixture(t), base = f.plugin("test-provider"), newer = f.plugin("test-provider","1.1.0");
  const child = f.plugin("test-provider/child","1.0.0",{deps:{"test-provider":"1.0.0"},source:'export function apply(){throw Error("fixture activation")}'});
  base.entry.verifiedReleases!.push(newer.release);
  const manager = f.manager([base.entry, child.entry]);
  const fresh = await row(manager,child.entry.id);
  assert.deepEqual(fresh.steps.map(s => [s.id,s.version,s.action]), [["test-provider","1.0.0","install"],[child.entry.id,"1.0.0","install"]]);
  await assert.rejects(manager.apply(fresh), (e:any) => /fixture activation/.test(e.message) && e.rolledBack.length === 2);
  assert.equal(f.runtime.records.has("test-provider"),false);
  await assert.rejects(readFile(join(f.root,"plugins/test-provider/plugin.yaml")), {code:"ENOENT"});
  const oldOnly = f.manager([{...base.entry,verifiedReleases:[base.release]},child.entry]);
  await oldOnly.apply(await row(oldOnly,"test-provider"));
  assert.equal((await row(manager,child.entry.id)).steps[0].action,"reuse");
  const future = f.manager([{...base.entry, verifiedReleases:[{...base.release, hostRange:"9.0.0"}]}, child.entry]);
  assert.equal((await row(future, child.entry.id)).action, "blocked");
  assert.equal((await row(future, base.entry.id)).action, "installed");
  await f.runtime.action("test-provider","stop");
  const stopped = await row(manager,child.entry.id);
  assert.equal(stopped.steps[0].action,"enable");
  await assert.rejects(manager.apply(stopped), /fixture activation/);
  assert.equal(f.runtime.pluginState.enabled("test-provider"),false);
  assert.equal(f.runtime.records.get("test-provider").status,"stopped");
  assert.equal(f.runtime.records.has(child.entry.id),false);
});

test("a reviewed bundled child is activated and identified without taking another plugin's directory", async t => {
  const f = await fixture(t);
  const bundle = f.plugin("studio-tools", "1.0.0", {children:["studio-tools/brush"], manifest:{sub:["brush"]}, extra:{
    "sub/brush/plugin.yaml":JSON.stringify({id:"brush",name:"Brush",description:"fixture",version:"0.3.0"}),
    "sub/brush/index.ts":program,
  }});
  const manager = f.manager([bundle.entry]);
  await manager.apply(await row(manager, bundle.entry.id));
  assert.equal(f.runtime.records.get("studio-tools/brush").status, "active");
  assert.equal((await row(manager, bundle.entry.id)).action, "installed");
  await assert.rejects(manager.apply({id:"studio-tools/brush",action:"install",planKey:"unknown"}));
});

test("corrupt bytes and identity or undeclared child mismatches fail before a dependency is installed", async t => {
  const f = await fixture(t), base = f.plugin("library"), deps = {library:"1.0.0"};
  const bad = f.plugin("bad","1.0.0",{deps}), packed = Buffer.from(bad.packed);
  packed[0] ^= 0xff; f.assets.set(bad.release.assetUrl, packed);
  const wrong = f.plugin("wrong","1.0.0",{deps,manifest:{id:"something-else"}});
  const extra = f.plugin("extra","1.0.0",{deps,extra:{"sub/shadow/index.ts":program}});
  for (const target of [bad,wrong,extra]) {
    const manager = f.manager([base.entry,target.entry]);
    await assert.rejects(manager.apply(await row(manager,target.entry.id)), (e:any) =>
      /SHA-256|插件清单|子插件文件/.test(e.message) && e.rolledBack.length === 0);
    assert.equal(f.runtime.records.size,0);
    await assert.rejects(readFile(join(f.root,"plugins/library/plugin.yaml")), {code:"ENOENT"});
  }
});

test("community removal rechecks bundled dependencies, unknown files and receipt failures without losing the running program", async t => {
  const f = await fixture(t), id = "ink", child = "ink/brush";
  const bundle = f.plugin(id, "1.0.0", {children:[child], extra:{
    "sub/brush/plugin.yaml":JSON.stringify({id:"brush",name:"画笔",description:"fixture",version:"0.1.0"}),
    "sub/brush/index.ts":program,
  }});
  const consumer = f.plugin("drawing", "1.0.0", {deps:{[child]:"0.1.0"}});
  const store = f.manager([bundle.entry]);
  await store.apply(await row(store,id));
  const local = () => installedCommunityPackages(f.runtime, [bundle.entry, consumer.entry]);
  const plan = await (await local()).preview(id);
  assert.deepEqual(plan.bundledPlugins,[{id:child,name:"画笔"}]);
  assert.equal(plan.action,"uninstall",plan.reason);

  const dir = join(f.root,"plugins",id);
  const orphan = join(dir,"sub","old");
  await mkdir(orphan,{recursive:true});
  await writeFile(join(orphan,"custom.ts"),"user script");
  await assert.rejects((await local()).apply(id,plan.planKey), /sub\/old\/custom\.ts/);
  assert.equal(await readFile(join(orphan,"custom.ts"),"utf8"),"user script");
  await unlink(join(orphan,"custom.ts"));
  await writeFile(join(orphan,"plugin.yaml"),"id: old");
  assert.match((await (await local()).preview(id)).reason,/ink\/old/);
  await unlink(join(orphan,"plugin.yaml"));
  await mkdir(join(orphan,"data"));
  await writeFile(join(orphan,"data","art"), "keep");

  const other = join(f.root,"plugins","drawing");
  await mkdir(other);
  for (const file of consumer.files) await writeFile(join(other,file.path),file.bytes);
  await f.runtime.loadPath("drawing");
  assert.match((await (await local()).preview(id)).reason, /drawing/);
  await f.runtime.stop("drawing");
  f.runtime.records.delete("drawing");

  const receiptPath = join(f.root,"config/community-installs.json");
  const original = JSON.parse(await readFile(receiptPath,"utf8"));
  // Change the receipt between confirmation and commit. The package transaction must restore
  // its own files and running children, without overwriting a concurrent installation record.
  const changed = structuredClone(original);
  changed.installs[0].sha256 = "f".repeat(64);
  const stop = f.runtime.stop.bind(f.runtime);
  t.mock.method(f.runtime,"stop",async (...args:Parameters<typeof stop>) => {
    await stop(...args);
    if (args[0] === id) await writeFile(receiptPath, JSON.stringify(changed));
  });
  await assert.rejects((await local()).apply(id,plan.planKey), /安装记录已变化/);
  assert.deepEqual(JSON.parse(await readFile(receiptPath,"utf8")),changed);
  assert.equal(f.runtime.records.get(id)?.status,"active");
  assert.equal(f.runtime.records.get(child)?.status,"active");
  for (const file of bundle.files) assert.deepEqual(await readFile(join(dir,file.path)), file.bytes);
  t.mock.restoreAll();
  await writeFile(receiptPath,JSON.stringify(original));
  await (await local()).apply(id,plan.planKey);
  assert.equal((JSON.parse(await readFile(receiptPath,"utf8"))).installs.length,0);
  assert.equal(await readFile(join(orphan,"data","art"),"utf8"),"keep");
});

test("package removal respects the runtime's global and subtree service providers", async t => {
  const f = await fixture(t);
  const provide = (name:string) => `export function apply(ctx){ctx.provide(${JSON.stringify(name)},true)}`;
  const bundle = f.plugin("canvas", "1.0.0", {children:["canvas/brush"], source:provide("artboard"), extra:{
    "sub/brush/plugin.yaml":JSON.stringify({id:"brush",name:"Brush",description:"fixture",version:"0.1.0"}),
    "sub/brush/index.ts":provide("pigment"),
  }});
  const store = f.manager([bundle.entry]);
  await store.apply(await row(store,"canvas"));
  const installLocal = async (p:ReturnType<typeof f.plugin>) => {
    const dir = join(f.root,"plugins",p.entry.id);
    await mkdir(dir);
    for (const file of p.files) await writeFile(join(dir,file.path),file.bytes);
    assert.equal((await f.runtime.loadPath(p.entry.id)).status,"active");
  };
  await installLocal(f.plugin("palette","1.0.0",{source:provide("pigment")}));
  await installLocal(f.plugin("portrait","1.0.0",{manifest:{depends:["pigment"]}}));
  const local = await installedCommunityPackages(f.runtime, [bundle.entry]);
  assert.equal((await local.preview("canvas")).action,"uninstall");
  await installLocal(f.plugin("landscape","1.0.0",{manifest:{depends:["artboard"]}}));
  const blocked = await local.preview("canvas");
  assert.equal(blocked.action,null);
  assert.match(blocked.reason,/landscape/);
  assert.doesNotMatch(blocked.reason,/portrait/);
});

test("Windows sharing violations on a program file or installation receipt roll back a community removal",
  {skip:process.platform !== "win32"}, async t => {
  const f = await fixture(t), addon = f.plugin("paint");
  const store = f.manager([addon.entry]);
  await store.apply(await row(store,"paint"));
  const local = await installedCommunityPackages(f.runtime,[addon.entry]);
  const plan = await local.preview("paint");
  const dir = join(f.root,"plugins/paint"), receipts = join(f.root,"config/community-installs.json");
  const original = await readFile(receipts);
  await writeFile(join(dir,"settings.json"), '{"ink":"blue"}');
  for (const file of [join(dir,"index.ts"), receipts]) {
    const lock = spawn("powershell.exe", ["-NoProfile","-NonInteractive","-Command",
      "$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:WHALE_TEST_LOCK,'Open','Read','Read'); " +
      "try { [Console]::WriteLine('locked'); [void][Console]::ReadLine() } finally { $f.Dispose() }"],
      {env:{...process.env,WHALE_TEST_LOCK:file},windowsHide:true});
    const closed = once(lock,"exit");
    try {
      const ready = await Promise.race([once(lock.stdout,"data").then(([chunk]) => String(chunk).trim()), closed.then(() => "")]);
      assert.equal(ready,"locked");
      await assert.rejects(local.apply("paint",plan.planKey), /EPERM|EBUSY|EACCES/);
      assert.equal(f.runtime.records.get("paint").status,"active");
      assert.deepEqual(await readFile(receipts),original);
      for (const programFile of addon.files) assert.deepEqual(await readFile(join(dir,programFile.path)),programFile.bytes);
      assert.equal(await readFile(join(dir,"settings.json"),"utf8"),'{"ink":"blue"}');
    } finally {
      lock.stdin.end("\n");
      await closed;
    }
  }
  await local.apply("paint",plan.planKey);
});
