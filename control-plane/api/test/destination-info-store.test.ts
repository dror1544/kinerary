import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import {
  destinationsNeedingInfo,
  readDestinationInfo,
  refreshStaleDestinationInfo,
  writeDestinationInfo,
} from "../src/destination-info-store.js";
import type { DestinationInfo, DestinationInfoResult } from "../src/destination-info.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
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

/** A consular row, the way lookup_consular_contacts writes one. `infoAgeDays`
 * = null leaves destination_info_fetched_at NULL, which is what a row inserted
 * by the consular path actually looks like. */
async function seedRow(
  pool: pg.Pool,
  destination: string,
  home: string,
  infoAgeDays: number | null = null,
) {
  await pool.query(
    `INSERT INTO control_plane.country_reference
       (destination_country, home_country, contacts, source, destination_info_fetched_at)
     VALUES ($1, $2, '[]'::jsonb, 'test',
             CASE WHEN $3::text IS NULL THEN NULL ELSE now() - ($3 || ' days')::interval END)`,
    [destination, home, infoAgeDays === null ? null : String(infoAgeDays)],
  );
}

const INFO: DestinationInfo = {
  health: [{ he: "מי הברז ראויים לשתייה", en: "Tap water is safe to drink" }],
  money: [{ he: "מזומן עדיין נפוץ", en: "Cash is still widely used" }],
  communication: [{ he: "eSIM זמין", en: "eSIM is available" }],
};

function runnerReturning(info: DestinationInfo, seen: string[] = []) {
  return async (destination: string): Promise<DestinationInfoResult> => {
    seen.push(destination);
    return { ok: true, info, warnings: [] };
  };
}

test("one lookup fans out to every home-country row for the destination", { skip }, async () => {
  // The brief's acceptance case: two home countries sharing a destination. The
  // duplication is accepted; recomputing per pairing is not. One model call,
  // one UPDATE, both rows carrying the same value and the same timestamp.
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel");
    await seedRow(pool, "japan", "united states");
    await seedRow(pool, "italy", "israel");

    const seen: string[] = [];
    const summary = await refreshStaleDestinationInfo(pool, runnerReturning(INFO, seen));

    assert.equal(seen.filter((d) => d === "japan").length, 1, "japan looked up exactly once");
    assert.equal(summary.refreshed, 2, "two destinations refreshed");
    assert.equal(summary.rowsWritten, 3, "three rows written from two lookups");

    const { rows } = await pool.query(
      `SELECT home_country, destination_info, destination_info_source, destination_info_fetched_at
         FROM control_plane.country_reference
        WHERE destination_country = 'japan' ORDER BY home_country`,
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(row.destination_info, INFO);
      assert.ok(row.destination_info_fetched_at, "fetched_at was stamped");
      assert.ok(String(row.destination_info_source).startsWith("hermes:"));
    }
    assert.deepEqual(rows[0].destination_info, rows[1].destination_info);
  });
});

test("the destination-info clock is separate from the consular clock", { skip }, async () => {
  // fetched_at drives consularContactsFor's 180-day staleness test. Refreshing
  // prose through it would re-date embassy phone numbers as freshly verified
  // when nothing verified them.
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel");
    const before = await pool.query("SELECT fetched_at FROM control_plane.country_reference");
    await refreshStaleDestinationInfo(pool, runnerReturning(INFO));
    const after = await pool.query(
      "SELECT fetched_at, destination_info_fetched_at FROM control_plane.country_reference",
    );
    assert.deepEqual(after.rows[0].fetched_at, before.rows[0].fetched_at, "consular clock untouched");
    assert.ok(after.rows[0].destination_info_fetched_at);
  });
});

test("a new home-country row for an already-cached destination is picked up", { skip }, async () => {
  // THE min() TRAP. SQL's min() skips nulls, so a destination with one fresh
  // row and one brand-new null row has a recent min() and `min() IS NULL` is
  // false — it would never be selected, and the new pairing would stay empty
  // forever while the job reported itself healthy. bool_or catches it.
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel", 1); // fresh
    await seedRow(pool, "japan", "united states", null); // just inserted, no info

    assert.deepEqual(await destinationsNeedingInfo(pool), ["japan"]);

    await refreshStaleDestinationInfo(pool, runnerReturning(INFO));
    const { rows } = await pool.query(
      `SELECT destination_info FROM control_plane.country_reference
        WHERE destination_country = 'japan' AND home_country = 'united states'`,
    );
    assert.deepEqual(rows[0].destination_info, INFO, "the new pairing converged on the cached value");
  });
});

test("a destination refreshed this month is left alone", { skip }, async () => {
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel", 3);
    assert.deepEqual(await destinationsNeedingInfo(pool), []);
    const summary = await refreshStaleDestinationInfo(pool, runnerReturning(INFO));
    assert.equal(summary.considered, 0);
  });
});

