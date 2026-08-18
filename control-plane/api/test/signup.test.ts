import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { digestTelegramId, verifyTelegramLogin, type VerifiedTelegramIdentity } from "../src/identity.js";
import { signApprovalAction } from "../src/approval-action.js";
import {
  startSignup,
  processApprovalCallback,
  getSignupStatus,
  getTripForMember,
  type NotificationAdapter,
  type SignupConfig,
} from "../src/signup.js";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const TEST_BOT_TOKEN = "12345678:AAFakeSignupTestBotTokenForTesting0";
const SUPER_ADMIN_ID = "100000001";
const SUPER_ADMIN_DIGEST = digestTelegramId(SUPER_ADMIN_ID);
const ACTION_SECRET = "test-action-secret-sprint1-signup";

const testConfig: SignupConfig = {
  superAdminSubjectDigest: SUPER_ADMIN_DIGEST,
  actionSecret: ACTION_SECRET,
  actionTtlSeconds: 3600,
  messagingAdapter: "fake",
  signupRateLimitCooldownSeconds: 0,
};

function makeIdentity(telegramId: string, name = "Test Organizer"): VerifiedTelegramIdentity {
  return {
    provider: "telegram",
    providerSubjectDigest: digestTelegramId(telegramId),
    displayName: name,
  };
}

class CapturingNotification implements NotificationAdapter {
  readonly calls: Array<Parameters<NotificationAdapter["sendApprovalRequest"]>[0]> = [];
  async sendApprovalRequest(params: Parameters<NotificationAdapter["sendApprovalRequest"]>[0]) {
    this.calls.push(params);
  }
}

class FailingNotification implements NotificationAdapter {
  async sendApprovalRequest() {
    throw new Error("notification adapter error");
  }
}

