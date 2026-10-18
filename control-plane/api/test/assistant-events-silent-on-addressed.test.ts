/**
 * "Silent on a message that named the assistant" as a defect count (staging run
 * 2026-10-17, A3). The connector drops the sentinel either way; what differs is
 * that a drop on a turn that named the assistant is recorded as
 * metadata.silent_on_addressed on its reply_suppressed row, and the daily report
 * shows how many there were. Part 1 needs no database; part 2 does (migration
 * 20261017120000, the rollup, the report).
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { validateAssistantEvent, type AssistantEvent } from "../src/analytics/contract.js";
import { RelayAssistantEvents, type AssistantEventSink } from "../src/analytics/emitter.js";
import type { InboundFacts } from "../src/analytics/relay-facts.js";
import { rollupAssistantEvents, writeAssistantEvents } from "../src/analytics/store.js";
import { renderDailyReport } from "../src/analytics/report.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const TRIP = "trip_0123456789abcdef0123456789abcdef";
const CHAT = "-1001234567890";

function recordingSink(): AssistantEventSink & { all: AssistantEvent[] } {
  const all: AssistantEvent[] = [];
  return { all, async write(events) { all.push(...events); return { inserted: events.length, duplicates: 0, rejected: [] }; } };
}

const facts = (over: Partial<InboundFacts> = {}): InboundFacts => ({
  tripId: TRIP, channelType: "group", triggerType: "mention", requesterRole: "unknown", mediaKind: "none", lengthBucket: "41_160", ...over,
});

describe("the emitter records silence on an addressed turn", () => {
  test("a suppressed reply flagged silentOnAddressed carries the boolean; unflagged and non-suppressed ones carry nothing", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.handedOff(CHAT, facts(), true, "41");
    events.replySent(CHAT, "suppressed", 25, "41", { silentOnAddressed: true });
    events.handedOff(CHAT, facts({ triggerType: "conversation_window" }), true, "42");
    events.replySent(CHAT, "suppressed", 25, "42");
    events.handedOff(CHAT, facts(), true, "43");
    events.replySent(CHAT, "delivered", 25, "43", { silentOnAddressed: true });
    await events.flush();
    const replies = sink.all.filter((e) => e.event_type === "reply_sent");
    assert.deepEqual(replies.map((r) => [r.outcome, r.metadata]), [
      ["reply_suppressed", { silent_on_addressed: true }],
      ["reply_suppressed", {}],
      ["reply_delivered", {}],
    ]);
    assert.equal(events.stats.rejected, 0);
    assert.ok(replies.every((r) => validateAssistantEvent(r).ok), "the contract admits it");
  });

  test("the contract admits only a boolean for the key", () => {
    const base = {
      event_id: randomUUID(), trip_id: TRIP, occurred_at: "2026-10-17T10:00:00.000Z", source_service: "relay",
      event_type: "reply_sent", outcome: "reply_suppressed", message_length_bucket: "1_40",
    };
    assert.equal(validateAssistantEvent({ ...base, metadata: { silent_on_addressed: true } }).ok, true);
    assert.equal(validateAssistantEvent({ ...base, metadata: { silent_on_addressed: "yes" } }).ok, false);
  });
});

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function withDb(fn: (pool: pg.Pool, tripId: string) => Promise<void>): Promise<void> {
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
    const tripId = `trip_${randomBytes(16).toString("hex")}`;
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await fn(pool, tripId);
  } finally {
    await pool.end();
  }
}

let tick = 0;
function reply(tripId: string, outcome: AssistantEvent["outcome"], metadata: AssistantEvent["metadata"]): AssistantEvent {
  tick += 1;
  return {
    event_id: randomUUID(), trip_id: tripId, occurred_at: `2026-10-17T10:00:${String(tick % 60).padStart(2, "0")}.000Z`,
    source_service: "relay", event_type: "reply_sent", turn_id: null, channel_type: "group", trigger_type: "mention",
    requester_role: "unknown", outcome, response_latency_ms: null, message_length_bucket: "1_40", media_kind: null,
    metadata, tool_name: null,
  };
}

describe("the table, the rollup and the report", { skip: SKIP }, () => {
  test("the table takes the boolean and refuses anything else; the rollup counts it; the report shows it", async () => {
    await withDb(async (pool, tripId) => {
      const events = [
        reply(tripId, "reply_suppressed", { silent_on_addressed: true }),
        reply(tripId, "reply_suppressed", { silent_on_addressed: true }),
        reply(tripId, "reply_suppressed", {}),
        reply(tripId, "reply_delivered", {}),
      ];
      assert.deepEqual((await writeAssistantEvents(pool, events)).rejected, []);
      await assert.rejects(
        pool.query(
          `INSERT INTO control_plane.assistant_events
             (event_id, trip_id, occurred_at, source_service, event_type, outcome, message_length_bucket, metadata)
           VALUES ($1, $2, now(), 'relay', 'reply_sent', 'reply_suppressed', '1_40', '{"silent_on_addressed": "yes"}')`,
          [randomUUID(), tripId],
        ),
        /violates check constraint/,
      );

      const [day] = await rollupAssistantEvents(pool, { tripId, timeZone: "UTC" });
      assert.equal(day!.replies.suppressed, 3);
      assert.equal(day!.replies.silent_on_addressed, 2, "only the flagged ones are the defect");

      const { json } = renderDailyReport(day!);
      const usage = json.sections.find((s) => s.title === "Usage")!;
      const line = usage.lines.find((l) => /Silent on a message that named/.test(l.label))!;
      assert.equal(line.value, "2");
    });
  });
});
