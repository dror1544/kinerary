/**
 * Mac staging, 2026-11-25 (Slovenia, Hebrew, interpret path): three things around the stops question.
 *
 *  1. A stay named at the stops question, with NO stop held yet, was read as a typed change to a stop that did not exist:
 *     "I couldn't find Ljubljana among your stops. Which one do you mean? You can tap one" - and nothing to tap.
 *  2. The organizer cancelled that change and was asked the stops question TWICE, back to back.
 *  3. The stops question asked "where are you going, and when?" of an organizer who had just created the trip with a
 *     destination and dates.
 *
 * Real path: `flushSettledInboundBursts` and `applyDecision` with a fake model, reading `intake_sessions` back.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { getSessionForChat, markAwaitingMachine, queueInboundMessage, recordLastPromptForChat, tripPlaceAndDatesKnown } from "../src/interview.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { askText, askTextAfterKnownDeclined, uiString } from "../src/intake-copy.js";
import { advanceRouterOwnedQuestions, applyDecision, flushSettledInboundBursts, forgetShownPreviewsForTests } from "../src/relay/poller.js";
import { setInterpretPath } from "../src/interpret.js";
import { INTAKE_QUESTIONS } from "../src/interview.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const SKIP = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };
const en = (key: string) => uiString(key, "en");

interface Chat { chatId: string; sessionId: string; tripId: string }

async function seedChat(pool: pg.Pool, chatId: string): Promise<Chat> {
  const userId = id("user");
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [id("memb"), tripId, userId],
  );
  const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(enrollment.ok);
  const started = await startFromDeepLink(pool, chatId, enrollment.token);
  assert.equal(started.kind, "started");
  await setInterpretPath(pool, chatId, true);
  return { chatId, sessionId: started.kind === "started" ? started.sessionId : "", tripId };
}

async function withChat(fn: (pool: pg.Pool, a: Chat) => Promise<void>): Promise<void> {
  const pool = testPool({ max: 10 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    forgetShownPreviewsForTests();
    await fn(pool, await seedChat(pool, "870000001"));
  } finally {
    await pool.end();
  }
}

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data });
const text = (t: string) => ({ kind: "text", schema_version: 3, text: t });

async function put(pool: pg.Pool, chat: Chat, questionId: string, value: unknown) {
  await pool.query(
    "UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1",
    [chat.sessionId, questionId, JSON.stringify(value)],
  );
}
async function answers(pool: pg.Pool, chat: Chat): Promise<Record<string, any>> {
  return (await pool.query("SELECT answers FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId])).rows[0]?.answers ?? {};
}
async function lastPrompt(pool: pg.Pool, chat: Chat): Promise<string | null> {
  return (await pool.query("SELECT ui_state->>'last_prompt' AS p FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId])).rows[0]?.p ?? null;
}
async function drafts(pool: pg.Pool, chat: Chat) {
  return (await pool.query("SELECT id, status FROM control_plane.intake_pending_changes WHERE session_id = $1 ORDER BY created_at", [chat.sessionId])).rows as { id: string; status: string }[];
}

type Button = { text: string; callback_data: string };
interface Sent { text: string; buttons: Button[] }
type Outgoing = { text: string; replyMarkup?: { inline_keyboard: Button[][] } };

/** A fake Telegram that can hold one matching send IN FLIGHT until released. */
class Telegram {
  readonly sent: Sent[] = [];
  private hold: { match: (p: Outgoing) => boolean; hit: () => void; gate: Promise<void> } | null = null;
  holdOn(match: (p: Outgoing) => boolean) {
    let hit!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((resolve) => { hit = resolve; });
    const gate = new Promise<void>((resolve) => { open = resolve; });
    this.hold = { match, hit, gate };
    return { reached, release: open };
  }
  async sendMessage(p: Outgoing) {
    if (this.hold?.match(p)) {
      const held = this.hold;
      this.hold = null;
      held.hit();
      await held.gate;
    }
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat() });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
  get last() { return this.sent[this.sent.length - 1]!; }
  get previews() { return this.sent.filter((s) => s.buttons.some((b) => b.callback_data.startsWith("pc:"))); }
}

