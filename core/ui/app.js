/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, availableModels } from "./api.js";
import { icon, whale } from "./icons.js";
import { renderModels, bindModels } from "./models.js";
import { renderPersonas, bindPersonas } from "./personas.js";
import { renderMemory, bindMemory, loadMemory } from "./memory.js";
import { renderContextMeter } from "./context.js";
import { renderStore, bindStore } from "./plugin-store.js";
import { bindHostUpdate, resetHostUpdateSession } from "./host-updates.js";
import { extensionPage, extensionNavigation, extensionActiveKey, extensionSignature, updateExtensionContent } from "./extensions.js";
import {
  renderOverview,
  renderBindings,
  bindBindings,
  renderPlugins,
  bindPlugins,
  renderChat,
  bindChat,
  renderLogs,
  bindLogs,
} from "./views.js";

const pages = {
  memory: { name: "记忆管理", render: renderMemory, bind: bindMemory },
  personas: { name: "人格配置", render: renderPersonas, bind: bindPersonas },
  overview: { name: "概览", render: renderOverview, bind: bindHostUpdate },
  models: { name: "模型服务", render: renderModels, bind: bindModels },
  bindings: { name: "使用配置", render: renderBindings, bind: bindBindings },
  chat: { name: "对话", render: renderChat, bind: bindChat },
  plugins: { name: "插件管理", render: renderPlugins, bind: bindPlugins },
  logs: { name: "运行日志", render: renderLogs, bind: bindLogs },
};
const $ = (id) => document.getElementById(id);
const pinStorageKey = "whalelife.sidebar.pinnedPlugins";
function readPinnedPlugins() {
  try {
    const value = JSON.parse(localStorage.getItem(pinStorageKey) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string"))] : [];
  } catch { return []; }
}
const storeRoute = () => /^#market(?:\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*))?$/.exec(location.hash);
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
document
  .querySelectorAll("[data-whale]")
  .forEach((el) => (el.innerHTML = whale));

class ConsoleApp {
  content = $("content");
  chatWS = null;
  logWS = null;
  reply = null;
  authenticated = false;
  generation = 0;
  toastTimer = null;
  sessionSync = 0;
  sessionReady = false;
  sessionChanging = false;
  pinnedPlugins = readPinnedPlugins();
  state = {
    page: "overview",
    config: null,
    status: null,
    probes: {},
    messages: [],
    logs: [],
    logFollow: true,
    chatBusy: false,
    chatDraft: "",
    session: null,
    sessions: [],
    memorySession: null,
  };
  constructor() {
    this.state.page = this.pageFromHash();
    this.bindPinMenu();
    window.addEventListener("storage", event => {
      if (event.key !== null && event.key !== pinStorageKey) return;
      this.closePinMenu();
      this.pinnedPlugins = readPinnedPlugins();
      if (this.authenticated) this.renderNavigation();
    });
    window.addEventListener("hashchange", () => {
      this.storeNavigating = false;
      const route = storeRoute();
      const page = this.pageFromHash();
      if (route && this.authenticated) {
        if (page !== this.state.page) {
          this.hideStore();
          this.state.page = page;
          this.render();
        }
        this.restoreStoreRoute(route);
        return;
      }
      if ($("store-drawer").open) {
        this.hideStore();
        if (page === this.state.page) return;
      }
      this.state.page = page;
      this.bindingsDirty = false;
      if (this.state.page === "memory") this.state.memoryLoadedTab = null;
      document.body.classList.remove("sidebar-open");
      $("sidebar-scrim").hidden = true;
      if (this.authenticated) {
        this.render();
        this.syncView();
        if (this.state.page === "memory") loadMemory(this);
      }
    });
    this.content.addEventListener("click", event => {
      const link = event.target.closest('a[href="#market"]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.storeTrigger = link;
      history.pushState({ storeOrigin: this.state.page }, "", "#market");
      this.displayStore(null);
    });
    const drawer = $("store-drawer");
    drawer.addEventListener("cancel", event => {
      event.preventDefault();
      this.leaveStore(false);
    });
    drawer.addEventListener("click", event => {
      if (event.target !== drawer) return;
      const r = drawer.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX >= r.right || event.clientY < r.top || event.clientY >= r.bottom) this.leaveStore(true);
    });
    // 切回窗口只做静默同步：核对会话、补漏，不重拉会话也不跳位置
    window.addEventListener("focus", () => this.syncView({ quiet: true }));
    $("login-form").onsubmit = (event) => {
      event.preventDefault();
      this.login();
    };
    $("refresh").onclick = () => this.reload();
    $("menu-toggle").onclick = () => {
      if (innerWidth <= 760) {
        document.body.classList.toggle("sidebar-open");
        $("sidebar-scrim").hidden =
          !document.body.classList.contains("sidebar-open");
      } else document.body.classList.toggle("collapsed");
    };
    $("sidebar-scrim").onclick = () => {
      document.body.classList.remove("sidebar-open");
      $("sidebar-scrim").hidden = true;
    };
    $("dialog").addEventListener("click", (event) => {
      if (event.target === $("dialog") && !this.dialogBusy) this.closeDialog();
    });
    $("dialog").addEventListener("cancel", (event) => {
      if (this.dialogBusy) event.preventDefault();
    });
  }
  bindPinMenu() {
    const nav = $("extension-nav");
    const linkFor = event => event.target.closest("a[data-pin-plugin]");
    let menu, item, trigger, hold, suppressTap;
    const cancelHold = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    const close = () => {
      cancelHold();
      if (trigger) menu.hidePopover();
    };
    const open = (link, x, y, input = "mouse") => {
      if (!menu) {
        menu = document.createElement("div");
        menu.className = "plugin-nav-menu";
        menu.setAttribute("role", "menu");
        menu.innerHTML = `<button type="button" role="menuitem">${icon("pin")}<span></span></button>`;
        item = menu.firstElementChild;
        document.body.append(menu);
        menu.addEventListener("beforetoggle", event => {
          if (event.newState === "closed") {
            trigger?.removeAttribute("aria-expanded");
            trigger = null;
          }
        });
        // Keep pointer interactions in the sidebar from taking focus out of a plugin editor.
        item.addEventListener("mousedown", event => event.preventDefault());
        item.addEventListener("click", () => {
          if (!trigger) return;
          const { page, pinPlugin: id } = trigger.dataset;
          const restoreFocus = document.activeElement === item || document.activeElement === trigger;
          close();
          const pins = this.pinnedPlugins;
          this.pinnedPlugins = pins.includes(id) ? pins.filter(p => p !== id) : [id, ...pins];
          try { localStorage.setItem(pinStorageKey, JSON.stringify(this.pinnedPlugins)); }
          catch { /* Keep the tab preference if browser storage is unavailable. */ }
          this.renderNavigation();
          if (restoreFocus) nav.querySelector(`[data-page="${CSS.escape(page)}"]`)?.focus({ preventScroll: true });
        });
        item.addEventListener("keydown", event => {
          if (event.key !== "Escape" && event.key !== "Tab") return;
          if (event.key === "Escape") event.preventDefault();
          const link = trigger;
          close();
          link?.focus({ preventScroll: true });
        });
      }
      // A long press opens before the initial finger lifts. Native light-dismiss would
      // treat that same release as an outside click, so dismiss touch menus on the next press.
      const mode = input === "touch" ? "manual" : "auto";
      if (menu.popover !== mode) {
        close();
        menu.popover = mode;
      }
      trigger?.removeAttribute("aria-expanded");
      trigger = link;
      trigger.setAttribute("aria-expanded", "true");
      menu.setAttribute("aria-label", link.textContent.trim());
      item.lastElementChild.textContent = this.pinnedPlugins.includes(link.dataset.pinPlugin) ? "取消置顶" : "置顶";
      menu.showPopover();
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, document.documentElement.clientWidth - width - 4)) + "px";
      menu.style.top = Math.max(4, Math.min(y, document.documentElement.clientHeight - height - 4)) + "px";
      if (input === "keyboard") item.focus({ preventScroll: true });
    };
    nav.addEventListener("mousedown", event => {
      if (event.button === 2 && linkFor(event)) event.preventDefault();
    });
    nav.addEventListener("contextmenu", event => {
      const link = linkFor(event);
      if (!link) return;
      event.preventDefault();
      const touch = hold || event.pointerType === "touch" || suppressTap === link;
      if (touch) suppressTap = link;
      cancelHold();
      open(link, event.clientX, event.clientY, touch ? "touch" : "mouse");
    });
    nav.addEventListener("keydown", event => {
      const link = linkFor(event);
      if (!link || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      event.preventDefault();
      const { left, bottom } = link.getBoundingClientRect();
      open(link, left, bottom, "keyboard");
    });
    nav.addEventListener("pointerdown", event => {
      cancelHold();
      suppressTap = null;
      const link = linkFor(event);
      if (!link || event.pointerType !== "touch" || !event.isPrimary) return;
      const { clientX: x, clientY: y } = event;
      hold = { x, y, timer: setTimeout(() => {
        hold = null;
        suppressTap = link;
        open(link, x, y, "touch");
      }, 550) };
    });
    nav.addEventListener("pointermove", event => {
      if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancelHold();
    });
    nav.addEventListener("pointerup", cancelHold);
    nav.addEventListener("pointercancel", cancelHold);
    nav.addEventListener("touchend", event => {
      // A completed long press must not also synthesize a tap on the link or menu.
      if (suppressTap && linkFor(event) === suppressTap) {
        event.preventDefault();
        suppressTap = null;
      }
    }, { passive: false });
    window.addEventListener("pointerdown", event => {
      if (trigger && menu.popover === "manual" && !menu.contains(event.target)) close();
    }, true);
    window.addEventListener("keydown", event => {
      if (trigger && menu.popover === "manual" && event.key === "Escape") close();
    });
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("hashchange", close);
    window.addEventListener("blur", close);
    this.closePinMenu = close;
  }
  pageFromHash() {
    if (storeRoute()) return history.state?.storeOrigin === "overview" ? "overview" : "plugins";
    const key = location.hash.slice(1);
    return pages[key] || key.startsWith("extension:") || key.startsWith("plugin:") ? key : "overview";
  }
  restoreStoreRoute(route) {
    // Give a bookmarked drawer the same return path as a visit from the console.
    if (!history.state?.storeOrigin) {
      const origin = this.state.page;
      history.replaceState(null, "", "#" + origin);
      history.pushState({ storeOrigin: origin }, "", "#market");
      if (route[1]) history.pushState({ storeOrigin: origin }, "", "#market/" + route[1]);
    }
    this.displayStore(route[1] || null);
  }
  showStoreDetail(id) {
    history.pushState({ storeOrigin: this.state.page }, "", "#market/" + id);
    this.displayStore(id);
  }
  leaveStore(all) {
    if (this.storeNavigating) return;
    this.storeNavigating = true;
    history.go(all && this.state.storeDetail ? -2 : -1);
  }
  displayStore(id) {
    const drawer = $("store-drawer");
    const previous = this.state.storeDetail;
    const opening = !drawer.open;
    if (opening) {
      this.storeScroll = 0;
      this.storeTrigger ??= this.content.querySelector('a[href="#market"]');
      drawer.innerHTML = `<header class="store-drawer-bar">
        <button type="button" data-store-back></button>
        <button type="button" data-store-close>关闭商店 ${icon("close")}</button>
      </header><div class="store-drawer-body"></div>`;
      drawer.querySelector("[data-store-back]").onclick = () => this.leaveStore(false);
      drawer.querySelector("[data-store-close]").onclick = () => this.leaveStore(true);
      drawer.showModal();
    } else if (!previous && id) {
      this.storeScroll = drawer.querySelector("[data-store-scroll]")?.scrollTop || 0;
    }
    this.state.storeDetail = id;
    const backLabel = id ? "插件商店" : pages[this.state.page].name;
    drawer.querySelector("[data-store-back]").innerHTML = icon("back") + "返回" + backLabel;
    const container = drawer.querySelector(".store-drawer-body");
    container.innerHTML = renderStore(this);
    bindStore(this, container, opening);
    const scroll = container.querySelector("[data-store-scroll]");
    if (scroll && !id) scroll.scrollTop = this.storeScroll;
    const card = !id && previous ? container.querySelector(`[data-store-entry="${CSS.escape(previous)}"]`) : null;
    (card || container.querySelector("#store-heading") || drawer.querySelector("[data-store-back]")).focus({ preventScroll: true });
    document.title = "插件商店 · WhaleLife";
  }
  hideStore() {
    const drawer = $("store-drawer");
    if (!drawer.open) return;
    if ($("dialog").open) this.closeDialog();
    drawer.close();
    drawer.replaceChildren();
    this.storeOfficialChange = null;
    this.state.storeDetail = null;
    if (this.storeNeedsRefresh) {
      this.storeNeedsRefresh = false;
      const expanded = new Set([...this.content.querySelectorAll(".plugin-card-children[open]")]
        .map(detail => detail.closest(".plugin-card").querySelector("[data-official-manage-slot]")?.dataset.officialManageSlot));
      const scrollY = window.scrollY;
      this.render();
      for (const detail of this.content.querySelectorAll(".plugin-card-children")) {
        const owner = detail.closest(".plugin-card").querySelector("[data-official-manage-slot]");
        if (owner && expanded.has(owner.dataset.officialManageSlot)) detail.open = true;
      }
      window.scrollTo({ top: scrollY, behavior: "instant" });
    }
    const trigger = this.storeTrigger?.isConnected ? this.storeTrigger : this.content.querySelector('a[href="#market"]');
    trigger?.focus({ preventScroll: true });
    this.storeTrigger = null;
    document.title = pages[this.state.page].name + " · WhaleLife";
  }
  get chatConnected() {
    return this.chatWS?.readyState === WebSocket.OPEN;
  }
  get logConnected() {
    return this.logWS?.readyState === WebSocket.OPEN;
  }
  async start() {
    try {
      await this.load();
      await this.enter();
    } catch (error) {
      if (error.status !== 401)
        $("login-error").textContent = "连接控制台失败：" + error.message;
    }
  }
  async load() {
    const config = await api("/api/model-config");
    const status = await api("/api/status");
    this.state.status = status;
    this.state.config = config;
    await this.syncSession();
  }
  async login() {
    const button = $("login-form").querySelector("button");
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      await api("/api/login", { password: $("password").value });
      $("password").value = "";
      if (this.reloadAfterHostUpdate) {
        // The restarted server can ship different console modules.
        location.reload();
        return;
      }
      await this.load();
      await this.enter();
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  async enter() {
    this.authenticated = true;
    $("login").hidden = true;
    $("shell").hidden = false;
    this.render();
    const route = storeRoute();
    if (route) this.restoreStoreRoute(route);
    this.connect("chat");
    this.connect("logs");
  }
  async refreshStatus() {
    this.state.status = await api("/api/status");
  }
  async useSession(id) {
    if (this.state.chatBusy || this.sessionChanging) throw Error("请等待当前操作结束后切换会话");
    this.sessionChanging = true;
    this.updateChatControls();
    try {
      await this.syncSession({ id });
      this.state.chatDraft = "";
      this.render();
    } finally {
      this.sessionChanging = false;
      this.updateChatControls();
    }
  }
  async syncSession(input) {
    if (this.state.chatBusy || (!input && this.sessionChanging)) return;
    const sequence = ++this.sessionSync;
    const { id } = await api("/api/session/current", input ??
      (this.sessionReady ? undefined : { legacyId: localStorage.whaleSession }));
    const [page, choices] = await Promise.all([
      api(`/api/session?id=${encodeURIComponent(id)}&limit=${SESSION_PAGE}`),
      api("/api/session/list"),
    ]);
    if (sequence !== this.sessionSync || this.state.chatBusy) return;
    this.sessionReady = true;
    if (this.state.session !== id) {
      this.state.sessionContext = null;
      // 换会话才回到最新一条；同一会话刷新不动位置。
      this.pendingScrollBottom = true;
    }
    this.state.session = id;
    this.state.sessions = choices.items;
    this.state.sessionName = choices.items.find(item => item.id === id)?.name || id;
    if (this.state.memorySession && !choices.items.some(item => item.id === this.state.memorySession)) {
      this.state.memorySession = null;
      this.state.memoryContext = null;
      this.state.memoryLoadedTab = null;
    }
    localStorage.whaleSession = id;
    this.state.messages = messageRows(page.items);
    this.state.paging = {
      total: page.total,
      start: page.start,
      end: page.end,
      hasMore: page.hasMore,
    };
  }
  async refreshSessionContext() {
    const id = this.state.session;
    try {
      const value = await api(
        "/api/session/context?id=" + encodeURIComponent(id),
      );
      if (id !== this.state.session) return;
      this.state.sessionContext = value;
      if ($("chat-context"))
        $("chat-context").innerHTML = renderContextMeter(value, true);
    } catch (error) {
      if (id === this.state.session && $("chat-context"))
        $("chat-context").textContent = error.message;
    }
  }
  async syncView(options) {
    if ($("store-drawer").open) return;
    const page = this.state.page;
    if (options?.quiet === true) {
      // 切回窗口只刷状态与上下文，不重拉会话：重拉会让人正读着的消息被顶掉。
      if (!this.authenticated || this.syncing || this.state.chatBusy) return;
      this.syncing = true;
      try {
        await this.refreshStatus();
        if (page === "chat") await this.refreshSessionContext();
      } catch (error) {
        if (error.status === 401) this.requireLogin();
      } finally {
        this.syncing = false;
      }
      return;
    }
    if (this.authenticated && (page.startsWith("extension:") || page.startsWith("plugin:")) && !this.syncing) {
      this.syncing = true;
      try {
        const before = extensionSignature(this.state.status);
        await this.refreshStatus();
        if (this.state.page === page && before !== extensionSignature(this.state.status)) this.render(true);
      } catch (error) { this.toast(error.message, true); }
      finally { this.syncing = false; }
      return;
    }
    if (
      !this.authenticated ||
      this.state.chatBusy ||
      this.syncing ||
      (page === "bindings" && this.bindingsDirty) ||
      !["overview", "plugins", "chat", "memory", "bindings"].includes(page)
    )
      return;
    this.syncing = true;
    try {
      await this.load();
      if (this.state.page === page && !this.state.chatBusy) this.render();
    } catch (error) {
      if (error.status === 401) this.requireLogin();
      else this.toast(error.message, true);
    } finally {
      this.syncing = false;
    }
  }
  async reload() {
    const button = $("refresh");
    button.disabled = true;
    try {
      await this.load();
      if (this.state.page === "memory") await loadMemory(this);
      this.render(extensionActiveKey(this.state.status, this.state.page).startsWith("plugin:"));
      this.toast("状态已刷新");
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
  renderNavigation() {
    const navigation = extensionNavigation(this.state.status, this.pinnedPlugins);
    if (navigation !== this.navigationMarkup) {
      this.closePinMenu();
      $("extension-nav").innerHTML = navigation;
      $("extension-nav-group").hidden = !navigation;
      this.navigationMarkup = navigation;
    }
    const active = extensionActiveKey(this.state.status, this.state.page);
    $("sidebar").querySelectorAll("[data-page]").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === active);
      if (a.dataset.page === active)
        a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  render(preserveExtension = false) {
    if ($("store-drawer").open) return;
    if (!this.state.config || !this.state.status) return;
    const page = pages[this.state.page] || extensionPage(this);
    this.renderNavigation();
    $("breadcrumb").textContent = page.name;
    document.title = page.name + " · WhaleLife";
    const count = availableModels(this.state.config).length;
    $("nav-model-count").textContent = count;
    $("nav-model-count").title = `${count} 个已启用且配置有效的模型`;
    $("nav-model-count").setAttribute("aria-label", `${count} 个可用模型`);
    const markup = page.render(this);
    if (!preserveExtension || !updateExtensionContent(this.content, markup)) this.content.innerHTML = markup;
    page.bind?.(this);
    this.updateConnection();
  }
  configDraft() {
    const c = structuredClone(this.state.config);
    return {
      revision: c.revision,
      timezone: c.timezone,
      providers: c.providers,
      models: c.models,
      bindings: c.bindings,
      personaModels: Object.fromEntries(
        c.personas.map((p) => [p.id, p.model || null]),
      ),
    };
  }
  async saveConfig(next) {
    const result = await api("/api/model-config", next);
    this.state.config = result;
    this.state.probes = {};
    await this.refreshStatus();
    this.render();
    this.toast("配置已保存，将用于下一次请求");
  }
  toast(message, error = false) {
    clearTimeout(this.toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    this.toastTimer = setTimeout(
      () => ($("toast").hidden = true),
      error ? 9000 : 4000,
    );
  }
  dialog(title, body, submit, label = "保存", danger = false) {
    if ($("dialog").open) this.closeDialog();
    this.dialogBusy = false;
    $("dialog-content").innerHTML =
      `<form id="dialog-form"><div class="dialog-head"><h2 id="dialog-title">${e(title)}</h2><button type="button" class="icon-btn" id="dialog-close" aria-label="关闭对话框">${icon("close")}</button></div><div class="dialog-body">${body}<div id="dialog-error" class="form-error" role="alert"></div></div><div class="dialog-foot"><button type="button" class="btn" id="dialog-cancel">${submit ? "取消" : "关闭"}</button>${submit ? `<button type="submit" class="btn ${danger ? "danger" : "primary"}">${label}</button>` : ""}</div></form>`;
    $("dialog-close").onclick = () => this.closeDialog();
    $("dialog-cancel").onclick = () => this.closeDialog();
    $("dialog-form").onsubmit = async (event) => {
      event.preventDefault();
      if (!submit || this.dialogBusy) return;
      const form = event.currentTarget;
      const button = form.querySelector("[type=submit]");
      const data = new FormData(form);
      this.dialogBusy = true;
      button.disabled = true;
      $("dialog-error").textContent = "";
      try {
        await submit(data);
        this.dialogBusy = false;
        this.closeDialog();
      } catch (error) {
        $("dialog-error").textContent = error.message;
        this.dialogBusy = false;
        button.disabled = false;
      }
    };
    $("dialog").showModal();
  }
  closeDialog() {
    if (this.dialogBusy) return;
    $("dialog").close();
    $("dialog-content").replaceChildren();
  }
  connect(kind, attempt = 0) {
    const generation = this.generation;
    const ws = new WebSocket(
      location.origin.replace(/^http/, "ws") + "/ws/" + kind,
    );
    if (kind === "chat") this.chatWS = ws;
    else this.logWS = ws;
    ws.onopen = () => {
      if (kind === "logs") this.state.logs = [];
      this.updateConnection();
      if (this.state.page === "chat") this.updateChatControls();
      if (this.state.page === "logs") this.render();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (kind === "logs") {
        this.state.logs.push(data.line);
        if (this.state.logs.length > 1000) this.state.logs.shift();
        if (this.state.page === "logs") this.renderLogs();
        return;
      }
      if (data.type === "context") {
        if (data.queued) {
          this.toast("当前会话正在处理其他请求，已排队等待");
          return;
        }
        this.replyPersonaName = data.personaName;
        this.state.status.persona = data.personaId;
        this.state.status.personaName = data.personaName;
        if (this.state.page === "chat") this.render();
        if (data.contextReset)
          this.toast("人格已更新，本轮使用新的人格上下文；旧记录保留");
        return;
      }
      if (data.type === "chunk") {
        if (!this.reply) {
          this.reply = {
            role: "assistant",
            text: "",
            personaName: this.replyPersonaName,
          };
          this.state.messages.push(this.reply);
        }
        this.reply.text += data.text;
      } else if (data.type === "done" || data.type === "error") {
        if (data.type === "error") {
          this.state.messages.push({ role: "error", text: data.error });
          this.toast(data.error, true);
        }
        this.state.chatBusy = false;
        this.reply = null;
        this.syncView();
        this.updateChatControls();
      }
      if (this.state.page === "chat") this.renderMessages();
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.updateConnection();
      if (kind === "chat" && this.state.chatBusy) {
        this.state.messages.push({
          role: "error",
          text: "连接已断开，本次回复可能尚未完成。重新连接后可刷新页面查看保存记录。",
        });
        this.state.chatBusy = false;
        this.reply = null;
        if (this.state.page === "chat") this.renderMessages();
      }
      this.updateChatControls();
      if (this.authenticated)
        setTimeout(
          async () => {
            if (generation !== this.generation) return;
            try {
              await api("/api/status");
              this.connect(kind, Math.min(attempt + 1, 4));
            } catch (error) {
              if (error.status === 401) this.requireLogin();
              else this.connect(kind, Math.min(attempt + 1, 4));
            }
          },
          Math.min(1000 * 2 ** attempt, 10000),
        );
    };
  }
  requireLogin() {
    if (!this.authenticated) return;
    const wasUpdating = resetHostUpdateSession(this);
    this.reloadAfterHostUpdate = wasUpdating;
    this.authenticated = false;
    this.closePinMenu();
    this.hideStore();
    this.generation++;
    this.chatWS?.close();
    this.logWS?.close();
    $("shell").hidden = true;
    $("login").hidden = false;
    $("login-error").textContent = wasUpdating
      ? "请重新进入控制台，在概览中查看本次更新结果。"
      : "服务已重启或登录已过期，请重新进入。";
  }
  updateConnection() {
    const online = this.chatConnected && this.logConnected;
    $("connection-state").innerHTML =
      `<i class="status-dot" style="${online ? "" : "background:#c5ac72"}"></i> ${online ? "核心已连接" : "正在连接"}`;
  }
  updateChatControls() {
    const activePersona = $("active-persona");
    if (activePersona)
      activePersona.disabled =
        this.state.chatBusy || !this.state.config.personas.length;
    const button = $("send");
    if (button) {
      const persona = this.state.config.personas.find(
        (p) => p.id === this.state.status.persona,
      );
      const selected = this.state.config.models.find(
        (m) =>
          m.id === (persona?.model || this.state.config.bindings.chat) &&
          m.enabled,
      );
      button.disabled = this.state.chatBusy || this.sessionChanging || !this.state.session || !this.chatConnected || !selected;
      button.innerHTML =
        (this.state.chatBusy ? "正在回复…" : "发送") + " " + icon("send");
    }
    if ($("new-session")) $("new-session").disabled = this.state.chatBusy || this.sessionChanging;
  }
  sendMessage() {
    const text = ($("chat-input")?.value || "").trim();
    if (
      !text ||
      !this.chatConnected ||
      this.state.chatBusy ||
      $("send").disabled
    )
      return;
    this.state.messages.push({ role: "user", text });
    this.state.chatBusy = true;
    this.state.chatDraft = "";
    this.reply = null;
    $("chat-input").value = "";
    this.replyPersonaName = this.state.status.personaName;
    this.chatWS.send(
      JSON.stringify({
        session: this.state.session,
        expectedSession: this.state.session,
        text,
        persona: this.state.status.persona,
      }),
    );
    this.updateChatControls();
    this.renderMessages();
  }
  async newSession() {
    if (this.state.chatBusy || this.sessionChanging) return;
    this.sessionChanging = true;
    this.updateChatControls();
    try {
      await this.syncSession({ create: true });
      this.state.chatDraft = "";
      this.render();
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      this.sessionChanging = false;
      this.updateChatControls();
    }
  }
  renderMessages(options) {
    const opts = options || {};
    const personaName = this.state.status.personaName || "助手";
    const box = $("messages");
    if (!box) return;
    // 重画会整块换掉 innerHTML，滚动位置跟着归零。这里先记住：贴底才跟到底，
    // 否则原地不动——否则定时刷新一次就把正在读的旧消息甩到最新。
    const prevTop = box.scrollTop;
    const prevNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const pinBottom = this.takeScrollPin();
    if (!this.state.messages.length) {
      box.innerHTML = `<div class="chat-empty"><span class="brand-mark">${whale}</span><h3>今天想和${e(personaName)}聊点什么？</h3><p>从一句问候开始，或试试「记下这个」。</p></div>`;
      this.ensureChatScroll();
      return;
    }
    box.innerHTML = this.state.messages
      .map(
        (m) =>
          `<div class="message ${m.role === "user" ? "user" : m.role === "error" ? "error" : ""}"><span class="mini-avatar" title="${e(m.personaName || "助手")}">${m.role === "user" ? "你" : m.role === "error" ? "!" : e((m.personaName || "助手").slice(0, 1))}</span><div class="bubble">${e(m.text)}${m.protocolOriginal ? `<details><summary>查看模型原文</summary><div>${e(m.protocolOriginal)}</div></details>` : ""}</div></div>`,
      )
      .join("");
    const stick = opts.anchor === "keep" ? false : pinBottom || prevNearBottom;
    this.setScrollTop(box, stick ? box.scrollHeight : prevTop);
    this.ensureChatScroll();
  }
  takeScrollPin() {
    const pin = this.pendingScrollBottom === true;
    this.pendingScrollBottom = false;
    return pin;
  }
  /** 设定滚动位置；恢复原位置时不播动画。 */
  setScrollTop(box, value, behavior) {
    const max = Math.max(0, (box.scrollHeight || 0) - (box.clientHeight || 0));
    const top = Math.max(0, Math.min(Number(value) || 0, max));
    if (behavior === "smooth" && typeof box.scrollTo === "function") {
      box.scrollTo({ top, behavior: "smooth" });
      return;
    }
    // 恢复原位置时不能带平滑动画，否则会看着它慢慢滑回去。
    const style = box.style;
    const previous = style && style.scrollBehavior;
    if (style) style.scrollBehavior = "auto";
    box.scrollTop = top;
    if (style) style.scrollBehavior = previous;
  }
  /** 刻度轨与滚动监听只绑一次；页面重绘后元素换了也能重新绑上。 */
  ensureChatScroll() {
    const box = $("messages");
    const rail = $("chat-ruler");
    if (!box) return;
    if (rail && rail.dataset && rail.dataset.bound !== "1") {
      rail.dataset.bound = "1";
      rail.addEventListener("click", (event) => {
        const tick = event.target.closest("[data-tick]");
        const target = $("messages");
        if (!tick || !target || !this.rulerStep) return;
        const index = Number(tick.dataset.tick) || 0;
        this.setScrollTop(target, index * this.rulerStep, "smooth");
      });
    }
    if (box.dataset && box.dataset.scrollBound !== "1") {
      box.dataset.scrollBound = "1";
      // 只有真的动手滚过，才允许触顶自动翻页；否则初次加载就会一直往前翻。
      const wake = () => {
        this.chatScrolled = true;
      };
      box.addEventListener("wheel", wake, { passive: true });
      box.addEventListener("touchmove", wake, { passive: true });
      box.addEventListener("keydown", wake);
      box.addEventListener(
        "scroll",
        () => {
          this.updateRuler();
          if (box.scrollTop <= 2 && this.chatScrolled && typeof this.loadOlder === 'function')
            this.loadOlder();
        },
        { passive: true },
      );
    }
    this.updateRuler();
  }
  updateRuler() {
    const rail = $("chat-ruler");
    const box = $("messages");
    if (!rail || !box) return;
    // 轨和消息区必须是两个元素；万一同一个，宁可把轨关掉，也不能擦掉正文。
    if (rail === box) {
      rail.hidden = true;
      this.rulerStep = 0;
      this.rulerCount = 0;
      return;
    }
    const viewport = box.clientHeight || 0;
    if (!rail.dataset || !viewport) {
      rail.hidden = true;
      rail.innerHTML = "";
      this.rulerStep = 0;
      this.rulerCount = 0;
      return;
    }
    const step = Math.max(Math.round(box.clientHeight * 0.9), 140);
    const scrollable = box.scrollHeight - box.clientHeight;
    const count =
      scrollable < step * 0.6
        ? 0
        : Math.min(Math.ceil((scrollable + box.clientHeight) / step), 60);
    if (!count) {
      rail.hidden = true;
      rail.innerHTML = "";
      this.rulerStep = 0;
      this.rulerCount = 0;
      return;
    }
    if (this.rulerStep !== step || this.rulerCount !== count) {
      this.rulerStep = step;
      this.rulerCount = count;
      const height = Math.max(box.clientHeight - 12, count * 6);
      const parts = [];
      for (let index = 0; index < count; index += 1) {
        const ratio = count === 1 ? 0 : index / (count - 1);
        parts.push(
          `<button type="button" class="tick" data-tick="${index}" style="top:${(ratio * (height - 6)).toFixed(1)}px" aria-label="第 ${index + 1} 屏，共 ${count} 屏"></button>`,
        );
      }
      rail.innerHTML = parts.join("");
    }
    rail.hidden = false;
    const active = Math.max(
      0,
      Math.min(count - 1, Math.round(box.scrollTop / step)),
    );
    rail
      .querySelectorAll(".tick")
      .forEach((tick, index) => tick.classList.toggle("active", index === active));
  }
  /** 滚到顶部时往前翻一页，翻完把阅读位置原样托住。 */
  async loadOlder() {
    const box = $("messages");
    const paging = this.state.paging;
    if (!box || !paging || !paging.hasMore || this.loadingOlder) return;
    const id = this.state.session;
    this.loadingOlder = true;
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    try {
      const page = await api(
        `/api/session?id=${encodeURIComponent(id)}&before=${paging.start}` +
          `&limit=${SESSION_PAGE}`,
      );
      if (id !== this.state.session) return;
      this.state.paging = {
        total: page.total,
        start: page.start,
        end: page.end,
        hasMore: page.hasMore,
      };
      const rows = messageRows(page.items);
      if (!rows.length) return;
      this.state.messages = rows.concat(this.state.messages);
      this.renderMessages({ anchor: "keep" });
      this.setScrollTop(box, box.scrollHeight - prevHeight + prevTop);
    } catch (error) {
      if (error.status !== 401) this.toast(error.message, true);
    } finally {
      this.loadingOlder = false;
    }
  }
  filteredLogs() {
    return this.state.logs.filter(
      (line) =>
        (!this.state.logLevel ||
          this.state.logLevel === "all" ||
          line.includes("[" + this.state.logLevel + "]")) &&
        line.toLowerCase().includes((this.state.logSearch || "").toLowerCase()),
    );
  }
  renderLogs() {
    const box = $("log-output");
    if (!box) return;
    const lines = this.filteredLogs();
    box.innerHTML = lines
      .map(
        (line) =>
          `<div class="log-line ${line.includes("[ERROR]") ? "error" : line.includes("[WARN]") ? "warn" : "info"}">${e(line)}</div>`,
      )
      .join("");
    if (this.state.logFollow) box.scrollTop = box.scrollHeight;
    $("log-meta").textContent =
      `显示 ${lines.length} / ${this.state.logs.length} 条 · ${this.logConnected ? "实时推送中" : "正在重新连接"}`;
  }
}
const SESSION_PAGE = 40;

/** 会话行 → 气泡数组；首屏与续页共用一份映射。 */
function messageRows(rows) {
  return rows
    .filter((row) => row.type === "message")
    .map((row) => ({
      role: row.role,
      text: row.text,
      protocolOriginal: row.tool_protocol_original,
      personaName: row.persona_name,
    }));
}

const app = new ConsoleApp();
app.start();
