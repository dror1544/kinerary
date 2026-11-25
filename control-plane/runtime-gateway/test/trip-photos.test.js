// The relay's photos from a trip's group through the gateway (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B).
//
//   POST /internal/t/<trip>/photos         one photo (JSON, bytes in base64)
//   GET  /internal/t/<trip>/photo-settings the two organizer settings
//   POST /internal/t/<trip>/photo-notice   the group was told
//
// Shaped like the participant and plan-changes routes: the caller proves itself with RUNTIME_EXCHANGE_KEY, the trip is reached with
// the key its route says it holds, a redirect is never followed, and a refused caller reaches no trip. A photo is far larger than the
// other bodies, so the body cap is its own: a photo that fits is forwarded whole, one past the cap is 413 and reaches no trip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

const MASTER = "test-master-do-not-use-0001";
const TRIP_D = "trip_derivedderivedderived";
const TRIP_R = "trip_redirectredirect";
const EXCHANGE = "exchange-key";
const LEGACY = "legacy-key-do-not-use";
const PORTAL = "https://app.example.test";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const derive = (tripId) => createHmac("sha256", MASTER).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");
const bodyOf = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString())); });

function fakeTrip(held, behaviour = "ok") {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const body = await bodyOf(req);
    seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], tripId: req.headers["x-control-plane-trip-id"], type: req.headers["content-type"], body });
    if (req.headers["x-api-key"] !== held) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"AUTHENTICATION_REQUIRED"}'); }
    if (behaviour === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  return { server, seen };
}

let controlPlane, controlPlaneOrigin;
const trips = {};
const gateways = [];

before(async () => {
  for (const [id, held, behaviour] of [[TRIP_D, derive(TRIP_D)], [TRIP_R, derive(TRIP_R), "redirect"]]) {
    const trip = fakeTrip(held, behaviour);
    trips[id] = { seen: trip.seen, server: trip.server, origin: await listen(trip.server) };
  }
  controlPlane = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== EXCHANGE) { res.statusCode = 401; return res.end("{}"); }
    const route = req.url.match(/^\/internal\/runtime-routes\/([^/]+)$/);
    const id = route && decodeURIComponent(route[1]);
    if (id && trips[id]) return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin: trips[id].origin, upstreamBasePath: "", tripKey: "derived" }));
    res.statusCode = 404; res.end("{}");
  });
  controlPlaneOrigin = await listen(controlPlane);
});
after(async () => { await Promise.all([...gateways.map(close), close(controlPlane), ...Object.values(trips).map((t) => close(t.server))]); });

async function startGateway() {
  const env = {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE,
    RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test",
    RUNTIME_UPSTREAM_TIMEOUT_MS: "1000", RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY,
  };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import(`../server.js?tripphotos=${Math.random()}`);
  const server = mod.createRuntimeGateway();
  const origin = await listen(server);
  gateways.push(server);
  return { origin };
}
const reset = () => { for (const t of Object.values(trips)) t.seen.length = 0; };
const post = (gw, tripId, path, body, { key = EXCHANGE } = {}) => fetch(`${gw.origin}/internal/t/${tripId}/${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(key === null ? {} : { "x-api-key": key }) }, body: typeof body === "string" ? body : JSON.stringify(body),
});

test("a photo is forwarded to the trip with THAT trip's key, the body whole, and the answer passed through", async () => {
  const gw = await startGateway();
  reset();
  const data = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64"); // ~4 MB of JSON: past the other routes' 32 KB cap
  const response = await post(gw, TRIP_D, "photos", { tripId: TRIP_D, sender: "42", messageKey: "1:2", mode: "auto", data });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, url: "/api/internal/control-plane/photos" });
  const seen = trips[TRIP_D].seen;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, derive(TRIP_D), "the trip's own key, not the exchange key");
  assert.notEqual(seen[0].key, EXCHANGE);
  assert.equal(JSON.parse(seen[0].body).data, data, "the bytes arrive whole");
  assert.equal(seen[0].type, "application/json");
});

test("a wrong, absent or trip-held caller key is 401 and NO request reaches the trip (the wrong trip key, refused)", async () => {
  const gw = await startGateway();
  reset();
  for (const wrong of [derive(TRIP_D), LEGACY, MASTER, "", "nope", null]) {
    const response = await post(gw, TRIP_D, "photos", { tripId: TRIP_D, mode: "auto", data: "AA==" }, { key: wrong });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "AUTHENTICATION_REQUIRED" });
    const settings = await fetch(`${gw.origin}/internal/t/${TRIP_D}/photo-settings`, { headers: wrong === null ? {} : { "x-api-key": wrong } });
    assert.equal(settings.status, 401);
    const notice = await post(gw, TRIP_D, "photo-notice", { tripId: TRIP_D }, { key: wrong });
    assert.equal(notice.status, 401);
  }
  assert.deepEqual(trips[TRIP_D].seen, [], "refused callers reach no trip");
});

test("a body that names another trip, no trip id, or is not JSON is 400 and reaches no trip", async () => {
  const gw = await startGateway();
  reset();
  for (const body of [{ tripId: TRIP_R, data: "AA==" }, { data: "AA==" }, "not json", "[]"]) {
    const response = await post(gw, TRIP_D, "photos", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await post(gw, "not-a-trip", "photos", { tripId: "not-a-trip" })).status, 404);
  assert.deepEqual(trips[TRIP_D].seen, []);
});

test("a body past the photo cap is 413 and reaches no trip", async () => {
  const gw = await startGateway();
  reset();
  const response = await post(gw, TRIP_D, "photos", `{"tripId":"${TRIP_D}","data":"${"A".repeat(29 * 1024 * 1024)}"}`);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "BODY_TOO_LARGE" });
  assert.deepEqual(trips[TRIP_D].seen, []);
});

test("the settings read carries the trip id in the header and no body; the notice carries it in the body", async () => {
  const gw = await startGateway();
  reset();
  const settings = await fetch(`${gw.origin}/internal/t/${TRIP_D}/photo-settings?evil=1`, { headers: { "x-api-key": EXCHANGE } });
  assert.equal(settings.status, 200);
  assert.equal((await post(gw, TRIP_D, "photo-notice", { tripId: TRIP_D })).status, 200);
  const [read, notice] = trips[TRIP_D].seen;
  assert.deepEqual([read.method, read.url, read.key, read.tripId], ["GET", "/api/internal/control-plane/photo-settings", derive(TRIP_D), TRIP_D], "nothing the caller put in the query is forwarded");
  assert.deepEqual([notice.method, notice.url, notice.key], ["POST", "/api/internal/control-plane/photo-notice", derive(TRIP_D)]);
});

test("a redirect from the trip is never followed: 502, and the key went nowhere else", async () => {
  const gw = await startGateway();
  reset();
  const response = await post(gw, TRIP_R, "photos", { tripId: TRIP_R, mode: "auto", data: "AA==" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "UPSTREAM_REDIRECT" });
  assert.equal(trips[TRIP_R].seen.length, 1);
});

test("an unknown method or path is not a photo route", async () => {
  const gw = await startGateway();
  assert.equal((await fetch(`${gw.origin}/internal/t/${TRIP_D}/photos`, { headers: { "x-api-key": EXCHANGE } })).status, 404);
  assert.equal((await post(gw, TRIP_D, "photo-settings", { tripId: TRIP_D })).status, 404);
});
