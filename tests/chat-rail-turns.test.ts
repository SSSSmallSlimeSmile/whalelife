// 导航轨分节与轮号的回归（作者在 PR #39 上挑的第 3、4 条）。
// 1) 中途补充（nudge）是同一轮的补充，不能单独成节，也不能让原问题那节变成「没有回答」
// 2) 轮号必须是全会话轮号；前面还没拉全时不假装知道，且不会因为加载更多而悄悄换号
// 3) clip 这个依赖必须真的在文件里（作者报的 clip is not defined）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, "..", "core", "ui", "app.js"), "utf8");

function toScript(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const merged: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (line.trim().startsWith("import ") && !line.trim().endsWith(";")) {
      while (i + 1 < lines.length) {
        i += 1;
        line += " " + lines[i].trim();
        if (lines[i].trim().endsWith(";")) break;
      }
    }
    merged.push(line);
  }
  const out: string[] = [];
  for (const line of merged) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") && trimmed.endsWith(";")) {
      const open = trimmed.indexOf("{");
      const close = trimmed.indexOf("}");
      if (open < 0 || close < open) continue;
      const names = trimmed
        .slice(open + 1, close)
        .split(",")
        .map((name: string) => name.trim().replace(/\s+as\s+/, ": "))
        .filter(Boolean)
        .join(", ");
      out.push("const { " + names + " } = globalThis.__stubBag;");
      continue;
    }
    if (trimmed === "const app = new ConsoleApp();") {
      out.push("globalThis.__ConsoleApp = ConsoleApp;");
      continue;
    }
    if (trimmed === "app.start();") continue;
    out.push(line);
  }
  return out.join("\n");
}

const patched = toScript(raw);

class FakeNode {
  dataset: Record<string, string> = {};
  clientHeight = 0;
  scrollHeight = 0;
  scrollTop = 0;
  offsetWidth = 0;
  hidden = false;
  innerHTML = "";
  children: FakeNode[] = [];
  classes = new Set<string>();
  style: Record<string, string> = {};
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: () => undefined,
  };
  constructor(attrs: Partial<FakeNode> & { dataset?: Record<string, string> } = {}) {
    Object.assign(this, attrs);
  }
  addEventListener() {}
  removeEventListener() {}
  appendChild() {}
  getBoundingClientRect() {
    return { top: 0, bottom: 20, left: 0, right: 20, width: 200, height: 60 };
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
}

