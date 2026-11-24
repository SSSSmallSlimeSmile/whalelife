/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Diagnostics } from "../core/diagnostics.ts";
import { LLM } from "../core/llm.ts";
import { withModelResponse } from "../core/model-http.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const logger: any = { info() {}, warn() {}, error() {} };
const provider = { id: "synthetic-provider", model: "synthetic-chat", protocol: "openai-compatible",
  base_url: "https://unused.invalid/v1", api_key: "synthetic-new-key-never-disclose" };
const input = { provider, messages: [{ role: "user", content: "合成模型请求" }] };
const frame = (value: any) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
function stream(values: any[], width = Infinity) {
  const data = new TextEncoder().encode(values.map(frame).join(""));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < data.length; offset += width) controller.enqueue(data.slice(offset, offset + width));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const simple = () => stream([{ choices: [{ delta: { content: "合成回答" }, finish_reason: "stop" }] }, "[DONE]"]);
const kinds = (events: any[], kind: string) => events.filter(event => event.kind === kind);
async function fixture(t: TestContext, enabled = true) {
  const base = await temporaryDirectory("whale-model-diagnostics-"), root = join(base, "app"), directory = join(base, "capture");
  await mkdir(root);
  const diagnostics = new Diagnostics(root, { enabled, directory }, logger, () => []);
  t.after(() => diagnostics.close());
  await diagnostics.initialize();
  const llm = new LLM(logger); llm.diagnostics = diagnostics;
  const events = async () => {
    await diagnostics.flush();
    let files: string[];
    try { files = await readdir(directory); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    const rows = (await Promise.all(files.filter(file => /\.(jsonl|ndjson)$/.test(file)).map(async file =>
      (await readFile(join(directory, file), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))))).flat();
    return rows.sort((a, b) => a.sequence - b.sequence);
  };
  return { diagnostics, llm, events, directory };
}

test("private channel image requests retain usage but never archive the image, vendor echoes or attachments", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from("synthetic channel image payload");
  const encoded = bytes.toString("base64"), url = "data:image/png;base64," + encoded;
  const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 8 } };
  const options = { provider, privateChannelImages: true, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(typeof init?.body === "string" && init.body.includes(encoded));
    if (++requests === 1) return stream([{ choices: [{ delta: { content: "ok" } }], usage: { ...usage, vendor_echo: url } }, "[DONE]"]);
    return Response.json({ error: { message: "Image input is not supported", echo: encoded } }, { status: 400, headers: { "x-echo": encoded } });
  });
  assert.deepEqual((await f.llm.chat(options)).usage, usage);
  await assert.rejects(f.llm.chat(options), /不支持图片输入/);
  const events = await f.events();
  assert.equal(kinds(events, "request.start").length, 2);
  assert.equal(kinds(events, "request.end").length, 2);
  assert.deepEqual(kinds(events, "request.usage").at(-1).data.usage, usage);
  assert.ok(!JSON.stringify(events).includes(encoded));
  const files = await readdir(join(f.directory, "attachments")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(files, []);
});

test("diagnostics on and off preserve the exact request, transport count and return value", async t => {
  const disabled = await fixture(t, false), enabled = await fixture(t);
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    return simple();
  });
  assert.deepEqual(await disabled.llm.chat(input), await enabled.llm.chat(input));
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(await disabled.events(), []);
  const events = await enabled.events(), start = kinds(events, "request.start");
  assert.equal(start.length, 1); assert.deepEqual(start[0].data.body, JSON.parse(requests[1].body));
  assert.equal(start[0].data.phase, "prepared");
  assert.equal(start[0].data.provider, provider.id); assert.equal(start[0].data.model, provider.model);
  assert.equal(kinds(events, "execution.start")[0].data.trigger, "program");
  assert.equal(kinds(events, "request.end")[0].data.transport_started, true);
  assert.equal(JSON.stringify(events).includes(provider.api_key), false, "register dynamically supplied keys before the first event");
});

test("request capture uses the serialized wire body without invoking toJSON a second time", async t => {
  const f = await fixture(t);
  let serialized = 0, sent: string | undefined;
  const payload = { toJSON() { serialized++; return { model: "actual-wire-model", value: "actual-wire-value" }; } };
  const transport = { ...provider, model: undefined };
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => { sent = init.body; return new Response("ok"); });
  assert.equal(await withModelResponse(transport, "/probe", payload, response => response.text(), undefined, f.diagnostics), "ok");
  assert.equal(serialized, 1);
  assert.deepEqual(kinds(await f.events(), "request.start")[0].data.body, JSON.parse(sent!));
  assert.equal(kinds(await f.events(), "request.start")[0].data.model, "actual-wire-model");
});

