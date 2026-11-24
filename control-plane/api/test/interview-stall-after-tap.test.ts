/**
 * THE INTERVIEW MUST NOT GO QUIET AFTER A TAP (nightly e2e 2026-11-24, issue #637).
 *
 * The nightly "multi" scenario stalled at the second question, with the organizer's
 * answer recorded and nobody left to ask the next one:
 *
 *   step_sent q:trip_type          the router asks; the floor is the organizer's
 *   prompt_deduped q:trip_type     a second pass says "already on screen" ...
 *   floor_held_by_person x2        ... and every later pass is refused
 *   router_prompt_sent             (logged whether or not anything was sent)
 *   session: awaiting=person, last_prompt=q:trip_type, next question = travelers
 *
 * The second pass is the cause. The tick scan (`advanceRouterOwnedQuestions`) reads a view, then spends several
 * queries before it reaches `sendNextStep`'s dedupe. An organizer who taps fast - the nightly's automated one does
 * so within milliseconds - lands the answer in that gap. The scan then holds a view saying "trip_type is on screen
 * and unanswered", dedupes it, and `claimFloor` hands the floor to the person: for a question they have just
 * answered. Nothing is scheduled any more - `router_prompt_due_at` is a one-shot spent long ago, the scan lists only
 * `awaiting = 'machine'` sessions - and the tap's own reply is no help, because an answer's view carries the
 * builder's default floor ("person"), so `respond` believed the floor was already the organizer's and gave up.
 *
 * Asserted here, each way the gap can be hit:
 *  - a stale scan lands between the answer and the tap's reply;
 *  - a stale scan lands after the tap's reply has already spoken (exactly once, never twice);
 *  - the itinerary note arriving after the tap changes nothing (the brief's first suspicion);
 *  - a session that is somehow stuck that way anyway is found and spoken to (the safety net).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import {
  answersForChat,
  getSessionForChat,
  markAwaitingMachine,
  type SessionView,
} from "../src/interview.js";
import {
  advanceRouterOwnedQuestions,
  applyDecision,
  foldItineraryFromDocument,
  rescueAnsweredButSilent,
  sendNextStep,
} from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { setInterpretPath } from "../src/interpret.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const dbOptions = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

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

/**
 * The session as the nightly's was after the documents were read: destination and dates held, the stops filed, the
 * travellers not (LOW_CONFIDENCE), the trip type not yet asked.
 */
async function afterDocuments(pool: pg.Pool, chatId: string): Promise<void> {
  const text = (value: string) => ({ kind: "text", schema_version: 3, text: value });
  const phases = {
    kind: "structured", schema_version: 3,
    data: [{ name: "Rome", start: "2026-05-02", end: "2026-05-06" }, { name: "Florence", start: "2026-05-06", end: "2026-05-12" }],
  };
  await pool.query(
    `UPDATE control_plane.intake_sessions
        SET answers = answers || jsonb_build_object('destination', $2::jsonb, 'departure_date', $3::jsonb,
                                                    'return_date', $4::jsonb, 'phases', $5::jsonb),
            phase = 'essentials', awaiting = 'person', language = 'en'
      WHERE telegram_chat_id = $1`,
    [chatId, JSON.stringify(text("Italy")), JSON.stringify(text("2026-05-02")), JSON.stringify(text("2026-05-12")), JSON.stringify(phases)],
  );
}

async function withInterview(fn: (pool: pg.Pool, chat: { chatId: string; sessionId: string }) => Promise<void>): Promise<void> {
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
    const chat = await seedInterview(pool, "870000001");
    await setInterpretPath(pool, chat.chatId, true);
    await afterDocuments(pool, chat.chatId);
    await fn(pool, chat);
  } finally {
    await pool.end();
  }
}

class Recorder {
  readonly sent: { text: string; buttons: string[] }[] = [];
  readonly edits: string[] = [];
  /** Runs inside the tap's own edit of the question it answered - after the answer is recorded, before the reply. */
  onEdit: (() => Promise<void>) | null = null;
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data?: string }[][] } }) {
    const flat = (p.replyMarkup?.inline_keyboard ?? []).flat();
    this.sent.push({ text: p.text, buttons: flat.map((b) => b.callback_data ?? "") });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText(p: { text?: string }) {
    this.edits.push(p.text ?? "");
    const hook = this.onEdit;
    this.onEdit = null;
    if (hook) await hook();
    return { ok: true as const };
  }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

const depsFor = (pool: pg.Pool, telegram: Recorder) =>
  ({ db: pool, telegram, connector: { pushInbound: () => true }, log: () => {} }) as never;

/** Messages that put this question to the organizer (by its buttons, or its words). */
const asking = (telegram: Recorder, key: "trip_type" | "travelers") =>
  telegram.sent.filter((m) =>
    key === "trip_type"
      ? m.buttons.some((b) => b.includes("trip_type"))
      : m.text.toLowerCase().includes("who is coming") || m.text.toLowerCase().includes("travel"));

/** The router's own turn: the tick scan runs over every session whose floor is the machine's. */
async function scan(pool: pg.Pool, telegram: Recorder): Promise<void> {
  await advanceRouterOwnedQuestions(depsFor(pool, telegram), DEFAULT_STRINGS, () => {});
}

async function tapFamily(pool: pg.Pool, chat: { chatId: string; sessionId: string }, telegram: Recorder): Promise<void> {
  await applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: "cq1", data: "a:trip_type:family", sessionId: chat.sessionId, messageId: "1" } as never,
    depsFor(pool, telegram),
  );
}

