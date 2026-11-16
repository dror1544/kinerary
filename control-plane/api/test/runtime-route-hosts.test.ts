// Host-mode route lookup: GET /internal/runtime-routes/by-host/:host (AC-R1.2, AC-R1.3).
// Addresses are the documentation range 192.0.2.0/24 and 198.51.100.0/24; names are under .test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { upstreamHostAllowed, type PortalDependencies } from "../src/portal.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const hex = createHash("sha256").update(suffix).digest("hex");
const KEY = { "x-api-key": "exchange-key" };
let pool: pg.Pool;
const tripIds: string[] = [];

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function portalDeps(db: pg.Pool, allowed: readonly string[] | undefined): PortalDependencies {
  return {
    db, runtimeAccounts: {} as PortalDependencies["runtimeAccounts"],
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], runtimeUpstreamAllowedHosts: allowed, telegramBotUsername: "kinerary_bot",
    sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  };
}

let counter = 0;
async function seedRoute(opts: { host?: string | null; upstream?: string | null; state?: string }): Promise<{ tripId: string; routeRef: string }> {
  counter += 1;
  const tripId = `trip_${suffix}${String(counter).padStart(3, "0")}`;
  const routeRef = `route_${suffix}${String(counter).padStart(3, "0")}`;
  tripIds.push(tripId);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1,$2,'ready_private')", [tripId, `host-route-${suffix}-${counter}`]);
  await pool.query(
    "INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state, public_host, upstream_url) VALUES ($1,$2,$3,$4,$5)",
    [tripId, routeRef, opts.state ?? "ready", opts.host ?? null, opts.upstream === undefined ? "http://192.0.2.10:8080" : opts.upstream]);
  return { tripId, routeRef };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 3 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => {
  if (skip) return;
  await pool.query("DELETE FROM control_plane.runtime_routes WHERE trip_id = ANY($1)", [tripIds]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = ANY($1)", [tripIds]);
  await pool.end();
});

const get = (app: ReturnType<typeof buildApp>, url: string, headers: Record<string, string> = KEY) => app.inject({ method: "GET", url, headers });

