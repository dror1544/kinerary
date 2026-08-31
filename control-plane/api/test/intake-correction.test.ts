import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { correctIntake } from "../src/intake-correction.js";
import { generatePlan } from "../src/planner.js";
import { issueApproval } from "../src/plan-approval.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

// This suite's fixture release carries no sealed manifest; generatePlan() only
// selects such a release when the unsealed-fallback opt-in is set (planner.ts /
// migration 0027). Production leaves it unset.
process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE = "1";

async function runMigrations(pool: pg.Pool) {
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); }
  finally { client.release(); }
}

function randomHex(n: number) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}
function generateTestId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomHex(8)}`;
}

interface CorrectionFixture {
  pool: pg.Pool;
  ownerId: string;
  tripId: string;
  slug: string;
  releaseId: string;
  intakeVersionId: string;
  correlationId: string;
}

const JAPAN_ANSWERS = {
  trip_type: { kind: "choice", option_id: "family", schema_version: 1, other_text: null },
  destination: { kind: "text", schema_version: 1, text: "Japan" },
  group_size: { kind: "choice", option_id: "2", schema_version: 1, other_text: null },
  trip_duration: { kind: "choice", option_id: "two_weeks", schema_version: 1, other_text: null },
  departure_date: { kind: "text", schema_version: 1, text: "2026-09-06" },
  return_date: { kind: "text", schema_version: 1, text: "2026-09-20" },
  travelers: { kind: "structured", schema_version: 1, data: [{ name: "Eitan", age: 52, family: "Sagi" }] },
  phases: { kind: "structured", schema_version: 1, data: [{ name: "Tokyo", start: "2026-09-06", end: "2026-09-20" }] },
};

const CORRECTED_ANSWERS = {
  ...JAPAN_ANSWERS,
  destination: { kind: "text", schema_version: 1, text: "South Korea" },
};

async function setupFixture(pool: pg.Pool, initialState: string = "intake_confirmed"): Promise<CorrectionFixture> {
  const ownerId = generateTestId("user");
  const tripId = generateTestId("trip");
  const slug = `corr-test-${Date.now().toString(36)}`;
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
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, $3)",
    [tripId, slug, initialState],
  );
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [generateTestId("memb"), tripId, ownerId],
  );
  await pool.query(
    // Direct insert: carry the promotion bookkeeping migration 0027 requires of
    // any 'available' row (releases_available_requires_promotion).
    `INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by)
     VALUES ($1, $2, $3, 1, 1, 1, 'available', now(), 'test:fixture')`,
    [releaseId, sourceRevision, artifactDigest],
  );
  await pool.query(
    `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data)
     VALUES ($1, $2, 1, 'intake:sessions:sess_test:v1', $3, now(), 1, $4::jsonb)`,
    [intakeVersionId, tripId, intakeDigest, JSON.stringify(JAPAN_ANSWERS)],
  );

  return { pool, ownerId, tripId, slug, releaseId, intakeVersionId, correlationId };
}

async function teardownFixture(fix: CorrectionFixture) {
  const { pool, tripId, ownerId, releaseId } = fix;
  await pool.query("DELETE FROM control_plane.plan_approvals WHERE plan_id IN (SELECT id FROM control_plane.plans WHERE trip_id = $1)", [tripId]);
  await pool.query("DELETE FROM control_plane.job_steps WHERE job_id IN (SELECT id FROM control_plane.jobs WHERE trip_id = $1)", [tripId]);
  await pool.query("DELETE FROM control_plane.jobs WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.plans WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.intake_versions WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
  await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [releaseId]);
  await pool.query("DELETE FROM control_plane.users WHERE id = $1", [ownerId]);
}

describe("correctIntake", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL });
    await runMigrations(pool);
  });

  after(async () => {
    if (SKIP) return;
    await pool.end();
  });

  test("creates a new intake version with incremented version number", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.version, 2);

      const row = await fix.pool.query<{ version: number; data: Record<string, unknown> }>(
        "SELECT version, data FROM control_plane.intake_versions WHERE id = $1",
        [result.versionId],
      );
      assert.equal(row.rows[0]?.version, 2);
      assert.deepEqual((row.rows[0]?.data as { destination: { text: string } })?.destination?.text, "South Korea");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("rejects unsafe corrected content without creating a new version", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const unsafeAnswers = {
        ...CORRECTED_ANSWERS,
        destination: {
          kind: "text",
          schema_version: 1,
          text: "Private endpoint 192.168.1.10",
        },
      };

      const result = await correctIntake(pool, fix.tripId, "user:test", unsafeAnswers);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "UNSAFE_ANSWER_CONTENT");
      if (result.reason !== "UNSAFE_ANSWER_CONTENT") throw new Error("unreachable");
      assert.match(result.unsafePath, /destination/);

      const versionCount = await fix.pool.query<{ count: string }>(
        "SELECT count(*) FROM control_plane.intake_versions WHERE trip_id = $1",
        [fix.tripId],
      );
      assert.equal(versionCount.rows[0]?.count, "1");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("previous confirmed version is unchanged", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      const row = await fix.pool.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM control_plane.intake_versions WHERE id = $1",
        [fix.intakeVersionId],
      );
      assert.deepEqual((row.rows[0]?.data as { destination: { text: string } })?.destination?.text, "Japan");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("reverts trip to intake_confirmed", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool, "planned");
    try {
      await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      const row = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.tripId],
      );
      assert.equal(row.rows[0]?.lifecycle_state, "intake_confirmed");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("supersedes active pending_approval plan", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);

      await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);

      const planRow = await fix.pool.query<{ status: string }>(
        "SELECT status FROM control_plane.plans WHERE trip_id = $1",
        [fix.tripId],
      );
      // Both the original plan (just generated) should be superseded.
      assert.ok(planRow.rows.every((r) => r.status === "superseded"));
    } finally {
      await teardownFixture(fix);
    }
  });

  test("cancels queued jobs when plan is superseded", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");

      // Move job to queued via approval so it's claimable.
      await issueApproval(fix.pool, plan.planId, "user:test", 3600);

      await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);

      const jobRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.jobs WHERE id = $1",
        [plan.jobId],
      );
      assert.equal(jobRow.rows[0]?.state, "cancelled");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("allows generating a new plan after correction", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const plan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(plan.ok, true);

      await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);

      const newPlan = await generatePlan(fix.pool, fix.tripId, fix.correlationId);
      assert.equal(newPlan.ok, true, `expected new plan to be generated, got: ${!newPlan.ok ? newPlan.reason : "ok"}`);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("returns TRIP_NOT_FOUND for unknown trip", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await correctIntake(pool, "trip_doesnotexist1234567890abcdef", "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "TRIP_NOT_FOUND");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("returns INVALID_STATE when trip is active", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool, "active");
    try {
      const result = await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "INVALID_STATE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("returns INVALID_STATE when trip is draft", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool, "draft");
    try {
      const result = await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "INVALID_STATE");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("returns NO_INTAKE_TO_CORRECT when no confirmed version exists", { skip: SKIP }, async () => {
    // Create trip with no intake_version.
    const ownerId = generateTestId("user");
    const tripId = generateTestId("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [ownerId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'intake_confirmed')", [tripId, `no-intake-${Date.now().toString(36)}`]);
    try {
      const result = await correctIntake(pool, tripId, "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NO_INTAKE_TO_CORRECT");
    } finally {
      await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
      await pool.query("DELETE FROM control_plane.users WHERE id = $1", [ownerId]);
    }
  });

  test("can correct from provisioning_approved state", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool, "provisioning_approved");
    try {
      const result = await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, true);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("can correct from ready_private — a live trip, reverting to intake_confirmed", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool, "ready_private");
    try {
      const result = await correctIntake(pool, fix.tripId, "user:test", CORRECTED_ANSWERS);
      assert.equal(result.ok, true);
      const row = await fix.pool.query<{ lifecycle_state: string }>(
        "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
        [fix.tripId],
      );
      assert.equal(row.rows[0]?.lifecycle_state, "intake_confirmed");
    } finally {
      await teardownFixture(fix);
    }
  });
});
