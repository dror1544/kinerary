import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { digestTelegramId } from "../src/identity.js";
import { applyMigrations } from "../src/migrations.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { MINI_APP_SESSIONS_PER_LAUNCH } from "../src/telegram-mini-app.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const hex = () => randomBytes(8).toString("hex");
// Telegram ids unique to this run, in the range real ids use.
let nextTg = 5_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
const tg = () => ++nextTg;

let pool: pg.Pool;
const logs: string[] = [];
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function portalDeps(db: pg.Pool, overrides: Partial<PortalDependencies> = {}): PortalDependencies {
  return {
    db,
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
    telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true, log: (line) => logs.push(line) },
    ...overrides,
  };
}
const newApp = (db: pg.Pool = pool, overrides: Partial<PortalDependencies> = {}) => buildApp(profile, { portal: portalDeps(db, overrides) });
type App = ReturnType<typeof newApp>;

// ── Fixtures ────────────────────────────────────────────────────────────────

const id = (prefix: string) => `${prefix}_${suffix}${hex()}`;
async function mkUser(name: string): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active',$2)", [userId, name]);
  return userId;
}
async function mkTrip(title: string, slug?: string): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,'draft',$3)", [tripId, slug ?? `mini-${tripId.replace(/_/g, "-").toLowerCase()}`, title]);
  return tripId;
}
async function mkMember(tripId: string, userId: string, role = "owner", opts: { dashboard?: boolean; runtime?: boolean; status?: string } = {}) {
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id("memb"), tripId, userId, role, opts.status ?? "active", opts.dashboard ?? role !== "member", opts.runtime ?? true]);
}
async function linkOrganizer(userId: string, telegramId: number, via = "enrollment_redemption"): Promise<string> {
  const linkId = `tol_${randomBytes(16).toString("hex")}`;
  await pool.query(
    "INSERT INTO control_plane.telegram_organizer_links(id,user_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4)",
    [linkId, userId, digestTelegramId(String(telegramId)), via]);
  return linkId;
}
async function webSession(userId: string, label: string) {
  const raw = `sess-${label}-${suffix}${hex()}`, csrf = `csrf-${label}-${suffix}${hex()}`;
  await pool.query(
    "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
    [id("wsess"), userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf, raw };
}

function initDataFor(telegramId: number, extra: Record<string, string> = {}, nowMs = Date.now()): string {
  return signedInitData(launchFields(telegramId, nowMs, { query_id: `AA${hex()}`, ...extra }));
}
async function exchange(app: App, initData: unknown, opts: { tripId?: string; cookie?: string; origin?: string | null; contentType?: string } = {}) {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.inject({
    method: "POST", url: "/v1/auth/telegram-mini-app", headers,
    payload: JSON.stringify({ initData, ...(opts.tripId ? { tripId: opts.tripId } : {}) }),
  });
}
function cookieOf(response: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.split(";")[0]!.slice(name.length + 1)) : null;
}
const asCookie = (response: { headers: Record<string, unknown> }) => `kit_session=${cookieOf(response, "kit_session")}; kit_csrf=${cookieOf(response, "kit_csrf")}`;
async function me(app: App, cookie: string) {
  return app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 8 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

// ── Resolution ──────────────────────────────────────────────────────────────

test("an unlinked person gets TELEGRAM_NOT_LINKED, identically whether or not the trip exists", { skip }, async () => {
  const app = newApp();
  try {
    const stranger = tg();
    const real = await mkTrip("Real");
    const none = await exchange(app, initDataFor(stranger));
    assert.equal(none.statusCode, 401);
    assert.deepEqual(none.json(), { error: "TELEGRAM_NOT_LINKED", fallback: "none" });
    assert.equal(none.headers["cache-control"], "private, no-store");
    assert.equal(cookieOf(none, "kit_session"), null);

    const missingTrip = "trip_doesnotexist000";
    const a = await exchange(app, initDataFor(stranger, { start_param: real }));
    const b = await exchange(app, initDataFor(stranger, { start_param: missingTrip }));
    assert.equal(a.statusCode, 401); assert.equal(b.statusCode, 401);
    assert.deepEqual(a.json(), { error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId: real });
    // Same shape; only the echoed selector (which the client already holds) differs.
    assert.deepEqual({ ...b.json(), tripId: real }, a.json());
  } finally { await app.close(); }
});

test("a linked organizer lands on the chat's trip with a session identical to a web sign-in", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive Organizer");
    const trip = await mkTrip("Rome");
    const other = await mkTrip("Elsewhere");
    await mkMember(trip, user); await mkMember(other, user);
    const telegramId = tg();
    const linkId = await linkOrganizer(user, telegramId);

    const response = await exchange(app, initDataFor(telegramId, { start_param: trip }));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { kind: "session", appPath: `/mini-app/trips/${trip}` });
    assert.equal(response.headers["cache-control"], "private, no-store");
    const setCookie = ([] as string[]).concat(response.headers["set-cookie"] as string[]);
    const sessionCookie = setCookie.find((c) => c.startsWith("kit_session="))!;
    assert.match(sessionCookie, /HttpOnly/); assert.match(sessionCookie, /SameSite=Lax/); assert.match(sessionCookie, /Max-Age=3600/);
    assert.match(setCookie.find((c) => c.startsWith("kit_csrf="))!, /Max-Age=3600/);
    assert.doesNotMatch(setCookie.find((c) => c.startsWith("kit_csrf="))!, /HttpOnly/);

    const row = await pool.query("SELECT user_id, telegram_link_id, expires_at - created_at AS ttl FROM control_plane.web_sessions WHERE token_digest = $1", [sha256(cookieOf(response, "kit_session")!)]);
    assert.equal(row.rows[0].user_id, user);
    assert.equal(row.rows[0].telegram_link_id, linkId);

    const who = await me(app, asCookie(response));
    assert.equal(who.statusCode, 200);
    assert.equal(who.json().id, user);
    // The same cookies authorise the same routes a web sign-in does.
    const trips = await app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: asCookie(response) } });
    assert.deepEqual(trips.json().trips.map((t: { id: string }) => t.id).sort(), [trip, other].sort());
  } finally { await app.close(); }
});

