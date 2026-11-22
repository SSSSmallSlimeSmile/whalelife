/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Channels, type ChannelHandle } from "../core/channels.ts";
import type { ChannelTurn, IncomingMessageData } from "../core/plugin-api.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const message = (messageId: string, text = messageId, peer = "friend"): IncomingMessageData => ({ peer, sender: "human", messageId, text });
const answer = (text = "最终答案") => ({ text, toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } });
const privateToolText = "SYNTHETIC_TURN_PRIVATE_TOOL_MATERIAL";
async function diskText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? diskText(join(root, entry.name)) : readFile(join(root, entry.name), "utf8")))).join("\n");
}
const rejects = (operation: () => unknown, pattern: RegExp) => assert.rejects(Promise.resolve().then(operation), pattern);
const open = (handle: ChannelHandle, input: IncomingMessageData, signal?: AbortSignal): Promise<ChannelTurn> => {
  assert.equal(typeof handle.openTurn, "function", "the new entry must be available without changing receive");
  return handle.openTurn!(input, signal ? { signal } : undefined);
};

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-channel-turn-");
  const releases: (() => void)[] = [], resources: { channels: Channels; sessions: Sessions }[] = [];
  t.after(async () => {
    releases.forEach(release => release());
    for (const resource of resources.reverse()) await Promise.all([resource.channels.close(), resource.sessions.close()]);
  });
  const logger: any = { info() {}, warn() {}, error() {} };
  await writeFile(join(root, "a.md"), "测试人格甲");
  const config: any = {
    providers: [{ id: "demo", model: "chat", base_url: "https://unused.invalid/v1", context_window: 300000 }],
    personas: { a: { name: "A", file: "a.md", provider: "demo", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" }, mock: { persona: "a", permission: "full" } },
    memory: { recent_lines: 200, budget_tokens: 200000, include_summary: false },
  };
  const requests: any[][] = [], calls: any[][] = [], deliveries: any[] = [];
  let respond: (input: any) => any = () => answer();
  let runTool: (...args: any[]) => any = async () => ({ ok: true, result: "动作已完成" });
  let transport: (...args: any[]) => any = async () => {};
  const llm: any = { chat: async (input: any) => { requests.push(structuredClone(input.messages)); return respond(input); } };
  const create = async () => {
    const memory = new Memory(join(root, "memory"), logger);
    await memory.init();
    const engine = new MemoryEngine(memory);
    const services: any = { memory, memoryEngine: engine, logger, llm, tools: {
      list: () => ["first_action", "second_action"].map(name => ({ type: "function", function: { name, parameters: { type: "object" } } })),
      call: async (...args: any[]) => { calls.push(args); return runTool(...args); },
    } };
    const sessions = new Sessions(root, config, services);
    engine.maintenance = id => sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
    const channels = new Channels(memory, sessions, config);
    resources.push({ channels, sessions });
    return { memory, engine, sessions, channels };
  };
  const state = await create();
  const adapter = { id: "mock", name: "测试渠道", account: "account", persona: "a", permission: "full" as const,
    send: async (...args: any[]) => { deliveries.push(args[0]); await transport(...args); } };
  const handle = state.channels.register(adapter, "turn-test");
  return { root, config, ...state, requests, calls, deliveries, handle,
    respond: (fn: typeof respond) => { respond = fn; }, tool: (fn: typeof runTool) => { runTool = fn; }, send: (fn: typeof transport) => { transport = fn; },
    gate: () => { const gate = deferred(); releases.push(gate.resolve); return gate; },
    restart: async () => {
      handle.dispose();
      const next = await create();
      return { ...next, handle: next.channels.register(adapter, "turn-test") };
    },
  };
}

test("active persona changes split live turns while preserving accepted inputs, history and delivery retries", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  await writeFile(join(f.root, "b.md"), "测试人格乙");
  f.config.personas.b = { ...f.config.personas.a, name: "B", file: "b.md" };

  const deliveries: string[] = [];
  const handle = f.channels.register({
    id: "mock", account: "following", personaMode: "active", permission: "off",
    async send(outgoing) {
      deliveries.push(outgoing.deliveryId);
      if (deliveries.length === 1) throw Error("synthetic transport failure");
    },
  }, "turn-test");
  const leader = message("original"), member = message("supplement"), next = message("next-persona");
  await f.memory.saveSessionMeta("same-session", {});
  await handle.bind(leader.peer, "same-session");
  const toolCounts: number[] = [];
  f.respond(async (input) => {
    toolCounts.push(input.tools?.length ?? 0);
    if (f.requests.length === 1) { entered.resolve(); await gate.promise; }
    return answer(input.messages[0].content.includes("测试人格乙") ? "B的回复" : "A的回复");
  });

  const first = await open(handle, leader);
  await entered.promise;
  assert.equal((await first.append(member)).status, "accepted");
  f.config.channels.web.persona = "b";
  assert.equal(handle.currentPersona!(), "b");
  assert.equal((await first.append(member)).status, "duplicate");
  await rejects(() => first.append({ ...member, text: "不同正文" }), /不一致|不同正文/);
  assert.equal((await first.append(next)).status, "closed");
  const second = await open(handle, next);
  assert.equal(second.sessionId, first.sessionId);
  f.config.channels.web.persona = "a"; // The B turn already has its slot in this session's queue.
  assert.equal((await first.append(message("after-switch-back"))).status, "closed");
  gate.resolve();

  const failed = await first.result(), completed = await second.result();
  assert.deepEqual([failed.status, failed.text, completed.status, completed.text], ["delivery_failed", "A的回复", "sent", "B的回复"]);
  assert.equal(f.requests.length, 3);
  assert.match(JSON.stringify(f.requests[2]), /supplement/);
  const third = await handle.receive(message("back-to-first"));
  assert.deepEqual([third.status, third.text, third.sessionId], ["sent", "A的回复", first.sessionId]);
  f.config.channels.web.persona = "b";
  const retried = await handle.retry(leader.peer, member.messageId);
  assert.deepEqual([retried.status, retried.text, retried.deliveryId], ["sent", "A的回复", failed.deliveryId]);
  assert.equal((await handle.receive(member)).duplicate, true);
  assert.deepEqual(deliveries, [failed.deliveryId, completed.deliveryId, third.deliveryId, failed.deliveryId]);
  assert.deepEqual(toolCounts, [0, 0, 0, 0], "each turn keeps the channel's explicit tool permission");

  const rows = await f.memory.readSession("same-session");
  assert.deepEqual(rows.filter(row => row.type === "message" && row.role === "user").map(row => [row.external_message_id, row.persona_id]), [
    ["original", "a"], ["supplement", "a"], ["next-persona", "b"], ["back-to-first", "a"],
  ]);
  assert.deepEqual(rows.filter(row => row.type === "message" && row.role === "assistant").map(row => row.persona_id), ["a", "b", "a"]);
  const owners = new Map([["original", "a"], ["supplement", "a"], ["next-persona", "b"], ["back-to-first", "a"]]);
  const receipts = rows.filter(row => row.type === "channel_receipt");
  assert.deepEqual(new Set(receipts.map(row => row.external_message_id)), new Set(owners.keys()));
  for (const receipt of receipts) assert.equal(receipt.persona_id, owners.get(receipt.external_message_id));
});

