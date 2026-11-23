// The gateway never follows a redirect while it holds a key (docs/specs/sprint-9/x-member-sign-in.md, amendment A28;
// docs/runtime-session-exchange.md, "Per-trip keys").
//
// Every request the gateway makes with fetch carries a key: a trip site is sent that trip's own key, the control plane is sent
// RUNTIME_EXCHANGE_KEY. fetch follows redirects by default and forwards `x-api-key` to a foreign origin, so a trip site (or a
// control plane) that answered 302/307 to somewhere else got the key sent there, and the foreign answer was returned as the site's:
// adopt "ok", release 200. `timedFetch` is now `redirect: "manual"` and a 3xx from a trip site is a 502 UPSTREAM_REDIRECT, as
// `planChanges` has always answered. Each test points a trip site at a stand-in that redirects, to a SECOND server that counts every
// request it gets: the assertion is zero, not "no key".
//
// What must NOT change: the browser-facing reverse proxy (`proxy()`, node:http, not fetch) passes a site's own 3xx on to the BROWSER.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

const MASTER = "test-master-do-not-use-0001";
const TRIP_D = "trip_redirectderived0001"; // derived key
const TRIP_S = "trip_redirectshared00001"; // the legacy key
const EXCHANGE = "exchange-key";
const LEGACY = "legacy-key-do-not-use";
const PORTAL = "https://app.example.test";
const derive = (tripId) => createHmac("sha256", MASTER).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

// What a believing gateway would have taken as the trip site's own answer.
const FOREIGN = JSON.stringify({ ok: true, released: true, participants: [], username: "bob" });
let target, targetOrigin, targetSeen;
let site, siteOrigin, siteSeen, siteMode;
let controlPlane, controlPlaneOrigin, cpMode, cpSeen;
const gateways = [];

before(async () => {
  targetSeen = [];
  target = http.createServer((req, res) => { targetSeen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] }); req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end(FOREIGN); });
  targetOrigin = await listen(target);
  siteSeen = []; siteMode = "redirect-cross";
  site = http.createServer((req, res) => {
    siteSeen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] });
    req.resume();
    if (req.url.startsWith("/api/internal/")) {
      const status = siteMode.startsWith("307") ? 307 : 302;
      res.writeHead(status, { location: siteMode.endsWith("same") ? "/somewhere-else" : `${targetOrigin}/stolen` });
      return res.end();
    }
    // An ordinary page: the site redirects the BROWSER (a trailing-slash redirect, or an absolute path).
    if (req.url === "/old-page") { res.writeHead(301, { location: "/new-page" }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  siteOrigin = await listen(site);
  cpSeen = []; cpMode = "ok";
  controlPlane = http.createServer((req, res) => {
    cpSeen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] });
    req.resume();
    res.setHeader("content-type", "application/json");
    const route = req.url.match(/^\/internal\/runtime-routes\/([^/]+)$/);
    if (route && cpMode === "redirect") { res.writeHead(302, { location: `${targetOrigin}/stolen-route` }); return res.end(); }
    const id = route && decodeURIComponent(route[1]);
    if (id === TRIP_D || id === TRIP_S) return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin: siteOrigin, upstreamBasePath: "", tripKey: id === TRIP_D ? "derived" : "shared" }));
    res.statusCode = 404; res.end("{}");
  });
  controlPlaneOrigin = await listen(controlPlane);
});
after(async () => { await Promise.all([...gateways.map(close), close(controlPlane), close(site), close(target)]); });

async function startGateway(controlPlaneUrl = controlPlaneOrigin) {
  const env = {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneUrl, RUNTIME_EXCHANGE_KEY: EXCHANGE, RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random",
    PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test", RUNTIME_UPSTREAM_TIMEOUT_MS: "1000",
    RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY,
  };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import(`../server.js?redirects=${Math.random()}`);
  const server = mod.createRuntimeGateway();
  const origin = await listen(server);
  gateways.push(server);
  return { origin };
}
const reset = () => { targetSeen.length = 0; siteSeen.length = 0; cpSeen.length = 0; };
const BODY = (tripId) => JSON.stringify({ tripId, userId: "user_abcdefgh", runtimeUsername: "bob" });
const calls = {
  list: (gw, tripId) => fetch(`${gw.origin}/internal/t/${tripId}/participants`, { headers: { "x-api-key": EXCHANGE } }),
  exists: (gw, tripId) => fetch(`${gw.origin}/internal/t/${tripId}/participants/bob`, { headers: { "x-api-key": EXCHANGE } }),
  provision: (gw, tripId) => fetch(`${gw.origin}/internal/t/${tripId}/participants`, { method: "POST", headers: { "x-api-key": EXCHANGE, "content-type": "application/json" }, body: BODY(tripId) }),
  adopt: (gw, tripId) => fetch(`${gw.origin}/internal/t/${tripId}/participants/adopt`, { method: "POST", headers: { "x-api-key": EXCHANGE, "content-type": "application/json" }, body: BODY(tripId) }),
  release: (gw, tripId) => fetch(`${gw.origin}/internal/t/${tripId}/participants/release`, { method: "POST", headers: { "x-api-key": EXCHANGE, "content-type": "application/json" }, body: BODY(tripId) }),
};