async function resetDb(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

// ── Service-layer tests ─────────────────────────────────────────────────────

test("verified signup creates one pending request and one outbox notification", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000001");
    const result = await startSignup(pool, identity, "Japan 2025", testConfig, notification);

    assert.equal(result.status, "awaiting_approval");
    assert.ok(result.requestId);
    assert.equal(notification.calls.length, 1);
    assert.equal(notification.calls[0].requestId, result.requestId);
    assert.equal(notification.calls[0].displayName, "Test Organizer");
    assert.equal(notification.calls[0].tripNameRequest, "Japan 2025");

    const requestsRows = await pool.query("SELECT count(*)::int AS c FROM control_plane.signup_approval_requests");
    const outboxRows = await pool.query("SELECT count(*)::int AS c FROM control_plane.notification_outbox");
    assert.equal(requestsRows.rows[0].c, 1);
    assert.equal(outboxRows.rows[0].c, 1);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("repeated signup reuses pending request without new notification", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000002");

    const r1 = await startSignup(pool, identity, "Hawaii 2026", testConfig, notification);
    assert.equal(r1.status, "awaiting_approval");
    const r2 = await startSignup(pool, identity, "Hawaii 2026", testConfig, notification);
    assert.equal(r2.status, "awaiting_approval");
    assert.equal(r2.requestId, r1.requestId);
    // Only one notification ever sent
    assert.equal(notification.calls.length, 1);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("approval callback creates draft trip and membership exactly once", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000003");
    const { requestId } = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.ok(requestId);

    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET);
    const r1 = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(r1.outcome, "approved");
    assert.ok("tripId" in r1 && r1.tripId);

    // Replay: same token is now a no-op (request is already approved)
    const r2 = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(r2.outcome, "already_decided");

    // Only one trip and one membership created
    const trips = await pool.query("SELECT count(*)::int AS c FROM control_plane.trips");
    const memberships = await pool.query("SELECT count(*)::int AS c FROM control_plane.trip_memberships");
    assert.equal(trips.rows[0].c, 1);
    assert.equal(memberships.rows[0].c, 1);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("rejection callback blocks enrollment; no draft trip created", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000004");
    const { requestId } = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.ok(requestId);

    const { token } = signApprovalAction(requestId, "reject", ACTION_SECRET);
    const result = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(result.outcome, "rejected");

    const trips = await pool.query("SELECT count(*)::int AS c FROM control_plane.trips");
    assert.equal(trips.rows[0].c, 0);

    const status = await getSignupStatus(pool, identity.providerSubjectDigest);
    assert.equal(status.status, "declined");
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("callback with wrong sender identity is refused", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000005");
    const { requestId } = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.ok(requestId);

    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET);
    const wrongSender = digestTelegramId("999999999");
    const result = await processApprovalCallback(pool, token, wrongSender, testConfig);
    assert.equal(result.outcome, "error");
    if (result.outcome !== "error") return;
    assert.equal(result.reason, "WRONG_SENDER");

    // Request is still pending
    const status = await getSignupStatus(pool, identity.providerSubjectDigest);
    assert.equal(status.status, "awaiting_approval");
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("callback with altered action token is refused", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000006");
    const { requestId } = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.ok(requestId);

    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET);
    const tampered = token.slice(0, -4) + "ZZZZ";
    const result = await processApprovalCallback(pool, tampered, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(result.outcome, "error");
    if (result.outcome !== "error") return;
    assert.equal(result.reason, "INVALID_SIGNATURE");
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("expired action token is refused", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const identity = makeIdentity("200000007");
    // Create signup with a very short TTL
    const shortConfig: SignupConfig = { ...testConfig, actionTtlSeconds: 1 };
    const { requestId } = await startSignup(pool, identity, "Japan 2025", shortConfig, notification);
    assert.ok(requestId);

    // Sign with a past nowMs so token is already expired
    const pastMs = Date.now() - 120_000;
    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET, {
      ttlSeconds: 1,
      nowMs: pastMs,
    });

    const result = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(result.outcome, "error");
    if (result.outcome !== "error") return;
    assert.equal(result.reason, "EXPIRED_TOKEN");
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("owner reads approved draft; different user and unauthenticated cannot", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const owner = makeIdentity("200000008");
    const other = makeIdentity("200000009");

    const { requestId } = await startSignup(pool, owner, "Japan 2025", testConfig, notification);
    assert.ok(requestId);
    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET);
    const approval = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(approval.outcome, "approved");
    if (approval.outcome !== "approved") return;
    const tripId = approval.tripId;

    // Owner can read the trip
    const ownerView = await getTripForMember(pool, tripId, owner.providerSubjectDigest);
    assert.ok(ownerView);
    assert.equal(ownerView.id, tripId);
    assert.equal(ownerView.lifecycleState, "draft");

    // Second user cannot
    const otherView = await getTripForMember(pool, tripId, other.providerSubjectDigest);
    assert.equal(otherView, null);

    // Forged trip ID returns null
    const forged = await getTripForMember(pool, "trip_forgedXXXXXXXX", owner.providerSubjectDigest);
    assert.equal(forged, null);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("notification failure is logged but does not roll back the signup request", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const failing = new FailingNotification();
    const identity = makeIdentity("200000010");
    const lines: string[] = [];
    const result = await startSignup(pool, identity, "Japan 2025", testConfig, failing, (l) => lines.push(l));

    // Request was persisted despite notification failure
    assert.equal(result.status, "awaiting_approval");
    assert.ok(result.requestId);
    const row = await pool.query("SELECT state FROM control_plane.signup_approval_requests WHERE id = $1", [result.requestId]);
    assert.equal(row.rows[0].state, "pending");

    // Outbox is marked failed
    const outbox = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE signup_request_id = $1", [result.requestId]);
    assert.equal(outbox.rows[0].state, "failed");

    // Error was logged with safe_error_code, not raw exception
    assert.equal(lines.length, 1);
    assert.match(lines[0], /NOTIFICATION_SEND_FAILED/);
    assert.doesNotMatch(lines[0], /notification adapter error/);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

// ── HTTP route tests ─────────────────────────────────────────────────────────

function buildValidTelegramPayload(telegramId: string, botToken: string): Record<string, unknown> {
  const authDate = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = { id: Number(telegramId), first_name: "Test", auth_date: authDate };
  const dcs = Object.entries(base).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${String(v)}`).join("\n");
  const sk = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", sk).update(dcs).digest("hex");
  return { ...base, hash };
}

const testArchitectureProfile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
  signup: {
    telegram_bot_token_secret_ref: "env://CONTROL_PLANE_TELEGRAM_BOT_TOKEN",
    super_admin_subject_digest: SUPER_ADMIN_DIGEST,
    action_secret_ref: "env://CONTROL_PLANE_ACTION_SECRET",
    action_ttl_seconds: 3600,
    signup_rate_limit_cooldown_seconds: 0,
  },
});

test("POST /v1/signup returns awaiting_approval for a fresh valid login", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const app = buildApp(testArchitectureProfile, {
      signup: { db: pool, config: testConfig, botToken: TEST_BOT_TOKEN, notification },
    });

    const payload = buildValidTelegramPayload("300000001", TEST_BOT_TOKEN);
    const response = await app.inject({
      method: "POST",
      url: "/v1/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegram: payload, trip_name_request: "Japan 2025" }),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, "awaiting_approval");
    assert.ok(body.requestId);
    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("POST /v1/signup rejects a tampered Telegram payload", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const app = buildApp(testArchitectureProfile, {
      signup: { db: pool, config: testConfig, botToken: TEST_BOT_TOKEN, notification },
    });

    const payload = buildValidTelegramPayload("300000002", TEST_BOT_TOKEN);
    payload.first_name = "Hacker"; // tamper after signing
    const response = await app.inject({
      method: "POST",
      url: "/v1/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegram: payload, trip_name_request: "Japan 2025" }),
    });
    assert.equal(response.statusCode, 401);
    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("POST /v1/signup/callback approves request and is idempotent on replay", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const app = buildApp(testArchitectureProfile, {
      signup: { db: pool, config: testConfig, botToken: TEST_BOT_TOKEN, notification },
    });

    const identity = makeIdentity("300000003");
    const { requestId } = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.ok(requestId);

    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET);

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/signup/callback",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, sender_subject_digest: SUPER_ADMIN_DIGEST }),
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().outcome, "approved");

    const r2 = await app.inject({
      method: "POST",
      url: "/v1/signup/callback",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, sender_subject_digest: SUPER_ADMIN_DIGEST }),
    });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().outcome, "already_decided");

    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("GET /v1/trips/:id is membership-scoped", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const app = buildApp(testArchitectureProfile, {
      signup: { db: pool, config: testConfig, botToken: TEST_BOT_TOKEN, notification },
    });

    const owner = makeIdentity("300000004");
    const { requestId } = await startSignup(pool, owner, "Japan 2025", testConfig, notification);
    assert.ok(requestId);
    const { token } = signApprovalAction(requestId, "approve", ACTION_SECRET);
    const approval = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(approval.outcome, "approved");
    if (approval.outcome !== "approved") return;
    const tripId = approval.tripId;

    const ownerPayload = buildValidTelegramPayload("300000004", TEST_BOT_TOKEN);
    const loginHeader = Buffer.from(JSON.stringify(ownerPayload)).toString("base64url");

    const ownerRes = await app.inject({
      method: "GET",
      url: `/v1/trips/${tripId}`,
      headers: { "x-telegram-login": loginHeader },
    });
    assert.equal(ownerRes.statusCode, 200);
    assert.equal(ownerRes.json().id, tripId);

    // Different user gets 404
    const otherPayload = buildValidTelegramPayload("300000005", TEST_BOT_TOKEN);
    const otherHeader = Buffer.from(JSON.stringify(otherPayload)).toString("base64url");
    const otherRes = await app.inject({
      method: "GET",
      url: `/v1/trips/${tripId}`,
      headers: { "x-telegram-login": otherHeader },
    });
    assert.equal(otherRes.statusCode, 404);

    // No auth header → 401
    const noAuthRes = await app.inject({ method: "GET", url: `/v1/trips/${tripId}` });
    assert.equal(noAuthRes.statusCode, 401);

    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("GET /v1/signup/status reflects current state without starting a new request", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const app = buildApp(testArchitectureProfile, {
      signup: { db: pool, config: testConfig, botToken: TEST_BOT_TOKEN, notification },
    });

    const telegramId = "300000006";
    const identity = makeIdentity(telegramId);
    await startSignup(pool, identity, "Japan 2025", testConfig, notification);

    const telegramPayload = buildValidTelegramPayload(telegramId, TEST_BOT_TOKEN);
    const encoded = Buffer.from(JSON.stringify(telegramPayload)).toString("base64url");

    const res = await app.inject({
      method: "GET",
      url: `/v1/signup/status?telegram=${encoded}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "awaiting_approval");

    // Still only one notification sent (status check didn't create a new one)
    assert.equal(notification.calls.length, 1);

    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("rejected request FK integrity: re-signup after cooldown preserves old rows", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    // testConfig has signupRateLimitCooldownSeconds: 0, so no cooldown block
    const identity = makeIdentity("200000011");

    const r1 = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.ok(r1.requestId);
    const firstRequestId = r1.requestId!;

    // Reject the request
    const { token } = signApprovalAction(firstRequestId, "reject", ACTION_SECRET);
    const rejection = await processApprovalCallback(pool, token, SUPER_ADMIN_DIGEST, testConfig);
    assert.equal(rejection.outcome, "rejected");

    // Old request row and outbox row still intact
    const oldReq = await pool.query("SELECT state FROM control_plane.signup_approval_requests WHERE id = $1", [firstRequestId]);
    assert.equal(oldReq.rows[0].state, "rejected");
    const oldOutbox = await pool.query("SELECT count(*)::int AS c FROM control_plane.notification_outbox WHERE signup_request_id = $1", [firstRequestId]);
    assert.equal(oldOutbox.rows[0].c, 1);

    // Re-signup with cooldown=0 (always allowed): must not throw FK violation
    const r2 = await startSignup(pool, identity, "Japan 2025", testConfig, notification);
    assert.equal(r2.status, "awaiting_approval");
    assert.ok(r2.requestId);
    assert.notEqual(r2.requestId, firstRequestId);

    // Old rows preserved after re-signup (FK integrity)
    const stillOldReq = await pool.query("SELECT state FROM control_plane.signup_approval_requests WHERE id = $1", [firstRequestId]);
    assert.equal(stillOldReq.rows[0].state, "rejected");
    const stillOldOutbox = await pool.query("SELECT count(*)::int AS c FROM control_plane.notification_outbox WHERE signup_request_id = $1", [firstRequestId]);
    assert.equal(stillOldOutbox.rows[0].c, 1);

    // Two requests and two outbox rows total
    const totalRequests = await pool.query("SELECT count(*)::int AS c FROM control_plane.signup_approval_requests");
    assert.equal(totalRequests.rows[0].c, 2);
    const totalOutbox = await pool.query("SELECT count(*)::int AS c FROM control_plane.notification_outbox");
    assert.equal(totalOutbox.rows[0].c, 2);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("expired pending request FK integrity: re-signup after expiry preserves old rows", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    // Use a failing notification so the first outbox row ends up in 'failed' state,
    // verifying that both 'pending' and 'failed' outbox rows are transitioned to 'skipped'
    // when the pending request expires and is superseded.
    const failing = new FailingNotification();
    const identity = makeIdentity("200000012");

    const r1 = await startSignup(pool, identity, "Japan 2025", testConfig, failing);
    assert.ok(r1.requestId);
    const firstRequestId = r1.requestId!;

    // Outbox is in 'failed' state (notification was not delivered)
    const firstOutbox = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE signup_request_id = $1", [firstRequestId]);
    assert.equal(firstOutbox.rows[0].state, "failed");

    // Force the action token to appear expired by backdating action_expires_at
    await pool.query(
      "UPDATE control_plane.signup_approval_requests SET action_expires_at = now() - interval '1 hour' WHERE id = $1",
      [firstRequestId],
    );

    // Re-signup: expired pending → new request; must not throw FK violation
    const capturing = new CapturingNotification();
    const r2 = await startSignup(pool, identity, "Japan 2025", testConfig, capturing);
    assert.equal(r2.status, "awaiting_approval");
    assert.ok(r2.requestId);
    assert.notEqual(r2.requestId, firstRequestId);

    // Old request transitioned to 'expired' (not deleted)
    const oldReq = await pool.query("SELECT state FROM control_plane.signup_approval_requests WHERE id = $1", [firstRequestId]);
    assert.equal(oldReq.rows[0].state, "expired");

    // Old outbox transitioned from 'failed' → 'skipped' (not deleted)
    const oldOutboxAfter = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE signup_request_id = $1", [firstRequestId]);
    assert.equal(oldOutboxAfter.rows[0].state, "skipped");

    // New request is pending; new notification was sent
    const newReq = await pool.query("SELECT state FROM control_plane.signup_approval_requests WHERE id = $1", [r2.requestId]);
    assert.equal(newReq.rows[0].state, "pending");
    assert.equal(capturing.calls.length, 1);

    // Two requests and two outbox rows total
    const totalRequests = await pool.query("SELECT count(*)::int AS c FROM control_plane.signup_approval_requests");
    assert.equal(totalRequests.rows[0].c, 2);
    const totalOutbox = await pool.query("SELECT count(*)::int AS c FROM control_plane.notification_outbox");
    assert.equal(totalOutbox.rows[0].c, 2);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("POST /v1/signup without signup config returns 503", async () => {
  const profile = validateArchitectureProfile({
    version: 1,
    environment: "test",
    public_api: { bind_host: "127.0.0.1", port: 4310 },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
    test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
  });
  const app = buildApp(profile);
  const res = await app.inject({
    method: "POST",
    url: "/v1/signup",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram: {}, trip_name_request: "test" }),
  });
  assert.equal(res.statusCode, 503);
  await app.close();
});

test("API responses do not expose Telegram numeric IDs or raw action secrets", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const notification = new CapturingNotification();
    const app = buildApp(testArchitectureProfile, {
      signup: { db: pool, config: testConfig, botToken: TEST_BOT_TOKEN, notification },
    });

    const telegramId = "300000007";
    const payload = buildValidTelegramPayload(telegramId, TEST_BOT_TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/v1/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegram: payload, trip_name_request: "Japan 2025" }),
    });

    assert.doesNotMatch(res.body, new RegExp(telegramId));
    assert.doesNotMatch(res.body, new RegExp(ACTION_SECRET));
    assert.doesNotMatch(res.body, new RegExp(TEST_BOT_TOKEN));

    // Notification payload also must not carry raw IDs or the bot token
    assert.equal(notification.calls.length, 1);
    const notifJson = JSON.stringify(notification.calls[0]);
    assert.doesNotMatch(notifJson, new RegExp(ACTION_SECRET));
    assert.doesNotMatch(notifJson, new RegExp(TEST_BOT_TOKEN));

    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});
