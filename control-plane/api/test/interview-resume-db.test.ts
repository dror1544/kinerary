/**
 * #513: a paused (expired) interview picks up where it stopped.
 *
 * Found on Mac staging, 2026-11-04. An interview closes an hour after the organizer's last message. Afterwards the trip
 * stayed `intake_in_progress`, no new link could be issued, and a new session -- had one been possible -- was built
 * from the trip card alone. Each test is named after the acceptance criterion in
 * docs/specs/sprint-8/513-expired-interview-resumes.md that it proves.
 *
 * The expiry is the real one (`claimExpiredSessions`), the link is the real one (`POST /v1/trips/:id/interview-link`
 * through the portal app, or `issueEnrollment` for a trip that has no dashboard), and the interview is reopened the way
 * Telegram reopens it: `/start <token>` through `dispatchUpdate`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { issueEnrollment, replaceEnrollment, verifyEnrollmentToken } from "../src/enrollment.js";
import { applyMigrations } from "../src/migrations.js";
import { startFromDeepLink } from "../src/chat-router.js";
import {
  claimExpiredSessions,
  getSessionForChat,
  startSession,
  type AnswerStore,
} from "../src/interview.js";
import { uiString } from "../src/intake-copy.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { applyDecision } from "../src/relay/poller.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const SEEDED = ["destination", "departure_date", "return_date", "trip_type"] as const;
const JAPAN = { destination: "Japan", tripType: "family", startDate: "2027-04-12", endDate: "2027-04-26" };

let pool: pg.Pool;
let chatSeq = 770000000;
const nextChat = () => String(++chatSeq);

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
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 4 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

async function organizer(givenName: string | null = "Dana"): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name, given_name) VALUES ($1, 'active', 'kin.test+local', $2)", [userId, givenName]);
  return userId;
}

async function session(userId: string) {
  const salt = randomBytes(4).toString("hex");
  const raw = `session-${userId}-${salt}`, csrf = `csrf-${userId}-${salt}`;
  await pool.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [id("wsess"), userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
}

const tokenOf = (deepLink: string) => new URL(deepLink).searchParams.get("start")!;

/** The dashboard's trip, and a way to call the portal as its owner. */
async function dashboardTrip(userId: string, body: Record<string, unknown> = JAPAN) {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  const s = await session(userId);
  const headers = { cookie: s.cookie, "x-csrf-token": s.csrf };
  const created = await app.inject({ method: "POST", url: "/v1/trips", headers, payload: body });
  assert.equal(created.statusCode, 201, created.body);
  const tripId = created.json().id as string;
  const link = await app.inject({ method: "POST", url: `/v1/trips/${tripId}/interview-link`, headers });
  assert.equal(link.statusCode, 201, link.body);
  const call = (method: "GET" | "POST", path: string, payload?: unknown, as = headers) =>
    app.inject({ method, url: `/v1/trips/${tripId}${path}`, headers: as, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
  return { app, tripId, token: tokenOf(link.json().deepLink), headers, call, userId };
}

/** A trip made the way Telegram signup and an operator's invitation make it: no card, no dashboard access. */
async function bareTrip(userId: string) {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
  await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')", [id("memb"), tripId, userId]);
  const issued = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  return { tripId, token: issued.token, userId };
}

function startUpdate(chatId: string, token: string, languageCode?: string): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 7, from: { id: 777, first_name: "Telegram-Dror", ...(languageCode ? { language_code: languageCode } : {}) }, chat: { id: chatId, type: "private" }, text: `/start ${token}` },
  } as TelegramUpdate;
}

/** What the organizer is sent when they open `token`'s link. */
async function opened(chatId: string, token: string, languageCode?: string) {
  const decision = await dispatchUpdate(pool, startUpdate(chatId, token, languageCode));
  assert.equal(decision.kind, "reply");
  if (decision.kind !== "reply") throw new Error("unreachable");
  return decision.reply;
}

