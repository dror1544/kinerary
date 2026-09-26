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
import { CONFIRM_CALLBACK_DATA, FINISH_CALLBACK_DATA, MORE_CALLBACK_DATA, startFromDeepLink } from "../src/chat-router.js";
import {
  applyPendingChangeForChat,
  confirmIntakeForChat,
  deferQuestionForChat,
  INTAKE_QUESTIONS,
  markAwaitingMachine,
  openAgentTurn,
  queueInboundMessage,
  recordLastPromptForChat,
  setLanguageForChat,
} from "../src/interview.js";
import { DEFAULT_STRINGS, dispatchUpdate } from "../src/relay/dispatch.js";
import { askText, uiString } from "../src/intake-copy.js";
import {
  advanceRouterOwnedQuestions,
  applyDecision,
  flushSettledInboundBursts,
  forgetShownPreviewsForTests,
  recoverStalledInterviews,
  renderDueRouterPrompts,
  retryFailedSteps,
  setStepRetryBaseMsForTests,
  startTripBotPoller,
  STEP_RETRY_MAX_ATTEMPTS,
} from "../src/relay/poller.js";
import { openConflict } from "../src/answer-provenance.js";
import { reserveDocument } from "../src/document-registry.js";
import { contentDigest } from "../src/document-store.js";
import { setInterpretPath } from "../src/interpret.js";
import { draftDigest } from "../src/typed-changes.js";
import { canonical } from "../src/answer-merge.js";
import { getOpenDraft, pickForDraft, proposeChange, PREVIEW_BUDGET_CHARS } from "../src/typed-changes-store.js";
import { HttpTelegramClient } from "../src/relay/telegram-api.js";
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

/** Why the fake refuses a preview: for good (`true`, a 400 "Bad Request"), or only for now. */
type PreviewFailure = false | true | "rate_limited" | "server_error" | "network" | "throws";

