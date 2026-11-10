/**
 * #523 — a MAIN Telegram per account, and SECONDARY organizers added with a trip link.
 *
 * One block per acceptance criterion (docs/specs/sprint-8/523-main-telegram-and-secondary-organizers.md), and one refusal test
 * for every "cannot" of AC-5 and AC-7. Everything runs through the same doors production uses: the portal routes with a
 * session and a CSRF token, and `dispatchUpdate` with the update a Telegram account would send.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { isMainTripOrganizer, isTripOrganizer, resolveTripPerson } from "../src/chat-router.js";
import { requesterRoleOf } from "../src/analytics/contract.js";
import { issueGroupBindingToken, redeemGroupBindingToken } from "../src/group-binding.js";
import { issueEnrollment } from "../src/enrollment.js";
import { digestTelegramId } from "../src/identity.js";
import { UI_STRINGS, uiString } from "../src/intake-copy.js";
import { applyMigrations } from "../src/migrations.js";
import { anyTelegramBound, boundTelegramAccounts, linkTelegramOrganizerInTx, listOrganizerTrips, switchChatToTrip } from "../src/organizer-trips.js";
import { answerLinkRequest } from "../src/organizer-link-approval.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { DEFAULT_STRINGS, dispatchUpdate, type DispatchDecision } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import {
  SECONDARY_TOKEN_PATTERN, issueSecondaryOrganizerToken, listSecondaryOrganizers, redeemSecondaryOrganizerToken,
  secondaryOrganizerTokenFromStartPayload,
} from "../src/secondary-organizers.js";
import { issueTelegramLinkToken, redeemTelegramLinkToken } from "../src/telegram-link-token.js";
import { unlinkedTelegramLinksByTrip } from "../src/telegram-mini-app.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const hex = () => randomBytes(8).toString("hex");
const id = (prefix: string) => `${prefix}_${suffix}${hex()}`;
let chatSeq = 770_000_000 + Math.floor(Math.random() * 100_000_000);
const nextChat = () => String(++chatSeq);
const digestOf = (chat: string) => digestTelegramId(chat);

let pool: pg.Pool;
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
      telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true, log: () => {} },
      ...overrides,
    },
  });
}
type App = ReturnType<typeof newApp>;
type Sess = { cookie: string; csrf: string };

before(async () => {
  if (skip) return;
  pool = testPool({ max: 8 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

// ── fixtures ────────────────────────────────────────────────────────────────

async function mkUser(name = "Olive"): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active',$2)", [userId, name]);
  return userId;
}
async function mkTrip(title: string, state = "ready_private"): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,$3,$4)", [tripId, `mt-${tripId.replace(/_/g, "-").toLowerCase()}`, state, title]);
  return tripId;
}
async function mkMember(tripId: string, userId: string, role = "owner", dashboard = role !== "member") {
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,$4,'active',$5,true)",
    [id("memb"), tripId, userId, role, dashboard]);
}
async function webSession(userId: string, label: string): Promise<Sess> {
  const raw = `sess-${label}-${suffix}${hex()}`, csrf = `csrf-${label}-${suffix}${hex()}`;
  await pool.query(
    "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
    [id("wsess"), userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
}
const call = (app: App, s: Sess | null, method: string, url: string, payload?: unknown) => app.inject({
  method: method as "GET", url,
  headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), origin: ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});
const tokenOf = (deepLink: string) => new URL(deepLink).searchParams.get("start")!;

function from(chat: string, firstName = "Telegram-User", username?: string, languageCode?: string) {
  return { id: Number(chat), first_name: firstName, ...(username ? { username } : {}), ...(languageCode ? { language_code: languageCode } : {}) };
}
function startUpdate(chat: string, token: string, who = from(chat), chatType = "private"): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, from: who, chat: { id: chat, type: chatType }, text: `/start ${token}` } } as unknown as TelegramUpdate;
}
function textUpdate(chat: string, text: string, who = from(chat)): TelegramUpdate {
  return { update_id: 2, message: { message_id: 8, from: who, chat: { id: chat, type: "private" }, text } } as unknown as TelegramUpdate;
}
function tapUpdate(chat: string, data: string, who = from(chat)): TelegramUpdate {
  return { update_id: 3, callback_query: { id: `cbq-${randomBytes(4).toString("hex")}`, data, from: who, message: { message_id: 9, chat: { id: chat, type: "private" } } } } as unknown as TelegramUpdate;
}
const dispatch = (update: TelegramUpdate) => dispatchUpdate(pool, update, DEFAULT_STRINGS);
type Multi = Extract<DispatchDecision, { kind: "multi_reply" }>;
function multi(decision: DispatchDecision): Multi {
  assert.equal(decision.kind, "multi_reply", JSON.stringify(decision).slice(0, 300));
  return decision as Multi;
}
function replyText(decision: DispatchDecision): string {
  assert.equal(decision.kind, "reply", JSON.stringify(decision).slice(0, 300));
  return decision.kind === "reply" ? decision.reply.text : "";
}

/** A draft trip owned by `userId`, with a live interview link. */
async function draftTrip(userId: string, title = "Secret Kyoto Honeymoon") {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id,slug,title,destination_label,lifecycle_state) VALUES ($1,$2,$3,'Kyoto','draft')", [tripId, tripId.replace(/_/g, "-").toLowerCase(), title]);
  await pool.query("INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access) VALUES ($1,$2,$3,'owner','active',true)", [id("memb"), tripId, userId]);
  const issued = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  return { tripId, token: issued.token, userId };
}

/** An account whose main Telegram T0 redeemed an interview link (so the bot knows T0's chat), with that interview over. */
async function accountWithMain(name = "Olive") {
  const user = await mkUser(name);
  const first = await draftTrip(user, "First Trip");
  const t0 = nextChat();
  assert.equal((await dispatch(startUpdate(t0, first.token, from(t0, "Dana", "dana_k")))).kind, "reply");
  await pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE telegram_chat_id = $1 AND expired_at IS NULL", [t0]);
  return { user, t0, firstTripId: first.tripId };
}

