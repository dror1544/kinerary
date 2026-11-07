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
 * ONE ORGANIZER, ONE TELEGRAM (#519) DOES NOT APPLY HERE, ON PURPOSE. That rule asks "is the Telegram account that opened
 * this interview link the one the organizer's account is bound to?" because an interview link is a bearer token that can be
 * forwarded. This link is different: it is issued only to a SIGNED-IN owner (full session and CSRF), so the account half is
 * proven by the owner themselves, and the owner chose to hand it to the Telegram account that opens it.
 *
 * SINCE #523 IT MAKES THE ACCOUNT'S MAIN TELEGRAM, not a one-trip addition. The opener is linked on EVERY trip the issuer runs
 * with `binding_scope = 'account'`, and a different Telegram that was the main one is replaced (its account-scoped links end
 * through `revokeOrganizerLinkInTx` with the reason `main_telegram_replaced`). "Its links" include any link made by this same
 * dashboard link at any scope: a phone added before #523 is trip-scoped (#519 narrowed it) and is still the owner's OLD phone,
 * so lost-phone recovery ends it too. Not touched: a trip-scoped link from an APPROVAL (another person the owner approved for
 * one trip) or an ordinary redemption. Trip-scoped links are not promoted by this release; the owner widens one by linking
 * from that Telegram. The costs of a leaked link are bounded as before: short, single use, announced on first sign-in
 * and listed on the card for Unlink - and, new, the previous main is told in its own chat that it was replaced.
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
import { LIVE_INTAKE_SESSION_PREDICATE, privateChatForDigest } from "./organizer-trips.js";
import { endSecondaryBindingsOfDigestInTx } from "./secondary-organizers.js";
import { CHAT_DIGEST_SQL, revokeOrganizerLinkInTx } from "./telegram-mini-app.js";
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
  | {
      ok: true;
      tripTitle: string;
      alreadyLinked: boolean;
      /**
       * The main Telegram accounts this link REPLACED (#523), one entry per account, each with the private chat that reaches
       * it (read before its links ended) or null when none can be reached. The router tells each chat once.
       */
      replaced: Array<{ chatId: string | null }>;
    }
  | { ok: false; reason: "INVALID" };

/**
 * Redeems a link token for the Telegram account that sent it. `telegramUserId`
 * is the update's verified sender and must be a private-chat id (a positive
 * integer); anything else is refused without touching the token, so a link
 * opened in a group stays usable in the DM where it belongs.
 *
 * WHAT IT MAKES (#523): the opener becomes the account's MAIN Telegram. A live
 * `account`-scoped link is written (or, when this Telegram already holds a
 * `trip`-scoped one, widened) on EVERY trip the issuer runs, so `/trips` lists them
 * all and an interview link for any of them, or for a trip created later, opened
 * from this Telegram is "the same account" (organizer-trips.ts
 * `boundTelegramAccounts`). If ANOTHER Telegram account was the main one, its
 * account-scoped links are revoked first, through the very function Unlink uses
 * (`revokeOrganizerLinkInTx`) with the reason `main_telegram_replaced`, so a replaced
 * main is never offered back by Restore. "Its links" are the account-scoped ones AND any
 * link made by this same dashboard link at any scope (a phone added before #523 is
 * trip-scoped and is still the owner's old phone). Left alone: a trip-scoped link from an
 * APPROVAL (another person the owner approved for one trip), and everyone else's
 * secondary organizer bindings. A Telegram that was a SECONDARY organizer of one of these trips
 * stops being one: it is now the main organizer's own.
 *
 * Everything is re-checked at redemption, not trusted from issue time: the
 * issuer must STILL run the trip. Consuming the token and writing the links are
 * one transaction, so a link is never left half made.
 *
 * A live link for the same Telegram account is not an error: the token is
 * consumed and the chat is told it is linked. A REVOKED link does not stand in the
 * way: this is the path back from an Unlink.
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

    // Every trip the issuer runs today (the same predicate as the issuing check), locked in a stable order.
    const trips = await client.query<{ trip_id: string }>(
      `SELECT m.trip_id
         FROM control_plane.trip_memberships m
         JOIN control_plane.trips t ON t.id = m.trip_id
         JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.user_id = $1 AND m.status = 'active' AND ${roleOk} AND ${NOT_RETIRED_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM control_plane.telegram_chat_bindings d
                 WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')
        ORDER BY m.trip_id
          FOR UPDATE OF m`,
      [token.user_id],
    );
    const tripIds = trips.rows.map((r) => r.trip_id);

    // 1. THE OLD MAIN(S) GO FIRST: every other Telegram account holding a live account-scoped link of this user. Each one's
    //    chat is read BEFORE its links end (the reader looks at the rows the end touches).
    //    "The old main" is every OTHER live link that is the owner's own: an account-scoped one, and ANY link whose origin is
    //    this same dashboard link, at any scope - a phone added with it before #523 was narrowed to its trip (#519's backfill)
    //    and is no less the owner's old phone for that (lost-phone recovery: it must not keep organizer access). A
    //    `dashboard_restore` row counts when the chain of restores behind it ends at a dashboard link. What is NOT touched:
    //    a trip-scoped link from an APPROVAL (another person the owner approved for that trip) or from an ordinary
    //    redemption, and every secondary organizer's binding.
    const others = await client.query<{ id: string; telegram_subject_digest: string }>(
      `WITH RECURSIVE chain(target, source_id, source_via) AS (
         SELECT r.id, o.id, o.verified_via
           FROM control_plane.telegram_organizer_trip_links r
           JOIN control_plane.telegram_organizer_trip_links o ON o.restored_link_id = r.id
          WHERE r.verified_via = 'dashboard_restore' AND r.user_id = $1
         UNION
         SELECT c.target, o.id, o.verified_via
           FROM chain c JOIN control_plane.telegram_organizer_trip_links o ON o.restored_link_id = c.source_id
       )
       SELECT l.id, l.telegram_subject_digest FROM control_plane.telegram_organizer_trip_links l
        WHERE l.user_id = $1 AND l.revoked_at IS NULL AND l.telegram_subject_digest <> $2
          AND (l.binding_scope = 'account'
               OR l.verified_via = 'dashboard_link_token'
               OR l.id IN (SELECT target FROM chain WHERE source_via = 'dashboard_link_token'))
        ORDER BY l.id FOR UPDATE OF l`,
      [token.user_id, digest],
    );
    const previous = new Map<string, string[]>();
    for (const link of others.rows) previous.set(link.telegram_subject_digest, [...(previous.get(link.telegram_subject_digest) ?? []), link.id]);
    // The sign-up identity, when it is a different Telegram account, stood for the account too (organizer-trips.ts
    // `boundTelegramAccounts`). It has no link row to revoke, so the replacement is written as a revoked row (a tombstone) that
    // `replaced_main` there reads.
    const identities = await client.query<{ provider_subject_digest: string }>(
      "SELECT provider_subject_digest FROM control_plane.user_identities WHERE user_id = $1 AND provider = 'telegram' AND provider_subject_digest <> $2",
      [token.user_id, digest],
    );
    const replaced: Array<{ chatId: string | null }> = [];
    const told = new Set<string>();
    for (const [oldDigest, linkIds] of previous) {
      replaced.push({ chatId: await privateChatForDigest(client, token.user_id, oldDigest) });
      told.add(oldDigest);
      for (const linkId of linkIds) await revokeOrganizerLinkInTx(client, token.user_id, linkId, "main_telegram_replaced");
    }
    for (const identity of identities.rows) {
      const oldDigest = identity.provider_subject_digest;
      const marked = await client.query(
        `SELECT 1 FROM control_plane.telegram_organizer_trip_links
          WHERE user_id = $1 AND telegram_subject_digest = $2 AND revoked_reason = 'main_telegram_replaced' LIMIT 1`,
        [token.user_id, oldDigest],
      );
      if (marked.rowCount) continue;
      if (!told.has(oldDigest)) replaced.push({ chatId: await privateChatForDigest(client, token.user_id, oldDigest) });
      await client.query(
        `INSERT INTO control_plane.telegram_organizer_trip_links
           (id, user_id, trip_id, telegram_subject_digest, verified_via, binding_scope, revoked_at, revoked_reason, revoked_by)
         VALUES ($1, $2, $3, $4, 'dashboard_link_token', 'account', now(), 'main_telegram_replaced', $2)`,
        [opaqueId("otl"), token.user_id, token.trip_id, oldDigest],
      );
    }

    // 2. THE NEW MAIN: a live account-scoped link on every trip the issuer runs.
    let alreadyLinked = false;
    for (const tripId of tripIds) {
      const live = await client.query<{ id: string; binding_scope: string }>(
        `SELECT id, binding_scope FROM control_plane.telegram_organizer_trip_links
          WHERE telegram_subject_digest = $1 AND user_id = $2 AND trip_id = $3 AND revoked_at IS NULL FOR UPDATE`,
        [digest, token.user_id, tripId],
      );
      let linkId = live.rows[0]?.id ?? null;
      if (linkId) {
        if (tripId === token.trip_id && live.rows[0]!.binding_scope === "account") alreadyLinked = true;
        await client.query(
          `UPDATE control_plane.telegram_organizer_trip_links
              SET binding_scope = 'account',
                  telegram_first_name = COALESCE(telegram_first_name, $2), telegram_username = COALESCE(telegram_username, $3)
            WHERE id = $1`,
          [linkId, telegramName?.firstName ?? null, telegramName?.username ?? null],
        );
      } else {
        linkId = opaqueId("otl");
        await client.query(
          `INSERT INTO control_plane.telegram_organizer_trip_links
             (id, user_id, trip_id, telegram_subject_digest, verified_via, telegram_first_name, telegram_username, binding_scope)
           VALUES ($1, $2, $3, $4, 'dashboard_link_token', $5, $6, 'account')`,
          [linkId, token.user_id, tripId, digest, telegramName?.firstName ?? null, telegramName?.username ?? null],
        );
      }
      // A relink restores the bot's organizer fact an Unlink demoted, and only that (see the helper).
      await restoreDemotedOrganizerPersonLink(client, tripId, digest);
      if (tripId === token.trip_id) {
        await client.query(
          "UPDATE control_plane.telegram_link_tokens SET state = 'consumed', consumed_at = now(), consumed_link_id = $2 WHERE id = $1",
          [token.id, linkId],
        );
      }
    }
    // A Telegram that was a secondary organizer of one of these trips is now the main organizer's own account.
    await endSecondaryBindingsOfDigestInTx(client, { tripIds, digest, reason: "became_main_organizer", revokedBy: token.user_id });
    await client.query("COMMIT");
    return { ok: true, tripTitle, alreadyLinked, replaced };
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
    const old = await client.query<{ trip_id: string; telegram_subject_digest: string; telegram_first_name: string | null; telegram_username: string | null; binding_scope: string }>(
      `SELECT trip_id, telegram_subject_digest, telegram_first_name, telegram_username, binding_scope FROM control_plane.telegram_organizer_trip_links
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
         (id, user_id, trip_id, telegram_subject_digest, verified_via, telegram_first_name, telegram_username, binding_scope)
       VALUES ($1, $2, $3, $4, 'dashboard_restore', $5, $6, $7)`,
      // A restore reaches exactly as far as the link it brings back (#519): a trip-scoped link stays trip-scoped.
      [linkId, input.userId, row.trip_id, row.telegram_subject_digest, row.telegram_first_name, row.telegram_username, row.binding_scope],
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
