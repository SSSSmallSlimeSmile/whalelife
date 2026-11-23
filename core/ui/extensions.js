/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, extensionPlugins } from "./api.js";
import { icon } from "./icons.js";
import { manageIcon } from "./community-icons.js";
import { bindManageActions, renderManageBadgeSlot, renderManageSlot } from "./official-plugins.js";
import { renderChildUpdates } from "./plugin-updates.js";
export const extensionKey = (path) => "extension:" + encodeURIComponent(path);
export const pluginKey = (id) => "plugin:" + encodeURIComponent(id);
export const extensionEntries = (status) => (status?.pluginPages ?? []).filter((p) => status.plugins?.some((plugin) => plugin.id === p.owner && plugin.status === "active"));
const statusName = (status) => ({ active: "运行中", stopped: "已停用", blocked: "等待依赖", failed: "加载失败", loading: "加载中" })[status] || status;
const badge = (p) => `<span class="badge ${p.status === "active" ? "green" : p.status === "failed" ? "red" : ""}">${e(statusName(p.status))}</span>`;
const belongs = (id, parent) => id === parent || id.startsWith(parent + "/");
const decode = (value) => { try { return decodeURIComponent(value); } catch { return ""; } };
const plugins = (status) => extensionPlugins(status || { plugins: [] });

// Only existing, explicitly opted-in ancestors collect their descendants.
// Complete ID segments prevent similarly named independent plugins being hidden.
export function pluginGroup(status, id) {
  return plugins(status).filter(p => p.console?.groupChildren === true && belongs(id, p.id))
    .sort((a, b) => a.id.length - b.id.length)[0];
}
export function visiblePluginCards(status) {
  return plugins(status).filter(p => { const parent = pluginGroup(status, p.id); return !parent || parent.id === p.id; });
}
function selection(status, page) {
  const entries = extensionEntries(status);
  if (page.startsWith("plugin:")) {
    const owner = plugins(status).find(p => p.id === decode(page.slice(7)));
    const own = entries.filter(p => p.owner === owner?.id && (p.settings || p.navigation));
    return { owner, entry: own.find(p => p.settings) || own[0] };
  }
  const path = decode(page.slice("extension:".length));
  const entry = entries.find(p => p.path === path);
  // A removed page must still lead to its stopped/failed plugin's management.
  const owner = plugins(status).find(p => p.id === entry?.owner) || plugins(status)
    .filter(p => path.startsWith(`/plugins/${p.id}/`)).sort((a, b) => b.id.length - a.id.length)[0];
  return { owner, entry };
}
export function extensionActiveKey(status, page) {
  if (!page.startsWith("extension:") && !page.startsWith("plugin:")) return page;
  const owner = selection(status, page).owner;
  const group = owner && pluginGroup(status, owner.id);
  return group ? pluginKey(group.id) : page;
}
export const extensionSignature = status => JSON.stringify([status?.plugins, status?.pluginPages]);

// Update host controls without detaching a live iframe and losing its unsaved form.
// Explicit navigation/reload still replaces the document normally.
export function updateExtensionContent(content, markup) {
  const next = content.ownerDocument.createElement("div");
  next.innerHTML = markup;
  const oldFrame = content.querySelector(".extension-frame"), newFrame = next.querySelector(".extension-frame");
  if (!oldFrame || !newFrame || oldFrame.getAttribute("src") !== newFrame.getAttribute("src") ||
      !!content.querySelector(".plugin-workspace") !== !!next.querySelector(".plugin-workspace")) return false;
  for (const selector of [".page-heading", ".plugin-family", ".plugin-detail", ".plugin-page-links", ".plugin-notice"]) {
    const old = content.querySelector(selector), replacement = next.querySelector(selector);
    if (old && replacement) old.replaceWith(replacement);
    else if (old) old.remove();
    else if (replacement) {
      const main = content.querySelector(".plugin-workspace-main");
      main.insertBefore(replacement, selector === ".plugin-notice" ? main.firstChild : content.querySelector(".extension-panel"));
    }
  }
  oldFrame.title = newFrame.title;
  return true;
}