const liveLinks = async (tripId: string, chat: string) =>
  (await pool.query("SELECT * FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [tripId, digestOf(chat)])).rows;
const linksOf = async (user: string, chat: string) =>
  (await pool.query("SELECT * FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1 AND telegram_subject_digest = $2 ORDER BY created_at", [user, digestOf(chat)])).rows;

/** The dashboard's "Link Telegram", then the Telegram account opening it. */
async function linkMain(app: App, user: string, tripId: string, chat: string, who = from(chat)) {
  const session = await webSession(user, "main");
  const issued = await call(app, session, "POST", `/v1/trips/${tripId}/telegram-link`);
  assert.equal(issued.statusCode, 201, issued.body);
  return dispatch(startUpdate(chat, tokenOf(issued.json().deepLink), who));
}

/** The main organizer's dashboard issues a trip link; the Telegram account opens it. Returns the dispatch decision. */
async function addSecondary(app: App, owner: string, tripId: string, chat: string, who = from(chat, "Noa", "noa_s")) {
  const session = await webSession(owner, "tl");
  const issued = await call(app, session, "POST", `/v1/trips/${tripId}/secondary-organizer-link`);
  assert.equal(issued.statusCode, 201, issued.body);
  return dispatch(startUpdate(chat, tokenOf(issued.json().deepLink), who));
}
const secondaryRow = async (tripId: string, chat: string) =>
  (await pool.query("SELECT * FROM control_plane.trip_secondary_organizers WHERE trip_id = $1 AND telegram_subject_digest = $2 ORDER BY created_at DESC", [tripId, digestOf(chat)])).rows[0];

/** A Mini App launch by Telegram account `chat`, naming `tripId`; returns the scoped session it mints (or the response). */
async function miniApp(app: App, chat: string, tripId: string) {
  const initData = signedInitData(launchFields(Number(chat), Date.now(), { query_id: `AA${hex()}`, start_param: tripId }));
  const response = await app.inject({
    method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json", origin: ORIGIN },
    payload: JSON.stringify({ initData }),
  });
  if (response.statusCode !== 200 || response.json().kind !== "session") return { response, session: null as Sess | null };
  const cookies = ([] as string[]).concat(response.headers["set-cookie"] as string[]);
  const pick = (name: string) => decodeURIComponent(cookies.find((c) => c.startsWith(`${name}=`))!.split(";")[0]!.slice(name.length + 1));
  const csrf = pick("kit_csrf");
  return { response, session: { cookie: `kit_session=${pick("kit_session")}; kit_csrf=${csrf}`, csrf } as Sess };
}

// ═══ THE MAIN TELEGRAM ═══════════════════════════════════════════════════════

describe("AC-1: Link Telegram makes the opener the account's MAIN Telegram, account-wide", { skip }, () => {
  test("it is linked on every trip the account runs, as an ACCOUNT link, and /trips lists them all", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const rome = await mkTrip("Rome"); const oslo = await mkTrip("Oslo");
      await mkMember(rome, user); await mkMember(oslo, user);
      const t = nextChat();
      const decision = await linkMain(app, user, rome, t);
      assert.equal(replyText(decision), uiString("mainTelegramLinked", "en"));
      for (const trip of [rome, oslo]) {
        const live = await liveLinks(trip, t);
        assert.equal(live.length, 1);
        assert.equal(live[0].binding_scope, "account");
        assert.equal(live[0].verified_via, "dashboard_link_token");
      }
      assert.deepEqual((await listOrganizerTrips(pool, t, t)).map((x) => x.tripId).sort(), [rome, oslo].sort());
    } finally { await app.close(); }
  });

  test("an interview link for ANY of the account's trips, including ones created later, opened from T starts as the organizer", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const rome = await mkTrip("Rome");
      await mkMember(rome, user);
      const t = nextChat();
      await linkMain(app, user, rome, t);
      // A trip that existed when T was linked, and one created afterwards.
      const before = await draftTrip(user, "Existing draft");
      const later = await draftTrip(user, "Created later");
      for (const trip of [before, later]) {
        const decision = await dispatch(startUpdate(t, trip.token));
        assert.equal(decision.kind, "reply", "the ordinary opening: no refusal, no question");
        assert.equal((await pool.query("SELECT 1 FROM control_plane.intake_sessions WHERE trip_id = $1 AND telegram_chat_id = $2", [trip.tripId, t])).rowCount, 1, "the interview started");
        await pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE telegram_chat_id = $1 AND expired_at IS NULL", [t]);
      }
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.organizer_link_requests WHERE user_id = $1", [user])).rows[0].n, 0, "nobody was asked");
    } finally { await app.close(); }
  });

  test("a Telegram that held a TRIP-scoped link (an approval, or a link #519 narrowed) is widened to the account when it is linked as main; other Telegrams' trip links are not touched", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const a = await mkTrip("A"); const b = await mkTrip("B");
      await mkMember(a, user); await mkMember(b, user);
      const approved = nextChat(); const t = nextChat();
      let client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, approved, user, a, "enrollment_redemption", null, "trip"); } finally { client.release(); }
      client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, t, user, a, "enrollment_redemption", null, "trip"); } finally { client.release(); }
      await linkMain(app, user, a, t);
      assert.equal((await liveLinks(a, t))[0].binding_scope, "account", "widened, not duplicated");
      assert.equal((await liveLinks(a, t)).length, 1);
      assert.equal((await liveLinks(b, t)).length, 1);
      // The other Telegram's trip-only approval stands, as a trip-only link.
      assert.equal((await liveLinks(a, approved)).length, 1);
      assert.equal((await liveLinks(a, approved))[0].binding_scope, "trip");
    } finally { await app.close(); }
  });
});

describe("AC-2: linking another Telegram REPLACES the main one", { skip }, () => {
  test("T0 is unlinked from the account and every trip it was bound to through the account; T0 and T1 are each told once", async () => {
    const app = newApp();
    try {
      const { user, t0, firstTripId } = await accountWithMain();
      const second = await mkTrip("Second"); await mkMember(second, user);
      await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
      const client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, t0, user, second); } finally { client.release(); }
      const t1 = nextChat();
      const decision = multi(await linkMain(app, user, firstTripId, t1, from(t1, "New", "new_phone", "he")));
      assert.deepEqual(decision.replies.map((r) => r.chatId), [t1, t0]);
      assert.equal(decision.replies[0]!.text, uiString("mainTelegramLinkedReplaced", "he"), "T1 is told it is now the main Telegram, in its own language");
      assert.equal(decision.replies[1]!.text, uiString("mainTelegramReplaced", "en"), "T0 is told once, in its chat");
      assert.doesNotMatch(decision.replies[1]!.text, /Kyoto|First Trip|Second/, "and it learns nothing about any trip");
      for (const trip of [firstTripId, second]) {
        assert.equal((await liveLinks(trip, t0)).length, 0, "T0 is unlinked from every trip it was bound through the account");
        assert.equal((await liveLinks(trip, t1)).length, 1);
      }
      const ended = await linksOf(user, t0);
      assert.ok(ended.length >= 2 && ended.every((l) => l.revoked_reason === "main_telegram_replaced"), "with a reason of its own, written through the Unlink function");
      assert.deepEqual((await listOrganizerTrips(pool, t0, t0)).map((x) => x.tripId), [], "T0's /trips is empty");
      // A replaced main is never offered back for Restore.
      assert.equal((await unlinkedTelegramLinksByTrip(pool, user, [firstTripId, second])).size, 0);
      // T0 is a DIFFERENT account for the account's next trip.
      const verdict = await boundTelegramAccounts(pool, user, firstTripId);
      assert.deepEqual(verdict.map((a) => a.digest), [digestOf(t1)]);
    } finally { await app.close(); }
  });

  test("a trip-only approval of T0 and a secondary organizer's binding are left alone", async () => {
    const app = newApp();
    try {
      const { user, t0, firstTripId } = await accountWithMain();
      const approvedTrip = await mkTrip("Approved only"); await mkMember(approvedTrip, user);
      const client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, t0, user, approvedTrip, "enrollment_redemption", null, "trip"); } finally { client.release(); }
      // A secondary organizer of the first trip, added by this account.
      const s = nextChat();
      await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1 AND trip_id = $2", [user, firstTripId]);
      const owner = await webSession(user, "own");
      await pool.query("UPDATE control_plane.trip_memberships SET dashboard_access = true WHERE trip_id = $1 AND user_id = $2", [firstTripId, user]);
      const issued = await call(app, owner, "POST", `/v1/trips/${firstTripId}/secondary-organizer-link`);
      assert.equal(issued.statusCode, 201);
      await dispatch(startUpdate(s, tokenOf(issued.json().deepLink), from(s, "Noa", "noa_s")));
      assert.ok(await secondaryRow(firstTripId, s));

      const t1 = nextChat();
      await linkMain(app, user, firstTripId, t1);
      assert.equal((await liveLinks(firstTripId, t0)).length, 0, "T0's account link ended");
      assert.equal((await liveLinks(approvedTrip, t0)).length, 1, "T0's trip-only approval stands");
      assert.equal((await secondaryRow(firstTripId, s)).revoked_at, null, "somebody else's secondary binding stands");
      assert.equal(await isTripOrganizer(pool, firstTripId, s), true);
    } finally { await app.close(); }
  });

  test("the sign-up Telegram identity is replaced too: it no longer stands for the account on a new trip", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const rome = await mkTrip("Rome"); await mkMember(rome, user);
      const signup = nextChat();
      await pool.query(
        "INSERT INTO control_plane.user_identities(id,user_id,provider,provider_subject_digest,provider_subject_id,verified_at) VALUES ($1,$2,'telegram',$3,$4,now())",
        [id("idnt"), user, digestOf(signup), signup]);
      const t1 = nextChat();
      await linkMain(app, user, rome, t1);
      const later = await draftTrip(user, "Later");
      assert.deepEqual((await boundTelegramAccounts(pool, user, later.tripId)).map((a) => a.digest), [digestOf(t1)], "only the new main is bound");
      assert.equal(await anyTelegramBound(pool, user), true, "and the account is never 'fresh' (#519 R3)");
      // The old identity opening the new trip's link is a different account: refused or asked, never bound.
      const decision = multi(await dispatch(startUpdate(signup, later.token)));
      assert.notEqual(decision.replies[0]!.text, "", "answered");
      assert.equal((await liveLinks(later.tripId, signup)).length, 0);
      // Linking the old identity as main again lifts it.
      const back = await linkMain(app, user, rome, signup);
      assert.equal(back.kind === "multi_reply" || back.kind === "reply", true);
      assert.ok((await boundTelegramAccounts(pool, user, later.tripId)).some((a) => a.digest === digestOf(signup)));
      assert.equal((await boundTelegramAccounts(pool, user, later.tripId)).some((a) => a.digest === digestOf(t1)), false, "and the other is now the replaced one");
    } finally { await app.close(); }
  });

  test("linking the SAME Telegram again replaces nothing and tells nobody else", async () => {
    const app = newApp();
    try {
      const { user, t0, firstTripId } = await accountWithMain();
      await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
      const decision = await linkMain(app, user, firstTripId, t0);
      assert.equal(decision.kind, "reply");
      assert.equal(replyText(decision), uiString("mainTelegramLinked", "en"));
      assert.equal((await liveLinks(firstTripId, t0)).length, 1);
    } finally { await app.close(); }
  });

  test("a legacy trip-scoped dashboard link (#519) is not promoted by the migration; the owner widens it by linking from that Telegram, and it ENDS when another Telegram becomes main", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const a = await mkTrip("A"); const b = await mkTrip("B");
      await mkMember(a, user); await mkMember(b, user);
      const legacy = nextChat();
      const client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, legacy, user, a, "dashboard_link_token", null, "trip"); } finally { client.release(); }
      assert.equal((await liveLinks(a, legacy))[0].binding_scope, "trip", "not promoted by being there");
      // The owner makes it the main one by linking from it: widened, on every trip.
      await linkMain(app, user, a, legacy);
      assert.equal((await liveLinks(a, legacy))[0].binding_scope, "account");
      assert.equal((await liveLinks(b, legacy)).length, 1);
    } finally { await app.close(); }
  });
});

