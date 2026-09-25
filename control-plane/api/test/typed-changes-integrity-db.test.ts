/**
 * #206 - the confirmed diff is the diff that is committed, and a change is never
 * silently lost. Boundary-audit findings A-I on PR #199, on the REAL typed path
 * (`flushSettledInboundBursts` and `applyDecision` with a fake model), reading
 * `intake_sessions.answers` back.
 *
 *  A  a Yes (button OR typed) applies only the version the person was looking at
 *  B  a preview whose send failed is not "shown"
 *  D  a draft has a size, and the preview provably fits one Telegram message
 *  E  a change proposed to a confirmed interview is refused, out loud
 *  G  no validator text reaches the organizer
 *  H  a held list that cannot be edited by typing says so and leaves no draft
 *  I  (dispatch level) lives in relay-dispatch.test.ts
 *  and: a crash between the draft and the commit loses nothing, duplicates nothing.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { applyPendingChangeForChat, queueInboundMessage } from "../src/interview.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision, flushSettledInboundBursts, forgetShownPreviewsForTests } from "../src/relay/poller.js";
import { setInterpretPath } from "../src/interpret.js";
import { draftDigest } from "../src/typed-changes.js";
import { getOpenDraft, proposeChange, PREVIEW_BUDGET_CHARS } from "../src/typed-changes-store.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

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

async function withChats(fn: (pool: pg.Pool, a: Chat, b: Chat) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
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
    const a = await seedChat(pool, "860000001");
    const b = await seedChat(pool, "860000002");
    await fn(pool, a, b);
  } finally {
    await pool.end();
  }
}

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data });

async function hold(pool: pg.Pool, chat: Chat, questionId: string, data: unknown) {
  await pool.query(
    `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
      WHERE id = $1`,
    [chat.sessionId, questionId, JSON.stringify(structured(data))],
  );
}
async function stored(pool: pg.Pool, chat: Chat, questionId: string): Promise<any[]> {
  const r = await pool.query("SELECT answers -> $2 AS a FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId, questionId]);
  return (r.rows[0]?.a?.data ?? []) as any[];
}
async function draftRows(pool: pg.Pool, chat: Chat) {
  return (await pool.query(
    "SELECT id, status, jsonb_array_length(ops) AS nops FROM control_plane.intake_pending_changes WHERE session_id = $1 ORDER BY created_at",
    [chat.sessionId],
  )).rows as { id: string; status: string; nops: number }[];
}
async function lastPrompt(pool: pg.Pool, chat: Chat): Promise<string | null> {
  return (await pool.query("SELECT ui_state->>'last_prompt' AS p FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId])).rows[0]?.p ?? null;
}

type Button = { text: string; callback_data: string };
interface Sent { text: string; buttons: Button[]; ok: boolean }

/** Mirrors the Bot API: a refused send returns ok:false, it does not throw. */
class Telegram {
  readonly sent: Sent[] = [];
  readonly acks: unknown[] = [];
  /** Refuse any message that carries buttons (a preview), the way a 429 or a network error would. */
  failPreviews = false;
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: Button[][] } }) {
    const buttons = (p.replyMarkup?.inline_keyboard ?? []).flat();
    const ok = !(this.failPreviews && buttons.length > 0) && p.text.length <= 4096;
    this.sent.push({ text: p.text, buttons, ok });
    return ok ? { ok: true as const, messageId: String(this.sent.length) } : { ok: false as const, error: "Bad Request" };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery(p: unknown) { this.acks.push(p); }
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
  get last() { return this.sent[this.sent.length - 1]; }
  /** Every message that carries change buttons and was really delivered. */
  get previews() { return this.sent.filter((s) => s.ok && s.buttons.some((b) => b.callback_data.startsWith("pc:"))); }
  /** A button on the most recent DELIVERED preview whose callback data ends `:<suffix>`. */
  button(suffix: string): Button | undefined {
    return this.previews.at(-1)?.buttons.find((b) => b.callback_data.endsWith(`:${suffix}`));
  }
}

function fakeModel(ops: () => unknown[], extra: () => Record<string, unknown> = () => ({}), before: () => Promise<void> = async () => {}) {
  const calls = { n: 0 };
  return {
    calls,
    runner: {
      async run() {
        calls.n += 1;
        await before();
        const list = ops();
        return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0, ...(list.length ? { ops: list } : {}), ...extra() }, attempts: 1, ms: 1 };
      },
    },
  };
}

