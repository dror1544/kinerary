import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
const ids = {
  owner: `user_${suffix}a`, member: `user_${suffix}b`, outsider: `user_${suffix}c`,
  ownedTrip: `trip_${suffix}a`, otherTrip: `trip_${suffix}b`,
};
let pool: pg.Pool;
let passwordInviteeId: string | undefined;
const runtimeEnrollments: Record<string, unknown>[] = [];
let failNextEnrollment = false;

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
    google: { authorizationUrl: () => "https://accounts.example.test", exchange: async () => ({ subject: "unused", displayName: "Unused" }) },
    runtimeAccounts: { participantExists: async ({ runtimeUsername }) => runtimeUsername !== "missing-user", provisionParticipant: async (input) => {
      runtimeEnrollments.push(input);
      if (failNextEnrollment) { failNextEnrollment = false; throw new Error("simulated runtime reply lost"); }
    } },
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

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  await pool.query(`INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Owner'),($2,'active','Member'),($3,'active','Outsider')`, [ids.owner, ids.member, ids.outsider]);
  for (const [index, id] of [ids.owner, ids.member, ids.outsider].entries()) {
    await pool.query(`INSERT INTO control_plane.user_identities(id,user_id,provider,provider_subject_digest,verified_at) VALUES ($1,$2,'google',$3,now())`, [`idnt_${suffix}${index}`, id, sha256(`google:${id}`)]);
  }
  await pool.query(`INSERT INTO control_plane.trips(id,slug,lifecycle_state,title,destination_label) VALUES ($1,$2,'draft','Owned','Rome'),($3,$4,'draft','Other','Paris')`, [ids.ownedTrip, `portal-owned-${suffix}`, ids.otherTrip, `portal-other-${suffix}`]);
  await pool.query(
    `INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access)
     VALUES ($1,$2,$3,'owner','active',true,true),($4,$2,$5,'member','active',false,true),($6,$7,$8,'owner','active',true,true)`,
    [`memb_${suffix}a`, ids.ownedTrip, ids.owner, `memb_${suffix}b`, ids.member, `memb_${suffix}c`, ids.otherTrip, ids.outsider]);
});

