/**
 * Restore without Telegram (owner request, round-3 staging test, 2026-10-23):
 * a Telegram account the signed-in owner Unlinked comes back with one click.
 *
 * Every assertion is a way a restore could have given access it should not (to
 * a scoped session, a non-organizer, a membership that ended, someone else's
 * link), revived what an Unlink ended (sessions), promoted someone it should
 * not (the bot's organizer fact without the demotion marker), or lost the
 * record of what happened.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { resolveChatRoute } from "../src/chat-router.js";
import { issueEnrollment } from "../src/enrollment.js";
import { digestTelegramId, telegramDisplayLabel } from "../src/identity.js";
import { issueTelegramLinkToken } from "../src/telegram-link-token.js";
import { DEFAULT_STRINGS, dispatchUpdate } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { applyMigrations } from "../src/migrations.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { PORTAL_SCOPE_POLICY } from "../src/portal-scope.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const hex = () => randomBytes(8).toString("hex");
let nextTg = 7_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
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
  await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,'ready_private',$3)", [tripId, `rs-${tripId.replace(/_/g, "-").toLowerCase()}`, title]);
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
async function personLink(tripId: string, telegramId: number, role: string) {
  await pool.query(
    `INSERT INTO control_plane.trip_person_links(id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
     VALUES ($1, $2, $3, $4, 'P', $5, 'interview_chat')`,
    [id("tpl"), tripId, String(telegramId), `p${hex()}`, role]);
}
const person = async (tripId: string, telegramId: number) =>
  (await pool.query<{ role: string; demoted_from_role: string | null }>(
    "SELECT role, demoted_from_role FROM control_plane.trip_person_links WHERE trip_id = $1 AND telegram_user_id = $2", [tripId, String(telegramId)])).rows[0]!;
type Sess = { cookie: string; csrf: string; raw: string };
async function fullSession(userId: string, label: string): Promise<Sess> {
  const raw = `sess-${label}-${suffix}${hex()}`, csrf = `csrf-${label}-${suffix}${hex()}`;
  await pool.query(
    "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
    [id("wsess"), userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf, raw };
}
/** A session minted the way a real Mini App launch mints one. */
async function telegramSession(app: App, telegramId: number, tripId: string): Promise<Sess> {
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
const call = (app: App, session: Sess, method: string, url: string) => app.inject({
  method: method as "GET", url, headers: { cookie: session.cookie, "x-csrf-token": session.csrf, origin: ORIGIN },
});
const restore = (app: App, session: Sess, linkId: string) => call(app, session, "POST", `/v1/account/telegram-links/${linkId}/restore`);
const unlink = (app: App, session: Sess, linkId: string) => call(app, session, "DELETE", `/v1/account/telegram-links/${linkId}`);
const tripCard = async (app: App, session: Sess, tripId: string) => (await call(app, session, "GET", `/v1/trips/${tripId}`)).json();
const live = (userId: string, tripId: string) => pool.query(
  "SELECT id, verified_via, telegram_subject_digest, first_signed_in_at FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1 AND trip_id = $2 AND revoked_at IS NULL", [userId, tripId]);
const row = async (linkId: string) => (await pool.query("SELECT * FROM control_plane.telegram_organizer_trip_links WHERE id = $1", [linkId])).rows[0]!;

/** Olive owns Rome; her phone (telegramId) is linked to it. */
async function fixture(app: App) {
  const user = await mkUser("Olive"); const rome = await mkTrip("Rome");
  await mkMember(rome, user);
  const telegramId = tg();
  const link = await organizerLink(user, rome, telegramId);
  const full = await fullSession(user, "full");
  return { user, rome, telegramId, link, full, app };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 8 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

test("an owner Unlink can be restored with one click: a NEW live link for the same Telegram account, the Unlink kept in the record", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    const unlinked = await unlink(app, full, link);
    assert.equal(unlinked.statusCode, 200);
    assert.equal((await live(user, rome)).rowCount, 0);
    // The card now offers it: when it was linked and unlinked, how - never an id, a digest or a name.
    const card = await tripCard(app, full, rome);
    assert.deepEqual(card.telegram.links, []);
    assert.equal(card.telegram.unlinked.length, 1);
    assert.deepEqual(Object.keys(card.telegram.unlinked[0]).sort(), ["id", "linkedAt", "unlinkedAt", "via"]);
    assert.equal(card.telegram.unlinked[0].id, link);
    // (the opaque ids are random hex and may hold a run of digits, so they are blanked before looking for a Telegram id)
    assert.doesNotMatch(JSON.stringify(card.telegram).replace(/otl_[0-9a-f]{32}/g, "otl_ID"), /sha256:|telegram_subject|[0-9]{9,}/);
    assert.ok(!JSON.stringify(card.telegram).includes(String(telegramId)), "the Telegram id is not in the payload");

    const response = await restore(app, full, link);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: "restored" });
    assert.equal(response.headers["cache-control"], "private, no-store");

    const now = (await live(user, rome)).rows;
    assert.equal(now.length, 1, "exactly one live link");
    assert.notEqual(now[0].id, link, "a new row, not the old one reopened");
    assert.equal(now[0].verified_via, "dashboard_restore");
    assert.equal(now[0].telegram_subject_digest, digestTelegramId(String(telegramId)), "the same Telegram account");
    assert.equal(now[0].first_signed_in_at, null, "it has not signed in yet: the first sign-in announces itself again");

    // The record: the Unlink is still there, and who restored it, when, as which row.
    const old = await row(link);
    assert.equal(old.revoked_reason, "owner_unlinked");
    assert.ok(old.revoked_at, "the Unlink stays recorded");
    assert.equal(old.revoked_by, user, "who unlinked");
    assert.ok(old.restored_at);
    assert.equal(old.restored_by, user, "who restored");
    assert.equal(old.restored_link_id, now[0].id, "as which link");

    // The card: live again, nothing left to restore, and a second click is a plain refusal.
    const after = await tripCard(app, full, rome);
    assert.equal(after.telegram.links.length, 1);
    assert.equal(after.telegram.links[0].via, "dashboard_restore");
    assert.deepEqual(after.telegram.unlinked, []);
    const again = await restore(app, full, link);
    assert.equal(again.statusCode, 404);
    assert.equal((await live(user, rome)).rowCount, 1, "no second link");

    // And the restored account really signs in again, to this trip only.
    const mini = await telegramSession(app, telegramId, rome);
    assert.equal((await call(app, mini, "GET", `/v1/trips/${rome}`)).statusCode, 200);
  } finally { await app.close(); }
});

