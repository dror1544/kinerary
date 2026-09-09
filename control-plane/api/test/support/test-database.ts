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
 */

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
