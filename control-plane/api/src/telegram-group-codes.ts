/**
 * Telegram groups from the dashboard (#690, docs/specs/sprint-9/690-dashboard-chat-parity.md).
 *
 * The owner's dashboard mints a one-time code (`chat_binding_codes`, platform `telegram`, kind `group`); the link it builds is
 * `?startgroup=<code>`, so Telegram adds the bot to the group the owner picks and posts `/start@<bot> <code>` THERE, from the
 * person who added it. `redeemTelegramGroupCode` then binds the group through `bindGroupToTrip`, the same body `/group KIN-…`
 * uses: there is one way a group gets bound, and this is a second door onto it, not a second mechanism.
 *
 * WHO MAY REDEEM. Not "whoever sends it". The sender is Telegram's own `from.id` and must be the trip's MAIN organizer
 * (`isMainTripOrganizer`: a live per-trip link to an active owner membership, or the interview's organizer person link), the proof
 * `/group` asks for before it hands anything out. A forwarded link redeemed by anyone else binds nothing and is not spent. (WhatsApp's
 * group code binds for whoever sends it because a WhatsApp sender cannot be checked that way; here it can, so it is.)
 *
 * LOCK ORDER, the same as `redeemGroupBindingToken`: the code row `FOR UPDATE` first (teardown expires codes first, before it closes
 * bindings and renames the trip), then the group's open binding, then `trips` through the INSERT's foreign key.
 */
import type pg from "pg";
import { isMainTripOrganizer } from "./chat-router.js";
import { CLOSE_REASONS, chatBindingCodeDigest, cleanChatText, extractChatBindingCode, tripEntitlement } from "./chat-binding-codes.js";
import { bindGroupToTrip, isActiveChatBindingConflict, type GroupBindingRedeemResult } from "./group-binding.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

type Queryable = Pick<pg.Pool, "query">;

/** A Telegram supergroup or group id: a negative number. A private chat's id is the user's own, positive. */
export const TELEGRAM_GROUP_CHAT_ID = /^-[0-9]{1,20}$/;
const OPAQUE_ID = /^[a-z]{2,12}_[A-Za-z0-9]{8,64}$/;

/**
 * The code a `/start` payload IS, canonicalised, or null: exactly one code and nothing else, the shape a `?startgroup=` link
 * delivers. Looser matching (a code amid words) is for people pasting, and a Telegram code is never pasted.
 */
export function telegramGroupCodeFromStartPayload(payload: string | null | undefined): string | null {
  const code = extractChatBindingCode(payload);
  return code !== null && code === (payload ?? "").trim().toUpperCase() ? code : null;
}

/**
 * Redeems a Telegram group code posted in a group, in ONE transaction. Same result shape as `redeemGroupBindingToken`, so the relay
 * answers it with the same sentences. Spent only by a success (or by finding its issuer no longer an owner, which can never
 * work again); a wrong sender, an expiry or a move the sender may not make leaves the code live for its owner.
 */
