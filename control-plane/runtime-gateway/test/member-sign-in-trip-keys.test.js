// The member sign-in routes under per-trip exchange keys (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2;
// docs/specs/sprint-9/x-member-sign-in.md, A1/A5/AC-10). Written when `main`'s key model was merged into the member
// sign-in branch, which had been built on ONE shared key.
//
// The branch adds three gateway routes that reach a trip site: GET /internal/t/:id/participants (the list), and POST
// .../participants/adopt and .../participants/release (the claim's binding and its end). Each must do what the older
// participant routes do under K2: check its CALLER against RUNTIME_EXCHANGE_KEY (the control-plane key) and send the TRIP
// SITE the key that trip's route says it holds (derived, or the legacy key for a `shared` trip), never RUNTIME_EXCHANGE_KEY
// and never a second key after a refusal. The two hops that call the CONTROL PLANE for an organizer
// (__member-claims, __member-invites) keep carrying RUNTIME_EXCHANGE_KEY, and nothing of it reaches a trip site.
//
// server.js reads its environment once, at import, so each gateway under test is its own import.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

const MASTER = "test-master-do-not-use-0002";
const TRIP_D = "trip_derivedderivedderived"; // holds derive(MASTER, id)
const TRIP_S = "trip_sharedsharedshared"; // still holds the legacy key
const EXCHANGE = "exchange-key-0002";
const LEGACY = "legacy-key-do-not-use-0002";
const PORTAL = "https://app.example.test";
const RUNTIME = "https://runtime.example.test";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const bodyOf = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString())); });
// An oracle written here, apart from the gateway's: the label and HMAC of the spec.
const derive = (tripId, master = MASTER) => createHmac("sha256", master).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");

// A trip site that accepts one key. Every request it sees is recorded, with the key it carried.
function fakeTrip(held) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const key = req.headers["x-api-key"];
    seen.push({ method: req.method, url: req.url, key });
    await bodyOf(req);
    res.setHeader("content-type", "application/json");
    if (key !== held) { res.statusCode = 401; return res.end(JSON.stringify({ error: "AUTHENTICATION_REQUIRED" })); }
    if (req.method === "GET") return res.end(JSON.stringify({ participants: [{ username: "bob", displayName: "Bob", role: "member" }] }));
    return res.end(JSON.stringify({ ok: true, released: true }));
  });
  return { server, seen };
}

const trips = {};
const routeKinds = { [TRIP_D]: "derived", [TRIP_S]: "shared" };
const controlPlaneKeys = [];
let controlPlane, controlPlaneOrigin;
const gateways = [];

before(async () => {
  for (const [id, held] of [[TRIP_D, derive(TRIP_D)], [TRIP_S, LEGACY]]) {
    const trip = fakeTrip(held);
    trips[id] = { seen: trip.seen, server: trip.server, origin: await listen(trip.server) };
  }
  controlPlane = http.createServer(async (req, res) => {
    controlPlaneKeys.push(req.headers["x-api-key"]);
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== EXCHANGE) { res.statusCode = 401; return res.end("{}"); }
    const route = req.url.match(/^\/internal\/runtime-routes\/([^/]+)$/);
    if (route && trips[decodeURIComponent(route[1])]) {
      const id = decodeURIComponent(route[1]);
      return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin: trips[id].origin, upstreamBasePath: "", tripKey: routeKinds[id] }));
    }
    if (req.url === "/internal/member-claims/list") { await bodyOf(req); return res.end(JSON.stringify({ claims: [] })); }
    res.statusCode = 404; res.end("{}");
  });
  controlPlaneOrigin = await listen(controlPlane);
});

after(async () => {
  await Promise.all([...gateways.map(close), close(controlPlane), ...Object.values(trips).map((t) => close(t.server))]);
});

async function startGateway(env) {
  const base = {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE,
    RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: RUNTIME,
    RUNTIME_UPSTREAM_TIMEOUT_MS: "1000", RUNTIME_TRIP_KEY_MASTER: undefined, RUNTIME_LEGACY_TRIP_KEY: undefined,
  };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await import(`../server.js?msi=${Math.random()}`);
  const server = mod.createRuntimeGateway();
  const origin = await listen(server);
  gateways.push(server);
  return { origin, mod };
}

const reset = () => { for (const t of Object.values(trips)) t.seen.length = 0; controlPlaneKeys.length = 0; };
const call = (gw, tripId, what, key) => {
  if (what === "list") return fetch(`${gw.origin}/internal/t/${tripId}/participants`, { headers: { "x-api-key": key } });
  return fetch(`${gw.origin}/internal/t/${tripId}/participants/${what}`, {
    method: "POST", headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ tripId, userId: "user_abcdefgh", runtimeUsername: "bob" }),
  });
};
const WHAT = ["list", "adopt", "release"];

