import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";

const { renderStore, bindStore } = await import(new URL("../core/ui/plugin-store.js", import.meta.url).href);
const { renderPlugins, bindPlugins } = await import(new URL("../core/ui/views.js", import.meta.url).href);
const { loadPluginUpdates } = await import(new URL("../core/ui/plugin-updates.js", import.meta.url).href);
const { pluginCard } = await import(new URL("../core/ui/extensions.js", import.meta.url).href);
const entry = (id: string, name: string) => {
  const repository = "https://github.com/example/" + id;
  return { id, name, repository, description: name, author: "作者", installation: repository + "#install",
    feedback: repository + "/issues", dependencies: [], collected: "2026-01-01", stars: 0 };
};
const gallery = entry("gallery", "图库"), note = entry("color-note", "颜色便签");
const child = entry("bilibili", "B 站");
const catalog = { official: [gallery, child], community: [note] };
const fixtures = [[gallery, "gallery", "official"], [child, "surf/bilibili", "official"],
  [note, "color-note", "community"]] as const;
const status = { plugins: fixtures.map(([plugin, runtimeId]) => ({
  id: runtimeId, name: plugin.name, version: "1.2.0", enabled: false, status: "stopped",
})) };
const state = {
  bundledStore: catalog, status,
  officialPlugins: fixtures.filter(([, , kind]) => kind === "official").map(([plugin, runtimeId]) => ({
    ...plugin, runtimeId, installed: true, recognized: true, installedVersion: "1.2.0", version: "1.2.0",
  })),
  pluginUpdates: fixtures.map(([plugin, runtimeId, source]) => ({
    id: plugin.id, repository: plugin.repository, runtimeId, source, installedVersion: "1.2.0", latestVersion: "1.10.0",
    url: plugin.repository + "/releases/" + (source === "official" ? "" : "tag/v1.10.0"),
  })),
};

test("installed official and community plugins show a notice in both views and a release link in details", () => {
  for (const [i, [plugin, runtimeId]] of fixtures.entries()) {
    const card = renderStore({ state: { ...state, storeSearch: plugin.id } });
    assert.match(card, /有更新/);
    assert.match(card, /更新到 v1\.10\.0<\/button>/);
    const managed = pluginCard(status, status.plugins.find(p => p.id === runtimeId), state);
    assert.match(managed, /有更新/);
    const details = renderStore({ state: { ...state, storeDetail: plugin.id } });
    assert.match(details, /有更新/);
    assert.match(details, /1\.2\.0/);
    assert.match(details, /1\.10\.0/);
    assert.match(details, /更新到 v1\.10\.0<\/button>/);
    assert.ok(details.includes('href="' + state.pluginUpdates[i].url + '"'));
    assert.doesNotMatch(details, /data-official-action=/);
  }
});

test("a stale notice cannot attach to a changed local install or a different store repository", () => {
  for (const plugins of [[], [{ ...status.plugins[2], version: "1.10.0" }]]) {
    const changed = { ...state, status: { plugins }, storeDetail: note.id };
    assert.doesNotMatch(renderStore({ state: changed }), /有更新|查看新版/);
    assert.doesNotMatch(renderStore({ state: changed }), /data-plugin-update=/);
    if (plugins.length) assert.doesNotMatch(pluginCard({ plugins }, plugins[0], changed), /有更新/);
  }
  const transferred = { official: [], community: [{ ...note, repository: "https://github.com/other/color-note" }] };
  assert.doesNotMatch(renderStore({ state: { ...state, publishedStore: transferred, storeDetail: note.id } }), /有更新|查看新版/);
});

