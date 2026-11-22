import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PluginUpdates } from "../core/plugin-updates.ts";
import { CommunityPackages } from "../core/community-packages.ts";
import { Runtime } from "../core/runtime.ts";
import { Logger } from "../core/logger.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const host: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const catalogURL = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
const registryURL = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/official-releases.json";
const github = "https://github.com/example/";
const card = (id: string) => ({ id, name: id, description: id, installation: github + id, dependencies: [] as string[], repository: github + id });
const author = card("color-note");
const review = (entry: typeof author, version: string, dependencies: Record<string, string> = {}) => ({
  version, hostRange: host, platform: "any", arch: "any", sizeBytes: 100, sha256: "a".repeat(64), dependencies,
  assetUrl: entry.repository + "/releases/download/v" + version + "/plugin.wlpkg.gz",
});
const reviewed = { ...author, verifiedReleases: [review(author, "1.10.0")] };
const catalog = { official: [card("child")], community: [reviewed] };
const child = { ...card("child"), parentId: "parent" };
const asset = (version: string) => ({ version, hostRange: host, platform: process.platform, arch: process.arch,
  delivery: "github-release", sizeBytes: 100, sha256: "a".repeat(64), inventorySha256: "b".repeat(64),
  assetUrl: child.repository + "/releases/download/v" + version + "/child.wlpkg.gz" });
const registry = { schemaVersion: 1, plugins: [{ ...child, verifiedReleases: [asset("1.1.0")] }] };
const installed = [{ id: "parent/child", version: "1.0.0" }, { id: "color-note", version: "1.9.0" }];
function make(plugins = installed) {
  return new PluginUpdates(new AbortController().signal, async (reviews, ids) => {
    const runtime = {
      root: await temporaryDirectory("whale-reviewed-notices-"),
      records: new Map(plugins.map(p => [p.id, { manifest: p, status: "active" }])),
      pluginState: { load: async () => {}, enabled: () => true },
      managePackages: (run: () => unknown) => run(),
    };
    return new CommunityPackages(runtime as unknown as Runtime, reviews).compatibleUpdateVersions(ids);
  }, registry);
}
const recognized = async () => ({ plugins: [{ runtimeId: "parent/child", installed: true, installedVersion: "1.0.0" }],
  recognizedRuntimeIds: ["parent/child"] });
const unrecognized = async () => ({ plugins: [], recognizedRuntimeIds: [] });

function serve(t: TestContext, replies: Map<string, unknown>) {
  const requests: { address: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (address: string, init: RequestInit) => {
    requests.push({ address, init });
    const reply = replies.get(address);
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply.clone() : reply ? Response.json(reply) : new Response(null, { status: 404 });
  });
  return requests;
}

test("updates compare local installations to compatible reviewed packages without disclosing them", async t => {
  const newest = { ...asset("1.10.0"), hostRange: "0.0.9" };
  const publicEntries = [{ ...child, verifiedReleases: [
    asset("1.9.0"), newest, { ...asset("3.0.0"), recognitionOnly: true }, { ...asset("4.0.0"), platform: "other" },
    { ...asset("5.0.0"), arch: "other" }, { ...asset("6.0.0"), hostRange: "other" },
    { ...asset("6.1.0"), hostRange: "99.0.0" }, { ...asset("6.2.0"), hostRange: ">=0.0.1 <" + host },
    { ...asset("7.0.0"), delivery: "inventory" }, { ...asset("8.0.0"), inventorySha256: "invalid" },
    { ...asset("9.0.0"), assetUrl: "https://example.net/download" }, asset("20.0.0-pre.1")
  ] }];
  const replies = new Map<string, unknown>([
    [catalogURL, { ...catalog, community: [reviewed, ...Array.from({ length: 120 }, (_, i) => card("absent-" + i))] }],
    [registryURL, { schemaVersion: 1, plugins: publicEntries }],
  ]);
  const requests = serve(t, replies);
  const service = make();
  const local = [...installed, { id: "private-plugin", version: "9.9.9", repository: "https://private.test/a" }];
  const [first, concurrent] = await Promise.all([service.list(local, recognized), service.list(local, recognized)]);
  assert.deepEqual(first.updates, [
    { id: "color-note", runtimeId: "color-note", repository: author.repository, source: "community", installedVersion: "1.9.0",
      latestVersion: "1.10.0", url: author.repository + "/releases/tag/v1.10.0" },
    { id: "child", runtimeId: "parent/child", repository: child.repository, source: "official", installedVersion: "1.0.0",
      latestVersion: "1.10.0", url: child.repository + "/releases/tag/v1.10.0" },
  ]);
  assert.equal(concurrent.updates.length, 2);
  assert.deepEqual(requests.map(r => r.address).sort(), [...replies.keys()].sort());
  for (const { init } of requests) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.body, undefined);
  }
  assert.deepEqual((await service.list([], recognized)).updates, []);
  assert.deepEqual((await service.list([{ id: "color-note", version: "2.0.0" }], recognized)).updates, []);
  assert.deepEqual((await service.list(installed, async () => { throw Error("inventory busy"); })).updates.map(p => p.source), ["community"]);
  assert.deepEqual(requests.map(r => r.address), [registryURL, catalogURL, catalogURL, registryURL, catalogURL]);
});