test("split SSE preserves raw fields, reasoning, tool deltas and a trailing final usage snapshot", async t => {
  const f = await fixture(t), chunks: string[] = [];
  const usage = { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38, prompt_tokens_details: { cached_tokens: 12 } };
  const raw = [
    { vendor_extra: { trace: "保留原始字段" }, choices: [{ delta: { reasoning_content: "考虑🐳", content: "你好", tool_calls: [{ index: 0, id: "call-one", function: { name: "inspect", arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage },
  ];
  t.mock.method(globalThis, "fetch", async () => stream([...raw, "[DONE]"], 3));
  const result = await f.llm.chat({ ...input, onChunk: (value: string) => chunks.push(value) });
  assert.equal(result.text, "你好"); assert.equal(result.reasoning_content, "考虑🐳");
  assert.deepEqual(result.toolCalls, [{ id: "call-one", name: "inspect", arguments: '{"x":1}' }]);
  assert.deepEqual(chunks, ["你好"]);
  const events = await f.events(), usageEvents = kinds(events, "request.usage");
  assert.deepEqual(usageEvents.map(event => event.data.stage), ["interim", "final"]);
  assert.ok(usageEvents.every(event => event.data.mode === "snapshot"));
  assert.deepEqual(usageEvents.at(-1).data.usage, usage);
  assert.deepEqual(kinds(events, "response.chunk").filter(event => event.data.phase === "sse").map(event => event.data.raw), [...raw, "[DONE]"]);
  const end = kinds(events, "request.end")[0].data;
  assert.equal(end.status, "completed"); assert.equal(end.http_status, 200);
  assert.equal(end.stage, "final"); assert.equal(end.text, result.text); assert.equal(end.reasoning_content, result.reasoning_content);
});

test("interrupted SSE retains observed text and interim usage without inventing final usage", async t => {
  const f = await fixture(t), usage = { prompt_tokens: 17, completion_tokens: 2 };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return stream([{ choices: [{ delta: { content: "部分正文" } }], usage }]); });
  await assert.rejects(f.llm.chat(input), /模型流意外中断/);
  const events = await f.events();
  assert.equal(requests, 1);
  assert.deepEqual(kinds(events, "request.usage").map(event => event.data.stage), ["interim"]);
  const end = kinds(events, "request.end")[0].data;
  assert.equal(end.status, "failed"); assert.equal(end.text, "部分正文"); assert.equal(end.stage, "interim");
  assert.deepEqual(end.usage, usage);
});

test("a response without provider usage does not manufacture token counts", async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => simple());
  const result = await f.llm.chat(input), events = await f.events();
  assert.equal(result.usage, undefined); assert.equal(kinds(events, "request.usage").length, 0);
  assert.equal(Object.hasOwn(kinds(events, "request.end")[0].data, "usage"), false);
});

test("HTTP capture retains the actual status and one consumed error body before public error normalization", async t => {
  const f = await fixture(t), usage = { prompt_tokens: 8, completion_tokens: 0 };
  const raw = JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit exceeded" }, vendor: "actual-error-body", usage });
  let consumed = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    consumed++; controller.enqueue(new TextEncoder().encode(raw)); controller.close();
  } }), { status: 429, headers: { "x-request-id": "req_12345678" } }));
  await assert.rejects(f.llm.chat(input), (error: any) => error.status === 502 && /HTTP 429/.test(error.message));
  const events = await f.events(), end = kinds(events, "request.end")[0].data;
  assert.equal(consumed, 1); assert.equal(end.http_status, 429); assert.equal(end.status, "failed");
  const response = kinds(events, "response.chunk").find(event => event.data.phase === "error_body").data;
  assert.equal(response.raw, raw); assert.equal(response.complete, true); assert.equal(response.boundary, "end");
  assert.deepEqual(kinds(events, "request.usage").map(event => event.data.stage), ["interim"]);
  assert.deepEqual(end.usage, usage); assert.equal(end.stage, "interim");
});

test("bounded error capture reports observed bytes and truncation without a second body read", async t => {
  const f = await fixture(t), raw = "x".repeat(17000);
  t.mock.method(globalThis, "fetch", async () => new Response(raw, { status: 503 }));
  await assert.rejects(f.llm.chat(input), /HTTP 503/);
  const response = kinds(await f.events(), "response.chunk").find(event => event.data.phase === "error_body").data;
  assert.equal(response.raw, raw.slice(0, 16 * 1024)); assert.equal(response.observed_bytes, 16 * 1024);
  assert.equal(response.complete, false); assert.equal(response.truncated, true); assert.equal(response.boundary, "truncated");
});

