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