function fakeModel(reply: () => Record<string, unknown>) {
  const calls = { n: 0 };
  return {
    calls,
    runner: {
      async run() {
        calls.n += 1;
        return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0, ...reply() }, attempts: 1, ms: 1 };
      },
    },
  };
}

let seq = 0;
const depsFor = (db: unknown, telegram: Telegram, model: { runner: unknown }) =>
  ({ db, telegram, connector: { pushInbound: () => true }, modelRunner: model.runner, log: () => {} }) as never;
async function say(db: any, chat: Chat, message: string, telegram: Telegram, model: { runner: unknown }) {
  seq += 1;
  await queueInboundMessage(db, chat.chatId, { text: message, message_id: `m${seq}` } as never);
  await flushSettledInboundBursts(depsFor(db, telegram, model), () => {}, 0);
}
function tap(db: any, chat: Chat, data: string, telegram: Telegram, model: { runner: unknown }) {
  seq += 1;
  return applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cq${seq}`, data, sessionId: chat.sessionId } as never,
    depsFor(db, telegram, model),
  );
}

/** Every required question before `phases` answered, the way the dashboard card and the first questions leave them. */
async function atStops(pool: pg.Pool, chat: Chat, opts: { destination?: string; start?: string; end?: string } = {}) {
  const known: Record<string, unknown> = {
    destination: text(opts.destination ?? "Slovenia"),
    departure_date: text(opts.start ?? "2027-05-10"),
    return_date: text(opts.end ?? "2027-05-17"),
    travelers: structured([{ name: "Dana Levi", age: 40 }]),
  };
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
    if (q.id === "phases") break;
    await put(pool, chat, q.id, known[q.id] ?? (q.type === "choice" ? { kind: "choice", schema_version: 3, option_id: q.options![0]!.id, other_text: null } : text("x")));
  }
  await recordLastPromptForChat(pool, chat.chatId, "q:phases");
  const view = await getSessionForChat(pool, chat.chatId);
  assert.ok(view.ok);
  assert.equal(view.view.nextQuestion?.id, "phases", "precondition: the stops question is the next one");
}

describe("#2: a change settled while the interview is waiting is followed by the next question exactly once", opts, () => {
  for (const choice of ["c", "a"] as const) {
    test(`a scan that runs while the tap's "${choice === "c" ? "cancelled" : "applied"}" notice is in flight does not make the question go out twice`, async () => {
      await withChat(async (pool, a) => {
        await atStops(pool, a);
        // The stops are held, so a change to one is a real change; the question the change displaced is the next one.
        const held = [{ name: "Tokyo", start: "2027-05-10", end: "2027-05-12" }, { name: "Kyoto", start: "2027-05-13", end: "2027-05-17" }];
        await put(pool, a, "phases", structured(held));
        const next = (await getSessionForChat(pool, a.chatId)) as { ok: true; view: { nextQuestion: { id: string } | null; language: "en" | "he" } };
        const question = INTAKE_QUESTIONS.find((q) => q.id === next.view.nextQuestion?.id)!;
        assert.ok(question, "precondition: a question is owed");
        await pool.query("UPDATE control_plane.intake_sessions SET ui_state = ui_state || jsonb_build_object('last_prompt', $2::text) WHERE id = $1", [a.sessionId, `q:${question.id}`]);

        const tg = new Telegram();
        const model = fakeModel(() => ({ ops: [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2027-05-11" } }] }));
        await say(pool, a, "Tokyo ends on the 11th", tg, model);
        const button = tg.previews.at(-1)!.buttons.find((b) => b.callback_data.endsWith(`:${choice}`))!;
        assert.ok(button, "a preview with the button");
        const before = tg.sent.length;
        const notice = en(choice === "c" ? "change.cancelled" : "change.applied");
        const gate = tg.holdOn((p) => p.text === notice);

        // The tap is on its way: the floor is the machine's, the draft is settled, the notice is in flight.
        const tapping = tap(pool, a, button.callback_data, tg, model);
        await gate.reached;
        // The tick scan runs now - the same thing the relay does every 700 ms.
        await advanceRouterOwnedQuestions(depsFor(pool, tg, model), DEFAULT_STRINGS, () => {});
        gate.release();
        await tapping;

        const asked = tg.sent.slice(before).filter((s) => s.text.includes(askText(question, "en")));
        assert.equal(asked.length, 1, `the question went out ${asked.length} times: ${JSON.stringify(tg.sent.slice(before).map((s) => s.text.slice(0, 40)))}`);
        assert.equal(await lastPrompt(pool, a), `q:${question.id}`, "and it is what is on screen");
      });
    });
  }
});

