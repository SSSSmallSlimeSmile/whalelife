import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

const { bindManageActions } = await import(new URL("../core/ui/official-plugins.js", import.meta.url).href);
const { pluginCard, extensionPage } = await import(new URL("../core/ui/extensions.js", import.meta.url).href);

const parent = { id: "studio", name: "画室", version: "1.0.0", status: "active", console: { groupChildren: true } };
const child = { id: "studio/palette", name: "调色板", version: "2.0.0", status: "active" };
const independent = { ...child, id: "studio/meme", name: "工坊" };
const status = { plugins: [parent, child, independent] };
const managed = [parent, independent];
const plan = { id: parent.id, name: parent.name, installedVersion: parent.version, action: "uninstall", planKey: "studio-plan",
  bundledPlugins: [{ id: child.id, name: child.name }], reason: "" };
type Dialog = { title: string; body: string; submit?: () => Promise<void>; label?: string };

function manager(t: TestContext, preview = plan, workspace?: string) {
  const requests: [string, unknown][] = [], dialogs: Dialog[] = [];
  const location = { hash: workspace ? "#plugin:" + encodeURIComponent(workspace) : "#plugins" };
  let clickHandler!: (event: unknown) => Promise<void>;
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push([path, init.body && JSON.parse(String(init.body))]);
    switch (path) {
      case "/api/official-plugins": return Response.json({ plugins: [] });
      case "/api/community-plugins/manage": return Response.json({ plugins: managed });
      case "/api/community-plugins/uninstall/preview": return Response.json(preview);
      case "/api/community-plugins/uninstall/apply": return Response.json({ ok: true, message: "已卸载" });
      default: throw Error("unexpected API " + path);
    }
  });
  const app = {
    state: { status, page: location.hash.slice(1) },
    content: { ownerDocument: { getElementById: () => null, defaultView: { location } }, querySelectorAll: () => [],
      querySelector: (s: string) => s === ".plugin-workspace" && workspace ? { dataset: { runtimeId: workspace } } : null,
      addEventListener: (_: string, callback: typeof clickHandler) => { clickHandler = callback; } },
    dialog(title: string, body: string, submit?: Dialog["submit"], label?: string) { dialogs.push({ title, body, submit, label }); },
    async refreshStatus() {}, toast() {}, render() {},
  };
  const click = (id: string) => clickHandler({ target: { closest: (selector: string) =>
    selector === "[data-community-uninstall]" ? { dataset: { communityUninstall: id },
      closest: () => ({ dataset: { officialManageSlot: id } }) } : null } });
  return { app, requests, dialogs, click, location };
}

test("管理卡和详情只给独立发行包卸载入口，随包子插件可以启停", () => {
  const state = { status, communityManaged: managed };
  const card = pluginCard(status, parent, state);
  assert.match(card, /data-community-uninstall="studio" aria-label="卸载 画室"/);
  assert.match(card, /data-community-uninstall="studio\/meme" aria-label="卸载 工坊"/);
  assert.doesNotMatch(card, /data-community-uninstall="studio\/palette"/);
  const detail = (id: string) => extensionPage({ state: { ...state, page: "plugin:" + encodeURIComponent(id) } }).render();
  assert.match(detail(parent.id), /aria-label="卸载 画室"/);
  assert.match(detail(independent.id), /aria-label="卸载 工坊"/);
  assert.match(detail(child.id), /data-plugin-id="studio\/palette" data-plugin-action="stop"/);
  assert.doesNotMatch(detail(child.id), /data-community-uninstall/);
});

test("管理页重复渲染沿用本机清单，点卸载才预览，确认后仅提交所选计划", async t => {
  const ui = manager(t, plan, parent.id);
  await bindManageActions(ui.app);
  await bindManageActions(ui.app);
  const local = () => ui.requests.filter(([path]) => path !== "/api/official-plugins");
  assert.deepEqual(local(), [["/api/community-plugins/manage", undefined]]);
  await ui.click(child.id);
  assert.equal(ui.dialogs.length, 0);
  await ui.click(parent.id);
  const dialog = ui.dialogs[0];
  assert.equal(dialog.title, "卸载 画室");
  assert.equal(dialog.label, "卸载 画室");
  assert.match(dialog.body, /随包卸载/);
  assert.match(dialog.body, /调色板/);
  assert.match(dialog.body, /配置和用户数据会保留/);
  assert.doesNotMatch(dialog.body, /工坊/);
  assert.deepEqual(local()[1], ["/api/community-plugins/uninstall/preview", { id: parent.id }]);
  assert.equal(local().length, 2);
  await dialog.submit!();
  assert.deepEqual(local()[2], ["/api/community-plugins/uninstall/apply", { id: parent.id, planKey: plan.planKey }]);
  assert.equal(ui.location.hash, "#plugins");
});

test("依赖阻止原因只在点击后的弹窗显示，无法确认卸载", async t => {
  const reason = "请先卸载依赖它的插件：<工坊>。";
  const ui = manager(t, { ...plan, action: "", planKey: "", reason });
  await bindManageActions(ui.app);
  assert.doesNotMatch(pluginCard(status, parent, ui.app.state), /请先卸载|&lt;工坊&gt;/);
  await ui.click(parent.id);
  assert.equal(ui.dialogs[0].title, "暂时无法卸载 画室");
  assert.match(ui.dialogs[0].body, /&lt;工坊&gt;/);
  assert.match(ui.dialogs[0].body, /调色板/);
  assert.equal(ui.dialogs[0].submit, undefined);
  assert.ok(!ui.requests.some(([path]) => path.endsWith("/apply")));
});