test("AC-R1.2: a ready route is returned as { tripId, routeRef, upstreamOrigin }, and only with the exchange key", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool, ["192.0.2.0/24"]) });
  try {
    const host = `ok-${suffix}.example.test`;
    const { tripId, routeRef } = await seedRoute({ host });
    const response = await get(app, `/internal/runtime-routes/by-host/${host}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { tripId, routeRef, upstreamOrigin: "http://192.0.2.10:8080", tripKey: "shared" }); // AC-K2.2 added tripKey; a row seeded with no key kind holds the shared one
    // The name is matched case-insensitively (the gateway lowercases, so this only protects a hand-made call).
    assert.equal((await get(app, `/internal/runtime-routes/by-host/${host.toUpperCase()}`)).statusCode, 200);
    for (const headers of [{}, { "x-api-key": "wrong" }, { "x-api-key": "exchange-key-and-more" }]) {
      const refused = await get(app, `/internal/runtime-routes/by-host/${host}`, headers);
      assert.equal(refused.statusCode, 401);
      assert.deepEqual(refused.json(), { error: "AUTHENTICATION_REQUIRED" });
      assert.doesNotMatch(refused.body, new RegExp(tripId));
    }
  } finally { await app.close(); }
});

test("AC-R1.2: no such host, not ready, no upstream and not a name all answer the same 404 body", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool, ["192.0.2.0/24"]) });
  try {
    await seedRoute({ host: `pending-${suffix}.example.test`, state: "pending" });
    await seedRoute({ host: `suspended-${suffix}.example.test`, state: "suspended" });
    await seedRoute({ host: `noupstream-${suffix}.example.test`, upstream: null });
    const hosts = [`nobody-${suffix}.example.test`, `pending-${suffix}.example.test`, `suspended-${suffix}.example.test`, `noupstream-${suffix}.example.test`, "single", "a..b", "-x.example.test", "x_y.example.test", "a".repeat(64) + ".example.test", "127.0.0.1:8080", "%20"];
    const bodies = new Set<string>();
    for (const host of hosts) {
      const response = await get(app, `/internal/runtime-routes/by-host/${encodeURIComponent(host)}`);
      assert.equal(response.statusCode, 404, host);
      assert.deepEqual(response.json(), { error: "RUNTIME_NOT_READY" }, host);
      bodies.add(response.body);
    }
    assert.equal(bodies.size, 1);
  } finally { await app.close(); }
});

test("AC-R1.3: an upstream that is not a plain http(s) origin on the allow-list is 503 RUNTIME_ROUTE_INVALID", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool, ["192.0.2.0/24", "trip-site.internal.test"]) });
  try {
    const bad: Array<[string, string]> = [
      ["ftp", "ftp://192.0.2.10:21"], ["creds", "http://user:secret@192.0.2.10:8080"], ["path", "http://192.0.2.10:8080/base"],
      ["query", "http://192.0.2.10:8080/?a=1"], ["emptyquery", "http://192.0.2.10:8080/?"], ["fragment", "http://192.0.2.10:8080/#x"],
      ["outside", "http://198.51.100.10:8080"], ["otherhost", "http://elsewhere.internal.test:8080"], ["subdomain", "http://x.trip-site.internal.test:8080"],
      ["ipv6", "http://[2001:db8::1]:8080"], ["junk", "not a url"],
    ];
    for (const [name, upstream] of bad) {
      const host = `bad-${name}-${suffix}.example.test`;
      await seedRoute({ host, upstream });
      const response = await get(app, `/internal/runtime-routes/by-host/${host}`);
      assert.equal(response.statusCode, 503, `${name}: ${upstream}`);
      assert.deepEqual(response.json(), { error: "RUNTIME_ROUTE_INVALID" });
      assert.doesNotMatch(response.body, /192\.0\.2|198\.51/, "the registered address is not echoed on a refusal");
    }
    const good: Array<[string, string, string]> = [
      ["https", "https://192.0.2.200:8443", "https://192.0.2.200:8443"], ["slash", "http://192.0.2.10:8080/", "http://192.0.2.10:8080"],
      ["named", "http://trip-site.internal.test:8080", "http://trip-site.internal.test:8080"], ["upper", "HTTP://TRIP-SITE.internal.test", "http://trip-site.internal.test"],
      ["octal", "http://0300.0.2.10", "http://192.0.2.10"], // the URL parser canonicalises the spelling before the allow-list sees it
    ];
    for (const [name, upstream, origin] of good) {
      const host = `good-${name}-${suffix}.example.test`;
      await seedRoute({ host, upstream });
      const response = await get(app, `/internal/runtime-routes/by-host/${host}`);
      assert.equal(response.statusCode, 200, `${name}: ${upstream}`);
      assert.equal(response.json().upstreamOrigin, origin);
    }
  } finally { await app.close(); }
});

test("AC-R1.3: an empty or absent allow-list allows nothing", { skip }, async () => {
  const host = `empty-${suffix}.example.test`;
  await seedRoute({ host });
  for (const allowed of [undefined, [] as string[]]) {
    const app = buildApp(profile, { portal: portalDeps(pool, allowed) });
    try {
      const response = await get(app, `/internal/runtime-routes/by-host/${host}`);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "RUNTIME_ROUTE_INVALID" });
    } finally { await app.close(); }
  }
});

test("AC-R1.3: the per-trip-id endpoint is unchanged, and by-host and :tripId cannot capture each other", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(pool, ["192.0.2.0/24"]) });
  try {
    const host = `both-${suffix}.example.test`;
    const { tripId, routeRef } = await seedRoute({ host });
    // The old endpoint reads the job result, never the new columns: a trip with a host but no succeeded job is not ready there.
    const noJob = await get(app, `/internal/runtime-routes/${tripId}`);
    assert.equal(noJob.statusCode, 404);
    assert.deepEqual(noJob.json(), { error: "RUNTIME_NOT_READY" });
    // ... and it still answers for a trip that has one, whose private_url must be under a configured suffix.
    const planId = `plan_${suffix}p`;
    await pool.query("INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by) VALUES ($1,$2,$3,1,1,1,'available',now(),'test:fixture')", [`rls_${suffix}`, hex.slice(0, 40), `sha256:${hex}`]);
    await pool.query("INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired) VALUES ($1,$2,$3,'provision',$4,'executed','{}'::jsonb)", [planId, tripId, `rls_${suffix}`, `sha256:${createHash("sha256").update(`plan${suffix}`).digest("hex")}`]);
    await pool.query("INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, result) VALUES ($1,$2,$3,'provision',$4,$5,'succeeded',$6::jsonb)",
      [`job_${suffix}j`, tripId, planId, `idem-${suffix}`, `corr_${suffix}c`, JSON.stringify({ private_url: "http://trip.internal/base" })]);
    try {
      const old = await get(app, `/internal/runtime-routes/${tripId}`);
      assert.equal(old.statusCode, 200);
      assert.deepEqual(old.json(), { routeRef, upstreamOrigin: "http://trip.internal", upstreamBasePath: "/base", tripKey: "shared" }); // AC-K2.2 added tripKey
    } finally {
      await pool.query("DELETE FROM control_plane.jobs WHERE id = $1", [`job_${suffix}j`]);
      await pool.query("DELETE FROM control_plane.plans WHERE id = $1", [planId]);
      await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [`rls_${suffix}`]);
    }
    // "by-host" alone is a trip id that does not exist; a trip id is never a host.
    const alone = await get(app, "/internal/runtime-routes/by-host");
    assert.equal(alone.statusCode, 404);
    assert.deepEqual(alone.json(), { error: "RUNTIME_NOT_READY" });
    const asHost = await get(app, `/internal/runtime-routes/by-host/${tripId}`);
    assert.equal(asHost.statusCode, 404, "a trip id is not a dotted name");
    const hostAsTrip = await get(app, `/internal/runtime-routes/${host}`);
    assert.equal(hostAsTrip.statusCode, 404);
    assert.equal((await get(app, "/internal/runtime-routes/by-host/")).statusCode, 404);
  } finally { await app.close(); }
});

test("upstreamHostAllowed: exact names, exact IPv4 and IPv4 CIDR; IPv6 and anything unlisted is refused", () => {
  assert.equal(upstreamHostAllowed("192.0.2.10", ["192.0.2.0/24"]), true);
  assert.equal(upstreamHostAllowed("192.0.2.255", ["192.0.2.0/24"]), true);
  assert.equal(upstreamHostAllowed("192.0.3.1", ["192.0.2.0/24"]), false);
  assert.equal(upstreamHostAllowed("192.0.2.10", ["192.0.2.10"]), true);
  assert.equal(upstreamHostAllowed("192.0.2.11", ["192.0.2.10"]), false);
  assert.equal(upstreamHostAllowed("10.200.3.4", ["10.0.0.0/8"]), true);
  assert.equal(upstreamHostAllowed("11.0.0.1", ["10.0.0.0/8"]), false);
  assert.equal(upstreamHostAllowed("192.0.2.10", ["192.0.2.10/32", "198.51.100.0/24"]), true);
  assert.equal(upstreamHostAllowed("trip.example.test", ["Trip.Example.test"]), true);
  assert.equal(upstreamHostAllowed("x.trip.example.test", ["trip.example.test"]), false, "a name is exact, not a suffix");
  assert.equal(upstreamHostAllowed("trip.example.test", ["192.0.2.0/24"]), false);
  assert.equal(upstreamHostAllowed("[2001:db8::1]", ["2001:db8::1", "192.0.2.0/24"]), false);
  assert.equal(upstreamHostAllowed("192.0.2.10", []), false);
  assert.equal(upstreamHostAllowed("192.0.2.10", undefined), false);
  assert.equal(upstreamHostAllowed("192.0.2.10", ["192.0.2.0/33", "192.0.2.0/abc", "garbage/24"]), false);
});

test("web.runtime_upstream_allowed_hosts: hostnames, IPv4 and IPv4 CIDR load; IPv6, a wide CIDR and junk are refused; absent is fine", async () => {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url)), "utf8"));
  const load = (value: unknown) => validateArchitectureProfile({ ...raw, web: { ...raw.web, ...(value === undefined ? {} : { runtime_upstream_allowed_hosts: value }) } }).web?.runtime_upstream_allowed_hosts;
  assert.equal(load(undefined), undefined);
  assert.deepEqual(load([]), []);
  assert.deepEqual(load(["Trip.Example.test", "192.0.2.10", "192.0.2.0/24", "10.0.0.0/8", "localhost"]), ["trip.example.test", "192.0.2.10", "192.0.2.0/24", "10.0.0.0/8", "localhost"]);
  for (const bad of ["2001:db8::1", "2001:db8::/32", "10.0.0.0/7", "0.0.0.0/0", "192.0.2.0/33", "192.0.2.256", "192.0.2.010", "http://trip.example.test", "bad host", "-x.test", "a/b", ""]) {
    assert.throws(() => load([bad]), /runtime_upstream_allowed_hosts|CIDR|hostname|IPv4|dotted/, `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validateArchitectureProfile({ ...raw, web: { ...raw.web, runtime_upstream_allowed_hosts: "192.0.2.10" } }));
});
