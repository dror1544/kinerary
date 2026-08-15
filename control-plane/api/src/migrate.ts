import { fileURLToPath } from "node:url";
import { createDatabasePool, readRequiredSecretFile } from "./database.js";
import { applyMigrations } from "./migrations.js";

const connectionString = await readRequiredSecretFile(
  process.env.CONTROL_PLANE_DATABASE_URL_FILE,
  "CONTROL_PLANE_DATABASE_URL",
);
const migrationsDir = process.env.CONTROL_PLANE_MIGRATIONS_DIR
  ?? fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const pool = createDatabasePool(connectionString);
const client = await pool.connect();
try {
  const applied = await applyMigrations(client, migrationsDir);
  process.stdout.write(`${JSON.stringify({ status: "ok", applied })}\n`);
} finally {
  client.release();
  await pool.end();
}
