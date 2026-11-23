/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";

const repositoryKey = url => typeof url === "string" ? url.replace(/\/$/, "").toLowerCase() : "";

function isInstalled(state, update) {
  if (update.source === "community" && state?.pluginUpdatesKey && state.pluginUpdatesKey !== installedKey(state)) return false;
  return state?.status?.plugins?.some(plugin =>
    !plugin.builtin && plugin.id === update.runtimeId && plugin.version === update.installedVersion &&
    (update.source !== "community" || plugin.repository == null || repositoryKey(plugin.repository) === repositoryKey(update.repository)));
}

export function storeUpdate(state, entry, source) {
  return state.pluginUpdates?.find(update => update.source === source && update.id === entry.id &&
    repositoryKey(update.repository) === repositoryKey(entry.repository) && isInstalled(state, update));
}

export function updateBadge(update) {
  if (!update) return "";
  const versions = `已安装 v${e(update.installedVersion)}，新版 v${e(update.latestVersion)}`;
  return `<span class="plugin-update-badge" title="${versions}">有更新</span>`;
}

function releaseLink(update) {
  try {
    const url = new URL(update.url);
    const repo = new URL(update.repository);
    const releases = repo.pathname.replace(/\/$/, "").toLowerCase() + "/releases";
    const path = url.pathname.toLowerCase();
    if (url.origin === "https://github.com" && repo.origin === url.origin &&
        !url.username && !url.password && (path === releases || path.startsWith(releases + "/"))) {
      return `<a class="plugin-update-link" href="${e(url.href)}" target="_blank" rel="noopener noreferrer">查看新版</a>`;
    }
  } catch {}
  return "";
}

export function updateDetails(update) {
  if (!update) return "";
  return `<p class="plugin-update-detail">已安装 v${e(update.installedVersion)} <span aria-hidden="true">→</span>
    新版 v${e(update.latestVersion)} ${releaseLink(update)}</p>`;
}

function managementNotice(state, runtimeId) {
  const update = state?.pluginUpdates?.find(row => row.runtimeId === runtimeId && isInstalled(state, row));
  return update ? updateBadge(update) + releaseLink(update) : "";
}

export function renderManageUpdate(state, runtimeId) {
  return `<span class="plugin-update-slot" data-plugin-update-runtime="${e(runtimeId)}">${managementNotice(state, runtimeId)}</span>`;
}

function childUpdates(state, parentId) {
  const prefix = parentId + "/";
  const count = state?.pluginUpdates?.filter(row => row.runtimeId.startsWith(prefix) && isInstalled(state, row)).length;
  return count ? `<span class="plugin-update-badge">${count} 个有更新</span>` : "";
}

export function renderChildUpdates(state, parentId) {
  return `<span data-plugin-update-children="${e(parentId)}">${childUpdates(state, parentId)}</span>`;
}

function paintUpdates(app) {
  for (const slot of app.content.querySelectorAll("[data-plugin-update-children]")) {
    slot.innerHTML = childUpdates(app.state, slot.dataset.pluginUpdateChildren);
  }
  for (const slot of app.content.querySelectorAll("[data-plugin-update-runtime]")) {
    const html = managementNotice(app.state, slot.dataset.pluginUpdateRuntime);
    if (slot.innerHTML === html) continue;
    const focused = slot.contains(slot.ownerDocument.activeElement);
    slot.innerHTML = html;
    if (focused) slot.querySelector("a")?.focus({ preventScroll: true });
  }
  app.content.ownerDocument.getElementById("plugin-store")?.dispatchEvent(new Event("plugin-updates"));
}

export function installedKey(state) {
  return JSON.stringify((state.status?.plugins || []).filter(p => !p.builtin)
    .map(p => [p.id, p.version, repositoryKey(p.repository)]).sort());
}

export function checkPluginsButton(state) {
  const busy = state.pluginUpdateCheck?.pending;
  return `<button type="button" class="btn small" data-check-plugin-updates${busy ? " disabled" : ""}>${busy ? "检查中…" : "检查插件更新"}</button>`;
}

function checkMessage(state) {
  const check = state.pluginUpdateCheck;
  return check && check.key === installedKey(state) ? check.message : "";
}

export function checkPluginsStatus(state) {
  return `<p class="plugin-check-status" data-plugin-check-status role="status">${e(checkMessage(state))}</p>`;
}

function paintCheckControls(app) {
  const store = app.content.ownerDocument.getElementById("plugin-store");
  const { pending } = app.state.pluginUpdateCheck;
  for (const root of [app.content, store]) {
    if (!root) continue;
    for (const button of root.querySelectorAll("[data-check-plugin-updates]")) {
      button.disabled = pending;
      button.textContent = pending ? "检查中…" : "检查插件更新";
    }
    for (const slot of root.querySelectorAll("[data-plugin-check-status]")) slot.textContent = checkMessage(app.state);
  }
}

export function bindPluginUpdateCheck(app, root) {
  const buttons = root.querySelectorAll("[data-check-plugin-updates]");
  for (const button of buttons) {
    button.onclick = () => loadPluginUpdates(app);
  }
  if (buttons.length && !app.pluginUpdateSnapshotRead && !app.state.pluginUpdateCheck) void restorePluginUpdates(app);
}

function updateSummary(state, updates, incomplete) {
  const count = updates.filter(update => isInstalled(state, update)).length;
  const found = count ? `发现 ${count} 个插件可更新。` : "";
  return incomplete ? found + "部分版本信息暂时无法核实，请稍后重试。" : found || "未发现可用的插件更新。";
}

export function clearCompletedUpdate(app, id, source) {
  const state = app.state;
  state.pluginUpdates = (state.pluginUpdates || []).filter(row => row.id !== id || row.source !== source);
  const check = state.pluginUpdateCheck;
  if (check && !check.pending) {
    check.message = updateSummary(state, state.pluginUpdates, check.incomplete);
    paintCheckControls(app);
  }
  paintUpdates(app);
}

async function restorePluginUpdates(app) {
  app.pluginUpdateSnapshotRead = true;
  const state = app.state, key = installedKey(state);
  try {
    const { updates, checked, incomplete } = await api("/api/plugin-updates");
    // An explicit check takes precedence over an earlier local snapshot read.
    if (state.pluginUpdateCheck || !Array.isArray(updates)) return;
    state.pluginUpdatesKey = key;
    state.pluginUpdates = updates;
    if (checked && key === installedKey(state)) {
      state.pluginUpdateCheck = { key, pending: false, incomplete, message: updateSummary(state, updates, incomplete) };
      paintCheckControls(app);
    }
    paintUpdates(app);
  } catch {
    // The check button remains usable if the previous local result could not be read.
  }
}

export async function loadPluginUpdates(app) {
  const state = app.state;
  if (state.pluginUpdateCheck?.pending) return;
  const check = { key: installedKey(state), pending: true, message: "" };
  state.pluginUpdateCheck = check;
  paintCheckControls(app);
  try {
    const { updates, incomplete } = await api("/api/plugin-updates/check", {});
    if (!Array.isArray(updates)) throw Error("插件更新结果格式有误，请稍后重试。");
    state.pluginUpdatesKey = check.key;
    state.pluginUpdates = updates;
    check.incomplete = incomplete;
    check.message = updateSummary(state, updates, incomplete);
    paintUpdates(app);
  } catch (error) {
    state.pluginUpdates = state.pluginUpdates?.filter(update => update.source !== "community") ?? [];
    paintUpdates(app);
    check.message = "检查插件更新失败：" + error.message;
  } finally {
    check.pending = false;
    paintCheckControls(app);
  }
}