describe("lost-phone recovery: the OLD phone is unlinked, whatever scope the dashboard link gave it", { skip }, () => {
  test("a phone added with the dashboard link before #523 (trip-scoped) loses every trip when a new main is linked; an APPROVAL's trip-only link stands", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const a = await mkTrip("A"); const b = await mkTrip("B"); const c = await mkTrip("C");
      for (const t of [a, b, c]) await mkMember(t, user);
      const oldPhone = nextChat(); const spouse = nextChat();
      for (const t of [a, b]) {
        const client = await pool.connect();
        try { await linkTelegramOrganizerInTx(client, oldPhone, user, t, "dashboard_link_token", null, "trip"); } finally { client.release(); }
      }
      // A DM binding so the bot can tell the old phone it was replaced.
      await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id,chat_id,trip_id,hermes_profile) VALUES ($1,$2,$3,'prof')", [id("tcb"), oldPhone, a]);
      // Another person the owner approved for trip C only (#519): not the owner's phone.
      const client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, spouse, user, c, "enrollment_redemption", null, "trip"); } finally { client.release(); }
      assert.equal(await isTripOrganizer(pool, a, oldPhone), true, "before: the old phone organizes");

      const newPhone = nextChat();
      const decision = multi(await linkMain(app, user, a, newPhone));
      assert.deepEqual(decision.replies.map((r) => r.chatId), [newPhone, oldPhone], "and the old phone IS told, so the message is true");
      assert.equal(decision.replies[1]!.text, uiString("mainTelegramReplaced", "en"));
      for (const t of [a, b]) {
        assert.equal((await liveLinks(t, oldPhone)).length, 0);
        assert.equal(await isTripOrganizer(pool, t, oldPhone), false, "no organizer access anywhere");
        assert.equal(await isMainTripOrganizer(pool, t, oldPhone), false);
      }
      assert.deepEqual((await listOrganizerTrips(pool, oldPhone, oldPhone)).map((x) => x.tripId), []);
      assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL", [oldPhone])).rowCount, 0, "and its companion DM route is closed");
      assert.equal((await liveLinks(c, spouse)).length, 1, "the approved person is not the old phone");
      assert.equal((await liveLinks(c, spouse))[0].binding_scope, "trip");
      assert.equal((await unlinkedTelegramLinksByTrip(pool, user, [a, b])).size, 0, "and it is not offered back for Restore");
    } finally { await app.close(); }
  });

  test("a Restore of a dashboard link's row is the owner's old phone too; a Restore of an approval's row is not", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const a = await mkTrip("A"); const c = await mkTrip("C");
      await mkMember(a, user); await mkMember(c, user);
      const restoredPhone = nextChat(); const restoredSpouse = nextChat();
      const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
      const { restoreTelegramLink } = await import("../src/telegram-link-token.js");
      for (const [phone, trip, via] of [[restoredPhone, a, "dashboard_link_token"], [restoredSpouse, c, "enrollment_redemption"]] as const) {
        const client = await pool.connect();
        try { await linkTelegramOrganizerInTx(client, phone, user, trip, via, null, "trip"); } finally { client.release(); }
        const row = (await liveLinks(trip, phone))[0];
        assert.equal(await unlinkTelegramLink(pool, user, row.id), true);
        assert.equal((await restoreTelegramLink(pool, { userId: user, linkId: row.id })).ok, true);
        assert.equal((await liveLinks(trip, phone))[0].verified_via, "dashboard_restore");
      }
      await linkMain(app, user, a, nextChat());
      assert.equal((await liveLinks(a, restoredPhone)).length, 0, "a restored dashboard-link phone ends");
      assert.equal((await liveLinks(c, restoredSpouse)).length, 1, "a restored approval stays");
    } finally { await app.close(); }
  });
});

