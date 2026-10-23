import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { issueEnrollment, replaceEnrollment } from "./enrollment.js";
import { ensureUnknownPasswordCredential, hashPassword, resolveOrCreateEmailAccount, verifyPasswordLogin } from "./password-identity.js";
import type { Mailer } from "./mailer.js";
import {
  PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, consumePasswordReset, consumeSignUpToken, isPlausibleEmail, portalMailIdle,
  runInBackground, startPasswordReset, startSignUp, type EmailAuthContext,
} from "./portal-email-auth.js";
import { pickLanguage } from "./portal-email-templates.js";
import { generatePlan } from "./planner.js";
import { issueApproval } from "./plan-approval.js";
import { removeMember } from "./member-removal.js";
import { structuredLog } from "./redaction.js";
import {
  TRIP_ID_PATTERN, claimSessionSlot, enqueueSignInNotice, linkMemberOrSkip,
  recordLinkSignIn, resolveMiniAppLaunch, telegramLinksByTrip, unlinkTelegramLink, unlinkedTelegramLinksByTrip,
  type LabelVisibility, type TelegramMiniAppConfig,
} from "./telegram-mini-app.js";
import { issueTelegramLinkToken, restoreTelegramLink } from "./telegram-link-token.js";
import {
  ACCOUNT_SIGN_IN_REQUIRED, assertEveryRouteIsClassified, loadSessionScope, scopeDecision, scopedSessionDigest, sessionDigests,
  type SessionScope,
} from "./portal-scope.js";
import { verifyMiniAppInitData, type VerifiedInitData } from "./telegram-webapp-auth.js";

// The gateway's key, compared in constant time (a plain !== leaks how many
// leading bytes were right).
function exchangeKeyMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || !expected) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function opaque(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function base64url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const scrypt = promisify(scryptCallback);

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hashPortalPassword(password: string): Promise<string> {
  const salt = base64url(16);
  const derived = await scrypt(password, salt, 32) as Buffer;
  return `scrypt:${salt}:${derived.toString("base64url")}`;
}

async function verifyPortalPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, digest, extra] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !digest || extra) return false;
  const derived = await scrypt(password, salt, 32) as Buffer;
  const expected = Buffer.from(digest, "base64url");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function parseCookies(header: unknown): Record<string, string> {
  if (typeof header !== "string") return {};
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 1) return [];
    try {
      return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
    } catch {
      // A malformed cookie is untrusted input, not an application error.
      return [];
    }
  }));
}

/**
 * `crossSite` is the COOKIE VARIANT FOR A MINI APP RUNNING INSIDE A FRAME ON
 * ANOTHER SITE — Telegram Web (web.telegram.org) embeds the portal in a
 * cross-site iframe, where a `SameSite=Lax` cookie is never sent and a
 * Mini App that cannot hold a session cannot sign anyone in.
 *
 *   SameSite=None   so the browser sends it from inside that frame;
 *   Secure          which `None` requires, so an http origin (local dev) keeps
 *                   the Lax cookie rather than emit one browsers would drop;
 *   Partitioned     CHIPS: the browser keys the cookie to the TOP-LEVEL site
 *                   that was framing us when it was set (web.telegram.org), so
 *                   it is sent only back inside that same embedding — not to
 *                   a page on any other site that frames or requests us.
 *
 * Only the Mini App's own sign-in asks for it (`embedded` in the request, set
 * by the page when it finds itself in a frame). The ordinary portal keeps Lax.
 */
function cookie(name: string, value: string, options: { maxAge?: number; httpOnly?: boolean; secure?: boolean; crossSite?: boolean } = {}): string {
  const crossSite = options.crossSite === true && options.secure !== false;
  const pieces = [`${name}=${encodeURIComponent(value)}`, "Path=/", crossSite ? "SameSite=None" : "SameSite=Lax"];
  if (options.secure !== false) pieces.push("Secure");
  if (crossSite) pieces.push("Partitioned");
  if (options.httpOnly !== false) pieces.push("HttpOnly");
  if (options.maxAge !== undefined) pieces.push(`Max-Age=${options.maxAge}`);
  return pieces.join("; ");
}

export function validatedReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/trips";
  try {
    const parsed = new URL(value, "https://portal.invalid");
    return parsed.origin === "https://portal.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/trips";
  } catch {
    return "/trips";
  }
}

export interface GoogleIdentity {
  subject: string;
  displayName: string;
  email?: string;
  /**
   * Google's own `email_verified` claim, and only ever true when it said so.
   * `exchange` rejects an explicit false, but the claim can also be absent —
   * and "absent" must not read as "verified" at the one call site that uses
   * this to decide whether two accounts are the same person.
   */
  emailVerified: boolean;
}

export interface GoogleOidcAdapter {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity>;
}

export class GoogleOidcClient implements GoogleOidcAdapter {
  private readonly client: OAuth2Client;

  constructor(private readonly clientId: string, clientSecret: string, private readonly redirectUri: string) {
    this.client = new OAuth2Client(clientId, clientSecret, redirectUri);
  }

  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string {
    return this.client.generateAuthUrl({
      access_type: "offline",
      scope: ["openid", "email", "profile"],
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: "select_account",
    });
  }

  async exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity> {
    const response = await this.client.getToken({ code: input.code, codeVerifier: input.codeVerifier, redirect_uri: this.redirectUri });
    const idToken = response.tokens.id_token;
    if (!idToken) throw new Error("GOOGLE_ID_TOKEN_MISSING");
    const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || payload.nonce !== input.nonce || payload.email_verified === false) throw new Error("GOOGLE_IDENTITY_INVALID");
    return {
      subject: payload.sub,
      displayName: payload.name?.slice(0, 120) || payload.email?.split("@")[0]?.slice(0, 120) || "Kinerary organizer",
      email: payload.email,
      emailVerified: payload.email_verified === true,
    };
  }
}

export interface RuntimeAccountAdapter {
  participantExists(input: {
    tripId: string;
    runtimeUsername: string;
  }): Promise<boolean>;
  provisionParticipant(input: {
    tripId: string;
    inviteId: string;
    userId: string;
    runtimeUsername: string;
    displayName: string;
  }): Promise<void>;
}

export class HttpRuntimeAccountAdapter implements RuntimeAccountAdapter {
  constructor(private readonly runtimeOrigin: string, private readonly apiKey: string) {}

