import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import type { PortalDependencies } from "../src/portal.js";
import { seedTrip } from "./support/plan-change-site.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// GET /internal/runtime-routes/:tripId (portal.ts), the runtime gateway's route lookup. Its body moved into
// runtimeUpstreamFor (runtime-upstream.ts) so the group-line poller applies the SAME host allow-list; this pins the
// route's status codes and bodies against a real database, and was run against the pre-move portal.ts to show they are
// the ones the route always gave. Own cptest_<name> database, never `cptest`.
const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const KEY = "exchange-key-for-runtime-route-test";

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function portalDeps(db: pg.Pool): PortalDependencies {
  return {
    db,
    google: { clientId: "test-client.apps.googleusercontent.com", verify: async () => ({ subject: "unused", displayName: "Unused", emailVerified: false }) },
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: KEY,
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, operatorChatId: "operator-chat-1",
  };
}

describe("GET /internal/runtime-routes/:tripId", { skip }, () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  before(async () => {
    pool = testPool({ max: 3 });
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally { client.release(); }
    app = buildApp(profile, { portal: portalDeps(pool) });
  });
  after(async () => {
    await app.close();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    } finally { client.release(); await pool.end(); }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE control_plane.runtime_routes, control_plane.jobs, control_plane.plans, control_plane.trips CASCADE");
  });

  const get = (tripId: string, key: string | null = KEY) => app.inject({
    method: "GET", url: `/internal/runtime-routes/${tripId}`, headers: key ? { "x-api-key": key } : {},
  });

  test("a ready trip answers its route, with the base path's trailing slash trimmed", async () => {
    const tripId = await seedTrip(pool, "route-ready", "http://site.internal:3000/base/");
    const res = await get(tripId);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["routeRef", "tripKey", "upstreamBasePath", "upstreamOrigin"]);
    assert.match(body.routeRef, /^route_[0-9a-f]{16}$/);
    assert.equal(body.upstreamOrigin, "http://site.internal:3000");
    assert.equal(body.upstreamBasePath, "/base");
  });

  test("a host that is a subdomain of an allowed suffix is allowed; a path of / is an empty base path", async () => {
    const tripId = await seedTrip(pool, "route-sub", "https://a.b.internal/");
    const res = await get(tripId);
    assert.equal(res.statusCode, 200);
    const { routeRef: _ref, ...rest } = res.json();
    assert.deepEqual(rest, { upstreamOrigin: "https://a.b.internal", upstreamBasePath: "", tripKey: "shared" });
  });

  test("no key and a wrong key are 401 AUTHENTICATION_REQUIRED, and say nothing about the trip", async () => {
    const tripId = await seedTrip(pool, "route-auth", "http://site.internal:3000");
    for (const key of [null, "not-the-key", ""]) {
      const res = await get(tripId, key);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { error: "AUTHENTICATION_REQUIRED" });
    }
  });

  test("a trip that is not ready, or has no site address yet, is 404 RUNTIME_NOT_READY", async () => {
    const pending = await seedTrip(pool, "route-pending", "http://site.internal:3000");
    await pool.query("UPDATE control_plane.runtime_routes SET state = 'pending' WHERE trip_id = $1", [pending]);
    const noUrl = await seedTrip(pool, "route-nourl", "http://site.internal:3000");
    await pool.query("UPDATE control_plane.jobs SET result = '{}'::jsonb WHERE trip_id = $1", [noUrl]);
    const noJob = await seedTrip(pool, "route-nojob", "http://site.internal:3000");
    await pool.query("DELETE FROM control_plane.jobs WHERE trip_id = $1", [noJob]);
    for (const tripId of [pending, noUrl, noJob]) {
      const res = await get(tripId);
      assert.equal(res.statusCode, 404, tripId);
      assert.deepEqual(res.json(), { error: "RUNTIME_NOT_READY" });
    }
  });

  test("an unknown trip is 404 RUNTIME_NOT_READY, the same as one not ready", async () => {
    const res = await get("trip_doesnotexist0001");
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "RUNTIME_NOT_READY" });
  });

  test("a site address the allow-list does not cover is 503 RUNTIME_ROUTE_INVALID", async () => {
    const bad = [
      "http://site.example.com:3000",          // a host outside the suffixes
      "http://evilinternal/",                  // ends with the suffix but is not a subdomain of it
      "ftp://site.internal/",                  // not http(s)
      "http://user:pass@site.internal/",       // credentials in the address
      "http://site.internal/?x=1",             // a query
      "http://site.internal/#frag",            // a fragment
      "not a url",                             // unparsable
    ];
    for (const [i, url] of bad.entries()) {
      const tripId = await seedTrip(pool, `route-bad-${i}`, url);
      const res = await get(tripId);
      assert.equal(res.statusCode, 503, url);
      assert.deepEqual(res.json(), { error: "RUNTIME_ROUTE_INVALID" }, url);
    }
  });
});