test("a fresh instance makes no public requests and unlisted installations do not trigger any author queries", async t => {
  const community = Array.from({ length: 150 }, (_, i) => card("absent-" + i));
  const requests = serve(t, new Map<string, unknown>([[catalogURL, { ...catalog, community }]]));
  const service = make();
  assert.deepEqual(await service.list([], recognized), { updates: [] });
  assert.equal(requests.length, 0);
  assert.deepEqual(await service.list([{ id: "private", version: "1.0.0" }], unrecognized), { updates: [] });
  assert.deepEqual(requests.map(r => r.address), [catalogURL]);
});

test("reading the last manual result is local, and notices disappear for removed or replaced installations", async t => {
  const calls = serve(t, new Map<string, unknown>([[catalogURL, catalog], [registryURL, registry]]));
  const service = make();
  assert.deepEqual(service.snapshot(installed), { updates: [] });
  assert.equal(calls.length, 0);
  const { updates } = await service.list(installed, recognized);
  assert.equal(updates.length, 2);
  assert.deepEqual(service.snapshot(installed), { updates, checked: true, incomplete: false });
  assert.deepEqual(service.snapshot([{ ...installed[0], version: "9.0.0" }, { ...installed[1], repository: github + "other" }]), { updates: [] });
  assert.deepEqual(service.snapshot([...installed, { id: "new-dependency", version: "1.0.0" }]).updates.map(p => p.source), ["official"]);
  assert.equal(calls.length, 2);
});

test("manual-only entries have no approved update; a failed catalog check does not use old approvals", async t => {
  const replies = new Map<string, unknown>([[catalogURL, { ...catalog, community: [author] }]]);
  serve(t, replies);
  assert.deepEqual(await make().list([installed[1]], recognized), { updates: [] });
  const service = make();
  replies.set(catalogURL, catalog);
  assert.equal((await service.list([installed[1]], recognized)).updates.length, 1);
  for (const failure of [new Response(null, {status: 403}), new Response(null, {status: 429}), Error("offline"), {community:{}}]) {
    replies.set(catalogURL, failure);
    assert.deepEqual(await service.list([installed[1]], recognized), { updates: [], incomplete: true });
    assert.deepEqual(service.snapshot([installed[1]]), { updates: [], checked: true, incomplete: true });
  }
});

test("offline official fallback respects fingerprints, runtime paths and installed versions", async t => {
  const replies = new Map<string, unknown>([[registryURL, Error("offline")], [catalogURL, Error("offline")]]);
  serve(t, replies);
  const service = make();
  assert.deepEqual((await service.list(installed, recognized)).updates.map(p => p.latestVersion), ["1.1.0"]);
  assert.deepEqual((await service.list(installed, unrecognized)).updates, []);
  assert.deepEqual((await service.list([{ id: "child", version: "1.0.0" }], recognized)).updates, []);
  assert.deepEqual((await service.list(installed, async () => ({
    ...await recognized(), plugins: [{ runtimeId:"parent/child", installed:true, installedVersion:"0.9.0" }]
  }))).updates, []);
  let scans = 0;
  for (const version of ["1.1.0", "1.1.0+my.build", "2.0.0", "malformed", "01.0.0"]) {
    assert.deepEqual((await service.list([{ id: "parent/child", version }], async () => { scans++; return recognized(); })).updates, []);
  }
  assert.equal(scans, 0);
});

test("foreign registry identities, duplicated parents and incompatible official releases never confer official updates", async t => {
  const replies = new Map<string, unknown>();
  serve(t, replies);
  const changed = { ...child, verifiedReleases: [asset("4.0.0")] };
  for (const candidates of [[{ ...changed, repository: github + "wrong" }], [{ ...changed, name: "other" }],
    [{ ...changed, parentId: "another" }], [changed, changed], [null]]) {
    replies.set(registryURL, { schemaVersion: 1, plugins: candidates });
    assert.deepEqual((await make().list(installed, recognized)).updates.map(p => p.latestVersion), ["1.1.0"]);
  }
});

