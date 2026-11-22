/**
 * "Send me a sign-in link" (docs/specs/sprint-9/x-member-sign-in.md, slice S3, AC-14 to AC-16; issue #614).
 *
 * A member who cannot get in asks for a link from a sign-in screen. If their account exists and has a channel, a
 * single-use, 30-minute link arrives there; opening it signs them in on the portal and offers, once, to set a new
 * password. The screen says the same thing whatever happened. This module is everything behind that sentence; the
 * three routes (portal.ts) only parse, limit and answer.
 *
 * WHO IS A "MEMBER ACCOUNT". An ACTIVE account with an active `member` seat on some trip and NO owner or organizer seat
 * on any trip, in any status (`isMemberAccount`). Organizer sign-in is not changed by this slice (spec, Non-goals): an
 * organizer's way back in is the password reset that already exists (`POST /v1/auth/password/forgot`,
 * portal-email-auth.ts), Telegram, or Google. So an organizer's address typed here sends NOTHING and says nothing, and so
 * does an account that has never been on a trip (a portal sign-up that has not made one yet is organizer-shaped, not a
 * member). Without the "no organizer seat anywhere" half, a person who organises one trip and joined another as a member
 * would be recoverable through the member door, which is organizer recovery by the back way.
 *
 * THE TWO DOORS, and why only one can use email:
 *   - `{ email }`: the account is the one `digestEmail(address)` names (the same lookup as the password reset). The
 *     address in hand is the one the person typed, and it is the only address anywhere: the control plane keeps
 *     addresses as digests ("a stored address is something that can be mailed", portal-email-auth.ts), so an email can
 *     only ever go to the text of this very request. It never mints an account (`resolveOrCreateEmailAccount` is not
 *     called): an unknown address finds nothing and sends nothing.
 *   - `{ tripId, travellerName }`: the account mapped to that traveller on that trip, by the same mapping the runtime
 *     launch exchange uses (a live group claim first, then a redeemed site invite; portal.ts). The name is matched,
 *     normalised, against the TRIP SITE'S participant list, and exactly one participant must answer to it, and the site
 *     must call them a `member`. Ambiguous, unmatched, unreadable: nothing. There is no address on this door, so its
 *     only channel is Telegram.
 *
 * WHERE A LINK GOES, in this order, and only if provably the account's own:
 *   1. a PRIVATE Telegram chat. The control plane holds a raw, sendable chat id in exactly two places for a member:
 *      the live group claim that made the account (`trip_participant_claims.telegram_user_id`, written from verified
 *      initData and blanked when the claim ends), and a `telegram` identity's `provider_subject_id` (written at a
 *      Telegram sign-in) whose digest matches. `telegram_member_links` holds a digest only and cannot be messaged, so a
 *      member who linked Telegram by password or invite has NO deliverable chat. Never a group: `isPrivateChatId`.
 *   2. a VERIFIED email address: the account holds a Google identity (Google asserted the address verified at that
 *      sign-in, portal.ts). `user_identities.verified_at` on the password identity is NOT evidence: it records when an
 *      address was asserted, not proven (password-identity.ts), and an invitation writes it for an address nobody has
 *      proven. That makes this channel narrow on purpose; widening it is one predicate (`emailIsVerified`).
 *   3. nowhere.
 *
 * WHAT THE SESSION IS. Opening the link mints the session the account's own sign-in mints (same cookies, same CSRF),
 * with one narrowing: an account a GROUP CLAIM made (a live `mini_app_group_membership` link) gets the claim's SCOPED
 * session, exactly as a Mini App launch does. A plain session would walk around the group re-check (A3), the switch (A4)
 * and the ban on a claimant's password (A2): the link would be a stronger way in than the one it recovers. A claimed
 * account has no credential and is never given one, so it is not offered a password.
 *
 * THE ANSWER NEVER SAYS WHAT HAPPENED, and the clock does not either: the route answers, then this module does every
 * lookup, every call to the trip site and every send in the background (`runInBackground`), so how long the answer takes
 * is the same for every case by construction (the 202 does not wait for any of it). Limits are silent (AC-16): the
 * per-IP count is taken in the route for EVERY request, found or not, so the limiter cannot tell an account from a
 * guess; the per-account and per-channel ceilings live in the table and are counted and written under one lock.
 *
 * NOTHING HERE LOGS AN ADDRESS, A NAME, A TOKEN, A LINK, A CHAT ID OR WHICH BRANCH WAS TAKEN. The only counter is
 * coarse and in memory (`signInLinkOutcomeCounts`): how many requests ended in a Telegram notice, a mail, nothing sent,
 * a ceiling, or a fault. It carries no key, so it cannot be joined to a request. A failure logs a code.
 *
 * THE CEILINGS COUNT REQUESTS, NOT LINKS (boundary review of S3, finding 1). Every admitted request takes one slot in each
 * per-channel ceiling it could have used, BEFORE anything is looked up and whatever it finds: a name-door request one
 * Telegram slot, an email-door request one Telegram and one email slot (`reserveSlots`). Counting issued links instead made
 * the ceiling a probe: fill it to one short, send a guess, then ask for your own link; it arrives only if the guess did NOT
 * take the last slot, i.e. did not qualify. The per-account allowance (3 links an hour) is keyed on the target and read only
 * by that account's own requests, so asking for a victim's link cannot be observed by anyone but the victim.
 *
 * TWO SWITCHES, both off unless set, and neither visible from outside. `member_sign_in_link` gates the feature: the name
 * door per trip (the resolver, `featureEnabled`), the email door, which has no trip, at the every-trip level
 * (`allTripsOn`; the resolver cannot be asked "every trip" without a trip id, so this reads that one setting). Off, unknown
 * or unreadable is the same 202 with the ceiling slot and the per-IP count already taken. A link that exists stays
 * redeemable for its 30 minutes whatever happens to that switch afterwards. `member_group_sign_in` gates a GROUP
 * CLAIMANT's link exactly as it gates their Mini App launch (see `claimMayOpen` at issue and the route's
 * `groupSessionVerdict` at redemption).
 *
 * THE TOKEN is 32 random bytes, `sl_` + base64url, stored as a digest (`sign_in_links`, see its migration). It travels
 * in the URL FRAGMENT (`/sign-in-link#token=…`), which a browser never sends to a server and a link previewer's GET
 * never reaches the API with; the landing page POSTs it. Redeeming is a POST for that reason, the same shape as the
 * email verification and password reset pages (`/verify-email#token=`, `/reset-password#token=`).
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { digestTelegramId, isPrivateChatId } from "./identity.js";
import type { Mailer } from "./mailer.js";
import { MailSendError } from "./mailer.js";
import { digestEmail } from "./password-identity.js";
import { featureEnabled } from "./feature-switches.js";
import { renderPortalMail, type MailLanguage } from "./portal-email-templates.js";
import { structuredLog } from "./redaction.js";
import type { NotificationAdapter } from "./signup.js";
import { findSwitch } from "../../../shared/feature-switches.js";
import type { GroupMembershipCheck } from "./telegram-group-membership.js";
import { GROUP_VERIFIED_VIA, TRIP_ID_PATTERN, openGroupChat, type SiteParticipant } from "./telegram-mini-app.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

export const SIGN_IN_LINK_TTL_SECONDS = 30 * 60;
export const SIGN_IN_LINK_NOTICE_TYPE = "sign_in_link_notice";
/** Links one account may be sent per hour, whatever the channel; past it a request is answered and nothing is sent. */
export const SIGN_IN_LINK_ACCOUNT_PER_HOUR = 3;
/** Admitted REQUESTS per channel, from anyone, per minute (see the header): a flood of distinct guesses cannot make this a message cannon. */
export const SIGN_IN_LINK_CHANNEL_PER_MINUTE = { telegram: 30, email: 20 } as const;
export const SIGN_IN_LINK_SWITCH = "member_sign_in_link";
/** How long after a redemption its session may take the one password step. */
export const SIGN_IN_LINK_PASSWORD_WINDOW = "15 minutes";