test("the policy table classifies the restore route as account-level (a full session only)", () => {
  assert.equal(PORTAL_SCOPE_POLICY["POST /v1/account/telegram-links/:linkId/restore"], "account");
});

test("a link revoked because the membership ended is NOT restorable, even if the membership comes back", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, link, full } = await fixture(app);
    await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [rome, user]);
    assert.equal((await row(link)).revoked_reason, "membership_ended", "the trigger ended it");
    await pool.query("UPDATE control_plane.trip_memberships SET status = 'active' WHERE trip_id = $1 AND user_id = $2", [rome, user]);
    const card = await tripCard(app, full, rome);
    assert.deepEqual(card.telegram.unlinked, [], "not offered");
    const response = await restore(app, full, link);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "NOT_FOUND" });
    assert.equal((await live(user, rome)).rowCount, 0, "nothing was written");
    assert.equal((await row(link)).restored_at, null);
  } finally { await app.close(); }
});

test("a scoped (Telegram-minted) session cannot restore: 403, nothing written, and its trip card never lists Unlinked accounts", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, link, full } = await fixture(app);
    const oslo = await mkTrip("Oslo"); await mkMember(oslo, user);
    // A second phone, still linked to Rome, mints the scoped session; the FIRST phone gets Unlinked.
    const second = tg();
    await organizerLink(user, rome, second);
    const scoped = await telegramSession(app, second, rome);
    assert.equal((await unlink(app, full, link)).statusCode, 200);

    const response = await restore(app, scoped, link);
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in with your password to do this." });
    assert.equal((await live(user, rome)).rows.filter((r) => r.verified_via === "dashboard_restore").length, 0);
    assert.equal((await row(link)).restored_at, null);

    const scopedCard = await tripCard(app, scoped, rome);
    assert.equal(scopedCard.id, rome, "the scoped session still opens its trip");
    assert.equal("unlinked" in scopedCard.telegram, false, "Restore is not offered to a scoped session");
    const listed = (await call(app, scoped, "GET", "/v1/trips")).json().trips;
    assert.ok(listed.every((t: { telegram?: object }) => !t.telegram || !("unlinked" in t.telegram)));
    assert.deepEqual((await tripCard(app, full, rome)).telegram.unlinked.map((u: { id: string }) => u.id), [link], "the full session still sees it");
  } finally { await app.close(); }
});

