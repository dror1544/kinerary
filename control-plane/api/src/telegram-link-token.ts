/**
 * The dashboard's one-time Telegram link: how an organizer (re)links a Telegram
 * account to ONE trip after an Unlink, or adds a second one.
 *
 * WHY THIS IS THE WAY BACK THROUGH TELEGRAM (the other is `restoreTelegramLink`,
 * at the bottom of this file, for the very account the owner Unlinked). An
 * organizer link is a sign-in path (telegram-mini-app.ts), so Unlinking it has
 * to stick: redeeming an interview link — which may have been forwarded — must
 * not quietly undo it (`linkTelegramOrganizerInTx` refuses a pair/trip that was
 * unlinked). Undoing an Unlink for an account that cannot be named from a row
 * therefore needs BOTH halves proven at once, by two different things:
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
import { digestTelegramId, isPrivateChatId, type TelegramName } from "./identity.js";
import { LIVE_INTAKE_SESSION_PREDICATE } from "./organizer-trips.js";
import { CHAT_DIGEST_SQL } from "./telegram-mini-app.js";
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

/**
 * The ONE answer to "does this user run this trip today": an active owner or
 * organizer membership with dashboard access, of a user who is active, on a trip
 * that is not retired or torn down. Issuing a link, redeeming one and restoring
 * one all ask it, so the three cannot drift apart. Returns the trip's title, or
 * null (callers answer all of "no", "not yours" and "no such trip" the same).
 * `lock` takes the membership row, so a concurrent membership end serialises.
 */
async function tripTheUserRuns(client: pg.PoolClient, userId: string, tripId: string, lock: boolean): Promise<string | null> {
  const result = await client.query<{ title: string }>(
    `SELECT COALESCE(t.title, t.destination_label, 'Untitled trip') AS title
       FROM control_plane.trip_memberships m
       JOIN control_plane.trips t ON t.id = m.trip_id
       JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.trip_id = $1 AND m.user_id = $2 AND m.status = 'active' AND ${roleOk}
        AND ${NOT_RETIRED_SQL}
        AND NOT EXISTS (
              SELECT 1 FROM control_plane.telegram_chat_bindings d
               WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')
      ${lock ? "FOR UPDATE OF m" : ""}`,
    [tripId, userId],
  );
  return result.rows[0]?.title ?? null;
}

/**
 * Gives back the bot's organizer fact an Unlink demoted (trip_person_links,
 * migration 0051) - EXACTLY that: only a row carrying the marker the demotion wrote (`demoted_from_role`,
 * migration 20261023120000), which is then cleared. A person who was a participant all along, whatever
 * old Unlinked link their Telegram account has on the trip, is not promoted (boundary review round 3,
 * MF2). Callers do it only because the user who made the link, checked, still runs the trip.
 * Shared by the lk_ relink and the dashboard Restore, which differ in how they know the Telegram account
 * (the update's sender id, or the digest on the row being restored) and in nothing else.
 */
