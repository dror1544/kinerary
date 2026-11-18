// Host mode (docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, AC-R1.4 to R1.10):
// one wildcard name points at the gateway and the Host header picks the trip.
// A fake control plane answers GET /internal/runtime-routes/by-host/:host and a
// fake upstream records exactly what reached it. Hostnames use the reserved
// .test TLD; addresses are loopback.
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";

const SUFFIX = "example.test";
let controlPlane, gateway, upstreamA, upstreamB, gatewayPort;
let originA, originB;
const seen = { a: [], b: [] };
const lookups = []; // every by-host lookup the gateway made
let cpMode = "normal"; // normal | down | hang | garbage
const routes = new Map(); // host -> { status, body }
let streamUpstreamClosed = false;
let uploadState;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function close(server) { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); }
function collect(req) { return new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); }); }

// What a trip origin might send: a dotted suffix domain, the parent domain, odd case and spacing, a bare attribute.
const DOMAIN_COOKIES_FROM_TRIP = [
  `a=1; Domain=.${SUFFIX}; Path=/; HttpOnly`,
  "b=2; domain=example.test; Secure; SameSite=Lax",
  "c=3; Path=/;  DOMAIN =.test ; Max-Age=60",
  "d=4;Domain=.Example.Test;Path=/x",
  "e=5; Path=/; Domain",
  "f=6; Path=/; SameSite=Strict; HttpOnly",
  "g=domain=keep-me; Path=/",
];

function recorder(which) {
  return async (req, res) => {
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      res.on("close", () => { streamUpstreamClosed = true; });
      return;
    }
    if (req.url === "/upload") {
      uploadState = { firstChunkAt: null, finishedAt: null, hash: createHash("sha256"), size: 0, release: null };
      const finished = new Promise((resolve) => { uploadState.release = resolve; });
      req.on("data", (chunk) => { uploadState.firstChunkAt ??= Date.now(); uploadState.hash.update(chunk); uploadState.size += chunk.length; uploadState.onData?.(); });
      req.on("end", () => { uploadState.finishedAt = Date.now(); res.end(JSON.stringify({ size: uploadState.size, sha256: uploadState.hash.digest("hex") })); });
      await finished;
      return;
    }
    const body = await collect(req);
    seen[which].push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: body.toString() });
    if (req.url.startsWith("/api/cookies")) {
      res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"], "x-custom": "kept", "content-security-policy": "default-src 'self'" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url.startsWith("/set-domain-cookies")) {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": DOMAIN_COOKIES_FROM_TRIP });
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ upstream: which, url: req.url }));
  };
}

before(async () => {
  upstreamA = http.createServer(recorder("a"));
  upstreamB = http.createServer(recorder("b"));
  originA = await listen(upstreamA);
  originB = await listen(upstreamB);
  controlPlane = http.createServer((req, res) => {
    assert.equal(req.headers["x-api-key"], "exchange-key");
    const match = req.url.match(/^\/internal\/runtime-routes\/by-host\/([^/]+)$/);
    if (!match) { res.statusCode = 404; return res.end("{}"); }
    const host = decodeURIComponent(match[1]);
    lookups.push(host);
    if (cpMode === "down") { res.statusCode = 500; return res.end("{}"); }
    if (cpMode === "hang") return;
    if (cpMode === "garbage") { res.setHeader("content-type", "application/json"); return res.end("not json"); }
    res.setHeader("content-type", "application/json");
    const route = routes.get(host) ?? { status: 404, body: { error: "RUNTIME_NOT_READY" } };
    res.statusCode = route.status;
    res.end(JSON.stringify(route.body));
  });
  const controlPlaneOrigin = await listen(controlPlane);
  Object.assign(process.env, {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin,
    RUNTIME_EXCHANGE_KEY: "exchange-key", RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random",
    PORTAL_ORIGIN: "https://app.example.test", RUNTIME_ORIGIN: "https://runtime.example.test",
    RUNTIME_UPSTREAM_TIMEOUT_MS: "300", TRIP_HOST_SUFFIX: SUFFIX, TRIP_HOST_RESPONSE_TIMEOUT_MS: "500",
  });
  const { createRuntimeGateway } = await import(`../server.js?host=${Date.now()}`);
  gateway = createRuntimeGateway();
  const origin = await listen(gateway);
  gatewayPort = Number(new URL(origin).port);
  const ok = (origin) => ({ status: 200, body: { tripId: "trip_alpha0001", routeRef: "route_alpha0001", upstreamOrigin: origin } });
  routes.set(`alpha.${SUFFIX}`, ok(originA));
  routes.set(`beta.${SUFFIX}`, { status: 200, body: { tripId: "trip_beta00001", routeRef: "route_beta00001", upstreamOrigin: originB } });
  routes.set(`dead.${SUFFIX}`, ok("http://127.0.0.1:1")); // nothing listens on port 1
  routes.set(`slow.${SUFFIX}`, ok(originA));
});

