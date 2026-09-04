import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp, type ChatRoutingDependencies, type InterviewDependencies } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { issueEnrollment } from "../src/enrollment.js";
import { applyMigrations } from "../src/migrations.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const apiKey = "test-interview-binding-key";
const profile = validateArchitectureProfile({ version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 }, worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 }, database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" }, adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" }, test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" } });
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

test("POST /internal/telegram-interviews/bind returns 503 without both internal dependencies", async () => {
  const app = buildApp(profile, {});
  const response = await app.inject({ method: "POST", url: "/internal/telegram-interviews/bind", headers: { "x-api-key": apiKey }, payload: {} });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test("POST /internal/telegram-interviews/bind authenticates, validates, and creates one active binding", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await pool.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
    const userId = id("user"), tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Owner')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ($1,$2,'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query("INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')", [id("memb"), tripId, userId]);
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.equal(enrollment.ok, true);
    if (!enrollment.ok) throw new Error("enrollment setup failed");
    const app = buildApp(profile, { chatRouting: { db: pool, apiKey } satisfies ChatRoutingDependencies, interview: { db: pool, config: { enrollmentTtlSeconds: 3600 } } satisfies InterviewDependencies });
    assert.equal((await app.inject({ method: "POST", url: "/internal/telegram-interviews/bind", payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/internal/telegram-interviews/bind", headers: { "x-api-key": apiKey }, payload: { chatId: "bad", enrollmentToken: enrollment.token } })).statusCode, 400);
    const response = await app.inject({ method: "POST", url: "/internal/telegram-interviews/bind", headers: { "x-api-key": apiKey }, payload: { chatId: "555000999", enrollmentToken: enrollment.token } });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.deepEqual(Object.keys(body).sort(), ["sessionId", "sessionToken", "tripId"]);
    const row = await pool.query("SELECT state,trip_id,session_id FROM control_plane.telegram_interview_bindings WHERE chat_id = $1", ["555000999"]);
    assert.deepEqual(row.rows[0], { state: "active", trip_id: tripId, session_id: body.sessionId });
    const duplicate = await app.inject({ method: "POST", url: "/internal/telegram-interviews/bind", headers: { "x-api-key": apiKey }, payload: { chatId: "555000999", enrollmentToken: enrollment.token } });
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(duplicate.json(), { error: "CHAT_ALREADY_BOUND" });
    await app.close();
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE").catch(() => undefined);
    await pool.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations").catch(() => undefined);
    await pool.end();
  }
});
