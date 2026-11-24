import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewedCommunityEntries, readPublishedCommunityReviews } from "../core/community-reviews.ts";

const repo = "https://github.com/example/sample";
const release = { version:"1.2.0", hostRange:"0.1.0", platform:"any", arch:"any", sha256:"a".repeat(64),
  sizeBytes:100, assetUrl:repo + "/releases/download/v1.2.0/sample-1.2.0.wlpkg.gz", dependencies:{} };
const item = {id:"sample", name:"示例", description:"测试", repository:repo, installation:repo, dependencies:[]};

test("收录与逐包审核独立；发行记录只能引用原仓库、已审版本和固定摘要", () => {
  const parse = (entry: object) => reviewedCommunityEntries({official:[], community:[entry]});
  assert.deepEqual(parse(item), []);
  assert.equal(parse({...item,verifiedReleases:[release]})[0].verifiedReleases![0].sha256, release.sha256);
  for (const hostRange of ["=0.1.0", ">=0.1.0", ">=0.1.0 <0.2.0", ">=0.1.0 <=0.1.1"]) {
    assert.equal(parse({...item, verifiedReleases:[{...release, hostRange}]})[0].verifiedReleases![0].hostRange, hostRange);
  }
  for (const invalid of [
    {...release, assetUrl:release.assetUrl.replace("example", "someone-else")},
    {...release, assetUrl:release.assetUrl.replace("v1.2.0/", "latest/")},
    {...release, sha256:""}, {...release, platform:"all"}, {...release, sizeBytes:-1},
    {...release, hostRange:"0.1"}, {...release, hostRange:">=0.1.1 <0.1.1"}, {...release, hostRange:">=0.2.0 <=0.1.0"},
    {...release, dependencies: {surf:"0.1.1"}}, {...release, bundledPluginIds:["gallery"]},
  ]) assert.throws(() => parse({...item, verifiedReleases:[invalid]}), /审核记录无效/);
  assert.throws(() => parse({...item, id:"surf/bilibili", verifiedReleases:[release]}), /重名/);
  assert.throws(() => parse({...item, id:"surf/sample", verifiedReleases:[release]}), /父插件/);
  assert.throws(() => parse({...item, verifiedReleases:[release, {...release,platform:"win32"}]}), /匹配重复/);
  assert.throws(() => parse({...item, verifiedReleases:[release, {...release,hostRange:">=0.1.0"}]}), /匹配重复/);
});

test("父插件最低兼容版本只接受发行记录内直接父插件的明确声明", () => {
  const dependencyVersions = { "parent/child":"1.2.0", helper:"0.3.0" };
  const child = {...item, id:"parent/child/sample", dependencies:Object.keys(dependencyVersions)};
  const plain = {...release, dependencies:dependencyVersions};
  const parse = (entry: object) => reviewedCommunityEntries({official:[], community:[entry]});
  const reviewed = (row: object) => parse({...child, verifiedReleases:[row]})[0].verifiedReleases![0];
  assert.ok(!Object.hasOwn(reviewed(plain), "parentCompatibility"));
  const matched = reviewed({...plain, parentCompatibility:"minimum"});
  assert.equal(matched.parentCompatibility, "minimum");
  assert.deepEqual(matched.dependencies, dependencyVersions);
  for (const invalid of [null, true, "exact", ">=1.2.0", ["minimum"]])
    assert.throws(() => reviewed({...plain, parentCompatibility:invalid}), /parentCompatibility/);
  assert.throws(() => parse({...item, verifiedReleases:[{...release,parentCompatibility:"minimum"}]}), /parentCompatibility/);
  assert.throws(() => parse({...child, dependencies:["parent"], verifiedReleases:[
    {...release, parentCompatibility:"minimum", dependencies:{parent:"1.2.0"}},
  ]}), /直接父插件/);
  assert.throws(() => parse({...child, parentCompatibility:"minimum", verifiedReleases:[plain]}), /发行包/);
});

test("同一子插件不能同时由独立条目与另一发行包管理", () => {
  assert.throws(() => reviewedCommunityEntries({official:[], community:[
    {...item, verifiedReleases:[{...release, bundledPluginIds:["sample/child"]}]},
    {...item, id:"sample/child"},
  ]}), /已被占用/);
});

test("线上目录隔离错误插件及重名条目，仍为独立插件提供已审核的精确宿主版本", async () => {
  const good = {...item, verifiedReleases:[{...release, hostRange:"=0.1.1"}]};
  const invalid = {...item, id:"broken", verifiedReleases:[release, {...release, hostRange:"unsupported"}]};
  const duplicate = {...good, id:"duplicate"};
  const catalog = {official:[], community:[invalid, duplicate, good, duplicate, {...item, id:"manual"}]};
  assert.throws(() => reviewedCommunityEntries(catalog), /审核记录无效/);
  const skipped: string[] = [];
  const reviews = await readPublishedCommunityReviews(new AbortController().signal, async () => Response.json(catalog),
    error => skipped.push(error.pluginId));
  assert.deepEqual(reviews.map(entry => entry.id), ["sample"]);
  assert.equal(reviews[0].verifiedReleases![0].hostRange, "=0.1.1");
  assert.deepEqual(new Set(skipped), new Set(["broken", "duplicate"]));
});

test("忽略无效记录时仍隔离所有争用同一子插件的发行包，顺序不影响结果", () => {
  const parent = {...item, id:"root", verifiedReleases:[{...release, bundledPluginIds:["root/sub/child"]}]};
  const sub = {...item, id:"root/sub", dependencies:["root"], verifiedReleases:[{...release,
    dependencies:{root:"1.2.0"}, bundledPluginIds:["root/sub/child"]}]};
  const good = {...item, verifiedReleases:[release]};
  for (const community of [[parent, good, sub], [sub, good, parent]]) {
    const skipped: string[] = [];
    assert.deepEqual(reviewedCommunityEntries({official:[], community}, err => skipped.push(err.pluginId))
      .map(entry => entry.id), ["sample"]);
    assert.deepEqual(new Set(skipped), new Set(["root", "root/sub"]));
    assert.throws(() => reviewedCommunityEntries({official:[], community}), /已被占用/);
  }
});

test("撤下、断网和格式错误均不会沿用之前的社区发行授权", async () => {
  const signal = new AbortController().signal;
  const responses = [
    Response.json({official:[], community:[{...item,verifiedReleases:[release]}]}),
    Response.json({official:[], community:[item]}), new Response("", {status:503}),
    Response.json({community:{}}),
  ];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url,"https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json");
    assert.equal(options?.credentials,"omit");
    assert.equal(options?.redirect,"error");
    return responses.shift()!;
  };
  assert.equal((await readPublishedCommunityReviews(signal, request)).length,1);
  assert.deepEqual(await readPublishedCommunityReviews(signal, request),[]);
  await assert.rejects(readPublishedCommunityReviews(signal, request));
  await assert.rejects(readPublishedCommunityReviews(signal, request));
});
