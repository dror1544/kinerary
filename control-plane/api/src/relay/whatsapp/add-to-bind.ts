/**
 * Binding a WhatsApp group by adding the number to it (spec 625, AC-28).
 *
 * THE RULE, ALL OF IT. The bridge reports the number added to a group, and who added
 * it (`addedBy`, when the notification names them). The group is bound ONLY when that
 * participant's opaque id has a WhatsApp person link that names an account which is, at
 * that moment, the ACTIVE OWNER of trip T, where T is the trip the participant's own
 * private chat is bound to, T is not retired, and T's `whatsapp` switch is on. Every
 * other case binds nothing and sends nothing: added by anyone else, by a secondary
 * organizer, by an owner with no connected private chat, an event that does not say by
 * whom, or a group that is already bound. The group code still works for all of them.
 *
 * WHAT PROVES WHAT. `addedBy` comes from the unofficial client, the same source that
 * says who sent a message; it is matched only through the keyed opaque id the person's
 * own `me` code bound, never through a name or a number.
 *
 * LOCK ORDER (spec "Lock order", the direction redemption takes): the owner's
 * membership FOR SHARE (so `removeMember`, which locks memberships and then closes
 * bindings, takes turns with this), then the open bindings of the group and of the
 * adder's private chat FOR UPDATE in `chat_id` order, then the insert, which selects the
 * trip only if it is not retired (`openBinding`). The group's own row does not exist yet,
 * so the partial unique index is what settles two concurrent adds: the loser's 23505 is
 * "already bound".
 */
import type pg from "pg";
import { WHATSAPP_SWITCH } from "../../chat-binding-codes.js";
import { featureEnabled } from "../../feature-switches.js";
import { openBinding } from "../../group-binding.js";
import { WHATSAPP_GROUP_CHAT_ID, WHATSAPP_SENDER_ID, isAcceptedWhatsAppGroupId } from "../../identity.js";
import { NOT_RETIRED_SQL } from "../../trip-retirement.js";

export type AddToBindResult =
  | { bound: true; bindingId: string; tripId: string }
  | {
      bound: false;
      reason:
        | "NO_ADDER"
        | "BAD_GROUP"
        | "ADDER_NOT_CONNECTED"
        | "ADDER_NOT_OWNER"
        | "TRIP_UNAVAILABLE"
        | "ALREADY_BOUND";
    };

export interface AddToBindInput {
  /** The group's alias (`wa_<32 hex>@g`). */
  groupAlias: string;
  /** The group's REAL id, as the bridge reported it: written to `transport_address` and nowhere else. */
  groupRealId: string;
  /** The adder's opaque id (`wa_<32 hex>`), or null when the event did not name them. */
  adderId: string | null;
  /** The group's title, already cleaned, when known. */
  title: string | null;
  log?: (line: string) => void;
}

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "23505";

export async function bindGroupByAdding(db: pg.Pool, input: AddToBindInput): Promise<AddToBindResult> {
  if (!input.adderId || !WHATSAPP_SENDER_ID.test(input.adderId)) return { bound: false, reason: "NO_ADDER" };
  if (!WHATSAPP_GROUP_CHAT_ID.test(input.groupAlias) || !isAcceptedWhatsAppGroupId(input.groupRealId)) {
    return { bound: false, reason: "BAD_GROUP" };
  }
  const adderChat = `${input.adderId}@p`;

  // Which trip, and whose account: read first without locks to find the candidates, then
  // every fact is read again under the locks below before anything is written.
  const candidate = await db.query<{ trip_id: string; account_user_id: string | null }>(
    `SELECT b.trip_id, l.account_user_id
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trip_person_links l
         ON l.trip_id = b.trip_id AND l.platform = 'whatsapp' AND l.telegram_user_id = $2
      WHERE b.chat_id = $1 AND b.platform = 'whatsapp' AND b.closed_at IS NULL`,
    [adderChat, input.adderId],
  );
  const found = candidate.rows[0];
  if (!found || !found.account_user_id) return { bound: false, reason: "ADDER_NOT_CONNECTED" };
  const tripId = found.trip_id;
  const accountId = found.account_user_id;

  const client = await db.connect();
  const rollback = async () => { await client.query("ROLLBACK").catch(() => undefined); };
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT 1 FROM control_plane.trip_memberships
        WHERE trip_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'
        FOR SHARE`,
      [tripId, accountId],
    );
    if (!owner.rowCount) { await rollback(); return { bound: false, reason: "ADDER_NOT_OWNER" }; }
    const open = await client.query<{ chat_id: string; trip_id: string }>(
      `SELECT chat_id, trip_id FROM control_plane.telegram_chat_bindings
        WHERE chat_id = ANY($1::text[]) AND closed_at IS NULL
        ORDER BY chat_id FOR UPDATE`,
      [[input.groupAlias, adderChat]],
    );
    if (open.rows.some((r) => r.chat_id === input.groupAlias)) { await rollback(); return { bound: false, reason: "ALREADY_BOUND" }; }
    // The adder's own chat must STILL be bound to the same trip, with the same account's link.
    const mine = open.rows.find((r) => r.chat_id === adderChat);
    if (!mine || mine.trip_id !== tripId) { await rollback(); return { bound: false, reason: "ADDER_NOT_CONNECTED" }; }
    const link = await client.query(
      `SELECT 1 FROM control_plane.trip_person_links
        WHERE trip_id = $1 AND platform = 'whatsapp' AND telegram_user_id = $2 AND account_user_id = $3`,
      [tripId, input.adderId, accountId],
    );
    if (!link.rowCount) { await rollback(); return { bound: false, reason: "ADDER_NOT_CONNECTED" }; }
    const live = await client.query(
      `SELECT 1 FROM control_plane.trips t WHERE t.id = $1 AND ${NOT_RETIRED_SQL}`,
      [tripId],
    );
    if (!live.rowCount || !(await featureEnabled(client, tripId, WHATSAPP_SWITCH, input.log))) {
      await rollback();
      return { bound: false, reason: "TRIP_UNAVAILABLE" };
    }
    const bindingId = await openBinding(client, input.groupAlias, tripId, {
      chatTitle: input.title,
      transportAddress: input.groupRealId,
    });
    await client.query("COMMIT");
    return { bound: true, bindingId, tripId };
  } catch (error) {
    await rollback();
    if (isUniqueViolation(error)) return { bound: false, reason: "ALREADY_BOUND" };
    // `openBinding` throws when the trip was retired between the check and the insert.
    if (error instanceof Error && /openBinding: trip row missing/.test(error.message)) return { bound: false, reason: "TRIP_UNAVAILABLE" };
    throw error;
  } finally {
    client.release();
  }
}
