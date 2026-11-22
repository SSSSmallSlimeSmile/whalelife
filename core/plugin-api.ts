/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
/** Public plugin data contracts. Do not export core implementation classes here. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelChoice, ModelConnection, ModelsAPI } from "./model-connection.ts";
export type { ModelChoice, ModelConnection, ModelsAPI } from "./model-connection.ts";

export type Permission = "off" | "ask" | "full";
export type Origin = { plugin?: string; channel?: string; platform?: string; action?: string };
export type OriginDetails = Pick<Origin, "platform" | "action">;
export type Dispose = () => void | Promise<void>;
export type Disposable = Dispose | { dispose: Dispose };

/** One optional provider instance. Invalidated on provider loss, unsubscribe or consumer stop. */
export interface OptionalService<T> {
  readonly service: T;
  readonly signal: AbortSignal;
  /** Register synchronous setup and bounded cleanup for this connection; rejects late setup. */
  effect<D extends Disposable>(setup: () => D): D;
}

export interface PluginLogger {
  log(level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}
export interface PluginConfig {
  <T = Record<string, unknown>>(file?: string): T;
  read<T = Record<string, unknown>>(file?: string): Promise<T>;
  save<T>(file: string, value: T): Promise<void>;
}
export interface ApprovalAPI {
  request(): Promise<{ approved: boolean; reason?: string }>;
}

export interface ToolSession {
  id?: string;
  permission: Permission;
  signal?: AbortSignal;
  personaId?: string;
  origin?: Origin;
  channel?: string;
  account?: string;
  peer?: string;
  sender?: string;
  /** This turn has used temporary external material; never persist raw parameters/results. */
  readonly transientContext?: boolean;
  [field: string]: unknown;
}
export type ToolSchema = Record<string, unknown>;
export interface ToolDefinition<Arguments = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  schema: ToolSchema;
  danger?: "safe" | "ask" | "full";
  origin?: OriginDetails;
  run(args: Arguments, session: ToolSession): Result | Promise<Result>;
}
export interface ModelTool {
  type: "function";
  function: { name: string; description: string; parameters: ToolSchema };
}
export type ToolResult<Result = unknown> = { ok: true; result: Result } | { ok: false; result: string };
export interface TransientToolOutput<Content = unknown, Receipt = unknown> {
  /** Available only to the current caller/model turn. */
  content: Content;
  /** Trusted, JSON-only durable projection of the action/result; null saves no experience. */
  receipt: Receipt | null;
}
/** Temporary tool media; no URLs, paths, native video or audio. Buffer is also accepted. */
export type ToolContentPart = { type: "text"; text: string } | {
  type: "image"; mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array; detail?: "auto" | "low" | "high";
};
export type MultimodalToolOutput<Receipt = unknown> = TransientToolOutput<ToolContentPart[], Receipt>;
export interface ToolsAPI {
  register<Arguments = Record<string, unknown>, Result = unknown>(tool: ToolDefinition<Arguments, Result>): () => void;
  /** Opt in explicitly; old hosts must not fall back to ordinary register. */
  registerTransient<Arguments = Record<string, unknown>, Content = unknown, Receipt = unknown>(tool: ToolDefinition<Arguments, TransientToolOutput<Content, Receipt>>): () => void;
  /** Native visual input for the current model; always transient. Feature-detect on older hosts. */
  registerMultimodal<Arguments = Record<string, unknown>, Receipt = unknown>(tool: ToolDefinition<Arguments, MultimodalToolOutput<Receipt>>): () => void;
  list(): ModelTool[];
  call<Result = unknown>(name: string, args: unknown, session: ToolSession, callId?: string): Promise<ToolResult<Result>>;
}
export type ChatContentPart = { type: "text"; text: string } | {
  type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" };
};
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Content arrays are supported for user messages on compatible vision models. */
  content: string | null | ChatContentPart[];
  /** Provider protocol data, not user-visible content or a memory record. */
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}
export interface ModelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [field: string]: unknown;
}
export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ModelTool[];
  max_tokens?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}
export interface ChatReply {
  text: string;
  reasoning_content?: string;
  /** Provider completion status, when supplied. "length" means output was truncated. */
  finish_reason?: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage?: ModelUsage;
}
export interface LLMAPI { chat(options: ChatOptions): Promise<ChatReply>; }

