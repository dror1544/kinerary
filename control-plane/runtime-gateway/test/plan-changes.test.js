// The group line's read through the gateway (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2, AC-K2.11).
//
// The control plane never sends a trip site a key: it asks GET /internal/t/<id>/plan-changes here, with
// RUNTIME_EXCHANGE_KEY, and the gateway reads the site with the key the route's `tripKey` names. Each fake trip holds
// exactly one key and records every request it sees, with the key it carried.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

const MASTER = "test-master-do-not-use-0001";
const TRIP_D = "trip_derivedderivedderived"; // holds derive(MASTER, id)
const TRIP_S = "trip_sharedsharedshared"; // holds the legacy key
const TRIP_R = "trip_redirectredirect"; // answers 302
const TRIP_BIG = "trip_bigbodybigbodybig"; // answers more than the cap
const TRIP_HTML = "trip_htmlhtmlhtmlhtml"; // answers 200 text/html
const TRIP_ERR = "trip_errorpageerrorpage"; // answers 404 with an html page
const EXCHANGE = "exchange-key";
const LEGACY = "legacy-key-do-not-use";
const PORTAL = "https://app.example.test";
const CAP = 512 * 1024;
const ANSWER = { active_revision_id: "rev_1", changes: [] };

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const derive = (tripId, master = MASTER) => createHmac("sha256", master).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");

function fakeTrip(held, behaviour = "ok") {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], tripId: req.headers["x-control-plane-trip-id"], accept: req.headers.accept });
    if (req.headers["x-api-key"] !== held) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"AUTHENTICATION_REQUIRED"}'); }
    if (behaviour === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" }); return res.end(); }
    if (behaviour === "big") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ pad: "x".repeat(CAP + 10) })); }
    if (behaviour === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>nope</html>"); }
    if (behaviour === "errorpage") { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html>Cannot GET</html>"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ANSWER));
  });
  return { server, seen };
}

let controlPlane, controlPlaneOrigin;
const trips = {};
const routeKinds = { [TRIP_D]: "derived", [TRIP_S]: "shared", [TRIP_R]: "derived", [TRIP_BIG]: "derived", [TRIP_HTML]: "derived", [TRIP_ERR]: "derived" };
const gateways = [];

before(async () => {
  for (const [id, held, behaviour] of [[TRIP_D, derive(TRIP_D)], [TRIP_S, LEGACY], [TRIP_R, derive(TRIP_R), "redirect"], [TRIP_BIG, derive(TRIP_BIG), "big"], [TRIP_HTML, derive(TRIP_HTML), "html"], [TRIP_ERR, derive(TRIP_ERR), "errorpage"]]) {
    const trip = fakeTrip(held, behaviour);
    trips[id] = { held, seen: trip.seen, server: trip.server, origin: await listen(trip.server), base: "" };
  }
  controlPlane = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== EXCHANGE) { res.statusCode = 401; return res.end("{}"); }
    const route = req.url.match(/^\/internal\/runtime-routes\/([^/]+)$/);
    const id = route && decodeURIComponent(route[1]);
    if (id && trips[id]) return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin: trips[id].origin, upstreamBasePath: trips[id].base, tripKey: routeKinds[id] }));
    res.statusCode = 404; res.end("{}");
  });
  controlPlaneOrigin = await listen(controlPlane);
});
after(async () => { await Promise.all([...gateways.map(close), close(controlPlane), ...Object.values(trips).map((t) => close(t.server))]); });

async function startGateway(env) {
  const base = {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE,
    RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test",
    RUNTIME_UPSTREAM_TIMEOUT_MS: "1000", RUNTIME_TRIP_KEY_MASTER: undefined, RUNTIME_LEGACY_TRIP_KEY: undefined,
  };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await import(`../server.js?planchanges=${Math.random()}`);
  const server = mod.createRuntimeGateway();
  const origin = await listen(server);
  gateways.push(server);
  return { origin };
}
const reset = () => { for (const t of Object.values(trips)) t.seen.length = 0; };
const ask = (gw, tripId, { key = EXCHANGE, query = "", method = "GET", headers = {} } = {}) =>
  fetch(`${gw.origin}/internal/t/${tripId}/plan-changes${query}`, { method, headers: { ...(key === null ? {} : { "x-api-key": key }), ...headers } });

test("AC-K2.11: a derived trip is read with derive(master, ITS id), and the answer is passed through", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  const response = await ask(gw, TRIP_D, { query: "?since=rev_0" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), ANSWER);
  assert.deepEqual(trips[TRIP_D].seen, [{ method: "GET", url: "/api/internal/control-plane/plan-changes?since=rev_0", key: derive(TRIP_D), tripId: TRIP_D, accept: "application/json" }]);
  assert.ok(![EXCHANGE, LEGACY, MASTER].includes(trips[TRIP_D].seen[0].key));
});

test("AC-K2.11: no since is no query; a shared trip is read with the legacy key", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  assert.equal((await ask(gw, TRIP_S)).status, 200);
  assert.deepEqual(trips[TRIP_S].seen.map((r) => [r.url, r.key]), [["/api/internal/control-plane/plan-changes", LEGACY]]);
});

test("AC-K2.11: a shared trip with no legacy key is 503 and NO request reaches the trip", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER });
  reset();
  const response = await ask(gw, TRIP_S, { query: "?since=rev_0" });
  assert.equal(response.status, 503);
  const body = await response.json();
  console.log(`shared trip, no legacy key: GET gateway /internal/t/<trip id>/plan-changes?since=rev_0 (exchange key) -> ${response.status} ${JSON.stringify(body)}; requests that reached the trip: ${trips[TRIP_S].seen.length}`);
  assert.deepEqual(body, { error: "RUNTIME_UNAVAILABLE" });
  assert.deepEqual(trips[TRIP_S].seen, [], "nothing was sent to the trip, with any key");
});