test("a non-organizer, another person's link and an unknown id are the same 404, byte for byte", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, link, full } = await fixture(app);
    assert.equal((await unlink(app, full, link)).statusCode, 200);

    const stranger = await mkUser("Stranger");
    const strangerSession = await fullSession(stranger, "stranger");
    const foreign = await restore(app, strangerSession, link);
    const unknown = await restore(app, full, "otl_doesnotexist0000000000000000");
    const garbage = await restore(app, full, "not-a-link");
    const memberLinkId = await restore(app, full, "tml_doesnotexist0000000000000000");
    assert.equal(foreign.statusCode, 404);
    for (const other of [unknown, garbage, memberLinkId]) {
      assert.equal(other.statusCode, 404);
      assert.equal(other.body, foreign.body, "indistinguishable from an unknown id");
    }

    // The owner's own row, but she is no longer an owner/organizer of the trip: a member cannot restore.
    await pool.query("UPDATE control_plane.trip_memberships SET role = 'member', dashboard_access = false WHERE trip_id = $1 AND user_id = $2", [rome, user]);
    const demoted = await restore(app, full, link);
    assert.equal(demoted.statusCode, 404);
    assert.equal(demoted.body, foreign.body);
    // An organizer-role member with dashboard access may (the same people the Link button is for).
    await pool.query("UPDATE control_plane.trip_memberships SET role = 'organizer', dashboard_access = true WHERE trip_id = $1 AND user_id = $2", [rome, user]);
    assert.equal((await restore(app, full, link)).statusCode, 200);
  } finally { await app.close(); }
});

test("a retired trip refuses: the same 404", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, link, full } = await fixture(app);
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    await pool.query("UPDATE control_plane.trips SET slug = $2 WHERE id = $1", [rome, `retired-rome-${suffix}-20261023`]);
    const gone = await restore(app, full, link);
    assert.equal(gone.statusCode, 404);
    assert.equal((await live(user, rome)).rowCount, 0);
  } finally { await app.close(); }
});

test("Origin and CSRF are enforced like every mutation; no session is 401", { skip }, async () => {
  const app = newApp();
  try {
    const { link, full } = await fixture(app);
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    const url = `/v1/account/telegram-links/${link}/restore`;
    assert.equal((await app.inject({ method: "POST", url })).statusCode, 401);
    const noCsrf = await app.inject({ method: "POST", url, headers: { cookie: full.cookie, origin: ORIGIN } });
    assert.equal(noCsrf.statusCode, 403); assert.equal(noCsrf.json().error, "CSRF_INVALID");
    const badOrigin = await app.inject({ method: "POST", url, headers: { cookie: full.cookie, "x-csrf-token": full.csrf, origin: "https://evil.example" } });
    assert.equal(badOrigin.statusCode, 403); assert.equal(badOrigin.json().error, "ORIGIN_INVALID");
    assert.equal((await row(link)).restored_at, null, "none of the refused requests restored anything");
    assert.equal((await restore(app, full, link)).statusCode, 200);
  } finally { await app.close(); }
});