test("a non-member's startapp, a nonexistent trip, a retired trip and a destroyed trip are all refused identically", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Opal");
    const mine = await mkTrip("Mine");
    await mkMember(mine, user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);

    const stranger = await mkUser("Someone Else");
    const foreign = await mkTrip("Foreign");
    await mkMember(foreign, stranger);
    const retired = await mkTrip("Retired", `retired-old-trip-${suffix}${hex()}`);
    await mkMember(retired, user);
    const destroyed = await mkTrip("Destroyed");
    await mkMember(destroyed, user);
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id,chat_id,trip_id,closed_at,closed_reason) VALUES ($1,$2,$3,now(),'trip_destroyed')",
      [id("tcb"), `-100${hex().slice(0, 9).replace(/[a-f]/g, "1")}`, destroyed]);
    const revoked = await mkTrip("Revoked");
    await mkMember(revoked, user, "member", { status: "revoked" });

    const bodies = new Map<string, string>();
    for (const [label, startParam] of Object.entries({
      foreign, nonexistent: "trip_nosuchtrip0000", retired, destroyed, revoked,
    })) {
      const response = await exchange(app, initDataFor(telegramId, { start_param: startParam }));
      assert.equal(response.statusCode, 200, label);
      bodies.set(label, response.body);
      assert.equal(response.json().notice, "TRIP_UNAVAILABLE", label);
      // Falls back to the one trip they can actually open, exactly as with no context.
      assert.equal(response.json().appPath, `/mini-app/trips/${mine}`, label);
      assert.doesNotMatch(response.body, new RegExp(`${foreign}|${retired}|${destroyed}|${revoked}`), label);
    }
    assert.equal(new Set(bodies.values()).size, 1, `refusals are byte-identical: ${[...bodies.keys()].join(", ")}`);
    // The retired and destroyed trips are also gone from the account's own scope.
    const direct = await exchange(app, initDataFor(telegramId, { start_param: mine }));
    assert.equal(direct.json().appPath, `/mini-app/trips/${mine}`);
    assert.equal(direct.json().notice, undefined);
  } finally { await app.close(); }
});

test("with several linked accounts the pick is deterministic: owner over organizer over member, runtime first, oldest first", { skip }, async () => {
  const app = newApp();
  try {
    const telegramId = tg();
    const trip = await mkTrip("Shared");
    const asMember = await mkUser("As Member");
    const asOrganizer = await mkUser("As Organizer");
    const asOwner = await mkUser("As Owner");
    await mkMember(trip, asMember, "member", { runtime: true, dashboard: false });
    await mkMember(trip, asOrganizer, "organizer");
    await mkMember(trip, asOwner, "owner");
    for (const user of [asMember, asOrganizer, asOwner]) await linkOrganizer(user, telegramId);
    const first = await exchange(app, initDataFor(telegramId, { start_param: trip }));
    assert.equal(first.statusCode, 200);
    assert.equal((await me(app, asCookie(first))).json().id, asOwner);
    const second = await exchange(app, initDataFor(telegramId, { start_param: trip }));
    assert.equal((await me(app, asCookie(second))).json().id, asOwner, "same input, same account");

    // Without the owner, organizer beats member.
    await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [trip, asOwner]);
    const third = await exchange(app, initDataFor(telegramId, { start_param: trip }));
    assert.equal((await me(app, asCookie(third))).json().id, asOrganizer);
  } finally { await app.close(); }
});

test("a role outside the allow-list is excluded, never ranked", { skip }, async () => {
  const app = newApp();
  const client = await pool.connect();
  try {
    // The CHECK on trip_memberships.role is today's allow-list in the schema;
    // lifting it is how a future role would arrive. The resolver must not
    // turn that role into a session by letting it fall through a comparison.
    await client.query("ALTER TABLE control_plane.trip_memberships DROP CONSTRAINT trip_memberships_role_check");
    const user = await mkUser("Viewer");
    const trip = await mkTrip("Viewable");
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,'viewer','active',true,true)",
      [id("memb"), trip, user]);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    const response = await exchange(app, initDataFor(telegramId, { start_param: trip }));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "TELEGRAM_NOT_LINKED");
    assert.equal(cookieOf(response, "kit_session"), null);
    await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [trip]);
  } finally {
    await client.query("ALTER TABLE control_plane.trip_memberships ADD CONSTRAINT trip_memberships_role_check CHECK (role IN ('owner', 'organizer', 'member'))");
    client.release();
    await app.close();
  }
});

