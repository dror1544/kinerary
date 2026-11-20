/**
 * Telegram Mini App sign-in: who a verified Telegram person is here, and which
 * trip opens first.
 *
 * `telegram-webapp-auth.ts` answers "did Telegram sign this?". This module
 * answers everything after that, and is where the trust decisions live:
 *
 *   - A VERIFIED Telegram identity is a digest. It becomes a control-plane
 *     session only through a LINK that someone created earlier by proving
 *     something Telegram alone cannot: redeeming an interview link or the
 *     dashboard's one-time link for ONE trip (`telegram_organizer_trip_links`),
 *     or typing the trip's own password / redeeming a site invite while
 *     presenting fresh initData (`telegram_member_links`). Every link is scoped
 *     to a trip, so Unlinking one trip leaves the person's others as they were.
 *     Possessing a Telegram id proves you are that Telegram id; the link is the
 *     claim that you are also that user.
 *
 *   - The CHAT'S TRIP only SELECTS. `start_param`, the chooser's `tripId` and
 *     the person's DM binding name a trip; membership of a linked account grants
 *     it. A trip the person cannot open is answered exactly like one that does
 *     not exist, because a distinguishable refusal confirms a guess.
 *
 *   - Roles are an ALLOW-LIST (`ROLE_RANK`). A role the list does not name is
 *     excluded, never ranked last: a future `viewer` or `guest` must not become
 *     a session by falling through a comparison.
 *
 *   - GROUP SIGN-IN (docs/specs/sprint-9/x-member-sign-in.md, slice S1; switch
 *     `member_group_sign_in`, off unless set) is a second way to a link, and it
 *     obeys the same rules. Being live in the trip's Telegram group is not a
 *     credential on its own: it lets a person CHOOSE which unclaimed traveller
 *     they are (`claimTravellerInTx`), and what they get is a `member` link
 *     scoped to that one trip. `start_param` still only selects the trip; the
 *     grant comes from Telegram's own `getChatMember` answer about the chat the
 *     trip's OWN open binding names, which the person cannot choose. Anything
 *     uncertain (the switch, the binding count, Telegram, the site's participant
 *     list) is the restrictive answer, and a refusal is the same answer whether
 *     or not the trip exists, the group is bound or the person is in it. The
 *     group is asked again at EVERY later launch of a group-proved link.
 *
 * Nothing here logs an initData string, a hash, a Telegram id or the digest of
 * one, a chat id, or a claim id. A digest of a short numeric id is
 * brute-forceable, so it is an identifier in the same class as the id itself.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { digestTelegramId, isPrivateChatId, type TelegramName } from "./identity.js";
import { structuredLog } from "./redaction.js";
import { TELEGRAM_API_ROOT } from "./relay/telegram-api.js";
import type { GroupMembershipCheck } from "./telegram-group-membership.js";
import { endSecondaryBindingInTx } from "./secondary-organizers.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";
import type { VerifiedInitData } from "./telegram-webapp-auth.js";

// ── Policy constants ────────────────────────────────────────────────────────

/** Sessions one launch's initData may mint inside its freshness window (reloads). */
export const MINI_APP_SESSIONS_PER_LAUNCH = 3;
/** How old a launch may be for the "Next time, open with Telegram" link to be written. */
export const LINK_MAX_AUTH_AGE_SECONDS = 60;
/** The one role order. Anything not listed here is excluded from access entirely. */
export const ROLE_RANK: Readonly<Record<string, number>> = Object.freeze({ owner: 0, organizer: 1, member: 2 });
export const TRIP_ID_PATTERN = /^trip_[A-Za-z0-9]{8,64}$/;
const CHOOSER_LIMIT = 50;

/** What the portal gets from server.ts when the feature is configured. */
export interface TelegramMiniAppConfig {
  botToken: string;
  maxAgeSeconds: number;
  /** Evaluated per request: boot's getMe check may succeed later than the listener starts. */
  enabled: () => boolean;
}

// ── Boot: is this token really the bot the profile says it is? ──────────────

export type BotIdentityResult =
  | { ok: true; hasMainWebApp: boolean | null }
  | { ok: false; reason: "MISMATCH" | "UNREACHABLE" | "UNUSABLE" };

/**
 * `getMe` on the token the Mini App will verify against, compared to the bot
 * username the profile states. A token for another bot would verify every
 * launch of THAT bot's Mini Apps against our database; the check turns a
 * mis-wired secret into a feature that stays off, loudly, rather than one that
 * is on for the wrong audience.
 */
export async function checkBotIdentity(options: {
  token: string;
  expectedUsername: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<BotIdentityResult> {
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await doFetch(`${TELEGRAM_API_ROOT}/bot${options.token}/getMe`, { signal: controller.signal });
    if (!response.ok) {
      log(structuredLog("warn", "mini_app.bot_check_failed", { http_status: response.status }));
      return { ok: false, reason: "UNREACHABLE" };
    }
    const body = (await response.json()) as { ok?: boolean; result?: { username?: unknown; has_main_web_app?: unknown } };
    const username = body.ok && typeof body.result?.username === "string" ? body.result.username : null;
    if (!username) {
      log(structuredLog("warn", "mini_app.bot_check_unusable", {}));
      return { ok: false, reason: "UNUSABLE" };
    }
    const hasMainWebApp = typeof body.result?.has_main_web_app === "boolean" ? body.result.has_main_web_app : null;
    log(structuredLog("info", "mini_app.bot_checked", { has_main_web_app: hasMainWebApp }));
    if (username.toLowerCase() !== options.expectedUsername.replace(/^@/, "").toLowerCase()) {
      // Public handles only; the token is never part of this line.
      log(structuredLog("error", "mini_app.bot_token_mismatch", {
        configured_username: options.expectedUsername,
        getme_username: username,
        effect: "Telegram Mini App sign-in stays off",
      }));
      return { ok: false, reason: "MISMATCH" };
    }
    return { ok: true, hasMainWebApp };
  } catch (error) {
    // Not the error text: a fetch failure message can carry the URL, and the URL carries the token.
    log(structuredLog("warn", "mini_app.bot_check_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return { ok: false, reason: "UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }
}

// ── Replay accounting ───────────────────────────────────────────────────────

/** The replay bucket for a launch: a digest of the COMPUTED HMAC bytes. */
function replayDigest(replayKeyHex: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(replayKeyHex, "hex")).digest("hex")}`;
}

/**
 * Claims one of a launch's session slots. One statement, so two API processes
 * (or two pools) racing for the last slot cannot both get it: the conflicting
 * update takes the row lock, re-evaluates the cap against the committed count,
 * and returns no row when the cap is already met.
 *
 * Must run inside the transaction that mints the session, so a session that
 * fails to mint gives its slot back.
 */
export async function claimSessionSlot(
  client: pg.PoolClient,
  launch: VerifiedInitData,
  maxAgeSeconds: number,
  cap: number = MINI_APP_SESSIONS_PER_LAUNCH,
): Promise<boolean> {
  await client.query("DELETE FROM control_plane.telegram_mini_app_launches WHERE expires_at < now() - interval '10 minutes'");
  const result = await client.query(
    `INSERT INTO control_plane.telegram_mini_app_launches AS l (replay_digest, sessions_minted, expires_at)
     VALUES ($1, 1, to_timestamp($2))
     ON CONFLICT (replay_digest) DO UPDATE SET sessions_minted = l.sessions_minted + 1
       WHERE l.sessions_minted < $3
     RETURNING l.sessions_minted`,
    [replayDigest(launch.replayKey), launch.authDate + maxAgeSeconds + 60, cap],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Claims the launch's one-shot right to write a member link. */
async function claimLinkSlot(client: pg.PoolClient, launch: VerifiedInitData, maxAgeSeconds: number): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO control_plane.telegram_mini_app_launches AS l (replay_digest, sessions_minted, link_consumed_at, expires_at)
     VALUES ($1, 0, now(), to_timestamp($2))
     ON CONFLICT (replay_digest) DO UPDATE SET link_consumed_at = now()
       WHERE l.link_consumed_at IS NULL
     RETURNING l.replay_digest`,
    [replayDigest(launch.replayKey), launch.authDate + maxAgeSeconds + 60],
  );
  return (result.rowCount ?? 0) === 1;
}

// ── Resolution ──────────────────────────────────────────────────────────────

export type LinkKind = "organizer" | "member";

interface AccessRow {
  tripId: string;
  title: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  userId: string;
  userDisplayName: string;
  role: string;
  runtimeAccess: boolean;
  membershipCreatedAt: number;
  linkId: string;
  linkKind: LinkKind;
  /** How the link was proved; null for an organizer link. Decides whether the group is asked again. */
  verifiedVia: string | null;
}