let seq = 0;
const depsFor = (db: unknown, telegram: Telegram, model: { runner: unknown }) =>
  ({ db, telegram, connector: { pushInbound: () => true }, modelRunner: model.runner, log: () => {} }) as never;

async function say(db: any, chat: Chat, text: string, telegram: Telegram, model: { runner: unknown }, messageId?: string) {
  seq += 1;
  await queueInboundMessage(db, chat.chatId, { text, message_id: messageId ?? `m${seq}` } as never);
  await flushSettledInboundBursts(depsFor(db, telegram, model), () => {}, 0);
}
async function tap(db: any, chat: Chat, data: string, telegram: Telegram, model: { runner: unknown }) {
  seq += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: chat.chatId, callbackQueryId: `cq${seq}`, data, sessionId: chat.sessionId } as never,
    depsFor(db, telegram, model),
  );
}

/** A database handle that throws ONCE when a statement matches: the relay dying at that seam. */
function crashOnce(pool: pg.Pool, match: RegExp): pg.Pool {
  let armed = true;
  const guard = (query: (...a: any[]) => Promise<unknown>) => async (sql: unknown, params?: unknown) => {
    if (armed && typeof sql === "string" && match.test(sql)) {
      armed = false;
      throw new Error("the relay died at the seam");
    }
    return query(sql, params);
  };
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "query") return guard(target.query.bind(target) as never);
      if (prop === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, p) {
              if (p === "query") return guard(c.query.bind(c) as never);
              const v = (c as any)[p];
              return typeof v === "function" ? v.bind(c) : v;
            },
          });
        };
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const stop = (name: string, start?: string, end?: string) => ({ name, ...(start ? { start } : {}), ...(end ? { end } : {}) });
const update = (name: string, fields: Record<string, unknown>) => ({ op: "update_stop", target: { name }, fields });
const TWO = [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")];
const names = (list: any[]) => list.map((e) => e.name);
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };
const en = (key: string) => uiString(key, "en");

