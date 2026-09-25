/**
 * What a TYPED correction to a list actually STORES (#205, #114 problem 5).
 *
 * `interpret.test.ts` asserts on `accepted.answer`, the merged answer the gate
 * builds. The relay's typed path once wrote `accepted.proposal.value` instead —
 * the model's raw reading, which the prompt asks to carry only what is ADDED —
 * and replaced the stored answer wholesale. Every assertion on `accepted.answer`
 * passed while three of four held stops were lost. So this drives the real burst
 * path with a FAKE model and reads `intake_sessions.answers` back.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { queueInboundMessage } from "../src/interview.js";
import { flushSettledInboundBursts } from "../src/relay/poller.js";
import { setInterpretPath, type ProposedAnswer } from "../src/interpret.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CHAT = "840000001";

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

async function withInterview(fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
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
    const started = await startFromDeepLink(pool, CHAT, enrollment.token);
    assert.equal(started.kind, "started");
    await setInterpretPath(pool, CHAT, true);
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data });

async function hold(pool: pg.Pool, questionId: string, data: unknown) {
  await pool.query(
    `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
      WHERE telegram_chat_id = $1`,
    [CHAT, questionId, JSON.stringify(structured(data))],
  );
}

async function stored(pool: pg.Pool, questionId: string): Promise<any> {
  const r = await pool.query(
    "SELECT answers -> $2 AS a FROM control_plane.intake_sessions WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT 1",
    [CHAT, questionId],
  );
  return r.rows[0]?.a;
}

class Telegram {
  async sendMessage() { return { ok: true as const, messageId: "1" }; }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

/** One typed message; the FAKE model reads it as `proposal`. */
async function say(pool: pg.Pool, text: string, proposal: Omit<ProposedAnswer, "sourceMessageId" | "confidence">) {
  const runner = {
    async run() {
      return {
        ok: true as const,
        value: { proposals: [{ ...proposal, confidence: 0.92, sourceMessageId: "1" }], unclear: [], malformed: 0 },
        attempts: 1,
        ms: 1,
      };
    },
  };
  await queueInboundMessage(pool, CHAT, { text, message_id: id("m") } as never);
  await flushSettledInboundBursts(
    { db: pool, telegram: new Telegram(), connector: { pushInbound: () => true }, modelRunner: runner } as never,
    () => {},
    0,
  );
}

const HELD_STOPS = [{ name: "Tokyo" }, { name: "Hakone" }, { name: "Kyoto" }, { name: "Osaka" }];
const stopsOf = (a: any) => (a.data as { name: string; start?: string }[]);

describe("a typed correction to a list keeps what was held", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("A: a marked return leg is a fifth stop, and the first Tokyo stays undated", async () => {
    await withInterview(async (pool) => {
      await hold(pool, "phases", HELD_STOPS);
      const text = "another three days at the end for Tokyo, 30 September to 3 October";
      await say(pool, text, {
        questionId: "phases",
        value: { kind: "structured", data: [{ name: "Tokyo", start: "2026-09-30", end: "2026-10-03", additional_visit: true }] },
        evidence: text,
      });
      const stops = stopsOf(await stored(pool, "phases"));
      assert.equal(stops.length, 5, JSON.stringify(stops));
      assert.deepEqual(stops.map((s) => s.name).sort(), ["Hakone", "Kyoto", "Osaka", "Tokyo", "Tokyo"]);
      assert.equal(stops.filter((s) => s.name === "Tokyo" && s.start === undefined).length, 1);
      assert.equal(stops.filter((s) => s.name === "Tokyo" && s.start === "2026-09-30").length, 1);
    });
  });

  test("B: an unmarked 'Tokyo, 19-24 September' fills the one Tokyo and keeps the other three", async () => {
    await withInterview(async (pool) => {
      await hold(pool, "phases", HELD_STOPS);
      const text = "Tokyo, 19 to 24 September";
      await say(pool, text, {
        questionId: "phases",
        value: { kind: "structured", data: [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }] },
        evidence: text,
      });
      const stops = stopsOf(await stored(pool, "phases"));
      assert.equal(stops.length, 4, JSON.stringify(stops));
      assert.equal(stops.find((s) => s.name === "Tokyo")?.start, "2026-09-19");
    });
  });

  test("C: 'my mother is joining' adds a traveller and keeps the held ones", async () => {
    await withInterview(async (pool) => {
      await hold(pool, "travelers", [{ name: "Avi Cohen" }, { name: "Ronit Cohen" }]);
      const text = "Actually my mother Ruth Cohen, 70, is joining us too";
      await say(pool, text, {
        questionId: "travelers",
        value: { kind: "structured", data: [{ name: "Ruth Cohen", age: 70 }] },
        evidence: text,
      });
      const names = stopsOf(await stored(pool, "travelers")).map((p) => p.name);
      assert.deepEqual(names, ["Avi Cohen", "Ronit Cohen", "Ruth Cohen"]);
    });
  });

  test("D: the marker is never stored — not where it steers the merge, not where it must be ignored", async () => {
    await withInterview(async (pool) => {
      await hold(pool, "phases", HELD_STOPS);
      const text = "another three days at the end for Tokyo, 30 September to 3 October";
      await say(pool, text, {
        questionId: "phases",
        value: { kind: "structured", data: [{ name: "Tokyo", start: "2026-09-30", end: "2026-10-03", additional_visit: true }] },
        evidence: text,
      });
      assert.doesNotMatch(JSON.stringify(await stored(pool, "phases")), /additional_visit/);

      // A spurious marker on a question that is not stops must neither duplicate
      // the entry nor be stored.
      await hold(pool, "travelers", [{ name: "Avi Cohen" }]);
      const t2 = "Avi Cohen, 41, again";
      await say(pool, t2, {
        questionId: "travelers",
        value: { kind: "structured", data: [{ name: "Avi Cohen", age: 41, additional_visit: true }] },
        evidence: t2,
      });
      const people = await stored(pool, "travelers");
      assert.doesNotMatch(JSON.stringify(people), /additional_visit/);
      assert.equal(stopsOf(people).filter((p) => p.name === "Avi Cohen").length, 1, "one Avi, not two");
    });
  });
});