/** Mirrors the Bot API client: a refused send returns ok:false (and says whether it is for good), it does not throw. */
class Telegram {
  readonly sent: Sent[] = [];
  readonly acks: unknown[] = [];
  /**
   * Refuse any message that carries a change's buttons (a preview). Only
   * previews: the interview's own questions still go out, so what happens AFTER
   * a refused preview can be seen.
   *
   *  - `true`: a text Telegram will never take (HTTP 400, `permanent: true`).
   *  - `"rate_limited"` / `"server_error"` / `"network"`: what `HttpTelegramClient`
   *    returns for a 429 it did not wait out, a 5xx, a fetch that failed -
   *    `ok: false` and NOT permanent: the same message may go through later.
   *  - `"throws"`: a client that throws instead (the poller must treat it as transient).
   */
  failPreviews: PreviewFailure = false;
  /** Refuse `change.sendFailed` too, transiently (in any language): the notice that the change is waiting never arrives. */
  failSendFailed = false;
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: Button[][] } }) {
    const buttons = (p.replyMarkup?.inline_keyboard ?? []).flat();
    const preview = buttons.some((b) => b.callback_data.startsWith("pc:"));
    if (this.failSendFailed && (p.text === uiString("change.sendFailed", "en") || p.text === uiString("change.sendFailed", "he"))) {
      this.sent.push({ text: p.text, buttons, ok: false });
      return { ok: false as const, error: "Too Many Requests: retry after 30" };
    }
    const failing = this.failPreviews !== false && preview;
    const tooLong = p.text.length > 4096;
    const ok = !failing && !tooLong;
    this.sent.push({ text: p.text, buttons, ok });
    if (ok) return { ok: true as const, messageId: String(this.sent.length) };
    if (tooLong || this.failPreviews === true) return { ok: false as const, error: "Bad Request: message is too long", permanent: true };
    if (this.failPreviews === "throws") throw new Error("socket hang up");
    const error = { rate_limited: "Too Many Requests: retry after 30", server_error: "Internal Server Error", network: "NETWORK" }[this.failPreviews as "rate_limited" | "server_error" | "network"];
    return { ok: false as const, error };
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

  test("the race test's failing interleaving, made deterministic: the Yes lands WHILE the follow-up is read - the follow-up's preview still goes out, after the tap's next question", async () => {
    // Round 4 root cause of the intermittent 'the preview on screen is not the
    // waiting version': the tap applied v1 and its next question took the floor
    // while this message was being read; the new draft's preview then lost the
    // floor and was never sent. Nothing replied to the organizer's message.
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      let during: () => Promise<void> = async () => {};
      const model = fakeModel(() => ops, () => ({}), () => during());
      await say(pool, a, "Tokyo ends 25", tg, model);
      const yes = tg.button("a")!.callback_data;
      ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
      during = async () => { during = async () => {}; await tap(pool, a, yes, tg, model); };
      const before = tg.sent.length;
      await say(pool, a, "and drop Kyoto", tg, model);

      assert.equal(model.calls.n, 2);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-25", "the Yes applied v1, which it showed");
      const open = (await getOpenDraft(pool, a.sessionId))!;
      assert.ok(open, "the follow-up is its own waiting draft");
      const after = tg.sent.slice(before);
      const done = after.findIndex((s) => s.text === en("change.applied"));
      const preview = after.findIndex((s) => s.ok && s.buttons.some((b) => b.callback_data.startsWith(`pc:${open.id}:${draftDigest(open)}:`)));
      assert.ok(done >= 0, JSON.stringify(after.map((s) => s.text.slice(0, 40))));
      assert.ok(preview > done, `the follow-up's preview was delivered, after the tap's answer: ${JSON.stringify(after.map((s) => s.text.slice(0, 40)))}`);
      assert.equal(after.filter((s) => s.buttons.some((b) => b.callback_data.startsWith(`pc:${open.id}:`))).length, 1, "once");
      await say(pool, a, "yes", tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo"], "and a yes to it applies it");
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
      assert.equal(tg.last!.text, en("change.uneditable").replace("{what}", "your stops"), "a lower-case noun, mid-sentence");
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

  test("a held list that GROWS under a waiting draft (a document) by 60 bookings: the old Yes applies nothing, the new preview counts what it cannot list, and ITS Yes applies", async () => {
    // Round 3 pinned the opposite here - the draft dropped as too big - which made
    // one removal impossible to do by typing, however it was sent (B1, round 4).
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const tg = new Telegram();
      const model = fakeModel(() => [{ op: "remove_stop", target: { name: "Kyoto" } }]);
      await say(pool, a, "no Kyoto", tg, model);
      const yes = tg.button("a")!.callback_data;
      const bookings = Array.from({ length: 60 }, (_, i) => ({ type: "hotel", name: `Hotel ${i} ${"h".repeat(50)}`, date: "2026-05-28", confirmation: `C-${i}-${"x".repeat(20)}` }));
      await hold(pool, a, "travel_anchors", bookings);
      await tap(pool, a, yes, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo", "Kyoto"], "nothing applied on the strength of a preview that did not know");
      assert.ok(!tg.sent.some((s) => s.text === en("change.droppedTooBig")), "not dropped: a removal cannot be sent in smaller pieces");
      assert.ok(tg.sent.every((s) => s.ok), "and nothing unsendable was attempted");
      const reshown = tg.previews.at(-1)!;
      assert.ok(reshown.text.startsWith(en("change.updated")), reshown.text.slice(0, 80));
      assert.ok(reshown.text.length <= PREVIEW_BUDGET_CHARS, `${reshown.text.length} chars`);
      const listed = [...reshown.text.matchAll(/C-\d+-x+/g)].length;
      const more = /…and (\d+) more confirmed bookings fall inside Kyoto/.exec(reshown.text);
      assert.ok(more && listed + Number(more[1]) === 60, `listed ${listed} + counted ${more?.[1]} = 60:\n${reshown.text}`);
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"]);
      await tap(pool, a, tg.button("a")!.callback_data, tg, model);
      assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo"], "the preview that counted them applies");
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
    ["a typed 'no' while the newest version's preview never went out: it is shown first, the next 'no' cancels", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends 25", new Telegram(), model);
      ops = [update("Kyoto", { end: "2026-05-31" })];
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "and Kyoto 31", dead, model);
      const tg = new Telegram();
      await say(pool, a, "no", tg, model);
      assert.equal(tg.previews.length, 1, "the merged version is shown");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "the merge they never saw is not cancelled unseen");
      await say(pool, a, "no", tg, model);
    }],
    ["a preview EVERY send rejects: a typed 'no' drops it out loud and the interview goes on", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "Tokyo ends 25", dead, model);
      await say(pool, a, "no", dead, model);
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
    ["a preview Telegram only rate-limits (a transient failure, #225): Confirm keeps it waiting and says so; a typed 'no' then cancels it", async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const tg = new Telegram();
      await say(pool, a, "Tokyo ends 25", tg, model);
      tg.failPreviews = "rate_limited";
      await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, model);
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "kept: the organizer has seen it and Telegram was only busy");
      assert.equal(tg.last!.text, en("change.sendFailed"));
      tg.failPreviews = false;
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

describe("B1 (round 4): one removal is never refused for the bookings it warns about", opts, () => {
  const PARKS = ["Universal Studios Islands of Adventure", "Walt Disney World Magic Kingdom", "Kennedy Space Center", "Hilton Orlando Lake Buena Vista", "Epcot"];
  const ORLANDO = [stop("Miami", "2026-09-25", "2026-09-30"), stop("Orlando", "2026-10-01", "2026-10-05")];
  const FAMILY = [{ name: "Dror Elul", age: 50 }, { name: "Ruth Elul", age: 48 }, { name: "Noa Elul", age: 15 }, { name: "Avi Elul", age: 12 }];
  const booking = (i: number, more: Record<string, unknown> = {}) => ({
    type: "activity", name: PARKS[i % PARKS.length], date: `2026-10-0${1 + (i % 5)}`, confirmation: `UOR-${10000000 + i}`,
    passengers: FAMILY.map((f) => f.name), ...more,
  });
  const forty = () => Array.from({ length: 40 }, (_, i) => booking(i, i === 33 ? { cancellable: false } : {}));

  for (const [label, ops, language] of [
    ["remove one stop holding 40 confirmed bookings", [{ op: "remove_stop", target: { name: "Orlando" } }], "en"],
    ["remove one traveller on 40 ticketed bookings", [{ op: "remove_traveller", target: { name: "Avi" } }], "en"],
    ["remove one stop holding 40 confirmed bookings, in Hebrew", [{ op: "remove_stop", target: { name: "Orlando" } }], "he"],
    ["remove one traveller on 40 ticketed bookings, in Hebrew", [{ op: "remove_traveller", target: { name: "Avi" } }], "he"],
  ] as const) {
    test(`${label}: proposed, delivered under the limit, the non-refundable one named; a booking landing after the preview still stops the old Yes`, async () => {
      await withChats(async (pool, a) => {
        await hold(pool, a, "phases", ORLANDO);
        await hold(pool, a, "travelers", FAMILY);
        await hold(pool, a, "travel_anchors", forty());
        await setLanguageForChat(pool, a.chatId, language);
        const tg = new Telegram();
        const model = fakeModel(() => [...ops]);
        await say(pool, a, "a removal", tg, model);
        assert.ok(!tg.sent.some((s) => s.text === uiString("change.tooBigFresh", language)), "not refused as too big");
        assert.equal(tg.previews.length, 1, JSON.stringify(tg.sent.map((s) => s.text.slice(0, 60))));
        const text = tg.previews[0]!.text;
        assert.ok(text.length <= PREVIEW_BUDGET_CHARS, `${text.length} chars`);
        assert.ok(text.includes("UOR-10000033"), `the booking the data says cannot be cancelled is named:\n${text}`);
        const draft = (await getOpenDraft(pool, a.sessionId))!;
        assert.equal(draft.preview.filter((l) => l.key.startsWith("warn.booking")).length, 40, "the draft keeps every warning");

        // A 41st booking lands AFTER the preview. It would be one of the COUNTED
        // ones, not a listed one - and the old Yes must still apply nothing.
        await hold(pool, a, "travel_anchors", [...forty(), booking(40)]);
        assert.deepEqual(await applyPendingChangeForChat(pool, a.chatId, draft.id, draftDigest(draft)), { ok: false, reason: "UPDATED" }, "the guard is over every warning, not the listed ones");
        await tap(pool, a, tg.button("a")!.callback_data, tg, model);
        assert.deepEqual(await stored(pool, a, "phases"), ORLANDO, "nothing applied");
        assert.deepEqual(await stored(pool, a, "travelers"), FAMILY);
        const reshown = tg.previews.at(-1)!;
        assert.ok(reshown.text.startsWith(uiString("change.updated", language)));
        assert.ok(reshown.text.length <= PREVIEW_BUDGET_CHARS);
        await tap(pool, a, tg.button("a")!.callback_data, tg, model);
        const [key, left] = ops[0].op === "remove_stop" ? ["phases", 1] : ["travelers", 3];
        assert.equal((await stored(pool, a, key)).length, left, "and the preview that knew applies");
      });
    });
  }
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
      // The bare reply went to the waiting change without the model: this fake
      // returns the same operation for ANY text, so a preview would be shown
      // either way - only the call count tells the two paths apart.
      assert.equal(model.calls.n, 1, "the bare 'yes' was not sent to the model (only the original change was)");
      assert.deepEqual(await stored(pool, a, "phases"), TWO, "'yes' to an unseen change applied nothing");
      assert.equal(tg.previews.length, 1, "it was shown");
      await say(pool, a, "no", tg, model);
      assert.equal(model.calls.n, 1, "nor was the 'no'");
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
      assert.equal(model.calls.n, 1, "the bare 'no' was not sent to the model (only the original change was)");
      assert.equal(tg.previews.length, 1, "shown");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "and still waiting for an answer to what they can now see");
    });
  });
});

