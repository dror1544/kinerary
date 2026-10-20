/**
 * The dashboard's one-time Telegram link: how an organizer (re)links a Telegram
 * account to ONE trip after an Unlink, or adds a second one.
 *
 * WHY THIS IS THE ONLY WAY BACK. An organizer link is a sign-in path
 * (telegram-mini-app.ts), so Unlinking it has to stick: redeeming an interview
 * link — which may have been forwarded — must not quietly undo it
 * (`linkTelegramOrganizerInTx` refuses a pair/trip that was unlinked). Undoing
 * an Unlink therefore needs BOTH halves proven at once, by two different
 * things:
 *
 *   - the ACCOUNT, by the signed-in dashboard session (and its CSRF token) that
 *     issues the token here, for a trip the account runs;
 *   - the TELEGRAM IDENTITY, by the update the bot receives on its own
 *     authenticated connection when someone opens `t.me/<bot>?start=<token>`
 *     and sends it (chat-router.ts / relay dispatch). The sender id comes from
 *     that update, never from the message.
 *
 * Whoever holds the URL for its few minutes can link THEIR Telegram — which is
 * why it is single use, short lived, bound to one user and one trip, and why a
 * first sign-in through the new link announces itself to the account owner
 * (telegram-mini-app.ts) and the card lists it for Unlink. It is the same
 * trade the interview link makes, with a shorter fuse.
 *
 * The token pattern is the enrollment's (enrollment.ts): random bytes, only the
 * sha256 stored, row-locked consume. No new crypto.
 *
 * Refusals are UNIFORM. Expired, used, revoked, unknown, the issuer's
 * membership gone, a retired trip — one `INVALID` to the caller and one
 * sentence to the chat; a distinguishable refusal confirms a guess.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { digestTelegramId, isPrivateChatId } from "./identity.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

/** How long an issued link works. Short on purpose; issuing another is one click. */
export const TELEGRAM_LINK_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * `lk_` + 32 base64url characters = 35, inside Telegram's 64-character
 * `start` alphabet. An enrollment token is 43 characters, so the two can never
 * be confused by length even when a random enrollment token happens to start
 * with the same three characters.
 */
export const LINK_TOKEN_PATTERN = /^lk_[A-Za-z0-9_-]{32}$/;

const roleOk = "m.role IN ('owner', 'organizer') AND m.dashboard_access = true";