/** Answer whatever is asked, `steps` times, straight into the row (the way the #438 tests walk an interview). */
async function answerSome(chat: string, steps: number): Promise<string[]> {
  const answered: string[] = [];
  for (let step = 0; step < steps; step++) {
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok);
    const next = view.view.nextQuestion;
    if (!next) break;
    answered.push(next.id);
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1 AND expired_at IS NULL`,
      [chat, next.id, JSON.stringify(next.id === "travelers"
        ? { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] }
        : next.type === "choice" ? { kind: "choice", schema_version: 3, option_id: next.options![0]!.id, other_text: null }
        // "Dana" is on the roster `travelers` gets above, which is what settles `organizer_identity`.
        : { kind: "text", schema_version: 3, text: next.id === "organizer_identity" ? "Dana" : `answer to ${next.id}` })]);
  }
  return answered;
}

/** The real expiry: the deadline passes, the sweep closes the session. */
async function expire(tripId: string) {
  await pool.query("UPDATE control_plane.intake_sessions SET expires_at = now() - interval '1 minute' WHERE trip_id = $1 AND expired_at IS NULL", [tripId]);
  const closed = await claimExpiredSessions(pool, 100);
  assert.ok(closed.length >= 1, "the sweep closed the session");
}

/** An interview opened and answered a little, then closed by the sweep. Returns what it held. */
async function pausedInterview(trip: { tripId: string; token: string }, steps = 3, languageCode?: string) {
  const chat = nextChat();
  const first = await dispatchUpdate(pool, startUpdate(chat, trip.token, languageCode));
  assert.equal(first.kind, "reply");
  const answered = await answerSome(chat, steps);
  const before = await pool.query("SELECT id, answers, language FROM control_plane.intake_sessions WHERE trip_id = $1", [trip.tripId]);
  const seen = await getSessionForChat(pool, chat);
  assert.ok(seen.ok);
  await expire(trip.tripId);
  return { chat, answered, sessionId: before.rows[0].id as string, answers: before.rows[0].answers as AnswerStore, language: before.rows[0].language as string | null, nextQuestionId: seen.view.nextQuestion?.id ?? null };
}

const liveSession = async (tripId: string) =>
  (await pool.query("SELECT * FROM control_plane.intake_sessions WHERE trip_id = $1 AND expired_at IS NULL AND state <> 'confirmed'", [tripId])).rows;
const lifecycleOf = async (tripId: string) =>
  (await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId])).rows[0].lifecycle_state as string;

describe("a paused interview picks up where it stopped (#513)", { skip }, () => {
  test("lifecycle: expiry leaves the trip in intake_in_progress -- the choice this feature is built on", async () => {
    const t = await dashboardTrip(await organizer());
    await pausedInterview(t);
    assert.equal(await lifecycleOf(t.tripId), "intake_in_progress", "the sweep does not move the trip; enrollment accepts an expired-only trip instead");
    await t.app.close();
  });

  test("AC-1 the trip detail says the interview is paused only once its session expired unconfirmed", async () => {
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    const live = (await t.call("GET", "")).json();
    assert.equal(live.interview.paused, false, "a live interview is not paused");
    await expire(t.tripId);
    const paused = await t.call("GET", "");
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().interview.paused, true);
    assert.equal(paused.json().lifecycleState, "intake_in_progress");
    const link = (await t.call("GET", "/interview-link")).json();
    assert.equal(link.hasInterview, false, "no live interview to continue in Telegram");
    await t.app.close();
  });

  test("AC-2 a new link is issued for a paused trip, and any earlier unredeemed link stops working", async () => {
    const t = await dashboardTrip(await organizer());
    await pausedInterview(t);
    const first = await t.call("POST", "/interview-link");
    assert.equal(first.statusCode, 201, first.body);
    const second = await t.call("POST", "/interview-link");
    assert.equal(second.statusCode, 201, "asking again replaces the unredeemed link instead of answering ACTIVE_ENROLLMENT_EXISTS");
    assert.deepEqual(await verifyEnrollmentToken(pool, tokenOf(first.json().deepLink)), { ok: false, reason: "REVOKED" });
    assert.ok((await verifyEnrollmentToken(pool, tokenOf(second.json().deepLink))).ok);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.interview_enrollments WHERE trip_id = $1 AND state = 'issued'", [t.tripId])).rows[0].n, 1);
    await t.app.close();
  });

  test("AC-2 the replace route accepts a paused trip, and `recoverable` says exactly what it answers", async () => {
    const t = await dashboardTrip(await organizer());
    const paused = await pausedInterview(t);
    const issued = await t.call("POST", "/interview-link");
    const metadata = (await t.call("GET", "/interview-link")).json();
    assert.equal(metadata.recoverable, true);
    const replaced = await t.call("POST", "/interview-link/replace", { expectedEnrollmentId: issued.json().enrollmentId });
    assert.equal(replaced.statusCode, 201, replaced.body);
    assert.equal(metadata.recoverable, replaced.statusCode === 201);
    // A LIVE interview is still refused, and `recoverable` still says so.
    // Opened from the organizer's own Telegram: a different account is refused on a started trip (#519).
    await dispatchUpdate(pool, startUpdate(paused.chat, tokenOf(replaced.json().deepLink)));
    const live = (await t.call("GET", "/interview-link")).json();
    assert.equal(live.recoverable, false);
    assert.equal(live.hasInterview, true);
    const refused = await t.call("POST", "/interview-link/replace", { expectedEnrollmentId: replaced.json().enrollmentId });
    assert.equal(refused.statusCode, 409);
    await t.app.close();
  });

  test("AC-3 the resumed interview holds every answer, the facts about the person, and asks the first unanswered question", async () => {
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token, "he"));
    const answered = await answerSome(chat, 3);
    assert.equal(answered.length, 3);
    // Facts about the person, and the transient state that must NOT travel.
    await pool.query(
      `UPDATE control_plane.intake_sessions SET ui_state = ui_state || $2::jsonb WHERE telegram_chat_id = $1`,
      [chat, JSON.stringify({
        organizer_name_declined: true, known_stop_declined: true, skipped: ["bot_name"],
        last_prompt: "q:something", pending_entry: "optional", pending_say: "stale words", pending_ask: "dietary",
        suggestions: { travelers: { optionId: null, otherText: "x" } }, recap_marker: "recap:doc:interp_abcdefgh1234",
        other_pending: "dietary", reading_document_since: new Date().toISOString(),
      })]);
    const old = (await pool.query("SELECT id, answers, language FROM control_plane.intake_sessions WHERE trip_id = $1", [t.tripId])).rows[0];
    const seen = await getSessionForChat(pool, chat);
    assert.ok(seen.ok);
    const expectedNext = seen.view.nextQuestion!.id;
    await expire(t.tripId);

    const link = await t.call("POST", "/interview-link");
    assert.equal(link.statusCode, 201);
    const started = await startFromDeepLink(pool, chat, tokenOf(link.json().deepLink));
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;

    const rows = await liveSession(t.tripId);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, old.id, "a new session");
    for (const [q, value] of Object.entries(old.answers as AnswerStore)) assert.deepEqual(rows[0].answers[q], value, `${q} is on record`);
    assert.equal(rows[0].language, "he", "the expired session's language");
    // Carried: the organizer's own words about themselves.
    assert.equal(rows[0].ui_state.organizer_name, "Dana");
    assert.equal(rows[0].ui_state.organizer_name_declined, true);
    assert.equal(rows[0].ui_state.known_stop_declined, true);
    assert.deepEqual(rows[0].ui_state.skipped, ["bot_name"]);
    // Not carried: what was on screen, what was in flight, what is derived per read.
    for (const key of ["last_prompt", "pending_entry", "pending_say", "pending_ask", "suggestions", "recap_marker", "other_pending", "reading_document_since"]) {
      assert.ok(!(key in rows[0].ui_state), `${key} is transient and starts clean`);
    }
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok);
    assert.equal(view.view.nextQuestion?.id, expectedNext, "the first question still unanswered");
    // (A question whose answer the interview itself does not accept as settled, such as `organizer_identity` against
    // an empty roster, is rightly still the next one: the equality above is the real claim.)
    for (const q of [...SEEDED, ...answered.filter((id) => !(["organizer_identity"] as string[]).includes(id))]) {
      assert.notEqual(view.view.nextQuestion?.id, q, `${q} is not asked again`);
    }
    assert.equal(await lifecycleOf(t.tripId), "intake_in_progress");
    assert.deepEqual(await verifyEnrollmentToken(pool, tokenOf(link.json().deepLink)), { ok: false, reason: "ALREADY_CONSUMED" }, "the link is single-use");
    await t.app.close();
  });

  test("AC-3 a second pause resumes from the first resume: answers chain across sessions", async () => {
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    await answerSome(chat, 2);
    await expire(t.tripId);
    const second = await t.call("POST", "/interview-link");
    assert.equal((await startFromDeepLink(pool, chat, tokenOf(second.json().deepLink))).kind, "started");
    const more = await answerSome(chat, 2);
    await expire(t.tripId);
    const third = await t.call("POST", "/interview-link");
    assert.equal(third.statusCode, 201);
    assert.equal((await startFromDeepLink(pool, chat, tokenOf(third.json().deepLink))).kind, "started");
    const answers = (await liveSession(t.tripId))[0].answers as AnswerStore;
    for (const q of [...SEEDED, ...more]) assert.ok(q in answers, `${q} survived two pauses`);
    await t.app.close();
  });

  test("AC-4 the resumed opening says so in one line, in the expired session's language, and is not the introduction", async () => {
    for (const [lang, line] of [["en", "Welcome back"], ["he", "ברוכים השבים"]] as const) {
      const t = await dashboardTrip(await organizer());
      const chat = nextChat();
      await dispatchUpdate(pool, startUpdate(chat, t.token, lang));
      await answerSome(chat, 2);
      await expire(t.tripId);
      const link = await t.call("POST", "/interview-link");
      // Opened from a phone whose locale says the OTHER language: the session's own language wins.
      const reply = await opened(chat, tokenOf(link.json().deepLink), lang === "he" ? "en" : "he");
      assert.equal(reply.text, uiString("resumedOpening", lang));
      assert.ok(reply.text.includes(line), reply.text);
      assert.ok(!reply.text.includes("\n"), "one line");
      assert.ok(!reply.text.includes(uiString("introduction", lang).slice(0, 40)), "not the first-time introduction");
      assert.ok(!JSON.stringify(reply.replyMarkup ?? null).includes("c:nodoc"), "no document offer: the documents are already read");
      // And the next question is owed, by the router, on its own turn.
      const row = (await liveSession(t.tripId))[0];
      assert.equal(row.awaiting, "machine");
      assert.ok(row.router_prompt_due_at, "the router's prompt is due");
      await t.app.close();
    }
  });

  test("AC-4 after the welcome back the router asks the first unanswered question, once, and no introduction follows", async () => {
    const { renderDueRouterPrompts } = await import("../src/relay/poller.js");
    const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    await answerSome(chat, 2);
    const before = await getSessionForChat(pool, chat);
    assert.ok(before.ok);
    const expected = before.view.nextQuestion!;
    await expire(t.tripId);
    const link = await t.call("POST", "/interview-link");
    await opened(chat, tokenOf(link.json().deepLink));

    // The sweep claims every due prompt in the database; leave only this chat's.
    await pool.query("UPDATE control_plane.intake_sessions SET router_prompt_due_at = NULL WHERE telegram_chat_id <> $1", [chat]);
    const sent: { chatId: string; text: string }[] = [];
    const deps = {
      db: pool, connector: { pushInbound: () => true }, log: () => {},
      telegram: { sendMessage: async (p: { chatId: string; text: string }) => { sent.push(p); return { ok: true as const, messageId: String(sent.length) }; } },
    } as never;
    await renderDueRouterPrompts(deps, DEFAULT_STRINGS, () => {}, 0);
    assert.equal(sent.length, 1, `one message: ${JSON.stringify(sent)}`);
    assert.equal(sent[0]!.chatId, chat);
    assert.ok(!sent[0]!.text.includes(uiString("introduction", "en").slice(0, 40)), "no introduction");
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok && view.view.lastPrompt === `q:${expected.id}`, `the question on screen is ${expected.id}, recorded as such (got ${view.ok ? view.view.lastPrompt : "none"})`);
    await renderDueRouterPrompts(deps, DEFAULT_STRINGS, () => {}, 0);
    assert.equal(sent.length, 1, "and it is not asked twice");
    await t.app.close();
  });

  test("AC-3/AC-4 an interview that stopped at the summary comes back to the summary, not to a bad link", async () => {
    const { renderDueRouterPrompts } = await import("../src/relay/poller.js");
    const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    await answerSome(chat, 60);
    await pool.query(
      "UPDATE control_plane.intake_sessions SET ui_state = ui_state || '{\"finish_requested\": true, \"offered_more\": true}'::jsonb, phase = 'recap', state = 'awaiting_confirmation' WHERE telegram_chat_id = $1",
      [chat]);
    const seen = await getSessionForChat(pool, chat);
    assert.ok(seen.ok && seen.view.state === "awaiting_confirmation" && seen.view.nextQuestion === null, "the premise: stopped at the summary");
    await expire(t.tripId);
    const link = await t.call("POST", "/interview-link");
    const reply = await opened(chat, tokenOf(link.json().deepLink));
    assert.equal(reply.text, uiString("resumedOpening", "en"), "not 'this link is no good'");
    const row = (await liveSession(t.tripId))[0];
    assert.equal(row.phase, "recap");
    assert.equal(row.state, "awaiting_confirmation");
    await pool.query("UPDATE control_plane.intake_sessions SET router_prompt_due_at = NULL WHERE telegram_chat_id <> $1", [chat]);
    const sent: string[] = [];
    const deps = {
      db: pool, connector: { pushInbound: () => true }, log: () => {},
      telegram: { sendMessage: async (p: { text: string }) => { sent.push(p.text); return { ok: true as const, messageId: String(sent.length) }; } },
    } as never;
    await renderDueRouterPrompts(deps, DEFAULT_STRINGS, () => {}, 0);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.startsWith(uiString("recapHeader", "en")), sent[0]);
    await t.app.close();
  });

  test("AC-5 the card seeds only what is unanswered; a carried answer is never overwritten", async () => {
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    // The organizer corrected the destination in the interview; the return date was never recorded.
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = (answers - 'return_date') || jsonb_build_object('destination', jsonb_build_object('kind','text','schema_version',3,'text','Hokkaido')) WHERE trip_id = $1`,
      [t.tripId]);
    await pool.query("UPDATE control_plane.trips SET destination_label = 'Japan (card)', end_date = '2027-05-03' WHERE id = $1", [t.tripId]);
    await expire(t.tripId);
    const link = await t.call("POST", "/interview-link");
    assert.equal((await startFromDeepLink(pool, chat, tokenOf(link.json().deepLink))).kind, "started");
    const answers = (await liveSession(t.tripId))[0].answers as AnswerStore;
    assert.equal(answers.destination?.kind === "text" && answers.destination.text, "Hokkaido", "the interview's answer stands over the card");
    assert.equal(answers.return_date?.kind === "text" && answers.return_date.text, "2027-05-03", "the unanswered question is seeded from the card");
    assert.equal(answers.departure_date?.kind === "text" && answers.departure_date.text, "2027-04-12");
    await t.app.close();
  });

  test("AC-6 documents already read stay attached to the trip, are not duplicated, and the staged source document travels", async () => {
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    const docId = id("doc"), extractionId = id("extr");
    await pool.query(
      `INSERT INTO control_plane.trip_documents(id, trip_id, content_digest, byte_size, mime, ingest_state) VALUES ($1, $2, $3, 10, 'application/pdf', 'unstored')`,
      [docId, t.tripId, `sha256:${"a".repeat(64)}`]);
    await pool.query(
      `INSERT INTO control_plane.trip_document_extractions(id, document_id, trip_id, reader_version, extractor_version, processing_key, status, text) VALUES ($1, $2, $3, 'r1', 'e1', 'pk1', 'ok', 'hotel in Kyoto')`,
      [extractionId, docId, t.tripId]);
    await pool.query("UPDATE control_plane.intake_sessions SET source_document = $2::jsonb WHERE trip_id = $1", [t.tripId, JSON.stringify({ filename: "plan.pdf", text: "hotel in Kyoto", savedAt: "2026-11-04T10:00:00Z" })]);
    await expire(t.tripId);
    const link = await t.call("POST", "/interview-link");
    assert.equal((await startFromDeepLink(pool, chat, tokenOf(link.json().deepLink))).kind, "started");
    assert.deepEqual((await pool.query("SELECT id FROM control_plane.trip_documents WHERE trip_id = $1", [t.tripId])).rows.map((r) => r.id), [docId]);
    assert.deepEqual((await pool.query("SELECT id, status, text FROM control_plane.trip_document_extractions WHERE trip_id = $1", [t.tripId])).rows, [{ id: extractionId, status: "ok", text: "hotel in Kyoto" }], "no second read, no second row");
    assert.equal((await liveSession(t.tripId))[0].source_document?.filename, "plan.pdf");
    await t.app.close();
  });

  test("AC-7 the bot points an organizer who has a dashboard to it, and anyone else to whoever set the trip up", async () => {
    const sentFor = async (chat: string, text: string) => {
      const sent: string[] = [];
      const deps = {
        db: pool, connector: { pushInbound: () => true }, log: () => {},
        telegram: { sendMessage: async (p: { text: string }) => { sent.push(p.text); return { ok: true as const, messageId: "1" }; } },
      } as never;
      await applyDecision({ kind: "interview_to_gateway", chatId: chat, sessionId: "x", hadAttachment: false, event: { text, message_id: "9001", message_type: "text", source: { chat_id: chat } } } as never, deps);
      return sent;
    };
    const withDashboard = await dashboardTrip(await organizer());
    const a = await pausedInterview(withDashboard);
    assert.deepEqual(await sentFor(a.chat, "we also want Nara"), [uiString("expiredWriteAfterDashboard", "en")]);
    await withDashboard.app.close();

    const noDashboard = await bareTrip(await organizer());
    const b = await pausedInterview(noDashboard);
    assert.deepEqual(await sentFor(b.chat, "we also want Nara"), [uiString("expiredWriteAfter", "en")]);
  });

  test("AC-8 a trip with no dashboard (Telegram signup, operator invitation) resumes from a re-requested link", async () => {
    const owner = await organizer();
    const trip = await bareTrip(owner);
    const paused = await pausedInterview(trip, 2, "he");
    assert.ok(paused.answered.length > 0);
    assert.equal(await lifecycleOf(trip.tripId), "intake_in_progress");
    const reissued = await issueEnrollment(pool, owner, trip.tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(reissued.ok, "no TRIP_NOT_DRAFT");
    if (!reissued.ok) return;
    const started = await startFromDeepLink(pool, paused.chat, reissued.token);
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;
    const row = (await liveSession(trip.tripId))[0];
    for (const [q, value] of Object.entries(paused.answers)) assert.deepEqual(row.answers[q], value, q);
    assert.equal(row.language, "he");
  });

  test("AC-9 a confirmed interview is unaffected: no new link, no resume, not paused", async () => {
    const t = await dashboardTrip(await organizer());
    const owner = t.userId;
    await pausedInterview(t);
    // A confirmed session on the trip, whatever the lifecycle says.
    const extra = await issueEnrollment(pool, owner, t.tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(extra.ok);
    await pool.query(
      `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, state, answers, phase) VALUES ($1, $2, $3, $4, 'confirmed', '{}'::jsonb, 'confirmed')`,
      [id("sess"), t.tripId, owner, extra.enrollmentId]);
    // Even a confirmed row that somehow also carries an expiry is an interview that happened, not a paused one.
    await pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE trip_id = $1 AND state = 'confirmed'", [t.tripId]);
    assert.equal((await t.call("GET", "")).json().interview.paused, false);
    assert.equal((await t.call("POST", "/interview-link")).statusCode, 409);
    assert.deepEqual(await issueEnrollment(pool, owner, t.tripId, { enrollmentTtlSeconds: 3600 }), { ok: false, reason: "TRIP_NOT_DRAFT" });
    assert.equal((await t.call("GET", "/interview-link")).json().hasInterview, true);
    // And the normal confirmed lifecycle: a confirmed trip refuses a link outright.
    await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed' WHERE id = $1", [t.tripId]);
    assert.equal((await t.call("POST", "/interview-link")).statusCode, 409);
    await t.app.close();
  });

  test("a trip in intake_in_progress with a LIVE interview is not resumable: no second session, no link", async () => {
    const t = await dashboardTrip(await organizer());
    await dispatchUpdate(pool, startUpdate(nextChat(), t.token));
    assert.equal((await t.call("POST", "/interview-link")).statusCode, 409);
    assert.equal((await t.call("GET", "")).json().interview.paused, false);
    await t.app.close();
  });

  // Boundary review of #517, finding 1. A link may be forwarded; the answers of a paused interview (travellers,
  // dietary needs, a flight) are the owner's, and only the owner's chat may be handed them back.
  async function pausedAtSummary(t: Awaited<ReturnType<typeof dashboardTrip>>, marker: string) {
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    await answerSome(chat, 60);
    await pool.query(
      `UPDATE control_plane.intake_sessions
          SET answers = answers || $2::jsonb,
              ui_state = ui_state || $3::jsonb, phase = 'recap', state = 'awaiting_confirmation'
        WHERE telegram_chat_id = $1 AND expired_at IS NULL`,
      [chat, JSON.stringify({
        travelers: { kind: "structured", schema_version: 3, data: [{ name: `${marker}-traveller` }] },
        dietary: { kind: "text", schema_version: 3, text: `${marker}-peanut-allergy` },
      }), JSON.stringify({ organizer_name: `${marker}-name`, typed_flights: [`${marker.slice(0, 2).toUpperCase()}8801`], finish_requested: true, offered_more: true })]);
    await expire(t.tripId);
    return chat;
  }

  test("#519 a forwarded link: a stranger's chat is refused outright and reaches nothing of the owner's; the owner's own chat still resumes", async () => {
    const t = await dashboardTrip(await organizer());
    const ownerChat = await pausedAtSummary(t, "OWNER");
    const forwarded = await t.call("POST", "/interview-link");
    assert.equal(forwarded.statusCode, 201);
    const stranger = nextChat();
    const refused = await dispatchUpdate(pool, startUpdate(stranger, tokenOf(forwarded.json().deepLink)));
    assert.equal(refused.kind, "multi_reply", "never reaches startSession: no session, no link, no answers");
    assert.equal((await liveSession(t.tripId)).length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [stranger])).rows[0].n, 0);
    assert.ok(!JSON.stringify(refused).includes("OWNER"));
    // The link was not spent: the owner's own chat resumes with it.
    const ownerReply = await opened(ownerChat, tokenOf(forwarded.json().deepLink));
    assert.equal(ownerReply.text, uiString("resumedOpening", "en"));
    assert.deepEqual((await liveSession(t.tripId))[0].answers.dietary, { kind: "text", schema_version: 3, text: "OWNER-peanut-allergy" });
    await t.app.close();
  });

  test("#517 survives #519: with the owner's Telegram Unlinked (nothing bound), a new account is bound and gets the ordinary opening and none of the owner's answers", async () => {
    const { renderDueRouterPrompts } = await import("../src/relay/poller.js");
    const { DEFAULT_STRINGS } = await import("../src/relay/dispatch.js");
    const t = await dashboardTrip(await organizer());
    const ownerChat = await pausedAtSummary(t, "OWNER");
    // The owner Unlinked their Telegram from the dashboard: the account has no Telegram bound, so the next account is bound.
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET revoked_at = now(), revoked_reason = 'owner_unlinked' WHERE trip_id = $1", [t.tripId]);
    const forwarded = await t.call("POST", "/interview-link");
    assert.equal(forwarded.statusCode, 201);

    const stranger = nextChat();
    const reply = await opened(stranger, tokenOf(forwarded.json().deepLink));
    assert.notEqual(reply.text, uiString("resumedOpening", "en"), "no welcome back for someone who was not in the interview");
    assert.ok(reply.text.endsWith(uiString("introduction", "en")), "the ordinary, seeded opening");
    assert.ok(JSON.stringify(reply.replyMarkup).includes("c:nodoc"), "with the document offer");
    const [row] = await liveSession(t.tripId);
    assert.equal(row.telegram_chat_id, stranger);
    assert.deepEqual(Object.keys(row.answers).sort(), [...SEEDED].sort(), "the card seed only");
    assert.ok(!JSON.stringify(row).includes("OWNER"), "nothing of the owner's is on the stranger's session");
    assert.equal(row.router_prompt_due_at, null, "and no summary is queued for them");
    assert.equal(row.phase, "opening");
    await pool.query("UPDATE control_plane.intake_sessions SET router_prompt_due_at = NULL WHERE telegram_chat_id <> $1", [stranger]);
    const sent: string[] = [];
    const deps = {
      db: pool, connector: { pushInbound: () => true }, log: () => {},
      telegram: { sendMessage: async (p: { text: string }) => { sent.push(p.text); return { ok: true as const, messageId: String(sent.length) }; } },
    } as never;
    await renderDueRouterPrompts(deps, DEFAULT_STRINGS, () => {}, 0);
    assert.ok(!sent.some((text) => text.includes("OWNER")), `no recap with the owner's details reached the stranger: ${JSON.stringify(sent)}`);

    // The closed session is still the owner's, untouched.
    const closed = await pool.query("SELECT answers FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [ownerChat]);
    assert.deepEqual(closed.rows[0].answers.dietary, { kind: "text", schema_version: 3, text: "OWNER-peanut-allergy" });
    await t.app.close();
  });

  test("a Telegram account already linked to the trip for this user resumes from a different chat; a revoked link does not", async () => {
    const { digestTelegramId } = await import("../src/identity.js");
    const t = await dashboardTrip(await organizer());
    const ownerChat = await pausedAtSummary(t, "LINKED");
    const newChat = nextChat();
    const insertLink = (revoked: boolean) => pool.query(
      `INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, 'enrollment_redemption', ${revoked ? "now()" : "NULL"}, ${revoked ? "'owner_unlinked'" : "NULL"})`,
      [id("otl"), t.userId, t.tripId, digestTelegramId(newChat)]);
    await insertLink(true);
    const first = await t.call("POST", "/interview-link");
    // A revoked link is not an organizer link, and the owner's own Telegram is still the bound one: refused outright (#519).
    const refused = await dispatchUpdate(pool, startUpdate(newChat, tokenOf(first.json().deepLink)));
    assert.equal(refused.kind, "multi_reply", "a revoked link is not an organizer link");
    assert.ok(!JSON.stringify(await liveSession(t.tripId)).includes("LINKED"));
    assert.equal((await liveSession(t.tripId)).length, 0);
    // Now the account holds a live link from before this redemption.
    await pool.query("DELETE FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1", [t.tripId]);
    await insertLink(false);
    const second = await t.call("POST", "/interview-link");
    const accepted = await opened(newChat, tokenOf(second.json().deepLink));
    assert.equal(accepted.text, uiString("resumedOpening", "en"));
    assert.equal(JSON.stringify((await liveSession(t.tripId))[0].answers).includes("LINKED-peanut-allergy"), true);
    void ownerChat;
    await t.app.close();
  });

  test("a second owner does not inherit the first owner's session; paused stays a per-trip fact", async () => {
    const first = await organizer("Olga");
    const t = await dashboardTrip(first);
    const chat = await pausedAtSummary(t, "OLGA");
    const second = await organizer("Oren");
    await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access) VALUES ($1, $2, $3, 'owner', 'active', true)", [id("memb"), t.tripId, second]);
    const s2 = await session(second);
    const h2 = { cookie: s2.cookie, "x-csrf-token": s2.csrf };
    assert.equal((await t.call("GET", "", undefined, h2)).json().interview.paused, true, "the trip is paused for both owners");
    const link = await t.call("POST", "/interview-link", undefined, h2);
    assert.equal(link.statusCode, 201, link.body);
    // Opened in the FIRST owner's own chat, so only the user check can stop it.
    const reply = await opened(chat, tokenOf(link.json().deepLink));
    assert.notEqual(reply.text, uiString("resumedOpening", "en"));
    const [row] = await liveSession(t.tripId);
    assert.equal(row.user_id, second);
    assert.ok(!JSON.stringify(row).includes("OLGA"), "none of the first owner's answers");
    await t.app.close();
  });

  test("a suspended owner is not handed a link, for a draft or a paused trip", async () => {
    const owner = await organizer();
    const bare = await bareTrip(owner);
    await pool.query("DELETE FROM control_plane.interview_enrollments WHERE trip_id = $1", [bare.tripId]);
    await pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [owner]);
    assert.deepEqual(await issueEnrollment(pool, owner, bare.tripId, { enrollmentTtlSeconds: 3600 }), { ok: false, reason: "NOT_OWNER" });
    await pool.query("UPDATE control_plane.users SET status = 'active' WHERE id = $1", [owner]);
    const issued = await issueEnrollment(pool, owner, bare.tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, issued.token));
    await expire(bare.tripId);
    await pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [owner]);
    assert.deepEqual(await issueEnrollment(pool, owner, bare.tripId, { enrollmentTtlSeconds: 3600 }), { ok: false, reason: "NOT_OWNER" });
    await pool.query("UPDATE control_plane.users SET status = 'active' WHERE id = $1", [owner]);
    assert.ok((await issueEnrollment(pool, owner, bare.tripId, { enrollmentTtlSeconds: 3600 })).ok);
  });

  test("once resumed the interview is live again: not paused (the older closed session is still there), no second link, no second resume", async () => {
    const t = await dashboardTrip(await organizer());
    const chat = nextChat();
    await dispatchUpdate(pool, startUpdate(chat, t.token));
    await expire(t.tripId);
    const link = await t.call("POST", "/interview-link");
    assert.equal((await startFromDeepLink(pool, chat, tokenOf(link.json().deepLink))).kind, "started");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1 AND expired_at IS NOT NULL", [t.tripId])).rows[0].n, 1, "the closed session is kept");
    assert.equal((await t.call("GET", "")).json().interview.paused, false);
    const metadata = (await t.call("GET", "/interview-link")).json();
    assert.equal(metadata.hasInterview, true);
    assert.equal(metadata.recoverable, false);
    assert.equal((await t.call("POST", "/interview-link")).statusCode, 409);
    // A link issued earlier and redeemed late finds a live interview and starts nothing.
    const stray = await issueEnrollment(pool, t.userId, t.tripId, { enrollmentTtlSeconds: 3600 });
    assert.deepEqual(stray, { ok: false, reason: "TRIP_NOT_DRAFT" });
    await t.app.close();
  });

  test("a trip in intake_in_progress with no session at all keeps refusing (TRIP_NOT_DRAFT), as before", async () => {
    const owner = await organizer();
    const trip = await bareTrip(owner);
    await pool.query("DELETE FROM control_plane.interview_enrollments WHERE trip_id = $1", [trip.tripId]);
    await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress' WHERE id = $1", [trip.tripId]);
    assert.deepEqual(await issueEnrollment(pool, owner, trip.tripId, { enrollmentTtlSeconds: 3600 }), { ok: false, reason: "TRIP_NOT_DRAFT" });
  });

  test("a link for a trip that is not paused and not a draft redeems to TRIP_NOT_DRAFT (the HTTP/MCP start is unchanged)", async () => {
    const owner = await organizer();
    const trip = await bareTrip(owner);
    await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress' WHERE id = $1", [trip.tripId]);
    assert.deepEqual(await startSession(pool, trip.token), { ok: false, reason: "TRIP_NOT_DRAFT" });
  });

  test("AC-10 only the trip's owner with dashboard access can get a link; everyone else is a 404 and nothing is issued", async () => {
    const t = await dashboardTrip(await organizer());
    await pausedInterview(t);
    const outsider = await session(await organizer("Eve"));
    const memberId = await organizer("Moe");
    await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access) VALUES ($1, $2, $3, 'member', 'active', true)", [id("memb"), t.tripId, memberId]);
    const member = await session(memberId);
    const noDashId = await organizer("Ned");
    await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access) VALUES ($1, $2, $3, 'owner', 'active', false)", [id("memb"), t.tripId, noDashId]);
    const noDash = await session(noDashId);
    const before = (await pool.query("SELECT count(*)::int AS n FROM control_plane.interview_enrollments WHERE trip_id = $1", [t.tripId])).rows[0].n;
    for (const who of [outsider, member, noDash]) {
      const headers = { cookie: who.cookie, "x-csrf-token": who.csrf };
      assert.equal((await t.call("POST", "/interview-link", undefined, headers)).statusCode, 404);
      assert.equal((await t.call("GET", "/interview-link", undefined, headers)).statusCode, 404);
      assert.equal((await t.call("POST", "/interview-link/replace", { expectedEnrollmentId: "enrl_abcdefgh1234" }, headers)).statusCode, 404);
    }
    assert.equal((await t.app.inject({ method: "POST", url: `/v1/trips/${t.tripId}/interview-link` })).statusCode, 401, "no session");
    assert.equal((await t.app.inject({ method: "POST", url: `/v1/trips/${t.tripId}/interview-link`, headers: { cookie: t.headers.cookie } })).statusCode, 403, "no CSRF token");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.interview_enrollments WHERE trip_id = $1", [t.tripId])).rows[0].n, before, "nothing was issued to a non-owner");
    // The enrollment functions themselves refuse a non-owner too, paused or not.
    assert.deepEqual(await issueEnrollment(pool, memberId, t.tripId, { enrollmentTtlSeconds: 3600 }), { ok: false, reason: "NOT_OWNER" });
    const live = await issueEnrollment(pool, t.userId, t.tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(live.ok);
    if (live.ok) assert.deepEqual(await replaceEnrollment(pool, memberId, t.tripId, live.enrollmentId, { enrollmentTtlSeconds: 3600 }), { ok: false, reason: "NOT_OWNER" });
    // The owner, for contrast, is served.
    assert.equal((await t.call("POST", "/interview-link")).statusCode, 201);
    await t.app.close();
  });
});
