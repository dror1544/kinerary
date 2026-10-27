/**
 * What a TELEGRAM-MINTED web session may see and do (#442, owner decision
 * 2026-10-21).
 *
 * A Mini App sign-in proves a Telegram account and a LINK somebody made earlier
 * — nothing more. So the session it mints is SCOPED to the trips that Telegram
 * account is linked to (for that user): it opens those trips, and nothing else
 * of the account. The full dashboard — the account's other trips, creating a
 * trip, anything account-level — needs a password or Google sign-in. Before this
 * change a forwarded interview link signed the forwardee in as the whole user.
 *
 * WHERE IT IS ENFORCED: `requireUser` in portal.ts — the one function every
 * authenticated portal route goes through (`requireMutation` calls it) — asks
 * `scopeDecision` below. Three properties make "a future route cannot forget":
 *
 *   1. Every portal route has a row in `PORTAL_SCOPE_POLICY`, and
 *      `assertEveryRouteIsClassified` throws at BOOT for one that does not.
 *   2. A scoped session on a route whose policy is anything but an explicit
 *      allowance is refused (default deny), including a policy of `open` on a
 *      route that nevertheless asks for a user.
 *   3. An unknown or unparseable scope is the EMPTY scope: no trip, no access.
 *
 * HOW A SESSION IS KNOWN TO BE SCOPED, two independent signals, either enough:
 * `web_sessions.telegram_link_id` is set, or the row's `token_digest` is the
 * SCOPED digest of the cookie (below). The scope itself is derived from the
 * link rows at request time — every live link (organizer trip links and member
 * links) of the same Telegram account and the same user as the link that minted
 * the session — so an Unlink, a revoked membership or a new link takes effect on
 * the next request without touching the session.
 *
 * ROLLBACK FAILS CLOSED. A scoped session's row is stored under
 * sha256("telegram-scope:" + cookie), not sha256(cookie). This release looks for
 * either; every older release looks only for sha256(cookie), finds nothing, and
 * answers 401. So a downgrade cannot turn a Telegram session into a full one:
 * the person simply launches again. (Sessions minted by the earlier build of this
 * feature, which stored the plain digest with a link id, are still recognised as
 * scoped here by the link id; only on the Mac staging database do any exist.)
 */
import { createHash } from "node:crypto";
import type pg from "pg";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** The digest a SCOPED session is stored under. Older releases never compute it. */
export function scopedSessionDigest(rawCookie: string): string {
  return sha(`telegram-scope:${rawCookie}`);
}

/** Every digest a cookie may be stored under, plain first. */
export function sessionDigests(rawCookie: string): string[] {
  // A real token is base64url and never contains ":". A cookie that starts with
  // the scope prefix is an attempt to make the PLAIN lookup land on a scoped row
  // (sha256("telegram-scope:" + t) is exactly where token t's scoped session is
  // stored): it matches nothing.
  if (rawCookie.startsWith("telegram-scope:")) return [];
  return [sha(rawCookie), scopedSessionDigest(rawCookie)];
}

export type RouteScope =
  /** Does not use the portal session at all (sign-in, invite inspection, internal routes). */
  | "open"
  /** Any signed-in session may call it; it reveals or changes nothing about a trip. */
  | "session"
  /** The trip in `:id` must be in the session's scope. */
  | "trip"
  /** The handler lists trips and filters to the session's scope. */
  | "filtered"
  /** `:linkId` is a Telegram link; the trip it belongs to must be in scope. */
  | "link"
  /** Account level: a full (password / Google) session only. */
  | "account";

