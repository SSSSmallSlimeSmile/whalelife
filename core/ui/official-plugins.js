/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";
import { clearCompletedUpdate, installedKey, renderManageUpdate } from "./plugin-updates.js";

const stepNames = { install: "安装", enable: "启用", reuse: "沿用", uninstall: "卸载", update: "更新" };
export const officialBadge = '<span class="store-official-badge">官方</span>';

function upgradeLink(url) {
  try {
    const target = new URL(url);
    if (target.origin === "https://github.com" && !target.username && !target.password)
      return `<p class="official-help"><a href="${e(target.href)}" target="_blank" rel="noopener noreferrer">查看升级说明</a></p>`;
  } catch {}
  return "";
}

function actionButton(state, plugin, action) {
  const install = action === "install";
  const verb = install ? "安装" : "卸载";
  const label = state.officialBusy === plugin.id ? verb + "中…" : verb;
  return `<button type="button" class="btn small ${install ? "tonal" : "official-remove"}" data-official-id="${e(plugin.id)}" data-official-action="${action}" aria-label="${e(verb + " " + plugin.name)}" ${state.officialBusy ? "disabled" : ""}>${label}</button>`;
}

// The catalog may include newer public entries. Only the host can supply a verified install plan.
export function renderStoreInstall(state, id) {
  const plugin = state.officialPlugins?.find(item => item.id === id);
  if (!plugin) return state.officialPlugins ? '<span class="official-version">本机尚无已验证版本</span>' : "";
  const version = plugin.installed ? plugin.installedVersion : plugin.version;
  const versionTag = version ? `<span class="official-version" aria-label="${plugin.installed ? "已安装" : "安装"}版本 v${e(version)}">v${e(version)}</span>` : "";
  return versionTag + (plugin.installed ? '<span class="official-installed">已安装</span>' : actionButton(state, plugin, "install"));
}

function installedPlugin(state, runtimeId) {
  return state?.officialPlugins?.find(item => item.installed && item.runtimeId === runtimeId);
}

function removeButton(state, runtimeId) {
  const plugin = installedPlugin(state, runtimeId);
  if (plugin) return actionButton(state, plugin, "uninstall");
  const community = state?.communityManaged?.find(item => item.id === runtimeId);
  if (!community) return "";
  const pending = state.communityRemovalPreview === runtimeId;
  const label = pending ? "核对中…" : state.officialBusy === runtimeId ? "卸载中…" : "卸载";
  return `<button type="button" class="btn small official-remove" data-community-uninstall="${e(runtimeId)}" aria-label="卸载 ${e(community.name)}" ${state.officialBusy || state.communityRemovalPreview ? "disabled" : ""}>${label}</button>`;
}

function installedBadge(state, runtimeId) {
  const recognized = state?.recognizedRuntimeIds?.includes(runtimeId) ?? installedPlugin(state, runtimeId)?.recognized;
  return recognized ? officialBadge : "";
}

export function renderManageBadgeSlot(state, runtimeId) {
  return `<span data-official-badge-slot="${e(runtimeId)}">${installedBadge(state, runtimeId)}</span>` + renderManageUpdate(state, runtimeId);
}

export function renderManageSlot(state, runtimeId) {
  return `<span class="official-manage-slot" data-official-manage-slot="${e(runtimeId)}">${removeButton(state, runtimeId)}</span>`;
}

function paintSlots(content, state) {
  for (const slot of content.querySelectorAll("[data-official-badge-slot]")) {
    slot.innerHTML = installedBadge(state, slot.dataset.officialBadgeSlot);
  }
  for (const slot of content.querySelectorAll("[data-official-store-slot], [data-official-manage-slot]")) {
    const focused = slot.contains(content.ownerDocument.activeElement);
    slot.innerHTML = slot.hasAttribute("data-official-manage-slot")
      ? removeButton(state, slot.dataset.officialManageSlot) : renderStoreInstall(state, slot.dataset.officialStoreSlot);
    if (focused) slot.querySelector("button:enabled")?.focus({ preventScroll: true });
  }
  for (const slot of content.querySelectorAll("[data-official-read-status]")) {
    const officialError = state.officialReadError
      ? `${e(state.officialReadError)} <button class="btn small" type="button" data-official-retry>重试</button>` : "";
    const communityError = !slot.closest("#plugin-store") && state.communityManageError
      ? `${e(state.communityManageError)} <button class="btn small" type="button" data-community-manage-retry>重试</button>` : "";
    slot.innerHTML = [officialError, communityError].filter(Boolean).join("<br>");
  }
}

