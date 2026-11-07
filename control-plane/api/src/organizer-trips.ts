/**
 * "Which trips are mine, and which one is this chat wired to?"
 *
 * Two questions an organizer on a SHARED bot cannot otherwise answer. The bot
 * serves every trip from one Telegram account, so a DM that silently routes to
 * last month's trip looks identical to one routing to this month's — and the
 * provisioner deliberately REFUSES to retarget a chat already bound elsewhere
 * (`bind_chat_to_trip`'s BindingRefused), so a second provisioned trip leaves
 * the organizer's DM pointing at the first with nothing in the conversation
 * saying so. That state is not hypothetical: it is the state this deployment
 * was in when these commands were asked for.
 *
 * THE RULE THIS MODULE INHERITS, from chat-router.ts's header: the model and
 * the message never choose the trip. A command LOOKS like it carries its own
 * authority, so the discipline is stated once here and enforced in every
 * function below:
 *
 *   - Identity is the Telegram sender id from the update Telegram delivered on
 *     the bot's own authenticated connection — never a body field.
 *   - The set of trips a command may touch is derived server-side from that
 *     identity, through telegram_organizer_trip_links — ONE ROW PER TRIP, so an
 *     organizer who unlinks one trip keeps the others — joined to active
 *     memberships. A link is also a Mini App sign-in path. The previous
 *     account-wide table (0052) is no longer read: an Unlink moves that pair's
 *     row out of it (telegram-mini-app.ts), so an older release after a
 *     rollback cannot see an unlinked account either. An argument or a tapped
 *     button SELECTS WITHIN the set; it can never widen it.
 *   - Refusals are uniform. "That trip isn't yours" and "no such trip" are the
 *     same sentence, for the reason group-binding already gives: a
 *     distinguishable refusal confirms a guess to whoever is guessing.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { digestTelegramId, isPrivateChatId, type TelegramName } from "./identity.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

/** Closed-binding reason for a switch the organizer asked for themselves. */
export const SWITCH_CLOSED_REASON = "organizer_switch";

/**
 * What makes an intake session LIVE, as a SQL fragment over `$1 = chat id`.
 *
 * One definition, two readers — `resolveChatRoute` decides what a chat routes
 * to, and `switchChatToTrip` refuses while one is running. They must agree:
 * when they did not, a chat whose interview had expired routed to its
 * companion while refusing every `/switch` as "we're in the middle of setting
 * up a trip".
 *
 * `expired_at IS NULL` is migration 0049's idle closure and is the half that
 * went missing. It belongs here for the reason the router already records: a
 * closed session that still counts as live locks the organizer out of the trip
 * they were half way through.
 */
export const LIVE_INTAKE_SESSION_PREDICATE =
  "telegram_chat_id = $1 AND state <> 'confirmed' AND expired_at IS NULL";

/**
 * Has this person been through all of this before?
 *
 * Asked once, at the moment an interview starts, to decide which opening they
 * meet: the full explanation of what Kinerary is, or the shorter one that does
 * not explain what they already have sitting on their phone.
 *
 * "Before" means a trip of theirs that was actually BUILT. A draft they
 * abandoned is not a previous trip, and greeting them with "your previous trip
 * isn't touched" when there is no site to speak of would be a sentence about
 * nothing. Retired trips are excluded for the same reason.
 *
 * Identity is read from both directions, because one person here legitimately
 * owns several user_ids: the trip's own owner, and every user the sender's
 * Telegram identity has been PROVEN to own for THAT earlier trip (a link the
 * organizer unlinked does not count). The Telegram id
 * comes from the update's own chat, never from anything anyone typed.
 *
 * Wrong in the safe direction by construction: an unknown person, a first
 * trip, or a failed lookup all produce false, which is the ordinary opening.
 */
