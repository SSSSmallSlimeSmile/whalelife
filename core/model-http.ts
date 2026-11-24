/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { ProxyAgent } from "undici";
import { randomUUID } from "node:crypto";
import type { Diagnostics } from "./diagnostics.ts";

export type ModelResponseTrace = {
  emit(kind: string, data: any): void;
  /** Accumulate observed result fields; request.end is emitted by the transport. */
  finish(data: any): void;
};

/** Keep billing and token counters while excluding unrecognised fields that may echo media. */
export function channelUsage(usage: any) {
  if (!usage || typeof usage !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "cost"])
    if (Number.isFinite(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  for (const key of ["cost_currency", "currency"])
    if (typeof usage[key] === "string" && /^[A-Z]{3}$/.test(usage[key])) result[key] = usage[key];
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    const details: Record<string, number> = {};
    for (const field of ["cached_tokens", "reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"])
      if (Number.isSafeInteger(usage[key]?.[field]) && usage[key][field] >= 0) details[field] = usage[key][field];
    if (Object.keys(details).length) result[key] = details;
  }
  return result;
}

function requestCapture(diagnostics: Diagnostics | undefined, provider: ModelTransport, endpoint: string, privateImages: boolean) {
  try { if (!diagnostics?.enabled) return; } catch { return; }
  const sink = diagnostics!;
  const safe = (fn: () => void) => { try { fn(); } catch { /* Diagnostics must not change a model call. */ } };
  const errorText = (error: unknown) => {
    try { return error instanceof Error ? error.message : String(error); } catch { return "模型请求失败，异常内容不可读取"; }
  };
  safe(() => sink.registerSecret(provider.api_key ?? ""));
  let parent: any = {};
  safe(() => { parent = sink.current() ?? {}; });
  const independent = !parent.execution_id;
  const context = { ...parent, execution_id: parent.execution_id ?? "model_" + randomUUID(), request_id: "request_" + randomUUID() };
  const identity = { provider: (provider as any).id, model: (provider as any).model,
    protocol: (provider as any).protocol ?? "openai-compatible",
    purpose: parent.purpose ?? (endpoint === "/chat/completions" ? "chat" : endpoint === "/models" ? "model_list" : "model_request") };
  let started = false, result: any = { phase: "preparing", transport_started: false, response_received: false };
  const emit = (kind: string, data: any) => safe(() => sink.event(kind, data, context));
  const trace: ModelResponseTrace = {
    emit: (kind, data) => {
      if (privateImages && kind === "request.usage") data = { ...data, usage: channelUsage(data.usage) };
      if (privateImages && kind === "response.chunk") return;
      safe(() => { if (kind === "request.usage") result = { ...result, usage: data.usage, mode: data.mode, stage: data.stage }; });
      emit(kind, data);
    },
    finish: data => safe(() => {
      if (privateImages) {
        // Arbitrary provider fields (including streamed errors) can echo the request.
        for (const key of ["phase", "transport_started", "transport_started_at", "http_status", "response_received", "response_received_at"])
          if (Object.hasOwn(data, key)) result[key] = data[key];
      } else result = { ...result, ...data };
    }),
  };
  return {
    trace,
    prepared(url: string, init: RequestInit) {
      safe(() => {
        if (privateImages) {
          started = true;
          emit("request.start", { ...identity, phase: "prepared", method: init.method, body_omitted: "channel_images" });
          return;
        }
        const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        started = true;
        emit("request.start", { ...identity, model: body?.model ?? identity.model, phase: "prepared", method: init.method, url,
          headers: init.headers, ...(body === undefined ? {} : { body }) });
      });
    },
    transport() { trace.finish({ phase: "transport_started", transport_started: true, transport_started_at: new Date().toISOString() }); },
    received(response: Response) {
      safe(() => {
        const data = { phase: "received", http_status: response.status, status_text: response.statusText,
          headers: Object.fromEntries(response.headers), response_received_at: new Date().toISOString() };
        trace.finish({ ...data, response_received: true });
        if (!privateImages) emit("response.chunk", data);
      });
    },
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const execute = async () => {
        if (independent) emit("execution.start", { title: "模型请求", trigger: "program" });
        let status = "completed", failure: unknown;
        try { return await fn(); }
        catch (error) {
          status = signal?.aborted ? "cancelled" : error instanceof ModelRequestError && error.status === 504 ? "timeout" : "failed";
          failure = error;
          throw error;
        } finally {
          if (!started) emit("request.start", { ...identity, phase: "preparation_failed", body_unavailable: true });
          emit("request.end", { ...result, status,
            ...(failure === undefined ? {} : { error: privateImages ? "渠道图片请求未完成" : errorText(failure) }) });
          if (independent) emit("execution.end", { status });
        }
      };
      // A broken observer may throw before invoking its callback. Never rerun an
      // operation which already began, even when the observer itself throws.
      let operation: Promise<T> | undefined;
      try { sink.run(context, () => (operation = execute())); }
      catch { /* Await an already-started operation, never replay it. */ }
      return operation ?? execute();
    },
  };
}