after(async () => {
  if (skip) return;
  await pool.query("DELETE FROM control_plane.notification_outbox WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.plan_approvals WHERE plan_id IN (SELECT id FROM control_plane.plans WHERE trip_id = ANY($1))", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.jobs WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.plans WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.runtime_launch_grants WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.runtime_routes WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.web_password_credentials WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.site_invites WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.web_sessions WHERE user_id = ANY($1)", [[ids.owner, ids.member, ids.outsider, passwordInviteeId].filter(Boolean)]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
  await pool.query("DELETE FROM control_plane.user_identities WHERE user_id = ANY($1)", [[ids.owner, ids.member, ids.outsider]]);
  await pool.query("DELETE FROM control_plane.users WHERE id = ANY($1)", [[ids.owner, ids.member, ids.outsider]]);
  if (passwordInviteeId) await pool.query("DELETE FROM control_plane.users WHERE id = $1", [passwordInviteeId]);
  await pool.end();
});

test("portal HTTP authorization separates dashboard, tenant and runtime access", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  const owner = await session(ids.owner, "owner");
  const member = await session(ids.member, "member");
  try {
    const listed = await app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: owner.cookie } });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().trips.map((trip: { id: string }) => trip.id), [ids.ownedTrip]);
    assert.doesNotMatch(listed.body, new RegExp(ids.otherTrip));

    const crossTrip = await app.inject({ method: "GET", url: `/v1/trips/${ids.otherTrip}`, headers: { cookie: owner.cookie } });
    assert.equal(crossTrip.statusCode, 404);
    const crossInvite = await app.inject({ method: "POST", url: `/v1/trips/${ids.otherTrip}/site-invites`, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }, payload: { displayName: "Hidden", runtimeUsername: "hidden-user" } });
    assert.equal(crossInvite.statusCode, 404);

    const noCsrf = await app.inject({ method: "POST", url: `/v1/trips/${ids.ownedTrip}/site-invites`, headers: { cookie: owner.cookie }, payload: { displayName: "Guest", runtimeUsername: "guest-user" } });
    assert.equal(noCsrf.statusCode, 403);
    const unknownRuntimeUser = await app.inject({ method: "POST", url: `/v1/trips/${ids.ownedTrip}/site-invites`, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }, payload: { displayName: "Missing", runtimeUsername: "missing-user" } });
    assert.equal(unknownRuntimeUser.statusCode, 409);

    const memberTrips = await app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: member.cookie } });
    assert.deepEqual(memberTrips.json().trips, []);
    const memberDetail = await app.inject({ method: "GET", url: `/v1/trips/${ids.ownedTrip}`, headers: { cookie: member.cookie } });
    assert.equal(memberDetail.statusCode, 404);
    const memberLaunch = await app.inject({ method: "POST", url: `/v1/trips/${ids.ownedTrip}/launch`, headers: { cookie: member.cookie, "x-csrf-token": member.csrf } });
    assert.equal(memberLaunch.statusCode, 200);

    const badInternal = await app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "wrong" }, payload: { token: memberLaunch.json().launchToken } });
    assert.equal(badInternal.statusCode, 401);
    const consumed = await app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key" }, payload: { token: memberLaunch.json().launchToken } });
    assert.equal(consumed.statusCode, 200);
    assert.equal(consumed.json().tripId, ids.ownedTrip);
    const replay = await app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key" }, payload: { token: memberLaunch.json().launchToken } });
    assert.equal(replay.statusCode, 401);

    const createdInvite = await app.inject({
      method: "POST", url: `/v1/trips/${ids.ownedTrip}/site-invites`,
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf },
      payload: { displayName: "Password Guest", runtimeUsername: "password-guest" },
    });
    assert.equal(createdInvite.statusCode, 201);
    const inviteToken = new URL(createdInvite.json().joinUrl).hash.slice("#token=".length);
    failNextEnrollment = true;
    const failedRedemption = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem",
      payload: { token: inviteToken, method: "password", password: "password-guest-secret" },
    });
    assert.equal(failedRedemption.statusCode, 500);
    const redeemed = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem",
      payload: { token: inviteToken, method: "password", password: "password-guest-secret" },
    });
    assert.equal(redeemed.statusCode, 200);
    const inviteRow = await pool.query<{ redeemed_by: string }>(
      "SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1", [createdInvite.json().id]);
    passwordInviteeId = inviteRow.rows[0]?.redeemed_by;
    assert.ok(passwordInviteeId);
    const attempts = runtimeEnrollments.filter(item => item.inviteId === createdInvite.json().id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].userId, passwordInviteeId);
    assert.deepEqual(attempts[0], attempts[1], "runtime binding retries use the same identity");
    assert.deepEqual(Object.keys(attempts[0]).sort(), ["displayName", "inviteId", "runtimeUsername", "tripId", "userId"]);


    const duplicateInvite = await app.inject({
      method: "POST", url: `/v1/trips/${ids.ownedTrip}/site-invites`,
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf },
      payload: { displayName: "Same Guest", runtimeUsername: "password-guest" },
    });
    assert.equal(duplicateInvite.statusCode, 409);
    assert.deepEqual(duplicateInvite.json(), { error: "INVITE_ALREADY_EXISTS" });

    const googleInvite = await app.inject({
      method: "POST", url: `/v1/trips/${ids.ownedTrip}/site-invites`,
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf },
      payload: { displayName: "Google Guest", runtimeUsername: "google-guest" },
    });
    assert.equal(googleInvite.statusCode, 201);
    const googleToken = new URL(googleInvite.json().joinUrl).hash.slice("#token=".length);
    const googleWithoutCsrf = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem", headers: { cookie: owner.cookie },
      payload: { token: googleToken, method: "google" },
    });
    assert.equal(googleWithoutCsrf.statusCode, 403);
    assert.deepEqual(googleWithoutCsrf.json(), { error: "CSRF_INVALID" });

    const setCookie = redeemed.headers["set-cookie"];
    const cookieLines = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const limitedCookie = cookieLines.map((line) => line.split(";", 1)[0]).join("; ");
    const csrf = decodeURIComponent(cookieLines.find((line) => line.startsWith("kit_csrf="))?.split(";", 1)[0]?.slice("kit_csrf=".length) ?? "");
    assert.match(limitedCookie, /kit_session=/);
    assert.ok(csrf);

    const limitedMe = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: limitedCookie } });
    assert.equal(limitedMe.statusCode, 200);
    const limitedTrips = await app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: limitedCookie } });
    assert.deepEqual(limitedTrips.json().trips, []);
    const limitedLaunch = await app.inject({
      method: "POST", url: `/v1/trips/${ids.ownedTrip}/launch`,
      headers: { cookie: limitedCookie, "x-csrf-token": csrf },
    });
    assert.equal(limitedLaunch.statusCode, 200);

    const passwordLogin = await app.inject({
      method: "POST", url: "/v1/auth/password",
      payload: { tripId: ids.ownedTrip, runtimeUsername: "password-guest", password: "password-guest-secret", returnTo: `/trips/${ids.ownedTrip}/app` },
    });
    assert.equal(passwordLogin.statusCode, 200);
    assert.equal(passwordLogin.json().appPath, `/trips/${ids.ownedTrip}/app`);
    const badPassword = await app.inject({
      method: "POST", url: "/v1/auth/password",
      payload: { tripId: ids.ownedTrip, runtimeUsername: "password-guest", password: "wrong-secret" },
    });
    assert.equal(badPassword.statusCode, 401);
  } finally { await app.close(); }
});