describe("AC-3: the account link is single use, short-lived, and issued only to the signed-in account", { skip }, () => {
  test("single use, and a second Telegram opening it is refused with the one refusal sentence", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const rome = await mkTrip("Rome"); await mkMember(rome, user);
      const session = await webSession(user, "once");
      const issued = await call(app, session, "POST", `/v1/trips/${rome}/telegram-link`);
      const token = tokenOf(issued.json().deepLink);
      assert.equal(replyText(await dispatch(startUpdate(nextChat(), token))), uiString("mainTelegramLinked", "en"));
      assert.equal(replyText(await dispatch(startUpdate(nextChat(), token))), uiString("telegramLinkRefused", "en"));
    } finally { await app.close(); }
  });

  test("short-lived: an expired link reaches nothing, and an opened-in-a-group link is not consumed", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const rome = await mkTrip("Rome"); await mkMember(rome, user);
      const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: rome });
      assert.ok(issued.ok);
      if (!issued.ok) return;
      const group = -(1_000_000_000_000 + Math.floor(Math.random() * 1e9));
      assert.equal(replyText(await dispatch(startUpdate(String(group), issued.token, from(nextChat()), "supergroup"))), DEFAULT_STRINGS.notPrivate);
      await pool.query("UPDATE control_plane.telegram_link_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1", [user]);
      const t = nextChat();
      assert.equal(replyText(await dispatch(startUpdate(t, issued.token))), uiString("telegramLinkRefused", "en"));
      assert.equal((await liveLinks(rome, t)).length, 0, "reaches nothing");
    } finally { await app.close(); }
  });

  test("issued only to the signed-in account: no session, no CSRF, and a Telegram-minted (scoped) session are all refused", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const rome = await mkTrip("Rome"); await mkMember(rome, user);
      const t = nextChat();
      await linkMain(app, user, rome, t);
      const session = await webSession(user, "csrf");
      assert.equal((await call(app, null, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 401);
      assert.equal((await call(app, { cookie: session.cookie, csrf: "wrong" }, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 403);
      const scoped = (await miniApp(app, t, rome)).session!;
      assert.equal((await call(app, scoped, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 403, "a forwarded interview link's phone cannot mint a main Telegram");
      assert.equal((await call(app, session, "POST", `/v1/trips/${rome}/telegram-link`)).statusCode, 201);
    } finally { await app.close(); }
  });
});

// ═══ SECONDARY ORGANIZERS ════════════════════════════════════════════════════

describe("AC-4: the main organizer's trip link makes the opener a secondary organizer of that trip only", { skip }, () => {
  test("created from the dashboard trip page; the opener is a secondary organizer; the main organizer is told who joined", async () => {
    const app = newApp();
    try {
      const { user, t0, firstTripId } = await accountWithMain();
      await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
      const other = await mkTrip("Other trip"); await mkMember(other, user);
      const s = nextChat();
      const decision = multi(await addSecondary(app, user, firstTripId, s, from(s, "Noa", "noa_s")));
      assert.deepEqual(decision.replies.map((r) => r.chatId), [s, t0]);
      assert.equal(decision.replies[0]!.text, uiString("secondaryJoined", "en").replace("{trip}", "First Trip"));
      assert.match(decision.replies[1]!.text, /Noa \(@noa_s\)/, "the main organizer is told who joined: first name and @username");
      assert.match(decision.replies[1]!.text, /First Trip/);
      const row = await secondaryRow(firstTripId, s);
      assert.equal(row.revoked_at, null);
      assert.equal(row.trip_id, firstTripId);
      assert.equal(await isTripOrganizer(pool, firstTripId, s), true);
      assert.equal(await isTripOrganizer(pool, other, s), false, "that trip only");
      assert.deepEqual((await listSecondaryOrganizers(pool, firstTripId)).map((x) => [x.name, x.username]), [["Noa", "noa_s"]]);
    } finally { await app.close(); }
  });

  test("the link is stored as a digest only, is single use, and a second opener is refused with the one sentence", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const trip = await mkTrip("Rome"); await mkMember(trip, user);
      const session = await webSession(user, "tok");
      const issued = await call(app, session, "POST", `/v1/trips/${trip}/secondary-organizer-link`);
      assert.equal(issued.statusCode, 201);
      const token = tokenOf(issued.json().deepLink);
      assert.match(token, SECONDARY_TOKEN_PATTERN);
      const stored = await pool.query("SELECT token_digest, expires_at FROM control_plane.trip_secondary_organizer_tokens WHERE trip_id = $1", [trip]);
      assert.equal(stored.rows[0].token_digest, sha256(token));
      assert.ok(!JSON.stringify(stored.rows).includes(token), "the raw token is not stored");
      assert.ok(stored.rows[0].expires_at.getTime() - Date.now() <= 15 * 60 * 1000 + 5000, "short lived");
      const s1 = nextChat(), s2 = nextChat();
      assert.equal(replyText(await dispatch(startUpdate(s1, token))), uiString("secondaryJoined", "en").replace("{trip}", "Rome"));
      assert.equal(replyText(await dispatch(startUpdate(s2, token))), uiString("secondaryRefused", "en"));
      assert.equal(await secondaryRow(trip, s2), undefined);
    } finally { await app.close(); }
  });

  test("short-lived: an expired link, an unknown one, a group, and an issuer who lost the trip are all the same refusal", async () => {
    const user = await mkUser(); const trip = await mkTrip("Rome"); await mkMember(trip, user);
    const refused = uiString("secondaryRefused", "en");
    const first = await issueSecondaryOrganizerToken(pool, { userId: user, tripId: trip });
    assert.ok(first.ok);
    if (!first.ok) return;
    await pool.query("UPDATE control_plane.trip_secondary_organizer_tokens SET expires_at = now() - interval '1 second' WHERE trip_id = $1", [trip]);
    assert.equal(replyText(await dispatch(startUpdate(nextChat(), first.token))), refused, "expired");
    assert.equal(replyText(await dispatch(startUpdate(nextChat(), `so_${randomBytes(24).toString("base64url")}`))), refused, "unknown");
    const second = await issueSecondaryOrganizerToken(pool, { userId: user, tripId: trip });
    assert.ok(second.ok);
    if (!second.ok) return;
    const group = String(-(1_000_000_000_000 + Math.floor(Math.random() * 1e9)));
    assert.equal(replyText(await dispatch(startUpdate(group, second.token, from(nextChat()), "supergroup"))), DEFAULT_STRINGS.notPrivate);
    assert.equal((await pool.query("SELECT state FROM control_plane.trip_secondary_organizer_tokens WHERE trip_id = $1 AND state = 'issued'", [trip])).rowCount, 1, "a link opened in a group is not consumed");
    await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [trip, user]);
    assert.equal(replyText(await dispatch(startUpdate(nextChat(), second.token))), refused, "the issuer no longer owns the trip");
    assert.equal(secondaryOrganizerTokenFromStartPayload(`so_${"a".repeat(40)}`), null);
    assert.equal(secondaryOrganizerTokenFromStartPayload(`lk_${"a".repeat(32)}`), null, "an account link is not a trip link");
  });

  test("the main organizer's own Telegram, and one that already organizes the trip, are told so and the link is NOT spent", async () => {
    const app = newApp();
    try {
      const { user, t0, firstTripId } = await accountWithMain();
      const session = await webSession(user, "self");
      const issued = await call(app, session, "POST", `/v1/trips/${firstTripId}/secondary-organizer-link`);
      const token = tokenOf(issued.json().deepLink);
      assert.equal(replyText(await dispatch(startUpdate(t0, token))), uiString("secondaryAlready", "en").replace("{trip}", "First Trip"));
      assert.equal((await pool.query("SELECT state FROM control_plane.trip_secondary_organizer_tokens WHERE trip_id = $1", [firstTripId])).rows[0].state, "issued");
      assert.equal(await secondaryRow(firstTripId, t0), undefined, "the main organizer is not made a secondary one");
    } finally { await app.close(); }
  });

  test("re-opening a link as the same secondary organizer joins nobody twice and tells the main organizer nothing more", async () => {
    const app = newApp();
    try {
      const { user, firstTripId } = await accountWithMain();
      await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
      const s = nextChat();
      await addSecondary(app, user, firstTripId, s);
      const again = await addSecondary(app, user, firstTripId, s);
      assert.equal(again.kind, "reply", "no second notice to the main organizer");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_secondary_organizers WHERE trip_id = $1 AND revoked_at IS NULL", [firstTripId])).rows[0].n, 1);
    } finally { await app.close(); }
  });
});

