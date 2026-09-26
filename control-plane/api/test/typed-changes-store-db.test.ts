/**
 * The waiting draft and its atomic apply (#206, slice 2). Inert: nothing in the
 * router calls these yet, so the tests drive the store and the apply function
 * directly against a real database.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { CONFIRM_CALLBACK_DATA, startFromDeepLink } from "../src/chat-router.js";
import { applyPendingChangeForChat, confirmIntakeForChat, getSessionForChat } from "../src/interview.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision } from "../src/relay/poller.js";
import { setInterpretPath } from "../src/interpret.js";
import { cancelDraft, getDraft, getOpenDraft, proposeChange, rebuildDraft } from "../src/typed-changes-store.js";
import type { Op } from "../src/typed-changes.js";
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
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    await fn(pool, await seedChat(pool, "860000001"), await seedChat(pool, "860000002"));
  } finally {
    await pool.end();
  }
}

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data });
async function hold(pool: pg.Pool, chat: Chat, questionId: string, data: unknown) {
  await pool.query(
    `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`,
    [chat.sessionId, questionId, JSON.stringify(structured(data))],
  );
}
async function stored(pool: pg.Pool, chat: Chat, questionId: string): Promise<any[]> {
  const r = await pool.query("SELECT answers -> $2 AS a FROM control_plane.intake_sessions WHERE id = $1", [chat.sessionId, questionId]);
  return (r.rows[0]?.a?.data ?? []) as any[];
}
const stop = (name: string, start?: string, end?: string) => ({ name, ...(start ? { start } : {}), ...(end ? { end } : {}) });
const tokyoEnd25: Op[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }];
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

async function propose(pool: pg.Pool, chat: Chat, ops: readonly Op[], interpretationId = id("interp")) {
  const r = await proposeChange(pool, { sessionId: chat.sessionId, tripId: chat.tripId, interpretationId, ops });
  assert.notEqual(r.kind, "no_session");
  return r as Extract<typeof r, { draft: unknown }>;
}

describe("the waiting draft", opts, () => {
  test("proposing stores the mutation and the preview and writes NOTHING to the answers", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const { kind, draft } = await propose(pool, a, tokyoEnd25);
      assert.equal(kind, "created");
      assert.equal(draft.status, "pending");
      assert.deepEqual(Object.keys(draft.base), ["phases"]);
      assert.deepEqual((draft.result.phases as any).data[0], stop("Tokyo", "2026-05-19", "2026-05-25"));
      assert.ok(draft.preview.some((l) => l.key === "preview.field"));
      assert.deepEqual((await stored(pool, a, "phases"))[0], stop("Tokyo", "2026-05-19", "2026-05-24"));
    });
  });

  test("a change that cannot be confirmed is still kept: it carries what to ask", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
      const { draft } = await propose(pool, a, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20", end: "2026-05-25" } }]);
      assert.deepEqual(draft.blocked.map((l) => l.key), ["blocked.overlap"]);
      assert.deepEqual(draft.result, {});
      const applied = await applyPendingChangeForChat(pool, a.chatId, draft.id);
      assert.deepEqual(applied, { ok: false, reason: "BLOCKED" });
    });
  });

  test("an interpretation seen twice is one draft — including a replay after the draft was applied", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const once = await propose(pool, a, tokyoEnd25, "interp_same");
      const again = await propose(pool, a, tokyoEnd25, "interp_same");
      assert.equal(again.kind, "replay");
      assert.equal(again.draft.id, once.draft.id);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_pending_changes")).rows[0].n, 1);
      assert.equal((await applyPendingChangeForChat(pool, a.chatId, once.draft.id)).ok, true);
      const late = await propose(pool, a, tokyoEnd25, "interp_same");
      assert.equal(late.kind, "replay");
      assert.equal(await getOpenDraft(pool, a.sessionId), null, "the applied draft is not raised from the dead");
    });
  });

  test("a follow-up MERGES into the open draft: other targets accumulate, the same target replaces", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen", age: 41 }]);
      await propose(pool, a, [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]);
      const second = await propose(pool, a, [{ op: "update_traveller", target: { name: "Avi" }, fields: { age: 40 } }]);
      assert.equal(second.kind, "merged");
      assert.deepEqual((second.draft.result.travelers as any).data.map((p: any) => p.age), [71, 40]);
      const third = await propose(pool, a, [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 72 } }]);
      assert.deepEqual((third.draft.result.travelers as any).data.map((p: any) => p.age), [72, 40]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_pending_changes")).rows[0].n, 1);
      assert.equal(third.draft.interpretationIds.length, 3);
    });
  });

  test("only one draft can be open per session, in the database itself", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo")]);
      const { draft } = await propose(pool, a, [{ op: "add_stop", fields: { name: "Nara" } }]);
      await assert.rejects(
        pool.query(
          "INSERT INTO control_plane.intake_pending_changes(id, session_id, trip_id) VALUES ($1, $2, $3)",
          [id("pchg"), a.sessionId, a.tripId],
        ),
        (e: { code?: string }) => e.code === "23505",
      );
      await cancelDraft(pool, { draftId: draft.id, sessionId: a.sessionId, by: "organizer" });
      await pool.query("INSERT INTO control_plane.intake_pending_changes(id, session_id, trip_id) VALUES ($1, $2, $3)", [id("pchg"), a.sessionId, a.tripId]);
    });
  });

  test("deleting the session takes its drafts with it", async () => {
    await withChats(async (pool, a, b) => {
      await hold(pool, a, "phases", [stop("Tokyo")]);
      await hold(pool, b, "phases", [stop("Tokyo")]);
      await propose(pool, a, [{ op: "add_stop", fields: { name: "Nara" } }]);
      await propose(pool, b, [{ op: "add_stop", fields: { name: "Nara" } }]);
      await pool.query("DELETE FROM control_plane.intake_sessions WHERE id = $1", [a.sessionId]);
      const left = await pool.query("SELECT session_id FROM control_plane.intake_pending_changes");
      assert.deepEqual(left.rows.map((r) => r.session_id), [b.sessionId]);
    });
  });

  test("cancel ends the draft; it cannot be applied afterwards", async () => {
    await withChats(async (pool, a, b) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const { draft } = await propose(pool, a, tokyoEnd25);
      assert.equal(await cancelDraft(pool, { draftId: draft.id, sessionId: b.sessionId, by: "organizer" }), false, "another session cannot cancel it");
      assert.equal(await cancelDraft(pool, { draftId: draft.id, sessionId: a.sessionId, by: "organizer" }), true);
      assert.equal((await getDraft(pool, draft.id))?.status, "cancelled");
      assert.deepEqual(await applyPendingChangeForChat(pool, a.chatId, draft.id), { ok: false, reason: "NOT_PENDING" });
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
    });
  });
});

describe("applying the draft: one transaction, compare-and-swap from base to result", opts, () => {
  test("writes exactly the stored result; a second tap says so and writes nothing", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const { draft } = await propose(pool, a, tokyoEnd25);
      const first = await applyPendingChangeForChat(pool, a.chatId, draft.id);
      assert.equal(first.ok, true);
      assert.deepEqual(await stored(pool, a, "phases"), (draft.result.phases as any).data);
      const row = (await pool.query("SELECT status, resolved_by FROM control_plane.intake_pending_changes WHERE id = $1", [draft.id])).rows[0];
      assert.deepEqual(row, { status: "applied", resolved_by: "organizer" });
      await pool.query("UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object('phases', $2::jsonb) WHERE id = $1", [a.sessionId, JSON.stringify(structured([stop("Osaka")]))]);
      assert.deepEqual(await applyPendingChangeForChat(pool, a.chatId, draft.id), { ok: false, reason: "ALREADY_APPLIED" });
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Osaka")], "the second tap wrote nothing");
    });
  });

  test("a stale base applies NOTHING; the draft is rebuilt against what is held and applies then", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-05-30")]);
      const { draft } = await propose(pool, a, tokyoEnd25);
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-27", "2026-06-02")]);
      const refused = await applyPendingChangeForChat(pool, a.chatId, draft.id);
      assert.deepEqual(refused, { ok: false, reason: "STALE", detail: "phases" });
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
      assert.equal((await getDraft(pool, draft.id))?.status, "pending", "still waiting, not lost");
      const rebuilt = await rebuildDraft(pool, { draftId: draft.id, sessionId: a.sessionId });
      assert.deepEqual((rebuilt!.result.phases as any).data[1], stop("Kyoto", "2026-05-27", "2026-06-02"), "recomputed from what is held now");
      assert.equal((await applyPendingChangeForChat(pool, a.chatId, draft.id)).ok, true);
      assert.deepEqual(await stored(pool, a, "phases"), [stop("Tokyo", "2026-05-19", "2026-05-25"), stop("Kyoto", "2026-05-27", "2026-06-02")]);
    });
  });

  test("a change touching two questions is applied together or not at all", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      await hold(pool, a, "travelers", [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen" }]);
      const { draft } = await propose(pool, a, [
        ...tokyoEnd25,
        { op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } },
      ]);
      assert.deepEqual(Object.keys(draft.result).sort(), ["phases", "travelers"]);
      // Corrupt one half of the stored result: the whole apply must refuse.
      await pool.query(
        "UPDATE control_plane.intake_pending_changes SET result = jsonb_set(result, '{travelers,data}', '[]'::jsonb) WHERE id = $1",
        [draft.id],
      );
      const refused = await applyPendingChangeForChat(pool, a.chatId, draft.id);
      assert.equal(refused.ok, false);
      assert.equal((refused as { reason: string }).reason, "INVALID");
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24", "the valid half was not written either");
      // And the uncorrupted change lands both.
      await pool.query("UPDATE control_plane.intake_pending_changes SET result = $2::jsonb WHERE id = $1", [draft.id, JSON.stringify(draft.result)]);
      assert.equal((await applyPendingChangeForChat(pool, a.chatId, draft.id)).ok, true);
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-25");
      assert.equal((await stored(pool, a, "travelers"))[0].age, 71);
    });
  });

  test("another session's chat cannot apply this draft, and an unknown id is not found", async () => {
    await withChats(async (pool, a, b) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const { draft } = await propose(pool, a, tokyoEnd25);
      assert.deepEqual(await applyPendingChangeForChat(pool, b.chatId, draft.id), { ok: false, reason: "WRONG_SESSION" });
      assert.deepEqual(await applyPendingChangeForChat(pool, a.chatId, "pchg_doesnotexist0000"), { ok: false, reason: "NOT_FOUND" });
      assert.deepEqual(await applyPendingChangeForChat(pool, "899999999", draft.id), { ok: false, reason: "NOT_FOUND" });
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
    });
  });

  test("the model is not involved: apply takes a database, a chat, a draft id and the digest of what was confirmed, and nothing else", async () => {
    assert.equal(applyPendingChangeForChat.length, 4);
  });
});

describe("the end-of-interview Confirm is blocked while a draft is open", opts, () => {
  test("PENDING_CHANGE, checked before anything else, and gone once the draft is cancelled", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const { draft } = await propose(pool, a, tokyoEnd25);
      const blocked = await confirmIntakeForChat(pool, a.chatId);
      assert.equal(blocked.ok, false);
      assert.equal((blocked as { reason: string }).reason, "PENDING_CHANGE");
      await cancelDraft(pool, { draftId: draft.id, sessionId: a.sessionId, by: "organizer" });
      const after = await confirmIntakeForChat(pool, a.chatId);
      assert.equal((after as { reason: string }).reason, "NOT_ALL_REQUIRED_ANSWERED", "the block was the draft, nothing else");
    });
  });

  test("the Confirm button answers in the interview's own language, English and Hebrew", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      await propose(pool, a, tokyoEnd25);
      for (const language of ["en", "he"] as const) {
        await pool.query("UPDATE control_plane.intake_sessions SET language = $2 WHERE id = $1", [a.sessionId, language]);
        const sent: string[] = [];
        const telegram = {
          async sendMessage(p: { text: string }) { sent.push(p.text); return { ok: true as const, messageId: "1" }; },
          async answerCallbackQuery(p: { text?: string }) { if (p.text) sent.push(`ack:${p.text}`); },
          async editMessageText() { return { ok: true as const }; },
          async sendChatAction() {},
        };
        await applyDecision(
          { kind: "interview_callback", chatId: a.chatId, callbackQueryId: `cq-${language}`, data: CONFIRM_CALLBACK_DATA, sessionId: a.sessionId } as never,
          { db: pool, telegram, connector: { pushInbound: () => true }, log: () => {} } as never,
        );
        assert.ok(sent.includes(uiString("changePendingBlocksConfirm", language)), `${language}: ${JSON.stringify(sent)}`);
        assert.ok(!sent.some((m) => m.includes("Something went wrong")), "not the generic failure");
      }
      assert.notEqual(uiString("changePendingBlocksConfirm", "en"), uiString("changePendingBlocksConfirm", "he"));
      assert.notEqual(uiString("changePendingBlocksConfirm", "en"), "changePendingBlocksConfirm", "the key exists in English");
      assert.notEqual(uiString("changePendingBlocksConfirm", "he"), uiString("changePendingBlocksConfirm", "en"), "and in Hebrew");
    });
  });

  test("a confirmed session is reported, not applied to", async () => {
    await withChats(async (pool, a) => {
      await hold(pool, a, "phases", [stop("Tokyo", "2026-05-19", "2026-05-24")]);
      const { draft } = await propose(pool, a, tokyoEnd25);
      await pool.query("UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE id = $1", [a.sessionId]);
      const r = await applyPendingChangeForChat(pool, a.chatId, draft.id);
      assert.equal(r.ok, false);
      assert.ok(["NOT_FOUND", "SESSION_CONFIRMED"].includes((r as { reason: string }).reason));
      assert.equal((await stored(pool, a, "phases"))[0].end, "2026-05-24");
    });
  });
});

void getSessionForChat;
