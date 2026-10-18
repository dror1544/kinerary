/**
 * The summary is on screen and the organizer says "also, we sleep at Hotel X".
 *
 * Live, 2026-10-15 (Hebrew, session sess_dd60b981...): after the summary was shown
 * the organizer typed that they wanted to add the hotel they were sleeping at.
 * The relay logged `interpret_ok proposals=0`, then `expectation_restated
 * NOT_UNDERSTOOD` and the offer; the organizer typed the hotel again and got
 * `proposals=0 unclear=1`, a boundary reading of `answer_only` that captured
 * nothing, and the summary again under "I didn't quite follow". They confirmed
 * it without the hotel. "When the summary is set and I ask to add more, it is
 * not receptive to any new information and strives to finish."
 *
 * Three things are pinned here, because three things went wrong together:
 *   1. the reader was not told that the summary is on screen, so a hotel had no
 *      stated home (a stop's accommodation) and was left `unclear`;
 *   2. a message the reader called `unclear` — or the boundary reader called
 *      `answer_only` — that captured nothing was met with "I didn't follow",
 *      said to a person who was followed perfectly well;
 *   3. nothing told the organizer HOW to add the thing, so the second attempt
 *      was as unlucky as the first.
 * The fake model returns what a correct model returns given the full question
 * set; what a live model does with the prompt is only measurable live.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { CONFIRM_CALLBACK_DATA, startFromDeepLink } from "../src/chat-router.js";
import {
  getSessionForChat,
  queueInboundMessage,
  recordLastPromptForChat,
  setFinishRequestedForChat,
  INTAKE_QUESTIONS,
} from "../src/interview.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision, flushSettledInboundBursts, OPTIONAL_OFFER_PROMPT } from "../src/relay/poller.js";
import { setInterpretPath } from "../src/interpret.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

interface Chat { chatId: string; sessionId: string }

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
  return { chatId, sessionId: started.kind === "started" ? started.sessionId : "" };
}

async function withChat(fn: (pool: pg.Pool, a: Chat) => Promise<void>): Promise<void> {
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
    await fn(pool, await seedChat(pool, "860000001"));
  } finally {
    await pool.end();
  }
}

const COLMAR = { name: "קולמר", name_en: "Colmar", start: "2026-12-01", end: "2026-12-05" };
const HOTEL_MESSAGE = "נישן במלון Hotel Le Colombier בקולמר";
const HOTEL_OPS = [{
  op: "update_stop",
  target: { name: "קולמר" },
  fields: { accommodation: { name: "Hotel Le Colombier" } },
}];

async function put(pool: pg.Pool, chat: Chat, questionId: string, value: unknown) {
  await pool.query(
    `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
      WHERE telegram_chat_id = $1`,
    [chat.chatId, questionId, JSON.stringify(value)],
  );
}

/** Every required question answered, the stops held, language Hebrew. */
async function answered(pool: pg.Pool, chat: Chat) {
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
    await put(pool, chat, q.id, q.id === "travelers"
      ? { kind: "structured", schema_version: 3, data: [{ name: "x" }] }
      : { kind: "text", schema_version: 3, text: "x" });
  }
  await put(pool, chat, "phases", { kind: "structured", schema_version: 3, data: [COLMAR] });
  await pool.query("UPDATE control_plane.intake_sessions SET language = 'he' WHERE telegram_chat_id = $1", [chat.chatId]);
}

/** The summary on screen: finish requested, phase recap, last prompt `recap`. */
async function recapOnScreen(pool: pg.Pool, chat: Chat) {
  await answered(pool, chat);
  await setFinishRequestedForChat(pool, chat.chatId, true);
  await recordLastPromptForChat(pool, chat.chatId, "recap");
  const view = await getSessionForChat(pool, chat.chatId);
  assert.ok(view.ok && view.view.state === "awaiting_confirmation", "the summary is what the session is at");
}

/** The offer ("more details, or the summary?") on screen, optional questions outstanding. */
async function offerOnScreen(pool: pg.Pool, chat: Chat) {
  await answered(pool, chat);
  await pool.query(
    `UPDATE control_plane.intake_sessions
        SET state = 'interviewing', awaiting = 'person', phase = 'optional',
            ui_state = jsonb_build_object('offered_more', true, 'last_prompt', $2::text)
      WHERE telegram_chat_id = $1`,
    [chat.chatId, OPTIONAL_OFFER_PROMPT],
  );
}