describe("B3 (round 4): a preview Telegram refuses every time still has a way out", opts, () => {
  for (const language of ["en", "he"] as const) {
    test(`a typed 'no' drops it out loud (${language}), applies nothing, and the interview resumes`, async () => {
      await withChats(async (pool, a) => {
        await hold(pool, a, "phases", TWO);
        await setLanguageForChat(pool, a.chatId, language);
        const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
        const dead = new Telegram();
        dead.failPreviews = true;
        await say(pool, a, "Tokyo ends 25", dead, model);
        assert.equal(dead.last!.text, uiString("change.sendFailed", language));
        const before = dead.sent.length;
        await say(pool, a, language === "he" ? "לא" : "no", dead, model);
        const after = dead.sent.slice(before);
        assert.equal(after.filter((s) => s.buttons.some((b) => b.callback_data.startsWith("pc:"))).length, 1, "the re-show was attempted once");
        assert.ok(!after.some((s) => s.text === uiString("change.sendFailed", language)), "not told to reply again: it will not work");
        const told = after.findIndex((s) => s.ok && s.text === uiString("change.droppedUnshown", language));
        assert.ok(told >= 0, `told, plainly, in ${language}: ${JSON.stringify(after.map((s) => s.text.slice(0, 60)))}`);
        assert.ok(after.slice(told + 1).some((s) => s.ok), "and the interview carries on after it");
        assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["cancelled"]);
        assert.deepEqual(await stored(pool, a, "phases"), TWO, "nothing applied");
        const prompt = await lastPrompt(pool, a);
        assert.ok(prompt && !prompt.startsWith("pc:"), `the screen holds the interview again: ${prompt}`);
        assert.equal(model.calls.n, 1);
      });
    });
  }

  test("a typed 'yes' to it keeps it waiting (it was asked for), and says so; 'no' still gets out", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "Tokyo ends 25", dead, model);
      await say(pool, a, "yes", dead, model);
      assert.equal(dead.last!.text, en("change.sendFailed"));
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"]);
      await say(pool, a, "no", dead, model);
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["cancelled"]);
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
    });
  });

  test("Confirm blocked by a change whose preview cannot be sent: the change is dropped out loud and Confirm is free", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "Tokyo ends 25", dead, model);
      const before = dead.sent.length;
      await tap(pool, a, CONFIRM_CALLBACK_DATA, dead, model);
      const after = dead.sent.slice(before).map((s) => s.text);
      assert.ok(after.includes(uiString("changePendingBlocksConfirm", "en")), JSON.stringify(after));
      assert.ok(after.includes(en("change.droppedUnshown")), JSON.stringify(after));
      await assertWayOut(pool, a, "after Confirm met an unsendable change");
    });
  });
});

describe("B4 (round 4): nothing happens to a change the organizer has not seen - yes and no alike", opts, () => {
  test("a follow-up merged in and ITS preview never went out: a typed 'no' shows the merge and cancels nothing; the next 'no' cancels both", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
      const model = fakeModel(() => ops);
      await say(pool, a, "Tokyo ends 25", new Telegram(), model);
      ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
      const dead = new Telegram();
      dead.failPreviews = true;
      await say(pool, a, "and drop Kyoto", dead, model);
      assert.equal(dead.last!.text, en("change.sendFailed"), "they were told it is waiting, and to reply yes or no to see it");
      const tg = new Telegram();
      await say(pool, a, "no", tg, model);
      assert.equal(model.calls.n, 2, "the 'no' was not interpreted");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "what they never saw was not cancelled");
      assert.equal(tg.previews.length, 1);
      assert.ok(tg.previews[0]!.text.startsWith(en("change.updated")), "shown as the newer version of what they saw");
      assert.match(tg.previews[0]!.text, /Remove Kyoto/, "the merge is on screen now");
      await say(pool, a, "no", tg, model);
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["cancelled"], "a 'no' to what IS on screen cancels it");
      assert.deepEqual(await stored(pool, a, "phases"), TWO);
    });
  });
});

// ── #225: the three defects the round-4 audit said must land before the VM ──

/**
 * Every required question answered, the optional phase entered and its offer
 * still owed: the interview's next step IS the boundary offer ("a few more
 * questions, or the summary?") - which is sent ONCE (`sendOptionalOffer`).
 */
async function atTheBoundary(pool: pg.Pool, chat: Chat) {
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
    const value = q.id === "phases" ? structured(TWO)
      : q.id === "travelers" ? structured([{ name: "Ruth Cohen", age: 70 }])
      : { kind: "text", schema_version: 3, text: q.id === "organizer_identity" ? "Ruth Cohen" : "x" };
    await pool.query(
      "UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1",
      [chat.sessionId, q.id, JSON.stringify(value)],
    );
  }
  await pool.query(
    "UPDATE control_plane.intake_sessions SET phase = 'optional', ui_state = ui_state || jsonb_build_object('pending_entry', 'optional') WHERE id = $1",
    [chat.sessionId],
  );
}

const texts = (list: Sent[]) => JSON.stringify(list.map((s) => s.text.slice(0, 50)));

type Outgoing = { text: string; replyMarkup?: { inline_keyboard: Button[][] } };

/** One held send: `reached` resolves when a matching message is IN FLIGHT, `release()` lets it complete. */
interface Hold { reached: Promise<void>; release: () => void }

/**
 * A fake Telegram that can hold messages IN FLIGHT until released - the send has
 * been made and Telegram has not answered yet - which forces the interleavings a
 * scheduler only produces under load. Holds are matched by exact text or by a
 * predicate (a preview's text is not known in advance), each catches one message,
 * and several can be armed at once.
 */
class GatedTelegram extends Telegram {
  private holds: Array<{ match: (p: Outgoing) => boolean; hit: () => void; gate: Promise<void> }> = [];
  private last_: Hold = { reached: Promise.resolve(), release: () => {} };
  /** The most recent hold's arrival - kept for the tests that arm one. */
  get reached() { return this.last_.reached; }
  holdOn(match: string | ((p: Outgoing) => boolean)): Hold {
    let hit!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((resolve) => { hit = resolve; });
    const gate = new Promise<void>((resolve) => { open = resolve; });
    this.holds.push({ match: typeof match === "string" ? (p) => p.text === match : match, hit, gate });
    this.last_ = { reached, release: open };
    return this.last_;
  }
  release() { this.last_.release(); }
  override async sendMessage(p: Outgoing) {
    const i = this.holds.findIndex((h) => h.match(p));
    if (i >= 0) {
      const [held] = this.holds.splice(i, 1);
      held!.hit();
      await held!.gate;
    }
    return super.sendMessage(p);
  }
}