test("caller cancellation retains its original reason and partial usage without retry", async t => {
  const f = await fixture(t), controller = new AbortController(), reason = Error("synthetic caller cancellation");
  const usage = { prompt_tokens: 9, completion_tokens: 1 };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests++;
    return new Response(new ReadableStream({ start(streamController) {
      streamController.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: "取消前正文" } }], usage })));
      init.signal.addEventListener("abort", () => streamController.error(init.signal.reason), { once: true });
    } }));
  });
  await assert.rejects(f.llm.chat({ ...input, signal: controller.signal, onChunk: () => controller.abort(reason) }), error => error === reason);
  const events = await f.events(), end = kinds(events, "request.end")[0].data;
  assert.equal(requests, 1); assert.equal(end.status, "cancelled"); assert.equal(end.text, "取消前正文");
  assert.deepEqual(end.usage, usage); assert.equal(end.stage, "interim");
  assert.equal(kinds(events, "request.usage").some(event => event.data.stage === "final"), false);
});

test("transport timeout remains the existing 504 error and is distinct from caller cancellation", { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  let requests = 0;
  t.mock.method(globalThis, "fetch", (_url: any, init: any) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  await assert.rejects(f.llm.chat({ ...input, provider: { ...provider, timeout_seconds: 1 } }), (error: any) => error.status === 504);
  const end = kinds(await f.events(), "request.end")[0].data;
  assert.equal(requests, 1); assert.equal(end.status, "timeout"); assert.equal(end.transport_started, true);
  assert.equal(end.response_received, false); assert.equal(end.http_status, undefined);
});

test("concurrent requests get distinct IDs while retaining only their explicitly supplied execution relation", async t => {
  const f = await fixture(t), release: (() => void)[] = [];
  t.mock.method(globalThis, "fetch", (_url: any, init: any) => {
    const label = JSON.parse(init.body).messages[0].content;
    return new Promise<Response>(resolve => release.push(() => resolve(stream([{ choices: [{ delta: { content: label } }] }, "[DONE]"]))));
  });
  const pending = f.diagnostics.run({ execution_id: "known-execution", session_id: "known-session", plugin_id: "synthetic", purpose: "verification" },
    () => Promise.all(["first", "second"].map(label => f.llm.chat({ ...input, messages: [{ role: "user", content: label }] }))));
  assert.equal(release.length, 2); release[1](); release[0]();
  await pending;
  const events = await f.events(), starts = kinds(events, "request.start");
  assert.equal(new Set(starts.map(event => event.request_id)).size, 2);
  assert.equal(kinds(events, "execution.start").length, 0, "an existing execution must not be invented again");
  for (const start of starts) {
    assert.equal(start.execution_id, "known-execution"); assert.equal(start.session_id, "known-session");
    assert.equal(start.data.purpose, "verification"); assert.equal(start.task_id, undefined);
    const end = kinds(events, "request.end").find(event => event.request_id === start.request_id);
    assert.equal(end.data.text, start.data.body.messages[0].content);
  }
});

test("finish records observed fields without ending early or replacing a consumer exception", async t => {
  const f = await fixture(t), reason = Error("synthetic consumer exception");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("body"); });
  await assert.rejects(withModelResponse(provider, "/probe", {}, async (_response, trace) => {
    trace?.finish({ text: "已观察正文" }); throw reason;
  }, undefined, f.diagnostics), error => error === reason);
  const ends = kinds(await f.events(), "request.end");
  assert.equal(requests, 1); assert.equal(ends.length, 1); assert.equal(ends[0].data.status, "failed");
  assert.equal(ends[0].data.text, "已观察正文");
});

test("observer exceptions cannot change callbacks, returned results or transport count", async t => {
  const llm = new LLM(logger), chunks: string[] = [];
  let requests = 0;
  llm.diagnostics = { enabled: true, current() { throw Error("observer current"); }, registerSecret() { throw Error("observer key"); },
    event() { throw Error("observer event"); }, run(_context: any, fn: any) { fn(); throw Error("observer scope"); },
  } as unknown as Diagnostics;
  t.mock.method(globalThis, "fetch", async () => { requests++; return simple(); });
  assert.equal((await llm.chat({ ...input, onChunk: (value: string) => chunks.push(value) })).text, "合成回答");
  assert.equal(requests, 1); assert.deepEqual(chunks, ["合成回答"]);
});
