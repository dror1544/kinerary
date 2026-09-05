import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isCanonicalRecordSafe } from "../src/canonical.js";
import { applyMigrations } from "../src/migrations.js";
import { loadCanonicalFixtures } from "./canonical-fixtures.js";

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
    assert.deepEqual(await applyMigrations(client, migrationsDir), [
      "0002_canonical_guardrails.sql",
      "0003_sprint0_review_hardening.sql",
      "0004_canonical_guardrail_key_matching.sql",
      "0005_opaque_id_format.sql",
      "0006_sprint1_signup.sql",
      "0007_sprint1_signup_unique_fix.sql",
      "0008_sprint2_interview.sql",
      "0009_sprint2_review.sql",
      "0010_sprint3_planner.sql",
      "0011_sprint3_review.sql",
      "0012_plans_updated_at.sql",
      "0013_sprint4.sql",
      "0014_telegram_callback_refs.sql",
      "0015_intake_versions_canonical_guard.sql",
      "0016_sprint4_seed_development_release.sql",
      "0017_telegram_chat_id.sql",
      "0018_release_accepts_intake_schema_v2.sql",
      "0019_telegram_chat_bindings.sql",
      "0020_web_portal.sql",
      "0021_password_identity.sql",
      "0021_web_password_credentials.sql",
      "0022_interview_chat_id_hint.sql",
      "0023_country_reference.sql",
      "0024_intake_source_document.sql",
      "0025_venue_links_reference.sql",
      "0026_plans_retryable_digest.sql",
      "0027_release_manifest.sql",
      "0028_interview_chat_binding.sql",
      "0029_telegram_binding_lifecycle.sql",
      "0030_trip_assistant_names.sql",
      "0031_interview_agent_turns.sql",
      "0032_release_accepts_intake_schema_v3.sql",
      "0033_router_prompt_handoff.sql",
      "0034_web_portal_addenda.sql",
      "0035_interview_ui_state.sql",
      "0036_interview_language.sql",
      "0037_interview_phase.sql",
      "0038_interview_floor.sql",
      "0039_interview_inbound_settle.sql",
    ]);
    assert.deepEqual(await applyMigrations(client, migrationsDir), []);
    const tables = await client.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'control_plane'");
    assert.equal(tables.rows[0].count >= 20, true);
    await reset(client);
    assert.deepEqual(await applyMigrations(client, migrationsDir), [
      "0001_foundation.sql",
      "0002_canonical_guardrails.sql",
      "0003_sprint0_review_hardening.sql",
      "0004_canonical_guardrail_key_matching.sql",
      "0005_opaque_id_format.sql",
      "0006_sprint1_signup.sql",
      "0007_sprint1_signup_unique_fix.sql",
      "0008_sprint2_interview.sql",
      "0009_sprint2_review.sql",
      "0010_sprint3_planner.sql",
      "0011_sprint3_review.sql",
      "0012_plans_updated_at.sql",
      "0013_sprint4.sql",
      "0014_telegram_callback_refs.sql",
      "0015_intake_versions_canonical_guard.sql",
      "0016_sprint4_seed_development_release.sql",
      "0017_telegram_chat_id.sql",
      "0018_release_accepts_intake_schema_v2.sql",
      "0019_telegram_chat_bindings.sql",
      "0020_web_portal.sql",
      "0021_password_identity.sql",
      "0021_web_password_credentials.sql",
      "0022_interview_chat_id_hint.sql",
      "0023_country_reference.sql",
      "0024_intake_source_document.sql",
      "0025_venue_links_reference.sql",
      "0026_plans_retryable_digest.sql",
      "0027_release_manifest.sql",
      "0028_interview_chat_binding.sql",
      "0029_telegram_binding_lifecycle.sql",
      "0030_trip_assistant_names.sql",
      "0031_interview_agent_turns.sql",
      "0032_release_accepts_intake_schema_v3.sql",
      "0033_router_prompt_handoff.sql",
      "0034_web_portal_addenda.sql",
      "0035_interview_ui_state.sql",
      "0036_interview_language.sql",
      "0037_interview_phase.sql",
      "0038_interview_floor.sql",
      "0039_interview_inbound_settle.sql",
    ]);
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
    await assert.rejects(client.query("INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_secret01','trip_abcdefgh','provision',$1,'draft',$2::jsonb)", [`sha256:${"c".repeat(64)}`, JSON.stringify({ secret: "raw-value" })]));
    await assert.rejects(client.query("INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_abcdefgh','trip_abcdefgh','provision',$1,'draft',$2::jsonb)", [`sha256:${"b".repeat(64)}`, JSON.stringify({ upstream: "192.168.1.10" })]));
    await client.query("INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_secretref','trip_abcdefgh','provision',$1,'draft',$2::jsonb)", [`sha256:${"d".repeat(64)}`, JSON.stringify({ connection_secret_ref: "file:///run/secrets/database_url" })]);
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("audit events reject update, delete and truncate", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    await client.query("INSERT INTO control_plane.audit_events(id,actor_ref,action,target_ref,correlation_id,occurred_at) VALUES ('audit_abcdefgh','user_abcdefgh','test.recorded','trip_abcdefgh','corr_abcdefgh',now())");
    await assert.rejects(client.query("UPDATE control_plane.audit_events SET action='test.changed'"));
    await assert.rejects(client.query("DELETE FROM control_plane.audit_events"));
    await assert.rejects(client.query("TRUNCATE control_plane.audit_events"));
    const count = await client.query("SELECT count(*)::int AS count FROM control_plane.audit_events");
    assert.equal(count.rows[0].count, 1);
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("failed job steps require a formatted safe error code", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    await client.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ('user_abcdefgh','active','Test')");
    await client.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ('trip_abcdefgh','japan-demo','planned')");
    await client.query("INSERT INTO control_plane.plans(id,trip_id,kind,digest,status) VALUES ('plan_abcdefgh','trip_abcdefgh','provision',$1,'approved')", [`sha256:${"e".repeat(64)}`]);
    await client.query("INSERT INTO control_plane.jobs(id,trip_id,plan_id,job_type,idempotency_key,correlation_id,state) VALUES ('job_abcdefgh','trip_abcdefgh','plan_abcdefgh','provision','job-step-parent-v1','corr_abcdefgh','running')");
    await assert.rejects(client.query("INSERT INTO control_plane.job_steps(id,job_id,step_key,state,idempotency_key) VALUES ('step_abcdefgh','job_abcdefgh','allocate','failed','step-allocate-v1')"));
    await assert.rejects(client.query("INSERT INTO control_plane.job_steps(id,job_id,step_key,state,idempotency_key,safe_error_code) VALUES ('step_badcode01','job_abcdefgh','allocate','failed','step-allocate-v2','bad code')"));
    await client.query("INSERT INTO control_plane.job_steps(id,job_id,step_key,state,idempotency_key,safe_error_code) VALUES ('step_safeerr01','job_abcdefgh','allocate','failed','step-allocate-v3','CONTROLLED_PROVIDER_FAILURE')");
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

// Sensitive-key matching must not depend on snake_case word boundaries, a
// *_secret_ref key must actually hold a reference rather than being exempt,
// and the private-address check must need a whole dotted quad so that ordinary
// version strings and dates survive.
const unsafeDocuments: Record<string, unknown> = {
  "camelCase token key": { accessToken: "ghp_RAWSECRET123" },
  "camelCase api key": { apiKey: "sk-live-RAWKEY" },
  "snake_case api key": { api_key: "RAWKEY" },
  "credential substring": { userCredential: "RAWVALUE" },
  "passphrase key": { passphrase: "RAWVALUE" },
  "secret_ref holding a literal": { secret_ref: "hunter2-not-a-reference" },
  "secret_ref holding a connection string": { db_secret_ref: "postgresql://u:PASSWORD@h/db" },
  "secret_ref holding a non-string": { secret_ref: { inline: "value" } },
  "private class C address": { upstream: "192.168.1.10" },
  "private class A address": { node: "10.0.0.5" },
  "loopback address": { loopback: "127.0.0.1" },
  "private class B address": { vpn: "172.16.0.9" },
  "nested camelCase secret": { runtime: { agent: { chatId: "8100200300" } } },
};

const safeDocuments: Record<string, unknown> = {
  "semver that starts like a private range": { app_version: "10.15.7" },
  "dotted date": { departure: "10.11.2025" },
  "public address": { dns: "8.8.8.8" },
  "file secret reference": { connection_secret_ref: "file:///run/secrets/database_url" },
  "env secret reference": { db_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  "nested camelCase vault reference": { nested: { deep: { secretRef: "vault://kv/data/trip" } } },
};

test("canonical guardrail matches sensitive keys regardless of case style", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    for (const [label, document] of Object.entries(unsafeDocuments)) {
      const result = await client.query("SELECT control_plane.canonical_json_is_safe($1::jsonb) AS safe", [JSON.stringify(document)]);
      assert.equal(result.rows[0].safe, false, `expected rejection: ${label}`);
    }
    for (const [label, document] of Object.entries(safeDocuments)) {
      const result = await client.query("SELECT control_plane.canonical_json_is_safe($1::jsonb) AS safe", [JSON.stringify(document)]);
      assert.equal(result.rows[0].safe, true, `expected acceptance: ${label}`);
    }
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("every canonical record carries an opaque identifier", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    // 0001 constrained only users.id and trips.id; the shape now holds across
    // the schema, including the identifiers that cross the API/worker boundary.
    await assert.rejects(client.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ('nope','japan-demo','draft')"));
    await client.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ('trip_abcdefgh','japan-demo','draft')");
    await assert.rejects(client.query(
      "INSERT INTO control_plane.plans(id,trip_id,kind,digest,status) VALUES ('short','trip_abcdefgh','provision',$1,'draft')",
      [`sha256:${"3".repeat(64)}`],
    ));
    await client.query(
      "INSERT INTO control_plane.plans(id,trip_id,kind,digest,status) VALUES ('plan_abcdefgh','trip_abcdefgh','provision',$1,'approved')",
      [`sha256:${"4".repeat(64)}`],
    );
    await assert.rejects(client.query(
      "INSERT INTO control_plane.jobs(id,trip_id,plan_id,job_type,idempotency_key,correlation_id,state) VALUES ('job_abcdefgh','trip_abcdefgh','plan_abcdefgh','provision','opaque-v1','not-opaque','queued')",
    ));
    await client.query(
      "INSERT INTO control_plane.jobs(id,trip_id,plan_id,job_type,idempotency_key,correlation_id,state) VALUES ('job_abcdefgh','trip_abcdefgh','plan_abcdefgh','provision','opaque-v2','corr_abcdefgh','queued')",
    );
    await assert.rejects(client.query(
      "INSERT INTO control_plane.audit_events(id,actor_ref,action,target_ref,correlation_id,occurred_at) VALUES ('audit_abcdefgh','user_abcdefgh','test.recorded','trip_abcdefgh','bare',now())",
    ));
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("canonical guardrail is enforced by the table constraints it backs", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    await client.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ('trip_abcdefgh','japan-demo','draft')");
    await assert.rejects(client.query(
      "INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_camelcase','trip_abcdefgh','provision',$1,'draft',$2::jsonb)",
      [`sha256:${"f".repeat(64)}`, JSON.stringify({ accessToken: "ghp_RAWSECRET123" })],
    ));
    await assert.rejects(client.query(
      "INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_fakeref01','trip_abcdefgh','provision',$1,'draft',$2::jsonb)",
      [`sha256:${"1".repeat(64)}`, JSON.stringify({ db_secret_ref: "postgresql://u:PASSWORD@h/db" })],
    ));
    await client.query(
      "INSERT INTO control_plane.plans(id,trip_id,kind,digest,status,desired) VALUES ('plan_version01','trip_abcdefgh','provision',$1,'draft',$2::jsonb)",
      [`sha256:${"2".repeat(64)}`, JSON.stringify({ app_version: "10.15.7", departure: "10.11.2025" })],
    );
    await assert.rejects(client.query(
      `INSERT INTO control_plane.intake_versions
         (id,trip_id,version,artifact_ref,digest,confirmed_at,schema_version,data)
       VALUES ('intk_unsafe01','trip_abcdefgh',1,'intake:test:unsafe',$1,now(),1,$2::jsonb)`,
      [`sha256:${"3".repeat(64)}`, JSON.stringify({ destination: { text: "Private endpoint 192.168.1.10" } })],
    ));
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});

test("the SQL guardrail and the application guard agree on every shared fixture", { skip: !databaseUrl }, async () => {
  // The previous application-layer copy was transliterated by hand and drifted
  // from the SQL, carrying the same three defects. Both are now driven from one
  // fixture file, and disagreement on any single case fails here.
  const { unsafe, safe } = await loadCanonicalFixtures();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);
    for (const [expected, fixtures] of [[false, unsafe], [true, safe]] as const) {
      for (const { label, document } of fixtures) {
        const result = await client.query("SELECT control_plane.canonical_json_is_safe($1::jsonb) AS safe", [JSON.stringify(document)]);
        const sql: boolean = result.rows[0].safe;
        const app = isCanonicalRecordSafe(document);
        assert.equal(sql, expected, `SQL disagrees with the fixture: ${label}`);
        assert.equal(app, sql, `application guard disagrees with SQL: ${label}`);
      }
    }
  } finally {
    await reset(client);
    client.release();
    await pool.end();
  }
});
