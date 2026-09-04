import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import type pg from "pg";
import type { ArchitectureProfile } from "./config.js";
import { resolveTelegramCallbackRef, answerTelegramCallbackQuery } from "./adapters/telegram.js";
import { issueEnrollment, verifyEnrollmentToken, type EnrollmentConfig } from "./enrollment.js";
import { digestTelegramId, verifyTelegramLogin, verifyTelegramWebhookSecret } from "./identity.js";
import {
  startSession, getSession, submitAnswer, confirmIntake, getSessionStatus,
  consularContactsFor, saveConsularContacts, saveSourceDocument,
  getSessionForAgent, submitAnswerForAgent, resolveChatFromOpenTurn,
} from "./interview.js";
import { saveDeferredVenueLinks } from "./venue-links.js";
import { correctIntake } from "./intake-correction.js";
import { issueApproval } from "./plan-approval.js";
import { createOrVerifyPasswordIdentity, verifyPasswordLogin, resolveWebAuth } from "./password-identity.js";
import { generatePlan, getPlan, listAvailableReleases, retryProvision } from "./planner.js";
import { structuredLog } from "./redaction.js";
import { registerPortalRoutes, type PortalDependencies } from "./portal.js";
import {
  startSignup,
  processApprovalCallback,
  getSignupStatus,
  getTripForMember,
  type NotificationAdapter,
  type SignupConfig,
} from "./signup.js";

export interface SignupDependencies {
  db: pg.Pool;
  /** Resolved values from the architecture profile's signup block. */
  config: SignupConfig;
  /** Resolved bot token for Telegram login verification. */
  botToken: string;
  /** Resolved secret registered with Telegram's setWebhook secret_token param. */
  webhookSecret: string;
  notification: NotificationAdapter;
}

export interface InterviewDependencies {
  db: pg.Pool;
  config: EnrollmentConfig;
}

export interface PlannerDependencies {
  db: pg.Pool;
  config: {
    approvalTtlSeconds: number;
  };
}

export interface ProvisionerDependencies {
  db: pg.Pool;
}

export interface ChatRoutingDependencies {
  db: pg.Pool;
  /** Shared secret Hermes's gateway presents as X-API-Key. Same trust tier as INTERVIEW_MCP_KEY. */
  apiKey: string;
}

/**
 * The interviewer agent's entry into an interview the ROUTER started.
 *
 * Separate from `interview` because the credential is different in kind: the
 * interview routes take the organizer's own session token, while these take a
 * service key held by the MCP sidecar, and the interview they act on is named
 * by chat rather than carried by the token.
 */
export interface InterviewAgentDependencies {
  db: pg.Pool;
  /** Presented as X-API-Key. Same trust tier as INTERVIEW_MCP_KEY. */
  apiKey: string;
}

export interface AppDependencies {
  readiness?: () => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
  log?: (line: string) => void;
  /** Optional: mount signup routes. Absent in Sprint 0 deployments and unit tests. */
  signup?: SignupDependencies;
  /** Optional: mount enrollment + interview routes (Sprint 2+). */
  interview?: InterviewDependencies;
  /** Optional: mount planner + approval routes (Sprint 3+). */
  planner?: PlannerDependencies;
  /** Optional: mount intake correction route (Sprint 4+). */
  provisioner?: ProvisionerDependencies;
  /** Optional: mount the internal chat-routing lookup Hermes's gateway calls. */
  chatRouting?: ChatRoutingDependencies;
  /** Optional: mount the organizer web portal routes. */
  portal?: PortalDependencies;
  /** Optional: mount the interviewer agent's chat-addressed interview routes. */
  interviewAgent?: InterviewAgentDependencies;
}