test("openTurn returns during generation; pending additions replace the candidate and retain individual source-bound history", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  f.respond(async () => {
    if (f.requests.length === 1) { entered.resolve(); await gate.promise; return answer("过时的候选内容"); }
    return answer();
  });
  const turn = await open(f.handle, message("first", "先选红色"));
  await entered.promise;
  let settled = false;
  const result = turn.result().then(value => { settled = true; return value; });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(await turn.append(message("second", "改成蓝色")), { status: "accepted", messageId: "second" });
  assert.equal((await turn.append(message("third", "数量为两份"))).status, "accepted");
  assert.equal(f.requests.length, 1, "adding input does not overlap a pending model call");
  gate.resolve();
  const completed = await result;
  assert.equal(completed.status, "sent"); assert.equal(completed.text, "最终答案");
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1]), /改成蓝色/); assert.match(JSON.stringify(f.requests[1]), /数量为两份/);
  const rows = (await f.memory.readSession(turn.sessionId)).filter(row => row.type === "message");
  assert.deepEqual(rows.filter(row => row.role === "user").map(row => [row.external_message_id, row.text]),
    [["first", "先选红色"], ["second", "改成蓝色"], ["third", "数量为两份"]]);
  assert.deepEqual(rows.filter(row => row.role === "assistant").map(row => row.text), ["最终答案"]);
  assert.equal(JSON.stringify(rows).includes("过时的候选内容"), false);
  for (const row of rows) {
    assert.equal(row.origin.plugin, "turn-test"); assert.equal(row.origin.platform, "测试渠道");
    assert.equal(row.channel, "mock"); assert.equal(row.account, "account"); assert.equal(row.peer, "friend");
  }
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].replyTo, "first");
  assert.equal((await f.engine.state(turn.sessionId)).usage.chat.requests, 2);
});