export async function hasEarlierBuiltTrip(
  db: pg.Pool,
  tripId: string,
  telegramUserId: string | null,
): Promise<boolean> {
  const digest = telegramUserId && isPrivateChatId(telegramUserId) ? digestTelegramId(telegramUserId) : null;
  const rows = await db.query<{ earlier: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM control_plane.trips t
         JOIN control_plane.trip_memberships m
           ON m.trip_id = t.id AND m.role = 'owner' AND m.status = 'active'
        WHERE t.id <> $1
          AND t.lifecycle_state IN ('ready_private', 'ready_public')
          AND ${NOT_RETIRED_SQL}
          AND (
            m.user_id IN (
              SELECT own.user_id FROM control_plane.trip_memberships own
               WHERE own.trip_id = $1 AND own.role = 'owner' AND own.status = 'active')
            OR ($2::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM control_plane.telegram_organizer_trip_links l
               WHERE l.telegram_subject_digest = $2 AND l.user_id = m.user_id
                 AND l.trip_id = t.id AND l.revoked_at IS NULL))
          )
     ) AS earlier`,
    [tripId, digest],
  );
  return rows.rows[0]?.earlier === true;
}

function bindingId(): string {
  return `tcb_${randomBytes(16).toString("hex")}`;
}

/**
 * Records that a Telegram person is this control-plane user, FOR ONE TRIP.
 *
 * Called inside the transaction that consumes an enrollment, because that is
 * the one moment both halves are proven at once: `consumeEnrollmentInTx`
 * returns the user (and trip) the enrollment was ISSUED for, and the chat id was
 * read by the router off its own Telegram connection. Neither came from a
 * message.
 *
 * Idempotent, and deliberately not read-before-write: redeeming another link
 * from the same chat is the ordinary case, not a conflict.
 *
 * A pair the owner has Unlinked for THIS trip stays unlinked: redeeming an
 * interview link (a forwarded one, say) must not quietly re-open it. The way
 * back is the dashboard's one-time link (telegram-link-token.ts), which needs
 * the signed-in account as well as the Telegram identity. Other trips are
 * unaffected either way.
 */
export type OrganizerLinkScope = "account" | "trip";

export type OrganizerLinkWrite =
  /** A new live link row was written. */
  | "linked"
  /** The pair already had a live link for this trip. */
  | "already_linked"
  /** The owner Unlinked this pair for this trip: nothing was written, and nothing here may re-open it. */
  | "revoked_pair"
  /** Not a private chat id: there is no Telegram person to link. */
  | "not_private";

/**
 * WHO MAY CALL THIS. Not every redeemer: `startSession` asks `organizerBindingVerdict` (below) first, under the trip
 * lock, and only an account that is not bound yet, or is the bound one, reaches this line -- or the approved replacement
 * (organizer-link-approval.ts), which is the organizer's own decision. A link opened by anyone else never gets here
 * (#519). The function itself stays a plain write because both of those callers have already decided.
 */
export async function linkTelegramOrganizerInTx(
  client: pg.PoolClient,
  telegramUserId: string,
  userId: string,
  tripId: string,
  verifiedVia: "enrollment_redemption" | "backfill_intake_session" = "enrollment_redemption",
  /** First name and @username from the update's verified `from` (identity.ts, telegramDisplayName). Display data only. */
  telegramName: TelegramName | null = null,
  /**
   * How far the link reaches (migration 20261106130000). `account`: an ordinary redemption of the account's own interview
   * link, which makes this Telegram the account's. `trip`: the organizer approved this Telegram for THIS trip only, so it
   * does not speak for the account's other trips.
   */
  scope: OrganizerLinkScope = "account",
): Promise<OrganizerLinkWrite> {
  if (!isPrivateChatId(telegramUserId)) return "not_private";
  const digest = digestTelegramId(telegramUserId);
  const inserted = await client.query(
    `INSERT INTO control_plane.telegram_organizer_trip_links
       (id, user_id, trip_id, telegram_subject_digest, verified_via, telegram_first_name, telegram_username, binding_scope)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
      WHERE NOT EXISTS (
        SELECT 1 FROM control_plane.telegram_organizer_trip_links r
         WHERE r.telegram_subject_digest = $4 AND r.user_id = $2 AND r.trip_id = $3
           AND r.revoked_at IS NOT NULL)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [`otl_${randomBytes(16).toString("hex")}`, userId, tripId, digest, verifiedVia, telegramName?.firstName ?? null, telegramName?.username ?? null, scope],
  );
  if (inserted.rows[0]) return "linked";
  const revoked = await client.query(
    `SELECT 1 FROM control_plane.telegram_organizer_trip_links
      WHERE telegram_subject_digest = $1 AND user_id = $2 AND trip_id = $3 AND revoked_at IS NOT NULL LIMIT 1`,
    [digest, userId, tripId],
  );
  return revoked.rowCount ? "revoked_pair" : "already_linked";
}

