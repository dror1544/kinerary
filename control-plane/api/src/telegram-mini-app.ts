/**
 * Telegram Mini App sign-in: who a verified Telegram person is here, and which
 * trip opens first.
 *
 * `telegram-webapp-auth.ts` answers "did Telegram sign this?". This module
 * answers everything after that, and is where the trust decisions live:
 *
 *   - A VERIFIED Telegram identity is a digest. It becomes a control-plane
 *     session only through a LINK that someone created earlier by proving
 *     something Telegram alone cannot: redeeming an interview link issued to the
 *     account (`telegram_organizer_links`), or typing the trip's own password /
 *     redeeming a site invite while presenting fresh initData
 *     (`telegram_member_links`). Possessing a Telegram id proves you are that
 *     Telegram id; the link is the claim that you are also that user.
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
 * Nothing here logs an initData string, a hash, a Telegram id or the digest of
 * one. A digest of a short numeric id is brute-forceable, so it is an
 * identifier in the same class as the id itself.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { digestTelegramId } from "./identity.js";
import { structuredLog } from "./redaction.js";
import { TELEGRAM_API_ROOT } from "./relay/telegram-api.js";
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

export type MiniAppOutcome =
  | { kind: "session"; target: SessionTarget; notice?: "TRIP_UNAVAILABLE" }
  | { kind: "choose"; trips: ChooserTrip[]; notice?: "TRIP_UNAVAILABLE" }
  | { kind: "not_linked"; fallback: "trip_password" | "none"; tripId?: string };

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
       SELECT 1 FROM control_plane.telegram_organizer_links l
         JOIN control_plane.users u ON u.id = l.user_id AND u.status = 'active'
        WHERE l.telegram_subject_digest = $1
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
    link_id: string; link_kind: LinkKind;
  }>(
    `WITH linked AS (
       SELECT l.id AS link_id, 'organizer'::text AS link_kind, l.user_id, NULL::text AS only_trip
         FROM control_plane.telegram_organizer_links l
        WHERE l.telegram_subject_digest = $1
       UNION ALL
       SELECT m.id, 'member'::text, m.user_id, m.trip_id
         FROM control_plane.telegram_member_links m
        WHERE m.telegram_subject_digest = $1 AND m.revoked_at IS NULL
     )
     SELECT t.id AS trip_id, COALESCE(t.title, t.destination_label, 'Untitled trip') AS title,
            t.destination_label, t.start_date::text AS start_date, t.end_date::text AS end_date,
            tm.user_id, u.display_name, tm.role, tm.runtime_access, tm.created_at AS membership_created_at,
            linked.link_id, linked.link_kind
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
      linkId: row.link_id, linkKind: row.link_kind,
    });
  }
  return { linked: true, rows };
}

/**
 * Decides what a verified Telegram launch gets. Pure over the database state in
 * `client`'s transaction; mints nothing.
 *
 * `requestedTripId` is the chooser follow-up's trip (already pattern-checked by
 * the route). It selects within the person's accessible set and can never
 * widen it.
 */