const TOKEN_SHAPE = /^sl_[A-Za-z0-9_-]{43}$/;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const opaqueId = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

// ── The only counter ────────────────────────────────────────────────────────

export type SignInLinkOutcome = "telegram_queued" | "email_sent" | "nothing_to_send" | "ceiling" | "fault";
const outcomes = new Map<SignInLinkOutcome, number>();
const count = (outcome: SignInLinkOutcome) => { outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1); };
/** Coarse totals since the process started. No key, no time, no account: nothing here can be joined to a request. */
export function signInLinkOutcomeCounts(): Record<SignInLinkOutcome, number> {
  return {
    telegram_queued: outcomes.get("telegram_queued") ?? 0, email_sent: outcomes.get("email_sent") ?? 0,
    nothing_to_send: outcomes.get("nothing_to_send") ?? 0, ceiling: outcomes.get("ceiling") ?? 0, fault: outcomes.get("fault") ?? 0,
  };
}

// ── Who ─────────────────────────────────────────────────────────────────────

type Queryable = Pick<pg.PoolClient, "query">;

/** See the header: an active member, and an organizer nowhere. One statement, so there is no gap between the two halves. */
async function isMemberAccount(db: Queryable, userId: string): Promise<boolean> {
  const found = await db.query(
    `SELECT 1 FROM control_plane.users u
      WHERE u.id = $1 AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM control_plane.trip_memberships m WHERE m.user_id = u.id AND m.role = 'member' AND m.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM control_plane.trip_memberships m WHERE m.user_id = u.id AND m.role IN ('owner', 'organizer'))`,
    [userId],
  );
  return (found.rowCount ?? 0) > 0;
}

