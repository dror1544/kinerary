import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { issueEnrollment } from "./enrollment.js";
import { generatePlan } from "./planner.js";
import { issueApproval } from "./plan-approval.js";

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
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

function cookie(name: string, value: string, options: { maxAge?: number; httpOnly?: boolean; secure?: boolean } = {}): string {
  const pieces = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.secure !== false) pieces.push("Secure");
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
    runtimeUsername: string;
    displayName: string;
    method: "google" | "password";
    googleSubjectDigest?: string;
    password?: string;
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
  google: GoogleOidcAdapter;
  runtimeAccounts: RuntimeAccountAdapter;
  publicOrigin: string;
  runtimeOrigin: string;
  runtimeExchangeKey: string;
  runtimeUpstreamHostSuffixes: readonly string[];
  telegramBotUsername: string;
  sessionTtlSeconds: number;
  enrollmentTtlSeconds: number;
  approvalTtlSeconds: number;
  provisioningAdminSubjectDigests: ReadonlySet<string>;
}

interface PortalUser {
  id: string;
  displayName: string;
  googleSubjectDigest: string | null;
  isProvisioningAdmin: boolean;
  sessionDigest: string;
  sessionCreatedAt: Date;
}

async function portalUser(request: FastifyRequest, deps: PortalDependencies): Promise<PortalUser | null> {
  const raw = parseCookies(request.headers.cookie).kit_session;
  if (!raw) return null;
  const result = await deps.db.query<{
    id: string; display_name: string; provider_subject_digest: string | null; session_digest: string; session_created_at: Date;
  }>(
    `SELECT u.id, u.display_name, ui.provider_subject_digest, s.token_digest AS session_digest, s.created_at AS session_created_at
     FROM control_plane.web_sessions s
     JOIN control_plane.users u ON u.id = s.user_id AND u.status = 'active'
     LEFT JOIN control_plane.user_identities ui ON ui.user_id = u.id AND ui.provider = 'google'
     WHERE s.token_digest = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(raw)],
  );
  const row = result.rows[0];
  if (!row) return null;
  void deps.db.query("UPDATE control_plane.web_sessions SET last_seen_at = now() WHERE token_digest = $1", [sha256(raw)]).catch(() => {});
  return {
    id: row.id,
    displayName: row.display_name,
    googleSubjectDigest: row.provider_subject_digest,
    isProvisioningAdmin: row.provider_subject_digest !== null && deps.provisioningAdminSubjectDigests.has(row.provider_subject_digest),
    sessionDigest: row.session_digest,
    sessionCreatedAt: row.session_created_at,
  };
}

async function createWebSession(client: pg.PoolClient, userId: string, ttlSeconds: number) {
  const sessionToken = base64url(32);
  const csrf = base64url(24);
  await client.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
    [opaque("wsess"), userId, sha256(sessionToken), sha256(csrf), ttlSeconds],
  );
  return { sessionToken, csrf };
}

function setWebSessionCookies(reply: FastifyReply, deps: PortalDependencies, session: { sessionToken: string; csrf: string }): void {
  const secure = deps.publicOrigin.startsWith("https://");
  reply.header("set-cookie", [
    cookie("kit_session", session.sessionToken, { maxAge: deps.sessionTtlSeconds, secure }),
    cookie("kit_csrf", session.csrf, { maxAge: deps.sessionTtlSeconds, httpOnly: false, secure }),
  ]);
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

async function requireUser(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await portalUser(request, deps);
  if (!user) reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
  return user;
}

async function requireMutation(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await requireUser(request, reply, deps);
  if (!user) return null;
  const cookies = parseCookies(request.headers.cookie);
  const csrfHeader = request.headers["x-csrf-token"];
  if (typeof csrfHeader !== "string" || !cookies.kit_csrf || !safeEqual(csrfHeader, cookies.kit_csrf)) {
    reply.code(403).send({ error: "CSRF_INVALID" });
    return null;
  }
  const session = await deps.db.query<{ csrf_digest: string }>(
    "SELECT csrf_digest FROM control_plane.web_sessions WHERE token_digest = $1 AND revoked_at IS NULL AND expires_at > now()",
    [sha256(cookies.kit_session ?? "")],
  );
  if (!session.rows[0] || !safeEqual(session.rows[0].csrf_digest, sha256(csrfHeader))) {
    reply.code(403).send({ error: "CSRF_INVALID" });
    return null;
  }
  return user;
}

async function membership(deps: PortalDependencies, tripId: string, userId: string) {
  const result = await deps.db.query<{ role: string; dashboard_access: boolean; runtime_access: boolean }>(
    `SELECT role, dashboard_access, runtime_access FROM control_plane.trip_memberships
     WHERE trip_id = $1 AND user_id = $2 AND status = 'active'`,
    [tripId, userId],
  );
  return result.rows[0] ?? null;
}

function nextAction(state: string, planStatus?: string | null, jobState?: string | null): string {
  if (state === "draft" || state === "intake_in_progress") return "continue_interview";
  if (state === "intake_confirmed") return "request_provisioning";
  if (planStatus === "pending_approval") return "await_operations_approval";
  if (["queued", "leased", "running"].includes(jobState ?? "")) return "track_provisioning";
  if (state === "ready_private" || state === "active") return "open_trip";
  if (state === "completed" || state === "sealed") return "view_trip";
  return "view_status";
}

async function tripDetail(deps: PortalDependencies, tripId: string, userId: string) {
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
    deps.db.query<{ id: string; status: string; digest: string; release_id: string | null; review_state: string | null; job_state: string | null; safe_error_code: string | null }>(
      `SELECT p.id, p.status, p.digest, p.release_id, r.state AS review_state, j.state AS job_state, j.safe_error_code
       FROM control_plane.plans p
       LEFT JOIN control_plane.plan_operations_reviews r ON r.plan_id = p.id
       LEFT JOIN control_plane.jobs j ON j.plan_id = p.id
       WHERE p.trip_id = $1 ORDER BY p.created_at DESC LIMIT 1`, [tripId]),
    deps.db.query<{ id: string; state: string }>("SELECT id, state FROM control_plane.intake_sessions WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1", [tripId]),
    deps.db.query<{ state: string }>("SELECT state FROM control_plane.runtime_routes WHERE trip_id = $1", [tripId]),
    deps.db.query<{ id: string; intended_display_name: string; runtime_username: string; state: string; expires_at: Date; created_at: Date }>(
      "SELECT id, intended_display_name, runtime_username, state, expires_at, created_at FROM control_plane.site_invites WHERE trip_id = $1 ORDER BY created_at DESC", [tripId]),
  ]);
  const plan = planResult.rows[0];
  return {
    id: trip.id,
    title: trip.title ?? trip.destination_label ?? "Untitled trip",
    destination: trip.destination_label,
    startDate: trip.start_date,
    endDate: trip.end_date,
    tripType: trip.trip_type ?? "other",
    lifecycleState: trip.lifecycle_state,
    nextAction: nextAction(trip.lifecycle_state, plan?.status, plan?.job_state),
    permissions: {
      role: trip.role,
      dashboard: trip.dashboard_access,
      runtime: trip.runtime_access,
      invite: trip.role === "owner" || trip.role === "organizer",
      requestProvisioning: trip.role === "owner",
    },
    interview: sessionResult.rows[0] ? { sessionId: sessionResult.rows[0].id, state: sessionResult.rows[0].state } : null,
    provisioning: plan ? {
      planId: plan.id, planStatus: plan.status, reviewState: plan.review_state, jobState: plan.job_state,
      releaseId: plan.release_id, digest: plan.digest, safeErrorCode: plan.safe_error_code,
    } : null,
    runtimeReady: routeResult.rows[0]?.state === "ready" || trip.lifecycle_state === "ready_private",
    invites: invitesResult.rows.map((invite) => ({
      id: invite.id, displayName: invite.intended_display_name, runtimeUsername: invite.runtime_username,
      status: invite.state === "unused" && invite.expires_at.getTime() < Date.now() ? "expired" : invite.state,
      expiresAt: invite.expires_at.toISOString(), createdAt: invite.created_at.toISOString(),
    })),
  };
}

export function registerPortalRoutes(app: FastifyInstance, deps: PortalDependencies): void {
  app.post("/v1/events", async (request, reply) => {
    const event = (request.body as Record<string, unknown>)?.event;
    if (event !== "landing_cta") return reply.code(400).send({ error: "INVALID_REQUEST" });
    await recordFunnelEvent(deps.db, "landing_cta");
    return reply.code(202).send({ accepted: true });
  });

  app.get("/v1/auth/google/start", async (request, reply) => {
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
        userId = opaque("user");
        await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, identity.displayName]);
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
    const body = request.body as Record<string, unknown>;
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
    if (!credential || !(await verifyPortalPassword(password, credential.password_hash))) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const session = await createWebSession(client, credential.user_id, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      const appPath = typeof body.returnTo === "string" ? validatedReturnTo(body.returnTo) : `/trips/${tripId}/app`;
      return { appPath };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    if (Date.now() - user.sessionCreatedAt.getTime() > 15 * 60 * 1000) {
      const sessionToken = base64url(32);
      const csrf = base64url(24);
      const client = await deps.db.connect();
      try {
        await client.query("BEGIN");
        const revoked = await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = $1 AND revoked_at IS NULL", [user.sessionDigest]);
        if (revoked.rowCount) await client.query(
          `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at)
           VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
          [opaque("wsess"), user.id, sha256(sessionToken), sha256(csrf), deps.sessionTtlSeconds]);
        await client.query("COMMIT");
        if (revoked.rowCount) {
          const secure = deps.publicOrigin.startsWith("https://");
          reply.header("set-cookie", [cookie("kit_session", sessionToken, { maxAge: deps.sessionTtlSeconds, secure }), cookie("kit_csrf", csrf, { maxAge: deps.sessionTtlSeconds, httpOnly: false, secure })]);
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    return { id: user.id, displayName: user.displayName, isProvisioningAdmin: user.isProvisioningAdmin };
  });

  app.post("/v1/logout", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const raw = parseCookies(request.headers.cookie).kit_session;
    await deps.db.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = $1", [sha256(raw ?? "")]);
    const secure = deps.publicOrigin.startsWith("https://");
    reply.header("set-cookie", [cookie("kit_session", "", { maxAge: 0, secure }), cookie("kit_csrf", "", { maxAge: 0, httpOnly: false, secure })]);
    return { ok: true };
  });

  app.get("/v1/trips", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    const rows = await deps.db.query<{ id: string }>(
      "SELECT trip_id AS id FROM control_plane.trip_memberships WHERE user_id = $1 AND status = 'active' AND dashboard_access = true ORDER BY created_at DESC", [user.id]);
    return { trips: (await Promise.all(rows.rows.map((row) => tripDetail(deps, row.id, user.id)))).filter(Boolean) };
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
    return reply.code(201).send(await tripDetail(deps, tripId, user.id));
  });

  app.get("/v1/trips/:id", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id;
    if (!tripId) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const detail = await tripDetail(deps, tripId, user.id);
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

  app.post("/v1/trips/:id/provisioning-request", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || member.role !== "owner" || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const generated = await generatePlan(deps.db, tripId, opaque("corr", 12));
    if (!generated.ok) return reply.code(generated.reason === "NO_COMPATIBLE_RELEASE" ? 422 : 409).send({ error: generated.reason });
    await deps.db.query(
      "INSERT INTO control_plane.plan_operations_reviews(id, plan_id, requested_by, state) VALUES ($1, $2, $3, 'pending')",
      [opaque("oprv"), generated.planId, user.id],
    );
    await recordFunnelEvent(deps.db, "provisioning_requested", { userId: user.id, tripId });
    return reply.code(201).send({ planId: generated.planId, digest: generated.planDigest, reviewState: "pending" });
  });

  app.get("/v1/ops/provisioning-requests", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    if (!user.isProvisioningAdmin) return reply.code(403).send({ error: "FORBIDDEN" });
    const result = await deps.db.query(
      `SELECT r.id, r.plan_id, r.state, r.created_at, p.trip_id, p.digest, p.release_id,
              p.desired->'resource_intent' AS requested_resources,
              t.title, t.destination_label
       FROM control_plane.plan_operations_reviews r JOIN control_plane.plans p ON p.id = r.plan_id
       JOIN control_plane.trips t ON t.id = p.trip_id WHERE r.state = 'pending' ORDER BY r.created_at`,
    );
    return { requests: result.rows.map((row) => ({
      id: row.id, planId: row.plan_id, tripId: row.trip_id, title: row.title ?? row.destination_label,
      digest: row.digest, releaseId: row.release_id, requestedResources: row.requested_resources ?? [], state: row.state, createdAt: row.created_at,
    })) };
  });

  app.post("/v1/ops/provisioning-requests/:planId/approve", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    if (!user.isProvisioningAdmin) return reply.code(403).send({ error: "FORBIDDEN" });
    const planId = (request.params as { planId?: string }).planId ?? "";
    const review = await deps.db.query<{ id: string; requested_by: string; trip_id: string }>(
      `SELECT r.id, r.requested_by, p.trip_id FROM control_plane.plan_operations_reviews r
       JOIN control_plane.plans p ON p.id = r.plan_id WHERE r.plan_id = $1 AND r.state = 'pending'`, [planId]);
    if (!review.rows[0]) return reply.code(404).send({ error: "NOT_FOUND" });
    if (review.rows[0].requested_by === user.id) return reply.code(403).send({ error: "SEPARATION_OF_DUTIES_REQUIRED" });
    const result = await issueApproval(deps.db, planId, `user:${user.id}`, deps.approvalTtlSeconds);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    await deps.db.query("UPDATE control_plane.plan_operations_reviews SET state = 'approved', decided_by = $1, decided_at = now(), updated_at = now() WHERE plan_id = $2", [user.id, planId]);
    await recordFunnelEvent(deps.db, "provisioning_approved", { userId: user.id, tripId: review.rows[0].trip_id });
    return { approvalId: result.approvalId, expiresAt: result.expiresAt.toISOString() };
  });

  app.post("/v1/ops/provisioning-requests/:planId/reject", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    if (!user.isProvisioningAdmin) return reply.code(403).send({ error: "FORBIDDEN" });
    const planId = (request.params as { planId?: string }).planId ?? "";
    const body = request.body as Record<string, unknown>;
    const code = typeof body.reasonCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.reasonCode) ? body.reasonCode : "OPERATIONS_REJECTED";
    const review = await deps.db.query<{ requested_by: string }>("SELECT requested_by FROM control_plane.plan_operations_reviews WHERE plan_id = $1 AND state = 'pending'", [planId]);
    if (!review.rows[0]) return reply.code(404).send({ error: "NOT_FOUND" });
    if (review.rows[0].requested_by === user.id) return reply.code(403).send({ error: "SEPARATION_OF_DUTIES_REQUIRED" });
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE control_plane.plan_operations_reviews SET state = 'rejected', decided_by = $1, safe_rejection_code = $2, decided_at = now(), updated_at = now() WHERE plan_id = $3 AND state = 'pending'",
        [user.id, code, planId]);
      if (!updated.rowCount) { await client.query("ROLLBACK"); return reply.code(404).send({ error: "NOT_FOUND" }); }
      await client.query("UPDATE control_plane.plans SET status = 'superseded', updated_at = now() WHERE id = $1 AND status = 'pending_approval'", [planId]);
      await client.query("UPDATE control_plane.jobs SET state = 'cancelled', updated_at = now() WHERE plan_id = $1 AND state = 'waiting_for_user_action'", [planId]);
      await client.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = (SELECT trip_id FROM control_plane.plans WHERE id = $1)", [planId]);
      await client.query("COMMIT");
      return { state: "rejected", reasonCode: code };
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
    await deps.db.query(
      `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'unused', now() + interval '7 days')`,
      [inviteId, tripId, user.id, displayName, runtimeUsername, sha256(token)],
    );
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
    if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "revoked" };
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
    const signedIn = await portalUser(request, deps);
    const password = method === "password" && typeof body.password === "string" ? body.password : undefined;
    if (method === "password" && (!password || password.length < 8 || password.length > 128)) return reply.code(400).send({ error: "PASSWORD_INVALID" });
    const runtimeCredential: { googleSubjectDigest?: string; password?: string } = {};
    if (method === "google") {
      if (!signedIn?.googleSubjectDigest) return reply.code(401).send({ error: "GOOGLE_SIGN_IN_REQUIRED" });
      runtimeCredential.googleSubjectDigest = signedIn.googleSubjectDigest;
    } else {
      runtimeCredential.password = password;
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
    const userId = signedIn?.id ?? opaque("user");
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
        tripId: invite.trip_id, inviteId: invite.id, runtimeUsername: invite.runtime_username, displayName: invite.intended_display_name,
        method, ...runtimeCredential,
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
      await client.query("COMMIT");
      if (passwordSession) setWebSessionCookies(reply, deps, passwordSession);
      return { status: "redeemed", tripId: invite.trip_id, appPath: `/trips/${invite.trip_id}/app` };
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
      `INSERT INTO control_plane.runtime_launch_grants(id, trip_id, user_id, token_digest, audience, expires_at)
       VALUES ($1, $2, $3, $4, 'runtime_gateway', now() + interval '90 seconds')`,
      [opaque("launch"), tripId, user.id, sha256(token)],
    );
    await recordFunnelEvent(deps.db, "runtime_launched", { userId: user.id, tripId });
    return { runtimeOrigin: deps.runtimeOrigin, framePath: `/t/${tripId}/`, launchToken: token, expiresInSeconds: 90 };
  });

  app.post("/internal/runtime-launch/consume", async (request, reply) => {
    if (request.headers["x-api-key"] !== deps.runtimeExchangeKey) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const token = (request.body as Record<string, unknown>)?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    const result = await deps.db.query<{ id: string; trip_id: string; user_id: string; role: string; runtime_username: string | null }>(
      `UPDATE control_plane.runtime_launch_grants g SET consumed_at = now()
       FROM control_plane.trip_memberships m
       WHERE g.token_digest = $1 AND g.consumed_at IS NULL AND g.expires_at > now()
         AND m.trip_id = g.trip_id AND m.user_id = g.user_id AND m.status = 'active' AND m.runtime_access = true
       RETURNING g.id, g.trip_id, g.user_id, m.role,
         (SELECT i.runtime_username FROM control_plane.site_invites i
          WHERE i.trip_id = g.trip_id AND i.redeemed_by = g.user_id AND i.state = 'redeemed'
          ORDER BY i.redeemed_at DESC LIMIT 1) AS runtime_username`, [sha256(token)]);
    const row = result.rows[0];
    if (!row) return reply.code(401).send({ error: "LAUNCH_INVALID" });
    return { tripId: row.trip_id, userId: row.user_id, role: row.role, runtimeUsername: row.runtime_username, audience: "runtime_gateway" };
  });

  app.get("/internal/runtime-routes/:tripId", async (request, reply) => {
    if (request.headers["x-api-key"] !== deps.runtimeExchangeKey) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
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