async function floorOf(pool: pg.Pool, chatId: string): Promise<string> {
  const r = await pool.query("SELECT awaiting FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [chatId]);
  return String(r.rows[0]?.awaiting);
}

/** What the scan holds when it is overtaken: read once the tap has handed it the floor, before the answer lands. */
async function staleScanView(pool: pg.Pool, chatId: string): Promise<SessionView> {
  await markAwaitingMachine(pool, chatId);
  const stale = await getSessionForChat(pool, chatId);
  assert.ok(stale.ok);
  assert.equal(stale.view.nextQuestion?.id, "trip_type", "the stale view still names the question being answered");
  assert.equal(stale.view.awaiting, "machine");
  return stale.view;
}

describe("a tap is never left without a next question", dbOptions, () => {
  test("control: the ordinary tap is answered with the next question, once", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await markAwaitingMachine(pool, chat.chatId);
      await scan(pool, telegram);
      assert.equal(asking(telegram, "trip_type").length, 1, JSON.stringify(telegram.sent));
      assert.equal(await floorOf(pool, chat.chatId), "person");

      await tapFamily(pool, chat, telegram);
      await scan(pool, telegram);
      assert.equal(telegram.sent.length, 2, JSON.stringify(telegram.sent.map((m) => m.text)));
      assert.equal(asking(telegram, "trip_type").length, 1, "the answered question is not asked again");
    });
  });

  test("a scan that read its view before the answer landed does not hand the floor back over it", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await markAwaitingMachine(pool, chat.chatId);
      await scan(pool, telegram);
      assert.equal(asking(telegram, "trip_type").length, 1);

      const stale = await staleScanView(pool, chat.chatId);
      // The overtaken scan finishes its pass while the tap is between recording the answer and replying to it.
      telegram.onEdit = async () => { await sendNextStep(stale, chat.chatId, depsFor(pool, telegram), DEFAULT_STRINGS); };
      await tapFamily(pool, chat, telegram);

      assert.equal(telegram.sent.length, 2, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.equal(asking(telegram, "trip_type").length, 1, "the answered question is not asked again");
    });
  });

  test("the same overtaking scan, landing after the tap has already replied: still exactly one next question", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await markAwaitingMachine(pool, chat.chatId);
      await scan(pool, telegram);

      const stale = await staleScanView(pool, chat.chatId);
      await tapFamily(pool, chat, telegram);
      await sendNextStep(stale, chat.chatId, depsFor(pool, telegram), DEFAULT_STRINGS);
      await scan(pool, telegram);

      assert.equal(telegram.sent.length, 2, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.equal(asking(telegram, "trip_type").length, 1);
    });
  });

  test("the nightly's order: the tap lands while the itinerary is still being read, the note arrives after - one next question, the note once, the days written", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await markAwaitingMachine(pool, chat.chatId);
      await scan(pool, telegram);
      assert.equal(asking(telegram, "trip_type").length, 1);

      let finishExtraction!: () => void;
      const extraction = new Promise<void>((resolve) => { finishExtraction = resolve; });
      const logs: string[] = [];
      const deps = {
        ...(depsFor(pool, telegram) as object),
        extractItinerary: async () => {
          await extraction;
          return {
            ok: true as const,
            phases: [{
              name: "Rome", phaseIndex: 0,
              days: [{ date: "2026-05-03", label: { en: "Arrival" }, items: [{ time: "10:00", text: { en: "Colosseum" } }] }],
              venues: [{ name: { en: "Colosseum" } }],
            }],
            warnings: [], venueLinksDeferred: [],
          };
        },
      } as never;
      const folding = foldItineraryFromDocument(
        deps, { chatId: chat.chatId, sessionId: chat.sessionId }, "Day 1 Rome", (line) => logs.push(line),
        async (text: string) => { await telegram.sendMessage({ text }); }, "en",
      );

      await tapFamily(pool, chat, telegram);
      await scan(pool, telegram);
      assert.equal(telegram.sent.length, 2, "the next question is out before the extraction finishes");
      finishExtraction();
      await folding;
      await scan(pool, telegram);

      assert.ok(logs.some((l) => l.includes("interview.itinerary_extracted") && l.includes('"written":true')), logs.join("\n"));
      assert.equal(telegram.sent.filter((m) => m.text.includes("day-by-day")).length, 1, "the note, once");
      assert.equal(telegram.sent.length, 3, `question, question, note: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      const held = (await answersForChat(pool, chat.chatId))!.answers.phases as { data?: { days?: unknown[] }[] };
      assert.equal(held.data?.[0]?.days?.length, 1, "the days were written");
    });
  });
});

/** The wedge itself, built in place: the floor is the organizer's, `q:trip_type` is the last word, and it is answered. */
async function wedge(pool: pg.Pool, chatId: string, secondsAgo = 3600): Promise<void> {
  await pool.query(
    `UPDATE control_plane.intake_sessions
        SET answers = answers || jsonb_build_object('trip_type', jsonb_build_object('kind','choice','option_id','family','schema_version',3,'other_text',NULL)),
            awaiting = 'person', awaiting_since = now() - make_interval(secs => $2), router_prompt_due_at = NULL,
            ui_state = jsonb_build_object('last_prompt', 'q:trip_type')
      WHERE telegram_chat_id = $1`,
    [chatId, secondsAgo],
  );
}

const rescue = (pool: pg.Pool, telegram: Recorder) =>
  rescueAnsweredButSilent(depsFor(pool, telegram), DEFAULT_STRINGS, () => {});

describe("the safety net: an answered question on screen with the floor on the organizer", dbOptions, () => {
  test("a session found that way is spoken to, once", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await wedge(pool, chat.chatId);
      await rescue(pool, telegram);
      await rescue(pool, telegram);
      await scan(pool, telegram);
      assert.equal(telegram.sent.length, 1, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.ok(telegram.sent[0]!.text.toLowerCase().includes("who"), "it is the next question (the travellers), not the answered one");
      assert.equal(asking(telegram, "trip_type").length, 0);
    });
  });

  test("a question that has NOT been answered is never nagged, however long it waits", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await markAwaitingMachine(pool, chat.chatId);
      await scan(pool, telegram);
      await pool.query("UPDATE control_plane.intake_sessions SET awaiting_since = now() - interval '1 hour' WHERE telegram_chat_id = $1", [chat.chatId]);
      await rescue(pool, telegram);
      await scan(pool, telegram);
      assert.equal(telegram.sent.length, 1, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
    });
  });

  test("an answer given moments ago is a pass in flight, not a stranded one", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await wedge(pool, chat.chatId, 2);
      await rescue(pool, telegram);
      assert.equal(telegram.sent.length, 0);
    });
  });

  // Each of these is a state in which an answered `q:<id>` is still the last word and the floor is rightly the
  // organizer's. Speaking in any of them would be the router talking over the person - the bug class the floor exists for.
  const legitimate: Array<[string, string]> = [
    ["the recap they have just read is what their next message is about", `ui_state = ui_state || jsonb_build_object('recap_marker', 'recap:doc:x')`],
    ["the interviewer owes them a message", `ui_state = ui_state || jsonb_build_object('pending_say', 'one moment')`],
    ["an Other button is waiting for their words", `ui_state = ui_state || jsonb_build_object('other_pending', 'trip_type')`],
    ["a document is still being read", `ui_state = ui_state || jsonb_build_object('reading_document_since', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`],
  ];
  for (const [name, set] of legitimate) {
    test(`left alone: ${name}`, async () => {
      await withInterview(async (pool, chat) => {
        const telegram = new Recorder();
        await wedge(pool, chat.chatId);
        await pool.query(`UPDATE control_plane.intake_sessions SET ${set} WHERE telegram_chat_id = $1`, [chat.chatId]);
        await rescue(pool, telegram);
        assert.equal(telegram.sent.length, 0, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
        assert.equal(await floorOf(pool, chat.chatId), "person", "the floor is still theirs");
      });
    });
  }

  test("left alone: a typed change is waiting for their yes", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await wedge(pool, chat.chatId);
      const tripId = (await pool.query("SELECT trip_id FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId])).rows[0].trip_id;
      await pool.query(
        "INSERT INTO control_plane.intake_pending_changes(id, session_id, trip_id, status) VALUES ($1, $2, $3, 'pending')",
        [`chg_${randomBytes(8).toString("hex")}`, chat.sessionId, tripId],
      );
      await rescue(pool, telegram);
      assert.equal(telegram.sent.length, 0);
      assert.equal(await floorOf(pool, chat.chatId), "person");
    });
  });

  test("left alone: a multi-select they are still ticking (its stored selection is not an answer yet)", async () => {
    await withInterview(async (pool, chat) => {
      const telegram = new Recorder();
      await wedge(pool, chat.chatId);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET answers = (answers - 'trip_type') || jsonb_build_object('trip_interests',
                  jsonb_build_object('kind','multi_choice','option_ids', jsonb_build_array('food'),'schema_version',3)),
                ui_state = jsonb_build_object('last_prompt', 'q:trip_interests', 'multi_pending', 'trip_interests')
          WHERE telegram_chat_id = $1`,
        [chat.chatId],
      );
      await rescue(pool, telegram);
      assert.equal(telegram.sent.length, 0, `sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.equal(await floorOf(pool, chat.chatId), "person");
    });
  });
});