/** The account an address names: the same two doors the password reset reads, and never a new account. */
async function accountForEmail(db: Queryable, email: string): Promise<string | null> {
  const digest = digestEmail(email);
  const found = await db.query<{ user_id: string }>(
    `SELECT user_id FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1
     UNION
     SELECT user_id FROM control_plane.password_credentials WHERE email_digest = $1
     LIMIT 2`,
    [digest],
  );
  // Two different users behind one digest is a data fault, not something to pick between.
  return found.rows.length === 1 ? found.rows[0]!.user_id : null;
}

/** NFKC, case-folded, invisible characters dropped, runs of whitespace collapsed: "exact, normalised". */
export function normaliseName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
}

async function accountForTraveller(
  db: pg.Pool, listParticipants: (tripId: string) => Promise<SiteParticipant[]>, tripId: string, travellerName: string,
): Promise<string | null> {
  if (!TRIP_ID_PATTERN.test(tripId)) return null;
  const trip = await db.query(`SELECT 1 FROM control_plane.trips t WHERE t.id = $1 AND ${NOT_RETIRED_SQL}`, [tripId]);
  if (!trip.rowCount) return null;
  const wanted = normaliseName(travellerName);
  if (!wanted) return null;
  const people = await listParticipants(tripId);
  const matches = people.filter((person) => typeof person.displayName === "string" && normaliseName(person.displayName) === wanted);
  const only = matches.length === 1 ? matches[0]! : null;
  if (!only || only.role !== "member") return null;
  // The launch exchange's own order: a live group claim, then a redeemed invite.
  const claimed = await db.query<{ user_id: string }>(
    `SELECT user_id FROM control_plane.trip_participant_claims
      WHERE trip_id = $1 AND runtime_username = $2 AND released_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [tripId, only.username],
  );
  const invited = claimed.rows[0] ? null : await db.query<{ user_id: string }>(
    `SELECT redeemed_by AS user_id FROM control_plane.site_invites
      WHERE trip_id = $1 AND runtime_username = $2 AND state = 'redeemed' AND redeemed_by IS NOT NULL ORDER BY redeemed_at DESC LIMIT 1`,
    [tripId, only.username],
  );
  const userId = claimed.rows[0]?.user_id ?? invited?.rows[0]?.user_id ?? null;
  if (!userId) return null;
  // Still a member of THIS trip: an invite whose person was removed maps to nobody.
  const seat = await db.query(
    "SELECT 1 FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND role = 'member' AND status = 'active'", [tripId, userId]);
  return seat.rowCount ? userId : null;
}

// ── Where ───────────────────────────────────────────────────────────────────

/**
 * The `telegram_member_links` row of a live GROUP CLAIM of this account, or null. A claim is live when its own row is
 * (`released_at IS NULL`) and its link is (`revoked_at IS NULL`); both end together, but this asks for both.
 */
async function liveGroupClaim(db: Queryable, userId: string): Promise<{ linkId: string; tripId: string; telegramUserId: string | null; chatId: string | null } | null> {
  const found = await db.query<{ link_id: string; trip_id: string; digest: string; telegram_user_id: string | null }>(
    `SELECT l.id AS link_id, l.trip_id, l.telegram_subject_digest AS digest, c.telegram_user_id
       FROM control_plane.telegram_member_links l
       JOIN control_plane.trip_participant_claims c ON c.trip_id = l.trip_id AND c.user_id = l.user_id AND c.released_at IS NULL
      WHERE l.user_id = $1 AND l.verified_via = $2 AND l.revoked_at IS NULL
      ORDER BY l.created_at DESC LIMIT 1`,
    [userId, GROUP_VERIFIED_VIA],
  );
  const row = found.rows[0];
  if (!row) return null;
  // The raw id counts only when it is a private chat id AND the link's own digest says it is that person's.
  const chat = row.telegram_user_id && isPrivateChatId(row.telegram_user_id) && digestTelegramId(row.telegram_user_id) === row.digest
    ? row.telegram_user_id : null;
  return { linkId: row.link_id, tripId: row.trip_id, telegramUserId: row.telegram_user_id, chatId: chat };
}

/** A private chat id that provably belongs to this account, or null. See the header for the two places one exists. */
async function deliverableChat(db: Queryable, userId: string, claim: { chatId: string | null } | null): Promise<string | null> {
  if (claim?.chatId) return claim.chatId;
  const identities = await db.query<{ id: string | null; digest: string }>(
    `SELECT provider_subject_id AS id, provider_subject_digest AS digest FROM control_plane.user_identities
      WHERE user_id = $1 AND provider = 'telegram' AND provider_subject_id IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
    [userId],
  );
  for (const row of identities.rows) {
    if (row.id && isPrivateChatId(row.id) && digestTelegramId(row.id) === row.digest) return row.id;
  }
  return null;
}