test("the bot's organizer fact comes back only with the demotion marker; a participant all along is never promoted", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    await personLink(rome, telegramId, "organizer");
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.deepEqual(await person(rome, telegramId), { role: "participant", demoted_from_role: "organizer" }, "the Unlink demoted and recorded it");
    assert.equal((await restore(app, full, link)).statusCode, 200);
    assert.deepEqual(await person(rome, telegramId), { role: "organizer", demoted_from_role: null }, "restored exactly, marker cleared");

    // Never demoted: a participant whose Telegram account has an old owner_unlinked row on the trip.
    const q = tg();
    await personLink(rome, q, "participant");
    const old = await organizerLink(user, rome, q);
    assert.equal((await unlink(app, full, old)).statusCode, 200);
    assert.deepEqual(await person(rome, q), { role: "participant", demoted_from_role: null }, "nothing to demote, no marker");
    assert.equal((await restore(app, full, old)).statusCode, 200, "the link itself comes back");
    assert.deepEqual(await person(rome, q), { role: "participant", demoted_from_role: null }, "but without the marker the participant is not promoted");

    // A row demoted before the marker existed (role participant, no marker) is not guessed back either.
    const legacy = tg();
    await personLink(rome, legacy, "participant");
    const legacyLink = await organizerLink(user, rome, legacy);
    assert.equal((await unlink(app, full, legacyLink)).statusCode, 200);
    assert.equal((await restore(app, full, legacyLink)).statusCode, 200);
    assert.equal((await person(rome, legacy)).role, "participant");
  } finally { await app.close(); }
});

test("restoring revives NO session: the sessions the Unlink ended stay ended, the new link has none, and the person signs in fresh", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    const oldPhone = await telegramSession(app, telegramId, rome);
    assert.equal((await call(app, oldPhone, "GET", "/v1/me")).statusCode, 200);
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.equal((await call(app, oldPhone, "GET", "/v1/me")).statusCode, 401, "the Unlink ended it");

    assert.equal((await restore(app, full, link)).statusCode, 200);
    assert.equal((await call(app, oldPhone, "GET", "/v1/me")).statusCode, 401, "restoring did not bring it back");
    const [newLink] = (await live(user, rome)).rows;
    const bound = await pool.query("SELECT revoked_at FROM control_plane.web_sessions WHERE telegram_link_id = $1", [link]);
    assert.ok(bound.rowCount! >= 1 && bound.rows.every((r) => r.revoked_at !== null), "every session of the old link is still revoked");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.web_sessions WHERE telegram_link_id = $1", [newLink.id])).rowCount, 0, "the new link has no session");

    const fresh = await telegramSession(app, telegramId, rome);
    assert.equal((await call(app, fresh, "GET", "/v1/me")).statusCode, 200, "a fresh sign-in works");
    assert.notEqual(fresh.raw, oldPhone.raw);
  } finally { await app.close(); }
});

test("a restored link announces its first sign-in again, once (a restore counts as new)", { skip }, async () => {
  const app = newApp();
  try {
    const { rome, telegramId, link, full } = await fixture(app);
    const notices = () => pool.query(
      "SELECT recipient FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice' AND recipient = $1", [String(telegramId)]);
    await telegramSession(app, telegramId, rome);
    await telegramSession(app, telegramId, rome);
    assert.equal((await notices()).rowCount, 1, "the original link: first sign-in only");
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.equal((await restore(app, full, link)).statusCode, 200);
    assert.equal((await notices()).rowCount, 1, "restoring itself sends nothing");
    await telegramSession(app, telegramId, rome);
    assert.equal((await notices()).rowCount, 2, "the restored link's first sign-in is news");
    await telegramSession(app, telegramId, rome);
    assert.equal((await notices()).rowCount, 2, "its second is not");
  } finally { await app.close(); }
});

