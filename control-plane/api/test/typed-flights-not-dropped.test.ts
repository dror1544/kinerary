/**
 * A FLIGHT THE ORGANIZER TYPED IS NEVER LOST BECAUSE THE MODEL DID NOT FILE IT.
 *
 * Live star e2e, 2026-10-15, 2 runs of 6. The organizer answers the stops
 * question in one Hebrew message that also carries both flights ("טיסה LY8801
 * ב-2 בדצמבר ב-07:10, וטיסה LY8802 ב-9 בדצמבר ב-15:40"). In a good run the
 * reader proposes `travel_anchors` from that message as well. In a bad run it
 * proposes only the stops; `travel_anchors` is an OPTIONAL question, reached
 * only through the boundary offer, so the organizer could go straight to the
 * summary, confirm, and the confirmed intake carried `travel_anchors = null`:
 * "'LY8801' was given in the interview and is nowhere in the config".
 *
 * The rule pinned here is code, not model judgement: a flight designator in
 * something the organizer typed that no `travel_anchors` entry carries is
 * ASKED about — once — before the interview can reach the summary. Nothing is
 * recorded from the detector alone; the organizer's own answer is what files it.
 *
 * Both producers of the answer are exercised: the reader that proposed the
 * stops only (the bad run) and the reader that proposed the stops AND the
 * bookings (the good run). The contract shape (`phases[].planned` vs
 * `phases[].venues`) is not touched — this is the intake answer, upstream of
 * the transformer.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { renderQuestion, startFromDeepLink } from "../src/chat-router.js";
import {
  INTAKE_QUESTIONS,
  answersForChat,
  flightDesignatorsIn,
  flightsOwed,
  flightsOwedLead,
  getSessionForChat,
  nextPhase,
  queueInboundMessage,
  setFinishRequestedForChat,
  type AnswerStore,
} from "../src/interview.js";
import { advanceRouterOwnedQuestions, flushSettledInboundBursts } from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { uiString, type Language } from "../src/intake-copy.js";
import { setInterpretPath } from "../src/interpret.js";
import { STAR_SCENARIO } from "../tools/organizer-scenarios.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const STAR_PHASES_TEXT = STAR_SCENARIO.text.phases!;

// ── The detector and the rule: pure ─────────────────────────────────────────

describe("flightDesignatorsIn — what counts as a flight the organizer typed", () => {
  test("the star scenario's stops message carries exactly its two flights", () => {
    assert.deepEqual(flightDesignatorsIn(STAR_PHASES_TEXT), ["LY8801", "LY8802"]);
  });

  test("separators and repeats are noise; the first spelling's order is kept", () => {
    assert.deepEqual(flightDesignatorsIn("we fly VN572 and then LY-381, VN572 again"), ["VN572", "LY381"]);
    assert.deepEqual(flightDesignatorsIn("U21234 then 9W450"), ["U21234", "9W450"]);
  });

  test("a text with no flight number is unaffected — dates, times, rooms, sizes, plain words", () => {
    for (const text of [
      "אנחנו שני זוגות וישנים את כל הטיול בקולמר, ב-2 בדצמבר ב-07:10",
      "Room 12, 2 adults, Level B2 French, an A4 map, 3 nights from 2027-12-02, EUR 200 or USD 1500 in DEC 15, an A320 or B737",
      "בואו ניסע ב-9 בדצמבר 2027 בשעה 15:40",
      "a 512GB phone and a 4K camera",
      "",
    ]) {
      assert.deepEqual(flightDesignatorsIn(text), [], text);
    }
  });

  test("a designator glued to other letters or digits is part of a longer word, not a flight", () => {
    assert.deepEqual(flightDesignatorsIn("XLY8801Z and 123LY8801 and LY88011"), []);
  });
});

describe("flightsOwed — typed, not represented, not yet asked", () => {
  const anchors = (...names: string[]): AnswerStore => ({
    travel_anchors: { kind: "structured", schema_version: 3, data: names.map((name) => ({ type: "flight", name })) } as never,
  });

  test("typed and absent from the bookings: owed", () => {
    assert.deepEqual(flightsOwed({}, { typedFlights: ["LY8801", "LY8802"] }), ["LY8801", "LY8802"]);
  });

  test("represented in the bookings — in the name or the confirmation, any spelling: not owed", () => {
    assert.deepEqual(flightsOwed(anchors("LY8801 תל אביב → פרנקפורט", "ly 8802 Frankfurt → TLV"), { typedFlights: ["LY8801", "LY8802"] }), []);
  });

  test("only the missing one is owed", () => {
    assert.deepEqual(flightsOwed(anchors("LY8801 TLV → FRA"), { typedFlights: ["LY8801", "LY8802"] }), ["LY8802"]);
  });

  test("asked once is enough — never owed again, however long the interview goes on", () => {
    assert.deepEqual(flightsOwed({}, { typedFlights: ["LY8801", "LY8802"], flightsAsked: ["LY8801", "LY8802"] }), []);
    assert.deepEqual(flightsOwed({}, { typedFlights: ["LY8801", "LY8802", "BA123"], flightsAsked: ["LY8801", "LY8802"] }), ["BA123"]);
  });

  test("nothing typed: nothing owed", () => {
    assert.deepEqual(flightsOwed({}, {}), []);
  });
});

describe("the phase machine holds the summary back while a typed flight is owed", () => {
  test("optional + finish requested + flights owed stays in optional; once asked it moves on", () => {
    const answers: AnswerStore = {};
    assert.equal(nextPhase("optional", answers, INTAKE_QUESTIONS, { finishRequested: true }), "recap", "control: no flights");
    assert.equal(
      nextPhase("optional", answers, INTAKE_QUESTIONS, { finishRequested: true, typedFlights: ["LY8801"] }),
      "optional",
    );
    assert.equal(
      nextPhase("optional", answers, INTAKE_QUESTIONS, { finishRequested: true, typedFlights: ["LY8801"], flightsAsked: ["LY8801"] }),
      "recap",
    );
  });

  test("a flight typed while the summary is up reopens the questions, once", () => {
    assert.equal(nextPhase("recap", {}, INTAKE_QUESTIONS, { finishRequested: true, typedFlights: ["LY8801"] }), "optional");
    assert.equal(
      nextPhase("recap", {}, INTAKE_QUESTIONS, { finishRequested: true, typedFlights: ["LY8801"], flightsAsked: ["LY8801"] }),
      "recap",
    );
  });
});

describe("the copy", () => {
  test("names every number, in the organizer's language, and is Hebrew where it should be", () => {
    for (const language of ["en", "he"] as const) {
      const one = flightsOwedLead(["LY8801"], language);
      const two = flightsOwedLead(["LY8801", "LY8802"], language);
      assert.ok(one.includes("LY8801"));
      assert.ok(two.includes("LY8801") && two.includes("LY8802"));
      assert.notEqual(one.replace("LY8801", ""), two.replace("LY8801", "").replace("LY8802", ""), "one and many are said differently");
    }
    assert.ok(/[א-ת]/u.test(flightsOwedLead(["LY8801"], "he")));
    assert.ok(!/[א-ת]/u.test(flightsOwedLead(["LY8801"], "en")));
  });
});

// ── Through the real router: DB ─────────────────────────────────────────────

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

async function seedInterview(pool: pg.Pool, chatId: string): Promise<{ chatId: string; sessionId: string }> {
  const userId = testId("user");
  const tripId = testId("trip");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [testId("memb"), tripId, userId],
  );
  const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(enrollment.ok);
  const started = await startFromDeepLink(pool, chatId, enrollment.token);
  assert.equal(started.kind, "started");
  return { chatId, sessionId: started.kind === "started" ? started.sessionId : "" };
}

async function withInterview(fn: (pool: pg.Pool, chatId: string) => Promise<void>): Promise<void> {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const a = await seedInterview(pool, "850000001");
    await setInterpretPath(pool, a.chatId, true);
    await fn(pool, a.chatId);
  } finally {
    await pool.end();
  }
}

const ROSTER = { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] };

async function answerRequiredExcept(pool: pg.Pool, chatId: string, except: readonly string[]): Promise<void> {
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required && !except.includes(x.id))) {
    const answer = q.id === "travelers" ? ROSTER
      : q.id === "organizer_identity" ? { kind: "text", schema_version: 3, text: "Dana" }
      : q.type === "choice" ? { kind: "choice", option_id: q.options![0]!.id, schema_version: 3, other_text: null }
      : { kind: "text", schema_version: 3, text: "x" };
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
        WHERE telegram_chat_id = $1`,
      [chatId, q.id, JSON.stringify(answer)],
    );
  }
}

/** The stops question on screen, everything else required already answered: the live state. */
async function stopsOnScreen(pool: pg.Pool, chatId: string, language: Language): Promise<void> {
  await answerRequiredExcept(pool, chatId, ["phases"]);
  await pool.query(
    `UPDATE control_plane.intake_sessions
        SET language = $2, awaiting = 'person', phase = 'essentials',
            ui_state = jsonb_build_object('last_prompt', 'q:phases')
      WHERE telegram_chat_id = $1`,
    [chatId, language],
  );
}

