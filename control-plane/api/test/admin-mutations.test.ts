/**
 * The super-admin dashboard's slice 2 (Sprint 6, decision 23 in
 * docs/sprint6-tracks.md): suspend/retry, server-side-authorized mutations
 * behind the same operator key slice 1's reads use.
 *
 * Pins, in order: retry reuses the real `retryProvision` mechanism (not a
 * reimplementation) and inherits its state-machine authorization; suspend
 * requires a real reason and actually stops a job from being claimed;
 * resume reverses it; every mutation — success or refusal — writes its own
 * audit row, with the operator's suspend reason never copied into that
 * row's evidence; and the routes are gated and unmounted exactly like
 * slice 1's.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { generatePlan } from "../src/planner.js";
import { issueApproval } from "../src/plan-approval.js";
import { claimJob } from "../src/job-queue.js";
import { resumeTrip, retryTripViaAdmin, suspendTrip, validateSuspendReason } from "../src/admin-mutations.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const DB_URL = testDatabaseUrl();
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const KEY = "admin-key-for-mutation-tests";
const APPROVAL_TTL_SECONDS = 3600;

// Same reasoning as planner.test.ts: generatePlan only selects the
// manifest-less dev-seed / fixture release when this is on.
process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE = "1";

const profile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

function randomHex(n: number): string {
  return randomBytes(n).toString("hex");
}

function generateTestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomHex(8)}`;
}

interface Fixture {
  pool: pg.Pool;
  ownerId: string;
  tripId: string;
  releaseId: string;
  correlationId: string;
}

/** A trip in `intake_confirmed` with no plan yet — the same retryable degenerate
 * case planner.ts's RETRYABLE_STATES comment calls out, and a release the
 * fixture's own schema range matches. Intake carries no `data`, so the
 * organizer-roster check (hasAnswers) never triggers — same shape as
 * planner.test.ts's default fixture. */
async function setupFixture(pool: pg.Pool, lifecycleState = "intake_confirmed"): Promise<Fixture> {
  const ownerId = generateTestId("user");
  const tripId = generateTestId("trip");
  const releaseId = generateTestId("rls");
  const intakeVersionId = generateTestId("intk");
  const intakeDigest = `sha256:${randomHex(32)}`;
  const sourceRevision = randomHex(20);
  const artifactDigest = `sha256:${randomHex(32)}`;
  const correlationId = `corr_${randomHex(8)}`;

  await pool.query(
    "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')",
    [ownerId],
  );
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, $3)",
    [tripId, tripId.replace(/_/g, "-"), lifecycleState],
  );
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [generateTestId("memb"), tripId, ownerId],
  );
  await pool.query(
    `INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by)
     VALUES ($1, $2, $3, 1, 1, 1, 'available', now(), 'test:fixture')`,
    [releaseId, sourceRevision, artifactDigest],
  );
  await pool.query(
    `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version)
     VALUES ($1, $2, 1, 'intake:sessions:sess_test:v1', $3, now(), 1)`,
    [intakeVersionId, tripId, intakeDigest],
  );

  return { pool, ownerId, tripId, releaseId, correlationId };
}

async function teardownFixture(fix: Fixture): Promise<void> {
  const { pool, tripId, ownerId, releaseId } = fix;
  await pool.query("DELETE FROM control_plane.plan_approvals WHERE plan_id IN (SELECT id FROM control_plane.plans WHERE trip_id = $1)", [tripId]);
  await pool.query("DELETE FROM control_plane.jobs WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.plans WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.intake_versions WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.user_identities WHERE user_id = $1", [ownerId]);
  await pool.query("DELETE FROM control_plane.users WHERE id = $1", [ownerId]);
  await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [releaseId]);
}

async function latestAuditEvidence(pool: pg.Pool, action: string, targetRef: string): Promise<unknown> {
  const row = await pool.query<{ evidence: unknown }>(
    "SELECT evidence FROM control_plane.audit_events WHERE action = $1 AND target_ref = $2 ORDER BY occurred_at DESC LIMIT 1",
    [action, targetRef],
  );
  return row.rows[0]?.evidence;
}