test("shared channel history attributes each user message, including a renamed speaker during a tool call", { timeout: 10000 }, async t => {
  const f = await fixture(t), toolEntered = deferred(), releaseTool = f.gate();
  const first = { ...message("one", "第一位发言"), sender: "person-A", senderProfile: { nickname: "小青", remark: "甲" } };
  const second = { ...message("two", "第二位发言"), sender: "person-B", senderProfile: { nickname: "小青", remark: "乙" } };
  const renamed = { ...second, messageId: "more", text: "补充一条", senderProfile: { nickname: "小青", remark: "乙的新备注" } };
  await f.handle.receive(first);
  f.respond(() => f.requests.length === 2 ? { text: "", toolCalls: [{ id: "read-one", name: "first_action", arguments: "{}" }] } : answer());
  f.tool(async () => { toolEntered.resolve(); await releaseTool.promise; return { ok: true, result: "完成" }; });
  const turn = await open(f.handle, second);
  await toolEntered.promise;
  assert.equal((await turn.append(renamed)).status, "accepted");
  assert.equal((await turn.append({ ...renamed, senderProfile: { remark: "重投名称" } })).status, "duplicate");
  const nameless = { ...message("extra", "只提供账号"), sender: second.sender };
  assert.equal((await turn.append(nameless)).status, "accepted");
  releaseTool.resolve();
  assert.equal((await turn.result()).status, "sent");
  await f.channels.web(turn.sessionId, "从网页继续", () => {});
  const users = [first, second, renamed, nameless];
  const speaker = (messages: any[], body: string) => {
    const msg = messages.find(m => m.role === "user" && m.content.endsWith("\n" + body));
    assert.ok(msg, "expected user content: " + body);
    const match = /【本条用户发言人】([^\n]+)/.exec(msg.content);
    assert.ok(match);
    return JSON.parse(match[1]);
  };
  for (const [index, messages] of f.requests.entries()) {
    for (const item of users.slice(0, [1, 2, 4, 4][index])) {
      assert.deepEqual(speaker(messages, item.text),
        { account: "account", peer: "friend", sender: item.sender, ...item.senderProfile });
    }
    assert.ok(messages.filter(m => m.role === "assistant" || m.role === "tool").every(m => !m.content?.includes("【本条用户发言人】")));
    assert.doesNotMatch(JSON.stringify(messages), /重投名称/);
  }
  const last = f.requests.at(-1)!;
  assert.deepEqual(last.at(-1), { role: "user", content: "从网页继续" });
  assert.equal(f.calls.length, 1);
  const rows = await f.memory.readSession(turn.sessionId);
  assert.deepEqual(rows.filter(row => row.role === "user").map(row => [row.text, row.senderProfile]),
    [...users.map(item => [item.text, item.senderProfile]), ["从网页继续", undefined]]);
  assert.ok(rows.filter(row => row.role === "assistant" || row.type === "tool").every(row => !("senderProfile" in row)));
});

test("a queued turn accepts additions before its model slot and preserves input arrival times", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  await f.memory.saveSessionMeta("shared", {}); await f.handle.bind("friend", "shared");
  f.respond(async () => { if (f.requests.length === 1) { entered.resolve(); await gate.promise; } return answer(); });
  const foreground = f.sessions.chat("shared", "已有对话", () => {}); await entered.promise;
  const turn = await open(f.handle, message("queued", "排队的请求"));
  const receivedAfter = Date.now();
  assert.equal((await turn.append(message("queued-more", "排队时的补充"))).status, "accepted");
  await turn.closeInput();
  assert.equal(f.requests.length, 1);
  await new Promise(resolve => setTimeout(resolve, 15));
  const releasedAt = Date.now(); gate.resolve(); await foreground;
  assert.equal((await turn.result()).status, "sent");
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1]), /排队的请求/); assert.match(JSON.stringify(f.requests[1]), /排队时的补充/);
  const rows = (await f.memory.readSession("shared")).filter(row => row.type === "message" && row.role === "user");
  assert.deepEqual(rows.map(row => row.text), ["已有对话", "排队的请求", "排队时的补充"]);
  assert.ok(Date.parse(rows[2].ts) >= receivedAfter && Date.parse(rows[2].ts) < releasedAt);
});

test("input during a tool preserves the completed action and closes every tool-call protocol slot without starting later batch actions", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  f.respond(() => f.requests.length === 1 ? { text: "", toolCalls: [
    { id: "action-1", name: "first_action", arguments: "{}" },
    { id: "action-2", name: "second_action", arguments: "{}" },
  ] } : answer("已保留第一步，按补充结束"));
  f.tool(async () => { entered.resolve(); await gate.promise; return { ok: true, result: "第一步已确认成功" }; });
  const turn = await open(f.handle, message("tool", "执行两步")); await entered.promise;
  assert.equal((await turn.append(message("tool-more", "不要执行第二步"))).status, "accepted");
  gate.resolve();
  assert.equal((await turn.result()).status, "sent");
  assert.deepEqual(f.calls.map(call => call[0]), ["first_action"]);
  assert.equal(f.requests.length, 2);
  const next = f.requests[1], results = next.filter(row => row.role === "tool");
  assert.deepEqual(results.map(row => row.tool_call_id), ["action-1", "action-2"]);
  assert.match(String(results[0].content), /第一步已确认成功/);
  assert.match(String(results[1].content), /未执行|跳过|skip|supplement|追加/i);
  assert.match(JSON.stringify(next), /不要执行第二步/);
  assert.equal(f.deliveries.length, 1);
});