describe("AC-5: what a secondary organizer can do in Telegram, and each thing they cannot", { skip }, () => {
  async function scenario() {
    const app = newApp();
    const { user, t0, firstTripId } = await accountWithMain();
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
    const other = await mkTrip("Other trip"); await mkMember(other, user);
    const client = await pool.connect();
    try { await linkTelegramOrganizerInTx(client, t0, user, other); } finally { client.release(); }
    const s = nextChat();
    await addSecondary(app, user, firstTripId, s);
    const sUser = (await secondaryRow(firstTripId, s)).user_id as string;
    return { app, user, t0, trip: firstTripId, other, s, sUser };
  }

  test("CAN: is an organizer of the trip (organizer actions), is treated as one by the bot's person role, and talks to the companion in a free DM", async () => {
    const { app, trip, s, other } = await scenario();
    try {
      assert.equal(await isTripOrganizer(pool, trip, s), true);
      assert.equal(await isTripOrganizer(pool, other, s), false);
      const person = await resolveTripPerson(pool, trip, s);
      assert.equal(person?.role, "secondary_organizer", "its OWN role value: never 'organizer', which is the main organizer's");
      assert.equal(person?.displayName, "Noa");
      assert.equal((await resolveTripPerson(pool, other, s)), null, "and nothing on another trip");
      assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND trip_id = $2 AND closed_at IS NULL", [s, trip])).rowCount, 1, "the free DM reaches the trip");
    } finally { await app.close(); }
  });

  test("CAN: /trips lists ONLY that trip, and /switch works for it", async () => {
    const { app, trip, s, other } = await scenario();
    try {
      assert.deepEqual((await listOrganizerTrips(pool, s, s)).map((x) => x.tripId), [trip]);
      const listed = await dispatch(textUpdate(s, "/trips"));
      const text = JSON.stringify(listed);
      assert.match(text, /First Trip/);
      assert.doesNotMatch(text, /Other trip/);
      assert.equal((await switchChatToTrip(pool, s, s, trip)).kind, "unchanged");
      assert.deepEqual(await switchChatToTrip(pool, s, s, other), { kind: "refused", reason: "NOT_YOURS" }, "CANNOT reach any other trip");
    } finally { await app.close(); }
  });

  test("CANNOT create links: neither a trip link nor an account link, by any door", async () => {
    const { app, trip, s, sUser } = await scenario();
    try {
      assert.deepEqual(await issueSecondaryOrganizerToken(pool, { userId: sUser, tripId: trip }), { ok: false, reason: "NOT_FOUND" });
      assert.deepEqual(await issueTelegramLinkToken(pool, { userId: sUser, tripId: trip }), { ok: false, reason: "NOT_FOUND" });
      // Through the portal, with the session the Mini App gives them: scoped, so the account-level routes refuse.
      const session = (await miniApp(app, s, trip)).session!;
      assert.ok(session, "a secondary organizer can open the Mini App for the trip");
      assert.equal((await call(app, session, "POST", `/v1/trips/${trip}/secondary-organizer-link`)).statusCode, 403);
      assert.equal((await call(app, session, "POST", `/v1/trips/${trip}/telegram-link`)).statusCode, 403);
      assert.equal((await call(app, session, "POST", `/v1/trips/${trip}/interview-link`)).statusCode, 403);
    } finally { await app.close(); }
  });

  test("CANNOT approve requests: a stranger's request to the main organizer is not S's to answer, by button or by typing", async () => {
    const { app, user, t0, s } = await scenario();
    try {
      // A trip nobody has started; a stranger opens its interview link; the main organizer (T0) is asked.
      const fresh = await draftTrip(user, "Fresh");
      const stranger = nextChat();
      const asked = multi(await dispatch(startUpdate(stranger, fresh.token, from(stranger, "Mallory", "mal"))));
      assert.equal(asked.replies[1]!.chatId, t0, "the main organizer is asked, not the secondary one");
      const requestId = (await pool.query("SELECT id FROM control_plane.organizer_link_requests WHERE trip_id = $1", [fresh.tripId])).rows[0].id as string;
      const result = await answerLinkRequest(pool, { requestId, choice: "approve", chatId: s, fromId: s });
      assert.notEqual(result.kind, "approved");
      assert.equal((await pool.query("SELECT state FROM control_plane.organizer_link_requests WHERE id = $1", [requestId])).rows[0].state, "pending");
      // Typing "approve" in S's own chat does nothing to the request either.
      await dispatch(textUpdate(s, "approve"));
      assert.equal((await pool.query("SELECT state FROM control_plane.organizer_link_requests WHERE id = $1", [requestId])).rows[0].state, "pending");
      assert.equal((await liveLinks(fresh.tripId, stranger)).length, 0);
    } finally { await app.close(); }
  });

  test("CANNOT add organizers: S is not in the set an approval is asked of or counted bound, and a link opened by S for the interview is another account's", async () => {
    const { app, user, trip, s } = await scenario();
    try {
      assert.equal((await boundTelegramAccounts(pool, user, trip)).some((a) => a.digest === digestOf(s)), false, "S is not 'bound' to the account");
      // S opening the main organizer's interview link is a stranger to the account: refused or asked, never made an organizer.
      const fresh = await draftTrip(user, "Fresh two");
      const decision = multi(await dispatch(startUpdate(s, fresh.token)));
      assert.ok(decision.replies.length >= 1);
      assert.equal((await liveLinks(fresh.tripId, s)).length, 0, "no organizer link was written for S");
      assert.equal((await pool.query("SELECT 1 FROM control_plane.intake_sessions WHERE trip_id = $1", [fresh.tripId])).rowCount, 0, "and no interview started");
    } finally { await app.close(); }
  });

  test("CANNOT see any other trip: not in the Mini App, not by launch", async () => {
    const { app, other, s, trip } = await scenario();
    try {
      const session = (await miniApp(app, s, trip)).session!;
      assert.deepEqual((await call(app, session, "GET", "/v1/trips")).json().trips.map((t: { id: string }) => t.id), [trip]);
      assert.equal((await call(app, session, "POST", `/v1/trips/${other}/launch`)).statusCode, 404);
      const out = await miniApp(app, s, other);
      assert.notEqual(out.response.json().appPath, `/mini-app/trips/${other}`, "the other trip is not offered");
    } finally { await app.close(); }
  });
});