describe("super-admin dashboard: slice 2 (suspend/retry)", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = testPool({ max: 5 });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); }
    finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  function appWithAdmin() {
    return buildApp(profile, {
      admin: { db: pool, apiKey: KEY },
      planner: { db: pool, config: { approvalTtlSeconds: APPROVAL_TTL_SECONDS } },
    });
  }

  // ── Authorization: gated and unmounted exactly like slice 1 ────────────

  const MUTATION_ROUTES: Array<{ method: "POST"; url: string }> = [
    { method: "POST", url: "/v1/admin/trips/trip_doesnotexist000/retry" },
    { method: "POST", url: "/v1/admin/trips/trip_doesnotexist000/suspend" },
    { method: "POST", url: "/v1/admin/trips/trip_doesnotexist000/resume" },
  ];

  test("without the key in the environment, none of the mutation routes exist", async () => {
    const app = buildApp(profile, {});
    try {
      for (const route of MUTATION_ROUTES) {
        const response = await app.inject({ method: route.method, url: route.url, payload: { reason: "testing" } });
        assert.equal(response.statusCode, 503, route.url);
        assert.equal(JSON.parse(response.body).error, "ADMIN_NOT_CONFIGURED", route.url);
      }
    } finally {
      await app.close();
    }
  });

  test("a wrong key, an empty key and no key are all refused, on every mutation route", async () => {
    const app = appWithAdmin();
    try {
      for (const route of MUTATION_ROUTES) {
        for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "nearly-the-key" }]) {
          const response = await app.inject({ method: route.method, url: route.url, headers, payload: { reason: "testing" } });
          assert.equal(response.statusCode, 401, `${route.url} ${JSON.stringify(headers)}`);
          assert.equal(JSON.parse(response.body).error, "AUTHENTICATION_REQUIRED");
        }
      }
    } finally {
      await app.close();
    }
  });

  test("the operator's own key does not open this door either", async () => {
    const app = buildApp(profile, {
      admin: { db: pool, apiKey: KEY },
      operator: { db: pool, apiKey: "operator-key", enrollmentTtlSeconds: 86400 },
    });
    try {
      const response = await app.inject({
        method: "POST", url: "/v1/admin/trips/trip_doesnotexist000/suspend",
        headers: { "x-api-key": "operator-key" }, payload: { reason: "testing" },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  // ── validateSuspendReason ────────────────────────────────────────────────

  test("validateSuspendReason: required, bounded, no control characters", () => {
    assert.equal(validateSuspendReason(undefined).ok, false);
    assert.equal(validateSuspendReason("").ok, false);
    assert.equal(validateSuspendReason("   ").ok, false);
    assert.equal(validateSuspendReason(123).ok, false);
    assert.equal(validateSuspendReason("a".repeat(501)).ok, false);
    assert.equal(validateSuspendReason("x\u0000y").ok, false);
    const ok = validateSuspendReason("  pausing to fix a transformer bug  ");
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.reason, "pausing to fix a transformer bug");
    // Embedded newlines are folded to a space, not rejected.
    const folded = validateSuspendReason("line one\nline two");
    assert.equal(folded.ok, true);
    if (folded.ok) assert.equal(folded.reason, "line one line two");
  });

  test("validateSuspendReason: C1 controls and Unicode line/bidi characters the boundary review found (finding 4)", () => {
    // Before the fix, all five of these passed validation and were stored
    // verbatim (live proof, #review 2026-10-03).
    assert.equal(validateSuspendReason("before\u0085after").ok, false, "U+0085 NEL");
    assert.equal(validateSuspendReason("before\u009B[31mafter").ok, false, "U+009B CSI");
    assert.equal(validateSuspendReason("before\u202Eafter").ok, false, "U+202E bidi override");

    // U+2028/U+2029 are folded to a space (same treatment as \r\n), not
    // rejected outright: matching this file's existing "newlines fold,
    // they don't refuse" posture for line-break-shaped characters.
    const lineSep = validateSuspendReason("line one\u2028line two");
    assert.equal(lineSep.ok, true);
    if (lineSep.ok) assert.equal(lineSep.reason, "line one line two", "U+2028 must fold, and the fold must actually produce one line");

    const paraSep = validateSuspendReason("line one\u2029line two");
    assert.equal(paraSep.ok, true);
    if (paraSep.ok) assert.equal(paraSep.reason, "line one line two", "U+2029 must fold too");

    // A tab is not a control character this validator refuses (it has no
    // line-break or bidi-override effect): confirming the widened class
    // doesn't overreach into ordinary whitespace.
    assert.equal(validateSuspendReason("before\tafter").ok, true);
  });

  // ── retry: reuses the real mechanism ────────────────────────────────────

  test("retryTripViaAdmin on a retryable trip calls through to retryProvision AND approves the plan it creates, so the job is actually queued (#review 2026-10-03 [P1])", async () => {
    const fix = await setupFixture(pool);
    try {
      const before = await pool.query("SELECT count(*)::int AS n FROM control_plane.plans WHERE trip_id = $1", [fix.tripId]);
      assert.equal(before.rows[0].n, 0);

      const result = await retryTripViaAdmin(pool, fix.tripId, APPROVAL_TTL_SECONDS, undefined, fix.correlationId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.supersededPlanId, null);
      assert.match(result.planId, /^plan_/);
      assert.match(result.jobId, /^job_/);

      // Before the fix, generatePlan left this `pending_approval` and the job
      // `waiting_for_user_action` — a click that reported success but left
      // the trip stuck forever, since the dashboard has no approval control.
      const planRow = await pool.query("SELECT status FROM control_plane.plans WHERE id = $1", [result.planId]);
      assert.equal(planRow.rows[0]?.status, "approved");
      const jobRow = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [result.jobId]);
      assert.equal(jobRow.rows[0]?.state, "queued");

      const evidence = await latestAuditEvidence(pool, "admin.retry_trip", fix.tripId) as Record<string, unknown>;
      assert.equal(evidence.ok, true);
      assert.equal(evidence.jobId, result.jobId);
      assert.equal(evidence.planId, result.planId);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("retryTripViaAdmin on a trip in a non-retryable state is refused, not crashed, and the refusal is audited", async () => {
    const fix = await setupFixture(pool, "draft");
    try {
      const result = await retryTripViaAdmin(pool, fix.tripId, APPROVAL_TTL_SECONDS, undefined, fix.correlationId);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_RETRYABLE_STATE");

      const evidence = await latestAuditEvidence(pool, "admin.retry_trip", fix.tripId) as Record<string, unknown>;
      assert.equal(evidence.ok, false);
      assert.equal(evidence.reason, "NOT_RETRYABLE_STATE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("retryTripViaAdmin on a trip that does not exist returns TRIP_NOT_FOUND and writes no audit row (#review 2026-10-03, finding N)", async () => {
    // A well-formed but nonexistent id is still just caller-chosen text, not
    // a verified safe opaque id — proven live with a crafted string spelling
    // out a name and a health condition within the shape check's own
    // charset. Same treatment as the malformed-shape case below: nothing
    // safe or meaningful to log about a trip that was never found.
    const fakeId = "jo_JohnDoe1973PeanutAllergy12";
    const correlationId = `corr_${randomHex(8)}`;
    const result = await retryTripViaAdmin(pool, fakeId, APPROVAL_TTL_SECONDS, undefined, correlationId);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TRIP_NOT_FOUND");

    const row = await pool.query("SELECT 1 FROM control_plane.audit_events WHERE target_ref = $1", [fakeId]);
    assert.equal(row.rowCount, 0, "a well-formed but nonexistent id must never reach audit_events either");
  });

  test("retryTripViaAdmin on a malformed id refuses before ever writing an audit row (#review 2026-10-03, finding 3)", async () => {
    // Before the fix, this exact string reached the audit INSERT verbatim as
    // target_ref — a permanent write (audit_events rejects UPDATE/DELETE/
    // TRUNCATE) of free text that was never a real trip id.
    const malformed = "Jane Doe jane.doe@example.com allergic to peanuts";
    const correlationId = `corr_${randomHex(8)}`;
    const result = await retryTripViaAdmin(pool, malformed, APPROVAL_TTL_SECONDS, undefined, correlationId);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TRIP_NOT_FOUND");

    const row = await pool.query(
      "SELECT 1 FROM control_plane.audit_events WHERE correlation_id = $1",
      [correlationId],
    );
    assert.equal(row.rowCount, 0, "a malformed id must never reach audit_events, not even redacted");
  });

  test("POST /v1/admin/trips/:id/retry: happy path reaches 201 with the new plan/job", async () => {
    const fix = await setupFixture(pool);
    const app = appWithAdmin();
    try {
      const response = await app.inject({
        method: "POST", url: `/v1/admin/trips/${fix.tripId}/retry`, headers: { "x-api-key": KEY },
      });
      assert.equal(response.statusCode, 201, response.body);
      const body = JSON.parse(response.body);
      assert.match(body.jobId, /^job_/);
    } finally {
      await app.close();
      await teardownFixture(fix);
    }
  });

  test("POST /v1/admin/trips/:id/retry: a trip not in a retryable state gets 409, not 500", async () => {
    const fix = await setupFixture(pool, "draft");
    const app = appWithAdmin();
    try {
      const response = await app.inject({
        method: "POST", url: `/v1/admin/trips/${fix.tripId}/retry`, headers: { "x-api-key": KEY },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(JSON.parse(response.body).error, "NOT_RETRYABLE_STATE");
    } finally {
      await app.close();
      await teardownFixture(fix);
    }
  });

  test("POST /v1/admin/trips/:id/retry: an unknown trip gets 404", async () => {
    const app = appWithAdmin();
    try {
      const response = await app.inject({
        method: "POST", url: `/v1/admin/trips/trip_${randomHex(16)}/retry`, headers: { "x-api-key": KEY },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(JSON.parse(response.body).error, "TRIP_NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  // ── suspend / resume ──────────────────────────────────────────────────────

  test("suspendTrip requires a real reason, marks the trip, and audits — without copying the reason into evidence", async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await suspendTrip(pool, fix.tripId, "pausing for a transformer fix");
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.tripId, fix.tripId);
      assert.ok(result.suspendedAt);

      const row = await pool.query<{ suspended_at: Date | null; suspended_reason: string | null }>(
        "SELECT suspended_at, suspended_reason FROM control_plane.trips WHERE id = $1", [fix.tripId],
      );
      assert.ok(row.rows[0]?.suspended_at);
      assert.equal(row.rows[0]?.suspended_reason, "pausing for a transformer fix");

      const evidence = await latestAuditEvidence(pool, "admin.suspend_trip", fix.tripId);
      assert.deepEqual(evidence, { ok: true });
    } finally {
      await teardownFixture(fix);
    }
  });

  test("suspendTrip on an already-suspended trip is refused with ALREADY_SUSPENDED, and the refusal is audited (#review 2026-10-03, finding 5)", async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await suspendTrip(pool, fix.tripId, "first reason");
      assert.equal(first.ok, true);
      const second = await suspendTrip(pool, fix.tripId, "second reason");
      assert.equal(second.ok, false);
      if (second.ok) throw new Error("unreachable");
      assert.equal(second.reason, "ALREADY_SUSPENDED");

      const evidence = await latestAuditEvidence(pool, "admin.suspend_trip", fix.tripId);
      assert.deepEqual(evidence, { ok: false, reason: "ALREADY_SUSPENDED" });
    } finally {
      await teardownFixture(fix);
    }
  });

  test("suspendTrip on a trip that does not exist returns TRIP_NOT_FOUND and writes no audit row (#review 2026-10-03, finding N)", async () => {
    // Same reasoning as retryTripViaAdmin's equivalent test: a well-formed
    // but nonexistent id is caller-chosen text, not a verified safe opaque
    // id, so it must not reach this permanent audit log either — unlike
    // ALREADY_SUSPENDED above, which only fires for a trip actually found.
    const tripId = `trip_${randomHex(16)}`;
    const result = await suspendTrip(pool, tripId, "a reason");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TRIP_NOT_FOUND");

    const evidence = await latestAuditEvidence(pool, "admin.suspend_trip", tripId);
    assert.equal(evidence, undefined, "a trip that was never found must not reach audit_events");
  });

  test("suspendTrip on a malformed id refuses before ever writing an audit row (finding 3's risk applies here too)", async () => {
    const malformed = "Jane Doe jane.doe@example.com allergic to peanuts";
    const result = await suspendTrip(pool, malformed, "a reason");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TRIP_NOT_FOUND");

    const row = await pool.query(
      "SELECT 1 FROM control_plane.audit_events WHERE target_ref = $1",
      [malformed],
    );
    assert.equal(row.rowCount, 0, "a malformed id must never reach audit_events, not even for a refusal");
  });

  test("resumeTrip reverses suspendTrip, audits, and preserves the suspension reason it reverses (#review 2026-10-03 [P2])", async () => {
    const fix = await setupFixture(pool);
    try {
      await suspendTrip(pool, fix.tripId, "pausing");
      const result = await resumeTrip(pool, fix.tripId);
      assert.equal(result.ok, true);

      // Before the fix, resume nulled suspended_reason along with
      // suspended_at, permanently losing the only record of WHY the trip
      // had been paused (the suspend audit event deliberately never copies
      // it — see admin-mutations.ts's module doc). suspended_at alone is
      // still the one thing every reader treats as "currently suspended"
      // (job-queue.ts, provisioner.py, this module's own checks), so a
      // lingering reason here changes no other behaviour.
      const row = await pool.query<{ suspended_at: Date | null; suspended_reason: string | null }>(
        "SELECT suspended_at, suspended_reason FROM control_plane.trips WHERE id = $1", [fix.tripId],
      );
      assert.equal(row.rows[0]?.suspended_at, null);
      assert.equal(row.rows[0]?.suspended_reason, "pausing");

      const evidence = await latestAuditEvidence(pool, "admin.resume_trip", fix.tripId);
      assert.deepEqual(evidence, { ok: true });
    } finally {
      await teardownFixture(fix);
    }
  });

  test("resumeTrip on a trip that is not suspended is refused with NOT_SUSPENDED, and the refusal is audited (finding 5)", async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await resumeTrip(pool, fix.tripId);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_SUSPENDED");

      const evidence = await latestAuditEvidence(pool, "admin.resume_trip", fix.tripId);
      assert.deepEqual(evidence, { ok: false, reason: "NOT_SUSPENDED" });
    } finally {
      await teardownFixture(fix);
    }
  });

  test("resumeTrip on a trip that does not exist returns TRIP_NOT_FOUND and writes no audit row (#review 2026-10-03, finding N)", async () => {
    // Same reasoning as suspendTrip's equivalent test — see its comment.
    const tripId = `trip_${randomHex(16)}`;
    const result = await resumeTrip(pool, tripId);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TRIP_NOT_FOUND");

    const evidence = await latestAuditEvidence(pool, "admin.resume_trip", tripId);
    assert.equal(evidence, undefined, "a trip that was never found must not reach audit_events");
  });

  test("resumeTrip on a malformed id refuses before ever writing an audit row", async () => {
    const malformed = "Jane Doe jane.doe@example.com allergic to peanuts";
    const result = await resumeTrip(pool, malformed);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.reason, "TRIP_NOT_FOUND");

    const row = await pool.query(
      "SELECT 1 FROM control_plane.audit_events WHERE target_ref = $1",
      [malformed],
    );
    assert.equal(row.rowCount, 0, "a malformed id must never reach audit_events, not even for a refusal");
  });

  test("POST /v1/admin/trips/:id/suspend: missing reason is refused with 400, before anything is written", async () => {
    const fix = await setupFixture(pool);
    const app = appWithAdmin();
    try {
      const response = await app.inject({
        method: "POST", url: `/v1/admin/trips/${fix.tripId}/suspend`, headers: { "x-api-key": KEY }, payload: {},
      });
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).error, "REASON_REQUIRED");

      const row = await pool.query("SELECT suspended_at FROM control_plane.trips WHERE id = $1", [fix.tripId]);
      assert.equal(row.rows[0]?.suspended_at, null);
    } finally {
      await app.close();
      await teardownFixture(fix);
    }
  });

  test("POST /v1/admin/trips/:id/suspend then /resume: the full HTTP round trip", async () => {
    const fix = await setupFixture(pool);
    const app = appWithAdmin();
    try {
      const suspend = await app.inject({
        method: "POST", url: `/v1/admin/trips/${fix.tripId}/suspend`, headers: { "x-api-key": KEY },
        payload: { reason: "operator paused this for review" },
      });
      assert.equal(suspend.statusCode, 200, suspend.body);

      const resume = await app.inject({
        method: "POST", url: `/v1/admin/trips/${fix.tripId}/resume`, headers: { "x-api-key": KEY },
      });
      assert.equal(resume.statusCode, 200, resume.body);
      assert.equal(JSON.parse(resume.body).tripId, fix.tripId);
    } finally {
      await app.close();
      await teardownFixture(fix);
    }
  });

  // ── The actual effect: a suspended trip's job cannot be claimed ─────────

  test("a suspended trip's approved, queued job is skipped by claimJob — and claimable again after resume", async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");
      const approval = await issueApproval(pool, plan.planId, "user:test", 3600);
      assert.equal(approval.ok, true);

      const suspend = await suspendTrip(pool, fix.tripId, "pausing before the claim");
      assert.equal(suspend.ok, true);

      const blockedClaim = await claimJob(pool, "worker_suspend_test", 60);
      assert.equal(blockedClaim.ok, false);
      if (blockedClaim.ok) throw new Error("unreachable");
      assert.equal(blockedClaim.reason, "NO_CLAIMABLE_JOB");

      // The job is still sitting queued, not cancelled or touched — suspend
      // is a pause, not a mutation of the job itself.
      const jobRow = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [plan.jobId]);
      assert.equal(jobRow.rows[0]?.state, "queued");

      const resume = await resumeTrip(pool, fix.tripId);
      assert.equal(resume.ok, true);

      const claim = await claimJob(pool, "worker_suspend_test", 60);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");
      assert.equal(claim.claim.jobId, plan.jobId);
    } finally {
      await teardownFixture(fix);
    }
  });

  // ── The race the boundary review proved live (2026-10-03): a claim must
  // not win against a suspend that is still mid-transaction, not only
  // against one that has already committed. ────────────────────────────────

  test("a claim cannot win a race against a suspend that is still mid-transaction", async () => {
    const fix = await setupFixture(pool);
    const holder = await pool.connect();
    try {
      const plan = await generatePlan(pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");
      const approval = await issueApproval(pool, plan.planId, "user:test", 3600);
      assert.equal(approval.ok, true);

      // Mirrors suspendTrip's own opening move exactly: BEGIN, then the same
      // `SELECT ... FOR UPDATE` on the trips row, held open — the same
      // window the boundary review exploited by calling claimJob() while a
      // real suspendTrip() call was 4 seconds from committing.
      await holder.query("BEGIN");
      await holder.query("SELECT suspended_at FROM control_plane.trips WHERE id = $1 FOR UPDATE", [fix.tripId]);

      // Before the fix (FOR UPDATE OF j, pa only), claimJob never named `t`
      // in its own FOR UPDATE clause, so it never waited or skipped on the
      // lock `holder` is sitting on — it claimed the job immediately. After
      // the fix (FOR UPDATE OF j, pa, t), `t` participates in SKIP LOCKED
      // too, so this claim must skip the row cleanly rather than race it.
      const raced = await claimJob(pool, "worker_race_test", 60);
      assert.equal(raced.ok, false, "a claim must not win while the trip row is locked by an in-flight suspend");
      if (raced.ok) throw new Error("unreachable");
      assert.equal(raced.reason, "NO_CLAIMABLE_JOB");

      const jobRow = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [plan.jobId]);
      assert.equal(jobRow.rows[0]?.state, "queued", "the job must still be sitting queued, not leased out from under the suspend");

      // Let the held transaction go (never actually committing the suspend —
      // this test only needs to prove the lock window matters, not exercise
      // suspendTrip's own commit path, which the tests above already cover).
      await holder.query("ROLLBACK");

      // With the lock released and the trip never actually suspended, a
      // normal claim now succeeds — proving the fix doesn't over-block.
      const claimAfter = await claimJob(pool, "worker_race_test", 60);
      assert.equal(claimAfter.ok, true);
      if (!claimAfter.ok) throw new Error("unreachable");
      assert.equal(claimAfter.claim.jobId, plan.jobId);
    } finally {
      holder.release();
      await teardownFixture(fix);
    }
  });
});
