/**
 * Binding a family group to a trip, with a token the organizer posts there.
 *
 * THE PROBLEM. A group cannot be bound from the organizer's DM — the control
 * plane has no idea which group they mean. And it cannot be bound from inside
 * the group either, because nothing said in a group proves who the organizer
 * is, and on a shared bot "whoever spoke first" would hand one family's trip to
 * another.
 *
 * The token crosses that gap. It is issued into a channel where the organizer's
 * identity is already established (their own DM), and redeemed in the group,
 * which proves they are in it. Two facts, each learned where it is actually
 * knowable.
 *
 * WHY IT IS REUSABLE. The organizer is told to make the bot an admin BEFORE
 * posting, because pinning and reading an invite link both need that. They will
 * sometimes forget, and the recovery has to be "post it again" — a token that
 * burned itself on first use would turn a forgotten step into a support
 * request. Re-posting re-runs the arrival: bind, greet, pin.
 *
 * WHAT MAKES A LEAKED TOKEN HARMLESS. `issued_to_telegram_user_id`. The token
 * alone would let anyone who saw it bind any group they are in; requiring the
 * sender to be the organizer it was issued to means a forwarded or
 * screenshotted token binds nothing. There is no case where that check has to
 * be skipped, because the token is handed over in the organizer's own DM and so
 * the recipient is always known.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { isTripOrganizer } from "./chat-router.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

/**
 * Why a binding was closed because its group was carried to another trip by
 * that group's own organizer. Free text in `telegram_chat_bindings.closed_reason`
 * (0029 constrains only its length and that it is set exactly when the binding
 * is closed) - no migration, and every reader that branches on a reason looks for
 * 'trip_destroyed' alone, so an unfamiliar one is safe to meet.
 */
export const GROUP_MOVED_CLOSED_REASON = "group_moved";

/**
 * `KIN-` plus eight unambiguous characters.
 *
 * Excludes I, O, 0 and 1: this is read off one screen and typed or pasted into
 * another, sometimes from a photo of a phone. The entropy lost is irrelevant —
 * the token is single-trip, expiring, and only usable by one known sender —
 * next to the cost of a family stuck on a character they cannot tell apart.
 */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 8;

/**
 * Matches a token as a standalone word.
 *
 * The lookarounds are what stop it matching inside a URL or a longer string:
 * a token is something the organizer pasted, not a fragment of something else.
 */
export const GROUP_BINDING_TOKEN_PATTERN = new RegExp(
  `(?<![A-Za-z0-9/_-])KIN-([${TOKEN_ALPHABET}]{${TOKEN_LENGTH}})(?![A-Za-z0-9-])`,
  "i",
);

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function tokenDigest(token: string): string {
  return `sha256:${sha256hex(token.toUpperCase())}`;
}

function newToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  }
  return `KIN-${out}`;
}

/**
 * The binding token in a message, canonicalised, or null if there is none.
 *
 * Case-insensitive on the way in and upper-case on the way out: phone keyboards
 * autocapitalise and autocorrect, and refusing a lowercase paste would be a
 * support request rather than a security boundary. The secret is the random
 * part, and it is matched against a digest either way.
 */
export function extractGroupBindingToken(text: string | null | undefined): string | null {
  const match = GROUP_BINDING_TOKEN_PATTERN.exec(text ?? "");
  return match ? `KIN-${match[1]!.toUpperCase()}` : null;
}

/**
 * The binding token a `/start` payload IS, canonicalised, or null.
 *
 * For the one-tap add link (`?startgroup=<token>`): Telegram adds the bot to
 * the chosen group and posts `/start@<bot> <token>` there, from the person who
 * added it. The payload has to be EXACTLY a token — not a longer string that
 * happens to contain one — so that nothing but a payload we issued reaches the
 * redemption path. `extractGroupBindingToken` is looser on purpose (people
 * paste a token amid words); a deep-link payload is machine-made and is not.
 */
export function groupBindingTokenFromStartPayload(payload: string | null | undefined): string | null {
  const token = extractGroupBindingToken(payload);
  return token !== null && token.toUpperCase() === (payload ?? "").trim().toUpperCase() ? token : null;
}

export type GroupBindingIssueResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: "TRIP_NOT_FOUND" };

export interface GroupBindingConfig {
  ttlSeconds: number;
}

/**
 * Issues (or replaces) the trip's group-binding token.
 *
 * One live token per trip: asking again supersedes rather than accumulates, so
 * an organizer who lost the message cannot end up with several valid tokens in
 * circulation and no way to tell which is current.
 */