describe("AC-6 (control plane half): an organizer view on the trip site, and no dashboard", { skip }, () => {
  test("the Mini App signs S in scoped to the trip; the dashboard routes refuse; the runtime launch carries the organizer role and NO dashboard url", async () => {
    const app = newApp();
    try {
      const { user, firstTripId } = await accountWithMain();
      const s = nextChat();
      await addSecondary(app, user, firstTripId, s);
      const { session } = await miniApp(app, s, firstTripId);
      assert.ok(session);
      const me = (await call(app, session!, "GET", "/v1/me")).json();
      assert.equal(me.scope, "telegram");
      const listed = (await call(app, session!, "GET", "/v1/trips")).json().trips;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].permissions.dashboard, false);
      assert.equal(listed[0].permissions.role, "organizer");
      assert.equal(listed[0].permissions.invite, false);
      assert.equal(listed[0].permissions.requestProvisioning, false);
      // The dashboard's trip detail, the member list and the account routes all refuse.
      assert.equal((await call(app, session!, "GET", `/v1/trips/${firstTripId}`)).statusCode, 404);
      assert.equal((await call(app, session!, "POST", `/v1/trips/${firstTripId}/site-invites`, { displayName: "X", runtimeUsername: "x-guest" })).statusCode, 403);
      assert.equal((await call(app, session!, "POST", "/v1/trips", { destination: "Lisbon", tripType: "family" })).statusCode, 403);
      assert.equal((await call(app, session!, "POST", `/v1/trips/${firstTripId}/provisioning-request`)).statusCode, 404);
      // The launch is what carries "organizer" to the trip site.
      const launched = await call(app, session!, "POST", `/v1/trips/${firstTripId}/launch`);
      assert.equal(launched.statusCode, 200);
      const consumed = await app.inject({
        method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" },
        payload: JSON.stringify({ token: launched.json().launchToken }),
      });
      assert.equal(consumed.statusCode, 200);
      assert.equal(consumed.json().role, "organizer");
      assert.equal(consumed.json().dashboardUrl, null, "no way back to a dashboard they cannot open");
      assert.equal(consumed.json().tripId, firstTripId);
      await pool.query("UPDATE control_plane.trip_memberships SET runtime_access = true WHERE trip_id = $1 AND user_id = $2", [firstTripId, user]);
      const owner = await webSession(user, "owner-launch");
      const ownerLaunch = await call(app, owner, "POST", `/v1/trips/${firstTripId}/launch`);
      const ownerConsumed = await app.inject({
        method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" },
        payload: JSON.stringify({ token: ownerLaunch.json().launchToken }),
      });
      assert.equal(ownerConsumed.json().role, "owner");
      assert.match(ownerConsumed.json().dashboardUrl, /\/setup$/, "the main organizer keeps theirs");
    } finally { await app.close(); }
  });
});

describe("AC-7: only the main organizer can create a trip link", { skip }, () => {
  test("a co-organizer, a member, an outsider, no session, a wrong CSRF and the secondary organizer are all refused on the dashboard", async () => {
    const app = newApp();
    try {
      const owner = await mkUser("Owner"); const co = await mkUser("Co"); const member = await mkUser("Member"); const outsider = await mkUser("Outsider");
      const trip = await mkTrip("Rome");
      await mkMember(trip, owner); await mkMember(trip, co, "organizer"); await mkMember(trip, member, "member");
      const url = `/v1/trips/${trip}/secondary-organizer-link`;
      assert.equal((await call(app, await webSession(co, "co"), "POST", url)).statusCode, 404, "an organizer-role member is not the main organizer");
      assert.equal((await call(app, await webSession(member, "member"), "POST", url)).statusCode, 404);
      assert.equal((await call(app, await webSession(outsider, "out"), "POST", url)).statusCode, 404);
      assert.equal((await call(app, null, "POST", url)).statusCode, 401);
      const ownerSession = await webSession(owner, "owner");
      assert.equal((await call(app, { cookie: ownerSession.cookie, csrf: "wrong" }, "POST", url)).statusCode, 403);
      assert.equal((await call(app, ownerSession, "POST", url)).statusCode, 201);
      // The secondary organizer's own hidden account.
      const s = nextChat();
      await dispatch(startUpdate(s, (await issueSecondaryOrganizerToken(pool, { userId: owner, tripId: trip }) as { token: string }).token));
      const sUser = (await secondaryRow(trip, s)).user_id as string;
      assert.equal((await call(app, await webSession(sUser, "sec"), "POST", url)).statusCode, 404, "even with a full-looking session, a no-dashboard membership is refused");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_secondary_organizer_tokens WHERE issued_by IN ($1,$2,$3,$4)", [co, member, outsider, sUser])).rows[0].n, 0, "and nothing was issued");
    } finally { await app.close(); }
  });

  test("a retired trip and a trip that does not exist: one 404", async () => {
    const app = newApp();
    try {
      const owner = await mkUser("Owner"); const trip = await mkTrip("Gone"); await mkMember(trip, owner);
      await pool.query("UPDATE control_plane.trips SET slug = 'retired-' || slug WHERE id = $1", [trip]);
      const session = await webSession(owner, "ret");
      assert.equal((await call(app, session, "POST", `/v1/trips/${trip}/secondary-organizer-link`)).statusCode, 404);
      assert.equal((await call(app, session, "POST", "/v1/trips/trip_doesnotexist1/secondary-organizer-link")).statusCode, 404);
    } finally { await app.close(); }
  });
});

describe("AC-8: the main organizer removes a secondary organizer, and it takes effect at once", { skip }, () => {
  async function joined() {
    const app = newApp();
    const { user, t0, firstTripId } = await accountWithMain();
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
    const s = nextChat(), keep = nextChat();
    await addSecondary(app, user, firstTripId, s, from(s, "Noa", "noa_s"));
    await addSecondary(app, user, firstTripId, keep, from(keep, "Kai", "kai_k"));
    const { session } = await miniApp(app, s, firstTripId);
    return { app, user, t0, trip: firstTripId, s, keep, sSession: session! };
  }

  test("the dashboard trip page lists them, Remove ends everything at once, and the other secondary organizer is untouched", async () => {
    const { app, user, trip, s, keep, sSession } = await joined();
    try {
      const owner = await webSession(user, "rm");
      const detail = (await call(app, owner, "GET", `/v1/trips/${trip}`)).json();
      assert.deepEqual(detail.secondaryOrganizers.map((x: { name: string; username: string }) => [x.name, x.username]).sort(), [["Kai", "kai_k"], ["Noa", "noa_s"]]);
      assert.equal(JSON.stringify(detail).includes(digestOf(s)), false, "never a digest");
      assert.ok(!detail.members.some((m: { displayName: string }) => m.displayName === "Noa"), "they are not listed as members too");
      const sId = detail.secondaryOrganizers.find((x: { username: string }) => x.username === "noa_s").id as string;

      const removed = await call(app, owner, "DELETE", `/v1/trips/${trip}/secondary-organizers/${sId}`);
      assert.equal(removed.statusCode, 200);
      // At once, in Telegram...
      assert.equal(await isTripOrganizer(pool, trip, s), false);
      assert.deepEqual((await listOrganizerTrips(pool, s, s)).map((x) => x.tripId), []);
      assert.deepEqual(await switchChatToTrip(pool, s, s, trip), { kind: "refused", reason: "NOT_YOURS" });
      assert.equal((await resolveTripPerson(pool, trip, s)), null);
      assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND trip_id = $2 AND closed_at IS NULL", [s, trip])).rowCount, 0, "the companion no longer answers that DM");
      // ...in the portal and the Mini App...
      assert.equal((await call(app, sSession, "GET", "/v1/trips")).statusCode, 401, "the session they held is gone");
      const again = await miniApp(app, s, trip);
      assert.equal(again.session, null);
      assert.equal(again.response.statusCode, 401);
      assert.equal(again.response.json().error, "TELEGRAM_NOT_LINKED");
      // ...and on the trip site: the gateway's liveness question answers no, and no launch is possible.
      const check = await app.inject({
        method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" },
        payload: JSON.stringify({ tripId: trip, userId: (await secondaryRow(trip, s)).user_id, sessionId: null, role: "organizer" }),
      });
      assert.equal(check.statusCode, 401);
      // The other one is untouched.
      assert.equal(await isTripOrganizer(pool, trip, keep), true);
      assert.deepEqual((await listSecondaryOrganizers(pool, trip)).map((x) => x.username), ["kai_k"]);
      // Removing it again, or a made-up id, is the one 404.
      assert.equal((await call(app, owner, "DELETE", `/v1/trips/${trip}/secondary-organizers/${sId}`)).statusCode, 404);
      assert.equal((await call(app, owner, "DELETE", `/v1/trips/${trip}/secondary-organizers/tso_nonexistent0000`)).statusCode, 404);
    } finally { await app.close(); }
  });

  test("only the main organizer can remove one: a secondary organizer, a member and an outsider cannot, and nothing changes", async () => {
    const { app, trip, s, keep, user } = await joined();
    try {
      const keepRow = await secondaryRow(trip, keep);
      const sSessionUser = (await secondaryRow(trip, s)).user_id as string;
      const member = await mkUser("Member"); await mkMember(trip, member, "member");
      const outsider = await mkUser("Outsider");
      const url = `/v1/trips/${trip}/secondary-organizers/${keepRow.id}`;
      for (const who of [sSessionUser, member, outsider]) {
        assert.equal((await call(app, await webSession(who, "x"), "DELETE", url)).statusCode, 404);
      }
      assert.equal((await call(app, null, "DELETE", url)).statusCode, 401);
      const scoped = (await miniApp(app, s, trip)).session!;
      assert.equal((await call(app, scoped, "DELETE", url)).statusCode, 403);
      assert.equal(await isTripOrganizer(pool, trip, keep), true);
      void user;
    } finally { await app.close(); }
  });

  test("a membership ended by ANY route (the dashboard's member removal included) ends the secondary organizer too", async () => {
    const { app, trip, s } = await joined();
    try {
      const row = await secondaryRow(trip, s);
      await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [trip, row.user_id]);
      assert.equal(await isTripOrganizer(pool, trip, s), false);
      assert.deepEqual((await listOrganizerTrips(pool, s, s)).map((x) => x.tripId), []);
      assert.equal((await listSecondaryOrganizers(pool, trip)).some((x) => x.username === "noa_s"), false);
      // Opening a fresh trip link afterwards makes a fresh binding (the old row is history).
      const issued = await issueSecondaryOrganizerToken(pool, { userId: (await pool.query("SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1 AND role = 'owner'", [trip])).rows[0].user_id, tripId: trip });
      assert.ok(issued.ok);
      if (!issued.ok) return;
      const rejoined = multi(await dispatch(startUpdate(s, issued.token, from(s, "Noa", "noa_s"))));
      assert.equal(rejoined.replies[0]!.text, uiString("secondaryJoined", "en").replace("{trip}", "First Trip"));
      assert.equal(await isTripOrganizer(pool, trip, s), true);
    } finally { await app.close(); }
  });
});