function paint(app) {
  paintSlots(app.content, app.state);
  const drawer = app.content.ownerDocument.getElementById("store-drawer");
  if (drawer?.open) {
    paintSlots(drawer, app.state);
    app.storeOfficialChange?.();
  }
}

async function refresh(app, redraw = false) {
  if (app.officialRead || app.state.officialBusy) return;
  const read = api("/api/official-plugins");
  app.officialRead = read;
  try {
    const { plugins, recognizedRuntimeIds } = await read;
    if (app.officialRead !== read) return;
    if (!Array.isArray(plugins)) throw Error("官方插件状态格式有误");
    app.state.officialPlugins = plugins;
    app.state.recognizedRuntimeIds = Array.isArray(recognizedRuntimeIds) ? recognizedRuntimeIds : null;
    app.state.officialReadError = "";
  } catch (error) {
    if (app.officialRead !== read) return;
    app.state.officialPlugins = null;
    app.state.recognizedRuntimeIds = null;
    app.state.officialReadError = "无法读取本机插件版本。" + error.message;
  } finally {
    if (app.officialRead === read) {
      try {
        // Rebind against this snapshot so rendering the page does not start another disk scan.
        if (redraw && (app.state.page === "plugins" || app.state.page === "overview")) {
          if (app.content.ownerDocument.getElementById("store-drawer")?.open) app.storeNeedsRefresh = true;
          else app.render();
        }
        paint(app);
      } finally {
        app.officialRead = null;
      }
    }
  }
}

async function readCommunityManage(app) {
  const { state, content } = app;
  const key = installedKey(state);
  if (app.communityManageSnapshot?.key === key) return;
  const snapshot = app.communityManageSnapshot = { key };
  state.communityManaged = null;
  state.communityManageError = "";
  if (!state.status?.plugins?.some(plugin => !plugin.builtin)) return;
  try {
    const { plugins } = await api("/api/community-plugins/manage");
    if (app.communityManageSnapshot !== snapshot) return;
    if (!Array.isArray(plugins)) throw Error("本机社区插件列表格式有误。");
    state.communityManaged = plugins;
  } catch (error) {
    if (app.communityManageSnapshot !== snapshot) return;
    state.communityManageError = "无法读取本机社区插件。" + error.message;
  } finally {
    if (app.communityManageSnapshot === snapshot) paintSlots(content, state);
  }
}

function openDialog(app, plugin, title, body, submit, label, danger) {
  const page = app.state.page, doc = app.content.ownerDocument;
  app.dialog(title, body, submit, label, danger);
  doc.getElementById("dialog")?.addEventListener("close", () => {
    if (app.state.page !== page || (doc.activeElement?.isConnected && doc.activeElement !== doc.body)) return;
    const drawer = doc.getElementById("store-drawer");
    const surface = drawer?.open ? drawer : app.content;
    const buttons = surface.querySelectorAll("[data-plugin-update]:enabled, [data-official-action]:enabled, [data-community-install]:enabled, [data-community-uninstall]:enabled, [data-store-entry]");
    const button = [...buttons].find(b => (b.dataset.pluginUpdate || b.dataset.officialId || b.dataset.communityInstall || b.dataset.communityUninstall) === plugin.id)
      || [...buttons].find(b => b.dataset.storeEntry === plugin.id);
    (button || surface.querySelector("#store-heading"))?.focus({ preventScroll: true });
  }, { once: true });
}

function failureMessage(error) {
  const changes = error.rolledBack;
  return error.message + (changes?.length ? "\n\n已撤回的改动\n" + changes.join("\n") : "");
}

function installSteps(plugin) {
  const steps = plugin.steps || [];
  const components = plugin.components || [];
  return `<ul class="official-plan">${steps.map(step => `<li><span>${e(stepNames[step.action])}</span><strong>${e(step.name || step.id)}</strong><small>v${e(step.version)}</small></li>`).join("")}${components.map(part => `<li><span>从上游下载并校验</span><strong>${e(part.name)}</strong><small>v${e(part.version)}</small></li>`).join("")}</ul>`;
}

