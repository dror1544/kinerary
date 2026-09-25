/**
 * The assistant-event table and its writer, against Postgres (#177).
 *
 *   - the table's columns ARE the contract's allow-list — adding one fails here;
 *   - the writer is idempotent on event_id and refuses a trip that does not exist;
 *   - the table itself refuses what the contract refuses, as a second line;
 *   - the purge deletes only what is older than its cutoff.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import {
  CHANNEL_TYPES,
  EVENT_FIELDS,
  EVENT_RULES,
  EVENT_TYPES,
  LENGTH_BUCKETS,
  MEDIA_KINDS,
  REQUESTER_ROLES,
  TRIGGER_TYPES,
  validateAssistantEvent,
  type AssistantEvent,
} from "../src/analytics/contract.js";
import { purgeExpiredEvents, rollupAssistantEvents, writeAssistantEvents } from "../src/analytics/store.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/**
 * The checked-in column list. Deliberately a literal, not EVENT_FIELDS: a
 * column added to the migration AND the contract in one careless edit must
 * still trip a test that a reviewer has to change by hand.
 */
const ALLOWED_COLUMNS = [
  "channel_type",
  "event_id",
  "event_type",
  "media_kind",
  "message_length_bucket",
  "metadata",
  "occurred_at",
  "outcome",
  "requester_role",
  "response_latency_ms",
  "source_service",
  "trigger_type",
  "trip_id",
  "turn_id",
];

async function withDb(fn: (pool: pg.Pool, tripId: string) => Promise<void>): Promise<void> {
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
    const tripId = `trip_${randomBytes(16).toString("hex")}`;
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
      tripId, tripId.replace(/_/g, "-"),
    ]);
    await fn(pool, tripId);
  } finally {
    await pool.end();
  }
}

function event(tripId: string, overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    event_id: randomUUID(),
    trip_id: tripId,
    occurred_at: new Date().toISOString(),
    source_service: "relay",
    event_type: "ignored_not_addressed",
    turn_id: null,
    channel_type: "group",
    trigger_type: "not_addressed",
    requester_role: "unknown",
    outcome: "ignored_not_addressed",
    response_latency_ms: null,
    message_length_bucket: "1_40",
    media_kind: "none",
    metadata: {},
    ...overrides,
  };
}

