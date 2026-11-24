import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { withModelResponse, modelErrorMessage, upstreamModelError } from "../core/model-http.ts";
import { isUnsupportedChannelImage } from "../core/channel-images.ts";

test("only explicit image input incompatibility permits a channel fallback", () => {
  for (const status of [400, 422, undefined]) {
    assert.ok(isUnsupportedChannelImage(upstreamModelError(status, { error: { message: "This model does not support image inputs" } })));
    assert.ok(isUnsupportedChannelImage(upstreamModelError(status, { error: { message: "Invalid content type. image_url is only supported by certain models." } })));
    assert.ok(isUnsupportedChannelImage(upstreamModelError(status, { error: { code: "image_input_not_supported" } })));
    for (const message of ["unsupported image format", "this model does not support images in this format",
      "Image input is not supported for this API key", "request timeout", "invalid image", "unsupported image URL scheme"]) {
      assert.equal(isUnsupportedChannelImage(upstreamModelError(status, { error: { message } })), false, message);
    }
  }
  for (const status of [401, 403, 404, 408, 413, 429, 500, 503])
    assert.equal(isUnsupportedChannelImage(upstreamModelError(status, { error: { code: "image_input_not_supported" } })), false);
  assert.equal(isUnsupportedChannelImage(upstreamModelError(undefined, { error: { status: 429, message: "Image input is not supported" } })), false);
});
import { LLM } from "../core/llm.ts";

async function server(t: TestContext, handler: RequestListener) {
  const instance = createServer(handler);
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>(r => instance.close(() => r())); });
  await new Promise<void>(r => instance.listen(0, "127.0.0.1", r));
  return { model: "synthetic", base_url: `http://127.0.0.1:${(instance.address() as any).port}`, api_key: "secret-never-disclose" };
}

test("HTTP diagnostics expose bounded protocol category/type/request ID, never credentials or provider request echoes", async t => {
  let requests = 0;
  const provider = await server(t, (req, res) => {
    requests++;
    req.resume();
    res.writeHead(400, { "Content-Type": "application/json", "x-request-id": "12345678-1234-1234-1234-123456789abc" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message:
      'The reasoning_content in the thinking mode must be passed back to the API. token=secret-never-disclose; PRIVATE_CONTEXT: 私人聊天内容',
      request: { messages: [{ content: "PRIVATE_CONTEXT" }], headers: { Authorization: "Bearer secret-never-disclose" } } } }));
  });
  const errors: any[] = [];
  const llm = new LLM({ info() {}, error(_message: string, data: any) { errors.push(data.error.message); } } as any);
  await assert.rejects(llm.chat({ provider, messages: [{ role: "user", content: "PRIVATE_CONTEXT" }] }), (error: any) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /reasoning_content/);
    assert.match(error.message, /invalid_request_error/);
    assert.match(error.message, /12345678-1234-1234-1234-123456789abc/);
    assert.ok(error.message.length < 300);
    return true;
  });
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_CONTEXT|私人聊天内容|secret-never-disclose|Authorization/);
});

test("unknown, oversized and non-JSON provider errors do not leak raw body text", async t => {
  for (const body of [
    JSON.stringify({ error: { message: "PRIVATE_CONTEXT", type: "PRIVATE_CONTEXT", code: "PRIVATE_CONTEXT" }, request_id: "secret-never-disclose" }),
    "<html>PRIVATE_CONTEXT</html>",
    JSON.stringify({ error: { message: "PRIVATE_CONTEXT".repeat(5000) } }),
  ]) {
    const provider = await server(t, (req, res) => { req.resume(); res.writeHead(400); res.end(body); });
    await assert.rejects(withModelResponse(provider, "/chat/completions", {}, r => r.text()), (error: any) => {
      assert.equal(error.message, "模型服务返回 HTTP 400");
      return true;
    });
  }
});

test("error-body diagnostics have a short read deadline and external cancellation retains its reason", { timeout: 6000 }, async t => {
  let entered!: () => void;
  const first = new Promise<void>(r => entered = r);
  const provider = await server(t, (req, res) => { req.resume(); res.writeHead(400); res.write('{"error":'); entered(); });
  const controller = new AbortController(), reason = Error("diagnostic cancelled");
  const pending = withModelResponse(provider, "/chat/completions", {}, r => r.text(), controller.signal);
  await first;
  controller.abort(reason);
  await assert.rejects(pending, (error: any) => error === reason);
  const started = Date.now();
  await assert.rejects(withModelResponse(provider, "/chat/completions", {}, r => r.text()), /HTTP 400/);
  assert.ok(Date.now() - started < 3000);
});

test("SSE error messages use the same safe diagnostic policy", async t => {
  const provider = await server(t, (req, res) => {
    req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"error":{"type":"invalid_request_error","message":"reasoning_content missing in thinking mode PRIVATE_CONTEXT"}}\n\n');
  });
  const llm = new LLM({ info() {}, error() {} } as any);
  await assert.rejects(llm.chat({ provider, messages: [{ role: "user", content: "test" }] }), (error: any) => {
    assert.match(error.message, /reasoning_content/);
    assert.doesNotMatch(error.message, /PRIVATE_CONTEXT/);
    return true;
  });
});

test("a model-busy 429 explains capacity rejection without echoing arbitrary upstream text", async t => {
  let requests = 0;
  const provider = await server(t, (req, res) => {
    requests++; req.resume(); res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "MODEL_RATE_LIMITED", type: "rate_limit_error",
      message: "The model is temporarily busy. Please try again later. PRIVATE_CONTEXT secret-never-disclose" },
      request_id: "req_1234567890abcdef" }));
  });
  await assert.rejects(withModelResponse(provider, "/chat/completions", {}, r => r.text()), (error: any) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 429.*模型服务繁忙.*暂时无法处理请求.*rate_limit_error.*req_1234567890abcdef/);
    assert.doesNotMatch(error.message, /频率|余额|额度|PRIVATE_CONTEXT|secret-never-disclose|Please try again/);
    return true;
  });
  assert.equal(requests, 1, "diagnosis does not automatically retry");
});

test("known error labels provide safe fallback reasons while an unexplained 429 stays unexplained", () => {
  for (const [label, reason] of [
    ["MODEL_RATE_LIMITED", "当前模型请求受限"], ["rate_limit_error", "服务暂时限制了请求"],
    ["overloaded_error", "模型服务繁忙"], ["MODEL_UNAVAILABLE", "当前模型不可用"],
    ["insufficient_quota", "服务额度或余额不足"], ["invalid_api_key", "服务拒绝了认证信息"],
  ]) {
    const message = modelErrorMessage(429, { error: { code: label, message: "PRIVATE_CONTEXT secret-never-disclose" } }, "secret-never-disclose");
    assert.ok(message.includes(reason));
    assert.doesNotMatch(message, /PRIVATE_CONTEXT|secret-never-disclose/);
  }
  assert.equal(modelErrorMessage(429, { error: { code: "unknown_private_code", type: "__proto__", message: "PRIVATE_CONTEXT" } }),
    "模型服务返回 HTTP 429");
  assert.equal(modelErrorMessage(429, undefined), "模型服务返回 HTTP 429");
  assert.match(modelErrorMessage(429, { error: { type: "rate_limit_error", code: "MODEL_RATE_LIMITED" } }), /当前模型请求受限/,
    "a known specific code is more informative than its generic type");
  assert.match(modelErrorMessage(429, { error: { type: "rate_limit_error", message: "insufficient balance" } }), /余额不足/,
    "an explicit quota error is not overridden by a generic rate-limit label");
});
