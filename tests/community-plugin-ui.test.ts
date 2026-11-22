import { test } from "node:test";
import assert from "node:assert/strict";

const { renderStore, bindStore } = await import(new URL("../core/ui/plugin-store.js", import.meta.url).href);
const entry = { id: "paper", name: "剪纸", repository: "https://github.com/example/paper", author: "原作者",
  description: "保存作品", installation: "https://github.com/example/paper#install", feedback: "https://github.com/example/paper/issues",
  dependencies: ["ink"], collected: "2026-01-01", stars: 0 };
const catalog = { official: [], community: [entry] };
const plan = { id: entry.id, repository: entry.repository, version: "1.2.0", action: "install", planKey: "reviewed-plan",
  buttonLabel: "启用墨盒并安装剪纸", steps: [{id: "ink", name: "墨盒", action: "enable", version: "1.0.0"},
    {id: entry.id, name: entry.name, action: "install", version: "1.2.0"}] };

test("安装按钮仅用于相同社区仓库的已审核计划，手动安装链接始终可用", () => {
  const state = { bundledStore: catalog, storeDetail: entry.id };
  for (const plugins of [undefined, [], [{...plan, id: "other"}], [{...plan, repository: "https://github.com/other/paper"}],
    [{...plan, planKey: ""}], [{...plan, version: ""}]]) {
    const html = renderStore({state: {...state, communityPlugins: plugins}});
    assert.match(html, /安装说明/);
    assert.doesNotMatch(html, /data-community-install|data-official-action|v1\.2\.0/);
  }
  const html = renderStore({state: {...state, communityPlugins: [plan]}});
  assert.match(html, /社区插件/);
  assert.match(html, /data-community-install="paper"/);
  assert.match(html, /v1\.2\.0/);
  assert.match(html, /安装说明/);
  assert.doesNotMatch(html, /store-official-badge|data-official-action|卸载/);
  assert.match(renderStore({state: {...state, storeDetail: null, communityPlugins: [plan]}}), /可安装/);
  const installed = renderStore({state: {...state, communityPlugins: [{...plan, action: "installed", installedVersion: "1.1.0"}]}});
  assert.match(installed, /v1\.1\.0/);
  assert.match(installed, /已安装/);
  assert.match(installed, /收录版本 v1\.2\.0 · 已装 v1\.1\.0/);
  assert.doesNotMatch(installed, /data-community-install/);
  const blocked = renderStore({state: {...state, communityPlugins: [{...plan, action: "blocked", reason: "请先升级墨盒"}]}});
  assert.match(blocked, /查看安装条件/);
  assert.doesNotMatch(blocked, /请先升级墨盒/);
  const conflict = {...plan, action: "blocked", installed: true, installedVersion: "9.9.9"};
  const cards = renderStore({state:{bundledStore: catalog, communityPlugins:[conflict]}});
  assert.doesNotMatch(cards, /v9\.9\.9|data-installed|已安装/);
});

test("已登记发行包的详情区分读取中、失败、缺少本机计划，重试后恢复安装", async t => {
  const packaged = {...entry, verifiedReleases: [{version: plan.version}]};
  const state = {bundledStore: {official: [], community: [packaged]}, storeDetail: entry.id};
  const listing: {onclick?: (event: any) => void} = {};
  const doc = {getElementById: () => null};
  const root = {ownerDocument: doc, addEventListener() {}, querySelectorAll: () => [],
    querySelector: (s: string) => s === "[data-store-results]" ? listing : null};
  const content = {ownerDocument: doc, querySelectorAll: () => [], querySelector: () => root};
  const app: {state: typeof state; content: typeof content; communityRead?: Promise<unknown>} = {state, content};
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return requests.length === 1 ? Response.json({error: "无法读取"}, {status: 503}) : Response.json({plugins: [plan]});
  });
  bindStore(app, content, false);
  assert.match(renderStore(app), /正在核对安装条件/);
  await assert.rejects(app.communityRead!);
  assert.match(renderStore(app), /安装条件核对失败[\s\S]*?data-community-plans-retry/);
  assert.match(renderStore(app), /安装说明/);
  assert.doesNotMatch(renderStore(app), /data-community-install=/);
  const manual = renderStore({state: {...app.state, bundledStore: catalog}});
  assert.match(manual, /安装说明/);
  assert.doesNotMatch(manual, /核对|data-community-plans-retry/);
  const isolated = renderStore({state: {...state, communityPlugins: [], communityPlansFailed: false}});
  assert.match(isolated, /当前没有可用的安装计划/);
  assert.match(isolated, /安装说明/);
  assert.doesNotMatch(isolated, /核对失败|data-community-install=|data-community-plans-retry/);
  bindStore(app, content, false);
  assert.equal(requests.length, 1);
  listing.onclick!({target: {closest: (s: string) => s === "[data-community-plans-retry]" ? {} : null}});
  assert.match(renderStore(app), /正在核对安装条件/);
  await app.communityRead;
  assert.match(renderStore(app), /data-community-install="paper"/);
  assert.doesNotMatch(renderStore(app), /核对失败|data-community-plans-retry/);
  assert.deepEqual(requests, ["/api/community-plugins", "/api/community-plugins"]);
});

test("从商店详情确认时核对显示的计划、列出依赖并只提交确认的计划键", async t => {
  const posts: any[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    if (options?.method === "POST") {
      posts.push([input, JSON.parse(String(options.body))]);
      return Response.json({ok: true, message: "安装完成"});
    }
    return Response.json({plugins: []});
  });
  const listing: {onclick?: (event: any) => void} = {};
  const doc = { getElementById: () => null };
  const root = { isConnected: true, ownerDocument: doc, addEventListener() {}, querySelectorAll: () => [],
    querySelector: (s: string) => s === "[data-store-results]" ? listing : null };
  const content = { ownerDocument: doc, querySelectorAll: () => [], querySelector: (s: string) => s === "#plugin-store" ? root : null };
  const state = { bundledStore: catalog, storeDetail: entry.id, communityPlugins: [plan] };
  type Dialog = { title: string; body: string; submit?: () => Promise<void>; label?: string };
  const dialogs: Dialog[] = [];
  let refreshed = 0;
  const app = { content, state, dialog(title: string, body: string, submit?: Dialog["submit"], label?: string) {
    dialogs.push({title, body, submit, label});
  }, async refreshStatus() { refreshed++; }, toast() {} };
  bindStore(app, content, false);
  const click = () => listing.onclick!({target: { closest: (selector: string) =>
    selector === "[data-community-install]" ? { dataset: {communityInstall: entry.id} } : null }});
  click();
  const preview = dialogs[0];
  assert.equal(preview.title, "安装 剪纸");
  assert.match(preview.body, /启用<\/span><strong>墨盒/);
  assert.match(preview.body, /安装<\/span><strong>剪纸/);
  assert.equal(preview.label, plan.buttonLabel);
  assert.deepEqual(posts, []);
  state.communityPlugins = [{...plan, planKey: "refreshed"}];
  await assert.rejects(preview.submit!(), /计划已变化/);
  assert.deepEqual(posts, []);
  click();
  await dialogs[1].submit!();
  assert.deepEqual(posts, [["/api/community-plugins/apply", {id:"paper", action:"install", planKey:"refreshed"}]]);
  assert.equal(refreshed, 1);
});
