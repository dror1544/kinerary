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
import { CLOSE_REASONS, chatBindingCodeDigest, cleanChatText, extractChatBindingCode } from "./chat-binding-codes.js";
import { structuredLog } from "./redaction.js";
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
    // THE READ IS LOCKED, as the WhatsApp redeem's is (chat-binding-codes.ts): `removeMember` takes the trip's memberships FOR UPDATE, so an
    // unlocked check could pass, the removal commit, and this transaction then bind a group for an account that no longer owns the trip.
    // FOR SHARE makes the two take turns. Lock order: code row, then this membership, then the group's binding and `trips` (bindGroupToTrip).
    const held = await client.query<{ role: string; dashboard_access: boolean }>(
      "SELECT role, dashboard_access FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE",
      [row.trip_id, row.issued_by_user_id],
    );
    const issuerOwns = held.rows.some((m) => m.role === "owner" && m.dashboard_access === true);
    if (!issuerOwns) {
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
 *
 * IT MUST NEVER STALL THE RELAY. The relay's poller handles one update at a time and the database has no lock or statement timeout of
 * its own (0), so a plain UPDATE would wait, and every chat with it, for as long as any other transaction holds that binding row
 * (a redemption, a teardown). The write runs in a transaction of its own with a short `lock_timeout` and `statement_timeout`: on
 * timeout (SQLSTATE 55P03 or 57014) it throws, and the caller logs and skips; the title is a label, and the next message tries again.
 */
export const TITLE_LOCK_TIMEOUT_MS = 500;
export const TITLE_STATEMENT_TIMEOUT_MS = 2000;
export async function recordTelegramGroupTitle(db: pg.Pool, chatId: string, title: unknown): Promise<boolean> {
  const cleaned = cleanChatText(title, 100);
  if (cleaned === null || !TELEGRAM_GROUP_CHAT_ID.test(chatId)) return false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${TITLE_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${TITLE_STATEMENT_TIMEOUT_MS}ms'`);
    const r = await client.query(
      `UPDATE control_plane.telegram_chat_bindings SET chat_title = $2
        WHERE chat_id = $1 AND closed_at IS NULL AND platform = 'telegram' AND chat_title IS DISTINCT FROM $2`,
      [chatId, cleaned],
    );
    await client.query("COMMIT");
    return (r.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

/**
 * The bot leaves the chat Unlink just closed, unless the chat has been bound again in the meantime (to this trip or another): then the
 * bot stays, because the group has a trip again. Best effort in every way: a failure is logged (HTTP status only, never the chat id)
 * and swallowed, nothing retries. Returns what happened, for the caller's tests. The check and the call are two steps, so a bind
 * landing in the few milliseconds between them is not caught; that costs trip B's group its bot until someone adds it again (no
 * handler closes a binding when the bot leaves), and it needs the owner's Unlink and another trip's main organizer in the same group
 * at the same moment.
 */
export async function leaveClosedTelegramGroup(
  db: Queryable,
  telegram: { leaveChat(chatId: string): Promise<void> } | undefined,
  chatId: string,
  log: (line: string) => void,
): Promise<"left" | "failed" | "skipped_bound_again" | "unavailable"> {
  if (!telegram) {
    log(structuredLog("warn", "telegram_groups.leave_unavailable", { effect: "the binding is closed; the bot stays in the group, nothing here can make it leave" }));
    return "unavailable";
  }
  const open = await db.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL LIMIT 1", [chatId]);
  if ((open.rowCount ?? 0) > 0) {
    log(structuredLog("info", "telegram_groups.leave_skipped", { reason: "the group was bound again before the bot left" }));
    return "skipped_bound_again";
  }
  try {
    await telegram.leaveChat(chatId);
    return "left";
  } catch (error) {
    const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
    log(structuredLog("warn", "telegram_groups.leave_failed", { http_status: typeof status === "number" ? status : null, effect: "the binding is closed; the bot may still be in the group" }));
    return "failed";
  }
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
 * Unlink, from the dashboard: the binding closes `dashboard_removed` and NOTHING is posted to the group (there is no existing Telegram
 * unbind to keep, spec 690). It returns the chat so the caller can make the bot LEAVE it (owner's decision 2026-11-27, D6): the route
 * does that after this statement (`leaveClosedTelegramGroup`), best effort. Only an open Telegram GROUP binding of THIS trip can be named: another trip's, a
 * private chat's, a WhatsApp binding, a closed one, a malformed id are all "not found".
 */
export async function removeTelegramGroup(
  db: pg.Pool,
  input: { tripId: string; bindingId: string },
): Promise<{ ok: true; chatId: string } | { ok: false; reason: "NOT_FOUND" }> {
  if (!OPAQUE_ID.test(input.bindingId ?? "")) return { ok: false, reason: "NOT_FOUND" };
  // The one statement both closes the binding and says WHICH chat it was: the caller leaves exactly the chat whose binding THIS
  // statement closed. A group moved to another trip BEFORE this statement is not found here, so the bot is not taken out of it;
  // a bind AFTER it is caught by `leaveClosedTelegramGroup`'s check. `chatId` is for the caller's Telegram call only; no route sends it to a client.
  const r = await db.query<{ chat_id: string }>(
    `UPDATE control_plane.telegram_chat_bindings
        SET closed_at = now(), closed_reason = $3
      WHERE id = $1 AND trip_id = $2 AND platform = 'telegram' AND chat_id ~ '^-[0-9]+$' AND closed_at IS NULL
      RETURNING chat_id`,
    [input.bindingId, input.tripId, CLOSE_REASONS.dashboardRemoved],
  );
  const row = r.rows[0];
  return row ? { ok: true, chatId: row.chat_id } : { ok: false, reason: "NOT_FOUND" };
}
