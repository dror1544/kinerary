import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function reset(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

test("fresh and upgrade migrations succeed on PostgreSQL", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await client.query(`CREATE TABLE public.control_plane_schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(await readFile(`${migrationsDir}/0001_foundation.sql`, "utf8"));
    await client.query("INSERT INTO public.control_plane_schema_migrations(version) VALUES ('0001_foundation.sql')");
    assert.deepEqual(await applyMigrations(client, migrationsDir), ["0002_canonical_guardrails.sql"]);
    assert.deepEqual(await applyMigrations(client, migrationsDir), []);
    const tables = await client.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'control_plane'");
    assert.equal(tables.rows[0].count >= 18, true);
    await reset(client);
    assert.deepEqual(await applyMigrations(client, migrationsDir), ["0001_foundation.sql", "0002_canonical_guardrails.sql"]);
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("failed jobs are durable without a resource side effect", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    await client.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ('user_abcdefgh','active','Test')");
    await client.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ('trip_abcdefgh','japan-demo','planned')");
    await client.query("INSERT INTO control_plane.plans(id,trip_id,kind,digest,status) VALUES ('plan_abcdefgh','trip_abcdefgh','provision',$1,'approved')", [`sha256:${"a".repeat(64)}`]);
    await client.query("INSERT INTO control_plane.jobs(id,trip_id,plan_id,job_type,idempotency_key,correlation_id,state,safe_error_code) VALUES ('job_abcdefgh','trip_abcdefgh','plan_abcdefgh','provision','provision-japan-v1','corr_abcdefgh','failed','CONTROLLED_PROVIDER_FAILURE')");
    const job = await client.query("SELECT state,safe_error_code FROM control_plane.jobs WHERE id='job_abcdefgh'");
    const resources = await client.query("SELECT count(*)::int AS count FROM control_plane.resources");
    assert.deepEqual(job.rows[0], { state: "failed", safe_error_code: "CONTROLLED_PROVIDER_FAILURE" });
    assert.equal(resources.rows[0].count, 0);
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("database guardrails reject secrets, private addressing and unlabelled test resources", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    await client.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ('trip_abcdefgh','japan-demo','draft')");
    await assert.rejects(client.query("INSERT INTO control_plane.resources(id,trip_id,provider,resource_type,provider_resource_ref,environment,state) VALUES ('res_abcdefgh','trip_abcdefgh','fake','runtime','prv_abcdefgh','test','planned')"));
    await assert.rejects(client.query("INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_abcdefgh','trip_abcdefgh','provision',$1,'draft',$2::jsonb)", [`sha256:${"b".repeat(64)}`, JSON.stringify({ upstream: "192.168.1.10" })]));
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});
