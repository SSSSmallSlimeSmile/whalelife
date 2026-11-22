import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const { bindStore, renderStore, loadStoreCatalog } = await import(new URL("../core/ui/plugin-store.js", import.meta.url).href);
const entry = (id: string) => ({
  id, name: id, description: "示例插件", author: "作者 <示例>",
  repository: "https://github.com/example/" + id, installation: "https://github.com/example/" + id + "#installation",
  feedback: "https://github.com/example/" + id + "/issues", dependencies: [] as string[],
});
const first = entry("zeta"), second = entry("alpha");
const popular = { ...entry("popular"), stars: 99991, collected: "2025-03-01" };
const recent = { ...entry("recent"), stars: 42, collected: "2026-05-02" };
const bundled = { official: [first, second], community: [recent, popular] };
const rows = (html: string) => Array.from(html.matchAll(/data-store-entry="([^"]+)"/g), m => m[1]);

test("the native store keeps official order, sorts only community, and does not display star counts", () => {
  const state = { bundledStore: bundled };
  const all = renderStore({ state });
  assert.deepEqual(rows(all), ["zeta", "alpha", "popular", "recent"]);
  assert.doesNotMatch(all, /99991/);
  assert.match(all, /962935021/);
  assert.match(all, /提交插件/);
  assert.match(all, /type="search" data-store-search/);
  const detail = renderStore({ state: { ...state, storeDetail: "zeta" } });
  assert.match(detail, /原仓库 · 加星/);
  assert.match(detail, /作者 &lt;示例&gt;/);
  assert.deepEqual(rows(renderStore({ state: { ...state, storeSort: "date" } })), ["zeta", "alpha", "recent", "popular"]);
  assert.deepEqual(rows(renderStore({ state: { ...state, storeView: "community" } })), ["popular", "recent"]);
  const officialOnly = renderStore({ state: { ...state, storeView: "official" } });
  assert.deepEqual(rows(officialOnly), ["zeta","alpha"]);
  assert.match(officialOnly, /class="store-sort" hidden/);
  assert.match(renderStore({ state: { storeView: "community", bundledStore: { official: [], community: [] } } }), /暂无收录的社区插件/);
});

test("both submission dialogs open the correct Issue form for each review queue", () => {
  const submit: {onclick?: () => void} = {};
  const root = {
    querySelector: (selector: string) => selector === "[data-store-submit]" ? submit : selector === "[data-store-results]" ? {} : null,
    querySelectorAll: () => [], addEventListener() {},
  };
  let modal = "";
  bindStore({state:{bundledStore:bundled, communityPlugins:{}}, dialog: (_: string, html: string) => { modal = html; }},
    {querySelector: () => root}, false);
  assert.ok(submit.onclick);
  submit.onclick();
  const staticPage = readFileSync(new URL("../market/index.html", import.meta.url),"utf8");
  for (const [file, prefix, required] of [
    ["submit-plugin.yml","[收录]",["repository","package-url","introduction"]],
    ["review-plugin-update.yml","[复审]",["repository","plugin-id","version","release-url","package-url"]],
    ["review-plugin-icon.yml","[图标]",["repository","plugin-id","icon"]],
  ] as const) {
    const link = "https://github.com/iinukami/whalelife/issues/new?template=" + file;
    for (const html of [modal,staticPage]) assert.ok(html.includes(`href="${link}"`), link);
    const form = parse(readFileSync(new URL("../.github/ISSUE_TEMPLATE/" + file, import.meta.url),"utf8"));
    assert.equal(form.title.trim(),prefix);
    const fields: {id: string; attributes: {label: string}; validations: {required:boolean}}[] =
      form.body.filter((item: {type:string}) => item.type !== "markdown");
    assert.deepEqual(fields.filter(field => field.validations.required).map(field => field.id), required);
    assert.equal(fields.find(field => field.id === "repository")?.attributes.label, "插件的公开 GitHub 仓库");
    if (file === "review-plugin-update.yml") {
      assert.equal(fields.find(field => field.id === "original-issue")?.validations.required,false);
      assert.equal(fields.find(field => field.id === "plugin-id")?.attributes.label,"插件 ID");
      assert.equal(fields.find(field => field.id === "version")?.attributes.label,"版本");
      assert.equal(fields.find(field => field.id === "release-url")?.attributes.label,"Release 链接");
    }
  }
});

