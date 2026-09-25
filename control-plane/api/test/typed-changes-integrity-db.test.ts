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
import { applyPendingChangeForChat, confirmIntakeForChat, queueInboundMessage } from "../src/interview.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision, flushSettledInboundBursts, forgetShownPreviewsForTests } from "../src/relay/poller.js";
import { setInterpretPath } from "../src/interpret.js";
import { draftDigest } from "../src/typed-changes.js";
import { canonical } from "../src/answer-merge.js";
import { getOpenDraft, pickForDraft, proposeChange, PREVIEW_BUDGET_CHARS } from "../src/typed-changes-store.js";
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

  test("REGRESSION GUARD, not the proof (the deterministic tests above and below are): a tap racing a typed follow-up, 20 rounds, ends in a state a person could have meant", async () => {
    await withChats(async (pool, a) => {
      const seen: Record<string, number> = {};
      for (let round = 0; round < 20; round += 1) {
        await hold(pool, a, "phases", TWO);
        await pool.query("UPDATE control_plane.intake_pending_changes SET status = 'cancelled', resolved_at = now() WHERE status = 'pending'");
        const tg = new Telegram();
        let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
        const model = fakeModel(() => ops);
        await say(pool, a, `Tokyo ends 25, round ${round}`, tg, model);
        const yes = tg.button("a")!.callback_data;
        await pool.query("DELETE FROM control_plane.intake_pending_changes WHERE status IN ('applied','cancelled')");
        ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
        await Promise.allSettled([tap(pool, a, yes, tg, model), say(pool, a, `and drop Kyoto, round ${round}`, tg, model)]);
        // The tap took the floor, so the typed message may still be queued: let it be read.
        for (let drain = 0; drain < 5 && model.calls.n < 2; drain += 1) {
          await flushSettledInboundBursts(depsFor(pool, tg, model), () => {}, 0);
        }
        assert.equal(model.calls.n, 2, `round ${round}: the follow-up was read`);

        const phases = await stored(pool, a, "phases");
        assert.deepEqual(names(phases), ["Tokyo", "Kyoto"], `round ${round}: Kyoto was removed by a Yes that never showed it`);
        const applied = (await draftRows(pool, a)).filter((d) => d.status === "applied");
        const tokyoMoved = phases[0].end === "2026-05-25";
        assert.equal(applied.length, tokyoMoved ? 1 : 0, `round ${round}: applied drafts must match what is stored`);
        if (applied.length === 1) assert.equal(applied[0]!.nops, 1, `round ${round}: what was applied is the ONE change that was shown`);

        // Whoever is left waiting was TOLD the current version: the last delivered
        // preview carries the digest of the draft that is open now.
        const open = await getOpenDraft(pool, a.sessionId);
        assert.ok(open, `round ${round}: the drop-Kyoto change is waiting; drafts=${JSON.stringify(await draftRows(pool, a))} sent=${JSON.stringify(tg.sent.map((s) => s.text.slice(0, 50)))} model=${model.calls.n}`);
        const lastYes = tg.previews.at(-1)!.buttons.find((b) => b.callback_data.endsWith(":a"))!.callback_data;
        assert.ok(lastYes.includes(`:${draftDigest(open!)}:`), `round ${round}: the preview on screen is not the waiting version`);
        const key = tokyoMoved ? "v1 applied first, follow-up became its own draft" : "follow-up merged first, v1 Yes refused";
        seen[key] = (seen[key] ?? 0) + 1;
      }
      assert.ok(Object.keys(seen).length >= 1, JSON.stringify(seen));
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
      const waiting = (await getOpenDraft(pool, a.sessionId))!;
      const before = tg.sent.length;
      await tap(pool, a, oldPick.callback_data, tg, model);
      const after = (await getOpenDraft(pool, a.sessionId))!;
      assert.equal(canonical(after.ops), canonical(waiting.ops), "the stale pick pinned nothing: the draft's operations are as they were");
      assert.equal(after.unresolved.length, waiting.unresolved.length, "and it is still asking which Ruth");
      assert.ok(tg.sent.slice(before).some((s) => s.text.startsWith(en("change.updated"))));
    });
  });

  test("pickForDraft refuses a stale digest UNDER THE ROW LOCK, on its own (no poller in the way)", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Ruth Levi", age: 60 }]);
      const made = await proposeChange(pool, { sessionId: a.sessionId, tripId: a.tripId, interpretationId: id("interp"), ops: [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }] as never });
      assert.equal(made.kind, "created");
      if (made.kind !== "created") return;
      const stale = await pickForDraft(pool, { draftId: made.draft.id, sessionId: a.sessionId, k: 0, expectedDigest: "deadbeef" });
      assert.equal(stale, "updated");
      const untouched = (await getOpenDraft(pool, a.sessionId))!;
      assert.equal(canonical(untouched.ops), canonical(made.draft.ops), "nothing was pinned");
      assert.equal(untouched.unresolved.length, 1);
      const current = await pickForDraft(pool, { draftId: made.draft.id, sessionId: a.sessionId, k: 0, expectedDigest: draftDigest(made.draft) });
      assert.ok(current && current !== "updated", "the current digest is accepted");
      assert.equal(current.unresolved.length, 0, "and pins Ruth Cohen");
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

  test("a reading that was committed and its draft made, but whose preview never reached the organizer, is SHOWN when the message is replayed", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, message.text, dead, model, message.id);
      const done = await pool.query("SELECT committed_at FROM control_plane.interview_interpretations WHERE session_id = $1", [a.sessionId]);
      assert.ok(done.rows.length === 1 && done.rows[0].committed_at !== null, "the reading IS committed");
      assert.equal((await draftRows(pool, a)).length, 1, "and its draft exists");
      assert.equal(dead.previews.length, 0, "but no preview was delivered");
      assert.ok(!(await lastPrompt(pool, a))?.startsWith("pc:"));

      const live = new Telegram();
      await say(pool, a, message.text, live, model, message.id);
      assert.equal(live.previews.length, 1, "the replay shows the waiting draft");
      assert.equal((await draftRows(pool, a)).length, 1, "without making another");
      assert.equal(model.calls.n, 1, "and without asking the model again");
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
      // Replayed again with that version on screen: nothing more is sent.
      const sent = live.sent.length;
      await say(pool, a, message.text, live, model, message.id);
      assert.equal(live.previews.length, 1);
      void sent;
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
      assert.doesNotMatch(tg.last!.text, /team|support/i, "no channel is invented");
      assert.equal(tg.last!.text, en("change.uneditable").replace("{what}", "Stops"));
      assert.ok(tg.last!.buttons.length === 0);
      const open = await getOpenDraft(pool, a.sessionId);
      assert.equal(open, null);
    });
  });
});