test("only installed plugin details offer the shared check before any update is known", () => {
  const initial = { ...state, pluginUpdates: [], communityPlugins: [{ ...note, action: "installed", version: "1.2.0" }] };
  for (const plugin of [gallery, note]) {
    const detail = renderStore({ state: { ...initial, storeDetail: plugin.id } });
    assert.equal(detail.match(/data-check-plugin-updates/g)?.length, 1);
    assert.match(detail, /data-plugin-check-status/);
    assert.doesNotMatch(detail, /data-plugin-update=/);
  }
  const uninstalled = { ...initial, officialPlugins: [], communityPlugins: [] };
  for (const plugin of [gallery, note]) {
    assert.doesNotMatch(renderStore({ state: { ...uninstalled, storeDetail: plugin.id } }),
      /data-check-plugin-updates|data-plugin-check-status/);
  }
});

test("a detail check still works after the installed plan arrives and only checks on click", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    paths.push(path);
    if (path === "/api/plugin-updates") return Response.json({ updates: [], checked: false });
    assert.equal(init.method, "POST");
    return Response.json({ updates: [state.pluginUpdates[2]] });
  });
  const plan = { ...note, action: "install", version: "1.2.0", planKey: "plan" };
  const current = { ...state, storeDetail: note.id, communityPlugins: [plan], pluginUpdates: [] };
  let button: { onclick?: () => Promise<void> } | undefined;
  let html = "";
  const listing = { contains: () => false, set innerHTML(value: string) {
    html = value;
    button = html.includes("data-check-plugin-updates") ? {} : undefined;
  } };
  const doc = { getElementById: () => root, activeElement: null };
  const root = Object.assign(new EventTarget(), { isConnected: true, ownerDocument: doc,
    querySelector: (selector: string) => selector === "[data-store-results]" ? listing : null,
    querySelectorAll: (selector: string) => selector === "[data-check-plugin-updates]" && button ? [button] : [] });
  const content = { ownerDocument: doc, querySelector: () => root, querySelectorAll: () => [] };
  const app = { state: current, content };
  listing.innerHTML = renderStore(app);
  bindStore(app, content, false);
  plan.action = "installed";
  root.dispatchEvent(new Event("community-plans"));
  await nextTurn();
  assert.deepEqual(paths, ["/api/plugin-updates"]);
  assert.ok(button?.onclick);
  await button.onclick();
  assert.deepEqual(paths, ["/api/plugin-updates", "/api/plugin-updates/check"]);
  assert.match(html, /更新到 v1\.10\.0<\/button>/);
  assert.match(html, /发现 1 个插件可更新/);
});

