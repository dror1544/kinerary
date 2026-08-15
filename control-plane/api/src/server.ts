import { buildApp } from "./app.js";
import { loadArchitectureProfile } from "./config.js";
import { createDatabasePool, databaseReadiness, readRequiredSecretFile } from "./database.js";

const profilePath = process.env.CONTROL_PLANE_ARCHITECTURE_PROFILE;
if (!profilePath) throw new Error("CONTROL_PLANE_ARCHITECTURE_PROFILE is required");

const profile = await loadArchitectureProfile(profilePath);
const connectionString = await readRequiredSecretFile(
  process.env.CONTROL_PLANE_DATABASE_URL_FILE,
  "CONTROL_PLANE_DATABASE_URL",
);
const pool = createDatabasePool(connectionString);
const app = buildApp(profile, {
  readiness: () => databaseReadiness(pool),
  close: () => pool.end(),
});
await app.listen({ host: profile.public_api.bind_host, port: profile.public_api.port });
