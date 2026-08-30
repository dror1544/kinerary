import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { resolvePendingVenueLinks } from "../src/venue-links.js";
import type { VenueUrlSearch } from "../src/itinerary-extract.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function resetDb(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

async function withDb(fn: (pool: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();
    await fn(pool);
  } finally {
    const c = await pool.connect();
    await resetDb(c);
    c.release();
    await pool.end();
  }
}

async function park(pool: pg.Pool, destination: string, name: string) {
  await pool.query(
    `INSERT INTO control_plane.venue_links (destination, venue_name, url, source)
     VALUES ($1, $2, NULL, 'deferred')`,
    [destination, name],
  );
}

async function rowFor(pool: pg.Pool, destination: string, name: string) {
  const { rows } = await pool.query(
    "SELECT url, source, attempts FROM control_plane.venue_links WHERE destination = $1 AND venue_name = $2",
    [destination, name],
  );
  return rows[0] as { url: string | null; source: string | null; attempts: number };
}

const found = (map: Record<string, string>): (() => Promise<VenueUrlSearch>) =>
  async () => ({ ok: true, urls: new Map(Object.entries(map)) });

test("a parked row the search resolves gets its url + cron-retry source", { skip }, async () => {
  await withDb(async (pool) => {
    await park(pool, "japan", "tokyo skytree");
    const resolved = await resolvePendingVenueLinks(pool, found({ "tokyo skytree": "https://skytree.example" }));
    assert.equal(resolved, 1);
    const row = await rowFor(pool, "japan", "tokyo skytree");
    assert.equal(row.url, "https://skytree.example");
    assert.equal(row.source, "cron-retry");
    assert.equal(row.attempts, 1);
  });
});

test("a rate-limited pass leaves the row for the next tick — no attempt spent", { skip }, async () => {
  await withDb(async (pool) => {
    await park(pool, "japan", "teamlab planets");
    const search = async (): Promise<VenueUrlSearch> => ({ ok: false, rateLimited: true });
    const resolved = await resolvePendingVenueLinks(pool, search);
    assert.equal(resolved, 0);
    const row = await rowFor(pool, "japan", "teamlab planets");
    assert.equal(row.url, null);
    assert.equal(row.attempts, 0);
  });
});

test("a name with no findable url ages out after the attempt cap", { skip }, async () => {
  await withDb(async (pool) => {
    await park(pool, "japan", "obscure alley");
    const search = found({}); // ok, but never returns this name
    for (let i = 0; i < 8; i++) await resolvePendingVenueLinks(pool, search);
    const row = await rowFor(pool, "japan", "obscure alley");
    assert.equal(row.url, null);
    assert.equal(row.attempts, 6, "stops being picked up once attempts hits MAX_ATTEMPTS (6)");
  });
});

test("a non-rate-limit search failure still counts an attempt", { skip }, async () => {
  await withDb(async (pool) => {
    await park(pool, "japan", "kyoto tower");
    const search = async (): Promise<VenueUrlSearch> => ({ ok: false, rateLimited: false });
    await resolvePendingVenueLinks(pool, search);
    const row = await rowFor(pool, "japan", "kyoto tower");
    assert.equal(row.attempts, 1);
    assert.equal(row.url, null);
  });
});

test("an already-resolved row is not re-searched", { skip }, async () => {
  await withDb(async (pool) => {
    await pool.query(
      `INSERT INTO control_plane.venue_links (destination, venue_name, url, source)
       VALUES ('japan', 'fushimi inari', 'https://inari.example', 'interview-web-search')`,
    );
    let called = false;
    const search = async (): Promise<VenueUrlSearch> => { called = true; return { ok: true, urls: new Map() }; };
    const resolved = await resolvePendingVenueLinks(pool, search);
    assert.equal(resolved, 0);
    assert.equal(called, false);
    const row = await rowFor(pool, "japan", "fushimi inari");
    assert.equal(row.url, "https://inari.example");
    assert.equal(row.attempts, 0);
  });
});
