import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRequiredSecretFile } from "../src/database.js";

test("database credentials are read from a non-empty secret file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-"));
  const path = join(directory, "database-url");
  try {
    await writeFile(path, "postgresql://example.invalid/database\n", { mode: 0o600 });
    assert.equal(await readRequiredSecretFile(path, "CONTROL_PLANE_DATABASE_URL"), "postgresql://example.invalid/database");
    await writeFile(path, "\n", { mode: 0o600 });
    await assert.rejects(readRequiredSecretFile(path, "CONTROL_PLANE_DATABASE_URL"), /is empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