describe("A: a Yes confirms the version it was drawn for, and only that", opts, () => {
  test("a stale button after a merge, and after a relay restart: nothing applied, the current preview shown, then the new Yes applies exactly the merge", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const oldYes = tg.button("a")!;
      assert.ok(oldYes, "a preview with Yes");
      const oldDraft = (await draftRows(pool, a))[0]!.id;

      // A follow-up merges into the SAME draft (same id): a second change, Kyoto.
      ops = [update("Kyoto", { end: "2026-05-31" })];
      await say(pool, a, "and Kyoto until the 31st", tg, model);
      const rows = await draftRows(pool, a);
      assert.deepEqual(rows.map((r) => r.id), [oldDraft], "one draft, merged");
      const newYes = tg.button("a")!;
      assert.notEqual(newYes.callback_data, oldYes.callback_data, "the merged version has its own Yes");
      assert.ok(newYes.callback_data.startsWith(`pc:${oldDraft}:`), "same draft id, different digest");

      // The relay restarts: the in-memory record of which message to edit is gone.
      forgetShownPreviewsForTests();
      const before = tg.sent.length;
      await tap(pool, a, oldYes.callback_data, tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), TWO, "the OLD Yes applied nothing");
      const reshown = tg.sent.slice(before).find((s) => s.buttons.length > 0)!;
      assert.ok(reshown, "the current preview was shown again, with fresh buttons");
      assert.ok(reshown.text.startsWith(en("change.updated")));
      assert.equal(reshown.buttons.find((b) => b.callback_data.endsWith(":a"))!.callback_data, newYes.callback_data);
      assert.equal(tg.acks.length, 1, "the tap was answered");

      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-19", "2026-05-25"), stop("Kyoto", "2026-05-27", "2026-05-31")], "exactly the merged result");
    });
  });

  test("the guard is atomic: apply with an old digest is refused under the lock (the merge landed between the read and the apply)", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      await say(pool, a, "Tokyo ends 25", tg, fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]));
      const draft = (await getOpenDraft(pool, a.sessionId))!;
      const seen = draftDigest(draft);
      const merged = await proposeChange(pool, { sessionId: a.sessionId, tripId: a.tripId, interpretationId: id("interp"), ops: [{ op: "remove_stop", target: { name: "Kyoto" } }] as never });
      assert.equal(merged.kind, "merged");
      const refused = await applyPendingChangeForChat(pool, a.chatId, draft.id, seen);
      assert.deepEqual(refused, { ok: false, reason: "UPDATED" });
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
    });
  });

  test("a tap racing a typed follow-up, 20 rounds: Kyoto is never removed by a Yes that was drawn before it was proposed", async () => {
    await withChats(async (pool, a) => {
      const outcomes: Record<string, number> = {};
      for (let round = 0; round < 20; round += 1) {
        await hold(pool, a, "phases", TWO);
        await pool.query("UPDATE control_plane.intake_pending_changes SET status = 'cancelled', resolved_at = now() WHERE status = 'pending'");
        const tg = new Telegram();
        let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
        const model = fakeModel(() => ops);
        await say(pool, a, `Tokyo ends 25, round ${round}`, tg, model);
        const yes = tg.button("a")!.callback_data;
        ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
        await Promise.allSettled([tap(pool, a, yes, tg, model), say(pool, a, `and drop Kyoto, round ${round}`, tg, model)]);
        const now = names(await stored(pool, a, "phases"));
        assert.deepEqual(now, ["Tokyo", "Kyoto"], `round ${round}: Kyoto must still be there`);
        const key = String((await stored(pool, a, "phases"))[0].end);
        outcomes[key] = (outcomes[key] ?? 0) + 1;
      }
      assert.ok(Object.keys(outcomes).length >= 1, JSON.stringify(outcomes));
    });
  });

  test("a TYPED yes confirms only the version whose preview was delivered: v2's send failed, so 'yes' applies nothing and shows v2", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      const v1Prompt = await lastPrompt(pool, a);
      assert.match(v1Prompt ?? "", /^pc:pchg_[0-9a-f]{32}:[0-9a-f]{8}$/);

      ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
      const failing = new Telegram();
      failing.failPreviews = true;
      await say(pool, a, "and drop Kyoto", failing, model);
      assert.equal(failing.previews.length, 0, "v2 never reached the organizer");
      assert.equal(await lastPrompt(pool, a), v1Prompt, "the screen is still v1's");

      const after = new Telegram();
      await say(pool, a, "yes", after, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Kyoto"], "nothing applied");
      assert.ok(after.previews.length === 1, "the current version is shown");
      assert.match(after.previews[0]!.text, /Kyoto/);
      // Now the typed yes to what IS on screen applies exactly it.
      await say(pool, a, "yes", after, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo"], "v2's own yes applies v2");
    });
  });

  test("a stale pick tap is not applied to a draft whose candidates moved", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Ruth Levi", age: 60 }]);
      const tg = new Telegram();
      let ops: unknown[] = [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }];
      const model = fakeModel(() => ops);
      await say(pool, a, "Ruth is 71", tg, model);
      const oldPick = tg.previews.at(-1)!.buttons.find((b) => b.callback_data.includes(":r:0"))!;
      ops = [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 72 } }];
      await say(pool, a, "no, 72", tg, model);
      const before = tg.sent.length;
      await tap(pool, a, oldPick.callback_data, tg, model);
      assert.deepEqual((await stored(pool, a, "travelers")).map((t) => t.age), [70, 60]);
      assert.ok(tg.sent.slice(before).some((s) => s.text.startsWith(en("change.updated"))));
    });
  });

  test("another chat's tap on this draft, and a forged well-formed id, change nothing and are answered", async () => {
    await withChats(async (pool, a, b) => {
      await hold(pool, a, "phases", TWO);
      const tgA = new Telegram();
      await say(pool, a, "Tokyo ends 25", tgA, fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]));
      const yes = tgA.button("a")!.callback_data;
      const tgB = new Telegram();
      await tap(pool, b, yes, tgB, fakeModel(() => []));
      await tap(pool, b, `pc:pchg_${"0".repeat(32)}:deadbeef:a`, tgB, fakeModel(() => []));
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
      assert.equal(tgB.acks.length, 2);
      assert.ok(tgB.sent.every((s) => s.text === en("change.gone")), JSON.stringify(tgB.sent));
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"]);
    });
  });

  test("a button from before digests existed is never applied", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      await say(pool, a, "Tokyo ends 25", tg, fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]));
      const draftId = (await draftRows(pool, a))[0]!.id;
      await tap(pool, a, `pc:${draftId}:a`, tg, fakeModel(() => []));
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
      assert.equal(tg.acks.length, 1);
    });
  });
});