test("closeInput retains accepted additions and automatic finalization closes input before transport finishes", { timeout: 10000 }, async t => {
  const f = await fixture(t), modelEntered = deferred(), modelGate = f.gate(), sendEntered = deferred(), sendGate = f.gate();
  f.respond(async () => { if (f.requests.length === 1) { modelEntered.resolve(); await modelGate.promise; return answer("旧候选"); } return answer(); });
  f.send(async () => { sendEntered.resolve(); await sendGate.promise; });
  const turn = await open(f.handle, message("close")); await modelEntered.promise;
  await turn.append(message("accepted", "必须读到这条补充")); await turn.closeInput(); await turn.closeInput();
  assert.equal((await turn.append(message("late"))).status, "closed");
  modelGate.resolve(); await sendEntered.promise;
  assert.match(JSON.stringify(f.requests[1]), /必须读到这条补充/);
  assert.equal((await turn.append(message("too-late"))).status, "closed");
  sendGate.resolve(); await turn.result();
  const autoSendEntered = deferred(), autoSendGate = f.gate();
  f.send(async () => { autoSendEntered.resolve(); await autoSendGate.promise; });
  const automatic = await open(f.handle, message("automatic")); await autoSendEntered.promise;
  assert.equal((await automatic.append(message("after-final"))).status, "closed");
  autoSendGate.resolve(); await automatic.result();
  const rows = (await f.memory.readSession(turn.sessionId)).filter(row => row.type === "message");
  assert.equal(rows.some(row => ["late", "too-late", "after-final", "旧候选"].includes(row.text)), false);
});

test("leader and member duplicates share one result and stay linked after a fresh memory/channel instance", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  f.respond(async () => { if (f.requests.length === 1) { entered.resolve(); await gate.promise; } return answer(); });
  const first = message("leader", "主请求"), second = message("member", "补充请求");
  const turn = await open(f.handle, first); await entered.promise;
  const duplicate = await open(f.handle, first);
  assert.equal(duplicate.id, turn.id); assert.equal(duplicate.duplicate, true);
  assert.equal((await turn.append(second)).status, "accepted");
  assert.equal((await turn.append(second)).status, "duplicate");
  const legacyFollower = f.handle.receive(first), memberFollower = f.handle.receive(second);
  gate.resolve();
  const result = await turn.result();
  for (const repeated of [await duplicate.result(), await legacyFollower, await memberFollower]) {
    assert.equal(repeated.status, "sent"); assert.equal(repeated.deliveryId, result.deliveryId); assert.equal(repeated.duplicate, true);
  }
  const before = f.requests.length;
  const restarted = await f.restart();
  for (const input of [first, second]) {
    const repeated = await open(restarted.handle, input);
    assert.equal(repeated.id, turn.id); assert.equal(repeated.duplicate, true);
    const reopened = await repeated.result(), received = await restarted.handle.receive(input);
    const retried = await restarted.handle.retry(input.peer, input.messageId);
    for (const value of [reopened, received, retried]) {
      assert.equal(value.deliveryId, result.deliveryId); assert.equal(value.messageId, input.messageId); assert.equal(value.duplicate, true);
    }
  }
  assert.equal(f.requests.length, before); assert.equal(f.deliveries.length, 1);
});

test("retrying a member retries only its leader's failed delivery with the same delivery ID", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  f.respond(async () => { if (f.requests.length === 1) { entered.resolve(); await gate.promise; } return answer(); });
  f.send(async () => { throw Error("synthetic transport failure"); });
  const turn = await open(f.handle, message("retry-leader")); await entered.promise;
  await turn.append(message("retry-member")); gate.resolve();
  const failed = await turn.result();
  assert.equal(failed.status, "delivery_failed"); assert.equal(f.deliveries.length, 1);
  const count = f.requests.length, restarted = await f.restart();
  f.send(async () => {});
  const retried = await restarted.handle.retry("friend", "retry-member");
  assert.equal(retried.status, "sent"); assert.equal(retried.deliveryId, failed.deliveryId); assert.equal(retried.messageId, "retry-member");
  assert.equal(f.deliveries.length, 2); assert.equal(f.deliveries[1].replyTo, "retry-leader");
  assert.equal((await restarted.handle.retry("friend", "retry-leader")).duplicate, true);
  const confirmedMember = await restarted.handle.retry("friend", "retry-member");
  assert.equal(confirmedMember.duplicate, true); assert.equal(confirmedMember.messageId, "retry-member");
  assert.equal((await restarted.handle.receive(message("retry-member"))).duplicate, true);
  assert.equal(f.requests.length, count); assert.equal(f.deliveries.length, 2);
});

