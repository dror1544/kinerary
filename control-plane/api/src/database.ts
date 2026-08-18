import { readFile } from "node:fs/promises";
import pg from "pg";

export async function readRequiredSecretFile(path: string | undefined, name: string): Promise<string> {
  if (!path) throw new Error(`${name}_FILE is required`);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${name}_FILE is empty`);
  return value;
}

export function createDatabasePool(connectionString: string, onIdleError: () => void = () => {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  // node-postgres emits idle-client errors on the Pool EventEmitter. Without a
  // listener Node treats them as unhandled "error" events and exits.
  pool.on("error", () => onIdleError());
  return pool;
}

export async function databaseReadiness(pool: pg.Pool): Promise<Record<string, unknown>> {
  const result = await pool.query(`
    SELECT count(*)::int AS migration_count
    FROM public.control_plane_schema_migrations
  `);
  return { database: "ready", schema_migrations: result.rows[0].migration_count };
}