/** `METHOD pattern` (Fastify's pattern, not the URL) to what a scoped session may do there. */
export const PORTAL_SCOPE_POLICY: Readonly<Record<string, RouteScope>> = Object.freeze({
  "POST /v1/events": "open",
  "GET /v1/auth/capabilities": "open",
  "POST /v1/auth/email-password": "open",
  // Email sign-up and password reset (portal-email-auth.ts). None reads the session cookie: the emailed token
  // (or, for sign-up and forgot, nothing but an address that gets a message) is the whole authority, so a
  // Telegram-scoped session can neither use these to reach another address's account nor be stopped from
  // using them as a stranger would.
  "POST /v1/auth/sign-up": "open",
  "POST /v1/auth/verify-email": "open",
  "POST /v1/auth/password/forgot": "open",
  "POST /v1/auth/password/reset": "open",
  "POST /v1/auth/telegram-mini-app": "open",
  // Sign in with Google (ID token). Never reads the session cookie: the signed token is the whole authority.
  "POST /v1/auth/google": "open",
  // The single-use nonce for it: sets a random cookie and returns its hash. Reads no session.
  "GET /v1/auth/google/nonce": "open",
  "POST /v1/auth/password": "open",
  "POST /v1/site-invites/inspect": "open",
  "POST /internal/runtime-launch/consume": "open",
  // The gateway's liveness question (#465). Authenticated by the exchange key, never reads the cookie,
  // exactly like consume above. Added at integration: the two lines were built apart.
  "POST /internal/runtime-sessions/check": "open",
  "GET /internal/runtime-routes/:tripId": "open",

  "GET /v1/me": "session",
  "POST /v1/logout": "session",

  "GET /v1/trips": "filtered",

  "POST /v1/trips": "account",
  "POST /v1/site-invites/redeem": "account",

  "DELETE /v1/account/telegram-links/:linkId": "link",
  // Restoring an Unlinked Telegram account without Telegram MINTS a way into the account, exactly like the
  // telegram-link route below: a scoped session (a forwardee's phone) must not undo an Unlink, its own
  // account's or anyone's. A password or Google sign-in only.
  "POST /v1/account/telegram-links/:linkId/restore": "account",

  "GET /v1/trips/:id": "trip",
  "GET /v1/trips/:id/interview-link": "trip",
  // These three MINT a way into the account: an interview link or a Telegram link redeemed by
  // another Telegram account becomes a link of its own, one that outlives the Unlink of the
  // session's own account (boundary review round 2, M1). They need a password or Google sign-in.
  "POST /v1/trips/:id/interview-link": "account",
  "POST /v1/trips/:id/interview-link/replace": "account",
  "POST /v1/trips/:id/telegram-link": "account",
  "POST /v1/trips/:id/provisioning-request": "trip",
  "POST /v1/trips/:id/plans/:planId/approve": "trip",
  "POST /v1/trips/:id/plans/:planId/reject": "trip",
  // A site invite is a join URL that anyone can redeem anonymously with a password: it makes an account
  // that outlives the Unlink of the session that minted it (round 3, MF1). Revoking an invite and removing
  // a member take access away from other people; a forwardee must not do either. All three need a password.
  "POST /v1/trips/:id/site-invites": "account",
  "DELETE /v1/trips/:id/site-invites/:inviteId": "account",
  "DELETE /v1/trips/:id/members/:membershipId": "account",
  "POST /v1/trips/:id/launch": "trip",
});

/** Boot-time guard: a portal route with no row above is a bug that would otherwise fail only for scoped sessions. */
export function assertEveryRouteIsClassified(routes: readonly string[]): void {
  const missing = routes.filter((route) => !(route in PORTAL_SCOPE_POLICY));
  if (missing.length > 0) {
    throw new Error(`portal routes without a scope policy (add them to PORTAL_SCOPE_POLICY in portal-scope.ts): ${missing.join(", ")}`);
  }
}

export interface SessionScope {
  /** Trips a Telegram-minted session may open. Empty is a valid, fail-closed answer. */
  tripIds: ReadonlySet<string>;
  /**
   * The Telegram account (digest) that minted the session. A scoped session may end only that
   * account's own links, never another account's - the owner's included (review S1). Null when unknown.
   */
  telegramDigest: string | null;
}

/**
 * The trips of every live link that belongs to the same Telegram account AND the
 * same user as the link that minted the session. A link id that is unknown,
 * revoked, of an older shape or not this user's yields the empty set.
 */