describe("#225 item 1: a boundary offer a change preview covered comes back when the change is settled", opts, () => {
  for (const answer of ["yes", "no"] as const) {
    test(`the tap's next step IS the offer and the follow-up's preview takes the floor back over it; settled by '${answer}', the offer is put back and no optional question is walked unasked`, async () => {
      await withChats(async (pool, a) => {
        await atTheBoundary(pool, a);
        const tg = new Telegram();
        let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
        let during: () => Promise<void> = async () => {};
        const model = fakeModel(() => ops, () => ({}), () => during());
        await say(pool, a, "Tokyo ends 25", tg, model);
        const yes = tg.button("a")!.callback_data;
        ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
        // The deterministic interleaving: the Yes on v1 lands WHILE the follow-up is read.
        during = async () => { during = async () => {}; await tap(pool, a, yes, tg, model); };
        const before = tg.sent.length;
        await say(pool, a, "and drop Kyoto", tg, model);

        const after = tg.sent.slice(before);
        const open = (await getOpenDraft(pool, a.sessionId))!;
        assert.ok(open, "the follow-up is its own waiting draft");
        const offer = after.findIndex((s) => s.text === en("essentialsDone"));
        const preview = after.findIndex((s) => s.ok && s.buttons.some((b) => b.callback_data.startsWith(`pc:${open.id}:`)));
        assert.ok(offer >= 0, `precondition: the tap's next step was the boundary offer: ${texts(after)}`);
        assert.ok(preview > offer, `the follow-up's preview went out over the offer: ${texts(after)}`);

        const mark = tg.sent.length;
        await say(pool, a, answer, tg, model);
        const settled = tg.sent.slice(mark);
        assert.equal(model.calls.n, 2, "the bare reply settled the change without the model");
        assert.ok(settled.some((s) => s.text === en(answer === "yes" ? "change.applied" : "change.cancelled")), texts(settled));
        assert.equal(settled.at(-1)?.text, en("essentialsDone"), `the offer is put back, last: ${texts(settled)}`);
        assert.equal(await lastPrompt(pool, a), "optional_offer", "and it is what is on screen - the choice is still open");
      });
    });
  }

  for (const how of ["its button", "a typed 'yes' (twice: the first one shows it)"] as const) {
    test(`the other order - the follow-up's preview goes out FIRST and the tap's offer lands over it; settled by ${how}, the offer is put back`, async () => {
      await withChats(async (pool, a) => {
        await atTheBoundary(pool, a);
        const tg = new GatedTelegram();
        let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
        let during: () => Promise<void> = async () => {};
        const model = fakeModel(() => ops, () => ({}), () => during());
        await say(pool, a, "Tokyo ends 25", tg, model);
        const yes = tg.button("a")!.callback_data;
        ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];
        // The tap applies v1 during the read and is held just before its "Done",
        // so the follow-up's preview is shown first; only then does the tap speak.
        let tapping: Promise<void> = Promise.resolve();
        during = async () => {
          during = async () => {};
          tg.holdOn(en("change.applied"));
          tapping = tap(pool, a, yes, tg, model);
          await tg.reached;
        };
        const before = tg.sent.length;
        await say(pool, a, "and drop Kyoto", tg, model);
        const open = (await getOpenDraft(pool, a.sessionId))!;
        assert.ok(open && tg.sent.slice(before).some((s) => s.ok && s.buttons.some((b) => b.callback_data.startsWith(`pc:${open.id}:`))), "v2's preview went out");
        assert.ok(!tg.sent.slice(before).some((s) => s.text === en("essentialsDone")), "before the tap said anything");
        tg.release();
        await tapping;
        assert.equal(tg.last!.text, en("essentialsDone"), `precondition: the tap's offer is now the latest message: ${texts(tg.sent.slice(before))}`);
        assert.equal(await lastPrompt(pool, a), "optional_offer");

        const mark = tg.sent.length;
        if (how === "its button") {
          await tap(pool, a, tg.previews.at(-1)!.buttons.find((b) => b.callback_data.endsWith(":a"))!.callback_data, tg, model);
        } else {
          await say(pool, a, "yes", tg, model);
          assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["applied", "pending"], "the first 'yes' only showed it (it was not the latest thing on screen)");
          await say(pool, a, "yes", tg, model);
        }
        const settled = tg.sent.slice(mark);
        assert.deepEqual(names(await stored(pool, a, "phases")), ["Tokyo"], "v2 applied");
        assert.equal(settled.at(-1)?.text, en("essentialsDone"), `the offer is put back: ${texts(settled)}`);
        assert.equal(await lastPrompt(pool, a), "optional_offer");
      });
    });
  }

  for (const answer of ["yes", "no"] as const) {
    test(`the OVERLAP (round 2): the tap's offer is sent WHILE the follow-up's preview is still in flight; settled by '${answer}', the offer is put back and no optional question is walked unasked`, async () => {
      await withChats(async (pool, a) => {
        await atTheBoundary(pool, a);
        const tg = new GatedTelegram();
        let ops: unknown[] = [update("Tokyo", { end: "2026-05-25" })];
        let during: () => Promise<void> = async () => {};
        const model = fakeModel(() => ops, () => ({}), () => during());
        await say(pool, a, "Tokyo ends 25", tg, model);
        const yes = tg.button("a")!.callback_data;
        const v1 = (await getOpenDraft(pool, a.sessionId))!.id;
        ops = [{ op: "remove_stop", target: { name: "Kyoto" } }];

        // The Yes on v1 lands while the follow-up is read, and is held just before
        // its "Done". The follow-up's preview (v2, a new draft: v1 is applied by
        // then) takes the floor, notes what is on screen, and is held IN FLIGHT.
        // Only then does the tap speak - "Done", then the boundary offer, which
        // records `optional_offer` before it is sent. Then the preview's send returns.
        const isV2Preview = (p: Outgoing) => (p.replyMarkup?.inline_keyboard ?? []).flat()
          .some((b) => b.callback_data.startsWith("pc:") && !b.callback_data.startsWith(`pc:${v1}:`));
        let tapping: Promise<void> = Promise.resolve();
        let tapDone: Hold | null = null;
        during = async () => {
          during = async () => {};
          tapDone = tg.holdOn(en("change.applied"));
          tapping = tap(pool, a, yes, tg, model);
          await tapDone.reached;
        };
        const preview = tg.holdOn(isV2Preview);
        const before = tg.sent.length;
        const following = say(pool, a, "and drop Kyoto", tg, model);
        await preview.reached;
        tapDone!.release();
        await tapping;
        assert.equal(await lastPrompt(pool, a), "optional_offer", `precondition: the tap's offer went out while the preview was in flight: ${texts(tg.sent.slice(before))}`);
        preview.release();
        await following;
        const after = tg.sent.slice(before);
        const open = (await getOpenDraft(pool, a.sessionId))!;
        assert.ok(open && open.id !== v1, "the follow-up is its own waiting draft");
        const offer = after.findIndex((s) => s.text === en("essentialsDone"));
        const shown = after.findIndex((s) => s.ok && s.buttons.some((b) => b.callback_data.startsWith(`pc:${open.id}:`)));
        assert.ok(offer >= 0 && shown > offer, `precondition: the offer, then v2's preview (whose send began first): ${texts(after)}`);

        const mark = tg.sent.length;
        await say(pool, a, answer, tg, model);
        const settled = tg.sent.slice(mark);
        assert.equal(model.calls.n, 2, "the bare reply settled the change without the model");
        assert.ok(settled.some((s) => s.text === en(answer === "yes" ? "change.applied" : "change.cancelled")), texts(settled));
        assert.equal(settled.at(-1)?.text, en("essentialsDone"), `the offer is put back, last: ${texts(settled)}`);
        assert.equal(await lastPrompt(pool, a), "optional_offer", "and it is what is on screen - the choice is still open");
      });
    });
  }

  test("the screen moved on AFTER the preview (the old offer's Finish was tapped, the summary is up): settling the change puts the summary back, not the offer it once covered", async () => {
    await withChats(async (pool, a) => {
      await atTheBoundary(pool, a);
      await pool.query(
        "UPDATE control_plane.intake_sessions SET ui_state = (ui_state - 'pending_entry') || jsonb_build_object('last_prompt', 'optional_offer', 'offered_more', true) WHERE id = $1",
        [a.sessionId],
      );
      const tg = new Telegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(pool, a, "Tokyo ends 25", tg, model);
      const yes = tg.button("a")!.callback_data;
      await tap(pool, a, FINISH_CALLBACK_DATA, tg, model);
      assert.equal(await lastPrompt(pool, a), "recap", `precondition: the summary is on screen: ${texts(tg.sent)}`);
      const mark = tg.sent.length;
      await tap(pool, a, yes, tg, model);
      const settled = tg.sent.slice(mark);
      assert.ok(settled.some((s) => s.text === en("change.applied")), texts(settled));
      assert.ok(!settled.some((s) => s.text === en("essentialsDone")), `the offer is not put back over the summary: ${texts(settled)}`);
      assert.equal(await lastPrompt(pool, a), "recap", "the summary is what is on screen");
    });
  });
});