export type PersonaChoice = { id: string; name: string; model: string | null };
export interface PersonasAPI { list(): PersonaChoice[]; }
export type SessionRun = {
  sessionId?: string; persona?: string; text: string; permission?: Permission;
  origin?: OriginDetails; signal?: AbortSignal; onChunk?: (text: string) => void;
};
export type SessionQueuedRun = SessionRun & {
  /** Higher first, -100..100; equal priorities are FIFO. Never interrupts running work. */
  priority?: number;
  /** Coalesce pending requests in this plugin instance and session; the first input wins. */
  key?: string;
  /** Recheck validity when execution starts. false cancels before any model/memory work. */
  beforeRun?: () => boolean | Promise<boolean>;
};
export type SessionInfo = { id: string; name: string; updatedAt?: string };
export interface ContextPolicy {
  /** Enables future automatic diary generation; disabling keeps valid saved diaries in history. */
  diary_enabled?: boolean;
  /** Compatibility alias; new clients use diary_enabled. */
  memory_mode?: "full" | "diary" | "legacy";
  compression_trigger_percent?: number;
  compression_target_percent?: number;
  history_enabled: boolean;
  short_term_days: number;
  short_term_min_messages: number;
  long_term_enabled: boolean;
  budget_tokens: number;
  include_facts: boolean;
  include_summary: boolean;
  history_scope: "persona" | "session";
}
export interface UsageTotals { input_tokens: number; output_tokens: number; requests: number; unknown_requests: number; }
export interface RequestUsage {
  model_id: string; model: string; provider_id: string;
  input_tokens: number; output_tokens: number; used_tokens: number;
  context_window: number | null; percent: number | null; measured_at: string;
  settings_changed?: boolean;
}
export interface SessionContext {
  context_estimate?: { input_tokens: number; reserved_output_tokens: number; total_tokens: number;
    percent: number | null; source: "estimate" };
  diary?: { count: number; covered_messages: number; remaining_messages: number; chars: number;
    invalid: number; enabled: boolean; paused?: { reason: string; at: string }; notice?: string; budget_remaining: number };
  id: string;
  name: string | null;
  persona: string;
  policy: ContextPolicy;
  model: { id: string; name: string; context_window: number | null; limit_source: string };
  memory_window: { short_term_messages: number; long_term_messages: number; short_summary_chars: number; long_summary_chars: number };
  available_messages: number;
  stored_messages: number;
  consumption?: { chat: UsageTotals; memory: UsageTotals };
  usage: RequestUsage | null;
}
export interface SessionAPI {
  list(): Promise<SessionInfo[]>;
  create(name?: string): Promise<string>;
  current(): Promise<string>;
  context(id: string, persona: string): Promise<SessionContext>;
  run(input: SessionRun): Promise<string>;
  /** The input is plugin context for this run only; it is never saved as a user message. */
  runTransient(input: SessionRun): Promise<string>;
  /** Wait for the session's execution slot. Existing run retains its busy error. */
  enqueue(input: SessionQueuedRun): Promise<string>;
  enqueueTransient(input: SessionQueuedRun): Promise<string>;
}

/** Optional fields preserve legacy records; unknown data must be narrowed by its consumer. */
export interface MemoryEvent {
  id?: string; ts?: string; session?: string; type?: string;
  role?: string; text?: string; name?: string; origin?: Origin;
  /** Display snapshot on external user messages, if supplied when the message arrived. */
  senderProfile?: SenderProfile;
  persona_id?: string; persona_name?: string; persona_revision?: string;
  [field: string]: unknown;
}
export interface FactsRevision { text: string; revision: string; updated_by: string; updated_at: string; }
export interface LocalFacts extends FactsRevision { chars: number; max: number; history: FactsRevision[]; }
export type ExperienceOutcome = "pending" | "succeeded" | "failed" | "denied";
export interface ExperienceInput { event_id: string; outcome: ExperienceOutcome; text: string; origin?: OriginDetails; occurred_at?: string; }
export interface MemoryRecord {
  id: string; kind: string; text: string; source: string; ts: string;
  occurred_at?: string;
  time_range?: { start?: string; end?: string; incomplete?: boolean };
  status?: "active" | "archived" | "superseded" | "review";
  origin?: Origin; origins?: Origin[]; origins_incomplete?: boolean;
  outcome?: ExperienceOutcome | null; evidence?: string[];
  pinned?: boolean; uncertain?: boolean; persona_revision?: string | null;
  [field: string]: unknown;
}
export interface MemorySearch {
  items: (MemoryRecord & { score?: number; reason?: string; freshness?: number })[];
  trace: { query: string; selected: { id: string; reason: string; score: number }[]; estimated_tokens: number; candidates: number; omitted: number };
}
export interface ExtensionInput<Data = unknown> {
  kind: string; key: string; text: string; data?: Data; active?: boolean; origin?: OriginDetails;
}
export interface ExtensionRecord<Data = unknown> { owner: string; kind: string; key: string; version: number; data: Data; }
/** Opaque plugin-owned session data. An absent document has null revision/data. */
export interface SessionDocument<Data = unknown> { revision: string | null; data: Data | null; }
export interface DocumentWrite<Data = unknown> { key: string; revision: string | null; data: Data; }
export interface MemoryAPI {
  readFacts(): Promise<string[]>;
  localFacts(sessionId: string): Promise<LocalFacts>;
  readSession(sessionId: string, limit?: number, beforeId?: string): Promise<MemoryEvent[]>;
  /** Exclude exact historical inputs created by this plugin's sessions.run; retain original events. */
  excludeInputs(sessionId: string, messageIds: string[]): Promise<{ excluded: number }>;
  search(sessionId: string, query: string): Promise<MemorySearch>;
  recordExperience(sessionId: string, input: ExperienceInput): Promise<MemoryRecord>;
  registerType(name: string, version?: number): { kind: string; dispose(): void };
  saveExtension<Data = unknown>(sessionId: string, input: ExtensionInput<Data>): Promise<{ id: string }>;
  readExtension<Data = unknown>(sessionId: string, kind: string, key: string): Promise<ExtensionRecord<Data> | null>;
  readDocument<Data = unknown>(sessionId: string, key: string): Promise<SessionDocument<Data>>;
  saveDocument<Data = unknown>(sessionId: string, input: DocumentWrite<Data>): Promise<SessionDocument<Data>>;
}

