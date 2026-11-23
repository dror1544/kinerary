/**
 * THE INTERVIEW ASKS ABOUT A RENTAL CAR, ONCE, BEFORE THE SUMMARY.
 *
 * Dror, 2026-11-21, on the real Alsace trip: "the car reservation is not
 * there, this information is also important for the travel planning." The
 * bookings (`travel_anchors`) had been filled from two flight PDFs and a hotel
 * document. `travel_anchors` is optional, so nothing ever asked about the car
 * the family had booked, and the site's Trip anchors card (which does show
 * `car` bookings) had nothing to show.
 *
 * The follow-up copies the flights one (typed-flights-not-dropped.test.ts): a
 * deterministic, ask-once question before the summary, asked about the same
 * `travel_anchors` question, filed by the SAME reader and merged by the SAME
 * merge. Nothing here is a model's judgement: whether to ask is code.
 *
 * Both producers of the bookings are exercised where it matters: the bookings
 * as a document would leave them (flights + hotel already held) and as typed.
 * The contract shape (`phases[].planned` vs `venues`) is not touched — this is
 * the intake answer, upstream of the transformer.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { parseCallbackData, startFromDeepLink, NO_CAR_CALLBACK_DATA, CAR_LATER_CALLBACK_DATA } from "../src/chat-router.js";
import {
  INTAKE_QUESTIONS,
  answersForChat,
  carOwed,
  getSessionForChat,
  hasCarAnchor,
  nextPhase,
  queueInboundMessage,
  setFinishRequestedForChat,
  advancePhaseForChat,
  type AnswerStore,
  type InterviewUiState,
} from "../src/interview.js";
import { advanceRouterOwnedQuestions, applyDecision, flushSettledInboundBursts, CAR_PROMPT } from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { UI_STRINGS, uiString, type Language } from "../src/intake-copy.js";
import { setInterpretPath } from "../src/interpret.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// ── The rule: pure ──────────────────────────────────────────────────────────

const anchors = (...entries: Record<string, unknown>[]): AnswerStore => ({
  travel_anchors: { kind: "structured", schema_version: 3, data: entries } as never,
});
const FLIGHT = { type: "flight", name: "LY8801 TLV → FRA", date: "2027-12-02", time: "07:10" };
const HOTEL = { type: "hotel", name: "Hotel Colmar", confirmation: "HC-5521" };
const CAR = { type: "car", name: "Rental car pick-up Frankfurt airport", date: "2027-12-02" };
const onInterpret: InterviewUiState = { interpretPath: true };

describe("carOwed — on the interpret path, no car in the bookings, not yet asked", () => {
  test("nothing held at all: owed", () => {
    assert.equal(carOwed({}, onInterpret), true);
  });

  test("flights and a hotel from documents, no car: owed", () => {
    assert.equal(carOwed(anchors(FLIGHT, HOTEL), onInterpret), true);
  });

  test("a car anchor, in any spelling of its type: not owed", () => {
    assert.equal(carOwed(anchors(FLIGHT, CAR), onInterpret), false);
    assert.equal(carOwed(anchors({ ...CAR, type: " Car " }), onInterpret), false);
    assert.equal(hasCarAnchor(anchors(FLIGHT, HOTEL)), false);
    assert.equal(hasCarAnchor(anchors(CAR)), true);
  });

  test("a hotel whose name says 'car' is not a car booking — the TYPE decides", () => {
    assert.equal(carOwed(anchors({ type: "hotel", name: "Car Park Hotel" }), onInterpret), true);
  });

  test("asked once is enough", () => {
    assert.equal(carOwed({}, { ...onInterpret, carAsked: true }), false);
  });

  test("not on the interpret path: never owed — the agent path has nothing to ask it", () => {
    assert.equal(carOwed({}, {}), false);
    assert.equal(carOwed({}, { interpretPath: false }), false);
  });
});

describe("the phase machine holds the summary back while the car is owed", () => {
  test("optional + finish requested + car owed stays in optional; once asked it moves on", () => {
    assert.equal(nextPhase("optional", {}, INTAKE_QUESTIONS, { finishRequested: true }), "recap", "control: agent path");
    assert.equal(nextPhase("optional", {}, INTAKE_QUESTIONS, { ...onInterpret, finishRequested: true }), "optional");
    assert.equal(nextPhase("optional", anchors(CAR), INTAKE_QUESTIONS, { ...onInterpret, finishRequested: true }), "recap");
    assert.equal(nextPhase("optional", {}, INTAKE_QUESTIONS, { ...onInterpret, finishRequested: true, carAsked: true }), "recap");
  });

  test("running out of optional questions is held the same way", () => {
    const everyOptionalSkipped = { skipped: INTAKE_QUESTIONS.filter((q) => !q.required).map((q) => q.id) };
    assert.equal(nextPhase("optional", {}, INTAKE_QUESTIONS, { ...onInterpret, ...everyOptionalSkipped }), "optional");
    assert.equal(nextPhase("optional", {}, INTAKE_QUESTIONS, { ...onInterpret, ...everyOptionalSkipped, carAsked: true }), "recap");
  });

  test("a summary already on screen is NEVER reopened for the car", () => {
    assert.equal(nextPhase("recap", {}, INTAKE_QUESTIONS, { ...onInterpret, finishRequested: true }), "recap");
  });
});

describe("the copy and the buttons", () => {
  test("the lead and both buttons exist in English and Hebrew, and Hebrew is Hebrew", () => {
    for (const key of ["carOwedLead", "noRentalCar", "carNotBookedYet"]) {
      assert.ok(UI_STRINGS.en[key], `en.${key}`);
      assert.ok(UI_STRINGS.he[key], `he.${key}`);
      assert.ok(/[א-ת]/u.test(uiString(key, "he")), `he.${key} is Hebrew`);
      assert.ok(!/[א-ת]/u.test(uiString(key, "en")), `en.${key} is English`);
    }
  });

  test("the Hebrew lead uses the plural address, never an ISO date, and asks for the pieces of a booking", () => {
    const he = uiString("carOwedLead", "he");
    assert.ok(/הזמנתם|יש לכם|תכתבו|ספרו|כתבו/u.test(he), he);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(he) && !/\d{4}-\d{2}-\d{2}/.test(uiString("carOwedLead", "en")));
  });

  test("the two buttons are callbacks the router parses", () => {
    assert.deepEqual(parseCallbackData(NO_CAR_CALLBACK_DATA), { kind: "no_car", choice: "none" });
    assert.deepEqual(parseCallbackData(CAR_LATER_CALLBACK_DATA), { kind: "no_car", choice: "later" });
    assert.ok(Buffer.byteLength(NO_CAR_CALLBACK_DATA) <= 64 && Buffer.byteLength(CAR_LATER_CALLBACK_DATA) <= 64);
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

async function withInterview(
  fn: (pool: pg.Pool, chat: { chatId: string; sessionId: string }) => Promise<void>,
  options: { interpretPath?: boolean } = {},
): Promise<void> {
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
    const chat = await seedInterview(pool, "860000001");
    await setInterpretPath(pool, chat.chatId, options.interpretPath ?? true);
    await fn(pool, chat);
  } finally {
    await pool.end();
  }
}

const ROSTER = { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] };

async function answerRequired(pool: pg.Pool, chatId: string): Promise<void> {
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
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

/** The bookings as two flight documents and a hotel document leave them. */
const DOCUMENT_BOOKINGS = [
  { type: "flight", name: "LY8801 תל אביב → פרנקפורט", date: "2027-12-02", time: "07:10" },
  { type: "flight", name: "LY8802 פרנקפורט → תל אביב", date: "2027-12-09", time: "15:40" },
  { type: "hotel", name: "Hotel Colmar", confirmation: "HC-5521" },
];