test("only the newest Unlink of an account is offered, and not once a lk_ relink has already brought the account back", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.equal((await restore(app, full, link)).statusCode, 200);
    const [second] = (await live(user, rome)).rows;
    assert.equal((await unlink(app, full, second.id)).statusCode, 200);
    // Two revoked rows for the pair now; the older one was restored, the newer one is the offer.
    const offered = (await tripCard(app, full, rome)).telegram.unlinked.map((u: { id: string }) => u.id);
    assert.deepEqual(offered, [second.id]);
    assert.equal((await restore(app, full, link)).statusCode, 404, "the older, already-restored row is not a way back");

    // A relink through the dashboard's lk_ path wins: the offer disappears and a restore is refused.
    const { redeemTelegramLinkToken, issueTelegramLinkToken } = await import("../src/telegram-link-token.js");
    const token = await issueTelegramLinkToken(pool, { userId: user, tripId: rome });
    assert.ok(token.ok);
    assert.equal((await redeemTelegramLinkToken(pool, token.ok ? token.token : "", String(telegramId))).ok, true);
    assert.deepEqual((await tripCard(app, full, rome)).telegram.unlinked, []);
    assert.equal((await restore(app, full, second.id)).statusCode, 404);
    assert.equal((await live(user, rome)).rowCount, 1, "still exactly one live link");
  } finally { await app.close(); }
});

// ── The bot comes back with the restore (owner round-2 complaint) ───────────

const dmUpdate = (telegramId: number, text: string, from: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { message_id: 5, from: { id: telegramId, first_name: "Olive", ...from }, chat: { id: telegramId, type: "private" }, text },
}) as unknown as TelegramUpdate;
const dm = (telegramId: number, text: string, from: Record<string, unknown> = {}) => dispatchUpdate(pool, dmUpdate(telegramId, text, from), DEFAULT_STRINGS);
const textOf = (decision: Awaited<ReturnType<typeof dispatchUpdate>>) => decision.kind === "reply" ? decision.reply.text : `<${decision.kind}>`;
async function bindDm(tripId: string, telegramId: number, profile = "kin-rome") {
  await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1,$2,$3,$4)", [id("tcb"), String(telegramId), tripId, profile]);
}
const bindings = async (chatId: number) => (await pool.query<{ trip_id: string; closed_reason: string | null; open: boolean; hermes_profile: string | null }>(
  "SELECT trip_id, closed_reason, closed_at IS NULL AS open, hermes_profile FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 ORDER BY created_at, id", [String(chatId)])).rows;

test("RESTORE REOPENS THE DM: the route is 'companion' again as a NEW binding (the closed one stays history), /trips marks the chat current, and a plain DM reaches the gateway", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    await bindDm(rome, telegramId);
    assert.equal((await resolveChatRoute(pool, String(telegramId))).kind, "companion");
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.equal((await resolveChatRoute(pool, String(telegramId))).kind, "unbound");
    assert.deepEqual((await bindings(telegramId)).map((b) => [b.closed_reason, b.open]), [["telegram_unlinked", false]]);

    const restored = await restore(app, full, link);
    assert.equal(restored.statusCode, 200);
    const route = await resolveChatRoute(pool, String(telegramId));
    assert.equal(route.kind, "companion");
    assert.equal(route.kind === "companion" && route.tripId, rome);
    assert.equal(route.kind === "companion" && route.hermesProfile, "kin-rome");
    assert.deepEqual((await bindings(telegramId)).map((b) => [b.closed_reason, b.open]), [["telegram_unlinked", false], [null, true]], "history kept closed, one new open row");
    assert.match(textOf(await dm(telegramId, "/trips")), /← this chat/);
    assert.equal((await dm(telegramId, "what is the plan tomorrow?")).kind, "to_gateway");
    assert.equal((await live(user, rome)).rowCount, 1);
  } finally { await app.close(); }
});