test("per-trip keys on: list, adopt and release send a derived trip derive(master, ITS id), and a shared trip the legacy key", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  for (const what of WHAT) assert.equal((await call(gw, TRIP_D, what, EXCHANGE)).status, 200, `derived trip: ${what}`);
  for (const what of WHAT) assert.equal((await call(gw, TRIP_S, what, EXCHANGE)).status, 200, `shared trip: ${what}`);
  assert.deepEqual(trips[TRIP_D].seen.map((r) => r.key), WHAT.map(() => derive(TRIP_D)));
  assert.deepEqual(trips[TRIP_S].seen.map((r) => r.key), WHAT.map(() => LEGACY));
  assert.deepEqual(trips[TRIP_D].seen.map((r) => `${r.method} ${r.url}`), [
    "GET /api/internal/control-plane/participants", "POST /api/internal/control-plane/participants/adopt", "POST /api/internal/control-plane/participants/release",
  ]);
  // The control-plane key was never handed to a trip site.
  for (const t of Object.values(trips)) for (const r of t.seen) assert.notEqual(r.key, EXCHANGE);
});

test("per-trip keys on: their CALLER is still checked against RUNTIME_EXCHANGE_KEY; a trip's key, the legacy key and the master open nothing and no trip is asked", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  for (const wrong of [derive(TRIP_D), LEGACY, MASTER, "", "nope"]) {
    for (const what of WHAT) assert.equal((await call(gw, TRIP_D, what, wrong)).status, 401, `${what} with ${wrong ? "a wrong key" : "no key"}`);
  }
  assert.deepEqual(trips[TRIP_D].seen, []);
});

test("per-trip keys on: a shared trip with no legacy key is 503 for all three, and nothing is sent to it with any key", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER });
  reset();
  for (const what of WHAT) {
    const response = await call(gw, TRIP_S, what, EXCHANGE);
    assert.equal(response.status, 503, what);
    assert.deepEqual(await response.json(), { error: "RUNTIME_UNAVAILABLE" });
  }
  assert.deepEqual(trips[TRIP_S].seen, []);
  assert.equal((await call(gw, TRIP_D, "adopt", EXCHANGE)).status, 200, "a derived trip on the same gateway is unaffected");
});

test("per-trip keys off (no master): the three routes send RUNTIME_EXCHANGE_KEY, as the older participant routes do", async () => {
  const held = fakeTrip(EXCHANGE);
  const origin = await listen(held.server);
  const saved = trips[TRIP_D].origin;
  trips[TRIP_D].origin = origin;
  try {
    const gw = await startGateway({});
    reset();
    for (const what of WHAT) assert.equal((await call(gw, TRIP_D, what, EXCHANGE)).status, 200, what);
    assert.deepEqual(held.seen.map((r) => r.key), WHAT.map(() => EXCHANGE));
  } finally { trips[TRIP_D].origin = saved; await close(held.server); }
});

test("per-trip keys on: a trip that refuses its key answers 401 to the caller, once per call, never retried with another key", async () => {
  const stubborn = fakeTrip("nobody-holds-this-key");
  const origin = await listen(stubborn.server);
  const saved = trips[TRIP_D].origin;
  trips[TRIP_D].origin = origin;
  try {
    const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
    reset();
    for (const what of WHAT) assert.equal((await call(gw, TRIP_D, what, EXCHANGE)).status, 401, what);
    assert.deepEqual(stubborn.seen.map((r) => r.key), WHAT.map(() => derive(TRIP_D)));
  } finally { trips[TRIP_D].origin = saved; await close(stubborn.server); }
});

// The hops (__member-claims, __member-invites) call the control plane through `controlPlane()`, the one helper that sets
// RUNTIME_EXCHANGE_KEY (gateway.test.js reads what they send, with a real session cookie). What this file adds is that, with
// per-trip keys on, a hop without a session reaches no trip site and asks the control plane nothing.
test("an organizer hop without a session asks neither a trip site nor the control plane", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  assert.equal((await fetch(`${gw.origin}/t/${TRIP_D}/__member-claims`)).status, 401);
  assert.equal((await fetch(`${gw.origin}/t/${TRIP_D}/__member-invites`)).status, 401);
  assert.deepEqual(trips[TRIP_D].seen, []);
  assert.deepEqual(controlPlaneKeys, []);
});