export interface ModelTransport {
  base_url: string;
  api_key?: string;
  timeout_seconds?: number;
  proxy_url?: string;
}

export class ModelRequestError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

export class ModelImageInputUnsupportedError extends ModelRequestError {}

/** Classify only explicit input-modality errors. A generic "unsupported" cannot justify a second paid call. */
export function upstreamModelError(status: number | undefined, body: any, secret?: string, headerId?: string | null): Error {
  const message = modelErrorMessage(status, body, secret, headerId);
  const raw = body?.error;
  const reportedStatuses = [status, raw?.status, raw?.status_code, raw?.code, body?.status]
    .filter(value => /^[1-5]\d\d$/.test(String(value))).map(Number);
  if (reportedStatuses.every(value => value === 400 || value === 422)) {
    const code = String(raw?.code ?? "").toLowerCase();
    const type = String(raw?.type ?? "").toLowerCase();
    const cause = typeof raw?.message === "string" ? raw.message.slice(0, 8192) : "";
    const otherFailure = /auth|api.?key|permission|billing|quota|rate.?limit|timeout|context.length|overload|server.error|image.(format|size)|invalid.image|corrupt|content.policy|鉴权|权限|限流|余额|超时/i;
    const rejectsModality = /\bmodel\b[^.\n]{0,70}(?:does not support|doesn't support|cannot (?:accept|process)) (?:any )?(?:images?\b|image_url\b|vision\b|multimodal\b)|(?:image inputs?|image_url|vision inputs?|multimodal inputs?)['"]? (?:is |are )?(?:not supported|unsupported|only supported (?:by|in) (?:certain|some) models)\b/i;
    const onlyText = /(?:only supports?|only accepts?) text(?:ual)? (?:inputs?|messages?)\b/i;
    const rejectsChinese = /(?:模型|接口)[^。\n]{0,18}不支持(?:图片|图像|视觉|多模态)(?:输入)?|(?:图片|图像|视觉|多模态)输入[^。\n]{0,12}不(?:受支持|支持)/;
    const explicitCode = ["unsupported_image_input", "image_input_not_supported", "vision_not_supported", "model_not_support_vision"].includes(code);
    const formatError = /(?:not support|unsupported|invalid|unknown).{0,30}(?:format|mime|file type|resolution|encoding|url scheme)|(?:image|图片|图像)[^。\n]{0,12}(?:格式|format|size|编码)/i;
    if (!otherFailure.test(code + " " + type + " " + cause) && !formatError.test(cause) &&
        (explicitCode || rejectsModality.test(cause) || onlyText.test(cause) || rejectsChinese.test(cause)))
      return new ModelImageInputUnsupportedError(message);
  }
  return status === undefined ? Error(message) : new ModelRequestError(message);
}

/** Only emit recognised diagnostic categories, never a provider's arbitrary text/request echo. */
export function modelErrorMessage(status: number | undefined, body: any, secret = "", headerId?: string | null) {
  const error = body?.error, message = typeof error?.message === "string" ? error.message.slice(0, 8192) : "";
  const labels = [error?.type, error?.code].filter((value): value is string => typeof value === "string")
    .map(value => value.toLowerCase());
  const fallback: Record<string, string> = {
    authentication_error: "服务拒绝了认证信息", invalid_api_key: "服务拒绝了认证信息",
    permission_error: "服务拒绝了此操作的权限", insufficient_quota: "服务额度或余额不足",
    context_length_exceeded: "请求超出模型上下文限制",
    // A rate-limit category can cover either request frequency or model capacity.
    // Do not infer an account balance or a specific limit from HTTP 429 alone.
    rate_limit_error: "服务暂时限制了请求，请稍后重试",
    model_rate_limited: "当前模型请求受限，请稍后重试",
    overloaded_error: "模型服务繁忙，暂时无法处理请求，请稍后重试",
    model_overloaded: "模型服务繁忙，暂时无法处理请求，请稍后重试",
    model_unavailable: "当前模型不可用，请检查服务状态或稍后重试",
    server_error: "模型服务暂时异常，请稍后重试",
  };
  let reason = "";
  if (/reasoning_content/i.test(message) && /thinking|passed back|missing|must|思考|缺少/i.test(message))
    reason = "思考模式要求回传完整 reasoning_content，请检查工具续轮协议";
  else if (/context.{0,30}(length|window)|maximum.{0,30}token|too many tokens/i.test(message)) reason = "请求超出模型上下文限制";
  else if (/invalid.{0,20}(api.?key|authentication)|unauthorized/i.test(message)) reason = "服务拒绝了认证信息";
  else if (/insufficient.{0,20}(quota|balance)|quota.{0,20}exceed/i.test(message)) reason = "服务额度或余额不足";
  else if (/\b(model|server|service)\b.{0,45}\b(busy|overloaded|temporarily unavailable)\b|^\s*overloaded[.!]?\s*$|(?:模型|服务).{0,15}繁忙/i.test(message))
    reason = "模型服务繁忙，暂时无法处理请求，请稍后重试";
  else if (/rate.{0,10}limit/i.test(message)) reason = "服务请求频率受限";
  else if (/(image|vision|multimodal|图片|图像)/i.test(message) && /not support|unsupported|not allowed|only.{0,15}text|不支持/i.test(message))
    reason = "当前模型或接口不支持图片输入，请选择支持图片与工具调用的模型；未自动切换模型";
  else if (/(invalid|invalid_value|corrupt|format).{0,40}image|image.{0,40}(invalid|corrupt|format)/i.test(message))
    reason = "模型服务拒绝了图片格式，请检查插件提供的图片";
  else if (/(tool|function).{0,40}(invalid|schema)|invalid.{0,30}(tool|function)/i.test(message)) reason = "服务拒绝了工具定义或调用格式";
  if (!reason) reason = [...labels].reverse().map(label => Object.hasOwn(fallback, label) ? fallback[label] : "").find(Boolean) ?? "";
  const known = new Set(["invalid_request_error", ...Object.keys(fallback)]);
  const type = labels.find(label => known.has(label));
  const candidate = headerId ?? body?.request_id ?? error?.request_id ?? message.match(/request_id:\s*([a-f\d-]{36})/i)?.[1];
  const requestId = typeof candidate === "string" && /^(?:[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|req_[a-z\d]{8,80})$/i.test(candidate) &&
    (!secret || !candidate.includes(secret)) ? candidate : undefined;
  const details = [reason, type, requestId ? "request_id=" + requestId : ""].filter(Boolean).join("；");
  return (status === undefined ? "模型服务返回错误" : `模型服务返回 HTTP ${status}`) + (details ? "：" + details : "");
}

async function boundedErrorBody(response: Response, trace?: ModelResponseTrace) {
  const reader = response.body?.getReader();
  if (!reader) { trace?.emit("response.chunk", { phase: "error_body", raw: "", complete: true, boundary: "no_body" }); return undefined; }
  const limit = 16 * 1024, decoder = new TextDecoder();
  let size = 0, raw = "";
  let complete = false, truncated = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 1000);
  timer.unref();
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) { complete = !timedOut; break; }
      const chunk = value.subarray(0, limit - size);
      if (chunk.length < value.length) truncated = true;
      size += chunk.length;
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    try {
      const body = JSON.parse(raw);
      if (body?.usage !== undefined && body?.usage !== null)
        trace?.emit("request.usage", { usage: body.usage, mode: "snapshot", stage: "interim" });
      return body;
    } catch { return undefined; }
  } finally {
    clearTimeout(timer);
    trace?.emit("response.chunk", { phase: "error_body", raw, observed_bytes: size, limit_bytes: limit,
      complete, truncated, boundary: complete ? "end" : truncated ? "truncated" : timedOut ? "timeout" : size >= limit ? "limit_unknown" : "interrupted" });
    trace?.finish({ response: raw, response_complete: complete, response_truncated: truncated,
      response_boundary: complete ? "end" : truncated ? "truncated" : timedOut ? "timeout" : size >= limit ? "limit_unknown" : "interrupted" });
    await reader.cancel().catch(() => {});
  }
}

