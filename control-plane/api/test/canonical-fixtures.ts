// Loader for the shared canonical fixtures. Deliberately not named *.test.ts:
// it is imported by both canonical.test.ts and migrations.test.ts, and the
// runner's test/*.test.ts glob would otherwise register those files' tests
// twice.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const fixturesPath = fileURLToPath(
  new URL("../../contracts/v1/canonical-fixtures.json", import.meta.url),
);

export interface CanonicalFixture {
  label: string;
  document: unknown;
}

export interface CanonicalFixtures {
  unsafe: CanonicalFixture[];
  safe: CanonicalFixture[];
}

export async function loadCanonicalFixtures(): Promise<CanonicalFixtures> {
  return JSON.parse(await readFile(fixturesPath, "utf8")) as CanonicalFixtures;
}