test("a restore does not reopen a chat that has a live interview, or one already routed to another trip", { skip }, async () => {
  const app = newApp();
  try {
    // A live interview on the chat.
    const a = await fixture(app);
    await bindDm(a.rome, a.telegramId);
    assert.equal((await unlink(app, a.full, a.link)).statusCode, 200);
    const enrollmentId = id("enr");
    await pool.query(
      `INSERT INTO control_plane.interview_enrollments(id, trip_id, user_id, token_digest, state, expires_at, consumed_at)
       VALUES ($1,$2,$3,$4,'consumed', now() + interval '1 hour', now())`,
      [enrollmentId, a.rome, a.user, `sha256:${randomBytes(32).toString("hex")}`]);
    await pool.query(
      `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id, language)
       VALUES ($1,$2,$3,$4,$5,'interviewing','{}'::jsonb,$6,'en')`,
      [id("sess"), a.rome, a.user, enrollmentId, `sha256:${randomBytes(32).toString("hex")}`, String(a.telegramId)]);
    assert.equal((await restore(app, a.full, a.link)).statusCode, 200, "the link itself still comes back");
    assert.deepEqual((await bindings(a.telegramId)).map((b) => b.open), [false], "no binding was opened under a live interview");
    assert.equal((await resolveChatRoute(pool, String(a.telegramId))).kind, "interview");

    // The chat was moved to another trip after the Unlink.
    const b = await fixture(app);
    const oslo = await mkTrip("Oslo"); await mkMember(oslo, b.user);
    await bindDm(b.rome, b.telegramId);
    assert.equal((await unlink(app, b.full, b.link)).statusCode, 200);
    await bindDm(oslo, b.telegramId, "kin-oslo");
    assert.equal((await restore(app, b.full, b.link)).statusCode, 200);
    const route = await resolveChatRoute(pool, String(b.telegramId));
    assert.equal(route.kind === "companion" && route.tripId, oslo, "the chat keeps the trip it was moved to");
    assert.equal((await bindings(b.telegramId)).filter((x) => x.open).length, 1);
  } finally { await app.close(); }
});

test("an unbound PRIVATE DM, plain text or /start, from an account with live organizer links gets the trips list; an unknown sender still gets the old reply", { skip }, async () => {
  const app = newApp();
  try {
    const { rome, telegramId } = await fixture(app);       // linked, no binding at all
    for (const text of ["hello?", "/start"]) {
      const answer = await dm(telegramId, text);
      assert.equal(answer.kind, "reply", text);
      assert.match(textOf(answer), /Here are your trips/, text);
      assert.match(textOf(answer), /Rome/, text);
      assert.ok(answer.kind === "reply" && JSON.stringify(answer.reply.replyMarkup).includes(`s:${rome}`), `${text}: a button per trip`);
    }
    const stranger = tg();
    assert.equal(textOf(await dm(stranger, "hello?")), DEFAULT_STRINGS.unbound, "an unknown sender learns what they always did");
    assert.equal(textOf(await dm(stranger, "/start")), DEFAULT_STRINGS.noPayload);
    // A bad payload keeps its own answer, even for a linked account.
    assert.equal(textOf(await dm(telegramId, "/start !!!")), DEFAULT_STRINGS.badLink);
    // Tapping the button binds the chat (re-authorised from the tapper's id), as /trips has always done.
    const tap = await dispatchUpdate(pool, { update_id: 2, callback_query: { id: "cq", from: { id: telegramId }, message: { message_id: 5, chat: { id: telegramId, type: "private" } }, data: `s:${rome}` } } as unknown as TelegramUpdate, DEFAULT_STRINGS);
    assert.equal(tap.kind, "callback_reply");
    assert.equal((await resolveChatRoute(pool, String(telegramId))).kind, "companion");
  } finally { await app.close(); }
});

