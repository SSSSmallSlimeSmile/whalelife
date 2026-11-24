import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { boot } from "../core/index.ts";
import { SessionQueue } from "../core/session-queue.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const signal = () => new AbortController().signal;

test("scheduler is FIFO, stable-priority, bounded, per-session and never preempts running work", async () => {
  const locks = new Set<string>(), queue = new SessionQueue(locks), gate = deferred(), order: string[] = [];
  const add = (id: string, label: string, priority = 0) => queue.submit(id, signal(), async () => { order.push(label); return label; }, { wait: true, priority });
  const running = queue.submit("a", signal(), async () => { order.push("running"); await gate.promise; });
  const normal = add("a", "normal"), high = add("a", "high", 10), equal = add("a", "equal", 10);
  assert.equal(await add("b", "independent"), "independent");
  assert.deepEqual(order, ["running", "independent"]);
  assert.throws(() => queue.submit("a", signal(), async () => "old"), /正在/);
  assert.throws(() => add("a", "bad", 101), /优先级/);
  assert.throws(() => queue.submit("a", signal(), async () => "", { wait: true, key: "" }), /去重键/);
  gate.resolve(); await Promise.all([running, normal, high, equal]);
  assert.deepEqual(order, ["running", "independent", "high", "equal", "normal"]);
  assert.equal(locks.size, 0);
  const hold = deferred(), first = queue.submit("limit", signal(), () => hold.promise);
  const pending = Array.from({ length: 128 }, () => add("limit", "pending"));
  assert.throws(() => add("limit", "overflow"), /队列已满/);
  hold.resolve(); await Promise.all([first, ...pending]);
  assert.equal(locks.size, 0);
});

test("pending deduplication is owner-scoped, first-wins; follower cancellation cannot cancel another job", async () => {
  const queue = new SessionQueue(new Set()), hold = deferred(), scope = {}, other = {}, calls: string[] = [];
  const running = queue.submit("s", signal(), () => hold.promise);
  const add = (owner: object, text: string, s = signal()) => queue.submit("s", s, async () => { calls.push(text); return text; }, { wait: true, scope: owner, key: "same" });
  const first = add(scope, "first"), follower = add(scope, "discarded"), independent = add(other, "other-owner");
  const cancellation = new AbortController(), cancelled = assert.rejects(add(scope, "cancelled-follower", cancellation.signal), /follower/);
  cancellation.abort(Error("follower stopped")); await cancelled;
  hold.resolve(); await running;
  assert.deepEqual(await Promise.all([first, follower, independent]), ["first", "first", "other-owner"]);
  assert.deepEqual(calls, ["first", "other-owner"]);
});