export async function redeemTelegramGroupCode(
  db: pg.Pool,
  code: string,
  chatId: string,
  senderTelegramUserId: string,
): Promise<GroupBindingRedeemResult> {
  // A private chat's id is the user's own: binding it would at best do nothing and at worst rebind the channel the code came on.
  if (!TELEGRAM_GROUP_CHAT_ID.test(chatId)) return { ok: false, reason: "NOT_A_GROUP" };
  const client = await db.connect();
  const rollback = async () => { await client.query("ROLLBACK").catch(() => undefined); };
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      id: string; trip_id: string; issued_by_user_id: string; expired: boolean; trip_retired: boolean;
    }>(
      `SELECT c.id, c.trip_id, c.issued_by_user_id, c.expires_at <= now() AS expired,
              NOT EXISTS (SELECT 1 FROM control_plane.trips t WHERE t.id = c.trip_id AND ${NOT_RETIRED_SQL}) AS trip_retired
         FROM control_plane.chat_binding_codes c
        WHERE c.code_digest = $1 AND c.state = 'issued' AND c.platform = 'telegram' AND c.kind = 'group'
        FOR UPDATE OF c`,
      [chatBindingCodeDigest(code)],
    );
    const row = found.rows[0];
    if (!row) { await rollback(); return { ok: false, reason: "NOT_FOUND" }; }
    if (row.expired) { await rollback(); return { ok: false, reason: "EXPIRED" }; }
    // The proof: Telegram's verified id of the sender, against the control plane's own links. Plain reads on this connection.
    if (!(await isMainTripOrganizer(client, row.trip_id, senderTelegramUserId))) { await rollback(); return { ok: false, reason: "WRONG_SENDER" }; }
    if (row.trip_retired) { await rollback(); return { ok: false, reason: "TRIP_RETIRED" }; }
    // The account that minted it must still own the trip: an owner removed since binds nothing, and the code is dead for good.
    const issuer = await tripEntitlement(client, row.trip_id, row.issued_by_user_id);
    if (!issuer.owner) {
      await client.query("UPDATE control_plane.chat_binding_codes SET state = 'expired' WHERE id = $1", [row.id]);
      await client.query("COMMIT");
      return { ok: false, reason: "NOT_FOUND" };
    }
    const bound = await bindGroupToTrip(client, { chatId, tripId: row.trip_id, senderTelegramUserId });
    if (!bound.ok) { await rollback(); return { ok: false, reason: bound.reason }; }
    await client.query(
      "UPDATE control_plane.chat_binding_codes SET state = 'redeemed', binding_id = $2, redeemed_at = now() WHERE id = $1",
      [row.id, bound.bindingId],
    );
    await client.query("COMMIT");
    return {
      ok: true, tripId: row.trip_id, rebound: bound.rebound,
      ...(bound.movedFromTripId !== undefined ? { movedFromTripId: bound.movedFromTripId } : {}),
    };
  } catch (error) {
    await rollback();
    // Somebody else's binding of this chat committed between our reads and our INSERT: not free, and this sender was never checked
    // against whoever holds it. The same uniform refusal as every other non-organizer.
    if (isActiveChatBindingConflict(error)) return { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" };
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The group's title, written to the open binding of that chat, in a statement of its own after the bind (never inside the bind's
 * INSERT, so a Telegram bind keeps working on a database without the column). Change-only: a row that already holds this title is
 * not touched. Returns whether a row changed. A title is text a person chose: cleaned to one line, never acted on.
 */
export async function recordTelegramGroupTitle(db: Queryable, chatId: string, title: unknown): Promise<boolean> {
  const cleaned = cleanChatText(title, 100);
  if (cleaned === null || !TELEGRAM_GROUP_CHAT_ID.test(chatId)) return false;
  const r = await db.query(
    `UPDATE control_plane.telegram_chat_bindings SET chat_title = $2
      WHERE chat_id = $1 AND closed_at IS NULL AND platform = 'telegram' AND chat_title IS DISTINCT FROM $2`,
    [chatId, cleaned],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Does this account hold a live per-trip Telegram link to the trip? The dashboard asks before it mints: a code can only be redeemed
 * by a Telegram account the control plane knows as the trip's main organizer, so for an owner with none a link would be a dead end.
 * (The redemption makes its own, final check; this one only keeps the page from handing out something that cannot work.)
 */
export async function ownerHasLiveTelegramLink(db: Queryable, tripId: string, userId: string): Promise<boolean> {
  const r = await db.query(
    "SELECT 1 FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND user_id = $2 AND revoked_at IS NULL LIMIT 1",
    [tripId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface TelegramGroup {
  bindingId: string;
  /** The group's title as Telegram last told us, cleaned; null when we have never seen one (a group bound before titles were kept). */
  name: string | null;
  connectedAt: string;
}

/**
 * The trip's open Telegram GROUP bindings, for the owner: binding id, title, when. Only a negative chat id is a group; the same
 * table holds the organizer's private chat (a positive id), which is not a group and is not listed. No chat id, no sender, no code.
 */
export async function listTelegramGroups(db: Queryable, tripId: string): Promise<TelegramGroup[]> {
  const r = await db.query<{ id: string; chat_title: string | null; created_at: Date }>(
    `SELECT id, chat_title, created_at FROM control_plane.telegram_chat_bindings
      WHERE trip_id = $1 AND platform = 'telegram' AND chat_id ~ '^-[0-9]+$' AND closed_at IS NULL
      ORDER BY created_at, id`,
    [tripId],
  );
  return r.rows.map((row) => ({ bindingId: row.id, name: cleanChatText(row.chat_title), connectedAt: row.created_at.toISOString() }));
}

/**
 * Unlink, from the dashboard: the binding closes `dashboard_removed` and NOTHING is sent to the group (there is no existing Telegram
 * unbind to keep, spec 690). The bot stays a member until someone removes it in Telegram. Only an open Telegram GROUP binding of
 * THIS trip can be named: another trip's, a private chat's, a WhatsApp binding, a closed one, a malformed id are all "not found".
 */
export async function removeTelegramGroup(
  db: pg.Pool,
  input: { tripId: string; bindingId: string },
): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" }> {
  if (!OPAQUE_ID.test(input.bindingId ?? "")) return { ok: false, reason: "NOT_FOUND" };
  const r = await db.query(
    `UPDATE control_plane.telegram_chat_bindings
        SET closed_at = now(), closed_reason = $3
      WHERE id = $1 AND trip_id = $2 AND platform = 'telegram' AND chat_id ~ '^-[0-9]+$' AND closed_at IS NULL`,
    [input.bindingId, input.tripId, CLOSE_REASONS.dashboardRemoved],
  );
  return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, reason: "NOT_FOUND" };
}
