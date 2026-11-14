/**
 * Corrections typed at the final summary (state `awaiting_confirmation`): a date said in words, and travellers
 * added by name.
 *
 * Mac staging, 2026-11-08, Sprint 8 manual test, Hebrew interview, session sess_1c5d0972... (`interpret_path`):
 *   1. The trip was made on the dashboard for 14-21 Nov. At the summary the organizer said they fly back on the
 *      22nd of November and confirmed. `return_date` was stored as the Hebrew words "22 בנובמבר 2026", not
 *      `2026-11-22`; `departure_date` and the stop were right. The worker reads ISO only and fell back to today + 90
 *      days (a February 2027 trip, slug `...-2027`); `trips.end_date` stayed 21 Nov; `datesInOrder` called a
 *      non-ISO value "fine", so nothing noticed.
 *   2. At the same summary "נוסעים אחרים" and then "Mira Vesper, Tom Vesper" came back `interpret_ok proposals=0
 *      unclear=1` -> `change_not_understood questions:["travelers"]`, three times. The clarifying question
 *      (#413) was only wired to the turn after a DOCUMENT recap, and the names that follow it had no context.
 *
 * These drive the real path - `flushSettledInboundBursts` and the confirming tap - with only Telegram (a
 * recorder) and the model (a script) faked. What a live model does with the prompt is only measurable live;
 * what is pinned is that its honest readings now land correctly.
 *
 * Contract shapes: the date tests write `text` answers (the same shape for an agentless and an agent interview);
 * the travellers arrive as `ops` (`add_traveller`), the one write path for a held list.
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
  answersForChat,
  getSessionForChat,
  queueInboundMessage,
  recordLastPromptForChat,
  setFinishRequestedForChat,
  INTAKE_QUESTIONS,
} from "../src/interview.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision, flushSettledInboundBursts } from "../src/relay/poller.js";
import { setInterpretPath } from "../src/interpret.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

interface Chat { chatId: string; sessionId: string; tripId: string }

const FOUR = [
  { name: "Arlo", name_en: "Arlo" },
  { name: "Lena", name_en: "Lena" },
  { name: "Bria", name_en: "Bria" },
  { name: "Cole", name_en: "Cole" },
];
const STOP = { name: "Gatecity", name_en: "Gatecity", start: "2026-11-14", end: "2026-11-22" };

async function put(pool: pg.Pool, chat: Chat, questionId: string, value: unknown) {
  await pool.query(
    `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
      WHERE telegram_chat_id = $1`,
    [chat.chatId, questionId, JSON.stringify(value)],
  );
}

async function withSummary(language: "he" | "en", fn: (pool: pg.Pool, chat: Chat) => Promise<void>): Promise<void> {
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
    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
    // The dashboard's card: 14-21 Nov.
    await pool.query(
      `INSERT INTO control_plane.trips(id, slug, lifecycle_state, title, destination_label, start_date, end_date, trip_type)
       VALUES ($1, $2, 'draft', 'Gatecity trip', 'Gatecity', '2026-11-14', '2026-11-21', 'family')`,
      [tripId, tripId.replace(/_/g, "-")],
    );
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [id("memb"), tripId, userId],
    );
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(enrollment.ok);
    const chatId = "870000438";
    const started = await startFromDeepLink(pool, chatId, enrollment.token);
    assert.equal(started.kind, "started");
    await setInterpretPath(pool, chatId, true);
    const chat: Chat = { chatId, sessionId: started.kind === "started" ? started.sessionId : "", tripId };

    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      await put(pool, chat, q.id, { kind: "text", schema_version: 3, text: q.id === "organizer_identity" ? "Arlo" : "x" });
    }
    await put(pool, chat, "travelers", { kind: "structured", schema_version: 3, data: FOUR });
    await put(pool, chat, "phases", { kind: "structured", schema_version: 3, data: [STOP] });
    await put(pool, chat, "departure_date", { kind: "text", schema_version: 3, text: "2026-11-14" });
    await put(pool, chat, "return_date", { kind: "text", schema_version: 3, text: "2026-11-21" });
    await pool.query("UPDATE control_plane.intake_sessions SET language = $2 WHERE telegram_chat_id = $1", [chatId, language]);
    await setFinishRequestedForChat(pool, chatId, true);
    await recordLastPromptForChat(pool, chatId, "recap");
    const view = await getSessionForChat(pool, chatId);
    assert.ok(view.ok && view.view.state === "awaiting_confirmation", "the summary is what the session is at");
    await fn(pool, chat);
  } finally {
    await pool.end();
  }
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

interface Said { proposals?: unknown[]; unclear?: { questionId: string; why: string }[]; ops?: unknown[] }

/** The reader answers with whatever `said()` returns at that moment; the boundary reader is never decisive. */
function model(said: () => Said) {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      async run(req: { prompt: string; schema?: { properties?: Record<string, unknown> }; parse: (raw: unknown) => unknown }) {
        if (req.schema?.properties?.intent) return { ok: true as const, value: req.parse({ intent: "unclear", confidence: 0.3 }), attempts: 1, ms: 1 };
        prompts.push(req.prompt);
        const s = said();
        const parsed = req.parse({
          proposals: s.proposals ?? [],
          unclear: s.unclear ?? [],
          ...(s.ops ? { opsJson: JSON.stringify(s.ops) } : {}),
        });
        if (parsed === null) return { ok: false as const, reason: "BAD_OUTPUT", detail: "", attempts: 1, ms: 1 };
        return { ok: true as const, value: parsed, attempts: 1, ms: 1 };
      },
    },
  };
}

