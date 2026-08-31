import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabasePool } from "../src/database.js";
import { defaultMigrationsDirectory } from "../src/migrations.js";

// Reading the database credential is no longer a database.ts concern: both
// entrypoints resolve profile.database.connection_secret_ref through
// resolveSecretRef, so the file case is covered by secrets.test.ts alongside
// every other scheme rather than by a second, near-duplicate helper here.

test("database pools consume idle client errors instead of crashing the process", async () => {
  let observed = 0;
  const pool = createDatabasePool("postgresql://example.invalid/database", () => { observed += 1; });
  assert.equal(pool.emit("error", new Error("password=must-not-escape")), true);
  assert.equal(observed, 1);
  await pool.end();
});

test("the built migration CLI defaults to the image migration directory", () => {
  assert.equal(defaultMigrationsDirectory("file:///app/dist/migrate.js"), "/app/migrations/");
});