/** Optional platform display data for this message, independent of sender identity and permission. */
export type SenderProfile = { nickname?: string; remark?: string };
export type IncomingMessageData = { peer: string; sender: string; senderProfile?: SenderProfile; messageId: string; text: string };
export type OutgoingMessage = { channel: string; account: string; peer: string; sessionId: string; text: string; deliveryId: string; replyTo?: string; transient?: true };
export type ChannelAdapter = {
  id: string; name?: string; account: string; persona?: string; permission?: Permission;
  /** Follow the active host persona for each new turn. Mutually exclusive with persona. */
  personaMode?: "active";
  send(message: OutgoingMessage, options: { signal: AbortSignal }): Promise<void>;
};
export type ChannelResult = {
  sessionId: string; messageId: string; deliveryId: string;
  status: "sent" | "generated" | "generation_failed" | "delivery_failed" | "uncertain";
  text?: string; error?: string; duplicate?: boolean; transient?: true;
};
export type ReceiveOptions = { signal?: AbortSignal };
export type TurnAppendResult = { status: "accepted" | "duplicate" | "closed" | "full" | "cancelled"; messageId: string };
/** Explicit opt-in input group. Methods remain usable across the plugin RPC boundary. */
export interface ChannelTurn {
  id: string;
  sessionId: string;
  duplicate?: boolean;
  append(message: IncomingMessageData): Promise<TurnAppendResult>;
  /** Stop accepting new input, without discarding already accepted additions. */
  closeInput(): Promise<void>;
  /** Wait for the one final delivery. Does not rerun generation or tools. */
  result(): Promise<ChannelResult>;
}
export type SendMessage = { peer: string; messageId: string; text: string };
export type RebindOptions = { expectedSessionId: string | null; sessionId?: string };
export interface ChannelHandle {
  readonly supportsSenderProfile?: true;
  /** Read the effective persona ID without creating a session or binding a peer. */
  currentPersona?(): string;
  receive(message: IncomingMessageData, options?: ReceiveOptions): Promise<ChannelResult>;
  openTurn?(message: IncomingMessageData, options?: ReceiveOptions): Promise<ChannelTurn>;
  bind(peer: string, sessionId: string): Promise<string>;
  rebind(peer: string, options: RebindOptions): Promise<string>;
  retry(peer: string, messageId: string, options?: ReceiveOptions & { direction?: "in" | "out" }): Promise<ChannelResult>;
  send(message: SendMessage, options?: ReceiveOptions): Promise<ChannelResult>;
  context(peer: string): Promise<SessionContext>;
  dispose(): void;
}
export interface ChannelAPI {
  /** Check before registering an adapter with personaMode. */
  readonly supportsActivePersona?: true;
  register(adapter: ChannelAdapter): ChannelHandle;
  send(target: SendMessage & { channel: string; account: string }, options?: ReceiveOptions): Promise<ChannelResult>;
}
export type PluginHandler = (req: IncomingMessage, res: ServerResponse, context: { signal: AbortSignal }) => unknown | Promise<unknown>;
export type PageOptions = { title: string; settings?: boolean; navigation?: boolean };
export type PluginPage = PageOptions & { owner: string; path: string };
export interface PluginWeb {
  page(path: string, handler: PluginHandler, entry?: PageOptions): () => void;
  api(path: string, handler: PluginHandler): () => void;
}
export interface PluginEvents {
  "whalelife/ready": { at: string };
  "whalelife/shutdown": { at: string };
  "channel/message": MemoryEvent;
  "channel/reply": MemoryEvent;
  "memory/recorded": MemoryEvent;
  "memory/updated": { session: string };
  "tool/called": { id: string; name: string; source: string; origin: Origin; session?: string; ok: boolean; result: unknown; transient?: true };
}
/** Can be augmented by typed plugins to declare their own service contracts. */
export interface PluginServices {
  logger: PluginLogger;
  tools: ToolsAPI;
  llm: LLMAPI;
  memory: MemoryAPI;
  approval: ApprovalAPI;
  channels: ChannelAPI;
  web: PluginWeb;
  models: ModelsAPI;
  personas: PersonasAPI;
  sessions: SessionAPI;
}
export interface PluginStatus {
  id: string;
  status: "loading" | "active" | "failed" | "stopped" | "blocked";
  error?: string;
}
