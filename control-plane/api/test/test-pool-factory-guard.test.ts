/**
 * #203: a DB test that builds its own `pg.Pool` instead of going through
 * `testPool()` (`test/support/test-database.ts`) can bypass every guard that
 * function carries — exactly what happened in `organizer-trips.test.ts`
 * before it was fixed (2026-09-25). This file is the rule living in one
 * place rather than in a reviewer's memory: it runs the same check
 * `findDirectPoolConstructions` offers against this package's real `test/`
 * directory on every `npm test`, and proves separately that the check itself
 * would have caught the hazard it is named for.
 *
 * This file is itself exempt from the scan it runs (see
 * `pool-construction-guard.ts`'s `DEFAULT_EXEMPT`): proving the check works
 * means describing and planting the exact pattern it looks for, in prose and
 * in a fixture string, and neither is the hazard the check exists to catch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findDirectPoolConstructions } from "./support/pool-construction-guard.js";

const testDir = fileURLToPath(new URL(".", import.meta.url));

describe("no test file builds its own pg.Pool (#203)", () => {
  test("every DB-backed suite in test/ routes through testPool(), not new pg.Pool() directly", () => {
    const violations = findDirectPoolConstructions(testDir);
    assert.deepEqual(
      violations,
      [],
      violations.length
        ? [
            "Found a direct pg.Pool/pg.Client construction outside test/support/test-database.ts:",
            ...violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`),
            "",
            "Route it through testPool() instead (test/support/test-database.ts) — that",
            "is the one place allowed to build a pool, and the one place that throws",
            "instead of silently connecting to the pg driver's defaults when there is",
            "no safe CONTROL_PLANE_TEST_DATABASE_URL.",
          ].join("\n")
        : undefined,
    );
  });

  test("the check itself catches a pg.Pool planted outside the factory, in a scratch fixture", () => {
    // Proves findDirectPoolConstructions is not a check that passes by
    // finding nothing to look at: plant the exact shape #203 was filed
    // about and confirm it is flagged.
    const scratch = mkdtempSync(join(tmpdir(), "pool-guard-fixture-"));
    try {
      writeFileSync(
        join(scratch, "planted.test.ts"),
        [
          'import pg from "pg";',
          "",
          "describe(\"a block with no skip gate\", () => {",
          '  test("builds its own pool", async () => {',
          "    const pool = new pg.Pool({ connectionString: process.env.SOME_OTHER_VAR });",
          "  });",
          "});",
          "",
        ].join("\n"),
      );
      // A second file, clean, to prove the check does not flag everything
      // indiscriminately once there IS a violation somewhere in the tree.
      writeFileSync(
        join(scratch, "clean.test.ts"),
        ['import { testPool } from "./support/test-database.js";', "const pool = testPool();", ""].join("\n"),
      );

      const violations = findDirectPoolConstructions(scratch);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0]?.file, "planted.test.ts");
      assert.match(violations[0]?.text ?? "", /new pg\.Pool\(/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the check does not flag the factory or itself for describing the pattern they guard against", () => {
    const violations = findDirectPoolConstructions(testDir);
    const flaggedFiles = new Set(violations.map((v) => v.file));
    assert.equal(flaggedFiles.has("support/test-database.ts"), false);
    assert.equal(flaggedFiles.has("support/pool-construction-guard.ts"), false);
    assert.equal(flaggedFiles.has("test-pool-factory-guard.test.ts"), false);
  });
});
