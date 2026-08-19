import { loadArchitectureProfile } from "./config.js";
import { createDatabasePool } from "./database.js";
import { applyMigrations, defaultMigrationsDirectory } from "./migrations.js";
import { resolveSecretRef } from "./secrets.js";

// The migration job resolves the same profile reference the API does. If it
// read CONTROL_PLANE_DATABASE_URL_FILE while the API resolved the profile, the
// two could migrate and serve different databases without either complaining.
const profilePath = process.env.CONTROL_PLANE_ARCHITECTURE_PROFILE;
if (!profilePath) throw new Error("CONTROL_PLANE_ARCHITECTURE_PROFILE is required");

const profile = await loadArchitectureProfile(profilePath);
const connectionString = await resolveSecretRef(profile.database.connection_secret_ref);
const migrationsDir = process.env.CONTROL_PLANE_MIGRATIONS_DIR
  ?? defaultMigrationsDirectory(import.meta.url);
const pool = createDatabasePool(connectionString);
const client = await pool.connect();
try {
  const applied = await applyMigrations(client, migrationsDir);
  process.stdout.write(`${JSON.stringify({ status: "ok", applied })}\n`);
} finally {
  client.release();
  await pool.end();
}