async function apply(app, plugin, source = "official") {
  const { state, content } = app;
  if (state.officialBusy) throw Error("另一个插件操作正在进行。");
  state.officialBusy = plugin.id;
  app.officialRead = null;
  paint(app);
  let applied = false;
  try {
    let result;
    if (plugin.action === "update")
      result = await api("/api/plugin-updates/apply", { id: plugin.id, source, version: plugin.version, planKey: plugin.planKey });
    else if (source === "community" && plugin.action === "uninstall")
      result = await api("/api/community-plugins/uninstall/apply", { id: plugin.id, planKey: plugin.planKey });
    else result = await api(`/api/${source}-plugins/apply`, { id: plugin.id, action: plugin.action, planKey: plugin.planKey });
    if (!result.ok) throw Object.assign(Error(result.error || result.message || "插件操作失败。"), { rolledBack: result.rolledBack });
    applied = true;
    app.toast(result.message);
  } finally {
    try { await app.refreshStatus(); } catch (error) { app.toast(error.message, true); }
    state.officialBusy = null;
    if (applied && (plugin.action === "update" || source === "community" && plugin.action === "uninstall"))
      clearCompletedUpdate(app, plugin.id, source);
    app.communityManageSnapshot = null;
    state.communityManaged = null;
    // Installing or enabling a dependency changes the plan for other entries too.
    state.communityPlugins = null;
    app.communityRead = null;
    content.ownerDocument.getElementById("plugin-store")?.dispatchEvent(new Event("community-plans-invalidated"));
    const workspace = content.querySelector(".plugin-workspace");
    if (applied && plugin.action === "uninstall" && workspace?.dataset.runtimeId === plugin.runtimeId) {
      state.officialPlugins = null;
      state.recognizedRuntimeIds = null;
      content.ownerDocument.defaultView.location.hash = "#plugins";
    } else {
      await refresh(app, true);
      if (content.querySelector("[data-official-manage-slot]")) await readCommunityManage(app);
    }
  }
}

export async function confirmPluginUpdate(app, entry, update, stillCurrent) {
  const state = app.state;
  if (state.officialBusy || state.pluginUpdatePreview || !stillCurrent()) return;
  state.pluginUpdatePreview = entry.id;
  app.storeOfficialChange?.();
  let plan;
  try {
    plan = await api("/api/plugin-updates/preview", { id: entry.id, source: update.source, version: update.latestVersion });
    if (!stillCurrent()) return;
    if (!plan.planKey) throw Error(plan.reason || "当前安装环境无法更新。");
    if (plan.id !== entry.id || plan.version !== update.latestVersion || plan.installedVersion !== update.installedVersion)
      throw Error("插件版本已变化，请重新检查更新。");
  } catch (error) {
    if (stillCurrent()) openDialog(app, entry, "暂时无法更新 " + entry.name, `<p class="official-dialog-text">${e(error.message)}</p>`);
    return;
  } finally {
    state.pluginUpdatePreview = null;
    app.storeOfficialChange?.();
  }
  const body = `<p class="official-dialog-text">${e(entry.name)} 将从 v${e(plan.installedVersion)} 更新到 <strong>v${e(plan.version)}</strong>。配置、数据和该插件原有的启停状态都会保留。</p>` +
    installSteps(plan);
  openDialog(app, entry, "确认更新 " + entry.name, body, async () => {
    if (!stillCurrent()) throw Error("更新计划已变化，请关闭并重新检查。");
    try { await apply(app, { ...plan, action: "update" }, update.source); }
    catch (error) { throw Error(failureMessage(error)); }
  }, e(plan.label || "更新到 v" + plan.version));
}

export function confirmCommunityInstall(app, entry, plugin, stillCurrent) {
  if (app.state.officialBusy) return;
  if (plugin.action === "blocked") {
    openDialog(app, entry, "暂时无法安装 " + entry.name,
      `<p class="official-dialog-text">${e(plugin.reason || "当前安装环境不兼容。")}</p>`);
    return;
  }
  if (plugin.action !== "install" || !plugin.planKey) return;
  const body = `<p class="official-dialog-text">将安装 ${e(entry.author)} 发布的 ${e(entry.name)} v${e(plugin.version)}。</p>` +
    installSteps(plugin);
  openDialog(app, entry, "安装 " + entry.name, body, async () => {
    if (!stillCurrent()) throw Error("安装计划已变化，请关闭并重新查看。");
    try { await apply(app, plugin, "community"); }
    catch (error) { throw Error(failureMessage(error)); }
  }, e(plugin.buttonLabel || "确认安装"));
}