/** Google signed this address as verified at a sign-in this account holds. The password identity's `verified_at` is not evidence. */
async function emailIsVerified(db: Queryable, userId: string): Promise<boolean> {
  const found = await db.query("SELECT 1 FROM control_plane.user_identities WHERE user_id = $1 AND provider = 'google' LIMIT 1", [userId]);
  return (found.rowCount ?? 0) > 0;
}

// ── The request (background) ────────────────────────────────────────────────

export interface SignInLinkContext {
  db: pg.Pool;
  /** Absent: the email channel does not exist, and a request that would have used it sends nothing. */
  mailer: Mailer | undefined;
  publicOrigin: string;
  listParticipants(tripId: string): Promise<SiteParticipant[]>;
  /** How to ask Telegram whether a person is in a trip's group; absent means the group path is not wired, and a claimant's link is never issued. */
  groupSignIn?: { isActiveMember: GroupMembershipCheck } | undefined;
  log(line: string): void;
}

export type SignInLinkRequest =
  | { door: "email"; email: string; language: MailLanguage }
  | { door: "traveller"; tripId: string; travellerName: string };

interface Issued { token: string; linkId: string }

type Channel = "telegram" | "email";

/**
 * Takes one slot in each of `channels`' per-minute ceilings, under one lock, and says which ceilings admitted the request.
 * A ceiling that is full admits nothing and takes nothing. Called for EVERY admitted request before any lookup (see the
 * header): what a request takes never depends on what it finds.
 */
