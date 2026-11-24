/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("an isolated channel sends binary images natively and scopes private auxiliary calls to the rejected input", { timeout: 20000 }, async t => {
  const root = await temporaryDirectory("whale-channel-image-rpc-");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XkAAAAASUVORK5CYII=", "base64");
  const hint = "synthetic blue pixel";
  const requests: any[] = [];
  let rejectImage = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (rejectImage && body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"))) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This model does not support image inputs." } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"图已收到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  let releaseAux!: () => void;
  const auxGate = new Promise<void>(resolve => { releaseAux = resolve; });
  t.after(async () => {
    releaseAux();
    try { await app?.close(); }
    finally {
      if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const dir = join(root, "plugins", "image-rpc");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, "config"));
  await writeFile(join(dir, "plugin.yaml"), "id: image-rpc\nname: test\nversion: 1.0.0\ndescription: isolated image RPC fixture\n");
  await writeFile(join(dir, "index.ts"), `export function apply(ctx) {
    const delivered = [], described = [];
    const ch = ctx.get("channels").register({
      id: "fixture", account: "one", persona: "a",
      async send(m) { delivered.push(m.replyTo); },
      async describeImages({ peer, messageId, images }, { signal }) {
        described.push({ peer, messageId, binary: images[0].data instanceof Uint8Array,
          base64: Buffer.from(images[0].data).toString("base64") });
        const llm = messageId === "fallback-get" ? ctx.get("llm") : ctx.llm;
        const reply = await llm.chat({ model: "aux", messages: [{ role: "user", content: "synthetic auxiliary" }], signal });
        return reply.text;
      },
    });
    ctx.provide("image-rpc", {
      info: () => ({ pid: process.pid, supports: ch.supportsImageInput, delivered, described }),
      receive: (messageId, bytes, signal) => ch.receive({
        peer: "room", sender: "person", messageId, text: "",
        images: [{ type: "image", mimeType: "image/png", data: bytes }],
      }, { signal }),
      ordinary: () => ctx.llm.chat({ model: "ordinary", messages: [] }),
    });
  }`);
  await writeFile(join(root, "config", "config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "local", base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api_key: "synthetic" }],
    models: [{ id: "chat", name: "Test", provider: "local", model: "local-test", type: "chat", context_window: 32000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", permission: "off" } },
    channels: { web: { persona: "a", permission: "off" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const api = app.runtime.services.get("image-rpc")!.value;
  assert.notEqual((await api.info()).pid, process.pid);
  assert.equal((await api.info()).supports, true);
  let entered!: () => void;
  const auxEntered = new Promise<void>(resolve => { entered = resolve; });
  const scoped: [string, boolean][] = [];
  let holdUntilAbort = false;
  let auxSignal: AbortSignal | undefined;
  let cancellationStarted!: () => void;
  const cancellableAux = new Promise<void>(resolve => { cancellationStarted = resolve; });
  const chat = app.llm.chat.bind(app.llm);
  app.llm.chat = async (options: any) => {
    if (options.model !== "aux" && options.model !== "ordinary") return chat(options);
    scoped.push([options.model, options.privateChannelImages === true]);
    if (options.model === "aux") {
      if (holdUntilAbort) {
        auxSignal = options.signal;
        cancellationStarted();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(options.signal.reason);
          if (options.signal.aborted) abort();
          else options.signal.addEventListener("abort", abort, { once: true });
        });
      } else {
        // The worker is still waiting for this host RPC's synchronous reply.
        // The new callback is pumped reentrantly and has its own privacy scope.
        await api.ordinary();
        entered();
        await auxGate;
      }
    }
    return { text: hint, toolCalls: [], usage: {} };
  };

  assert.equal((await api.receive("native", png)).status, "sent");
  assert.equal(requests.length, 1);
  assert.ok(JSON.stringify(requests[0].messages).includes(`data:image/png;base64,${png.toString("base64")}`));
  assert.deepEqual((await api.info()).described, []);

  rejectImage = true;
  const fallback = api.receive("fallback-get", png);
  await auxEntered;
  await api.ordinary();
  releaseAux();
  assert.equal((await fallback).status, "sent");
  assert.equal(requests.length, 3);
  assert.ok(JSON.stringify(requests[2].messages).includes(hint));
  assert.ok(!JSON.stringify(requests[2].messages).includes(png.toString("base64")));
  assert.equal((await api.receive("fallback-get", png)).duplicate, true);
  assert.equal(requests.length, 3);
  const info = await api.info();
  assert.deepEqual(info.delivered, ["native", "fallback-get"]);
  assert.deepEqual(info.described, [{ peer: "room", messageId: "fallback-get", binary: true, base64: png.toString("base64") }]);

  holdUntilAbort = true;
  const controller = new AbortController();
  const cancelled = api.receive("cancel", png, controller.signal);
  await cancellableAux;
  controller.abort(Error("synthetic cancellation"));
  const result = await cancelled;
  assert.equal(result.status, "generation_failed");
  assert.equal(auxSignal?.aborted, true);
  assert.deepEqual((await api.info()).delivered, info.delivered);
  assert.equal(requests.length, 4);
  assert.deepEqual(scoped, [["aux", true], ["ordinary", false], ["ordinary", false], ["aux", true]]);
});