class Recorder {
  readonly sent: { text: string; buttons: string[] }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data?: string }[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "") });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

const STOPS = [{ name: "קולמר", name_en: "Colmar", start: "2027-12-02", end: "2027-12-09" }];
const FLIGHTS = [
  { type: "flight", name: "LY8801 תל אביב → פרנקפורט", date: "2027-12-02", time: "07:10" },
  { type: "flight", name: "LY8802 פרנקפורט → תל אביב", date: "2027-12-09", time: "15:40" },
];
const stopsProposal = {
  questionId: "phases", confidence: 0.95, evidence: "וישנים את כל הטיול בקולמר",
  value: { kind: "structured", data: STOPS },
};
const flightsProposal = {
  questionId: "travel_anchors", confidence: 0.95, evidence: "טיסה LY8801 ב-2 בדצמבר ב-07:10",
  value: { kind: "structured", data: FLIGHTS },
};

function runnerProposing(...proposals: unknown[]) {
  return {
    async run() {
      return { ok: true as const, value: { proposals, unclear: [], malformed: 0 }, attempts: 1, ms: 1 };
    },
  };
}

let seq = 0;
async function say(pool: pg.Pool, chatId: string, text: string, telegram: Recorder, modelRunner: unknown, logs: string[] = []) {
  seq += 1;
  const log = (line: string) => { logs.push(line); };
  await queueInboundMessage(pool, chatId, { text, message_id: `f${seq}` } as never);
  await flushSettledInboundBursts({ db: pool, telegram, connector: { pushInbound: () => true }, modelRunner, log } as never, log, 0);
}

