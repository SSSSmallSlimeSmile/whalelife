/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, availableModels } from "./api.js";
import { icon, whale } from "./icons.js";
import { renderRich, detailsState, applyDetailsState, hasVisibleText, avatarLabel } from "./rich.js";
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
    // toggle 不冒泡，只能用捕获阶段；用户亲手收起时也要记下来
    document.addEventListener("toggle", (event) => this.rememberDetails(event), true);
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
  async syncSession(input, options = {}) {
    if (this.state.chatBusy || (!input && this.sessionChanging)) return;
    const sequence = ++this.sessionSync;
    // adopt：别的窗口已经切了会话，这里只跟着显示，不再回写服务端，
    // 否则两个窗口每次聚焦都把对方拽回来。
    const { id } = options.adopt && input && input.id
      ? { id: input.id }
      : await api("/api/session/current", input ??
      (this.sessionReady ? undefined : { legacyId: localStorage.whaleSession }));
    // 刷新时按上次读到的条数取回同样多，不然只会拿回最后一页、位置全丢
    if (id === this.state.session) this.saveChatView();
    const savedView = this.savedView(id);
    const want = Math.min(
      Math.max(savedView ? Number(savedView.count) || 0 : 0, SESSION_PAGE),
      500,
    );
    const pageUrl = `/api/session?id=${encodeURIComponent(id)}&limit=${want}`;
    const [page, choices] = await Promise.all([
      api(pageUrl),
      api("/api/session/list"),
    ]);
    // Keep the oldest loaded message when a new arrival shifts the latest page.
    while (id === this.state.session && savedView && page.hasMore && page.start > savedView.start) {
      if (sequence !== this.sessionSync || this.state.chatBusy) return;
      const older = await api(pageUrl + "&before=" + page.start);
      if (!older.items.length || older.start >= page.start) break;
      const from = older.positions.findIndex(position => position >= savedView.start);
      if (from < 0) break;
      page.items = older.items.slice(from).concat(page.items);
      page.positions = older.positions.slice(from).concat(page.positions);
      page.start = older.positions[from];
      page.hasMore = from > 0 || older.hasMore;
    }
    if (sequence !== this.sessionSync || this.state.chatBusy) return;
    this.sessionReady = true;
    if (this.state.session !== id) {
      this.state.sessionContext = null;
      // 换个会话，上一份「查看模型原文」的展开状态就不作数了
      this.detailsOpen = new Set();
      // 换会话才回到最新一条；同一会话刷新不动位置。
      this.pendingScrollBottom = true;
      this.chatScrolled = false;
      if (this.viewTimer) clearTimeout(this.viewTimer);
    } else if (savedView?.atBottom) this.pendingScrollBottom = true;
    this.state.session = id;
    this.state.sessions = choices.items;
    this.state.sessionName = choices.items.find(item => item.id === id)?.name || id;
    if (this.state.memorySession && !choices.items.some(item => item.id === this.state.memorySession)) {
      this.state.memorySession = null;
      this.state.memoryContext = null;
      this.state.memoryLoadedTab = null;
    }
    localStorage.whaleSession = id;
    this.state.messages = messageRows(page.items, page.positions);
    this.state.paging = {
      total: page.total,
      start: page.start,
      end: page.end,
      hasMore: page.hasMore,
    };
    // 同一会话刷新：等这一版画出来再照锚点把位置摆回去
    this.pendingRestore =
      savedView && !this.pendingScrollBottom && savedView.index < this.state.messages.length
        ? savedView
        : null;
  }
  // ---- 阅读位置：刷新后要能回到原处 ----
  chatViewKey(id) {
    return "whalelife.chatView." + (id || "");
  }
  /** 记下屏幕最上面那条消息和它被滚掉了多少。 */
  saveChatView() {
    const box = $("messages");
    const id = this.state.session;
    if (!box || !id || !this.state.messages.length) return;
    if (typeof box.querySelectorAll !== "function") return;
    let index = 0;
    let mid = "";
    let offset = 0;
    const nodes = box.querySelectorAll(".message[data-index]");
    if (!nodes.length) return;
    const viewportTop = box.getBoundingClientRect().top;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > viewportTop) {
        index = Number(node.dataset.index) || 0;
        // 序号会漂：末尾新增一条，序号对得上的其实是另一条消息。
        // id 是那条消息自己的，翻页、追加都不会变。
        mid = node.dataset.mid || "";
        offset = viewportTop - rect.top;
        break;
      }
    }
    try {
      localStorage.setItem(
        this.chatViewKey(id),
        JSON.stringify({
          count: this.state.messages.length,
          index,
          mid,
          offset,
          atBottom: box.scrollHeight - box.scrollTop - box.clientHeight < 80,
          start: this.state.paging ? this.state.paging.start : 0,
        }),
      );
    } catch {
      // 存不下就算了，不要因为记住位置这点事打断聊天
    }
  }
  savedView(id) {
    try {
      const raw = JSON.parse(localStorage.getItem(this.chatViewKey(id)) || "null");
      if (!raw || !Number.isFinite(raw.index) || !Number.isFinite(raw.count)) return null;
      return raw;
    } catch {
      return null;
    }
  }
  restoreChatView(box) {
    const saved = this.pendingRestore;
    this.pendingRestore = null;
    if (!saved || !box || typeof box.querySelector !== "function") return;
    // 先按消息 id 找：这才是「当时屏幕最上面那条」，序号只是兜底。
    let node = saved.mid && Array.from(box.querySelectorAll(".message[data-index]"))
      .find(item => item.dataset.mid === saved.mid);
    if (!node) node = box.querySelector(`.message[data-index="${saved.index}"]`);
    if (!node) return;
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
    this.setScrollTop(box, box.scrollTop + top + (Number(saved.offset) || 0));
    this.syncRail();
  }