let seq = 0;
async function say(pool: pg.Pool, chat: Chat, text: string, telegram: Telegram, runner: unknown, logs: string[] = []) {
  seq += 1;
  await queueInboundMessage(pool, chat.chatId, { text, message_id: `s${seq}` } as never);
  const log = (line: string) => logs.push(line);
  await flushSettledInboundBursts({ db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner, log } as never, log, 0);
}

async function tap(pool: pg.Pool, chat: Chat, data: string, telegram: Telegram, runner: unknown, logs: string[] = []) {
  seq += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cq${seq}`, data, sessionId: chat.sessionId } as never,
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner, log: (l: string) => logs.push(l) } as never,
  );
}

async function text(pool: pg.Pool, chat: Chat, questionId: string): Promise<string | undefined> {
  const a = (await answersForChat(pool, chat.chatId))?.answers[questionId];
  return a?.kind === "text" ? a.text : undefined;
}

async function travellerNames(pool: pg.Pool, chat: Chat): Promise<string[]> {
  const a = (await answersForChat(pool, chat.chatId))?.answers.travelers;
  return a?.kind === "structured" ? (a.data as { name: string }[]).map((p) => p.name) : [];
}

const asDate = (questionId: "departure_date" | "return_date", value: string, evidence: string) => ({
  questionId, confidence: 0.9, value: { kind: "text", text: value }, evidence,
});

describe("a date said in words at the summary is stored as a day (2026-11-08)", opts, () => {
  for (const [language, message, evidence, words] of [
    ["he", "בעצם אנחנו חוזרים ב-22 בנובמבר", "22 בנובמבר", "22 בנובמבר 2026"],
    ["en", "actually we fly back on 22 November", "22 November", "22 November 2026"],
  ] as const) {
    test(`${language}: the return date the reader wrote in words is stored as YYYY-MM-DD, and the card follows on confirm`, async () => {
      await withSummary(language, async (pool, chat) => {
        const tg = new Telegram();
        const logs: string[] = [];
        const m = model(() => ({ proposals: [asDate("return_date", words, evidence)] }));
        await say(pool, chat, message, tg, m.runner, logs);

        assert.equal(await text(pool, chat, "return_date"), "2026-11-22", "stored as a day, never as the organizer's words");
        assert.equal(await text(pool, chat, "departure_date"), "2026-11-14");

        await tap(pool, chat, CONFIRM_CALLBACK_DATA, tg, m.runner, logs);
        const trip = await pool.query("SELECT start_date::text AS s, end_date::text AS e FROM control_plane.trips WHERE id = $1", [chat.tripId]);
        assert.deepEqual(trip.rows[0], { s: "2026-11-14", e: "2026-11-22" }, "the dashboard card shows the confirmed dates");
        const intake = await pool.query(
          "SELECT data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
          [chat.tripId],
        );
        const held = intake.rows[0].data;
        assert.equal((held.answers ?? held).return_date.text, "2026-11-22", "and so does the confirmed intake the worker reads");
      });
    });
  }

  for (const [language, message, said] of [
    ["he", "בעצם אנחנו חוזרים ב-22 בנובמבר", "22 בנובמבר"],
    ["en", "actually we fly back on 22 November", "22 November"],
  ] as const) {
    test(`${language}: a day and month with no year takes its year from the held departure`, async () => {
      await withSummary(language, async (pool, chat) => {
        const tg = new Telegram();
        const m = model(() => ({ proposals: [asDate("return_date", said, said)] }));
        await say(pool, chat, message, tg, m.runner);
        assert.equal(await text(pool, chat, "return_date"), "2026-11-22", "first such day on or after the held departure (2026-11-14)");
        assert.ok(!tg.texts.some((t) => t.startsWith("I wasn't sure what you wanted to change")), "nothing is refused");
      });
    });
  }

  test("a year-less departure is placed on or before the held return", async () => {
    await withSummary("en", async (pool, chat) => {
      const tg = new Telegram();
      const m = model(() => ({ proposals: [asDate("departure_date", "13 November", "13 November")] }));
      await say(pool, chat, "we leave on 13 November", tg, m.runner);
      assert.equal(await text(pool, chat, "departure_date"), "2026-11-13", "the last such day on or before the held return (2026-11-21)");
    });
  });

  test("a day that cannot be placed is not guessed: it is asked about, and the stored day stays", async () => {
    await withSummary("en", async (pool, chat) => {
      const tg = new Telegram();
      const m = model(() => ({ proposals: [asDate("return_date", "3/4", "3/4")] }));
      await say(pool, chat, "actually we fly back on 3/4", tg, m.runner);

      assert.equal(await text(pool, chat, "return_date"), "2026-11-21", "the held day is untouched");
      assert.ok(tg.sent.length > 0, "and the organizer is told, not left believing it was recorded");
      assert.ok(tg.texts.some((t) => t.startsWith("I wasn't sure what you wanted to change about")), `asked about it - sent: ${JSON.stringify(tg.texts)}`);
    });
  });

  test("the departure goes through the same gate", async () => {
    await withSummary("en", async (pool, chat) => {
      const tg = new Telegram();
      const m = model(() => ({ proposals: [asDate("departure_date", "Nov 13, 2026", "13 November")] }));
      await say(pool, chat, "we leave on 13 November", tg, m.runner);
      assert.equal(await text(pool, chat, "departure_date"), "2026-11-13");
    });
  });
});

describe("travellers added at the summary (2026-11-08)", opts, () => {
  for (const [language, first, names, ask] of [
    ["he", "נוסעים אחרים", "Mira Vesper, Tom Vesper", uiString("askOtherTravellers", "he")],
    ["en", "other travellers", "Mira Vesper, Tom Vesper", uiString("askOtherTravellers", "en")],
  ] as const) {
    test(`${language}: "${first}" asks who they are, and the names that follow are ADDED to the four held`, async () => {
      await withSummary(language, async (pool, chat) => {
        const tg = new Telegram();
        const logs: string[] = [];
        let next: Said = { unclear: [{ questionId: "travelers", why: "other travellers, no names" }] };
        const m = model(() => next);

        await say(pool, chat, first, tg, m.runner, logs);
        assert.equal(tg.last.text, ask, `asked who they are - sent: ${JSON.stringify(tg.texts)}`);
        assert.ok(!logs.some((l) => l.includes("change_not_understood")), "not met with 'I did not follow'");
        assert.match(m.prompts.at(-1) ?? "", /names nobody/, "the reader was told what to do with a nameless message about travellers");
        assert.deepEqual(await travellerNames(pool, chat), ["Arlo", "Lena", "Bria", "Cole"]);

        next = { ops: [{ op: "add_traveller", fields: { name: "Mira Vesper" } }, { op: "add_traveller", fields: { name: "Tom Vesper" } }] };
        await say(pool, chat, names, tg, m.runner, logs);
        assert.match(m.prompts.at(-1) ?? "", /JUST ASKED THEM WHO THE OTHER TRAVELLERS ARE/, "the reader knows the names answer that question");
        assert.match(m.prompts.at(-1) ?? "", /add_traveller/, "and that each is added");
        assert.deepEqual(await travellerNames(pool, chat), ["Arlo", "Lena", "Bria", "Cole"], "nothing is written before the confirming tap");

        const yes = tg.last.buttons.find((b) => b.callback_data.startsWith("pc:") && b.callback_data.endsWith(":a"));
        assert.ok(yes, `a preview with a confirm button - sent: ${JSON.stringify(tg.last)}`);
        await tap(pool, chat, yes!.callback_data, tg, m.runner, logs);
        assert.deepEqual(
          await travellerNames(pool, chat),
          ["Arlo", "Lena", "Bria", "Cole", "Mira Vesper", "Tom Vesper"],
          "the four are kept and the two are added",
        );
      });
    });
  }

  test("the question is not asked twice in a row: a second nameless reply gets the plain 'not understood'", async () => {
    await withSummary("en", async (pool, chat) => {
      const tg = new Telegram();
      const logs: string[] = [];
      const m = model(() => ({ unclear: [{ questionId: "travelers", why: "no names" }] }));
      await say(pool, chat, "other travellers", tg, m.runner, logs);
      assert.equal(tg.last.text, uiString("askOtherTravellers", "en"));
      assert.ok(!logs.some((l) => l.includes("change_not_understood")));
      await say(pool, chat, "you know, the others", tg, m.runner, logs);
      assert.ok(logs.some((l) => l.includes("change_not_understood")), "then the way out, not the same question again");
      assert.deepEqual(await travellerNames(pool, chat), ["Arlo", "Lena", "Bria", "Cole"]);
    });
  });
});