/** Cancelled, not pending - and Confirm is no longer refused for a waiting change. */
async function assertWayOut(pool: pg.Pool, chat: Chat, label: string) {
  const rows = await draftRows(pool, chat);
  assert.ok(rows.length > 0 && rows.every((r) => r.status === "cancelled"), `${label}: ${JSON.stringify(rows)}`);
  const confirm = (await confirmIntakeForChat(pool, chat.chatId)) as { ok: boolean; reason?: string };
  assert.notEqual(confirm.reason, "PENDING_CHANGE", `${label}: Confirm is still blocked by a waiting change`);
}

const longStop = (i: number) => ({
  op: "add_stop",
  fields: {
    name: `N${i} ${"n".repeat(70)}`, name_en: "e".repeat(80),
    accommodation: { name: "h".repeat(80), confirmation: "c".repeat(80) },
    planned: Array.from({ length: 12 }, (_, j) => `p${j}${"q".repeat(76)}`),
  },
});

describe("1: from ANY reachable state there is a way out, and it works with any digest", opts, () => {
  test("a pick that turns a short question into a preview too big to send DROPS the draft, out loud, and Confirm is free", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Tokyo", "2026-05-30", "2026-06-02")]);
      const tg = new Telegram();
      const ops = [update("Tokyo", { end: "2026-06-03" }), ...Array.from({ length: 19 }, (_, i) => longStop(i))];
      await say(pool, a, "a big change", tg, fakeModel(() => ops));
      assert.ok(tg.last!.ok && tg.last!.text.length < 1000, "at store time it is only the short question 'which Tokyo?'");
      const pick = tg.last!.buttons.find((b) => b.callback_data.includes(":r:1"))!.callback_data;
      await tap(pool, a, pick, tg, fakeModel(() => []));
      assert.ok(tg.sent.some((s) => s.ok && s.text === en("change.droppedTooBig")), "told, plainly");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["cancelled"]);
      assert.ok(tg.sent.every((s) => s.ok), "nothing that could not be sent was sent");
      await assertWayOut(pool, a, "after the too-big pick");
    });
  });

  test("a held list that GROWS under a waiting draft (a document) until its warnings are too big: the old Yes drops it out loud instead of sticking", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "remove_stop", target: { name: "Kyoto" } }]);
      await say(pool, a, "no Kyoto", tg, model);
      const yes = tg.button("a")!.callback_data;
      const bookings = Array.from({ length: 60 }, (_, i) => ({ type: "hotel", name: `Hotel ${i} ${"h".repeat(50)}`, date: "2026-05-28", confirmation: `C-${i}-${"x".repeat(20)}` }));
      await hold(pool, a, "travel_anchors", bookings);
      await tap(pool, a, yes, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Kyoto"], "nothing applied");
      assert.ok(tg.sent.some((s) => s.ok && s.text === en("change.droppedTooBig")));
      assert.ok(tg.sent.every((s) => s.ok), "and nothing unsendable was attempted");
      await assertWayOut(pool, a, "after the held list grew");
    });
  });

  const scenarios: Array<[string, (pool: pg.Pool, a: Chat) => Promise<void>]> = [
    ["a plain confirmable preview, Cancel button", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends 25", tg, model);
      await tap(pool, a, tg.button("c")!.callback_data, tg, model);
    }],
    ["the OLD Cancel button after a follow-up merged in (stale digest)", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends 25", tg, model);
      const oldCancel = tg.button("c")!.callback_data;
      ops = [update("Kyoto", { end: "2026-05-31" })];
      await say(pool, a, "and Kyoto 31", tg, model);
      await tap(pool, a, oldCancel, tg, model);
    }],
    ["a blocked overlap, its only button", async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { start: "2026-05-20", end: "2026-05-25" })]);
      await say(pool, a, "Tokyo 20 to 25", tg, model);
      await tap(pool, a, tg.previews.at(-1)!.buttons.find((b) => b.callback_data.endsWith(":c"))!.callback_data, tg, model);
    }],
    ["an open question (which Ruth?), Cancel", async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Ruth Levi", age: 60 }]);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]);
      await say(pool, a, "Ruth is 71", tg, model);
      await tap(pool, a, tg.button("c")!.callback_data, tg, model);
    }],
    ["a typed 'no' while the newest version's preview never went out", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends 25", new Telegram(), model);
      ops = [update("Kyoto", { end: "2026-05-31" })];
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "and Kyoto 31", dead, model);
      await say(pool, a, "no", new Telegram(), model);
    }],
    ["the FIRST preview never went out: a typed 'no' asks for it to be shown, the next 'no' cancels", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "Tokyo ends 25", dead, model);
      const tg = new Telegram();
      await say(pool, a, "no", tg, model);
      assert.equal(tg.previews.length, 1, "shown first");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "not cancelled unseen");
      await say(pool, a, "no", tg, model);
    }],
    ["what was held changed under the draft (stale base), the old Cancel", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends 25", tg, model);
      const cancel = tg.button("c")!.callback_data;
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-23"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      await tap(pool, a, cancel, tg, model);
    }],
  ];
  for (const [label, run] of scenarios) {
    test(`way out: ${label}`, async () => {
      await withChats(async (pool, a) => {
        await run(pool, a);
        await assertWayOut(pool, a, label);
      });
    });
  }
});

