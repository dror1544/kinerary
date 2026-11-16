// AC-K2.1, AC-K2.2: the route lookups say which KIND of key a trip's site holds, and never a key.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import type { PortalDependencies } from "../src/portal.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const hex = createHash("sha256").update(suffix).digest("hex");
const KEY = { "x-api-key": "exchange-key" };
let pool: pg.Pool;
const tripIds: string[] = [];
const planIds: string[] = [];
const jobIds: string[] = [];

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function portalDeps(db: pg.Pool): PortalDependencies {
  return {
    db, runtimeAccounts: {} as PortalDependencies["runtimeAccounts"],
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], runtimeUpstreamAllowedHosts: ["192.0.2.0/24"], telegramBotUsername: "kinerary_bot",
    sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  };
}

let counter = 0;
// A trip whose route is ready by BOTH lookups: it has a host and upstream (by-host) and a succeeded job with a private_url (by trip id).
async function seed(tripKey: string | null): Promise<{ tripId: string; host: string; routeRef: string }> {
  counter += 1;
  const n = String(counter).padStart(3, "0");
  const tripId = `trip_${suffix}k${n}`, routeRef = `route_${suffix}k${n}`, host = `k${n}-${suffix}.example.test`;
  tripIds.push(tripId);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1,$2,'ready_private')", [tripId, `trip-key-${suffix}-${n}`]);
  if (tripKey === null) {
    await pool.query("INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state, public_host, upstream_url) VALUES ($1,$2,'ready',$3,'http://192.0.2.10:8080')", [tripId, routeRef, host]);
  } else {
    await pool.query("INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state, public_host, upstream_url, trip_key) VALUES ($1,$2,'ready',$3,'http://192.0.2.10:8080',$4)", [tripId, routeRef, host, tripKey]);
  }
  const planId = `plan_${suffix}k${n}`, jobId = `job_${suffix}k${n}`;
  planIds.push(planId); jobIds.push(jobId);
  await pool.query("INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired) VALUES ($1,$2,$3,'provision',$4,'executed','{}'::jsonb)", [planId, tripId, `rls_${suffix}`, `sha256:${createHash("sha256").update(`plan${suffix}${n}`).digest("hex")}`]);
  await pool.query("INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, result) VALUES ($1,$2,$3,'provision',$4,$5,'succeeded',$6::jsonb)",
    [jobId, tripId, planId, `idem-${suffix}${n}`, `corr_${suffix}${n}`, JSON.stringify({ private_url: "http://trip.internal" })]);
  return { tripId, host, routeRef };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 3 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  await pool.query("INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by) VALUES ($1,$2,$3,1,1,1,'available',now(),'test:fixture')", [`rls_${suffix}`, hex.slice(0, 40), `sha256:${hex}`]);
});
after(async () => {
  if (skip) return;
  await pool.query("DELETE FROM control_plane.jobs WHERE id = ANY($1)", [jobIds]);
  await pool.query("DELETE FROM control_plane.plans WHERE id = ANY($1)", [planIds]);
  await pool.query("DELETE FROM control_plane.runtime_routes WHERE trip_id = ANY($1)", [tripIds]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = ANY($1)", [tripIds]);
  await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [`rls_${suffix}`]);
  await pool.end();
});

test("AC-K2.1: the column is shared by default and accepts only shared or derived", { skip }, async () => {
  const column = await pool.query("SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = 'control_plane' AND table_name = 'runtime_routes' AND column_name = 'trip_key'");
  assert.deepEqual(column.rows, [{ is_nullable: "NO", column_default: "'shared'::text", data_type: "text" }]);
  const { tripId } = await seed(null);
  assert.equal((await pool.query("SELECT trip_key FROM control_plane.runtime_routes WHERE trip_id = $1", [tripId])).rows[0].trip_key, "shared", "a row written without it holds the shared key");
  for (const bad of ["", "Derived", "legacy", "both"]) {
    await assert.rejects(pool.query("UPDATE control_plane.runtime_routes SET trip_key = $2 WHERE trip_id = $1", [tripId, bad]), /runtime_routes_trip_key_check/, `refuses ${JSON.stringify(bad)}`);
  }
  await assert.rejects(pool.query("UPDATE control_plane.runtime_routes SET trip_key = NULL WHERE trip_id = $1", [tripId]), /null value/);
});

test("AC-K2.2: both lookups return tripKey, shared and derived, and only behind the exchange key", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const shared = await seed("shared"), derived = await seed("derived");
    for (const [trip, kind] of [[shared, "shared"], [derived, "derived"]] as const) {
      const byId = await app.inject({ method: "GET", url: `/internal/runtime-routes/${trip.tripId}`, headers: KEY });
      assert.equal(byId.statusCode, 200);
      assert.equal(byId.json().tripKey, kind, "by trip id");
      assert.deepEqual(byId.json(), { routeRef: trip.routeRef, upstreamOrigin: "http://trip.internal", upstreamBasePath: "", tripKey: kind });
      const byHost = await app.inject({ method: "GET", url: `/internal/runtime-routes/by-host/${trip.host}`, headers: KEY });
      assert.equal(byHost.statusCode, 200);
      assert.deepEqual(byHost.json(), { tripId: trip.tripId, routeRef: trip.routeRef, upstreamOrigin: "http://192.0.2.10:8080", tripKey: kind }, "by host");
      for (const url of [`/internal/runtime-routes/${trip.tripId}`, `/internal/runtime-routes/by-host/${trip.host}`]) {
        for (const headers of [{}, { "x-api-key": "wrong" }]) {
          const refused = await app.inject({ method: "GET", url, headers });
          assert.equal(refused.statusCode, 401);
          assert.doesNotMatch(refused.body, /tripKey|derived|shared/, "a refused caller learns nothing about the key kind");
        }
      }
    }
    // No key material anywhere in the answers: the column holds a kind, never a key.
    const all = JSON.stringify((await app.inject({ method: "GET", url: `/internal/runtime-routes/${derived.tripId}`, headers: KEY })).json());
    assert.doesNotMatch(all, /[0-9a-f]{64}/);
  } finally { await app.close(); }
});

test("AC-K2.2: a trip that is not ready says nothing about its key kind", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool) });
  try {
    const { tripId, host } = await seed("derived");
    await pool.query("UPDATE control_plane.runtime_routes SET state = 'suspended' WHERE trip_id = $1", [tripId]);
    for (const url of [`/internal/runtime-routes/${tripId}`, `/internal/runtime-routes/by-host/${host}`]) {
      const response = await app.inject({ method: "GET", url, headers: KEY });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "RUNTIME_NOT_READY" });
    }
  } finally { await app.close(); }
});
