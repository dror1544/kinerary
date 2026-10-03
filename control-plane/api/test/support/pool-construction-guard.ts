/**
 * The static-analysis half of #203: `testPool()` (in `test-database.ts`)
 * gives every suite a safe way to build its pool, but nothing stops a future
 * test file from writing `new pg.Pool(...)` directly instead, the way
 * `organizer-trips.test.ts` once did. This is the check that would catch it.
 *
 * It is deliberately a grep, not a parser: the hazard is a literal substring
 * in a `.ts` file, and a regex that finds it is much less likely to be wrong
 * than a second place that has opinions about what counts as "inside
 * test-database.ts" via AST analysis. `test/test-pool-factory-guard.test.ts`
 * runs this against the real `test/` directory on every `npm test`, so a
 * violation fails the suite rather than waiting for a reviewer to notice.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Matches `new pg.Pool(`, `new Pool(`, `new pg.Client(`, `new Client(`. */
const DIRECT_CONSTRUCTION = /\bnew\s+(?:pg\.)?(Pool|Client)\s*\(/;

/**
 * Files allowed to contain the pattern above, relative to `dir`: the factory,
 * this file, and the meta-test that exercises both — all three have to
 * describe or plant the pattern in prose or fixture text to do their job.
 * Every other file in `dir` is checked for real.
 */
const DEFAULT_EXEMPT = [
  join("support", "test-database.ts"),
  join("support", "pool-construction-guard.ts"),
  "test-pool-factory-guard.test.ts",
];

export interface PoolConstructionViolation {
  /** Path to the offending file, relative to the directory that was scanned. */
  file: string;
  line: number;
  text: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      yield* walk(full);
    } else if (info.isFile()) {
      yield full;
    }
  }
}

/**
 * Scans every `.ts` file under `dir` for a direct `pg.Pool`/`pg.Client`
 * construction, and returns one violation per matching line. `exempt` is a
 * list of paths relative to `dir` that are allowed to contain the pattern —
 * defaults to `support/test-database.ts` (the factory) and this file (which
 * has to describe the pattern it looks for).
 */
export function findDirectPoolConstructions(
  dir: string,
  exempt: string[] = DEFAULT_EXEMPT,
): PoolConstructionViolation[] {
  const exemptNormalized = new Set(exempt.map((e) => e.split(sep).join("/")));
  const violations: PoolConstructionViolation[] = [];
  for (const file of walk(dir)) {
    if (!file.endsWith(".ts")) continue;
    const rel = relative(dir, file).split(sep).join("/");
    if (exemptNormalized.has(rel)) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (DIRECT_CONSTRUCTION.test(line)) {
        violations.push({ file: rel, line: index + 1, text: line.trim() });
      }
    });
  }
  return violations;
}