export interface ChooserTrip {
  tripId: string;
  title: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface SessionTarget {
  userId: string;
  userDisplayName: string;
  linkId: string;
  linkKind: LinkKind;
  appPath: string;
  /** The trip the session opens on, when it opens on one (the notice names it). */
  tripId: string | null;
  tripTitle: string | null;
}

/** One unclaimed traveller as the claim screen sees them: a name and an id that says nothing about who they are. */
export interface ClaimableTraveller {
  /** `pick_<48 hex>`: an HMAC of (trip, username) under a server secret. Not the username, not guessable, not valid on another trip. */
  claimId: string;
  name: string;
}

export type MiniAppOutcome =
  | { kind: "session"; target: SessionTarget; notice?: "TRIP_UNAVAILABLE" }
  | { kind: "choose"; trips: ChooserTrip[]; notice?: "TRIP_UNAVAILABLE" }
  | { kind: "not_linked"; fallback: "trip_password" | "none"; tripId?: string }
  /** Group sign-in: the person is live in the trip's group and has no link yet. `travellers` may be empty. */
  | { kind: "claim"; tripId: string; travellers: ClaimableTraveller[] }
  /**
   * A group-proved link could not be re-checked (Telegram unreachable), or the site's participant list could not be
   * read for a person already proven to be in the group. No session, nothing revoked; the page may try again.
   */
  | { kind: "unavailable" };

function startParamTrip(startParam: string | null): string | null {
  return startParam && TRIP_ID_PATTERN.test(startParam) ? startParam : null;
}

function better(a: AccessRow, b: AccessRow): number {
  return ((ROLE_RANK[a.role] ?? Number.MAX_SAFE_INTEGER) - (ROLE_RANK[b.role] ?? Number.MAX_SAFE_INTEGER))
    || (Number(b.runtimeAccess) - Number(a.runtimeAccess))
    || (a.membershipCreatedAt - b.membershipCreatedAt)
    || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
    || (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);
}

async function loadAccess(client: pg.PoolClient, digest: string): Promise<{ linked: boolean; rows: AccessRow[] }> {
  const linked = await client.query<{ linked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM control_plane.telegram_organizer_trip_links l
         JOIN control_plane.users u ON u.id = l.user_id AND u.status = 'active'
        WHERE l.telegram_subject_digest = $1 AND l.revoked_at IS NULL
       UNION ALL
       SELECT 1 FROM control_plane.telegram_member_links m
         JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.telegram_subject_digest = $1 AND m.revoked_at IS NULL
     ) AS linked`,
    [digest],
  );
  if (!linked.rows[0]?.linked) return { linked: false, rows: [] };
  const result = await client.query<{
    trip_id: string; title: string; destination_label: string | null; start_date: string | null; end_date: string | null;
    user_id: string; display_name: string; role: string; runtime_access: boolean; membership_created_at: Date;
    link_id: string; link_kind: LinkKind; verified_via: string | null;
  }>(
    `WITH linked AS (
       SELECT l.id AS link_id, 'organizer'::text AS link_kind, l.user_id, l.trip_id AS only_trip, NULL::text AS verified_via
         FROM control_plane.telegram_organizer_trip_links l
        WHERE l.telegram_subject_digest = $1 AND l.revoked_at IS NULL
       UNION ALL
       SELECT m.id, 'member'::text, m.user_id, m.trip_id, m.verified_via
         FROM control_plane.telegram_member_links m
        WHERE m.telegram_subject_digest = $1 AND m.revoked_at IS NULL
     )
     SELECT t.id AS trip_id, COALESCE(t.title, t.destination_label, 'Untitled trip') AS title,
            t.destination_label, t.start_date::text AS start_date, t.end_date::text AS end_date,
            tm.user_id, u.display_name, tm.role, tm.runtime_access, tm.created_at AS membership_created_at,
            linked.link_id, linked.link_kind, linked.verified_via
       FROM linked
       JOIN control_plane.users u ON u.id = linked.user_id AND u.status = 'active'
       JOIN control_plane.trip_memberships tm
         ON tm.user_id = linked.user_id AND tm.status = 'active'
        AND (linked.only_trip IS NULL OR tm.trip_id = linked.only_trip)
       JOIN control_plane.trips t ON t.id = tm.trip_id
      WHERE (tm.runtime_access OR tm.dashboard_access)
        AND ${NOT_RETIRED_SQL}
        AND NOT EXISTS (
              SELECT 1 FROM control_plane.telegram_chat_bindings d
               WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')`,
    [digest],
  );
  const rows: AccessRow[] = [];
  for (const row of result.rows) {
    // The allow-list, enforced a second time in code: a role the SQL let through
    // that ROLE_RANK does not name is not access.
    if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, row.role)) continue;
    rows.push({
      tripId: row.trip_id, title: row.title, destination: row.destination_label,
      startDate: row.start_date, endDate: row.end_date, userId: row.user_id, userDisplayName: row.display_name,
      role: row.role, runtimeAccess: row.runtime_access, membershipCreatedAt: row.membership_created_at.getTime(),
      linkId: row.link_id, linkKind: row.link_kind, verifiedVia: row.verified_via,
    });
  }
  return { linked: true, rows };
}

// ── Group sign-in (slice S1 of docs/specs/sprint-9/x-member-sign-in.md) ──────

/** `telegram_member_links.verified_via` of a link a group claim wrote. The one value that makes a launch ask the group again. */
export const GROUP_VERIFIED_VIA = "mini_app_group_membership";
/** The `link_kind` of the payload of the outbox row that tells the organizers about a claim. */
export const GROUP_CLAIM_LINK_KIND = "group_claim";

/** One participant of the trip site, as the runtime adapter reports it. */
export interface SiteParticipant {
  username: string;
  displayName: string;
  role: string;
}

/** What the group path needs from the deployment. Absent, the path does not exist and every launch is today's. */
export interface GroupSignInDeps {
  /**
   * Is `member_group_sign_in` on for this trip? Asked on `db`, which is the launch's own connection (`switchIsOn`
   * wraps it in a savepoint): a second connection from the pool, held while this one waits, is how a burst of
   * launches would starve the pool. False on any doubt.
   */
  switchOn(db: Pick<pg.PoolClient, "query">, tripId: string): Promise<boolean>;
  /** Live membership of a group, from Telegram (telegram-group-membership.ts). */
  isActiveMember: GroupMembershipCheck;
  /** The trip site's participants (RuntimeAccountAdapter.listParticipants). May throw. */
  listParticipants(tripId: string): Promise<readonly SiteParticipant[]>;
  /** Secret behind the opaque claim ids. Server-side only; ids are an HMAC under it, so they cannot be derived from a name. */
  claimIdKey: Buffer;
  /** PER-REQUEST collector (the route passes a copy with a fresh array): claims a launch ended, to unbind on the site after commit. */
  released?: ReleasedClaim[];
}

/**
 * The switch, read inside the caller's transaction but never able to spoil it. `featureEnabled` never throws: a read
 * that fails (a function that is missing, a connection that died) is logged and answers off. But a failed statement
 * inside a transaction leaves the TRANSACTION aborted, and every later query on it would fail with it; the savepoint is
 * what turns "the switch could not be read" into one answer (off) instead of a 500 for the launch. Rolled back whether
 * the read worked or not: it wrote nothing.
 */
async function switchIsOn(client: pg.PoolClient, group: GroupSignInDeps, tripId: string): Promise<boolean> {
  await client.query("SAVEPOINT group_switch_read");
  try {
    return (await group.switchOn(client, tripId)) === true;
  } catch {
    return false;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT group_switch_read");
    await client.query("RELEASE SAVEPOINT group_switch_read");
  }
}

const USERNAME_SHAPE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const CLAIM_ID_SHAPE = /^pick_[0-9a-f]{48}$/;
const TRAVELLER_LIMIT = 200;

/** The id the claim screen shows for a traveller: stable per (trip, username), meaningless without the key. */
export function claimIdFor(key: Buffer, tripId: string, username: string): string {
  return `pick_${createHmac("sha256", key).update(`claim:v1\0${tripId}\0${username}`).digest("hex").slice(0, 48)}`;
}