test("a ready lifecycle stays closed until its runtime route is ready", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  const owner = await session(ids.owner, "route");
  try {
    await pool.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'ready_private' WHERE id = $1",
      [ids.ownedTrip],
    );

    const withoutRoute = await app.inject({
      method: "GET", url: `/v1/trips/${ids.ownedTrip}`, headers: { cookie: owner.cookie },
    });
    assert.equal(withoutRoute.statusCode, 200);
    assert.equal(withoutRoute.json().runtimeReady, false);
    assert.equal(withoutRoute.json().nextAction, "view_status");

    await pool.query(
      `INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state)
       VALUES ($1, $2, 'ready')`,
      [ids.ownedTrip, `route_${suffix}ready`],
    );
    const withRoute = await app.inject({
      method: "GET", url: `/v1/trips/${ids.ownedTrip}`, headers: { cookie: owner.cookie },
    });
    assert.equal(withRoute.statusCode, 200);
    assert.equal(withRoute.json().runtimeReady, true);
    assert.equal(withRoute.json().nextAction, "open_trip");
  } finally {
    await pool.query("DELETE FROM control_plane.runtime_routes WHERE trip_id = $1", [ids.ownedTrip]);
    await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'draft' WHERE id = $1", [ids.ownedTrip]);
    await app.close();
  }
});

// ── Provisioning approval: one organizer-driven path ────────────────────────
//
// The ops-review gate these routes replaced is gone (migration 0041). What has
// to hold now is that the trip's OWNER decides, that nobody else can, and that
// the operator notification is enqueued by the approval itself rather than by
// the route — so an approval can never happen silently, and a notification can
// never fail an approval.

async function seedPendingPlan(tripId: string, label: string) {
  const planId = `plan_${suffix}${label}`;
  const digest = `sha256:${label.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "a")}`;
  // plans_trip_active_idx (migration 0011) allows one pending_approval-or-
  // approved plan per trip, so retire whatever a previous test left active.
  await pool.query(
    "UPDATE control_plane.plans SET status = 'superseded' WHERE trip_id = $1 AND status IN ('pending_approval','approved')",
    [tripId]);
  await pool.query(
    `INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status)
     VALUES ($1, $2, NULL, 'provision', $3, 'pending_approval')`,
    [planId, tripId, digest]);
  await pool.query(
    `INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state)
     VALUES ($1, $2, $3, 'provision', $4, $5, 'waiting_for_user_action')`,
    [`job_${suffix}${label}`, tripId, planId, `idem-${planId}`, `corr_${suffix}${label}`]);
  await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'planned' WHERE id = $1", [tripId]);
  return planId;
}

test("the trip owner approves their own plan, and the operator notification rides the same transaction", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const planId = await seedPendingPlan(ids.ownedTrip, "p1");
    const { cookie, csrf } = await session(ids.owner, "appr1");

    const approve = await app.inject({
      method: "POST", url: `/v1/trips/${ids.ownedTrip}/plans/${planId}/approve`,
      headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(approve.statusCode, 200);
    assert.ok(approve.json().approvalId);

    // The approval did what the worker gates on.
    const plan = await pool.query("SELECT status FROM control_plane.plans WHERE id = $1", [planId]);
    assert.equal(plan.rows[0].status, "approved");
    const job = await pool.query("SELECT state FROM control_plane.jobs WHERE plan_id = $1", [planId]);
    assert.equal(job.rows[0].state, "queued");
    const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [ids.ownedTrip]);
    assert.equal(trip.rows[0].lifecycle_state, "provisioning_approved");

    // ...and the operator row is there, addressed to the operator, pending for
    // the dispatcher. Nothing in the path above waited on it.
    const outbox = await pool.query(
      `SELECT recipient, state, payload FROM control_plane.notification_outbox
       WHERE trip_id = $1 AND notification_type = 'operator_provisioning_approved'`,
      [ids.ownedTrip]);
    assert.equal(outbox.rowCount, 1);
    assert.equal(outbox.rows[0].recipient, "operator-chat-1");
    assert.equal(outbox.rows[0].state, "pending");
    assert.equal(outbox.rows[0].payload.plan_id, planId);
    assert.equal(outbox.rows[0].payload.approved_by, `user:${ids.owner}`);
    assert.equal(outbox.rows[0].payload.organizer, "Owner");
  } finally { await app.close(); }
});