async function restoreDemotedOrganizerPersonLink(client: pg.PoolClient, tripId: string, telegramDigest: string): Promise<void> {
  await client.query(
    `UPDATE control_plane.trip_person_links SET role = 'organizer', demoted_from_role = NULL
      WHERE trip_id = $1 AND telegram_user_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("telegram_user_id")} = $2
        AND role = 'participant' AND demoted_from_role = 'organizer'`,
    [tripId, telegramDigest],
  );
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
    const allowed = await tripTheUserRuns(client, input.userId, input.tripId, true);
    if (allowed === null) {
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
  /** The Telegram account's first name and @username, from the update's verified `from` (display data only, never from the message). */
  telegramName: TelegramName | null = null,
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
    const tripTitle = await tripTheUserRuns(client, token.user_id, token.trip_id, false);
    if (tripTitle === null) {
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
           (id, user_id, trip_id, telegram_subject_digest, verified_via, telegram_first_name, telegram_username)
         VALUES ($1, $2, $3, $4, 'dashboard_link_token', $5, $6)`,
        [linkId, token.user_id, token.trip_id, digest, telegramName?.firstName ?? null, telegramName?.username ?? null],
      );
    } else if (telegramName) {
      await client.query(
        `UPDATE control_plane.telegram_organizer_trip_links
            SET telegram_first_name = COALESCE(telegram_first_name, $2), telegram_username = COALESCE(telegram_username, $3) WHERE id = $1`,
        [linkId, telegramName.firstName, telegramName.username]);
    }
    // A relink restores the bot's organizer fact an Unlink demoted, and only that (see the helper).
    await restoreDemotedOrganizerPersonLink(client, token.trip_id, digest);
    await client.query(
      "UPDATE control_plane.telegram_link_tokens SET state = 'consumed', consumed_at = now(), consumed_link_id = $2 WHERE id = $1",
      [token.id, linkId],
    );
    await client.query("COMMIT");
    return { ok: true, tripTitle, alreadyLinked: live.rows.length > 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Gives the Telegram account's private chat its route back: the open chat binding the Unlink closed
 * (`closed_reason = 'telegram_unlinked'`, telegram-mini-app.ts `closeChatHold`), as a NEW open row with the
 * trip's companion profile - history is never un-closed. Without it a restored organizer's DM stays
 * `unbound` and the bot answers "I don't have a trip for this chat" to the person who was just restored.
 *
 * Only the chat THIS Unlink closed (closed in the same transaction, so `closed_at >= revoked_at` of the
 * revoked row), only a private chat of the very digest being restored, and only when it is free: no open
 * binding of the chat (to this or any trip - the organizer may have switched it elsewhere since) and no live
 * interview on it, which would outrank a companion anyway and must not be disturbed.
 *
 * TWO STEPS, because of LOCK ORDER. Teardown (scripts/teardown-trip.py `retire_in_db`) and group-binding.ts
 * take group-binding tokens, then CHAT BINDINGS, then the TRIP row. Inserting a link row takes a KEY SHARE
 * lock on `trips` through its foreign key, so every chat-binding lock this restore needs is taken FIRST, by
 * `lockFreePrivateChats`, before the link row is written; `openBindings` runs last and only inserts. The
 * order inside restoreTelegramLink is therefore memberships, link rows, chat bindings, then trips. (Taking
 * the binding lock after the link INSERT was the reverse of teardown's and could deadlock with 40P01 against
 * a concurrent retire - boundary review round 2, MF1.) A concurrent switch of the same chat holds the open
 * binding FOR UPDATE; the partial unique index on open bindings is the backstop, and ON CONFLICT DO NOTHING
 * turns a lost race into "not reopened" rather than an error.
 */
async function lockFreePrivateChats(client: pg.PoolClient, revokedLinkId: string, tripId: string, digest: string): Promise<string[]> {
  const chats = await client.query<{ chat_id: string }>(
    `SELECT DISTINCT b.chat_id
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.telegram_organizer_trip_links o ON o.id = $1
      WHERE b.trip_id = $2 AND b.closed_reason = 'telegram_unlinked' AND b.closed_at >= o.revoked_at
        AND b.chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("b.chat_id")} = $3
      ORDER BY b.chat_id`,
    [revokedLinkId, tripId, digest],
  );
  const free: string[] = [];
  for (const { chat_id: chatId } of chats.rows) {
    const open = await client.query(
      "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL FOR UPDATE",
      [chatId],
    );
    if (open.rowCount) continue;
    const interview = await client.query(`SELECT 1 FROM control_plane.intake_sessions WHERE ${LIVE_INTAKE_SESSION_PREDICATE}`, [chatId]);
    if (interview.rowCount) continue;
    free.push(chatId);
  }
  return free;
}

/** Second step of the reopen: only inserts, so it adds no lock that runs ahead of teardown's order. */
async function openBindings(client: pg.PoolClient, chatIds: readonly string[], tripId: string): Promise<boolean> {
  let reopened = false;
  for (const chatId of chatIds) {
    const inserted = await client.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
       SELECT $1, $2, t.id,
              coalesce(
                t.hermes_profile,
                (SELECT b.hermes_profile FROM control_plane.telegram_chat_bindings b
                  WHERE b.trip_id = t.id AND b.hermes_profile IS NOT NULL
                  ORDER BY b.created_at DESC LIMIT 1))
         FROM control_plane.trips t WHERE t.id = $3
       ON CONFLICT DO NOTHING`,
      [opaqueId("tcb"), chatId, tripId],
    );
    if (inserted.rowCount) reopened = true;
  }
  return reopened;
}

export type RestoreLinkResult =
  | { ok: true; linkId: string; tripTitle: string; routeReopened: boolean }
  /** Not theirs, not restorable, not a trip they run, already back, unknown: ONE answer. */
  | { ok: false; reason: "NOT_FOUND" };