export async function issueGroupBindingToken(
  db: pg.Pool,
  tripId: string,
  telegramUserId: string,
  config: GroupBindingConfig,
): Promise<GroupBindingIssueResult> {
  const trip = await db.query("SELECT 1 FROM control_plane.trips WHERE id = $1", [tripId]);
  if (!trip.rowCount) return { ok: false, reason: "TRIP_NOT_FOUND" };

  const token = newToken();
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
  await db.query(
    `INSERT INTO control_plane.telegram_group_binding_tokens
       (id, trip_id, token_digest, issued_to_telegram_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (trip_id) DO UPDATE
        SET token_digest = EXCLUDED.token_digest,
            issued_to_telegram_user_id = EXCLUDED.issued_to_telegram_user_id,
            expires_at = EXCLUDED.expires_at,
            created_at = now(),
            last_used_at = NULL,
            use_count = 0`,
    [`gbt_${randomBytes(16).toString("hex")}`, tripId, tokenDigest(token), telegramUserId, expiresAt],
  );
  return { ok: true, token, expiresAt };
}

/**
 * Is this a live token, issued to this person, for this trip?
 *
 * Read-only: it never consumes, never binds, and is not a redemption path. It
 * exists for ONE question — the organizer pasted a group code into their own
 * DM instead of into the family group, and we have to answer them without
 * pretending it worked.
 *
 * Scoped to the caller's OWN trip and their OWN issued token on purpose. It is
 * asked in a chat already bound to that trip, and answering only "yours / not
 * yours" tells whoever asks nothing they did not already have — the same
 * position the group path takes by giving one flat refusal for every failure.
 */
