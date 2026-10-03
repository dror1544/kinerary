/**
 * The one place a test is allowed to learn which database it may destroy.
 *
 * Every DB-backed suite in this package opens with:
 *
 *     DROP SCHEMA IF EXISTS control_plane CASCADE
 *
 * which is correct for a scratch database and catastrophic for any other. On
 * 2026-09-06 `CONTROL_PLANE_TEST_DATABASE_URL` was pointed at
 * `control_plane_database_url_host` — the dev stack's OWN database, reached
 * through the host port rather than the compose network — and the suite wiped
 * the running control plane. The tests passed. Nothing warned. The stack was
 * only found broken afterwards, by its own readiness probe failing with 42P01.
 *
 * The convention that would have prevented it was already written down
 * (`docs/sprint5-trip-bot-router-design.md`: "tests drop and recreate the
 * schema, so point CONTROL_PLANE_TEST_DATABASE_URL at a scratch database").
 * A convention that only exists in prose is one every reader has to remember;
 * this module makes it a precondition instead, checked at the source rather
 * than at 25 call sites that would each have to remember to check.
 *
 * The rule is deliberately crude — the database NAME must say it is for tests
 * — because the failure it guards is crude. A subtler rule (is this port the
 * dev stack's? is this host local?) would have more ways to be wrong, and the
 * cost of being wrong here is the whole database.
 *
 * `testDatabaseUrl()` alone only closes half the hazard (#203). It refuses an
 * UNSAFE url, but an UNSET one quietly returns `undefined` — correct for the
 * "no database configured, skip the DB suites" case, but only correct as long
 * as every call site remembers to gate its block on that being falsy before
 * building a `pg.Pool` from it. One block forgot (`organizer-trips.test.ts`,
 * fixed 2026-09-25): with no env var set, `new pg.Pool({ connectionString:
 * undefined })` still ran, under the `pg` driver's own defaults — localhost,
 * or whatever `PG*` variables the shell happened to hold — and its fixture's
 * first statement is the same `DROP SCHEMA ... CASCADE`. `testPool()` below
 * is the fix: the one place a test is allowed to BUILD the pool, and it
 * throws immediately rather than silently falling through to the driver's
 * defaults when there is no safe URL. A test that calls it without being
 * skip-gated now fails loudly instead of connecting to localhost:5432.
 */
import pg from "pg";

/** Names a database may have before this package will drop schemas in it. */
const TEST_NAME_PATTERN = /test/i;

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTestDatabaseError";
  }
}

/**
 * The database name in a Postgres connection string, or null if there is none.
 *
 * Kept separate so the naming rule can be tested without constructing URLs
 * that look like credentials.
 */
export function databaseNameOf(connectionString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return null;
  }
  const name = parsed.pathname.replace(/^\//, "");
  return name === "" ? null : decodeURIComponent(name);
}

/** Whether a connection string names a database this package may destroy. */
export function isTestDatabaseUrl(connectionString: string): boolean {
  const name = databaseNameOf(connectionString);
  return name !== null && TEST_NAME_PATTERN.test(name);
}

/**
 * The database URL for destructive suites, or `undefined` when none is set.
 *
 * Unset stays a SKIP — running the unit subset with no database is a normal,
 * supported state. Set-but-unsafe is a THROW, loudly and before any test runs:
 * a skip would hide the misconfiguration, and the next person would point it
 * at their stack too.
 */
export function testDatabaseUrl(
  raw: string | undefined = process.env.CONTROL_PLANE_TEST_DATABASE_URL,
): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  if (isTestDatabaseUrl(value)) return value;

  const name = databaseNameOf(value);
  throw new UnsafeTestDatabaseError(
    [
      `CONTROL_PLANE_TEST_DATABASE_URL names ${name ? `the database "${name}"` : "no database"},`,
      `which does not look like a scratch database.`,
      ``,
      `These suites begin by dropping the control_plane schema, so pointing them`,
      `at a real database destroys it. The dev stack's own database is exactly`,
      `the mistake this catches.`,
      ``,
      `Use the scratch database instead:`,
      `  CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest"`,
      ``,
      `Or leave it unset to run the unit subset only.`,
    ].join("\n"),
  );
}

/**
 * Builds the `pg.Pool` a destructive suite runs its fixture through — the one
 * place in this package's tests allowed to call `new pg.Pool(...)`.
 *
 * It throws, rather than returning a pool pointed at the driver's defaults,
 * when there is no safe URL: `testDatabaseUrl()` already throws for a SET but
 * unsafe one, and this adds the missing half — an UNSET one no longer lets a
 * forgotten `{ skip: SKIP }` fall through into `new pg.Pool({ connectionString:
 * undefined })`, which is exactly how `organizer-trips.test.ts` nearly dropped
 * a schema with no test database configured at all (fixed 2026-09-25; see the
 * module comment above). A caller still has to skip-gate its test or describe
 * block — this does not make that unnecessary, it makes forgetting it loud
 * instead of silent: the block would now throw on the first line instead of
 * connecting to whatever Postgres the shell's `PG*` variables or localhost:5432
 * happen to reach.
 *
 * `options` is anything `pg.Pool` accepts other than `connectionString`,
 * which always comes from the guarded URL.
 */
export function testPool(options: Omit<pg.PoolConfig, "connectionString"> = {}): pg.Pool {
  const connectionString = testDatabaseUrl();
  if (!connectionString) {
    throw new UnsafeTestDatabaseError(
      [
        `testPool() was called with no CONTROL_PLANE_TEST_DATABASE_URL set.`,
        ``,
        `A DB-backed test must be gated — \`{ skip: SKIP }\` on the test, or`,
        `\`{ skip: SKIP }\` on its enclosing describe — so this function is never`,
        `reached when there is no scratch database. Reaching here unguarded is`,
        `the exact hazard #203 audited: the old pattern (\`new pg.Pool({`,
        `connectionString: databaseUrl })\` with no gate) would have silently`,
        `built a pool from the \`pg\` driver's own defaults instead of failing.`,
        ``,
        `Either set CONTROL_PLANE_TEST_DATABASE_URL to a scratch database:`,
        `  CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest"`,
        `or make sure the test/describe calling this is skip-gated on the same`,
        `condition (\`!testDatabaseUrl()\`).`,
      ].join("\n"),
    );
  }
  return new pg.Pool({ ...options, connectionString });
}
