// The trip group's photo through the gateway (docs/specs/sprint-9/x-trip-group-photo.md, "the road").
//
// The control plane never holds a trip's key: it POSTs /internal/t/<id>/group-photo/{claim,result} here with
// RUNTIME_EXCHANGE_KEY, and the gateway POSTs the trip's own site with the key that trip holds, carrying a body BUILT HERE
// from the path's trip id and a closed set of fields. Each fake trip holds one key and records every request it sees.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

const MASTER = "test-master-do-not-use-0001";
const TRIP_D = "trip_derivedderivedderived";
const TRIP_R = "trip_redirectredirect";
const TRIP_BIG = "trip_bigbodybigbodybig";
const TRIP_HTML = "trip_htmlhtmlhtmlhtml";
const TRIP_ERR = "trip_errorpageerrorpage";
const EXCHANGE = "exchange-key";
const LEGACY = "legacy-key-do-not-use";
const PORTAL = "https://app.example.test";
const CAP = 3 * 1024 * 1024;
const TOKEN = "0123456789abcdef01234567";
const CLAIM = { request: { id: 7, attempt: 1, logo_hash: "0123456789abcdef", requested_at: "2026-12-03T10:00:00Z" }, photo: { content_type: "image/png", base64: "AAAA" } };

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const derive = (tripId, master = MASTER) => createHmac("sha256", master).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");

function fakeTrip(held, behaviour = "ok") {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body: Buffer.concat(chunks).toString("utf8") });
      if (req.headers["x-api-key"] !== held) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"AUTHENTICATION_REQUIRED"}'); }
      if (behaviour === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" }); return res.end(); }
      if (behaviour === "big") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ pad: "x".repeat(CAP + 10) })); }
      if (behaviour === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>nope</html>"); }
      if (behaviour === "errorpage") { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html>Cannot POST</html>"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.endsWith("/claim") ? CLAIM : { ok: true }));
    });
  });
  return { server, seen };
}

let controlPlane, controlPlaneOrigin;
const trips = {};
const gateways = [];

before(async () => {
  for (const [id, behaviour] of [[TRIP_D], [TRIP_R, "redirect"], [TRIP_BIG, "big"], [TRIP_HTML, "html"], [TRIP_ERR, "errorpage"]]) {
    const trip = fakeTrip(derive(id), behaviour);
    trips[id] = { seen: trip.seen, server: trip.server, origin: await listen(trip.server), base: "" };
  }
  controlPlane = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== EXCHANGE) { res.statusCode = 401; return res.end("{}"); }
    const route = req.url.match(/^\/internal\/runtime-routes\/([^/]+)$/);
    const id = route && decodeURIComponent(route[1]);
    if (id && trips[id]) return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin: trips[id].origin, upstreamBasePath: trips[id].base, tripKey: "derived" }));
    res.statusCode = 404; res.end("{}");
  });
  controlPlaneOrigin = await listen(controlPlane);
});
after(async () => { await Promise.all([...gateways.map(close), close(controlPlane), ...Object.values(trips).map((t) => close(t.server))]); });

async function startGateway(env = {}) {
  const base = {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE,
    RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test",
    RUNTIME_UPSTREAM_TIMEOUT_MS: "1000", RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY,
  };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await import(`../server.js?groupphoto=${Math.random()}`);
  const server = mod.createRuntimeGateway();
  const origin = await listen(server);
  gateways.push(server);
  return { origin };
}
const reset = () => { for (const t of Object.values(trips)) t.seen.length = 0; };
const post = (gw, tripId, action, { key = EXCHANGE, body, method = "POST" } = {}) =>
  fetch(`${gw.origin}/internal/t/${tripId}/group-photo/${action}`, { method, headers: { ...(key === null ? {} : { "x-api-key": key }), "content-type": "application/json" }, ...(method === "POST" ? { body: body === undefined ? "{}" : JSON.stringify(body) } : {}) });