test("official and community store updates preview dependencies and post only the confirmed version and plan", async t => {
  const posts: {path: string; data: any}[] = [];
  let blocked = false, fail = false;
  t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => {
    if (options?.method !== "POST") return Response.json({plugins: []});
    const data = JSON.parse(String(options.body));
    posts.push({path, data});
    if (path.endsWith("/preview")) return Response.json({
      id: data.id, version: data.version, installedVersion: "1.2.0", planKey: blocked ? "" : "approved",
      reason: blocked ? "请先升级依赖" : "", steps: [
        {id: "first", name: "甲", action: "install", version: "1.0.0"},
        {id: "second", name: "乙", action: "enable", version: "1.1.0"},
        {id: "third", name: "丙", action: "reuse", version: "1.2.0"},
        {id: data.id, name: "目标", action: "update", version: data.version},
      ],
    });
    assert.equal(path, "/api/plugin-updates/apply");
    return fail ? Response.json({error: "启用目标失败", rolledBack: ["已还原原版"]}, {status: 409})
      : Response.json({ok: true, message: "更新成功"});
  });
  const doc = { getElementById: () => null };
  const listing = { onclick: null as any, contains: () => false };
  const root = { isConnected: true, ownerDocument: doc, addEventListener() {}, querySelectorAll: () => [],
    querySelector: (s: string) => s === "[data-store-results]" ? listing : null };
  const content = { ownerDocument: doc, querySelectorAll: () => [], querySelector: (s: string) => s === "#plugin-store" ? root : null };
  const dialogs: {title: string; body: string; submit?: () => Promise<void>}[] = [];
  const app = { content, state: { ...state, communityPlugins: [], storeDetail: "" }, async refreshStatus() {}, toast() {},
    dialog(title: string, body: string, submit?: () => Promise<void>) { dialogs.push({title, body, submit}); } };
  bindStore(app, content, false);
  const click = (pluginUpdate: string, source: string) => listing.onclick({target: {closest: (selector: string) =>
    selector === "[data-plugin-update]" ? {dataset: {pluginUpdate, source, version: "1.10.0"}} : null }});

  for (const [entry, , source] of [fixtures[0], fixtures[2]]) {
    app.state.storeDetail = source === "community" ? entry.id : "";
    const data = {id: entry.id, source, version: "1.10.0"};
    posts.length = 0;
    blocked = true;
    await click(entry.id, source);
    assert.match(dialogs.at(-1)!.body, /请先升级依赖/);
    assert.equal(dialogs.at(-1)!.submit, undefined);
    assert.deepEqual(posts, [{path: "/api/plugin-updates/preview", data}]);

    blocked = false;
    await click(entry.id, source);
    const preview = dialogs.at(-1)!;
    assert.match(preview.body, /v1\.2\.0.*v1\.10\.0/);
    assert.match(preview.body, /安装<\/span><strong>甲/);
    assert.match(preview.body, /启用<\/span><strong>乙/);
    assert.match(preview.body, /沿用<\/span><strong>丙/);
    assert.match(preview.body, /配置、数据/);
    assert.ok(posts.every(p => p.path.endsWith("/preview")));

    root.isConnected = false;
    await assert.rejects(preview.submit!(), /计划已变化/);
    assert.ok(posts.every(p => p.path.endsWith("/preview")));
    root.isConnected = true;
    fail = true;
    await assert.rejects(preview.submit!(), /启用目标失败[\s\S]*已撤回的改动[\s\S]*已还原原版/);
    assert.ok(app.state.pluginUpdates.some(p => p.id === entry.id));
    fail = false;
    await preview.submit!();
    assert.deepEqual(posts.at(-1), {path: "/api/plugin-updates/apply", data: {...data, planKey: "approved"}});
    assert.ok(!app.state.pluginUpdates.some(p => p.id === entry.id));
    assert.ok(!posts.some(p => p.path.endsWith("/check")));
  }
});

test("management and store share an explicit check; binding, rendering and waiting do not start one", async t => {
  const paths: string[] = [];
  let reply!: (response: Response) => void;
  let localReads = 0, localReply!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    if (path === "/api/official-plugins") return Response.json({plugins: []});
    if (path === "/api/plugin-updates") {
      localReads++;
      return new Promise<Response>(resolve => { localReply = resolve; });
    }
    paths.push(path);
    assert.equal(init.method, "POST");
    return new Promise<Response>(resolve => { reply = resolve; });
  });
  const controls = () => {
    const button = { disabled: false, onclick: () => Promise.resolve() }, status = { textContent: "" };
    return { button, status, querySelectorAll(selector: string) {
      if (selector === "[data-check-plugin-updates]") return [button];
      if (selector === "[data-plugin-check-status]") return [status];
      return [];
    }, addEventListener() {} };
  };
  const store = { ...controls(), querySelector: () => ({}), dispatchEvent() {} };
  const content = { ...controls(), ownerDocument: { getElementById: (id: string) => id === "plugin-store" ? store : null } };
  const app = { state: { ...state, page: "plugins", communityPlugins: [] }, content };
  const bind = () => {
    bindPlugins(app);
    bindStore(app, { querySelector: () => store }, false);
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  bind();
  t.mock.timers.tick(60 * 60_000);
  bind();
  assert.deepEqual(paths, []);
  assert.equal(localReads, 1);
  assert.match(renderPlugins(app), /data-check-plugin-updates/);
  assert.match(renderStore(app), /data-check-plugin-updates/);

  const pending = content.button.onclick();
  assert.equal(store.button.disabled, true);
  await store.button.onclick();
  bind();
  assert.deepEqual(paths, ["/api/plugin-updates/check"]);
  reply(Response.json({ updates: state.pluginUpdates }));
  await pending;
  localReply(Response.json({ updates: [], checked: true }));
  await nextTurn();
  assert.equal(content.button.disabled, false);
  assert.equal(store.status.textContent, "发现 3 个插件可更新。");
  assert.match(renderPlugins(app), /发现 3 个插件可更新/);
  assert.match(renderStore(app), /发现 3 个插件可更新/);
  const partial = store.button.onclick();
  reply(Response.json({ updates: [], incomplete: true }));
  await partial;
  assert.match(content.status.textContent, /暂时无法核实/);
  assert.doesNotMatch(content.status.textContent, /未发现/);

  const retry = store.button.onclick();
  reply(Response.json({ updates: [] }));
  await retry;
  assert.equal(content.status.textContent, "未发现可用的插件更新。");
  const failed = content.button.onclick();
  reply(Response.json({ error: "服务不可用" }, { status: 503 }));
  await failed;
  assert.match(store.status.textContent, /检查插件更新失败.*服务不可用/);
  assert.equal(paths.length, 4);
  const refreshed = { state: { ...state, page: "plugins", communityPlugins: [], pluginUpdates: [] }, content };
  bindPlugins(refreshed);
  assert.equal(localReads, 2);
  localReply(Response.json({ updates: state.pluginUpdates, checked: true, incomplete: true }));
  await nextTurn();
  assert.match(renderPlugins(refreshed), /发现 3 个插件可更新。部分版本信息暂时无法核实/);
  assert.match(renderStore(refreshed), /有更新/);
  const withChangedDependency = { ...refreshed.state, storeDetail: note.id,
    status: { plugins: [...status.plugins, { id: "other-dependency", version: "2.0.0" }] } };
  assert.doesNotMatch(renderStore({ state: withChangedDependency }), /有更新|查看新版/);
  assert.equal(paths.length, 4);
});

