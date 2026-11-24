/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Channels } from "../core/channels.ts";
import { Diagnostics } from "../core/diagnostics.ts";
import { Memory } from "../core/memory.ts";
import { ModelImageInputUnsupportedError } from "../core/model-http.ts";
import { Sessions } from "../core/session.ts";
import type { ChannelImage, ToolContentPart } from "../core/plugin-api.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const answer = (text: string) => ({ text, toolCalls: [] });
const picture = (mark: number): ChannelImage => ({
  type: "image", mimeType: "image/png", data: Buffer.from([137,80,78,71,13,10,26,10,mark]),
});
const incoming = (messageId: string, text: string, images?: ChannelImage[]) => ({
  sender: "alice", peer: "friend", messageId, text, images,
});
const imageMessages = (request: any[]) => request.filter(message => Array.isArray(message.content));
const toolCall = { name: "write_note", arguments: "{}", id: "t1" };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, diagnosticDirectory?: string) {
  const root = await temporaryDirectory("whale-channel-images-");
  await writeFile(join(root, "p.md"), "image-test-persona");
  const config = {
    providers: [{ id: "model", model: "chat", base_url: "https://unused.invalid", context_window: 32000 }],
    personas: { p: { name: "P", file: "p.md", provider: "model", permission: "full" } },
    channels: { web: { persona: "p", permission: "full" } }, memory: { include_summary: false },
  };
  const logger: any = { info() {}, warn() {}, error() {} };
  const diagnostics = new Diagnostics(root, { enabled: !!diagnosticDirectory, directory: diagnosticDirectory }, logger);
  t.after(() => diagnostics.close());
  await diagnostics.initialize();
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const requests: any[][] = [], sends: string[] = [], descriptions: string[] = [];
  let effects = 0;
  const behavior = {
    model: async (_number: number): Promise<any> => answer("final reply"),
    describe: async (id: string): Promise<string> => "auxiliary details for " + id,
    toolMedia: [] as ToolContentPart[],
  };
  const tools = {
    list: () => [{ type: "function", function: { name: "write_note", parameters: { type: "object" } } }],
    call: async () => { effects++; return { ok: true, result: "written" }; },
    multimodal: () => behavior.toolMedia.length ? { content: behavior.toolMedia, signal: new AbortController().signal } : undefined,
  };
  const llm = { chat: async ({ messages }: any) => {
    requests.push(structuredClone(messages));
    return behavior.model(requests.length);
  } };
  const sessions = new Sessions(root, config, { memory, llm, tools, logger, diagnostics });
  const channels = new Channels(memory, sessions, config);
  t.after(async () => { await channels.close(); await sessions.close(); });
  const handle = channels.register({
    id: "example", account: "bot", persona: "p", permission: "full",
    async send(message) { sends.push(message.text); },
    async describeImages({ messageId }) { descriptions.push(messageId); return behavior.describe(messageId); },
  });
  await memory.saveSessionMeta("shared", {});
  await handle.bind("friend", "shared");
  return { memory, handle, requests, sends, descriptions, behavior, diagnostics, effects: () => effects };
}

test("native channel images share the user's message and remain outside later history", async t => {
  const f = await fixture(t);
  const first = await f.handle.receive(incoming("first", "what is here?", [picture(5), picture(6)]));
  assert.equal(first.status, "sent");
  assert.equal(imageMessages(f.requests[0]).length, 1);
  const { role, content } = imageMessages(f.requests[0])[0];
  assert.equal(role, "user");
  assert.match(content[0].text, /what is here\?/);
  assert.deepEqual(content.slice(1).map((part: any) => part.image_url.url),
    [picture(5), picture(6)].map(image => "data:image/png;base64," + Buffer.from(image.data).toString("base64")));
  await f.handle.receive(incoming("second", "continue"));
  assert.equal(imageMessages(f.requests[1]).length, 0);
  assert.deepEqual(f.descriptions, []);
  assert.doesNotMatch(JSON.stringify(await f.memory.readSession("shared")), /data:image|iVBORw0KGgo/);
});

