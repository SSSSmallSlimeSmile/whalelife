/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Channels } from "../core/channels.ts";
import type { ChannelImage, IncomingMessageData } from "../core/plugin-api.ts";
import { Memory } from "../core/memory.ts";
import { Sessions } from "../core/session.ts";
import { TurnInput } from "../core/turn-input.ts";
import { CHANNEL_IMAGE_LIMITS, channelImagesArePrivate } from "../core/channel-images.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

function picture(tail: number, bytes = 12): ChannelImage {
  const data = Buffer.alloc(bytes, tail);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return { type: "image", mimeType: "image/png", data };
}
function member(messageId: string, images: ChannelImage[]) {
  return { messageId, text: "", images, receivedAt: "2026-11-24T00:00:00Z", timezone: "Asia/Shanghai" };
}

test("channel image additions reserve their share, roll back failures and retain identity after consumption", async () => {
  const initial = () => member("root", [picture(1)]);
  const inbox = new TurnInput(initial(), new AbortController().signal);
  const remaining = Array.from({ length: CHANNEL_IMAGE_LIMITS.images - 1 }, () => picture(2));
  await assert.rejects(inbox.append(member("n", remaining), async () => { throw Error("failed write"); }), /failed write/);
  const admitted = member("n", remaining);
  assert.equal((await inbox.append(admitted)).status, "accepted");
  admitted.images[0].data[10] = 9;
  const [taken] = await inbox.take();
  assert.equal(taken.images?.[0].data[10], 2);
  assert.equal((await inbox.append(initial())).status, "duplicate");
  assert.equal((await inbox.append(member("n", taken.images!))).status, "duplicate");
  await assert.rejects(inbox.append(admitted), /不同正文或图片/);
  assert.equal((await inbox.append(member("extra", [picture(3)]))).status, "full");

  const limit = CHANNEL_IMAGE_LIMITS.imageBytes;
  const bytes = new TurnInput(member("first", [picture(3, limit), picture(3, limit)]), new AbortController().signal);
  assert.equal((await bytes.append(member("remaining", [picture(4, limit), picture(4, limit)]))).status, "accepted");
  await bytes.take();
  assert.equal((await bytes.append(member("beyond", [picture(5)]))).status, "full");
});

test("receipt replay checks original images and preserves the legacy text fingerprint", async t => {
  const root = await temporaryDirectory("whale-channel-image-in-");
  const logger = { info() {}, warn() {}, error() {} } as any;
  const memory = new Memory(join(root, "memory"), logger);
  const config = { personas: { a: {} }, channels: { web: { persona: "a" } } };
  const sessions = new Sessions(root, config, { memory, logger });
  const channels = new Channels(memory, sessions, config);
  t.after(async () => { await channels.close(); await sessions.close(); });
  await memory.init();
  let runs = 0;
  const sends: string[] = [];
  sessions.dispatchIncoming = async (id, route, run) => run(async text => {
    runs++;
    assert.equal(route.persona, "a");
    if (route.images?.length) {
      assert.equal(route.images[0].data[10], 7);
      assert.equal(text, "");
    }
    return "answer";
  }, { transient: false });
  const channel = channels.register({ id: "mock", account: "account", persona: "a", send: async reply => { sends.push(reply.text); } });
  assert.equal(channel.supportsImageInput, true);
  const imageMessage = (): IncomingMessageData => ({ messageId: "image", sender: "person", peer: "room", text: "", images: [picture(7)] });
  const original = imageMessage(), sending = channel.receive(original);
  original.images![0].data[10] = 9;
  const sent = await sending;
  assert.equal(sent.status, "sent");
  assert.equal((await channel.receive(imageMessage())).duplicate, true);
  assert.equal((await channel.openTurn!(imageMessage())).duplicate, true);
  assert.equal((await channel.retry("room", "image")).duplicate, true);
  await assert.rejects(channel.receive(original), /内容不一致/);
  await assert.rejects(channel.openTurn!(original), /内容不一致/);
  const legacy = { messageId: "old", sender: "person", peer: "room", text: "hello" };
  await channel.receive(legacy);
  assert.equal((await channel.receive({ ...legacy, images: [] })).duplicate, true);
  const rows = await memory.readSession(sent.sessionId);
  const old = rows.find(row => row.type === "channel_receipt" && row.external_message_id === "old");
  assert.equal(old?.fingerprint, createHash("sha256").update(JSON.stringify(["person", "hello"])).digest("hex"));
  assert.ok(!JSON.stringify(rows).includes(Buffer.from(picture(7).data).toString("base64")));
  assert.ok(rows.every(row => !Object.hasOwn(row, "images")));
  assert.deepEqual(sends, ["answer", "answer"]);
  assert.equal(runs, 2);
  const echo = { ...imageMessage(), messageId: "echo", text: Buffer.from(picture(7).data).toString("base64") };
  await assert.rejects(Promise.resolve().then(() => channel.receive(echo)), /原始编码/);
  assert.ok(!(await memory.readSession(sent.sessionId)).some(row => row.external_message_id === "echo"));
});

test("a cancelled channel stops waiting for even an uncooperative image describer", { timeout: 5000 }, async t => {
  const root = await temporaryDirectory("whale-channel-image-abort-");
  const logger = { warn() {}, info() {}, error() {} } as any;
  const memory = new Memory(root, logger);
  const config = { personas: { a: {} }, channels: { web: { persona: "a" } } };
  const sessions = new Sessions(root, config, { memory, logger });
  const channels = new Channels(memory, sessions, config);
  t.after(async () => { await channels.close(); await sessions.close(); });
  await memory.init();
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  sessions.dispatchIncoming = async (id, route, run) => run(async () => {
    return route.describeImages!(route.messageId!, route.images!, route.signal!);
  }, { transient: false });
  let lateReject!: (error: Error) => void;
  const channel = channels.register({ id: "mock", persona: "a", account: "account",
    send: async () => { assert.fail("cancelled reply sent"); },
    describeImages: async ({ messageId, images, peer }, { signal }) => {
      assert.ok(channelImagesArePrivate());
      assert.equal(peer, "p");
      assert.equal(messageId, "cancel");
      assert.equal(images[0].data[10], 4);
      assert.equal(signal.aborted, false);
      entered();
      return new Promise<string>((_, reject) => { lateReject = reject; });
    } });
  const controller = new AbortController();
  const result = channel.receive({ peer: "p", sender: "s", messageId: "cancel", text: "", images: [picture(4)] }, { signal: controller.signal });
  await started;
  controller.abort();
  assert.equal((await result).status, "generation_failed");
  lateReject(Error("late provider rejection"));
});