test("append validates sender, peer, message identity and text even when peers share the same session", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  await f.memory.saveSessionMeta("shared-input", {});
  await f.handle.bind("friend", "shared-input"); await f.handle.bind("other-peer", "shared-input");
  f.respond(async () => { if (f.requests.length === 1) { entered.resolve(); await gate.promise; } return answer(); });
  const turn = await open(f.handle, message("identity", "原始内容")); await entered.promise;
  await rejects(() => turn.append(message("cross-peer", "不能跨对象追加", "other-peer")), /同一|peer|对象/);
  await rejects(() => turn.append({ ...message("cross-sender"), sender: "someone-else" }), /同一|sender|发送者/);
  await rejects(() => turn.append(message("identity", "冒充同一消息")), /不一致|不同正文/);
  await rejects(() => open(f.handle, message("identity", "冒充初始输入")), /不一致/);
  await rejects(() => turn.append(message("oversized", "x".repeat(16001))), /16000|消息/);
  await rejects(() => turn.append(message("empty", "  ")), /消息|文本/);
  await rejects(() => turn.append({ ...message("forged"), origin: { plugin: "forged-owner" } } as any), /路由策略|来源|字段/);
  assert.equal((await turn.append(message("valid", "有效补充"))).status, "accepted");
  gate.resolve(); await turn.result();
  const rows = (await f.memory.readSession(turn.sessionId)).filter(row => row.type === "message" && row.role === "user");
  assert.deepEqual(rows.map(row => row.external_message_id), ["identity", "valid"]);
});

test("identical message IDs from separate peers bound to one session remain separate turns and deliveries", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = f.gate();
  await f.memory.saveSessionMeta("two-peers", {});
  await f.handle.bind("friend", "two-peers"); await f.handle.bind("other-peer", "two-peers");
  f.respond(async () => { if (f.requests.length === 1) { entered.resolve(); await gate.promise; } return answer(); });
  const first = await open(f.handle, message("same-id", "同一文本")); await entered.promise;
  const second = await open(f.handle, message("same-id", "同一文本", "other-peer"));
  assert.notEqual(first.id, second.id); assert.equal(first.sessionId, second.sessionId);
  assert.equal(second.duplicate, undefined);
  assert.equal((await second.append(message("same-member", "第二个对象的补充", "other-peer"))).status, "accepted");
  await second.closeInput(); gate.resolve();
  const results = await Promise.all([first.result(), second.result()]);
  assert.ok(results.every(result => result.status === "sent")); assert.notEqual(results[0].deliveryId, results[1].deliveryId);
  assert.deepEqual(f.deliveries.map(delivery => [delivery.peer, delivery.replyTo]), [["friend", "same-id"], ["other-peer", "same-id"]]);
  assert.equal(f.requests.length, 2);
  const rows = (await f.memory.readSession("two-peers")).filter(row => row.type === "message" && row.role === "user");
  assert.deepEqual(rows.map(row => [row.peer, row.external_message_id]), [["friend", "same-id"], ["other-peer", "same-id"], ["other-peer", "same-member"]]);
});

test("accepted inputs have finite count and character budgets; rejected excess never enters history", { timeout: 15000 }, async t => {
  const f = await fixture(t), firstEntered = deferred(), firstGate = f.gate();
  f.respond(async () => { if (f.requests.length === 1) { firstEntered.resolve(); await firstGate.promise; } return answer(); });
  const counted = await open(f.handle, message("count-0")); await firstEntered.promise;
  for (let index = 1; index < 128; index++) assert.equal((await counted.append(message("count-" + index))).status, "accepted");
  assert.equal((await counted.append(message("count-overflow"))).status, "full");
  assert.equal((await counted.append(message("count-1"))).status, "duplicate");
  firstGate.resolve(); await counted.result();
  const countRows = (await f.memory.readSession(counted.sessionId)).filter(row => row.type === "message" && row.role === "user");
  assert.equal(countRows.length, 128); assert.equal(countRows.some(row => row.text === "count-overflow"), false);
  const charEntered = deferred(), charGate = f.gate(); let calls = 0;
  f.respond(async () => { if (++calls === 1) { charEntered.resolve(); await charGate.promise; } return answer(); });
  const chars = await open(f.handle, message("chars-0", "0".repeat(16000), "chars-peer")); await charEntered.promise;
  for (let index = 1; index < 8; index++) assert.equal((await chars.append(message("chars-" + index, String(index).repeat(16000), "chars-peer"))).status, "accepted");
  assert.equal((await chars.append(message("chars-overflow", "x", "chars-peer"))).status, "full");
  charGate.resolve(); await chars.result();
  const charRows = (await f.memory.readSession(chars.sessionId)).filter(row => row.type === "message" && row.role === "user");
  assert.equal(charRows.length, 8); assert.equal(charRows.reduce((total, row) => total + row.text.length, 0), 128000);
});

