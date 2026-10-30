/**
 * #438: a trip created on the dashboard seeds the interview.
 *
 * Staging acceptance run, 2026-10-19: the organizer created a trip on the dashboard with a destination and dates,
 * started the interview from it, and was asked for the destination and the dates again. Each test below is named
 * after the acceptance criterion in docs/specs/sprint-8/438-dashboard-trip-seeds-interview.md that it proves.
 *
 * The trip is created the way the dashboard creates it -- POST /v1/trips through the portal app, then POST
 * /v1/trips/:id/interview-link -- and the interview is opened the way Telegram opens it, with /start <token> through
 * `dispatchUpdate`, so what is asserted is what the organizer is sent, not a function's return value.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { issueEnrollment } from "../src/enrollment.js";
import { applyMigrations } from "../src/migrations.js";
import { renderDocumentOffer, renderSuggestion, startFromDeepLink, suggestionNoCallbackData, suggestionYesCallbackData } from "../src/chat-router.js";
import {
  INTAKE_QUESTIONS,
  confirmIntakeForChat,
  getSessionForChat,
  queueInboundMessage,
  seedAnswersFromCard,
  startSession,
  type AnswerStore,
  type SessionView,
} from "../src/interview.js";
import { readableDate, uiString } from "../src/intake-copy.js";
import { setInterpretPath } from "../src/interpret.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { applyDecision, flushSettledInboundBursts } from "../src/relay/poller.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const SEEDED = ["destination", "departure_date", "return_date", "trip_type"] as const;
const ISO = /\d{4}-\d{2}-\d{2}/;

let pool: pg.Pool;
let chatSeq = 880000000;
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

/** An organizer account; `givenName` is what they told the product, null for an account that never did. */
async function organizer(givenName: string | null, displayName = "kin.test+local"): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name, given_name) VALUES ($1, 'active', $2, $3)", [userId, displayName, givenName]);
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

/** The trip card the dashboard's new-trip form writes, then the interview link the dashboard hands out. */
async function dashboardTrip(userId: string, body: Record<string, unknown>) {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const s = await session(userId);
    const created = await app.inject({ method: "POST", url: "/v1/trips", headers: { cookie: s.cookie, "x-csrf-token": s.csrf }, payload: body });
    assert.equal(created.statusCode, 201, created.body);
    const tripId = created.json().id as string;
    const link = await app.inject({ method: "POST", url: `/v1/trips/${tripId}/interview-link`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    assert.equal(link.statusCode, 201, link.body);
    const token = new URL(link.json().deepLink).searchParams.get("start")!;
    return { tripId, token };
  } finally {
    await app.close();
  }
}

/** A trip made the way Telegram signup and an operator's invitation make it: a bare draft, no card. */
async function bareTrip(userId: string) {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
  await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')", [id("memb"), tripId, userId]);
  const issued = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  return { tripId, token: issued.token };
}

function startUpdate(chatId: string, token: string, firstName = "Telegram-Dror", languageCode?: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: 777, first_name: firstName, ...(languageCode ? { language_code: languageCode } : {}) },
      chat: { id: chatId, type: "private" },
      text: `/start ${token}`,
    },
  } as TelegramUpdate;
}

/** The opening the organizer is sent when they open `token`'s link. */
async function opening(chatId: string, token: string, firstName?: string, languageCode?: string) {
  const decision = await dispatchUpdate(pool, startUpdate(chatId, token, firstName, languageCode));
  assert.equal(decision.kind, "reply");
  if (decision.kind !== "reply") throw new Error("unreachable");
  return decision.reply;
}

