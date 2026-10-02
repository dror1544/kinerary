import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  databaseNameOf,
  isTestDatabaseUrl,
  testDatabaseUrl,
  testPool,
  UnsafeTestDatabaseError,
} from "./support/test-database.js";

describe("test database guard", () => {
  test("accepts the documented scratch database", () => {
    // CLAUDE.md, "The control-plane DB suites destroy the database they are given" — the URL every DB suite should use.
    assert.equal(testDatabaseUrl("postgres://postgres:test@127.0.0.1:5434/cptest"), "postgres://postgres:test@127.0.0.1:5434/cptest");
  });

  test("refuses the dev stack's own database — the 2026-09-06 incident", () => {
    // This exact string is what wiped the running control plane. It must never
    // be accepted again, whichever port or host it arrives on.
    const dangerous = [
      "postgresql://kinerary_control_plane:pw@127.0.0.1:5433/kinerary_control_plane",
      "postgresql://kinerary_control_plane:pw@postgres:5432/kinerary_control_plane",
    ];
    for (const url of dangerous) {
      assert.throws(() => testDatabaseUrl(url), UnsafeTestDatabaseError, url);
    }
  });

  test("the refusal says what to use instead", () => {
    // A guard that only says "no" gets worked around. This one has to hand the
    // reader the correct URL, or the next person edits the guard.
    try {
      testDatabaseUrl("postgresql://u:p@127.0.0.1:5433/kinerary_control_plane");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof UnsafeTestDatabaseError);
      assert.match(error.message, /cptest/);
      assert.match(error.message, /kinerary_control_plane/);
    }
  });

  test("unset stays a skip, not a failure", () => {
    // Running the unit subset with no database is a supported state, and
    // turning it into an error would make the common case the loud one.
    //
    // The env var has to be cleared for this: `testDatabaseUrl()` defaults its
    // argument to `process.env.CONTROL_PLANE_TEST_DATABASE_URL`, so passing
    // `undefined` explicitly reads the environment rather than bypassing it —
    // which is exactly what this suite runs under.
    const saved = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
    try {
      delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      assert.equal(testDatabaseUrl(), undefined);
      assert.equal(testDatabaseUrl(undefined), undefined);
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      else process.env.CONTROL_PLANE_TEST_DATABASE_URL = saved;
    }
    // These need no environment: an explicit empty value is empty either way.
    assert.equal(testDatabaseUrl(""), undefined);
    assert.equal(testDatabaseUrl("   "), undefined);
  });

  test("reads the environment when given no argument", () => {
    // The path every suite actually uses.
    const saved = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
    try {
      process.env.CONTROL_PLANE_TEST_DATABASE_URL = "postgres://h:1/cptest";
      assert.equal(testDatabaseUrl(), "postgres://h:1/cptest");
      process.env.CONTROL_PLANE_TEST_DATABASE_URL = "postgres://h:1/kinerary_control_plane";
      assert.throws(() => testDatabaseUrl(), UnsafeTestDatabaseError);
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      else process.env.CONTROL_PLANE_TEST_DATABASE_URL = saved;
    }
  });

  test("a name that merely contains 'test' is enough, in either convention", () => {
    assert.equal(isTestDatabaseUrl("postgres://h/cptest"), true);
    assert.equal(isTestDatabaseUrl("postgres://h/kinerary_control_plane_test"), true);
    assert.equal(isTestDatabaseUrl("postgres://h/TEST_DB"), true);
    assert.equal(isTestDatabaseUrl("postgres://h/my-test-db"), true);
  });

  test("fails closed on anything it cannot read a database name from", () => {
    // Unparseable, or a URL with no database path. Guessing that these are
    // safe is the one answer that could destroy something.
    assert.equal(databaseNameOf("not a url"), null);
    assert.equal(databaseNameOf("postgres://host:5432"), null);
    assert.throws(() => testDatabaseUrl("not a url"), UnsafeTestDatabaseError);
    assert.throws(() => testDatabaseUrl("postgres://host:5432"), UnsafeTestDatabaseError);
  });
});

describe("testPool() (#203)", () => {
  // testPool() reads CONTROL_PLANE_TEST_DATABASE_URL through testDatabaseUrl()
  // itself, the same as every other call in this file — these tests only
  // control that one env var, never a connection.
  test("throws, rather than building a pool from the driver's defaults, when no safe URL is configured", () => {
    // This is the hazard #203 audited: the old call sites built their own
    // pool directly, from a connection string that could be undefined, and
    // relied on every test/describe remembering its own `{ skip: SKIP }`
    // gate. One forgot (organizer-trips.test.ts, fixed 2026-09-25).
    // testPool() closes that path at the source — calling it unguarded now
    // throws instead of silently reaching for localhost:5432 or whatever
    // PG* the shell holds.
    const saved = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
    try {
      delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      assert.throws(() => testPool(), UnsafeTestDatabaseError);
      try {
        testPool();
        assert.fail("expected a throw");
      } catch (error) {
        assert.ok(error instanceof UnsafeTestDatabaseError);
        assert.match((error as Error).message, /no CONTROL_PLANE_TEST_DATABASE_URL set/);
        assert.match((error as Error).message, /skip/i);
      }
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      else process.env.CONTROL_PLANE_TEST_DATABASE_URL = saved;
    }
  });

  test("throws the same way testDatabaseUrl() does when the URL is set but unsafe", () => {
    const saved = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
    try {
      process.env.CONTROL_PLANE_TEST_DATABASE_URL = "postgresql://u:p@127.0.0.1:5433/kinerary_control_plane";
      assert.throws(() => testPool(), UnsafeTestDatabaseError);
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      else process.env.CONTROL_PLANE_TEST_DATABASE_URL = saved;
    }
  });

  test("builds a real pg.Pool, carrying extra options through, when the URL is safe", () => {
    const saved = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
    try {
      process.env.CONTROL_PLANE_TEST_DATABASE_URL = "postgres://postgres:test@127.0.0.1:5434/cptest";
      const pool = testPool({ max: 3 });
      try {
        assert.equal(pool.options.max, 3);
        assert.equal(pool.options.connectionString, "postgres://postgres:test@127.0.0.1:5434/cptest");
      } finally {
        // No connection was ever made — .end() on an unused pool is a no-op.
        void pool.end();
      }
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_TEST_DATABASE_URL;
      else process.env.CONTROL_PLANE_TEST_DATABASE_URL = saved;
    }
  });
});