test("caller cancellation and adapter disposal reject additions and suppress late model tools and delivery", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const mode of ["signal", "dispose"] as const) {
    const entered = deferred(), gate = f.gate(), controller = new AbortController(); let requestSignal: AbortSignal | undefined;
    f.respond(async input => {
      requestSignal = input.signal; entered.resolve(); await gate.promise;
      return { text: "不能留下的候选", toolCalls: [{ id: "late", name: "first_action", arguments: "{}" }] };
    });
    const turn = await open(f.handle, message(mode), controller.signal); await entered.promise;
    await turn.append(message(mode + "-accepted", "取消前已接纳"));
    if (mode === "signal") controller.abort(Error("synthetic cancel")); else f.handle.dispose();
    assert.equal(requestSignal!.aborted, true);
    assert.equal((await turn.append(message(mode + "-late"))).status, "cancelled");
    gate.resolve();
    assert.equal((await turn.result()).status, "generation_failed");
    const rows = await f.memory.readSession(turn.sessionId);
    assert.equal(rows.some(row => row.type === "message" && row.role === "assistant"), false);
    assert.equal(JSON.stringify(rows).includes("不能留下的候选"), false);
    assert.ok(rows.some(row => row.type === "channel_receipt" && row.external_message_id === mode + "-accepted" && row.input_text === "取消前已接纳"),
      "cancellation must retain durable evidence of every accepted addition");
  }
  assert.equal(f.calls.length, 0); assert.equal(f.deliveries.length, 0);
  await rejects(() => open(f.handle, message("after-dispose")), /已停用/);
});

