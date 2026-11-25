import { randomBytes } from "node:crypto";
import type pg from "pg";
import { structuredLog } from "./redaction.js";
import { isPrivateChatId } from "./identity.js";

/**
 * Who a message about a trip is FOR, as a role of the trip and never as a chat id
 * (video Release 1C, docs/specs/sprint-9/x-video-r1-group-line.md, "Who receives it").
 *
 * The outbox used to send to whatever chat id an enqueuer wrote into `recipient`, and nothing re-checked at send time
 * that the chat still belonged to the trip. A TARGETED row has no recipient (a CHECK in the database), only a trip and a
 * target; the chat is resolved from the trip's own open `telegram_chat_bindings` rows, and the dispatcher re-reads the
 * binding at the moment of sending (`confirmAudience`). No caller passes a chat id in, and nothing outside the control
 * plane can create a targeted row: `enqueueTripMessage` below is the only writer, and it is called by the two pollers (plan-change-poller.ts, group-photo-poller.ts; plan-change-boundary.test.ts pins the list).
 *
 * `trip_group` is the only target built in this slice. `trip_organizer` is in the database's CHECK so a later release
 * (the morning briefing, flight alerts) does not need a migration, but nothing here resolves it: it resolves to nobody,
 * and a row that carried it would end `skipped`, never sent. A direct message to a person is a path that deserves its
 * own review, and 1C does not need one.
 *
 * Telegram is the only channel today. A second channel adds a source to `resolveTripAudience`, and no caller changes.
 */
export type AudienceTarget = "trip_group" | "trip_organizer";

export interface AudienceMember {
  channel: "telegram";
  bindingId: string;
  chatId: string;
}

export type AudienceSkipReason = "binding_closed" | "binding_trip_mismatch" | "no_audience" | "target_unsupported";

/**
 * A Telegram group's chat id is negative. A private chat's is a plain number (identity.ts), and anything else is no group.
 * WHATSAPP (spec 625, "Chat kind"): a WhatsApp group's chat id (`wa_<hex>@g`) matches neither shape, so it is EXCLUDED on
 * purpose and no outbox message goes to a WhatsApp group in this slice (plan-change lines, scheduled messages and
 * notifications stay on Telegram; whatsapp-exclusions.test.ts pins it). Do not widen this to `chatKind`: that would send them.
 */
function isGroupChatId(chatId: string): boolean {
  return !isPrivateChatId(chatId) && /^-\d{1,20}$/.test(chatId);
}

type Queryable = Pick<pg.Pool, "query">;

/**
 * The trip's audience for `target`, from its own open bindings, in a stable order.
 * `trip_group`: every open binding of the trip whose chat id is a group's. Others: nobody (see above).
 */
export async function resolveTripAudience(db: Queryable, tripId: string, target: AudienceTarget): Promise<AudienceMember[]> {
  if (target !== "trip_group") return [];
  const result = await db.query<{ id: string; chat_id: string }>(
    `SELECT id, chat_id FROM control_plane.telegram_chat_bindings
     WHERE trip_id = $1 AND closed_at IS NULL
     ORDER BY created_at, id`,
    [tripId],
  );
  return result.rows
    .filter((row) => isGroupChatId(row.chat_id))
    .map((row) => ({ channel: "telegram" as const, bindingId: row.id, chatId: row.chat_id }));
}

export type ConfirmResult = { ok: true; chatId: string } | { ok: false; reason: AudienceSkipReason };

export interface TargetedRow {
  trip_id: string | null;
  target: string | null;
  binding_id: string | null;
}

/**
 * Re-reads the binding a targeted row was addressed to, AT SEND TIME, and says where the message may go.
 * The chat comes from the binding row and from nothing on the outbox row but its id. The binding must still be open
 * (a group that left in between gets nothing) and must belong to the row's own trip (a row enqueued for A that names
 * B's binding sends nothing), and for `trip_group` its chat must be a group's.
 */
export async function confirmAudience(db: Queryable, row: TargetedRow): Promise<ConfirmResult> {
  if (row.target !== "trip_group") return { ok: false, reason: "target_unsupported" };
  if (!row.trip_id || !row.binding_id) return { ok: false, reason: "no_audience" };
  const result = await db.query<{ trip_id: string; chat_id: string; closed_at: Date | null }>(
    "SELECT trip_id, chat_id, closed_at FROM control_plane.telegram_chat_bindings WHERE id = $1",
    [row.binding_id],
  );
  const binding = result.rows[0];
  if (!binding || binding.closed_at !== null) return { ok: false, reason: "binding_closed" };
  if (binding.trip_id !== row.trip_id) return { ok: false, reason: "binding_trip_mismatch" };
  if (!isGroupChatId(binding.chat_id)) return { ok: false, reason: "no_audience" };
  return { ok: true, chatId: binding.chat_id };
}

export interface EnqueueTripMessageInput {
  tripId: string;
  /** The notification type the dispatcher words (outbox-dispatcher.ts's messageTextFor). */
  type: string;
  target: AudienceTarget;
  payload: Record<string, unknown>;
  /** Idempotency: a second enqueue with the same key writes nothing. */
  dedupeKey: string;
}

/**
 * Writes one outbox row per audience binding, resolved now, with `binding_id` set, `recipient` NULL and the adapter
 * `control-plane`. Returns how many rows were written: 0 when the audience is empty, or when this dedupe key was already
 * enqueued. The only writer of targeted rows.
 *
 * Each row's stored key is `<dedupeKey>#<binding id>`: one enqueue makes a row per group, and the unique index is over
 * what is stored. Pass a transaction's client to make the enqueue part of it.
 */
export async function enqueueTripMessage(db: Queryable, input: EnqueueTripMessageInput): Promise<number> {
  const audience = await resolveTripAudience(db, input.tripId, input.target);
  let written = 0;
  for (const member of audience) {
    const result = await db.query(
      `INSERT INTO control_plane.notification_outbox
         (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target, binding_id, dedupe_key)
       VALUES ($1, $2, $3, NULL, $4::jsonb, NULL, $3, 'control-plane', 'pending', $5, $6, $7)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        `notif_${randomBytes(16).toString("hex")}`,
        input.tripId,
        input.type,
        JSON.stringify(input.payload),
        input.target,
        member.bindingId,
        `${input.dedupeKey}#${member.bindingId}`,
      ],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

/** The log line for a targeted row that was skipped: the reason and the ids of the row, never a chat id. */
export function skippedLine(notificationId: string, target: string | null, reason: AudienceSkipReason | "no_text"): string {
  return structuredLog("info", "outbox.targeted_skipped", { notification_id: notificationId, target, reason });
}