async function confirmCommunityUninstall(app, button) {
  const { state, content } = app;
  const id = button.dataset.communityUninstall;
  const plugin = state.communityManaged?.find(item => item.id === id);
  if (!plugin || button.closest("[data-official-manage-slot]")?.dataset.officialManageSlot !== id) return;
  const page = state.page;
  const current = () => state.page === page && !content.ownerDocument.getElementById("store-drawer")?.open &&
    state.communityManaged?.some(item => item.id === id && item.version === plugin.version);
  if (!current()) return;
  state.communityRemovalPreview = id;
  paintSlots(content, state);
  let plan;
  try {
    plan = await api("/api/community-plugins/uninstall/preview", { id });
    if (!current()) return;
    if (plan.id !== id) throw Error("插件已变化，请重新查看。");
    if (plan.action === "uninstall" && plan.installedVersion !== plugin.version) throw Error("已装版本已变化，请重新查看。");
  } catch (error) {
    if (current()) openDialog(app, plugin, "暂时无法卸载 " + plugin.name, `<p class="official-dialog-text">${e(error.message)}</p>`);
    return;
  } finally {
    state.communityRemovalPreview = null;
    paintSlots(content, state);
  }
  const children = plan.bundledPlugins || [];
  const childList = children.length ? `<ul class="official-plan">${children.map(child => `<li><strong>${e(child.name || child.id)}</strong><small>${e(child.id)}</small></li>`).join("")}</ul>` : "";
  if (plan.action !== "uninstall" || !plan.planKey) {
    const reason = `<p class="official-dialog-text">${e(plan.reason || "当前无法安全卸载。")}</p>`;
    openDialog(app, plugin, "暂时无法卸载 " + plugin.name, reason + (childList ? "<p>此发行包包含以下子插件。</p>" + childList : ""));
    return;
  }
  const body = `<p class="official-dialog-text">将移除 <strong>${e(plugin.name)} v${e(plan.installedVersion)}</strong> 的程序文件。配置和用户数据会保留，重新安装后可以继续使用。</p>` +
    (childList ? "<p>以下子插件随包卸载，其配置和用户数据也会保留。</p>" + childList : "");
  openDialog(app, plugin, "卸载 " + plugin.name, body, async () => {
    if (!current()) throw Error("卸载计划已变化，请关闭并重新查看。");
    try { await apply(app, { ...plan, runtimeId: id }, "community"); }
    catch (error) { throw Error(failureMessage(error)); }
  }, e("卸载 " + plugin.name), true);
}

async function handleClick(app, event) {
  if (app.state.officialBusy || app.state.communityRemovalPreview) return;
  if (event.target.closest("[data-community-manage-retry]")) {
    app.communityManageSnapshot = null;
    return readCommunityManage(app);
  }
  const communityButton = event.target.closest("[data-community-uninstall]");
  if (communityButton && !communityButton.disabled) return confirmCommunityUninstall(app, communityButton);
  if (event.target.closest("[data-official-retry]")) return refresh(app);
  const button = event.target.closest("[data-official-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.officialAction;
  // A management card and a store listing have distinct authorities.
  const slot = button.closest(action === "install" ? "[data-official-store-slot]" : "[data-official-manage-slot]");
  const plugin = app.state.officialPlugins?.find(item => item.id === button.dataset.officialId);
  if (!slot || !plugin || (action === "install" ? slot.dataset.officialStoreSlot !== plugin.id || plugin.installed
    : action !== "uninstall" || slot.dataset.officialManageSlot !== plugin.runtimeId || !plugin.installed)) return refresh(app);
  const verb = action === "uninstall" ? "卸载" : "安装";
  if (plugin.reason || plugin.action !== action || !plugin.planKey) {
    const reason = plugin.reason || "插件状态已更新，请重新查看后再操作。";
    openDialog(app, plugin, "暂时无法" + verb + " " + plugin.name,
      `<p class="official-dialog-text">${e(reason)}</p>${upgradeLink(plugin.upgradeUrl)}`);
    return;
  }
  const steps = plugin.steps || [];
  const components = plugin.components || [];
  if (action === "uninstall" || components.length || steps.some(step => step.id !== plugin.id)) {
    const body = action === "uninstall"
      ? '<p class="official-dialog-text">只移除这个插件的程序文件。配置和用户资料会保留，重新安装后可以继续使用。</p>'
      : installSteps(plugin);
    openDialog(app, plugin, verb + " " + plugin.name, body, async () => {
      try { await apply(app, plugin); } catch (error) { throw Error(failureMessage(error)); }
    }, e(plugin.label || verb), action === "uninstall");
    return;
  }
  const page = app.state.page;
  try { await apply(app, plugin); }
  catch (error) {
    if (app.state.page === page) openDialog(app, plugin, verb + " " + plugin.name + "失败",
      `<p class="official-dialog-text">${e(failureMessage(error))}</p>`);
    else app.toast(failureMessage(error), true);
  }
}

export function bindOfficialActions(app, root = app.content, readPlan = true) {
  // Delegate from either the management page or the open store.
  app.officialActionClick ??= event => handleClick(app, event);
  root.addEventListener("click", app.officialActionClick);
  if (readPlan) void refresh(app);
}

export function bindManageActions(app) {
  bindOfficialActions(app);
  return readCommunityManage(app);
}