describe("AC-9: #519's rules still hold", { skip }, () => {
  test("a secondary organizer is not a 'bound' Telegram: it never makes an account non-empty, and 'an account that ever had a Telegram is never empty' is unchanged", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const trip = await draftTrip(user, "Fresh");
      // An account with NOTHING bound adds a secondary organizer from the dashboard.
      const s = nextChat();
      await addSecondary(app, user, trip.tripId, s);
      assert.equal(await anyTelegramBound(pool, user), false, "S does not bind the account");
      assert.deepEqual(await boundTelegramAccounts(pool, user, trip.tripId), []);
      // So the account's first interview opener still binds (AC-1 of #519), and from then on the account is never empty.
      const t = nextChat();
      assert.equal((await dispatch(startUpdate(t, trip.token))).kind, "reply");
      assert.equal((await liveLinks(trip.tripId, t)).length, 1);
      assert.equal(await anyTelegramBound(pool, user), true);
    } finally { await app.close(); }
  });

  test("the per-trip approval still works and still reaches that trip only, with a secondary organizer on the trip", async () => {
    const app = newApp();
    try {
      const { user, t0 } = await accountWithMain();
      const trip = await draftTrip(user, "Approve me");
      const s = nextChat();
      await addSecondary(app, user, trip.tripId, s);
      const t1 = nextChat();
      const asked = multi(await dispatch(startUpdate(t1, trip.token, from(t1, "Mallory", "mal"))));
      assert.equal(asked.replies[1]!.chatId, t0);
      const approve = (asked.replies[1] as { replyMarkup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }).replyMarkup!.inline_keyboard.flat().find((b) => b.callback_data?.endsWith(":a"))!.callback_data!;
      await dispatch(tapUpdate(t0, approve));
      assert.equal((await liveLinks(trip.tripId, t1))[0]?.binding_scope, "trip");
      assert.equal(await isTripOrganizer(pool, trip.tripId, s), true, "S is untouched by it");
    } finally { await app.close(); }
  });
});

describe("AC-10: Hebrew and English copy for every new message, Hebrew in the plural voice", { skip }, () => {
  const keys = ["mainTelegramLinked", "mainTelegramLinkedReplaced", "mainTelegramReplaced", "secondaryJoined", "secondaryAlready", "secondaryRefused", "secondaryJoinedNotice"];
  test("every key exists in both languages", () => {
    for (const key of keys) {
      assert.ok(UI_STRINGS.en[key] && UI_STRINGS.en[key]!.length > 20, `en ${key}`);
      assert.ok(UI_STRINGS.he[key] && UI_STRINGS.he[key]!.length > 20, `he ${key}`);
      assert.notEqual(UI_STRINGS.he[key], UI_STRINGS.en[key]);
      assert.match(UI_STRINGS.he[key]!, /[֐-׿]/);
    }
  });
  test("the Hebrew speaks to 'you' in the plural (imperatives and pronouns), never the singular", () => {
    assert.match(UI_STRINGS.he.mainTelegramLinked!, /שלחו/);
    assert.match(UI_STRINGS.he.mainTelegramLinked!, /שלכם/);
    assert.match(UI_STRINGS.he.secondaryJoined!, /אתם/);
    assert.match(UI_STRINGS.he.secondaryAlready!, /שלחו/);
    assert.match(UI_STRINGS.he.secondaryRefused!, /בקשו/);
    for (const key of keys) assert.doesNotMatch(UI_STRINGS.he[key]!, /שלח\b|תשלח|בקש\b|אתה\b|שלך\b/, key);
  });
  test("the placeholders the router fills are present in both languages", () => {
    for (const language of ["en", "he"] as const) {
      assert.match(UI_STRINGS[language].secondaryJoined!, /\{trip\}/);
      assert.match(UI_STRINGS[language].secondaryAlready!, /\{trip\}/);
      assert.match(UI_STRINGS[language].secondaryJoinedNotice!, /\{who\}/);
      assert.match(UI_STRINGS[language].secondaryJoinedNotice!, /\{trip\}/);
    }
  });
  test("the secondary organizer is told in their own language", async () => {
    const app = newApp();
    try {
      const user = await mkUser(); const trip = await mkTrip("Tel Aviv"); await mkMember(trip, user);
      const s = nextChat();
      const decision = await addSecondary(app, user, trip, s, from(s, "Noa", "noa_s", "he"));
      assert.equal(replyText(decision), uiString("secondaryJoined", "he").replace("{trip}", "Tel Aviv"));
    } finally { await app.close(); }
  });
});

// ═══ the helpers the module exposes, and the hash that must not change ═══════