/** Equal-time comparison of two claim ids of the same shape; anything else is simply not equal. */
function sameClaimId(a: string, b: string): boolean {
  if (!CLAIM_ID_SHAPE.test(a) || !CLAIM_ID_SHAPE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The chat the trip's own binding names — and ONLY if there is exactly one open group binding on a live trip. Two
 * would not say which group is "the" group; none means no group to ask; a retired or destroyed trip has none. The
 * caller treats null as "no", which is the answer for every one of those, so nothing tells them apart.
 */
export async function openGroupChat(client: Pick<pg.PoolClient, "query">, tripId: string): Promise<string | null> {
  const result = await client.query<{ chat_id: string }>(
    `SELECT b.chat_id
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trips t ON t.id = b.trip_id
      WHERE b.trip_id = $1 AND b.closed_at IS NULL AND b.chat_id ~ '^-[0-9]{1,20}$'
        AND ${NOT_RETIRED_SQL}
        AND NOT EXISTS (
              SELECT 1 FROM control_plane.telegram_chat_bindings d
               WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')`,
    [tripId],
  );
  return result.rows.length === 1 ? result.rows[0]!.chat_id : null;
}

interface Candidate { username: string; displayName: string; claimId: string }

/**
 * The trip site's plain `member`s, each with its claim id. THE ROLE ALLOW-LIST: a participant is a candidate only if
 * the site says `member` AND `member` is a name `ROLE_RANK` holds. A missing role, another case ("Member"), an unknown
 * one ("viewer", "guest") or an inherited property name ("constructor") is not a candidate: fail safe, never
 * "not an organizer, therefore a member". Returns null when the site cannot be read.
 */
async function siteCandidates(group: GroupSignInDeps, tripId: string): Promise<Candidate[] | null> {
  let people: readonly SiteParticipant[];
  try { people = await group.listParticipants(tripId); } catch { return null; }
  if (!Array.isArray(people)) return null;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const person of people) {
    if (!person || typeof person !== "object") continue;
    const { username, displayName, role } = person as Partial<SiteParticipant>;
    if (typeof username !== "string" || !USERNAME_SHAPE.test(username) || seen.has(username)) continue;
    if (typeof role !== "string" || role !== "member" || !Object.prototype.hasOwnProperty.call(ROLE_RANK, role)) continue;
    const name = typeof displayName === "string" ? cleanDisplayText(displayName, 120) : null;
    if (!name) continue;
    seen.add(username);
    out.push({ username, displayName: name, claimId: claimIdFor(group.claimIdKey, tripId, username) });
  }
  return out;
}

/** Display text from outside (a site's participant name, a Telegram first name): no control or bidi-override characters, one line, bounded. */
function cleanDisplayText(value: string, max: number): string | null {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * Who on this trip is spoken for in the control plane: `held` (a live claim, a redeemed invite or a trip password maps
 * the traveller to an account) and `organizerSide` (the account holding it is an owner or organizer here). Both by
 * username, read in the transaction's own snapshot.
 */
async function spokenFor(client: pg.PoolClient, tripId: string): Promise<{ held: Set<string>; organizerSide: Set<string> }> {
  const result = await client.query<{ runtime_username: string; organizer_side: boolean }>(
    `WITH mapped AS (
       SELECT cl.runtime_username, cl.user_id FROM control_plane.trip_participant_claims cl
        WHERE cl.trip_id = $1 AND cl.released_at IS NULL
       UNION ALL
       SELECT i.runtime_username, i.redeemed_by FROM control_plane.site_invites i
        WHERE i.trip_id = $1 AND i.state = 'redeemed'
       UNION ALL
       SELECT c.runtime_username, c.user_id FROM control_plane.web_password_credentials c
         JOIN control_plane.users u ON u.id = c.user_id AND u.status = 'active'
        WHERE c.trip_id = $1
     )
     SELECT mapped.runtime_username,
            EXISTS (SELECT 1 FROM control_plane.trip_memberships tm
                     WHERE tm.trip_id = $1 AND tm.user_id = mapped.user_id AND tm.status = 'active'
                       AND tm.role IN ('owner', 'organizer')) AS organizer_side
       FROM mapped`,
    [tripId],
  );
  const held = new Set<string>(), organizerSide = new Set<string>();
  for (const row of result.rows) {
    held.add(row.runtime_username);
    if (row.organizer_side) organizerSide.add(row.runtime_username);
  }
  return { held, organizerSide };
}

/**
 * The person is proven to be in the trip's group and has no link: the names they may pick from. Null is "this path
 * says nothing" (the caller answers as it always did): switch off or unreadable, no single open group, or the person
 * is not clearly in it. `unavailable` is only for someone ALREADY PROVEN in the group whose list cannot be drawn.
 */
async function offerClaim(client: pg.PoolClient, launch: VerifiedInitData, tripId: string, group: GroupSignInDeps): Promise<MiniAppOutcome | null> {
  if (!(await switchIsOn(client, group, tripId))) return null;
  const chat = await openGroupChat(client, tripId);
  if (!chat) return null;
  if ((await group.isActiveMember(chat, launch.telegramUserId)) !== true) return null;
  const candidates = await siteCandidates(group, tripId);
  if (!candidates) return { kind: "unavailable" };
  const { held, organizerSide } = await spokenFor(client, tripId);
  const travellers = candidates
    .filter((c) => !held.has(c.username) && !organizerSide.has(c.username))
    .map(({ claimId, displayName }) => ({ claimId, name: displayName }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.claimId < b.claimId ? -1 : 1))
    .slice(0, TRAVELLER_LIMIT);
  return { kind: "claim", tripId, travellers };
}

type GroupLinkVerdict = "in" | "out" | "unreachable" | "dormant";

/**
 * AC-6: a link a group claim wrote is only as good as the person's seat in the group, so each launch asks again.
 *   in          keep it.
 *   out         the person left (or was removed): the link, its claim, its sessions and its membership end HERE, in the
 *               launch's transaction, and the row is dropped from this launch.
 *   unreachable Telegram did not give a clear answer: the row is dropped from this launch (no session) and NOTHING is
 *               revoked; a Telegram outage must neither sign someone in nor throw them out.
 *   dormant     the switch is off, the group is no longer exactly one, or the path is not wired: the row is dropped
 *               without a call and without revoking. Switching the feature off closes the door; switching it back on
 *               opens it for the same links.
 */
async function groupLinkVerdict(client: pg.PoolClient, launch: VerifiedInitData, row: AccessRow, group: GroupSignInDeps | undefined): Promise<GroupLinkVerdict> {
  if (!group || !(await switchIsOn(client, group, row.tripId))) return "dormant";
  const chat = await openGroupChat(client, row.tripId);
  if (!chat) return "dormant";
  const member = await group.isActiveMember(chat, launch.telegramUserId);
  if (member === true) return "in";
  if (member === "unknown") return "unreachable";
  const ended = await endGroupClaimInTx(client, { tripId: row.tripId, userId: row.userId, linkReason: "left_group", claimReason: "left_group" });
  group.released?.push(...ended);
  return "out";
}

async function enforceGroupLinks(
  client: pg.PoolClient, launch: VerifiedInitData, rows: AccessRow[], group: GroupSignInDeps | undefined,
): Promise<{ rows: AccessRow[]; unreachable: Set<string> }> {
  const kept: AccessRow[] = [];
  const unreachable = new Set<string>();
  const verdicts = new Map<string, GroupLinkVerdict>();
  for (const row of rows) {
    if (!(row.linkKind === "member" && row.verifiedVia === GROUP_VERIFIED_VIA)) { kept.push(row); continue; }
    let verdict = verdicts.get(row.tripId);
    if (!verdict) { verdict = await groupLinkVerdict(client, launch, row, group); verdicts.set(row.tripId, verdict); }
    if (verdict === "in") kept.push(row);
    else if (verdict === "unreachable") unreachable.add(row.tripId);
  }
  return { rows: kept, unreachable };
}

/**
 * Decides what a verified Telegram launch gets. Pure over the database state in
 * `client`'s transaction, with ONE exception: a group-proved link whose person
 * has left the group is ended here (`enforceGroupLinks`), in that transaction,
 * so the launch that finds out is the launch that closes it. Mints nothing.
 *
 * `requestedTripId` is the chooser follow-up's trip (already pattern-checked by
 * the route). It selects within the person's accessible set and can never
 * widen it.
 *
 * `group` is the deployment's group sign-in wiring. Absent, nothing about it
 * exists: the outcome is what it was before the feature.
 */
export async function resolveMiniAppLaunch(
  client: pg.PoolClient,
  launch: VerifiedInitData,
  requestedTripId: string | null,
  group?: GroupSignInDeps,
): Promise<MiniAppOutcome> {
  const digest = digestTelegramId(launch.telegramUserId);
  const loaded = await loadAccess(client, digest);
  const { linked } = loaded;
  const signedTrip = startParamTrip(launch.startParam);
  const requested = requestedTripId ?? signedTrip;
  const checked = linked ? await enforceGroupLinks(client, launch, loaded.rows, group) : { rows: [] as AccessRow[], unreachable: new Set<string>() };
  const rows = checked.rows;

  if (!linked || rows.length === 0) {
    if (requested && checked.unreachable.has(requested)) return { kind: "unavailable" };
    // A person with nothing yet, who named a trip: the group may let them pick a name. Anything else is the one answer
    // that depends on nothing about the trip: not on its existence, nor on the person's links elsewhere.
    if (requested && group) {
      const offer = await offerClaim(client, launch, requested, group);
      if (offer) return offer;
    }
    if (checked.unreachable.size > 0) return { kind: "unavailable" };
    return requested
      ? { kind: "not_linked", fallback: "trip_password", tripId: requested }
      : { kind: "not_linked", fallback: "none" };
  }

  // The DM binding is a hint of last resort: only when Telegram signed no
  // start_param and the launch is from the person's own chat.
  let context = requested;
  if (!context && launch.startParam === null && (launch.chatType === null || launch.chatType === "sender")) {
    const bound = await client.query<{ trip_id: string }>(
      "SELECT trip_id FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL LIMIT 1",
      [launch.telegramUserId],
    );
    context = bound.rows[0]?.trip_id ?? null;
  }

  let notice: "TRIP_UNAVAILABLE" | undefined;
  if (context) {
    const candidates = rows.filter((row) => row.tripId === context).sort(better);
    if (candidates[0]) return { kind: "session", target: targetOf(candidates[0], `/mini-app/trips/${context}`) };
    // Not a trip this person can open. Whether it exists, was retired, belongs
    // to somebody else or never did, they are told the same thing, and only
    // when they named it.
    if (requested) {
      // ...unless it is a trip whose group link we could not re-check (try again, do not pretend it is somebody else's)
      // or one whose group they are in (they may pick a name).
      if (checked.unreachable.has(requested)) return { kind: "unavailable" };
      if (group) {
        const offer = await offerClaim(client, launch, requested, group);
        if (offer) return offer;
      }
      notice = "TRIP_UNAVAILABLE";
    }
  }

  const bestPerTrip = new Map<string, AccessRow>();
  for (const row of [...rows].sort(better)) if (!bestPerTrip.has(row.tripId)) bestPerTrip.set(row.tripId, row);
  const best = [...bestPerTrip.values()];
  const first = [...best].sort(better)[0];
  if (!first) return { kind: "not_linked", fallback: "none" };
  if (best.length === 1) {
    return { kind: "session", target: targetOf(first, `/mini-app/trips/${first.tripId}`), ...(notice ? { notice } : {}) };
  }
  const users = new Set(best.map((row) => row.userId));
  if (users.size === 1) {
    return { kind: "session", target: targetOf(first, "/mini-app"), ...(notice ? { notice } : {}) };
  }
  const trips = [...best]
    .sort((a, b) => b.membershipCreatedAt - a.membershipCreatedAt || (a.tripId < b.tripId ? -1 : 1))
    .slice(0, CHOOSER_LIMIT)
    .map(({ tripId, title, destination, startDate, endDate }) => ({ tripId, title, destination, startDate, endDate }));
  return { kind: "choose", trips, ...(notice ? { notice } : {}) };
}

function targetOf(row: AccessRow, appPath: string): SessionTarget {
  const onTrip = appPath !== "/mini-app";
  return {
    userId: row.userId, userDisplayName: row.userDisplayName, linkId: row.linkId, linkKind: row.linkKind, appPath,
    tripId: onTrip ? row.tripId : null, tripTitle: onTrip ? row.title : null,
  };
}

// ── Link bookkeeping and the first-use notice ───────────────────────────────

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

const LINK_TABLE: Record<LinkKind, string> = {
  organizer: "control_plane.telegram_organizer_trip_links",
  member: "control_plane.telegram_member_links",
};

/**
 * Records a sign-in through a link and reports whether it was the FIRST.
 * Locks the link row, so an Unlink racing this either lands first (and the
 * sign-in is refused: `null`) or waits until the sign-in has committed (and
 * then revokes the session it minted via `web_sessions.telegram_link_id`).
 */
export async function recordLinkSignIn(
  client: pg.PoolClient, kind: LinkKind, linkId: string,
  /** From the signature-checked initData (VerifiedInitData.name); display data only. Fills a link that has none. */
  telegramName: TelegramName | null = null,
): Promise<{ first: boolean } | null> {
  const table = LINK_TABLE[kind];
  const row = await client.query<{ first_signed_in_at: Date | null }>(
    // Both kinds are revoked in place (`revoked_at`); a revoked link signs nobody in.
    `SELECT first_signed_in_at FROM ${table} WHERE id = $1 AND revoked_at IS NULL FOR UPDATE`,
    [linkId],
  );
  if (!row.rows[0]) return null;
  await client.query(
    `UPDATE ${table} SET last_signed_in_at = now(), first_signed_in_at = COALESCE(first_signed_in_at, now()),
            telegram_first_name = COALESCE(telegram_first_name, $2), telegram_username = COALESCE(telegram_username, $3) WHERE id = $1`,
    [linkId, telegramName?.firstName ?? null, telegramName?.username ?? null],
  );
  return { first: row.rows[0].first_signed_in_at === null };
}

/**
 * The "a Telegram account just signed in as you" notice, as rows in the outbox
 * in the same transaction as the session. Sent by the ordinary outbox
 * dispatcher (outbox-dispatcher.ts), never inline: a Telegram outage must not
 * delay or fail a sign-in, and a rolled-back sign-in must not announce itself.
 *
 * WHO GETS IT: every private bot chat the account owner has, INCLUDING the one
 * that signed in (owner decision 2026-10-20). The first version skipped the
 * signer's chat on the reasoning that a forwardee's own notice warns nobody —
 * true, and it cost the common case: an organizer's own phone is usually their
 * only chat, so the notice they were promised never arrived. Sending to every
 * chat is also the simpler rule, and a forwardee reading "someone signed in as
 * you" learns nothing they were not just shown.
 *
 * The chats are the open, private (positive-id) bindings of the trips the
 * account is owner or organizer of, plus the signing Telegram account's own
 * private chat (a Mini App launch is by definition from a person who can be
 * messaged by the bot; the id is Telegram-verified, never a body field). The
 * count is returned so the caller can log it, quietly.
 *
 * One row per chat, trip_id NULL, its own notification type. The raw Telegram
 * chat id in `recipient` is nulled by the dispatcher once the row is sent or
 * has failed for good, so it does not stay at rest.
 */
export async function enqueueSignInNotice(
  client: pg.PoolClient,
  input: {
    signerTelegramId: string;
    userId: string;
    accountName: string;
    linkKind: LinkKind;
    tripTitle: string | null;
    now?: Date;
  },
): Promise<number> {
  const bound = await client.query<{ chat_id: string }>(
    `SELECT DISTINCT b.chat_id
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trip_memberships m
         ON m.trip_id = b.trip_id AND m.user_id = $1 AND m.status = 'active' AND m.role IN ('owner', 'organizer')
       JOIN control_plane.trips t ON t.id = b.trip_id
      WHERE b.closed_at IS NULL
        AND b.chat_id ~ '^[0-9]{1,20}$'
        AND ${NOT_RETIRED_SQL}`,
    [input.userId],
  );
  const chats = new Set(bound.rows.map((row) => row.chat_id));
  if (isPrivateChatId(input.signerTelegramId)) chats.add(input.signerTelegramId);
  const payload = JSON.stringify({
    account_name: input.accountName, link_kind: input.linkKind, trip_title: input.tripTitle,
    at: (input.now ?? new Date()).toISOString(),
  });
  for (const chatId of chats) {
    await client.query(
      `INSERT INTO control_plane.notification_outbox
         (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
       VALUES ($1, NULL, 'mini_app_sign_in_notice', $2, $3::jsonb, NULL, 'mini_app_sign_in_notice', 'control-plane', 'pending')`,
      [opaqueId("notif"), chatId, payload],
    );
  }
  return chats.size;
}

export const SIGN_IN_NOTICE_TYPE = "mini_app_sign_in_notice";

export function signInNoticeText(
  input: { accountName: string; linkKind: LinkKind; tripTitle: string | null; at: string | null },
  publicOrigin: string | null,
): string {
  // Without a configured origin the link is dropped, not the notice.
  const where = publicOrigin ? `${publicOrigin}/trips` : "Kinerary";
  const when = input.at && !Number.isNaN(Date.parse(input.at)) ? `${new Date(input.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "just now";
  const trip = input.tripTitle ? `"${input.tripTitle}"` : null;
  const en = input.linkKind === "member" && trip
    ? `A Telegram account was just linked to "${input.accountName}" and can now open ${trip} in Kinerary's Mini App without a password (${when}).`
    : `A Telegram account just signed in to Kinerary's Mini App as "${input.accountName}"${trip ? ` and opened ${trip}` : ""} (${when}). ${trip ? "It is linked to that trip" : "It is linked to your trips"} and needs no password.`;
  const he = input.linkKind === "member" && trip
    ? `חשבון טלגרם חובר ל-"${input.accountName}" ויכול מעכשיו לפתוח את ${trip} באפליקציית ה-Mini App של Kinerary בלי סיסמה (${when}).`
    : `חשבון טלגרם נכנס עכשיו לאפליקציית ה-Mini App של Kinerary בתור "${input.accountName}"${trip ? ` ופתח את ${trip}` : ""} (${when}). ${trip ? "הוא מקושר לטיול הזה" : "הוא מקושר לטיולים שלכם"} ואינו צריך סיסמה.`;
  return [
    en,
    `If that was not you or someone you trust: open ${where}, find the trip, open its Telegram menu (the three dots) and choose Unlink.`,
    "",
    he,
    `אם זה לא אתם או מישהו שאתם סומכים עליו: היכנסו אל ${where}, מצאו את הטיול, פתחו את תפריט הטלגרם שלו (שלוש הנקודות) ובחרו Unlink.`,
  ].join("\n");
}

// ── Phase 2: linking a member ───────────────────────────────────────────────

/**
 * Links this Telegram account to `userId` for ONE trip. Called inside the
 * transaction of a successful trip-password sign-in or invite redemption, and
 * nowhere else. The preconditions are all here, so the callers cannot forget one:
 *
 *   - the initData is fresh (`LINK_MAX_AUTH_AGE_SECONDS`), checked here against
 *     the already-verified auth_date;
 *   - the launch has not already written a link (one per launch, so a replayed
 *     or re-sent initData writes nothing);
 *   - the user is an active member of the trip with runtime access.
 *
 * Returns "linked" or "skipped"; a skip never fails the sign-in it rode on.
 */
export async function linkMemberInTx(
  client: pg.PoolClient,
  input: {
    launch: VerifiedInitData;
    maxAgeSeconds: number;
    nowMs?: number;
    userId: string;
    tripId: string;
    accountName: string;
    via: "mini_app_trip_password" | "mini_app_invite_redemption";
  },
): Promise<"linked" | "skipped"> {
  const nowMs = input.nowMs ?? Date.now();
  const age = nowMs / 1000 - input.launch.authDate;
  if (age > LINK_MAX_AUTH_AGE_SECONDS || age < -LINK_MAX_AUTH_AGE_SECONDS) return "skipped";
  const member = await client.query(
    `SELECT 1 FROM control_plane.trip_memberships
      WHERE trip_id = $1 AND user_id = $2 AND status = 'active' AND runtime_access = true`,
    [input.tripId, input.userId],
  );
  if (!member.rowCount) return "skipped";
  if (!(await claimLinkSlot(client, input.launch, input.maxAgeSeconds))) return "skipped";
  // Has this Telegram account ever been linked to this person on this trip
  // (revoked rows count)? Then re-linking is not news: no second notice.
  const before = await client.query(
    `SELECT 1 FROM control_plane.telegram_member_links
      WHERE telegram_subject_digest = $1 AND user_id = $2 AND trip_id = $3 LIMIT 1`,
    [digestTelegramId(input.launch.telegramUserId), input.userId, input.tripId],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO control_plane.telegram_member_links
       (id, user_id, trip_id, telegram_subject_digest, verified_via, first_signed_in_at, last_signed_in_at, telegram_first_name, telegram_username)
     VALUES ($1, $2, $3, $4, $5, now(), now(), $6, $7)
     ON CONFLICT (telegram_subject_digest, user_id, trip_id) WHERE revoked_at IS NULL DO NOTHING
     RETURNING id`,
    [opaqueId("tml"), input.userId, input.tripId, digestTelegramId(input.launch.telegramUserId), input.via, input.launch.name?.firstName ?? null, input.launch.name?.username ?? null],
  );
  if (inserted.rowCount && !before.rowCount) {
    const trip = await client.query<{ title: string }>(
      "SELECT COALESCE(title, destination_label, 'Untitled trip') AS title FROM control_plane.trips WHERE id = $1", [input.tripId]);
    await enqueueSignInNotice(client, {
      signerTelegramId: input.launch.telegramUserId, userId: input.userId, accountName: input.accountName,
      linkKind: "member", tripTitle: trip.rows[0]?.title ?? null,
    });
  }
  return "linked";
}

/**
 * `linkMemberInTx` that cannot take the sign-in down with it. The link is a
 * convenience riding on a credential that already verified; a database error
 * while writing it must cost the link, not the person's login. A savepoint is
 * what makes that possible inside the sign-in's own transaction.
 */
export async function linkMemberOrSkip(
  client: pg.PoolClient,
  input: Parameters<typeof linkMemberInTx>[1],
  log: (line: string) => void = () => {},
): Promise<"linked" | "skipped"> {
  await client.query("SAVEPOINT telegram_member_link");
  try {
    const outcome = await linkMemberInTx(client, input);
    await client.query("RELEASE SAVEPOINT telegram_member_link");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT telegram_member_link");
    log(structuredLog("error", "mini_app.link_failed", { safe_error_code: (error as { code?: string } | null)?.code ?? "UNKNOWN" }));
    return "skipped";
  }
}

// ── Group sign-in: the claim, the notice, and ending a claim ─────────────────

export type ClaimResult =
  | { kind: "claimed"; target: SessionTarget; runtimeUsername: string }
  /** The trip site cannot be asked who is on the trip: nothing is known, so nothing is written; retryable. */
  | { kind: "unavailable" }
  /** Every way of being refused that must look the same: switch off, no single group, not in it, no such traveller, a stale race. */
  | { kind: "refused" }
  | { kind: "already_claimed" }
  /** The initData is older than `LINK_MAX_AUTH_AGE_SECONDS`. Signed, so saying so confirms nothing. */
  | { kind: "stale" };

/**
 * AC-5, one transaction (the caller's): re-check the group live, re-check that the traveller is free (the trip row is
 * locked `FOR UPDATE`, so two claims of one traveller meet here one after the other, and the second reads the first's
 * committed row), then write the account, its member membership, the claim and the link. The caller mints the scoped
 * session and commits; on anything but `claimed` it ROLLS BACK, so a refused claim leaves nothing behind.
 *
 * What a claim can ever be: a `member`, `dashboard_access = false`, `runtime_access = true`, for ONE trip. Nothing in
 * the site's participant record reaches the role: a traveller is a candidate only when the site says `member`
 * (`siteCandidates`), and the INSERT below names `member` literally.
 *
 * The order is the information a refusal gives away: stale first (it needs a valid signature, so it tells nobody
 * anything), then the switch, the binding and Telegram (all of which a stranger fails identically), and only for a
 * person proven to be in the group do the traveller's state (`already_claimed`) and a bad id (`refused`) differ.
 */
export async function claimTravellerInTx(
  client: pg.PoolClient,
  input: {
    launch: VerifiedInitData;
    maxAgeSeconds: number;
    nowMs?: number;
    tripId: string;
    claimId: string;
    group: GroupSignInDeps;
    log?: (line: string) => void;
  },
): Promise<ClaimResult> {
  const { launch, group, tripId } = input;
  const age = (input.nowMs ?? Date.now()) / 1000 - launch.authDate;
  if (age > LINK_MAX_AUTH_AGE_SECONDS || age < -LINK_MAX_AUTH_AGE_SECONDS) return { kind: "stale" };
  if (!(await switchIsOn(client, group, tripId))) return { kind: "refused" };
  const chat = await openGroupChat(client, tripId);
  if (!chat) return { kind: "refused" };
  // Not "unknown" either: a person mid-claim whose Telegram check wobbles is refused like a stranger, and tries again.
  if ((await group.isActiveMember(chat, launch.telegramUserId)) !== true) return { kind: "refused" };
  const candidates = await siteCandidates(group, tripId);
  if (!candidates) return { kind: "unavailable" };
  // No early exit: how long the comparison takes does not say how far down the list a guess matched.
  let picked: Candidate | undefined;
  for (const candidate of candidates) if (sameClaimId(candidate.claimId, input.claimId)) picked = candidate;
  if (!picked) return { kind: "refused" };

  // From here the rows are locked. The trip row is the lock: every claim on the trip passes through it.
  const locked = await client.query("SELECT 1 FROM control_plane.trips t WHERE t.id = $1 AND " + NOT_RETIRED_SQL + " FOR UPDATE OF t", [tripId]);
  if (!locked.rowCount) return { kind: "refused" };
  const { held, organizerSide } = await spokenFor(client, tripId);
  if (organizerSide.has(picked.username)) return { kind: "refused" };
  if (held.has(picked.username)) return { kind: "already_claimed" };
  const digest = digestTelegramId(launch.telegramUserId);
  // One Telegram account, one traveller per trip: a parent claiming the children's names is what the personal invite is for.
  const holds = await client.query(
    `SELECT 1 FROM control_plane.telegram_member_links WHERE telegram_subject_digest = $1 AND trip_id = $2 AND revoked_at IS NULL
     UNION ALL
     SELECT 1 FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1 AND trip_id = $2 AND revoked_at IS NULL`,
    [digest, tripId],
  );
  if (holds.rowCount) return { kind: "already_claimed" };
  // One link-writing action per launch, as linkMemberInTx has: a replayed initData writes nothing a second time.
  if (!(await claimLinkSlot(client, launch, input.maxAgeSeconds))) return { kind: "refused" };

  const userId = opaqueId("user");
  await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, picked.displayName]);
  await client.query(
    `INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access)
     VALUES ($1, $2, $3, 'member', 'active', false, true)`,
    [opaqueId("memb"), tripId, userId],
  );
  try {
    await client.query(
      `INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id, last_group_check_at)
       VALUES ($1, $2, $3, $4, 'group_membership', $5, now())`,
      [opaqueId("tpc"), tripId, userId, picked.username, launch.telegramUserId],
    );
  } catch (error) {
    // The partial unique index is the last word: the check above is not the only thing keeping one traveller to one person.
    if ((error as { code?: string } | null)?.code === "23505") return { kind: "already_claimed" };
    throw error;
  }
  const linkId = opaqueId("tml");
  await client.query(
    `INSERT INTO control_plane.telegram_member_links
       (id, user_id, trip_id, telegram_subject_digest, verified_via, first_signed_in_at, last_signed_in_at, telegram_first_name, telegram_username)
     VALUES ($1, $2, $3, $4, $5, now(), now(), $6, $7)`,
    [linkId, userId, tripId, digest, GROUP_VERIFIED_VIA, launch.name?.firstName ?? null, launch.name?.username ?? null],
  );
  const trip = await client.query<{ title: string; language: string | null }>(
    `SELECT COALESCE(title, destination_label, 'Untitled trip') AS title, companion_intro ->> 'language' AS language
       FROM control_plane.trips WHERE id = $1`,
    [tripId],
  );
  const tripTitle = trip.rows[0]?.title ?? null;
  const noticed = await enqueueGroupClaimNotice(client, {
    tripId, travellerName: picked.displayName, telegramFirstName: launch.name?.firstName ?? null,
    tripTitle, language: trip.rows[0]?.language === "he" ? "he" : "en",
  });
  void noticed;
  return {
    kind: "claimed",
    runtimeUsername: picked.username,
    target: { userId, userDisplayName: picked.displayName, linkId, linkKind: "member", appPath: `/mini-app/trips/${tripId}`, tripId, tripTitle },
  };
}

/**
 * AC-7's notice: "<Telegram first name> signed in as <traveller> from the trip group", in the trip's language, to the
 * organizers' own Telegram chats: the trip's open PRIVATE bindings (the organizers' direct chats with the bot), never
 * the group (it is the audience that just took a name) and never the claimer's own chat. One outbox row per chat, the
 * same `mini_app_sign_in_notice` rows `enqueueSignInNotice` writes (so the same dispatcher sends them and nulls the raw
 * chat id once sent), told apart by `payload.link_kind = 'group_claim'`. Sent after commit by the ordinary outbox
 * dispatcher: a Telegram outage must not delay or fail a claim, and a rolled-back claim must not announce itself.
 */
async function enqueueGroupClaimNotice(
  client: pg.PoolClient,
  input: { tripId: string; travellerName: string; telegramFirstName: string | null; tripTitle: string | null; language: "he" | "en" },
): Promise<number> {
  const bound = await client.query<{ chat_id: string }>(
    `SELECT DISTINCT b.chat_id FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trips t ON t.id = b.trip_id
      WHERE b.trip_id = $1 AND b.closed_at IS NULL AND b.chat_id ~ '^[0-9]{1,20}$' AND ${NOT_RETIRED_SQL}`,
    [input.tripId],
  );
  const payload = JSON.stringify({
    link_kind: GROUP_CLAIM_LINK_KIND, traveller_name: input.travellerName,
    telegram_first_name: input.telegramFirstName ? cleanDisplayText(input.telegramFirstName, 64) : null,
    trip_title: input.tripTitle, language: input.language, at: new Date().toISOString(),
  });
  for (const row of bound.rows) {
    await client.query(
      `INSERT INTO control_plane.notification_outbox
         (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
       VALUES ($1, NULL, 'mini_app_sign_in_notice', $2, $3::jsonb, NULL, 'mini_app_sign_in_notice', 'control-plane', 'pending')`,
      [opaqueId("notif"), row.chat_id, payload],
    );
  }
  return bound.rows.length;
}

/** The words of a group-claim notice, from its outbox payload. One language, the trip's: Hebrew for "he", English otherwise. */
export function groupClaimNoticeText(payload: Record<string, unknown> | null): string {
  const text = (key: string) => (typeof payload?.[key] === "string" && (payload[key] as string).trim() ? (payload[key] as string) : null);
  const traveller = text("traveller_name") ?? "a traveller";
  const first = text("telegram_first_name");
  const trip = text("trip_title");
  if (text("language") === "he") {
    return [
      `${first ?? "מישהו"} נכנס/ה בתור ${traveller} מקבוצת הטיול${trip ? ` (${trip})` : ""}.`,
      "אם זה לא נכון, אפשר לשחרר את הכניסה בהגדרות המארגן של הטיול, תחת \"כניסה\".",
    ].join("\n");
  }
  return [
    `${first ?? "Someone"} signed in as ${traveller} from the trip group${trip ? ` (${trip})` : ""}.`,
    "If that is not right, release it in the trip's Organizer settings, under Signing in.",
  ].join("\n");
}

/**
 * Ends a group claim in the caller's transaction: the person's links for the trip (revoked in place, with
 * `linkReason`), the sessions those links minted, the claim (released, with `claimReason`, so the traveller can be
 * claimed again), any unspent launch grant, the membership the claim created, and — because that account was made for
 * this one trip and holds nothing else — every other session it has. Shared by the three ways a claim ends that this
 * code starts (the person left the group, an organizer's Release, the person's own Unlink); a fourth, the membership
 * ending by itself, is the database trigger of migration 20261119120000, which finds nothing left to do here.
 */
export async function endGroupClaimInTx(
  client: pg.PoolClient,
  input: {
    tripId: string;
    userId: string;
    linkReason: "left_group" | "claim_released" | "owner_unlinked";
    claimReason: "left_group" | "organizer_released" | "unlinked";
  },
): Promise<ReleasedClaim[]> {
  const links = await client.query<{ id: string }>(
    `UPDATE control_plane.telegram_member_links SET revoked_at = now(), revoked_reason = $3
      WHERE trip_id = $1 AND user_id = $2 AND verified_via = $4 AND revoked_at IS NULL
      RETURNING id`,
    [input.tripId, input.userId, input.linkReason, GROUP_VERIFIED_VIA],
  );
  if (links.rowCount) {
    await client.query(
      "UPDATE control_plane.web_sessions SET revoked_at = now() WHERE telegram_link_id = ANY($1::text[]) AND revoked_at IS NULL",
      [links.rows.map((row) => row.id)],
    );
  }
  const released = await client.query<{ runtime_username: string }>(
    `UPDATE control_plane.trip_participant_claims SET released_at = now(), released_reason = $3, telegram_user_id = NULL
      WHERE trip_id = $1 AND user_id = $2 AND released_at IS NULL
      RETURNING runtime_username`,
    [input.tripId, input.userId, input.claimReason],
  );
  await client.query(
    "UPDATE control_plane.runtime_launch_grants SET consumed_at = now() WHERE trip_id = $1 AND user_id = $2 AND consumed_at IS NULL",
    [input.tripId, input.userId],
  );
  await client.query(
    "UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2 AND status = 'active'",
    [input.tripId, input.userId],
  );
  await client.query(
    `UPDATE control_plane.web_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM control_plane.trip_memberships m WHERE m.user_id = $1 AND m.status = 'active')`,
    [input.userId],
  );
  return released.rows.map((row) => ({ tripId: input.tripId, userId: input.userId, runtimeUsername: row.runtime_username, reason: input.claimReason }));
}

/**
 * A claim that just ended in a transaction, for the caller to end the trip site's binding of that traveller once the
 * transaction has COMMITTED (never before: a rolled-back release must not unbind anyone). Best effort by design; see the
 * header of `releaseSiteBindings` in portal.ts for why a release that does not arrive costs nothing.
 */
export interface ReleasedClaim { tripId: string; userId: string; runtimeUsername: string; /** why it ended, for the audit line */ reason?: string }

// ── The owner's view: the trip card's Telegram status, and Unlink ───────────

export type LinkVia = "interview_link" | "earlier_interview" | "dashboard_link" | "dashboard_restore" | "trip_password" | "invite" | "group";

/**
 * Whose names a caller may be shown. A FULL session sees every label on the user's own links; a
 * Telegram-minted (scoped) session only its OWN Telegram account's (`ownDigest`, from the session's scope) -
 * it must not learn how the owner's other phones are named.
 */
export type LabelVisibility = "all" | { ownDigest: string | null };

/**
 * The first name and @username when the viewer may see them, as two separate keys (`name`, `username`; a
 * missing one is omitted). Display data only: never compared, never decides anything.
 */
function visibleName(firstName: string | null, username: string | null, digest: string, visibility: LabelVisibility): { name?: string; username?: string } {
  if (visibility !== "all" && !(visibility.ownDigest !== null && visibility.ownDigest === digest)) return {};
  return { ...(firstName ? { name: firstName } : {}), ...(username ? { username } : {}) };
}

/** One Telegram account that can currently open ONE trip as `userId`. */
export interface TelegramLinkView {
  /** Opaque row id; the only thing the Unlink button needs. */
  id: string;
  /** First name and @username (separate fields) when the viewer may see them; absent otherwise. Never decide anything. */
  name?: string;
  username?: string;
  via: LinkVia;
  linkedAt: string;
  firstSignedInAt: string | null;
  lastSignedInAt: string | null;
}

const VIA: Record<string, LinkVia> = {
  enrollment_redemption: "interview_link",
  backfill_intake_session: "earlier_interview",
  dashboard_link_token: "dashboard_link",
  dashboard_restore: "dashboard_restore",
  mini_app_trip_password: "trip_password",
  mini_app_invite_redemption: "invite",
  mini_app_group_membership: "group",
};

/**
 * The Telegram accounts that can open each of these trips as `userId`, keyed by
 * trip. This is what the dashboard's trip card shows (linked / not linked) and
 * what its ⋮ menu offers to Unlink.
 *
 * WHAT IS SHOWN, and why that much: when it was linked, how, and when it first
 * and last signed in. Those are the facts a person can check against their own
 * memory ("I never linked Telegram to Rome on the 3rd") without this becoming a
 * way to learn who the other party is. Not shown, on purpose: the Telegram id,
 * its digest or any prefix of it (a digest of a short numeric id is
 * brute-forceable, so a fragment narrows it). The one thing about the other
 * party that IS shown (owner decision 2026-10-23, "name + confirm") is the
 * display name - first name and @username as two separate fields, free text the
 * other person chose, stored from a verified Telegram path and bounded - so the owner can tell their
 * own phone from a stranger's before pressing Unlink or Restore. A FULL session
 * sees every label on its own links; a scoped session only its own account's
 * (`LabelVisibility`). It is display data: nothing reads it to decide anything.
 * The trip comes from the card the row is rendered on, so the rows carry no trip
 * title either.
 */
export async function telegramLinksByTrip(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  tripIds: readonly string[],
  visibility: LabelVisibility = { ownDigest: null },
): Promise<Map<string, TelegramLinkView[]>> {
  const byTrip = new Map<string, TelegramLinkView[]>();
  if (tripIds.length === 0) return byTrip;
  const result = await db.query<{
    id: string; trip_id: string; verified_via: string; created_at: Date;
    first_signed_in_at: Date | null; last_signed_in_at: Date | null; telegram_first_name: string | null; telegram_username: string | null; telegram_subject_digest: string;
  }>(
    `SELECT l.id, l.trip_id, l.verified_via, l.created_at, l.first_signed_in_at, l.last_signed_in_at, l.telegram_first_name, l.telegram_username, l.telegram_subject_digest
       FROM control_plane.telegram_organizer_trip_links l
      WHERE l.user_id = $1 AND l.trip_id = ANY($2::text[]) AND l.revoked_at IS NULL
     UNION ALL
     SELECT m.id, m.trip_id, m.verified_via, m.created_at, m.first_signed_in_at, m.last_signed_in_at, m.telegram_first_name, m.telegram_username, m.telegram_subject_digest
       FROM control_plane.telegram_member_links m
      WHERE m.user_id = $1 AND m.trip_id = ANY($2::text[]) AND m.revoked_at IS NULL
     ORDER BY created_at, id`,
    [userId, [...tripIds]],
  );
  for (const row of result.rows) {
    const list = byTrip.get(row.trip_id) ?? [];
    list.push({
      id: row.id,
      via: VIA[row.verified_via] ?? "interview_link",
      linkedAt: row.created_at.toISOString(),
      firstSignedInAt: row.first_signed_in_at ? row.first_signed_in_at.toISOString() : null,
      lastSignedInAt: row.last_signed_in_at ? row.last_signed_in_at.toISOString() : null,
      ...visibleName(row.telegram_first_name, row.telegram_username, row.telegram_subject_digest, visibility),
    });
    byTrip.set(row.trip_id, list);
  }
  return byTrip;
}

/** One Unlinked Telegram account the owner may bring back with a click (the trip card's "Restore"). */
export interface UnlinkedTelegramLinkView {
  /** Opaque id of the REVOKED row; the only thing the Restore button needs. */
  id: string;
  via: LinkVia;
  linkedAt: string;
  unlinkedAt: string;
  /** First name and @username, full sessions only (this list is never given to any other). Never decide anything. */
  name?: string;
  username?: string;
}

/**
 * The Telegram accounts `userId` Unlinked from each trip that can still be
 * restored without Telegram, keyed by trip. Given ONLY to a full session of an
 * owner or organizer (the route that fills the card decides; a scoped session is
 * never handed this), and only what the live list shows: when it was linked and
 * how, plus when it was unlinked. Never the Telegram id, its digest or a name.
 *
 * Restorable means all of: an owner Unlink (not a membership that ended), not
 * restored already, the NEWEST revoked row of its (Telegram account, user, trip)
 * pair, and the pair has no live row now (a lk_ relink already brought it back).
 * `restoreTelegramLink` (telegram-link-token.ts) re-checks every one at the click.
 */
export async function unlinkedTelegramLinksByTrip(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  tripIds: readonly string[],
): Promise<Map<string, UnlinkedTelegramLinkView[]>> {
  const byTrip = new Map<string, UnlinkedTelegramLinkView[]>();
  if (tripIds.length === 0) return byTrip;
  const result = await db.query<{ id: string; trip_id: string; verified_via: string; created_at: Date; revoked_at: Date; telegram_first_name: string | null; telegram_username: string | null }>(
    `SELECT l.id, l.trip_id, l.verified_via, l.created_at, l.revoked_at, l.telegram_first_name, l.telegram_username
       FROM control_plane.telegram_organizer_trip_links l
      WHERE l.user_id = $1 AND l.trip_id = ANY($2::text[])
        AND l.revoked_reason = 'owner_unlinked' AND l.restored_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM control_plane.telegram_organizer_trip_links x
               WHERE x.telegram_subject_digest = l.telegram_subject_digest AND x.user_id = l.user_id AND x.trip_id = l.trip_id
                 AND x.id <> l.id AND (x.revoked_at IS NULL OR (x.revoked_at, x.id) > (l.revoked_at, l.id)))
      ORDER BY l.revoked_at DESC, l.id`,
    [userId, [...tripIds]],
  );
  for (const row of result.rows) {
    const list = byTrip.get(row.trip_id) ?? [];
    list.push({
      id: row.id, via: VIA[row.verified_via] ?? "interview_link",
      linkedAt: row.created_at.toISOString(), unlinkedAt: row.revoked_at.toISOString(),
      ...(row.telegram_first_name ? { name: row.telegram_first_name } : {}),
      ...(row.telegram_username ? { username: row.telegram_username } : {}),
    });
    byTrip.set(row.trip_id, list);
  }
  return byTrip;
}

/**
 * Ends one of `userId`'s own links — ONE TRIP's link — and with it everything
 * that link held:
 *
 *   - the sessions it minted (`web_sessions.telegram_link_id`);
 *   - for an organizer link, that Telegram account's hold on THAT trip outside
 *     the web: an interview it is part-way through, and any open chat binding of
 *     the same Telegram chat to the trip. Closed, in the existing patterns
 *     (`expired_at` on the session, `closed_at`/`closed_reason` on the binding,
 *     `revoked` on the interview binding) — nothing deleted. Without this a
 *     forwardee who redeemed the owner's interview link would lose the Mini App
 *     and keep answering the owner's interview.
 *
 * The organizer's OTHER trips are untouched: the bot's /trips and /switch, and
 * the Mini App sign-in, keep working for every trip whose link is still live.
 *
 * ROLLBACK SAFETY. Both link tables are revoked in place and are read only by
 * this release. The previous release read the account-wide
 * `telegram_organizer_links` instead, and could not hide one trip out of it —
 * so if this pair still has an account-wide row it is MOVED to the history
 * table here, in the same transaction (see migration 20261021120000): older
 * code then sees none of the pair's trips, which can cost access after a
 * rollback and can never keep access the owner took away.
 *
 * `false` for a link that is not theirs, does not exist or is already gone —
 * the same answer for all three.
 */
export async function unlinkTelegramLink(db: pg.Pool, userId: string, linkId: string, released?: ReleasedClaim[]): Promise<boolean> {
  const kind: LinkKind | null = linkId.startsWith("otl_") ? "organizer" : linkId.startsWith("tml_") ? "member" : null;
  if (!kind) return false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (kind === "member") {
      const revoked = await client.query<{ trip_id: string; verified_via: string }>(
        `UPDATE control_plane.telegram_member_links SET revoked_at = now(), revoked_reason = 'owner_unlinked'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING trip_id, verified_via`,
        [linkId, userId],
      );
      if (!revoked.rowCount) { await client.query("ROLLBACK"); return false; }
      // A link a group claim wrote IS the way into an account that was made for it, so Unlinking it ends the claim as
      // well, and the traveller can be claimed again. Without this the name would stay held by an account nobody can open.
      if (revoked.rows[0]!.verified_via === GROUP_VERIFIED_VIA) {
        released?.push(...(await endGroupClaimInTx(client, { tripId: revoked.rows[0]!.trip_id, userId, linkReason: "owner_unlinked", claimReason: "unlinked" })));
      }
      // A SECONDARY ORGANIZER (#523) unlinking the member link their Mini App access rests on RESIGNS: the binding ends with it
      // (the Telegram organizer actions, the DM route, the membership). The alternative, refusing, would leave a person who
      // wants to leave with no way to; and leaving the binding alive would leave an organizer in Telegram with no Mini App,
      // a state nobody chose. Only their OWN link (the query above is by `user_id`, the hidden user is theirs alone).
      const own = await client.query<{ id: string }>(
        "SELECT id FROM control_plane.trip_secondary_organizers WHERE member_link_id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE",
        [linkId, userId],
      );
      if (own.rows[0]) await endSecondaryBindingInTx(client, { secondaryId: own.rows[0].id, reason: "membership_ended", revokedBy: userId });
    } else {
      if (!(await revokeOrganizerLinkInTx(client, userId, linkId))) { await client.query("ROLLBACK"); return false; }
    }
    if (kind === "member") {
      await client.query(
        "UPDATE control_plane.web_sessions SET revoked_at = now() WHERE telegram_link_id = $1 AND revoked_at IS NULL",
        [linkId],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The organizer half of `unlinkTelegramLink`, inside the caller's transaction: the link is revoked in place, the pair's
 * account-wide row retired, the chat's hold on THIS trip closed, the bot's organizer fact demoted and the web sessions the
 * link minted ended. `false` for a link that is not the user's or is already gone.
 *
 * One body for two callers, so they cannot drift: the owner's Unlink, and an approved replacement (#519,
 * organizer-link-approval.ts), where the bound Telegram account itself says another one takes over this trip. The second
 * is recorded exactly like the first (`owner_unlinked`): it is the owner, from the Telegram the account is bound to, taking
 * the link away, and the dashboard lists it as restorable like any other.
 */
export async function revokeOrganizerLinkInTx(
  client: pg.PoolClient,
  userId: string,
  linkId: string,
  /**
   * Why the link ended. `owner_unlinked` (the default) is an Unlink or an approved replacement and is listed for Restore.
   * `main_telegram_replaced` (#523) is the owner linking a NEW main Telegram: the old one's account-scoped links end through
   * this same function, with a reason of their own so the dashboard never offers a replaced main back for Restore.
   */
  reason: "owner_unlinked" | "main_telegram_replaced" = "owner_unlinked",
): Promise<boolean> {
  const revoked = await client.query<{ telegram_subject_digest: string; trip_id: string }>(
    `UPDATE control_plane.telegram_organizer_trip_links
        SET revoked_at = now(), revoked_reason = $3, revoked_by = $2
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING telegram_subject_digest, trip_id`,
    [linkId, userId, reason],
  );
  const row = revoked.rows[0];
  if (!row) return false;
  await retireAccountWideLink(client, userId, row.telegram_subject_digest);
  await closeChatHold(client, userId, row.telegram_subject_digest, row.trip_id);
  // The bot's own organizer fact for this sender on this trip (migration 0051's person link,
  // written at provisioning from whoever ran the interview) is demoted too: an Unlink must take
  // the organizer powers the link gave, not only the Mini App (boundary review R1).
  await client.query(
    `UPDATE control_plane.trip_person_links SET role = 'participant', demoted_from_role = 'organizer'
      WHERE trip_id = $2 AND role = 'organizer' AND telegram_user_id ~ '^[0-9]{1,20}$'
        AND ${CHAT_DIGEST_SQL("telegram_user_id")} = $1
        -- the same guard as the membership-end trigger: another user's live link of this
        -- Telegram account to this trip still stands, so the account is still an organizer there
        AND NOT EXISTS (
          SELECT 1 FROM control_plane.telegram_organizer_trip_links l
           WHERE l.trip_id = $2 AND l.telegram_subject_digest = $1 AND l.revoked_at IS NULL)`,
    [row.telegram_subject_digest, row.trip_id],
  );
  await client.query(
    "UPDATE control_plane.web_sessions SET revoked_at = now() WHERE telegram_link_id = $1 AND revoked_at IS NULL",
    [linkId],
  );
  return true;
}

/**
 * Moves the pair's account-wide row (the previous release's model, 0052) into
 * the history table and ends the sessions it minted. A no-op for a pair that
 * never had one. See `unlinkTelegramLink` for why this exists at all.
 */
async function retireAccountWideLink(client: pg.PoolClient, userId: string, digest: string): Promise<void> {
  const gone = await client.query<{ id: string }>(
    `WITH gone AS (
       DELETE FROM control_plane.telegram_organizer_links
        WHERE user_id = $1 AND telegram_subject_digest = $2
        RETURNING id, user_id, telegram_subject_digest, verified_via, created_at, first_signed_in_at, last_signed_in_at
     ), kept AS (
       INSERT INTO control_plane.telegram_organizer_link_revocations
         (id, user_id, telegram_subject_digest, verified_via, linked_at, first_signed_in_at, last_signed_in_at, revoked_reason)
       SELECT id, user_id, telegram_subject_digest, verified_via, created_at, first_signed_in_at, last_signed_in_at, 'owner_unlinked' FROM gone
       ON CONFLICT DO NOTHING
     )
     SELECT id FROM gone`,
    [userId, digest],
  );
  const ids = gone.rows.map((row) => row.id);
  if (ids.length > 0) {
    await client.query(
      "UPDATE control_plane.web_sessions SET revoked_at = now() WHERE telegram_link_id = ANY($1::text[]) AND revoked_at IS NULL",
      [ids],
    );
  }
}

/** sha256 of a raw Telegram chat id column, built exactly like identity.ts's digestTelegramId. */
export const CHAT_DIGEST_SQL = (column: string) => `'sha256:' || encode(sha256(convert_to(${column}, 'UTF8')), 'hex')`;

async function closeChatHold(client: pg.PoolClient, userId: string, digest: string, tripId: string): Promise<void> {
  // A live interview of the account's FOR THIS TRIP, driven from the unlinked chat.
  await client.query(
    `UPDATE control_plane.intake_sessions SET expired_at = now()
      WHERE user_id = $1 AND trip_id = $3 AND expired_at IS NULL AND state <> 'confirmed'
        AND telegram_chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("telegram_chat_id")} = $2`,
    [userId, digest, tripId],
  );
  await client.query(
    `UPDATE control_plane.telegram_interview_bindings SET state = 'revoked', updated_at = now()
      WHERE state = 'active' AND chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("chat_id")} = $1
        AND trip_id = $2`,
    [digest, tripId],
  );
  // The same chat's open routing to THIS trip (a companion DM).
  await client.query(
    `UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'telegram_unlinked'
      WHERE closed_at IS NULL AND chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("chat_id")} = $1
        AND trip_id = $2`,
    [digest, tripId],
  );
}
