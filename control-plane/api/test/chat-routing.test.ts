import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { buildApp, type ChatRoutingDependencies } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const API_KEY = "test-chat-routing-key";

async function resetDb(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

const testProfile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

test("GET /internal/telegram-chat-bindings/:chatId returns the bound trip and profile", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = testId("trip");
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')",
      [tripId, tripId.replace(/_/g, "-")],
    );
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
      ["555000999", tripId, "trip-companion-abc"],
    );

    const chatRouting: ChatRoutingDependencies = { db: pool, apiKey: API_KEY };
    const app = buildApp(testProfile, { chatRouting });

    const res = await app.inject({
      method: "GET",
      url: "/internal/telegram-chat-bindings/555000999",
      headers: { "x-api-key": API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { tripId, hermesProfile: "trip-companion-abc" });
    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("GET /internal/telegram-chat-bindings/:chatId returns 404 for an unbound chat id", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const chatRouting: ChatRoutingDependencies = { db: pool, apiKey: API_KEY };
    const app = buildApp(testProfile, { chatRouting });
    const res = await app.inject({
      method: "GET",
      url: "/internal/telegram-chat-bindings/000000000",
      headers: { "x-api-key": API_KEY },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("GET /internal/telegram-chat-bindings/:chatId refuses a missing or wrong API key", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const chatRouting: ChatRoutingDependencies = { db: pool, apiKey: API_KEY };
    const app = buildApp(testProfile, { chatRouting });

    const noKey = await app.inject({ method: "GET", url: "/internal/telegram-chat-bindings/555000999" });
    assert.equal(noKey.statusCode, 401);

    const wrongKey = await app.inject({
      method: "GET",
      url: "/internal/telegram-chat-bindings/555000999",
      headers: { "x-api-key": "not-the-right-key" },
    });
    assert.equal(wrongKey.statusCode, 401);

    await app.close();
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("GET /internal/telegram-chat-bindings/:chatId is 503 when chatRouting isn't configured", async () => {
  const app = buildApp(testProfile, {});
  const res = await app.inject({
    method: "GET",
    url: "/internal/telegram-chat-bindings/555000999",
    headers: { "x-api-key": "anything" },
  });
  assert.equal(res.statusCode, 503);
  await app.close();
});