describe("#225 item 3: a message that loses the floor to a concurrent tap is still answered, once, after the tap's reply", opts, () => {
  const tells: Array<[string, () => string, (pool: pg.Pool, a: Chat) => Promise<void>, unknown[]]> = [
    ["too big to show", () => en("change.tooBigFresh"), async () => {}, Array.from({ length: 20 }, (_, i) => longStop(i))],
    ["a held list that cannot be edited by typing", () => en("change.uneditable").replace("{what}", "your stops"),
      async (pool, a) => { await hold(pool, a, "phases", ["Tokyo", stop("Kyoto", "2026-05-27", "2026-05-30")]); },
      [update("Kyoto", { end: "2026-05-31" })]],
    ["operations that do not parse (not understood)", () => en("change.notUnderstood"), async () => {}, [{ op: "delete_everything" }]],
  ];
  for (const [label, expected, arrange, followUp] of tells) {
    test(`${label}: the tell is delivered once, as the last message, after the tap's own reply`, async () => {
      await withChats(async (pool, a) => {
        // v1 is a change to the TRAVELLERS, so the follow-up can be about the stops.
        await hold(pool, a, "phases", TWO);
        await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }]);
        const tg = new Telegram();
        let ops: unknown[] = [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } }];
        let during: () => Promise<void> = async () => {};
        const model = fakeModel(() => ops, () => ({}), () => during());
        await say(pool, a, "Ruth is 71", tg, model);
        const yes = tg.button("a")!.callback_data;
        await arrange(pool, a);
        ops = followUp;
        during = async () => { during = async () => {}; await tap(pool, a, yes, tg, model); };
        const before = tg.sent.length;
        await say(pool, a, "the follow-up", tg, model);

        const after = tg.sent.slice(before);
        const done = after.findIndex((s) => s.text === en("change.applied"));
        assert.ok(done >= 0 && after.length > done + 1, `precondition: the tap applied v1 and its next step went out: ${texts(after)}`);
        assert.equal(after.filter((s) => s.text === expected()).length, 1, `the tell, once: ${texts(after)}`);
        assert.equal(after.at(-1)!.text, expected(), `after the tap's reply: ${texts(after)}`);
        assert.equal((await stored(pool, a, "travelers"))[0].age, 71, "the tap's change was applied");
        assert.equal(await getOpenDraft(pool, a.sessionId), null, "nothing is left waiting");
      });
    });
  }
});

describe("#225 item 5: a change is dropped only when Telegram refuses it for good", opts, () => {
  for (const failure of ["rate_limited", "server_error", "network", "throws"] as const) {
    test(`Confirm meets a preview Telegram cannot take RIGHT NOW (${failure}): the change the organizer saw stays waiting, they are told so, nothing is dropped - and once Telegram recovers it is settled`, async () => {
      await withChats(async (pool, a) => {
        await hold(pool, a, "phases", TWO);
        const tg = new Telegram();
        const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
        await say(pool, a, "Tokyo ends 25", tg, model);
        tg.failPreviews = failure;
        const before = tg.sent.length;
        await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, model);
        const after = tg.sent.slice(before);
        assert.ok(after.some((s) => s.text === uiString("changePendingBlocksConfirm", "en")), texts(after));
        assert.equal(after.filter((s) => s.buttons.some((b) => b.callback_data.startsWith("pc:"))).length, 1, "the re-show was attempted");
        assert.ok(!after.some((s) => s.text === en("change.droppedUnshown")), `not dropped: ${texts(after)}`);
        assert.ok(after.some((s) => s.ok && s.text === en("change.sendFailed")), `told it is waiting: ${texts(after)}`);
        assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "the change they saw is still waiting");
        assert.deepEqual(await stored(pool, a, "phases"), TWO, "and nothing was applied");

        tg.failPreviews = false;
        await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, model);
        await tap(pool, a, tg.button("a")!.callback_data, tg, model);
        assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-25", "shown again once Telegram recovered, and its Yes applies");
      });
    });
  }

  for (const [status, description, dropped] of [
    [403, "Forbidden: bot was blocked by the user", false],
    [404, "Not Found", false],
    [400, "Bad Request: message is too long", true],
  ] as const) {
    test(`end to end through the REAL client (round 2): Telegram answers the preview with ${status} - ${dropped ? "only a 400 drops it, out loud" : "the change is kept waiting, and the organizer is told"}`, async () => {
      await withChats(async (pool, a) => {
        await hold(pool, a, "phases", TWO);
        const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
        await say(pool, a, "Tokyo ends 25", new Telegram(), model);
        const delivered: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
          const method = String(input).split("/").at(-1);
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; reply_markup?: { inline_keyboard?: Button[][] } };
          const preview = (body.reply_markup?.inline_keyboard ?? []).flat().some((b) => b.callback_data.startsWith("pc:"));
          if (method === "sendMessage" && preview) {
            return new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
          }
          if (method === "sendMessage") delivered.push(body.text ?? "");
          return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: delivered.length } : true }));
        }) as typeof fetch;
        try {
          const client = new HttpTelegramClient("123456:test-token", () => {}, undefined, { sleep: async () => {} });
          await applyDecision(
            { kind: "interview_callback", chatId: a.chatId, callbackQueryId: "cq-real", data: CONFIRM_CALLBACK_DATA, sessionId: a.sessionId } as never,
            { db: pool, telegram: client, connector: { pushInbound: () => true }, modelRunner: model.runner, log: () => {} } as never,
          );
        } finally {
          globalThis.fetch = realFetch;
        }
        assert.ok(delivered.includes(uiString("changePendingBlocksConfirm", "en")), JSON.stringify(delivered));
        assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), [dropped ? "cancelled" : "pending"], JSON.stringify(delivered));
        assert.equal(delivered.includes(en("change.droppedUnshown")), dropped, JSON.stringify(delivered));
        assert.equal(delivered.includes(en("change.sendFailed")), !dropped, JSON.stringify(delivered));
        assert.deepEqual(await stored(pool, a, "phases"), TWO, "nothing applied");
      });
    });
  }

  for (const when of ["the change's first preview", "Confirm's re-show of a change the organizer saw"] as const) {
    test(`round 2: ${when} fails for now AND so does 'change.sendFailed' - nothing is told, nothing is lost: the next Confirm is refused with the reason, shows the change, and its Yes applies`, async () => {
      await withChats(async (pool, a) => {
        await hold(pool, a, "phases", TWO);
        const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
        const tg = new Telegram();
        if (when === "the change's first preview") {
          tg.failPreviews = "rate_limited";
          tg.failSendFailed = true;
          await say(pool, a, "Tokyo ends 25", tg, model);
        } else {
          await say(pool, a, "Tokyo ends 25", tg, model);
          assert.equal(tg.previews.length, 1, "seen");
          tg.failPreviews = "rate_limited";
          tg.failSendFailed = true;
          await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, model);
        }
        assert.ok(tg.sent.some((s) => !s.ok && s.text === en("change.sendFailed")), `the notice was attempted and failed: ${texts(tg.sent)}`);
        assert.ok(!tg.sent.some((s) => s.ok && s.text === en("change.sendFailed")), "so the organizer was not told");
        assert.ok(!tg.sent.some((s) => s.text === en("change.droppedUnshown")), "and nothing was dropped");
        assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"], "the change is still waiting");
        assert.deepEqual(await stored(pool, a, "phases"), TWO);

        // Telegram recovers. The organizer taps Confirm, believing all is well.
        tg.failPreviews = false;
        tg.failSendFailed = false;
        const shownBefore = tg.previews.length;
        const mark = tg.sent.length;
        await tap(pool, a, CONFIRM_CALLBACK_DATA, tg, model);
        const after = tg.sent.slice(mark);
        assert.ok(after.some((s) => s.ok && s.text === uiString("changePendingBlocksConfirm", "en")), `Confirm is refused, with the reason: ${texts(after)}`);
        assert.equal(tg.previews.length, shownBefore + 1, "and the change is shown");
        const confirmed = await pool.query("SELECT state FROM control_plane.intake_sessions WHERE id = $1", [a.sessionId]);
        assert.notEqual(confirmed.rows[0].state, "confirmed", "the interview was NOT confirmed without the change");
        await tap(pool, a, tg.button("a")!.callback_data, tg, model);
        assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-25", "its Yes applies it");
      });
    });
  }

  test("a typed 'no' whose re-show is rate-limited keeps the unseen change waiting and says so; it is not dropped as if Telegram would never take it", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      const tg = new Telegram();
      tg.failPreviews = "rate_limited";
      await say(pool, a, "Tokyo ends 25", tg, model);
      assert.equal(tg.last!.text, en("change.sendFailed"));
      const before = tg.sent.length;
      await say(pool, a, "no", tg, model);
      const after = tg.sent.slice(before);
      assert.ok(!after.some((s) => s.text === en("change.droppedUnshown")), texts(after));
      assert.equal(after.at(-1)!.text, en("change.sendFailed"), "told it is still waiting");
      assert.deepEqual((await draftRows(pool, a)).map((d) => d.status), ["pending"]);
      tg.failPreviews = false;
      await say(pool, a, "no", tg, model);
      assert.equal(tg.previews.length, 1, "shown once Telegram recovered (it was never seen, so the 'no' shows it first)");
      await say(pool, a, "no", tg, model);
      await assertWayOut(pool, a, "after a rate-limited re-show");
    });
  });
});