function tokenDigest(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** The token a `/start` payload carries, or null when it is not one of ours. */
export function telegramLinkTokenFromStartPayload(payload: string | null): string | null {
  return payload !== null && LINK_TOKEN_PATTERN.test(payload) ? payload : null;
}

export type IssueLinkTokenResult =
  | { ok: true; token: string; expiresAt: Date }
  /** Not a trip this user runs — including one that does not exist, is retired or torn down. */
  | { ok: false; reason: "NOT_FOUND" };

/**
 * Issues a link for `tripId` to `userId`, who must run that trip (an active
 * owner or organizer membership with dashboard access). At most one live token
 * per (user, trip): a new one revokes the previous, so a link the organizer
 * lost, or sent to the wrong person, can be replaced by asking again.
 *
 * The membership row is locked, so two tabs asking at once serialise rather
 * than racing the live-token index.
 */
export async function issueTelegramLinkToken(
  db: pg.Pool,
  input: { userId: string; tripId: string; ttlSeconds?: number },
): Promise<IssueLinkTokenResult> {
  const ttl = input.ttlSeconds ?? TELEGRAM_LINK_TOKEN_TTL_SECONDS;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const allowed = await client.query(
      `SELECT 1
         FROM control_plane.trip_memberships m
         JOIN control_plane.trips t ON t.id = m.trip_id
         JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.trip_id = $1 AND m.user_id = $2 AND m.status = 'active' AND ${roleOk}
          AND ${NOT_RETIRED_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM control_plane.telegram_chat_bindings d
                 WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')
        FOR UPDATE OF m`,
      [input.tripId, input.userId],
    );
    if (!allowed.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_FOUND" };
    }
    // Housekeeping with the write that makes the rows: nothing needs a sweeper.
    await client.query(
      "DELETE FROM control_plane.telegram_link_tokens WHERE state <> 'issued' AND created_at < now() - interval '1 day'",
    );
    await client.query(
      "UPDATE control_plane.telegram_link_tokens SET state = 'revoked' WHERE user_id = $1 AND trip_id = $2 AND state = 'issued'",
      [input.userId, input.tripId],
    );
    const token = `lk_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await client.query(
      `INSERT INTO control_plane.telegram_link_tokens (id, user_id, trip_id, token_digest, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [opaqueId("tlt"), input.userId, input.tripId, tokenDigest(token), expiresAt],
    );
    await client.query("COMMIT");
    return { ok: true, token, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type RedeemLinkTokenResult =
  | { ok: true; tripTitle: string; alreadyLinked: boolean }
  | { ok: false; reason: "INVALID" };

/**
 * Redeems a link token for the Telegram account that sent it. `telegramUserId`
 * is the update's verified sender and must be a private-chat id (a positive
 * integer); anything else is refused without touching the token, so a link
 * opened in a group stays usable in the DM where it belongs.
 *
 * Everything is re-checked at redemption, not trusted from issue time: the
 * issuer must STILL run the trip. Consuming the token and writing the link are
 * one transaction, so a link is never left half made.
 *
 * A live link for the same (Telegram account, user, trip) is not an error — the
 * token is consumed and the chat is told it is linked. A REVOKED link does not
 * stand in the way: this is the path back from an Unlink.
 */
export async function redeemTelegramLinkToken(
  db: pg.Pool,
  rawToken: string,
  telegramUserId: string,
): Promise<RedeemLinkTokenResult> {
  if (!LINK_TOKEN_PATTERN.test(rawToken) || !isPrivateChatId(telegramUserId)) return { ok: false, reason: "INVALID" };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ id: string; user_id: string; trip_id: string; state: string; expires_at: Date }>(
      `SELECT id, user_id, trip_id, state, expires_at
         FROM control_plane.telegram_link_tokens WHERE token_digest = $1 FOR UPDATE`,
      [tokenDigest(rawToken)],
    );
    const token = row.rows[0];
    if (!token || token.state !== "issued" || token.expires_at.getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "INVALID" };
    }
    const trip = await client.query<{ title: string }>(
      `SELECT COALESCE(t.title, t.destination_label, 'Untitled trip') AS title
         FROM control_plane.trip_memberships m
         JOIN control_plane.trips t ON t.id = m.trip_id
         JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.trip_id = $1 AND m.user_id = $2 AND m.status = 'active' AND ${roleOk}
          AND ${NOT_RETIRED_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM control_plane.telegram_chat_bindings d
                 WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')`,
      [token.trip_id, token.user_id],
    );
    if (!trip.rows[0]) {
      // The issuer no longer runs the trip: the token is worthless, and now spent.
      await client.query("UPDATE control_plane.telegram_link_tokens SET state = 'revoked' WHERE id = $1", [token.id]);
      await client.query("COMMIT");
      return { ok: false, reason: "INVALID" };
    }
    const digest = digestTelegramId(telegramUserId);
    const live = await client.query<{ id: string }>(
      `SELECT id FROM control_plane.telegram_organizer_trip_links
        WHERE telegram_subject_digest = $1 AND user_id = $2 AND trip_id = $3 AND revoked_at IS NULL`,
      [digest, token.user_id, token.trip_id],
    );
    let linkId = live.rows[0]?.id ?? null;
    if (!linkId) {
      linkId = opaqueId("otl");
      await client.query(
        `INSERT INTO control_plane.telegram_organizer_trip_links
           (id, user_id, trip_id, telegram_subject_digest, verified_via)
         VALUES ($1, $2, $3, $4, 'dashboard_link_token')`,
        [linkId, token.user_id, token.trip_id, digest],
      );
    }
    await client.query(
      "UPDATE control_plane.telegram_link_tokens SET state = 'consumed', consumed_at = now(), consumed_link_id = $2 WHERE id = $1",
      [token.id, linkId],
    );
    await client.query("COMMIT");
    return { ok: true, tripTitle: trip.rows[0].title, alreadyLinked: live.rows.length > 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