describe("#3: the stops question does not ask where they are going and when, once the card said", opts, () => {
  /** The router's own next step, as the tick scan sends it. */
  async function asked(pool: pg.Pool, a: Chat, language: "en" | "he"): Promise<Sent> {
    await pool.query("UPDATE control_plane.intake_sessions SET language = $2, ui_state = ui_state - 'last_prompt' WHERE id = $1", [a.sessionId, language]);
    await markAwaitingMachine(pool, a.chatId);
    const tg = new Telegram();
    await advanceRouterOwnedQuestions(depsFor(pool, tg, fakeModel(() => ({}))), DEFAULT_STRINGS, () => {});
    assert.equal(await lastPrompt(pool, a), "q:phases", `precondition: the stops question went out: ${JSON.stringify(tg.sent.map((s) => s.text.slice(0, 40)))}`);
    return tg.sent.at(-1)!;
  }
  const PLAIN = /Where are you going, and when|לאן אתם הולכים, ומתי/;

  for (const language of ["en", "he"] as const) {
    test(`${language}: a destination in non-Latin script cannot be offered as the only stop, and is asked for detail - the stops, the flights, where they stay`, async () => {
      await withChat(async (pool, a) => {
        await atStops(pool, a, { destination: "סלובניה — לובליאנה ובלד" });
        const sent = await asked(pool, a, language);
        assert.doesNotMatch(sent.text, PLAIN);
        assert.match(sent.text, language === "en" ? /Tell me more about the trip/ : /ספרו לי עוד על הטיול/);
        assert.match(sent.text, language === "en" ? /stops.*flights.*staying/ : /התחנות.*הטיסות.*ישנים/);
        assert.equal(sent.buttons.some((b) => b.callback_data.startsWith("pc:")), false);
      });
    });
  }

  test("and it is a question, not a form: what is typed in answer is read as any answer to the stops question", async () => {
    await withChat(async (pool, a) => {
      await atStops(pool, a, { destination: "סלובניה — לובליאנה ובלד" });
      await asked(pool, a, "he");
      const stops = [{ name: "לובליאנה", name_en: "Ljubljana", start: "2027-05-10", end: "2027-05-13" }, { name: "בלד", name_en: "Bled", start: "2027-05-13", end: "2027-05-17" }];
      await say(pool, a, "שלושה לילות בלובליאנה ואז בלד", new Telegram(), fakeModel(() => ({
        proposals: [{ questionId: "phases", confidence: 0.95, evidence: "לובליאנה ואז בלד", sourceMessageId: "m", value: { kind: "structured", data: stops } }],
      })));
      assert.deepEqual((await answers(pool, a)).phases?.data, stops);
    });
  });

  test("when the place or the dates are not known, the plain question stays (and what counts as known)", () => {
    const text = (t: string) => ({ kind: "text", schema_version: 3, text: t }) as never;
    const known = { destination: text("Slovenia"), departure_date: text("2027-05-10"), return_date: text("2027-05-17") };
    assert.equal(tripPlaceAndDatesKnown(known), true);
    assert.equal(tripPlaceAndDatesKnown({ ...known, destination: text("סלובניה") }), true, "script is no matter: it is asked for detail, not offered");
    for (const lacking of [{ destination: undefined }, { destination: text("  ") }, { departure_date: undefined }, { return_date: text("not a day") }, { return_date: text("2027-05-01") }]) {
      assert.equal(tripPlaceAndDatesKnown({ ...known, ...lacking } as never), false, JSON.stringify(lacking));
    }
    const phases = INTAKE_QUESTIONS.find((q) => q.id === "phases")!;
    assert.match(askText(phases, "en"), PLAIN);
    assert.match(askText(phases, "he"), PLAIN);
    assert.doesNotMatch(askTextAfterKnownDeclined(phases, "en"), PLAIN);
    assert.doesNotMatch(askTextAfterKnownDeclined(phases, "he"), PLAIN);
  });
});