/** Required answered, bookings from documents with no car, the offer behind them, "that's everything" said. */
async function readyToFinish(pool: pg.Pool, chatId: string, language: Language, bookings: unknown[] | null = DOCUMENT_BOOKINGS): Promise<void> {
  await answerRequired(pool, chatId);
  if (bookings) {
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object('travel_anchors', $2::jsonb)
        WHERE telegram_chat_id = $1`,
      [chatId, JSON.stringify({ kind: "structured", schema_version: 3, data: bookings })],
    );
  }
  await pool.query(
    `UPDATE control_plane.intake_sessions
        SET language = $2, awaiting = 'person', phase = 'optional',
            ui_state = jsonb_build_object('last_prompt', 'optional_offer', 'offered_more', true)
      WHERE telegram_chat_id = $1`,
    [chatId, language],
  );
}

class Recorder {
  readonly sent: { text: string; buttons: string[]; labels: string[] }[] = [];
  readonly edits: string[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data?: string; text?: string }[][] } }) {
    const flat = (p.replyMarkup?.inline_keyboard ?? []).flat();
    this.sent.push({ text: p.text, buttons: flat.map((b) => b.callback_data ?? ""), labels: flat.map((b) => b.text ?? "") });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText(p: { text?: string }) { this.edits.push(p.text ?? ""); return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

function runnerProposing(...proposals: unknown[]) {
  return {
    async run() {
      return { ok: true as const, value: { proposals, unclear: [], malformed: 0 }, attempts: 1, ms: 1 };
    },
  };
}

let seq = 0;
async function say(pool: pg.Pool, chatId: string, text: string, telegram: Recorder, modelRunner: unknown) {
  seq += 1;
  const log = () => {};
  await queueInboundMessage(pool, chatId, { text, message_id: `car${seq}` } as never);
  await flushSettledInboundBursts({ db: pool, telegram, connector: { pushInbound: () => true }, modelRunner, log } as never, log, 0);
}

async function tap(pool: pg.Pool, chat: { chatId: string; sessionId: string }, data: string, telegram: Recorder) {
  seq += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cqcar${seq}`, data, sessionId: chat.sessionId, messageId: "1" } as never,
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runnerProposing(), log: () => {} } as never,
  );
}