function makeApp(elements: Record<string, FakeNode>) {
  const sandbox: Record<string, any> = {
    document: {
      getElementById: (id: string) => elements[id] || new FakeNode(),
      createElement: () => new FakeNode(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      visibilityState: "visible",
      body: new FakeNode(),
    },
    localStorage: {
      store: new Map<string, string>(),
      getItem(key: string) {
        return this.store.has(key) ? this.store.get(key) : null;
      },
      setItem(key: string, value: unknown) {
        this.store.set(key, String(value));
      },
    },
    window: {
      addEventListener() {},
      innerWidth: 1400,
      innerHeight: 900,
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    console,
    URL,
    URLSearchParams,
    JSON,
    Number,
    location: { hash: "" },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.__stubBag = new Proxy(
    {
      // 转义要真做，不然断言里的文案全被吞掉
      escapeHTML: (value: unknown) =>
        String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch),
    },
    { get: (target: any, key: string) => (key in target ? target[key] : () => "") },
  );
  vm.runInContext(patched, sandbox, { filename: "app.js" });
  const App = sandbox.__ConsoleApp;
  assert.equal(typeof App, "function", "没拿到 ConsoleApp");
  const app = new App();
  // 暴露 vm 的全局，测试才能直接调真 messageRows，而不是绕过它手塞字段。
  (app as any).__api = sandbox;
  return app;
}

function rail(elements: Record<string, FakeNode>) {
  const app = makeApp({
    messages: new FakeNode(),
    "chat-rail": new FakeNode({ clientHeight: 500 }),
    "chat-rail-card": new FakeNode(),
    ...elements,
  });
  app.state.messages = [];
  return app;
}

test("中途补充不单独成节，原问题那节也不会变成没有回答", () => {
  const app = rail({});
  app.state.messages = [
    { role: "user", text: "帮我改一下那个函数" },
    { role: "user", text: "改完顺便跑个测试", nudge: true },
    { role: "assistant", text: "改好了，测试也过了" },
    { role: "user", text: "好" },
    { role: "assistant", text: "行" },
    { role: "user", text: "再问一句" },
    { role: "assistant", text: "嗯" },
  ];
  app.renderOutline();
  assert.equal(app.railTurns.length, 3, "三条用户发言应当只切成三节，补充不再独占一节");
  const first = app.railTurns[0];
  assert.equal(first.ask, "帮我改一下那个函数");
  assert.equal(first.nudges.length, 1, "补充只算一条");
  assert.equal(first.nudges[0], "改完顺便跑个测试", "补充要挂在同一轮上");
  assert.equal(first.answers.length, 1, "原问题那节要有回答");
  assert.equal(first.answers[0], "改好了，测试也过了");
  assert.equal(app.railTurns[2].ask, "再问一句", "后面的问题照旧各成一节");
});

test("clip 依赖真的在文件里，悬浮卡不会因此抛错", () => {
  const app = rail({});
  app.state.messages = [
    { role: "user", text: "问一" },
    { role: "assistant", text: "答一" },
    { role: "user", text: "问二" },
    { role: "assistant", text: "答二" },
    { role: "user", text: "问三" },
    { role: "assistant", text: "答三" },
  ];
  app.renderOutline();
  const tick = new FakeNode({ dataset: { turn: "0" } });
  assert.doesNotThrow(() => app.showRailCard(tick));
  const card = app.railCard();
  assert.match(String(card.innerHTML), /问一/, "悬浮卡里应当是问的那一句，不是空白");
});

test("前面还没拉全时，编号不假装是全会话轮号", () => {
  const app = rail({});
  app.railPrefix = undefined;
  app.state.messages = [
    { role: "user", text: "问一" },
    { role: "assistant", text: "答一" },
    { role: "user", text: "问二" },
    { role: "assistant", text: "答二" },
    { role: "user", text: "问三" },
    { role: "assistant", text: "答三" },
  ];
  app.renderOutline();
  const card = app.railCard();
  const prevTick = new FakeNode({ dataset: { page: "prev" } });
  app.showRailCard(prevTick);
  assert.match(String(card.innerHTML), /已加载第/, "前缀未知时要说「已加载第…」");
  assert.doesNotMatch(String(card.innerHTML), /共 3 轮 · 点一下换这一批/, "不能把已加载轮数说成总数");
});

test("拉到顶之后，轮号是全会话轮号，且加载更多不会把它改小", () => {
  const app = rail({});
  app.railPrefix = 5;
  app.state.messages = [
    { role: "user", text: "问一" },
    { role: "assistant", text: "答一" },
    { role: "user", text: "问二" },
    { role: "assistant", text: "答二" },
    { role: "user", text: "问三" },
    { role: "assistant", text: "答三" },
  ];
  app.renderOutline();
  const card = app.railCard();
  app.showRailCard(new FakeNode({ dataset: { turn: "0" } }));
  assert.match(String(card.innerHTML), /6 轮/, "前缀 5 + 第 1 格 = 第 6 轮");
  assert.doesNotMatch(String(card.innerHTML), /已加载第/, "前缀已知时不该再退成「已加载」");
});

test("刷新后读回来的补充带 external_message_id，照样并回上一轮", () => {
  const app = rail({});
  // 走真链：服务端行 → messageRows → 分节。以前这些测试直接往 state.messages 手塞字段，
  // 恰好绕过了 messageRows 那一层，所以「刷新后认不出」这个洞一直是绿的。（勘 2026-11-26）
  app.state.messages = app.__api.messageRows([
    { type: "message", role: "user", text: "帮我看看这个报错", id: "u1", origin: { channel: "web" } },
    { type: "message", role: "user", text: "顺便把日志也读一下", id: "u2", origin: { channel: "web" }, external_message_id: "nudge_mwuyg262yeho5rg3" },
    { type: "message", role: "user", text: "也看一下缓存", channel: "web", external_message_id: "nudge_mwuzb9itk8385ws8" },
    { type: "message", role: "assistant", text: "报错是缓存没命中，日志我看过了" },
    { type: "message", role: "user", text: "好", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "行" },
    { type: "message", role: "user", text: "再问一句", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "嗯" },
  ], undefined);
  app.renderOutline();
  assert.equal(app.railTurns.length, 3, "连续两条补充都应挂在原问题下");
  assert.equal(app.railTurns[0].ask, "帮我看看这个报错");
  assert.equal(app.railTurns[0].nudges.length, 2);
  assert.equal(app.railTurns[0].nudges[0], "顺便把日志也读一下");
  assert.equal(app.railTurns[0].nudges[1], "也看一下缓存");
  assert.equal(app.railTurns[0].answers.length, 1, "原问题不能变成「没有回答」");
});
test("补充只会并进当前这一轮，不会串到下一轮", () => {
  const app = rail({});
  app.state.messages = app.__api.messageRows([
    { type: "message", role: "user", text: "问一", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "答一" },
    { type: "message", role: "user", text: "问二", origin: { channel: "web" } },
    { type: "message", role: "user", text: "补二", origin: { channel: "web" }, external_message_id: "nudge_mwuzb9itk8385ws8" },
    { type: "message", role: "assistant", text: "答二" },
    { type: "message", role: "user", text: "问三", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "答三" },
  ], undefined);
  app.renderOutline();
  assert.equal(app.railTurns.length, 3);
  assert.equal(app.railTurns[0].nudges.length, 0, "第一轮不该拿到第二轮的补充");
  assert.equal(app.railTurns[1].nudges.length, 1);
  assert.equal(app.railTurns[1].answers[0], "答二");
});
test("上一轮中断没留下回答时，新问不能并进上一轮", () => {
  const app = rail({});
  // 上一轮被中断：用户问了一句，之后没有 assistant 文本，直接是新的一问
  app.state.messages = [
    { role: "user", text: "帮我跑一下那个脚本", id: "u1" },
    { role: "user", text: "算了，先别跑了，看看日志", id: "u2" },
    { role: "assistant", text: "日志里没有相关报错" },
  ];
  app.renderOutline();
  assert.equal(app.railTurns.length, 2, "中断之后重新发问是独立一问，不能被并进上一轮");
  assert.equal(app.railTurns[0].ask, "帮我跑一下那个脚本");
  assert.equal(app.railTurns[0].nudges.length, 0, "没有 nudge 信号的不能当补充");
  assert.equal(app.railTurns[1].ask, "算了，先别跑了，看看日志", "新问题要能在导航上找到");
  assert.equal(app.railTurns[1].answers.length, 1);
});

test("旧的补充行（既无标记也无 external_message_id）宁可多一节，也不吞掉新问题", () => {
  const app = rail({});
  app.state.messages = [
    { role: "user", text: "问一" },
    { role: "user", text: "无标记的第二条" },
    { role: "assistant", text: "答一" },
    { role: "user", text: "问二" },
    { role: "assistant", text: "答二" },
  ];
  app.renderOutline();
  assert.equal(app.railTurns.length, 3, "认不出是补充时按独立一节处理，不猜");
  assert.equal(app.railTurns[1].ask, "无标记的第二条");
});

test("前缀未知时，最新一轮的编号也不假装是全会话轮号", () => {
  const app = rail({});
  app.railPrefix = undefined;
  app.state.messages = [
    { role: "user", text: "问一" },
    { role: "assistant", text: "答一" },
    { role: "user", text: "问二" },
    { role: "assistant", text: "答二" },
    { role: "user", text: "问三" },
    { role: "assistant", text: "答三" },
  ];
  app.renderOutline();
  const card = app.railCard();
  app.showRailCard(new FakeNode({ dataset: { page: "latest" } }));
  assert.match(String(card.innerHTML), /已加载第 3 轮/, "要说明这是已加载的轮号");
  assert.doesNotMatch(String(card.innerHTML), /^(?![\s\S]*已加载)[\s\S]*第 3 轮$/, "不能直接说第 3 轮");
});

// ---- 补充判据的两道闸（勘 2026-11-26）----
// 作者在 #39 上指出：只按 "nudge_" 前缀猜，渠道契约允许的 nudge_qq123 这类普通 ID 会撞车，
// 一条独立的新问会被并进上一轮，导航上等于没有入口。

function turnCount(app: any, rows: any[]) {
  app.state.messages = app.__api.messageRows(rows, undefined);
  app.renderOutline();
  return app.railTurns.length;
}

test("messageRows 把判据要用的两项带出来，别的字段照旧", () => {
  const app = rail({});
  const rows = app.__api.messageRows([
    { type: "message", role: "user", text: "问", id: "u1", origin: { channel: "web" }, external_message_id: "nudge_mwuyg262yeho5rg3", persona_name: "勘" },
    { type: "message", role: "assistant", text: "答" },
    { type: "channel_receipt", role: "user", text: "不该出现" },
  ], undefined);
  assert.equal(rows.length, 2, "只留 type=message 的行");
  assert.equal(rows[0].originChannel, "web", "渠道要带出来");
  assert.equal(rows[0].external_message_id, "nudge_mwuyg262yeho5rg3", "external_message_id 不能在映射时丢掉");
  assert.equal(rows[0].personaName, "勘", "原有的字段不许被改坏");
  assert.equal(rows[1].external_message_id, undefined, "没有就别硬塞一个 undefined 值");
});

test("qq 渠道的 ID 再像 nudge_ 也不当补充", () => {
  const app = rail({});
  const n = turnCount(app, [
    { type: "message", role: "user", text: "问一", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "答一" },
    { type: "message", role: "user", text: "问二", origin: { channel: "web" } },
    { type: "message", role: "user", text: "qq 来的一条正常消息", origin: { channel: "qq" }, external_message_id: "nudge_qq123456789012" },
    { type: "message", role: "assistant", text: "答二" },
  ]);
  assert.equal(n, 3, "qq 那条是新的一问，不能并进上一轮");
  assert.equal(app.railTurns[2].ask, "qq 来的一条正常消息");
});

test("web 渠道的普通消息（web_xxx）不并进上一轮", () => {
  const app = rail({});
  const n = turnCount(app, [
    { type: "message", role: "user", text: "问一", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "答一" },
    { type: "message", role: "user", text: "问二", origin: { channel: "web" } },
    { type: "message", role: "user", text: "这是独立一问", origin: { channel: "web" }, external_message_id: "web_dafa1c399aa1d08a" },
    { type: "message", role: "assistant", text: "答二" },
  ]);
  assert.equal(n, 3, "web 渠道的普通 ID 不是补充");
});

test("渠道记录冲突时保留独立问题的导航入口", () => {
  for (const [originChannel, channel] of [["web", "qq"], ["qq", "web"], ["", "web"], [0, "web"]]) {
    const app = rail({});
    const n = turnCount(app, [
      { type: "message", role: "user", text: "上一问" },
      { type: "message", role: "user", text: "独立新问", origin: { channel: originChannel }, channel,
        external_message_id: "nudge_mwuyg262yeho5rg3" },
    ]);
    assert.equal(n, 2, `origin.channel=${JSON.stringify(originChannel)}, channel=${channel}`);
    assert.equal(app.railTurns[1].ask, "独立新问");
  }
});

test("渠道不明或形状太短的，一律不当补充", () => {
  const noOrigin = turnCount(rail({}), [
    { type: "message", role: "user", text: "问一" },
    { type: "message", role: "assistant", text: "答一" },
    { type: "message", role: "user", text: "问二" },
    { type: "message", role: "user", text: "带 ID 但没渠道", external_message_id: "nudge_mwuyg262yeho5rg3" },
  ]);
  assert.equal(noOrigin, 3, "认不出渠道就不能当补充");

  const tooShort = turnCount(rail({}), [
    { type: "message", role: "user", text: "问一", origin: { channel: "web" } },
    { type: "message", role: "assistant", text: "答一" },
    { type: "message", role: "user", text: "问二", origin: { channel: "web" } },
    { type: "message", role: "user", text: "短的 ID", origin: { channel: "web" }, external_message_id: "nudge_abc123" },
  ]);
  assert.equal(tooShort, 3, "不是我们生成的那种形状就别猜");
});

// ── 翻页交互（作者在 PR #39 上报的第 2 条）──────────────────────────────
// 点一次「更早」，要真的落到提示的那一批。旧写法里 syncRail 认为「高亮在批外就该换批」，
// 而平滑滚动途中高亮还在末尾，于是刚翻过去的批次当场被拽回来，看着像点了没反应。

function ticksOf(rail: FakeNode) {
  return (rail as any).__ticks as FakeNode[];
}

function railWithTicks() {
  const rail = new FakeNode({ clientHeight: 500 });
  (rail as any).__ticks = [];
  Object.defineProperty(rail, "innerHTML", {
    get() {
      return (this as any).__html || "";
    },
    set(value: string) {
      (this as any).__html = value;
      const list: FakeNode[] = [];
      const re = /<button[^>]*>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(String(value)))) {
        const tag = m[0];
        if (!tag.includes("chat-rail-tick")) continue;
        const node = new FakeNode();
        const page = /data-page="([^"]*)"/.exec(tag);
        const turn = /data-turn="([^"]*)"/.exec(tag);
        const ordinal = /data-ordinal="([^"]*)"/.exec(tag);
        if (page) node.dataset.page = page[1];
        if (turn) node.dataset.turn = turn[1];
        if (ordinal) node.dataset.ordinal = ordinal[1];
        node.classList.toggle = (name: string, on?: boolean) => {
          if (on) node.classes.add(name);
          else node.classes.delete(name);
        };
        node.style = {};
        list.push(node);
      }
      (this as any).__ticks = list;
    },
  });
  rail.querySelectorAll = (sel: string) => {
    const all = (rail as any).__ticks as FakeNode[];
    if (sel.includes("[data-turn]")) return all.filter((t) => t.dataset.turn !== undefined);
    return all;
  };
  return rail;
}

