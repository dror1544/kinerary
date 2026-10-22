/**
 * A session a Telegram link minted sees ONLY the trips that Telegram account is
 * linked to (#442, owner decision 2026-10-21). Everything else of the account
 * needs a password or Google sign-in.
 *
 * The sweep below is the point: it walks PORTAL_SCOPE_POLICY - the table every
 * portal route must have a row in - and fires each route at a trip the session
 * is NOT linked to, so a route added later cannot forget the check (and a route
 * with no row does not even boot).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { digestTelegramId } from "../src/identity.js";
import { applyMigrations } from "../src/migrations.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import {
  PORTAL_SCOPE_POLICY, assertEveryRouteIsClassified, scopedSessionDigest, sessionDigests,
} from "../src/portal-scope.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const hex = () => randomBytes(8).toString("hex");
let nextTg = 8_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
const tg = () => ++nextTg;
const id = (prefix: string) => `${prefix}_${suffix}${hex()}`;

let pool: pg.Pool;
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});
const newApp = () => buildApp(profile, {
  portal: {
    db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
    telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true },
  } as PortalDependencies,
});
type App = ReturnType<typeof newApp>;

async function mkUser(name: string) {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active',$2)", [userId, name]);
  return userId;
}
async function mkTrip(title: string) {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,'ready_private',$3)", [tripId, `sc-${tripId.replace(/_/g, "-").toLowerCase()}`, title]);
  return tripId;
}
async function mkMember(tripId: string, userId: string, role = "owner") {
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,$4,'active',$5,true)",
    [id("memb"), tripId, userId, role, role !== "member"]);
}
async function organizerLink(userId: string, tripId: string, telegramId: number) {
  const linkId = `otl_${randomBytes(16).toString("hex")}`;
  await pool.query(
    "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
    [linkId, userId, tripId, digestTelegramId(String(telegramId))]);
  return linkId;
}
async function fullSession(userId: string, label: string) {
  const raw = `sess-${label}-${suffix}${hex()}`, csrf = `csrf-${label}-${suffix}${hex()}`;
  await pool.query(
    "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
    [id("wsess"), userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf, raw };
}
/** A session minted the way a real Mini App launch mints one. */
async function telegramSession(app: App, telegramId: number, tripId: string) {
  const initData = signedInitData(launchFields(telegramId, Date.now(), { query_id: `AA${hex()}`, start_param: tripId }));
  const response = await app.inject({
    method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json", origin: ORIGIN },
    payload: JSON.stringify({ initData }),
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookies = ([] as string[]).concat(response.headers["set-cookie"] as string[]);
  const pick = (name: string) => decodeURIComponent(cookies.find((c) => c.startsWith(`${name}=`))!.split(";")[0]!.slice(name.length + 1));
  const csrf = pick("kit_csrf");
  return { cookie: `kit_session=${pick("kit_session")}; kit_csrf=${csrf}`, csrf, raw: pick("kit_session") };
}
type Sess = { cookie: string; csrf: string };
const call = (app: App, session: Sess, method: string, url: string, payload?: unknown) => app.inject({
  method: method as "GET", url, headers: { cookie: session.cookie, "x-csrf-token": session.csrf, origin: ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

/** Olive runs two trips; her Telegram account is linked to Rome only. */
async function fixture(app: App) {
  const user = await mkUser("Olive");
  const rome = await mkTrip("Rome"), oslo = await mkTrip("Oslo");
  await mkMember(rome, user); await mkMember(oslo, user);
  const telegramId = tg();
  const romeLink = await organizerLink(user, rome, telegramId);
  const osloLink = await organizerLink(user, oslo, tg());      // a DIFFERENT Telegram account's link to Oslo
  const scoped = await telegramSession(app, telegramId, rome);
  const full = await fullSession(user, "full");
  return { user, rome, oslo, telegramId, romeLink, osloLink, scoped, full };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 8 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

// ── The policy table cannot lag the routes ──────────────────────────────────

test("every route the portal registers has a scope policy, and every policy names a real route", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/portal.ts", import.meta.url)), "utf8");
  const routes = [...source.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
  assert.ok(routes.length >= 25, `the scan found the routes (${routes.length})`);
  assert.deepEqual(routes.filter((route) => !(route in PORTAL_SCOPE_POLICY)), [], "a portal route with no scope policy");
  assert.deepEqual(Object.keys(PORTAL_SCOPE_POLICY).filter((key) => !routes.includes(key)), [], "a policy row for a route that is gone");
  assert.throws(() => assertEveryRouteIsClassified(["GET /v1/a-route-nobody-classified"]), /a-route-nobody-classified/);
  assertEveryRouteIsClassified(Object.keys(PORTAL_SCOPE_POLICY));
});

// ── The sweep ───────────────────────────────────────────────────────────────

test("SWEEP: every route, aimed at a trip the Telegram session is not linked to, is the same 404; account routes are 403; filtered routes are filtered", { skip }, async () => {
  const app = newApp();
  try {
    const { oslo, rome, osloLink, scoped } = await fixture(app);
    const ghost = "trip_doesnotexist000";
    const fill = (route: string, tripId: string) => route.replace(":id", tripId).replace(":planId", "plan_abcdefgh").replace(":inviteId", "inv_abcdefgh")
      .replace(":membershipId", "memb_abcdefgh").replace(":linkId", osloLink).replace(":tripId", tripId);
    const swept: string[] = [];
    const tripCount = async () => (await pool.query("SELECT count(*)::int AS n FROM control_plane.trips")).rows[0].n;
    const before = await tripCount();
    for (const [key, scope] of Object.entries(PORTAL_SCOPE_POLICY)) {
      const [method, pattern] = key.split(" ") as [string, string];
      if (scope === "trip") {
        const out = await call(app, scoped, method, fill(pattern, oslo), {});
        const nowhere = await call(app, scoped, method, fill(pattern, ghost), {});
        assert.equal(out.statusCode, 404, `${key} -> out-of-scope trip`);
        assert.equal(out.body, '{"error":"NOT_FOUND"}', key);
        assert.equal(out.body, nowhere.body, `${key}: out-of-scope is byte-identical to nonexistent`);
        swept.push(key);
      } else if (scope === "link") {
        const out = await call(app, scoped, method, fill(pattern, oslo));
        const nowhere = await call(app, scoped, method, pattern.replace(":linkId", "otl_doesnotexist000"));
        assert.equal(out.statusCode, 404, key);
        assert.equal(out.body, nowhere.body, `${key}: another trip's link looks like no link`);
        swept.push(key);
      } else if (scope === "account") {
        const response = await call(app, scoped, method, fill(pattern, rome), key === "POST /v1/trips" ? { destination: "Lisbon", tripType: "family" } : { token: "x", method: "google" });
        assert.equal(response.statusCode, 403, key);
        assert.deepEqual(response.json(), { error: "ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in with your password to do this." }, key);
        swept.push(key);
      }
    }
    const expectedSweep = Object.values(PORTAL_SCOPE_POLICY).filter((kind) => ["trip", "link", "account"].includes(kind)).length;
    assert.equal(swept.length, expectedSweep, `swept ${swept.length} of ${expectedSweep} routes: ${swept.join(", ")}`);
    assert.ok(swept.length >= 15);
    assert.ok(["POST /v1/trips/:id/telegram-link", "POST /v1/trips/:id/interview-link", "POST /v1/trips/:id/interview-link/replace"].every((k) => swept.includes(k)), "the link-minting routes are account-level");
    // Nothing the sweep did touched Oslo.
    assert.equal((await pool.query("SELECT 1 FROM control_plane.site_invites WHERE trip_id = $1", [oslo])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_link_tokens WHERE trip_id = $1", [oslo])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_organizer_trip_links WHERE id = $1 AND revoked_at IS NULL", [osloLink])).rowCount, 1, "another trip's link was not unlinked");
    assert.equal(await tripCount(), before, "no trip was created");
  } finally { await app.close(); }
});

// ── What the scoped session CAN do ──────────────────────────────────────────

test("a scoped session lists and opens only its linked trips; the full session of the same user still sees both", { skip }, async () => {
  const app = newApp();
  try {
    const { rome, oslo, scoped, full, user } = await fixture(app);
    const listed = (await call(app, scoped, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id);
    assert.deepEqual(listed, [rome]);
    const everything = (await call(app, full, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id).sort();
    assert.deepEqual(everything, [rome, oslo].sort(), "the password session is unchanged");
    assert.equal((await call(app, scoped, "GET", `/v1/trips/${rome}`)).statusCode, 200);
    assert.equal((await call(app, full, "GET", `/v1/trips/${oslo}`)).statusCode, 200);

    const me = await call(app, scoped, "GET", "/v1/me");
    assert.deepEqual(me.json(), { id: user, displayName: "Olive", scope: "telegram" });
    assert.equal((await call(app, full, "GET", "/v1/me")).json().scope, "full");

    // Acting on the linked trip works as an organizer's session does - except minting a way INTO the
    // account (a Telegram link, an interview link), which needs a password (boundary review M1).
    assert.equal((await call(app, scoped, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 403);
    assert.equal((await call(app, full, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 201);
    assert.equal((await call(app, scoped, "POST", `/v1/trips/${rome}/site-invites`, { displayName: "Guest", runtimeUsername: "guest-one" })).statusCode, 201);
    assert.equal((await call(app, scoped, "GET", `/v1/trips/${rome}/interview-link`)).statusCode, 200);
    assert.equal((await call(app, scoped, "POST", `/v1/trips/${rome}/launch`)).statusCode, 200, "/launch respects the scope for its own trip");
    const outLaunch = await call(app, scoped, "POST", `/v1/trips/${oslo}/launch`);
    assert.equal(outLaunch.statusCode, 404);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.runtime_launch_grants WHERE trip_id = $1", [oslo])).rowCount, 0, "no launch grant exists for the unlinked trip");
    // A full session creating a trip still works (the account-level route is only closed to the scoped one).
    assert.equal((await call(app, full, "POST", "/v1/trips", { destination: "Lisbon", tripType: "family" })).statusCode, 201);
  } finally { await app.close(); }
});

test("a scoped session may end only ITS OWN Telegram account's link; another account's link on the same trip - the owner's phone - is the same 404 as an unknown id", { skip }, async () => {
  const app = newApp();
  try {
    const { scoped, romeLink, osloLink, user, rome } = await fixture(app);
    const ownersPhone = await organizerLink(user, rome, tg());     // a DIFFERENT Telegram account, same in-scope trip
    const unknown = await call(app, scoped, "DELETE", "/v1/account/telegram-links/otl_doesnotexist0000");
    const foreign = await call(app, scoped, "DELETE", `/v1/account/telegram-links/${ownersPhone}`);
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.body, unknown.body, "a foreign id and an unknown one look the same");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_organizer_trip_links WHERE id = $1 AND revoked_at IS NULL", [ownersPhone])).rowCount, 1, "the owner's link is still live");
    assert.equal((await call(app, scoped, "DELETE", `/v1/account/telegram-links/${osloLink}`)).statusCode, 404);
    // The scope decision runs AFTER the CSRF check: without the header both are the same 403, whatever id they name.
    const noCsrf = (id: string) => app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${id}`, headers: { cookie: scoped.cookie, origin: ORIGIN } });
    const a = await noCsrf(ownersPhone), b = await noCsrf("otl_doesnotexist0000");
    assert.equal(a.statusCode, 403); assert.equal(a.body, b.body);
    // Its own: allowed, and it ends the session.
    assert.equal((await call(app, scoped, "DELETE", `/v1/account/telegram-links/${romeLink}`)).statusCode, 200);
    assert.equal((await call(app, scoped, "GET", "/v1/me")).statusCode, 401, "the link's own session ended with it");
  } finally { await app.close(); }
});

test("M1 CHAIN: a scoped session cannot mint a Telegram link or an interview link, so it cannot plant a second account that outlives the first one's Unlink", { skip }, async () => {
  const app = newApp();
  try {
    const { scoped, rome, user } = await fixture(app);
    const tokens = async () => (await pool.query("SELECT 1 FROM control_plane.telegram_link_tokens WHERE trip_id = $1", [rome])).rowCount;
    const enrollments = async () => (await pool.query("SELECT 1 FROM control_plane.interview_enrollments WHERE trip_id = $1", [rome])).rowCount;
    for (const [method, url] of [["POST", `/v1/trips/${rome}/telegram-link`], ["POST", `/v1/trips/${rome}/interview-link`], ["POST", `/v1/trips/${rome}/interview-link/replace`]] as const) {
      const response = await call(app, scoped, method, url, url.endsWith("replace") ? { expectedEnrollmentId: "enrl_abcdefgh" } : undefined);
      assert.equal(response.statusCode, 403, url);
      assert.deepEqual(response.json(), { error: "ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in with your password to do this." }, url);
    }
    assert.equal(await tokens(), 0, "no link token was created");
    assert.equal(await enrollments(), 0, "no interview enrollment was created");
    // The same user with a password session may, as before.
    const full = await fullSession(user, "m1");
    assert.equal((await call(app, full, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 201);
    assert.equal(await tokens(), 1);
  } finally { await app.close(); }
});

// ── Origin: a second wall behind the CSRF token (review S3) ──────────────────

test("a state-changing request with a present Origin that is not ours is refused; a missing Origin keeps CSRF-token-only behaviour", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, full } = await fixture(app);
    const post = (origin: string | null, session: { cookie: string; csrf: string }) => app.inject({
      method: "POST", url: `/v1/trips/${rome}/telegram-link`,
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf, ...(origin !== null ? { origin } : {}) },
    });
    assert.equal((await post(ORIGIN, full)).statusCode, 201, "our own origin");
    assert.equal((await post(null, full)).statusCode, 201, "no Origin header: unchanged");
    for (const origin of ["https://evil.example", "null", "http://portal.example.test.evil.example", "https://web.telegram.org"]) {
      const response = await post(origin, full);
      assert.equal(response.statusCode, 403, origin);
      assert.deepEqual(response.json(), { error: "ORIGIN_INVALID" }, origin);
    }
    // Logout and unlink go through the same wall.
    const out = await app.inject({ method: "POST", url: "/v1/logout", headers: { cookie: full.cookie, "x-csrf-token": full.csrf, origin: "https://evil.example" } });
    assert.equal(out.statusCode, 403);
    assert.equal((await call(app, full, "GET", "/v1/me")).statusCode, 200, "the refused logout did not end the session");
    // GETs carry no state change and are not Origin-checked.
    assert.equal((await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: full.cookie, origin: "https://evil.example" } })).statusCode, 200);

    // Redeeming an invite while riding a cookie session is a state change on that account too.
    const invite = await call(app, full, "POST", `/v1/trips/${rome}/site-invites`, { displayName: "Guest", runtimeUsername: "guest-origin" });
    assert.equal(invite.statusCode, 201);
    const token = new URL(invite.json().joinUrl).hash.slice("#token=".length);
    const redeem = (origin: string | null) => app.inject({
      method: "POST", url: "/v1/site-invites/redeem",
      headers: { cookie: full.cookie, "x-csrf-token": full.csrf, "content-type": "application/json", ...(origin !== null ? { origin } : {}) },
      payload: JSON.stringify({ token, method: "google" }),
    });
    // Our own origin and no Origin at all are not refused by the wall (this session has no Google identity, so 401 is what follows).
    assert.equal((await redeem(ORIGIN)).statusCode, 401);
    assert.equal((await redeem(null)).statusCode, 401);
    assert.equal((await redeem("https://evil.example")).statusCode, 403);
    assert.deepEqual((await redeem("https://evil.example")).json(), { error: "ORIGIN_INVALID" });
    const byPassword = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem",
      headers: { cookie: full.cookie, "content-type": "application/json", origin: "https://evil.example" },
      payload: JSON.stringify({ token, method: "password", password: "a-long-enough-password" }),
    });
    assert.equal(byPassword.statusCode, 403, "the password path riding a cookie session is Origin-checked too");
    assert.deepEqual(byPassword.json(), { error: "ORIGIN_INVALID" });
    assert.equal((await pool.query("SELECT state FROM control_plane.site_invites WHERE runtime_username = 'guest-origin' AND trip_id = $1", [rome])).rows[0].state, "unused", "the invite was not consumed");
    void user;
  } finally { await app.close(); }
});

test("the scope follows the links live: a new link for the same Telegram account widens it on the next request, an Unlink narrows it", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, oslo, telegramId, scoped } = await fixture(app);
    assert.deepEqual((await call(app, scoped, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id), [rome]);
    const osloForThisTelegram = await organizerLink(user, oslo, telegramId);
    assert.deepEqual((await call(app, scoped, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id).sort(), [rome, oslo].sort());
    assert.equal((await call(app, scoped, "GET", `/v1/trips/${oslo}`)).statusCode, 200);
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET revoked_at = now(), revoked_reason = 'owner_unlinked' WHERE id = $1", [osloForThisTelegram]);
    assert.equal((await call(app, scoped, "GET", `/v1/trips/${oslo}`)).statusCode, 404);
    // A link of the same Telegram account to ANOTHER user's trips is not this session's.
    const other = await mkUser("Somebody else"); const theirs = await mkTrip("Theirs");
    await mkMember(theirs, other); await organizerLink(other, theirs, telegramId);
    assert.equal((await call(app, scoped, "GET", `/v1/trips/${theirs}`)).statusCode, 404);
  } finally { await app.close(); }
});

test("a member-link session sees only that trip, even if the member is on more", { skip }, async () => {
  const app = newApp();
  try {
    const owner = await mkUser("Owner"); const member = await mkUser("Mia");
    const a = await mkTrip("A"), b = await mkTrip("B");
    await mkMember(a, owner); await mkMember(b, owner); await mkMember(a, member, "member"); await mkMember(b, member, "member");
    const telegramId = tg();
    await pool.query(
      "INSERT INTO control_plane.telegram_member_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'mini_app_trip_password')",
      [`tml_${randomBytes(16).toString("hex")}`, member, a, digestTelegramId(String(telegramId))]);
    const session = await telegramSession(app, telegramId, a);
    assert.deepEqual((await call(app, session, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id), [a]);
    assert.equal((await call(app, session, "POST", `/v1/trips/${b}/launch`)).statusCode, 404);
  } finally { await app.close(); }
});

// ── Fail closed ─────────────────────────────────────────────────────────────

test("an unknown, unparseable or revoked scope is NO access - never a full session", { skip }, async () => {
  const app = newApp();
  try {
    const { scoped, rome, user, raw } = await (async () => { const f = await fixture(app); return { ...f, raw: f.scoped.raw }; })();
    const digest = scopedSessionDigest(raw);
    for (const [label, linkId] of [["garbage", "bogus"], ["an older account-wide id", "tol_0123456789abcdef"], ["a link that does not exist", "otl_ffffffffffffffff"], ["no link at all", null]] as const) {
      await pool.query("UPDATE control_plane.web_sessions SET telegram_link_id = $2 WHERE token_digest = $1", [digest, linkId]);
      assert.deepEqual((await call(app, scoped, "GET", "/v1/trips")).json().trips, [], label);
      assert.equal((await call(app, scoped, "GET", `/v1/trips/${rome}`)).statusCode, 404, label);
      assert.equal((await call(app, scoped, "POST", "/v1/trips", { destination: "Lisbon", tripType: "family" })).statusCode, 403, label);
      assert.equal((await call(app, scoped, "GET", "/v1/me")).json().scope, "telegram", `${label}: still reported as scoped`);
    }
    void user;
  } finally { await app.close(); }
});

test("ROLLBACK FAILS CLOSED: a scoped session is not stored under the plain digest an older release looks up", { skip }, async () => {
  const app = newApp();
  try {
    const { scoped, full } = await fixture(app);
    const [plain, scopedDigest] = sessionDigests(scoped.raw);
    // What every older release does: look the cookie up by sha256(cookie).
    assert.equal((await pool.query("SELECT 1 FROM control_plane.web_sessions WHERE token_digest = $1 AND revoked_at IS NULL", [plain])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.web_sessions WHERE token_digest = $1", [scopedDigest])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.web_sessions WHERE token_digest = $1", [sessionDigests(full.raw)[0]])).rowCount, 1, "a password session stays under the plain digest");
    // Presenting the SCOPED digest's preimage prefix as a cookie does not turn it into a plain lookup.
    const probe = { cookie: `kit_session=telegram-scope:${scoped.raw}; kit_csrf=x`, csrf: "x" };
    assert.equal((await call(app, probe, "GET", "/v1/me")).statusCode, 401);
  } finally { await app.close(); }
});

test("a session the earlier build minted (plain digest, link id set) is scoped too", { skip }, async () => {
  const app = newApp();
  try {
    const { user, romeLink, rome, oslo } = await fixture(app);
    const raw = `old-${suffix}${hex()}`, csrf = `csrf-old-${hex()}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at,telegram_link_id) VALUES ($1,$2,$3,$4,now() + interval '1 hour',$5)",
      [id("wsess"), user, sha256(raw), sha256(csrf), romeLink]);
    const old = { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
    assert.deepEqual((await call(app, old, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id), [rome]);
    assert.equal((await call(app, old, "GET", `/v1/trips/${oslo}`)).statusCode, 404);
  } finally { await app.close(); }
});

test("logout works for a scoped session and ends it", { skip }, async () => {
  const app = newApp();
  try {
    const { scoped } = await fixture(app);
    assert.equal((await call(app, scoped, "POST", "/v1/logout")).statusCode, 200);
    assert.equal((await call(app, scoped, "GET", "/v1/me")).statusCode, 401);
  } finally { await app.close(); }
});