test("waiting abort and invalid guards do no work; active cancellation waits for real completion before releasing", async () => {
  const locks = new Set<string>(), queue = new SessionQueue(locks), hold = deferred(), active = new AbortController();
  const order: string[] = [];
  const running = queue.submit("s", active.signal, async () => { await hold.promise; order.push("confirmed"); });
  const waiting = new AbortController();
  const cancelled = assert.rejects(queue.submit("s", waiting.signal, async () => { order.push("wrong"); }, { wait: true }), /cancel-wait/);
  waiting.abort(Error("cancel-wait")); await cancelled;
  const invalid = assert.rejects(queue.submit("s", signal(), async () => { order.push("wrong"); }, { wait: true, beforeRun: () => false }), /已失效/);
  const after = queue.submit("s", signal(), async () => { order.push("after"); }, { wait: true });
  active.abort(Error("active-cancel"));
  assert.equal(locks.has("s"), true); assert.equal(order.length, 0);
  hold.resolve(); await Promise.all([running, invalid, after]);
  assert.deepEqual(order, ["confirmed", "after"]); assert.equal(locks.size, 0);
  const guard = new AbortController(), entered = deferred();
  const blocked = assert.rejects(queue.submit("s", guard.signal, async () => { order.push("wrong"); }, {
    wait: true, beforeRun: () => { entered.resolve(); return new Promise<boolean>(() => {}); },
  }), /guard-cancel/);
  await entered.promise; guard.abort(Error("guard-cancel")); await blocked;
  assert.equal(locks.size, 0);
});

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-session-queue-");
  let app: any;
  const releases: (() => void)[] = [];
  t.after(async () => { releases.forEach(release => release()); await app?.close(); });
  await mkdir(join(root, "config"));
  for (const id of ["queue-one", "queue-two"]) {
    await mkdir(join(root, "plugins", id), { recursive: true });
    await writeFile(join(root, "plugins", id, "plugin.yaml"), `id: ${id}\nname: Queue test\ndescription: Isolated queue contract test\nversion: 1.0.0\napiVersion: "1"\n`);
    await writeFile(join(root, "plugins", id, "index.ts"), `export function apply(ctx) {
      const jobs = new Map(), sent = []; let valid = true, guards = 0;
      const channel = ctx.channels.register({ id: '${id}', account: 'test', persona: 'a', permission: 'full',
        async send(message) { sent.push(message); } });
      ctx.tools.register({ name: '${id.replaceAll("-", "_")}_send', description: 'Send with a real receipt', schema: {}, danger: 'safe',
        async run(args, session) {
          return channel.send({ peer: 'friend', messageId: 'tool-send', text: '已执行的发送' }, { signal: session.signal });
        } });
      ctx.tools.register({ name: '${id.replaceAll("-", "_")}_finish', description: 'Record then finish', schema: {}, danger: 'safe',
        async run(args, session) {
          await ctx.memory.recordExperience(session.id, { event_id: 'finished', outcome: 'succeeded', text: '判断完成' });
          jobs.get('quiet').controller.abort(Error('quiet-finished'));
          return 'recorded';
        } });
      ctx.provide('${id}', {
        run: input => ctx.sessions.run(input),
        start(name, input, transient = true) {
          const controller = new AbortController();
          const job = { controller }; jobs.set(name, job);
          job.result = ctx.sessions[transient ? 'enqueueTransient' : 'enqueue']({ ...input, signal: controller.signal,
            ...(input.guard ? { beforeRun: () => { guards++; return valid; } } : {})
          }).then(text => ({ ok: true, text }), error => ({ ok: false, error: error.message }));
          return true;
        },
        result: name => jobs.get(name).result,
        cancel(name) { jobs.get(name).controller.abort(Error('waiting-cancelled')); },
        allow(value) { valid = value; },
        guards: () => guards,
        bind: id => channel.bind('friend', id),
        receive: message => channel.receive({ peer: 'friend', sender: 'human', ...message }),
        sent: () => sent,
      });
    }`);
  }
  await writeFile(join(root, "a.md"), "人格甲的标记青柠");
  await writeFile(join(root, "b.md"), "人格乙的标记蓝莓");
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", name: "Test", provider: "test", model: "test", type: "chat", context_window: 32000 }],
    model_bindings: { chat: "chat" },
    personas: { a: { name: "A", file: "a.md", permission: "full" }, b: { name: "B", file: "b.md", permission: "off" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const id = await app.sessions.current();
  const requests: any[] = [];
  const normal = () => ({ text: "完成", toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } });
  let responder: (input: any) => any = normal;
  app.llm.chat = async (input: any) => { requests.push(structuredClone(input.messages)); return responder(input); };
  return { app, id, root, requests, normal,
    api: (name = "queue-one") => app.runtime.services.get(name).value,
    respond: (fn: (input: any) => any) => { responder = fn; },
    hold: () => {
      const started = deferred(), gate = deferred(); releases.push(gate.resolve);
      let first = true;
      responder = async () => { if (first) { first = false; started.resolve(); await gate.promise; } return normal(); };
      return { started: started.promise, release: gate.resolve };
    },
  };
}