test("the drawer filters cards by official name, ID and author without changing the catalog", () => {
  const state = { bundledStore: bundled, storeSearch: " ALPh " };
  assert.deepEqual(rows(renderStore({ state })), ["alpha"]);
  assert.deepEqual(rows(renderStore({ state: { ...state, storeSearch: "作者" } })), ["zeta", "alpha", "popular", "recent"]);
  const miss = renderStore({ state: { ...state, storeSearch: "<xyz>" } });
  assert.match(miss, /没有找到匹配的插件/);
  assert.doesNotMatch(miss, /<xyz>/);
  assert.match(renderStore({ state: { ...state, storeDetail: "retired" } }), /未找到这个插件/);
});

test("cards and details show catalog versions before local plans load and keep a different installed version visible", () => {
  const gallery = { ...first, version: "1.10.0" };
  const manual = { ...popular, version: "0.1.0" };
  const catalog = { official: [gallery], community: [manual, recent] };
  const oldPublic = { official: [first], community: [popular, recent] };
  const state = { bundledStore: catalog, publishedStore: oldPublic };
  // A previously published catalog can arrive after the newer bundled one.
  for (const storeDetail of [null, gallery.id, manual.id, recent.id]) {
    const html = renderStore({state: {...state, storeDetail}});
    for (const [id, text] of [[gallery.id, "收录版本 v1.10.0"], [manual.id, "收录版本 v0.1.0"], [recent.id, "版本未提供"]]) {
      if (!storeDetail || storeDetail === id) assert.ok(html.includes('<span class="store-version">' + text + '</span>'));
    }
    assert.doesNotMatch(html, /store-card-version|data-community-install|data-official-action/);
  }
  const plan = {...gallery, installed: true, installedVersion: "1.9.0"};
  for (const storeDetail of [null, gallery.id]) {
    assert.match(renderStore({state: {...state, storeDetail, officialPlugins:[plan]}}), /收录版本 v1\.10\.0 · 已装 v1\.9\.0/);
  }
  const compatible = {...gallery, installed:false, action:"install", version:"1.8.0"};
  assert.match(renderStore({state: {...state, officialPlugins:[compatible]}}), /收录版本 v1\.10\.0 · 本机可装 v1\.8\.0/);
  const mismatch = renderStore({state:{...state, storeDetail:manual.id, publishedStore:{official:[], community:[{...popular, repository:"https://github.com/other/popular"}]},
    status:{plugins:[{...manual, version:"7.7.7"}]}}});
  assert.match(mismatch, /版本未提供/);
  assert.doesNotMatch(mismatch, /v0\.1\.0|v7\.7\.7/);
});

test("a legacy public community catalog supplies the newest reviewed distribution before a local install plan loads", () => {
  const release = (version: string) => ({version, assetUrl: popular.repository + "/releases/download/v" + version + "/sample.wlpkg.gz",
    sizeBytes: 123, sha256: "a".repeat(64)});
  const legacy = {...popular, verifiedReleases: [release("0.2.9"), release("0.2.10"), {...release("3.0.0"), recognitionOnly:true},
    {...release("9.0.0"), assetUrl:"https://github.com/elsewhere/elsewhere/releases/download/v9/package"}]};
  const state = {bundledStore:{official:[], community:[{...popular, version:"0.1.0"}]}, publishedStore:{official:[], community:[legacy]}};
  for (const storeDetail of [null, popular.id]) {
    const html = renderStore({state:{...state, storeDetail}});
    assert.match(html, /收录版本 v0\.2\.10/);
    assert.doesNotMatch(html, /v9\.0\.0|v3\.0\.0|v0\.1\.0|data-community-install=/);
  }
  assert.match(renderStore({state:{...state, storeDetail:popular.id}}), /安装说明/);
});