test("a collapsed group reports only outdated descendants and clears the count when they are updated", async t => {
  const parent = { id: "surf", name: "网上冲浪", version: "1.0.0", status: "active", console: { groupChildren: true } };
  const child = { id: "surf/bilibili", name: "B 站", version: "1.0.0", status: "stopped" };
  const deep = { ...child, id: "surf/bilibili/notes" };
  const unrelated = { ...child, id: "surf-extra/reader" };
  const state = { status: { plugins: [parent, child, deep, unrelated] } };
  const summarySlot = { innerHTML: "", dataset: { pluginUpdateChildren: parent.id } };
  const app = { state, content: { ownerDocument: { getElementById: () => null },
    querySelectorAll: (selector: string) => selector === "[data-plugin-update-children]" ? [summarySlot] : [] } };
  const notice = (runtimeId: string) => ({ id: runtimeId, runtimeId, source: "community", repository: "https://github.com/example/project",
    url: "https://github.com/example/project/releases/tag/v2.0.0", installedVersion: "1.0.0", latestVersion: "2.0.0" });
  let updates = [child, deep, unrelated].map(plugin => notice(plugin.id));
  t.mock.method(globalThis, "fetch", async () => Response.json({ updates }));

  assert.doesNotMatch(pluginCard(state.status, parent, state), /有更新/);
  await loadPluginUpdates(app);
  assert.match(summarySlot.innerHTML, /2 个有更新/);
  const card = pluginCard(state.status, parent, state);
  assert.match(card, /<details class="plugin-card-children"><summary>2 个子插件.*?2 个有更新.*?<\/summary>/);
  assert.equal(card.match(/>有更新<\/span>/g)?.length, 2);

  child.version = "2.0.0";
  updates = updates.filter(row => row.runtimeId !== child.id);
  await loadPluginUpdates(app);
  assert.match(summarySlot.innerHTML, /1 个有更新/);
  deep.version = "2.0.0";
  updates = [notice(unrelated.id), notice(parent.id)];
  await loadPluginUpdates(app);
  assert.equal(summarySlot.innerHTML, "");
  assert.doesNotMatch(pluginCard(state.status, parent, state).match(/<summary>.*?<\/summary>/)[0], /有更新/);
});
