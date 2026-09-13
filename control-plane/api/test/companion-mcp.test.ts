/**
 * companion-mcp: who is calling, and which trip it may touch.
 *
 * The two properties that make an AI runtime's write to the control plane safe
 * enough to exist: identity comes from the relay's own signed gateway token,
 * never from a header or an argument the caller writes, and the trip comes from
 * that identity's own chat bindings — no tool takes a trip id.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { gatewayFromAuthorization, renameFromCompanion, tripForCompanion } from "../src/companion-mcp.js";
import { applyMigrations } from "../src/migrations.js";
import { makeUpgradeToken } from "../src/relay/protocol.js";
import { testDatabaseUrl } from "./support/test-database.js";

const SECRET = "relay-gateway-secret-for-tests";

describe("gatewayFromAuthorization — identity is the relay's token, nothing else", () => {
  test("a token the relay would accept names its gateway", () => {
    assert.equal(gatewayFromAuthorization(`Bearer ${makeUpgradeToken("japan2026", SECRET)}`, [SECRET]), "japan2026");
  });

  test("a token signed with any other secret names nobody", () => {
    assert.equal(gatewayFromAuthorization(`Bearer ${makeUpgradeToken("japan2026", "not-the-secret")}`, [SECRET]), null);
  });

  test("no Bearer, a bare token, or garbage is refused", () => {
    const token = makeUpgradeToken("japan2026", SECRET);
    for (const header of [undefined, "", token, "Basic abc", "Bearer ", "Bearer not-a-token"]) {
      assert.equal(gatewayFromAuthorization(header, [SECRET]), null, `accepted ${JSON.stringify(header)}`);
    }
  });

  test("with no secret configured, nothing is accepted", () => {
    assert.equal(gatewayFromAuthorization(`Bearer ${makeUpgradeToken("japan2026", SECRET)}`, []), null);
  });
});

const databaseUrl = testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const hex = (n = 12) => randomBytes(n).toString("hex");

async function withDb(run: (pool: pg.Pool) => Promise<void>) {
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
    await run(pool);
  } finally {
    await pool.end();
  }
}

async function trip(pool: pg.Pool, names: string[]): Promise<string> {
  const id = `trip_${hex()}`;
  await pool.query(
    "INSERT INTO control_plane.trips (id, slug, lifecycle_state, assistant_names) VALUES ($1, $2, 'ready_private', $3)",
    [id, `trip-${hex(4)}`, names],
  );
  return id;
}

async function bind(pool: pg.Pool, tripId: string, profile: string, chatId = `-100${Date.now()}${hex(2)}`) {
  await pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, $4)",
    [`tcb_${hex()}`, chatId, tripId, profile],
  );
}

describe("the trip a companion may rename is its own", { skip: !databaseUrl }, () => {
  test("a profile bound to one trip resolves to that trip", async () => {
    await withDb(async (pool) => {
      const id = await trip(pool, ["Rio"]);
      await bind(pool, id, "japan2026");
      assert.deepEqual(await tripForCompanion(pool, "japan2026"), { ok: true, tripId: id });
    });
  });

  test("a profile bound to nothing, or to two trips, is refused", async () => {
    await withDb(async (pool) => {
      assert.deepEqual(await tripForCompanion(pool, "nobody"), { ok: false, reason: "NO_TRIP" });
      await bind(pool, await trip(pool, ["A1"]), "shared");
      await bind(pool, await trip(pool, ["B1"]), "shared");
      assert.deepEqual(await tripForCompanion(pool, "shared"), { ok: false, reason: "AMBIGUOUS_TRIP" });
    });
  });

  test("a rename changes the caller's trip and leaves every other family's alone", async () => {
    await withDb(async (pool) => {
      const mine = await trip(pool, ["סולומון"]);
      const theirs = await trip(pool, ["Luca"]);
      await bind(pool, mine, "japan2026");
      await bind(pool, theirs, "italy2026");

      assert.deepEqual(await renameFromCompanion(pool, "japan2026", ["סולו", "Solo"]), { ok: true, names: ["סולו", "Solo"] });
      const { rows } = await pool.query("SELECT id, assistant_names FROM control_plane.trips ORDER BY id");
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.assistant_names]));
      assert.deepEqual(byId[mine], ["סולו", "Solo"]);
      assert.deepEqual(byId[theirs], ["Luca"], "another trip's names are untouched");
    });
  });

  test("a refused name writes nothing", async () => {
    await withDb(async (pool) => {
      const mine = await trip(pool, ["Rio"]);
      await bind(pool, mine, "japan2026");
      assert.deepEqual(await renameFromCompanion(pool, "japan2026", ["@evil"]), { ok: false, reason: "INVALID" });
      const { rows } = await pool.query("SELECT assistant_names FROM control_plane.trips WHERE id = $1", [mine]);
      assert.deepEqual(rows[0].assistant_names, ["Rio"]);
    });
  });
});