// ── One organizer, one Telegram (#519) ───────────────────────────────────────

/** A Telegram account the organizer's account is bound to. The digest is the identity; nothing else decides. */
export interface BoundTelegramAccount {
  digest: string;
  /** This account holds a live link to THE trip in question (it is preferred when somebody has to be asked). */
  onThisTrip: boolean;
  /** When it was bound, newest first among equals. */
  boundAt: Date | null;
}

/**
 * WHICH TELEGRAM ACCOUNTS AN ORGANIZER'S ACCOUNT IS BOUND TO, FOR ONE TRIP. The one definition; every reader goes through it.
 *
 * Sources, all written only from a verified update or a verified sign-in:
 *
 *   `telegram_organizer_trip_links` with `binding_scope = 'account'`  the non-revoked links an ordinary redemption of the
 *      account's own interview links made, over EVERY trip. Account-wide on purpose: a trip created on the dashboard has
 *      no link of its own until its interview link is redeemed, so a per-trip reading would call every new trip "not bound
 *      yet" and let a forwarded link bind a stranger -- the very case #519 closes.
 *   `telegram_organizer_trip_links` of THIS trip, whatever their scope  a Telegram the organizer approved for this trip, or
 *      narrowed to it by #519 (a dashboard link before #523). It is the organizer's Telegram for this trip and for no
 *      other: a `trip`-scoped link is invisible when the question is about a different trip, so an approval for trip A cannot
 *      open trip C (owner decision 2026-11-06). The dashboard's one-time link now writes `account` links (#523).
 *   `user_identities` (provider `telegram`)  the Telegram account the user SIGNED UP with. It is a verified Telegram
 *      identity on the account, and it outlives an Unlink of a trip.
 *
 * A revoked row is history and does not count. And an account that HOLDS a revoked link on this very trip and no live one
 * is out of this trip's set even if the account's other trips still bind it: it was taken off THIS trip (by the owner, or
 * by approving a replacement), so for this trip it is a different account, and opening this trip's next link is a
 * question, not a "same account". Its other trips are untouched.
 *
 * The union is the stricter reading (a set at least as large, so "someone else" is asked about more often, never less).
 * A retired (torn-down) trip's link still counts: the safe direction, and the cost is one approval prompt.
 */
