/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";

/** A confirmed transport result is conversation; pending/failed receipts are not. */
export function outgoingMessage(session: string, receipt: any): any | undefined {
  if (receipt?.type !== "channel_receipt" || receipt.direction !== "out" || receipt.status !== "sent" ||
      receipt.transient || typeof receipt.text !== "string" || !receipt.text.trim() ||
      typeof receipt.delivery_id !== "string" || !receipt.delivery_id) return;
  const ts = receipt.sent_at ?? receipt.ts;
  if (typeof ts !== "string" || !Number.isFinite(Date.parse(ts))) return;
  const context = receipt.conversation ?? {};
  const channel = context.channel ?? receipt.channel;
  return {
    type: "message", session, role: "assistant", text: receipt.text, ts,
    id: "sent_" + createHash("sha256").update(JSON.stringify([session, receipt.delivery_id])).digest("hex"),
    channel, account: context.account ?? receipt.account, peer: context.peer ?? receipt.peer,
    origin: { ...(context.origin ?? receipt.origin ?? (channel ? { channel } : {})), action: "发送消息" },
    ...(context.persona_id ? { persona_id: context.persona_id } : {}),
    ...(context.persona_name ? { persona_name: context.persona_name } : {}),
    ...(context.persona_revision ? { persona_revision: context.persona_revision } : {}),
    ...(context.timezone ? { timezone: context.timezone } : {}),
    delivery_id: receipt.delivery_id, external_message_id: receipt.external_message_id,
    delivery_status: "sent",
  };
}

/** Read-only compatibility for old receipts or interrupted message projection.
 * The first confirmed receipt fixes ordering; a materialized message wins and is
 * emitted only once. Repeated application keeps the same IDs, contents and order.
 */
export function conversationRows(rows: any[]): any[] {
  const messages = new Map(rows.filter(row => row.type === "message" && row.id).map(row => [row.id, row]));
  const projected = new Map<string, any>(), seen = new Set<string>();
  for (const row of rows) {
    const message = outgoingMessage(row.session, row);
    if (message && !projected.has(message.id)) projected.set(message.id, messages.get(message.id) ?? message);
  }
  const result: any[] = [];
  for (const row of rows) {
    const message = outgoingMessage(row.session, row);
    if (message) {
      if (!seen.has(message.id)) { seen.add(message.id); result.push(projected.get(message.id)); }
    } else if (!(row.type === "message" && projected.has(row.id))) result.push(row);
  }
  return result;
}

/**
 * 与 conversationRows 同一套判据，但保留每行在整份历史里的行号。
 * 分页取窗口时要靠这个行号当游标，所以不能先投影再切页——
 * 旧渠道的 sent 回执会被投影成助手正文，按原始 type 过滤会把它整条漏掉。
 */
export function conversationWindows(entries: { row: any; at: number }[]): { row: any; at: number }[] {
  const messages = new Map(entries.filter(e => e.row.type === "message" && e.row.id).map(e => [e.row.id, e.row]));
  const projected = new Map<string, any>();
  for (const entry of entries) {
    const message = outgoingMessage(entry.row.session, entry.row);
    if (message && !projected.has(message.id)) projected.set(message.id, messages.get(message.id) ?? message);
  }
  const seen = new Set<string>();
  const out: { row: any; at: number }[] = [];
  for (const entry of entries) {
    const message = outgoingMessage(entry.row.session, entry.row);
    if (message) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        out.push({ row: projected.get(message.id), at: entry.at });
      }
      continue;
    }
    // 只留真正会显示成气泡的行：工具记录不占一页，否则前端滤完就成空白页
    if (entry.row.type === "message" && !projected.has(entry.row.id)) out.push(entry);
  }
  return out;
}