function actions(p) {
  return `<button class="btn small" data-plugin-id="${e(p.id)}" data-plugin-action="${(p.enabled ?? p.status === "active") ? "stop" : "start"}">${(p.enabled ?? p.status === "active") ? "停用" : "启用"}</button><button class="btn small tonal" data-plugin-id="${e(p.id)}" data-plugin-action="reload">${icon("refresh")}重载</button>`;
}
export function pluginCard(status, p, state) {
  const grouped = pluginGroup(status, p.id)?.id === p.id;
  const children = plugins(status).filter(c => c.id !== p.id && belongs(c.id, p.id));
  const childMenu = grouped && children.length ? `<details class="plugin-card-children"><summary>${children.length} 个子插件 ${renderChildUpdates(state, p.id)}</summary>
    ${children.map(child => `<div class="plugin-card-child"><span class="store-name-line">${manageIcon(state, child, true)}<a href="#${pluginKey(child.id)}">${e(child.name || child.id)}</a>${renderManageBadgeSlot(state, child.id)}</span>${renderManageSlot(state, child.id)}</div>`).join("")}</details>` : "";
  return `<article class="panel plugin-card ${p.id.includes("/") ? "child" : ""}"><div class="row">${manageIcon(state, p)}<div class="store-name-line"><h3>${e(p.name || p.id)}</h3>${renderManageBadgeSlot(state, p.id)}</div><div class="spacer"></div>${badge(p)}</div><code>${e(p.id)} · v${e(p.version || "0.1.0")}</code><p class="${p.error ? "plugin-error" : ""}">${e(p.error || p.description || "扩展插件")}</p><footer>${grouped ? `<a class="btn small" href="#${pluginKey(p.id)}">${icon("sliders")}打开 / 管理</a>` : extensionSettings(status, p.id)}${actions(p)}${renderManageSlot(state, p.id)}${!grouped && p.id.includes("/") ? '<small class="plugin-child-count">子插件</small>' : ""}</footer>${childMenu}</article>`;
}
export function bindPluginActions(app) {
  if (app.state) bindManageActions(app);
  app.content.querySelectorAll(".plugin-more").forEach(menu => menu.addEventListener?.("keydown", event => {
    if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); }
  }));
  app.content.querySelectorAll("[data-plugin-action]").forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api("/api/plugin", { id: button.dataset.pluginId, action: button.dataset.pluginAction });
        await app.refreshStatus(); app.render(); app.toast("插件状态已更新");
      } catch (error) { app.toast(error.message, true); }
      finally { button.disabled = false; }
    };
  });
}
function familyNavigation(status, root, selected) {
  const members = plugins(status).filter(p => belongs(p.id, root.id));
  const label = p => members.filter(parent => parent.id !== root.id && belongs(p.id, parent.id))
    .sort((a, b) => a.id.length - b.id.length).map(parent => parent.name || parent.id).join(" / ");
  const link = (p, parent = false) => `<a class="plugin-family-link ${p.id === selected.id ? "selected" : ""}" href="#${pluginKey(p.id)}" title="${e(parent ? `${p.name || p.id} · 父插件设置` : `${label(p)} · ${statusName(p.status)}`)}" ${p.id === selected.id ? 'aria-current="page"' : ""}><span class="plugin-state-dot ${p.status === "active" ? "running" : p.status === "failed" ? "failed" : ""}" aria-label="${e(statusName(p.status))}"></span><span>${e(parent ? `${p.name || p.id} 设置` : label(p))}</span></a>`;
  const children = members.filter(p => p.id !== root.id);
  return `<nav class="plugin-family" aria-label="父子插件"><div class="plugin-parent-tab">${link(root, true)}</div>${children.length ? `<span class="plugin-family-label">子插件</span><div class="plugin-child-tabs">${children.map(p => link(p)).join("")}</div>` : ""}</nav>`;
}
function groupPage(app, owner, entry, root) {
  const status = app.state.status;
  const ownPages = extensionEntries(status).filter(p => p.owner === owner.id && (p.settings || p.navigation));
  const pageLinks = ownPages.length > 1 ? `<nav class="plugin-page-links" aria-label="插件页面">${ownPages.map(p => `<a class="btn small ${p.path === entry?.path ? "tonal" : ""}" href="#${extensionKey(p.path)}">${e(p.title)}</a>`).join("")}</nav>` : "";
  const content = entry ? `<section class="panel extension-panel"><iframe class="extension-frame" title="${e(entry.title)}" src="${e(entry.path)}"></iframe></section>`
    : `<div class="plugin-empty">${icon("puzzle")}<h2>${owner.status === "active" ? "暂无可用页面" : "插件未运行"}</h2><p>${owner.status === "active" ? "此插件未注册可用页面，或原页面已移除。" : "可以在右上方启用或重载，已有设置会保留。"}</p></div>`;
  const info = `<details class="plugin-more"><summary class="btn small" aria-label="插件信息与更多操作" title="插件信息与更多操作">${icon("more")}</summary><div class="plugin-more-menu"><strong>${e(owner.name || owner.id)}</strong><code>${e(owner.id)} · v${e(owner.version || "0.1.0")}</code><p>${e(owner.description || "扩展插件")}</p><button class="btn small" data-plugin-id="${e(owner.id)}" data-plugin-action="reload">${icon("refresh")}重载插件</button></div></details>`;
  const heading = `<header class="plugin-detail"><div class="plugin-location"><a href="#plugins" aria-label="返回插件管理" title="返回插件管理">${icon("back")}</a><a class="plugin-root-name" href="#${pluginKey(root.id)}">${e(root.name || root.id)}</a>${owner.id !== root.id ? `${icon("chevron")}<span class="plugin-selected-name">${e(owner.name || owner.id)}</span>` : '<span class="plugin-location-kind">父插件</span>'}</div><div class="plugin-controls">${badge(owner)}<button class="btn small ${(owner.enabled ?? owner.status === "active") ? "" : "primary"}" data-plugin-id="${e(owner.id)}" data-plugin-action="${(owner.enabled ?? owner.status === "active") ? "stop" : "start"}">${(owner.enabled ?? owner.status === "active") ? "停用" : "启用"}</button>${renderManageSlot(app.state, owner.id)}${info}</div></header>`;
  const notice = owner.error ? `<div class="plugin-notice" role="status">${icon("info")}<span>${e(owner.error)}</span></div>` : "";
  return `<div class="plugin-workspace" data-runtime-id="${e(owner.id)}">${heading}${familyNavigation(status, root, owner)}<div data-official-read-status role="status"></div><div class="plugin-workspace-main">${notice}${pageLinks}${content}</div></div>`;
}
export function extensionPage(app) {
  const { owner, entry } = selection(app.state.status, app.state.page);
  const group = owner && pluginGroup(app.state.status, owner.id);
  if (owner && (group || app.state.page.startsWith("plugin:"))) {
    const root = group || owner;
    return { name: root.name || root.id, render: () => groupPage(app, owner, entry, root), bind: bindPluginActions };
  }
  return { name: entry?.title || "插件页面", render: () => entry
    ? `<div class="page-heading"><div><h1>${e(entry.title)}</h1><p>${e(entry.owner)}</p></div><a class="btn" href="#plugins">返回插件管理</a></div><section class="panel extension-panel"><iframe class="extension-frame" title="${e(entry.title)}" src="${e(entry.path)}"></iframe></section>`
    : '<div class="panel empty">插件已停用或页面已移除。<a href="#plugins">返回插件管理</a></div>' };
}
export function extensionNavigation(status, pinned = []) {
  const order = new Map(pinned.map((id, index) => [id, index]));
  const seen = new Set(), rows = [];
  for (const page of extensionEntries(status)) {
    if (!page.navigation) continue;
    const root = pluginGroup(status, page.owner);
    const key = root ? pluginKey(root.id) : extensionKey(page.path);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, id: root?.id || page.owner, title: root?.name || page.title });
  }
  // Keep the host's registry order intact when sorting this sidebar.
  const rank = row => order.get(row.id) ?? pinned.length;
  return rows.sort((left, right) => rank(left) - rank(right)).map(({ key, id, title }) => {
    const isPinned = order.has(id);
    const hint = isPinned ? "已置顶，右键取消置顶" : "右键置顶";
    const indicator = isPinned ? `<span class="plugin-pin-indicator" role="img" aria-label="已置顶">${icon("pin")}</span>` : "";
    return `<a href="#${e(key)}" data-page="${e(key)}" data-pin-plugin="${e(id)}" aria-haspopup="menu" aria-keyshortcuts="Shift+F10" title="${e(title)} · ${hint}">${icon("puzzle")}<span class="plugin-nav-label"><span class="plugin-nav-title">${e(title)}</span>${indicator}</span></a>`;
  }).join("");
}
export function extensionSettings(status, owner) {
  const page = extensionEntries(status).find((p) => p.owner === owner && p.settings);
  return page ? `<a class="btn small" href="#${extensionKey(page.path)}">${icon("sliders")}设置</a>` : "";
}
