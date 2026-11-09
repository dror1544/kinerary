import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { generatePlan } from "../src/planner.js";
import { issueApproval } from "../src/plan-approval.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// POST /v1/trips/:id/provisioning-retry - the dashboard's "Try again" on a build the worker gave up on.
// generatePlan only picks a manifest-less 'available' release under this flag (the fixture's release has none).
process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE = "1";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
const hex = (n: number) => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
const ids = {
  owner: `user_${suffix}a`, secondary: `user_${suffix}b`, member: `user_${suffix}c`, stranger: `user_${suffix}d`,
  trip: `trip_${suffix}a`, release: `rls_${suffix}a`, intake: `intk_${suffix}a`,
};
let pool: pg.Pool;

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function portalDeps(db: pg.Pool): PortalDependencies {
  return {
    db,
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => undefined },
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, operatorChatId: "operator-chat-1",
  };
}

async function session(userId: string, label: string) {
  const raw = `session-${label}-${suffix}`, csrf = `csrf-${label}-${suffix}`;
  await pool.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [`wsess_${suffix}${label}`, userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
}

/** A trip whose build ran out of attempts, in the shape the worker's `_fail` leaves: job failed, plan retired, approval spent. */
async function failTheBuild(): Promise<{ planId: string; jobId: string }> {
  await pool.query("UPDATE control_plane.plans SET status = 'superseded' WHERE trip_id = $1 AND status IN ('pending_approval','approved')", [ids.trip]);
  await pool.query("UPDATE control_plane.jobs SET state = 'cancelled' WHERE trip_id = $1 AND state NOT IN ('succeeded','failed','cancelled')", [ids.trip]);
  await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed' WHERE id = $1", [ids.trip]);
  const plan = await generatePlan(pool, ids.trip, `corr_${hex(12)}`);
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("unreachable");
  const approval = await issueApproval(pool, plan.planId, `user:${ids.owner}`, 3600);
  assert.equal(approval.ok, true);
  await pool.query("UPDATE control_plane.jobs SET state = 'failed', attempt = max_attempts, safe_error_code = 'PROVISIONER_ERROR', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [plan.jobId]);
  await pool.query("UPDATE control_plane.plan_approvals SET used_at = now() WHERE plan_id = $1", [plan.planId]);
  await pool.query("UPDATE control_plane.plans SET status = 'superseded' WHERE id = $1", [plan.planId]);
  return { planId: plan.planId, jobId: plan.jobId };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 3 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  await pool.query(
    `INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Owner'),($2,'active','Second'),($3,'active','Member'),($4,'active','Stranger')`,
    [ids.owner, ids.secondary, ids.member, ids.stranger]);
  await pool.query(`INSERT INTO control_plane.trips(id,slug,lifecycle_state,title,destination_label) VALUES ($1,$2,'intake_confirmed','Retry trip','Rome')`, [ids.trip, `retry-${suffix}`]);
  await pool.query(
    `INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access)
     VALUES ($1,$5,$2,'owner','active',true,true),($3,$5,$4,'member','active',false,true),($6,$5,$7,'organizer','active',false,true)`,
    [`memb_${suffix}a`, ids.owner, `memb_${suffix}b`, ids.member, ids.trip, `memb_${suffix}c`, ids.secondary]);
  await pool.query(
    `INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by)
     VALUES ($1, $2, $3, 1, 1, 1, 'available', now(), 'test:fixture')`,
    [ids.release, hex(40), `sha256:${hex(64)}`]);
  await pool.query(
    `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version)
     VALUES ($1, $2, 1, 'intake:sessions:sess_test:v1', $3, now(), 1)`,
    [ids.intake, ids.trip, `sha256:${hex(64)}`]);
});

after(async () => {
  if (skip) return;
  const trip = [ids.trip];
  const users = [ids.owner, ids.secondary, ids.member, ids.stranger];
  await pool.query("DELETE FROM control_plane.notification_outbox WHERE trip_id = ANY($1)", [trip]);
  await pool.query("DELETE FROM control_plane.plan_approvals WHERE plan_id IN (SELECT id FROM control_plane.plans WHERE trip_id = ANY($1))", [trip]);
  await pool.query("DELETE FROM control_plane.job_steps WHERE job_id IN (SELECT id FROM control_plane.jobs WHERE trip_id = ANY($1))", [trip]);
  await pool.query("DELETE FROM control_plane.jobs WHERE trip_id = ANY($1)", [trip]);
  await pool.query("DELETE FROM control_plane.plans WHERE trip_id = ANY($1)", [trip]);
  await pool.query("DELETE FROM control_plane.intake_versions WHERE trip_id = ANY($1)", [trip]);
  await pool.query("DELETE FROM control_plane.web_sessions WHERE user_id = ANY($1)", [users]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = ANY($1)", [trip]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = ANY($1)", [trip]);
  await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [ids.release]);
  await pool.query("DELETE FROM control_plane.users WHERE id = ANY($1)", [users]);
  await pool.end();
});