  async participantExists(input: { tripId: string; runtimeUsername: string }): Promise<boolean> {
    const response = await fetch(`${this.runtimeOrigin}/internal/t/${encodeURIComponent(input.tripId)}/participants/${encodeURIComponent(input.runtimeUsername)}`, {
      method: "GET",
      headers: { "x-api-key": this.apiKey },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("RUNTIME_PARTICIPANT_LOOKUP_FAILED");
    return true;
  }

  async provisionParticipant(input: Parameters<RuntimeAccountAdapter["provisionParticipant"]>[0]): Promise<void> {
    const response = await fetch(`${this.runtimeOrigin}/internal/t/${encodeURIComponent(input.tripId)}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("RUNTIME_PARTICIPANT_PROVISION_FAILED");
  }
}

export interface PortalDependencies {
  db: pg.Pool;
  google?: GoogleOidcAdapter;
  runtimeAccounts: RuntimeAccountAdapter;
  publicOrigin: string;
  runtimeOrigin: string;
  runtimeExchangeKey: string;
  runtimeUpstreamHostSuffixes: readonly string[];
  telegramBotUsername: string;
  sessionTtlSeconds: number;
  enrollmentTtlSeconds: number;
  approvalTtlSeconds: number;
  /** Operator's Telegram chat id for provisioning notifications. See issueApproval. */
  operatorChatId?: string;
  /**
   * Telegram Mini App sign-in (#442). Absent, or `enabled()` false, leaves
   * `POST /v1/auth/telegram-mini-app` answering 503 and `capabilities` saying
   * so: the feature is off, and says it is off.
   */
  telegramMiniApp?: TelegramMiniAppConfig & { log?: (line: string) => void };
  /** How long a dashboard-issued Telegram link works. Defaults to 15 minutes. */
  telegramLinkTtlSeconds?: number;
  /**
   * Carries the verification and password-reset messages. ABSENT means email is
   * not configured: `POST /v1/auth/sign-up` and `/v1/auth/password/forgot` answer
   * 503 SIGN_UP_UNAVAILABLE and `capabilities.emailSignUp` is false. There is no
   * path on which a message is silently not sent.
   */
  mailer?: Mailer;
  /** Where the email routes write their (token-free) log lines. Defaults to stderr. */
  emailAuthLog?: (line: string) => void;
}

interface PortalUser {
  id: string;
  displayName: string;
  googleSubjectDigest: string | null;
  sessionDigest: string;
  sessionId: string;
  sessionCreatedAt: Date;
  /**
   * NULL for a full (password / Google) session. For a session a Telegram link
   * minted, the trips that Telegram account is linked to - possibly none. See
   * portal-scope.ts: `requireUser` enforces it, so a handler sees only a user
   * the route is allowed for.
   */
  scope: SessionScope | null;
}

/**
 * A scoped session's scope, derived from its link rows now. The ONE place that
 * turns "this session was minted by that link" into a trip set, used by
 * `portalUser` (every portal request) and by the gateway's liveness check, so
 * the two cannot disagree. A scope that cannot be read is the EMPTY scope.
 */
async function readSessionScope(deps: PortalDependencies, userId: string, telegramLinkId: string | null): Promise<SessionScope> {
  return loadSessionScope(deps.db, { userId, telegramLinkId }).catch(() => ({ tripIds: new Set<string>(), telegramDigest: null }));
}

/** The route whose policy decides whether a session may OPEN a trip: the launch that produced the trip session. */
const OPEN_TRIP_ROUTE = "POST /v1/trips/:id/launch";

/**
 * Is a live portal session of this user one that may still open this trip? A full session (no
 * Telegram link) may; a scoped one only if the trip is in its scope TODAY, by the same
 * `scopeDecision` `requireUser` applies to the launch. Without `sessionId` (a grant minted before
 * session binding) any live session that qualifies is enough.
 */
async function sessionMayOpenTrip(deps: PortalDependencies, input: { userId: string; tripId: string; sessionId: string | null }): Promise<boolean> {
  const sessions = await deps.db.query<{ telegram_link_id: string | null }>(
    `SELECT telegram_link_id FROM control_plane.web_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND ($2::text IS NULL OR id = $2::text)
      ORDER BY (telegram_link_id IS NULL) DESC`,
    [input.userId, input.sessionId]);
  for (const row of sessions.rows) {
    if (row.telegram_link_id === null) return true;
    const decision = await scopeDecision(deps.db, {
      routeKey: OPEN_TRIP_ROUTE, params: { id: input.tripId }, scope: await readSessionScope(deps, input.userId, row.telegram_link_id),
    });
    if (decision.allow) return true;
  }
  return false;
}

async function portalUser(request: FastifyRequest, deps: PortalDependencies): Promise<PortalUser | null> {
  const raw = parseCookies(request.headers.cookie).kit_session;
  if (!raw) return null;
  const result = await deps.db.query<{
    id: string; display_name: string; provider_subject_digest: string | null; session_digest: string; session_id: string; session_created_at: Date;
    telegram_link_id: string | null;
  }>(
    `SELECT u.id, u.display_name, ui.provider_subject_digest, s.token_digest AS session_digest, s.id AS session_id, s.created_at AS session_created_at,
            s.telegram_link_id
     FROM control_plane.web_sessions s
     JOIN control_plane.users u ON u.id = s.user_id AND u.status = 'active'
     LEFT JOIN control_plane.user_identities ui ON ui.user_id = u.id AND ui.provider = 'google'
     WHERE s.token_digest = ANY($1::text[]) AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionDigests(raw)],
  );
  const row = result.rows[0];
  if (!row) return null;
  void deps.db.query("UPDATE control_plane.web_sessions SET last_seen_at = now() WHERE token_digest = $1", [row.session_digest]).catch(() => {});
  // Scoped when EITHER signal says so: a Telegram link minted it, or it is stored under the scoped digest.
  // A scoped session whose scope cannot be read has the empty scope, not a full one.
  const scoped = row.telegram_link_id !== null || row.session_digest === scopedSessionDigest(raw);
  const scope = scoped ? await readSessionScope(deps, row.id, row.telegram_link_id) : null;
  return {
    id: row.id,
    displayName: row.display_name,
    googleSubjectDigest: row.provider_subject_digest,
    sessionDigest: row.session_digest,
    sessionId: row.session_id,
    sessionCreatedAt: row.session_created_at,
    scope,
  };
}

async function createWebSession(client: pg.PoolClient, userId: string, ttlSeconds: number, telegramLinkId: string | null = null) {
  const sessionToken = base64url(32);
  const csrf = base64url(24);
  // `telegramLinkId` is set only for a session a Telegram link minted, so that
  // unlinking (or the link ending any other way) can end that session too. Such
  // a session is SCOPED (portal-scope.ts) and is stored under the scoped digest,
  // which no older release can match: a rollback cannot widen it.
  await client.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at, telegram_link_id)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), $6)`,
    [opaque("wsess"), userId, telegramLinkId ? scopedSessionDigest(sessionToken) : sha256(sessionToken), sha256(csrf), ttlSeconds, telegramLinkId],
  );
  return { sessionToken, csrf };
}

function setWebSessionCookies(
  reply: FastifyReply, deps: PortalDependencies, session: { sessionToken: string; csrf: string },
  options: { embedded?: boolean } = {},
): void {
  const secure = deps.publicOrigin.startsWith("https://");
  const crossSite = options.embedded === true;
  reply.header("set-cookie", [
    cookie("kit_session", session.sessionToken, { maxAge: deps.sessionTtlSeconds, secure, crossSite }),
    cookie("kit_csrf", session.csrf, { maxAge: deps.sessionTtlSeconds, httpOnly: false, secure, crossSite }),
  ]);
}

/**
 * Expires BOTH variants. A cookie is identified by name, domain, path AND (for
 * the partitioned one) its partition, so a Lax expiry does not touch the
 * partitioned cookie a Mini App session set, and the other way round.
 */
function expiredSessionCookies(deps: PortalDependencies): string[] {
  const secure = deps.publicOrigin.startsWith("https://");
  const out = [cookie("kit_session", "", { maxAge: 0, secure }), cookie("kit_csrf", "", { maxAge: 0, httpOnly: false, secure })];
  if (secure) out.push(cookie("kit_session", "", { maxAge: 0, secure, crossSite: true }), cookie("kit_csrf", "", { maxAge: 0, httpOnly: false, secure, crossSite: true }));
  return out;
}

function clearWebSessionCookies(reply: FastifyReply, deps: PortalDependencies): void {
  reply.header("set-cookie", expiredSessionCookies(deps));
}

/** The page found itself in a frame on another site and says so; it can only ever weaken its own cookie. */
function embeddedRequest(body: Record<string, unknown>): boolean {
  return body.embedded === true;
}

/** An Origin that is present, is not the literal "null" of a sandboxed/opaque origin, and is ours. */
function originIsOurs(request: FastifyRequest, deps: PortalDependencies): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin !== "null" && origin === deps.publicOrigin;
}

/**
 * The "Next time, open with Telegram" request: verified-initData material AND an
 * explicit consent flag, both in the SAME request as a credential. Anything
 * short of `consent === true` is not a request to link.
 */
function telegramLinkRequest(body: Record<string, unknown>): { initData: string } | null {
  const link = body.telegramLink;
  if (!link || typeof link !== "object") return null;
  const { initData, consent } = link as { initData?: unknown; consent?: unknown };
  return consent === true && typeof initData === "string" ? { initData } : null;
}

async function recordFunnelEvent(
  db: pg.Pool | pg.PoolClient,
  eventName: string,
  input: { outcome?: "success" | "failure"; userId?: string; tripId?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO control_plane.funnel_events(id, event_name, outcome, user_id, trip_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [opaque("event"), eventName, input.outcome ?? null, input.userId ?? null, input.tripId ?? null],
  );
}

async function authenticate(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await portalUser(request, deps);
  if (!user) { reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" }); return null; }
  return user;
}

/**
 * THE one place a Telegram-minted session is held to its scope (portal-scope.ts).
 * For a mutation it runs AFTER the Origin and CSRF checks, so a request that
 * would be refused for those reasons gets the same status whatever id it names:
 * a foreign link id and an unknown one cannot be told apart by the status.
 */
async function enforceScope(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies, user: PortalUser): Promise<boolean> {
  if (!user.scope) return true;
  const decision = await scopeDecision(deps.db, {
    routeKey: `${request.method} ${request.routeOptions.url ?? ""}`,
    params: (request.params && typeof request.params === "object" ? request.params : {}) as Record<string, unknown>,
    scope: user.scope,
  });
  if (!decision.allow) { reply.code(decision.status).send(decision.body); return false; }
  return true;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await authenticate(request, reply, deps);
  if (!user) return null;
  return (await enforceScope(request, reply, deps, user)) ? user : null;
}

/**
 * A state-changing request carries the session cookie, a CSRF header that matches it
 * AND - when the browser says where it came from - our own origin. A present Origin
 * that is not `web.public_origin` (including the literal "null") is refused: with the
 * Telegram Web cookie variant (SameSite=None) the cookie is no longer held back by
 * SameSite, so this is a second wall behind the CSRF token. A MISSING Origin keeps
 * today's behaviour (CSRF token only): non-browser clients and older browsers do not send it.
 */
function originRefused(request: FastifyRequest, deps: PortalDependencies): boolean {
  const origin = request.headers.origin;
  return origin !== undefined && origin !== deps.publicOrigin;
}

async function requireMutation(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await authenticate(request, reply, deps);
  if (!user) return null;
  if (originRefused(request, deps)) {
    reply.code(403).send({ error: "ORIGIN_INVALID" });
    return null;
  }
  const cookies = parseCookies(request.headers.cookie);
  const csrfHeader = request.headers["x-csrf-token"];
  if (typeof csrfHeader !== "string" || !cookies.kit_csrf || !safeEqual(csrfHeader, cookies.kit_csrf)) {
    reply.code(403).send({ error: "CSRF_INVALID" });
    return null;
  }
  const session = await deps.db.query<{ csrf_digest: string }>(
    "SELECT csrf_digest FROM control_plane.web_sessions WHERE token_digest = ANY($1::text[]) AND revoked_at IS NULL AND expires_at > now()",
    [sessionDigests(cookies.kit_session ?? "")],
  );
  if (!session.rows[0] || !safeEqual(session.rows[0].csrf_digest, sha256(csrfHeader))) {
    reply.code(403).send({ error: "CSRF_INVALID" });
    return null;
  }
  return (await enforceScope(request, reply, deps, user)) ? user : null;
}

/**
 * An account with no email behind it — a Google sign-in whose address Google
 * would not vouch for. It gets its own user, as it always has, because there
 * is nothing here to tie it to anyone.
 */
async function createBareUser(client: pg.PoolClient, displayName: string): Promise<string> {
  const userId = opaque("user");
  await client.query(
    "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)",
    [userId, displayName],
  );
  return userId;
}

async function membership(deps: PortalDependencies, tripId: string, userId: string) {
  const result = await deps.db.query<{ role: string; dashboard_access: boolean; runtime_access: boolean }>(
    `SELECT role, dashboard_access, runtime_access FROM control_plane.trip_memberships
     WHERE trip_id = $1 AND user_id = $2 AND status = 'active'`,
    [tripId, userId],
  );
  return result.rows[0] ?? null;
}

function nextAction(state: string, planStatus?: string | null, jobState?: string | null, runtimeReady = false): string {
  if (state === "draft" || state === "intake_in_progress") return "continue_interview";
  if (state === "intake_confirmed") return "request_provisioning";
  // The organizer's own next move, not a wait on someone else.
  if (planStatus === "pending_approval") return "review_plan";
  if (["queued", "leased", "running"].includes(jobState ?? "")) return "track_provisioning";
  if (state === "ready_private" || state === "active") return runtimeReady ? "open_trip" : "view_status";
  if (state === "completed" || state === "sealed") return "view_trip";
  return "view_status";
}

/**
 * What a session may be told about the Telegram links on a card: a FULL session gets the Unlinked accounts
 * (Restore) and every label; a Telegram-minted one gets neither, except the label of its own account.
 */
function linkView(user: PortalUser): { restorable: boolean; labels: LabelVisibility } {
  return user.scope ? { restorable: false, labels: { ownDigest: user.scope.telegramDigest } } : { restorable: true, labels: "all" };
}

async function tripDetail(deps: PortalDependencies, tripId: string, userId: string, opts: { restorable?: boolean; labels?: LabelVisibility } = {}) {
  const tripResult = await deps.db.query<{
    id: string; title: string | null; destination_label: string | null; start_date: string | null; end_date: string | null;
    trip_type: string | null; lifecycle_state: string; slug: string; role: string; dashboard_access: boolean; runtime_access: boolean;
  }>(
    `SELECT t.id, t.title, t.destination_label, t.start_date::text, t.end_date::text, t.trip_type,
            t.lifecycle_state, t.slug, m.role, m.dashboard_access, m.runtime_access
     FROM control_plane.trips t JOIN control_plane.trip_memberships m ON m.trip_id = t.id
     WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [tripId, userId],
  );
  const trip = tripResult.rows[0];
  if (!trip) return null;
  const [planResult, sessionResult, routeResult, invitesResult] = await Promise.all([
    deps.db.query<{ id: string; status: string; digest: string; release_id: string | null; job_state: string | null; safe_error_code: string | null }>(
      `SELECT p.id, p.status, p.digest, p.release_id, j.state AS job_state, j.safe_error_code
       FROM control_plane.plans p
       LEFT JOIN control_plane.jobs j ON j.plan_id = p.id
       WHERE p.trip_id = $1 ORDER BY p.created_at DESC LIMIT 1`, [tripId]),
    deps.db.query<{ id: string; state: string }>("SELECT id, state FROM control_plane.intake_sessions WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1", [tripId]),
    deps.db.query<{ state: string }>("SELECT state FROM control_plane.runtime_routes WHERE trip_id = $1", [tripId]),
    deps.db.query<{ id: string; intended_display_name: string; runtime_username: string; state: string; expires_at: Date; created_at: Date }>(
      "SELECT id, intended_display_name, runtime_username, state, expires_at, created_at FROM control_plane.site_invites WHERE trip_id = $1 ORDER BY created_at DESC", [tripId]),
  ]);
  const plan = planResult.rows[0];
  const runtimeReady = routeResult.rows[0]?.state === "ready";
  // Who is on the trip, for the organizer's "remove member". The handle is the
  // membership id, never a user id. `removable` is the server's own answer so
  // the page does not re-derive the rules (not yourself; owners only by an
  // owner; never the last owner/organizer).
  const memberRows = trip.dashboard_access ? await deps.db.query<{
    id: string; user_id: string; display_name: string; role: string; runtime_username: string | null;
  }>(
    `SELECT m.id, m.user_id, u.display_name, m.role,
            (SELECT i.runtime_username FROM control_plane.site_invites i
              WHERE i.trip_id = m.trip_id AND i.redeemed_by = m.user_id AND i.state = 'redeemed'
              ORDER BY i.redeemed_at DESC LIMIT 1) AS runtime_username
       FROM control_plane.trip_memberships m JOIN control_plane.users u ON u.id = m.user_id
      WHERE m.trip_id = $1 AND m.status = 'active' ORDER BY m.created_at, m.id`, [tripId]) : { rows: [] };
  const isOrganizerSide = (role: string) => role === "owner" || role === "organizer";
  const members = memberRows.rows.map((row) => {
    const others = memberRows.rows.filter((other) => other.user_id !== row.user_id);
    const removable = trip.dashboard_access && isOrganizerSide(trip.role) && row.user_id !== userId
      && !(row.role === "owner" && (trip.role !== "owner" || !others.some((other) => other.role === "owner")))
      && !(isOrganizerSide(row.role) && !others.some((other) => isOrganizerSide(other.role)));
    return { id: row.id, displayName: row.display_name, role: row.role, runtimeUsername: row.runtime_username, you: row.user_id === userId, removable };
  });
  return {
    id: trip.id,
    title: trip.title ?? trip.destination_label ?? "Untitled trip",
    destination: trip.destination_label,
    startDate: trip.start_date,
    endDate: trip.end_date,
    tripType: trip.trip_type ?? "other",
    lifecycleState: trip.lifecycle_state,
    nextAction: nextAction(trip.lifecycle_state, plan?.status, plan?.job_state, runtimeReady),
    permissions: {
      role: trip.role,
      dashboard: trip.dashboard_access,
      runtime: trip.runtime_access,
      invite: trip.role === "owner" || trip.role === "organizer",
      requestProvisioning: trip.role === "owner",
    },
    interview: sessionResult.rows[0] ? { sessionId: sessionResult.rows[0].id, state: sessionResult.rows[0].state } : null,
    provisioning: plan ? {
      planId: plan.id, planStatus: plan.status, jobState: plan.job_state,
      releaseId: plan.release_id, digest: plan.digest, safeErrorCode: plan.safe_error_code,
    } : null,
    runtimeReady,
    members,
    // Which Telegram accounts can open THIS trip as the viewer: the card's
    // linked / not-linked icon and its ⋮ menu's Unlink entries.
    telegram: {
      links: (await telegramLinksByTrip(deps.db, userId, [tripId], opts.labels)).get(tripId) ?? [],
      // Unlinked accounts the owner may Restore. A FULL session only (the caller decides): a Telegram-minted
      // session is never told which accounts were Unlinked, because it cannot restore one (portal-scope.ts).
      ...(opts.restorable ? { unlinked: (await unlinkedTelegramLinksByTrip(deps.db, userId, [tripId])).get(tripId) ?? [] } : {}),
    },
    invites: invitesResult.rows.map((invite) => ({
      id: invite.id, displayName: invite.intended_display_name, runtimeUsername: invite.runtime_username,
      status: invite.state === "unused" && invite.expires_at.getTime() < Date.now() ? "expired" : invite.state,
      expiresAt: invite.expires_at.toISOString(), createdAt: invite.created_at.toISOString(),
    })),
  };
}