type Button = { text: string; callback_data: string };
class Telegram {
  readonly sent: { text: string; buttons: Button[] }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: Button[][] } }) {
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
  get texts() { return this.sent.map((m) => m.text); }
}

/**
 * Interpret answers first, the boundary reading second — told apart by the
 * schema each asks for, as in production. `interpret` is a function so a test
 * can change what the "model" says between messages.
 */
function model(interpret: () => { ops?: unknown[]; unclear?: { questionId: string; why: string }[] }, boundary?: unknown) {
  const prompts: string[] = [];
  const log: string[] = [];
  return {
    prompts,
    log,
    runner: {
      async run(req: { prompt: string; schema?: { properties?: Record<string, unknown> }; parse: (raw: unknown) => unknown }) {
        const isBoundary = Boolean(req.schema?.properties?.intent);
        let raw: unknown;
        if (isBoundary) {
          log.push("boundary");
          raw = boundary ?? { intent: "unclear", confidence: 0.3 };
        } else {
          prompts.push(req.prompt);
          log.push("interpret");
          const said = interpret();
          raw = {
            proposals: [],
            unclear: said.unclear ?? [],
            ...(said.ops ? { opsJson: JSON.stringify(said.ops) } : {}),
          };
        }
        const parsed = req.parse(raw);
        if (parsed === null) return { ok: false as const, reason: "BAD_OUTPUT", detail: "", attempts: 1, ms: 1 };
        return { ok: true as const, value: parsed, attempts: 1, ms: 1 };
      },
    },
  };
}

let seq = 0;
async function say(pool: pg.Pool, chat: Chat, text: string, telegram: Telegram, runner: unknown) {
  seq += 1;
  await queueInboundMessage(pool, chat.chatId, { text, message_id: `r${seq}` } as never);
  const log = () => {};
  await flushSettledInboundBursts(
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner, log } as never,
    log,
    0,
  );
}

