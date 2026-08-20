import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { generatePlan } from "../src/planner.js";
import { issueApproval } from "../src/plan-approval.js";
import { claimJob, heartbeat, recoverStaleLeases, recoverExpiredApprovals, completeJob, failJob } from "../src/job-queue.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function runMigrations(pool: pg.Pool) {
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); }
  finally { client.release(); }
}

function randomHex(n: number) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}

function generateTestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomHex(8)}`;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface PlannerFixture {
  pool: pg.Pool;
  ownerId: string;
  tripId: string;
  releaseId: string;
  intakeVersionId: string;
  intakeDigest: string;
  correlationId: string;
}

async function setupFixture(pool: pg.Pool): Promise<PlannerFixture> {
  const ownerId = generateTestId("user");
  const tripId = generateTestId("trip");
  const releaseId = generateTestId("rls");
  const intakeVersionId = generateTestId("intk");
  const intakeDigest = `sha256:${randomHex(64)}`;
  const artifactDigest = `sha256:${randomHex(64)}`;
  const sourceRevision = randomHex(40);
  const correlationId = `corr_${randomHex(16)}`;

  await pool.query(
    "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')",
    [ownerId],
  );
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'intake_confirmed')",
    [tripId, `planner-test-${Date.now().toString(36)}`],
  );
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [generateTestId("memb"), tripId, ownerId],
  );
  await pool.query(
    `INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status)
     VALUES ($1, $2, $3, 1, 1, 1, 'available')`,
    [releaseId, sourceRevision, artifactDigest],
  );
  await pool.query(
    `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version)
     VALUES ($1, $2, 1, 'intake:sessions:sess_test:v1', $3, now(), 1)`,
    [intakeVersionId, tripId, intakeDigest],
  );

  return { pool, ownerId, tripId, releaseId, intakeVersionId, intakeDigest, correlationId };
}

async function teardownFixture(fix: PlannerFixture) {
  const { pool, tripId, ownerId, releaseId } = fix;
  await pool.query("DELETE FROM control_plane.plan_approvals WHERE plan_id IN (SELECT id FROM control_plane.plans WHERE trip_id = $1)", [tripId]);
  await pool.query("DELETE FROM control_plane.job_steps WHERE job_id IN (SELECT id FROM control_plane.jobs WHERE trip_id = $1)", [tripId]);
  await pool.query("DELETE FROM control_plane.jobs WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.plans WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.intake_versions WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.user_identities WHERE user_id = $1", [ownerId]);
  await pool.query("DELETE FROM control_plane.users WHERE id = $1", [ownerId]);
  await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [releaseId]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("generatePlan", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await runMigrations(pool);
  });

  after(async () => { if (!SKIP) await pool?.end(); });

  test("generates a plan and job from a confirmed intake", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.match(result.planId, /^plan_/);
      assert.match(result.planDigest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(result.releaseId, fix.releaseId);
      assert.match(result.jobId, /^job_/);

      // Plan must be pending_approval; job must be waiting_for_user_action.
      const planRow = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1",
        [result.planId],
      );
      assert.equal(planRow.rows[0]?.status, "pending_approval");

      const jobRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1",
        [result.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "waiting_for_user_action");

      // Trip lifecycle advances to 'planned'.
      const tripRow = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.tripId],
      );
      assert.equal(tripRow.rows[0]?.lifecycle_state, "planned");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects when trip is not intake_confirmed", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      // Manually set trip to a non-confirmed state.
      await fix.pool.query("UPDATE control_plane.trips SET lifecycle_state = 'draft' WHERE id = $1", [fix.tripId]);
      const result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "TRIP_NOT_CONFIRMED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects when no compatible release is available", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      // Mark the release as deprecated so no available release exists.
      await fix.pool.query("UPDATE control_plane.releases SET status = 'deprecated' WHERE id = $1", [fix.releaseId]);
      const result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NO_COMPATIBLE_RELEASE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects a release with incompatible schema range", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      // Reconfigure the release to support only schema version 2+.
      await fix.pool.query(
        "UPDATE control_plane.releases SET data_schema_min = 2, data_schema_max = 2 WHERE id = $1",
        [fix.releaseId],
      );
      // Intake has schema_version = 1 (the default from setupFixture).
      const result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NO_COMPATIBLE_RELEASE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects when a pending or approved plan already exists", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);

      const second = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(second.ok, false);
      if (second.ok) throw new Error("unreachable");
      assert.equal(second.reason, "PLAN_ALREADY_PENDING");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("concurrent generatePlan: exactly one succeeds, one returns PLAN_ALREADY_PENDING", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const [a, b] = await Promise.all([
        generatePlan(fix.pool, fix.tripId, fix.correlationId),
        generatePlan(fix.pool, fix.tripId, `${fix.correlationId}_b`),
      ]);
      const results = [a, b];
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      assert.equal(successes.length, 1, "exactly one generatePlan should succeed");
      assert.equal(failures.length, 1, "exactly one generatePlan should return PLAN_ALREADY_PENDING");
      assert.ok(!failures[0]!.ok && failures[0]!.reason === "PLAN_ALREADY_PENDING");

      // Confirm exactly one plan and one job exist for the trip.
      const planCount = await fix.pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM control_plane.plans WHERE trip_id = $1", [fix.tripId],
      );
      assert.equal(planCount.rows[0]?.count, "1");
      const jobCount = await fix.pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM control_plane.jobs WHERE trip_id = $1", [fix.tripId],
      );
      assert.equal(jobCount.rows[0]?.count, "1");
    } finally {
      await teardownFixture(fix);
    }
  });
});

describe("issueApproval", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await runMigrations(pool);
  });

  after(async () => { if (!SKIP) await pool?.end(); });

  test("approves a pending plan and moves its job to queued", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      const approval = await issueApproval(fix.pool, plan.planId, "user:test", 3600);
      assert.equal(approval.ok, true);
      if (!approval.ok) throw new Error("unreachable");
      assert.match(approval.approvalId, /^appr_/);
      assert.ok(approval.expiresAt > new Date());

      const planRow = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1",
        [plan.planId],
      );
      assert.equal(planRow.rows[0]?.status, "approved");

      const jobRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1",
        [plan.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "queued");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("replay: second approval attempt returns ALREADY_APPROVED", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      const first = await issueApproval(fix.pool, plan.planId, "user:test", 3600);
      assert.equal(first.ok, true);

      const second = await issueApproval(fix.pool, plan.planId, "user:test", 3600);
      assert.equal(second.ok, false);
      if (second.ok) throw new Error("unreachable");
      assert.equal(second.reason, "ALREADY_APPROVED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects approval for a non-existent plan", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await issueApproval(fix.pool, "plan_doesnotexist00", "user:test", 3600);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "PLAN_NOT_FOUND");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("concurrent issueApproval: exactly one succeeds, one returns ALREADY_APPROVED", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      const [a, b] = await Promise.all([
        issueApproval(fix.pool, plan.planId, "user:test_a", 3600),
        issueApproval(fix.pool, plan.planId, "user:test_b", 3600),
      ]);
      const results = [a, b];
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      assert.equal(successes.length, 1, "exactly one issueApproval should succeed");
      assert.equal(failures.length, 1, "exactly one issueApproval should return ALREADY_APPROVED");
      assert.ok(!failures[0]!.ok && failures[0]!.reason === "ALREADY_APPROVED");

      // Confirm exactly one approval row exists.
      const approvalCount = await fix.pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM control_plane.plan_approvals WHERE plan_id = $1", [plan.planId],
      );
      assert.equal(approvalCount.rows[0]?.count, "1");
    } finally {
      await teardownFixture(fix);
    }
  });
});

describe("claimJob / heartbeat / completeJob / failJob", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await runMigrations(pool);
  });

  after(async () => { if (!SKIP) await pool?.end(); });

  async function setupApprovedJob(fix: PlannerFixture) {
    const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
    assert.equal(plan.ok, true);
    if (!plan.ok) throw new Error("unreachable");
    const approval = await issueApproval(fix.pool, plan.planId, "user:test", 3600);
    assert.equal(approval.ok, true);
    if (!approval.ok) throw new Error("unreachable");
    return { planId: plan.planId, planDigest: plan.planDigest, jobId: plan.jobId };
  }

  test("worker claims a queued job with a valid approval", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      const claim = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");
      assert.equal(claim.claim.tripId, fix.tripId);
      assert.equal(claim.claim.attempt, 1);

      const jobRow = await fix.pool.query<{ state: string; lease_owner: string }>(
        "SELECT state, lease_owner FROM control_plane.jobs WHERE id = $1",
        [claim.claim.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "leased");
      assert.equal(jobRow.rows[0]?.lease_owner, "worker_01");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("concurrent claim: only one worker claims the job (SKIP LOCKED)", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      // Two concurrent claim attempts.
      const [r1, r2] = await Promise.all([
        claimJob(fix.pool, "worker_A", 60),
        claimJob(fix.pool, "worker_B", 60),
      ]);

      const successes = [r1, r2].filter((r) => r.ok);
      assert.equal(successes.length, 1, "exactly one worker must claim the job");

      const failures = [r1, r2].filter((r) => !r.ok);
      assert.equal(failures.length, 1);
      if (!failures[0]!.ok) assert.equal(failures[0].reason, "NO_CLAIMABLE_JOB");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("approval expiry: expired approval blocks worker claim", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      // Issue an already-expired approval (TTL = -1 second).
      const approval = await issueApproval(fix.pool, plan.planId, "user:test", -1);
      assert.equal(approval.ok, true);

      const claim = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(claim.ok, false);
      if (claim.ok) throw new Error("unreachable");
      assert.equal(claim.reason, "NO_CLAIMABLE_JOB");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("approval replay: approval already used blocks second claim", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      const first = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");

      // Complete the job so it's no longer leased.
      await completeJob(fix.pool, first.claim.jobId, "worker_01", { done: true });

      // A second claim attempt finds no claimable job — the approval was used.
      const second = await claimJob(fix.pool, "worker_02", 60);
      assert.equal(second.ok, false);
      if (second.ok) throw new Error("unreachable");
      assert.equal(second.reason, "NO_CLAIMABLE_JOB");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("heartbeat: extends the lease", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      const claim = await claimJob(fix.pool, "worker_01", 5);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");

      const extended = await heartbeat(fix.pool, claim.claim.jobId, "worker_01", 300);
      assert.equal(extended, true);

      const jobRow = await fix.pool.query<{ lease_expires_at: Date }>(
        "SELECT lease_expires_at FROM control_plane.jobs WHERE id = $1",
        [claim.claim.jobId],
      );
      const leaseExpiresAt = jobRow.rows[0]?.lease_expires_at;
      assert.ok(leaseExpiresAt);
      // New lease should be roughly now + 300s, far beyond the original 5s.
      assert.ok(leaseExpiresAt.getTime() > Date.now() + 250_000);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("stale lease recovery: re-queues expired leased job without requiring reapproval", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      // Issue a long-lived approval (so the approval does not expire during the test).
      const approval = await issueApproval(fix.pool, plan.planId, "user:test", 3600);
      assert.equal(approval.ok, true);

      // Simulate a worker crash: set the job to leased with an expired lease.
      // The approval is NOT consumed — that only happens at terminal events.
      await fix.pool.query(
        `UPDATE control_plane.jobs
         SET state = 'leased', lease_owner = 'dead_worker', lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [plan.jobId],
      );

      const recovered = await recoverStaleLeases(fix.pool);
      assert.equal(recovered, 1);

      const jobRow = await fix.pool.query<{ state: string; lease_owner: string | null }>(
        "SELECT state, lease_owner FROM control_plane.jobs WHERE id = $1",
        [plan.jobId],
      );
      // Approval survives the retry, so the job goes directly back to 'queued'.
      assert.equal(jobRow.rows[0]?.state, "queued");
      assert.equal(jobRow.rows[0]?.lease_owner, null);

      const planRow = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1",
        [plan.planId],
      );
      assert.equal(planRow.rows[0]?.status, "approved");

      const tripRow = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.tripId],
      );
      assert.equal(tripRow.rows[0]?.lifecycle_state, "provisioning_approved");

      // The re-queued job is immediately claimable without a new approval.
      const reclaim = await claimJob(fix.pool, "worker_02", 60);
      assert.equal(reclaim.ok, true);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("stale lease: job exhausted max_attempts is marked failed", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      // Set attempt to max_attempts and force an expired lease.
      await fix.pool.query(
        `UPDATE control_plane.jobs
         SET state = 'leased', lease_owner = 'dead_worker', lease_expires_at = now() - interval '1 second',
             attempt = max_attempts
         WHERE id = $1`,
        [plan.jobId],
      );

      await recoverStaleLeases(fix.pool);

      const jobRow = await fix.pool.query<{ state: string; safe_error_code: string }>(
        "SELECT state, safe_error_code FROM control_plane.jobs WHERE id = $1",
        [plan.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "failed");
      assert.equal(jobRow.rows[0]?.safe_error_code, "LEASE_EXHAUSTED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("completeJob: marks job succeeded", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      const claim = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");

      const completed = await completeJob(fix.pool, claim.claim.jobId, "worker_01", { output: "ok" });
      assert.equal(completed, true);

      const jobRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1",
        [claim.claim.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "succeeded");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("failJob with remaining attempts: re-queues without requiring reapproval", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      const claim = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");

      // Default max_attempts is 3; after the first claim, attempt = 1. Fail once.
      const failed = await failJob(fix.pool, claim.claim.jobId, "worker_01", "TRANSIENT_ERROR");
      assert.equal(failed, true);

      const jobRow = await fix.pool.query<{ state: string; safe_error_code: string | null }>(
        "SELECT state, safe_error_code FROM control_plane.jobs WHERE id = $1",
        [claim.claim.jobId],
      );
      // attempt (1) < max_attempts (3) → retryable. Approval survives, so the
      // job goes directly back to 'queued' without plan/trip reversion.
      assert.equal(jobRow.rows[0]?.state, "queued");
      assert.equal(jobRow.rows[0]?.safe_error_code, null);

      const planRow = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(planRow.rows[0]?.status, "approved");

      const tripRow = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.tripId],
      );
      assert.equal(tripRow.rows[0]?.lifecycle_state, "provisioning_approved");

      // The re-queued job is immediately claimable without a new approval.
      const reclaim = await claimJob(fix.pool, "worker_02", 60);
      assert.equal(reclaim.ok, true);
      assert.equal(reclaim.ok && reclaim.claim.jobId, claim.claim.jobId);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("retry path: claim → transient fail → re-claim → complete without reapproval", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const { planId, jobId } = await setupApprovedJob(fix);

      // First attempt: claim and fail transiently.
      const first = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      assert.equal(first.claim.attempt, 1);

      await failJob(fix.pool, jobId, "worker_01", "TRANSIENT_ERROR");

      // Second attempt: re-claim using the same approval — no new approval needed.
      const second = await claimJob(fix.pool, "worker_02", 60);
      assert.equal(second.ok, true);
      if (!second.ok) throw new Error("unreachable");
      assert.equal(second.claim.jobId, jobId);
      assert.equal(second.claim.attempt, 2);

      // Complete successfully.
      const completed = await completeJob(fix.pool, jobId, "worker_02", { output: "ok" });
      assert.equal(completed, true);

      const jobRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1", [jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "succeeded");

      // Approval is consumed after terminal success.
      const approvalRow = await fix.pool.query<{ used_at: Date | null }>(
        "SELECT used_at FROM control_plane.plan_approvals WHERE plan_id = $1", [planId],
      );
      assert.ok(approvalRow.rows[0]?.used_at !== null);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("failJob at max_attempts: marks job failed", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await setupApprovedJob(fix);

      // Exhaust all attempts directly.
      await fix.pool.query("UPDATE control_plane.jobs SET attempt = max_attempts - 1 WHERE trip_id = $1", [fix.tripId]);

      const claim = await claimJob(fix.pool, "worker_01", 60);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");

      const failed = await failJob(fix.pool, claim.claim.jobId, "worker_01", "CONTROLLED_PROVIDER_FAILURE");
      assert.equal(failed, true);

      const jobRow = await fix.pool.query<{ state: string; safe_error_code: string }>(
        "SELECT state, safe_error_code FROM control_plane.jobs WHERE id = $1",
        [claim.claim.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "failed");
      assert.equal(jobRow.rows[0]?.safe_error_code, "CONTROLLED_PROVIDER_FAILURE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("approval expiry recovery: re-queues job back to waiting_for_user_action", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      // Issue an already-expired approval.
      await issueApproval(fix.pool, plan.planId, "user:test", -1);

      // The job was moved to 'queued' by issueApproval even though the approval
      // was immediately expired. recoverExpiredApprovals should move it back.
      const recovered = await recoverExpiredApprovals(fix.pool);
      assert.equal(recovered, 1);

      const jobRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1",
        [plan.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "waiting_for_user_action");

      const planRow = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1",
        [plan.planId],
      );
      assert.equal(planRow.rows[0]?.status, "pending_approval");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("exit gate: approved plan has exactly one queued job; unapproved has none", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      // Before approval: no queued job.
      const beforeApproval = await fix.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_plane.jobs WHERE plan_id = $1 AND state = 'queued'",
        [plan.planId],
      );
      assert.equal(beforeApproval.rows[0]?.count, "0");

      await issueApproval(fix.pool, plan.planId, "user:test", 3600);

      // After approval: exactly one queued job.
      const afterApproval = await fix.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_plane.jobs WHERE plan_id = $1 AND state = 'queued'",
        [plan.planId],
      );
      assert.equal(afterApproval.rows[0]?.count, "1");
    } finally {
      await teardownFixture(fix);
    }
  });
});