describe("control_plane.assistant_events", () => {
  test("its columns are exactly the checked-in allow-list, and the contract's", { skip: SKIP }, async () => {
    await withDb(async (pool) => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'control_plane' AND table_name = 'assistant_events' ORDER BY column_name`,
      );
      const columns = rows.map((r) => r.column_name);
      assert.deepEqual(columns, ALLOWED_COLUMNS);
      assert.deepEqual(columns, [...EVENT_FIELDS].sort());
    });
  });

  test("its indexes are the primary key on event_id and (trip_id, occurred_at)", { skip: SKIP }, async () => {
    await withDb(async (pool) => {
      const { rows } = await pool.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'control_plane' AND tablename = 'assistant_events' ORDER BY indexname",
      );
      const defs = rows.map((r) => r.indexdef.replace(/^.* USING btree /, ""));
      assert.deepEqual(defs.sort(), ["(event_id)", "(trip_id, occurred_at)"]);
    });
  });

  test("the same event written twice is stored once", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      const one = event(tripId);
      const first = await writeAssistantEvents(pool, [one]);
      const again = await writeAssistantEvents(pool, [one, one]);
      assert.deepEqual(first, { inserted: 1, duplicates: 0, rejected: [] });
      assert.deepEqual(again, { inserted: 0, duplicates: 2, rejected: [] });
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
      assert.equal(rows[0].n, 1);
    });
  });

  test("a trip_id that is not a trip is refused, and the rest of the batch still lands", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      const result = await writeAssistantEvents(pool, [
        event(tripId),
        event(`trip_${"f".repeat(32)}`),
        event(tripId, { event_type: "message_received" as never }),
        { ...event(tripId), chat_id: "-1009876543210" },
      ]);
      assert.equal(result.inserted, 1);
      assert.deepEqual(result.rejected, [
        { index: 1, reason: "UNKNOWN_TRIP" },
        { index: 2, reason: "BAD:event_type" },
        { index: 3, reason: "UNKNOWN_FIELD" },
      ]);
    });
  });

  test("every value in the contract's vocabulary is one the table accepts", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      const batch: AssistantEvent[] = [];
      for (const type of EVENT_TYPES) {
        for (const outcome of EVENT_RULES[type].outcomes) {
          batch.push(event(tripId, { event_type: type, outcome, turn_id: randomUUID() }));
        }
      }
      CHANNEL_TYPES.forEach((v) => batch.push(event(tripId, { channel_type: v })));
      TRIGGER_TYPES.forEach((v) => batch.push(event(tripId, { trigger_type: v })));
      REQUESTER_ROLES.forEach((v) => batch.push(event(tripId, { requester_role: v })));
      LENGTH_BUCKETS.forEach((v) => batch.push(event(tripId, { message_length_bucket: v })));
      MEDIA_KINDS.forEach((v) => batch.push(event(tripId, { media_kind: v })));
      batch.push(event(tripId, { metadata: { attachments_joined: 2, documents: 3, document_held: true } }));
      const result = await writeAssistantEvents(pool, batch);
      assert.deepEqual(result, { inserted: batch.length, duplicates: 0, rejected: [] });
    });
  });

  test("the table refuses what the contract refuses, even written around the writer — except a null trip_id, which ON DELETE SET NULL needs", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      // Every case is a full, otherwise-valid row with ONE thing wrong, so a
      // refusal can only be that one thing — and each is first shown to be
      // refused by the contract too, so the two lines are compared, not assumed.
      const base = (overrides: Partial<AssistantEvent>): AssistantEvent => event(tripId, {
        event_type: "request_forwarded",
        outcome: "dispatched",
        turn_id: randomUUID(),
        trigger_type: "name",
        metadata: { documents: 0, attachments_joined: 0 },
        ...overrides,
      });
      const direct = (row: AssistantEvent) => pool.query(
        `INSERT INTO control_plane.assistant_events (${EVENT_FIELDS.join(", ")})
         VALUES (${EVENT_FIELDS.map((_, i) => `$${i + 1}`).join(", ")})`,
        EVENT_FIELDS.map((f) => (f === "metadata" ? JSON.stringify(row.metadata) : row[f])),
      );

      await direct(base({})); // the control: a valid row goes in
      const cases: [string, Partial<Record<keyof AssistantEvent, unknown>>][] = [
        ["unknown channel", { channel_type: "participant_dm" }],
        ["unknown role", { requester_role: "admin" }],
        ["`answered`", { event_type: "reply_sent", outcome: "answered" }],
        ["a text key in metadata", { metadata: { filename: "voucher.pdf" } }],
        ["a string count", { metadata: { documents: "two" } }],
        ["a negative, chat-id-sized count", { metadata: { documents: -1001234567890 } }],
        ["a huge count", { metadata: { attachments_joined: 987654321 } }],
        ["a fractional count", { metadata: { documents: 1.5 } }],
        ["a count above 20", { metadata: { documents: 21 } }],
        ["a non-boolean flag", { metadata: { document_held: "yes" } }],
        ["metadata that is not an object", { metadata: [1, 2] }],
        ["an outcome of another type", { event_type: "reply_sent", outcome: "dispatched" }],
        ["a request with no channel", { channel_type: null }],
        ["a request with no turn", { turn_id: null }],
        ["a request with no role", { requester_role: null }],
        ["an unaddressed message with no trigger", { event_type: "ignored_not_addressed", outcome: "ignored_not_addressed", turn_id: null, trigger_type: null }],
        ["a lost turn with no media class", { event_type: "turn_lost", outcome: "lost_gateway_unavailable", media_kind: null }],
        ["a reply with no length bucket", { event_type: "reply_sent", outcome: "reply_delivered", message_length_bucket: null }],
        ["a relay tool outcome with no turn", { event_type: "relay_tool_completed", outcome: "failed_tool", turn_id: null }],
      ];
      for (const [label, overrides] of cases) {
        const row = base(overrides as Partial<AssistantEvent>);
        assert.equal(validateAssistantEvent(row).ok, false, `${label}: the contract refuses it`);
        await assert.rejects(direct(row), /check constraint/, `${label}: and so does the table`);
      }

      // The one deliberate difference: the contract requires trip_id at write
      // time, the table cannot, or deleting a trip would fail on its history.
      const orphan = base({ trip_id: null });
      assert.equal(validateAssistantEvent(orphan).ok, false);
      await direct(orphan);
    });
  });

  test("the writer refuses a trip that does not exist per row, in the same statement as the insert", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      const gone = `trip_${randomBytes(16).toString("hex")}`;
      await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [gone, gone.replace(/_/g, "-")]);
      await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [gone]);
      const result = await writeAssistantEvents(pool, [event(gone), event(tripId), event(gone)]);
      assert.deepEqual(result, {
        inserted: 1,
        duplicates: 0,
        rejected: [{ index: 0, reason: "UNKNOWN_TRIP" }, { index: 2, reason: "UNKNOWN_TRIP" }],
      });
    });
  });

  test("deleting a trip keeps its events, with the trip forgotten", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      await writeAssistantEvents(pool, [event(tripId)]);
      await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
      const { rows } = await pool.query("SELECT trip_id FROM control_plane.assistant_events");
      assert.deepEqual(rows, [{ trip_id: null }]);
    });
  });
});

describe("rollupAssistantEvents at a window's edge", () => {
  test("asked at 23:58, answered at 00:03: answered, when the caller asks for just that day", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      const turn = randomUUID();
      // 23:58 and 00:03 in Tokyo.
      const asked = "2026-09-18T14:58:00.000Z";
      const answered = "2026-09-18T15:03:00.000Z";
      await writeAssistantEvents(pool, [
        event(tripId, { event_type: "request_forwarded", outcome: "dispatched", turn_id: turn, trigger_type: "name", occurred_at: asked }),
        event(tripId, {
          event_type: "reply_sent", outcome: "reply_delivered", turn_id: turn, trigger_type: "name",
          occurred_at: answered, response_latency_ms: 300_000, media_kind: null,
        }),
      ]);
      const day = { tripId, timeZone: "Asia/Tokyo", from: new Date("2026-09-17T15:00:00Z"), to: new Date("2026-09-18T15:00:00Z") };
      const [only, ...rest] = await rollupAssistantEvents(pool, day);
      assert.equal(rest.length, 0);
      assert.equal(only!.local_day, "2026-09-18");
      assert.deepEqual(only!.turns, { reply_delivered_substantive_outcome_unknown: 1, unanswered: 0, lost: 0 });
      assert.deepEqual(only!.reply_latency_ms, [300_000]);
      assert.equal(only!.replies.delivered, 0, "the reply itself is the NEXT day's message");

      const [next] = await rollupAssistantEvents(pool, { ...day, from: day.to, to: new Date("2026-09-19T15:00:00Z") });
      assert.equal(next!.local_day, "2026-09-19");
      assert.equal(next!.replies.delivered, 1);
      assert.equal(next!.requests_forwarded, 0, "and the turn is not counted twice");
    });
  });
});

describe("purgeExpiredEvents", () => {
  test("deletes only what is older than the cutoff", { skip: SKIP }, async () => {
    await withDb(async (pool, tripId) => {
      const day = 24 * 3600 * 1000;
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
      const old = event(tripId, { occurred_at: at(91) });
      const edge = event(tripId, { occurred_at: at(89) });
      const fresh = event(tripId, { occurred_at: at(1) });
      await writeAssistantEvents(pool, [old, edge, fresh]);

      assert.equal(await purgeExpiredEvents(pool), 1, "the default is 90 days");
      const left = await pool.query<{ event_id: string }>("SELECT event_id::text FROM control_plane.assistant_events ORDER BY occurred_at");
      assert.deepEqual(left.rows.map((r) => r.event_id), [edge.event_id, fresh.event_id]);

      assert.equal(await purgeExpiredEvents(pool, 30), 1);
      assert.equal(await purgeExpiredEvents(pool, 30), 0, "running it again finds nothing more");
    });
  });

  test("refuses a cutoff that would delete everything", { skip: SKIP }, async () => {
    await withDb(async (pool) => {
      await assert.rejects(purgeExpiredEvents(pool, 0), RangeError);
      await assert.rejects(purgeExpiredEvents(pool, -5), RangeError);
      await assert.rejects(purgeExpiredEvents(pool, 1.5), RangeError);
    });
  });
});
