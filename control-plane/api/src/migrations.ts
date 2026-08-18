import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { PoolClient } from "pg";

export function defaultMigrationsDirectory(moduleUrl: string): string {
  return fileURLToPath(new URL("../migrations/", moduleUrl));
}

export async function applyMigrations(client: PoolClient, migrationsDir: string): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock(hashtext('kinerary_control_plane_migrations'))");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.control_plane_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    const applied: string[] = [];
    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM public.control_plane_schema_migrations WHERE version = $1", [file]);
      if (existing.rowCount) continue;
      const sql = await readFile(resolve(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.control_plane_schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('kinerary_control_plane_migrations'))");
  }
}