// A driver's message and stack routinely carry the connection string, so the
// only part of a failure worth logging is its SQLSTATE: a fixed five-character
// class code that cannot hold a credential.
function sqlstateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export function buildApp(profile: ArchitectureProfile, dependencies: AppDependencies = {}) {
  const log = dependencies.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const app = Fastify({ logger: false });

  app.get("/", async () => ({
    service: "kinerary-control-plane",
    sprint: 4,
    endpoints: [
      "/healthz", "/readyz",
      "/v1/signup", "/v1/signup/callback", "/v1/signup/status", "/v1/trips/:id",
      "/v1/trips/:id/enrollment", "/v1/trips/:id/plan", "/v1/trips/:id/plan/retry", "/v1/trips/:id/intake/correct",
      "/v1/interview", "/v1/interview/:sessionId", "/v1/interview/:sessionId/answer", "/v1/interview/:sessionId/confirm",
      "/v1/interview/:sessionId/consular", "/v1/interview/:sessionId/source-document",
      "/v1/interview/:sessionId/venue-links",
      "/v1/plans/:planId", "/v1/plans/:planId/approve",
      "/v1/releases",
      "/internal/telegram-interviews/bind",
    ],
  }));

  app.get("/healthz", async () => ({ status: "ok", service: "control-plane-api" }));

  app.get("/readyz", async (_request, reply) => {
    if (!dependencies.readiness) {
      log(structuredLog("error", "readiness.unconfigured", { safe_error_code: "READINESS_UNCONFIGURED" }));
      return reply.code(503).send({ status: "not_ready", reason: "readiness_unconfigured" });
    }
    try {
      const details = await dependencies.readiness();
      return { status: "ready", profile_version: profile.version, ...details };
    } catch (error) {
      log(structuredLog("error", "readiness.check_failed", {
        safe_error_code: "DATABASE_UNAVAILABLE",
        sqlstate: sqlstateOf(error),
      }));
      return reply.code(503).send({ status: "not_ready", reason: "database_unavailable" });
    }
  });

  // ── Sprint 1: Signup routes ─────────────────────────────────────────────────

  // POST /v1/signup — start or resume the signup approval flow.
  // Body: { telegram: <Telegram Login Widget data>, trip_name_request: string }
  //    or { password: { email, password }, trip_name_request: string } —
  //    stopgap path, see password-identity.ts's module doc.
  // Returns: { status, requestId? }
  app.post("/v1/signup", async (request, reply) => {
    if (dependencies.portal) return reply.code(410).send({ error: "TELEGRAM_WEB_AUTH_RETIRED" });
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const { signup } = dependencies;

    const body = request.body as Record<string, unknown>;
    const telegramPayload = body?.telegram as Record<string, unknown> | undefined;
    const passwordPayload = body?.password as Record<string, unknown> | undefined;
    const tripNameRequest = body?.trip_name_request;

    if ((!telegramPayload && !passwordPayload) || typeof tripNameRequest !== "string" || tripNameRequest.length < 1 || tripNameRequest.length > 120) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const loginResult = telegramPayload
      ? verifyTelegramLogin(telegramPayload, signup.botToken)
      : await createOrVerifyPasswordIdentity(signup.db, passwordPayload!);
    if (!loginResult.ok) {
      log(structuredLog("warn", "signup.login_rejected", { safe_error_code: loginResult.error }));
      return reply.code(401).send({ error: loginResult.error });
    }

    const result = await startSignup(
      signup.db,
      loginResult.identity,
      tripNameRequest,
      signup.config,
      signup.notification,
      log,
    );

    return reply.code(200).send(result);
  });

  // POST /v1/signup/callback — Telegram's webhook target, called directly by
  // Telegram when the super-admin clicks Approve or Reject. The signed action
  // token was embedded in the keyboard button's callback_data.
  //
  // The sender identity is NEVER taken from request-body input: it is derived
  // from callback_query.from.id on a request that first passes the
  // X-Telegram-Bot-Api-Secret-Token check. That header is only ever sent by
  // Telegram itself (configured via setWebhook's secret_token), and
  // digestTelegramId has no server-side key, so trusting a client-supplied
  // digest here would let anyone who obtains a valid action token approve or
  // reject requests directly.
  //
  // Body (Telegram Update object): { callback_query: { from: { id }, data } }
  app.post("/v1/signup/callback", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const { signup } = dependencies;

    const secretHeader = (request.headers as Record<string, unknown>)["x-telegram-bot-api-secret-token"];
    if (!verifyTelegramWebhookSecret(secretHeader, signup.webhookSecret)) {
      log(structuredLog("warn", "signup.callback_webhook_unauthorized", { safe_error_code: "WEBHOOK_SECRET_INVALID" }));
      return reply.code(401).send({ error: "WEBHOOK_SECRET_INVALID" });
    }

    const body = request.body as Record<string, unknown>;
    const callbackQuery = body?.callback_query as Record<string, unknown> | undefined;
    const from = callbackQuery?.from as Record<string, unknown> | undefined;
    const callbackData = callbackQuery?.data;
    const callbackQueryId = callbackQuery?.id;
    const fromId = from?.id;

    if (
      !callbackQuery
      || typeof callbackData !== "string"
      || typeof callbackQueryId !== "string"
      || (typeof fromId !== "number" && typeof fromId !== "string")
    ) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    // A real Telegram button only ever carries a short callback_data ref
    // (see db/migrations/0014 — the actual signed token is too long for
    // Telegram's 64-byte limit and never appears in the request at all).
    // Resolving it back to the real token here is a pure transport-layer
    // expansion; verifyApprovalAction below still does the exact same HMAC
    // and expiry check it always has, on the exact same token shape.
    //
    // Existing tests that hand this route a raw signed token directly
    // (bypassing an actual Telegram round trip) keep working unmodified: a
    // full token never matches a stored ref, so resolution falls through
    // and the value is used as-is, same as before this indirection existed.
    const resolvedToken = await resolveTelegramCallbackRef(signup.db, callbackData) ?? callbackData;

    const senderDigest = digestTelegramId(String(fromId));

    const result = await processApprovalCallback(
      signup.db,
      resolvedToken,
      senderDigest,
      signup.config,
    );

    // Best-effort: Telegram shows a loading spinner on the tapped button
    // until this is called. A failure here must never mask the real
    // approve/reject outcome already computed above.
    void answerTelegramCallbackQuery(
      signup.botToken,
      callbackQueryId,
      result.outcome === "approved" ? "Approved"
        : result.outcome === "rejected" ? "Rejected"
        : result.outcome === "already_decided" ? "Already decided"
        : "Could not process this action",
      log,
    );

    if (result.outcome === "error") {
      const status = result.reason === "WRONG_SENDER" ? 403
        : result.reason === "REQUEST_NOT_FOUND" ? 404
        : 400;
      log(structuredLog("warn", "signup.callback_rejected", { safe_error_code: result.reason }));
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(200).send(result);
  });

  // GET /v1/signup/status — re-authenticate to poll status.
  // Query: ?telegram=<base64url-encoded-json> or ?password=<base64url-encoded-json>
  app.get("/v1/signup/status", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const query = request.query as Record<string, unknown>;
    const telegramRaw = query?.telegram;
    const passwordRaw = query?.password;
    if (typeof telegramRaw !== "string" && typeof passwordRaw !== "string") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from((telegramRaw ?? passwordRaw) as string, "base64url").toString()) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const loginResult = typeof telegramRaw === "string"
      ? verifyTelegramLogin(payload, dependencies.signup.botToken)
      : await verifyPasswordLogin(dependencies.signup.db, payload);
    if (!loginResult.ok) {
      return reply.code(401).send({ error: loginResult.error });
    }

    const result = await getSignupStatus(
      dependencies.signup.db,
      loginResult.identity.provider,
      loginResult.identity.providerSubjectDigest,
    );
    return reply.code(200).send(result);
  });

  // GET /v1/trips/:id — read a trip the authenticated user is a member of.
  // Header: X-Telegram-Login or X-Portal-Password-Login (base64url JSON)
  if (!dependencies.portal) app.get("/v1/trips/:id", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const loginResult = await resolveWebAuth(
      request.headers as Record<string, unknown>, dependencies.signup.db, verifyTelegramLogin, dependencies.signup.botToken,
    );
    if (!loginResult.ok) {
      return reply.code(401).send({ error: loginResult.error });
    }

    const trip = await getTripForMember(
      dependencies.signup.db,
      tripId,
      loginResult.identity.provider,
      loginResult.identity.providerSubjectDigest,
    );
    if (!trip) {
      // Return 404 for both "not found" and "not a member" — don't distinguish
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    return reply.code(200).send(trip);
  });

  // ── Sprint 2: Enrollment + Interview routes ───────────────────────────────

  // ── Sprint 2: Enrollment + Interview routes ───────────────────────────────

  // POST /v1/trips/:id/enrollment — issue an enrollment link for the trip owner.
  // The organizer sends this link to the Hermes interviewer to start the interview.
  // Header: X-Telegram-Login or X-Portal-Password-Login (base64url JSON)
  app.post("/v1/trips/:id/enrollment", async (request, reply) => {
    if (!dependencies.interview || !dependencies.signup) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }
    const { interview, signup } = dependencies;
    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    // Authenticate and resolve the internal user id.
    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      [loginResult.identity.provider, loginResult.identity.providerSubjectDigest],
    );
    const [identity] = identityRow.rows;
    if (!identity) return reply.code(401).send({ error: "UNKNOWN_USER" });

    const result = await issueEnrollment(interview.db, identity.user_id, tripId, interview.config, log);
    if (!result.ok) {
      const status = result.reason === "NOT_OWNER" ? 403 : 409;
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(201).send({
      enrollmentId: result.enrollmentId,
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  // POST /v1/interview — start an interview session by exchanging an enrollment token.
  // Header: Authorization: Bearer <enrollment-token>
  // This is the narrow entry point for the Hermes interviewer agent.
  app.post("/v1/interview", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }

    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    // Pre-validate before taking side effects (gives a clearer error reason).
    const check = await verifyEnrollmentToken(dependencies.interview.db, rawToken);
    if (!check.ok) {
      const status = check.reason === "ALREADY_CONSUMED" || check.reason === "REVOKED" ? 409 : 401;
      return reply.code(status).send({ error: check.reason });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const telegramChatId = typeof body.telegramChatId === "string" ? body.telegramChatId : undefined;
    const result = await startSession(dependencies.interview.db, rawToken, log, telegramChatId);
    if (!result.ok) {
      return reply.code(result.reason === "TRIP_NOT_DRAFT" ? 409 : 401).send({ error: result.reason });
    }

    return reply.code(201).send({
      sessionId: result.sessionId,
      sessionToken: result.sessionToken,
      state: result.view.state,
      nextQuestion: result.view.nextQuestion,
      optionalRemaining: result.view.optionalRemaining,
    });
  });

  // GET /v1/interview/:sessionId — get the current session view (no answer transcript).
  // Header: Authorization: Bearer <session-token>
  app.get("/v1/interview/:sessionId", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }

    const params = request.params as Record<string, unknown>;
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const result = await getSession(dependencies.interview.db, rawToken);
    if (!result.ok) return reply.code(401).send({ error: result.reason });

    // The path's sessionId must match the token's session (prevents probing other sessions).
    if (result.view.sessionId !== sessionId) return reply.code(404).send({ error: "NOT_FOUND" });

    return reply.code(200).send({
      sessionId: result.view.sessionId,
      state: result.view.state,
      nextQuestion: result.view.nextQuestion,
      optionalRemaining: result.view.optionalRemaining,
      recap: result.view.recap,
    });
  });

  // POST /v1/interview/:sessionId/answer — submit or correct an answer.
  // Header: Authorization: Bearer <session-token>
  // Body: { questionId, optionId?, otherText?, data?, optionIds? }
  // `data` carries the payload for "structured" questions (e.g. travelers,
  // phases) — a JSON array/object rather than a string.
  // `optionIds` carries every selected id for a "multi_choice" question.
  app.post("/v1/interview/:sessionId/answer", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }

    const params = request.params as Record<string, unknown>;
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const body = request.body as Record<string, unknown> | undefined;
    const questionId = body?.questionId;
    const optionId = body?.optionId ?? null;
    const otherText = body?.otherText;
    const structuredData = body?.data;
    const optionIds = body?.optionIds;

    if (typeof questionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (optionId !== null && typeof optionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (otherText !== undefined && typeof otherText !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Reject a non-string element here rather than letting validateAnswer's
    // option lookup coerce it — an id must be a literal option id, and a
    // number or object that stringifies into one is not that.
    if (optionIds !== undefined && (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string"))) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const result = await submitAnswer(
      dependencies.interview.db,
      rawToken,
      questionId,
      optionId as string | null,
      otherText as string | undefined,
      sessionId,
      structuredData,
      optionIds as string[] | undefined,
    );

    if (!result.ok) {
      const status = result.reason === "NOT_FOUND" ? 404
        : result.reason === "SESSION_CONFIRMED" ? 409
        : 400;
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(200).send({
      state: result.view.state,
      nextQuestion: result.view.nextQuestion,
      optionalRemaining: result.view.optionalRemaining,
      recap: result.view.recap,
    });
  });

  // POST /v1/interview/:sessionId/confirm — CONFIRM: produce an immutable intake version.
  // Header: Authorization: Bearer <session-token>
  app.post("/v1/interview/:sessionId/confirm", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }

    const params = request.params as Record<string, unknown>;
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const result = await confirmIntake(dependencies.interview.db, rawToken, log, sessionId);

    if (!result.ok) {
      const status = result.reason === "NOT_FOUND" ? 404 : 422;
      // unsafePath names the offending field, never its value — same rule
      // UnsafeCanonicalRecordError itself follows.
      return reply.code(status).send(
        result.reason === "UNSAFE_ANSWER_CONTENT"
          ? { error: result.reason, unsafePath: result.unsafePath }
          : { error: result.reason },
      );
    }

    return reply.code(200).send({
      intakeVersionId: result.intakeVersionId,
      digest: result.digest,
      versionNumber: result.versionNumber,
    });
  });

  // POST /v1/interview/:sessionId/consular — read or populate the cross-trip
  // consular-contacts store (control_plane.country_reference).
  // Header: Authorization: Bearer <session-token>
  // Body: { destination, homeCountry, contacts?, source? }
  //   - contacts omitted → read: { found, contacts, fetchedAt? }. `found` is
  //     true only when a cached row exists and is fresh; the interviewer's tool
  //     then skips the web search.
  //   - contacts present → upsert the row the web search produced and echo the
  //     cleaned list back.
  app.post("/v1/interview/:sessionId/consular", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }
    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const destination = body.destination;
    const homeCountry = body.homeCountry;
    if (typeof destination !== "string" || typeof homeCountry !== "string") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const db = dependencies.interview.db;
    if (body.contacts === undefined) {
      const read = await consularContactsFor(db, rawToken, destination, homeCountry);
      if (!read.ok) {
        return reply.code(read.reason === "NOT_FOUND" ? 404 : 400).send({ error: read.reason });
      }
      return reply.code(200).send({ found: read.found, contacts: read.contacts, fetchedAt: read.fetchedAt });
    }

    const saved = await saveConsularContacts(
      db, rawToken, destination, homeCountry, body.contacts,
      typeof body.source === "string" ? body.source : undefined,
    );
    if (!saved.ok) {
      const status = saved.reason === "NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({ error: saved.reason });
    }
    return reply.code(200).send({ contacts: saved.contacts });
  });

  // POST /v1/interview/:sessionId/source-document — stage the raw plan document
  // the organizer shared, for later re-extraction. Copied onto the immutable
  // intake_versions row at confirm. Best-effort: the interviewer already
  // extracted from it live, so a failure here is not fatal.
  // Header: Authorization: Bearer <session-token>. Body: { text, filename? }
  app.post("/v1/interview/:sessionId/source-document", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }
    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.text !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const result = await saveSourceDocument(
      dependencies.interview.db, rawToken, body.text,
      typeof body.filename === "string" ? body.filename : undefined,
    );
    if (!result.ok) {
      return reply.code(result.reason === "NOT_FOUND" ? 404 : 400).send({ error: result.reason });
    }
    return reply.code(200).send({ chars: result.chars });
  });

  // POST /v1/interview/:sessionId/venue-links — park venue names whose
  // interview-time ticket/official-URL search was rate-limited, for the API's
  // background drain (resolvePendingVenueLinks) to retry. Best-effort; the
  // venue still shows its Maps/Waze links without a ticket URL.
  // Header: Authorization: Bearer <session-token>. Body: { destination, deferred: string[] }
  app.post("/v1/interview/:sessionId/venue-links", async (request, reply) => {
    if (!dependencies.interview) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }
    const authHeader = (request.headers as Record<string, unknown>)["authorization"];
    const rawToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7) : null;
    if (!rawToken) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.destination !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const result = await saveDeferredVenueLinks(
      dependencies.interview.db, rawToken, body.destination, body.deferred,
    );
    if (!result.ok) {
      return reply.code(result.reason === "NOT_FOUND" ? 404 : 400).send({ error: result.reason });
    }
    return reply.code(200).send({ queued: result.queued });
  });

  // GET /v1/interview/:sessionId/status — lifecycle status for the organizer status UI.
  // Does not expose any answer or transcript content.
  // Header: X-Telegram-Login (identifies the organizer without the session token)
  app.get("/v1/interview/:sessionId/status", async (request, reply) => {
    if (!dependencies.interview || !dependencies.signup) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }
    const { interview, signup } = dependencies;

    const params = request.params as Record<string, unknown>;
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      [loginResult.identity.provider, loginResult.identity.providerSubjectDigest],
    );
    const [identity] = identityRow.rows;
    if (!identity) return reply.code(401).send({ error: "UNKNOWN_USER" });

    const result = await getSessionStatus(interview.db, sessionId, identity.user_id);
    if (!result.ok) {
      return reply.code(result.reason === "NOT_FOUND" ? 404 : 403).send({ error: result.reason });
    }

    return reply.code(200).send({
      state: result.state,
      ...(result.intakeVersionId ? { intakeVersionId: result.intakeVersionId, digest: result.digest } : {}),
    });
  });

  // ── Sprint 3: Planner + Approval routes ──────────────────────────────────

  // GET /v1/releases — list available releases (Telegram auth required).
  app.get("/v1/releases", async (request, reply) => {
    if (!dependencies.planner || !dependencies.signup) {
      return reply.code(503).send({ error: "PLANNER_NOT_CONFIGURED" });
    }

    const loginResult = await resolveWebAuth(
      request.headers as Record<string, unknown>, dependencies.signup.db, verifyTelegramLogin, dependencies.signup.botToken,
    );
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const releases = await listAvailableReleases(dependencies.planner.db);
    return reply.code(200).send({ releases });
  });

  // POST /v1/trips/:id/plan — generate a provisioning plan from confirmed intake.
  // Header: X-Telegram-Login
  app.post("/v1/trips/:id/plan", async (request, reply) => {
    if (!dependencies.planner || !dependencies.signup || !dependencies.interview) {
      return reply.code(503).send({ error: "PLANNER_NOT_CONFIGURED" });
    }
    const { planner, signup, interview } = dependencies;

    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    // Verify the caller is an owner of this trip.
    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      [loginResult.identity.provider, loginResult.identity.providerSubjectDigest],
    );
    const identity = identityRow.rows[0];
    if (!identity) return reply.code(401).send({ error: "UNKNOWN_USER" });

    const memberRow = await planner.db.query(
      "SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'",
      [tripId, identity.user_id],
    );
    if (!memberRow.rows[0]) return reply.code(403).send({ error: "NOT_OWNER" });

    const correlationId = `corr_${randomBytes(12).toString("hex")}`;
    const result = await generatePlan(planner.db, tripId, correlationId);

    if (!result.ok) {
      const status = result.reason === "PLAN_ALREADY_PENDING" ? 409
        : result.reason === "NO_COMPATIBLE_RELEASE" ? 422
        : 409;
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(201).send({
      planId: result.planId,
      planDigest: result.planDigest,
      releaseId: result.releaseId,
      jobId: result.jobId,
    });
  });

  // POST /v1/trips/:id/plan/retry — re-run provisioning for a trip whose
  // previous attempt is finished (terminally failed, or succeeded and being
  // replaced) without a manual database edit. Supersedes any active plan,
  // cancels its non-terminal jobs, reverts to intake_confirmed, and generates
  // a fresh plan + job from the latest confirmed intake.
  // Header: X-Telegram-Login (trip owner only)
  app.post("/v1/trips/:id/plan/retry", async (request, reply) => {
    if (!dependencies.planner || !dependencies.signup || !dependencies.interview) {
      return reply.code(503).send({ error: "PLANNER_NOT_CONFIGURED" });
    }
    const { planner, signup, interview } = dependencies;

    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      [loginResult.identity.provider, loginResult.identity.providerSubjectDigest],
    );
    const identity = identityRow.rows[0];
    if (!identity) return reply.code(401).send({ error: "UNKNOWN_USER" });

    const memberRow = await planner.db.query(
      "SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'",
      [tripId, identity.user_id],
    );
    if (!memberRow.rows[0]) return reply.code(403).send({ error: "NOT_OWNER" });

    const correlationId = `corr_${randomBytes(12).toString("hex")}`;
    const result = await retryProvision(planner.db, tripId, correlationId);

    if (!result.ok) {
      const status = result.reason === "TRIP_NOT_FOUND" ? 404
        : result.reason === "NO_COMPATIBLE_RELEASE" ? 422
        : 409;
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(201).send({
      planId: result.planId,
      planDigest: result.planDigest,
      releaseId: result.releaseId,
      jobId: result.jobId,
      supersededPlanId: result.supersededPlanId,
    });
  });

  // GET /v1/plans/:planId — get plan details (owner or super-admin).
  // Header: X-Telegram-Login
  app.get("/v1/plans/:planId", async (request, reply) => {
    if (!dependencies.planner || !dependencies.signup || !dependencies.interview) {
      return reply.code(503).send({ error: "PLANNER_NOT_CONFIGURED" });
    }
    const { planner, signup, interview } = dependencies;

    const params = request.params as Record<string, unknown>;
    const planId = params?.planId;
    if (typeof planId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    // Resolve caller's user_id.
    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      [loginResult.identity.provider, loginResult.identity.providerSubjectDigest],
    );
    const identity = identityRow.rows[0];
    if (!identity) return reply.code(401).send({ error: "UNKNOWN_USER" });

    // Resolve the plan and its trip.
    const planRow = await planner.db.query<{ trip_id: string }>(
      "SELECT trip_id FROM control_plane.plans WHERE id = $1",
      [planId],
    );
    const planMeta = planRow.rows[0];
    if (!planMeta) return reply.code(404).send({ error: "NOT_FOUND" });

    // Caller must be a member of the trip.
    const memberRow = await planner.db.query(
      "SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND status = 'active'",
      [planMeta.trip_id, identity.user_id],
    );
    if (!memberRow.rows[0]) return reply.code(404).send({ error: "NOT_FOUND" });

    const result = await getPlan(planner.db, planId, planMeta.trip_id);
    if (!result.ok) return reply.code(404).send({ error: "NOT_FOUND" });

    const { plan } = result;
    return reply.code(200).send({
      id: plan.id,
      tripId: plan.tripId,
      releaseId: plan.releaseId,
      kind: plan.kind,
      digest: plan.digest,
      status: plan.status,
    });
  });

  // POST /v1/plans/:planId/approve — approve a pending plan.
  // Header: X-Telegram-Login (trip owner only for Sprint 3)
  app.post("/v1/plans/:planId/approve", async (request, reply) => {
    if (!dependencies.planner || !dependencies.signup || !dependencies.interview) {
      return reply.code(503).send({ error: "PLANNER_NOT_CONFIGURED" });
    }
    const { planner, signup, interview } = dependencies;

    const params = request.params as Record<string, unknown>;
    const planId = params?.planId;
    if (typeof planId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      [loginResult.identity.provider, loginResult.identity.providerSubjectDigest],
    );
    const identity = identityRow.rows[0];
    if (!identity) return reply.code(401).send({ error: "UNKNOWN_USER" });

    // Caller must be the trip owner.
    const planRow = await planner.db.query<{ trip_id: string }>(
      "SELECT trip_id FROM control_plane.plans WHERE id = $1",
      [planId],
    );
    const planMeta = planRow.rows[0];
    if (!planMeta) return reply.code(404).send({ error: "NOT_FOUND" });

    const memberRow = await planner.db.query(
      "SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'",
      [planMeta.trip_id, identity.user_id],
    );
    if (!memberRow.rows[0]) return reply.code(403).send({ error: "NOT_OWNER" });

    const actorRef = `user:${identity.user_id}`;
    const result = await issueApproval(planner.db, planId, actorRef, planner.config.approvalTtlSeconds);

    if (!result.ok) {
      const status = result.reason === "PLAN_NOT_FOUND" ? 404
        : result.reason === "ALREADY_APPROVED" ? 409
        : 422;
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(200).send({
      approvalId: result.approvalId,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  // ── Sprint 4: Intake correction route ────────────────────────────────────────

  // POST /v1/trips/:id/intake/correct — create a new confirmed intake version,
  // supersede the active plan, and revert the trip to intake_confirmed so the
  // organizer can generate a new plan. Requires the trip owner.
  // Header: X-Telegram-Login (trip owner only)
  // Body: { answers: { [questionId]: answer } }
  app.post("/v1/trips/:id/intake/correct", async (request, reply) => {
    if (!dependencies.provisioner || !dependencies.signup) {
      return reply.code(503).send({ error: "PROVISIONER_NOT_CONFIGURED" });
    }
    const { provisioner, signup } = dependencies;

    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    // Authenticate the caller.
    const loginResult = await resolveWebAuth(request.headers as Record<string, unknown>, signup.db, verifyTelegramLogin, signup.botToken);
    if (!loginResult.ok) {
      return reply.code(401).send({ error: loginResult.error });
    }

    // Verify the caller is the trip owner.
    const membership = await provisioner.db.query<{ role: string }>(
      `SELECT tm.role FROM control_plane.trip_memberships tm
       JOIN   control_plane.user_identities ui ON ui.user_id = tm.user_id
       WHERE  tm.trip_id = $1
         AND  tm.status = 'active'
         AND  tm.role = 'owner'
         AND  ui.provider_subject_digest = $2`,
      [tripId, loginResult.identity.providerSubjectDigest],
    );
    if (membership.rowCount === 0) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }

    const body = request.body as Record<string, unknown>;
    const answers = body?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const actorRef = `user:${loginResult.identity.providerSubjectDigest}`;
    const result = await correctIntake(
      provisioner.db,
      tripId,
      actorRef,
      answers as Record<string, unknown>,
    );

    if (!result.ok) {
      const status = result.reason === "TRIP_NOT_FOUND" ? 404
        : result.reason === "INVALID_STATE" ? 409
        : result.reason === "INVALID_ANSWERS" || result.reason === "UNSAFE_ANSWER_CONTENT" ? 422
        : 400;
      return reply.code(status).send(
        result.reason === "UNSAFE_ANSWER_CONTENT"
          ? { error: result.reason, unsafePath: result.unsafePath }
          : { error: result.reason },
      );
    }

    return reply.code(200).send({
      versionId: result.versionId,
      version: result.version,
      digest: result.digest,
    });
  });

  // Internal only — never exposed to organizers/families, never routed
  // through Telegram-login auth. Trust is a single shared key, same tier as
  // interview-mcp.ts's INTERVIEW_MCP_KEY: the caller is Hermes's gateway
  // process deciding which profile's HERMES_HOME serves an inbound chat, not
  // a human. Returns only a trip id and a profile name — no trip content, no
  // credentials — so a leaked response is low-value on its own.
  // ── The interviewer agent's interview routes ───────────────────────────────
  //
  // Both are addressed by chat rather than by session token, because the
  // session was created by the router from a /start <enrollment_token> deep
  // link and the agent was never handed a token for it.
  //
  // The chat named in the request is matched against the turn the router
  // opened when it forwarded — see migration 0031 and lockSession's "agent"
  // branch, which does that matching inside the same transaction as the write.
  // A chat with no open turn resolves to no session and comes back 404.
  //
  // FUTURE: replace the supplied chat id with gateway-injected trusted context
  // once the relay contract can carry it.

  function agentAuth(request: { headers: unknown }): boolean {
    const deps = dependencies.interviewAgent;
    if (!deps) return false;
    const providedKey = (request.headers as Record<string, unknown>)["x-api-key"];
    return typeof providedKey === "string" && providedKey.length > 0 && providedKey === deps.apiKey;
  }

  // GET|POST /internal/interview/agent/current[...] — the same two operations,
  // for an agent that cannot name its own chat.
  //
  // It cannot: the gateway sets the chat id on the agent object but never
  // renders it into the prompt, so the model has no per-turn access to it.
  // Asking it for one produced the first live run's failure — no write at all,
  // and an invented interview on top.
  //
  // Registered as literal segments so Fastify's static-over-parametric
  // precedence keeps them off the :chatId route; a Telegram chat id is numeric
  // and can never collide with "current" regardless.
  //
  // The authorization story is unchanged, and slightly stronger: these routes
  // were always gated on the router's open turn rather than on the id the
  // caller supplied. Removing the id removes the only thing the model could
  // have gotten wrong.
  async function resolveCurrentChat(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<string | null> {
    const resolved = await resolveChatFromOpenTurn(dependencies.interviewAgent!.db);
    if (resolved.ok) return resolved.chatId;
    // AMBIGUOUS is 409, not 404: nothing is missing, the request cannot be
    // attributed. Telling those apart is what stops a retry loop against a
    // second organizer's live interview.
    reply.code(resolved.reason === "AMBIGUOUS" ? 409 : 404).send({ error: resolved.reason });
    return null;
  }

  app.get("/internal/interview/agent/current", async (request, reply) => {
    if (!dependencies.interviewAgent) {
      return reply.code(503).send({ error: "INTERVIEW_AGENT_NOT_CONFIGURED" });
    }
    if (!agentAuth(request)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const chatId = await resolveCurrentChat(reply);
    if (chatId === null) return reply;

    const result = await getSessionForAgent(dependencies.interviewAgent.db, chatId);
    if (!result.ok) return reply.code(404).send({ error: result.reason });
    return reply.code(200).send(result.view);
  });

  app.post("/internal/interview/agent/current/answer", async (request, reply) => {
    if (!dependencies.interviewAgent) {
      return reply.code(503).send({ error: "INTERVIEW_AGENT_NOT_CONFIGURED" });
    }
    if (!agentAuth(request)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const chatId = await resolveCurrentChat(reply);
    if (chatId === null) return reply;

    const body = request.body as Record<string, unknown> | undefined;
    const questionId = body?.questionId;
    const optionId = body?.optionId ?? null;
    const otherText = body?.otherText;
    const structuredData = body?.data;
    const optionIds = body?.optionIds;

    if (typeof questionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (optionId !== null && typeof optionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (otherText !== undefined && typeof otherText !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (optionIds !== undefined && (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string"))) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const result = await submitAnswerForAgent(
      dependencies.interviewAgent.db,
      chatId,
      questionId,
      optionId as string | null,
      otherText as string | undefined,
      structuredData,
      optionIds as string[] | undefined,
    );

    if (!result.ok) {
      const status = result.reason === "NOT_FOUND" ? 404
        : result.reason === "SESSION_CONFIRMED" ? 409
        : 400;
      return reply.code(status).send({ error: result.reason });
    }
    return reply.code(200).send({ state: result.view.state, view: result.view });
  });

  // GET /internal/interview/agent/:chatId — the session view for an open turn.
  app.get("/internal/interview/agent/:chatId", async (request, reply) => {
    if (!dependencies.interviewAgent) {
      return reply.code(503).send({ error: "INTERVIEW_AGENT_NOT_CONFIGURED" });
    }
    if (!agentAuth(request)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const params = request.params as Record<string, unknown>;
    const chatId = params?.chatId;
    if (typeof chatId !== "string" || chatId.length === 0) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const result = await getSessionForAgent(dependencies.interviewAgent.db, chatId);
    if (!result.ok) return reply.code(404).send({ error: result.reason });
    return reply.code(200).send(result.view);
  });

  // POST /internal/interview/agent/:chatId/answer — record a resolved answer.
  //
  // The agent's job is the judgement the deterministic layer cannot do:
  // turning "Vienna and Prague" into a destination, a date phrased in words
  // into a normalised one. What arrives here is the RESULT of that, and it
  // goes through validateAnswer exactly like every other answer.
  app.post("/internal/interview/agent/:chatId/answer", async (request, reply) => {
    if (!dependencies.interviewAgent) {
      return reply.code(503).send({ error: "INTERVIEW_AGENT_NOT_CONFIGURED" });
    }
    if (!agentAuth(request)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });

    const params = request.params as Record<string, unknown>;
    const chatId = params?.chatId;
    if (typeof chatId !== "string" || chatId.length === 0) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const body = request.body as Record<string, unknown> | undefined;
    const questionId = body?.questionId;
    const optionId = body?.optionId ?? null;
    const otherText = body?.otherText;
    const structuredData = body?.data;
    const optionIds = body?.optionIds;

    if (typeof questionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (optionId !== null && typeof optionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (otherText !== undefined && typeof otherText !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Same reason as the token-authenticated route: an id must be a literal
    // option id, not something that stringifies into one.
    if (optionIds !== undefined && (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string"))) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const result = await submitAnswerForAgent(
      dependencies.interviewAgent.db,
      chatId,
      questionId,
      optionId as string | null,
      otherText as string | undefined,
      structuredData,
      optionIds as string[] | undefined,
    );

    if (!result.ok) {
      const status = result.reason === "NOT_FOUND" ? 404
        : result.reason === "SESSION_CONFIRMED" ? 409
        : 400;
      return reply.code(status).send({ error: result.reason });
    }
    return reply.code(200).send({ state: result.view.state, view: result.view });
  });

  app.get("/internal/telegram-chat-bindings/:chatId", async (request, reply) => {
    if (!dependencies.chatRouting) {
      return reply.code(503).send({ error: "CHAT_ROUTING_NOT_CONFIGURED" });
    }
    const { db, apiKey } = dependencies.chatRouting;
    const providedKey = (request.headers as Record<string, unknown>)["x-api-key"];
    if (typeof providedKey !== "string" || providedKey.length === 0 || providedKey !== apiKey) {
      return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    }
    const params = request.params as Record<string, unknown>;
    const chatId = params?.chatId;
    if (typeof chatId !== "string" || chatId.length === 0) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    // `closed_at IS NULL` is load-bearing, not tidiness. Migration 0029 keeps
    // closed bindings as history, so an unfiltered read would route a group to
    // a trip it was deliberately detached from — on a shared bot, that is
    // another organizer's trip.
    const result = await db.query<{ trip_id: string; hermes_profile: string }>(
      `SELECT trip_id, hermes_profile
       FROM control_plane.telegram_chat_bindings
       WHERE chat_id = $1 AND closed_at IS NULL`,
      [chatId],
    );
    const [row] = result.rows;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.code(200).send({ tripId: row.trip_id, hermesProfile: row.hermes_profile });
  });

  // The shared Telegram bot exchanges a deep-link token for an interview and
  // binds only that verified chat to the resulting session. No web-login
  // identity is created or modified by this path.
  app.post("/internal/telegram-interviews/bind", async (request, reply) => {
    if (!dependencies.chatRouting || !dependencies.interview) return reply.code(503).send({ error: "INTERVIEW_BINDING_NOT_CONFIGURED" });
    const providedKey = (request.headers as Record<string, unknown>)["x-api-key"];
    if (providedKey !== dependencies.chatRouting.apiKey) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const body = request.body as Record<string, unknown>;
    const chatId = typeof body.chatId === "string" && /^-?[0-9]{1,20}$/.test(body.chatId) ? body.chatId : null;
    const enrollmentToken = typeof body.enrollmentToken === "string" ? body.enrollmentToken : null;
    if (!chatId || !enrollmentToken) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const active = await dependencies.interview.db.query("SELECT 1 FROM control_plane.telegram_interview_bindings WHERE chat_id = $1 AND state = 'active'", [chatId]);
    if (active.rows[0]) return reply.code(409).send({ error: "CHAT_ALREADY_BOUND" });
    const started = await startSession(dependencies.interview.db, enrollmentToken, log);
    if (!started.ok) return reply.code(started.reason === "TRIP_NOT_DRAFT" ? 409 : 401).send({ error: started.reason });
    try {
      await dependencies.interview.db.query(
        `INSERT INTO control_plane.telegram_interview_bindings(chat_id, trip_id, session_id, state)
         VALUES ($1, $2, $3, 'active')`, [chatId, started.view.tripId, started.sessionId]);
    } catch (error) {
      // A chat binding race must not reveal the newly minted bearer. Remove
      // the losing session and return the trip to draft so the organizer can
      // issue a fresh one-time link.
      const client = await dependencies.interview.db.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM control_plane.intake_sessions WHERE id = $1", [started.sessionId]);
        await client.query("UPDATE control_plane.trips SET lifecycle_state = 'draft', updated_at = now() WHERE id = $1 AND lifecycle_state = 'intake_in_progress'", [started.view.tripId]);
        await client.query("COMMIT");
      } catch { await client.query("ROLLBACK"); } finally { client.release(); }
      return reply.code(409).send({ error: "CHAT_ALREADY_BOUND" });
    }
    return reply.code(201).send({ sessionId: started.sessionId, sessionToken: started.sessionToken, tripId: started.view.tripId });
  });

  if (dependencies.portal) { app.get("/v1/auth/telegram", async (_request, reply) => reply.code(410).send({ error: "TELEGRAM_WEB_AUTH_RETIRED" })); registerPortalRoutes(app, dependencies.portal); }

  if (dependencies.close) app.addHook("onClose", dependencies.close);
  return app;
}
