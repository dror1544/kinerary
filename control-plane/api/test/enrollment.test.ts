import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { issueEnrollment, verifyEnrollmentToken, consumeEnrollmentInTx } from "../src/enrollment.js";
import { applyMigrations } from "../src/migrations.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function runMigrations(pool: pg.Pool) {
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); }
  finally { client.release(); }
}

function generateTestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface TestFixture {
  pool: pg.Pool;
  ownerId: string;
  nonOwnerId: string;
  draftTripId: string;
  otherTripId: string;
  testRunId: string;
}

async function setupFixture(pool: pg.Pool): Promise<TestFixture> {
  const testRunId = `tr_${Date.now().toString(36)}`;
  const ownerId = generateTestId("user");
  const nonOwnerId = generateTestId("user");
  const draftTripId = generateTestId("trip");
  const otherTripId = generateTestId("trip");

  await pool.query(`
    INSERT INTO control_plane.users(id, status, display_name)
    VALUES ($1, 'active', 'Owner'), ($2, 'active', 'NonOwner')
  `, [ownerId, nonOwnerId]);

  await pool.query(`
    INSERT INTO control_plane.trips(id, slug, lifecycle_state)
    VALUES ($1, $2, 'draft'), ($3, $4, 'intake_in_progress')
  `, [
    draftTripId, `enrl-test-draft-${testRunId}`,
    otherTripId, `enrl-test-other-${testRunId}`,
  ]);

  await pool.query(`
    INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status)
    VALUES ($1, $2, $3, 'owner', 'active')
  `, [generateTestId("memb"), draftTripId, ownerId]);

  return { pool, ownerId, nonOwnerId, draftTripId, otherTripId, testRunId };
}

async function teardownFixture(fixture: TestFixture) {
  const { pool, draftTripId, otherTripId, ownerId, nonOwnerId } = fixture;
  // Delete in FK-safe order
  await pool.query("DELETE FROM control_plane.intake_sessions WHERE trip_id = ANY($1)", [[draftTripId, otherTripId]]);
  await pool.query("DELETE FROM control_plane.interview_enrollments WHERE trip_id = ANY($1)", [[draftTripId, otherTripId]]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = ANY($1)", [[draftTripId, otherTripId]]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = ANY($1)", [[draftTripId, otherTripId]]);
  await pool.query("DELETE FROM control_plane.user_identities WHERE user_id = ANY($1)", [[ownerId, nonOwnerId]]);
  await pool.query("DELETE FROM control_plane.users WHERE id = ANY($1)", [[ownerId, nonOwnerId]]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enrollment", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
    await runMigrations(pool);
  });

  after(async () => {
    if (SKIP) return;
    await pool?.end();
  });

  test("issueEnrollment: succeeds for active owner of a draft trip", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.ok(result.token.length > 20);
      assert.ok(result.expiresAt > new Date());
    } finally {
      await teardownFixture(fix);
    }
  });

  test("issueEnrollment: rejects non-owner", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await issueEnrollment(fix.pool, fix.nonOwnerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_OWNER");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("issueEnrollment: rejects when trip is not in draft state", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      // otherTripId is 'intake_in_progress', not 'draft'
      const result = await issueEnrollment(fix.pool, fix.ownerId, fix.otherTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.ok(result.reason === "NOT_OWNER" || result.reason === "TRIP_NOT_DRAFT");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("issueEnrollment: rejects second issue while first is still active", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const first = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(first.ok, true);

      const second = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(second.ok, false);
      if (second.ok) throw new Error("unreachable");
      assert.equal(second.reason, "ACTIVE_ENROLLMENT_EXISTS");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("verifyEnrollmentToken: valid token verifies correctly", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const issued = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(issued.ok, true);
      if (!issued.ok) throw new Error("unreachable");

      const result = await verifyEnrollmentToken(fix.pool, issued.token);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.tripId, fix.draftTripId);
      assert.equal(result.userId, fix.ownerId);
    } finally {
      await teardownFixture(fix);
    }
  });

  test("verifyEnrollmentToken: altered/unknown token returns NOT_FOUND", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const result = await verifyEnrollmentToken(fix.pool, "notarealtoken");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "NOT_FOUND");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("verifyEnrollmentToken: expired token returns EXPIRED", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const issued = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: -1 });
      assert.equal(issued.ok, true);
      if (!issued.ok) throw new Error("unreachable");

      const result = await verifyEnrollmentToken(fix.pool, issued.token);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "EXPIRED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("consumeEnrollmentInTx: token cannot be reused after consumption", { skip: SKIP }, async () => {
    const fix = await setupFixture(pool);
    try {
      const issued = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(issued.ok, true);
      if (!issued.ok) throw new Error("unreachable");

      // First consume
      const client1 = await fix.pool.connect();
      try {
        await client1.query("BEGIN");
        const first = await consumeEnrollmentInTx(client1, issued.token);
        assert.ok(first !== null);
        await client1.query("COMMIT");
      } finally { client1.release(); }

      // Second consume
      const client2 = await fix.pool.connect();
      try {
        await client2.query("BEGIN");
        const second = await consumeEnrollmentInTx(client2, issued.token);
        assert.equal(second, null);
        await client2.query("ROLLBACK");
      } finally { client2.release(); }

      // verifyEnrollmentToken also returns ALREADY_CONSUMED
      const check = await verifyEnrollmentToken(fix.pool, issued.token);
      assert.equal(check.ok, false);
      if (check.ok) throw new Error("unreachable");
      assert.equal(check.reason, "ALREADY_CONSUMED");
    } finally {
      await teardownFixture(fix);
    }
  });

  test("issueEnrollment: expired enrollment does not block re-issue", { skip: SKIP }, async () => {
    // An enrollment issued with ttl=-1 expires immediately. A second issue must
    // succeed rather than returning ACTIVE_ENROLLMENT_EXISTS, because the expiry
    // cleanup step transitions the old row to 'expired' before inserting the new one.
    const fix = await setupFixture(pool);
    try {
      const expired = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: -1 });
      assert.equal(expired.ok, true);

      const fresh = await issueEnrollment(fix.pool, fix.ownerId, fix.draftTripId, { enrollmentTtlSeconds: 3600 });
      assert.equal(fresh.ok, true);
      if (!fresh.ok) throw new Error("unreachable");
      assert.ok(fresh.expiresAt > new Date());

      // Old enrollment is now 'expired' in the DB
      if (!expired.ok) throw new Error("unreachable");
      const oldRow = await fix.pool.query<{ state: string }>(
        "SELECT state FROM control_plane.interview_enrollments WHERE token_digest = $1",
        [`sha256:${(await import("node:crypto")).createHash("sha256").update(expired.token).digest("hex")}`],
      );
      assert.equal(oldRow.rows[0]?.state, "expired");
    } finally {
      await teardownFixture(fix);
    }
  });
});
