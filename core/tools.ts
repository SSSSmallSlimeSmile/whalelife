/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Diagnostics } from "./diagnostics.ts";
import { decision } from "./permission.ts";
import type { Logger } from "./logger.ts";
import { randomUUID, createHash } from "node:crypto";
import { pluginOrigin } from "./provenance.ts";
import { receiptSnapshot, type ToolTurn } from "./tool-retention.ts";
import { toolContentSnapshot, ToolContentError } from "./tool-content.ts";
import type { ToolContentPart } from "./plugin-api.ts";
import type { ExecutionArchive } from "./execution-archive.ts";
import { echoesPrivateChannelImage } from "./channel-images.ts";
export class Tools {
  entries = new Map<string, any>();
  logger: Logger;
  overrides: any;
  observe?: (event: any) => Promise<void>;
  executionArchive?: ExecutionArchive;
  diagnostics?: Diagnostics;
  private persisted = new WeakMap<object, { ok: boolean; result: unknown; transient: true }>();
  private media = new WeakMap<object, { content: ToolContentPart[]; signal: AbortSignal }>();
  constructor(logger: Logger, overrides: any = {}) {
    this.logger = logger;
    this.overrides = { remember_fact: "full", ...overrides };
  }
  register(tool: any, signal?: AbortSignal) {
    return this.add(tool, signal, false);
  }
  registerTransient(tool: any, signal?: AbortSignal) {
    return this.add(tool, signal, true);
  }
  registerMultimodal(tool: any, signal?: AbortSignal) {
    return this.add(tool, signal, true, true);
  }
  private add(tool: any, signal: AbortSignal | undefined, transientResult: boolean, multimodalResult = false) {
    signal?.throwIfAborted();
    if (this.entries.has(tool.name)) throw Error("工具重名：" + tool.name);
    const origin = pluginOrigin(tool.owner || "core", tool.origin);
    const controller = new AbortController();
    const entry = { ...tool, origin, transientResult, multimodalResult, signal: signal
      ? AbortSignal.any([signal, controller.signal]) : controller.signal };
    this.entries.set(tool.name, entry);
    const dispose = () => {
      controller.abort(Error("工具已停用"));
      if (this.entries.get(tool.name) === entry) this.entries.delete(tool.name);
      signal?.removeEventListener("abort", dispose);
    };
    signal?.addEventListener("abort", dispose, { once: true });
    return dispose;
  }
  list() {
    return [...this.entries.values()].map(({ name, description, schema }) => ({
      type: "function",
      function: {
        name,
        description,
        parameters: schema.type
          ? schema
          : {
              type: "object",
              properties: schema,
              required: Object.keys(schema),
              additionalProperties: false,
            },
      },
    }));
  }
  stored(result: any) { return this.persisted.get(result) ?? result; }
  multimodal(result: object) { return this.media.get(result); }
  async call(name: string, args: any, session: any, callId = randomUUID(), turn: ToolTurn = { transient: false }) {
    const diagnostics = this.diagnostics;
    if (!diagnostics?.enabled) return this.invoke(name, args, session, callId, turn);
    const parent = diagnostics.current(), tool = this.entries.get(name);
    const own = !parent.execution_id;
    return diagnostics.run({ execution_id: parent.execution_id ?? turn.execution?.id ?? randomUUID(),
      ...(session.id ? { session_id: session.id } : {}), tool_call_id: callId,
      ...(tool?.owner ? { plugin_id: tool.owner } : {}), relation_verified: true }, async () => {
      if (own) diagnostics.event("execution.start", { title: "direct_tool", trigger: "tool_call", origin: tool?.origin });
      diagnostics.event("tool.start", { tool_call_id: callId, name, arguments: args, origin: tool?.origin });
      let status = "failed";
      try {
        const result = await this.invoke(name, args, session, callId, turn);
        status = result.ok ? "completed" : session.signal?.aborted ? "cancelled" : "failed";
        const payload = { result, ...(this.media.has(result) ? { content: this.media.get(result)!.content } : {}) };
        diagnostics.event("tool.end", { tool_call_id: callId, name, status,
          ...(echoesPrivateChannelImage(payload) ? { content_omitted: "channel_images" } : payload) });
        return result;
      } catch (error) {
        diagnostics.event("tool.end", { tool_call_id: callId, name, status, error });
        throw error;
      } finally { if (own) diagnostics.event("execution.end", { status }); }
    });
  }
  private async invoke(name: string, args: any, session: any, callId: string, turn: ToolTurn) {
    const tool = this.entries.get(name);
    if (tool?.transientResult || session.transientContext) turn.transient = true;
    const storedName = turn.transient && !tool ? "[未注册工具]" : name;
    const started = Date.now();
    const execution = turn.execution ?? (session.id ? await this.executionArchive?.start(session.id, {
      kind: "direct_tool", tool: storedName, origin: tool?.origin,
    }) : undefined);
    const call = createHash("sha256").update(String(callId)).digest("hex").slice(0, 24);
    let verdict: string | undefined;
    let argumentsDigest: string | undefined;
    try { argumentsDigest = createHash("sha256").update(JSON.stringify(args) ?? "undefined").digest("hex"); } catch { /* Diagnostic hashing must not change tool semantics. */ }
    await execution?.write("tool_start", { round: turn.round, call, tool: storedName, origin: tool?.origin,
      ...(turn.transient ? { arguments: "临时参数不保存" } : { arguments: args }),
      arguments_digest: argumentsDigest,
    });
    const report = async (ok: boolean, result: any, receipt: unknown = null) => {
      const returned = { ok, result };
      const stored = turn.transient ? { ok, result: receipt, transient: true as const } : returned;
      if (echoesPrivateChannelImage(stored.result))
        throw Error("工具返回了临时渠道图片，原始数据不保存");
      if (turn.transient) this.persisted.set(returned, stored as any);
      await execution?.write("tool_result", { round: turn.round, call, tool: storedName, ok,
        elapsed_ms: Date.now() - started, transient: turn.transient, permission: verdict,
        // Archive reads never copy another archive into this one. Transient contracts still exclude raw content.
        result: tool?.archiveRead ? "按需读取，内容不重复存档" : stored.result,
        ...(!ok ? { error: result, failure: session.signal?.aborted || tool?.signal.aborted ? "cancelled"
          : !tool ? "tool_unavailable" : verdict && verdict !== "allow" ? "permission_" + verdict : "tool_failed" } : {}),
        note: "ok仅表示工具执行状态，业务是否成功以实际回执为准",
      });
      if (!turn.execution) await execution?.end(ok ? "completed" : session.signal?.aborted || tool?.signal.aborted ? "cancelled" : "failed");
      try {
        await this.observe?.({
          id: turn.transient ? "temporary_" + createHash("sha256").update(callId).digest("hex") : callId,
          name: storedName,
          source: tool?.owner || "core",
          origin: { ...(tool?.origin ?? { plugin: "core" }), action: tool?.origin?.action ?? "工具调用" },
          session: turn.transient ? { ...session, transientContext: true } : session,
          ok,
          result: stored.result,
          ...(turn.transient ? { transient: true } : {}),
        });
      } catch (error) {
        this.logger.warn("工具经历记录失败", { name: storedName, error: turn.transient ? "临时调用的记录失败" : error });
      }
      return returned;
    };
    try {
      if (!tool) throw Error("工具不存在");
      const signal = AbortSignal.any([tool.signal, ...(session.signal ? [session.signal] : [])]);
      signal.throwIfAborted();
      verdict = decision(
        session.permission,
        tool.danger ?? "ask",
        this.overrides[name],
      );
      this.logger.info("工具权限判定", {
        name,
        verdict,
        args: turn.transient ? "[临时参数不记录]" : JSON.stringify(args).slice(0, 120),
      });
      if (verdict !== "allow")
        throw Error(
          verdict === "ask"
            ? "需要审批；M0 暂不支持审批，请修改权限后重启"
            : "工具已关闭",
        );
      signal.throwIfAborted();
      const result = await tool.run(args, { ...session, signal, ...(turn.transient ? { transientContext: true } : {}) });
      // Cancellation cannot undo a completed external operation or replace its true result.
      if (tool.transientResult) {
        if (!result || typeof result !== "object" || !Object.hasOwn(result, "content") || !Object.hasOwn(result, "receipt"))
          throw Error("临时工具必须返回content和receipt");
        const receipt = receiptSnapshot(result.receipt);
        if (tool.multimodalResult) {
          const content = toolContentSnapshot(result.content);
          const returned = await report(true, content, receipt);
          this.media.set(returned, { content, signal });
          return returned;
        }
        return report(true, result.content, receipt);
      }
      return report(true, result);
    } catch (error: any) {
      if (echoesPrivateChannelImage(error?.message ?? error)) error = Error("工具处理渠道图片失败，原始错误不保存");
      this.diagnostics?.event("tool.error", { tool_call_id: callId, name, error });
      const message = error instanceof ToolContentError ? error.message : turn.transient ? "临时工具调用失败，未保存原始错误；外部动作结果请通过插件回执核对，不要自动重试。" : error?.message ?? String(error);
      this.logger.error("工具调用失败", { name: storedName, error: turn.transient ? message : error });
      return report(false, message);
    }
  }
}
