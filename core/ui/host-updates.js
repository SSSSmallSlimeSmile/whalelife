/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";

const endpoint = "/api/host-update";
const versionLabel = value => /^\d/.test(value) ? "v" + value : value;
const active = data => data?.phase === "preparing" || data?.phase === "restarting";

function releaseLink(address) {
  try {
    const url = new URL(address);
    if (url.origin === "https://github.com" && !url.username && !url.password &&
        /^\/iinukami\/whalelife\/(?:releases(?:\/|$)|commit\/)/i.test(url.pathname))
      return `<a class="host-release-link" href="${e(url.href)}" target="_blank" rel="noopener noreferrer">发行说明</a>`;
  } catch {}
  return "";
}

export function hostUpdateContent(app) {
  const ui = app.hostUpdate ?? {};
  const data = ui.data;
  const latest = data?.latest;
  const busy = ui.watching || active(data);
  const current = data?.current ? "当前版本 " + versionLabel(data.current) : "";
  const error = ui.error || data?.error;
  const available = Boolean(latest?.version && data?.supported && !error);
  let title = "WhaleLife 本体", status = "";
  if (busy) {
    title = ui.reconnecting ? "正在重新连接 WhaleLife" :
      data?.phase === "restarting" ? "WhaleLife 正在重启" : "正在准备本体更新";
    status = ui.reconnecting ? "连接恢复后将显示更新结果。" : "完成后会在这里显示结果。";
  } else if (latest?.version && !error) {
    title = "WhaleLife " + versionLabel(latest.version) + " 可更新";
  } else if (data?.supported && !error && data.phase === "idle") {
    status = data.checked ? "暂无更高的正式版本" : "尚未检查更新";
  }
  if (!busy && data?.supported === false && !error) {
    status = "当前安装方式不支持一键更新";
  }
  if (!busy && error && data?.lastCheckedAt && (ui.error || !data.checked)) {
    status = "上次成功检查 " + new Date(data.lastCheckedAt).toLocaleString("zh-CN", { hour12: false });
  }
  const info = [current, status].filter(Boolean).join(" · ");
  const last = data?.lastResult;
  const resultLabel = { updated: "更新成功", "rolled-back": "更新失败，已回滚", failed: "更新失败" }[last?.status];
  const result = !busy && resultLabel
    ? `<p class="host-update-result ${last.status === "updated" ? "ok" : "warning"}">上次更新 · ${e(resultLabel)}${last.version ? "（" + e(versionLabel(last.version)) + "）" : ""}${last.message ? "。" + e(last.message) : ""}</p>` : "";
  const release = !busy && !error && latest ? releaseLink(latest.url) : "";
  const open = available
    ? `<button type="button" class="btn small primary" data-host-action="open"${ui.reading ? " disabled" : ""}>查看更新</button>` : "";
  const button = busy ? "" : open + `<button type="button" class="btn small" data-host-action="check"${ui.reading ? " disabled" : ""}>${ui.checking ? "检查中…" : "检查更新"}</button>`;
  return `<div class="host-update-line"><span class="host-update-icon${available ? " available" : ""}">${icon(busy ? "refresh" : "download")}</span>
    <div class="host-update-copy" role="status"><strong>${e(title)}</strong><small>${info ? e(info) + " · " : ""}<a class="host-release-link" href="https://github.com/iinukami/whalelife/releases" target="_blank" rel="noopener noreferrer">GitHub 正式发行版</a></small>${result}
    ${error && !busy ? `<p class="host-update-result warning">${e(error)}</p>` : ""}</div>
    <div class="host-update-actions">${release}${button}</div></div>`;
}

function paint(app) {
  const slot = app.content.querySelector("[data-host-update]");
  if (!slot) return;
  const focused = slot.contains(slot.ownerDocument.activeElement);
  slot.innerHTML = hostUpdateContent(app);
  if (focused) slot.querySelector("button:enabled")?.focus({ preventScroll: true });
}

