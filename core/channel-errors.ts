/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { diagnosticSnapshot } from "./execution-archive.ts";
import { EmptyModelResponseError } from "./model-response-error.ts";

// These are complete host-authored messages, never prefixes followed by an
// arbitrary exception body. Channel receipts are durable conversation data.
const hostMessages = new Set([
  "请先明确选择可用的对话模型",
  "请先在模型配置中为人格选择可用的对话模型",
  "请先在模型配置中选择已启用的对话模型",
  "对话模型的提供商不存在或已停用",
  "此模型协议由插件调用，不能用于主干对话",
  "模型引用的提供商不存在",
  "提供商协议标识无效",
  "提供商 API 地址无效",
  "思考字段兼容设置仅适用于 OpenAI 兼容协议的对话模型",
  "模型 API 地址无效",
  "模型 API 地址不可包含凭据、查询参数或片段",
  "无法连接模型服务，请检查 API 地址、代理和网络",
  "模型返回空响应",
  "模型服务返回了无效的流式数据",
  "模型流意外中断",
  "渠道辅助识图失败，未生成本轮回复",
  "模型返回了原始图片数据，已停止本轮",
  "工具返回了原始图片数据，已停止本轮",
  "模型重复返回已处理的工具调用 ID，本轮已停止；请核对先前的工具回执",
  "模型未返回最终回复，请重试",
  "本轮内容或工具结果超出模型上下文预算，请减少输入或切换更大上下文模型",
  "思考模式工具响应缺少 reasoning_content，未执行本次工具调用",
  "本轮工具图片累计超过16张或16MiB，请减少查看的图片或视频帧",
  "会话或记忆正在维护，请稍后重试",
  "该会话正在回复或维护，请稍候",
  "会话等待队列已满，请稍后重试",
  "排队请求已失效，未执行",
  "记忆恢复中，请稍后重试",
  "会话维护中，请稍后重试",
  "此会话已删除，请新建或选择其他会话",
  "当前人格已在其他窗口切换，请刷新后重试",
  "人格不存在",
  "会话正在处理，请稍后重试发送",
  "会话已删除",
  "渠道绑定已改变，不能保存旧会话回执",
]);
const modelDetails = new Set([
  "服务拒绝了认证信息", "服务拒绝了此操作的权限", "服务额度或余额不足",
  "请求超出模型上下文限制", "服务暂时限制了请求，请稍后重试", "当前模型请求受限，请稍后重试",
  "模型服务繁忙，暂时无法处理请求，请稍后重试", "当前模型不可用，请检查服务状态或稍后重试",
  "模型服务暂时异常，请稍后重试", "服务请求频率受限",
  "思考模式要求回传完整 reasoning_content，请检查工具续轮协议",
  "当前模型或接口不支持图片输入，请选择支持图片与工具调用的模型；未自动切换模型",
  "模型服务拒绝了图片格式，请检查插件提供的图片", "服务拒绝了工具定义或调用格式",
  "invalid_request_error", "authentication_error", "invalid_api_key", "permission_error", "insufficient_quota",
  "context_length_exceeded", "rate_limit_error", "model_rate_limited", "overloaded_error", "model_overloaded",
  "model_unavailable", "server_error",
]);
const systemErrors: Record<string, string> = {
  ENOSPC: "存储空间不足", EACCES: "文件访问被拒绝", EPERM: "文件操作权限不足",
  EROFS: "存储位置只读", EIO: "存储读写失败", ENOENT: "所需文件不存在",
  EMFILE: "打开的文件数量过多", ECONNREFUSED: "连接被拒绝", ECONNRESET: "连接已中断",
  ETIMEDOUT: "连接超时", ENOTFOUND: "网络地址解析失败", EAI_AGAIN: "网络地址解析暂时失败",
};
const fallback = "执行失败，原始错误未保存；请核对执行档案";

/** Select diagnostic categories; do not persist arbitrary message/stack/cause. */
export function channelFailureReason(error: unknown, secrets: unknown = []): string {
  try {
    let reason = fallback;
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof EmptyModelResponseError) {
        const finishReasons = { output_limit: "length", content_filtered: "content_filter",
          service_unavailable: "insufficient_system_resource", generation_aborted: "aborted" };
        // Rebuild from the category rather than trusting a mutable Error.message.
        const finish = Object.hasOwn(finishReasons, error.reason) ? finishReasons[error.reason as keyof typeof finishReasons] : undefined;
        reason = new EmptyModelResponseError(finish, error.reason === "reasoning_only").message;
      } else if (typeof code === "string" && Object.hasOwn(systemErrors, code)) reason = `${systemErrors[code]}（${code}）`;
      else if (typeof error.message === "string" && error.message.length <= 4096) {
        const message = error.message;
        if (hostMessages.has(message)) reason = message;
        else if (/^模型请求超时（(?:[1-9]\d?|[1-5]\d\d|600) 秒），请检查服务或调整超时时间$/.test(message)) reason = message;
        else {
          const prefix = message.match(/^模型服务返回 (?:HTTP [1-5]\d\d|错误)(?=：|$)/)?.[0];
          if (prefix) {
            const details = message.slice(prefix.length + 1).split("；").filter(part => modelDetails.has(part));
            reason = prefix + (details.length ? "：" + [...new Set(details)].slice(0, 3).join("；") : "");
          }
        }
      }
    }
    // Keep the configured key list inside the host. Redact before limiting so a
    // boundary cannot expose the beginning of a key; longer overlapping keys first.
    const knownSecrets = Array.isArray(secrets)
      ? secrets.filter((value): value is string => typeof value === "string" && !!value).sort((a, b) => b.length - a.length) : [];
    const safe = diagnosticSnapshot(reason, knownSecrets);
    return typeof safe === "string" ? safe.slice(0, 256) : fallback;
  } catch { return fallback; }
}
