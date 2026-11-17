// A wildcard (host mode) trip, end to end through the REAL control-plane API and the REAL runtime gateway
// (docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, AC-R1.11).
//
// The worker verifies a wildcard trip over the LAN but records its PUBLIC name (https://<slug>.<suffix>) as the
// job's private_url. The gateway's by-trip-ID calls (session exchange at a portal launch, participant
// provisioning) must go to the LAN origin the route registered, not back through the public name, where host mode
// answers 404 for /api/internal/*. A trip could reach ready_private while both failed (owner review of #599, F1).
//
// Real: buildApp + the database, listening on a port; runtime-gateway/server.js as a child process with
// TRIP_HOST_SUFFIX set. Faked: only the trip site, a recording server on loopback. Names are under .test.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const gatewayScript = fileURLToPath(new URL("../../runtime-gateway/server.js", import.meta.url));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const hex = createHash("sha256").update(suffix).digest("hex");

const EXCHANGE_KEY = "e2e-exchange-key";
const MASTER = "e2e-trip-key-master";
const LEGACY = "e2e-legacy-trip-key";
const TRIP_HOST_SUFFIX = "trips.example.test";
const ids = {
  user: `user_${suffix}a`, trip: `trip_${suffix}a`, route: `route_${suffix}a`, membership: `memb_${suffix}a`,
  release: `rls_${suffix}`, plan: `plan_${suffix}p`, job: `job_${suffix}j`,
};
const slug = `wild-${suffix}`;
const publicUrl = `https://${slug}.${TRIP_HOST_SUFFIX}`;

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
let upstream: http.Server;
let gateway: ChildProcess | undefined;
let gatewayOutput = "";
let upstreamOrigin = "", apiOrigin = "", gatewayOrigin = "", portalOrigin = "";
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}
const listen = (server: http.Server) => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)));
const derivedKey = (tripId: string) => createHmac("sha256", MASTER).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");