async function isolatedFixture(t: TestContext) {
  const root = await temporaryDirectory("whale-channel-turn-rpc-");
  let app: any;
  const gates: (() => void)[] = [];
  t.after(async () => { gates.forEach(release => release()); await app?.close(); });
  await mkdir(join(root, "config"));
  const plugin = join(root, "plugins", "turn-rpc"); await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "plugin.yaml"), "id: turn-rpc\nname: Turn RPC fixture\ndescription: Isolated channel turn contract\nversion: 1.0.0\napiVersion: \"1\"\n");
  await writeFile(join(plugin, "index.ts"), `export function apply(ctx) {
    const turns = new Map(), deliveries = [];
    const channel = ctx.channels.register({ id: 'rpc-channel', account: 'fixture', persona: 'a', permission: 'full',
      async send(message) { deliveries.push(message); } });
    ctx.tools.registerTransient({ name: 'rpc_temporary_read', description: 'Temporary fixture material', schema: {}, danger: 'safe',
      run: async () => ({ content: ${JSON.stringify(privateToolText)}, receipt: { action: 'read', count: 1 } }) });
    ctx.provide('turn-rpc', {
      pid: () => process.pid,
      supportsSenderProfile: () => channel.supportsSenderProfile === true,
      receive: message => channel.receive(message),
      async open(name, message, signal) {
        const turn = await channel.openTurn(message, { signal }); turns.set(name, turn);
        return { id: turn.id, sessionId: turn.sessionId, duplicate: turn.duplicate };
      },
      append: (name, message) => turns.get(name).append(message),
      close: name => turns.get(name).closeInput(),
      result: name => turns.get(name).result(),
      deliveries: () => deliveries,
    });
  }`);
  await writeFile(join(root, "a.md"), "隔离测试人格");
  await writeFile(join(root, "config", "config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", name: "Test", provider: "test", model: "test", type: "chat", context_window: 32000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  assert.equal(app.runtime.records.get("turn-rpc")?.status, "active");
  const api = app.runtime.services.get("turn-rpc").value;
  assert.notEqual(await api.pid(), process.pid, "fixture must execute through loadPath in a separate process");
  const requests: any[][] = [];
  let respond: (input: any) => any = () => answer();
  app.llm.chat = async (input: any) => { requests.push(structuredClone(input.messages)); return respond(input); };
  return { root, app, api, requests, respond: (fn: typeof respond) => { respond = fn; },
    gate: () => { const gate = deferred(); gates.push(gate.resolve); return gate; } };
}

test("an isolated installed plugin uses open, append, close and result through the real RPC lifecycle", { timeout: 15000 }, async t => {
  const f = await isolatedFixture(t), entered = deferred(), gate = f.gate();
  f.respond(async () => { if (f.requests.length === 1) { entered.resolve(); await gate.promise; return answer("RPC旧候选"); } return answer("RPC最终回复"); });
  const turn = await f.api.open("one", message("rpc-first", "RPC原始输入")); await entered.promise;
  assert.equal(typeof turn.id, "string"); assert.equal(typeof turn.sessionId, "string");
  assert.equal((await f.api.append("one", message("rpc-second", "RPC追加输入"))).status, "accepted");
  await f.api.close("one");
  assert.equal((await f.api.append("one", message("rpc-closed"))).status, "closed");
  gate.resolve();
  const result = await f.api.result("one");
  assert.equal(result.status, "sent"); assert.equal(result.text, "RPC最终回复");
  assert.equal((await f.api.result("one")).deliveryId, result.deliveryId);
  assert.equal(f.requests.length, 2); assert.match(JSON.stringify(f.requests[1]), /RPC追加输入/);
  assert.equal((await f.api.deliveries()).length, 1);
  const rows = (await f.app.memory.readSession(turn.sessionId)).filter((row: any) => row.type === "message");
  assert.deepEqual(rows.map((row: any) => row.text), ["RPC原始输入", "RPC追加输入", "RPC最终回复"]);
  assert.ok(rows.every((row: any) => row.origin.plugin === "turn-rpc"));
});

test("an isolated channel snapshots each sender profile once across receive, openTurn and append", { timeout: 15000 }, async t => {
  const f = await isolatedFixture(t);
  assert.equal(await f.api.supportsSenderProfile(), true);
  const first = message("first-profile", "第一条");
  const sameIdDifferentProfile = { ...first, senderProfile: { nickname: "重投时的昵称" } };
  const firstResult = await f.api.receive({ ...first, senderProfile: {
    nickname: " \u202e旧\u200b名\r\n称 ", remark: "🌙".repeat(70), sender: "伪造账号", permission: "伪造权限",
  } });
  assert.equal((await f.api.receive(sameIdDifferentProfile)).duplicate, true);

  const entered = deferred(), gate = f.gate();
  f.respond(async () => { entered.resolve(); await gate.promise; return answer(); });
  const start = message("group-profile", "轮内第一条");
  const turn = await f.api.open("turn", { ...start, senderProfile: { remark: "首条备注" } });
  await entered.promise;
  assert.equal((await f.api.open("duplicate", { ...start, senderProfile: { remark: "改名重开" } })).duplicate, true);
  const member = message("append-profile", "轮内第二条");
  assert.equal((await f.api.append("turn", { ...member, senderProfile: { nickname: "第二条昵称" } })).status, "accepted");
  assert.equal((await f.api.append("turn", { ...member, senderProfile: { nickname: "改名重投" } })).status, "duplicate");
  assert.equal((await f.api.append("turn", { ...message("blank-profile"), senderProfile: { remark: "\t\u202e", nickname: 123 } })).status, "accepted");
  await f.api.close("turn"); gate.resolve();
  assert.equal((await f.api.result("turn")).status, "sent");
  assert.equal((await f.api.receive({ ...member, senderProfile: { nickname: "完成后变更" } })).duplicate, true);
  assert.equal(firstResult.sessionId, turn.sessionId);
  assert.equal((await f.api.deliveries()).length, 2);
  assert.equal(f.requests.length, 3);

  const rows = await f.app.memory.readSession(turn.sessionId);
  const messages = rows.filter((row: any) => row.type === "message" && row.role === "user");
  assert.deepEqual(messages.map((row: any) => [row.text, row.sender, row.senderProfile]), [
    [first.text, "human", { nickname: "旧名 称", remark: "🌙".repeat(64) }],
    [start.text, "human", { remark: "首条备注" }], [member.text, "human", { nickname: "第二条昵称" }],
    ["blank-profile", "human", undefined],
  ]);
  const reservedMembers = rows.filter((row: any) => row.type === "channel_receipt" && row.group_message_id === start.messageId);
  assert.deepEqual(reservedMembers.map((row: any) => row.input_sender_profile), [{ nickname: "第二条昵称" }, undefined]);
  const stored = JSON.stringify(rows);
  for (const ignored of ["重投时的昵称", "伪造账号", "伪造权限", "改名重开", "改名重投", "完成后变更"]) assert.ok(!stored.includes(ignored));
});

test("a caller signal crosses the isolated plugin RPC boundary and cancels its open turn", { timeout: 15000 }, async t => {
  const f = await isolatedFixture(t), entered = deferred(), gate = f.gate(), controller = new AbortController();
  let modelSignal: AbortSignal | undefined;
  f.respond(async input => { modelSignal = input.signal; entered.resolve(); await gate.promise; return answer("RPC取消后的候选"); });
  const turn = await f.api.open("cancel", message("rpc-cancel"), controller.signal); await entered.promise;
  assert.equal((await f.api.append("cancel", message("rpc-before-cancel"))).status, "accepted");
  controller.abort(Error("RPC caller cancelled")); await until(() => modelSignal?.aborted === true);
  assert.equal((await f.api.append("cancel", message("rpc-after-cancel"))).status, "cancelled");
  gate.resolve();
  assert.equal((await f.api.result("cancel")).status, "generation_failed");
  assert.equal((await f.api.deliveries()).length, 0);
  const rows = await f.app.memory.readSession(turn.sessionId);
  assert.equal(rows.some((row: any) => row.type === "message" && row.role === "assistant"), false);
  assert.equal(JSON.stringify(rows).includes("RPC取消后的候选"), false);
  assert.equal(f.app.runtime.records.get("turn-rpc")?.status, "active");
});

test("an unfinished member receipt holds finalization; input after a transient tool remains ordinary history without retaining tool material", { timeout: 15000 }, async t => {
  const f = await isolatedFixture(t), modelEntered = deferred(), modelGate = f.gate(), writeEntered = deferred(), writeGate = f.gate();
  f.respond(async () => {
    if (f.requests.length === 1) return { text: "", toolCalls: [{ id: "private-read", name: "rpc_temporary_read", arguments: "{}" }] };
    if (f.requests.length === 2) { modelEntered.resolve(); await modelGate.promise; return answer("写入完成前的旧候选"); }
    return answer("已按补充完成");
  });
  const turn = await f.api.open("persist", message("persist-leader", "请读取临时资料")); await modelEntered.promise;
  assert.match(JSON.stringify(f.requests[1]), new RegExp(privateToolText), "temporary material must actually reach the model for this privacy test");
  const appendEvent = f.app.memory.appendEvent.bind(f.app.memory);
  f.app.memory.appendEvent = async (row: any) => {
    if (row.type === "channel_receipt" && row.external_message_id === "persist-member") {
      writeEntered.resolve(); await writeGate.promise;
    }
    return appendEvent(row);
  };
  const append = f.api.append("persist", message("persist-member", "用户刚刚补充的真实要求")); await writeEntered.promise;
  let settled = false;
  const result = f.api.result("persist").then((value: any) => { settled = true; return value; });
  modelGate.resolve();
  await until(async () => (await f.app.memoryEngine.state(turn.sessionId)).usage.chat.requests === 2); await tick();
  assert.equal(settled, false); assert.equal(f.requests.length, 2); assert.equal((await f.api.deliveries()).length, 0);
  assert.equal((await f.app.memory.readSession(turn.sessionId)).some((row: any) => row.type === "message" && row.role === "assistant"), false);
  writeGate.resolve(); assert.equal((await append).status, "accepted");
  assert.equal((await result).status, "sent"); assert.equal(f.requests.length, 3);
  assert.match(JSON.stringify(f.requests[2]), /用户刚刚补充的真实要求/);
  const rows = await f.app.memory.readSession(turn.sessionId), humans = rows.filter((row: any) => row.type === "message" && row.role === "user");
  assert.deepEqual(humans.map((row: any) => row.text), ["请读取临时资料", "用户刚刚补充的真实要求"]);
  assert.ok(humans.every((row: any) => !row.transient && row.origin.plugin === "turn-rpc"));
  assert.deepEqual(rows.filter((row: any) => row.type === "message" && row.role === "assistant").map((row: any) => row.text), ["已按补充完成"]);
  assert.equal((await f.api.deliveries()).length, 1);
  const next = await f.api.open("next", message("next-private-check", "继续按刚才的要求")); await f.api.result("next");
  assert.equal(next.sessionId, turn.sessionId);
  assert.equal(JSON.stringify(f.requests.at(-1)).includes(privateToolText), false);
  assert.match(JSON.stringify(f.requests.at(-1)), /用户刚刚补充的真实要求/);
  await f.app.runtime.events.drain();
  for (const name of ["memory", "logs"]) {
    const stored = await diskText(join(f.root, name));
    assert.equal(stored.includes(privateToolText), false, name + " must not retain temporary tool material");
    assert.equal(stored.includes("写入完成前的旧候选"), false, name + " must not retain a discarded candidate");
  }
});

test("failed member persistence cancels the whole turn and cannot confirm duplicate appends or deliver its stale candidate", { timeout: 10000 }, async t => {
  const f = await fixture(t), modelEntered = deferred(), modelGate = f.gate(), writeEntered = deferred(), writeGate = f.gate();
  f.respond(async () => { modelEntered.resolve(); await modelGate.promise; return answer("持久化失败时的旧候选"); });
  const turn = await open(f.handle, message("failed-write-leader")); await modelEntered.promise;
  const appendEvent = f.memory.appendEvent.bind(f.memory);
  f.memory.appendEvent = async (row: any) => {
    if (row.type === "channel_receipt" && row.external_message_id === "failed-write-member") {
      writeEntered.resolve(); await writeGate.promise; throw Error("synthetic member receipt failure");
    }
    return appendEvent(row);
  };
  const member = message("failed-write-member", "尚未确认写入的补充");
  const append = assert.rejects(turn.append(member), /synthetic member receipt failure/); await writeEntered.promise;
  const duplicate = assert.rejects(turn.append(member), /synthetic member receipt failure/);
  modelGate.resolve();
  await until(async () => (await f.engine.state(turn.sessionId)).usage.chat.requests === 1); await tick();
  assert.equal(f.deliveries.length, 0);
  writeGate.resolve(); await Promise.all([append, duplicate]);
  assert.equal((await turn.result()).status, "generation_failed");
  assert.equal((await turn.append(message("after-write-failure"))).status, "cancelled");
  const replay = await f.handle.receive(member);
  assert.equal(replay.status, "generation_failed"); assert.equal(replay.duplicate, true);
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 0);
  const rows = await f.memory.readSession(turn.sessionId);
  assert.equal(rows.some(row => row.type === "message" && row.role === "assistant"), false);
  assert.equal(JSON.stringify(rows).includes("持久化失败时的旧候选"), false);
  assert.equal(f.sessions.locks.size, 0); assert.equal(f.sessions.channelOperations.size, 0);
});
