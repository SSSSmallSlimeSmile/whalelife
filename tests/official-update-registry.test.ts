import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { officialUpdateEntries, readOfficialInventory } from "../core/official-update-registry.ts";

const repository = "https://github.com/test/official-demo";
const release = (version: string) => ({ version, hostRange:"0.1.0", platform:"win32", arch:"x64", delivery:"github-release",
  assetUrl:repository+"/releases/download/v"+version+"/demo.wlpkg.gz", dependencies:{}, sizeBytes:1024,
  sha256:"a".repeat(64), inventorySha256:"b".repeat(64) });
const local = { id:"demo", name:"Demo", repository, parentId:null, requiredPlugins:[], verifiedReleases:[release("1.0.0")] };
const published = {...local, verifiedReleases:[release("1.1.0")]};

test("published historical variants confer ownership only and must pin an inventory for the registered plugin", () => {
  const sha256 = "d".repeat(64);
  const historical = {version:"0.9.0", platform:"win32", arch:"x64", hostRange:"0.1.0", dependencies:{},
    delivery:"inventory", recognitionOnly:true, sha256, sizeBytes:500, fileCount:2, sourceCommit:"c".repeat(40),
    inventoryPath:"market/inventories/" + sha256 + ".json"};
  const resolve = (row: unknown) => officialUpdateEntries({schemaVersion:1,
    plugins:[{...published, verifiedReleases:[row]}]},[local])[0].verifiedReleases;
  const history = resolve({...historical, assetUrl:repository+"/releases/download/v0.9.0/demo.wlpkg.gz"});
  assert.ok(history.every(r => r.recognitionOnly));
  assert.equal(history.find(r => r.sha256 === sha256)?.assetUrl, undefined);
  for (const change of [{recognitionOnly:false}, {delivery:"github-release"}, {inventoryPath:"../foreign.json"},
    {sha256:[sha256]}, {version:"latest"}, {hostRange:"*"}, {platform:["win32"]}, {arch:{}},
    {sizeBytes:-1}, {fileCount:0}, {sourceCommit:"main"}, {dependencies:{other:"1.0.0"}}, {bundledPluginIds:["other/child"]}])
    assert.throws(() => resolve({...historical,...change}), /审核资料无效/);
});

test("conditional children must be owned by the reviewed release", () => {
  const row = {...release("1.1.0"), bundledPluginIds:["demo/bridge"]};
  const targets = (conditionalBundledPluginIds: unknown) => officialUpdateEntries({schemaVersion:1,
    plugins:[{...published, verifiedReleases:[{...row, conditionalBundledPluginIds}]}]},[local])[0].verifiedReleases;
  assert.deepEqual(targets(["demo/bridge"])[0].conditionalBundledPluginIds, ["demo/bridge"]);
  for (const invalid of [null, "demo/bridge", ["demo/bridge","demo/bridge"], ["demo/unowned"], ["other/bridge"]])
    assert.throws(() => targets(invalid), /审核资料无效/);
});

test("a legacy catalog can reuse conditional child review only on the identical, still-approved release", () => {
  const row = {...release("1.1.0"), bundledPluginIds:["demo/bridge"]};
  const known = {...local, verifiedReleases:[{...row, conditionalBundledPluginIds:["demo/bridge"]}]};
  const targets = (...rows: unknown[]) => officialUpdateEntries({schemaVersion:1,
    plugins:[{...published, verifiedReleases:rows}]},[known])[0].verifiedReleases.filter(r => !r.recognitionOnly);
  assert.deepEqual(targets({...row})[0].conditionalBundledPluginIds, ["demo/bridge"]);
  assert.deepEqual(targets({...row,conditionalBundledPluginIds:[]})[0].conditionalBundledPluginIds, []);
  assert.deepEqual(targets(), []);
  for (const change of [{sha256:"d".repeat(64)}, {inventorySha256:"c".repeat(64)}, {hostRange:">=0.1.1"},
    {bundledPluginIds:[]}, {sizeBytes:2048}, {arch:"arm64"}, {sourceCommit:"d".repeat(40)}])
    assert.equal(targets({...row,...change})[0].conditionalBundledPluginIds, undefined);
});

test("current main authorizes official target bytes and the shipped inventory can still identify an old install", () => {
  const resolved = (plugins: unknown[]) => officialUpdateEntries({schemaVersion:1,plugins},[local])[0].verifiedReleases;
  assert.deepEqual(resolved([published]).filter(r=>!r.recognitionOnly).map(r=>r.version),["1.1.0"]);
  assert.equal(resolved([published]).find(r=>r.recognitionOnly)?.sha256,local.verifiedReleases[0].inventorySha256);
  assert.equal(resolved([]).filter(r=>!r.recognitionOnly).length,0);
  for(const plugins of [[{...published,repository:repository+"-other"}],[published,published],
    [{...published,verifiedReleases:[{...release("1.1.0"),assetUrl:repository+"/releases/download/v2.0.0/demo.wlpkg.gz"}]}],
    [{...published,verifiedReleases:[release("1.1.0"),release("1.1.0")]}]]) {
    assert.throws(()=>resolved(plugins));
  }
});

test("official update approvals accept bounded hosts and reject duplicate builds with the same host floor", () => {
  const resolve = (...ranges: string[]) => officialUpdateEntries({
    schemaVersion:1, plugins:[{...published, verifiedReleases:ranges.map(hostRange => ({...release("1.1.0"), hostRange}))}],
  }, [local])[0].verifiedReleases.filter(r => !r.recognitionOnly);
  const ranges = ["=0.1.0", ">=0.1.1 <=0.1.5", ">=0.1.6 <1.0.0", ">=1.0.0"];
  assert.deepEqual(resolve(...ranges).map(r => r.hostRange), ranges);
  for (const aliases of [["0.1.0", ">=0.1.0"], ["=0.1.0", ">=0.1.0 <0.2.0"]]) {
    assert.throws(() => resolve(...aliases), /版本与平台重复/);
  }
  for (const invalid of [">=0.1.0 <0.1.0", "^0.1.0", "latest"]) {
    assert.throws(() => resolve(invalid), /审核资料无效/);
  }
});

test("an inventory absent from the host is read from the digest-addressed official main file and verified", async t => {
  const bytes=JSON.stringify({format:1,files:[]})+"\n";
  const sha256=createHash("sha256").update(bytes).digest("hex");
  let contents=bytes;
  t.mock.method(globalThis,"fetch",async(url:string)=>{
    assert.equal(url,"https://raw.githubusercontent.com/iinukami/whalelife/main/market/inventories/"+sha256+".json");
    return new Response(contents);
  });
  assert.equal((await readOfficialInventory(sha256,new AbortController().signal)).toString(),bytes);
  contents+=" ";
  await assert.rejects(readOfficialInventory(sha256,new AbortController().signal),/SHA-256/);
  await assert.rejects(readOfficialInventory("../untrusted",new AbortController().signal),/摘要/);
});