async function tap(pool: pg.Pool, chat: Chat, data: string, telegram: Telegram, runner: unknown) {
  seq += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cq${seq}`, data, sessionId: chat.sessionId } as never,
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner, log: () => {} } as never,
  );
}

async function storedStops(pool: pg.Pool, chat: Chat): Promise<any[]> {
  const r = await pool.query("SELECT answers -> 'phases' AS a FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId]);
  return r.rows[0]?.a?.data ?? [];
}

const didNotFollow = (text: string) => text.includes(uiString("didNotFollow", "he"));

describe("the summary on screen is receptive to new information", opts, () => {
  test("a hotel typed at the summary reaches the stop it belongs to, is shown back, and the summary returns with it", async () => {
    await withChat(async (pool, a) => {
      await recapOnScreen(pool, a);
      const tg = new Telegram();
      const m = model(() => ({ ops: HOTEL_OPS }));

      await say(pool, a, HOTEL_MESSAGE, tg, m.runner);

      assert.ok(!tg.texts.some(didNotFollow), `nobody is told they were not followed — sent: ${JSON.stringify(tg.texts)}`);
      assert.match(tg.last.text, /Hotel Le Colombier/, "the change is shown back with the hotel");
      assert.equal((await storedStops(pool, a))[0].accommodation, undefined, "nothing is stored before the organizer agrees");

      const yes = tg.last.buttons.find((b) => b.callback_data.endsWith(":a"));
      assert.ok(yes, `a Yes button is offered — buttons: ${JSON.stringify(tg.last.buttons)}`);
      await tap(pool, a, yes!.callback_data, tg, m.runner);

      assert.deepEqual((await storedStops(pool, a))[0].accommodation, { name: "Hotel Le Colombier" });
      const recap = tg.sent.filter((s) => s.text.includes(uiString("recapHeader", "he")));
      assert.ok(recap.length > 0, "the summary comes back");
      assert.match(recap[recap.length - 1]!.text, /Hotel Le Colombier/, "and it carries the hotel");
    });
  });

  test("the reader is told the summary is up, and is given every answerable question — stops, bookings, and the hotel's home", async () => {
    await withChat(async (pool, a) => {
      await recapOnScreen(pool, a);
      const tg = new Telegram();
      const m = model(() => ({ ops: HOTEL_OPS }));
      await say(pool, a, HOTEL_MESSAGE, tg, m.runner);
      const prompt = m.prompts[0]!;
      assert.match(prompt, /summary/i, "told the summary is on screen");
      assert.match(prompt, /id: travel_anchors/, "the bookings question is described in full");
      assert.match(prompt, /id: constraints/, "so is every other answerable question");
      assert.match(prompt, /Stops:\n- s1: /, "the held stops are listed under their ids");
      assert.match(prompt, /A HOTEL[\s\S]*ACCOMMODATION of the stop/, "a hotel is said to be a stop's accommodation");
    });
  });

  test("a hotel the reader cannot place is asked about — what to say and where — not 'I didn't follow'", async () => {
    await withChat(async (pool, a) => {
      await recapOnScreen(pool, a);
      const tg = new Telegram();
      // The 2026-10-15 reading: nothing proposed, one question left unclear.
      const m = model(() => ({ unclear: [{ questionId: "travel_anchors", why: "a hotel, stop unknown" }] }), { intent: "unclear", confidence: 0.2 });

      await say(pool, a, "אני רוצה להוסיף את המלון שבו אנחנו ישנים", tg, m.runner);

      assert.ok(tg.sent.length > 0, "something is said");
      assert.ok(!tg.texts.some(didNotFollow), `not 'I didn't follow' — sent: ${JSON.stringify(tg.texts)}`);
      assert.equal(tg.last.text.includes(uiString("recapNothingCaptured", "he")), true, `says how to add it — sent: ${tg.last.text}`);
      assert.ok(tg.last.buttons.some((b) => b.callback_data === CONFIRM_CALLBACK_DATA), "and the Confirm button is still there");

      // It does not loop: the next, successful message is taken, and the summary stands.
      const m2 = model(() => ({ ops: HOTEL_OPS }));
      await say(pool, a, HOTEL_MESSAGE, tg, m2.runner);
      assert.match(tg.last.text, /Hotel Le Colombier/);
    });
  });

  test("confirm still confirms from the summary", async () => {
    await withChat(async (pool, a) => {
      await recapOnScreen(pool, a);
      const tg = new Telegram();
      const m = model(() => ({}));
      await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, m.runner);
      const r = await pool.query("SELECT state FROM control_plane.intake_sessions WHERE id = $1", [a.sessionId]);
      assert.equal(r.rows[0].state, "confirmed");
    });
  });
});

describe("the offer on screen is receptive to new information", opts, () => {
  test("a hotel typed at 'more, or the summary?' is captured as a change, not restated", async () => {
    await withChat(async (pool, a) => {
      await offerOnScreen(pool, a);
      const tg = new Telegram();
      const m = model(() => ({ ops: HOTEL_OPS }), { intent: "answer_only", confidence: 0.85 });
      await say(pool, a, HOTEL_MESSAGE, tg, m.runner);
      assert.ok(!tg.texts.some(didNotFollow), `sent: ${JSON.stringify(tg.texts)}`);
      assert.match(tg.last.text, /Hotel Le Colombier/);
    });
  });

  test("answer_only with nothing captured says it could not place it and how to say it — never 'I didn't follow'", async () => {
    await withChat(async (pool, a) => {
      await offerOnScreen(pool, a);
      const tg = new Telegram();
      const m = model(() => ({ unclear: [{ questionId: "travel_anchors", why: "a hotel, stop unknown" }] }), { intent: "answer_only", confidence: 0.85 });
      await say(pool, a, "אני רוצה להוסיף את המלון שבו אנחנו ישנים", tg, m.runner);
      assert.ok(!tg.texts.some(didNotFollow), `sent: ${JSON.stringify(tg.texts)}`);
      assert.equal(tg.last.text, uiString("couldNotPlace", "he"));
      assert.equal(tg.last.buttons.length, 2, "both exits are still underneath");
    });
  });
});