/** 造一个能算高亮的消息容器：第 n 条消息离视口顶端 (n - cursor) * 20px。 */
function scrollableMessages(cursor: { at: number }) {
  const box = new FakeNode({ clientHeight: 500 });
  box.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 1000, width: 1000, height: 500 });
  box.querySelector = (sel: string) => {
    const m = /data-index="(\d+)"/.exec(sel);
    if (!m) return null;
    const index = Number(m[1]);
    return {
      isConnected: true,
      scrollIntoView() {},
      getBoundingClientRect() {
        const top = (index - cursor.at) * 20;
        return { top, bottom: top + 20, height: 20, width: 100, left: 0, right: 100 };
      },
    };
  };
  return box;
}

function longSession() {
  const cursor = { at: 152 };
  const railEl = railWithTicks();
  const messages = scrollableMessages(cursor);
  const app = rail({ messages, "chat-rail": railEl });
  const rows: any[] = [];
  for (let i = 0; i < 80; i += 1) {
    rows.push({ role: "user", text: "问" + i });
    rows.push({ role: "assistant", text: "答" + i });
  }
  app.state.messages = rows;
  app.renderOutline();
  return { app, rail: railEl, cursor };
}

test("点一次「更早」就落到提示的那一批，不会被拽回末尾", () => {
  const { app, rail, cursor } = longSession();
  const batch = app.railBatch;
  assert.ok(batch >= 8, "一批的格数按轨道高度算");
  assert.equal(app.railStart, 80 - batch, "首屏停在最新一批");

  // 平滑滚动刚开始：高亮还在最后一轮，旧写法这里就会把批次拽回末尾
  cursor.at = 152;
  app.syncRail();
  assert.equal(app.railStart, 80 - batch, "滚动还没动时，批次不能变");

  app.railPage("prev");
  assert.equal(app.railStart, 80 - batch * 2, "点一次「更早」走一整批");
  const firstTurn = Number(ticksOf(rail).filter((t) => t.dataset.turn !== undefined)[0].dataset.turn);
  assert.equal(firstTurn, 80 - batch * 2, "刻度上的第一格就是这一批的第一轮");

  // 滚动途中，高亮还在末尾附近
  cursor.at = 150;
  app.syncRail();
  assert.equal(app.railStart, 80 - batch * 2, "滚动途中高亮在批外，不许把批次弹回末尾");

  // 再滚一段，仍在批外
  cursor.at = 100;
  app.syncRail();
  assert.equal(app.railStart, 80 - batch * 2, "中途任何一度都不许弹回");

  // 落到目标那一批：第 start 轮的消息索引是 start*2，视口顶端落在它上面
  cursor.at = (80 - batch * 2) * 2 - 6;
  app.syncRail();
  assert.equal(app.railStart, 80 - batch * 2, "到位后批次不变");
  const active = ticksOf(rail).filter((t) => t.classes.has("active"));
  assert.equal(active.length, 1, "高亮只留一格");
  assert.equal(Number(active[0].dataset.turn), 80 - batch * 2, "高亮在那一批的第一格");
});

test("翻页过头之后，用户自己滚到别处，批次照常跟着换", () => {
  const { app, cursor } = longSession();
  app.railPage("prev");
  const landed = app.railStart;
  // 落到位，解除主动跳转
  cursor.at = landed * 2;
  app.syncRail();
  // 再往上滚很远（滚出这一批）
  cursor.at = 10;
  app.syncRail();
  assert.notEqual(app.railStart, landed, "解除之后，滚动越界就换批，不能钉死");
  assert.ok(app.railStart <= 12, "换到高亮所在的那一批");
});

test("跳到最新那一格，期间也不被中途的滚动打断", () => {
  const { app, cursor } = longSession();
  app.railPage("prev");
  app.railPage("prev");
  const early = app.railStart;
  assert.ok(early < 80 - app.railBatch, "已经翻到更早的批次");
  cursor.at = early * 2;
  app.syncRail();
  app.railPage("latest");
  assert.equal(app.railStart, 80 - app.railBatch, "跳到最新，回到末尾那一批");
  cursor.at = 90;
  app.syncRail();
  assert.equal(app.railStart, 80 - app.railBatch, "途中不许换批");
});