function plainQuestion(id: string, language: Language) {
  const question = INTAKE_QUESTIONS.find((q) => q.id === id)!;
  const rendered = renderQuestion(question, [], language);
  return { text: rendered.text, buttons: (rendered.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "") };
}

async function bookingsOf(pool: pg.Pool, chatId: string): Promise<string> {
  const store = await answersForChat(pool, chatId);
  return JSON.stringify(store?.answers.travel_anchors ?? null);
}

describe("a typed flight the reader did not file is asked about", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("the bad run: stops only — the bookings are asked, naming both flights, before the interview can finish", async () => {
    await withInterview(async (pool, chatId) => {
      await stopsOnScreen(pool, chatId, "he");
      const telegram = new Recorder();
      const logs: string[] = [];

      await say(pool, chatId, STAR_PHASES_TEXT, telegram, runnerProposing(stopsProposal), logs);

      const asked = telegram.sent.at(-1)!;
      const original = plainQuestion("travel_anchors", "he");
      assert.equal(asked.text, `${flightsOwedLead(["LY8801", "LY8802"], "he")}\n\n${original.text}`,
        `the lead, then the bookings question — sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.ok(asked.text.includes("LY8801") && asked.text.includes("LY8802"), "both numbers are quoted");
      assert.deepEqual(asked.buttons, original.buttons, "the question's own shortcuts (skip, finished) are intact");
      assert.ok(!telegram.sent.some((m) => m.text === uiString("optionalOffer", "he")), "not the optional offer instead");

      const view = await getSessionForChat(pool, chatId);
      assert.ok(view.ok);
      assert.equal(view.view.lastPrompt, "q:travel_anchors:flights");
      assert.equal(view.view.state, "interviewing");
      assert.equal(await bookingsOf(pool, chatId), "null", "nothing is invented from the detector alone");
      assert.ok(logs.some((l) => l.includes("interview.typed_flights_asked") && l.includes("LY8801")), "and it is in the log");
    });
  });

  test("asking to finish before it was asked does not skip it: the summary waits, then the answer files the flights", async () => {
    await withInterview(async (pool, chatId) => {
      // The state the bad run reaches the moment the offer is on screen: the
      // flights were typed (noted), nothing was filed, nothing asked yet.
      await answerRequiredExcept(pool, chatId, []);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'he', awaiting = 'person', phase = 'optional',
                ui_state = jsonb_build_object('last_prompt', 'optional_offer', 'offered_more', true,
                                              'typed_flights', jsonb_build_array('LY8801', 'LY8802'))
          WHERE telegram_chat_id = $1`,
        [chatId],
      );
      const telegram = new Recorder();

      // "Skip" / "that's all": the finish request, which used to open the summary.
      const finished = await setFinishRequestedForChat(pool, chatId, true);
      assert.ok(finished.ok);
      assert.equal(finished.view.state, "interviewing", "the summary is not reachable yet");
      assert.equal(finished.view.recap, null);
      const held = await getSessionForChat(pool, chatId);
      assert.ok(held.ok);
      assert.equal(held.view.phase, "optional");

      // The router's turn: it asks, with both numbers, instead of the summary.
      await pool.query("UPDATE control_plane.intake_sessions SET awaiting = 'machine' WHERE telegram_chat_id = $1", [chatId]);
      await advanceRouterOwnedQuestions(
        { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runnerProposing() } as never, DEFAULT_STRINGS, () => {},
      );
      const asked = telegram.sent.at(-1)!;
      assert.equal(asked.text, `${flightsOwedLead(["LY8801", "LY8802"], "he")}\n\n${plainQuestion("travel_anchors", "he").text}`);
      assert.ok(telegram.sent.every((m) => !m.text.includes(uiString("recapHeader", "he"))), "no summary was sent");

      // They answer it, in the scenario's own bookings answer.
      await say(pool, chatId, STAR_SCENARIO.text.travel_anchors!, telegram, runnerProposing({
        ...flightsProposal, evidence: "טיסה LY8801 מתל אביב לפרנקפורט ב-2 בדצמבר 2027 ב-07:10",
      }));
      const bookings = await bookingsOf(pool, chatId);
      assert.ok(bookings.includes("LY8801") && bookings.includes("LY8802"), `filed on the organizer's own answer: ${bookings}`);
      const after = await getSessionForChat(pool, chatId);
      assert.ok(after.ok);
      assert.equal(after.view.state, "awaiting_confirmation", "and now the summary comes, with the bookings in it");
      assert.ok(after.view.recap?.some((r) => r.questionId === "travel_anchors"));
    });
  });

  test("asked ONCE: an answer that does not file them lets the interview finish; it does not ask again", async () => {
    await withInterview(async (pool, chatId) => {
      await stopsOnScreen(pool, chatId, "he");
      const telegram = new Recorder();
      await say(pool, chatId, STAR_PHASES_TEXT, telegram, runnerProposing(stopsProposal));
      const flightQuestions = () => telegram.sent.filter((m) => m.text.includes("LY8801") && m.text.includes(plainQuestion("travel_anchors", "he").text)).length;
      assert.equal(flightQuestions(), 1);

      // "They are not booked yet" — nothing to file.
      await say(pool, chatId, "עוד לא הזמנו אותן", telegram, runnerProposing());
      const after = await getSessionForChat(pool, chatId);
      assert.ok(after.ok);
      assert.notEqual(after.view.lastPrompt, "q:travel_anchors:flights", "the interview moved on");
      assert.equal(flightQuestions(), 1, "never asked a second time");
      assert.equal(await bookingsOf(pool, chatId), "null");
      assert.deepEqual((await answersForChat(pool, chatId))!.ui.flightsAsked, ["LY8801", "LY8802"]);

      // And finishing now reaches the summary: the organizer's "not booked" is believed.
      const finished = await setFinishRequestedForChat(pool, chatId, true);
      assert.ok(finished.ok);
      assert.equal(finished.view.state, "awaiting_confirmation");
      assert.equal(flightQuestions(), 1, "still asked once");
    });
  });

  test("the good run: stops AND flights proposed — nothing extra is asked, as before", async () => {
    await withInterview(async (pool, chatId) => {
      await stopsOnScreen(pool, chatId, "he");
      const telegram = new Recorder();

      await say(pool, chatId, STAR_PHASES_TEXT, telegram, runnerProposing(stopsProposal, flightsProposal));

      const bookings = await bookingsOf(pool, chatId);
      assert.ok(bookings.includes("LY8801") && bookings.includes("LY8802"));
      assert.ok(!telegram.sent.some((m) => m.text.includes(flightsOwedLead(["LY8801", "LY8802"], "he"))), "no flight question");
      const store = await answersForChat(pool, chatId);
      assert.deepEqual(flightsOwed(store!.answers, store!.ui), []);
      const view = await getSessionForChat(pool, chatId);
      assert.ok(view.ok);
      assert.notEqual(view.view.lastPrompt, "q:travel_anchors:flights");
    });
  });

  test("a text with no flight numbers is unaffected", async () => {
    await withInterview(async (pool, chatId) => {
      await stopsOnScreen(pool, chatId, "he");
      const telegram = new Recorder();
      const plain = "אנחנו שני זוגות וישנים את כל הטיול בקולמר, מ-2 בדצמבר עד 9 בדצמבר";

      await say(pool, chatId, plain, telegram, runnerProposing(stopsProposal));

      assert.ok(!telegram.sent.some((m) => /LY\d|טיסות?\s+\S*\d{3}/.test(m.text)), "no flight question");
      const store = await answersForChat(pool, chatId);
      assert.deepEqual(store!.ui.typedFlights ?? [], []);
      const view = await getSessionForChat(pool, chatId);
      assert.ok(view.ok);
      assert.notEqual(view.view.lastPrompt, "q:travel_anchors:flights");
      assert.equal(view.view.lastPrompt, "optional_offer", "the optional offer, exactly as before");
    });
  });

  test("a flight typed after the summary is up reopens the questions and is asked about", async () => {
    await withInterview(async (pool, chatId) => {
      await answerRequiredExcept(pool, chatId, []);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'he', awaiting = 'person', phase = 'recap', state = 'awaiting_confirmation',
                ui_state = jsonb_build_object('last_prompt', 'recap', 'finish_requested', true, 'offered_more', true)
          WHERE telegram_chat_id = $1`,
        [chatId],
      );
      const telegram = new Recorder();

      await say(pool, chatId, "ועוד דבר, אנחנו טסים בטיסה LY8801 ב-2 בדצמבר", telegram, runnerProposing());

      assert.ok(telegram.sent.at(-1)!.text.includes("LY8801"), `asked — sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      const view = await getSessionForChat(pool, chatId);
      assert.ok(view.ok);
      assert.equal(view.view.lastPrompt, "q:travel_anchors:flights");
    });
  });
});
