import Fastify from "fastify";
import type pg from "pg";
import type { ArchitectureProfile } from "./config.js";
import { verifyTelegramLogin } from "./identity.js";
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
  notification: NotificationAdapter;
}

export interface AppDependencies {
  readiness?: () => Promise<Record<string, unknown>>;
  close?: () => Promise<void>;
  log?: (line: string) => void;
  /** Optional: mount signup routes. Absent in Sprint 0 deployments and unit tests. */
  signup?: SignupDependencies;
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
    sprint: 1,
    endpoints: ["/healthz", "/readyz", "/v1/signup", "/v1/signup/callback", "/v1/trips/:id"],
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

  // POST /v1/signup/callback — called by the Telegram bot webhook when the
  // super-admin clicks Approve or Reject. The signed action token was embedded
  // in the Telegram keyboard button's callback_data.
  // Body: { token: string, sender_subject_digest: string }
  app.post("/v1/signup/callback", async (request, reply) => {
    if (!dependencies.signup) {
      return reply.code(503).send({ error: "SIGNUP_NOT_CONFIGURED" });
    }
    const body = request.body as Record<string, unknown>;
    const token = body?.token;
    const senderDigest = body?.sender_subject_digest;

    if (typeof token !== "string" || typeof senderDigest !== "string") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    const result = await processApprovalCallback(
      dependencies.signup.db,
      token,
      senderDigest,
      dependencies.signup.config,
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

  if (dependencies.close) app.addHook("onClose", dependencies.close);
  return app;
}