test("a destination older than a month is re-verified", { skip }, async () => {
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel", 45);
    assert.deepEqual(await destinationsNeedingInfo(pool), ["japan"]);
  });
});

test("a rate limit leaves the clock alone so the next pass retries", { skip }, async () => {
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel", 45);
    const summary = await refreshStaleDestinationInfo(pool, async () => ({
      ok: false as const,
      reason: "RATE_LIMITED" as const,
    }));
    assert.equal(summary.rateLimited, 1);
    assert.equal(summary.refreshed, 0);
    // Still selected: stamping the clock on a failure would mark the row
    // "verified this month" when nothing verified it.
    assert.deepEqual(await destinationsNeedingInfo(pool), ["japan"]);
  });
});

test("a throwing lookup is counted as failed, not propagated", { skip }, async () => {
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel", 45);
    const summary = await refreshStaleDestinationInfo(pool, async () => {
      throw new Error("hermes on fire");
    });
    assert.equal(summary.failed, 1);
    assert.deepEqual(await destinationsNeedingInfo(pool), ["japan"]);
  });
});

test("an empty model answer is not written over a previously good row", { skip }, async () => {
  await withDb(async (pool) => {
    await seedRow(pool, "japan", "israel", 45);
    await writeDestinationInfo(pool, "japan", INFO, "hermes:search");
    const summary = await refreshStaleDestinationInfo(pool, async () => ({
      ok: true as const,
      info: { health: [], money: [], communication: [] },
      warnings: [],
    }), () => {}, 0);
    assert.equal(summary.failed, 1);
    const cached = await readDestinationInfo(pool, "japan");
    assert.deepEqual(cached?.info, INFO, "the good row survived an empty answer");
  });
});

test("readDestinationInfo answers the worker's provision-time read", { skip }, async () => {
  await withDb(async (pool) => {
    assert.equal(await readDestinationInfo(pool, "japan"), null, "a miss is null, not an empty shape");
    await seedRow(pool, "japan", "israel");
    // A row with NULL destination_info_fetched_at has never been filled and
    // must read as a miss, not as three empty lists.
    assert.equal(await readDestinationInfo(pool, "japan"), null);
    await writeDestinationInfo(pool, "japan", INFO, "hermes:search");
    const cached = await readDestinationInfo(pool, "JAPAN  ");
    assert.deepEqual(cached?.info, INFO, "the destination key is normalised on read");
  });
});

test("writing a destination with no rows reports zero rather than succeeding", { skip }, async () => {
  await withDb(async (pool) => {
    assert.equal(await writeDestinationInfo(pool, "narnia", INFO, "hermes:search"), 0);
  });
});

/**
 * WHY THIS TEST EXISTS. `readDestinationInfo` has no production caller in this
 * package — review on #156 asked whether it was dead code. It is not: it is the
 * reference implementation of a read that really happens, in Python, inside a
 * closure in the worker's entry point that has no test harness of its own. This
 * test is what makes that claim true instead of merely written down, and what
 * makes the function non-dead: it is the caller.
 *
 * Each fragment below fails SILENTLY if only one side changes — a thin or empty
 * Info tab, never an error. Deliberately no `skip`: it needs no database, so it
 * runs even in the unit subset, which is where a careless SQL edit is most
 * likely to be made and least likely to be noticed.
 */
const WORKER_LOOKUP = fileURLToPath(
  new URL("../../worker/control_plane_worker/__main__.py", import.meta.url),
);

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").toLowerCase();

test("the worker's provision-time read matches this module's reference implementation", async () => {
  const worker = oneLine(await readFile(WORKER_LOOKUP, "utf8"));
  const store = oneLine(await readFile(fileURLToPath(new URL("../src/destination-info-store.ts", import.meta.url)), "utf8"));

  // The file is read by path; a move or rename would make every assertion below
  // vacuously true against an empty string, so prove we found the right file.
  assert.ok(
    worker.includes("_destination_info_lookup"),
    `${WORKER_LOOKUP} no longer defines _destination_info_lookup — this test is checking the wrong file`,
  );

  const shared: Array<[string, string]> = [
    [
      "destination_info_fetched_at is not null",
      "without it, a row the consular path inserted but the refresh has never filled reads as three EMPTY lists instead of a miss",
    ],
    [
      "order by destination_info_fetched_at desc",
      "which duplicate wins while a fan-out is interrupted partway",
    ],
    ["limit 1", "one destination, one answer"],
    ["from control_plane.country_reference", "both must read the same table"],
  ];

  for (const [fragment, why] of shared) {
    assert.ok(store.includes(fragment), `destination-info-store.ts lost "${fragment}" — ${why}`);
    assert.ok(
      worker.includes(fragment),
      `__main__.py's _destination_info_lookup lost "${fragment}" — ${why}. ` +
        `The two reads must stay identical; change both or neither.`,
    );
  }
});
