/**
 * #206 — a typed change to held answers: interpret, build a structured diff,
 * validate it against the whole trip, SHOW it, and apply exactly that diff only
 * after explicit confirmation.
 *
 * These drive the REAL typed path — `flushSettledInboundBursts` with a FAKE
 * model — and read `intake_sessions.answers` back, because the earlier tests of
 * this feature asserted on `accepted.answer` and passed while the stored answer
 * was wrong (#205). Every case asserts that NOTHING is stored before the
 * confirmation.
 *
 * THE FAKE MODEL'S OUTPUT is `{ proposals: [], unclear: [], malformed: 0,
 * ops: [...] }` — the interpreter's payload grows an optional `ops` list (the
 * operations in `typed-changes.ts`). That shape is pinned here and built in
 * slice 3; until then every case in this file FAILS, which is the point of
 * writing it first.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { confirmIntakeForChat, getSessionForChat, INTAKE_QUESTIONS, queueInboundMessage } from "../src/interview.js";
import { uiString } from "../src/intake-copy.js";
import { CONFIRM_CALLBACK_DATA } from "../src/chat-router.js";
import { applyDecision, flushSettledInboundBursts, forgetShownPreviewsForTests } from "../src/relay/poller.js";
import { burstKey, claimInterpretation, setInterpretPath } from "../src/interpret.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

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

async function withChats(fn: (pool: pg.Pool, a: Chat, b: Chat) => Promise<void>): Promise<void> {
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
    const a = await seedChat(pool, "850000001");
    const b = await seedChat(pool, "850000002");
    await fn(pool, a, b);
  } finally {
    await pool.end();
  }
}

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data });

async function hold(pool: pg.Pool, chat: Chat, questionId: string, data: unknown) {
  await pool.query(
    `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
      WHERE telegram_chat_id = $1`,
    [chat.chatId, questionId, JSON.stringify(structured(data))],
  );
}

async function stored(pool: pg.Pool, chat: Chat, questionId: string): Promise<any[]> {
  const r = await pool.query(
    "SELECT answers -> $2 AS a FROM control_plane.intake_sessions WHERE id = $1",
    [chat.sessionId, questionId],
  );
  return (r.rows[0]?.a?.data ?? []) as any[];
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
  get last() { return this.sent[this.sent.length - 1]; }
  /** A button on the most recent message whose callback data ends `:<suffix>`. */
  button(suffix: string): Button | undefined {
    return this.last?.buttons.find((b) => b.callback_data.startsWith("pc:") && b.callback_data.endsWith(`:${suffix}`));
  }
}

/** The fake model: returns `ops` for every reading, and counts how often it is asked. */
function fakeModel(ops: () => unknown[]) {
  const calls = { n: 0 };
  return {
    calls,
    runner: {
      async run() {
        calls.n += 1;
        return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0, ops: ops() }, attempts: 1, ms: 1 };
      },
    },
  };
}

let seq = 0;
async function say(pool: pg.Pool, chat: Chat, text: string, telegram: Telegram, model: { runner: unknown }) {
  seq += 1;
  await queueInboundMessage(pool, chat.chatId, { text, message_id: `m${seq}` } as never);
  await flushSettledInboundBursts(
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: model.runner, log: () => {} } as never,
    () => {},
    0,
  );
}

