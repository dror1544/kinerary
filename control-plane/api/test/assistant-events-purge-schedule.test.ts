/**
 * The retention purge's schedule (#186): `purgeExpiredEvents` runs once
 * shortly after the relay starts and then daily — and only when assistant
 * events are on. Unset, nothing is scheduled at all.
 *
 * The schedule takes an injectable scheduler, so nothing here sleeps: a fake
 * records each timer and the test fires it by hand.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AssistantEvent } from "../src/analytics/contract.js";
import {
  PURGE_INTERVAL_MS,
  PURGE_START_DELAY_MS,
  startAssistantEventsPurge,
  type PurgeScheduler,
} from "../src/analytics/purge-schedule.js";
import { DEFAULT_RETENTION_DAYS, writeAssistantEvents } from "../src/analytics/store.js";
import { applyMigrations } from "../src/migrations.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

interface FakeTimer {
  kind: "timeout" | "interval";
  ms: number;
  fn: () => void;
  cleared: boolean;
  unrefed: boolean;
}

function fakeScheduler(): { scheduler: PurgeScheduler; timers: FakeTimer[]; live: () => FakeTimer[] } {
  const timers: FakeTimer[] = [];
  const make = (kind: FakeTimer["kind"]) => (fn: () => void, ms: number) => {
    const timer: FakeTimer = { kind, ms, fn, cleared: false, unrefed: false };
    timers.push(timer);
    return Object.assign(timer, { unref() { timer.unrefed = true; return timer; } });
  };
  const clear = (handle: unknown) => { (handle as FakeTimer).cleared = true; };
  return {
    scheduler: {
      setTimeout: make("timeout") as PurgeScheduler["setTimeout"],
      setInterval: make("interval") as PurgeScheduler["setInterval"],
      clearTimeout: clear,
      clearInterval: clear,
    },
    timers,
    live: () => timers.filter((t) => !t.cleared),
  };
}

const ON = { ASSISTANT_EVENTS_ENABLED: "1" } as NodeJS.ProcessEnv;
const fakeDb = {} as pg.Pool;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const lines = () => {
  const out: string[] = [];
  return { out, log: (line: string) => { out.push(line); } };
};

describe("assistant-events purge schedule", () => {
  test("flag unset, 0, or a typo: no timer is created and purge is never called", async () => {
    for (const env of [{}, { ASSISTANT_EVENTS_ENABLED: "0" }, { ASSISTANT_EVENTS_ENABLED: "true" }, { ASSISTANT_EVENTS_ENABLED: "" }]) {
      const { scheduler, timers } = fakeScheduler();
      let calls = 0;
      const stop = startAssistantEventsPurge(env as NodeJS.ProcessEnv, fakeDb, () => {}, {
        scheduler,
        purge: async () => { calls += 1; return 0; },
      });
      assert.equal(stop, undefined, JSON.stringify(env));
      assert.equal(timers.length, 0, "no timer, not even a cleared one");
      assert.equal(calls, 0);
    }
  });

  test("flag set but no database: nothing is scheduled", () => {
    const { scheduler, timers } = fakeScheduler();
    const stop = startAssistantEventsPurge(ON, undefined, () => {}, { scheduler });
    assert.equal(stop, undefined);
    assert.equal(timers.length, 0);
  });

  test("flag set: one start-delay timer and one daily interval, both unref'd", () => {
    const { scheduler, timers } = fakeScheduler();
    const stop = startAssistantEventsPurge(ON, fakeDb, () => {}, { scheduler, purge: async () => 0 });
    assert.equal(typeof stop, "function");
    assert.equal(timers.length, 2);
    const [first, repeat] = timers;
    assert.equal(first!.kind, "timeout");
    assert.equal(first!.ms, PURGE_START_DELAY_MS);
    assert.equal(repeat!.kind, "interval");
    assert.equal(repeat!.ms, PURGE_INTERVAL_MS);
    assert.equal(PURGE_INTERVAL_MS, 24 * 3600 * 1000);
    assert.ok(PURGE_START_DELAY_MS <= 5 * 60_000, "shortly after start");
    assert.ok(timers.every((t) => t.unrefed), "a timer must not keep the process alive");
    stop!();
  });

  test("runs after the start delay and again on the interval, with the store's default retention", async () => {
    const { scheduler, timers } = fakeScheduler();
    const { out, log } = lines();
    const seen: number[] = [];
    let deleted = 7;
    startAssistantEventsPurge(ON, fakeDb, log, {
      scheduler,
      purge: async (_db, days) => { seen.push(days); return deleted; },
    });
    assert.deepEqual(seen, [], "nothing runs at start");
    timers[0]!.fn();
    await settle();
    deleted = 0;
    timers[1]!.fn();
    await settle();
    assert.deepEqual(seen, [DEFAULT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS]);
    assert.equal(DEFAULT_RETENTION_DAYS, 90);
    const done = out.map((l) => JSON.parse(l)).filter((l) => l.event === "relay.assistant_events_purged");
    assert.equal(done.length, 2);
    assert.deepEqual(done.map((l) => [l.level, l.deleted, l.retention_days]), [["info", 7, 90], ["info", 0, 90]]);
    assert.deepEqual(Object.keys(done[0]).sort(), ["deleted", "event", "level", "retention_days"], "counts only");
  });

  test("a purge that throws is logged once, by class and message, and the next tick still runs", async () => {
    const { scheduler, timers } = fakeScheduler();
    const { out, log } = lines();
    let calls = 0;
    startAssistantEventsPurge(ON, fakeDb, log, {
      scheduler,
      purge: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("connection terminated"), { name: "DatabaseError", detail: "Key (trip_id)=(trip_secret) row data" });
        }
        return 3;
      },
    });
    timers[0]!.fn();
    await settle();
    const failed = out.map((l) => JSON.parse(l)).filter((l) => l.event === "relay.assistant_events_purge_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].level, "warn");
    assert.equal(failed[0].error_class, "DatabaseError");
    assert.equal(failed[0].message, "connection terminated");
    assert.ok(!out.join("\n").includes("trip_secret"), "no row data from the error");

    timers[1]!.fn();
    await settle();
    assert.equal(calls, 2);
    assert.ok(out.map((l) => JSON.parse(l)).some((l) => l.event === "relay.assistant_events_purged" && l.deleted === 3));
  });

  test("a purge that throws synchronously, or a non-Error, does not escape", async () => {
    const { scheduler, timers } = fakeScheduler();
    const { out, log } = lines();
    let calls = 0;
    startAssistantEventsPurge(ON, fakeDb, log, {
      scheduler,
      purge: (() => {
        calls += 1;
        if (calls === 1) throw "boom";
        return Promise.reject(new TypeError("bad"));
      }) as never,
    });
    timers[0]!.fn();
    await settle();
    timers[1]!.fn();
    await settle();
    assert.equal(calls, 2);
    const failed = out.map((l) => JSON.parse(l)).filter((l) => l.event === "relay.assistant_events_purge_failed");
    assert.equal(failed.length, 2);
    assert.equal(failed[1].error_class, "TypeError");
  });

  test("overlapping ticks do not stack: a run still in flight makes the next tick a no-op", async () => {
    const { scheduler, timers } = fakeScheduler();
    let calls = 0;
    let release!: () => void;
    startAssistantEventsPurge(ON, fakeDb, () => {}, {
      scheduler,
      purge: () => {
        calls += 1;
        return new Promise<number>((resolve) => { release = () => resolve(1); });
      },
    });
    timers[0]!.fn();
    timers[1]!.fn();
    timers[1]!.fn();
    await settle();
    assert.equal(calls, 1, "the second and third ticks found the first still running");
    release();
    await settle();
    timers[1]!.fn();
    await settle();
    assert.equal(calls, 2, "once it settles the loop runs again");
  });

  test("stop clears both timers, and a tick that fires after stop does nothing", async () => {
    const { scheduler, timers, live } = fakeScheduler();
    let calls = 0;
    const stop = startAssistantEventsPurge(ON, fakeDb, () => {}, {
      scheduler,
      purge: async () => { calls += 1; return 0; },
    });
    assert.equal(live().length, 2);
    stop!();
    assert.equal(live().length, 0);
    timers[0]!.fn();
    timers[1]!.fn();
    await settle();
    assert.equal(calls, 0);
    stop!(); // idempotent
  });

  test("with the real scheduler the timers do not keep the process alive, and stop clears them", () => {
    const stop = startAssistantEventsPurge(ON, fakeDb, () => {}, { purge: async () => 0 });
    assert.equal(typeof stop, "function");
    stop!();
  });

  // relay/server.ts runs main() on import, so it cannot be imported here; this
  // pins the wiring by reading it. A schedule nobody starts is the failure this
  // whole change exists to remove, and it would fail silently.
  test("the relay entry point starts the schedule and its shutdown handler stops it", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/relay/server.ts", import.meta.url)), "utf8");
    assert.match(source, /import \{ startAssistantEventsPurge \} from "\.\.\/analytics\/purge-schedule\.js"/);
    assert.match(source, /stopEventsPurge = startAssistantEventsPurge\(process\.env, runtime\.db, log\)/);
    const shutdown = source.slice(source.indexOf('relay.shutting_down'));
    assert.match(shutdown, /stopEventsPurge\?\.\(\)/, "the shutdown handler clears the purge timers");
    assert.ok(shutdown.indexOf("stopEventsPurge?.()") < shutdown.indexOf("process.exit(0)"));
  });
});

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function event(tripId: string, occurredAt: string): AssistantEvent {
  return {
    event_id: randomUUID(),
    trip_id: tripId,
    occurred_at: occurredAt,
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
  };
}

describe("assistant-events purge schedule against Postgres", () => {
  test("the scheduled run deletes only events older than 90 days and touches no trip", { skip: SKIP }, async () => {
    const pool = testPool();
    try {
      const client = await pool.connect();
      try {
        await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
        await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
        await applyMigrations(client, migrationsDir);
      } finally {
        client.release();
      }
      const tripId = `trip_${randomBytes(16).toString("hex")}`;
      await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
      const day = 24 * 3600 * 1000;
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
      const old = event(tripId, at(120));
      const older = event(tripId, at(91));
      const edge = event(tripId, at(89));
      const fresh = event(tripId, at(1));
      await writeAssistantEvents(pool, [old, older, edge, fresh]);
      const tripsBefore = (await pool.query("SELECT count(*)::int AS n FROM control_plane.trips")).rows[0].n;

      const { scheduler, timers } = fakeScheduler();
      const { out, log } = lines();
      startAssistantEventsPurge(ON, pool, log, { scheduler });
      timers[0]!.fn();
      // The real purge is one round trip; wait for its log line, not a sleep.
      for (let i = 0; i < 200 && out.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));

      const left = await pool.query<{ event_id: string }>("SELECT event_id::text FROM control_plane.assistant_events ORDER BY occurred_at");
      assert.deepEqual(left.rows.map((r) => r.event_id), [edge.event_id, fresh.event_id]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.trips")).rows[0].n, tripsBefore, "the trip is untouched");
      const line = JSON.parse(out[0]!);
      assert.equal(line.event, "relay.assistant_events_purged");
      assert.equal(line.deleted, 2);
      assert.equal(line.retention_days, 90);
    } finally {
      await pool.end();
    }
  });
});