async function reserveSlots(db: pg.Pool, channels: readonly Channel[]): Promise<Set<Channel>> {
  const admitted = new Set<Channel>();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sign_in_link.slots', 0))");
    for (const channel of channels) {
      const counted = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM control_plane.sign_in_link_requests WHERE channel = $1 AND created_at > now() - interval '1 minute'", [channel]);
      if ((counted.rows[0]?.n ?? 0) >= SIGN_IN_LINK_CHANNEL_PER_MINUTE[channel]) continue;
      await client.query("INSERT INTO control_plane.sign_in_link_requests(channel) VALUES ($1)", [channel]);
      admitted.add(channel);
    }
    await client.query("COMMIT");
    return admitted;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Is the feature on at the EVERY-TRIP level? The question the email door (which has no trip) and the capabilities answer ask.
 * `feature_enabled` resolves a switch for a trip and cannot be asked "every trip" without one, so this reads that one setting.
 * Off for everything uncertain, exactly like `featureEnabled`: an unregistered name, no row, a failed read.
 */
export async function signInLinkAvailable(db: Queryable, log: (line: string) => void = () => {}): Promise<boolean> {
  if (!findSwitch(SIGN_IN_LINK_SWITCH)) return false;
  try {
    const found = await db.query<{ enabled: unknown }>(
      "SELECT enabled FROM control_plane.feature_switch_settings WHERE switch = $1 AND scope = 'all_trips'", [SIGN_IN_LINK_SWITCH]);
    return found.rows[0]?.enabled === true;
  } catch {
    try { log(structuredLog("warn", "feature_switch.read_failed", { switch: SIGN_IN_LINK_SWITCH })); } catch { /* never the reason a feature turns on */ }
    return false;
  }
}

/** Opportunistic, on every admitted request, no scheduler: see the migration's RETENTION paragraph. */
async function purge(db: pg.Pool): Promise<void> {
  await db.query("DELETE FROM control_plane.sign_in_links WHERE created_at < now() - interval '2 days'");
  await db.query("DELETE FROM control_plane.sign_in_link_requests WHERE created_at < now() - interval '1 hour'");
  // A notice nobody sent within the link's life (no dispatcher in this deployment, or one that is down) keeps no token and no chat id.
  await db.query(
    `UPDATE control_plane.notification_outbox SET state = 'skipped', recipient = NULL, payload = NULL, updated_at = now()
      WHERE notification_type = '${SIGN_IN_LINK_NOTICE_TYPE}' AND state = 'pending' AND created_at < now() - ($1 * interval '1 second')`,
    [SIGN_IN_LINK_TTL_SECONDS],
  );
}

/**
 * Issue-time half of the Mini App's gate for a GROUP CLAIMANT, read-only: the group switch is on, the trip has its one open
 * group, and Telegram says the person is in it. So no link is sent that cannot be used. Nothing is revoked here (only a
 * launch, and the redemption through the route's `groupSessionVerdict`, end a claim); and it runs behind the already-sent
 * answer, so it is no oracle.
 */
async function claimMayOpen(ctx: SignInLinkContext, claim: { tripId: string; telegramUserId: string | null }): Promise<boolean> {
  if (!ctx.groupSignIn || !claim.telegramUserId) return false;
  if (!(await featureEnabled(ctx.db, claim.tripId, "member_group_sign_in", ctx.log))) return false;
  const chat = await openGroupChat(ctx.db, claim.tripId);
  if (!chat) return false;
  return (await ctx.groupSignIn.isActiveMember(chat, claim.telegramUserId)) === true;
}

/**
 * Counts and writes in one step under one lock (the per-account allowance), ends the account's older
 * links, writes this one and, for Telegram, the notice that carries it, all in one transaction: a link exists if and
 * only if its message was queued. Null when a ceiling stopped it.
 */
async function issueLink(
  db: pg.Pool, input: { userId: string; channel: "telegram" | "email"; telegramLinkId: string | null; chatId: string | null },
): Promise<Issued | null> {
  const token = `sl_${randomBytes(32).toString("base64url")}`;
  const linkId = opaqueId("sil");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sign_in_link.budget', 0))");
    // The per-channel ceilings are not here: they count admitted REQUESTS and were taken before the lookup (`reserveSlots`).
    const counts = await client.query<{ account: number }>(
      "SELECT count(*)::int AS account FROM control_plane.sign_in_links WHERE user_id = $1 AND created_at > now() - interval '1 hour'",
      [input.userId],
    );
    if ((counts.rows[0]?.account ?? 0) >= SIGN_IN_LINK_ACCOUNT_PER_HOUR) {
      await client.query("ROLLBACK");
      return null;
    }
    // Only the newest link works: a person who asked twice is not left holding two live ones.
    await client.query("UPDATE control_plane.sign_in_links SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()", [input.userId]);
    await client.query(
      `INSERT INTO control_plane.sign_in_links(id, token_digest, user_id, channel, telegram_link_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))`,
      [linkId, sha(token), input.userId, input.channel, input.telegramLinkId, SIGN_IN_LINK_TTL_SECONDS],
    );
    if (input.channel === "telegram") {
      // The token is in this row's payload for the seconds until the dispatcher sends it, and the dispatcher blanks the
      // payload (and the chat id) the moment the row is sent or has failed for good.
      await client.query(
        `INSERT INTO control_plane.notification_outbox
           (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
         VALUES ($1, NULL, $2, $3, $4::jsonb, NULL, $2, 'control-plane', 'pending')`,
        [opaqueId("notif"), SIGN_IN_LINK_NOTICE_TYPE, input.chatId, JSON.stringify({ token })],
      );
    }
    await client.query("COMMIT");
    return { token, linkId };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Everything a request does after it has been answered. Never throws, never logs who or why: a fault is a code.
 * Returns nothing: the caller's answer was sent before this started.
 */
export async function startSignInLink(ctx: SignInLinkContext, request: SignInLinkRequest): Promise<void> {
  try {
    await purge(ctx.db);
    // FIRST, and whatever follows: the ceilings' slots. A request takes the same ones for every account state and for either
    // setting of the switch (header). A name-door request could only ever use Telegram; an email-door one either channel.
    const admitted = await reserveSlots(ctx.db, request.door === "email" ? ["telegram", "email"] : ["telegram"]);
    if (admitted.size === 0) return count("ceiling");
    // The switch. Off, unknown and unreadable are all "nothing", after the slot is taken.
    const switchOn = request.door === "email"
      ? await signInLinkAvailable(ctx.db, ctx.log)
      : TRIP_ID_PATTERN.test(request.tripId) && await featureEnabled(ctx.db, request.tripId, SIGN_IN_LINK_SWITCH, ctx.log);
    if (!switchOn) return count("nothing_to_send");

    const userId = request.door === "email"
      ? await accountForEmail(ctx.db, request.email)
      : await accountForTraveller(ctx.db, ctx.listParticipants, request.tripId, request.travellerName);
    if (!userId || !(await isMemberAccount(ctx.db, userId))) return count("nothing_to_send");

    const claim = await liveGroupClaim(ctx.db, userId);
    // A group claimant's link is held to the same gate as their Mini App launch: no link that cannot be used.
    if (claim && !(await claimMayOpen(ctx, claim))) return count("nothing_to_send");
    const chatId = admitted.has("telegram") ? await deliverableChat(ctx.db, userId, claim) : null;
    // The one address anywhere is the one just typed, so only the email door can use this channel.
    const address = request.door === "email" ? request.email : null;
    const viaEmail = !chatId && admitted.has("email") && address !== null && ctx.mailer !== undefined && await emailIsVerified(ctx.db, userId);
    if (!chatId && !viaEmail) return count("nothing_to_send");

    const channel = chatId ? "telegram" : "email";
    const issued = await issueLink(ctx.db, { userId, channel, telegramLinkId: claim?.linkId ?? null, chatId });
    if (!issued) return count("ceiling");
    if (channel === "telegram") return count("telegram_queued");

    // Email: after the commit, to the text of this request. A send that fails ends the link (nobody has it) and is loud.
    try {
      await ctx.mailer!.send(renderPortalMail({
        kind: "sign_in", link: `${ctx.publicOrigin}/sign-in-link#token=${issued.token}`, ttlMinutes: SIGN_IN_LINK_TTL_SECONDS / 60,
      }, request.door === "email" ? request.language : "en", address!));
      count("email_sent");
    } catch (error) {
      await ctx.db.query("UPDATE control_plane.sign_in_links SET expires_at = now() WHERE id = $1", [issued.linkId]);
      ctx.log(structuredLog("error", "sign_in_link.send_failed", {
        provider_status: error instanceof MailSendError ? error.status : null, effect: "no message reached the address",
      }));
      count("fault");
    }
  } catch (error) {
    count("fault");
    ctx.log(structuredLog("error", "sign_in_link.request_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
  }
}

// ── The Telegram notice (outbox) ────────────────────────────────────────────

function noticeText(link: string): string {
  return [
    `Your Kinerary sign-in link: ${link}`,
    "It works once and for 30 minutes. If you did not ask for it, ignore this message: nothing happens unless the link is opened.",
    "",
    `קישור הכניסה שלכם ל-Kinerary: ${link}`,
    "הוא פועל פעם אחת ולמשך 30 דקות. אם לא ביקשתם אותו, אפשר להתעלם מההודעה הזו: שום דבר לא קורה אלא אם נפתח הקישור.",
  ].join("\n");
}

async function expireLinkOf(db: pg.Pool, token: string): Promise<void> {
  await db.query("UPDATE control_plane.sign_in_links SET expires_at = now() WHERE token_digest = $1 AND used_at IS NULL", [sha(token)]);
}

/**
 * Sends the pending `sign_in_link_notice` rows. A separate pass from the ordinary dispatcher (outbox-dispatcher.ts calls
 * it, and its own query never selects this type) because these rows carry a secret: sent or failed for good, the row's
 * chat id AND payload are blanked; a row older than the link's own life is skipped and blanked unsent, never delivered
 * late. Returns how many were sent.
 */
export async function dispatchSignInLinkNotices(
  db: pg.Pool, notification: NotificationAdapter, log: (line: string) => void, options?: { publicOrigin?: string | null },
): Promise<number> {
  const { rows } = await db.query<{ id: string; recipient: string | null; payload: { token?: unknown } | null; attempt: number; max_attempts: number; fresh: boolean }>(
    `SELECT id, recipient, payload, attempt, max_attempts,
            (created_at > now() - ($1 * interval '1 second')) AS fresh
       FROM control_plane.notification_outbox
      WHERE state = 'pending' AND notification_type = '${SIGN_IN_LINK_NOTICE_TYPE}'
      ORDER BY created_at LIMIT 20`,
    [SIGN_IN_LINK_TTL_SECONDS],
  );
  let sent = 0;
  // Loud, once per pass, and about the deployment (not a request): without the portal's origin no link can be built, so the
  // rows are blanked unsent and nobody would otherwise know why no message came.
  if (rows.length > 0 && !options?.publicOrigin) {
    log(structuredLog("error", "sign_in_link.no_public_origin", { effect: "pending sign-in link notices were dropped unsent" }));
  }
  for (const row of rows) {
    const token = typeof row.payload?.token === "string" && TOKEN_SHAPE.test(row.payload.token) ? row.payload.token : null;
    if (!row.fresh || !row.recipient || !isPrivateChatId(row.recipient) || !token || !options?.publicOrigin) {
      if (token) await expireLinkOf(db, token);
      await db.query(
        `UPDATE control_plane.notification_outbox SET state = 'skipped', recipient = NULL, payload = NULL, updated_at = now()
          WHERE id = $1 AND state = 'pending'`, [row.id]);
      continue;
    }
    try {
      await notification.sendMessage({ chatId: row.recipient, text: noticeText(`${options.publicOrigin}/sign-in-link#token=${token}`) });
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'sent', sent_at = now(), recipient = NULL, payload = NULL, updated_at = now() WHERE id = $1",
        [row.id]);
      sent++;
    } catch {
      log(structuredLog("error", "outbox.dispatch_failed", { safe_error_code: "NOTIFICATION_SEND_FAILED", notification_id: row.id }));
      // The same ending as a mail that could not be sent: a link nobody received does not stay alive for its 30 minutes.
      if (row.attempt + 1 >= row.max_attempts) await expireLinkOf(db, token);
      await db.query(
        `UPDATE control_plane.notification_outbox
            SET state = CASE WHEN attempt + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
                recipient = CASE WHEN attempt + 1 >= max_attempts THEN NULL ELSE recipient END,
                payload = CASE WHEN attempt + 1 >= max_attempts THEN NULL ELSE payload END,
                attempt = attempt + 1, updated_at = now()
          WHERE id = $1`, [row.id]);
    }
  }
  return sent;
}

// ── Opening the link (inside the caller's transaction) ──────────────────────

export type RedeemResult =
  /** Unknown, used, expired, superseded, malformed, and "the account is no longer one a link may sign in" are ONE answer. */
  | { ok: false }
  | { ok: true; linkId: string; userId: string; telegramLinkId: string | null; /** set for a group claimant: the route asks the Mini App's group gate before it hands the session out */ claimTripId: string | null; canSetPassword: boolean };

/**
 * Spends a link and says who it signs in and with what scope. The caller owns BEGIN/COMMIT and mints the session in the
 * same transaction. A link whose account has stopped being a member account, or whose group claim has ended (or begun)
 * since it was sent, is spent and refused like any dead link.
 */
export async function consumeSignInLink(client: pg.PoolClient, token: unknown): Promise<RedeemResult> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return { ok: false };
  const found = await client.query<{ id: string; user_id: string; telegram_link_id: string | null }>(
    // No join on the account's status: a link of a suspended account is found, SPENT and refused below, so lifting the
    // suspension within its 30 minutes does not bring it back to life. (`isMemberAccount` is the status check.)
    `SELECT l.id, l.user_id, l.telegram_link_id FROM control_plane.sign_in_links l
      WHERE l.token_digest = $1 AND l.used_at IS NULL AND l.expires_at > now() FOR UPDATE OF l`,
    [sha(token)],
  );
  const row = found.rows[0];
  if (!row) return { ok: false };
  await client.query("UPDATE control_plane.sign_in_links SET used_at = now() WHERE id = $1", [row.id]);
  if (!(await isMemberAccount(client, row.user_id))) return { ok: false };
  const claim = await liveGroupClaim(client, row.user_id);
  if ((claim?.linkId ?? null) !== row.telegram_link_id) return { ok: false };
  const credential = await client.query(
    `SELECT 1 FROM control_plane.password_credentials WHERE user_id = $1
     UNION ALL SELECT 1 FROM control_plane.web_password_credentials WHERE user_id = $1 LIMIT 1`, [row.user_id]);
  return { ok: true, linkId: row.id, userId: row.user_id, telegramLinkId: claim?.linkId ?? null, claimTripId: claim?.tripId ?? null, canSetPassword: !claim && (credential.rowCount ?? 0) > 0 };
}

/**
 * Gives a link back: its redemption was stopped by something that says nothing about the link or the person (the group switch is
 * off, Telegram could not be reached). The session minted for the check is ended by the caller; the link is live again for what is
 * left of its 30 minutes.
 */
export async function unspendLink(db: Queryable, linkId: string): Promise<void> {
  await db.query("UPDATE control_plane.sign_in_links SET used_at = NULL, session_id = NULL WHERE id = $1", [linkId]);
}

export async function attachSession(client: pg.PoolClient, linkId: string, sessionId: string): Promise<void> {
  await client.query("UPDATE control_plane.sign_in_links SET session_id = $2 WHERE id = $1", [linkId, sessionId]);
}

export type PasswordStepResult = "ok" | "not_offered" | "already_set" | "no_credential";

/**
 * The link's one password step, for the session its redemption minted. It REPLACES the credential(s) the account
 * already has (the email credential and/or the trip password the member signs in with) and creates none: an account with
 * nothing to replace is told so (`no_credential`). The account's other sessions end (a forgotten password is often a
 * lost or shared device); this one stays. The caller computes the hashes BEFORE the transaction, so no row lock is held
 * across scrypt.
 */
export async function applyLinkPassword(
  client: pg.PoolClient, input: { userId: string; sessionId: string; hashForEmailCredential: string; hashForTripCredential: string },
): Promise<PasswordStepResult> {
  const link = await client.query<{ id: string; password_set_at: Date | null }>(
    `SELECT id, password_set_at FROM control_plane.sign_in_links
      WHERE session_id = $1 AND user_id = $2 AND used_at > now() - interval '${SIGN_IN_LINK_PASSWORD_WINDOW}' FOR UPDATE`,
    [input.sessionId, input.userId],
  );
  const row = link.rows[0];
  if (!row) return "not_offered";
  if (row.password_set_at) return "already_set";
  const email = await client.query("UPDATE control_plane.password_credentials SET password_hash = $2, updated_at = now() WHERE user_id = $1", [input.userId, input.hashForEmailCredential]);
  const trip = await client.query("UPDATE control_plane.web_password_credentials SET password_hash = $2, updated_at = now() WHERE user_id = $1", [input.userId, input.hashForTripCredential]);
  if ((email.rowCount ?? 0) + (trip.rowCount ?? 0) === 0) return "no_credential";
  await client.query("UPDATE control_plane.sign_in_links SET password_set_at = now() WHERE id = $1", [row.id]);
  await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [input.userId, input.sessionId]);
  return "ok";
}
