/**
 * Migration 20261117120000_owner_access_backfill.sql: owners created before signup.ts and organizer-invite.ts set
 * dashboard_access/runtime_access held both flags false and could not open their own trip. The backfill repairs
 * exactly those rows and nothing else.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const MIGRATION = "20261117120000_owner_access_backfill.sql";

const opaque = (prefix: string, u: string) => `${prefix}_${u.replace(/_/g, "")}0000`;

async function reset(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

test("the owner-access backfill flips active f/f owners only, and a rerun changes nothing", { skip }, async () => {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);

    await client.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ('trip_oab00001', 'oab-1', 'draft')");
    const users = ["owner_ff", "owner_ft", "owner_tf", "owner_tt", "owner_ended", "org_ft", "org_ff", "member_ff", "member_tt"];
    for (const u of users) {
      await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $1)", [opaque("user", u)]);
    }
    const rows: Array<[string, string, string, boolean, boolean]> = [
      // user, role, status, dashboard, runtime
      ["owner_ff", "owner", "active", false, false],   // the bug: must become t/t
      ["owner_ft", "owner", "active", false, true],    // deliberate partial: untouched
      ["owner_tf", "owner", "active", true, false],    // deliberate partial: untouched
      ["owner_tt", "owner", "active", true, true],     // already right
      ["owner_ended", "owner", "revoked", false, false], // not active: untouched
      ["org_ft", "organizer", "active", false, true],  // secondary organizer: untouched
      ["org_ff", "organizer", "active", false, false], // not an owner: untouched
      ["member_ff", "member", "active", false, false], // member: untouched
      ["member_tt", "member", "active", false, true],
    ];
    for (const [u, role, status, d, r] of rows) {
      await client.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access) VALUES ($1, 'trip_oab00001', $2, $3, $4, $5, $6)",
        [opaque("memb", u), opaque("user", u), role, status, d, r],
      );
    }
    const snapshot = async () => (await client.query(
      "SELECT user_id, role, status, dashboard_access d, runtime_access r FROM control_plane.trip_memberships ORDER BY user_id")).rows;
    const before = await snapshot();

    // Run it through the real runner: forget that it was applied, then apply.
    await client.query("DELETE FROM public.control_plane_schema_migrations WHERE version = $1", [MIGRATION]);
    assert.deepEqual(await applyMigrations(client, migrationsDir), [MIGRATION]);
    const after = await snapshot();

    const changed = after.filter((row, i) => row.d !== before[i]!.d || row.r !== before[i]!.r);
    assert.deepEqual(changed, [{ user_id: opaque("user", "owner_ff"), role: "owner", status: "active", d: true, r: true }]);

    // Rerun is a no-op.
    await client.query("DELETE FROM public.control_plane_schema_migrations WHERE version = $1", [MIGRATION]);
    assert.deepEqual(await applyMigrations(client, migrationsDir), [MIGRATION]);
    assert.deepEqual(await snapshot(), after);
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});
