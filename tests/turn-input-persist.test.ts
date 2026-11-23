import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const load = () => import(new URL("../core/turn-input.ts", import.meta.url).href);
const webSource = () => readFile(new URL("../core/web.ts", import.meta.url), "utf8");
const appSource = () => readFile(new URL("../core/ui/app.js", import.meta.url), "utf8");

const msg = (id: string, text = "补充一条") => ({
  messageId: id,
  text,
  receivedAt: "2026-11-23T00:00:00.000Z",
  timezone: "Asia/Shanghai",
});

test("补充在接收时就落盘，不必等到消费方 take", async () => {
  const { TurnInput } = await load();
  const saved: string[] = [];
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  input.setPersister(async (message: { text: string }) => { saved.push(message.text); });
  const result = await input.append(msg("a", "排队时的补充"));
  assert.equal(result.status, "accepted");
  // 还没 take，但已经写下去了：模型报错或取消也不会丢
  assert.deepEqual(saved, ["排队时的补充"]);
  assert.equal(input.persisted("a"), true);
  assert.deepEqual((await input.take()).map((m: { text: string }) => m.text), ["排队时的补充"]);
});

test("排队中的轮次还没有 persister，消费方得自己补写", async () => {
  const { TurnInput } = await load();
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  assert.equal((await input.append(msg("b"))).status, "accepted");
  assert.equal(input.persisted("b"), false);
});

test("渠道回执先写，被拒时不留历史行", async () => {
  const { TurnInput } = await load();
  const order: string[] = [];
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  input.setPersister(async () => { order.push("row"); });
  await input.append(msg("ok"), async () => { order.push("receipt"); });
  assert.deepEqual(order, ["receipt", "row"]);

  const rejected = new TurnInput(msg("seed2", "开场"), new AbortController().signal);
  const second: string[] = [];
  rejected.setPersister(async () => { second.push("row"); });
  await assert.rejects(() => rejected.append(msg("bad"), async () => { throw Error("此消息已经属于其他轮次"); }));
  assert.deepEqual(second, []);
  assert.equal(rejected.persisted("bad"), false);
});

test("被丢弃的那段回复会通知界面撤掉", async () => {
  const { TurnInput } = await load();
  const input = new TurnInput(msg("seed", "开场"), new AbortController().signal);
  let resets = 0;
  input.setResetHandler(() => { resets++; });
  input.notifyReset();
  assert.equal(resets, 1);
});

test("信箱按轮登记，不按会话：同一会话的两轮各有各的 turn id", async () => {
  const source = await webSource();
  // 开轮时登记 turn id 并告诉前端
  assert.match(source, /const turnId = "t_" \+ randomBytes\(8\)\.toString\("hex"\);/);
  assert.match(source, /webInboxes\.set\(turnId, inbox\);/);
  assert.match(source, /send\(\{ type: "started", turn: turnId \}\);/);
  // 补充按 turn 找信箱，找不到才退回会话
  assert.match(source, /const inbox = turnId \? webInboxes\.get\(turnId\) : undefined;/);
  assert.doesNotMatch(source, /webInboxes\.get\(String\(data\.session/);
  // 收尾按 turn 清
  assert.match(source, /webInboxes\.delete\(turnId\);/);
});

test("前端记住本轮的 turn id，并把没进去的补充放回输入框", async () => {
  const source = await appSource();
  assert.match(source, /this\.turn = typeof data\.turn === "string" \? data\.turn : null;/);
  assert.match(source, /JSON\.stringify\(\{ append: true, session: this\.state\.session, turn: this\.turn, text \}\)/);
  assert.match(source, /this\.pendingNudge = \{ text, index: this\.state\.messages\.length - 1 \};/);
  assert.ok(source.includes('$("chat-input").value = pending.text;'));
  assert.match(source, /if \(data\.type === "reset"\)/);
});
