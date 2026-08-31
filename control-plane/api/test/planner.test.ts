import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { generatePlan, retryProvision } from "../src/planner.js";
import { issueApproval } from "../src/plan-approval.js";
import { claimJob, heartbeat, recoverStaleLeases, recoverExpiredApprovals, completeJob, failJob } from "../src/job-queue.js";
import { buildReleaseManifest, type PayloadSource } from "../src/release-artifact.js";
import { promoteRelease, registerCandidateRelease } from "../src/release-registry.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

// generatePlan() only selects a manifest-less 'available' release when this is
// set (see planner.ts / migration 0027 — the production default is OFF, so a
// deprecated sealed release never silently falls back to unscanned code). The
// fixtures here use a manifest-less release, so opt this file's process in;
// the dedicated "production default" test below clears it around its own body.
process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE = "1";

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
    // Direct insert (not via promoteRelease), so it must carry the promotion
    // bookkeeping migration 0027's releases_available_requires_promotion demands
    // of any 'available' row — the same way migration 0016's seed does.
    `INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by)
     VALUES ($1, $2, $3, 1, 1, 1, 'available', now(), 'test:fixture')`,
    [releaseId, sourceRevision, artifactDigest],
  );
  await pool.query(
    `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version)
     VALUES ($1, $2, 1, 'intake:sessions:sess_test:v1', $3, now(), 1)`,
    [intakeVersionId, tripId, intakeDigest],
  );

  return { pool, ownerId, tripId, releaseId, intakeVersionId, intakeDigest, correlationId };
}

// Hides every 'available' release other than the fixture's own — including the
// permanent dev-seed release from migration 0016 — so a test can construct a
// genuine "no compatible release" scenario. Pushes the schema range out of
// reach rather than flipping status: migration 0027's transition trigger
// forbids deprecated -> available, so a status round-trip can't be undone.
// Returns the prior ranges to restore afterward.
type HiddenRelease = { id: string; min: number; max: number };

async function withOtherAvailableReleasesHidden(fix: PlannerFixture): Promise<HiddenRelease[]> {
  const { rows } = await fix.pool.query<{ id: string; data_schema_min: number; data_schema_max: number }>(
    "SELECT id, data_schema_min, data_schema_max FROM control_plane.releases WHERE status = 'available' AND id <> $1",
    [fix.releaseId],
  );
  if (rows.length === 0) return [];
  await fix.pool.query(
    "UPDATE control_plane.releases SET data_schema_min = 999, data_schema_max = 999 WHERE id = ANY($1)",
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({ id: r.id, min: r.data_schema_min, max: r.data_schema_max }));
}