test("claim: the site is POSTed with the trip's own derived key and a body built here (the path's trip id and nothing else); the answer is passed through", async () => {
  const gw = await startGateway();
  reset();
  const response = await post(gw, TRIP_D, "claim", { body: { tripId: "trip_someoneelse01", request_id: 99, surprise: true } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), CLAIM);
  assert.equal(trips[TRIP_D].seen.length, 1);
  const seen = trips[TRIP_D].seen[0];
  assert.deepEqual([seen.method, seen.url, seen.key], ["POST", "/api/internal/control-plane/group-photo/claim", derive(TRIP_D)]);
  assert.deepEqual(JSON.parse(seen.body), { tripId: TRIP_D }, "a caller's body never names another trip or adds a field");
  assert.ok(![EXCHANGE, LEGACY, MASTER].includes(seen.key));
});

test("result: only request_id, claim_token, status and detail are forwarded, with the path's trip id", async () => {
  const gw = await startGateway();
  reset();
  const response = await post(gw, TRIP_D, "result", { body: { request_id: 7, claim_token: TOKEN, status: "bot_lacks_rights", detail: "administrator without can_change_info", tripId: "trip_someoneelse01", extra: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(trips[TRIP_D].seen[0].body), { tripId: TRIP_D, request_id: 7, claim_token: TOKEN, status: "bot_lacks_rights", detail: "administrator without can_change_info" });
  assert.equal(trips[TRIP_D].seen[0].url, "/api/internal/control-plane/group-photo/result");
});

test("result: a body that is not a closed-set report is 400 and nothing reaches the trip", async () => {
  const gw = await startGateway();
  reset();
  const ok = { request_id: 7, claim_token: TOKEN, status: "done" };
  for (const bad of [{}, { request_id: 7 }, { ...ok, request_id: "7" }, { ...ok, request_id: 0 }, { ...ok, status: "expired" }, { ...ok, status: "pending" }, { ...ok, detail: 5 }, { ...ok, status: "failed", detail: "x".repeat(301) }, { request_id: 7, status: "done" }, { ...ok, claim_token: 5 }, { ...ok, claim_token: "short" }, { ...ok, claim_token: "Z".repeat(24) }, [], "done"]) {
    assert.equal((await post(gw, TRIP_D, "result", { body: bad })).status, 400, JSON.stringify(bad));
  }
  const notJson = await fetch(`${gw.origin}/internal/t/${TRIP_D}/group-photo/result`, { method: "POST", headers: { "x-api-key": EXCHANGE, "content-type": "application/json" }, body: "{nope" });
  assert.equal(notJson.status, 400);
  assert.deepEqual(trips[TRIP_D].seen, []);
});

test("no key, a wrong key, a trip's own key and the legacy key are all 401 and nothing reaches the trip", async () => {
  const gw = await startGateway();
  reset();
  for (const key of [null, "nope", derive(TRIP_D), LEGACY]) {
    for (const action of ["claim", "result"]) assert.equal((await post(gw, TRIP_D, action, { key, body: { request_id: 7, claim_token: TOKEN, status: "done" } })).status, 401, `${key} ${action}`);
  }
  assert.deepEqual(trips[TRIP_D].seen, []);
});

test("a method other than POST, an unknown action and a malformed trip id never reach a trip", async () => {
  const gw = await startGateway();
  reset();
  assert.equal((await post(gw, TRIP_D, "claim", { method: "GET" })).status, 404);
  assert.equal((await post(gw, TRIP_D, "launch")).status, 404);
  assert.equal((await post(gw, "not-a-trip", "claim")).status, 404);
  assert.deepEqual(trips[TRIP_D].seen, []);
});

test("a redirect from the site is a 502 and is not followed; a body over the cap is a 502; a 2xx that is not JSON is a 502; a site's own error page keeps its status", async () => {
  const gw = await startGateway();
  reset();
  const redirect = await post(gw, TRIP_R, "claim");
  assert.equal(redirect.status, 502);
  assert.deepEqual(await redirect.json(), { error: "UPSTREAM_REDIRECT" });
  const big = await post(gw, TRIP_BIG, "claim");
  assert.equal(big.status, 502);
  assert.deepEqual(await big.json(), { error: "UPSTREAM_BODY_TOO_LARGE" });
  const html = await post(gw, TRIP_HTML, "claim");
  assert.equal(html.status, 502);
  assert.deepEqual(await html.json(), { error: "UPSTREAM_NOT_JSON" });
  const page = await post(gw, TRIP_ERR, "claim");
  assert.equal(page.status, 404);
  assert.deepEqual(await page.json(), { error: "UPSTREAM_ERROR" });
});
