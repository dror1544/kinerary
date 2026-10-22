/**
 * The dashboard's one-time Telegram link (#442 round 4): how an organizer
 * (re)links a Telegram account to ONE trip after an Unlink.
 *
 * Every assertion is a way a link could have been made without BOTH halves
 * proven (the signed-in account that issues it, the Telegram identity that
 * redeems it), or kept alive past its fuse, or told apart by a guesser.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { DEFAULT_STRINGS, dispatchUpdate } from "../src/relay/dispatch.js";
import { digestTelegramId } from "../src/identity.js";
import { uiString } from "../src/intake-copy.js";
import { applyMigrations } from "../src/migrations.js";
import { listOrganizerTrips, linkTelegramOrganizerInTx } from "../src/organizer-trips.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import {
  LINK_TOKEN_PATTERN, TELEGRAM_LINK_TOKEN_TTL_SECONDS, issueTelegramLinkToken, redeemTelegramLinkToken,
  telegramLinkTokenFromStartPayload,
} from "../src/telegram-link-token.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const hex = () => randomBytes(8).toString("hex");
let nextTg = 6_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
const tg = () => ++nextTg;
const id = (prefix: string) => `${prefix}_${suffix}${hex()}`;

let pool: pg.Pool;
const logs: string[] = [];
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});
function newApp(overrides: Partial<PortalDependencies> = {}) {
  return buildApp(profile, {
    portal: {
      db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
      publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
      runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
      enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
      telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true, log: (line) => logs.push(line) },
      ...overrides,
    },
  });
}
type App = ReturnType<typeof newApp>;

async function mkUser(name: string): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active',$2)", [userId, name]);
  return userId;
}
async function mkTrip(title: string, slug?: string): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,'ready_private',$3)", [tripId, slug ?? `lk-${tripId.replace(/_/g, "-").toLowerCase()}`, title]);
  return tripId;
}
async function mkMember(tripId: string, userId: string, role = "owner", opts: { dashboard?: boolean; status?: string } = {}) {
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,$4,$5,$6,true)",
    [id("memb"), tripId, userId, role, opts.status ?? "active", opts.dashboard ?? role !== "member"]);
}
async function webSession(userId: string, label: string) {
  const raw = `sess-${label}-${suffix}${hex()}`, csrf = `csrf-${label}-${suffix}${hex()}`;
  await pool.query(
    "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
    [id("wsess"), userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
}
const issue = (app: App, tripId: string, s: { cookie: string; csrf: string }, csrf: string | null = s.csrf) => app.inject({
  method: "POST", url: `/v1/trips/${tripId}/telegram-link`, headers: { cookie: s.cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) },
});
const tokenOf = (deepLink: string) => new URL(deepLink).searchParams.get("start")!;

function startMessage(chatId: string | number, payload: string, opts: { chatType?: string; fromId?: string | number } = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7, from: { id: opts.fromId ?? chatId, first_name: "Person" },
      chat: { id: chatId, type: opts.chatType ?? "private" }, text: `/start ${payload}`,
    },
  } as unknown as TelegramUpdate;
}
const dispatch = (update: TelegramUpdate) => dispatchUpdate(pool, update, DEFAULT_STRINGS);
const replyOf = (decision: Awaited<ReturnType<typeof dispatchUpdate>>) => {
  assert.equal(decision.kind, "reply");
  return decision.kind === "reply" ? decision.reply.text : "";
};
const liveLinks = (userId: string, tripId: string) => pool.query(
  "SELECT id, verified_via, telegram_subject_digest FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1 AND trip_id = $2 AND revoked_at IS NULL", [userId, tripId]);

before(async () => {
  if (skip) return;
  pool = testPool({ max: 8 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

// ── Issuing: the signed-in account half ─────────────────────────────────────

test("a signed-in organizer gets a one-time t.me link for their trip; only the digest is stored", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive"); const trip = await mkTrip("Rome");
    await mkMember(trip, user);
    const session = await webSession(user, "issue");
    const response = await issue(app, trip, session);
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers["cache-control"], "private, no-store");
    const { deepLink, expiresAt } = response.json();
    assert.match(deepLink, /^https:\/\/t\.me\/kinerary_bot\?start=lk_[A-Za-z0-9_-]{32}$/);
    const ttl = (Date.parse(expiresAt) - Date.now()) / 1000;
    assert.ok(ttl > TELEGRAM_LINK_TOKEN_TTL_SECONDS - 10 && ttl <= TELEGRAM_LINK_TOKEN_TTL_SECONDS, `short fuse: ${ttl}s`);
    assert.equal(TELEGRAM_LINK_TOKEN_TTL_SECONDS, 900);
    const token = tokenOf(deepLink);
    assert.ok(LINK_TOKEN_PATTERN.test(token));
    assert.equal(token.length, 35, "never confusable with a 43-character enrollment token");
    const stored = await pool.query("SELECT token_digest, state, user_id, trip_id FROM control_plane.telegram_link_tokens WHERE trip_id = $1", [trip]);
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].token_digest, `sha256:${createHash("sha256").update(token).digest("hex")}`);
    assert.deepEqual([stored.rows[0].state, stored.rows[0].user_id], ["issued", user]);
    assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(token), "the raw token is not stored");
  } finally { await app.close(); }
});

test("issuing needs the session AND the CSRF token, and is refused identically for everyone who does not run the trip", { skip }, async () => {
  const app = newApp();
  try {
    const owner = await mkUser("Owner"); const trip = await mkTrip("Mine");
    await mkMember(trip, owner);
    const session = await webSession(owner, "csrf");
    assert.equal((await issue(app, trip, session, null)).statusCode, 403);
    assert.equal((await issue(app, trip, session, "wrong")).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/v1/trips/${trip}/telegram-link` })).statusCode, 401);

    const outsider = await webSession(await mkUser("Outsider"), "out");
    const member = await mkUser("Plain member"); await mkMember(trip, member, "member");
    const memberSession = await webSession(member, "mem");
    const noDashboard = await mkUser("No dashboard"); await mkMember(trip, noDashboard, "organizer", { dashboard: false });
    const noDashSession = await webSession(noDashboard, "nodash");
    const removed = await mkUser("Removed"); await mkMember(trip, removed, "owner", { status: "revoked" });
    const removedSession = await webSession(removed, "rem");
    const retired = await mkTrip("Retired", `retired-lk-${suffix}${hex()}`); await mkMember(retired, owner);
    const bodies = new Set<string>();
    for (const [label, response] of Object.entries({
      outsider: await issue(app, trip, outsider), member: await issue(app, trip, memberSession),
      noDashboard: await issue(app, trip, noDashSession), removed: await issue(app, trip, removedSession),
      retired: await issue(app, retired, session), nonexistent: await issue(app, "trip_doesnotexist0000", session),
    })) {
      assert.equal(response.statusCode, 404, label);
      bodies.add(response.body);
    }
    assert.equal(bodies.size, 1, "every refusal is the same bytes");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_link_tokens WHERE trip_id = ANY($1)", [[trip, retired]])).rowCount, 0);
  } finally { await app.close(); }
});

test("an organizer-role member with dashboard access may issue; issuing again revokes the previous link", { skip }, async () => {
  const app = newApp();
  try {
    const owner = await mkUser("Owner"); const trip = await mkTrip("Shared");
    await mkMember(trip, owner);
    const organizer = await mkUser("Co-organizer"); await mkMember(trip, organizer, "organizer");
    const session = await webSession(organizer, "co");
    const first = tokenOf((await issue(app, trip, session)).json().deepLink);
    const second = tokenOf((await issue(app, trip, session)).json().deepLink);
    assert.notEqual(first, second);
    const states = await pool.query("SELECT state FROM control_plane.telegram_link_tokens WHERE user_id = $1 ORDER BY created_at", [organizer]);
    assert.deepEqual(states.rows.map((r) => r.state), ["revoked", "issued"]);
    const stale = await redeemTelegramLinkToken(pool, first, String(tg()));
    assert.deepEqual(stale, { ok: false, reason: "INVALID" }, "the replaced link is dead");
    assert.equal((await redeemTelegramLinkToken(pool, second, String(tg()))).ok, true);
    assert.equal((await liveLinks(organizer, trip)).rowCount, 1);
    assert.equal((await liveLinks(owner, trip)).rowCount, 0, "bound to the ISSUER, not to the trip's owner");
  } finally { await app.close(); }
});

test("issuing is rate limited per person", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Eager"); const trip = await mkTrip("Eager trip");
    await mkMember(trip, user);
    const session = await webSession(user, "eager");
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await issue(app, trip, session)).statusCode;
    assert.equal(last, 429);
  } finally { await app.close(); }
});

// ── Redeeming: the Telegram-identity half ───────────────────────────────────

test("opening the link in the bot's private chat links THAT Telegram account to the issuer for that trip only, once", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive"); const rome = await mkTrip("Rome 2027"); const oslo = await mkTrip("Oslo 2027");
    await mkMember(rome, user); await mkMember(oslo, user);
    const session = await webSession(user, "redeem");
    const token = tokenOf((await issue(app, rome, session)).json().deepLink);
    const telegramId = tg();

    const reply = replyOf(await dispatch(startMessage(telegramId, token)));
    assert.match(reply, /linked to "Rome 2027"/);
    assert.match(reply, /\/trips/);
    const links = await liveLinks(user, rome);
    assert.equal(links.rowCount, 1);
    assert.equal(links.rows[0].verified_via, "dashboard_link_token");
    assert.equal(links.rows[0].telegram_subject_digest, digestTelegramId(String(telegramId)));
    assert.equal((await liveLinks(user, oslo)).rowCount, 0, "one trip, not the account");
    assert.deepEqual((await listOrganizerTrips(pool, String(telegramId), String(telegramId))).map((t) => t.tripId), [rome]);

    // Single use: the same link, again, from anyone.
    const again = replyOf(await dispatch(startMessage(tg(), token)));
    assert.equal(again, uiString("telegramLinkRefused", "en"));
    assert.equal((await liveLinks(user, rome)).rowCount, 1, "nothing else was written");
    const row = await pool.query("SELECT state, consumed_link_id FROM control_plane.telegram_link_tokens WHERE user_id = $1", [user]);
    assert.deepEqual([row.rows[0].state, row.rows[0].consumed_link_id], ["consumed", links.rows[0].id]);
  } finally { await app.close(); }
});

test("every refusal is the same sentence: expired, used, unknown, malformed, and an issuer who no longer runs the trip", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive"); const trip = await mkTrip("Refusals");
    await mkMember(trip, user);
    const session = await webSession(user, "refuse");
    const refused = uiString("telegramLinkRefused", "en");
    const expectRefused = async (payload: string, label: string, fromId: number = tg()) =>
      assert.equal(replyOf(await dispatch(startMessage(fromId, payload))), refused, label);

    const expired = tokenOf((await issue(app, trip, session)).json().deepLink);
    await pool.query("UPDATE control_plane.telegram_link_tokens SET expires_at = now() - interval '1 second' WHERE token_digest = $1", [sha256(expired)]);
    // (sha256() in portal.ts builds the same `sha256:<hex>` the token table stores.)
    await expectRefused(expired, "expired");
    await expectRefused(`lk_${randomBytes(24).toString("base64url")}`, "unknown");

    const gone = tokenOf((await issue(app, trip, session)).json().deepLink);
    await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [trip, user]);
    await expectRefused(gone, "issuer removed from the trip after issuing");
    assert.equal((await liveLinks(user, trip)).rowCount, 0);
    // `lk_` plus the wrong length is not a link token at all: it falls through to the enrollment path's own refusal.
    assert.equal(telegramLinkTokenFromStartPayload(`lk_${"a".repeat(40)}`), null);
    assert.equal(telegramLinkTokenFromStartPayload(null), null);
    assert.equal(telegramLinkTokenFromStartPayload(`lk_${"a".repeat(32)}`), `lk_${"a".repeat(32)}`);
  } finally { await app.close(); }
});

test("a link opened in a group is not consumed; the Telegram account is the update's own sender", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive"); const trip = await mkTrip("Group trip");
    await mkMember(trip, user);
    const token = tokenOf((await issue(app, trip, await webSession(user, "grp"))).json().deepLink);
    const group = -(1_000_000_000_000 + Math.floor(Math.random() * 1e9));
    const text = replyOf(await dispatch(startMessage(group, token, { chatType: "supergroup", fromId: tg() })));
    assert.equal(text, DEFAULT_STRINGS.notPrivate);
    assert.equal((await liveLinks(user, trip)).rowCount, 0);
    assert.equal((await pool.query("SELECT state FROM control_plane.telegram_link_tokens WHERE user_id = $1", [user])).rows[0].state, "issued", "still usable in the DM");
    // In the DM it works, and what is linked is the SENDER's id, not anything in the text.
    const sender = tg();
    assert.match(replyOf(await dispatch(startMessage(sender, token))), /linked to "Group trip"/);
    assert.equal((await liveLinks(user, trip)).rows[0].telegram_subject_digest, digestTelegramId(String(sender)));
  } finally { await app.close(); }
});

test("the reply is in the person's language", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive"); const trip = await mkTrip("Tel Aviv");
    await mkMember(trip, user);
    const token = tokenOf((await issue(app, trip, await webSession(user, "he"))).json().deepLink);
    const update = startMessage(tg(), token);
    (update.message as unknown as { from: Record<string, unknown> }).from.language_code = "he";
    const reply = replyOf(await dispatch(update));
    assert.equal(reply, uiString("telegramLinked", "he").replace("{trip}", "Tel Aviv"));
    assert.match(reply, /Tel Aviv/);
  } finally { await app.close(); }
});

test("a title with replacement patterns in it is shown as written", { skip }, async () => {
  const user = await mkUser("Olive"); const trip = await mkTrip("Trip $& and $1");
  await mkMember(trip, user);
  const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: trip });
  assert.ok(issued.ok);
  const update = startMessage(tg(), issued.ok ? issued.token : "");
  assert.match(replyOf(await dispatch(update)), /"Trip \$& and \$1"/);
});

// ── The path back, end to end ───────────────────────────────────────────────

test("after an Unlink the dashboard link is the ONLY way back: a forwarded interview link cannot undo it", { skip }, async () => {
  const app = newApp();
  try {
    const user = await mkUser("Olive"); const rome = await mkTrip("Rome"); const oslo = await mkTrip("Oslo");
    await mkMember(rome, user); await mkMember(oslo, user);
    const telegramId = tg();
    for (const trip of [rome, oslo]) {
      const client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, String(telegramId), user, trip); } finally { client.release(); }
    }
    const session = await webSession(user, "back");
    const romeLink = (await liveLinks(user, rome)).rows[0].id;
    const unlinked = await app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${romeLink}`, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });
    assert.equal(unlinked.statusCode, 200);
    assert.deepEqual((await listOrganizerTrips(pool, String(telegramId), String(telegramId))).map((t) => t.tripId), [oslo], "Oslo is still linked");

    // A forwarded interview link for Rome redeems from that Telegram account: nothing comes back.
    const client = await pool.connect();
    try { await linkTelegramOrganizerInTx(client, String(telegramId), user, rome); } finally { client.release(); }
    assert.equal((await liveLinks(user, rome)).rowCount, 0);
    const initData = (extra: Record<string, string> = {}) => signedInitData(launchFields(telegramId, Date.now(), { query_id: `AA${hex()}`, ...extra }));
    const exchange = (data: string, tripId?: string) => app.inject({
      method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json", origin: ORIGIN },
      payload: JSON.stringify({ initData: data, ...(tripId ? { tripId } : {}) }),
    });
    assert.equal((await exchange(initData({ start_param: rome }))).json().notice, "TRIP_UNAVAILABLE");

    // The signed-in dashboard issues a link; the Telegram account redeems it.
    const token = tokenOf((await issue(app, rome, session)).json().deepLink);
    assert.match(replyOf(await dispatch(startMessage(telegramId, token))), /linked to "Rome"/);
    assert.deepEqual((await listOrganizerTrips(pool, String(telegramId), String(telegramId))).map((t) => t.tripId).sort(), [rome, oslo].sort());
    const back = await exchange(initData({ start_param: rome }));
    assert.deepEqual(back.json(), { kind: "session", appPath: `/mini-app/trips/${rome}` });
    // The new link is a NEW row: the revoked one stays as history, and the card shows only the live one.
    const rows = await pool.query("SELECT revoked_at FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1 AND trip_id = $2 ORDER BY created_at", [user, rome]);
    assert.equal(rows.rowCount, 2);
    assert.ok(rows.rows[0].revoked_at && rows.rows[1].revoked_at === null);
    // Each link announces ITS first Mini App sign-in to the account's private chats, the signer's
    // included: Oslo's (the TRIP_UNAVAILABLE launch above signed in through it) and the new Rome link's.
    const notices = await pool.query("SELECT payload FROM control_plane.notification_outbox WHERE notification_type = 'mini_app_sign_in_notice' AND recipient = $1", [String(telegramId)]);
    assert.deepEqual(notices.rows.map((r) => r.payload.trip_title).sort(), ["Oslo", "Rome"]);
  } finally { await app.close(); }
});

test("redeeming the same token from two Telegram accounts at once links exactly one", { skip }, async () => {
  const user = await mkUser("Race"); const trip = await mkTrip("Race trip");
  await mkMember(trip, user);
  const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: trip });
  assert.ok(issued.ok);
  const token = issued.ok ? issued.token : "";
  const results = await Promise.all([redeemTelegramLinkToken(pool, token, String(tg())), redeemTelegramLinkToken(pool, token, String(tg()))]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await liveLinks(user, trip)).rowCount, 1);
});

test("a group or malformed Telegram id is refused without touching the token", { skip }, async () => {
  const user = await mkUser("Strict"); const trip = await mkTrip("Strict trip");
  await mkMember(trip, user);
  const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: trip });
  assert.ok(issued.ok);
  const token = issued.ok ? issued.token : "";
  for (const bad of ["-100123456789", "abc", "", "12 34"]) assert.deepEqual(await redeemTelegramLinkToken(pool, token, bad), { ok: false, reason: "INVALID" });
  assert.equal((await pool.query("SELECT state FROM control_plane.telegram_link_tokens WHERE user_id = $1", [user])).rows[0].state, "issued");
});