/**
 * What a member WITHOUT dashboard access may see of a trip in their list: the
 * trip's name, place, dates, their own permissions and whether it can be
 * opened. Nothing of the organizer's workbench — invitees' names and usernames,
 * invite ids, plan id/digest/status, the interview session, the lifecycle —
 * which `tripDetail` carries for the people who run the trip.
 */
async function memberTripSummary(deps: PortalDependencies, tripId: string, userId: string, labels?: LabelVisibility) {
  const result = await deps.db.query<{
    id: string; title: string | null; destination_label: string | null; start_date: string | null; end_date: string | null;
    role: string; dashboard_access: boolean; runtime_access: boolean; runtime_ready: boolean;
  }>(
    `SELECT t.id, t.title, t.destination_label, t.start_date::text, t.end_date::text, m.role, m.dashboard_access, m.runtime_access,
            EXISTS (SELECT 1 FROM control_plane.runtime_routes r WHERE r.trip_id = t.id AND r.state = 'ready') AS runtime_ready
       FROM control_plane.trips t JOIN control_plane.trip_memberships m ON m.trip_id = t.id
      WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [tripId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? row.destination_label ?? "Untitled trip",
    destination: row.destination_label,
    startDate: row.start_date,
    endDate: row.end_date,
    permissions: { role: row.role, dashboard: false, runtime: row.runtime_access, invite: false, requestProvisioning: false },
    runtimeReady: row.runtime_ready,
    telegram: { links: (await telegramLinksByTrip(deps.db, userId, [tripId], labels)).get(tripId) ?? [] },
  };
}

export function registerPortalRoutes(app: FastifyInstance, deps: PortalDependencies): void {
  // Every route registered below must have a scope policy (portal-scope.ts), or
  // the app does not boot: a route that forgot would fail only for a Telegram
  // session, which is exactly the session nobody tests by hand.
  const registered: string[] = [];
  let collecting = true;
  app.addHook("onRoute", (route) => {
    if (!collecting) return;
    for (const method of ([] as string[]).concat(route.method)) {
      if (method !== "HEAD" && method !== "OPTIONS") registered.push(`${method} ${route.url}`);
    }
  });
  registerPortalRouteHandlers(app, deps);
  collecting = false;
  // Sign-up and reset work happens after the response; closing the app waits for it.
  app.addHook("onClose", async () => { await portalMailIdle(); });
  assertEveryRouteIsClassified(registered);
}

function registerPortalRouteHandlers(app: FastifyInstance, deps: PortalDependencies): void {
  app.post("/v1/events", async (request, reply) => {
    const event = (request.body as Record<string, unknown>)?.event;
    if (event !== "landing_cta") return reply.code(400).send({ error: "INVALID_REQUEST" });
    await recordFunnelEvent(deps.db, "landing_cta");
    return reply.code(202).send({ accepted: true });
  });

  app.get("/v1/auth/capabilities", async () => ({
    google: Boolean(deps.google),
    emailPassword: true,
    // Whether the portal can send the verification / reset message at all. False renders "Sign-up isn't open yet".
    emailSignUp: Boolean(deps.mailer),
    telegramMiniApp: Boolean(deps.telegramMiniApp?.enabled()),
  }));

  // Bound both expensive credential checks and limiter memory. Use the socket
  // peer from Fastify (trustProxy is off), never caller-supplied forwarding.
  type Attempts = Map<string, { count: number; expiresAt: number }>;
  const loginAttempts: Attempts = new Map();
  const accountAttempts: Attempts = new Map();
  // Mini App launches and the trip-password route get limiters of their own, so
  // a flood against one cannot spend another's allowance. The per-person and
  // per-account maps are only ever keyed AFTER the thing being keyed has been
  // verified to exist (a signed initData, a credential row): keyed earlier, any
  // caller could fill the 1024 slots with junk and lock everyone else out.
  const miniAppIpAttempts: Attempts = new Map();
  const miniAppUserAttempts: Attempts = new Map();
  const passwordIpAttempts: Attempts = new Map();
  const passwordAccountAttempts: Attempts = new Map();
  function admitLogin(attempts: Attempts, key: string, limit: number): boolean {
    const now = Date.now();
    for (const [storedKey, entry] of attempts) if (entry.expiresAt <= now) attempts.delete(storedKey);
    const previous = attempts.get(key);
    if ((previous && previous.count >= limit) || (!previous && attempts.size >= 1024)) return false;
    attempts.set(key, { count: (previous?.count ?? 0) + 1, expiresAt: previous?.expiresAt ?? now + 60_000 });
    return true;
  }
  app.post("/v1/auth/email-password", async (request, reply) => {
    if (!admitLogin(loginAttempts, request.ip, 100)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    // A login creates only a session, never an account or a credential.
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.email !== "string" || body.email.length > 254 ||
        typeof body.password !== "string" || body.password.length > 1024) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    // Same-origin forms do not require a pre-existing session's CSRF token,
    // but must not let another origin force the browser into a chosen account.
    if (request.headers.origin && request.headers.origin !== deps.publicOrigin) {
      return reply.code(403).send({ error: "ORIGIN_INVALID" });
    }
    if (!admitLogin(accountAttempts, sha256(body.email.trim().toLowerCase()), 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    const result = await verifyPasswordLogin(deps.db, body);
    if (!result.ok) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT id FROM control_plane.users WHERE id = $1 AND status = 'active' FOR SHARE", [result.identity.providerSubjectId]);
      if (!user.rows[0]) { await client.query("ROLLBACK"); return reply.code(401).send({ error: "INVALID_CREDENTIALS" }); }
      const session = await createWebSession(client, user.rows[0].id, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
      return { appPath: validatedReturnTo(body.returnTo) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

  // ── Email sign-up, verification and password reset (portal-email-auth.ts) ──
  //
  //   POST /v1/auth/sign-up          { email, displayName?, returnTo?, language? }  202 { status: "check_your_email" }  (no password: it is chosen at verification)
  //   POST /v1/auth/verify-email     { token, password }       200 { appPath } + session cookies | 400 TOKEN_INVALID | 400 PASSWORD_TOO_SHORT | 409 ACCOUNT_EXISTS
  //   POST /v1/auth/password/forgot  { email, language? }      202 { status: "check_your_email" }
  //   POST /v1/auth/password/reset   { token, password }       200 { appPath } + session cookies | 400 TOKEN_INVALID
  //
  // All four are `open` (portal-scope.ts): none reads the session cookie, so a
  // Telegram-scoped session gets no more and no less from them than a stranger;
  // the emailed token is the whole authority. Sign-up and forgot answer 503
  // SIGN_UP_UNAVAILABLE without a mailer, and answer 202 identically for an
  // address that has an account and one that has not (the work follows the
  // response; see portal-email-auth.ts). Every one is `no-store` and needs our
  // own Origin, like /v1/auth/password: verify and reset SIGN SOMEBODY IN, so a
  // page on another site must not be able to post a token it holds.
  const signUpIpAttempts: Attempts = new Map();
  const signUpAddressAttempts: Attempts = new Map();
  const forgotIpAttempts: Attempts = new Map();
  const forgotAddressAttempts: Attempts = new Map();
  const emailTokenIpAttempts: Attempts = new Map();
  const emailAuthLog = (line: string) => (deps.emailAuthLog ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
  const emailAuthContext = (mailer: Mailer): EmailAuthContext => ({ db: deps.db, mailer, publicOrigin: deps.publicOrigin, log: emailAuthLog });
  const jsonBody = (request: FastifyRequest): Record<string, unknown> =>
    request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
  const addressKey = (email: string) => sha256(email.trim().toLowerCase());
  /** The page's own `returnTo`, kept only if it is a path the migration's CHECK also accepts. */
  const storableReturnTo = (value: unknown): string => {
    const path = validatedReturnTo(value);
    return /^\/[A-Za-z0-9/_?=&.#%-]*$/.test(path) ? path : "/trips";
  };

  app.post("/v1/auth/sign-up", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.mailer) return reply.code(503).send({ error: "SIGN_UP_UNAVAILABLE" });
    if (!admitLogin(signUpIpAttempts, request.ip, 20)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_UP_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    // There is deliberately no password here, and one in the body is ignored, never stored: the person
    // chooses it on the page the emailed link opens (see portal-email-auth.ts).
    if (!isPlausibleEmail(body.email) ||
        (body.displayName !== undefined && (typeof body.displayName !== "string" || body.displayName.length > 120))) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    if (!admitLogin(signUpAddressAttempts, addressKey(body.email), 3)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_UP_RATE_LIMITED" });
    const input = {
      email: body.email, displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      returnTo: storableReturnTo(body.returnTo ?? body.return_to), language: pickLanguage(body.language, request.headers["accept-language"]),
    };
    const ctx = emailAuthContext(deps.mailer);
    runInBackground(() => startSignUp(ctx, input), (error) =>
      emailAuthLog(structuredLog("error", "email_auth.sign_up_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" })));
    return reply.code(202).send({ status: "check_your_email" });
  });

  app.post("/v1/auth/verify-email", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!admitLogin(emailTokenIpAttempts, request.ip, 30)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    if (typeof body.password !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Before the token is touched: a typo in the password must not burn the link.
    if (body.password.length < PASSWORD_MIN_LENGTH) return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });
    if (body.password.length > PASSWORD_MAX_LENGTH) return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Hashed before the transaction, so a bad token costs the same scrypt and no row lock is held meanwhile.
    const passwordHash = await hashPassword(body.password);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const result = await consumeSignUpToken(client, body.token, passwordHash);
      if (!result.ok) {
        // Commit: a spent token stays spent, even when the address turned out to have an account already.
        await client.query("COMMIT");
        return reply.code(result.error === "ACCOUNT_EXISTS" ? 409 : 400).send({ error: result.error });
      }
      const session = await createWebSession(client, result.userId, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      return { appPath: validatedReturnTo(result.returnTo) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  });

  app.post("/v1/auth/password/forgot", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.mailer) return reply.code(503).send({ error: "SIGN_UP_UNAVAILABLE" });
    if (!admitLogin(forgotIpAttempts, request.ip, 20)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_UP_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    if (!isPlausibleEmail(body.email)) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (!admitLogin(forgotAddressAttempts, addressKey(body.email), 3)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_UP_RATE_LIMITED" });
    const input = { email: body.email, language: pickLanguage(body.language, request.headers["accept-language"]) };
    const ctx = emailAuthContext(deps.mailer);
    runInBackground(() => startPasswordReset(ctx, input), (error) =>
      emailAuthLog(structuredLog("error", "email_auth.password_reset_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" })));
    return reply.code(202).send({ status: "check_your_email" });
  });

  app.post("/v1/auth/password/reset", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!admitLogin(emailTokenIpAttempts, request.ip, 30)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    if (typeof body.token !== "string" || typeof body.password !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Before the token is touched: a typo in the new password must not burn the link.
    if (body.password.length < PASSWORD_MIN_LENGTH) return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });
    if (body.password.length > PASSWORD_MAX_LENGTH) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const passwordHash = await hashPassword(body.password);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const result = await consumePasswordReset(client, body.token, passwordHash);
      if (!result.ok) { await client.query("ROLLBACK"); return reply.code(400).send({ error: result.error }); }
      const session = await createWebSession(client, result.userId, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      return { appPath: "/trips" };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  });

  // ── Telegram Mini App sign-in (#442) ──────────────────────────────────────
  //
  // POST /v1/auth/telegram-mini-app  { initData, tripId? }
  //
  //   200 { kind: "session", appPath, notice? }  + the ordinary session cookies
  //   200 { kind: "choose", trips, notice? }     no cookie, no user ids
  //   401 { error: "TELEGRAM_NOT_LINKED", fallback: "trip_password" | "none", tripId? }
  //   401 { error: "TELEGRAM_INIT_DATA_INVALID" }   ONE code for every verification failure
  //   400 INVALID_REQUEST (a tripId that is not shaped like one) · 403 ORIGIN_INVALID
  //   415 · 429 · 503 (feature off)
  //
  // Everything is `private, no-store`. The order below is the security design:
  // cheap structural gates first (feature, per-IP budget, Origin, content type —
  // all in onRequest, before the body is even parsed), then ONE HMAC, and only
  // then anything keyed on the person.
  const miniAppLog = (line: string) => (deps.telegramMiniApp?.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
  app.post("/v1/auth/telegram-mini-app", {
    // initData is capped at 4096 bytes; a body that cannot hold one is not one.
    bodyLimit: 65536,
    onRequest: async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (!deps.telegramMiniApp?.enabled()) return reply.code(503).send({ error: "TELEGRAM_MINI_APP_UNAVAILABLE" });
      if (!admitLogin(miniAppIpAttempts, request.ip, 100)) {
        return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
      }
      // A login-CSRF vector: another site could otherwise post a victim's own
      // initData (or an attacker's) from the victim's browser. Missing and the
      // literal "null" (sandboxed iframes, file:, redirects) are refused too.
      if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
      if (!/^application\/json(?:\s*;.*)?$/i.test(String(request.headers["content-type"] ?? ""))) {
        return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE" });
      }
    },
  }, async (request, reply) => {
    const cfg = deps.telegramMiniApp!;
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    // Only `initData`, the signed string, is ever read. Not initDataUnsafe, not a
    // user object, not a query parameter.
    const verified = verifyMiniAppInitData(body.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds });
    if (!verified.ok) {
      miniAppLog(structuredLog("warn", "mini_app.init_data_rejected", { reason: verified.reason }));
      return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_INVALID" });
    }
    const launch: VerifiedInitData = verified.data;
    // Keyed by a hash of the id and held in memory only; reachable solely with a
    // signature Telegram made, so junk cannot fill the map.
    if (!admitLogin(miniAppUserAttempts, sha256(`miniapp:${launch.telegramUserId}`), 20)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    let requestedTripId: string | null = null;
    if (body.tripId !== undefined && body.tripId !== null) {
      if (typeof body.tripId !== "string" || !TRIP_ID_PATTERN.test(body.tripId)) return reply.code(400).send({ error: "INVALID_REQUEST" });
      requestedTripId = body.tripId;
    }
    const incoming = parseCookies(request.headers.cookie).kit_session;
    const revokeIncoming = async (client: pg.PoolClient) => {
      // A verified launch replaces whatever session this WebView already held:
      // on a shared device the previous person must not stay signed in behind it.
      if (incoming) await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = ANY($1::text[]) AND revoked_at IS NULL", [sessionDigests(incoming)]);
    };
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const outcome = await resolveMiniAppLaunch(client, launch, requestedTripId);
      if (outcome.kind === "session") {
        if (!(await claimSessionSlot(client, launch, cfg.maxAgeSeconds))) {
          // The launch has minted its allowance. Same answer as any other bad initData.
          await client.query("ROLLBACK");
          miniAppLog(structuredLog("warn", "mini_app.init_data_rejected", { reason: "REPLAY_CAP" }));
          return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_INVALID" });
        }
        const used = await recordLinkSignIn(client, outcome.target.linkKind, outcome.target.linkId, launch.name);
        if (!used) {
          await client.query("ROLLBACK");
          return reply.code(401).send({ error: "TELEGRAM_NOT_LINKED", fallback: "none" });
        }
        const session = await createWebSession(client, outcome.target.userId, deps.sessionTtlSeconds, outcome.target.linkId);
        // First use of this link: tell the account owner's OWN chats (not the signer).
        const noticesQueued = used.first
          ? await enqueueSignInNotice(client, {
            signerTelegramId: launch.telegramUserId, userId: outcome.target.userId, accountName: outcome.target.userDisplayName,
            linkKind: outcome.target.linkKind, tripTitle: outcome.target.tripTitle,
          })
          : 0;
        await revokeIncoming(client);
        await client.query("COMMIT");
        setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
        miniAppLog(structuredLog("info", "mini_app.sign_in", { outcome: "session", link_kind: outcome.target.linkKind, first_use: used.first, notices_queued: noticesQueued }));
        return { kind: "session", appPath: outcome.target.appPath, ...(outcome.notice ? { notice: outcome.notice } : {}) };
      }
      await revokeIncoming(client);
      await client.query("COMMIT");
      if (incoming) clearWebSessionCookies(reply, deps);
      miniAppLog(structuredLog("info", "mini_app.sign_in", { outcome: outcome.kind }));
      if (outcome.kind === "choose") return { kind: "choose", trips: outcome.trips, ...(outcome.notice ? { notice: outcome.notice } : {}) };
      return reply.code(401).send({ error: "TELEGRAM_NOT_LINKED", fallback: outcome.fallback, ...(outcome.tripId ? { tripId: outcome.tripId } : {}) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  // Ends one Telegram link — one TRIP's link — of the signed-in user's own, with
  // the sessions it opened. The trip card (GET /v1/trips) says which links exist;
  // this is the ⋮ menu's Unlink. Any signed-in user, member or organizer.
  app.delete("/v1/account/telegram-links/:linkId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    const linkId = (request.params as { linkId?: string }).linkId ?? "";
    if (!(await unlinkTelegramLink(deps.db, user.id, linkId))) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "unlinked" };
  });

  // The trip card's "Restore": brings back a Telegram account the signed-in owner or organizer Unlinked,
  // with no Telegram round trip (telegram-link-token.ts, restoreTelegramLink). Policy "account": a session a
  // Telegram link minted gets 403 before this handler runs, because restoring is minting a way in. Origin and
  // CSRF as for every mutation. Refused alike (404) for a link that is not theirs, does not exist, is not an
  // owner Unlink, is already back, or is on a trip they do not run.
  const restoreAttempts: Attempts = new Map();
  app.post("/v1/account/telegram-links/:linkId/restore", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    if (!admitLogin(restoreAttempts, user.id, 20)) {
      return reply.header("retry-after", "60").code(429).send({ error: "RATE_LIMITED" });
    }
    const linkId = (request.params as { linkId?: string }).linkId ?? "";
    const restored = await restoreTelegramLink(deps.db, { userId: user.id, linkId });
    if (!restored.ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "restored" };
  });

  app.get("/v1/auth/google/start", async (request, reply) => {
    if (!deps.google) return reply.code(503).send({ error: "GOOGLE_SIGN_IN_UNAVAILABLE" });
    const query = request.query as Record<string, unknown>;
    const state = base64url(24);
    const nonce = base64url(24);
    const verifier = base64url(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await deps.db.query(
      `INSERT INTO control_plane.web_auth_attempts(id, state_digest, code_verifier, nonce, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [opaque("wauth"), sha256(state), verifier, nonce, validatedReturnTo(query.return_to ?? query.returnTo)],
    );
    return reply.redirect(deps.google.authorizationUrl({ state, nonce, codeChallenge: challenge }));
  });

  app.get("/v1/auth/google/callback", async (request, reply) => {
    if (!deps.google) return reply.code(503).send({ error: "GOOGLE_SIGN_IN_UNAVAILABLE" });
    const query = request.query as Record<string, unknown>;
    if (typeof query.state !== "string" || typeof query.code !== "string") return reply.code(400).send({ error: "AUTH_CALLBACK_INVALID" });
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const attempts = await client.query<{ id: string; code_verifier: string; nonce: string; return_to: string }>(
        `SELECT id, code_verifier, nonce, return_to FROM control_plane.web_auth_attempts
         WHERE state_digest = $1 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(query.state)]);
      const attempt = attempts.rows[0];
      if (!attempt) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "AUTH_CALLBACK_INVALID" }); }
      const identity = await deps.google.exchange({ code: query.code, codeVerifier: attempt.code_verifier, nonce: attempt.nonce });
      const subjectDigest = sha256(`google:${identity.subject}`);
      const identities = await client.query<{ user_id: string }>(
        "SELECT user_id FROM control_plane.user_identities WHERE provider = 'google' AND provider_subject_digest = $1", [subjectDigest]);
      let userId = identities.rows[0]?.user_id;
      if (!userId) {
        // First Google sign-in for this Google account. If Google has VERIFIED
        // an address for it, that address already names an organizer account
        // here — one they signed up for, or one an operator invited — and this
        // is the same person arriving by a different door. Attach the Google
        // identity to that account instead of starting a third one beside it.
        //
        // Safe in the direction that matters: Google proving the address is a
        // stronger claim than this system has ever had for it, since signup
        // itself never verifies an email. An unverified or absent claim falls
        // through to a fresh account, which is the old behavior.
        if (identity.email && identity.emailVerified) {
          userId = await resolveOrCreateEmailAccount(client, identity.email, identity.displayName);
          // The account must not be claimable by asserting its address. Without
          // this, an account reachable only by Google would sit there with no
          // password credential, and `POST /v1/signup` with that email would
          // set one — handing a stranger who knows the address everything this
          // person owns. A credential nobody knows closes that; they sign in
          // with Google, and password recovery (portal-email-auth.ts) gives them one they chose.
          await ensureUnknownPasswordCredential(client, userId, identity.email);
        } else {
          userId = await createBareUser(client, identity.displayName);
        }
        await client.query(
          "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1, $2, 'google', $3, now())",
          [opaque("idnt"), userId, subjectDigest],
        );
      }
      const session = await createWebSession(client, userId, deps.sessionTtlSeconds);
      await recordFunnelEvent(client, "google_auth", { outcome: "success", userId });
      await client.query("UPDATE control_plane.web_auth_attempts SET consumed_at = now() WHERE id = $1", [attempt.id]);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      return reply.redirect(`${deps.publicOrigin}${attempt.return_to}`);
    } catch {
      await client.query("ROLLBACK");
      await recordFunnelEvent(deps.db, "google_auth", { outcome: "failure" }).catch(() => {});
      return reply.code(401).send({ error: "GOOGLE_AUTH_FAILED" });
    } finally {
      client.release();
    }
  });

  app.post("/v1/auth/password", async (request, reply) => {
    // Per-IP before anything is read or hashed: scrypt is the expensive step.
    if (!admitLogin(passwordIpAttempts, request.ip, 100)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    // Same-origin form posts only. This route used to accept a request from any
    // origin (and none): a page on another site could drive the victim's browser
    // into a chosen account, which is login CSRF. Missing and "null" are refused.
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const tripId = typeof body.tripId === "string" ? body.tripId : "";
    const runtimeUsername = typeof body.runtimeUsername === "string" ? body.runtimeUsername.toLowerCase().trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId) || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtimeUsername) || password.length < 8 || password.length > 128) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const result = await deps.db.query<{ user_id: string; password_hash: string }>(
      `SELECT c.user_id, c.password_hash
       FROM control_plane.web_password_credentials c
       JOIN control_plane.users u ON u.id = c.user_id AND u.status = 'active'
       WHERE c.trip_id = $1 AND c.runtime_username = $2`,
      [tripId, runtimeUsername],
    );
    const credential = result.rows[0];
    // Per account, and only for an account that EXISTS: keyed on the request's
    // own (trip, username) before this lookup, any caller could fill the map
    // with invented pairs and 429 every real member.
    if (credential && !admitLogin(passwordAccountAttempts, sha256(`${tripId}:${runtimeUsername}`), 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    if (!credential || !(await verifyPortalPassword(password, credential.password_hash))) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    const linkRequest = telegramLinkRequest(body);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const session = await createWebSession(client, credential.user_id, deps.sessionTtlSeconds);
      // "Next time, open with Telegram": the credential just verified, fresh
      // verified initData and an explicit consent flag all arrive in THIS
      // request, or nothing is linked. A skip never fails the sign-in.
      let telegramLink: "linked" | "skipped" | undefined;
      if (linkRequest) {
        telegramLink = "skipped";
        const cfg = deps.telegramMiniApp;
        const verified = cfg?.enabled() ? verifyMiniAppInitData(linkRequest.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds }) : null;
        if (cfg && verified?.ok && admitLogin(miniAppUserAttempts, sha256(`miniapp:${verified.data.telegramUserId}`), 20)) {
          const name = await client.query<{ display_name: string }>("SELECT display_name FROM control_plane.users WHERE id = $1", [credential.user_id]);
          telegramLink = await linkMemberOrSkip(client, {
            launch: verified.data, maxAgeSeconds: cfg.maxAgeSeconds, userId: credential.user_id, tripId,
            accountName: name.rows[0]?.display_name ?? "your account", via: "mini_app_trip_password",
          }, miniAppLog);
        }
      }
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
      const appPath = typeof body.returnTo === "string" ? validatedReturnTo(body.returnTo) : `/trips/${tripId}/app`;
      return { appPath, ...(telegramLink ? { telegramLink } : {}) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    // `scope: "telegram"` tells the page this session sees only the trips its Telegram account is linked to.
    return { id: user.id, displayName: user.displayName, scope: user.scope ? "telegram" : "full" };
  });

  app.post("/v1/logout", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const raw = parseCookies(request.headers.cookie).kit_session;
    await deps.db.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = ANY($1::text[])", [sessionDigests(raw ?? "")]);
    clearWebSessionCookies(reply, deps);
    return { ok: true };
  });

  app.get("/v1/trips", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    const rows = await deps.db.query<{ id: string; dashboard_access: boolean }>(
      // A member's trips are the ones they can open (runtime access), the same
      // list the Mini App shows; an organizer's also include the trips they run.
      // A Telegram-minted session sees only the trips its Telegram account is
      // linked to (portal-scope.ts): the filter is in the query, not after it.
      `SELECT trip_id AS id, dashboard_access FROM control_plane.trip_memberships
        WHERE user_id = $1 AND status = 'active' AND (dashboard_access = true OR runtime_access = true)
          AND ($2::text[] IS NULL OR trip_id = ANY($2::text[]))
        ORDER BY created_at DESC`,
      [user.id, user.scope ? [...user.scope.tripIds] : null]);
    // Full detail only where the caller runs the trip; a runtime-only member gets the summary.
    return { trips: (await Promise.all(rows.rows.map((row) => row.dashboard_access ? tripDetail(deps, row.id, user.id, linkView(user)) : memberTripSummary(deps, row.id, user.id, linkView(user).labels)))).filter(Boolean) };
  });

  app.post("/v1/trips", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const body = request.body as Record<string, unknown>;
    const destination = typeof body.destination === "string" ? body.destination.trim() : "";
    const tripType = typeof body.tripType === "string" ? body.tripType : "family";
    const startDate = typeof body.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ? body.startDate : null;
    const endDate = typeof body.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.endDate) ? body.endDate : null;
    if (!destination || destination.length > 160 || !["family", "group", "couple", "other"].includes(tripType) || (startDate && endDate && endDate < startDate)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const tripId = opaque("trip");
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : `${destination} trip`;
    const draftInputs = { destination, trip_type: tripType, ...(startDate ? { departure_date: startDate } : {}), ...(endDate ? { return_date: endDate } : {}) };
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO control_plane.trips(id, slug, lifecycle_state, title, destination_label, start_date, end_date, trip_type, draft_inputs)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8::jsonb)`,
        [tripId, `draft-${tripId.replace(/_/g, "-")}`, title, destination, startDate, endDate, tripType, JSON.stringify(draftInputs)],
      );
      await client.query(
        `INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access)
         VALUES ($1, $2, $3, 'owner', 'active', true, true)`, [opaque("memb"), tripId, user.id]);
      await recordFunnelEvent(client, "draft_created", { userId: user.id, tripId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return reply.code(201).send(await tripDetail(deps, tripId, user.id, linkView(user)));
  });

  app.get("/v1/trips/:id", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id;
    if (!tripId) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const detail = await tripDetail(deps, tripId, user.id, linkView(user));
    if (!detail || !detail.permissions.dashboard) return reply.code(404).send({ error: "NOT_FOUND" });
    return detail;
  });

  app.post("/v1/trips/:id/interview-link", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || member.role !== "owner" || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const result = await issueEnrollment(deps.db, user.id, tripId, { enrollmentTtlSeconds: deps.enrollmentTtlSeconds });
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    await recordFunnelEvent(deps.db, "interview_launched", { userId: user.id, tripId });
    return reply.code(201).send({
      enrollmentId: result.enrollmentId,
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(result.token)}`,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  // The trip card's "Link Telegram": a one-time, short-lived deep link that links
  // WHICHEVER Telegram account opens it to the signed-in organizer, for this trip
  // only. The session and CSRF token prove the account; the bot's verified update
  // proves the Telegram identity (telegram-link-token.ts). This is the way back for an account the
  // organizer never linked; the one they Unlinked comes back with Restore (below), and an interview
  // link, which may have been forwarded, does not undo an Unlink.
  const linkTokenAttempts: Attempts = new Map();
  app.post("/v1/trips/:id/telegram-link", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    // A person asks a handful of times, not hundreds; the cap bounds the churn
    // of revoked rows and the memory the limiter holds.
    if (!admitLogin(linkTokenAttempts, user.id, 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "RATE_LIMITED" });
    }
    const tripId = (request.params as { id?: string }).id ?? "";
    const issued = await issueTelegramLinkToken(deps.db, { userId: user.id, tripId, ttlSeconds: deps.telegramLinkTtlSeconds });
    // Not a trip they run, not a trip at all, retired: one answer.
    if (!issued.ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.code(201).send({
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(issued.token)}`,
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  // Safe recovery metadata only: the original plaintext enrollment is never
  // persisted, reconstructed, or returned here.
  app.get("/v1/trips/:id/interview-link", async (request, reply) => {
    const user = await requireUser(request, reply, deps); if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const result = await deps.db.query<{ lifecycle_state: string; id: string | null; expires_at: Date | null; has_interview: boolean }>(
      `SELECT t.lifecycle_state,e.id,e.expires_at,
         EXISTS(SELECT 1 FROM control_plane.intake_sessions s WHERE s.trip_id=t.id) AS has_interview
       FROM control_plane.trips t
       JOIN control_plane.trip_memberships m ON m.trip_id=t.id
       LEFT JOIN control_plane.interview_enrollments e ON e.trip_id=t.id AND e.state='issued' AND e.expires_at>now()
       WHERE t.id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='owner' AND m.dashboard_access=true`, [tripId,user.id]);
    const row = result.rows[0]; if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.header("cache-control", "private, no-store").send({
      activeEnrollment: row.id ? { id: row.id, expiresAt: row.expires_at!.toISOString() } : null,
      recoverable: Boolean(row.id) && row.lifecycle_state === "draft" && !row.has_interview,
      hasInterview: row.has_interview,
      telegramChatUrl: `https://t.me/${deps.telegramBotUsername}`,
    });
  });

  app.post("/v1/trips/:id/interview-link/replace", async (request, reply) => {
    const user = await requireMutation(request, reply, deps); if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const expectedEnrollmentId = (request.body as { expectedEnrollmentId?: unknown } | null)?.expectedEnrollmentId;
    if (typeof expectedEnrollmentId !== "string" || !/^enrl_[A-Za-z0-9]{8,64}$/.test(expectedEnrollmentId)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const result = await replaceEnrollment(deps.db, user.id, tripId, expectedEnrollmentId, { enrollmentTtlSeconds: deps.enrollmentTtlSeconds });
    if (!result.ok) return reply.code(result.reason === "NOT_OWNER" ? 404 : 409).send({ error: result.reason === "NOT_OWNER" ? "NOT_FOUND" : result.reason });
    return reply.header("cache-control", "private, no-store").code(201).send({
      enrollmentId: result.enrollmentId,
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(result.token)}`,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.post("/v1/trips/:id/provisioning-request", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || member.role !== "owner" || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const generated = await generatePlan(deps.db, tripId, opaque("corr", 12));
    if (!generated.ok) {
      const status = generated.reason === "NO_COMPATIBLE_RELEASE" || generated.reason === "ORGANIZER_NOT_ON_ROSTER" ? 422 : 409;
      return reply.code(status).send({ error: generated.reason });
    }
    await recordFunnelEvent(deps.db, "provisioning_requested", { userId: user.id, tripId });
    return reply.code(201).send({ planId: generated.planId, digest: generated.planDigest, planStatus: "pending_approval" });
  });

  // The organizer reviews the plan they just created, then approves or rejects
  // it. Twin of app.ts's POST /v1/plans/:planId/approve — same decision, same
  // authorizer, different auth surface (this one takes the SPA's cookie+CSRF
  // session). There is no operations-review queue: the operator is notified
  // when an approval lands, and provisioning never waits on that DM.
  //
  // Both routes are trip-scoped so the owner check and the plan are read
  // together; a plan whose trip the caller does not own is 404, not 403.
  async function ownedPendingPlan(
    request: FastifyRequest, reply: FastifyReply, userId: string,
  ): Promise<{ planId: string; tripId: string } | null> {
    const params = request.params as { id?: string; planId?: string };
    const tripId = params.id ?? "";
    const planId = params.planId ?? "";
    const member = await membership(deps, tripId, userId);
    if (!member || member.role !== "owner" || !member.dashboard_access) {
      reply.code(404).send({ error: "NOT_FOUND" });
      return null;
    }
    const plan = await deps.db.query<{ id: string }>(
      "SELECT id FROM control_plane.plans WHERE id = $1 AND trip_id = $2",
      [planId, tripId],
    );
    if (!plan.rows[0]) {
      reply.code(404).send({ error: "NOT_FOUND" });
      return null;
    }
    return { planId, tripId };
  }

  app.post("/v1/trips/:id/plans/:planId/approve", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const owned = await ownedPendingPlan(request, reply, user.id);
    if (!owned) return;
    const result = await issueApproval(deps.db, owned.planId, `user:${user.id}`, deps.approvalTtlSeconds, {
      operatorChatId: deps.operatorChatId,
    });
    if (!result.ok) return reply.code(result.reason === "ALREADY_APPROVED" ? 409 : 422).send({ error: result.reason });
    await recordFunnelEvent(deps.db, "provisioning_approved", { userId: user.id, tripId: owned.tripId });
    return { approvalId: result.approvalId, expiresAt: result.expiresAt.toISOString() };
  });

  app.post("/v1/trips/:id/plans/:planId/reject", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const owned = await ownedPendingPlan(request, reply, user.id);
    if (!owned) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body.reasonCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.reasonCode) ? body.reasonCode : "ORGANIZER_REJECTED";
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      // Guarded on status rather than a review row: only a plan still awaiting
      // a decision can be rejected, and the UPDATE's own rowCount is the lock.
      const superseded = await client.query(
        "UPDATE control_plane.plans SET status = 'superseded', updated_at = now() WHERE id = $1 AND status = 'pending_approval'",
        [owned.planId]);
      if (!superseded.rowCount) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "PLAN_NOT_PENDING" }); }
      await client.query("UPDATE control_plane.jobs SET state = 'cancelled', updated_at = now() WHERE plan_id = $1 AND state = 'waiting_for_user_action'", [owned.planId]);
      await client.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1", [owned.tripId]);
      await client.query("COMMIT");
      return { state: "rejected", reasonCode: code };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  });

  app.post("/v1/trips/:id/site-invites", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || !["owner", "organizer"].includes(member.role) || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = request.body as Record<string, unknown>;
    const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 120) : "";
    const runtimeUsername = typeof body.runtimeUsername === "string" ? body.runtimeUsername.toLowerCase().trim() : "";
    if (!displayName || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtimeUsername)) return reply.code(400).send({ error: "INVALID_REQUEST" });
    let participantExists = false;
    try {
      participantExists = await deps.runtimeAccounts.participantExists({ tripId, runtimeUsername });
    } catch {
      return reply.code(409).send({ error: "RUNTIME_NOT_READY" });
    }
    if (!participantExists) return reply.code(409).send({ error: "RUNTIME_PARTICIPANT_NOT_FOUND" });
    const token = base64url(32);
    const inviteId = opaque("invite");
    try {
      await deps.db.query(
        `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'unused', now() + interval '7 days')`,
        [inviteId, tripId, user.id, displayName, runtimeUsername, sha256(token)],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "INVITE_ALREADY_EXISTS" });
      throw error;
    }
    return reply.code(201).send({ id: inviteId, status: "unused", joinUrl: `${deps.publicOrigin}/join#token=${token}` });
  });

  app.delete("/v1/trips/:id/site-invites/:inviteId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const params = request.params as { id?: string; inviteId?: string };
    const member = await membership(deps, params.id ?? "", user.id);
    if (!member || !["owner", "organizer"].includes(member.role) || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const result = await deps.db.query(
      "UPDATE control_plane.site_invites SET state = 'revoked', updated_at = now() WHERE id = $1 AND trip_id = $2 AND state = 'unused'",
      [params.inviteId, params.id]);
    if (result.rowCount) return { status: "revoked" };
    // A REDEEMED invite is a person on the trip: revoking it removes them, with
    // everything removing a member does (member-removal.ts).
    const redeemed = await deps.db.query<{ redeemed_by: string | null }>(
      "SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1 AND trip_id = $2 AND state = 'redeemed'",
      [params.inviteId, params.id]);
    const target = redeemed.rows[0]?.redeemed_by;
    if (!target) return reply.code(404).send({ error: "NOT_FOUND" });
    const removal = await removeMember(deps.db, { tripId: params.id ?? "", actorUserId: user.id, targetUserId: target });
    if (!removal.ok) return reply.code(removal.status).send({ error: removal.error });
    return { status: "revoked" };
  });

  // Remove a member from the trip. Organizer-side only; anyone else, and any
  // membership that is not on this trip, is the same 404.
  app.delete("/v1/trips/:id/members/:membershipId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const params = request.params as { id?: string; membershipId?: string };
    const tripId = params.id ?? "";
    const target = await deps.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.trip_memberships WHERE id = $1 AND trip_id = $2 AND status = 'active'",
      [params.membershipId ?? "", tripId]);
    const actor = await membership(deps, tripId, user.id);
    if (!actor || !["owner", "organizer"].includes(actor.role) || !actor.dashboard_access || !target.rows[0]) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    const removal = await removeMember(deps.db, { tripId, actorUserId: user.id, targetUserId: target.rows[0].user_id });
    if (!removal.ok) return reply.code(removal.status).send({ error: removal.error });
    return { status: "removed" };
  });

  app.post("/v1/site-invites/inspect", async (request, reply) => {
    const token = (request.body as Record<string, unknown>)?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    const result = await deps.db.query(
      `SELECT i.id, i.intended_display_name, i.runtime_username, i.state, i.expires_at,
              t.title, t.destination_label FROM control_plane.site_invites i JOIN control_plane.trips t ON t.id = i.trip_id
       WHERE i.token_digest = $1`, [sha256(token)]);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    const status = row.state === "unused" && new Date(row.expires_at).getTime() < Date.now() ? "expired" : row.state;
    return { id: row.id, displayName: row.intended_display_name, runtimeUsername: row.runtime_username, tripTitle: row.title ?? row.destination_label, status, expiresAt: row.expires_at };
  });

  app.post("/v1/site-invites/redeem", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const token = body.token;
    const method = body.method;
    if (typeof token !== "string" || (method !== "google" && method !== "password")) return reply.code(400).send({ error: "INVALID_REQUEST" });
    let signedIn = await portalUser(request, deps);
    // Riding a cookie session is a state change on that account: it needs our origin when the browser sends one.
    if (signedIn && originRefused(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    // Joining a trip adds a membership to the signed-in ACCOUNT: account level,
    // so not from a session a Telegram link minted (portal-scope.ts).
    if (signedIn?.scope) return reply.code(ACCOUNT_SIGN_IN_REQUIRED.status).send(ACCOUNT_SIGN_IN_REQUIRED.body);
    const password = method === "password" && typeof body.password === "string" ? body.password : undefined;
    if (method === "password" && (!password || password.length < 8 || password.length > 128)) return reply.code(400).send({ error: "PASSWORD_INVALID" });
    if (method === "google") {
      // Google redemption acts through an existing browser session, so it is
      // a state-changing request and must prove the session's CSRF secret.
      const csrfUser = await requireMutation(request, reply, deps);
      if (!csrfUser) return;
      signedIn = csrfUser;
      if (!signedIn?.googleSubjectDigest) return reply.code(401).send({ error: "GOOGLE_SIGN_IN_REQUIRED" });
    }
    const invites = await deps.db.query<{
      id: string; trip_id: string; intended_display_name: string; runtime_username: string; state: string; expires_at: Date;
    }>("SELECT id, trip_id, intended_display_name, runtime_username, state, expires_at FROM control_plane.site_invites WHERE token_digest = $1", [sha256(token)]);
    const invite = invites.rows[0];
    if (!invite || invite.state !== "unused") return reply.code(404).send({ error: "NOT_FOUND" });
    if (invite.expires_at.getTime() < Date.now()) {
      await deps.db.query("UPDATE control_plane.site_invites SET state = 'expired', updated_at = now() WHERE id = $1", [invite.id]);
      return reply.code(410).send({ error: "INVITE_EXPIRED" });
    }
    // Stable across a rolled-back redemption: the runtime may already have
    // recorded this invite when the control-plane transaction retries.
    const userId = signedIn?.id ?? `user_${sha256(invite.id).slice(7, 39)}`;
    const portalPasswordHash = method === "password" && password ? await hashPortalPassword(password) : null;
    let passwordSession: { sessionToken: string; csrf: string } | null = null;
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT state FROM control_plane.site_invites WHERE id = $1 FOR UPDATE", [invite.id]);
      if (locked.rows[0]?.state !== "unused") { await client.query("ROLLBACK"); return reply.code(409).send({ error: "INVITE_ALREADY_USED" }); }
      if (!signedIn) await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, invite.intended_display_name]);
      // The runtime adapter is idempotent by invite id. Holding the invite row
      // lock prevents concurrent redemption; if the database transaction later
      // aborts, the same raw invite may safely retry the runtime enrollment.
      await deps.runtimeAccounts.provisionParticipant({
        tripId: invite.trip_id, inviteId: invite.id, userId, runtimeUsername: invite.runtime_username, displayName: invite.intended_display_name,
      });
      if (portalPasswordHash) {
        await client.query(
          `INSERT INTO control_plane.web_password_credentials(user_id, trip_id, runtime_username, password_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, trip_id) DO UPDATE
             SET runtime_username = EXCLUDED.runtime_username, password_hash = EXCLUDED.password_hash, updated_at = now()`,
          [userId, invite.trip_id, invite.runtime_username, portalPasswordHash],
        );
      }
      await client.query(
        `INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access)
         VALUES ($1, $2, $3, 'member', 'active', false, true)
         ON CONFLICT (trip_id, user_id) DO UPDATE SET status = 'active', runtime_access = true`,
        [opaque("memb"), invite.trip_id, userId]);
      await client.query("UPDATE control_plane.site_invites SET state = 'redeemed', redeemed_by = $1, redeemed_at = now(), updated_at = now() WHERE id = $2", [userId, invite.id]);
      if (!signedIn) passwordSession = await createWebSession(client, userId, deps.sessionTtlSeconds);
      await recordFunnelEvent(client, "invitation_redeemed", { userId, tripId: invite.trip_id });
      // Phase 2 linking, invite flavour. Only for a brand-new account that has
      // just proved itself by holding the invite and choosing a password — never
      // for a redemption riding an existing cookie session (that is a session,
      // not a credential), and only from our own origin.
      let telegramLink: "linked" | "skipped" | undefined;
      const linkRequest = !signedIn && method === "password" ? telegramLinkRequest(body) : null;
      if (linkRequest) {
        telegramLink = "skipped";
        const cfg = deps.telegramMiniApp;
        const verified = cfg?.enabled() && originIsOurs(request, deps)
          ? verifyMiniAppInitData(linkRequest.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds })
          : null;
        if (cfg && verified?.ok && admitLogin(miniAppUserAttempts, sha256(`miniapp:${verified.data.telegramUserId}`), 20)) {
          telegramLink = await linkMemberOrSkip(client, {
            launch: verified.data, maxAgeSeconds: cfg.maxAgeSeconds, userId, tripId: invite.trip_id,
            accountName: invite.intended_display_name, via: "mini_app_invite_redemption",
          }, miniAppLog);
        }
      }
      await client.query("COMMIT");
      if (passwordSession) setWebSessionCookies(reply, deps, passwordSession);
      return { status: "redeemed", tripId: invite.trip_id, appPath: `/trips/${invite.trip_id}/app`, ...(telegramLink ? { telegramLink } : {}) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.post("/v1/trips/:id/launch", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member?.runtime_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const token = base64url(32);
    await deps.db.query(
      `INSERT INTO control_plane.runtime_launch_grants(id, trip_id, user_id, token_digest, audience, expires_at, session_id)
       VALUES ($1, $2, $3, $4, 'runtime_gateway', now() + interval '90 seconds', $5)`,
      [opaque("launch"), tripId, user.id, sha256(token), user.sessionId],
    );
    await recordFunnelEvent(deps.db, "runtime_launched", { userId: user.id, tripId });
    return { runtimeOrigin: deps.runtimeOrigin, framePath: `/t/${tripId}/`, launchToken: token, expiresInSeconds: 90 };
  });

  app.post("/internal/runtime-launch/consume", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const token = (request.body as Record<string, unknown>)?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    const result = await deps.db.query<{ id: string; trip_id: string; user_id: string; role: string; runtime_username: string | null; session_id: string | null }>(
      `UPDATE control_plane.runtime_launch_grants g SET consumed_at = now()
       FROM control_plane.trip_memberships m
       WHERE g.token_digest = $1 AND g.consumed_at IS NULL AND g.expires_at > now()
         AND m.trip_id = g.trip_id AND m.user_id = g.user_id AND m.status = 'active' AND m.runtime_access = true
       RETURNING g.id, g.trip_id, g.user_id, g.session_id, m.role,
         (SELECT i.runtime_username FROM control_plane.site_invites i
          WHERE i.trip_id = g.trip_id AND i.redeemed_by = g.user_id AND i.state = 'redeemed'
          ORDER BY i.redeemed_at DESC LIMIT 1) AS runtime_username`, [sha256(token)]);
    const row = result.rows[0];
    if (!row) return reply.code(401).send({ error: "LAUNCH_INVALID" });
    // The way back to the dashboard, from this deployment's own configured
    // portal origin (no hostname in code). Only an owner/organizer has a
    // dashboard; the trip still re-checks the role before it serves the URL.
    const dashboardUrl = row.role === "member" ? null : `${deps.publicOrigin}/trips/${row.trip_id}/setup`;
    return { tripId: row.trip_id, userId: row.user_id, role: row.role, runtimeUsername: row.runtime_username, dashboardUrl, sessionId: row.session_id, audience: "runtime_gateway" };
  });

  // Asked by the gateway (at most every 30 s per session) before it serves a
  // request on a sealed cookie: is the portal session that opened this trip
  // still live, and is its person still active and still entitled to the trip?
  // Signing out of the portal on one device therefore ends the trip session
  // opened from that device and no other; removal from the trip or disabling
  // ends them all. The role the session was opened with must still be the
  // membership's role: a demotion (or promotion) answers no, so the person has to
  // relaunch and is issued a session for the role they now hold. A grant minted before session binding existed carries no
  // session (null) and keeps the earlier rule: any live portal session of the
  // person. Those grants live 90 seconds, so that rule is a rollback aid only.
  // A session a Telegram link minted is SCOPED (portal-scope.ts): it also has to still have this trip in
  // its scope, re-derived from the live link rows here, so an Unlink ends an open trip page.
  app.post("/internal/runtime-sessions/check", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const { tripId, userId, sessionId, role } = (request.body ?? {}) as Record<string, unknown>;
    const optionalText = (value: unknown) => value === undefined || value === null || typeof value === "string";
    if (typeof tripId !== "string" || typeof userId !== "string" || !optionalText(sessionId) || !optionalText(role)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const result = await deps.db.query(
      `SELECT 1 FROM control_plane.trip_memberships m
       JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
       WHERE m.trip_id = $1 AND m.user_id = $2 AND m.status = 'active' AND m.runtime_access = true
         AND ($4::text IS NULL OR m.role = $4::text)
         AND EXISTS (SELECT 1 FROM control_plane.web_sessions s
                     WHERE s.user_id = m.user_id AND s.revoked_at IS NULL AND s.expires_at > now()
                       AND ($3::text IS NULL OR s.id = $3::text))`,
      [tripId, userId, sessionId ?? null, role ?? null]);
    if (!result.rows[0]) return reply.code(401).send({ error: "SESSION_REVOKED" });
    // A Telegram-minted (scoped) session stays valid only while the trip is in its scope: an Unlink
    // ends an open trip page as it ends the next portal request. Answered exactly as a revoked session.
    if (!(await sessionMayOpenTrip(deps, { userId, tripId, sessionId: typeof sessionId === "string" ? sessionId : null }))) {
      return reply.code(401).send({ error: "SESSION_REVOKED" });
    }
    return { live: true };
  });

  app.get("/internal/runtime-routes/:tripId", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const tripId = (request.params as { tripId?: string }).tripId ?? "";
    const result = await deps.db.query<{ route_ref: string; private_url: string | null }>(
      `SELECT r.route_ref, j.result->>'private_url' AS private_url
       FROM control_plane.runtime_routes r
       LEFT JOIN LATERAL (
         SELECT result FROM control_plane.jobs
         WHERE trip_id = r.trip_id AND state = 'succeeded' AND result ? 'private_url'
         ORDER BY updated_at DESC LIMIT 1
       ) j ON true
       WHERE r.trip_id = $1 AND r.state = 'ready'`, [tripId]);
    const row = result.rows[0];
    if (!row?.private_url) return reply.code(404).send({ error: "RUNTIME_NOT_READY" });
    let upstream: URL;
    try { upstream = new URL(row.private_url); } catch { return reply.code(503).send({ error: "RUNTIME_ROUTE_INVALID" }); }
    const allowed = deps.runtimeUpstreamHostSuffixes.some((suffix) => upstream.hostname === suffix || upstream.hostname.endsWith(`.${suffix}`));
    if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || !allowed) {
      return reply.code(503).send({ error: "RUNTIME_ROUTE_INVALID" });
    }
    return { routeRef: row.route_ref, upstreamOrigin: upstream.origin, upstreamBasePath: upstream.pathname.replace(/\/$/, "") };
  });
}