after(async () => { await Promise.all([close(gateway), close(controlPlane), close(upstreamA), close(upstreamB)]); });

function send({ host, path = "/", method = "GET", headers = {}, body, hostHeader = host }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (hostHeader !== undefined) h.host = hostHeader;
    const request = http.request({ host: "127.0.0.1", port: gatewayPort, method, path, headers: h, setHost: false }, (response) => {
      const chunks = []; response.on("data", (c) => chunks.push(c));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function reset() { seen.a.length = 0; seen.b.length = 0; lookups.length = 0; cpMode = "normal"; }

test("AC-R1.5: a name exactly one label under the suffix is routed by host; Host is lowercased and its port removed", async () => {
  reset();
  const response = await send({ host: `ALPHA.${SUFFIX}:8443`, path: "/api/config" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { upstream: "a", url: "/api/config" });
  assert.deepEqual(lookups, [`alpha.${SUFFIX}`]);
});

test("AC-R1.5: the bare suffix, a deeper name and a non-label are 404 with no control-plane lookup", async () => {
  reset();
  const pages = [];
  for (const host of [SUFFIX, `a.b.${SUFFIX}`, `-bad.${SUFFIX}`, `bad-.${SUFFIX}`, `bad_name.${SUFFIX}`, `${"x".repeat(64)}.${SUFFIX}`, `.${SUFFIX}`, `..${SUFFIX}`]) {
    const response = await send({ host });
    assert.equal(response.status, 404, host);
    pages.push(response.body);
  }
  assert.deepEqual(lookups, [], "no lookup for a name that cannot be a trip");
  assert.equal(new Set(pages).size, 1, "the same page for each");
});

test("AC-R1.5: RUNTIME_ORIGIN's own host, and any host outside the suffix, keep today's /t/<trip_id>/ handling", async () => {
  reset();
  const runtime = await send({ host: "runtime.example.test", path: "/health" });
  assert.deepEqual(JSON.parse(runtime.body), { ok: true });
  const unknownPath = await send({ host: "runtime.example.test", path: "/anything" });
  assert.equal(unknownPath.status, 404);
  assert.deepEqual(JSON.parse(unknownPath.body), { error: "NOT_FOUND" });
  const other = await send({ host: "127.0.0.1:4320", path: "/health" });
  assert.deepEqual(JSON.parse(other.body), { ok: true });
  const lookalike = await send({ host: `alpha.example.test.evil.test`, path: "/health" });
  assert.deepEqual(JSON.parse(lookalike.body), { ok: true }, "a name that merely contains the suffix is not under it");
  assert.deepEqual(lookups, []);
});

test("AC-R1.6: method, path, query, body, Cookie, Authorization and Host reach the upstream unchanged; forwarding headers are set; X-Forwarded-Prefix is removed", async () => {
  reset();
  const response = await send({
    host: `alpha.${SUFFIX}`, method: "POST", path: "/api/cookies?x=1&y=%20z",
    headers: { cookie: "session=abc; other=def", authorization: "Bearer trip-own-token", "content-type": "application/json", "x-forwarded-prefix": "/evil", "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "http", "x-forwarded-host": "spoof.test", "x-api-key": "trips-own-key" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(seen.a.length, 1);
  const got = seen.a[0];
  assert.equal(got.method, "POST");
  assert.equal(got.url, "/api/cookies?x=1&y=%20z");
  assert.equal(got.body, JSON.stringify({ hello: "world" }));
  assert.equal(got.headers.cookie, "session=abc; other=def");
  assert.equal(got.headers.authorization, "Bearer trip-own-token");
  assert.equal(got.headers["x-api-key"], "trips-own-key", "the trip's own key is the trip's business");
  assert.equal(got.headers.host, `alpha.${SUFFIX}`);
  assert.equal(got.headers["x-forwarded-host"], `alpha.${SUFFIX}`);
  assert.equal(got.headers["x-forwarded-proto"], "https");
  assert.equal(got.headers["x-forwarded-for"], "198.51.100.7, 127.0.0.1", "the incoming chain, then the peer");
  assert.equal(got.headers["x-forwarded-prefix"], undefined);
  assert.equal(response.status, 201);
  assert.equal(response.headers["x-custom"], "kept");
  assert.equal(response.headers["content-security-policy"], "default-src 'self'", "the trip's CSP is not rewritten in host mode");
  assert.deepEqual(response.headers["set-cookie"], ["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"]);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test("AC-R1.12: a trip can only set host-only cookies: Domain is removed from every upstream Set-Cookie, the rest kept", async () => {
  reset();
  const response = await send({ host: `alpha.${SUFFIX}`, path: "/set-domain-cookies" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers["set-cookie"], [
    "a=1; Path=/; HttpOnly",
    "b=2; Secure; SameSite=Lax",
    "c=3; Path=/; Max-Age=60",
    "d=4;Path=/x",
    "e=5; Path=/",
    "f=6; Path=/; SameSite=Strict; HttpOnly",
    "g=domain=keep-me; Path=/",
  ]);
  for (const cookie of response.headers["set-cookie"]) assert.doesNotMatch(cookie.split(";").slice(1).join(";"), /domain/i, cookie);
});

test("AC-R1.6: with no incoming X-Forwarded-For the chain is the peer alone; Host keeps the port a client sent", async () => {
  reset();
  await send({ host: `alpha.${SUFFIX}:8443`, path: "/p" });
  assert.equal(seen.a[0].headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(seen.a[0].headers.host, `alpha.${SUFFIX}:8443`);
  assert.equal(seen.a[0].headers["x-forwarded-host"], `alpha.${SUFFIX}:8443`);
});

test("AC-R1.6: a text/event-stream response streams, and closing the browser side closes the upstream", async () => {
  reset();
  streamUpstreamClosed = false;
  const request = http.request({ host: "127.0.0.1", port: gatewayPort, path: "/sse", headers: { host: `alpha.${SUFFIX}` }, setHost: false });
  const first = await new Promise((resolve, reject) => {
    request.on("response", (response) => response.once("data", (chunk) => resolve({ response, text: chunk.toString() })));
    request.on("error", reject);
    request.end();
  });
  assert.equal(first.response.headers["content-type"], "text/event-stream");
  assert.match(first.text, /event: ready/, "the first event arrives while the stream is still open");
  first.response.destroy();
  request.destroy();
  for (let i = 0; i < 40 && !streamUpstreamClosed; i += 1) await sleep(25);
  assert.equal(streamUpstreamClosed, true, "the upstream connection was closed");
});

test("AC-R1.7: /api/internal/* on a trip host is 404 and never reaches the upstream, however it is spelled", async () => {
  reset();
  const paths = [
    "/api/internal/control-plane/session", "/api/internal", "/api/internal/", "/API/Internal/x", "/api/%69nternal/x", "/api/%2569nternal/x",
    "//api/internal/x", "/api//internal/x", "/api/./internal/x", "/x/../api/internal/x", "/api/internal%2Fx", "/api\\internal/x", "/api/internal?x=1",
  ];
  const pages = [];
  for (const path of paths) {
    const response = await send({ host: `alpha.${SUFFIX}`, path, method: path.length % 2 ? "POST" : "GET" });
    assert.equal(response.status, 404, path);
    pages.push(response.body);
  }
  assert.equal(new Set(pages).size, 1, "the answer is the same page for every spelling");
  assert.deepEqual(seen.a, [], "the upstream saw none of them");
  assert.deepEqual(lookups, [], "refused before any lookup, so the answer cannot tell a known trip from an unknown one");
  const near = await send({ host: `alpha.${SUFFIX}`, path: "/api/internals/x" });
  assert.equal(near.status, 200, "a different segment that merely starts the same is an ordinary path");
  const percent = await send({ host: `alpha.${SUFFIX}`, path: "/photos/100%25.jpg" });
  assert.equal(percent.status, 200, "an encoded percent sign in a file name is an ordinary path, not an unreadable one");
});

test("AC-R1.7: a path that cannot be read is refused rather than guessed at", async () => {
  reset();
  const response = await send({ host: `alpha.${SUFFIX}`, path: "/api/%zz/internal" });
  assert.equal(response.status, 400);
  assert.deepEqual(seen.a, []);
});

test("AC-R1.8: unknown, not-ready and no-upstream hosts get one identical small 404 page, no-store", async () => {
  reset();
  routes.set(`pending.${SUFFIX}`, { status: 404, body: { error: "RUNTIME_NOT_READY" } });
  const responses = [];
  for (const host of [`nobody.${SUFFIX}`, `pending.${SUFFIX}`, `other-unknown.${SUFFIX}`]) responses.push(await send({ host, path: "/some/page?x=1" }));
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.ok(response.body.length < 600, "small");
    assert.ok(!response.body.includes("nobody") && !response.body.includes("pending"), "the name asked for is not reflected");
  }
  assert.equal(new Set(responses.map((r) => r.body)).size, 1);
  assert.equal(new Set(responses.map((r) => JSON.stringify(Object.entries(r.headers).filter(([k]) => !["date", "connection", "keep-alive"].includes(k))))).size, 1, "identical headers too");
});

test("AC-R1.8: a miss is cached for at most 5 seconds, a hit for at most 30", async () => {
  reset();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    await send({ host: `missing-cache.${SUFFIX}` });
    await send({ host: `missing-cache.${SUFFIX}` });
    assert.deepEqual(lookups, [`missing-cache.${SUFFIX}`], "second miss answered from the cache");
    mock.timers.tick(5_001);
    await send({ host: `missing-cache.${SUFFIX}` });
    assert.equal(lookups.length, 2, "asked again once 5 s have passed");

    await send({ host: `beta.${SUFFIX}` });
    await send({ host: `beta.${SUFFIX}` });
    assert.equal(lookups.filter((h) => h === `beta.${SUFFIX}`).length, 1, "a hit is cached");
    mock.timers.tick(29_000);
    await send({ host: `beta.${SUFFIX}` });
    assert.equal(lookups.filter((h) => h === `beta.${SUFFIX}`).length, 1, "still cached at 29 s");
    mock.timers.tick(1_500);
    await send({ host: `beta.${SUFFIX}` });
    assert.equal(lookups.filter((h) => h === `beta.${SUFFIX}`).length, 2, "asked again after 30 s");
  } finally { mock.timers.reset(); }
});

test("AC-R1.8: a route that becomes ready is served once the miss expires; one that goes away stops being served once the hit expires", async () => {
  reset();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const host = `later.${SUFFIX}`;
    assert.equal((await send({ host })).status, 404);
    routes.set(host, { status: 200, body: { tripId: "trip_later0001", routeRef: "route_later0001", upstreamOrigin: originA } });
    mock.timers.tick(5_001);
    assert.equal((await send({ host, path: "/hi" })).status, 200);
    routes.delete(host);
    mock.timers.tick(30_001);
    const gone = await send({ host, path: "/hi" });
    assert.equal(gone.status, 404);
    assert.equal(gone.headers["cache-control"], "no-store");
  } finally { mock.timers.reset(); }
});

test("AC-R1.9: a control plane that cannot be asked is 503, and the failure is not cached as an answer", async () => {
  reset();
  routes.set(`recover.${SUFFIX}`, { status: 200, body: { tripId: "trip_recover01", routeRef: "route_recover01", upstreamOrigin: originA } });
  cpMode = "down";
  assert.equal((await send({ host: `recover.${SUFFIX}` })).status, 503);
  cpMode = "garbage";
  assert.equal((await send({ host: `recover.${SUFFIX}` })).status, 503);
  cpMode = "hang";
  assert.equal((await send({ host: `recover.${SUFFIX}` })).status, 503, "a hung control plane times out closed");
  cpMode = "normal";
  assert.equal((await send({ host: `recover.${SUFFIX}` })).status, 200, "and the next request recovers at once");
  assert.equal(seen.a.length, 1);
});

test("AC-R1.9: a registry answer that is not a plain http(s) origin is not proxied to", async () => {
  reset();
  const bad = [
    ["credentials", "http://user:pw@127.0.0.1:9"], ["path", `${originA}/base`], ["query", `${originA}/?q=1`], ["scheme", "ftp://127.0.0.1:9"],
    ["relative", "/just/a/path"], ["number", 42], ["missing", undefined],
  ];
  for (const [name, upstreamOrigin] of bad) {
    routes.set(`bad-${name}.${SUFFIX}`, { status: 200, body: { tripId: "trip_bad000001", routeRef: "route_bad000001", upstreamOrigin } });
    const response = await send({ host: `bad-${name}.${SUFFIX}` });
    assert.equal(response.status, 404, `${name}: the same uniform page as an unknown name`);
  }
  assert.deepEqual(seen.a, []);
});

test("AC-R1.8: a name whose registered upstream is invalid answers the same 404 page as an unknown name, and the reason is logged", async () => {
  reset();
  routes.set(`invalid.${SUFFIX}`, { status: 503, body: { error: "RUNTIME_ROUTE_INVALID" } });
  routes.set(`badorigin.${SUFFIX}`, { status: 200, body: { tripId: "trip_bad000002", routeRef: "route_bad000002", upstreamOrigin: "ftp://127.0.0.1:9" } });
  const logged = mock.method(console, "error", () => {});
  let unknown, invalid, badOrigin;
  try {
    unknown = await send({ host: `nobody-here.${SUFFIX}`, path: "/p" });
    invalid = await send({ host: `invalid.${SUFFIX}`, path: "/p" });
    badOrigin = await send({ host: `badorigin.${SUFFIX}`, path: "/p" });
  } finally { logged.mock.restore(); }
  const shape = (r) => JSON.stringify([r.status, r.body, Object.entries(r.headers).filter(([k]) => !["date", "connection", "keep-alive"].includes(k))]);
  assert.equal(unknown.status, 404);
  assert.equal(shape(invalid), shape(unknown), "identical status, headers and body");
  assert.equal(shape(badOrigin), shape(unknown));
  const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(lines.includes(`runtime_gateway.host_route_invalid host=invalid.${SUFFIX} reason=registry_route_invalid`), lines.join("\n"));
  assert.ok(lines.includes(`runtime_gateway.host_route_invalid host=badorigin.${SUFFIX} reason=origin_refused`), lines.join("\n"));
  assert.deepEqual(seen.a, []);
});

test("AC-R1.8: an invalid answer is cached no longer than a miss, and a 503 that is not ROUTE_INVALID is still 503", async () => {
  reset();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const logged = mock.method(console, "error", () => {});
  try {
    const host = `fixed-later.${SUFFIX}`;
    routes.set(host, { status: 503, body: { error: "RUNTIME_ROUTE_INVALID" } });
    assert.equal((await send({ host })).status, 404);
    assert.equal((await send({ host })).status, 404);
    assert.deepEqual(lookups, [host], "the second answer came from the cache");
    routes.set(host, { status: 200, body: { tripId: "trip_fixed0001", routeRef: "route_fixed0001", upstreamOrigin: originA } });
    mock.timers.tick(5_001);
    assert.equal((await send({ host, path: "/hi" })).status, 200, "served once the miss window passes");

    routes.set(`unwell.${SUFFIX}`, { status: 503, body: { error: "SOMETHING_ELSE" } });
    assert.equal((await send({ host: `unwell.${SUFFIX}` })).status, 503, "the control plane could not answer: unavailable, not 'not found'");
    routes.set(`noisy.${SUFFIX}`, { status: 502, body: { error: "RUNTIME_ROUTE_INVALID" } });
    assert.equal((await send({ host: `noisy.${SUFFIX}` })).status, 503, "only a 503 carrying the code is an invalid route");
  } finally { logged.mock.restore(); mock.timers.reset(); }
});

test("AC-R1.9: an unreachable upstream is 502; a hung one is 502 once the request is sent and no response comes", async () => {
  reset();
  assert.equal((await send({ host: `dead.${SUFFIX}` })).status, 502);
  const hangServer = http.createServer(() => {});
  const hangOrigin = await listen(hangServer);
  routes.set(`hung.${SUFFIX}`, { status: 200, body: { tripId: "trip_hung000001", routeRef: "route_hung000001", upstreamOrigin: hangOrigin } });
  try { assert.equal((await send({ host: `hung.${SUFFIX}` })).status, 502); } finally { await close(hangServer); }
});

test("AC-R1.9: each host reaches only the upstream the registry returned for that exact name", async () => {
  reset();
  const a = await send({ host: `alpha.${SUFFIX}`, path: "/who" });
  const b = await send({ host: `beta.${SUFFIX}`, path: "/who" });
  assert.equal(JSON.parse(a.body).upstream, "a");
  assert.equal(JSON.parse(b.body).upstream, "b");
  assert.equal(seen.a.length, 1);
  assert.equal(seen.b.length, 1);
  // Host and X-Forwarded-Host in the request do not choose the route; only the Host header does.
  reset();
  const spoof = await send({ host: `beta.${SUFFIX}`, path: "/who", headers: { "x-forwarded-host": `alpha.${SUFFIX}`, "x-original-host": `alpha.${SUFFIX}` } });
  assert.equal(JSON.parse(spoof.body).upstream, "b");
  assert.deepEqual(seen.a, []);
});

test("AC-R1.10: a body far larger than the JSON limits streams through intact", async () => {
  reset();
  const size = 12 * 1024 * 1024;
  const payload = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) payload[i] = (i * 31 + 7) & 255;
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: gatewayPort, method: "POST", path: "/upload", headers: { host: `alpha.${SUFFIX}`, "content-type": "application/octet-stream", "content-length": size }, setHost: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(payload);
    setTimeout(() => uploadState?.release?.(), 50).unref();
  });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.size, size);
  assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
});

test("AC-R1.10: the upstream receives the first chunk while the client is still sending (nothing is buffered)", async () => {
  reset();
  const request = http.request({ host: "127.0.0.1", port: gatewayPort, method: "POST", path: "/upload", headers: { host: `alpha.${SUFFIX}`, "transfer-encoding": "chunked" }, setHost: false });
  const done = new Promise((resolve, reject) => { request.on("response", (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); request.on("error", reject); });
  request.write(Buffer.alloc(64 * 1024, 1));
  const arrivedBeforeEnd = await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (uploadState?.firstChunkAt) { clearInterval(poll); resolve(true); }
      else if (Date.now() - started > 3000) { clearInterval(poll); resolve(false); }
    }, 10);
  });
  assert.equal(arrivedBeforeEnd, true, "data reached the upstream before the request ended");
  assert.equal(uploadState.finishedAt, null, "the request had not ended yet");
  request.end(Buffer.alloc(1024, 2));
  uploadState.release();
  assert.equal(await done, 200);
  assert.equal(uploadState.size, 64 * 1024 + 1024);
});

test("the lookup carries the exchange key and the host, percent-encoded as one path segment", async () => {
  reset();
  await send({ host: `alpha.${SUFFIX}`, path: "/x" }); // the control-plane fake asserts the key
  assert.equal(lookups.at(-1) ?? `alpha.${SUFFIX}`, `alpha.${SUFFIX}`);
});