function schedule(app) {
  const ui = app.hostUpdate;
  clearTimeout(ui.timer);
  if (app.authenticated && ui.watching)
    ui.timer = setTimeout(() => void read(app), 2000);
}

async function read(app, checkRelease = false) {
  const ui = app.hostUpdate;
  if (ui.reading || ui.submitting || !app.authenticated) return;
  ui.reading = true;
  ui.checking = checkRelease;
  paint(app);
  try {
    const data = await api(checkRelease ? endpoint + "/check" : endpoint, checkRelease ? {} : undefined, AbortSignal.timeout(20_000));
    if (ui !== app.hostUpdate) return;
    ui.data = data;
    ui.error = "";
    ui.watching = active(data);
    ui.reconnecting = false;
    ui.disconnectedAt = 0;
  } catch (error) {
    if (ui !== app.hostUpdate) return;
    if (error.status === 401) return app.requireLogin();
    if (ui.watching) {
      ui.reconnecting = true;
      ui.disconnectedAt ||= Date.now();
      if (Date.now() - ui.disconnectedAt >= 180_000) {
        ui.data = undefined;
        ui.watching = false;
        ui.error = "尚未收到更新结果。服务恢复后可点「检查更新」重新连接。";
      }
    } else ui.error = error.message || "暂时无法读取更新状态。";
  } finally {
    if (ui === app.hostUpdate) {
      ui.reading = false;
      ui.checking = false;
      paint(app);
      schedule(app);
    }
  }
}

function confirmUpdate(app) {
  const ui = app.hostUpdate;
  const version = ui.data?.latest?.version;
  if (!version || !ui.data.supported || ui.watching || ui.submitting) return;
  app.dialog("更新 WhaleLife 并重启？",
    `<p class="official-dialog-text">将从 ${e(versionLabel(ui.data.current))} 更新到 <strong>${e(versionLabel(version))}</strong>。重启期间控制台会短暂断开，重新进入后可查看结果。</p>
    <p class="host-confirm-note">预检失败会恢复旧版。新版正式接管后，插件和会话产生的新数据会保留。</p>`,
    async () => {
      if (ui !== app.hostUpdate || ui.reading || ui.submitting || ui.watching || ui.data?.latest?.version !== version)
        throw Error("更新状态已变化，请关闭并重新查看。");
      clearTimeout(ui.timer);
      ui.submitting = true;
      ui.watching = true;
      ui.error = "";
      paint(app);
      try {
        const data = await api(endpoint + "/apply", { version, confirmed: true }, AbortSignal.timeout(30_000));
        if (ui !== app.hostUpdate) return;
        ui.data = data;
        ui.watching = active(data);
      } catch (error) {
        if (ui !== app.hostUpdate) return;
        if (error.status === 401) return app.requireLogin();
        if (error.status) {
          ui.watching = false;
          ui.error = error.message;
        } else {
          // A lost response can follow an accepted update. Only poll; never resubmit it.
          ui.reconnecting = true;
          ui.disconnectedAt = Date.now();
        }
      } finally {
        if (ui === app.hostUpdate) {
          ui.submitting = false;
          paint(app);
          schedule(app);
        }
      }
    }, "更新并重启");
}

export function bindHostUpdate(app) {
  const firstRead = !app.hostUpdate;
  const ui = app.hostUpdate ??= {};
  const slot = app.content.querySelector("[data-host-update]");
  slot.onclick = event => {
    const button = event.target.closest("[data-host-action]");
    if (!button || button.disabled || ui.reading || ui.watching || ui.submitting) return;
    if (button.dataset.hostAction === "open") confirmUpdate(app);
    else void read(app, true);
  };
  if (firstRead) void read(app);
}

export function resetHostUpdateSession(app) {
  const ui = app.hostUpdate;
  clearTimeout(ui?.timer);
  app.hostUpdate = undefined;
  return Boolean(ui?.watching);
}