export async function resolveMiniAppLaunch(
  client: pg.PoolClient,
  launch: VerifiedInitData,
  requestedTripId: string | null,
): Promise<MiniAppOutcome> {
  const digest = digestTelegramId(launch.telegramUserId);
  const { linked, rows } = await loadAccess(client, digest);
  const signedTrip = startParamTrip(launch.startParam);
  const requested = requestedTripId ?? signedTrip;

  if (!linked || rows.length === 0) {
    // One answer, whether or not the trip exists or the person has ever been
    // linked to anything: nothing here depends on the trip's existence.
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
    if (requested) notice = "TRIP_UNAVAILABLE";
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
  organizer: "control_plane.telegram_organizer_links",
  member: "control_plane.telegram_member_links",
};

/**
 * Records a sign-in through a link and reports whether it was the FIRST.
 * Locks the link row, so an Unlink racing this either lands first (and the
 * sign-in is refused: `null`) or waits until the sign-in has committed (and
 * then revokes the session it minted via `web_sessions.telegram_link_id`).
 */
export async function recordLinkSignIn(client: pg.PoolClient, kind: LinkKind, linkId: string): Promise<{ first: boolean } | null> {
  const table = LINK_TABLE[kind];
  const row = await client.query<{ first_signed_in_at: Date | null }>(
    // An organizer link that was Unlinked is no longer in its table at all;
    // a member link is flagged.
    `SELECT first_signed_in_at FROM ${table} WHERE id = $1 ${kind === "member" ? "AND revoked_at IS NULL" : ""} FOR UPDATE`,
    [linkId],
  );
  if (!row.rows[0]) return null;
  await client.query(
    `UPDATE ${table} SET last_signed_in_at = now(), first_signed_in_at = COALESCE(first_signed_in_at, now()) WHERE id = $1`,
    [linkId],
  );
  return { first: row.rows[0].first_signed_in_at === null };
}

/**
 * The "a Telegram account just signed in as you" notice, as rows in the outbox
 * in the same transaction as the session. Sent by the ordinary outbox
 * dispatcher (outbox-dispatcher.ts), never inline: a Telegram outage must not
 * delay or fail a sign-in, and a rolled-back sign-in must not announce itself.
 *
 * WHO GETS IT. Not the account that signed in: a forwarded interview link is
 * the case this exists for, and telling the forwardee about their own
 * sign-in warns nobody. It goes to the account owner's OWN chats — the open,
 * private (positive-id) bindings of the trips the account is owner or
 * organizer of — minus the signer's own chat. If there are none, nothing is
 * queued and the "Telegram accounts that can sign in as you" list is the only
 * channel; the count is returned so the caller can log that, quietly.
 * (A member-scoped link has no such chats: members are not bound to the bot in
 * DM, and the member just consented in the same request.)
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
  const chats = await client.query<{ chat_id: string }>(
    `SELECT DISTINCT b.chat_id
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trip_memberships m
         ON m.trip_id = b.trip_id AND m.user_id = $1 AND m.status = 'active' AND m.role IN ('owner', 'organizer')
       JOIN control_plane.trips t ON t.id = b.trip_id
      WHERE b.closed_at IS NULL
        AND b.chat_id ~ '^[0-9]{1,20}$'
        AND b.chat_id <> $2
        AND ${NOT_RETIRED_SQL}`,
    [input.userId, input.signerTelegramId],
  );
  const payload = JSON.stringify({
    account_name: input.accountName, link_kind: input.linkKind, trip_title: input.tripTitle,
    at: (input.now ?? new Date()).toISOString(),
  });
  for (const chat of chats.rows) {
    await client.query(
      `INSERT INTO control_plane.notification_outbox
         (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
       VALUES ($1, NULL, 'mini_app_sign_in_notice', $2, $3::jsonb, NULL, 'mini_app_sign_in_notice', 'control-plane', 'pending')`,
      [opaqueId("notif"), chat.chat_id, payload],
    );
  }
  return chats.rows.length;
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
    : `A Telegram account just signed in to Kinerary's Mini App as "${input.accountName}"${trip ? ` and opened ${trip}` : ""} (${when}). It can open that account's trips without a password.`;
  const he = input.linkKind === "member" && trip
    ? `חשבון טלגרם חובר ל-"${input.accountName}" ויכול מעכשיו לפתוח את ${trip} באפליקציית ה-Mini App של Kinerary בלי סיסמה (${when}).`
    : `חשבון טלגרם נכנס עכשיו לאפליקציית ה-Mini App של Kinerary בתור "${input.accountName}"${trip ? ` ופתח את ${trip}` : ""} (${when}). הוא יכול לפתוח את הטיולים של אותו חשבון בלי סיסמה.`;
  return [
    en,
    `If that was not you or someone you trust: open ${where}, find "Telegram accounts that can sign in as you", and press Unlink.`,
    "",
    he,
    `אם זה לא אתם או מישהו שאתם סומכים עליו: היכנסו אל ${where}, מצאו את "Telegram accounts that can sign in as you" ולחצו Unlink.`,
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
       (id, user_id, trip_id, telegram_subject_digest, verified_via, first_signed_in_at, last_signed_in_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (telegram_subject_digest, user_id, trip_id) WHERE revoked_at IS NULL DO NOTHING
     RETURNING id`,
    [opaqueId("tml"), input.userId, input.tripId, digestTelegramId(input.launch.telegramUserId), input.via],
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

// ── The owner's view: list and unlink ───────────────────────────────────────

export type LinkVia = "interview_link" | "earlier_interview" | "trip_password" | "invite";

export interface TelegramLinkView {
  /** Opaque row id; the only thing the Unlink button needs. */
  id: string;
  /** "account" opens every trip of the account; "trip" opens one. */
  scope: "account" | "trip";
  via: LinkVia;
  /** The trip a trip-scoped link opens. */
  tripTitle: string | null;
  /**
   * For a link made by redeeming an interview link: the trip THAT interview was
   * for, so an organizer can match "linked on the 3rd via the interview for
   * Rome" against their own memory of redeeming it — and spot the one they
   * did not.
   */
  viaTripTitle: string | null;
  linkedAt: string;
  firstSignedInAt: string | null;
  lastSignedInAt: string | null;
}