test("the store labels official cards and details by catalog section, including before local plans load", () => {
  const community = { ...popular, name: first.name, author: first.author };
  const state = { bundledStore: { official: [first], community: [community] } };
  const badge = /class="store-official-badge">官方<\/span>/g;
  for (const storeView of ["all", "official", "community"]) {
    const html = renderStore({ state: { ...state, storeView } });
    const cards = [...html.matchAll(/data-store-entry="([^"]+)"([\s\S]*?)<\/button>/g)];
    assert.ok(cards.length);
    for (const [, id, card] of cards) assert.equal([...card.matchAll(badge)].length, id === first.id ? 1 : 0);
  }
  for (const entry of [first, community]) {
    const html = renderStore({ state: { ...state, storeDetail: entry.id } });
    assert.equal([...html.matchAll(badge)].length, entry === first ? 1 : 0);
  }
});

test("the storefront exposes install only for matching local identities and never offers uninstall", () => {
  const plans = [
    { ...first, installed: true, installedVersion: "1.2.3", version: "1.3.0" },
    { ...second, installed: false, version: "2.0.0", action: "install" },
  ];
  const state = { bundledStore: bundled, officialPlugins: plans };
  const local = renderStore({ state });
  assert.match(local, /v1\.2\.3/);
  assert.match(local, /已安装/);
  assert.match(local, /可安装/);
  assert.doesNotMatch(local, /data-official-action=/);
  const install = renderStore({ state: { ...state, storeDetail: second.id } });
  assert.match(install, /data-official-action="install"/);
  assert.match(install, /v2\.0\.0/);
  const installed = renderStore({ state: { ...state, storeDetail: first.id } });
  assert.match(installed, /已安装/);
  assert.doesNotMatch(installed, /data-official-action=/);
  assert.doesNotMatch(local, /data-official-action="uninstall"/);
  const renamed = { ...second, name: "不匹配的名称" };
  const changedRepo = { ...first, repository: "https://github.com/other/zeta" };
  for (const item of [renamed, changedRepo, entry("new")]) {
    const remote = renderStore({ state: { ...state, storeDetail: item.id, publishedStore: { official: [item], community: [] } } });
    assert.doesNotMatch(remote, /data-official-store-slot|data-official-action/);
    assert.match(remote, /安装说明/);
  }
  const community = renderStore({ state: { ...state, storeView: "community", storeDetail: popular.id } });
  assert.doesNotMatch(community, /data-official-store-slot|data-official-action/);
  assert.match(community, /安装说明/);
});

test("a failed public refresh keeps the verified local list and permits a later refresh", async t => {
  const globals = globalThis as typeof globalThis & { isWhaleLifeCatalog?: (value: unknown) => boolean };
  const context: { window: Record<string, any>; URL: typeof URL } = { window: {}, URL };
  runInNewContext(readFileSync(new URL("../market/assets/catalog-validation.js", import.meta.url), "utf8"), context);
  const prior = globals.isWhaleLifeCatalog;
  globals.isWhaleLifeCatalog = context.window.isWhaleLifeCatalog;
  t.after(() => {
    if (prior) globals.isWhaleLifeCatalog = prior;
    else delete globals.isWhaleLifeCatalog;
  });
  let localReads = 0, remoteReads = 0;
  const updated = { official: [first, second], community: [recent, popular, { ...popular, id: "third" }] };
  t.mock.method(globalThis, "fetch", async (target: string, init: RequestInit) => {
    if (target === "/market/catalog.json") { localReads++; return Response.json(bundled); }
    assert.equal(target, "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.redirect, "error");
    remoteReads++;
    if (remoteReads === 1) throw Error("offline");
    if (remoteReads === 2) return Response.json({ ...updated, official: [{ ...first, installation: "javascript:invalid" }] });
    return Response.json(updated);
  });
  const app: any = { state: {} };
  const painted: unknown[] = [];
  const update = () => painted.push(app.state.publishedStore || app.state.bundledStore);
  await Promise.all([loadStoreCatalog(app, update), loadStoreCatalog(app, update)]);
  assert.deepEqual(app.state.bundledStore, bundled);
  assert.deepEqual(painted[0], bundled);
  assert.equal(app.state.publishedStore, undefined);
  await loadStoreCatalog(app, update);
  assert.equal(app.state.publishedStore, undefined);
  await loadStoreCatalog(app, update);
  assert.deepEqual(app.state.publishedStore, updated);
  await loadStoreCatalog(app, update);
  assert.deepEqual([localReads, remoteReads], [1, 3]);
});