test("a non-owner cannot approve or reject, and the retired ops queue is gone", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const planId = await seedPendingPlan(ids.ownedTrip, "p2");
    for (const [userId, label] of [[ids.member, "mem"], [ids.outsider, "out"]] as const) {
      const { cookie, csrf } = await session(userId, `deny${label}`);
      for (const action of ["approve", "reject"]) {
        const response = await app.inject({
          method: "POST", url: `/v1/trips/${ids.ownedTrip}/plans/${planId}/${action}`,
          headers: { cookie, "x-csrf-token": csrf },
        });
        assert.equal(response.statusCode, 404, `${label} ${action}`);
      }
    }
    // The plan is untouched by the refusals.
    const plan = await pool.query("SELECT status FROM control_plane.plans WHERE id = $1", [planId]);
    assert.equal(plan.rows[0].status, "pending_approval");

    // The operations-review surface no longer exists at all.
    const { cookie } = await session(ids.owner, "opsgone");
    const queue = await app.inject({ method: "GET", url: "/v1/ops/provisioning-requests", headers: { cookie } });
    assert.equal(queue.statusCode, 404);
  } finally { await app.close(); }
});

test("the owner rejects a plan: superseded, job cancelled, trip back to intake_confirmed", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const planId = await seedPendingPlan(ids.otherTrip, "p3");
    // otherTrip's owner is `outsider` — ownership is per trip, not global.
    const { cookie, csrf } = await session(ids.outsider, "rej1");

    const reject = await app.inject({
      method: "POST", url: `/v1/trips/${ids.otherTrip}/plans/${planId}/reject`,
      headers: { cookie, "x-csrf-token": csrf }, payload: { reasonCode: "ORGANIZER_CHANGED_MIND" },
    });
    assert.equal(reject.statusCode, 200);
    assert.equal(reject.json().reasonCode, "ORGANIZER_CHANGED_MIND");

    const plan = await pool.query("SELECT status FROM control_plane.plans WHERE id = $1", [planId]);
    assert.equal(plan.rows[0].status, "superseded");
    const job = await pool.query("SELECT state FROM control_plane.jobs WHERE plan_id = $1", [planId]);
    assert.equal(job.rows[0].state, "cancelled");
    const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [ids.otherTrip]);
    assert.equal(trip.rows[0].lifecycle_state, "intake_confirmed");

    // A rejected plan cannot then be approved.
    const approve = await app.inject({
      method: "POST", url: `/v1/trips/${ids.otherTrip}/plans/${planId}/approve`,
      headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(approve.statusCode, 422);
    // Rejection is not an operator-notification event — only approval is.
    const outbox = await pool.query(
      `SELECT count(*)::int AS count FROM control_plane.notification_outbox
       WHERE trip_id = $1 AND notification_type LIKE 'operator_%'`, [ids.otherTrip]);
    assert.equal(outbox.rows[0].count, 0);
  } finally { await app.close(); }
});

test("with no operator chat id configured, approval still succeeds and simply enqueues nothing", { skip }, async () => {
  const app = buildApp(profile, { portal: { ...portalDeps(pool), operatorChatId: undefined } });
  try {
    const planId = await seedPendingPlan(ids.ownedTrip, "p4");
    const { cookie, csrf } = await session(ids.owner, "noop1");
    const before = await pool.query(
      `SELECT count(*)::int AS count FROM control_plane.notification_outbox
       WHERE notification_type = 'operator_provisioning_approved'`);
    const approve = await app.inject({
      method: "POST", url: `/v1/trips/${ids.ownedTrip}/plans/${planId}/approve`,
      headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(approve.statusCode, 200);
    const job = await pool.query("SELECT state FROM control_plane.jobs WHERE plan_id = $1", [planId]);
    assert.equal(job.rows[0].state, "queued");
    const after = await pool.query(
      `SELECT count(*)::int AS count FROM control_plane.notification_outbox
       WHERE notification_type = 'operator_provisioning_approved'`);
    assert.equal(after.rows[0].count, before.rows[0].count, "no operator row was added");
  } finally { await app.close(); }
});