export function timeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return 120;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 600
  )
    throw new ModelRequestError("请求超时必须为 1–600 秒的整数", 400);
  return value;
}

export function proxyURL(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string")
    throw new ModelRequestError("代理地址必须是 HTTP 或 HTTPS 地址", 400);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ModelRequestError("代理地址必须是完整的 HTTP 或 HTTPS 地址", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ModelRequestError(
      "代理地址仅支持 HTTP/HTTPS 主机及端口，不可包含凭据、路径或查询参数",
      400,
    );
  return url.origin;
}

/** A request-scoped dispatcher avoids changing networking for unrelated services. */
export async function withModelResponse<T>(
  provider: ModelTransport,
  endpoint: string,
  payload: unknown | undefined,
  consume: (response: Response, trace?: ModelResponseTrace) => Promise<T>,
  externalSignal?: AbortSignal,
  diagnostics?: Diagnostics,
  privateChannelImages = false,
): Promise<T> {
  let capture: ReturnType<typeof requestCapture>;
  try { capture = requestCapture(diagnostics, provider, endpoint, privateChannelImages); } catch { /* Optional observer setup is best effort. */ }
  const execute = async (): Promise<T> => {
  externalSignal?.throwIfAborted();
  const seconds = timeoutSeconds(provider.timeout_seconds);
  const proxy = proxyURL(provider.proxy_url);
  let url: URL;
  try {
    url = new URL(provider.base_url);
  } catch {
    throw new ModelRequestError("模型 API 地址无效", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ModelRequestError(
      "模型 API 地址不可包含凭据、查询参数或片段",
      400,
    );
  const dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, proxyTunnel: true })
    : undefined;
  const timeout = AbortSignal.timeout(seconds * 1000);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeout])
    : timeout;
  const checkAbort = () => {
    if (!signal.aborted) return;
    if (externalSignal?.aborted && signal.reason === externalSignal.reason)
      throw signal.reason;
    throw new ModelRequestError(
      `模型请求超时（${seconds} 秒），请检查服务或调整超时时间`,
      504,
    );
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  try {
    let response: Response;
    try {
      const init: RequestInit & { dispatcher?: ProxyAgent } = {
        method: payload === undefined ? "GET" : "POST",
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: "error",
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      };
      capture?.prepared(provider.base_url.replace(/\/+$/, "") + endpoint, init);
      capture?.transport();
      response = await fetch(
        provider.base_url.replace(/\/+$/, "") + endpoint,
        init,
      );
      capture?.received(response);
    } catch {
      checkAbort();
      throw new ModelRequestError(
        "无法连接模型服务，请检查 API 地址、代理和网络",
        502,
      );
    }
    if (!response.ok) {
      let body: unknown;
      try { body = await boundedErrorBody(response, capture?.trace); } catch { /* retain the HTTP status on truncated/erroring bodies */ }
      checkAbort();
      throw upstreamModelError(response.status, body, provider.api_key,
        response.headers.get("x-request-id") ?? response.headers.get("request-id"));
    }
    try {
      return await consume(response, capture?.trace);
    } catch (error) {
      checkAbort();
      throw error;
    }
  } finally {
    if (dispatcher) await dispatcher.destroy();
  }
  };
  return capture ? capture.run(execute, externalSignal) : execute();
}