/** Like `crashOnce`, but only from the moment `arm()` is called: the relay failing at one seam, at one moment. */
function armedCrash(pool: pg.Pool, match: RegExp): { db: pg.Pool; arm: () => void } {
  let armed = false;
  const guard = (query: (...a: any[]) => Promise<unknown>) => async (sql: unknown, params?: unknown) => {
    if (armed && typeof sql === "string" && match.test(sql)) {
      armed = false;
      throw new Error("the read failed");
    }
    return query(sql, params);
  };
  const db = new Proxy(pool, {
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
  return { db, arm: () => { armed = true; } };
}

const SESSION_READ = /SELECT id, trip_id, state, phase, awaiting, answers, ui_state, language\s+FROM control_plane\.intake_sessions/;

describe("#225 F-b: the read after a delivered preview cannot lose the preview", opts, () => {
  test("the session re-read throws once the preview has gone out: the preview is still recorded as on screen (pc:), the change waits, nothing is dropped", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const { db, arm } = armedCrash(pool, SESSION_READ);
      class ArmingTelegram extends Telegram {
        override async sendMessage(p: Outgoing) {
          const result = await super.sendMessage(p);
          // The preview is delivered; the NEXT session read is the one after the send.
          if (result.ok && (p.replyMarkup?.inline_keyboard ?? []).flat().some((b) => b.callback_data.startsWith("pc:"))) arm();
          return result;
        }
      }
      const tg = new ArmingTelegram();
      const model = fakeModel(() => [update("Tokyo", { end: "2026-05-25" })]);
      await say(db, a, "Tokyo ends 25", tg, model);
      assert.equal(tg.previews.length, 1, `the preview was delivered: ${texts(tg.sent)}`);
      const open = (await getOpenDraft(pool, a.sessionId))!;
      assert.ok(open, "the change is waiting");
      assert.ok((await lastPrompt(pool, a))?.startsWith(`pc:${open.id}:`), `and recorded as on screen: ${await lastPrompt(pool, a)}`);
      assert.ok(!tg.sent.some((s) => s.text === en("change.droppedUnshown") || s.text === en("change.sendFailed")), texts(tg.sent));
      // What the record is for: a typed "yes" confirms the preview that went out.
      await say(pool, a, "yes", tg, model);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-25", "the typed yes applied the change it was shown");
    });
  });
});

/**
 * Refuses the messages `refuse` matches, the way `HttpTelegramClient` reports it:
 * `ok: false`, not a throw, and `permanent` only for a 400.
 */
class RefusingTelegram extends Telegram {
  refuse: { match: (p: Outgoing) => boolean; permanent: boolean } | null = null;
  override async sendMessage(p: Outgoing) {
    if (this.refuse?.match(p)) {
      this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat(), ok: false });
      return this.refuse.permanent
        ? { ok: false as const, error: "Bad Request: something about this message", permanent: true }
        : { ok: false as const, error: "Too Many Requests: retry after 30" };
    }
    return super.sendMessage(p);
  }
}