/** 左侧段落目录：满 20 条或隔 30 分钟切一段，点一下跳到那段。 */
  /** 左侧导航轨：一条用户请求一节。轨道上只画刻度，摘要放进悬浮卡（勘 2026-11-16）。 */
  renderOutline() {
    const rail = $("chat-rail");
    if (!rail) return;
    this.railTurns = [];
    let turn = null;
    (this.state.messages || []).forEach((m, index) => {
      if (m.role === "user") {
        turn = { from: index, ask: plainText(m.text), answers: [] };
        this.railTurns.push(turn);
        return;
      }
      if (turn && m.text) turn.answers.push(plainText(m.text));
    });
    if (this.railTurns.length < 3) {
      rail.hidden = true;
      rail.innerHTML = "";
      this.hideRailCard();
      return;
    }
    rail.hidden = false;
    rail.innerHTML =
      this.railTurns
        .map(
          (t, i) =>
            '<button type="button" class="chat-rail-tick" data-turn="' + i +
            '" aria-label="' + e(clip(t.ask, 40)) + '"><i></i></button>',
        )
        .join("");
    rail.querySelectorAll("[data-turn]").forEach((tick) => {
      tick.onmouseenter = () => this.showRailCard(tick);
      tick.onmouseleave = () => this.hideRailCard();
      tick.onfocus = () => this.showRailCard(tick);
      tick.onblur = () => this.hideRailCard();
      tick.onclick = () => this.jumpToTurn(Number(tick.dataset.turn));
    });
    this.watchRail();
  }
  railCard() {
    let card = document.getElementById("chat-rail-card");
    if (!card) {
      card = document.createElement("div");
      card.id = "chat-rail-card";
      card.className = "chat-rail-card";
      card.hidden = true;
      document.body.appendChild(card);
    }
    return card;
  }
  /** 悬浮卡贴在刻度右边，纵向不许出窗口。 */
  showRailCard(tick) {
    const turn = (this.railTurns || [])[Number(tick.dataset.turn)];
    if (!turn) return;
    const card = this.railCard();
    const answer = turn.answers.join(" ");
    card.innerHTML =
      "<b>" + e(clip(turn.ask, 120)) + "</b>" +
      "<span>" + e(clip(answer || "（这一节没有回答）", 260)) + "</span>" +
      '<span class="chat-rail-card-meta">' + (1 + turn.answers.length) + " 条</span>";
    card.hidden = false;
    const rect = tick.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const left = Math.min(rect.right + 12, window.innerWidth - box.width - 12);
    const top = Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.height - 12));
    card.style.left = Math.max(12, left) + "px";
    card.style.top = top + "px";
  }
  hideRailCard() {
    const card = document.getElementById("chat-rail-card");
    if (card) card.hidden = true;
  }
  jumpToTurn(index) {
    const turn = (this.railTurns || [])[index];
    if (!turn) return;
    const nodes = $("messages")?.querySelectorAll(".message") || [];
    const target = $("messages")?.querySelector('.message[data-index="' + turn.from + '"]');
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  /** 滚动或窗口尺寸一变就重排：刻度按消息的真实位置摆，紫色只留一个（勘 2026-11-16）。
      旧版一边画按比例插值的游标、一边画按消息判定的高亮，两者位置不一致，
      看着就是"对不上"；窗口一改尺寸还会同时看到两条紫线。现在只保留刻度本身。 */
  watchRail() {
    const rail = $("chat-rail");
    const box = $("messages");
    if (!rail || !box) return;
    // 每次 render() 都会用整页 markup 重建 #messages，拿到的是新节点；
    // 旧监听还挂在被摘下来的那个节点上，此后滚动手势再也送不到轨道，
    // 高亮就永远停在最后一次算出来的位置（勘 2026-11-16 修）。
    if (this.railBox !== box) {
      if (this.railBox && this.railScrollHandler)
        this.railBox.removeEventListener("scroll", this.railScrollHandler);
      this.railScrollHandler = () => this.syncRail();
      box.addEventListener("scroll", this.railScrollHandler, { passive: true });
      this.railBox = box;
    }
    if (!this.railWatched) {
      this.railWatched = true;
      window.addEventListener("resize", () => this.syncRail(), { passive: true });
      // 切窗口回来时，尺寸没变、滚动没变，一个事件都不会来。
      // 上一轮若是趁容器被隐藏时算过一遍，高亮就钉死了，得给个重新对账的机会（勘 2026-11-16 修）。
      window.addEventListener("focus", () => this.syncRail());
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.syncRail();
      });
    }
    // ResizeObserver 每次都要盯住"当前的"内容节点。
    // 旧写法只在第一次 observe：一旦 #messages 的内层被整体换掉，
    // 观察者盯的就是已经摘下来的节点，此后永不触发（勘 2026-11-16 修）。
    if (typeof ResizeObserver === "function") {
      const target = box.firstElementChild || box;
      if (this.railObserverTarget !== target) {
        if (!this.railObserver) this.railObserver = new ResizeObserver(() => this.syncRail());
        this.railObserver.disconnect();
        this.railObserver.observe(target);
        this.railObserverTarget = target;
      }
    }
    this.syncRail();
  }
  syncRail() {
    const rail = $("chat-rail");
    const box = $("messages");
    if (!rail || !box || rail.hidden) return;
    // 窗口最小化、切到后台、渲染中途容器被隐藏时，所有 rect 都是 0。
    // 那时"每条消息都顶在阈值上方"会把高亮钉死在最后一格，
    // 而尺寸恢复后往往又没有事件再来纠正——干脆不在这时候算（勘 2026-11-16 修）。
    if (document.hidden || box.clientHeight < 1 || rail.clientHeight < 1) return;
    const ticks = [...rail.querySelectorAll(".chat-rail-tick")];
    if (!ticks.length) return;
    const nodes = [...box.querySelectorAll(".message")];
    const boxRect = box.getBoundingClientRect();
    const pad = 12;
    const usable = Math.max(1, rail.clientHeight - pad * 2);
    // 刻度等距排开，看着整齐；位置只表示"第几节"，不再对应真实滚动偏移（勘 2026-11-16）
    const count = ticks.length;
    const stepRaw = count > 1 ? usable / (count - 1) : 0;
    const step = Math.max(6, stepRaw);
    const total = step * Math.max(0, count - 1);
    const start = pad + (step > stepRaw ? Math.max(0, (usable - total) / 2) : 0);
    ticks.forEach((tick, i) => {
      tick.style.top = Math.round((start + i * step) * 10) / 10 + "px";
    });
    // 当前那一节：直接拿消息相对视口的位置比，不再掺 scrollTop。
    // 旧写法假设滚动一定发生在这个容器上；实际一旦滚动落在祖先元素，
    // scrollTop 恒为 0、每条消息的 rect 却已经在动，于是"全都不超过阈值"，
    // 高亮永远停在最后一格（勘 2026-11-16 修）。
    const liveBox = box.getBoundingClientRect();
    const head = liveBox.top + Math.min(120, box.clientHeight * 0.3);
    let active = -1;
    (this.railTurns || []).forEach((turn, i) => {
      const node = box.querySelector('.message[data-index="' + turn.from + '"]');
      if (!node || !node.isConnected) return;
      const rect = node.getBoundingClientRect();
      if (!rect.height && !rect.width) return; // 还没量出来的节点不算
      if (rect.top <= head) active = i;
    });
    if (active < 0) return; // 一个都量不准，就别动上一轮的结果
    ticks.forEach((tick, i) => tick.classList.toggle("active", i === active));
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
        if (page === "chat") {
          await this.refreshSessionContext();
          await this.reconcileSession();
        }
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
  /**
   * 切回窗口时和服务端对一下当前会话：别的窗口换过了就跟着换，
   * 否则这一窗还在往旧会话里发，服务端只会一直拒。
   */
  async reconcileSession() {
    if (!this.state.session || this.state.chatBusy || this.sessionChanging) return;
    let current = null;
    try {
      const value = await api("/api/session/current");
      current = value && value.id;
    } catch {
      return;
    }
    if (!current || current === this.state.session) return;
    await this.syncSession({ id: current }, { adopt: true });
    if (this.state.page === "chat") this.render();
    this.toast("其他窗口已切换会话，这里已跟着换过来");
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
      if (data.type === "append") {
        const entered = data.status === "accepted" || data.status === "duplicate";
        if (data.status === "accepted") this.toast("已并入本轮");
        else if (data.status === "duplicate") this.toast("这句已经并进去了");
        else if (data.status === "full") this.toast("本轮补充已满，这句没进去", true);
        else if (data.reason === "queued") this.toast("这一轮还在排队，开始回复后可以再补充", true);
        else if (data.status === "closed") this.toast("本轮未接收这条补充，可以重发", true);
        else this.toast(data.error || "补充没送进去", true);
        // 没进去的补充不能留成一条看着已发出的虚线气泡，原文放回输入框。
        // 按 messageId 找，而不是只看「最后一条待定」——done 可能比这条回执先到。
        const pending =
          this.pendingNudge && (!data.messageId || this.pendingNudge.messageId === data.messageId)
            ? this.pendingNudge
            : null;
        if (pending) this.pendingNudge = null;
        if (!entered) {
          const nudgeId = data.messageId ? "n_" + data.messageId : pending?.nudgeId;
          const bubble = nudgeId && this.state.messages.find(message => message.nudgeId === nudgeId);
          const original = bubble?.text || pending?.text || (typeof data.text === "string" ? data.text : "");
          if (nudgeId) this.state.messages = this.state.messages.filter((m) => m.nudgeId !== nudgeId);
          // 原文不能丢：输入框空着就放回去；已经有草稿就排进「未送达」，让用户决定重发还是丢弃
          if (original) {
            const box = $("chat-input");
            if (box && !(box.value || "").trim()) {
              box.value = original;
              this.state.chatDraft = original;
            } else {
              (this.unsentNudges ||= []).push({ text: original, messageId: data.messageId || "" });
            }
          }
          if (this.state.page === "chat") this.renderMessages();
        }
        return;
      }
      if (data.type === "started") {
        // 记住这一轮的 id：两个窗口跑同一会话时，补充要落到自己那一轮上
        this.turn = typeof data.turn === "string" ? data.turn : null;
        return;
      }
      if (data.type === "reset") {
        // 服务端把这段回复丢掉了（不会进存档），界面上的也得撤，否则刷新前后不一致
        if (this.reply) {
          this.reply.text = "";
          if (this.state.page === "chat") this.renderMessages();
        }
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
        const created = !this.reply;
        if (created) {
          this.reply = {
            role: "assistant",
            text: "",
            personaName: this.replyPersonaName,
          };
          this.state.messages.push(this.reply);
        }
        this.reply.text += data.text;
        if (this.state.page === "chat") {
          if (created) this.renderMessages();
          else this.updateStreamingReply();
        }
        return;
      }
      if (data.type === "done" || data.type === "error") {
        this.turn = null;
        this.pendingNudge = null;
        if (data.type === "done") this.pendingSend = null;
        if (data.type === "error") {
          // 这条没发出去：撤掉乐观上屏的气泡，把原文放回输入框，省得重打一遍
          const pending = this.pendingSend;
          this.pendingSend = null;
          if (pending && this.state.messages[pending.index]?.role === "user")
            this.state.messages.splice(pending.index, 1);
          if (pending && !($("chat-input")?.value || "").trim()) {
            $("chat-input").value = pending.text;
            this.state.chatDraft = pending.text;
          }
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
      // 本轮还在跑时按钮不禁用，改成「补充」：这句话并进当前回合，不另起一轮。
      button.disabled = this.sessionChanging || !this.state.session || !this.chatConnected || !selected;
      button.innerHTML =
        (this.state.chatBusy ? "补充" : "发送") + " " + icon("send");
    }
    if ($("new-session")) $("new-session").disabled = this.state.chatBusy || this.sessionChanging;
  }
  sendMessage() {
    const text = ($("chat-input")?.value || "").trim();
    if (!text || !this.chatConnected || $("send").disabled) return;
    // 本轮还在跑：不排队、不新起一轮，直接并进当前回合让它中途改方向。
    if (this.state.chatBusy) {
      // 稳定 ID：同一句重送不会写出两条历史，服务端按它去重。
      const messageId = "nudge_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      this.chatWS.send(
        JSON.stringify({ append: true, session: this.state.session, turn: this.turn, text, messageId }),
      );
      const nudgeId = "n_" + messageId;
      this.state.messages.push({ role: "user", text, nudge: true, nudgeId });
      this.pendingNudge = { text, nudgeId, messageId };
      this.state.chatDraft = "";
      $("chat-input").value = "";
      this.renderMessages();
      return;
    }
    this.state.messages.push({ role: "user", text });
    // 记下这一条，服务端没接住时好把原文放回输入框
    this.pendingSend = { text, index: this.state.messages.length - 1 };
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
  /** 「查看模型原文」的展开状态：按「会话:消息身份:第几个 details」记，跨整页重画保留。 */
  rememberDetails(event) {
    const details = event && event.target;
    if (!details || details.tagName !== "DETAILS") return;
    const node = details.closest ? details.closest(".message[data-index]") : null;
    if (!node) return;
    const data = node.dataset || {};
    const identity = data.detailKey !== undefined ? data.detailKey : data.index === undefined ? undefined : "i" + data.index;
    if (identity === undefined) return;
    const list = Array.from(node.querySelectorAll("details"));
    const offset = list.indexOf(details);
    if (offset < 0) return;
    if (!this.detailsOpen) this.detailsOpen = new Set();
    const key = identity + ":" + offset;
    if (details.open) this.detailsOpen.add(key);
    else this.detailsOpen.delete(key);
  }
  /** 回复里已经有可见文字，才让它占一个气泡。 */
  replyVisible() {
    return hasVisibleText(this.reply && this.reply.text);
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
    // 会话前缀进键里：两个会话的第 1 条不会撞同一个键
    const keyOf = (m, index) => (this.state.session || "-") + ":" + (m.id || "i" + index);
    if (!this.state.messages.length) {
      box.innerHTML = `<div class="chat-empty"><span class="brand-mark">${whale}</span><h3>今天想和${e(personaName)}聊点什么？</h3><p>从一句问候开始，或试试「记下这个」。</p></div>`;
      this.ensureChatScroll();
      this.renderOutline();
      return;
    }
    // 整页重画会换掉 #messages，状态必须存在实例上，不能只读当前这个盒子
    if (!this.detailsOpen) this.detailsOpen = detailsState(box);
    const open = this.detailsOpen;
    const parts = [];
    this.state.messages.forEach((m, index) => {
      if (m === this.reply && !this.replyVisible()) return;
      parts.push(
        `<div class="message ${m.role === "user" ? "user" : m.role === "error" ? "error" : ""}${m.nudge ? " nudge" : ""}" data-index="${index}" data-mid="${e(String(m.id || index))}" data-detail-key="${e(keyOf(m, index))}"${m === this.reply ? ' data-streaming="1"' : ""}><span class="mini-avatar" title="${e(m.personaName || "助手")}">${m.role === "user" ? "我" : m.role === "error" ? "!" : e(avatarLabel(m.personaName))}</span><div class="bubble">${renderRich(m.text)}${m.protocolOriginal ? `<details><summary>查看模型原文</summary><div>${e(m.protocolOriginal)}</div></details>` : ""}${m.protocolNote ? '<div class="protocol-note">上面是模型把工具调用写进正文，已替换为说明，没有执行任何工具。</div>' : ""}</div></div>`,
      );
    });
    box.innerHTML = parts.join("");
    applyDetailsState(box, open);
    if (this.state.chatBusy && !this.replyVisible())
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="message" data-thinking="1"><span class="mini-avatar" title="${e(personaName)}">${e(avatarLabel(personaName))}</span><div class="bubble thinking"><i></i><i></i><i></i><span>思考中 <em class="think-face">${pickThinkingFace()}</em></span></div></div>`,
      );
    const stick = opts.anchor === "keep" ? false : pinBottom || prevNearBottom;
    this.setScrollTop(box, stick ? box.scrollHeight : prevTop);
    this.ensureChatScroll();
    this.renderOutline();
    if (this.pendingRestore) this.restoreChatView(box);
    this.renderUnsentNudges();
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
  /** 消息区的滚动、翻页、位置保存只绑一次。刻度轨由 renderOutline 负责。 */
  ensureChatScroll() {
    const box = $("messages");
    if (!box) return;
    if (box.dataset && box.dataset.scrollBound !== "1") {
      box.dataset.scrollBound = "1";
      // 只有真的动手滚过，才允许触顶自动翻页；否则初次加载就会一直往前翻。
      const wake = () => {
        if (box === $("messages")) this.chatScrolled = true;
      };
      box.addEventListener("wheel", wake, { passive: true });
      box.addEventListener("touchmove", wake, { passive: true });
      box.addEventListener("keydown", wake);
      box.addEventListener(
        "scroll",
        () => {
          if (box !== $("messages")) return;
          this.syncRail();
          // 位置攒一下再写，滚动一次不要连着写几十遍 localStorage
          if (this.viewTimer) clearTimeout(this.viewTimer);
          this.viewTimer = setTimeout(() => this.saveChatView(), 400);
          if (box.scrollTop <= 2 && this.chatScrolled && typeof this.loadOlder === 'function')
            this.loadOlder();
        },
        { passive: true },
      );
    }
    this.syncRail();
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
      if (paging !== this.state.paging || box !== $("messages") || id !== this.state.session) return;
      this.state.paging = {
        total: page.total,
        start: page.start,
        end: page.end,
        hasMore: page.hasMore,
      };
      const rows = messageRows(page.items, page.positions);
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
  /** 流式分片只重画当前那条回复，旧消息和它们的展开状态都不动。 */
  updateStreamingReply() {
    const box = $("messages");
    if (!box || !this.replyVisible()) return;
    const bubble = box.querySelector('.message[data-streaming="1"] .bubble');
    if (!bubble) {
      this.renderMessages();
      return;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    bubble.innerHTML = renderRich(this.reply.text);
    box.querySelector('.message[data-thinking="1"]')?.remove();
    if (nearBottom) box.scrollTop = box.scrollHeight;
    this.syncRail();
  }
  /** 被拒且没处放的补充排在这里：能重发，也能显式丢掉。不碰输入框里正在写的草稿。 */
  renderUnsentNudges() {
    const bar = $("nudge-unsent");
    // 页面没渲染这一块，或者和消息容器是同一个节点（桩环境里常见），就别碰它，
    // 否则清空自己就等于把正文一起擦了。
    if (!bar || bar === $("messages")) return;
    const list = this.unsentNudges || [];
    if (!list.length) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML =
      `<span class="nudge-unsent-label">没送进去 ${list.length} 条</span>` +
      list
        .map(
          (item, index) =>
            `<span class="nudge-unsent-item" title="${e(item.text)}">${e(item.text.length > 24 ? item.text.slice(0, 24) + "…" : item.text)}` +
            `<button type="button" class="btn small" data-nudge-resend="${index}">重发</button>` +
            `<button type="button" class="btn small" data-nudge-drop="${index}">丢弃</button></span>`,
        )
        .join("");
    if (bar.dataset.bound) return;
    bar.dataset.bound = "1";
    bar.addEventListener("click", (event) => {
      const resend = event.target.closest("[data-nudge-resend]");
      const drop = event.target.closest("[data-nudge-drop]");
      if (!resend && !drop) return;
      const index = Number((resend || drop).dataset[resend ? "nudgeResend" : "nudgeDrop"]);
      const item = (this.unsentNudges || [])[index];
      if (!item) return;
      if (drop) {
        this.unsentNudges.splice(index, 1);
        this.renderUnsentNudges();
        return;
      }
      this.unsentNudges.splice(index, 1);
      const box = $("chat-input");
      if (!box) return;
      box.value = box.value.trim() ? item.text + "\n" + box.value : item.text;
      this.state.chatDraft = box.value;
      this.renderUnsentNudges();
      box.focus();
    });
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
const thinkingFaces = ["(｡•ᴗ•｡)","(´｡• ᵕ •｡`)","(๑•̀ㅂ•́)و","(￣▽￣)","(＝ω＝)","(っ˘ω˘ς)","(๑´ω`๑)","(・ω・)","(๑•́ ₃ •̀๑)","( ˘ω˘ )","(´▽`)","(･ω･)ﾉ"];
const pickThinkingFace = () => thinkingFaces[Math.floor(Math.random() * thinkingFaces.length)];

const SESSION_PAGE = 40;

/** 会话行 → 气泡数组；首屏与续页共用一份映射。 */
function messageRows(rows, positions) {
  return rows
    .filter((row) => row.type === "message")
    .map((row, index) => ({
      id: row.id || (positions ? "historical-line:" + positions[index] : undefined),
      role: row.role,
      text: row.text,
      protocolOriginal: row.tool_protocol_original,
      personaName: row.persona_name,
    }));
}

const app = new ConsoleApp();
app.start();