const HE_MESSAGE = "טיסה LY5143 מתל אביב ללובליאנה ב-10 במאי 2027 ב-08:00, וחזרה LY5144 ב-17 במאי ב-16:00. מלון Grand Hotel Union בלובליאנה, אישור GU-4471.";
const HOTEL_OP = { op: "update_stop", target: { name: "לובליאנה" }, fields: { accommodation: { name: "Grand Hotel Union", confirmation: "GU-4471" } } };

describe("#1: a stay named at the stops question, with no stop yet, is the stops answer", opts, () => {
  const seededHebrew = async (pool: pg.Pool, a: Chat) => {
    await atStops(pool, a, { destination: "סלובניה — לובליאנה ובלד" });
    await pool.query("UPDATE control_plane.intake_sessions SET language = 'he' WHERE id = $1", [a.sessionId]);
  };

  test("the staging message: one stop for the place, the hotel in it, the trip's dates - and no change, no 'which one', nothing to press", async () => {
    await withChat(async (pool, a) => {
      await seededHebrew(pool, a);
      const tg = new Telegram();
      const model = fakeModel(() => ({ ops: [HOTEL_OP] }));
      await say(pool, a, HE_MESSAGE, tg, model);

      const phases = (await answers(pool, a)).phases;
      assert.deepEqual(phases?.data, [{
        name: "לובליאנה", start: "2027-05-10", end: "2027-05-17",
        accommodation: { name: "Grand Hotel Union", confirmation: "GU-4471" },
      }]);
      assert.deepEqual(await drafts(pool, a), [], "nothing was proposed as a change");
      assert.equal(tg.previews.length, 0, "no box with buttons for a change");
      assert.ok(tg.sent.every((s) => !s.text.includes("לא מצאתי")), JSON.stringify(tg.sent.map((s) => s.text.slice(0, 60))));
      const view = await getSessionForChat(pool, a.chatId);
      assert.ok(view.ok);
      assert.notEqual(view.view.nextQuestion?.id, "phases", "the interview moved on");
    });
  });

  test("the reader proposed the stops itself as well: that wins, and the operation is not applied over it", async () => {
    await withChat(async (pool, a) => {
      await seededHebrew(pool, a);
      const tg = new Telegram();
      const proposed = [{ name: "לובליאנה", name_en: "Ljubljana", start: "2027-05-10", end: "2027-05-17", accommodation: { name: "Grand Hotel Union", confirmation: "GU-4471" } }];
      const model = fakeModel(() => ({
        proposals: [{ questionId: "phases", confidence: 0.95, evidence: "מלון Grand Hotel Union בלובליאנה", sourceMessageId: "m", value: { kind: "structured", data: proposed } }],
        ops: [HOTEL_OP],
      }));
      await say(pool, a, HE_MESSAGE, tg, model);
      assert.deepEqual((await answers(pool, a)).phases?.data, proposed);
      assert.deepEqual(await drafts(pool, a), []);
    });
  });

  test("a removal of a stop that is not there is still a change - and says there is nothing to pick from, with a way out", async () => {
    await withChat(async (pool, a) => {
      await atStops(pool, a);
      const tg = new Telegram();
      const model = fakeModel(() => ({ ops: [{ op: "remove_stop", target: { name: "Osaka" } }] }));
      await say(pool, a, "drop Osaka", tg, model);
      const box = tg.previews.at(-1)!;
      assert.ok(box, "the organizer is told");
      assert.doesNotMatch(box.text, /tap one|ללחוץ על אחד/);
      assert.deepEqual(box.buttons.map((b) => b.callback_data.split(":").at(-1)), ["c"], "only the way out");
    });
  });
});
