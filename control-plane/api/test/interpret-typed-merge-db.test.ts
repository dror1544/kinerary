/**
 * What a typed correction to a list OTHER than the stops and the travellers
 * stores (#205). Stops and travellers are a confirmed change now
 * (typed-changes-flow-db.test.ts); the other structured lists — the bookings —
 * are still merged into what is held, and this reads `intake_sessions.answers`
 * back because asserting on `accepted.answer` once passed while the stored answer
 * was wrong: the typed writer replaced the answer with only what was ADDED.
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
import { setInterpretPath } from "../src/interpret.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const CHAT = "840000001";

async function withInterview(fn: (pool: pg.Pool, sessionId: string) => Promise<void>): Promise<void> {
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
    await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')", [id("memb"), tripId, userId]);
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(enrollment.ok);
    const started = await startFromDeepLink(pool, CHAT, enrollment.token);
    assert.equal(started.kind, "started");
    await setInterpretPath(pool, CHAT, true);
    await fn(pool, started.kind === "started" ? started.sessionId : "");
  } finally {
    await pool.end();
  }
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

describe("a typed correction to the bookings keeps what was held", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("a booking added by typing joins the held ones instead of replacing them", async () => {
    await withInterview(async (pool, sessionId) => {
      const held = [{ type: "hotel", name: "Gion Inn", date: "2026-09-25", confirmation: "GI-77" }];
      await pool.query(
        "UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object('travel_anchors', $2::jsonb) WHERE id = $1",
        [sessionId, JSON.stringify({ kind: "structured", schema_version: 3, data: held })],
      );
      const text = "also we booked flight LY381 on 19 September, confirmation XR7T2Q";
      const runner = { async run() {
        return { ok: true as const, attempts: 1, ms: 1, value: { unclear: [], malformed: 0, proposals: [{
          questionId: "travel_anchors", confidence: 0.95, evidence: text, sourceMessageId: "1",
          value: { kind: "structured", data: [{ type: "flight", name: "LY381", date: "2026-09-19", confirmation: "XR7T2Q" }] },
        }] } };
      } };
      await queueInboundMessage(pool, CHAT, { text, message_id: id("m") } as never);
      await flushSettledInboundBursts({ db: pool, telegram: new Telegram(), connector: { pushInbound: () => true }, modelRunner: runner } as never, () => {}, 0);
      const stored = (await pool.query("SELECT answers->'travel_anchors'->'data' AS d FROM control_plane.intake_sessions WHERE id = $1", [sessionId])).rows[0].d as { name: string }[];
      assert.deepEqual(stored.map((b) => b.name).sort(), ["Gion Inn", "LY381"]);
    });
  });
});