test("Web, two channel messages and plugin share one lane; arrival, history, source, permission and tokens remain correct", { timeout: 15000 }, async t => {
  const f = await fixture(t), api = f.api();
  await api.bind(f.id);
  const gate = f.hold(), first = f.app.channels.web(f.id, "网页先发", () => {});
  await gate.started;
  const arrival = Date.now();
  const one = api.receive({ messageId: "one", text: "渠道第一句" });
  await until(() => f.app.sessions.channelOperations.has(f.id));
  const two = api.receive({ messageId: "two", text: "渠道第二句" });
  await until(() => f.app.sessions.channelOperations.get(f.id) === 2);
  await api.start("plugin", { sessionId: f.id, text: "临时机会TOKEN998", priority: -10, permission: "off" });
  await assert.rejects(api.run({ sessionId: f.id, text: "旧入口仍拒绝" }), /正在/);
  assert.equal(f.requests.length, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const released = Date.now(); gate.release();
  await first;
  const result = await Promise.all([one, two, api.result("plugin")]);
  assert.equal(result[0].status, "sent"); assert.equal(result[1].status, "sent"); assert.equal(result[2].ok, true);
  const speaker = '【本条用户发言人】{"account":"test","peer":"friend","sender":"human"}\n';
  assert.deepEqual(f.requests.slice(0, 3).map(x => x.at(-1).content),
    ["网页先发", speaker + "渠道第一句", speaker + "渠道第二句"]);
  assert.doesNotMatch(f.requests[3].at(-1).content, /【本条用户发言人】/);
  assert.match(f.requests[3].at(-1).content, /临时机会TOKEN998/);
  assert.match(JSON.stringify(f.requests[3]), /渠道第二句/);
  const rows = await f.app.memory.readSession(f.id), state = await f.app.memoryEngine.state(f.id);
  assert.equal(JSON.stringify(rows).includes("TOKEN998"), false);
  const humans = rows.filter((row: any) => row.role === "user");
  assert.deepEqual(humans.map((x: any) => x.text), ["网页先发", "渠道第一句", "渠道第二句"]);
  assert.equal(humans[1].origin.plugin, "queue-one"); assert.equal(humans[1].sender, "human");
  assert.ok(Date.parse(humans[1].ts) >= arrival && Date.parse(humans[1].ts) < released);
  assert.equal(state.usage.chat.requests, 4); assert.equal(state.usage.chat.input_tokens, 80);
  assert.deepEqual((await api.sent()).map((x: any) => x.replyTo), ["one", "two"]);
  assert.equal(f.app.sessions.locks.size, 0); assert.equal(f.app.sessions.channelOperations.size, 0);
});

test("queued plugin snapshots target/persona/permissions, scopes deduplication and evaluates validity at execution", { timeout: 15000 }, async t => {
  const f = await fixture(t), a = f.api(), b = f.api("queue-two"), gate = f.hold();
  const first = f.app.channels.web(f.id, "正在交流", () => {}); await gate.started;
  await a.start("normal", { text: "普通机会", key: "same", guard: true });
  await a.start("duplicate", { text: "重复应忽略", key: "same", guard: true });
  await b.start("independent", { text: "另一个插件的机会", key: "same" });
  await a.start("urgent", { text: "优先机会", priority: 10, permission: "off" });
  await a.start("invalid", { text: "无效机会", key: "invalid", guard: true });
  assert.equal(await a.guards(), 0);
  const other = await f.app.sessions.current({ create: true });
  f.app.config.channels.web.persona = "b"; f.app.config.personas.a.permission = "off";
  await a.allow(false);
  const seen: any[] = [];
  // The running responder retains its gate; subsequent requests use the new responder.
  f.respond(input => { seen.push({ tools: input.tools.length, prompt: input.messages[0].content }); return f.normal(); });
  gate.release(); await first;
  assert.equal((await a.result("urgent")).ok, true);
  assert.equal((await b.result("independent")).ok, true);
  for (const name of ["normal", "duplicate", "invalid"]) assert.match((await a.result(name)).error, /已失效/);
  assert.equal(await a.guards(), 2);
  assert.match(f.requests[1].at(-1).content, /优先机会/);
  assert.equal(seen[0].tools, 0); assert.ok(seen[1].tools > 0, "queued permission must not change with later defaults");
  assert.ok(seen.every(x => x.prompt.includes("人格甲") && !x.prompt.includes("人格乙")));
  assert.deepEqual(await f.app.memory.readSession(other), []);
  assert.equal(await f.app.sessions.current(), other);
});

test("waiting cancellation and stopped/reloaded plugins leave no synthetic memories and do not block another plugin", { timeout: 15000 }, async t => {
  const f = await fixture(t), a = f.api(), gate = f.hold();
  const first = f.app.channels.web(f.id, "真人交流", () => {}); await gate.started;
  await a.start("cancel", { text: "取消掉的机会" });
  await a.cancel("cancel"); assert.match((await a.result("cancel")).error, /waiting-cancelled/);
  await a.start("stopped", { text: "旧实例机会" });
  await f.app.runtime.action("queue-one", "stop");
  await f.api("queue-two").start("kept", { text: "其他插件继续" });
  await f.app.runtime.action("queue-one", "start");
  await f.api().start("new", { text: "新实例机会" });
  gate.release(); await first;
  assert.equal((await f.api("queue-two").result("kept")).ok, true);
  assert.equal((await f.api().result("new")).ok, true);
  assert.equal(f.requests.length, 3);
  assert.equal(JSON.stringify(f.requests).includes("旧实例机会"), false);
  assert.equal(JSON.stringify(f.requests).includes("取消掉的机会"), false);
  assert.equal(f.app.sessions.locks.size, 0);
});

test("queued tool can send on its own channel and wait for confirmed receipt without self-deadlock or replay", { timeout: 15000 }, async t => {
  const f = await fixture(t), api = f.api(); await api.bind(f.id);
  f.respond(input => input.messages.some((x: any) => x.role === "tool") ? f.normal()
    : { text: "", toolCalls: [{ id: "call", name: "queue_one_send", arguments: "{}" }] });
  await api.start("send", { text: "发送判断", permission: "full" });
  assert.equal((await api.result("send")).ok, true);
  assert.equal((await api.sent()).length, 1);
  assert.match(JSON.stringify(f.requests.at(-1)), /sent/);
  await api.start("duplicate-send", { text: "再次检查相同发送ID", permission: "full" });
  assert.equal((await api.result("duplicate-send")).ok, true);
  assert.equal((await api.sent()).length, 1, "stable delivery ID is never replayed");
  const state = await f.app.memoryEngine.state(f.id);
  assert.ok(state.records.some((row: any) => row.text.includes("已通过") && row.outcome === "succeeded"));
});

test("quiet completion cancellation keeps its actual decision, releases the lane, and continues waiting input", { timeout: 15000 }, async t => {
  const f = await fixture(t), api = f.api(), gate = f.hold();
  const first = f.app.channels.web(f.id, "真人先聊", () => {}); await gate.started;
  await api.start("quiet", { text: "临时安静判断", permission: "full" });
  await api.start("next", { text: "之后的真实输入", priority: -1 }, false);
  let firstCall = true;
  f.respond(() => {
    if (firstCall) { firstCall = false; return { text: "", toolCalls: [{ id: "quiet", name: "queue_one_finish", arguments: "{}" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }; }
    return f.normal();
  });
  gate.release(); await first;
  assert.match((await api.result("quiet")).error, /quiet-finished/);
  assert.equal((await api.result("next")).ok, true);
  const rows = await f.app.memory.readSession(f.id), state = await f.app.memoryEngine.state(f.id);
  assert.equal(JSON.stringify(rows).includes("临时安静判断"), false);
  assert.ok(state.records.some((x: any) => x.text === "判断完成"));
  assert.equal(state.usage.chat.requests, 3);
  assert.equal(f.app.sessions.locks.size, 0);
});

test("waiting sessions block deletion/context edits/restore and shutdown cancels pending work without replay", { timeout: 15000 }, async t => {
  const f = await fixture(t), api = f.api(), started = deferred();
  f.respond(input => new Promise((_, reject) => {
    started.resolve(); input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
  }));
  const first = assert.rejects(f.app.channels.web(f.id, "正在处理", () => {}), /关闭/);
  await started.promise;
  await api.start("pending", { text: "不应重放" });
  await assert.rejects(f.app.sessions.updateContext(f.id, {}), /正在/);
  const admin = new MemoryAdmin(f.app.memory, f.app.sessions, f.app.logger);
  await assert.rejects(admin.deleteSession({ id: f.id }), /正在|稍候|等待/);
  await assert.rejects(admin.restore({ id: "irrelevant" }), /对话正在进行/);
  assert.equal(f.app.sessions.locks.has(f.id), true);
  f.app.sessions.beginClose();
  await first;
  assert.match((await api.result("pending")).error, /关闭/);
  await f.app.sessions.close();
  assert.equal(f.requests.length, 1); assert.equal(f.app.sessions.locks.size, 0);
  assert.equal(JSON.stringify(await f.app.memory.readSession(f.id)).includes("不应重放"), false);
});

test("WebSocket reports waiting, keeps its original session after switching, then streams normally", { timeout: 15000 }, async t => {
  const f = await fixture(t), gate = f.hold();
  await f.api().start("active", { sessionId: f.id, text: "插件先执行" }); await gate.started;
  const url = `http://127.0.0.1:${f.app.web.server.address().port}`;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const ws = new WebSocket(url.replace("http", "ws") + "/ws/chat", { headers: { Cookie: cookie } });
  t.after(() => ws.terminate()); await once(ws, "open");
  const events: any[] = [];
  ws.on("message", raw => events.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ session: f.id, expectedSession: f.id, persona: "a", text: "网页等待消息" }));
  await until(() => events.some(x => x.type === "context" && x.queued));
  const other = await f.app.sessions.current({ create: true });
  f.app.config.channels.web.persona = "b";
  f.respond(input => { input.onChunk?.("完成"); return f.normal(); });
  gate.release(); await f.api().result("active");
  await until(() => events.some(x => x.type === "done"));
  assert.equal(events.some(x => x.type === "error"), false);
  assert.ok(events.some(x => x.type === "chunk" && x.text === "完成"));
  assert.ok(events.some(x => x.type === "context" && x.personaId === "a"));
  assert.ok((await f.app.memory.readSession(f.id)).some((x: any) => x.text === "网页等待消息"));
  assert.deepEqual(await f.app.memory.readSession(other), []);
});

async function webChatClient(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const url = "http://127.0.0.1:" + f.app.web.server.address().port;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const ws = new WebSocket(url.replace("http", "ws") + "/ws/chat", { headers: { Cookie: cookie } });
  t.after(() => ws.terminate());
  const events: any[] = [];
  ws.on("message", raw => events.push(JSON.parse(raw.toString())));
  await once(ws, "open");
  return { events, send: (data: any) => ws.send(JSON.stringify({ session: f.id, ...data })) };
}

test("Web supplements stay in their own turn and a failed history write stops the model", async t => {
  const f = await fixture(t), gate = f.hold();
  const a = await webChatClient(t, f), b = await webChatClient(t, f);
  a.send({ expectedSession: f.id, text: "first" }); await gate.started;
  b.send({ expectedSession: f.id, text: "second" });
  b.send({ append: true, messageId: "before_start", text: "too early" });
  await until(() => b.events.some(x => x.queued));
  const turnB = b.events.find(x => x.type === "started").turn;
  b.send({ append: true, turn: turnB, messageId: "while_waiting", text: "queued input" });
  await until(() => b.events.some(x => x.messageId === "while_waiting"));
  assert.equal(b.events.find(x => x.messageId === "before_start").status, "closed");
  assert.equal(b.events.find(x => x.messageId === "while_waiting").reason, "queued");

  const turnA = a.events.find(x => x.type === "started").turn;
  const addition = { append: true, turn: turnA, messageId: "first_addition", text: "keep this" };
  a.send(addition); a.send(addition);
  await until(() => a.events.filter(x => x.messageId === addition.messageId).length === 2);
  assert.deepEqual(a.events.filter(x => x.messageId === addition.messageId).map(x => x.status), ["accepted", "duplicate"]);
  a.send({ ...addition, text: "different text with same ID" });
  await until(() => a.events.some(x => x.status === "rejected"));
  const save = f.app.memory.appendEvent.bind(f.app.memory);
  f.app.memory.appendEvent = async (row: any) => {
    if (row.type === "message" && row.external_message_id === "missing_row") throw Error("synthetic history failure");
    return save(row);
  };
  a.send({ append: true, turn: turnA, messageId: "missing_row", text: "lost input" });
  await until(() => a.events.some(x => x.messageId === "missing_row"));
  const failure = a.events.find(x => x.messageId === "missing_row");
  assert.equal(failure.status, "rejected");
  assert.equal(failure.text, "lost input");
  gate.release();
  await until(() => a.events.some(x => x.type === "error") && b.events.some(x => x.type === "done"));
  assert.ok(!a.events.some(x => x.type === "done"));
  const rows = (await f.app.memory.readSession(f.id)).filter((row: any) => row.type === "message");
  assert.deepEqual(rows.map((row: any) => row.text), ["first", "keep this", "second", "完成"]);
});

test("a sealed Web turn acknowledges its duplicates and rejects new text until done", async t => {
  const f = await fixture(t), model = f.hold(), client = await webChatClient(t, f);
  const writing = deferred(), release = deferred();
  const save = f.app.memory.appendEvent.bind(f.app.memory);
  f.app.memory.appendEvent = async (row: any) => {
    if (row.type === "message" && row.role === "assistant") { writing.resolve(); await release.promise; }
    return save(row);
  };
  try {
    client.send({ expectedSession: f.id, text: "question" });
    await model.started;
    await until(() => client.events.some(x => x.type === "started"));
    const turn = client.events.find(x => x.type === "started").turn;
    const member = { append: true, turn, messageId: "already_saved", text: "accepted addition" };
    client.send(member);
    await until(() => client.events.some(x => x.status === "accepted"));
    model.release(); await writing.promise;
    client.send(member);
    client.send({ ...member, messageId: "too_late", text: "late addition" });
    await until(() => client.events.filter(x => x.type === "append").length === 3);
    const duplicate = client.events.filter(x => x.messageId === member.messageId).at(-1);
    const late = client.events.find(x => x.messageId === "too_late");
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(late, { type: "append", status: "closed", messageId: "too_late", text: "late addition" });
  } finally { release.resolve(); }
  await until(() => client.events.some(x => x.type === "done"));
  const rows = await f.app.memory.readSession(f.id);
  assert.equal(rows.filter((row: any) => row.text === "accepted addition").length, 1);
  assert.ok(!rows.some((row: any) => row.text === "late addition"));
});