async function tap(pool: pg.Pool, chat: Chat, data: string, telegram: Telegram, model: { runner: unknown }) {
  seq += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cq${seq}`, data, sessionId: chat.sessionId } as never,
    { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: model.runner, log: () => {} } as never,
  );
}

const stop = (name: string, start?: string, end?: string) => ({ name, ...(start ? { start } : {}), ...(end ? { end } : {}) });
const names = (list: any[]) => list.map((e) => e.name);
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

describe("typed changes: propose, validate, confirm, apply (#206)", opts, () => {
  test("destination date correction: previewed, nothing stored, applied exactly on confirmation", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20", end: "2026-05-25" } }]);
      await say(pool, a, "actually Tokyo is May 20 to 25", tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")], "nothing stored before confirmation");
      const yes = tg.button("a");
      assert.ok(yes, `a preview with a confirm button — sent: ${JSON.stringify(tg.last)}`);
      assert.match(tg.last!.text, /Tokyo/);
      await tap(pool, a, yes!.callback_data, tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-20", "2026-05-25"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
    });
  });

  test("a typed message that changes nothing is not shown as a change, and the interview goes on (#647)", async () => {
    await withChats(async (pool, a) => {
      // PR #633 staging test: "GU-4471 is the hotel's confirmation" - the stay already says so.
      const held = [{ name: "Ljubljana", start: "2027-05-10", end: "2027-05-17", accommodation: { name: "Grand Hotel Union", confirmation: "GU-4471" } }];
      await hold(pool, a, "phases", held);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_stop", target: { name: "Ljubljana" }, fields: { accommodation: { confirmation: "GU-4471" } } }]);
      const logs: string[] = [];
      seq += 1;
      await queueInboundMessage(pool, a.chatId, { text: "GU-4471 is the hotel's confirmation, not a flight", message_id: `m${seq}` } as never);
      await flushSettledInboundBursts(
        { db: pool, telegram: tg, connector: { pushInbound: () => true }, modelRunner: model.runner, log: (l: string) => { logs.push(l); } } as never,
        (l: string) => { logs.push(l); },
        0,
      );
      assert.ok(logs.some((l) => l.includes("interview.change_noop")), `logged as a no-op: ${logs.filter((l) => l.includes("change_")).join(" | ")}`);
      assert.ok(!logs.some((l) => l.includes("interview.change_proposed") || l.includes("interview.change_shown")), "never proposed, never shown");
      assert.ok(tg.sent.length > 0, "the interview did not go quiet");
      for (const m of tg.sent) {
        assert.ok(!m.text.includes(uiString("change.header", "en")), `no change preview - sent: ${m.text}`);
        assert.ok(!m.buttons.some((b) => b.callback_data.startsWith("pc:")), "no confirm button");
      }
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_pending_changes")).rows[0].n, 0, "no draft is left waiting");
      assert.deepEqual(await stored(pool, a, "phases"), held, "nothing was written");
    });
  });

  test("a follow-up that undoes the waiting change cancels it like a No: the old buttons come off and the interview goes on (#647)", async () => {
    await withChats(async (pool, a) => {
      const held = [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")];
      await hold(pool, a, "phases", held);
      const edits: string[] = [];
      const tg = new Telegram();
      tg.editMessageText = async (p: { text?: string }) => { edits.push(p.text ?? ""); return { ok: true as const }; };
      let ops: unknown[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      assert.ok(tg.button("a"), "the preview is up");
      const before = tg.sent.length;

      ops = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-24" } }];
      const logs: string[] = [];
      seq += 1;
      await queueInboundMessage(pool, a.chatId, { text: "no wait, the 24th", message_id: `m${seq}` } as never);
      await flushSettledInboundBursts(
        { db: pool, telegram: tg, connector: { pushInbound: () => true }, modelRunner: model.runner, log: (l: string) => { logs.push(l); } } as never,
        (l: string) => { logs.push(l); },
        0,
      );
      assert.ok(logs.some((l) => l.includes("interview.change_noop") && l.includes('"merged":true')), `logged: ${logs.filter((l) => l.includes("change_")).join(" | ")}`);
      assert.equal(edits.length, 1, "the old preview lost its buttons");
      assert.ok(edits[0]!.includes(uiString("change.cancelled", "en")));
      assert.ok(tg.sent.slice(before).some((m) => m.text === uiString("change.cancelled", "en")), "they are told it was cancelled");
      assert.ok(tg.sent.length > before + 1, "and the interview went on after it");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_pending_changes WHERE status = 'pending'")).rows[0].n, 0);
      assert.deepEqual(await stored(pool, a, "phases"), held);
    });
  });

  test("traveller age correction: Ruth 70 -> 71, Avi kept, applied only on confirmation", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen" }]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } }]);
      await say(pool, a, "Ruth Cohen is 71", tg, model);
      assert.equal((await stored(pool, a, "travelers"))[0].age, 70);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      const people = await stored(pool, a, "travelers");
      assert.deepEqual(people.map((p) => [p.name, p.age]), [["Ruth Cohen", 71], ["Avi Cohen", undefined]]);
    });
  });

  test("a date change that OVERLAPS another stop is not offered for confirmation; the restated dates are", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20", end: "2026-05-25" } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo should be May 20 to 25", tg, model);
      assert.equal(tg.button("a"), undefined, "no Yes button on a conflicting change");
      assert.match(tg.last!.text, /Tokyo/);
      assert.match(tg.last!.text, /Kyoto/, "names every affected stop");
      assert.equal((await stored(pool, a, "phases"))[0].start, "2026-05-19");
      // A PARTIAL reply: Kyoto only. Tokyo's half is kept in the draft.
      ops = [{ op: "update_stop", target: { name: "Kyoto" }, fields: { start: "2026-05-25", end: "2026-05-28" } }];
      await say(pool, a, "Kyoto 25 to 28", tg, model);
      const yes = tg.button("a");
      assert.ok(yes, "now valid, so it is offered");
      await tap(pool, a, yes!.callback_data, tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-20", "2026-05-25"), stop("Kyoto", "2026-05-25", "2026-05-28")]);
    });
  });

  test("Ella beside a held Bella is a new traveller, never fused", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Bella Cohen", age: 12 }]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "add_traveller", fields: { name: "Ella Cohen", age: 9 } }]);
      await say(pool, a, "My daughter Ella Cohen, 9, is joining", tg, model);
      assert.deepEqual(names(await stored(pool, a, "travelers")), ["Bella Cohen"], "nothing stored yet");
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(names(await stored(pool, a, "travelers")).sort(), ["Bella Cohen", "Ella Cohen"]);
    });
  });

  test("typed removal: shows what remains, removes only after confirmation", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "remove_stop", target: { name: "Kyoto" } }]);
      await say(pool, a, "We're not going to Kyoto anymore", tg, model);
      assert.equal((await stored(pool, a, "phases")).length, 2);
      assert.match(tg.last!.text, /Tokyo/, "says what stays");
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo"]);
    });
  });

  test("typed removal of every stop: the preview says it would remove the whole itinerary", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo"), stop("Kyoto"), stop("Osaka")]);
      const tg = new Telegram();
      const model = fakeModel(() => ["Tokyo", "Kyoto", "Osaka"].map((name) => ({ op: "remove_stop", target: { name } })));
      await say(pool, a, "remove Tokyo, Kyoto and Osaka", tg, model);
      assert.equal((await stored(pool, a, "phases")).length, 3, "nothing stored before confirmation");
      assert.match(tg.last!.text, /This would remove every stop — your whole itinerary\./);
    });
  });

  test("typed reorder and replacement", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo"), stop("Kyoto"), stop("Osaka")]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "move_stop", target: { name: "Kyoto" }, after: { name: "Osaka" } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Move Kyoto after Osaka", tg, model);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Osaka", "Kyoto"]);
      ops = [{ op: "replace_stop", target: { name: "Osaka" }, fields: { name: "Nagoya" } }];
      await say(pool, a, "Change Osaka to Nagoya", tg, model);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Nagoya", "Kyoto"]);
    });
  });

  test("confirmation applies EXACTLY the shown diff — the model is never asked again", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const asked = model.calls.n;
      ops = [{ op: "remove_stop", target: { name: "Kyoto" } }]; // a different reading, if anyone asked
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.equal(model.calls.n, asked, "no second interpretation after confirmation");
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-19", "2026-05-25"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
    });
  });

  test("a stale confirmation (the held answer changed meanwhile) applies nothing and says so", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const yes = tg.button("a")!;
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-06-02")]);
      const before = tg.sent.length;
      await tap(pool, a, yes.callback_data, tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24", "nothing applied on the stale tap");
      assert.ok(tg.sent.length > before, "and it says so");
      assert.ok(tg.last!.text.includes(uiString("change.stale", "en")), "in words");
      // The change is shown AGAIN against what is held now, and applying THAT lands on the new state.
      const again = tg.button("a");
      assert.ok(again, "with a fresh Yes");
      await tap(pool, a, again!.callback_data, tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-19", "2026-05-25"), stop("Kyoto", "2026-05-27", "2026-06-02")]);
    });
  });

  test("cancel by button and by words leave everything as it was", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      await tap(pool, a, tg.button("c")!.callback_data, tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      await say(pool, a, "no", tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
      await say(pool, a, "לא", tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
    });
  });

  test("ignoring the preview and saying something else leaves the change waiting, not applied and not dropped", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const draftButton = tg.button("a")!.callback_data;
      ops = [];
      await say(pool, a, "we like sushi", tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
      await tap(pool, a, draftButton, tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-25", "the waiting change is still there to confirm");
    });
  });

  test("a second correction is MERGED into the waiting draft, never silently replacing it", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen", age: 41 }]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Ruth Cohen is 71", tg, model);
      ops = [{ op: "update_traveller", target: { name: "Avi Cohen" }, fields: { age: 40 } }];
      await say(pool, a, "Avi is 40", tg, model);
      assert.match(tg.last!.text, /Ruth/, "the first change is still in the preview");
      assert.match(tg.last!.text, /Avi/);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual((await stored(pool, a, "travelers")).map((p) => p.age), [71, 40]);
    });
  });

  test("an ambiguous reference asks which — and never picks", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Ruth Levi", age: 60 }]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]);
      await say(pool, a, "Ruth is 71", tg, model);
      assert.equal(tg.button("a"), undefined, "cannot be confirmed while a reference is open");
      assert.deepEqual((await stored(pool, a, "travelers")).map((p) => p.age), [70, 60]);
      const which = tg.last!.buttons.find((b) => b.callback_data.startsWith("pc:") && b.text.includes("Levi"));
      assert.ok(which, `one button per candidate — got ${JSON.stringify(tg.last)}`);
      await tap(pool, a, which!.callback_data, tg, model);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual((await stored(pool, a, "travelers")).map((p) => p.age), [70, 71]);
    });
  });

  test("a 'yes' to some OTHER question does not confirm a waiting change", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      // Something else is now the prompt on screen, and "yes" answers THAT.
      await pool.query(
        "UPDATE control_plane.intake_sessions SET ui_state = ui_state || jsonb_build_object('last_prompt', 'q:trip_type') WHERE id = $1",
        [a.sessionId],
      );
      ops = [];
      await say(pool, a, "yes", tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
    });
  });

  test("the end-of-interview Confirm is blocked while a change is waiting", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const result = await confirmIntakeForChat(pool, a.chatId);
      assert.equal(result.ok, false);
      assert.equal((result as { reason?: string }).reason, "PENDING_CHANGE");
    });
  });

  test("another session's chat cannot confirm this session's draft", async () => {
    await withChats(async (pool, a, b) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tgA = new Telegram();
      const model = fakeModel(() => [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }]);
      await say(pool, a, "Tokyo ends on the 25th", tgA, model);
      const tgB = new Telegram();
      await tap(pool, b, tgA.button("a")!.callback_data, tgB, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
      assert.ok(tgB.sent.length > 0, "the tap is answered, not ignored");
    });
  });
});

async function draftStatuses(pool: pg.Pool, chat: Chat): Promise<string[]> {
  const r = await pool.query("SELECT status FROM control_plane.intake_pending_changes WHERE session_id = $1 ORDER BY created_at", [chat.sessionId]);
  return r.rows.map((x) => x.status);
}
async function lastPrompt(pool: pg.Pool, chat: Chat): Promise<string | null> {
  const r = await pool.query("SELECT ui_state->>'last_prompt' AS p FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId]);
  return r.rows[0]?.p ?? null;
}
const update = (name: string, fields: Record<string, unknown>) => ({ op: "update_stop", target: { name }, fields });

describe("typed changes: saying it in words, and everything the router must not do silently (#206)", opts, () => {
  test("a typed 'yes' applies the change on screen — and so does Hebrew כן", async () => {
    await withChats(async (pool, a, b) => {
      for (const [chat, word, text] of [[a, "yes", "Tokyo ends on the 25th"], [b, "כן", "טוקיו מסתיימת ב-25"]] as const) {
        await hold(pool, chat, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
        const tg = new Telegram();
        const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
        await say(pool, chat, text, tg, model);
        assert.equal((await stored(pool, chat, "phases"))[0].end, "2026-05-24", "still nothing stored");
        const asked = model.calls.n;
        await say(pool, chat, word, tg, model);
        assert.equal((await stored(pool, chat, "phases"))[0].end, "2026-05-25", `"${word}" applied it`);
        assert.equal(model.calls.n, asked, "a bare yes is not interpreted");
        assert.deepEqual(await draftStatuses(pool, chat), ["applied"]);
      }
    });
  });

  test("'no' in words cancels the draft itself, not just the reading of it", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      await say(pool, a, "No.", tg, model);
      assert.deepEqual(await draftStatuses(pool, a), ["cancelled"]);
      assert.notEqual((await confirmIntakeForChat(pool, a.chatId) as { reason?: string }).reason, "PENDING_CHANGE");
    });
  });

  test("'yes, and add Nara' is MERGED into the waiting change: nothing applied, Nara shown, then one yes applies both", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      ops = [{ op: "add_stop", fields: { name: "Nara" } }];
      await say(pool, a, "yes, and add Nara", tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24", "not applied and dropped");
      assert.match(tg.last!.text, /Nara/);
      assert.match(tg.last!.text, /Tokyo/, "the first change is still in it");
      await say(pool, a, "yes", tg, model);
      assert.deepEqual((await stored(pool, a, "phases")).map((s) => [s.name, s.end]), [["Tokyo", "2026-05-25"], ["Nara", undefined]]);
      assert.deepEqual(await draftStatuses(pool, a), ["applied"]);
    });
  });

  test("the preview is written in the interview's language, English and Hebrew, and shows what stays", async () => {
    await withChats(async (pool, a, b) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const en = new Telegram();
      await say(pool, a, "Tokyo ends on the 25th", en, fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]));
      assert.ok(en.last!.text.includes(uiString("change.header", "en")));
      assert.match(en.last!.text, /24 May 2026|May 24, 2026/);
      assert.match(en.last!.text, /Kyoto/, "what stays is named");
      assert.deepEqual(en.last!.buttons.map((x) => x.text), [uiString("change.apply", "en"), uiString("change.cancel", "en")]);

      await hold(pool, b, "phases", [stop("טוקיו", "2026-05-19", "2026-05-24"), stop("קיוטו", "2026-05-27", "2026-05-30")]);
      const he = new Telegram();
      await say(pool, b, "טוקיו מסתיימת ב-25 במאי", he, fakeModel(() => [update("טוקיו", { end: "2026-05-25" })]));
      assert.ok(he.last!.text.includes(uiString("change.header", "he")), he.last!.text);
      assert.match(he.last!.text, /קיוטו/);
      assert.deepEqual(he.last!.buttons.map((x) => x.text), [uiString("change.apply", "he"), uiString("change.cancel", "he")]);
    });
  });

  test("an ambiguous WORDING (rename, replace or add?) asks, with one button per reading, and applies only the one chosen", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Hakone", "2026-05-24", "2026-05-27")]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "choose", options: [
        { op: "rename_stop", target: { name: "Hakone" }, name: "Nagoya" },
        { op: "replace_stop", target: { name: "Hakone" }, fields: { name: "Nagoya" } },
        { op: "add_stop", fields: { name: "Nagoya" } },
      ] }]);
      await say(pool, a, "change Hakone to Nagoya", tg, model);
      assert.equal(tg.button("a"), undefined, "nothing to confirm yet");
      const buttons = tg.last!.buttons.filter((b) => b.callback_data.startsWith("pc:") && b.callback_data.includes(":r:"));
      assert.equal(buttons.length, 3, JSON.stringify(tg.last));
      assert.deepEqual((await stored(pool, a, "phases")).map((s) => s.name), ["Tokyo", "Hakone"]);
      await tap(pool, a, buttons[0]!.callback_data, tg, model); // the rename
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Nagoya", "2026-05-24", "2026-05-27")], "renamed, dates kept");
    });
  });

  test("two stops with the same name: the person picks, and the pick is the one that changes", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27"), stop("Tokyo", "2026-05-30", "2026-06-02")]);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-06-03" })]);
      await say(pool, a, "Tokyo ends on the 3rd", tg, model);
      assert.equal(tg.button("a"), undefined);
      const picks = tg.last!.buttons.filter((b) => b.callback_data.includes(":r:"));
      assert.equal(picks.length, 2);
      await tap(pool, a, picks[1]!.callback_data, tg, model);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual((await stored(pool, a, "phases")).map((s) => s.end), ["2026-05-24", "2026-05-27", "2026-06-03"]);
    });
  });

  test("removing a stop with a confirmed booking says so in the preview — and does not claim refund terms it does not have", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
      await hold(pool, a, "travel_anchors", [{ type: "hotel", name: "Gion Inn", date: "2026-05-25", confirmation: "GI-77" }]);
      const tg = new Telegram();
      await say(pool, a, "no Kyoto", tg, fakeModel(() => [{ op: "remove_stop", target: { name: "Kyoto" } }]));
      assert.match(tg.last!.text, /GI-77/);
      assert.match(tg.last!.text, /don't know its cancellation terms/);
      assert.doesNotMatch(tg.last!.text, /non-refundable/);
    });
  });

  test("Confirm while a change waits says why — in the interview's language — and shows the change again", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const before = tg.sent.length;
      await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, model);
      const after = tg.sent.slice(before).map((m) => m.text);
      assert.ok(after.includes(uiString("changePendingBlocksConfirm", "en")), JSON.stringify(after));
      assert.ok(tg.button("a"), "the change is back on screen with its buttons");
    });
  });

  test("what the change displaced comes back: the optional offer is re-sent, a question is re-asked", async () => {
    await withChats(async (pool, a, b) => {
      // The offer was on screen when the change arrived.
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      await pool.query("UPDATE control_plane.intake_sessions SET ui_state = ui_state || jsonb_build_object('last_prompt', 'optional_offer', 'offered_more', true) WHERE id = $1", [a.sessionId]);
      const tgA = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends on the 25th", tgA, model);
      await tap(pool, a, tgA.button("c")!.callback_data, tgA, model);
      assert.ok(tgA.sent.some((m) => m.text === uiString("essentialsDone", "en")), "the offer is put back, once more");
      assert.equal(await lastPrompt(pool, a), "optional_offer");

      // A question was on screen.
      await hold(pool, b, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      await pool.query("UPDATE control_plane.intake_sessions SET ui_state = ui_state || jsonb_build_object('last_prompt', 'q:trip_type') WHERE id = $1", [b.sessionId]);
      const tgB = new Telegram();
      await say(pool, b, "Tokyo ends on the 25th", tgB, model);
      const before = tgB.sent.length;
      await tap(pool, b, tgB.button("a")!.callback_data, tgB, model);
      assert.ok(tgB.sent.length > before + 1, "applied, and then the interview goes on");
      assert.match((await lastPrompt(pool, b)) ?? "", /^q:/, "a question is on screen again");
    });
  });

  test("a PROPOSAL to replace the held stops is never written, and never silent: the person is asked", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
      const runner = { async run() {
        return { ok: true as const, attempts: 1, ms: 1, value: { unclear: [], malformed: 0, proposals: [{
          questionId: "phases", confidence: 0.95, evidence: "Tokyo is 20 to 25", sourceMessageId: "1",
          value: { kind: "structured", data: [stop("Tokyo", "2026-05-20", "2026-05-25")] },
        }] } };
      } };
      const tg = new Telegram();
      await say(pool, a, "Tokyo is 20 to 25", tg, { runner });
      assert.equal((await stored(pool, a, "phases")).length, 2, "nothing was replaced");
      assert.equal((await stored(pool, a, "phases"))[0].start, "2026-05-19");
      assert.ok(tg.sent.length > 0 && tg.last!.text.includes(uiString("change.notUnderstoodAbout", "en").split("{what}")[0]!), JSON.stringify(tg.sent));
    });
  });

  test("an unsure correction to an answered question is asked about, not dropped; operations that do not parse likewise", async () => {
    await withChats(async (pool, a, b) => {
      await pool.query(
        "UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object('trip_type', $2::jsonb) WHERE id = $1",
        [a.sessionId, JSON.stringify({ kind: "choice", schema_version: 3, option_id: "family", other_text: null })],
      );
      const unsure = { async run() {
        return { ok: true as const, attempts: 1, ms: 1, value: { unclear: [], malformed: 0, proposals: [{
          questionId: "trip_type", confidence: 0.5, evidence: "maybe friends", sourceMessageId: "1", value: { kind: "choice", optionId: "friends" },
        }] } };
      } };
      const tgA = new Telegram();
      await say(pool, a, "maybe friends actually", tgA, { runner: unsure });
      assert.ok(tgA.sent.length > 0, "the organizer is told");
      const answer = (await pool.query("SELECT answers->'trip_type'->>'option_id' AS o FROM control_plane.intake_sessions WHERE id = $1", [a.sessionId])).rows[0].o;
      assert.equal(answer, "family", "and nothing changed");

      await hold(pool, b, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tgB = new Telegram();
      await say(pool, b, "delete everything", tgB, fakeModel(() => [{ op: "delete_everything" }]));
      assert.ok(tgB.sent.length > 0, "operations the parser refuses are asked about");
      assert.equal((await stored(pool, b, "phases")).length, 1);
      assert.deepEqual(await draftStatuses(pool, b), [], "no draft was made from them");
    });
  });

  test("the poller ANSWERS a tap on a change whose session is over (dispatch.ts still drops such a tap before it gets here)", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const yes = tg.button("a")!.callback_data;
      await pool.query("UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE id = $1", [a.sessionId]);
      const before = tg.sent.length;
      await tap(pool, a, yes, tg, model);
      assert.ok(tg.sent.length > before, "answered, not ignored");
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
    });
  });

  test("a crash between the model answering and the draft landing is resumed by asking again — the operations were never stored", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const text = "Tokyo ends on the 25th";
      // The burst was claimed by an earlier attempt that died after the model answered.
      const claimed = await claimInterpretation(pool, { sessionId: a.sessionId, chatId: a.chatId, burstKey: burstKey(["mresume1"], text), sourceText: text });
      assert.equal(claimed.fresh, true);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await queueInboundMessage(pool, a.chatId, { text, message_id: "mresume1" } as never);
      await flushSettledInboundBursts({ db: pool, telegram: tg, connector: { pushInbound: () => true }, modelRunner: model.runner, log: () => {} } as never, () => {}, 0);
      assert.equal(model.calls.n, 1, "asked again, not resumed as 'the model said nothing'");
      assert.ok(tg.button("a"), "and the change is shown");
      assert.deepEqual(await draftStatuses(pool, a), ["pending"]);
    });
  });

  // #205's own scenario, end to end through the real typed path: held phases =
  // Tokyo, Hakone, Kyoto, Osaka; the organizer types a reading that names only
  // Tokyo. Before PR #199/#206, the relay wrote `accepted.proposal.value` —
  // whatever the model re-emitted, which by the interpreter prompt's own rule
  // is only what changed — and the shared writer replaced the stored answer
  // wholesale, so Hakone, Kyoto and Osaka were silently dropped. This drives
  // `flushSettledInboundBursts` and `applyDecision` for real and reads
  // `intake_sessions.answers` back, the same way `interpret-typed-merge-db.test.ts`
  // does for the other structured lists.
  test("#205: 'another three days at the end for Tokyo' keeps Hakone, Kyoto and Osaka", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo"), stop("Hakone"), stop("Kyoto"), stop("Osaka")]);
      const tg = new Telegram();
      const model = fakeModel(() => [
        { op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-09-30", end: "2026-10-03" } },
      ]);
      await say(pool, a, "another three days at the end for Tokyo, 30 September to 3 October", tg, model);
      assert.deepEqual(
        names(await stored(pool, a, "phases")),
        ["Tokyo", "Hakone", "Kyoto", "Osaka"],
        "nothing stored before confirmation",
      );
      const yes = tg.button("a");
      assert.ok(yes, `a preview with a confirm button — sent: ${JSON.stringify(tg.last)}`);
      await tap(pool, a, yes!.callback_data, tg, model);
      const after = await stored(pool, a, "phases");
      assert.deepEqual(names(after), ["Tokyo", "Hakone", "Kyoto", "Osaka"], "#205: Hakone, Kyoto and Osaka survive");
      assert.deepEqual([after[0].start, after[0].end], ["2026-09-30", "2026-10-03"]);
    });
  });

  test("#205: 'my mother is joining too' adds a traveller without dropping the rest of the roster", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Dror Cohen" }, { name: "Ruth Cohen" }, { name: "Avi Cohen" }]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "add_traveller", fields: { name: "Mom Cohen" } }]);
      await say(pool, a, "my mother is joining too", tg, model);
      assert.deepEqual(
        names(await stored(pool, a, "travelers")),
        ["Dror Cohen", "Ruth Cohen", "Avi Cohen"],
        "nothing stored before confirmation",
      );
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(
        names(await stored(pool, a, "travelers")).sort(),
        ["Avi Cohen", "Dror Cohen", "Mom Cohen", "Ruth Cohen"],
        "#205: the rest of the roster survives",
      );
    });
  });
});

// ── #666: "no, keep it" typed while a change waits ───────────────────────────
//
// Real-model run, 2026-11-25: a box was waiting (stay end 17 May -> 16 May); the organizer typed "לא, רגע — עד 17 במאי".
// The held end already IS 17 May, the reader emitted no operation, and the draft stayed pending with the recap re-sent
// beneath the live box.
describe("a typed refusal that restates what is held cancels the waiting change (#666)", opts, () => {
  const LJUBLJANA = [{ name: "לובליאנה", start: "2027-05-10", end: "2027-05-17" }];
  const toTheSixteenth = () => [update("לובליאנה", { end: "2027-05-16" })];

  async function waitingBox(pool: pg.Pool, a: Chat, tg: Telegram, ops: { current: unknown[] }) {
    await hold(pool, a, "phases", LJUBLJANA);
    await pool.query("UPDATE control_plane.intake_sessions SET language = 'he' WHERE id = $1", [a.sessionId]);
    const model = fakeModel(() => ops.current);
    await say(pool, a, "הלינה בלובליאנה עד 16 במאי", tg, model);
    assert.ok(tg.button("a"), "the box is up");
    assert.deepEqual(await draftStatuses(pool, a), ["pending"]);
    return model;
  }

  async function sayLogged(pool: pg.Pool, a: Chat, text: string, tg: Telegram, model: { runner: unknown }): Promise<string[]> {
    const logs: string[] = [];
    seq += 1;
    await queueInboundMessage(pool, a.chatId, { text, message_id: `m${seq}` } as never);
    await flushSettledInboundBursts(
      { db: pool, telegram: tg, connector: { pushInbound: () => true }, modelRunner: model.runner, log: (l: string) => { logs.push(l); } } as never,
      (l: string) => { logs.push(l); },
      0,
    );
    return logs;
  }

  test("the reader returns nothing: 'לא, רגע — עד 17 במאי' is the organizer's No - box collapsed, told once, interview resumed once", async () => {
    await withChats(async (pool, a) => {
      const edits: string[] = [];
      const tg = new Telegram();
      tg.editMessageText = async (p: { text?: string }) => { edits.push(p.text ?? ""); return { ok: true as const }; };
      const ops = { current: toTheSixteenth() as unknown[] };
      const model = await waitingBox(pool, a, tg, ops);
      const before = tg.sent.length;

      ops.current = [];
      const logs = await sayLogged(pool, a, "לא, רגע — עד 17 במאי", tg, model);

      assert.deepEqual(await draftStatuses(pool, a), ["cancelled"], `logged: ${logs.filter((l) => l.includes("change_")).join(" | ")}`);
      assert.ok(logs.some((l) => l.includes("interview.change_no_restated")), "and it says why");
      assert.equal(edits.length, 1, "the box lost its buttons");
      assert.ok(edits[0]!.includes(`✖ ${uiString("change.cancelled", "he")}`), edits[0]);
      const after = tg.sent.slice(before);
      assert.equal(after.filter((m) => m.text === uiString("change.cancelled", "he")).length, 1, "told once");
      assert.ok(after.length >= 2, "and the interview went on after it");
      assert.ok(after.every((m) => !m.buttons.some((b) => b.callback_data.startsWith("pc:"))), "no second box, nothing to confirm");
      assert.equal((await stored(pool, a, "phases"))[0].end, "2027-05-17");
      assert.notEqual((await confirmIntakeForChat(pool, a.chatId) as { reason?: string }).reason, "PENDING_CHANGE");
    });
  });

  test("the second wording of the run, and English, cancel the same way", async () => {
    for (const text of ["לא, הלינה בלובליאנה נשארת עד 17 במאי", "no, keep it until 17 May"]) {
      await withChats(async (pool, a) => {
        const tg = new Telegram();
        const ops = { current: toTheSixteenth() as unknown[] };
        const model = await waitingBox(pool, a, tg, ops);
        ops.current = [];
        await sayLogged(pool, a, text, tg, model);
        assert.deepEqual(await draftStatuses(pool, a), ["cancelled"], text);
      });
    }
  });

  test("the reader does emit the restating operation: #647's merged no-op cancels it and the backstop does not run twice", async () => {
    await withChats(async (pool, a) => {
      const edits: string[] = [];
      const tg = new Telegram();
      tg.editMessageText = async (p: { text?: string }) => { edits.push(p.text ?? ""); return { ok: true as const }; };
      const ops = { current: toTheSixteenth() as unknown[] };
      const model = await waitingBox(pool, a, tg, ops);
      const before = tg.sent.length;
      ops.current = [update("לובליאנה", { end: "2027-05-17" })];
      const logs = await sayLogged(pool, a, "תחזירו את סוף הלינה בלובליאנה ל-17 במאי", tg, model);
      assert.deepEqual(await draftStatuses(pool, a), ["cancelled"]);
      assert.ok(logs.some((l) => l.includes("interview.change_noop") && l.includes('"merged":true')));
      assert.ok(!logs.some((l) => l.includes("interview.change_no_restated")));
      assert.equal(edits.length, 1);
      assert.equal(tg.sent.slice(before).filter((m) => m.text === uiString("change.cancelled", "he")).length, 1);
    });
  });

  test("the reader is told a change waits, and what it would do - only while one does", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", LJUBLJANA);
      const prompts: string[] = [];
      const runner = {
        async run(args: { prompt: string }) {
          prompts.push(args.prompt);
          return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0, ops: prompts.length === 1 ? toTheSixteenth() : [] }, attempts: 1, ms: 1 };
        },
      };
      const tg = new Telegram();
      await say(pool, a, "הלינה בלובליאנה עד 16 במאי", tg, { runner });
      await say(pool, a, "לא, רגע — עד 17 במאי", tg, { runner });
      assert.equal(prompts.length, 2);
      assert.doesNotMatch(prompts[0]!, /A CHANGE IS WAITING/, "nothing waits at the first message");
      assert.match(prompts[1]!, /A CHANGE IS WAITING/);
      assert.ok(prompts[1]!.includes("2027-05-16"), "with what it would do");
    });
  });

  test("a different new value is a correction, never a cancel: it merges and the new box shows it", async () => {
    await withChats(async (pool, a) => {
      const tg = new Telegram();
      const ops = { current: toTheSixteenth() as unknown[] };
      const model = await waitingBox(pool, a, tg, ops);
      ops.current = [update("לובליאנה", { end: "2027-05-21" })];
      await sayLogged(pool, a, "לא, עד 21 במאי", tg, model);
      assert.deepEqual(await draftStatuses(pool, a), ["pending"]);
      assert.match(tg.last!.text, /21/);
      assert.ok(tg.button("a"), "a new box to confirm");
    });
  });

  test("a refusal with a different value the reader missed is not cancelled either: the value is the organizer's, not ours to drop", async () => {
    await withChats(async (pool, a) => {
      const tg = new Telegram();
      const ops = { current: toTheSixteenth() as unknown[] };
      const model = await waitingBox(pool, a, tg, ops);
      ops.current = [];
      const logs = await sayLogged(pool, a, "לא, עד 21 במאי", tg, model);
      assert.deepEqual(await draftStatuses(pool, a), ["pending"]);
      assert.ok(!logs.some((l) => l.includes("interview.change_no_restated")));
    });
  });

  test("no refusal, no cancel: a message about something else, or a 'no' that negates the next word, leaves the change waiting", async () => {
    for (const text of ["we like sushi", "לא יודע אם עד 17", "I know it's 17 May"]) {
      await withChats(async (pool, a) => {
        const tg = new Telegram();
        const ops = { current: toTheSixteenth() as unknown[] };
        const model = await waitingBox(pool, a, tg, ops);
        ops.current = [];
        await sayLogged(pool, a, text, tg, model);
        assert.deepEqual(await draftStatuses(pool, a), ["pending"], text);
      });
    }
  });

  test("a refusal that also answers a question is recorded as the answer, and does not cancel the change", async () => {
    await withChats(async (pool, a) => {
      const tg = new Telegram();
      const ops = { current: toTheSixteenth() as unknown[] };
      await waitingBox(pool, a, tg, ops);
      const withAnswer = {
        runner: {
          async run() {
            return {
              ok: true as const, attempts: 1, ms: 1,
              value: {
                proposals: [{ questionId: "bot_name", value: { kind: "text", text: "Tripper" }, confidence: 0.95, evidence: "Tripper", sourceMessageId: "m" }],
                unclear: [], malformed: 0, ops: [],
              },
            };
          },
        },
      };
      await sayLogged(pool, a, "לא, קראו לו Tripper", tg, withAnswer);
      assert.deepEqual(await draftStatuses(pool, a), ["pending"]);
    });
  });

  test("the run's own state: the summary re-sent beneath the live box - the refusal still cancels it", async () => {
    await withChats(async (pool, a) => {
      const tg = new Telegram();
      const ops = { current: toTheSixteenth() as unknown[] };
      const model = await waitingBox(pool, a, tg, ops);
      // What the failed first attempt left behind: the recap on screen, the box still live above it.
      for (const q of INTAKE_QUESTIONS.filter((x) => x.required && x.id !== "phases")) {
        const answer = q.id === "travelers" ? structured([{ name: "Dana" }])
          : q.id === "organizer_identity" ? { kind: "text", schema_version: 3, text: "Dana" }
          : q.type === "choice" ? { kind: "choice", option_id: q.options![0]!.id, schema_version: 3, other_text: null }
          : { kind: "text", schema_version: 3, text: "x" };
        await pool.query(
          "UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1",
          [a.sessionId, q.id, JSON.stringify(answer)],
        );
      }
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET phase = 'recap', ui_state = ui_state || jsonb_build_object('last_prompt', 'recap')
          WHERE id = $1`,
        [a.sessionId],
      );
      const recapView = await getSessionForChat(pool, a.chatId);
      assert.ok(recapView.ok && recapView.view.state === "awaiting_confirmation", "premise: the summary is what the interview is at");
      ops.current = [];
      const logs = await sayLogged(pool, a, "לא, הלינה בלובליאנה נשארת עד 17 במאי", tg, model);
      assert.deepEqual(await draftStatuses(pool, a), ["cancelled"], logs.filter((l) => l.includes("change_")).join(" | "));
      assert.ok(logs.some((l) => l.includes("interview.change_no_restated")));
    });
  });

  test("another question or the boundary offer is on screen: 'no, that's all' answers THAT, and the change keeps waiting", async () => {
    for (const [prompt, text] of [["q:trip_type", "לא, עוד לא"], ["optional_offer", "no, that's all"]] as const) {
      await withChats(async (pool, a) => {
        const tg = new Telegram();
        const ops = { current: toTheSixteenth() as unknown[] };
        const model = await waitingBox(pool, a, tg, ops);
        await pool.query("UPDATE control_plane.intake_sessions SET ui_state = ui_state || jsonb_build_object('last_prompt', $2::text) WHERE id = $1", [a.sessionId, prompt]);
        ops.current = [];
        const logs = await sayLogged(pool, a, text, tg, model);
        assert.deepEqual(await draftStatuses(pool, a), ["pending"], `${prompt}: ${text}`);
        assert.ok(!logs.some((l) => l.includes("interview.change_no_restated")));
      });
    }
  });

  test("a date that merely collides with another held number is not a restatement: 'לא, עד 5 במאי' is left to the reader", async () => {
    for (const text of ["לא, עד 5 במאי", "לא, עד 10 במאי"]) {
      await withChats(async (pool, a) => {
        const tg = new Telegram();
        const ops = { current: toTheSixteenth() as unknown[] };
        const model = await waitingBox(pool, a, tg, ops);
        ops.current = [];
        await sayLogged(pool, a, text, tg, model);
        assert.deepEqual(await draftStatuses(pool, a), ["pending"], text);
      });
    }
  });

  test("a change the organizer has not seen is not cancelled by words they typed about something else", async () => {
    await withChats(async (pool, a) => {
      const tg = new Telegram();
      const ops = { current: toTheSixteenth() as unknown[] };
      const model = await waitingBox(pool, a, tg, ops);
      // A relay restart forgets which messages carry the box, and the screen has moved on.
      forgetShownPreviewsForTests();
      await pool.query("UPDATE control_plane.intake_sessions SET ui_state = ui_state || jsonb_build_object('last_prompt', 'q:trip_type') WHERE id = $1", [a.sessionId]);
      ops.current = [];
      await sayLogged(pool, a, "לא, רגע — עד 17 במאי", tg, model);
      assert.deepEqual(await draftStatuses(pool, a), ["pending"]);
    });
  });
});