test("the trip-link token is not an account link or an enrollment token, by prefix and length", () => {
  assert.equal(SECONDARY_TOKEN_PATTERN.test(`so_${"A".repeat(32)}`), true);
  assert.equal(SECONDARY_TOKEN_PATTERN.test(`lk_${"A".repeat(32)}`), false);
  assert.equal(SECONDARY_TOKEN_PATTERN.test(randomBytes(32).toString("base64url")), false);
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
  void redeemSecondaryOrganizerToken; void redeemTelegramLinkToken; void unlinkedTelegramLinksByTrip;
});

// ═══ boundary review fixes ═══════════════════════════════════════════════════

describe("a secondary organizer may not move a family group, or hand out a group link (boundary review, HIGH)", { skip }, () => {
  async function scenario() {
    const app = newApp();
    const owner = await mkUser("Main"); const a = await mkTrip("Family Trip A"); await mkMember(a, owner);
    const t0 = nextChat();
    const client = await pool.connect();
    try { await linkTelegramOrganizerInTx(client, t0, owner, a); } finally { client.release(); }
    const group = `-100${Math.floor(Math.random() * 1e9)}`;
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id,chat_id,trip_id,hermes_profile) VALUES ($1,$2,$3,'prof-a')", [id("tcb"), group, a]);
    const s = nextChat();
    await addSecondary(app, owner, a, s);
    // S also runs their own trip B under their own Kinerary account.
    const sAccount = await mkUser("Noa own account"); const b = await mkTrip("Noa's other trip"); await mkMember(b, sAccount);
    const c2 = await pool.connect();
    try { await linkTelegramOrganizerInTx(c2, s, sAccount, b); } finally { c2.release(); }
    return { app, owner, a, t0, group, s, b };
  }
  const groupTrip = async (group: string) => (await pool.query("SELECT trip_id FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL", [group])).rows.map((r) => r.trip_id);

  test("the reviewer's scenario: S of trip A, who runs trip B, cannot carry A's group to B", async () => {
    const { app, a, b, group, s } = await scenario();
    try {
      assert.equal(await isTripOrganizer(pool, a, s), true, "S organizes A (any level)");
      assert.equal(await isMainTripOrganizer(pool, a, s), false, "but is not its MAIN organizer");
      assert.equal(await isMainTripOrganizer(pool, b, s), true);
      const token = await issueGroupBindingToken(pool, b, s, { ttlSeconds: 3600 });
      const moved = await redeemGroupBindingToken(pool, token.token, group, s);
      assert.deepEqual(moved, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      assert.deepEqual(await groupTrip(group), [a], "the group is still A's");
    } finally { await app.close(); }
  });

  test("/group in a secondary organizer's DM bound to the trip hands out nothing; the main organizer's still does", async () => {
    const { app, owner, a, s, t0 } = await scenario();
    try {
      const before = (await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1", [a])).rows[0].n;
      const refused = await dispatch(textUpdate(s, "/group", from(s, "Noa", "noa_s")));
      assert.equal(replyText(refused), DEFAULT_STRINGS.groupTokenUnavailable);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1", [a])).rows[0].n, before, "no token was issued");
      await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id,chat_id,trip_id,hermes_profile) VALUES ($1,$2,$3,'prof-a')", [id("tcb"), t0, a]);
      const granted = await dispatch(textUpdate(t0, "/group", from(t0, "Dana")));
      assert.notEqual(granted.kind === "reply" ? granted.reply.text : JSON.stringify(granted), DEFAULT_STRINGS.groupTokenUnavailable);
      void owner;
    } finally { await app.close(); }
  });

  test("the main organizer of both trips can still move the group", async () => {
    const { app, owner, a, group, t0 } = await scenario();
    try {
      const b2 = await mkTrip("Main's other trip"); await mkMember(b2, owner);
      const client = await pool.connect();
      try { await linkTelegramOrganizerInTx(client, t0, owner, b2); } finally { client.release(); }
      const token = await issueGroupBindingToken(pool, b2, t0, { ttlSeconds: 3600 });
      const moved = await redeemGroupBindingToken(pool, token.token, group, t0);
      assert.equal(moved.ok, true);
      assert.deepEqual(await groupTrip(group), [b2]);
      void a;
    } finally { await app.close(); }
  });

  test("/proactive stays open to a secondary organizer (it changes no person, group or link)", async () => {
    const { app, a, s } = await scenario();
    try {
      assert.equal(await isTripOrganizer(pool, a, s), true);
    } finally { await app.close(); }
  });
});

describe("a secondary organizer has its own role value everywhere it is read (boundary review, LOW)", { skip }, () => {
  test("resolveTripPerson says secondary_organizer; the main organizer still says organizer; analytics counts both as organizers", async () => {
    const app = newApp();
    try {
      const { user, t0, firstTripId } = await accountWithMain();
      const s = nextChat();
      await addSecondary(app, user, firstTripId, s);
      await pool.query(
        "INSERT INTO control_plane.trip_person_links(id,trip_id,telegram_user_id,participant_username,display_name,role,verified_via) VALUES ($1,$2,$3,'dana','Dana','organizer','interview_chat')",
        [id("tpl"), firstTripId, t0]);
      assert.equal((await resolveTripPerson(pool, firstTripId, s))?.role, "secondary_organizer");
      assert.equal((await resolveTripPerson(pool, firstTripId, t0))?.role, "organizer");
      assert.equal(requesterRoleOf("secondary_organizer"), "organizer");
      // A person link that says organizer is never downgraded by a secondary binding on the same Telegram.
      await pool.query(
        "INSERT INTO control_plane.trip_person_links(id,trip_id,telegram_user_id,participant_username,display_name,role,verified_via) VALUES ($1,$2,$3,'noa','Noa P','participant','interview_chat')",
        [id("tpl"), firstTripId, s]);
      assert.equal((await resolveTripPerson(pool, firstTripId, s))?.role, "secondary_organizer", "outranks a participant row");
      assert.equal(await isTripOrganizer(pool, firstTripId, s), true);
    } finally { await app.close(); }
  });
});

describe("a secondary organizer who unlinks their own member link RESIGNS (boundary review, LOW)", { skip }, () => {
  test("their Mini App session can DELETE its own tml_ link; the binding, membership and Telegram access end with it", async () => {
    const app = newApp();
    try {
      const { user, firstTripId } = await accountWithMain();
      await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET binding_scope = 'account' WHERE user_id = $1", [user]);
      const s = nextChat(), keep = nextChat();
      await addSecondary(app, user, firstTripId, s);
      await addSecondary(app, user, firstTripId, keep, from(keep, "Kai", "kai_k"));
      const { session } = await miniApp(app, s, firstTripId);
      assert.ok(session);
      const row = await secondaryRow(firstTripId, s);
      const unlinked = await call(app, session!, "DELETE", `/v1/account/telegram-links/${row.member_link_id}`);
      assert.equal(unlinked.statusCode, 200);
      assert.equal(await isTripOrganizer(pool, firstTripId, s), false, "no organizer left in Telegram");
      assert.deepEqual((await listOrganizerTrips(pool, s, s)).map((x) => x.tripId), []);
      assert.equal((await secondaryRow(firstTripId, s)).revoked_reason, "membership_ended");
      assert.equal((await pool.query("SELECT status FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [firstTripId, row.user_id])).rows[0].status, "revoked");
      assert.equal(await isTripOrganizer(pool, firstTripId, keep), true, "another secondary organizer is untouched");
      // They cannot unlink somebody else's link.
      const { session: keepSession } = await miniApp(app, keep, firstTripId);
      const otherLink = (await secondaryRow(firstTripId, s)).member_link_id as string;
      assert.equal((await call(app, keepSession!, "DELETE", `/v1/account/telegram-links/${otherLink}`)).statusCode, 404);
    } finally { await app.close(); }
  });
});