test("the dashboard offers retry_provisioning once the build has failed for good, and not while it is being retried", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const { cookie } = await session(ids.owner, "next");
    const failed = await failTheBuild();
    const detail = await app.inject({ method: "GET", url: `/v1/trips/${ids.trip}`, headers: { cookie } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().nextAction, "retry_provisioning");
    assert.equal(detail.json().provisioning.jobState, "failed");
    assert.equal(detail.json().provisioning.planId, failed.planId);

    // A build still in its retry backoff (job queued) is not offered a second one.
    await pool.query("UPDATE control_plane.jobs SET state = 'queued' WHERE id = $1", [failed.jobId]);
    const queued = await app.inject({ method: "GET", url: `/v1/trips/${ids.trip}`, headers: { cookie } });
    assert.equal(queued.json().nextAction, "track_provisioning");
  } finally { await app.close(); }
});

test("the owner retries a failed build: a fresh approved plan and a queued job, no second review", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const { cookie, csrf } = await session(ids.owner, "retry");
    const failed = await failTheBuild();
    const response = await app.inject({ method: "POST", url: `/v1/trips/${ids.trip}/provisioning-retry`, headers: { cookie, "x-csrf-token": csrf } });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.notEqual(body.planId, failed.planId);
    assert.equal(body.planStatus, "approved");

    const job = await pool.query("SELECT state, attempt, lease_expires_at FROM control_plane.jobs WHERE id = $1", [body.jobId]);
    assert.equal(job.rows[0].state, "queued", "claimable by the worker without a second review");
    assert.equal(job.rows[0].attempt, 0, "a fresh job: the earlier attempts are not carried over");
    assert.equal(job.rows[0].lease_expires_at, null, "and not held back by the earlier job's backoff");
    const plan = await pool.query("SELECT status FROM control_plane.plans WHERE id = $1", [body.planId]);
    assert.equal(plan.rows[0].status, "approved");
    const approval = await pool.query("SELECT issued_by, used_at FROM control_plane.plan_approvals WHERE plan_id = $1", [body.planId]);
    assert.equal(approval.rows[0].issued_by, `user:${ids.owner}`);
    assert.equal(approval.rows[0].used_at, null);
    const old = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [failed.jobId]);
    assert.equal(old.rows[0].state, "failed", "the failed attempt stays as history");

    // A second tap while that build is queued is refused: never a second build.
    const again = await app.inject({ method: "POST", url: `/v1/trips/${ids.trip}/provisioning-retry`, headers: { cookie, "x-csrf-token": csrf } });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, "NOT_FAILED");
  } finally { await app.close(); }
});

test("only the main organizer may retry: a secondary organizer and a member get 403, a stranger 404, no session 401", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const failed = await failTheBuild();
    const url = `/v1/trips/${ids.trip}/provisioning-retry`;
    for (const [userId, label, status] of [[ids.secondary, "sec", 403], [ids.member, "mem", 403], [ids.stranger, "str", 404]] as const) {
      const { cookie, csrf } = await session(userId, `deny${label}`);
      const response = await app.inject({ method: "POST", url, headers: { cookie, "x-csrf-token": csrf } });
      assert.equal(response.statusCode, status, label);
    }
    const anonymous = await app.inject({ method: "POST", url });
    assert.equal(anonymous.statusCode, 401);
    // Nothing moved: the latest job is still the failed one.
    const jobs = await pool.query("SELECT id, state FROM control_plane.jobs WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1", [ids.trip]);
    assert.deepEqual(jobs.rows[0], { id: failed.jobId, state: "failed" });
  } finally { await app.close(); }
});

test("a request without the CSRF token is refused, and so is a retry when the build has not failed", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const { cookie, csrf } = await session(ids.owner, "csrf");
    const failed = await failTheBuild();
    const url = `/v1/trips/${ids.trip}/provisioning-retry`;
    const noCsrf = await app.inject({ method: "POST", url, headers: { cookie } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error, "CSRF_INVALID");
    const wrongCsrf = await app.inject({ method: "POST", url, headers: { cookie, "x-csrf-token": "not-the-token" } });
    assert.equal(wrongCsrf.statusCode, 403);
    const job = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [failed.jobId]);
    assert.equal(job.rows[0].state, "failed", "a refused request changed nothing");

    // Not terminally failed: the plan is waiting for the organizer's review.
    await pool.query("UPDATE control_plane.plans SET status = 'pending_approval' WHERE id = $1", [failed.planId]);
    await pool.query("UPDATE control_plane.jobs SET state = 'waiting_for_user_action', safe_error_code = NULL WHERE id = $1", [failed.jobId]);
    const notFailed = await app.inject({ method: "POST", url, headers: { cookie, "x-csrf-token": csrf } });
    assert.equal(notFailed.statusCode, 409);
    assert.equal(notFailed.json().error, "NOT_FAILED");
  } finally { await app.close(); }
});