describe("B: a preview that was not delivered is not shown", opts, () => {
  test("a refused send records no prompt, says something short, and a typed 'ok' applies nothing", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      tg.failPreviews = true;
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      assert.equal(tg.previews.length, 0);
      assert.ok(!(await lastPrompt(pool, a))?.startsWith("pc:"), `the screen must not be marked: ${await lastPrompt(pool, a)}`);
      assert.ok(tg.sent.some((s) => s.ok && s.text === en("change.sendFailed")), "the organizer is told, briefly");
      const quiet = fakeModel(() => []);
      await say(pool, a, "ok", new Telegram(), quiet);
      assert.deepEqual(await stored(pool, a, "phases"), TWO, "an unseen change is never applied by a typed ok");
    });
  });
});

describe("a crash between the draft and the commit loses nothing and duplicates nothing", opts, () => {
  const message = { text: "Tokyo ends on the 25th", id: "m-crash-1" };

  test("the relay dies while the draft is created: the redelivered message makes it, once, and shows it", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(crashOnce(pool, /INSERT INTO control_plane\.intake_pending_changes/), a, message.text, tg, model, message.id);
      assert.equal((await draftRows(pool, a)).length, 0, "the crash left no draft");
      const done = await pool.query("SELECT committed_at FROM control_plane.interview_interpretations WHERE session_id = $1", [a.sessionId]);
      assert.ok(done.rows.every((r) => r.committed_at === null), "and the reading was NOT marked done");
      await say(pool, a, message.text, tg, model, message.id);
      const rows = await draftRows(pool, a);
      assert.equal(rows.length, 1, "exactly one draft");
      assert.equal(tg.previews.length, 1, "the change is shown");
      assert.deepEqual(await stored(pool, a, "phases"), TWO, "and nothing is applied before Yes");
    });
  });

  test("the relay dies after the draft, before the commit: replay finds THAT draft, shows it, makes no second", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(crashOnce(pool, /SET outcomes = \$2::jsonb, committed_at = now\(\)/), a, message.text, tg, model, message.id);
      assert.equal((await draftRows(pool, a)).length, 1, "the draft was made first");
      assert.equal(tg.previews.length, 0);
      await say(pool, a, message.text, tg, model, message.id);
      assert.equal((await draftRows(pool, a)).length, 1, "still exactly one");
      assert.equal(tg.previews.length, 1, "shown once");
    });
  });

  test("a MIXED message (an answer and a change) resumed after a crash keeps both: the answer written once, the change shown", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(
        () => [update("Tokyo", { end: "2026-05-25" })],
        () => ({
          proposals: [{ questionId: "trip_interests", value: { kind: "text", text: "hiking" }, confidence: 0.95, evidence: "hiking", sourceMessageId: "m-mixed" }],
        }),
      );
      const text = "Tokyo ends on the 25th, and we love hiking";
      await say(crashOnce(pool, /SET outcomes = \$2::jsonb, committed_at = now\(\)/), a, text, tg, model, "m-mixed");
      await say(pool, a, text, tg, model, "m-mixed");
      assert.equal((await draftRows(pool, a)).length, 1);
      assert.equal(tg.previews.length, 1, "the change was not lost with the resumed reading");
      const interests = await pool.query("SELECT answers -> 'trip_interests' AS a FROM control_plane.intake_sessions WHERE id = $1", [a.sessionId]);
      assert.equal(interests.rows[0].a?.text ?? interests.rows[0].a?.other_text, "hiking", "the answer half was written");
      assert.equal(model.calls.n, 1, "the paid-for reading was resumed, not asked again");
    });
  });

  test("a replay after a normal completion creates nothing and shows nothing more", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, message.text, tg, model, message.id);
      const shown = tg.previews.length;
      await say(pool, a, message.text, tg, model, message.id);
      assert.equal((await draftRows(pool, a)).length, 1);
      assert.equal(tg.previews.length, shown, "no second preview");
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
    });
  });
});

