/**
 * Per-trip feature switches, slice S1 (docs/specs/sprint-9/567-feature-switches.md):
 * the store, the resolver, the operator command and the admin routes.
 *
 * AC-1..AC-5, AC-7, AC-8 and AC-10 run against a real Postgres (a `cptest_*`
 * database — this suite drops the control_plane schema). AC-6, the failing
 * read, is in relay-feature-switch.test.ts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import {
  SAFE_WITHOUT_LIVE_TRIP_STATES,
  describeFeatureSwitches,
  featureEnabled,
  setFeatureSwitch,
  tripNeedsLive,
} from "../src/feature-switches.js";
import { tripStates } from "../src/lifecycle.js";
import { applyMigrations } from "../src/migrations.js";
import { FEATURE_SWITCHES } from "../../../shared/feature-switches.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const run = promisify(execFile);
const DB_URL = testDatabaseUrl();
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const KEY = "admin-key-for-feature-switch-tests";
const SWITCH = "delivery_probe";

const profile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

async function addTrip(pool: pg.Pool, id: string, state = "provisioning", createdAt?: string): Promise<string> {
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state, created_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))",
    [id, id.replace(/_/g, "-"), state, createdAt ?? null],
  );
  return id;
}

const TRIP_A = "trip_aaaaaaaa";
const TRIP_B = "trip_bbbbbbbb";

describe("feature switches (S1)", { skip: SKIP }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = testPool();
    await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await pool.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    const client = await pool.connect();
    try {
      await applyMigrations(client, migrationsDir);
    } finally {
      client.release();
    }
  });
  after(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query("DELETE FROM control_plane.feature_switch_settings");
    await pool.query("ALTER TABLE control_plane.feature_switch_history DISABLE TRIGGER feature_switch_history_append_only");
    await pool.query("DELETE FROM control_plane.feature_switch_history");
    await pool.query("ALTER TABLE control_plane.feature_switch_history ENABLE TRIGGER feature_switch_history_append_only");
    await pool.query("DELETE FROM control_plane.trips WHERE id IN ($1, $2) OR id LIKE 'trip_state%' OR id LIKE 'trip_early%' OR id LIKE 'trip_gone%'", [TRIP_A, TRIP_B]);
    await addTrip(pool, TRIP_A);
    await addTrip(pool, TRIP_B);
  });

  // ── AC-1 ────────────────────────────────────────────────────────────────

  test("AC-1: an unregistered name resolves off and cannot be set", async () => {
    assert.equal(await featureEnabled(pool, TRIP_A, "no_such_switch"), false);
    // Not even a row planted by hand can make an unregistered name read as on.
    await pool.query(
      "INSERT INTO control_plane.feature_switch_settings(switch, scope, trip_id, enabled, changed_by) VALUES ('rogue_switch','all_trips',NULL,true,$1)",
      [`sha256:${"a".repeat(64)}`],
    );
    assert.equal(await featureEnabled(pool, TRIP_A, "rogue_switch"), false);
    // Nor a name that is not a string, or that tries to be a prototype key.
    assert.equal(await featureEnabled(pool, TRIP_A, "constructor"), false);
    assert.equal(await featureEnabled(pool, TRIP_A, undefined as unknown as string), false);

    const refused = await setFeatureSwitch(pool, { switch: "no_such_switch", enabled: true, scope: "all_trips", live: true });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.reason, "UNKNOWN_SWITCH");
      assert.match(refused.message, /shared\/feature-switches\.js/);
    }
    const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.feature_switch_history");
    assert.equal(rows.rows[0].n, 0);
  });

  test("AC-1: the command line refuses an unregistered name and names the registry file", async () => {
    const result = await run(
      process.execPath,
      ["--import", "tsx", "src/feature-cli.ts", "set", "no_such_switch", "on", "--all", "--live"],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, CONTROL_PLANE_DATABASE_URL: DB_URL! } },
    ).then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /shared\/feature-switches\.js/);
  });

  // ── AC-1/AC-2, review M1: a trip the resolver does not know is off ───────

  test("M1: with every trip on, anything that is not an existing trip id is off, in SQL and through featureEnabled", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), true, "control: a real trip is on");
    const slug = TRIP_A.replace(/_/g, "-");
    for (const ref of ["trip_doesnotexist99", slug, "not-a-trip-at-all", ""]) {
      assert.equal(await featureEnabled(pool, ref, SWITCH), false, `featureEnabled(${JSON.stringify(ref)})`);
      const sql = await pool.query("SELECT control_plane.feature_enabled($1, $2) AS on", [ref, SWITCH]);
      assert.equal(sql.rows[0].on, false, `feature_enabled(${JSON.stringify(ref)}) in SQL`);
    }
    const nul = await pool.query("SELECT control_plane.feature_enabled(NULL, $1) AS on", [SWITCH]);
    assert.equal(nul.rows[0].on, false, "NULL trip in SQL");
    assert.equal(await featureEnabled(pool, null as unknown as string, SWITCH), false);
  });

  test("M1: a per-trip off cannot be bypassed by passing the slug", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "trip", trip: TRIP_A });
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), false);
    assert.equal(await featureEnabled(pool, TRIP_A.replace(/_/g, "-"), SWITCH), false);
  });

  test("M1: a trip id that no longer exists is off, whatever is stored", async () => {
    await addTrip(pool, "trip_gonegone01");
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    assert.equal(await featureEnabled(pool, "trip_gonegone01", SWITCH), true);
    await pool.query("DELETE FROM control_plane.trips WHERE id = 'trip_gonegone01'");
    assert.equal(await featureEnabled(pool, "trip_gonegone01", SWITCH), false);
    const sql = await pool.query("SELECT control_plane.feature_enabled('trip_gonegone01', $1) AS on", [SWITCH]);
    assert.equal(sql.rows[0].on, false);
  });

  test("M1: the registry gate is in code, not SQL — featureEnabled keeps a planted row off", async () => {
    await pool.query(
      "INSERT INTO control_plane.feature_switch_settings(switch, scope, trip_id, enabled, changed_by) VALUES ('rogue_switch','all_trips',NULL,true,$1)",
      [`sha256:${"c".repeat(64)}`],
    );
    assert.equal(await featureEnabled(pool, TRIP_A, "rogue_switch"), false);
    // The SQL function alone does not know the registry; every SQL caller must
    // go through a registry check first (see the function's comment).
    const sql = await pool.query("SELECT control_plane.feature_enabled($1, 'rogue_switch') AS on", [TRIP_A]);
    assert.equal(sql.rows[0].on, true, "documented: SQL has no registry");
  });

  // ── AC-2 ────────────────────────────────────────────────────────────────

  test("AC-2: no stored row means off", async () => {
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), false);
    assert.equal(await featureEnabled(pool, "trip_neverexisted", SWITCH), false);
  });

  // ── AC-3 ────────────────────────────────────────────────────────────────

  test("AC-3: on for trip A only is on for A and off for B", async () => {
    const set = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A });
    assert.equal(set.ok, true);
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), true);
    assert.equal(await featureEnabled(pool, TRIP_B, SWITCH), false);
  });

  test("AC-3: a trip may be named by slug", async () => {
    const set = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A.replace(/_/g, "-") });
    assert.equal(set.ok && set.tripId, TRIP_A);
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), true);
  });

  // ── AC-4 ────────────────────────────────────────────────────────────────

  test("AC-4: off for trip A beats on for every trip", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "trip", trip: TRIP_A });
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), false);
    assert.equal(await featureEnabled(pool, TRIP_B, SWITCH), true);
    // A trip created later is covered by "every trip" too.
    await addTrip(pool, "trip_cccccccc");
    assert.equal(await featureEnabled(pool, "trip_cccccccc", SWITCH), true);
    await pool.query("DELETE FROM control_plane.trips WHERE id = 'trip_cccccccc'");
  });

  test("AC-4: on for trip A beats off for every trip", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "all_trips", live: true });
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A });
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), true);
    assert.equal(await featureEnabled(pool, TRIP_B, SWITCH), false);
  });

  // ── AC-5 ────────────────────────────────────────────────────────────────

  test("AC-5: on for future trips reaches only trips created after the moment it was set", async () => {
    const before = await addTrip(pool, "trip_statebefore", "draft", new Date(Date.now() - 3_600_000).toISOString());
    const set = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "new_trips", live: true });
    assert.equal(set.ok, true);
    const after = await addTrip(pool, "trip_stateafter0", "draft", new Date(Date.now() + 60_000).toISOString());
    assert.equal(await featureEnabled(pool, before, SWITCH), false);
    assert.equal(await featureEnabled(pool, after, SWITCH), true);
    // And the older trips already in the table, created before the moment, stay off.
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), false);
  });

  test("AC-5: an off setting for future trips never turns anything on", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "new_trips", live: true });
    await addTrip(pool, "trip_stateafter0", "draft", new Date(Date.now() + 60_000).toISOString());
    assert.equal(await featureEnabled(pool, "trip_stateafter0", SWITCH), false);
  });

  test("AC-5: setting the same value again keeps the moment; changing it moves it", async () => {
    const first = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "new_trips", live: true });
    const again = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "new_trips", live: true });
    assert.ok(first.ok && again.ok);
    assert.equal(first.ok && first.effectiveFrom.getTime(), again.ok && again.effectiveFrom.getTime());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const flipped = await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "new_trips", live: true });
    assert.equal(flipped.ok && first.ok && flipped.effectiveFrom > first.effectiveFrom, true);
  });

  // ── AC-7 ────────────────────────────────────────────────────────────────

  test("AC-7: every successful set writes one history row, with a digest of the actor", async () => {
    const first = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A, by: "dror" });
    assert.equal(first.ok, true);
    let rows = await pool.query("SELECT * FROM control_plane.feature_switch_history ORDER BY changed_at");
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].switch, SWITCH);
    assert.equal(rows.rows[0].scope, "trip");
    assert.equal(rows.rows[0].trip_id, TRIP_A);
    assert.equal(rows.rows[0].old_enabled, null);
    assert.equal(rows.rows[0].new_enabled, true);
    assert.equal(rows.rows[0].changed_by, `sha256:${createHash("sha256").update("dror").digest("hex")}`);
    assert.ok(rows.rows[0].changed_at instanceof Date);
    assert.doesNotMatch(JSON.stringify(rows.rows[0]), /dror/);

    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "trip", trip: TRIP_A, by: "dror" });
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    rows = await pool.query("SELECT scope, trip_id, old_enabled, new_enabled FROM control_plane.feature_switch_history ORDER BY changed_at, id");
    assert.deepEqual(rows.rows.map((r) => [r.scope, r.trip_id, r.old_enabled, r.new_enabled]), [
      ["trip", TRIP_A, null, true],
      ["trip", TRIP_A, true, false],
      ["all_trips", null, null, true],
    ]);
  });

  test("AC-7: setting the value it already has is still recorded", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A });
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A });
    const rows = await pool.query("SELECT old_enabled, new_enabled FROM control_plane.feature_switch_history ORDER BY changed_at, id");
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows[1], { old_enabled: true, new_enabled: true });
  });

  test("AC-7: the history is append-only", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A });
    await assert.rejects(pool.query("UPDATE control_plane.feature_switch_history SET new_enabled = false"), /append-only/);
    await assert.rejects(pool.query("DELETE FROM control_plane.feature_switch_history"), /append-only/);
  });

  test("AC-7: the change and its history row are one transaction", async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION control_plane.test_fail_history() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'history write refused'; END; $$`);
    await pool.query("CREATE TRIGGER test_fail_history BEFORE INSERT ON control_plane.feature_switch_history FOR EACH ROW EXECUTE FUNCTION control_plane.test_fail_history()");
    try {
      await assert.rejects(setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A }), /history write refused/);
    } finally {
      await pool.query("DROP TRIGGER test_fail_history ON control_plane.feature_switch_history");
    }
    const settings = await pool.query("SELECT count(*)::int AS n FROM control_plane.feature_switch_settings");
    assert.equal(settings.rows[0].n, 0);
    assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), false);
  });

  test("the database refuses a malformed row on its own", async () => {
    const by = `sha256:${"b".repeat(64)}`;
    const insert = (switchName: string, scope: string, trip: string | null, who = by) => pool.query(
      "INSERT INTO control_plane.feature_switch_settings(switch, scope, trip_id, enabled, changed_by) VALUES ($1,$2,$3,true,$4)",
      [switchName, scope, trip, who],
    );
    await assert.rejects(insert("Bad-Name", "all_trips", null));
    await assert.rejects(insert(SWITCH, "everywhere", null));
    await assert.rejects(insert(SWITCH, "trip", null), "scope trip needs a trip");
    await assert.rejects(insert(SWITCH, "all_trips", TRIP_A), "scope all_trips takes no trip");
    await assert.rejects(insert(SWITCH, "trip", "trip_doesnotexist"), "the trip must exist");
    await assert.rejects(insert(SWITCH, "all_trips", null, "dror"), "the actor is a digest");
    await insert(SWITCH, "all_trips", null);
    await assert.rejects(insert(SWITCH, "all_trips", null), "one row per switch and scope");
    await insert(SWITCH, "trip", TRIP_A);
    await assert.rejects(insert(SWITCH, "trip", TRIP_A), "one row per switch and trip");
  });

  // ── AC-8 ────────────────────────────────────────────────────────────────

  // ── "In use" is an allow-list (owner's confirmation pending) ──────────────
  // A trip-scoped set needs no --live only for a trip strictly BEFORE
  // ready_private. ready_private itself, everything after it and any state this
  // code does not recognise need --live: both real production trips sit at
  // ready_private.

  test("AC-8: ready_private and every later state refuse a trip-scoped set without --live, and take it with --live", async () => {
    const states = ["ready_private", "activation_approved", "active", "completed", "sealed"];
    for (const state of states) {
      const id = `trip_state${state.replace(/_/g, "")}`;
      await addTrip(pool, id, state);
      const refused = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: id });
      assert.equal(refused.ok, false, state);
      if (!refused.ok) {
        assert.equal(refused.reason, "TRIP_IN_USE", state);
        assert.match(refused.message, /in use/);
        assert.match(refused.message, /--live/);
      }
      assert.equal(await featureEnabled(pool, id, SWITCH), false, state);
      const allowed = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: id, live: true });
      assert.equal(allowed.ok, true, state);
      assert.equal(await featureEnabled(pool, id, SWITCH), true, state);
    }
    const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.feature_switch_history");
    assert.equal(rows.rows[0].n, states.length, "only the --live sets were recorded");
  });

  test("AC-8: the states that need no --live are exactly those before ready_private in the lifecycle CHECK", async () => {
    const res = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'control_plane.trips'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lifecycle_state%'`,
    );
    const lists = res.rows.map((row) => [...String(row.def).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
    const checked = lists.sort((x, y) => y.length - x.length)[0]!;
    assert.ok(checked.includes("ready_private"), "the CHECK names ready_private");
    const before = checked.slice(0, checked.indexOf("ready_private"));
    assert.deepEqual([...SAFE_WITHOUT_LIVE_TRIP_STATES], before,
      "a state added before ready_private must be decided here; one added after it lands on the --live side");
    assert.deepEqual(checked, [...tripStates], "lifecycle.ts and the CHECK agree on the states and their order");
    for (const state of checked) {
      assert.equal(tripNeedsLive(state), !before.includes(state), state);
    }
    // Fail safe: a state this code has never heard of needs --live, as do non-strings.
    for (const unknown of ["ready_public", "archived", "", "READY_PRIVATE ", undefined, null, 7]) {
      assert.equal(tripNeedsLive(unknown as string), true, String(unknown));
    }
  });

  test("AC-8: states strictly before ready_private need no --live", async () => {
    for (const state of SAFE_WITHOUT_LIVE_TRIP_STATES) {
      const id = `trip_early${state.replace(/_/g, "")}`;
      await addTrip(pool, id, state);
      const set = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: id });
      assert.equal(set.ok, true, state);
    }
    await pool.query("DELETE FROM control_plane.feature_switch_settings");
    await pool.query("DELETE FROM control_plane.trips WHERE id LIKE 'trip_early%'");
  });

  test("AC-8: ready_private is refused without --live through the command line too", async () => {
    await addTrip(pool, "trip_statereadypriv", "ready_private");
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const env = { ...process.env, CONTROL_PLANE_DATABASE_URL: DB_URL! };
    const bare = await run(
      process.execPath,
      ["--import", "tsx", "src/feature-cli.ts", "set", SWITCH, "on", "--trip", "trip-statereadypriv"],
      { cwd, env },
    ).then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }));
    assert.notEqual(bare.code, 0);
    assert.match(bare.stderr, /TRIP_IN_USE/);
    assert.equal(await featureEnabled(pool, "trip_statereadypriv", SWITCH), false);
    await run(
      process.execPath,
      ["--import", "tsx", "src/feature-cli.ts", "set", SWITCH, "on", "--trip", "trip-statereadypriv", "--live"],
      { cwd, env },
    );
    assert.equal(await featureEnabled(pool, "trip_statereadypriv", SWITCH), true);
  });

  test("AC-8: ready_private is refused without live through the route too", async () => {
    await addTrip(pool, "trip_statereadypriv", "ready_private");
    const app = buildApp(profile, { admin: { db: pool, apiKey: KEY } });
    try {
      const headers = { "x-api-key": KEY };
      const refused = await app.inject({
        method: "POST", url: "/v1/admin/feature-switches", headers,
        payload: { switch: SWITCH, enabled: true, scope: "trip", trip: "trip_statereadypriv" },
      });
      assert.equal(refused.statusCode, 409);
      assert.equal(JSON.parse(refused.body).error, "TRIP_IN_USE");
      assert.equal(await featureEnabled(pool, "trip_statereadypriv", SWITCH), false);
      const live = await app.inject({
        method: "POST", url: "/v1/admin/feature-switches", headers,
        payload: { switch: SWITCH, enabled: true, scope: "trip", trip: "trip_statereadypriv", live: true },
      });
      assert.equal(live.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test("AC-8: every trip and future trips refuse without --live, whatever the trips are", async () => {
    for (const scope of ["all_trips", "new_trips"] as const) {
      const refused = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope });
      assert.equal(refused.ok, false, scope);
      if (!refused.ok) assert.equal(refused.reason, "LIVE_REQUIRED", scope);
      const allowed = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope, live: true });
      assert.equal(allowed.ok, true, scope);
    }
    // A string is not a yes: only the literal boolean counts as --live.
    const sloppy = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: "true" as unknown as boolean });
    assert.equal(sloppy.ok, false);
  });

  test("a trip-scoped set needs a trip that exists, and only the trip scope takes one", async () => {
    const missing = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: "no-such-trip" });
    assert.equal(!missing.ok && missing.reason, "TRIP_NOT_FOUND");
    const none = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip" });
    assert.equal(!none.ok && none.reason, "TRIP_REQUIRED");
    const extra = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", trip: TRIP_A, live: true });
    assert.equal(!extra.ok && extra.reason, "INVALID_REQUEST");
    const notBool = await setFeatureSwitch(pool, { switch: SWITCH, enabled: "yes" as unknown as boolean, scope: "trip", trip: TRIP_A });
    assert.equal(!notBool.ok && notBool.reason, "INVALID_REQUEST");
    const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.feature_switch_history");
    assert.equal(rows.rows[0].n, 0);
  });

  // ── AC-10 ───────────────────────────────────────────────────────────────

  test("AC-10: describe lists every registered switch with its value and where it came from", async () => {
    let view = await describeFeatureSwitches(pool, TRIP_A);
    assert.deepEqual(view.map((v) => v.name), FEATURE_SWITCHES.map((s) => s.name));
    assert.deepEqual(
      [view[0]!.enabled, view[0]!.source],
      [false, "default"],
    );

    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "new_trips", live: true });
    await addTrip(pool, "trip_statefuture", "draft", new Date(Date.now() + 60_000).toISOString());
    view = await describeFeatureSwitches(pool, "trip_statefuture");
    assert.deepEqual([view[0]!.enabled, view[0]!.source], [true, "new_trips"]);
    view = await describeFeatureSwitches(pool, TRIP_A);
    assert.deepEqual([view[0]!.enabled, view[0]!.source], [false, "default"]);

    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    view = await describeFeatureSwitches(pool, TRIP_A);
    assert.deepEqual([view[0]!.enabled, view[0]!.source], [true, "all_trips"]);

    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "trip", trip: TRIP_A });
    view = await describeFeatureSwitches(pool, TRIP_A);
    assert.deepEqual([view[0]!.enabled, view[0]!.source], [false, "trip"]);
    assert.equal(view[0]!.summary, FEATURE_SWITCHES[0]!.summary);
  });

  test("AC-10: what describe says is what featureEnabled answers", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "all_trips", live: true });
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "trip", trip: TRIP_B });
    for (const trip of [TRIP_A, TRIP_B]) {
      const view = await describeFeatureSwitches(pool, trip);
      assert.equal(view[0]!.enabled, await featureEnabled(pool, trip, SWITCH));
    }
  });

  test("AC-10: the command line's show prints every switch for a trip, by slug", async () => {
    await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A });
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", "src/feature-cli.ts", "show", "--trip", TRIP_A.replace(/_/g, "-")],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, CONTROL_PLANE_DATABASE_URL: DB_URL! } },
    );
    assert.match(stdout, new RegExp(`${SWITCH}\\s+on\\s+this trip`));
  });

  // ── The admin routes ────────────────────────────────────────────────────

  describe("admin routes", () => {
    const ROUTES = [
      { method: "GET" as const, url: "/v1/admin/feature-switches" },
      { method: "POST" as const, url: "/v1/admin/feature-switches" },
    ];

    test("unmounted without the admin key in the environment", async () => {
      const app = buildApp(profile, {});
      try {
        for (const route of ROUTES) {
          const response = await app.inject({ method: route.method, url: route.url, payload: {} });
          assert.equal(response.statusCode, 503, route.method);
          assert.equal(JSON.parse(response.body).error, "ADMIN_NOT_CONFIGURED");
        }
      } finally {
        await app.close();
      }
    });

    test("no key, an empty key and a wrong key are refused, and nothing is written", async () => {
      const app = buildApp(profile, { admin: { db: pool, apiKey: KEY } });
      try {
        for (const route of ROUTES) {
          for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "not-the-key" }]) {
            const response = await app.inject({
              method: route.method, url: route.url, headers,
              payload: { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A },
            });
            assert.equal(response.statusCode, 401, `${route.method} ${JSON.stringify(headers)}`);
            assert.equal(JSON.parse(response.body).error, "AUTHENTICATION_REQUIRED");
          }
        }
        assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), false);
        const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.feature_switch_history");
        assert.equal(rows.rows[0].n, 0);
      } finally {
        await app.close();
      }
    });

    test("a valid key sets a switch and reads it back", async () => {
      const app = buildApp(profile, { admin: { db: pool, apiKey: KEY } });
      try {
        const headers = { "x-api-key": KEY };
        const post = await app.inject({
          method: "POST", url: "/v1/admin/feature-switches", headers,
          payload: { switch: SWITCH, enabled: true, scope: "trip", trip: TRIP_A, by: "route-test" },
        });
        assert.equal(post.statusCode, 200, post.body);
        const posted = JSON.parse(post.body);
        assert.equal(posted.switch, SWITCH);
        assert.equal(posted.tripId, TRIP_A);
        assert.equal(posted.enabled, true);
        assert.equal(posted.previous, null);
        assert.equal(await featureEnabled(pool, TRIP_A, SWITCH), true);

        const get = await app.inject({ method: "GET", url: `/v1/admin/feature-switches?trip=${TRIP_A}`, headers });
        assert.equal(get.statusCode, 200, get.body);
        const body = JSON.parse(get.body);
        assert.equal(body.trip.id, TRIP_A);
        assert.deepEqual(
          body.switches.map((s: { name: string; enabled: boolean; source: string }) => [s.name, s.enabled, s.source]),
          [[SWITCH, true, "trip"]],
        );

        const list = await app.inject({ method: "GET", url: "/v1/admin/feature-switches", headers });
        assert.equal(list.statusCode, 200);
        assert.deepEqual(JSON.parse(list.body).switches.map((s: { name: string }) => s.name), [SWITCH]);

        const unknownTrip = await app.inject({ method: "GET", url: "/v1/admin/feature-switches?trip=no-such-trip", headers });
        assert.equal(unknownTrip.statusCode, 404);
      } finally {
        await app.close();
      }
    });

    test("an unregistered switch name is refused, naming the registry, and nothing is written", async () => {
      const app = buildApp(profile, { admin: { db: pool, apiKey: KEY } });
      try {
        const response = await app.inject({
          method: "POST", url: "/v1/admin/feature-switches", headers: { "x-api-key": KEY },
          payload: { switch: "no_such_switch", enabled: true, scope: "all_trips", live: true },
        });
        assert.equal(response.statusCode, 422);
        const body = JSON.parse(response.body);
        assert.equal(body.error, "UNKNOWN_SWITCH");
        assert.match(body.message, /shared\/feature-switches\.js/);
        const rows = await pool.query("SELECT count(*)::int AS n FROM control_plane.feature_switch_history");
        assert.equal(rows.rows[0].n, 0);
      } finally {
        await app.close();
      }
    });

    test("the in-use refusal and a malformed body are refused over HTTP too", async () => {
      await addTrip(pool, "trip_stateactiv", "active");
      const app = buildApp(profile, { admin: { db: pool, apiKey: KEY } });
      try {
        const headers = { "x-api-key": KEY };
        const inUse = await app.inject({
          method: "POST", url: "/v1/admin/feature-switches", headers,
          payload: { switch: SWITCH, enabled: true, scope: "trip", trip: "trip_stateactiv" },
        });
        assert.equal(inUse.statusCode, 409);
        assert.equal(JSON.parse(inUse.body).error, "TRIP_IN_USE");
        const allTrips = await app.inject({
          method: "POST", url: "/v1/admin/feature-switches", headers,
          payload: { switch: SWITCH, enabled: true, scope: "all_trips" },
        });
        assert.equal(allTrips.statusCode, 409);
        assert.equal(JSON.parse(allTrips.body).error, "LIVE_REQUIRED");
        const bad = await app.inject({
          method: "POST", url: "/v1/admin/feature-switches", headers,
          payload: { switch: SWITCH, enabled: "yes", scope: "trip", trip: TRIP_A },
        });
        assert.equal(bad.statusCode, 400);
        const noBody = await app.inject({ method: "POST", url: "/v1/admin/feature-switches", headers });
        assert.equal(noBody.statusCode, 400);
        const live = await app.inject({
          method: "POST", url: "/v1/admin/feature-switches", headers,
          payload: { switch: SWITCH, enabled: true, scope: "trip", trip: "trip_stateactiv", live: true },
        });
        assert.equal(live.statusCode, 200);
      } finally {
        await app.close();
      }
    });
  });
});