export async function groupBindingTokenIsOwn(
  db: pg.Pool,
  token: string,
  tripId: string,
  senderTelegramUserId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM control_plane.telegram_group_binding_tokens
      WHERE token_digest = $1
        AND trip_id = $2
        AND issued_to_telegram_user_id = $3
        AND expires_at > now()`,
    [tokenDigest(token), tripId, senderTelegramUserId],
  );
  return rows.length > 0;
}

export type GroupBindingRedeemResult =
  | {
      ok: true;
      tripId: string;
      rebound: boolean;
      /** Set when the group was carried here from another trip (the old binding is closed 'group_moved'). */
      movedFromTripId?: string;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "EXPIRED"
        | "WRONG_SENDER"
        /**
         * The group is bound to another trip and the sender is not an organizer of BOTH
         * that trip and this one. One reason for every way of failing that, on purpose.
         */
        | "GROUP_MOVE_NOT_ORGANIZER"
        | "NOT_A_GROUP"
        | "TRIP_RETIRED";
    };

/**
 * Redeems a token posted in a group, binding that group to the token's trip.
 *
 * A chat already bound to a DIFFERENT trip is MOVED only by someone who is an
 * organizer of that trip AND of the one the token is for (`isTripOrganizer`,
 * from the sender's verified Telegram id - the same proof `/proactive` asks
 * for). On a shared bot the group belongs to a real family, and a token is not
 * authority over a binding somebody else made - the organizer of the other trip
 * never agreed to lose it - so anyone else is refused with
 * `GROUP_MOVE_NOT_ORGANIZER` and nothing changes. The token alone is NOT
 * enough here, even though it was issued to the sender: a code can be issued
 * into any chat bound to its trip, and a family member's DM is one.
 *
 * A move happens in ONE transaction: the old open binding is closed with
 * `group_moved` (history is kept; nothing is overwritten) and a new one is
 * opened for the new trip with THAT trip's companion profile. The old trip's
 * website and companion are untouched; routing simply follows the open binding.
 * The authorization is one function call (`senderMayMoveGroup`) made before the
 * first write, so a "tap to confirm" step can later be added by returning early
 * from exactly there, with no change to what a confirmed move does.
 *
 * Rebinding the SAME trip is the supported path and reports
 * `rebound: true` so the caller can greet again without claiming it is new.
 *
 * Refuses a token whose trip has been retired (`t.slug` renamed
 * `retired-<slug>-<yyyymmdd>` by `teardown-trip.py`, issue #105) via the
 * `NOT EXISTS` subquery below, the same `NOT_RETIRED_SQL` fragment
 * `bind_chat_to_trip` checks first on its own side.
 *
 * A REAL DEADLOCK WAS HERE, AND IS FIXED — on `teardown-trip.py`'s side, not
 * in this function. `INSERT INTO telegram_chat_bindings` below has a foreign
 * key to `trips`, which takes a `FOR KEY SHARE` lock on the referenced trip
 * row as a side effect — regardless of the `NOT EXISTS` subquery above
 * correctly avoiding a direct lock on `trips` in the SELECT itself (see that
 * query's own comment). This function's real lock order is therefore: the
 * token row first (via `FOR UPDATE`), then `trips` second (via the FK).
 * `teardown-trip.py`'s `retire_in_db` used to revoke a trip's group-binding
 * token LAST, after closing its bindings and renaming its slug — locking
 * `trips` first and the token row second, the OPPOSITE order. Two
 * transactions each holding one of those two locks and waiting on the
 * other's is a real `40P01: deadlock detected`, reproduced against Postgres
 * by regression-planner — not a theoretical one this docstring merely
 * warned about. The fix is entirely on `teardown-trip.py`'s side:
 * `REVOKE_GROUP_TOKENS` now runs FIRST in both of that function's
 * transaction branches, so it locks the token row before `trips`, matching
 * this function's own order instead of opposing it.
 *
 * THE MOVE ADDS ONE LOCK TO THAT ORDER, IN THE SAME PLACE TEARDOWN TAKES IT:
 * the group's open binding row (`FOR UPDATE`) sits between the token row and
 * `trips` - teardown revokes tokens, then closes bindings, then renames the
 * slug. It is taken on every redemption, not just a move, so two redemptions of
 * one chat take turns instead of racing the partial unique index. The
 * organizer reads for the authorization are plain reads on this transaction's
 * own connection and lock nothing.
 *
 * THE RACE THIS STILL DOES NOT CLOSE — separate from the deadlock above
 * (that one is fixed; this one is not), and related to, but sharper than,
 * `bind_chat_to_trip`'s own documented one (`provisioner.py`). That race is
 * a stale binding created after teardown already ran; this one is a stale
 * binding created DURING teardown, by TIMING rather than by lock order: the
 * `NOT EXISTS` subquery reads `control_plane.trips` with no lock on it at
 * all, so it can run while a concurrent `teardown-trip.py` transaction has
 * already executed — but not yet committed — its own slug-rename and
 * binding-close steps. This function sees the trip as still live, proceeds,
 * and INSERTs a brand-new open binding; teardown's close step already ran
 * earlier in ITS OWN transaction, before that row existed, so it never
 * closes it. Once both transactions commit, the result is a fresh, OPEN,
 * stale binding — arguably worse than #105's original evidence (an
 * eight-minute gap between teardown finishing and a stray binding
 * appearing), because here the two are interleaved rather than sequential.
 * Accepted as a narrow residual risk for the same reason `bind_chat_to_trip`
 * accepts its own: actually closing it needs the trips row locked here AND
 * `teardown-trip.py` cooperating with that lock, which is a bigger
 * transactional change than this fix is meant to be.
 */
export async function redeemGroupBindingToken(
  db: pg.Pool,
  token: string,
  chatId: string,
  senderTelegramUserId: string,
): Promise<GroupBindingRedeemResult> {
  // A group chat id is negative on Telegram; a private one is the user's own
  // id. Binding a DM here would at best be a no-op and at worst rebind the very
  // channel the token arrived on.
  if (!chatId.startsWith("-")) return { ok: false, reason: "NOT_A_GROUP" };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // `trip_retired` is a `NOT EXISTS` subquery, not a `JOIN`: a subquery's
    // tables are never locked by `FOR UPDATE`, only tables named in the
    // top-level `FROM` are — so this folds the retired-trip check into the
    // same round trip as the token lookup without this SELECT itself taking
    // any lock on `control_plane.trips`. That does NOT make the function
    // lock-order-safe on its own, though: the INSERT below still takes a
    // `FOR KEY SHARE` lock on the same trip row via its foreign key, so this
    // function's real order is token row, then trips — a `JOIN` here would
    // have taken that same trips lock one statement earlier, not changed
    // the order. The actual `40P01` deadlock regression-planner reproduced
    // was `teardown-trip.py` locking trips before the token row, the
    // opposite way around; fixed there, by revoking the token first. See
    // the docstring above.
    const { rows } = await client.query<{
      trip_id: string;
      issued_to_telegram_user_id: string;
      expired: boolean;
      trip_retired: boolean;
    }>(
      `SELECT tg.trip_id, tg.issued_to_telegram_user_id, tg.expires_at <= now() AS expired,
              NOT EXISTS (
                SELECT 1 FROM control_plane.trips t
                 WHERE t.id = tg.trip_id AND ${NOT_RETIRED_SQL}
              ) AS trip_retired
         FROM control_plane.telegram_group_binding_tokens tg
        WHERE tg.token_digest = $1
        FOR UPDATE OF tg`,
      [tokenDigest(token)],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (row.issued_to_telegram_user_id !== senderTelegramUserId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "WRONG_SENDER" };
    }
    if (row.expired) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EXPIRED" };
    }
    if (row.trip_retired) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_RETIRED" };
    }

    // FOR UPDATE: the binding row is the second lock in the order described above, and what
    // makes two redemptions (or a redemption and a teardown) of one chat take turns.
    const readOpenBinding = async () => (await client.query<{ id: string; trip_id: string }>(
      `SELECT id, trip_id FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND closed_at IS NULL
        FOR UPDATE`,
      [chatId],
    )).rows[0];
    let bound = await readOpenBinding();
    // A redemption that waited on that row lock while a MOVE (or a re-bind) committed does not
    // see the binding the winner just opened: the locked row no longer matches and a statement
    // never sees rows inserted after it began. Read again - a fresh statement, a fresh view -
    // so a group that is no longer free goes down the bound-elsewhere path below, authorization
    // included, instead of being "bound" over the top of somebody else's move.
    bound ??= await readOpenBinding();
    let movedFromTripId: string | undefined;
    if (bound && bound.trip_id !== row.trip_id) {
      if (!(await senderMayMoveGroup(client, bound.trip_id, row.trip_id, senderTelegramUserId))) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" };
      }
      await client.query(
        `UPDATE control_plane.telegram_chat_bindings
            SET closed_at = now(), closed_reason = $2
          WHERE id = $1`,
        [bound.id, GROUP_MOVED_CLOSED_REASON],
      );
      await openBinding(client, chatId, row.trip_id);
      movedFromTripId = bound.trip_id;
    } else if (!bound) {
      // The trip may have no companion installed yet (migration 0043): `openBinding` binds it
      // anyway with a NULL profile. Routing and the assistant behind it are separate
      // components, separately retryable, and a bound chat with no profile answers
      // COMPANION_PENDING rather than "I don't have a trip for this chat".
      await openBinding(client, chatId, row.trip_id);
    }

    // The token is NOT consumed here, on purpose. Owner decision 2026-10-16:
    // one trip may bind several groups; the token stays reusable until
    // expiry, re-issue (`/group`) or revoke (teardown). Its protection is the
    // sender check above, not single use.
    await client.query(
      `UPDATE control_plane.telegram_group_binding_tokens
          SET last_used_at = now(), use_count = use_count + 1
        WHERE token_digest = $1`,
      [tokenDigest(token)],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      tripId: row.trip_id,
      rebound: Boolean(bound) && movedFromTripId === undefined,
      ...(movedFromTripId !== undefined ? { movedFromTripId } : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Somebody else's binding of this chat committed between our reads and our INSERT (the
    // partial unique index on open bindings, 0029). The group is not free and this sender was
    // never checked against whoever holds it: the same uniform refusal as any other
    // non-organizer, never an unhandled error (which the poller would swallow as a dropped update).
    if (isActiveChatBindingConflict(error)) return { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" };
    throw error;
  } finally {
    client.release();
  }
}

function isActiveChatBindingConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === "23505" && e.constraint === "telegram_chat_bindings_active_chat_idx";
}

/**
 * Opens the chat's binding to a trip, with ONE rule for the companion profile whether the
 * group was free or moved: the trip's own (`trips.hermes_profile`, migration 20260922060000)
 * first, then the latest binding of that trip that carries one (a trip built before that
 * column), else NULL. The trip may have no companion yet (migration 0043) and is bound anyway.
 *
 * The caller has made sure no open binding of this chat exists in its own view; if one
 * committed since, the partial unique index throws 23505 and the caller refuses.
 */
async function openBinding(client: pg.PoolClient, chatId: string, tripId: string): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
     SELECT $1, $2, t.id,
            coalesce(
              t.hermes_profile,
              (SELECT b.hermes_profile
                 FROM control_plane.telegram_chat_bindings b
                WHERE b.trip_id = t.id AND b.hermes_profile IS NOT NULL
                ORDER BY b.created_at DESC
                LIMIT 1))
       FROM control_plane.trips t
      WHERE t.id = $3`,
    [`tcb_${randomBytes(16).toString("hex")}`, chatId, tripId],
  );
  // The token's foreign key guarantees the trip exists; no row here would be a bug, not a state.
  if (!inserted.rowCount) throw new Error("openBinding: trip row missing");
}

/**
 * May this sender carry a group from `fromTripId` to `toTripId`?
 *
 * Both halves are facts the control plane holds about the sender's VERIFIED
 * Telegram id (the update's `from.id`), never anything typed: they must be an
 * organizer of the trip the group belongs to now (it is theirs to give up) and
 * of the trip it is going to (it is theirs to receive). Reads go through
 * `isTripOrganizer` rather than restating the link tables here, so a change to
 * what "linked organizer" means (revoked links, per-trip links) lands in one place.
 *
 * Runs on the redeeming transaction's own client: plain reads, no locks.
 */
async function senderMayMoveGroup(
  client: pg.PoolClient,
  fromTripId: string,
  toTripId: string,
  senderTelegramUserId: string,
): Promise<boolean> {
  return (await isTripOrganizer(client, fromTripId, senderTelegramUserId))
    && (await isTripOrganizer(client, toTripId, senderTelegramUserId));
}