test("no trip in context: one trip opens directly, one account opens My trips, several accounts choose", { skip }, async () => {
  const app = newApp();
  try {
    // One trip across two accounts opens directly.
    const solo = tg();
    const u1 = await mkUser("U1"), u2 = await mkUser("U2");
    const onlyTrip = await mkTrip("Only");
    await mkMember(onlyTrip, u1);
    await linkOrganizer(u1, solo); await linkOrganizer(u2, solo);
    const direct = await exchange(app, initDataFor(solo));
    assert.deepEqual(direct.json(), { kind: "session", appPath: `/mini-app/trips/${onlyTrip}` });

    // Several trips under one account: the account's My trips.
    const many = tg();
    const u3 = await mkUser("U3");
    await mkMember(await mkTrip("A"), u3); await mkMember(await mkTrip("B"), u3);
    await linkOrganizer(u3, many);
    const mine = await exchange(app, initDataFor(many));
    assert.deepEqual(mine.json(), { kind: "session", appPath: "/mini-app" });

    // Trips under different accounts: choose. No cookie, no user ids.
    const chooser = tg();
    const c1 = await mkUser("C1"), c2 = await mkUser("C2");
    const t1 = await mkTrip("First"), t2 = await mkTrip("Second");
    await mkMember(t1, c1); await mkMember(t2, c2);
    await linkOrganizer(c1, chooser); await linkOrganizer(c2, chooser);
    const choose = await exchange(app, initDataFor(chooser));
    assert.equal(choose.statusCode, 200);
    assert.equal(choose.json().kind, "choose");
    assert.deepEqual(choose.json().trips.map((t: { tripId: string }) => t.tripId).sort(), [t1, t2].sort());
    assert.equal(cookieOf(choose, "kit_session"), null);
    assert.doesNotMatch(choose.body, new RegExp(`${c1}|${c2}|user_`));

    // Follow-up with a chosen trip: a session as the account that owns THAT trip.
    const picked = await exchange(app, initDataFor(chooser), { tripId: t2 });
    assert.deepEqual(picked.json(), { kind: "session", appPath: `/mini-app/trips/${t2}` });
    assert.equal((await me(app, asCookie(picked))).json().id, c2);

    // Chooser tampering: a trip outside the set never widens it.
    const foreignTrip = await mkTrip("Not theirs");
    await mkMember(foreignTrip, await mkUser("Foreign owner"));
    const tampered = await exchange(app, initDataFor(chooser), { tripId: foreignTrip });
    assert.equal(tampered.json().kind, "choose");
    assert.equal(tampered.json().notice, "TRIP_UNAVAILABLE");
    assert.equal(cookieOf(tampered, "kit_session"), null);
    const nonexistent = await exchange(app, initDataFor(chooser), { tripId: "trip_nosuchtrip0001" });
    assert.equal(nonexistent.body, tampered.body, "a foreign trip and a nonexistent trip look the same");
    const malformed = await exchange(app, initDataFor(chooser), { tripId: "../etc/passwd" });
    assert.equal(malformed.statusCode, 400);
  } finally { await app.close(); }
});

test("the DM binding is a last-resort hint: used only with no start_param and in the person's own chat", { skip }, async () => {
  const app = newApp();
  try {
    const telegramId = tg();
    const user = await mkUser("Dana");
    const a = await mkTrip("DM A"), b = await mkTrip("DM B");
    await mkMember(a, user); await mkMember(b, user);
    await linkOrganizer(user, telegramId);
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id,chat_id,trip_id) VALUES ($1,$2,$3)", [id("tcb"), String(telegramId), b]);

    const dm = await exchange(app, initDataFor(telegramId));
    assert.equal(dm.json().appPath, `/mini-app/trips/${b}`);
    const sender = await exchange(app, initDataFor(telegramId, { chat_type: "sender" }));
    assert.equal(sender.json().appPath, `/mini-app/trips/${b}`);
    // A group launch ignores it, and a start_param outranks it.
    const group = await exchange(app, initDataFor(telegramId, { chat_type: "supergroup", chat_instance: "123" }));
    assert.equal(group.json().appPath, "/mini-app");
    const explicit = await exchange(app, initDataFor(telegramId, { start_param: a }));
    assert.equal(explicit.json().appPath, `/mini-app/trips/${a}`);
    // The binding selects, it does not grant: a binding to a trip they cannot open is ignored.
    const stranger = tg();
    const foreign = await mkTrip("Foreign DM");
    await mkMember(foreign, await mkUser("Foreign"));
    const outsiderUser = await mkUser("Outsider");
    await mkMember(await mkTrip("Own"), outsiderUser);
    await linkOrganizer(outsiderUser, stranger);
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id,chat_id,trip_id) VALUES ($1,$2,$3)", [id("tcb"), String(stranger), foreign]);
    const ignored = await exchange(app, initDataFor(stranger));
    assert.doesNotMatch(ignored.body, new RegExp(foreign));
    assert.equal(ignored.json().kind, "session");
  } finally { await app.close(); }
});