async function answersOf(tripId: string): Promise<AnswerStore> {
  const r = await pool.query("SELECT answers FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
  assert.equal(r.rowCount, 1);
  return r.rows[0].answers as AnswerStore;
}
const textOf = (a: AnswerStore, q: string) => (a[q]?.kind === "text" ? (a[q] as { text: string }).text : undefined);

const JAPAN = { destination: "Japan", tripType: "family", startDate: "2027-04-12", endDate: "2027-04-26" };

// ── The pure seed ─────────────────────────────────────────────────────────────

describe("seedAnswersFromCard", () => {
  test("a full card seeds four answers", () => {
    const seed = seedAnswersFromCard({ destination: "Japan", startDate: "2027-04-12", endDate: "2027-04-26", tripType: "family" });
    assert.deepEqual(Object.keys(seed).sort(), [...SEEDED].sort());
    assert.equal(textOf(seed, "destination"), "Japan");
    assert.equal(textOf(seed, "departure_date"), "2027-04-12");
    assert.equal(textOf(seed, "return_date"), "2027-04-26");
    assert.equal(seed.trip_type?.kind, "choice");
    assert.equal(seed.trip_type?.kind === "choice" && seed.trip_type.option_id, "family");
  });

  test("a start date alone seeds only the departure", () => {
    const seed = seedAnswersFromCard({ destination: "Japan", startDate: "2027-04-12", endDate: null, tripType: null });
    assert.deepEqual(Object.keys(seed).sort(), ["departure_date", "destination"]);
  });

  test("an invalid value is not seeded", () => {
    const seed = seedAnswersFromCard({ destination: "x".repeat(201), startDate: "2027-02-30", endDate: "not a date", tripType: "couple" });
    assert.deepEqual(Object.keys(seed), ["trip_type"], "a destination over the question's maxLength, and two non-days, are left to be asked");
  });

  test("dates out of order are not seeded", () => {
    const seed = seedAnswersFromCard({ destination: "Japan", startDate: "2027-04-26", endDate: "2027-04-12", tripType: null });
    assert.deepEqual(Object.keys(seed), ["destination"]);
  });

  test("group and other are not seeded", () => {
    for (const tripType of ["group", "other", "friends", ""]) {
      assert.deepEqual(Object.keys(seedAnswersFromCard({ destination: null, startDate: null, endDate: null, tripType })), [], tripType);
    }
    assert.equal(seedAnswersFromCard({ destination: null, startDate: null, endDate: null, tripType: "couple" }).trip_type?.kind === "choice", true);
  });

  test("whitespace around a destination is trimmed, and a blank one is not seeded", () => {
    assert.equal(textOf(seedAnswersFromCard({ destination: "  Kyoto ", startDate: null, endDate: null, tripType: null }), "destination"), "Kyoto");
    assert.deepEqual(Object.keys(seedAnswersFromCard({ destination: "   ", startDate: null, endDate: null, tripType: null })), []);
  });
});

// ── The opening, as copy ──────────────────────────────────────────────────────

describe("the seeded opening, as copy", () => {
  const seeded = { destination: "Japan", departureDate: "2027-04-12", returnDate: "2027-04-26", organizerName: "Dana" };

  test("AC-2 the English and the Hebrew opening name the organizer, the destination and both dates in words, and ask for none", () => {
    for (const language of ["en", "he"] as const) {
      for (const returning of [false, true]) {
        const text = renderDocumentOffer(language, returning, seeded).text;
        assert.ok(text.includes("Dana"), `${language}/${returning}: the name`);
        assert.ok(text.includes("Japan"), `${language}/${returning}: the destination`);
        assert.ok(text.includes(readableDate("2027-04-12", language)!), `${language}/${returning}: the departure in words`);
        assert.ok(text.includes(readableDate("2027-04-26", language)!), `${language}/${returning}: the return in words`);
        assert.doesNotMatch(text, ISO, `${language}/${returning}: no YYYY-MM-DD`);
        assert.ok(text.endsWith(uiString(returning ? "introductionReturning" : "introduction", language)), `${language}/${returning}: the rest of the introduction is unchanged`);
        for (const asked of [INTAKE_QUESTIONS.find((q) => q.id === "destination")!.prompt, INTAKE_QUESTIONS.find((q) => q.id === "departure_date")!.prompt]) {
          assert.ok(!text.includes(asked), `${language}: the question is not asked`);
        }
      }
    }
  });

  test("AC-5 a card with no dates names only the destination; one with a start date names only that", () => {
    const none = renderDocumentOffer("en", false, { ...seeded, departureDate: null, returnDate: null }).text;
    assert.ok(none.includes("Japan"));
    assert.ok(!none.includes("2027") && !/April/.test(none), "no date is invented");
    const startOnly = renderDocumentOffer("en", false, { ...seeded, returnDate: null }).text;
    assert.ok(startOnly.includes(readableDate("2027-04-12", "en")!));
    assert.ok(!startOnly.includes(readableDate("2027-04-26", "en")!));
  });

  test("with no name the opening still states the starting point, without a greeting to nobody", () => {
    const text = renderDocumentOffer("en", false, { ...seeded, organizerName: null }).text;
    assert.ok(text.includes("Japan"));
    assert.ok(!/Hi\s*,|Hi\s+—|undefined|null/.test(text));
  });

  test("AC-7 an unseeded opening is byte-identical to today's", () => {
    for (const language of ["en", "he"] as const) {
      assert.equal(renderDocumentOffer(language, false).text, uiString("introduction", language));
      assert.equal(renderDocumentOffer(language, true).text, uiString("introductionReturning", language));
      assert.equal(renderDocumentOffer(language, false, undefined).text, uiString("introduction", language));
    }
  });
});

// ── The session start ─────────────────────────────────────────────────────────

describe("a trip created on the dashboard", { skip }, () => {
  test("AC-1 the session starts with the card's four answers and its first question is none of them", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, JAPAN);
    const chat = nextChat();
    const started = await startFromDeepLink(pool, chat, token);
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;

    // Read straight off the row, not off the returned view: the answers are in the session the transaction created.
    const answers = await answersOf(tripId);
    assert.deepEqual(Object.keys(answers).sort(), [...SEEDED].sort());
    assert.equal(textOf(answers, "destination"), "Japan");
    assert.equal(textOf(answers, "departure_date"), "2027-04-12");
    assert.equal(textOf(answers, "return_date"), "2027-04-26");
    assert.equal(answers.trip_type?.kind === "choice" && answers.trip_type.option_id, "family");

    const first = started.view.nextQuestion;
    assert.ok(first, "there is a first question");
    assert.ok(!(SEEDED as readonly string[]).includes(first!.id), `the first question is ${first!.id}, not one of the four`);
    const stored = await getSessionForChat(pool, chat);
    assert.ok(stored.ok && stored.view.nextQuestion?.id === first!.id, "and a later read of the session agrees");
  });

  test("AC-1 the seed and the session are one transaction: a start that fails after the seed leaves no session and the trip still a draft", async () => {
    const user = await organizer("Dana");
    const first = await dashboardTrip(user, JAPAN);
    const second = await dashboardTrip(user, { destination: "Peru", tripType: "couple", startDate: "2028-01-05", endDate: "2028-01-19" });
    const chat = nextChat();
    assert.equal((await startFromDeepLink(pool, chat, first.token)).kind, "started");
    // The same chat already holds a live interview, so the session insert (after the seed was built) violates
    // the one-live-session-per-chat index: the whole start must roll back, seed and lifecycle change included.
    const failure = await startSession(pool, second.token, () => {}, undefined, chat).then(() => null, (e) => e);
    assert.ok(failure, "the second start fails");
    const sessions = await pool.query("SELECT 1 FROM control_plane.intake_sessions WHERE trip_id = $1", [second.tripId]);
    assert.equal(sessions.rowCount, 0, "no session, so no half-seeded one");
    const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [second.tripId]);
    assert.equal(trip.rows[0].lifecycle_state, "draft", "and the trip did not move");
  });

  test("AC-2 the opening the organizer is sent greets them by name, states the destination and dates in words, and keeps the document offer", async () => {
    const user = await organizer("Dana");
    const { token } = await dashboardTrip(user, JAPAN);
    const reply = await opening(nextChat(), token, "Telegram-Dror");
    assert.ok(reply.text.startsWith("Hi Dana") || reply.text.includes("Dana"), reply.text);
    assert.ok(!reply.text.includes("Telegram-Dror"), "the account's own name wins over the Telegram first name");
    assert.ok(reply.text.includes("Japan"));
    assert.ok(reply.text.includes(readableDate("2027-04-12", "en")!));
    assert.ok(reply.text.includes(readableDate("2027-04-26", "en")!));
    assert.doesNotMatch(reply.text, ISO);
    assert.ok(reply.text.endsWith(uiString("introduction", "en")));
    assert.ok(JSON.stringify(reply.replyMarkup).includes("c:nodoc"), "the document offer's button is still there");
  });

  test("AC-2 a Hebrew interview greets in Hebrew", async () => {
    const user = await organizer("דנה");
    const { token } = await dashboardTrip(user, JAPAN);
    const reply = await opening(nextChat(), token, "Dror", "he");
    assert.ok(reply.text.includes("דנה"), reply.text);
    assert.ok(reply.text.includes(readableDate("2027-04-12", "he")!));
    assert.ok(reply.text.endsWith(uiString("introduction", "he")));
    assert.doesNotMatch(reply.text, ISO);
  });

  test("AC-2 an account with no name of its own is greeted by its Telegram first name, never by its email-derived display name", async () => {
    const user = await organizer(null, "dror.elul+kin7");
    const { token } = await dashboardTrip(user, JAPAN);
    const reply = await opening(nextChat(), token, "Dror");
    assert.ok(reply.text.includes("Dror"), reply.text);
    assert.ok(!reply.text.includes("dror.elul"), "the display name is never used");
    // And with neither, the opening states the starting point without a name.
    const nobody = await organizer(null, "dror.elul+kin8");
    const second = await dashboardTrip(nobody, JAPAN);
    const chat = nextChat();
    const decision = await dispatchUpdate(pool, { update_id: 2, message: { message_id: 8, from: { id: 778 }, chat: { id: chat, type: "private" }, text: `/start ${second.token}` } } as TelegramUpdate);
    assert.equal(decision.kind, "reply");
    if (decision.kind !== "reply") return;
    assert.ok(decision.reply.text.includes("Japan") && !decision.reply.text.includes("dror.elul"), decision.reply.text);
  });

  test("AC-3 answering every remaining question never puts one of the four on screen, and the summary lists all four", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, JAPAN);
    const chat = nextChat();
    assert.equal((await startFromDeepLink(pool, chat, token)).kind, "started");
    const put = (q: string, value: unknown) => pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1`,
      [chat, q, JSON.stringify(value)]);
    const onScreen: string[] = [];
    for (let step = 0; step < 20; step++) {
      const view = await getSessionForChat(pool, chat);
      assert.ok(view.ok);
      const next = view.view.nextQuestion;
      if (!next) break;
      onScreen.push(next.id);
      await put(next.id, next.id === "travelers"
        ? { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] }
        : next.type === "choice" ? { kind: "choice", schema_version: 3, option_id: next.options![0]!.id, other_text: null }
        : { kind: "text", schema_version: 3, text: "Dana" });
    }
    assert.ok(onScreen.length > 0);
    for (const q of SEEDED) assert.ok(!onScreen.includes(q), `${q} was never asked (asked: ${onScreen.join(", ")})`);
    await pool.query("UPDATE control_plane.intake_sessions SET ui_state = ui_state || '{\"finish_requested\": true}'::jsonb WHERE telegram_chat_id = $1", [chat]);
    await pool.query("UPDATE control_plane.intake_sessions SET phase = 'recap' WHERE telegram_chat_id = $1", [chat]);
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok && view.view.recap, "the summary is up");
    const ids = view.view.recap!.map((r) => r.questionId);
    for (const q of SEEDED) assert.ok(ids.includes(q), `the summary lists ${q}`);
    void tripId;
  });

  test("AC-5 a card with only a start date seeds only the departure and the return date is asked", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, { destination: "Japan", tripType: "couple", startDate: "2027-04-12" });
    const chat = nextChat();
    assert.equal((await startFromDeepLink(pool, chat, token)).kind, "started");
    const answers = await answersOf(tripId);
    assert.deepEqual(Object.keys(answers).sort(), ["departure_date", "destination", "trip_type"]);
    // Walk to the point where the dates come up: the return date is the question.
    const asked: string[] = [];
    for (let step = 0; step < 20; step++) {
      const view = await getSessionForChat(pool, chat);
      assert.ok(view.ok);
      const next = view.view.nextQuestion;
      if (!next) break;
      asked.push(next.id);
      if (next.id === "return_date") break;
      await pool.query(
        `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1`,
        [chat, next.id, JSON.stringify(next.id === "travelers" ? { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] } : { kind: "text", schema_version: 3, text: "x" })]);
    }
    assert.ok(asked.includes("return_date"), `the return date comes up as a question (asked: ${asked.join(", ")})`);
    assert.ok(!asked.includes("departure_date"));
  });

  test("AC-5 a card with no dates seeds no date and the opening names only the destination", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, { destination: "Japan", tripType: "family" });
    const reply = await opening(nextChat(), token);
    const answers = await answersOf(tripId);
    assert.ok(!("departure_date" in answers) && !("return_date" in answers));
    assert.ok(reply.text.includes("Japan") && !/20\d\d/.test(reply.text.split(uiString("introduction", "en"))[0]!), reply.text);
  });

  test("AC-6 a card value the interview would not accept is not seeded, and the session still starts", async () => {
    const user = await organizer("Dana");
    // The card's own constraint lets a blank destination through; validateAnswer does not.
    const { tripId, token } = await dashboardTrip(user, { destination: "Japan", tripType: "family", startDate: "2027-04-12", endDate: "2027-04-26" });
    await pool.query("UPDATE control_plane.trips SET destination_label = '   ' WHERE id = $1", [tripId]);
    const chat = nextChat();
    const lines: string[] = [];
    const started = await startFromDeepLink(pool, chat, token, (line) => lines.push(line));
    assert.equal(started.kind, "started");
    const skippedLine = lines.find((l) => l.includes("interview.session_seed_skipped"));
    assert.ok(skippedLine, "a refused card value is logged, so it is not invisible");
    assert.deepEqual(JSON.parse(skippedLine!).skipped, ["destination"]);
    assert.ok(!skippedLine!.includes("2027"), "ids only");
    const answers = await answersOf(tripId);
    assert.ok(!("destination" in answers), "the blank destination is not seeded");
    assert.deepEqual(Object.keys(answers).sort(), ["departure_date", "return_date", "trip_type"]);
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok && view.view.nextQuestion?.id === "destination", "and the destination is the question");
  });

  test("a group or other dashboard type is not seeded: the interview asks the type as today", async () => {
    const user = await organizer("Dana");
    for (const tripType of ["group", "other"]) {
      const { tripId, token } = await dashboardTrip(user, { ...JAPAN, tripType });
      assert.equal((await startFromDeepLink(pool, nextChat(), token)).kind, "started");
      const answers = await answersOf(tripId);
      assert.ok(!("trip_type" in answers), tripType);
      assert.ok("destination" in answers && "departure_date" in answers);
    }
  });

  test("AC-7 a trip with no card starts with answers '{}' and the opening is today's, byte for byte", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await bareTrip(user);
    const reply = await opening(nextChat(), token, "Telegram-Dror");
    assert.equal(reply.text, uiString("introduction", "en"));
    assert.deepEqual(await answersOf(tripId), {});
    const ui = await pool.query("SELECT ui_state FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    assert.deepEqual(ui.rows[0].ui_state, {}, "nothing about the organizer is stored either");
  });

  test("AC-8 the start logs one line naming the seeded question ids and none of the values", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, JAPAN);
    const lines: string[] = [];
    const result = await startSession(pool, token, (line) => lines.push(line));
    assert.ok(result.ok);
    const seededLines = lines.filter((l) => l.includes("interview.session_seeded"));
    assert.equal(seededLines.length, 1);
    const parsed = JSON.parse(seededLines[0]!);
    assert.deepEqual([...parsed.seeded].sort(), [...SEEDED].sort());
    assert.equal(parsed.trip_id, tripId);
    for (const value of ["Japan", "2027-04-12", "2027-04-26", "Dana"]) assert.ok(!seededLines[0]!.includes(value), `${value} is not in the log line`);
    // A bare trip logs no such line.
    const bare = await bareTrip(user);
    const bareLines: string[] = [];
    await startSession(pool, bare.token, (line) => bareLines.push(line));
    assert.ok(!bareLines.some((l) => l.includes("interview.session_seeded")));
  });
});

// ── A seeded date is corrected in words ───────────────────────────────────────

type Button = { text: string; callback_data: string };
class Telegram {
  readonly sent: { text: string; buttons: Button[] }[] = [];
  readonly edited: { text: string }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: Button[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat() });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText(p: { text: string }) { this.edited.push({ text: p.text }); return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
  get last() { return this.sent[this.sent.length - 1]!; }
}

function model(proposals: unknown[]) {
  return {
    async run(req: { schema?: { properties?: Record<string, unknown> }; parse: (raw: unknown) => unknown }) {
      const raw = req.schema?.properties?.intent
        ? { intent: "answer_only", confidence: 0.9 }
        : { proposals, unclear: [] };
      const parsed = req.parse(raw);
      if (parsed === null) return { ok: false as const, reason: "BAD_OUTPUT", detail: "", attempts: 1, ms: 1 };
      return { ok: true as const, value: parsed, attempts: 1, ms: 1 };
    },
  };
}

let burst = 0;
async function say(chat: string, text: string, telegram: Telegram, runner: unknown) {
  burst += 1;
  await queueInboundMessage(pool, chat, { text, message_id: `d${burst}` } as never);
  const log = () => {};
  await flushSettledInboundBursts({ db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner, log } as never, log, 0);
}
async function tapOn(chat: string, sessionId: string, data: string, telegram: Telegram, runner: unknown) {
  burst += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: chat, callbackQueryId: `cq${burst}`, data, sessionId } as never,
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner, log: () => {} } as never,
  );
}

describe("a seeded interview, once running", { skip }, () => {
  test("AC-4 'actually we go in May, 3 to 17' changes both dates through the existing correction path, and the card is not re-applied", async () => {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, JAPAN);
    const chat = nextChat();
    const started = await startFromDeepLink(pool, chat, token);
    assert.equal(started.kind, "started");
    await setInterpretPath(pool, chat, true);
    const tg = new Telegram();
    const message = "actually we go in May, 3 to 17";
    const m = model([
      { questionId: "departure_date", confidence: 0.95, evidence: "May, 3 to 17", value: { kind: "text", text: "2027-05-03" } },
      { questionId: "return_date", confidence: 0.95, evidence: "May, 3 to 17", value: { kind: "text", text: "2027-05-17" } },
    ]);
    await say(chat, message, tg, m);
    const corrected = await answersOf(tripId);
    assert.equal(textOf(corrected, "departure_date"), "2027-05-03");
    assert.equal(textOf(corrected, "return_date"), "2027-05-17");
    assert.match(tg.sent[0]!.text, /May 3, 2027/, "the new reading is shown back");
    // The card is read once, at the start: a later message does not bring its values back.
    await say(chat, "we are four people", tg, model([]));
    const later = await answersOf(tripId);
    assert.equal(textOf(later, "departure_date"), "2027-05-03");
    assert.equal(textOf(later, "return_date"), "2027-05-17");
    const card = await pool.query("SELECT start_date::text AS s, end_date::text AS e FROM control_plane.trips WHERE id = $1", [tripId]);
    assert.equal(card.rows[0].s, "2027-04-12", "and nothing writes the card until the intake is confirmed");
  });
});

// ── Who is the organizer on the roster ────────────────────────────────────────

describe("AC-9 the organizer's name offers a one-tap confirm on the roster", { skip }, () => {
  async function seededAtIdentity(givenName: string, roster: { name: string; name_en?: string }[]) {
    const user = await organizer(givenName);
    const { tripId, token } = await dashboardTrip(user, JAPAN);
    const chat = nextChat();
    const started = await startFromDeepLink(pool, chat, token);
    assert.equal(started.kind, "started");
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object('travelers', $2::jsonb) WHERE telegram_chat_id = $1`,
      [chat, JSON.stringify({ kind: "structured", schema_version: 3, data: roster })]);
    // Every required question that comes before the organizer's, so that is the one the router reaches.
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      if (q.id === "organizer_identity") break;
      const have = await pool.query("SELECT answers ? $2 AS has FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [chat, q.id]);
      if (have.rows[0].has) continue;
      await pool.query(
        `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1`,
        [chat, q.id, JSON.stringify(q.type === "structured"
          ? { kind: "structured", schema_version: 3, data: [{ name: "Stop", start: "2027-04-12", end: "2027-04-14" }] }
          : q.type === "choice" ? { kind: "choice", schema_version: 3, option_id: q.options![0]!.id, other_text: null }
          : { kind: "text", schema_version: 3, text: "x" })]);
    }
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok);
    return { tripId, chat, sessionId: (started as { sessionId: string }).sessionId, view: view.view };
  }

  test("exactly one match is offered as a confirm, in the roster's own spelling", async () => {
    const a = await seededAtIdentity("Dana", [{ name: "Dana Levi" }, { name: "Omri Levi" }]);
    assert.equal(a.view.nextQuestion?.id, "organizer_identity");
    const suggestion = a.view.suggestions.organizer_identity;
    assert.ok(suggestion, "a confirm is offered");
    assert.equal(suggestion!.otherText, "Dana Levi");
    const rendered = renderSuggestion(INTAKE_QUESTIONS.find((q) => q.id === "organizer_identity")!, "Dana Levi", "en", null, "account_name");
    assert.match(rendered.text, /Dana Levi/);
    assert.match(rendered.text, /right\?/);
    assert.ok(JSON.stringify(rendered.replyMarkup).includes(suggestionYesCallbackData("organizer_identity")));

    // And the router, asked for the next step, puts exactly that on screen -- not a document's "is this right?".
    const tg = new Telegram();
    await tapOn(a.chat, a.sessionId, "c:nodoc", tg, model([]));
    assert.equal(tg.last.text, "You're Dana Levi on the list, right?");
    assert.ok(tg.last.buttons.some((b) => b.callback_data === suggestionYesCallbackData("organizer_identity")));
    assert.ok(tg.last.buttons.some((b) => b.callback_data === suggestionNoCallbackData("organizer_identity")));
  });

  test("yes records the roster entry; no falls back to today's open question and does not come back", async () => {
    const yes = await seededAtIdentity("Dana", [{ name: "Dana Levi" }, { name: "Omri Levi" }]);
    const tg = new Telegram();
    await tapOn(yes.chat, yes.sessionId, suggestionYesCallbackData("organizer_identity"), tg, model([]));
    const stored = await answersOf(yes.tripId);
    assert.equal(textOf(stored, "organizer_identity"), "Dana Levi");

    const no = await seededAtIdentity("Dana", [{ name: "Dana Levi" }, { name: "Omri Levi" }]);
    const tg2 = new Telegram();
    await tapOn(no.chat, no.sessionId, suggestionNoCallbackData("organizer_identity"), tg2, model([]));
    assert.ok(!("organizer_identity" in (await answersOf(no.tripId))), "nothing recorded");
    const after = await getSessionForChat(pool, no.chat);
    assert.ok(after.ok);
    assert.equal(after.view.nextQuestion?.id, "organizer_identity");
    assert.equal(after.view.suggestions.organizer_identity, undefined, "the offer does not return after a no");
    assert.ok((after.view.choices?.organizer_identity ?? []).length === 2, "the open question, with the roster as buttons, is what is asked");
  });

  test("zero matches, or several, ask as today", async () => {
    const none = await seededAtIdentity("Dana", [{ name: "Noa Barak" }, { name: "Omri Barak" }]);
    assert.equal(none.view.nextQuestion?.id, "organizer_identity");
    assert.equal(none.view.suggestions.organizer_identity, undefined);
    const several = await seededAtIdentity("Dana", [{ name: "Dana Levi" }, { name: "Dana Cohen" }]);
    assert.equal(several.view.suggestions.organizer_identity, undefined, "two Danas: never guessed between");
  });

  test("a trip that was not seeded never offers one", async () => {
    const user = await organizer("Dana");
    const { token, tripId } = await bareTrip(user);
    const chat = nextChat();
    assert.equal((await startFromDeepLink(pool, chat, token)).kind, "started");
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object('travelers', $2::jsonb) WHERE telegram_chat_id = $1`,
      [chat, JSON.stringify({ kind: "structured", schema_version: 3, data: [{ name: "Dana Levi" }] })]);
    const view = await getSessionForChat(pool, chat);
    assert.ok(view.ok);
    assert.equal(view.view.suggestions.organizer_identity, undefined);
    void tripId;
  });
});

// ── The card follows the confirmed intake ─────────────────────────────────────

describe("AC-10 the card follows the confirmed intake", { skip }, () => {
  async function confirmedWith(card: Record<string, unknown>, change: Partial<Record<"destination" | "departure_date" | "return_date", string>>) {
    const user = await organizer("Dana");
    const { tripId, token } = await dashboardTrip(user, card);
    const chat = nextChat();
    assert.equal((await startFromDeepLink(pool, chat, token)).kind, "started");
    for (const [q, text] of Object.entries(change)) {
      await pool.query(
        `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1`,
        [chat, q, JSON.stringify({ kind: "text", schema_version: 3, text })]);
    }
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      const have = await pool.query("SELECT answers ? $2 AS has FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [chat, q.id]);
      if (have.rows[0].has) continue;
      await pool.query(
        `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1`,
        [chat, q.id, JSON.stringify(q.id === "travelers"
          ? { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] }
          : q.type === "choice" ? { kind: "choice", schema_version: 3, option_id: q.options![0]!.id, other_text: null }
          : { kind: "text", schema_version: 3, text: "Dana" })]);
    }
    const confirmed = await confirmIntakeForChat(pool, chat);
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
    return { tripId, user };
  }
  const card = async (tripId: string) =>
    (await pool.query("SELECT destination_label, start_date::text AS s, end_date::text AS e, title FROM control_plane.trips WHERE id = $1", [tripId])).rows[0];

  test("a destination and dates that differ from the card's are written back, with who and when", async () => {
    const { tripId, user } = await confirmedWith(JAPAN, { destination: "Korea", departure_date: "2027-05-03", return_date: "2027-05-17" });
    const row = await card(tripId);
    assert.equal(row.destination_label, "Korea");
    assert.equal(row.s, "2027-05-03");
    assert.equal(row.e, "2027-05-17");
    assert.equal(row.title, "Korea trip", "the automatic 'Japan trip' title followed the destination");
    const audit = await pool.query("SELECT actor_ref, action, target_ref, evidence, occurred_at FROM control_plane.audit_events WHERE target_ref = $1", [tripId]);
    assert.equal(audit.rowCount, 1, "the change is recorded once");
    assert.equal(audit.rows[0].action, "trip.card_synced_from_intake");
    assert.equal(audit.rows[0].actor_ref, user, "who");
    assert.ok(audit.rows[0].occurred_at instanceof Date, "when");
    assert.deepEqual(audit.rows[0].evidence.changed.sort(), ["destination", "end_date", "start_date"]);
  });

  test("an intake that agrees with the card writes nothing and records nothing", async () => {
    const { tripId } = await confirmedWith(JAPAN, {});
    const audit = await pool.query("SELECT 1 FROM control_plane.audit_events WHERE target_ref = $1", [tripId]);
    assert.equal(audit.rowCount, 0);
  });

  test("a title the organizer chose is left alone", async () => {
    const { tripId } = await confirmedWith({ ...JAPAN, title: "Spring with the cousins" }, { destination: "Korea" });
    const row = await card(tripId);
    assert.equal(row.destination_label, "Korea");
    assert.equal(row.title, "Spring with the cousins");
  });

  test("dates the interview could not read as days leave the card's dates alone, and never fail the confirm", async () => {
    const { tripId } = await confirmedWith(JAPAN, { departure_date: "sometime in spring", return_date: "2027-04-02" });
    const row = await card(tripId);
    assert.equal(row.s, "2027-04-12");
    assert.equal(row.e, "2027-04-26", "a half-readable pair is not written either: the card keeps one consistent range");
  });
});

// ── Not a security exercise, but the opening of a session must stay inside one trip ──

describe("the seed is read from the trip the enrollment names", { skip }, () => {
  test("two dashboard trips of one organizer seed their own sessions", async () => {
    const user = await organizer("Dana");
    const a = await dashboardTrip(user, JAPAN);
    const b = await dashboardTrip(user, { destination: "Peru", tripType: "couple", startDate: "2028-01-05", endDate: "2028-01-19" });
    assert.equal((await startFromDeepLink(pool, nextChat(), b.token)).kind, "started");
    assert.equal((await startFromDeepLink(pool, nextChat(), a.token)).kind, "started");
    assert.equal(textOf(await answersOf(a.tripId), "destination"), "Japan");
    assert.equal(textOf(await answersOf(b.tripId), "destination"), "Peru");
    assert.equal(textOf(await answersOf(b.tripId), "departure_date"), "2028-01-05");
  });
});

export type { SessionView };
