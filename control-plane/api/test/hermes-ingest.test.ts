/**
 * The Hermes tool-outcome ingest path — the assistant-side half of the
 * outcome-event pipeline #177/#326 left as `not_measurable`.
 *
 *   - the route is absent (503) with no key configured, never a 401 that
 *     would at least confirm it exists;
 *   - a wrong, empty or missing key is refused, and the key itself never
 *     comes back in any response;
 *   - the right key resolves the caller's OWN trip from its Hermes profile
 *     and writes `tool_call_completed` rows nobody can see without it;
 *   - a malformed request — bad profile, bad batch shape, a bad event
 *     inside an otherwise fine batch — is refused before anything is
 *     written, and the batch's own contract rules (no `answered`, ever)
 *     hold at this door too.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, test, before, after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const DB_URL = testDatabaseUrl();
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const KEY = "hermes-ingest-key-for-tests";
const ROUTE = "/internal/assistant-events/tool-outcomes";

const profile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

function suffix(): string {
  return randomBytes(6).toString("hex");
}

describe("POST /internal/assistant-events/tool-outcomes", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query("DELETE FROM control_plane.assistant_events");
    await pool.query("DELETE FROM control_plane.trips");
  });

  function appWithIngest() {
    return buildApp(profile, { assistantEventsIngest: { db: pool, apiKey: KEY } });
  }

  async function seedTrip(hermesProfile: string | null): Promise<string> {
    const tripId = `trip_${suffix()}`;
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state, hermes_profile) VALUES ($1, $2, 'draft', $3)",
      [tripId, tripId.replace(/_/g, "-"), hermesProfile],
    );
    return tripId;
  }

  function validEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return { event_id: randomUUID(), outcome: "grounded_answer", tool_name: "get_today", ...overrides };
  }

  // ── Off unless configured ────────────────────────────────────────────────

  test("with no key in the environment, the route does not exist", async () => {
    const app = buildApp(profile, {});
    try {
      const response = await app.inject({ method: "POST", url: ROUTE, payload: { profile: "p", events: [validEvent()] } });
      assert.equal(response.statusCode, 503);
      assert.equal(JSON.parse(response.body).error, "ASSISTANT_EVENTS_INGEST_NOT_CONFIGURED");
    } finally {
      await app.close();
    }
  });

  // ── Authentication ───────────────────────────────────────────────────────

  test("a wrong key, an empty key and no key are all refused, and the key never comes back", async () => {
    const app = appWithIngest();
    try {
      for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "nearly-the-key" }]) {
        const response = await app.inject({
          method: "POST", url: ROUTE, headers,
          payload: { profile: "p", events: [validEvent()] },
        });
        assert.equal(response.statusCode, 401, JSON.stringify(headers));
        assert.equal(JSON.parse(response.body).error, "AUTHENTICATION_REQUIRED");
        assert.ok(!response.body.includes(KEY), "the configured key is never echoed");
      }
    } finally {
      await app.close();
    }
  });

  test("a trip's own HERMES_API_KEY-shaped value is not this key", async () => {
    // There is no shared-secret crossover to test directly (HERMES_API_KEY
    // lives in server/server.js, a different process), but the auth check
    // here is a single configured value — this pins that an unrelated,
    // plausible-looking key is refused like any other wrong one.
    const app = appWithIngest();
    try {
      const response = await app.inject({
        method: "POST", url: ROUTE, headers: { "x-api-key": "a-trip-site-agent-key" },
        payload: { profile: "p", events: [validEvent()] },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  // ── The happy path ───────────────────────────────────────────────────────

  test("the right key, a known profile and a valid event: 200, and the row is written as tool_call_completed/hermes", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `profile-${suffix()}`;
      const tripId = await seedTrip(hermesProfile);
      const eventId = randomUUID();

      const response = await app.inject({
        method: "POST", url: ROUTE, headers: { "x-api-key": KEY },
        payload: { profile: hermesProfile, events: [{ event_id: eventId, outcome: "grounded_answer", tool_name: "get_today" }] },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), { inserted: 1, duplicates: 0, rejected: [] });

      const { rows } = await pool.query(
        "SELECT trip_id, source_service, event_type, outcome, turn_id, channel_type, tool_name FROM control_plane.assistant_events WHERE event_id = $1",
        [eventId],
      );
      assert.deepEqual(rows, [{
        trip_id: tripId, source_service: "hermes", event_type: "tool_call_completed",
        outcome: "grounded_answer", turn_id: null, channel_type: null, tool_name: "get_today",
      }]);
    } finally {
      await app.close();
    }
  });

  test("failed_tool is accepted; the same event_id posted twice is stored once", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `profile-${suffix()}`;
      await seedTrip(hermesProfile);
      const eventId = randomUUID();
      const payload = { profile: hermesProfile, events: [{ event_id: eventId, outcome: "failed_tool", tool_name: "get_today" }] };

      const first = await app.inject({ method: "POST", url: ROUTE, headers: { "x-api-key": KEY }, payload });
      const again = await app.inject({ method: "POST", url: ROUTE, headers: { "x-api-key": KEY }, payload });
      assert.deepEqual(JSON.parse(first.body), { inserted: 1, duplicates: 0, rejected: [] });
      assert.deepEqual(JSON.parse(again.body), { inserted: 0, duplicates: 1, rejected: [] });

      const { rows } = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
      assert.equal(rows[0].n, 1);
    } finally {
      await app.close();
    }
  });

  test("a batch of several events for the same profile all land", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `profile-${suffix()}`;
      await seedTrip(hermesProfile);
      const events = Array.from({ length: 5 }, (_, i) => ({ event_id: randomUUID(), outcome: i % 2 === 0 ? "grounded_answer" : "failed_tool", tool_name: "get_today" }));

      const response = await app.inject({ method: "POST", url: ROUTE, headers: { "x-api-key": KEY }, payload: { profile: hermesProfile, events } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), { inserted: 5, duplicates: 0, rejected: [] });
    } finally {
      await app.close();
    }
  });

  // ── Identity: from the profile, never a trip id in the body ─────────────

  test("a profile with no trip is a 404, and nothing is written", async () => {
    const app = appWithIngest();
    try {
      const response = await app.inject({
        method: "POST", url: ROUTE, headers: { "x-api-key": KEY },
        payload: { profile: `no-such-profile-${suffix()}`, events: [validEvent()] },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(JSON.parse(response.body).error, "NO_TRIP");
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
      assert.equal(rows[0].n, 0);
    } finally {
      await app.close();
    }
  });

  test("a profile shared by two trips is a 409, and nothing is written", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `shared-${suffix()}`;
      await seedTrip(hermesProfile);
      await seedTrip(hermesProfile);
      const response = await app.inject({
        method: "POST", url: ROUTE, headers: { "x-api-key": KEY },
        payload: { profile: hermesProfile, events: [validEvent()] },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(JSON.parse(response.body).error, "AMBIGUOUS_TRIP");
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
      assert.equal(rows[0].n, 0);
    } finally {
      await app.close();
    }
  });

  test("the request never names a trip id directly — a trip_id field in the body is ignored, not trusted", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `profile-${suffix()}`;
      const realTrip = await seedTrip(hermesProfile);
      const eventId = randomUUID();
      const response = await app.inject({
        method: "POST", url: ROUTE, headers: { "x-api-key": KEY },
        payload: { profile: hermesProfile, trip_id: "trip_someoneelsestrip00000000", events: [{ event_id: eventId, outcome: "grounded_answer", tool_name: "get_today" }] },
      });
      assert.equal(response.statusCode, 200, response.body);
      const { rows } = await pool.query("SELECT trip_id FROM control_plane.assistant_events WHERE event_id = $1", [eventId]);
      assert.deepEqual(rows, [{ trip_id: realTrip }]);
    } finally {
      await app.close();
    }
  });

  // ── Malformed requests: refused before anything is written ─────────────

  test("a missing or badly-shaped profile is a 400", async () => {
    const app = appWithIngest();
    try {
      for (const payload of [
        { events: [validEvent()] },
        { profile: "", events: [validEvent()] },
        { profile: 42, events: [validEvent()] },
        { profile: "x".repeat(65), events: [validEvent()] },
      ]) {
        const response = await app.inject({ method: "POST", url: ROUTE, headers: { "x-api-key": KEY }, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(JSON.parse(response.body).error, "INVALID_PROFILE");
      }
    } finally {
      await app.close();
    }
  });

  test("a missing, empty or oversized events array is a 400", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `profile-${suffix()}`;
      await seedTrip(hermesProfile);
      const cases: [Record<string, unknown>, string][] = [
        [{ profile: hermesProfile }, "INVALID_BATCH"],
        [{ profile: hermesProfile, events: "not-an-array" }, "INVALID_BATCH"],
        [{ profile: hermesProfile, events: [] }, "EMPTY_BATCH"],
        [{ profile: hermesProfile, events: Array.from({ length: 51 }, () => validEvent()) }, "BATCH_TOO_LARGE"],
      ];
      for (const [payload, reason] of cases) {
        const response = await app.inject({ method: "POST", url: ROUTE, headers: { "x-api-key": KEY }, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(JSON.parse(response.body).error, reason);
      }
    } finally {
      await app.close();
    }
  });

  test("one malformed event in an otherwise valid batch is a 400 for the whole request, and nothing is written", async () => {
    const app = appWithIngest();
    try {
      const hermesProfile = `profile-${suffix()}`;
      await seedTrip(hermesProfile);
      const cases: [unknown, string][] = [
        [{ event_id: "not-a-uuid", outcome: "grounded_answer" }, "BAD:event_id"],
        [{ event_id: randomUUID(), outcome: "answered" }, "BAD:outcome"],
        [{ event_id: randomUUID(), outcome: "answered_with_tools" }, "BAD:outcome"],
        [{ event_id: randomUUID(), outcome: "banana" }, "BAD:outcome"],
        [{ event_id: randomUUID() }, "BAD:outcome"],
        [{ event_id: randomUUID(), outcome: "grounded_answer", tool_name: "get_today", occurred_at: "yesterday" }, "BAD:occurred_at"],
        [{ event_id: randomUUID(), outcome: "grounded_answer" }, "BAD:tool_name"],
        [{ event_id: randomUUID(), outcome: "grounded_answer", tool_name: "drop_table" }, "BAD:tool_name"],
        ["not-an-object", "INVALID_EVENT"],
        [null, "INVALID_EVENT"],
      ];
      for (const [badEvent, reason] of cases) {
        const response = await app.inject({
          method: "POST", url: ROUTE, headers: { "x-api-key": KEY },
          payload: { profile: hermesProfile, events: [validEvent(), badEvent] },
        });
        assert.equal(response.statusCode, 400, JSON.stringify(badEvent));
        const body = JSON.parse(response.body);
        assert.equal(body.error, "INVALID_EVENT");
        assert.equal(body.detail.index, 1);
        assert.equal(body.detail.reason, reason);
      }
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM control_plane.assistant_events");
      assert.equal(rows[0].n, 0, "the whole request is refused — the valid sibling event is not written either");
    } finally {
      await app.close();
    }
  });

  test("`answered` can never reach the table through this route, even posted directly as a tool_call_completed row", async () => {
    // The ingest path's own parser already refuses it (test above); this
    // pins the second line, the one the relay's table-level test pins for
    // its own events — the CHECK constraint refuses it even written around
    // the application layer entirely.
    const hermesProfile = `profile-${suffix()}`;
    const tripId = await seedTrip(hermesProfile);
    await assert.rejects(
      pool.query(
        `INSERT INTO control_plane.assistant_events
           (event_id, trip_id, occurred_at, source_service, event_type, outcome, metadata)
         VALUES ($1, $2, now(), 'hermes', 'tool_call_completed', 'answered', '{}')`,
        [randomUUID(), tripId],
      ),
      /check constraint/,
    );
  });
});