// ── The display label: name + confirm (owner decision 2026-10-23) ───────────

const labelOf = async (linkId: string) => (await row(linkId)).telegram_label as string | null;

test("telegramDisplayLabel: first name and @username only, bounded, control and bidi characters stripped, junk dropped", () => {
  assert.equal(telegramDisplayLabel({ first_name: "Dana", username: "dana_k" }), "Dana @dana_k");
  assert.equal(telegramDisplayLabel({ first_name: "Dana" }), "Dana");
  assert.equal(telegramDisplayLabel({ username: "dana_k" }), "@dana_k");
  assert.equal(telegramDisplayLabel({ first_name: "‮Da\nna\u0000\t  K⁦", username: "not a handle!" }), "Da na K", "controls, bidi and line breaks gone; a non-handle dropped");
  assert.equal(telegramDisplayLabel({ first_name: "x".repeat(500), username: "u".repeat(32) }), `${"x".repeat(40)} @${"u".repeat(32)}`, "bounded");
  assert.ok(Array.from(telegramDisplayLabel({ first_name: "😀".repeat(100), username: "u".repeat(32) })!).length <= 80);
  assert.equal(telegramDisplayLabel({ first_name: "\ud800" }), null, "a lone surrogate would not survive Postgres: stripped");
  for (const junk of [null, undefined, {}, { first_name: 5, username: {} }, { first_name: " \n " }]) assert.equal(telegramDisplayLabel(junk as never), null);
});

test("the label is written only from verified Telegram data, shown to a full session, copied by Restore, and a body field is never trusted", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    assert.equal(await labelOf(link), null, "an existing row has none");
    assert.equal("label" in (await tripCard(app, full, rome)).telegram.links[0], false, "so the card carries none, and says 'Telegram account'");

    // A Mini App sign-in fills it from the SIGNED user object; extra body fields are ignored.
    const initData = signedInitData(launchFields(telegramId, Date.now(), {
      query_id: `AA${hex()}`, start_param: rome, user: JSON.stringify({ id: telegramId, first_name: "Dana", username: "dana_k" }),
    }));
    const signIn = await app.inject({
      method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json", origin: ORIGIN },
      payload: JSON.stringify({ initData, label: "EVIL", telegramLabel: "EVIL", first_name: "EVIL", username: "evil", user: { first_name: "EVIL" } }),
    });
    assert.equal(signIn.statusCode, 200);
    assert.equal(await labelOf(link), "Dana @dana_k", "from initData, not from the body");
    // Later sign-ins do not rewrite a label that is there.
    await app.inject({
      method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json", origin: ORIGIN },
      payload: JSON.stringify({ initData: signedInitData(launchFields(telegramId, Date.now(), { query_id: `AA${hex()}`, start_param: rome, user: JSON.stringify({ id: telegramId, first_name: "Changed" }) })) }),
    });
    assert.equal(await labelOf(link), "Dana @dana_k");
    assert.equal((await tripCard(app, full, rome)).telegram.links[0].label, "Dana @dana_k");

    // Unlink, then Restore with a hostile body: the new row carries the OLD row's label, nothing else.
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.equal((await tripCard(app, full, rome)).telegram.unlinked[0].label, "Dana @dana_k");
    const restored = await app.inject({
      method: "POST", url: `/v1/account/telegram-links/${link}/restore`,
      headers: { cookie: full.cookie, "x-csrf-token": full.csrf, origin: ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ label: "EVIL", telegramLabel: "EVIL" }),
    });
    assert.equal(restored.statusCode, 200);
    const [now] = (await live(user, rome)).rows;
    assert.equal(await labelOf(now.id), "Dana @dana_k");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_organizer_trip_links WHERE telegram_label ILIKE '%evil%'")).rowCount, 0, "the client's text is nowhere in the table");
  } finally { await app.close(); }
});