before(async () => {
  if (skip) return;
  pool = testPool({ max: 3 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }

  // The trip site: records exactly what reaches it. A trip on the real site answers 404 to nothing here; it is
  // only the other end of the wire.
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/internal/control-plane/session" ? { token: "trip-runtime-token" } : { ok: true }));
    });
  });
  upstreamOrigin = await listen(upstream);

  // The seeded wildcard trip: a ready route that registered the LAN upstream, and a succeeded provision job whose
  // private_url is the PUBLIC name (what the worker records).
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Owner')", [ids.user]);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1,$2,'ready_private')", [ids.trip, slug]);
  await pool.query("INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,'owner','active',true,true)", [ids.membership, ids.trip, ids.user]);
  await pool.query(
    "INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state, public_host, upstream_url, trip_key) VALUES ($1,$2,'ready',$3,$4,'derived')",
    [ids.trip, ids.route, `${slug}.${TRIP_HOST_SUFFIX}`, upstreamOrigin]);
  await pool.query("INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by) VALUES ($1,$2,$3,1,1,1,'available',now(),'test:fixture')", [ids.release, hex.slice(0, 40), `sha256:${hex}`]);
  await pool.query("INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired) VALUES ($1,$2,$3,'provision',$4,'executed','{}'::jsonb)", [ids.plan, ids.trip, ids.release, `sha256:${createHash("sha256").update(`plan${suffix}`).digest("hex")}`]);
  await pool.query("INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, result) VALUES ($1,$2,$3,'provision',$4,$5,'succeeded',$6::jsonb)",
    [ids.job, ids.trip, ids.plan, `idem-${suffix}`, `corr_${suffix}c`, JSON.stringify({ private_url: publicUrl })]);

  // The real API, listening.
  const portal: PortalDependencies = {
    db: pool, runtimeAccounts: {} as PortalDependencies["runtimeAccounts"],
    publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: EXCHANGE_KEY,
    runtimeUpstreamHostSuffixes: [TRIP_HOST_SUFFIX], runtimeUpstreamAllowedHosts: ["127.0.0.1"], telegramBotUsername: "kinerary_bot",
    sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  };
  app = buildApp(profile, { portal });
  apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });

  // The real gateway, in host mode, pointed at that API. Only the variables it names are passed.
  const gatewayPort = await freePort();
  gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
  portalOrigin = `http://127.0.0.1:${await freePort()}`;
  gateway = spawn(process.execPath, [gatewayScript], {
    env: {
      PATH: process.env.PATH ?? "", PORT: String(gatewayPort), BIND_HOST: "127.0.0.1",
      CONTROL_PLANE_INTERNAL_ORIGIN: apiOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE_KEY, RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY,
      RUNTIME_COOKIE_SECRET: "e2e-cookie-secret", PORTAL_ORIGIN: portalOrigin, RUNTIME_ORIGIN: gatewayOrigin,
      TRIP_HOST_SUFFIX, RUNTIME_UPSTREAM_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout?.on("data", (chunk) => { gatewayOutput += chunk; });
  gateway.stderr?.on("data", (chunk) => { gatewayOutput += chunk; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { if ((await fetch(`${gatewayOrigin}/health`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline || gateway.exitCode !== null) throw new Error(`the gateway did not start: ${gatewayOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

after(async () => {
  if (skip) return;
  gateway?.kill("SIGKILL");
  await app?.close();
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  await pool.query("DELETE FROM control_plane.runtime_launch_grants WHERE trip_id = $1", [ids.trip]);
  await pool.query("DELETE FROM control_plane.jobs WHERE id = $1", [ids.job]);
  await pool.query("DELETE FROM control_plane.plans WHERE id = $1", [ids.plan]);
  await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [ids.release]);
  await pool.query("DELETE FROM control_plane.runtime_routes WHERE trip_id = $1", [ids.trip]);
  await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [ids.trip]);
  await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [ids.trip]);
  await pool.query("DELETE FROM control_plane.users WHERE id = $1", [ids.user]);
  await pool.end();
});

test("AC-R1.11: the by-trip-ID answer is the registered LAN origin; the public URL stays the job's private_url", { skip }, async () => {
  const response = await fetch(`${apiOrigin}/internal/runtime-routes/${ids.trip}`, { headers: { "x-api-key": EXCHANGE_KEY } });
  assert.equal(response.status, 200);
  const body = await response.json();
  console.log("by-trip-ID request:  GET /internal/runtime-routes/<trip id> (exchange key)");
  console.log(`by-trip-ID response: 200 ${JSON.stringify({ ...body, routeRef: "<route_ref>" })}`);
  assert.deepEqual(body, { routeRef: ids.route, upstreamOrigin, upstreamBasePath: "", tripKey: "derived" });
  const job = await pool.query("SELECT result->>'private_url' AS private_url FROM control_plane.jobs WHERE id = $1", [ids.job]);
  assert.equal(job.rows[0].private_url, publicUrl, "the public URL is what the browser is sent to, and is not rewritten");
});

test("AC-R1.11: participant provisioning through the gateway reaches the trip site's internal route on the LAN", { skip }, async () => {
  seen.length = 0;
  const response = await fetch(`${gatewayOrigin}/internal/t/${ids.trip}/participants`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": EXCHANGE_KEY },
    body: JSON.stringify({ tripId: ids.trip, runtimeUsername: "guest-user", displayName: "Guest", role: "member" }),
  });
  const text = await response.text();
  console.log(`provisioning request:  POST gateway /internal/t/<trip id>/participants -> trip site POST ${seen[0]?.url}`);
  console.log(`provisioning response: ${response.status} ${text}`);
  assert.equal(response.status, 200, `gateway log: ${gatewayOutput}`);
  assert.equal(seen.length, 1, "exactly one request reached the trip site");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/api/internal/control-plane/participants");
  assert.equal(seen[0].headers["x-api-key"], derivedKey(ids.trip), "the trip's own derived key, not the control-plane key");
  assert.equal(JSON.parse(seen[0].body).runtimeUsername, "guest-user");
});

test("AC-R1.11: a portal launch exchanges its session with the trip site on the LAN and ends in the 303", { skip }, async () => {
  seen.length = 0;
  const token = `launch-token-${suffix}`;
  await pool.query("INSERT INTO control_plane.runtime_launch_grants(id,trip_id,user_id,token_digest,audience,expires_at) VALUES ($1,$2,$3,$4,'runtime_gateway', now() + interval '1 minute')",
    [`launch_${suffix}a`, ids.trip, ids.user, sha256(token)]);
  const response = await fetch(`${gatewayOrigin}/t/${ids.trip}/__launch`, {
    method: "POST", redirect: "manual",
    headers: { origin: portalOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  console.log(`launch request:  POST gateway /t/<trip id>/__launch (portal Origin, form token) -> trip site POST ${seen[0]?.url}`);
  console.log(`launch response: ${response.status} location=${response.headers.get("location")} set-cookie=${response.headers.get("set-cookie") ? "present" : "absent"}`);
  assert.equal(response.status, 303, `gateway log: ${gatewayOutput}`);
  assert.equal(response.headers.get("location"), `/t/${ids.trip}/`);
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`kit_rt_${ids.trip}=`));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/internal/control-plane/session");
  assert.equal(seen[0].headers["x-api-key"], derivedKey(ids.trip));
  assert.deepEqual({ tripId: JSON.parse(seen[0].body).tripId, userId: JSON.parse(seen[0].body).userId, role: JSON.parse(seen[0].body).role }, { tripId: ids.trip, userId: ids.user, role: "owner" });
  const grant = await pool.query("SELECT consumed_at FROM control_plane.runtime_launch_grants WHERE id = $1", [`launch_${suffix}a`]);
  assert.ok(grant.rows[0].consumed_at, "the control plane consumed the grant");
});
