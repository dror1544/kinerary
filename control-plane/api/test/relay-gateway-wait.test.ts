import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import {
  awaitExpectedGateways,
  expectedGatewayProfiles,
  gatewayWaitMsFromEnv,
} from "../src/relay/gateway-wait.js";
import { applyMigrations } from "../src/migrations.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";
import { fileURLToPath } from "node:url";

/**
 * The relay restarts on every control-plane upgrade. It used to start polling
 * Telegram the moment its socket listened — before any companion gateway had
 * reconnected (they back off up to 30 s) — so every message waiting at
 * Telegram for a live trip was answered "I'm still finishing your assistant"
 * and consumed. The wait holds the poll loop, and Telegram holds the updates,
 * until the companions the router would route to are back.
 */

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
  };
}

test("polling waits until every expected companion is reachable", async () => {
  const time = clock();
  const reachableAt = new Map([["japan2026", 12_000], ["usa2026", 3_000]]);
  const result = await awaitExpectedGateways({
    expected: ["japan2026", "usa2026"],
    canReach: (profile) => time.now() >= (reachableAt.get(profile) ?? Infinity),
    timeoutMs: 40_000,
    pollMs: 500,
    now: time.now,
    sleep: time.sleep,
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.connected, ["japan2026", "usa2026"]);
  assert.equal(result.waitedMs, 12_000);
  assert.equal(result.timedOut, false);
});

test("a companion that never comes back costs the timeout, not the relay", async () => {
  const time = clock();
  const result = await awaitExpectedGateways({
    expected: ["japan2026", "stopped-trip"],
    canReach: (profile) => profile === "japan2026",
    timeoutMs: 40_000,
    pollMs: 1_000,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.connected, ["japan2026"]);
  assert.deepEqual(result.missing, ["stopped-trip"]);
  assert.equal(result.waitedMs, 40_000);
});

test("nothing expected means no wait at all", async () => {
  let slept = false;
  const result = await awaitExpectedGateways({
    expected: [],
    canReach: () => false,
    timeoutMs: 40_000,
    now: () => 0,
    sleep: async () => { slept = true; },
  });
  assert.equal(slept, false);
  assert.equal(result.waitedMs, 0);
  assert.equal(result.timedOut, false);
});

test("the wait is configurable and can be switched off, but not made unbounded", () => {
  assert.equal(gatewayWaitMsFromEnv({}), 40_000);
  assert.equal(gatewayWaitMsFromEnv({ RELAY_GATEWAY_WAIT_SECONDS: "0" }), 0);
  assert.equal(gatewayWaitMsFromEnv({ RELAY_GATEWAY_WAIT_SECONDS: "15" }), 15_000);
  // A typo must not silently disable the wait, nor hold the bot offline for
  // an hour: garbage falls back to the default, and the ceiling is 5 minutes.
  assert.equal(gatewayWaitMsFromEnv({ RELAY_GATEWAY_WAIT_SECONDS: "soon" }), 40_000);
  assert.equal(gatewayWaitMsFromEnv({ RELAY_GATEWAY_WAIT_SECONDS: "-3" }), 40_000);
  assert.equal(gatewayWaitMsFromEnv({ RELAY_GATEWAY_WAIT_SECONDS: "3600" }), 300_000);
});

const databaseUrl = testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

test("expected companions are the open bindings of trips not known to be unreachable", { skip: !databaseUrl }, async () => {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
    await client.query(`INSERT INTO control_plane.trips(id, slug, lifecycle_state, reachability, unreachable_reason) VALUES
      ('trip_live0001', 'japan', 'ready_private', 'reachable', NULL),
      ('trip_unkn0001', 'usa', 'ready_private', 'unknown', NULL),
      ('trip_down0001', 'broken', 'ready_private', 'unreachable', 'COMPANION_INSTALL_FAILED'),
      ('trip_brdg0001', 'bridge-broken', 'ready_private', 'unreachable', 'TRIP_MCP_BRIDGE_FAILED'),
      ('trip_gone0001', 'retired-italy-20260911', 'ready_private', 'reachable', NULL),
      ('trip_gone0002', 'retired-france-20260920', 'ready_private', 'unknown', NULL)`);
    const columns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'control_plane' AND table_name = 'telegram_chat_bindings'",
    );
    const names = new Set(columns.rows.map((row) => row.column_name as string));
    assert.ok(names.has("hermes_profile") && names.has("closed_at"));
    const insert = async (id: string, chat: string, trip: string, profile: string | null, closed: boolean) => {
      await client.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile, closed_at, closed_reason)
         VALUES ($1, $2, $3, $4, ${closed ? "now(), 'trip_destroyed'" : "NULL, NULL"})`,
        [id, chat, trip, profile],
      );
    };
    await insert("tcb_live0001", "-1001", "trip_live0001", "japan2026", false);
    await insert("tcb_live0002", "1000001", "trip_live0001", "japan2026", false);
    await insert("tcb_unkn0001", "-1002", "trip_unkn0001", "usa2026", false);
    await insert("tcb_nocomp01", "-1005", "trip_unkn0001", null, false);
    await insert("tcb_down0001", "-1003", "trip_down0001", "broken2026", false);
    // Issue #193: the companion itself answers fine here, only its trip-mcp
    // bridge is down (`restart-bridges` exists to repair exactly this) — the
    // relay must still wait for it after a restart, unlike a genuinely
    // unreachable trip (COMPANION_INSTALL_FAILED, above).
    await insert("tcb_brdg0001", "-1007", "trip_brdg0001", "bridge2026", false);
    await insert("tcb_gone0001", "-1004", "trip_gone0001", "italy2026", true);
    // The issue #105 shape exactly: a fourth binding created AFTER teardown,
    // still open, naming a companion profile that no longer exists, on a
    // trip whose `reachability` was never updated to `unreachable`. Without
    // the slug exclusion this profile would enter the expected set and cost
    // every other trip the full gateway-wait timeout.
    await insert("tcb_gone0002", "-1006", "trip_gone0002", "france2026", false);
    assert.deepEqual(await expectedGatewayProfiles(client), ["bridge2026", "japan2026", "usa2026"]);
  } finally {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    client.release();
    await pool.end();
  }
});

test("only a companion the reconciler actually stopped is dormant; a decision alone does not hide it", { skip: !databaseUrl }, async () => {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
    const trips = [
      ["current", "reachable", null],
      ["dormant", "reachable", null],
      ["undecided", "reachable", null],
      ["revived", "reachable", null],
      ["brokendormant", "unreachable", "TRIP_MCP_BRIDGE_FAILED"],
      ["observeonly", "reachable", null],
      ["neverstopped", "reachable", null],
      ["cameback", "reachable", null],
      ["failedstop", "reachable", null],
      ["restarted", "reachable", null],
    ] as const;
    for (const [i, [name, reach, reason]] of trips.entries()) {
      await client.query(
        "INSERT INTO control_plane.trips(id, slug, lifecycle_state, reachability, unreachable_reason) VALUES ($1, $2, 'ready_private', $3, $4)",
        [`trip_w${String(i).padStart(7, "0")}`, `${name}-trip`, reach, reason],
      );
      await client.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, $4)",
        [`tcb_w${String(i).padStart(7, "0")}`, `-${2000 + i}`, `trip_w${String(i).padStart(7, "0")}`, `${name}2026`],
      );
    }
    const gw = (profile: string, desired: string, reason: string, observed: string | null, action: string | null, result: string | null) =>
      client.query(
        `INSERT INTO control_plane.companion_gateways(hermes_profile, kind, desired, reason, observed, observed_count, last_action, last_action_at, last_result)
         VALUES ($1, 'companion', $2, $3, $4, 0, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6)`,
        [profile, desired, reason, observed, action, result],
      );
    await gw("current2026", "running", "CURRENT_TRIP", "running", null, null);
    // The reconciler stopped it and the host confirmed: dormant, not waited for.
    await gw("dormant2026", "stopped", "NOT_CURRENT", "stopped", "stop", "ok");
    await gw("brokendormant2026", "stopped", "ARCHIVED", "absent", "stop", "ok");
    await gw("revived2026", "running", "REVIVED", "running", "start", "ok");
    // Decided stopped but NOT stopped by the reconciler: still expected, whatever
    // the host says - observe mode decides and never acts.
    await gw("observeonly2026", "stopped", "NOT_CURRENT", "running", null, null);
    await gw("neverstopped2026", "stopped", "NOT_CURRENT", "stopped", null, null);
    // Stopped once, then it came back (or the stop failed, or it was started again).
    await gw("cameback2026", "stopped", "NOT_CURRENT", "running", "stop", "ok");
    await gw("failedstop2026", "stopped", "NOT_CURRENT", "running", "stop", "failed");
    await gw("restarted2026", "stopped", "NOT_CURRENT", "stopped", "start", "ok");
    assert.deepEqual(await expectedGatewayProfiles(client), [
      "cameback2026", "current2026", "failedstop2026", "neverstopped2026", "observeonly2026", "restarted2026",
      "revived2026", "undecided2026",
    ]);
    // The decision flips back to running: expected again.
    await client.query("UPDATE control_plane.companion_gateways SET desired = 'running', reason = 'REVIVED' WHERE hermes_profile = 'dormant2026'");
    assert.ok((await expectedGatewayProfiles(client)).includes("dormant2026"));
  } finally {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    client.release();
    await pool.end();
  }
});