test("a label decides nothing: two accounts with the SAME label are two links; Restore follows the row, not the name", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, link, full } = await fixture(app);
    const twin = tg();
    const twinLink = await organizerLink(user, rome, twin);
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET telegram_label = 'Dana' WHERE id = ANY($1)", [[link, twinLink]]);
    assert.equal((await unlink(app, full, link)).statusCode, 200);
    assert.equal((await restore(app, full, link)).statusCode, 200);
    const digests = (await live(user, rome)).rows.map((r) => r.telegram_subject_digest);
    assert.equal(new Set(digests).size, 2, "both accounts live; the restore did not merge or pick by name");
  } finally { await app.close(); }
});

test("a scoped session sees its OWN account's label and no other's, and never the Unlinked list", { skip }, async () => {
  const app = newApp();
  try {
    const { user, rome, telegramId, link, full } = await fixture(app);
    const other = tg();
    const otherLink = await organizerLink(user, rome, other);
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET telegram_label = CASE WHEN id = $1 THEN 'Mine @me' ELSE 'Other @other' END WHERE id = ANY($2)", [link, [link, otherLink]]);
    const scoped = await telegramSession(app, telegramId, rome);
    const scopedCard = (await tripCard(app, scoped, rome)).telegram;
    const byId = Object.fromEntries(scopedCard.links.map((l: { id: string; label?: string }) => [l.id, l.label]));
    assert.equal(byId[link], "Mine @me");
    assert.equal(byId[otherLink], undefined, "the owner's other phone's name is not for this session");
    assert.equal("unlinked" in scopedCard, false);
    const fullCard = (await tripCard(app, full, rome)).telegram;
    assert.deepEqual(Object.fromEntries(fullCard.links.map((l: { id: string; label?: string }) => [l.id, l.label])), { [link]: "Mine @me", [otherLink]: "Other @other" });
  } finally { await app.close(); }
});

test("the label is stored at an interview redemption and at a lk_ redemption, from the update's own sender", { skip }, async () => {
  const app = newApp();
  try {
    // lk_: the bot's /start from a verified sender.
    const { user, rome } = await fixture(app);
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: rome });
    assert.ok(issued.ok);
    const newcomer = tg();
    const reply = await dm(newcomer, `/start ${issued.ok ? issued.token : ""}`, { first_name: "Maya", username: "maya_m", last_name: "Surname" });
    assert.equal(reply.kind, "reply");
    const created = (await pool.query("SELECT telegram_label, verified_via FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1", [digestTelegramId(String(newcomer))])).rows;
    assert.deepEqual(created, [{ telegram_label: "Maya @maya_m", verified_via: "dashboard_link_token" }], "first name and @username; the surname is not kept");

    // Interview: an enrollment redeemed from the organizer's chat.
    const owner = await mkUser("Ivy");
    const draft = id("trip");
    await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,'draft','Draft')", [draft, `rs-${draft.replace(/_/g, "-").toLowerCase()}`]);
    await mkMember(draft, owner);
    const enrollment = await issueEnrollment(pool, owner, draft, { enrollmentTtlSeconds: 900 });
    assert.ok(enrollment.ok);
    const ivy = tg();
    const started = await dm(ivy, `/start ${enrollment.ok ? enrollment.token : ""}`, { first_name: "Ivy", username: "ivy_i" });
    assert.notEqual(textOf(started), DEFAULT_STRINGS.badLink);
    const interviewLink = (await pool.query("SELECT telegram_label, verified_via FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1", [digestTelegramId(String(ivy))])).rows;
    assert.deepEqual(interviewLink, [{ telegram_label: "Ivy @ivy_i", verified_via: "enrollment_redemption" }]);
  } finally { await app.close(); }
});