async function restoreAvailableReleases(_fix: PlannerFixture, hidden: HiddenRelease[]): Promise<void> {
  for (const h of hidden) {
    await _fix.pool.query(
      "UPDATE control_plane.releases SET data_schema_min = $2, data_schema_max = $3 WHERE id = $1",
      [h.id, h.min, h.max],
    );
  }
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

      // desired pins the exact source the worker must deploy. The fixture
      // release carries no manifest, so release_verified is false.
      const desired = (await fix.pool.query<{ desired: Record<string, unknown> }>(
        "SELECT desired FROM control_plane.plans WHERE id = $1", [result.planId],
      )).rows[0]!.desired;
      assert.equal(desired.release_id, fix.releaseId);
      assert.match(desired.release_source_revision as string, /^[a-f0-9]{40}$/);
      assert.match(desired.release_artifact_digest as string, /^sha256:[a-f0-9]{64}$/);
      assert.equal(desired.release_verified, false);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("desired.first_provision is true until a provision job has succeeded", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      const firstDesired = (await fix.pool.query<{ desired: { first_provision?: boolean } }>(
        "SELECT desired FROM control_plane.plans WHERE id = $1", [first.planId],
      )).rows[0]!.desired;
      assert.equal(firstDesired.first_provision, true);

      // Simulate a completed provision. A second plan then carries
      // first_provision:false, which also gives it a different digest — so no
      // supersede/delete gymnastics are needed to dodge plans_trip_id_digest_key.
      await fix.pool.query(
        `INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state)
         VALUES ($1, $2, $3, 'provision', $4, $5, 'succeeded')`,
        [`job_${randomHex(16)}`, fix.tripId, first.planId, `done-${first.planId}`, `corr_${randomHex(16)}`],
      );
      await fix.pool.query("UPDATE control_plane.plans SET status = 'superseded' WHERE id = $1", [first.planId]);
      await fix.pool.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed' WHERE id = $1", [fix.tripId]);

      const second = await generatePlan(fix.pool, fix.tripId, `corr_${randomHex(8)}`);
      assert.equal(second.ok, true);
      if (!second.ok) throw new Error("unreachable");
      const secondDesired = (await fix.pool.query<{ desired: { first_provision?: boolean } }>(
        "SELECT desired FROM control_plane.plans WHERE id = $1", [second.planId],
      )).rows[0]!.desired;
      assert.equal(secondDesired.first_provision, false);
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
    // The dev-seed migration (0016) inserts a permanently 'available' release
    // so generatePlan has something to select against outside tests. Neutralize
    // every other available release so this scenario is genuinely release-less.
    const others = await withOtherAvailableReleasesHidden(fix);
    try {
      // Mark the release as deprecated so no available release exists.
      await fix.pool.query("UPDATE control_plane.releases SET status = 'deprecated' WHERE id = $1", [fix.releaseId]);
      const result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NO_COMPATIBLE_RELEASE");
    } finally {
      await restoreAvailableReleases(fix, others);
      await teardownFixture(fix);
    }
  });

  test("rejects a release with incompatible schema range", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    // Same interference as above: neutralize the dev-seed release so it
    // cannot mask the fixture release's now-incompatible schema range.
    const others = await withOtherAvailableReleasesHidden(fix);
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
      await restoreAvailableReleases(fix, others);
      await teardownFixture(fix);
    }
  });

  test("only an 'available' release is selectable — a candidate/verified one is not", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    const others = await withOtherAvailableReleasesHidden(fix);
    // Take the fixture's own release out of the pool too, so the only path to a
    // plan is the pipeline-built release we promote below.
    await fix.pool.query("UPDATE control_plane.releases SET status = 'deprecated' WHERE id = $1", [fix.releaseId]);

    // Build + register a real candidate through the release pipeline.
    const revision = randomHex(40);
    const source: PayloadSource = {
      async resolveRevision() { return revision; },
      async listPayload() {
        return [
          { path: "server/server.js", blobSha: randomHex(40) },
          { path: "shared/schema.js", blobSha: randomHex(40) },
          { path: "site/app.js", blobSha: randomHex(40) },
        ];
      },
      async readTextFile() { return "// clean\nconst v = process.env.X;\n"; },
    };
    const manifest = await buildReleaseManifest(source, {
      applicationSchema: 1, dataSchemaMin: 1, dataSchemaMax: 2,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    const { releaseId } = await registerCandidateRelease(fix.pool, manifest);

    try {
      // candidate → no plan
      let result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.reason, "NO_COMPATIBLE_RELEASE");

      // verified but not available → still no plan
      assert.equal((await promoteRelease(fix.pool, { releaseId, to: "verified", actorRef: "operator:test" })).ok, true);
      result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.reason, "NO_COMPATIBLE_RELEASE");

      // available → the planner selects exactly this release
      assert.equal((await promoteRelease(fix.pool, { releaseId, to: "available", actorRef: "operator:test" })).ok, true);
      result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.releaseId, releaseId);

      // A manifest-backed release → the worker will materialize + digest-verify it.
      const desired = (await fix.pool.query<{ desired: Record<string, unknown> }>(
        "SELECT desired FROM control_plane.plans WHERE id = $1", [result.planId],
      )).rows[0]!.desired;
      assert.equal(desired.release_verified, true);
      assert.equal(desired.release_source_revision, revision);
      assert.equal(desired.release_artifact_digest, manifest.artifactDigest);
    } finally {
      await restoreAvailableReleases(fix, others);
      await teardownFixture(fix);
      await fix.pool.query("DELETE FROM control_plane.releases WHERE id = $1", [releaseId]);
    }
  });

  test("production default: a manifest-less 'available' release is NOT selectable", { skip: SKIP }, async () => {
    // The dev-seed release (migration 0016 / 0027) is 'available' but carries a
    // `legacy-hand-seed` manifest with no `files` — unmaterializable and
    // unverifiable. With CONTROL_PLANE_ALLOW_UNSEALED_RELEASE unset (what a real
    // deployment runs), generatePlan must not pick it and silently fall the
    // worker back to the ambient checkout.
    const fix = await setupFixture(pool);
    // Take the fixture's own (also manifest-less) release out of the pool so the
    // dev seed is the only 'available' row left.
    await fix.pool.query("UPDATE control_plane.releases SET status = 'deprecated' WHERE id = $1", [fix.releaseId]);
    const prior = process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE;
    try {
      delete process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE;
      let result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.reason, "NO_COMPATIBLE_RELEASE");

      // Flip the local-dev opt-in back on: the same seed is now selectable, and
      // the plan is explicitly marked unverified so the worker deploys REPO_ROOT
      // with a warning rather than trying to digest-check a placeholder.
      process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE = "1";
      result = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      const desired = (await fix.pool.query<{ desired: Record<string, unknown> }>(
        "SELECT desired FROM control_plane.plans WHERE id = $1", [result.planId],
      )).rows[0]!.desired;
      assert.equal(desired.release_verified, false);
    } finally {
      if (prior === undefined) delete process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE;
      else process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE = prior;
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

describe("retryProvision", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await runMigrations(pool);
  });

  after(async () => { if (!SKIP) await pool?.end(); });

  // Leaves the trip in the exact shape _fail() / failJob() do at max_attempts:
  // job 'failed' with a safe error code, plan 'superseded', approval consumed,
  // trip still parked at 'provisioning_approved'.
  async function simulateTerminalFailure(fix: PlannerFixture, planId: string, jobId: string) {
    await fix.pool.query(
      "UPDATE control_plane.jobs SET state = 'failed', safe_error_code = 'PROVISIONER_ERROR', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [jobId],
    );
    await fix.pool.query("UPDATE control_plane.plan_approvals SET used_at = now() WHERE plan_id = $1", [planId]);
    await fix.pool.query("UPDATE control_plane.plans SET status = 'superseded' WHERE id = $1", [planId]);
  }

  test("recovers a terminally failed provision to a fresh queued job — no DB edits, same digest", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      const approval = await issueApproval(fix.pool, first.planId, "user:test", 3600);
      assert.equal(approval.ok, true);
      await simulateTerminalFailure(fix, first.planId, first.jobId);

      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, true);
      if (!retry.ok) throw new Error("unreachable");

      // A brand-new plan, with the SAME digest as the dead one — proving the
      // 0026 partial index lets a retired digest be reused.
      assert.notEqual(retry.planId, first.planId);
      assert.equal(retry.planDigest, first.planDigest);
      assert.equal(retry.supersededPlanId, null); // the failed plan was already superseded

      const newPlan = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1", [retry.planId],
      );
      assert.equal(newPlan.rows[0]?.status, "pending_approval");
      const newJob = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1", [retry.jobId],
      );
      assert.equal(newJob.rows[0]?.state, "waiting_for_user_action");

      // History preserved: the failed plan is still there, still superseded.
      const oldPlan = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1", [first.planId],
      );
      assert.equal(oldPlan.rows[0]?.status, "superseded");

      const trip = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [fix.tripId],
      );
      assert.equal(trip.rows[0]?.lifecycle_state, "planned");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("re-provision of a live trip: first_provision=false, executed plan untouched", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      // Simulate a completed provision: job succeeded, plan executed, trip live.
      await fix.pool.query(
        "UPDATE control_plane.jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
        [first.jobId],
      );
      await fix.pool.query("UPDATE control_plane.plans SET status = 'executed' WHERE id = $1", [first.planId]);
      await fix.pool.query("UPDATE control_plane.trips SET lifecycle_state = 'ready_private' WHERE id = $1", [fix.tripId]);

      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, true);
      if (!retry.ok) throw new Error("unreachable");

      const desired = (await fix.pool.query<{ desired: { first_provision?: boolean } }>(
        "SELECT desired FROM control_plane.plans WHERE id = $1", [retry.planId],
      )).rows[0]!.desired;
      assert.equal(desired.first_provision, false);
      // A live-trip re-provision has a different digest from the first
      // (first_provision flipped), but that is incidental — the point is the
      // executed plan is left as history, not disturbed.
      const oldPlan = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1", [first.planId],
      );
      assert.equal(oldPlan.rows[0]?.status, "executed");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("supersedes a still-active plan and cancels its non-terminal job", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      const approval = await issueApproval(fix.pool, first.planId, "user:test", 3600);
      assert.equal(approval.ok, true);
      // Job is now 'queued', plan 'approved', trip 'provisioning_approved'.

      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, true);
      if (!retry.ok) throw new Error("unreachable");
      assert.equal(retry.supersededPlanId, first.planId);

      const oldPlan = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE id = $1", [first.planId],
      );
      assert.equal(oldPlan.rows[0]?.status, "superseded");
      const oldJob = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1", [first.jobId],
      );
      assert.equal(oldJob.rows[0]?.state, "cancelled");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("cancels a non-terminal provision job even after its plan was superseded elsewhere", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      await issueApproval(fix.pool, first.planId, "user:test", 3600);
      // Something else superseded the plan but left the queued job behind — an
      // orphan the old plan_id-scoped cancel would have missed. The retry is
      // trip-scoped now, so it still clears it.
      await fix.pool.query("UPDATE control_plane.plans SET status = 'superseded' WHERE id = $1", [first.planId]);

      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, true);
      if (!retry.ok) throw new Error("unreachable");
      assert.equal(retry.supersededPlanId, null); // nothing active left to supersede

      const oldJob = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1", [first.jobId],
      );
      assert.equal(oldJob.rows[0]?.state, "cancelled");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("refuses while a provision job holds a live lease", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      await issueApproval(fix.pool, first.planId, "user:test", 3600);
      const claim = await claimJob(fix.pool, "worker_live", 600);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error("unreachable");
      assert.equal(claim.claim.tripId, fix.tripId);

      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, false);
      if (retry.ok) throw new Error("unreachable");
      assert.equal(retry.reason, "PROVISION_IN_PROGRESS");

      // Nothing touched.
      const job = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1", [first.jobId],
      );
      assert.equal(job.rows[0]?.state, "leased");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("cancels a stale (expired) lease and re-plans", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      await issueApproval(fix.pool, first.planId, "user:test", 3600);
      const claim = await claimJob(fix.pool, "worker_stale", 600);
      assert.equal(claim.ok, true);
      // Force the lease into the past.
      await fix.pool.query(
        "UPDATE control_plane.jobs SET lease_expires_at = now() - interval '1 hour' WHERE id = $1",
        [first.jobId],
      );

      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, true);
      if (!retry.ok) throw new Error("unreachable");
      assert.equal(retry.supersededPlanId, first.planId);
      const oldJob = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1", [first.jobId],
      );
      assert.equal(oldJob.rows[0]?.state, "cancelled");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects a trip in a non-retryable lifecycle state", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await fix.pool.query("UPDATE control_plane.trips SET lifecycle_state = 'active' WHERE id = $1", [fix.tripId]);
      const retry = await retryProvision(fix.pool, fix.tripId, `corr_${randomHex(12)}`);
      assert.equal(retry.ok, false);
      if (retry.ok) throw new Error("unreachable");
      assert.equal(retry.reason, "NOT_RETRYABLE_STATE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects an unknown trip", { skip: SKIP }, async () => {
    const retry = await retryProvision(pool, `trip_${randomHex(16)}`, `corr_${randomHex(12)}`);
    assert.equal(retry.ok, false);
    if (retry.ok) throw new Error("unreachable");
    assert.equal(retry.reason, "TRIP_NOT_FOUND");
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