/**
 * Brings back a Telegram account the signed-in organizer Unlinked from ONE trip,
 * with no Telegram round trip (owner request 2026-10-23). The caller is a FULL
 * session (portal-scope.ts policy "account") and has passed Origin and CSRF.
 *
 * WHAT IS PROVEN, and by what. The ACCOUNT, by that session. The TELEGRAM
 * IDENTITY, by the row itself: it is the very account this user linked before
 * (verified then, by an interview link or the bot's /start), and the digest is
 * copied from it, never taken from the request - the request names only the
 * revoked row's opaque id. A Telegram account that never held a link needs the
 * lk_ link above.
 *
 * ALL of these must hold, re-read inside the transaction with the rows locked, or
 * the answer is the same `NOT_FOUND` whichever failed (a distinguishable refusal
 * confirms a guess about another person's links):
 *   - the revoked row is the signed-in user's own (never someone else's);
 *   - it was revoked by an owner Unlink - `membership_ended` is permanent, and so
 *     is a link whose user is gone (the readers join active users);
 *   - it has not been restored already, and is the NEWEST revoked row of its
 *     (Telegram account, user, trip) pair, with no live row now;
 *   - the user still runs the trip TODAY (`tripTheUserRuns`, the check the issuer
 *     and the redeemer use): owner or organizer with dashboard access.
 *
 * WHAT IT WRITES. A NEW live row (`dashboard_restore`), never a cleared
 * `revoked_at` - the Unlink stays in the table that records it, and the new row
 * has no first sign-in, so the account announces itself again. The revoked row
 * gets restored_at / restored_by / restored_link_id. The bot's demoted
 * organizer fact comes back under the same marker rule as the lk_ relink.
 *
 * IT ALSO REOPENS THE BOT ROUTE (`lockFreePrivateChats` then `openBindings`): the private chat whose
 * binding THIS Unlink closed gets a NEW open binding to the trip, so the restored
 * organizer's DM reaches the companion again instead of "I don't have a trip for
 * this chat". Only when that chat is free (no open binding, no live interview).
 * The name (`telegram_first_name`, `telegram_username`) is copied from the revoked row - display data
 * only, never taken from the request.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It revives no session: every session the
 * Unlink ended points at the OLD link id, the new row has a new one, and the
 * person signs in fresh. It does not reopen the interview session or the
 * interview binding the Unlink closed (a live interview is the one thing that
 * must never be resumed by a click; a new interview link starts a new one), and
 * it does not un-close the old chat binding - history stays closed. It does not
 * touch `telegram_organizer_links` (the pre-Sprint-7 account-wide table; the
 * Unlink moved the pair's row out, and it stays out). A rollback to a release
 * that reads `telegram_organizer_trip_links` (the Sprint 7 candidate d0e3b73
 * does) keeps the restored account's access; one to a release from before that
 * table cannot see per-trip rows, so the restored account loses access there -
 * it can cost access, never keep what the owner took away.
 */
export async function restoreTelegramLink(
  db: pg.Pool,
  input: { userId: string; linkId: string },
): Promise<RestoreLinkResult> {
  const notFound: RestoreLinkResult = { ok: false, reason: "NOT_FOUND" };
  if (!/^otl_[A-Za-z0-9]{8,64}$/.test(input.linkId)) return notFound;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const peek = await client.query<{ trip_id: string }>(
      "SELECT trip_id FROM control_plane.telegram_organizer_trip_links WHERE id = $1 AND user_id = $2",
      [input.linkId, input.userId],
    );
    if (!peek.rows[0]) { await client.query("ROLLBACK"); return notFound; }
    // Membership first, then the link row - the order the membership-end trigger takes them in.
    const tripTitle = await tripTheUserRuns(client, input.userId, peek.rows[0].trip_id, true);
    if (tripTitle === null) { await client.query("ROLLBACK"); return notFound; }
    const old = await client.query<{ trip_id: string; telegram_subject_digest: string; telegram_first_name: string | null; telegram_username: string | null }>(
      `SELECT trip_id, telegram_subject_digest, telegram_first_name, telegram_username FROM control_plane.telegram_organizer_trip_links
        WHERE id = $1 AND user_id = $2 AND revoked_reason = 'owner_unlinked' AND restored_at IS NULL FOR UPDATE`,
      [input.linkId, input.userId],
    );
    const row = old.rows[0];
    if (!row) { await client.query("ROLLBACK"); return notFound; }
    // Compared inside SQL: a JS Date would round the row's microsecond timestamp to milliseconds.
    const superseded = await client.query(
      `SELECT 1 FROM control_plane.telegram_organizer_trip_links x
         JOIN control_plane.telegram_organizer_trip_links o ON o.id = $1
        WHERE x.telegram_subject_digest = o.telegram_subject_digest AND x.user_id = o.user_id AND x.trip_id = o.trip_id
          AND x.id <> o.id AND (x.revoked_at IS NULL OR (x.revoked_at, x.id) > (o.revoked_at, o.id))`,
      [input.linkId],
    );
    if (superseded.rowCount) { await client.query("ROLLBACK"); return notFound; }
    // The chat-binding locks come BEFORE the link INSERT below (its FK takes a lock on `trips`): teardown's
    // order is bindings, then trips, and this must not be the reverse (lockFreePrivateChats).
    const freeChats = await lockFreePrivateChats(client, input.linkId, row.trip_id, row.telegram_subject_digest);
    const linkId = opaqueId("otl");
    await client.query(
      `INSERT INTO control_plane.telegram_organizer_trip_links
         (id, user_id, trip_id, telegram_subject_digest, verified_via, telegram_first_name, telegram_username)
       VALUES ($1, $2, $3, $4, 'dashboard_restore', $5, $6)`,
      [linkId, input.userId, row.trip_id, row.telegram_subject_digest, row.telegram_first_name, row.telegram_username],
    );
    await client.query(
      `UPDATE control_plane.telegram_organizer_trip_links
          SET restored_at = now(), restored_by = $2, restored_link_id = $3 WHERE id = $1`,
      [input.linkId, input.userId, linkId],
    );
    await restoreDemotedOrganizerPersonLink(client, row.trip_id, row.telegram_subject_digest);
    const routeReopened = await openBindings(client, freeChats, row.trip_id);
    await client.query("COMMIT");
    return { ok: true, linkId, tripTitle, routeReopened };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