const VIA: Record<string, LinkVia> = {
  enrollment_redemption: "interview_link",
  backfill_intake_session: "earlier_interview",
  mini_app_trip_password: "trip_password",
  mini_app_invite_redemption: "invite",
};

/**
 * Every Telegram account that can currently sign in as `userId`.
 *
 * WHAT IS SHOWN, and why that much: the date it was linked, how (and for which
 * trip's interview), the trip for a trip-scoped link, and when it first and
 * last signed in. Those are the facts a person can check against their own
 * memory ("I never redeemed an interview link for Rome on the 3rd") without this
 * endpoint becoming a way to learn who the other party is. Not shown, on
 * purpose: the Telegram id, its digest or any prefix of it (a digest of a short
 * numeric id is brute-forceable, so a fragment narrows it), and any
 * Telegram-supplied name (free text the other person chose).
 *
 * The interview trip is matched by time: the link row is written in the same
 * transaction that consumes the enrollment, so its created_at is the
 * enrollment's consumed_at. A link with no enrollment within five minutes of it
 * (a backfilled one) simply has no `viaTripTitle`.
 */
export async function listTelegramLinks(db: pg.Pool, userId: string): Promise<TelegramLinkView[]> {
  const result = await db.query<{
    id: string; scope: "account" | "trip"; verified_via: string; trip_title: string | null; via_trip_title: string | null;
    created_at: Date; first_signed_in_at: Date | null; last_signed_in_at: Date | null;
  }>(
    `SELECT l.id, 'account'::text AS scope, l.verified_via, NULL::text AS trip_title, v.title AS via_trip_title,
            l.created_at, l.first_signed_in_at, l.last_signed_in_at
       FROM control_plane.telegram_organizer_links l
       LEFT JOIN LATERAL (
         SELECT COALESCE(t.title, t.destination_label, 'Untitled trip') AS title
           FROM control_plane.interview_enrollments e
           JOIN control_plane.trips t ON t.id = e.trip_id
          WHERE e.user_id = l.user_id AND e.consumed_at IS NOT NULL
            AND l.verified_via = 'enrollment_redemption'
            AND abs(extract(epoch FROM (e.consumed_at - l.created_at))) <= 300
          ORDER BY abs(extract(epoch FROM (e.consumed_at - l.created_at))) LIMIT 1
       ) v ON true
      WHERE l.user_id = $1
     UNION ALL
     SELECT m.id, 'trip'::text, m.verified_via, COALESCE(t.title, t.destination_label, 'Untitled trip'), NULL::text,
            m.created_at, m.first_signed_in_at, m.last_signed_in_at
       FROM control_plane.telegram_member_links m
       JOIN control_plane.trips t ON t.id = m.trip_id
      WHERE m.user_id = $1 AND m.revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    via: VIA[row.verified_via] ?? "interview_link",
    tripTitle: row.trip_title,
    viaTripTitle: row.via_trip_title,
    linkedAt: row.created_at.toISOString(),
    firstSignedInAt: row.first_signed_in_at ? row.first_signed_in_at.toISOString() : null,
    lastSignedInAt: row.last_signed_in_at ? row.last_signed_in_at.toISOString() : null,
  }));
}

/**
 * Ends one of `userId`'s own links, and with it everything that link held:
 *
 *   - the sessions it minted (`web_sessions.telegram_link_id`);
 *   - for an organizer link, the Telegram account's hold on the account's trips
 *     outside the web: an interview it is part-way through, and any open chat
 *     binding of that same Telegram chat to those trips. Closed, in the
 *     existing patterns (`expired_at` on the session, `closed_at`/`closed_reason`
 *     on the binding, `revoked` on the interview binding) — nothing deleted.
 *     Without this a forwardee who redeemed the owner's interview link would
 *     lose the Mini App and keep answering the owner's interview.
 *
 * An organizer link is MOVED to the history table rather than flagged, so a
 * reader that has never heard of revocation (this code's older release, after a
 * rollback) cannot see it. A member link is in a table only this release reads
 * and is flagged. `false` for a link that is not theirs, does not exist or is
 * already gone — the same answer for all three.
 */
export async function unlinkTelegramLink(db: pg.Pool, userId: string, linkId: string): Promise<boolean> {
  const kind: LinkKind | null = linkId.startsWith("tol_") ? "organizer" : linkId.startsWith("tml_") ? "member" : null;
  if (!kind) return false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (kind === "member") {
      const revoked = await client.query(
        `UPDATE control_plane.telegram_member_links SET revoked_at = now(), revoked_reason = 'owner_unlinked'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [linkId, userId],
      );
      if (!revoked.rowCount) { await client.query("ROLLBACK"); return false; }
    } else {
      const removed = await client.query<{ telegram_subject_digest: string }>(
        `WITH gone AS (
           DELETE FROM control_plane.telegram_organizer_links
            WHERE id = $1 AND user_id = $2
            RETURNING id, user_id, telegram_subject_digest, verified_via, created_at, first_signed_in_at, last_signed_in_at
         ), kept AS (
           INSERT INTO control_plane.telegram_organizer_link_revocations
             (id, user_id, telegram_subject_digest, verified_via, linked_at, first_signed_in_at, last_signed_in_at, revoked_reason)
           SELECT id, user_id, telegram_subject_digest, verified_via, created_at, first_signed_in_at, last_signed_in_at, 'owner_unlinked' FROM gone
         )
         SELECT telegram_subject_digest FROM gone`,
        [linkId, userId],
      );
      const digest = removed.rows[0]?.telegram_subject_digest;
      if (!digest) { await client.query("ROLLBACK"); return false; }
      await closeChatHold(client, userId, digest);
    }
    await client.query(
      "UPDATE control_plane.web_sessions SET revoked_at = now() WHERE telegram_link_id = $1 AND revoked_at IS NULL",
      [linkId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** sha256 of a raw Telegram chat id column, built exactly like identity.ts's digestTelegramId. */
const CHAT_DIGEST_SQL = (column: string) => `'sha256:' || encode(sha256(convert_to(${column}, 'UTF8')), 'hex')`;

async function closeChatHold(client: pg.PoolClient, userId: string, digest: string): Promise<void> {
  // A live interview of the account's, driven from the unlinked chat.
  await client.query(
    `UPDATE control_plane.intake_sessions SET expired_at = now()
      WHERE user_id = $1 AND expired_at IS NULL AND state <> 'confirmed'
        AND telegram_chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("telegram_chat_id")} = $2`,
    [userId, digest],
  );
  await client.query(
    `UPDATE control_plane.telegram_interview_bindings SET state = 'revoked', updated_at = now()
      WHERE state = 'active' AND chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("chat_id")} = $2
        AND trip_id IN (SELECT trip_id FROM control_plane.trip_memberships WHERE user_id = $1)`,
    [userId, digest],
  );
  // The same chat's open routing to the account's trips (a companion DM).
  await client.query(
    `UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'telegram_unlinked'
      WHERE closed_at IS NULL AND chat_id ~ '^[0-9]{1,20}$' AND ${CHAT_DIGEST_SQL("chat_id")} = $2
        AND trip_id IN (SELECT trip_id FROM control_plane.trip_memberships WHERE user_id = $1)`,
    [userId, digest],
  );
}