test("a member linked in phase 2 is scoped to the one trip, and members' My trips lists runtime trips", { skip }, async () => {
  const app = newApp();
  try {
    const owner = await mkUser("Owner"), member = await mkUser("Mia Member");
    const t = await mkTrip("Member trip"), other = await mkTrip("Other member trip");
    await mkMember(t, owner); await mkMember(other, owner);
    await mkMember(t, member, "member", { dashboard: false, runtime: true });
    await mkMember(other, member, "member", { dashboard: false, runtime: true });
    const telegramId = tg();
    await pool.query(
      "INSERT INTO control_plane.telegram_member_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'mini_app_trip_password')",
      [`tml_${randomBytes(16).toString("hex")}`, member, t, digestTelegramId(String(telegramId))]);
    // Linked via trip t only: trip `other` is not reachable through this link.
    const response = await exchange(app, initDataFor(telegramId, { start_param: other }));
    assert.equal(response.json().notice, "TRIP_UNAVAILABLE");
    assert.equal(response.json().appPath, `/mini-app/trips/${t}`);
    const session = asCookie(response);
    // A member session is a member session: no owner routes.
    assert.equal((await app.inject({ method: "GET", url: `/v1/trips/${t}`, headers: { cookie: session } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/trips/${t}/interview-link`, headers: { cookie: session, "x-csrf-token": cookieOf(response, "kit_csrf")! } })).statusCode, 404);
    const listed = await app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: session } });
    assert.ok(listed.json().trips.some((x: { id: string }) => x.id === t));
  } finally { await app.close(); }
});

// ── Replay ──────────────────────────────────────────────────────────────────

test("one launch mints at most three sessions; a re-encoded copy shares the bucket; the fourth is refused", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Replay");
    const trip = await mkTrip("Replay trip");
    await mkMember(trip, user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    const initData = initDataFor(telegramId, { start_param: trip });
    const respelled = initData.split("&").reverse().map((p) => p.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())).join("&");
    assert.notEqual(respelled, initData);
    const spellings = [initData, respelled, initData];
    assert.equal(MINI_APP_SESSIONS_PER_LAUNCH, 3);
    for (const [index, spelling] of spellings.entries()) {
      assert.equal((await exchange(app, spelling)).statusCode, 200, `use ${index + 1}`);
    }
    const fourth = await exchange(app, respelled);
    assert.equal(fourth.statusCode, 401);
    assert.deepEqual(fourth.json(), { error: "TELEGRAM_INIT_DATA_INVALID" });
    assert.equal(cookieOf(fourth, "kit_session"), null);
    const stored = await pool.query("SELECT sessions_minted FROM control_plane.telegram_mini_app_launches ORDER BY created_at DESC LIMIT 1");
    assert.equal(stored.rows[0].sessions_minted, 3);
  } finally { await app.close(); }
});

test("the cap holds across two API processes racing on the same launch", { skip }, async () => {
  const second = testPool({ max: 6 });
  const appA = newApp(), appB = newApp(second);
  try {
    const user = await mkUser("Race");
    const trip = await mkTrip("Race trip");
    await mkMember(trip, user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    const initData = initDataFor(telegramId, { start_param: trip });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => exchange(i % 2 ? appA : appB, initData)));
    const ok = results.filter((r) => r.statusCode === 200).length;
    const refused = results.filter((r) => r.statusCode === 401).length;
    assert.equal(ok, MINI_APP_SESSIONS_PER_LAUNCH);
    assert.equal(refused, 12 - MINI_APP_SESSIONS_PER_LAUNCH);
    const sessions = await pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions WHERE user_id = $1", [user]);
    assert.equal(sessions.rows[0].n, MINI_APP_SESSIONS_PER_LAUNCH);
  } finally { await appA.close(); await appB.close(); await second.end(); }
});

test("a launch that ends in choose or NOT_LINKED mints nothing and does not use up the cap", { skip }, async () => {
  const app = newApp();
  try {
    const telegramId = tg();
    const initData = initDataFor(telegramId);
    for (let i = 0; i < 5; i++) assert.equal((await exchange(app, initData)).statusCode, 401);
    const user = await mkUser("Later");
    await mkMember(await mkTrip("Later trip"), user);
    await linkOrganizer(user, telegramId);
    assert.equal((await exchange(app, initData)).statusCode, 200);
  } finally { await app.close(); }
});

// ── Shared device ───────────────────────────────────────────────────────────

test("a verified launch revokes whatever kit_session the WebView already held", { skip }, async () => {
  const app = newApp();
  try {
    const previous = await mkUser("Previous Person");
    const previousSession = await webSession(previous, "prev");
    assert.equal((await me(app, previousSession.cookie)).statusCode, 200);

    const user = await mkUser("New Person");
    const trip = await mkTrip("New trip");
    await mkMember(trip, user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    const minted = await exchange(app, initDataFor(telegramId), { cookie: previousSession.cookie });
    assert.equal(minted.statusCode, 200);
    assert.equal((await me(app, previousSession.cookie)).statusCode, 401, "the previous session is revoked");
    assert.equal((await me(app, asCookie(minted))).json().id, user);

    // The same on a launch that ends in NOT_LINKED, and the cookies are cleared.
    const second = await webSession(previous, "prev2");
    const refused = await exchange(app, initDataFor(tg()), { cookie: second.cookie });
    assert.equal(refused.statusCode, 401);
    assert.equal((await me(app, second.cookie)).statusCode, 401);
    assert.match(String(([] as string[]).concat(refused.headers["set-cookie"] as string[]).find((c) => c.startsWith("kit_session="))), /Max-Age=0/);

    // A forged launch touches nothing: no session is revoked by an unverified request.
    const third = await webSession(previous, "prev3");
    const forged = await exchange(app, initDataFor(telegramId).replace(/hash=[0-9a-f]{64}/, `hash=${"0".repeat(64)}`), { cookie: third.cookie });
    assert.equal(forged.statusCode, 401);
    assert.equal((await me(app, third.cookie)).statusCode, 200);
  } finally { await app.close(); }
});

// ── Safeguards: visible, revocable, announced ───────────────────────────────

test("a forwarded interview link is visible to the organizer, who can unlink it and end its sessions", { skip }, async () => {
  const app = newApp();
  try {
    const organizer = await mkUser("Real Organizer");
    const trip = await mkTrip("Forwarded");
    await mkMember(trip, organizer);
    const attacker = tg();
    // What redeeming a forwarded interview link writes (organizer-trips.ts).
    const linkId = await linkOrganizer(organizer, attacker);
    const attackerSession = await exchange(app, initDataFor(attacker));
    assert.equal(attackerSession.statusCode, 200);
    assert.equal((await me(app, asCookie(attackerSession))).json().id, organizer);

    const owner = await webSession(organizer, "owner");
    const listed = await app.inject({ method: "GET", url: "/v1/account/telegram-links", headers: { cookie: owner.cookie } });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.headers["cache-control"], "private, no-store");
    const body = listed.json();
    assert.equal(body.links.length, 1);
    assert.deepEqual(Object.keys(body.links[0]).sort(), ["id", "lastSignedInAt", "linkedAt", "scope", "tripTitle", "via"]);
    assert.equal(body.links[0].id, linkId);
    assert.equal(body.links[0].via, "interview_link");
    assert.equal(body.links[0].scope, "account");
    assert.ok(body.links[0].lastSignedInAt);
    // Never the Telegram id, its digest, or any piece of either.
    const digestHex = digestTelegramId(String(attacker)).slice("sha256:".length);
    assert.doesNotMatch(listed.body, new RegExp(`${attacker}|${digestHex.slice(0, 8)}|sha256`));

    // Another user cannot see or unlink it; unlinking needs the CSRF token.
    const bystander = await webSession(await mkUser("Bystander"), "by");
    const theirs = await app.inject({ method: "GET", url: "/v1/account/telegram-links", headers: { cookie: bystander.cookie } });
    assert.deepEqual(theirs.json().links, []);
    const denied = await app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${linkId}`, headers: { cookie: bystander.cookie, "x-csrf-token": bystander.csrf } });
    assert.equal(denied.statusCode, 404);
    const noCsrf = await app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${linkId}`, headers: { cookie: owner.cookie } });
    assert.equal(noCsrf.statusCode, 403);

    const unlinked = await app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${linkId}`, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });
    assert.equal(unlinked.statusCode, 200);
    assert.equal((await me(app, asCookie(attackerSession))).statusCode, 401, "sessions the link minted end with it");
    const after = await exchange(app, initDataFor(attacker));
    assert.equal(after.statusCode, 401);
    assert.equal(after.json().error, "TELEGRAM_NOT_LINKED");
    assert.deepEqual((await app.inject({ method: "GET", url: "/v1/account/telegram-links", headers: { cookie: owner.cookie } })).json().links, []);
    const again = await app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${linkId}`, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });
    assert.equal(again.statusCode, 404);
    const stored = await pool.query("SELECT revoked_reason FROM control_plane.telegram_organizer_links WHERE id = $1", [linkId]);
    assert.equal(stored.rows[0].revoked_reason, "owner_unlinked");
  } finally { await app.close(); }
});

test("the first sign-in through a link queues one notice via the outbox; a second queues none; the ordinary dispatcher sends it once and nulls the id", { skip }, async () => {
  const app = newApp();
  try {
    await pool.query("DELETE FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice'");
    const user = await mkUser("Noticed Person");
    await mkMember(await mkTrip("Noticed"), user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    assert.equal((await exchange(app, initDataFor(telegramId))).statusCode, 200);
    assert.equal((await exchange(app, initDataFor(telegramId))).statusCode, 200);
    const queued = await pool.query("SELECT recipient, trip_id, state, payload FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice'");
    assert.equal(queued.rowCount, 1);
    assert.equal(queued.rows[0].recipient, String(telegramId));
    assert.equal(queued.rows[0].trip_id, null);
    assert.equal(queued.rows[0].state, "pending");

    const sent: Array<{ chatId: string; text: string }> = [];
    const adapter = { sendApprovalRequest: async () => {}, sendMessage: async (m: { chatId: string; text: string }) => { sent.push(m); } };
    // The one dispatcher that sends every other outbox row sends this one too.
    await dispatchPendingTripNotifications(pool, adapter, () => {}, { publicOrigin: ORIGIN });
    const mine = sent.filter((m) => m.chatId === String(telegramId));
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.text, /Noticed Person/);
    assert.match(mine[0]!.text, /Unlink/);
    assert.match(mine[0]!.text, new RegExp(`${ORIGIN}/trips`));
    const done = await pool.query("SELECT state, recipient FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice'");
    assert.equal(done.rows[0].state, "sent");
    assert.equal(done.rows[0].recipient, null, "the raw Telegram id does not stay at rest");
    await dispatchPendingTripNotifications(pool, adapter, () => {}, { publicOrigin: ORIGIN });
    assert.equal(sent.filter((m) => m.chatId === String(telegramId)).length, 1, "sent exactly once");
  } finally { await app.close(); }
});

test("a failing Telegram send leaves the notice pending and never fails or delays the sign-in", { skip }, async () => {
  const app = newApp();
  try {
    await pool.query("DELETE FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice'");
    const user = await mkUser("Outage");
    await mkMember(await mkTrip("Outage trip"), user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    assert.equal((await exchange(app, initDataFor(telegramId))).statusCode, 200);
    const broken = { sendApprovalRequest: async () => {}, sendMessage: async () => { throw new Error("telegram down"); } };
    assert.equal(await dispatchPendingTripNotifications(pool, broken, (line) => logs.push(line), { publicOrigin: ORIGIN }), 0);
    const row = await pool.query("SELECT state, attempt FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice'");
    assert.equal(row.rows[0].state, "pending");
    assert.equal(row.rows[0].attempt, 1);
    // The ordinary retry budget applies; when it is spent the row fails for good
    // and the raw Telegram id is dropped with it.
    for (let i = 0; i < 5; i++) await dispatchPendingTripNotifications(pool, broken, () => {}, { publicOrigin: ORIGIN });
    const spent = await pool.query("SELECT state, recipient FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice'");
    assert.equal(spent.rows[0].state, "failed");
    assert.equal(spent.rows[0].recipient, null);
  } finally { await app.close(); }
});

// ── Phase 2: members link themselves, once, with a credential ──────────────

async function memberWithInvite(app: App, owner: { cookie: string; csrf: string }, tripId: string, username: string) {
  const created = await app.inject({
    method: "POST", url: `/v1/trips/${tripId}/site-invites`, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf },
    payload: { displayName: `Guest ${username}`, runtimeUsername: username },
  });
  assert.equal(created.statusCode, 201);
  return new URL(created.json().joinUrl).hash.slice("#token=".length);
}
const linkBody = (initData: string, consent = true) => ({ telegramLink: { initData, consent } });
const passwordPost = (app: App, payload: Record<string, unknown>, headers: Record<string, string> = { origin: ORIGIN }) =>
  app.inject({ method: "POST", url: "/v1/auth/password", headers, payload });
async function linksFor(userId: string) {
  return (await pool.query("SELECT * FROM control_plane.telegram_member_links WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
}

test("phase 2: invite redemption and trip-password sign-in link a member only with consent, fresh verified initData and a credential, once", { skip }, async () => {
  const app = newApp();
  try {
    const organizer = await mkUser("Org");
    const trip = await mkTrip("Phase two");
    await mkMember(trip, organizer);
    const owner = await webSession(organizer, "ph2");
    const username = `guest-${suffix}${hex().slice(0, 4)}`;
    const token = await memberWithInvite(app, owner, trip, username);
    const telegramId = tg();

    // Redemption WITH consent, verified fresh initData and a chosen password:
    // the only shape that links. (Refusals follow below; none of them fails the
    // sign-in or redemption it rode on.)
    const redeem = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem", headers: { origin: ORIGIN },
      payload: { token, method: "password", password: "member-secret-1", ...linkBody(initDataFor(telegramId), true) },
    });
    assert.equal(redeem.statusCode, 200, redeem.body);
    assert.equal(redeem.json().telegramLink, "linked");
    const memberUser = (await pool.query("SELECT redeemed_by FROM control_plane.site_invites WHERE trip_id = $1 AND runtime_username = $2", [trip, username])).rows[0].redeemed_by as string;
    const links = await linksFor(memberUser);
    assert.equal(links.length, 1);
    assert.equal(links[0].verified_via, "mini_app_invite_redemption");
    assert.equal(links[0].trip_id, trip);
    assert.equal(links[0].telegram_subject_digest, digestTelegramId(String(telegramId)));

    // That Telegram account now opens the trip as the member, with no password.
    const opened = await exchange(app, initDataFor(telegramId, { start_param: trip }));
    assert.equal(opened.statusCode, 200);
    assert.equal((await me(app, asCookie(opened))).json().id, memberUser);

    // Trip-password sign-in: no consent flag / consent false → nothing.
    const other = tg();
    const noConsent = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1" });
    assert.equal(noConsent.statusCode, 200); assert.equal(noConsent.json().telegramLink, undefined);
    const denied = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1", ...linkBody(initDataFor(other), false) });
    assert.equal(denied.statusCode, 200);
    assert.equal(await linksFor(memberUser).then((l) => l.filter((x) => x.revoked_at === null).length), 1);

    // Failed password → 401, nothing linked, and the launch is not burned.
    const fresh = initDataFor(other);
    const wrong = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "wrong-password", ...linkBody(fresh) });
    assert.equal(wrong.statusCode, 401);
    assert.equal((await linksFor(memberUser)).length, 1);
    const good = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1", ...linkBody(fresh) });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().telegramLink, "linked");
    assert.equal((await linksFor(memberUser)).length, 2);
    // Replay: the same initData cannot write a second link (a different account would be needed).
    const replayed = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1", ...linkBody(fresh) });
    assert.equal(replayed.statusCode, 200);
    assert.equal(replayed.json().telegramLink, "skipped");
    assert.equal((await linksFor(memberUser)).length, 2);

    // Stale launch (older than ~60 s), forged and other-bot initData: sign-in
    // succeeds, nothing is linked, and the answer says so.
    const stale = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1", ...linkBody(initDataFor(tg(), {}, Date.now() - 120_000)) });
    assert.equal(stale.statusCode, 200); assert.equal(stale.json().telegramLink, "skipped");
    const forged = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1", ...linkBody(initDataFor(tg()).replace(/hash=[0-9a-f]{64}/, `hash=${"1".repeat(64)}`)) });
    assert.equal(forged.json().telegramLink, "skipped");
    assert.equal((await linksFor(memberUser)).length, 2);

    // Existing cookie session + redemption: never links.
    const second = await memberWithInvite(app, owner, trip, `${username}b`);
    const signedIn = await webSession(await mkUser("Cookie user"), "cookie");
    const viaCookie = await app.inject({
      method: "POST", url: "/v1/site-invites/redeem", headers: { origin: ORIGIN, cookie: signedIn.cookie },
      payload: { token: second, method: "password", password: "member-secret-2", ...linkBody(initDataFor(tg())) },
    });
    assert.equal(viaCookie.statusCode, 200, viaCookie.body);
    assert.equal(viaCookie.json().telegramLink, undefined);
  } finally { await app.close(); }
});

test("a database error while writing the link costs the link, never the sign-in", { skip }, async () => {
  const app = newApp();
  try {
    const organizer = await mkUser("Org Savepoint");
    const trip = await mkTrip("Savepoint");
    await mkMember(trip, organizer);
    const owner = await webSession(organizer, "sp");
    const username = `sp-${suffix}${hex().slice(0, 3)}`;
    const token = await memberWithInvite(app, owner, trip, username);
    await app.inject({ method: "POST", url: "/v1/site-invites/redeem", headers: { origin: ORIGIN }, payload: { token, method: "password", password: "member-secret-1" } });
    await pool.query("ALTER TABLE control_plane.telegram_member_links RENAME TO telegram_member_links_away");
    try {
      logs.length = 0;
      const initData = initDataFor(tg());
      const response = await passwordPost(app, { tripId: trip, runtimeUsername: username, password: "member-secret-1", ...linkBody(initData) });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().telegramLink, "skipped");
      assert.ok(cookieOf(response, "kit_session"), "the session was still issued");
      assert.ok(logs.some((l) => l.includes("mini_app.link_failed")));
    } finally {
      await pool.query("ALTER TABLE control_plane.telegram_member_links_away RENAME TO telegram_member_links");
    }
  } finally { await app.close(); }
});

test("member links end with the trip password, the membership, or the invite — and take their sessions with them", { skip }, async () => {
  const app = newApp();
  try {
    const organizer = await mkUser("Org2");
    const trip = await mkTrip("Revocations");
    await mkMember(trip, organizer);
    const owner = await webSession(organizer, "rev");
    const results: Record<string, string> = {};
    for (const event of ["password", "membership", "invite"] as const) {
      const username = `rev-${event}-${suffix}${hex().slice(0, 3)}`;
      const token = await memberWithInvite(app, owner, trip, username);
      const telegramId = tg();
      const redeemed = await app.inject({
        method: "POST", url: "/v1/site-invites/redeem", headers: { origin: ORIGIN },
        payload: { token, method: "password", password: "member-secret-1", ...linkBody(initDataFor(telegramId)) },
      });
      assert.equal(redeemed.json().telegramLink, "linked");
      const userId = (await pool.query("SELECT redeemed_by FROM control_plane.site_invites WHERE trip_id = $1 AND runtime_username = $2", [trip, username])).rows[0].redeemed_by as string;
      const opened = await exchange(app, initDataFor(telegramId, { start_param: trip }));
      assert.equal(opened.statusCode, 200);
      const cookie = asCookie(opened);

      if (event === "password") await pool.query("UPDATE control_plane.web_password_credentials SET password_hash = $1 WHERE user_id = $2 AND trip_id = $3", [`scrypt:rotated:${hex()}${hex()}${hex()}`, userId, trip]);
      if (event === "membership") await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE user_id = $1 AND trip_id = $2", [userId, trip]);
      if (event === "invite") await pool.query("UPDATE control_plane.site_invites SET state = 'revoked' WHERE trip_id = $1 AND runtime_username = $2", [trip, username]);

      const link = (await linksFor(userId))[0];
      results[event] = link.revoked_reason;
      assert.equal((await me(app, cookie)).statusCode, 401, `${event}: the session minted by the link ends`);
      const again = await exchange(app, initDataFor(telegramId, { start_param: trip }));
      assert.equal(again.statusCode, 401, `${event}: the link no longer signs in`);
    }
    assert.deepEqual(results, { password: "trip_password_changed", membership: "membership_ended", invite: "invite_revoked" });
  } finally { await app.close(); }
});

test("revoking an unused invite through the portal also routes through the trigger without error", { skip }, async () => {
  const app = newApp();
  try {
    const organizer = await mkUser("Org3");
    const trip = await mkTrip("Unused invite");
    await mkMember(trip, organizer);
    const owner = await webSession(organizer, "unused");
    await memberWithInvite(app, owner, trip, `unused-${suffix}${hex().slice(0, 3)}`);
    const invite = (await pool.query("SELECT id FROM control_plane.site_invites WHERE trip_id = $1", [trip])).rows[0].id;
    const revoked = await app.inject({ method: "DELETE", url: `/v1/trips/${trip}/site-invites/${invite}`, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });
    assert.equal(revoked.statusCode, 200);
  } finally { await app.close(); }
});

// ── Trip-password route hardening ───────────────────────────────────────────

test("POST /v1/auth/password: Origin must be ours, and it is rate limited per account and per IP", { skip }, async () => {
  const app = newApp();
  try {
    const organizer = await mkUser("Org4");
    const trip = await mkTrip("Limited");
    await mkMember(trip, organizer);
    const owner = await webSession(organizer, "lim");
    const username = `lim-${suffix}${hex().slice(0, 3)}`;
    const token = await memberWithInvite(app, owner, trip, username);
    await app.inject({ method: "POST", url: "/v1/site-invites/redeem", headers: { origin: ORIGIN }, payload: { token, method: "password", password: "member-secret-1" } });
    const payload = { tripId: trip, runtimeUsername: username, password: "wrong-password" };

    for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }] as Array<Record<string, string>>) {
      const refused = await passwordPost(app, payload, headers);
      assert.equal(refused.statusCode, 403, JSON.stringify(headers));
      assert.deepEqual(refused.json(), { error: "ORIGIN_INVALID" });
    }
    // Junk accounts do not consume any account's allowance.
    for (let i = 0; i < 12; i++) {
      const junk = await passwordPost(app, { tripId: "trip_nosuchtrip0002", runtimeUsername: "ghost", password: "wrong-password" });
      assert.equal(junk.statusCode, 401, `junk attempt ${i + 1} is never throttled as an account`);
    }
    // The real account allows ten attempts a minute.
    for (let i = 0; i < 10; i++) assert.equal((await passwordPost(app, payload)).statusCode, 401);
    const limited = await passwordPost(app, payload);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: "SIGN_IN_RATE_LIMITED" });
    assert.equal(limited.headers["retry-after"], "60");
  } finally { await app.close(); }
});

test("POST /v1/auth/password: the per-IP limit applies before any lookup", { skip }, async () => {
  let queries = 0;
  const counting = new Proxy(pool, { get(target, prop, receiver) {
    if (prop === "query") return (...args: unknown[]) => { queries++; return (target.query as (...a: unknown[]) => unknown)(...args); };
    return Reflect.get(target, prop, receiver);
  } }) as pg.Pool;
  const limited = newApp(counting);
  try {
    for (let i = 0; i < 100; i++) await passwordPost(limited, { tripId: `trip_nosuch${String(i).padStart(6, "0")}`, runtimeUsername: "ghost", password: "wrong-password" });
    const before = queries;
    const blocked = await passwordPost(limited, { tripId: "trip_nosuchtrip0003", runtimeUsername: "ghost", password: "wrong-password" });
    assert.equal(blocked.statusCode, 429);
    assert.equal(queries, before, "the 101st request reached no query");
  } finally { await limited.close(); }
});

// ── Redaction ───────────────────────────────────────────────────────────────

test("nothing the Mini App path logs contains initData, a hash, the Telegram id, its digest or the bot token", { skip }, async () => {
  logs.length = 0;
  const app = newApp();
  try {
    const user = await mkUser("Redacted");
    const trip = await mkTrip("Redaction trip");
    await mkMember(trip, user);
    const telegramId = tg();
    await linkOrganizer(user, telegramId);
    const secrets: string[] = [];
    const run = async (initData: string, opts = {}) => {
      secrets.push(initData, ...new URLSearchParams(initData).values());
      return exchange(app, initData, opts);
    };
    assert.equal((await run(initDataFor(telegramId, { start_param: trip }))).statusCode, 200);
    await run(initDataFor(tg()));                                              // not linked
    await run(initDataFor(telegramId).replace(/hash=[0-9a-f]{64}/, `hash=${"a".repeat(64)}`)); // forged
    await run(initDataFor(telegramId, {}, Date.now() - 900_000));              // stale
    const replay = initDataFor(telegramId);
    for (let i = 0; i < 4; i++) await run(replay);                             // cap
    const digest = digestTelegramId(String(telegramId));
    const needles = [String(telegramId), digest, digest.slice("sha256:".length), TEST_BOT_TOKEN, ...secrets.filter((s) => s.length >= 8)];
    assert.ok(logs.length > 0, "the path does log (otherwise this test proves nothing)");
    for (const line of logs) {
      for (const needle of needles) assert.equal(line.includes(needle), false, `a log line contains a secret: ${line.slice(0, 120)}`);
    }
    assert.ok(logs.some((l) => l.includes("mini_app.sign_in")));
    assert.ok(logs.some((l) => l.includes("mini_app.init_data_rejected")));
  } finally { await app.close(); }
});

test("capabilities reports the Mini App flag, and a disabled feature answers 503 before anything else", { skip }, async () => {
  let enabled = true;
  const app = newApp(pool, { telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => enabled, log: () => {} } });
  try {
    assert.equal((await app.inject({ url: "/v1/auth/capabilities" })).json().telegramMiniApp, true);
    enabled = false;
    assert.equal((await app.inject({ url: "/v1/auth/capabilities" })).json().telegramMiniApp, false);
    const off = await exchange(app, initDataFor(tg()));
    assert.equal(off.statusCode, 503);
    assert.deepEqual(off.json(), { error: "TELEGRAM_MINI_APP_UNAVAILABLE" });
  } finally { await app.close(); }
});