/** The router's turn: the floor is the machine's and the scan runs. */
async function routerTurn(pool: pg.Pool, chatId: string, telegram: Recorder): Promise<void> {
  await pool.query("UPDATE control_plane.intake_sessions SET awaiting = 'machine' WHERE telegram_chat_id = $1", [chatId]);
  await advanceRouterOwnedQuestions(
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runnerProposing() } as never, DEFAULT_STRINGS, () => {},
  );
}

const carQuestions = (telegram: Recorder, language: Language) =>
  telegram.sent.filter((m) => m.text.includes(uiString("carOwedLead", language)));
const recapsSent = (telegram: Recorder, language: Language) =>
  telegram.sent.filter((m) => m.text.includes(uiString("recapHeader", language)));

async function bookingsOf(pool: pg.Pool, chatId: string): Promise<any[]> {
  const store = await answersForChat(pool, chatId);
  const answer = store?.answers.travel_anchors;
  return answer && answer.kind === "structured" && Array.isArray(answer.data) ? (answer.data as any[]) : [];
}

const dbOptions = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

describe("the rental car is asked about before the summary", dbOptions, () => {
  test("flights and a hotel held, no car, 'that's everything': the car question comes, not the summary", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "he");
      const finished = await setFinishRequestedForChat(pool, chat.chatId, true);
      assert.ok(finished.ok);
      assert.equal(finished.view.state, "interviewing", "the summary is not reachable yet");
      assert.equal(finished.view.recap, null);
      const due = await getSessionForChat(pool, chat.chatId);
      assert.ok(due.ok);
      assert.equal(due.view.carDue, true);

      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);

      const asked = carQuestions(telegram, "he");
      assert.equal(asked.length, 1, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.equal(recapsSent(telegram, "he").length, 0, "no summary yet");
      assert.ok(asked[0]!.buttons.includes(NO_CAR_CALLBACK_DATA) && asked[0]!.buttons.includes(CAR_LATER_CALLBACK_DATA), "both shortcuts");
      assert.ok(asked[0]!.labels.includes(uiString("noRentalCar", "he")) && asked[0]!.labels.includes(uiString("carNotBookedYet", "he")));
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.lastPrompt, CAR_PROMPT);
      assert.equal((await answersForChat(pool, chat.chatId))!.ui.carAsked, true, "asked, and remembered");
      assert.equal((await bookingsOf(pool, chat.chatId)).length, 3, "asking files nothing");
    });
  });

  test("asked ONCE: a second router turn does not ask again", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en");
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);
      await routerTurn(pool, chat.chatId, telegram);
      await routerTurn(pool, chat.chatId, telegram);
      assert.equal(carQuestions(telegram, "en").length, 1);
    });
  });

  test("not asked when a car anchor already exists: the summary comes", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en", [...DOCUMENT_BOOKINGS, CAR]);
      const finished = await setFinishRequestedForChat(pool, chat.chatId, true);
      assert.ok(finished.ok);
      assert.equal(finished.view.state, "awaiting_confirmation");
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.carDue, false);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);
      assert.equal(carQuestions(telegram, "en").length, 0);
    });
  });

  test("empty bookings are asked about the car too (the typed and the empty cases)", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en", null);
      const finished = await setFinishRequestedForChat(pool, chat.chatId, true);
      assert.ok(finished.ok);
      const due = await getSessionForChat(pool, chat.chatId);
      assert.ok(due.ok);
      assert.equal(due.view.carDue, true);
    });
  });

  test("a rental car typed in words lands as a type:car anchor and the flights and hotel stay", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "he");
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);
      assert.equal(carQuestions(telegram, "he").length, 1);

      const text = "יש לנו רכב שכור מחברת Sixt, איסוף בנמל התעופה של פרנקפורט ב-2 בדצמבר, אישור SX-90417";
      await say(pool, chat.chatId, text, telegram, runnerProposing({
        questionId: "travel_anchors", confidence: 0.95, evidence: "רכב שכור מחברת Sixt, איסוף בנמל התעופה של פרנקפורט",
        value: {
          kind: "structured",
          data: [{ type: "car", name: "Sixt — איסוף בנמל התעופה פרנקפורט", date: "2027-12-02", confirmation: "SX-90417" }],
        },
      }));

      const bookings = await bookingsOf(pool, chat.chatId);
      assert.equal(bookings.filter((b) => b.type === "car").length, 1, JSON.stringify(bookings));
      assert.equal(bookings.filter((b) => b.type === "flight").length, 2, "both flights are still there");
      assert.equal(bookings.filter((b) => b.type === "hotel").length, 1, "and the hotel");
      assert.ok(bookings.some((b) => String(b.name).includes("LY8801")) && bookings.some((b) => b.confirmation === "HC-5521"), "untouched");
      assert.ok(bookings.some((b) => b.confirmation === "SX-90417"));
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.state, "awaiting_confirmation", "and now the summary comes");
      assert.ok(view.view.recap?.some((r) => r.questionId === "travel_anchors"), "with the bookings in it");
      assert.equal(carQuestions(telegram, "he").length, 1, "still asked once");
    });
  });

  test("the reader is SHOWN the bookings question while the car is asked, though documents filled the bookings", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en");
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);

      // What the real reader would be handed: only questions still outstanding are described to it, and the
      // bookings are answered. Without the poller adding it, a typed car has nowhere to go.
      const prompts: string[] = [];
      const recording = {
        async run(input: { prompt: string }) {
          prompts.push(input.prompt);
          return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0 }, attempts: 1, ms: 1 };
        },
      };
      await say(pool, chat.chatId, "we have a rental car from Sixt picked up at Frankfurt airport", telegram, recording);

      assert.equal(prompts.length, 1);
      const bookings = INTAKE_QUESTIONS.find((q) => q.id === "travel_anchors")!;
      assert.ok(prompts[0]!.includes(bookings.prompt), "the bookings question itself is described to the reader");
    });
  });

  test("'no rental car' typed in words is believed: nothing filed, never asked again, the summary comes", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "he");
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);

      await say(pool, chat.chatId, "אין לנו רכב שכור", telegram, runnerProposing());

      assert.equal((await bookingsOf(pool, chat.chatId)).length, 3, "nothing invented");
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.state, "awaiting_confirmation");
      assert.equal(carQuestions(telegram, "he").length, 1, "never a second time");
      assert.equal(recapsSent(telegram, "he").length, 1, "the summary was shown");
    });
  });

  test("the 'No rental car' button: believed, the summary comes, nothing filed", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en");
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);

      await tap(pool, chat, NO_CAR_CALLBACK_DATA, telegram);

      assert.equal((await bookingsOf(pool, chat.chatId)).length, 3);
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.state, "awaiting_confirmation");
      assert.equal(carQuestions(telegram, "en").length, 1);
      assert.equal(recapsSent(telegram, "en").length, 1);
      assert.ok(telegram.edits.some((t) => t.includes(uiString("noRentalCar", "en"))), "the keyboard collapses to what was chosen");
    });
  });

  test("the 'Not booked yet' button does the same", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "he");
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);

      await tap(pool, chat, CAR_LATER_CALLBACK_DATA, telegram);

      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.state, "awaiting_confirmation");
      assert.equal(carQuestions(telegram, "he").length, 1);
      assert.equal((await bookingsOf(pool, chat.chatId)).length, 3);
    });
  });

  test("the agent path is not held: no car question, the summary is reachable", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en");
      const finished = await setFinishRequestedForChat(pool, chat.chatId, true);
      assert.ok(finished.ok);
      assert.equal(finished.view.state, "awaiting_confirmation");
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.carDue, false);
      assert.equal(view.view.phase, "recap");
    }, { interpretPath: false });
  });

  test("a summary already on screen is not reopened for the car", async () => {
    await withInterview(async (pool, chat) => {
      await answerRequired(pool, chat.chatId);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'en', awaiting = 'person', phase = 'recap', state = 'awaiting_confirmation',
                ui_state = jsonb_build_object('last_prompt', 'recap', 'finish_requested', true, 'offered_more', true)
          WHERE telegram_chat_id = $1`,
        [chat.chatId],
      );
      assert.equal(await advancePhaseForChat(pool, chat.chatId), null, "no transition");
      const view = await getSessionForChat(pool, chat.chatId);
      assert.ok(view.ok);
      assert.equal(view.view.phase, "recap");
      assert.equal(view.view.state, "awaiting_confirmation");
      assert.equal(view.view.carDue, false);
      const stored = await pool.query("SELECT state FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [chat.chatId]);
      assert.equal(stored.rows[0].state, "awaiting_confirmation", "and the stored state did not move either");
    });
  });

  test("the car follows a typed-flight question: flights first, then the car, then the summary", async () => {
    await withInterview(async (pool, chat) => {
      await readyToFinish(pool, chat.chatId, "en", []);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET ui_state = ui_state || jsonb_build_object('typed_flights', jsonb_build_array('LY8801'))
          WHERE telegram_chat_id = $1`,
        [chat.chatId],
      );
      await setFinishRequestedForChat(pool, chat.chatId, true);
      const telegram = new Recorder();
      await routerTurn(pool, chat.chatId, telegram);
      assert.ok(telegram.sent.at(-1)!.text.includes("LY8801"), "the flight question first");
      assert.equal(carQuestions(telegram, "en").length, 0);

      await say(pool, chat.chatId, "they are not booked yet", telegram, runnerProposing());
      await routerTurn(pool, chat.chatId, telegram);
      assert.equal(carQuestions(telegram, "en").length, 1, `then the car — sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.equal(recapsSent(telegram, "en").length, 0);

      await tap(pool, chat, NO_CAR_CALLBACK_DATA, telegram);
      assert.equal(recapsSent(telegram, "en").length, 1);
    });
  });
});