/** Every required question answered but `leave`, which is therefore the next thing to ask. */
async function allRequiredBut(pool: pg.Pool, chat: Chat, leave: string) {
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required && x.id !== leave)) {
    const value = q.id === "phases" ? structured(TWO)
      : q.id === "travelers" ? structured([{ name: "Ruth Cohen", age: 70 }])
      : { kind: "text", schema_version: 3, text: q.id === "organizer_identity" ? "Ruth Cohen" : "x" };
    await pool.query(
      "UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1",
      [chat.sessionId, q.id, JSON.stringify(value)],
    );
  }
}
async function awaitingOf(pool: pg.Pool, chat: Chat): Promise<string> {
  return (await pool.query("SELECT awaiting FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId])).rows[0]?.awaiting;
}

describe("#225 item 9: a question or summary Telegram did not take is asked again - and never forever", opts, () => {
  const destination = INTAKE_QUESTIONS.find((q) => q.id === "destination")!;
  const asksDestination = (p: { text: string }) => p.text.includes(askText(destination, "en"));
  const stableDeps = (pool: pg.Pool, tg: Telegram, logs: string[] = []) =>
    ({ db: pool, telegram: tg, connector: { pushInbound: () => true }, log: (l: string) => logs.push(l) }) as never;
  const LATER = () => Date.now() + 3_600_000;
  const offerOnScreen = (pool: pg.Pool, a: Chat) => pool.query(
    "UPDATE control_plane.intake_sessions SET ui_state = (ui_state - 'pending_entry') || jsonb_build_object('last_prompt', 'optional_offer', 'offered_more', true) WHERE id = $1",
    [a.sessionId],
  );
  const isSummary = (p: { text: string }) => p.text.includes(en("recapHeader"));
  /**
   * Nothing else scheduled to speak: a router prompt the tap left due would re-run
   * `sendNextStep` ONCE, three seconds on, and is then spent - after that, a
   * summary that still has not arrived is owed to the step retry alone.
   */
  const dueFlagSpent = (pool: pg.Pool, a: Chat) =>
    pool.query("UPDATE control_plane.intake_sessions SET router_prompt_due_at = NULL WHERE id = $1", [a.sessionId]);

  test("a required question refused FOR NOW: un-named, the machine still owes it, the tick does not hammer it, and after the backoff it is asked - once", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      const tg = new RefusingTelegram();
      const logs: string[] = [];
      const deps = stableDeps(pool, tg, logs);
      tg.refuse = { match: asksDestination, permanent: false };
      const before = await lastPrompt(pool, a);
      await markAwaitingMachine(pool, a.chatId);

      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asksDestination).length, 1, `attempted: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), before, "un-named: the dedupe must not take it for on screen");
      assert.equal(await awaitingOf(pool, a), "machine", "the machine still owes the organizer this message");
      assert.ok(logs.some((l) => l.includes("trip_bot.step_send_failed") && l.includes('"retry":true')), logs.join("\n"));

      // The tick comes round again at once (700 ms in production): nothing is sent while the backoff runs.
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asksDestination).length, 1, "not hammered");

      tg.refuse = null;
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      const delivered = tg.sent.filter((s) => s.ok && asksDestination(s));
      assert.equal(delivered.length, 1, `asked once the backoff passed: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), "q:destination", "and now it IS on screen");
      assert.equal(await awaitingOf(pool, a), "person", "and it is the organizer's turn");

      // Nothing twice: every path that could speak again finds it on screen.
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter((s) => s.ok && asksDestination(s)).length, 1, "sent once");
    });
  });

  test("the SUMMARY refused for now after Finish: un-named, and re-sent once the backoff passes - the tick scan alone never would", async () => {
    await withChats(async (pool, a) => {
      await atTheBoundary(pool, a);
      await offerOnScreen(pool, a);
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg);
      tg.refuse = { match: isSummary, permanent: false };
      await tap(pool, a, FINISH_CALLBACK_DATA, tg, fakeModel(() => []));
      await dueFlagSpent(pool, a);
      assert.equal(tg.sent.filter(isSummary).length, 1, `the summary was attempted: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), "optional_offer", "un-named: what is on screen is still the offer");
      assert.equal(await awaitingOf(pool, a), "machine");

      tg.refuse = null;
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter((s) => s.ok && isSummary(s)).length, 0, "not before the backoff, and the scan does not cover a summary");

      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      const shown = tg.sent.filter((s) => s.ok && isSummary(s));
      assert.equal(shown.length, 1, `the summary arrived: ${texts(tg.sent)}`);
      assert.ok(shown[0]!.buttons.some((b) => b.callback_data === CONFIRM_CALLBACK_DATA), "with its Confirm button");
      assert.equal(await lastPrompt(pool, a), "recap");
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter((s) => s.ok && isSummary(s)).length, 1, "sent once");
    });
  });

  test("a PERMANENT refusal (a 400) is not retried automatically - no loop - and the organizer's next message tries it afresh", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      const tg = new RefusingTelegram();
      const logs: string[] = [];
      const deps = stableDeps(pool, tg, logs);
      tg.refuse = { match: asksDestination, permanent: true };
      const before = await lastPrompt(pool, a);
      await markAwaitingMachine(pool, a.chatId);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asksDestination).length, 1);
      assert.equal(await lastPrompt(pool, a), before, "un-named");
      assert.equal(await awaitingOf(pool, a), "person", "not handed back: re-sending what Telegram refuses for good is a loop");
      assert.ok(logs.some((l) => l.includes("trip_bot.step_send_failed") && l.includes('"permanent":true')), logs.join("\n"));

      for (let i = 0; i < 3; i += 1) {
        await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
        await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      }
      assert.equal(tg.sent.filter(asksDestination).length, 1, "no automatic retry");

      // The organizer writes (anything): the machine owes a reply, and the question is not deduped away.
      tg.refuse = null;
      await markAwaitingMachine(pool, a.chatId);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter((s) => s.ok && asksDestination(s)).length, 1, `asked on their next turn: ${texts(tg.sent)}`);
    });
  });

  test("the first optional question after 'a few more questions', refused for now: the retry asks THAT question (the nomination is not spent by a send that did not arrive)", async () => {
    await withChats(async (pool, a) => {
      await atTheBoundary(pool, a);
      await offerOnScreen(pool, a);
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg);
      // The tap itself is answered with answerCallbackQuery; the one message it
      // leads to is the first optional question, and that is what is refused.
      tg.refuse = { match: () => true, permanent: false };
      await tap(pool, a, MORE_CALLBACK_DATA, tg, fakeModel(() => []));
      // The tap nominates the question; the router asks it on its next prompt.
      await renderDueRouterPrompts(deps, DEFAULT_STRINGS, () => {}, 0);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      const attempted = tg.sent.filter((s) => !s.ok);
      assert.equal(attempted.length, 1, `the first optional question was attempted: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), "optional_offer", "un-named");

      tg.refuse = null;
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      const asked = tg.sent.filter((s) => s.ok && s.text === attempted[0]!.text);
      assert.equal(asked.length, 1, `the same question arrived: ${texts(tg.sent)}`);
      assert.ok((await lastPrompt(pool, a))?.startsWith("q:"), `and it is on screen: ${await lastPrompt(pool, a)}`);
    });
  });

  test("a TYPED message whose reply is refused for now gets no 'I didn't follow' on top: the reply is owed to the retry, not replaced", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      const tg = new RefusingTelegram();
      tg.refuse = { match: asksDestination, permanent: false };
      await say(pool, a, "hello there", tg, fakeModel(() => []));
      assert.equal(tg.sent.filter(asksDestination).length, 1, `one attempt: ${texts(tg.sent)}`);
      assert.ok(!tg.sent.some((s) => s.text.includes(en("didNotFollow"))), `no "didn't follow" over a reply Telegram did not take: ${texts(tg.sent)}`);
      tg.refuse = null;
      await retryFailedSteps(stableDeps(pool, tg), DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter((s) => s.ok && asksDestination(s)).length, 1, texts(tg.sent));
    });
  });

  test(`transient refusals in a row stop after ${STEP_RETRY_MAX_ATTEMPTS} attempts: the floor goes to the organizer and the log says so`, async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      const tg = new RefusingTelegram();
      const logs: string[] = [];
      const deps = stableDeps(pool, tg, logs);
      tg.refuse = { match: asksDestination, permanent: false };
      await markAwaitingMachine(pool, a.chatId);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      for (let i = 0; i < STEP_RETRY_MAX_ATTEMPTS + 3; i += 1) {
        await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      }
      assert.equal(tg.sent.filter(asksDestination).length, STEP_RETRY_MAX_ATTEMPTS, texts(tg.sent));
      assert.equal(await awaitingOf(pool, a), "person");
      assert.equal(logs.filter((l) => l.includes("trip_bot.step_send_abandoned")).length, 1, logs.join("\n"));
    });
  });

  test("the retry runs on the poller's own deliver tick (wired, not only callable)", async () => {
    await withChats(async (pool, a) => {
      await atTheBoundary(pool, a);
      await offerOnScreen(pool, a);
      const tg = new RefusingTelegram();
      tg.refuse = { match: isSummary, permanent: false };
      // BEFORE the failure (round 2, R3): the backoff is recorded when the send
      // fails, so shortening it afterwards would still leave a real 2 s to wait.
      // The poller starts only after, so the attempt is the tap's alone.
      setStepRetryBaseMsForTests(20);
      let stop = () => {};
      try {
        await tap(pool, a, FINISH_CALLBACK_DATA, tg, fakeModel(() => []));
        await dueFlagSpent(pool, a);
        assert.equal(tg.sent.filter(isSummary).length, 1, `attempted: ${texts(tg.sent)}`);
        tg.refuse = null;
        stop = startTripBotPoller(stableDeps(pool, tg), { longPollSeconds: 0, deliverIntervalMs: 10 });
        const deadline = Date.now() + 5_000;
        while (!tg.sent.some((s) => s.ok && isSummary(s)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      } finally {
        stop();
        setStepRetryBaseMsForTests();
        // Let the loops observe the stop before the fixture drops the pool.
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(tg.sent.filter((s) => s.ok && isSummary(s)).length, 1, texts(tg.sent));
    });
  });

  test("askOpenConflict: a disagreement refused for now is not marked as asked, nothing goes out in its place, and it is asked once the backoff passes", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", TWO);
      const bytes = new TextEncoder().encode("voucher");
      const { document } = await reserveDocument(pool, { tripId: a.tripId, digest: contentDigest(bytes), byteSize: bytes.length });
      const { conflict } = await openConflict(pool, {
        tripId: a.tripId, questionId: "phases", entryKey: "n:|tokyo|2026-05-19", path: "end",
        held: "2026-05-24", incoming: "2026-05-25", documentId: document.id,
      });
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg);
      const buttonsOf = (p: Outgoing | Sent) => ("buttons" in p ? p.buttons : (p.replyMarkup?.inline_keyboard ?? []).flat());
      const asksConflict = (p: Outgoing | Sent) => buttonsOf(p).some((b) => b.callback_data.includes(conflict.id));
      tg.refuse = { match: asksConflict, permanent: false };
      await markAwaitingMachine(pool, a.chatId);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asksConflict).length, 1, `attempted: ${texts(tg.sent)}`);
      assert.notEqual(await lastPrompt(pool, a), `cfl:${conflict.id}`, "not marked as asked");
      assert.equal(tg.sent.filter((s) => s.ok).length, 0, "and nothing went out in its place");

      tg.refuse = null;
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter((s) => s.ok && asksConflict(s)).length, 1, texts(tg.sent));
      assert.equal(await lastPrompt(pool, a), `cfl:${conflict.id}`);
    });
  });

  /** An open disagreement on this chat's trip, and a predicate for the message that asks it. */
  async function openDisagreement(pool: pg.Pool, a: Chat) {
    const bytes = new TextEncoder().encode("voucher");
    const { document } = await reserveDocument(pool, { tripId: a.tripId, digest: contentDigest(bytes), byteSize: bytes.length });
    const { conflict } = await openConflict(pool, {
      tripId: a.tripId, questionId: "phases", entryKey: "n:|tokyo|2026-05-19", path: "end",
      held: "2026-05-24", incoming: "2026-05-25", documentId: document.id,
    });
    const asks = (p: Outgoing | Sent) => ("buttons" in p ? p.buttons : (p.replyMarkup?.inline_keyboard ?? []).flat())
      .some((b) => b.callback_data.includes(conflict.id));
    return { conflict, asks };
  }

  test("round 2 (R1): a disagreement Telegram refuses FOR GOOD never blocks the interview - it is skipped, the next question goes out, and it is not asked again on later ticks", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      await hold(pool, a, "phases", TWO);
      const { asks } = await openDisagreement(pool, a);
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg);
      tg.refuse = { match: (p) => asks(p), permanent: true };
      await markAwaitingMachine(pool, a.chatId);

      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asks).length, 1, `the disagreement was attempted once: ${texts(tg.sent)}`);
      assert.equal(tg.sent.filter((s) => s.ok && asksDestination(s)).length, 1, `and the interview went on - the next question arrived: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), "q:destination");
      assert.equal(await awaitingOf(pool, a), "person", "the organizer's turn");

      // Later ticks, and a due retry: nothing loops, nothing is asked again.
      for (let i = 0; i < 3; i += 1) {
        await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
        await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      }
      assert.equal(tg.sent.filter(asks).length, 1, "the disagreement is not re-asked");
      assert.equal(tg.sent.filter(asksDestination).length, 1, "and the question is not repeated");
    });
  });

  test("round 2 (R1): the refused disagreement's key stays recorded (the old dedupe), so a question that then fails for now is retried WITHOUT the disagreement being asked again", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      await hold(pool, a, "phases", TWO);
      const { conflict, asks } = await openDisagreement(pool, a);
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg);
      // The disagreement is refused for good; the question after it only for now.
      let failQuestion = true;
      const original = tg.sendMessage.bind(tg);
      tg.sendMessage = (async (p: Outgoing) => {
        const refused = asks(p) || (failQuestion && asksDestination(p));
        if (!refused) return original(p);
        tg.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat(), ok: false });
        return asks(p)
          ? { ok: false as const, error: "Bad Request: something about this message", permanent: true }
          : { ok: false as const, error: "Too Many Requests: retry after 30" };
      }) as never;
      await markAwaitingMachine(pool, a.chatId);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asks).length, 1);
      assert.equal(tg.sent.filter(asksDestination).length, 1, "the question was attempted after the skipped disagreement");
      assert.equal(await lastPrompt(pool, a), `cfl:${conflict.id}`, "the question rolled back to the disagreement's key, which stays recorded");
      assert.equal(await awaitingOf(pool, a), "machine", "the question is owed");

      failQuestion = false;
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter((s) => s.ok && asksDestination(s)).length, 1, `retried and delivered: ${texts(tg.sent)}`);
      assert.equal(tg.sent.filter(asks).length, 1, "without asking the disagreement again");
    });
  });

  test("round 2 (R6): a required answer RE-RAISED at the boundary, refused for now: un-named, owed, and asked once the backoff passes", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      // It stepped aside after a reply that did not answer it: nothing required is
      // next, but a required answer is missing - the boundary brings it back.
      await deferQuestionForChat(pool, a.chatId, "destination");
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg);
      const reRaise = (p: { text: string }) => p.text.startsWith(en("beforeWeFinish"));
      tg.refuse = { match: reRaise, permanent: false };
      const before = await lastPrompt(pool, a);
      await markAwaitingMachine(pool, a.chatId);

      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(reRaise).length, 1, `the re-raise was attempted: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), before, "un-named");
      assert.equal(await awaitingOf(pool, a), "machine", "still owed");
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asksDestination).length, 1, "not hammered during the backoff");

      tg.refuse = null;
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter((s) => s.ok && asksDestination(s)).length, 1, `asked, once: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), "q:destination");
      assert.equal(await awaitingOf(pool, a), "person");
    });
  });

  test("round 2 (R7d): a send that fails AFTER another speaker put something on screen does not un-name theirs or take the turn back", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      const logs: string[] = [];
      const tg = new RefusingTelegram();
      const deps = stableDeps(pool, tg, logs);
      // While the question is in flight, another speaker's message lands and is
      // recorded; then Telegram refuses the question.
      const original = tg.sendMessage.bind(tg);
      tg.sendMessage = (async (p: Outgoing) => {
        if (!asksDestination(p)) return original(p);
        await recordLastPromptForChat(pool, a.chatId, "optional_offer");
        tg.sent.push({ text: p.text, buttons: [], ok: false });
        return { ok: false as const, error: "Too Many Requests: retry after 30" };
      }) as never;
      await markAwaitingMachine(pool, a.chatId);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
      assert.equal(tg.sent.filter(asksDestination).length, 1);
      assert.equal(await lastPrompt(pool, a), "optional_offer", "theirs stays named");
      assert.equal(await awaitingOf(pool, a), "person", "and the turn is not taken back over it");
      assert.ok(logs.some((l) => l.includes("trip_bot.step_send_failed") && l.includes("SPOKEN_SINCE")), logs.join("\n"));
      await retryFailedSteps(deps, DEFAULT_STRINGS, () => {}, LATER());
      assert.equal(tg.sent.filter(asksDestination).length, 1, "nothing owed to the retry");
    });
  });

  test("recoverStalledInterviews: a recovery Telegram did not take is not recorded as on screen", async () => {
    await withChats(async (pool, a) => {
      await allRequiredBut(pool, a, "destination");
      const tg = new RefusingTelegram();
      const logs: string[] = [];
      tg.refuse = { match: (p) => p.text.startsWith(en("resumed")), permanent: false };
      const before = await lastPrompt(pool, a);
      await openAgentTurn(pool, a.chatId, a.sessionId);
      await markAwaitingMachine(pool, a.chatId);
      await recoverStalledInterviews(stableDeps(pool, tg), DEFAULT_STRINGS, (l) => logs.push(l), 0);
      assert.equal(tg.sent.filter((s) => s.text.startsWith(en("resumed"))).length, 1, `attempted: ${texts(tg.sent)}`);
      assert.equal(await lastPrompt(pool, a), before, "a question nobody received is not on screen");
      assert.ok(logs.some((l) => l.includes("trip_bot.stalled_turn_recovery_failed")), logs.join("\n"));
    });
  });
});