export async function boundTelegramAccounts(
  q: Pick<pg.PoolClient, "query">,
  userId: string,
  tripId: string,
): Promise<BoundTelegramAccount[]> {
  const rows = await q.query<{ digest: string; on_this_trip: boolean; bound_at: Date | null }>(
    `WITH links AS (
       SELECT telegram_subject_digest AS d, trip_id, created_at, revoked_at, revoked_reason, binding_scope
         FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1
     ), removed AS (
       SELECT d FROM links WHERE trip_id = $2 AND revoked_at IS NOT NULL
       EXCEPT
       SELECT d FROM links WHERE trip_id = $2 AND revoked_at IS NULL
     ), replaced_main AS (
       -- A Telegram the owner REPLACED as the account's main one (#523) no longer stands for the account through the sign-up
       -- identity either, until it is linked as main again (a live account-scoped link). Its trip-scoped links, if any,
       -- were not touched by the replacement and still count for their own trip above.
       SELECT d FROM links WHERE revoked_reason = 'main_telegram_replaced'
       EXCEPT
       SELECT d FROM links WHERE revoked_at IS NULL AND binding_scope = 'account'
     )
     SELECT d AS digest, bool_or(trip_id = $2) AS on_this_trip, max(created_at) AS bound_at
       FROM links
      WHERE revoked_at IS NULL AND (binding_scope = 'account' OR trip_id = $2)
        AND d NOT IN (SELECT d FROM removed)
      GROUP BY d
     UNION ALL
     SELECT provider_subject_digest, false, verified_at
       FROM control_plane.user_identities
      WHERE user_id = $1 AND provider = 'telegram'
        AND provider_subject_digest NOT IN (SELECT d FROM removed)
        AND provider_subject_digest NOT IN (SELECT d FROM replaced_main)`,
    [userId, tripId],
  );
  const merged = new Map<string, BoundTelegramAccount>();
  for (const row of rows.rows) {
    const held = merged.get(row.digest);
    if (!held) {
      merged.set(row.digest, { digest: row.digest, onThisTrip: row.on_this_trip, boundAt: row.bound_at });
      continue;
    }
    held.onThisTrip = held.onThisTrip || row.on_this_trip;
    if (row.bound_at && (!held.boundAt || row.bound_at > held.boundAt)) held.boundAt = row.bound_at;
  }
  // This trip's own accounts first, then the most recently bound.
  return [...merged.values()].sort((a, b) =>
    Number(b.onThisTrip) - Number(a.onThisTrip) || (b.boundAt?.getTime() ?? 0) - (a.boundAt?.getTime() ?? 0));
}

/** Has any interview session ever been opened for this trip -- live, paused (closed unconfirmed) or confirmed? */
export async function tripHasInterviewSession(q: Pick<pg.PoolClient, "query">, tripId: string): Promise<boolean> {
  const row = await q.query("SELECT 1 FROM control_plane.intake_sessions WHERE trip_id = $1 LIMIT 1", [tripId]);
  return (row.rowCount ?? 0) > 0;
}

export type OrganizerBindingVerdict =
  /** The account is not bound to any Telegram yet, or is bound to this very one: redeem as before. */
  | { kind: "proceed"; reason: "not_bound" | "same_account" }
  /** A different Telegram account than the one the organizer is bound to. `started`: an interview exists, so no approval. */
  | { kind: "other_account"; started: boolean; bound: BoundTelegramAccount[] };

/**
 * May THIS Telegram account redeem an interview link issued to `userId` for `tripId`?
 *
 * `telegramUserId` is the update's verified private-chat sender and nothing else is an input: not a message, not a
 * callback payload, not a token field. Read under the caller's transaction (it holds the trip row), so the answer and the
 * redemption it gates see the same moment.
 */
export async function organizerBindingVerdict(
  q: Pick<pg.PoolClient, "query">,
  input: { userId: string; tripId: string; telegramUserId: string },
): Promise<OrganizerBindingVerdict> {
  // TWO QUESTIONS, kept apart on purpose (re-review R1, R2):
  //   1. Is the opener the SAME account FOR THIS TRIP? -- the narrowed set (`boundTelegramAccounts`).
  //   2. Is ANYONE bound to this account at all? -- `anyTelegramBound`, which does not narrow.
  // Narrowing answers 1 only. Reading an empty narrowed set as "nobody is bound" would let a stranger be bound account-wide
  // the moment the only account-scoped link is Unlinked (the lost-phone case: the new phone is a trip-scoped link) or the
  // owner is Unlinked from this one trip. An opener who is not the same account but where somebody is bound is "another
  // account"; only an account with nothing bound anywhere binds its first opener (AC-1).
  const same = await boundTelegramAccounts(q, input.userId, input.tripId);
  const mine = digestTelegramId(input.telegramUserId);
  if (same.some((account) => account.digest === mine)) return { kind: "proceed", reason: "same_account" };
  if (same.length === 0 && !(await anyTelegramBound(q, input.userId))) return { kind: "proceed", reason: "not_bound" };
  // `bound` is who may be ASKED: the accounts that can speak for this trip. It may be empty (everyone bound is bound to some
  // other trip only, or was taken off this one), and then nobody is asked and the opener is refused: fail closed.
  return { kind: "other_account", started: await tripHasInterviewSession(q, input.tripId), bound: same };
}