export async function loadSessionScope(
  db: pg.Pool,
  input: { userId: string; telegramLinkId: string | null },
): Promise<SessionScope> {
  const empty: SessionScope = { tripIds: new Set(), telegramDigest: null };
  const linkId = input.telegramLinkId;
  if (!linkId || !/^(otl|tml)_[A-Za-z0-9]{8,64}$/.test(linkId)) return empty;
  const result = await db.query<{ trip_id: string; minting_digest: string }>(
    `WITH minting AS (
       SELECT user_id, telegram_subject_digest FROM control_plane.telegram_organizer_trip_links
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       UNION ALL
       SELECT user_id, telegram_subject_digest FROM control_plane.telegram_member_links
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     )
     SELECT l.trip_id, m.telegram_subject_digest AS minting_digest FROM control_plane.telegram_organizer_trip_links l
       JOIN minting m ON m.user_id = l.user_id AND m.telegram_subject_digest = l.telegram_subject_digest
      WHERE l.revoked_at IS NULL
     UNION
     SELECT l.trip_id, m.telegram_subject_digest FROM control_plane.telegram_member_links l
       JOIN minting m ON m.user_id = l.user_id AND m.telegram_subject_digest = l.telegram_subject_digest
      WHERE l.revoked_at IS NULL`,
    [linkId, input.userId],
  );
  return { tripIds: new Set(result.rows.map((row) => row.trip_id)), telegramDigest: result.rows[0]?.minting_digest ?? null };
}

export type ScopeDecision =
  | { allow: true }
  | { allow: false; status: 403; body: { error: "ACCOUNT_SIGN_IN_REQUIRED"; message: string } }
  | { allow: false; status: 404; body: { error: "NOT_FOUND" } };

export const ACCOUNT_SIGN_IN_REQUIRED = {
  allow: false as const, status: 403 as const,
  body: { error: "ACCOUNT_SIGN_IN_REQUIRED" as const, message: "Sign in with your password to do this." },
};
const NOT_FOUND: ScopeDecision = { allow: false, status: 404, body: { error: "NOT_FOUND" } };

/**
 * What a scoped session may do on this route. Trip routes are answered with the
 * SAME 404 for a trip outside the scope as for one that does not exist; account
 * level routes with a 403 the page can show.
 */
export async function scopeDecision(
  db: pg.Pool,
  input: { routeKey: string; params: Record<string, unknown>; scope: SessionScope },
): Promise<ScopeDecision> {
  const policy: RouteScope | undefined = PORTAL_SCOPE_POLICY[input.routeKey];
  switch (policy) {
    case "session":
    case "filtered":
      return { allow: true };
    case "trip": {
      const tripId = input.params.id;
      return typeof tripId === "string" && input.scope.tripIds.has(tripId) ? { allow: true } : NOT_FOUND;
    }
    case "link": {
      const linkId = input.params.linkId;
      if (typeof linkId !== "string" || !/^(otl|tml)_[A-Za-z0-9]{8,64}$/.test(linkId)) return NOT_FOUND;
      const row = await db.query<{ trip_id: string; telegram_subject_digest: string }>(
        `SELECT trip_id, telegram_subject_digest FROM control_plane.telegram_organizer_trip_links WHERE id = $1 AND revoked_at IS NULL
         UNION ALL
         SELECT trip_id, telegram_subject_digest FROM control_plane.telegram_member_links WHERE id = $1 AND revoked_at IS NULL`,
        [linkId],
      );
      const found = row.rows[0];
      // Only the session's OWN Telegram account's links: another account's link on an in-scope trip - the
      // owner's phone, say - is not this session's to end, and looks like no link at all.
      const mine = Boolean(found) && input.scope.telegramDigest !== null && found!.telegram_subject_digest === input.scope.telegramDigest;
      return found && mine && input.scope.tripIds.has(found.trip_id) ? { allow: true } : NOT_FOUND;
    }
    // "account", "open" (a route that asks for a user but declared it does not),
    // and anything unclassified: refuse.
    default:
      return ACCOUNT_SIGN_IN_REQUIRED;
  }
}