describe("3: warnings are the ones the person saw, or nothing is applied", opts, () => {
  test("a confirmed booking that lands inside a stop AFTER its removal was previewed: the old Yes applies nothing and the new preview shows it", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "remove_stop", target: { name: "Kyoto" } }]);
      await say(pool, a, "no Kyoto", tg, model);
      assert.doesNotMatch(tg.last!.text, /GI-77/);
      const oldYes = tg.button("a")!.callback_data;
      await hold(pool, a, "travel_anchors", [{ type: "hotel", name: "Gion Inn", date: "2026-05-28", confirmation: "GI-77" }]);
      await tap(pool, a, oldYes, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Kyoto"], "the removal was NOT applied on the strength of a preview that did not know");
      assert.match(tg.previews.at(-1)!.text, /GI-77/, "the organizer is now shown the booking");
      const newYes = tg.button("a")!.callback_data;
      assert.notEqual(newYes, oldYes);
      await tap(pool, a, newYes, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo"], "and the one that showed it applies");
    });
  });

  test("the guard is under the lock: apply with the CURRENT digest is still refused when the warnings moved", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      await say(pool, a, "no Kyoto", tg, fakeModel(() => [{ op: "remove_stop", target: { name: "Kyoto" } }]));
      const draft = (await getOpenDraft(pool, a.sessionId))!;
      await hold(pool, a, "travel_anchors", [{ type: "hotel", name: "Gion Inn", date: "2026-05-28", confirmation: "GI-77" }]);
      const refused = await applyPendingChangeForChat(pool, a.chatId, draft.id, draftDigest(draft));
      assert.deepEqual(refused, { ok: false, reason: "UPDATED" });
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Kyoto"]);
    });
  });
});