/**
 * Has this account EVER had a Telegram? A link row of either scope on any trip, live or revoked (a revoked row is an Unlink
 * or a membership that ended: somebody WAS bound), or a Telegram sign-up identity. Never narrowed, and never forgetful: it
 * exists so that a narrowed set cannot be mistaken for an empty account, and so that an account whose every Telegram was
 * Unlinked does not read as "fresh" -- a stranger would otherwise be bound account-wide by the next trip's interview link
 * (re-review R3). Only an account that has never had one binds its first opener (AC-1); the owner's way back is the dashboard.
 */
export async function anyTelegramBound(q: Pick<pg.PoolClient, "query">, userId: string): Promise<boolean> {
  const row = await q.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM control_plane.user_identities WHERE user_id = $1 AND provider = 'telegram')`,
    [userId],
  );
  return (row.rowCount ?? 0) > 0;
}

/**
 * The private chat that reaches a bound Telegram account, or null.
 *
 * Organizer links keep only a digest (the raw id is not stored there), so the id is recovered from rows that hold one
 * for the same person: the interviews this user ran, the chats of this user's trips, and the Telegram signup identity.
 * A candidate is accepted only when it hashes to the digest, so a stale or foreign row cannot point the question at
 * somebody else. Null means "nobody can be asked": the caller fails closed.
 */
export async function privateChatForDigest(
  q: Pick<pg.PoolClient, "query">,
  userId: string,
  digest: string,
): Promise<string | null> {
  const candidates = await q.query<{ chat_id: string | null }>(
    `SELECT provider_subject_id AS chat_id FROM control_plane.user_identities WHERE user_id = $1 AND provider = 'telegram'
     UNION
     SELECT telegram_chat_id FROM control_plane.intake_sessions WHERE user_id = $1
     UNION
     SELECT b.chat_id FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trip_memberships m ON m.trip_id = b.trip_id AND m.user_id = $1`,
    [userId],
  );
  for (const row of candidates.rows) {
    const id = row.chat_id;
    if (id && isPrivateChatId(id) && digestTelegramId(id) === digest) return id;
  }
  return null;
}

// ── Secondary organizers (#523) ──────────────────────────────────────────────

/**
 * The SQL fragment every Telegram-side reader shares: a LIVE secondary organizer row, whose hidden user still holds an ACTIVE
 * membership of the trip it is bound to. Callers add their own filter on `so.trip_id` and `so.telegram_subject_digest`. One
 * definition so `/trips`, `/switch`, the organizer check and the person role cannot drift apart, and so a membership that ends
 * by ANY route (the dashboard's member removal included) ends the secondary organizer with it.
 */
export const LIVE_SECONDARY_ORGANIZER_SQL = `
  FROM control_plane.trip_secondary_organizers so
  JOIN control_plane.trip_memberships som
    ON som.trip_id = so.trip_id AND som.user_id = so.user_id AND som.status = 'active' AND som.role = 'organizer'
  WHERE so.revoked_at IS NULL`;

/** Is this verified Telegram sender a live secondary organizer of `tripId`? Private-chat senders only; anything else is "no". */
export async function isSecondaryOrganizer(
  q: Pick<pg.PoolClient, "query">,
  tripId: string,
  telegramUserId: string,
): Promise<boolean> {
  if (!tripId || !isPrivateChatId(telegramUserId)) return false;
  const result = await q.query(
    `SELECT 1 ${LIVE_SECONDARY_ORGANIZER_SQL} AND so.trip_id = $1 AND so.telegram_subject_digest = $2 LIMIT 1`,
    [tripId, digestTelegramId(telegramUserId)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The first name stored for a live secondary organizer of this trip, or null when the sender is not one. */
export async function secondaryOrganizerName(
  q: Pick<pg.PoolClient, "query">,
  tripId: string,
  telegramUserId: string,
): Promise<{ displayName: string | null } | null> {
  if (!tripId || !isPrivateChatId(telegramUserId)) return null;
  const result = await q.query<{ telegram_first_name: string | null }>(
    `SELECT so.telegram_first_name ${LIVE_SECONDARY_ORGANIZER_SQL} AND so.trip_id = $1 AND so.telegram_subject_digest = $2 LIMIT 1`,
    [tripId, digestTelegramId(telegramUserId)],
  );
  return result.rows[0] ? { displayName: result.rows[0].telegram_first_name } : null;
}

export interface OrganizerTrip {
  tripId: string;
  slug: string;
  title: string | null;
  lifecycleState: string;
  reachability: string;
  /**
   * Why the trip is unreachable (migration 0042), or NULL. The database only
   * lets it be non-NULL while `reachability` is `unreachable`.
   */
  unreachableReason: string | null;
  /** The trip THIS chat routes to right now. At most one is true. */
  current: boolean;
  /**
   * Whether any binding for this trip carries a companion profile.
   *
   * Shown because a trip can be perfectly provisioned and still have no
   * assistant reachable from a new chat (migration 0043) — switching to it
   * succeeds and then answers `companionPending`, and an organizer who was not
   * told that reads it as the switch having failed.
   */
  hasCompanion: boolean;
}

/**
 * Every trip this Telegram person can act on, newest first, with the one this
 * chat is bound to marked.
 *
 * `chatId` is a ROUTING input only — it decides which row gets `current`, and
 * never which rows appear. That is why an organizer reading their list in one
 * chat sees the same trips as in any other.
 *
 * TORN-DOWN TRIPS ARE EXCLUDED, and the two markers used are the ones teardown
 * already writes (`scripts/teardown-trip.py`, `retire_in_db`): the `retired-`
 * slug prefix, and every binding closed with `trip_destroyed`. Membership alone
 * was the filter until 2026-09-20, when 39 of 40 `ready_private` rows on a
 * staging database were torn-down trips and the list was unusable.
 *
 * There is deliberately nothing on the trip ROW to test: teardown leaves
 * `lifecycle_state` exactly as it was, so a destroyed trip still reads
 * `ready_private`. Adding a state would change teardown's contract and its
 * refusal set; these two markers need no migration and are written by the only
 * thing that destroys a trip.
 *
 * NOT excluded: a trip whose bindings never carried a `hermes_profile`. That is
 * REVIVABLE, not dead — migration 0043's rule is that routing and the assistant
 * behind it are separate, separately retryable components, and the
 * provisioner's `attach_profile_to_orphan_bindings` fills exactly that gap on
 * the next provision. `hasCompanion` reports it so the caller can say so.
 */
export async function listOrganizerTrips(
  db: pg.Pool,
  telegramUserId: string,
  chatId: string,
): Promise<OrganizerTrip[]> {
  if (!isPrivateChatId(telegramUserId)) return [];
  const { rows } = await db.query<{
    id: string;
    slug: string;
    title: string | null;
    lifecycle_state: string;
    reachability: string;
    unreachable_reason: string | null;
    current: boolean;
    has_companion: boolean;
  }>(
    `SELECT DISTINCT t.id, t.slug, t.title, t.lifecycle_state, t.reachability, t.unreachable_reason, t.created_at,
            EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings b
                     WHERE b.trip_id = t.id AND b.chat_id = $2 AND b.closed_at IS NULL) AS current,
            EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings hb
                     WHERE hb.trip_id = t.id AND hb.hermes_profile IS NOT NULL) AS has_companion
       FROM control_plane.trips t
       JOIN control_plane.trip_memberships m
         ON m.trip_id = t.id AND m.status = 'active'
      WHERE (EXISTS (
              SELECT 1 FROM control_plane.telegram_organizer_trip_links l
               WHERE l.telegram_subject_digest = $1 AND l.user_id = m.user_id
                 AND l.trip_id = t.id AND l.revoked_at IS NULL)
             -- A secondary organizer (#523) sees the ONE trip they were added to, and no other: the row names a trip.
             OR EXISTS (
              SELECT 1 ${LIVE_SECONDARY_ORGANIZER_SQL} AND so.trip_id = t.id AND so.telegram_subject_digest = $1))
        AND ${NOT_RETIRED_SQL}
        AND NOT EXISTS (
              SELECT 1 FROM control_plane.telegram_chat_bindings d
               WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')
      ORDER BY t.created_at DESC`,
    [digestTelegramId(telegramUserId), chatId],
  );
  return rows.map((row) => ({
    tripId: row.id,
    slug: row.slug,
    title: row.title,
    lifecycleState: row.lifecycle_state,
    reachability: row.reachability,
    unreachableReason: row.unreachable_reason,
    current: row.current,
    hasCompanion: row.has_companion,
  }));
}

export type SwitchOutcome =
  | {
      kind: "switched";
      tripId: string;
      previousTripId: string | null;
      /** NULL when no binding for this trip has ever carried a companion. */
      hermesProfile: string | null;
    }
  /** Already routed here. Reported separately so the reply can say so plainly. */
  | { kind: "unchanged"; tripId: string }
  | {
      kind: "refused";
      reason:
        /** Asked in a group. A group's binding belongs to the family, not to whoever typed. */
        | "NOT_PRIVATE_CHAT"
        /** Not a trip this verified sender may act on — INCLUDING one that does not exist. */
        | "NOT_YOURS"
        /** A live interview outranks a binding, so switching would appear to do nothing. */
        | "IN_INTERVIEW";
    };

/**
 * Points one chat at a different trip the sender already owns.
 *
 * PRIVATE CHATS ONLY, and that restriction is load-bearing rather than
 * cautious. On a shared bot, letting `/switch` run in a family group would let
 * any member move the whole room to another trip — possibly another
 * organizer's. The sprint plan says the same thing from the other side:
 * private selection "changes only the DM context; neither group binding
 * changes".
 *
 * A reassignment CLOSES the previous binding rather than overwriting it, which
 * is the entire point of migration 0029 — bindings are append-only and "in
 * force" is a partial unique index over the open rows. The close carries its
 * own reason, so history distinguishes an organizer's own switch from a
 * provisioner move.
 *
 * The new row inherits the trip's companion profile the same way
 * `redeemGroupBindingToken` does: from the most recent binding that has one.
 * When the trip has never had a binding with a profile, the row is written
 * with NULL rather than refused — migration 0043's rule is that routing and
 * the assistant behind it are separate, separately retryable components, and
 * the provisioner's `attach_profile_to_orphan_bindings` fills exactly this gap
 * on the next provision. Refusing instead would leave an organizer with a
 * provisioned trip they can never point their DM at.
 */
export async function switchChatToTrip(
  db: pg.Pool,
  telegramUserId: string,
  chatId: string,
  tripId: string,
): Promise<SwitchOutcome> {
  // Both halves must be the private shape: the chat because a group binding is
  // not one person's to move, and the sender because a digest of anything else
  // is not an identity.
  if (!isPrivateChatId(chatId) || !isPrivateChatId(telegramUserId)) {
    return { kind: "refused", reason: "NOT_PRIVATE_CHAT" };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // A live interview outranks a binding in `resolveChatRoute`, so a switch
    // applied underneath one would look like it did nothing at all. Checked
    // before anything is written, and reported rather than silently applied.
    //
    // The predicate is SHARED with the router rather than restated here. It was
    // restated, and the copy drifted: it omitted `expired_at IS NULL`, so an
    // interview closed for idleness stopped routing the chat — correctly — and
    // went on blocking every switch in it, permanently, with a companion
    // answering in the same chat. Nothing clears it; teardown's own cleanup
    // expires sessions, it does not confirm them. Found live 2026-09-20.
    const live = await client.query(
      `SELECT 1 FROM control_plane.intake_sessions
        WHERE ${LIVE_INTAKE_SESSION_PREDICATE}`,
      [chatId],
    );
    if (live.rowCount) {
      await client.query("ROLLBACK");
      return { kind: "refused", reason: "IN_INTERVIEW" };
    }

    // The authorization, and the only one. Derived from the digest of the id
    // Telegram delivered — never from the argument, which is being checked
    // AGAINST this set rather than trusted to name it.
    const owned = await client.query(
      `SELECT 1
         FROM control_plane.trip_memberships m
         JOIN control_plane.trips t ON t.id = m.trip_id
        WHERE m.trip_id = $1
          AND m.status = 'active'
          -- Ownership survives retirement (teardown renames the slug, it keeps
          -- the membership), so membership alone would bind a chat to a
          -- retired trip. Same predicate as group-binding and the trip list;
          -- deliberately no lock — see #175 (40P01 against retire_in_db).
          AND ${NOT_RETIRED_SQL}
          AND (EXISTS (
                SELECT 1 FROM control_plane.telegram_organizer_trip_links l
                 WHERE l.telegram_subject_digest = $2 AND l.user_id = m.user_id
                   AND l.trip_id = m.trip_id AND l.revoked_at IS NULL)
               -- A secondary organizer (#523) may switch to the trip they were added to (and only that one).
               OR EXISTS (
                SELECT 1 ${LIVE_SECONDARY_ORGANIZER_SQL} AND so.trip_id = m.trip_id AND so.telegram_subject_digest = $2))
        LIMIT 1`,
      [tripId, digestTelegramId(telegramUserId)],
    );
    if (!owned.rowCount) {
      await client.query("ROLLBACK");
      // Same answer a non-existent trip gets. See the header.
      return { kind: "refused", reason: "NOT_YOURS" };
    }

    // FOR UPDATE so two taps of the same button serialise here rather than
    // both believing they closed the incumbent. 0029's partial unique index is
    // the backstop if they somehow don't.
    const openRow = await client.query<{ id: string; trip_id: string; hermes_profile: string | null }>(
      `SELECT id, trip_id, hermes_profile
         FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND closed_at IS NULL
        FOR UPDATE`,
      [chatId],
    );
    const existing = openRow.rows[0];
    if (existing && existing.trip_id === tripId) {
      await client.query("ROLLBACK");
      return { kind: "unchanged", tripId };
    }

    if (existing) {
      await client.query(
        `UPDATE control_plane.telegram_chat_bindings
            SET closed_at = now(), closed_reason = $2
          WHERE id = $1`,
        [existing.id, SWITCH_CLOSED_REASON],
      );
    }

    // The trip's own companion first (migration 20260922060000), a binding's only as a
    // fallback for trips built before that column existed.
    //
    // Reading bindings alone was a hole exactly where this feature is needed:
    // a trip whose binding was REFUSED has no binding row at all, so the lookup
    // found nothing and the switch bound the chat with a NULL profile — a trip
    // that answers "I'm still finishing your assistant" for good, with its
    // assistant installed and running. That is the state every returning
    // organizer's second trip is in until the moment this switch happens.
    const profileRow = await client.query<{ hermes_profile: string | null }>(
      `SELECT coalesce(
                t.hermes_profile,
                (SELECT b.hermes_profile
                   FROM control_plane.telegram_chat_bindings b
                  WHERE b.trip_id = t.id AND b.hermes_profile IS NOT NULL
                  ORDER BY b.created_at DESC
                  LIMIT 1)
              ) AS hermes_profile
         FROM control_plane.trips t
        WHERE t.id = $1`,
      [tripId],
    );
    const hermesProfile = profileRow.rows[0]?.hermes_profile ?? null;

    await client.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
       VALUES ($1, $2, $3, $4)`,
      [bindingId(), chatId, tripId, hermesProfile],
    );

    await client.query("COMMIT");
    return {
      kind: "switched",
      tripId,
      previousTripId: existing?.trip_id ?? null,
      hermesProfile,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
