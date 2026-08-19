import Fastify from "fastify";
import type pg from "pg";
import type { ArchitectureProfile } from "./config.js";
import { issueEnrollment, verifyEnrollmentToken, type EnrollmentConfig } from "./enrollment.js";
import { digestTelegramId, verifyTelegramLogin, verifyTelegramWebhookSecret } from "./identity.js";
import { startSession, getSession, submitAnswer, confirmIntake, getSessionStatus } from "./interview.js";
import { structuredLog } from "./redaction.js";
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

export interface AppDependencies {
  readiness?: () => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
  log?: (line: string) => void;
  /** Optional: mount signup routes. Absent in Sprint 0 deployments and unit tests. */
  signup?: SignupDependencies;
  /** Optional: mount enrollment + interview routes (Sprint 2+). */
  interview?: InterviewDependencies;
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
    sprint: 2,
    endpoints: [
      "/healthz", "/readyz",
      "/v1/signup", "/v1/signup/callback", "/v1/signup/status", "/v1/trips/:id",
      "/v1/trips/:id/enrollment",
      "/v1/interview", "/v1/interview/:sessionId", "/v1/interview/:sessionId/answer", "/v1/interview/:sessionId/confirm",
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
  // Returns: { status, requestId? }
  app.post("/v1/signup", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const { signup } = dependencies;

    const body = request.body as Record<string, unknown>;
    const telegramPayload = body?.telegram as Record<string, unknown> | undefined;
    const tripNameRequest = body?.trip_name_request;

    if (!telegramPayload || typeof tripNameRequest !== "string" || tripNameRequest.length < 1 || tripNameRequest.length > 120) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const loginResult = verifyTelegramLogin(telegramPayload, signup.botToken);
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
    const token = callbackQuery?.data;
    const fromId = from?.id;

    if (
      !callbackQuery
      || typeof token !== "string"
      || (typeof fromId !== "number" && typeof fromId !== "string")
    ) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const senderDigest = digestTelegramId(String(fromId));

    const result = await processApprovalCallback(
      signup.db,
      token,
      senderDigest,
      signup.config,
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

  // GET /v1/signup/status — re-authenticate with Telegram to poll status.
  // Query: ?telegram=<base64url-encoded-json>
  app.get("/v1/signup/status", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const query = request.query as Record<string, unknown>;
    const telegramRaw = query?.telegram;
    if (typeof telegramRaw !== "string") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    let telegramPayload: Record<string, unknown>;
    try {
      telegramPayload = JSON.parse(Buffer.from(telegramRaw, "base64url").toString()) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const loginResult = verifyTelegramLogin(telegramPayload, dependencies.signup.botToken);
    if (!loginResult.ok) {
      return reply.code(401).send({ error: loginResult.error });
    }

    const result = await getSignupStatus(
      dependencies.signup.db,
      loginResult.identity.providerSubjectDigest,
    );
    return reply.code(200).send(result);
  });

  // GET /v1/trips/:id — read a trip the authenticated user is a member of.
  // Header: X-Telegram-Login: <base64url-encoded-json of Telegram login data>
  app.get("/v1/trips/:id", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const loginHeader = (request.headers as Record<string, unknown>)["x-telegram-login"];
    if (typeof loginHeader !== "string") {
      return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    }
    let telegramPayload: Record<string, unknown>;
    try {
      telegramPayload = JSON.parse(Buffer.from(loginHeader, "base64url").toString()) as Record<string, unknown>;
    } catch {
      return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    }

    const loginResult = verifyTelegramLogin(telegramPayload, dependencies.signup.botToken);
    if (!loginResult.ok) {
      return reply.code(401).send({ error: loginResult.error });
    }

    const trip = await getTripForMember(
      dependencies.signup.db,
      tripId,
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
  // Header: X-Telegram-Login: <base64url-encoded-json>
  app.post("/v1/trips/:id/enrollment", async (request, reply) => {
    if (!dependencies.interview || !dependencies.signup) {
      return reply.code(503).send({ error: "INTERVIEW_NOT_CONFIGURED" });
    }
    const { interview, signup } = dependencies;
    const params = request.params as Record<string, unknown>;
    const tripId = params?.id;
    if (typeof tripId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    // Authenticate via Telegram login and resolve the internal user id.
    const loginHeader = (request.headers as Record<string, unknown>)["x-telegram-login"];
    if (typeof loginHeader !== "string") return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    let telegramPayload: Record<string, unknown>;
    try {
      telegramPayload = JSON.parse(Buffer.from(loginHeader, "base64url").toString()) as Record<string, unknown>;
    } catch { return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" }); }

    const loginResult = verifyTelegramLogin(telegramPayload, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = 'telegram' AND provider_subject_digest = $1",
      [loginResult.identity.providerSubjectDigest],
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

    const result = await startSession(dependencies.interview.db, rawToken, log);
    if (!result.ok) {
      return reply.code(result.reason === "TRIP_NOT_DRAFT" ? 409 : 401).send({ error: result.reason });
    }

    return reply.code(201).send({
      sessionId: result.sessionId,
      sessionToken: result.sessionToken,
      state: result.view.state,
      nextQuestion: result.view.nextQuestion,
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
      recap: result.view.recap,
    });
  });

  // POST /v1/interview/:sessionId/answer — submit or correct an answer.
  // Header: Authorization: Bearer <session-token>
  // Body: { questionId, optionId?, otherText? }
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

    if (typeof questionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (optionId !== null && typeof optionId !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (otherText !== undefined && typeof otherText !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });

    const result = await submitAnswer(
      dependencies.interview.db,
      rawToken,
      questionId,
      optionId as string | null,
      otherText as string | undefined,
      sessionId,
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
      return reply.code(status).send({ error: result.reason });
    }

    return reply.code(200).send({
      intakeVersionId: result.intakeVersionId,
      digest: result.digest,
      versionNumber: result.versionNumber,
    });
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

    const loginHeader = (request.headers as Record<string, unknown>)["x-telegram-login"];
    if (typeof loginHeader !== "string") return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    let telegramPayload: Record<string, unknown>;
    try {
      telegramPayload = JSON.parse(Buffer.from(loginHeader, "base64url").toString()) as Record<string, unknown>;
    } catch { return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" }); }

    const loginResult = verifyTelegramLogin(telegramPayload, signup.botToken);
    if (!loginResult.ok) return reply.code(401).send({ error: loginResult.error });

    const identityRow = await interview.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = 'telegram' AND provider_subject_digest = $1",
      [loginResult.identity.providerSubjectDigest],
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

  if (dependencies.close) app.addHook("onClose", dependencies.close);
  return app;
}
