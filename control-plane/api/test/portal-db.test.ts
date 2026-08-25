import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { sha256, type PortalDependencies } from "../src/portal.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
const ids = {
  owner: `user_${suffix}a`, member: `user_${suffix}b`, outsider: `user_${suffix}c`,
  ownedTrip: `trip_${suffix}a`, otherTrip: `trip_${suffix}b`,
};
let pool: pg.Pool;
let passwordInviteeId: string | undefined;

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
    runtimeAccounts: { provisionParticipant: async () => {} },
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, provisioningAdminSubjectDigests: new Set(),
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
  await pool.query("DELETE FROM control_plane.runtime_launch_grants WHERE trip_id = ANY($1)", [[ids.ownedTrip, ids.otherTrip]]);
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
    const redeemed = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem",
      payload: { token: inviteToken, method: "password", password: "password-guest-secret" },
    });
    assert.equal(redeemed.statusCode, 200);
    const inviteRow = await pool.query<{ redeemed_by: string }>(
      "SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1", [createdInvite.json().id]);
    passwordInviteeId = inviteRow.rows[0]?.redeemed_by;
    assert.ok(passwordInviteeId);

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
  } finally { await app.close(); }
});