test("unsupported appended pictures fall back once per input without replaying a completed action", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const afterTool = gate(), releaseModel = gate();
  const inFallback = gate(), releaseFallback = gate();
  t.after(() => { releaseModel.resolve(); releaseFallback.resolve(); });
  f.behavior.model = async number => {
    if (number === 1) return { text: "", toolCalls: [toolCall] };
    if (number === 2) { afterTool.resolve(); await releaseModel.promise; return answer("obsolete"); }
    if (number === 3) throw new ModelImageInputUnsupportedError("no vision");
    return answer("final reply");
  };
  f.behavior.describe = async id => {
    if (id === "pic1") { inFallback.resolve(); await releaseFallback.promise; }
    return "auxiliary details for " + id;
  };
  const turn = await f.handle.openTurn!(incoming("start", "write a note"));
  await afterTool.promise;
  assert.equal((await turn.append(incoming("pic1", "caption one", [picture(1)]))).status, "accepted");
  releaseModel.resolve();
  await inFallback.promise;
  assert.equal((await turn.append(incoming("pic1", "caption one", [picture(1)]))).status, "duplicate");
  assert.equal((await turn.append(incoming("pic2", "", [picture(2)]))).status, "accepted");
  releaseFallback.resolve();
  const result = await turn.result();
  assert.equal(result.status, "sent", result.error);
  assert.deepEqual(f.descriptions, ["pic1", "pic2"]);
  assert.deepEqual(f.sends, ["final reply"]);
  assert.equal(f.effects(), 1);
  assert.equal(f.requests.length, 4);
  assert.equal(imageMessages(f.requests[2]).length, 1);
  const rebuilt = f.requests[3];
  assert.equal(imageMessages(rebuilt).length, 0);
  assert.equal(rebuilt.filter(m => m.role === "tool" && m.tool_call_id === "t1").length, 1);
  assert.match(rebuilt.at(-2).content, /caption one[\s\S]*auxiliary details for pic1/);
  assert.match(rebuilt.at(-1).content, /图片 1 张[\s\S]*auxiliary details for pic2/);
  const rows = await f.memory.readSession("shared");
  assert.doesNotMatch(JSON.stringify(rows), /auxiliary details|iVBORw0KGgo|obsolete/);
  assert.equal(rows.filter((r: any) => r.type === "message" && r.role === "user").length, 3);
});

test("a model error on a batch also containing tool media does not invoke a channel fallback", async t => {
  const f = await fixture(t);
  f.behavior.toolMedia = [picture(23)];
  f.behavior.model = async number => {
    if (number === 1) return { text: "", toolCalls: [toolCall] };
    throw new ModelImageInputUnsupportedError("no vision");
  };
  assert.equal((await f.handle.receive(incoming("1", "do it", [picture(13)]))).status, "generation_failed");
  assert.equal(f.effects(), 1);
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.descriptions, []);
});

test("diagnostic tool attachments omit channel image echoes while retaining unrelated tool media", async t => {
  const directory = await temporaryDirectory("whale-channel-image-diagnostics-");
  const f = await fixture(t, directory);
  assert.equal(f.diagnostics.enabled, true);
  const original = picture(1), independent = picture(77);
  const raw = Buffer.from(original.data).toString("base64");
  f.behavior.toolMedia = [original, independent, { type: "text", text: "input repeated: " + raw },
    { type: "text", text: "independent tool caption" }];
  f.behavior.model = async number => number === 1 ? { text: "", toolCalls: [toolCall] } : answer("done");
  const result = await f.handle.receive(incoming("one", "compare", [original]));
  assert.equal(result.status, "sent", result.error);
  assert.match(JSON.stringify(f.requests[1].at(-1)), /input repeated/);
  await f.diagnostics.flush();
  const files = await readdir(join(directory, "attachments"));
  assert.deepEqual(files, [createHash("sha256").update(independent.data).digest("hex")]);
  const events = (await Promise.all((await readdir(directory)).filter(file => /\.(?:jsonl|ndjson)$/.test(file))
    .map(file => readFile(join(directory, file), "utf8")))).join("\n");
  assert.match(events, /independent tool caption/);
  assert.ok(!events.includes(raw));
});

test("the fallback reply cannot execute a previous tool call ID a second time", async t => {
  const f = await fixture(t);
  f.behavior.model = async number => {
    if (number === 2) throw new ModelImageInputUnsupportedError("no vision");
    return { text: "", toolCalls: [toolCall] };
  };
  const result = await f.handle.receive(incoming("photo", "do it", [picture(17)]));
  assert.equal(result.status, "generation_failed");
  assert.match(result.error!, /重复返回已处理/);
  assert.equal(f.effects(), 1);
  assert.deepEqual(f.descriptions, ["photo"]);
  assert.deepEqual(f.sends, []);
  assert.equal(f.requests.length, 3);
});

test("a failing auxiliary callback returns a safe reason and never generates or sends a substitute", async t => {
  const f = await fixture(t);
  f.behavior.model = async () => { throw new ModelImageInputUnsupportedError("no vision"); };
  f.behavior.describe = async () => { throw Error("SYNTHETIC_PRIVATE_CALLBACK_ERROR"); };
  const result = await f.handle.receive(incoming("photo", "", [picture(90)]));
  assert.equal(result.status, "generation_failed");
  assert.equal(result.error, "渠道辅助识图失败，未生成本轮回复");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.descriptions, ["photo"]);
  assert.doesNotMatch(JSON.stringify(await f.memory.readSession("shared")), /SYNTHETIC_PRIVATE_CALLBACK_ERROR/);
});

test("echoed image bytes cannot enter tool arguments, assistant history or a delivery", async t => {
  const f = await fixture(t), image = picture(84);
  const encoded = Buffer.from(image.data).toString("base64");
  f.behavior.model = async () => ({ text: "do it", toolCalls: [{ ...toolCall, arguments: JSON.stringify({ data: encoded }) }] });
  assert.equal((await f.handle.receive(incoming("1", "view", [image]))).status, "generation_failed");
  assert.equal(f.effects(), 0);
  assert.deepEqual(f.sends, []);
  assert.ok(!JSON.stringify(await f.memory.readSession("shared")).includes(encoded));
});