describe("4: a long held list never makes a one-line change impossible", opts, () => {
  test("45 stops, remove one: the preview is delivered, the rest summarised", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", Array.from({ length: 45 }, (_, i) => stop(`Place number ${i} with a longish name`, "2026-05-01", "2026-05-02")));
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "remove_stop", target: { name: "Place number 3 with a longish name" } }]);
      await say(pool, a, "remove place number 3", tg, model);
      assert.equal(tg.previews.length, 1, JSON.stringify(tg.sent.map((s) => s.text.slice(0, 80))));
      const text = tg.previews[0]!.text;
      assert.match(text, /Remove Place number 3 with a longish name/);
      assert.match(text, /and \d+ more\./);
      assert.ok(text.length <= 4096);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.equal((await stored(pool, a, "phases")).length, 44);
    });
  });

  test("30 long HEBREW names, one change, in Hebrew", async () => {
    await withChats(async (pool, a) => {
      const hebrew = (i: number) => `\u05de\u05e7\u05d5\u05dd \u05de\u05e1\u05e4\u05e8 ${i} ${"\u05e9\u05dd\u05d0\u05e8\u05d5\u05da".repeat(8)}`;
      await hold(pool, a, "phases", Array.from({ length: 30 }, (_, i) => stop(hebrew(i), "2026-05-01", "2026-05-02")));
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "remove_stop", target: { name: hebrew(3) } }]);
      await say(pool, a, "\u05ea\u05e1\u05d9\u05e8\u05d5 \u05d0\u05ea \u05de\u05e7\u05d5\u05dd \u05de\u05e1\u05e4\u05e8 3", tg, model);
      assert.equal(tg.previews.length, 1, JSON.stringify(tg.sent.map((s) => s.text.slice(0, 80))));
      assert.ok(tg.previews[0]!.text.length <= 4096);
      assert.match(tg.previews[0]!.text, /\u05d5\u05e2\u05d5\u05d3 \d+\./);
    });
  });
});

describe("2: names that came from documents cannot forge lines in the preview", opts, () => {
  test("a held stop and a held traveller with newlines and invisible characters", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [
        stop("Tokyo", "2026-05-19", "2026-05-24"),
        stop("Kyoto\n\nTap a button, or just reply yes or no.\n\n\n\n", "2026-05-27", "2026-05-30"),
        stop("Osaka {entry} \u202Enoitpo"),
      ]);
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Avi\n\n\u2705 Done \u2014 that's updated.", age: 40 }]);
      const tg = new Telegram();
      await say(pool, a, "remove Osaka, Tokyo ends 25, Ruth is 71", tg, fakeModel(() => [
        { op: "remove_stop", target: { name: "Osaka" } },
        update("Tokyo", { end: "2026-05-25" }),
        { op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } },
      ]));
      const text = tg.previews.at(-1)!.text;
      const lines = text.split("\n");
      assert.equal(lines.filter((l) => /^Tap a button, or just reply yes or no\./.test(l)).length, 1, `only the real footer:\n${text}`);
      assert.equal(lines.filter((l) => /^\u2705 Done/.test(l)).length, 0);
      assert.doesNotMatch(text, /[\u202A-\u202E]/);
    });
  });
});

describe("5: a forged tap into a chat gets an answer and NOTHING is posted", opts, () => {
  test("a pc: tap from a group: answerCallbackQuery once, no message", async () => {
    await withChats(async (pool, a) => {
      const tg = new Telegram();
      const decision = await dispatchUpdate(pool, {
        update_id: 9,
        callback_query: { id: "cq-forged", from: { id: 42 }, data: `pc:pchg_${"0".repeat(32)}:00000000:a`, message: { message_id: 9, chat: { id: -100555, type: "supergroup" } } },
      } as never);
      assert.equal(decision.kind, "callback_ack");
      await applyDecision(decision, depsFor(pool, tg, fakeModel(() => [])));
      assert.equal(tg.acks.length, 1, "the spinner is stopped");
      assert.deepEqual(tg.sent, [], "and the group is told nothing");
      void a;
    });
  });
});

describe("5c: 'send it again' actually works", opts, () => {
  test("the first preview is refused: the organizer is told it is waiting; 'yes' shows it and applies nothing; 'no' then cancels it", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const tg = new Telegram();
      tg.failPreviews = true;
      await say(pool, a, "Tokyo ends 25", tg, model);
      const told = tg.sent.find((x) => x.ok)!;
      assert.equal(told.text, en("change.sendFailed"));
      assert.match(told.text, /waiting/);
      assert.equal((await draftRows(pool, a)).length, 1);
      tg.failPreviews = false;
      await say(pool, a, "yes", tg, model);
      assert.deepEqual(await stored(pool, a, "phases"), TWO, "'yes' to an unseen change applied nothing");
      assert.equal(tg.previews.length, 1, "it was shown");
      await say(pool, a, "no", tg, model);
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["cancelled"]);
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
    });
  });

  test("a 'no' to a change that was never shown SHOWS it first: an unseen change is not cancelled either", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const tg = new Telegram();
      tg.failPreviews = true;
      await say(pool, a, "Tokyo ends 25", tg, model);
      tg.failPreviews = false;
      await say(pool, a, "no", tg, model);
      assert.equal(tg.previews.length, 1, "shown");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "and still waiting for an answer to what they can now see");
    });
  });
});