describe("D: a draft has a size, and its preview fits one message", opts, () => {
  test("follow-ups that would pass 40 operations are refused OUT LOUD, and what was waiting is kept whole", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      let batch = 0;
      const model = fakeModel(() => Array.from({ length: 20 }, (_, i) => ({ op: "add_stop", fields: { name: `S${batch}-${i}` } })));
      for (batch = 0; batch < 3; batch += 1) await say(pool, a, `add twenty more, batch ${batch}`, tg, model);
      const rows = await draftRows(pool, a);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.nops, 40, "two batches kept, the third refused whole");
      assert.equal(tg.last!.text, en("change.tooBig"));
      for (const s of tg.sent) assert.ok(s.ok && s.text.length <= 4096, `${s.text.length} chars`);
      assert.ok(tg.previews.at(-1)!.text.length <= PREVIEW_BUDGET_CHARS + 200);
    });
  });

  test("one message too large to show is refused, with nothing stored, and every preview ever sent fits", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const long = (n: number) => "x".repeat(n);
      const model = fakeModel(() =>
        Array.from({ length: 20 }, (_, i) => ({
          op: "add_stop",
          fields: { name: `${long(70)}${i}`, name_en: long(80), accommodation: { name: long(80), confirmation: long(80) }, planned: Array.from({ length: 12 }, () => long(80)) },
        })),
      );
      await say(pool, a, "add everything", tg, model);
      assert.equal((await draftRows(pool, a)).length, 0);
      assert.equal(tg.last!.text, en("change.tooBigFresh"));
      for (const s of tg.sent) assert.ok(s.ok && s.text.length <= 4096);
    });
  });

  test("the largest draft the store will accept renders under Telegram's limit in both languages", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const { renderDraft } = await import("../src/typed-changes-render.js");
      let accepted = 0;
      let widest = 0;
      for (let i = 0; i < 40; i += 1) {
        const r = await proposeChange(pool, {
          sessionId: a.sessionId, tripId: a.tripId, interpretationId: id("interp"),
          ops: [{ op: "add_stop", fields: { name: `${"n".repeat(60)}${i}`, planned: ["p".repeat(80), "q".repeat(80), "r".repeat(80)] } }] as never,
        });
        if (r.kind !== "created" && r.kind !== "merged") break;
        accepted += 1;
        for (const language of ["en", "he"] as const) widest = Math.max(widest, renderDraft(r.draft, language).text.length + 200);
      }
      assert.ok(accepted >= 2 && accepted < 40, `${accepted} accepted before the budget`);
      assert.ok(widest <= 4096, `${widest} chars`);
    });
  });
});

describe("E: a change proposed to a confirmed interview is refused, out loud", opts, () => {
  test("Confirm lands while the model is reading: the change is refused with a plain sentence, and no draft is left", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(
        () => [update("Tokyo", { end: "2026-05-25" })],
        () => ({}),
        async () => { await pool.query("UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE id = $1", [a.sessionId]); },
      );
      await say(pool, a, "Tokyo ends on the 25th", tg, model);
      assert.equal((await draftRows(pool, a)).length, 0);
      assert.equal(tg.last!.text, en("change.sessionConfirmed"));
    });
  });

  test("the store itself refuses", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      await pool.query("UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE id = $1", [a.sessionId]);
      const r = await proposeChange(pool, { sessionId: a.sessionId, tripId: a.tripId, interpretationId: id("interp"), ops: [update("Tokyo", { end: "2026-05-25" })] as never });
      assert.deepEqual(r, { kind: "confirmed" });
    });
  });
});

describe("G: no validator text reaches the organizer", opts, () => {
  for (const [label, message, expected] of [
    ["English", "Ruth isn't coming", "it would leave nobody on the trip"],
    ["Hebrew", "רות לא מגיעה", "זה לא יותיר אף נוסע בטיול"],
  ] as const) {
    test(`removing the only traveller (${label}) says a localized reason`, async () => {
      await withChats(async (pool, a) => {
        await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }]);
        const tg = new Telegram();
        await say(pool, a, message, tg, fakeModel(() => [{ op: "remove_traveller", target: { name: "Ruth Cohen" } }]));
        const text = tg.last!.text;
        assert.doesNotMatch(text, /establish who is on this trip|Ask for the names directly/);
        assert.ok(text.includes(expected), text);
      });
    });
  }
});

describe("H: a held list that cannot be edited by typing says so and leaves no draft", opts, () => {
  test("a non-object stop: one plain message, no draft, no button, Confirm is not blocked", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", ["Tokyo", stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const tg = new Telegram();
      await say(pool, a, "Kyoto ends 31", tg, fakeModel(() => [update("Kyoto", { end: "2026-05-31" })]));
      assert.equal((await draftRows(pool, a)).length, 0, "no draft was left");
      assert.equal(tg.previews.length, 0);
      assert.match(tg.last!.text, /can't change .* by typing/);
      assert.ok(tg.last!.buttons.length === 0);
      const open = await getOpenDraft(pool, a.sessionId);
      assert.equal(open, null);
    });
  });
});