for (const mode of ["302-cross", "307-cross", "302-same", "307-same"]) {
  for (const [tripId, held] of [[TRIP_D, derive(TRIP_D)], [TRIP_S, LEGACY]]) {
    test(`a trip site answering ${mode.replace("-", " to a ")}-origin Location (${tripId === TRIP_D ? "derived" : "shared"} key): list, exists, provision, adopt and release are each a 502 UPSTREAM_REDIRECT and the target gets no request`, async () => {
      const gw = await startGateway();
      siteMode = mode;
      const evidence = [];
      for (const [name, call] of Object.entries(calls)) {
        reset();
        const response = await call(gw, tripId);
        assert.equal(response.status, 502, name);
        assert.deepEqual(await response.json(), { error: "UPSTREAM_REDIRECT" }, name);
        assert.equal(siteSeen.length, 1, `${name}: the trip site was asked once`);
        assert.equal(siteSeen[0].key, held, `${name}: with that trip's own key (never the control-plane key)`);
        assert.notEqual(siteSeen[0].key, EXCHANGE);
        assert.deepEqual(targetSeen, [], `${name}: the redirect target received ${JSON.stringify(targetSeen)}`);
        evidence.push(`${name}: site saw ${siteSeen[0].method} ${siteSeen[0].url}; gateway answered ${response.status}; target hits ${targetSeen.length}`);
      }
      if (process.env.REDIRECT_EVIDENCE) console.log(`${mode} ${tripId}\n  ${evidence.join("\n  ")}`);
    });
  }
}

test("a CONTROL PLANE that answers 302 holds the exchange key too: the route lookup fails closed and the redirect target gets no request", async () => {
  const gw = await startGateway();
  siteMode = "302-cross";
  cpMode = "redirect";
  try {
    reset();
    const response = await calls.list(gw, TRIP_D);
    assert.equal(response.status, 503, "the route could not be read: unavailable, not an answer");
    assert.equal(cpSeen.length, 1, "the control plane was asked once and its redirect was not followed");
    assert.equal(cpSeen[0].key, EXCHANGE);
    assert.deepEqual(targetSeen, [], `the redirect target received ${JSON.stringify(targetSeen)}`);
    assert.deepEqual(siteSeen, [], "and no trip site was asked");
    if (process.env.REDIRECT_EVIDENCE) console.log(`control plane 302: gateway answered ${response.status}; control plane saw ${JSON.stringify(cpSeen)}; target hits ${targetSeen.length}`);
  } finally { cpMode = "ok"; }
});

test("what is unchanged: the reverse proxy passes a trip site's own 3xx to the BROWSER (it is node:http, not fetch, and is not touched)", async () => {
  // A live session is needed to reach the proxy, so this test brings its own control plane (grant, liveness, route) and its own trip site.
  let sessionRedirects = true;
  const pageSite = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/internal/control-plane/session") {
      if (sessionRedirects) { res.writeHead(307, { location: `${targetOrigin}/stolen-session` }); return res.end(); }
      return res.end(JSON.stringify({ token: "runtime-jwt" }));
    }
    if (req.url === "/old-page") { res.writeHead(301, { location: "/new-page" }); return res.end(); }
    res.end(JSON.stringify({ path: req.url }));
  });
  const pageSiteOrigin = await listen(pageSite);
  const granting = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/runtime-launch/consume") return res.end(JSON.stringify({ tripId: TRIP_D, userId: "user_abcdefgh", role: "owner", runtimeUsername: null, audience: "runtime_gateway", sessionId: "wsess_devicea0001" }));
    if (req.url === "/internal/runtime-sessions/check") return res.end(JSON.stringify({ live: true }));
    if (req.url === `/internal/runtime-routes/${TRIP_D}`) return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin: pageSiteOrigin, upstreamBasePath: "", tripKey: "derived" }));
    res.statusCode = 404; res.end("{}");
  });
  const grantingOrigin = await listen(granting);
  gateways.push(pageSite, granting);
  const saved = process.env.CONTROL_PLANE_INTERNAL_ORIGIN;
  try {
    const gw = await startGateway(grantingOrigin);
    // First the launch's own call to the trip site (the session exchange, sent the trip's key) meets a redirect: refused, nothing followed.
    reset();
    const refused = await fetch(`${gw.origin}/t/${TRIP_D}/__launch`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: PORTAL }, body: "token=anything" });
    assert.equal(refused.status, 503, "a redirect from the trip site is a refused launch, never a session");
    assert.deepEqual(targetSeen, [], `the redirect target received ${JSON.stringify(targetSeen)}`);
    sessionRedirects = false;
    const launched = await fetch(`${gw.origin}/t/${TRIP_D}/__launch`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: PORTAL }, body: "token=anything" });
    assert.equal(launched.status, 303, "the launch itself worked (the session route answered 200)");
    const cookie = launched.headers.get("set-cookie").split(";")[0];
    const page = await fetch(`${gw.origin}/t/${TRIP_D}/old-page`, { redirect: "manual", headers: { cookie } });
    assert.equal(page.status, 301, "the site's own redirect reaches the browser as a 3xx");
    assert.equal(page.headers.get("location"), `/t/${TRIP_D}/new-page`, "with the path prefix the proxy has always added");
  } finally { process.env.CONTROL_PLANE_INTERNAL_ORIGIN = saved; }
});