test("AC-K2.11: with per-trip keys off, the site is read with RUNTIME_EXCHANGE_KEY (what it holds today)", async () => {
  const held = fakeTrip(EXCHANGE);
  const origin = await listen(held.server);
  const saved = trips[TRIP_D].origin;
  trips[TRIP_D].origin = origin;
  try {
    const gw = await startGateway({});
    assert.equal((await ask(gw, TRIP_D, { query: "?since=rev_0" })).status, 200);
    assert.deepEqual(held.seen.map((r) => r.key), [EXCHANGE]);
  } finally { trips[TRIP_D].origin = saved; await close(held.server); }
});

test("AC-K2.11: a wrong, absent or trip-held caller key is 401 and no request reaches any trip", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  for (const wrong of [derive(TRIP_D), LEGACY, MASTER, "", "nope", null]) {
    const response = await ask(gw, TRIP_D, { key: wrong });
    assert.equal(response.status, 401, wrong === null ? "no key" : "a wrong key");
    const body = await response.json();
    assert.deepEqual(body, { error: "AUTHENTICATION_REQUIRED" });
    console.log(`caller key ${wrong === null ? "absent" : wrong === derive(TRIP_D) ? "derived(A)" : wrong === LEGACY ? "legacy" : wrong === MASTER ? "master" : wrong === "" ? "empty" : "wrong"}: GET gateway /internal/t/<trip id>/plan-changes -> ${response.status} ${JSON.stringify(body)}`);
  }
  console.log(`requests that reached the trip after ${6} refused callers: ${trips[TRIP_D].seen.length}`);
  assert.deepEqual(trips[TRIP_D].seen, [], "refused callers reach no trip");
});

test("AC-K2.11: only `since` is forwarded, only in the site's own shape; a malformed or repeated one is 400 with no request", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  const response = await ask(gw, TRIP_D, { query: "?since=rev_0&evil=1&x-api-key=nope", headers: { "x-trip-key": LEGACY, "x-control-plane-trip-id": TRIP_S } });
  assert.equal(response.status, 200);
  assert.equal(trips[TRIP_D].seen[0].url, "/api/internal/control-plane/plan-changes?since=rev_0", "the other parameters are dropped");
  assert.equal(trips[TRIP_D].seen[0].tripId, TRIP_D, "the trip id header is the route's, not the caller's");
  reset();
  for (const query of ["?since=../x", `?since=${"a".repeat(101)}`, "?since=", "?since=a&since=b", "?since=a%20b"]) {
    assert.equal((await ask(gw, TRIP_D, { query })).status, 400, query);
  }
  assert.deepEqual(trips[TRIP_D].seen, []);
  assert.equal((await ask(gw, "not-a-trip")).status, 404);
  assert.equal((await ask(gw, TRIP_D, { method: "POST" })).status, 404, "GET only");
});

test("AC-K2.11: a redirect from the site is a 502 and is not followed", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  const elsewhere = [];
  const target = http.createServer((req, res) => { elsewhere.push(req.headers["x-api-key"]); res.end("{}"); });
  const targetOrigin = await listen(target);
  const redirector = http.createServer((req, res) => { res.writeHead(307, { location: `${targetOrigin}/stolen` }); res.end(); });
  const redirectorOrigin = await listen(redirector);
  const saved = trips[TRIP_R].origin;
  trips[TRIP_R].origin = redirectorOrigin;
  try {
    reset();
    const response = await ask(gw, TRIP_R, { query: "?since=rev_0" });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "UPSTREAM_REDIRECT" });
    assert.deepEqual(elsewhere, [], "the redirect target was never contacted");
  } finally { trips[TRIP_R].origin = saved; await close(target); await close(redirector); }
  const fresh = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY }); // the first one cached the redirector as the route
  assert.equal((await ask(fresh, TRIP_R)).status, 502, "a site that answers 302 to a closed port is the same");
});

test("AC-K2.11: a body over the cap is refused (502), a 2xx that is not JSON is a 502, a site error page keeps its status", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  const big = await ask(gw, TRIP_BIG);
  assert.equal(big.status, 502);
  assert.deepEqual(await big.json(), { error: "UPSTREAM_BODY_TOO_LARGE" });
  const html = await ask(gw, TRIP_HTML);
  assert.equal(html.status, 502);
  assert.deepEqual(await html.json(), { error: "UPSTREAM_NOT_JSON" });
  const page = await ask(gw, TRIP_ERR);
  assert.equal(page.status, 404);
  assert.deepEqual(await page.json(), { error: "UPSTREAM_ERROR" });
});

test("AC-K2.11: a trip that refuses its key answers 401 once, with no second key tried", async () => {
  const stubborn = fakeTrip("nobody-holds-this-key");
  const origin = await listen(stubborn.server);
  const saved = trips[TRIP_D].origin;
  trips[TRIP_D].origin = origin;
  try {
    const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
    const response = await ask(gw, TRIP_D, { query: "?since=rev_0" });
    assert.equal(response.status, 401);
    assert.deepEqual(stubborn.seen.map((r) => r.key), [derive(TRIP_D)]);
  } finally { trips[TRIP_D].origin = saved; await close(stubborn.server); }
});

test("AC-K2.11: a base path on the route is kept", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  trips[TRIP_D].base = "/trips/colmar";
  try {
    reset();
    assert.equal((await ask(gw, TRIP_D, { query: "?since=rev_0" })).status, 200);
    assert.equal(trips[TRIP_D].seen[0].url, "/trips/colmar/api/internal/control-plane/plan-changes?since=rev_0");
  } finally { trips[TRIP_D].base = ""; }
});