test("only current, correctly identified approvals can recommend the highest reviewed compatible version", async t => {
  const approved = review(author, "1.10.0");
  const releases = [
    review(author, "1.9.0"), approved,
    { ...review(author, "2.0.0"), platform: process.platform === "win32" ? "linux" : "win32" },
    { ...review(author, "3.0.0"), arch: process.arch === "x64" ? "arm64" : "x64" },
    { ...review(author, "4.0.0"), hostRange: "99.0.0" },
  ];
  const replies = new Map<string, unknown>([[catalogURL, { ...catalog, community: [{
    ...author, version: "9.0.0", verifiedReleases: releases,
  }] }]]);
  const requests = serve(t, replies);
  const service = make();
  assert.equal((await service.list([installed[1]], unrecognized)).updates[0]?.latestVersion, approved.version);
  for (const plugin of [{ id: "else/color-note", version: "1.0.0" }, { ...installed[1], builtin: true },
    { ...installed[1], version: "1.10.0" }, { ...installed[1], version: "2.0.0" },
    { ...installed[1], repository: github + "other" }, { ...installed[1], version: "1.9.0-beta.01" }]) {
    assert.deepEqual((await service.list([plugin], unrecognized)).updates, []);
  }
  replies.set(catalogURL, { ...catalog, community: [] });
  assert.deepEqual(await service.list([installed[1]], unrecognized), { updates: [] });
  for (const invalid of [{ ...approved, sha256: "invalid" }, { ...approved, assetUrl: "https://example.net/file.wlpkg.gz" }]) {
    replies.set(catalogURL, { ...catalog, community: [{ ...author, verifiedReleases: [invalid] }] });
    assert.deepEqual(await service.list([installed[1]], unrecognized), { updates: [], incomplete: true });
  }
  const other = card("broken");
  replies.set(catalogURL, { ...catalog, community: [reviewed, {...other, verifiedReleases:[{...review(other, "2.0.0"), sha256:"invalid"}]}] });
  const partial = await service.list([installed[1], {id:other.id, version:"1.0.0"}], unrecognized);
  assert.equal(partial.incomplete, true);
  assert.deepEqual(partial.updates.map(p => p.id), [author.id]);
  assert.ok(requests.every(r => r.address === catalogURL));
});

test("reviewed notices follow the install planner through missing, conflicting and cyclic dependencies", async t => {
  const dep = card("note-engine"), leaf = card("note-layout");
  const packagedDep = { ...dep, dependencies: [leaf.id], verifiedReleases: [review(dep, "1.0.0", { [leaf.id]: "1.0.0" })] };
  const packagedLeaf = { ...leaf, verifiedReleases: [review(leaf, "1.0.0")] };
  const candidate = { ...author, dependencies: [dep.id], verifiedReleases: [
    review(author, "2.0.0", { [dep.id]: "1.0.0" }), review(author, "3.0.0", { [dep.id]: "2.0.0" }),
  ] };
  const replies = new Map<string, unknown>();
  const requests = serve(t, replies);
  const root = [installed[1]];
  replies.set(catalogURL, { ...catalog, community: [candidate, packagedDep, packagedLeaf] });
  assert.equal((await make(root).list(root, unrecognized)).updates[0]?.latestVersion, "2.0.0");
  const wrong = [...root, { id: leaf.id, version: "0.9.0" }];
  assert.deepEqual((await make(wrong).list(wrong, unrecognized)).updates.map(row => row.id), [leaf.id]);
  replies.set(catalogURL, { ...catalog, community: [candidate, packagedDep] });
  assert.deepEqual((await make(root).list(root, unrecognized)).updates, []);
  replies.set(catalogURL, { ...catalog, community: [candidate, packagedDep,
    { ...leaf, dependencies: [dep.id], verifiedReleases: [review(leaf, "1.0.0", { [dep.id]: "1.0.0" })] }] });
  assert.deepEqual((await make(root).list(root, unrecognized)).updates, []);
  assert.ok(requests.every(r => r.address === catalogURL));
});

test("community notices apply host floors, explicit bounds and platform restrictions to approved releases", async t => {
  const replies = new Map<string, unknown>();
  const requests = serve(t, replies);
  const service = make();
  const release = { ...review(author, "2.0.0"), hostRange: "0.0.9" };
  for (const [candidate, expected] of [
    [release, true], [{ ...release, hostRange: "99.0.0" }, false], [{ ...release, hostRange: "=0.0.9" }, false],
    [{ ...release, hostRange: ">=0.0.9 <=" + host }, true], [{ ...release, hostRange: ">=0.0.9 <" + host }, false],
    [{ ...release, platform: process.platform === "win32" ? "linux" : "win32" }, false],
    [{ ...release, arch: process.arch === "x64" ? "arm64" : "x64" }, false],
  ] as const) {
    replies.set(catalogURL, { ...catalog, community: [{ ...author, verifiedReleases: [candidate] }] });
    const checked = await service.list([installed[1]], unrecognized);
    assert.equal(checked.incomplete, undefined);
    assert.deepEqual(checked.updates.map(item => item.latestVersion), expected ? [candidate.version] : []);
  }
  assert.ok(requests.every(request => request.address === catalogURL));
});

test("a pending parent package recovery blocks loading its children and preflight only inspects their files", async t => {
  const root = await temporaryDirectory("whale-plugin-update-preflight-");
  const runtime = new Runtime(root, new Logger(join(root, "logs")));
  t.after(() => runtime.bus.stop());
  const dir = join(root, "plugins", "parent", "sub", "child");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id: "child", name: "Child", description: "Fixture", version: "1.0.0" }));
  await writeFile(join(dir, "index.ts"), 'throw Error("plugin code ran during preflight")');
  runtime.packageRecoveryBlocks.set("parent", "parent transaction needs review");
  await assert.rejects(runtime.checkInstalledPlugins(["parent/child"]), /parent transaction needs review/);
  const blocked = await runtime.loadPath("parent/child");
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error, /parent transaction needs review/);
  runtime.packageRecoveryBlocks.clear();
  await runtime.checkInstalledPlugins(["parent/child"]);
});
