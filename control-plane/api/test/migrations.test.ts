import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isCanonicalRecordSafe } from "../src/canonical.js";
import { applyMigrations } from "../src/migrations.js";
import { loadCanonicalFixtures } from "./canonical-fixtures.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
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
      "0040_interview_document_floor.sql",
      "0041_drop_plan_operations_reviews.sql",
      "0042_trip_reachability.sql",
      "0043_binding_without_companion.sql",
      "0044_companion_intro_facts.sql",
      "0045_group_binding_tokens.sql",
      "0046_intake_version_language.sql",
      "0047_agent_spoke_on_turn.sql",
      "0048_interview_interpretations.sql",
      "0049_interview_session_expiry.sql",
      "0050_plan_reviews.sql",
      "0051_trip_person_links.sql",
      "0052_telegram_organizer_links.sql",
      "0053_companion_reply_capture.sql",
      "0054_organizer_invitations.sql",
      "0055_one_organizer_per_address.sql",
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
      "0040_interview_document_floor.sql",
      "0041_drop_plan_operations_reviews.sql",
      "0042_trip_reachability.sql",
      "0043_binding_without_companion.sql",
      "0044_companion_intro_facts.sql",
      "0045_group_binding_tokens.sql",
      "0046_intake_version_language.sql",
      "0047_agent_spoke_on_turn.sql",
      "0048_interview_interpretations.sql",
      "0049_interview_session_expiry.sql",
      "0050_plan_reviews.sql",
      "0051_trip_person_links.sql",
      "0052_telegram_organizer_links.sql",
      "0053_companion_reply_capture.sql",
      "0054_organizer_invitations.sql",
      "0055_one_organizer_per_address.sql",
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

test("0055 merges the two accounts an invited organizer used to end up with", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    // Everything up to and including the migration that introduced the split.
    const files = (await applyMigrations(client, migrationsDir));
    assert.ok(files.includes("0055_one_organizer_per_address.sql"));

    // Rebuild, by hand, exactly what the old code left behind: an invited user
    // with no identity row owning the built trip, and a separately created
    // credentialed user for the SAME address, which is the only one that can
    // log in. This is the state migration 0055 exists to repair.
    const digest = "sha256:" + "a".repeat(64);
    const invitedUser = "user_" + "1".repeat(32);
    const webUser = "user_" + "2".repeat(32);
    const tripId = "trip_" + "3".repeat(32);
    const tgDigest = "sha256:" + "b".repeat(64);

    await client.query(
      "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1,'active','Invited'), ($2,'active','Signed up')",
      [invitedUser, webUser]);
    await client.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1,$2,'ready_private')",
      [tripId, "draft-" + tripId.replace(/_/g, "-")]);
    await client.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1,$2,$3,'owner','active')",
      ["memb_" + "4".repeat(32), tripId, invitedUser]);
    await client.query(
      "INSERT INTO control_plane.organizer_invitations(id, email_digest, user_id, trip_id, kind, language, invited_by) VALUES ($1,$2,$3,$4,'new','en','an operator')",
      ["invt_" + "5".repeat(32), digest, invitedUser, tripId]);
    await client.query(
      "INSERT INTO control_plane.telegram_organizer_links(id, user_id, telegram_subject_digest, verified_via) VALUES ($1,$2,$3,'enrollment_redemption')",
      ["tol_" + "6".repeat(32), invitedUser, tgDigest]);
    // The account they can actually log in with, holding the address.
    await client.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'password',$3, now())",
      ["idnt_" + "7".repeat(32), webUser, digest]);
    await client.query(
      "INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash) VALUES ($1,$2,$3)",
      [webUser, digest, "scrypt:" + "c".repeat(40)]);

    // Re-run just the repair, as an upgrade of a database that already held it.
    await client.query("DELETE FROM public.control_plane_schema_migrations WHERE version = '0055_one_organizer_per_address.sql'");
    assert.deepEqual(await applyMigrations(client, migrationsDir), ["0055_one_organizer_per_address.sql"]);

    // The trip now belongs to the account they log in with.
    const owner = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1 AND role = 'owner'", [tripId]);
    assert.deepEqual(owner.rows.map((r) => r.user_id), [webUser]);

    // The Telegram link moved with it, so the bot still finds their trip.
    const link = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.telegram_organizer_links WHERE telegram_subject_digest = $1", [tgDigest]);
    assert.deepEqual(link.rows.map((r) => r.user_id), [webUser]);

    // The audit record still points at an account that owns something.
    const invitation = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.organizer_invitations WHERE email_digest = $1", [digest]);
    assert.deepEqual(invitation.rows.map((r) => r.user_id), [webUser]);

    // The emptied account is marked rather than left looking like an organizer.
    const stale = await client.query<{ status: string }>(
      "SELECT status FROM control_plane.users WHERE id = $1", [invitedUser]);
    assert.equal(stale.rows[0].status, "deleted");

    // One identity for the address, and re-running changes nothing further.
    const identities = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1", [digest]);
    assert.deepEqual(identities.rows.map((r) => r.user_id), [webUser]);
    await client.query("DELETE FROM public.control_plane_schema_migrations WHERE version = '0055_one_organizer_per_address.sql'");
    assert.deepEqual(await applyMigrations(client, migrationsDir), ["0055_one_organizer_per_address.sql"]);
    const afterRerun = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1 AND role = 'owner'", [tripId]);
    assert.deepEqual(afterRerun.rows.map((r) => r.user_id), [webUser]);
  } finally {
    client.release();
    await pool.end();
  }
});

test("0055 gives an invited account with no rival an identity of its own", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await reset(client);
    await applyMigrations(client, migrationsDir);

    const digest = "sha256:" + "d".repeat(64);
    const invitedUser = "user_" + "8".repeat(32);
    const tripId = "trip_" + "9".repeat(32);
    await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1,'active','Invited')", [invitedUser]);
    await client.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1,$2,'draft')",
      [tripId, "draft-" + tripId.replace(/_/g, "-")]);
    await client.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1,$2,$3,'owner','active')",
      ["memb_" + "a".repeat(32), tripId, invitedUser]);
    await client.query(
      "INSERT INTO control_plane.organizer_invitations(id, email_digest, user_id, trip_id, kind, language, invited_by) VALUES ($1,$2,$3,$4,'new','en','an operator')",
      ["invt_" + "b".repeat(32), digest, invitedUser, tripId]);

    await client.query("DELETE FROM public.control_plane_schema_migrations WHERE version = '0055_one_organizer_per_address.sql'");
    await applyMigrations(client, migrationsDir);

    // The account they were invited into is now the address's canonical one, so
    // signing up later completes it instead of building a second organizer.
    const identities = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1", [digest]);
    assert.deepEqual(identities.rows.map((r) => r.user_id), [invitedUser]);
    const stale = await client.query<{ status: string }>("SELECT status FROM control_plane.users WHERE id = $1", [invitedUser]);
    assert.equal(stale.rows[0].status, "active");
  } finally {
    client.release();
    await pool.end();
  }
});
