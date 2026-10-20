import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let upstream, controlPlane, gateway;
let upstreamOrigin, gatewayOrigin;
let proxiedAuthorization;
let eventStreamClosed = false;
const sessionBodies = [];
const consumed = new Set();
const revokedUsers = new Set();
const revokedSessions = new Set();
let lastCheck;
let currentRole = "owner", hangControlPlane = false;
let checkCalls = 0, checkDown = false;
const PORTAL = "https://app.example.test";
// What a browser sends for a page navigation (undici would otherwise say sec-fetch-mode: cors).
const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html" };

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function formLaunch(token, origin = PORTAL, path = "/t/trip_abcdefgh/__launch") {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  return fetch(`${gatewayOrigin}${path}`, { method: "POST", redirect: "manual", headers, body: new URLSearchParams({ token }).toString() });
}
// fetch() overwrites Sec-Fetch-* itself (it says "cors"), so page navigations are made with http.request.
function rawGet(path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request(`${gatewayOrigin}${path}`, { method, headers }, (response) => {
      const chunks = []; response.on("data", (c) => chunks.push(c));
      response.on("end", () => resolve({ status: response.statusCode, headers: { get: (n) => response.headers[n.toLowerCase()] ?? null }, text: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end();
  });
}
function body(req) { return new Promise((resolve) => { const chunks = []; req.on("data", (chunk) => chunks.push(chunk)); req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"))); }); }

before(async () => {
  upstream = http.createServer(async (req, res) => {
    if (req.url === "/api/internal/control-plane/session") {
      assert.equal(req.headers["x-api-key"], "exchange-key");
      sessionBodies.push(await body(req));
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ token: "runtime-jwt" }));
    }
    if (req.url === "/api/internal/control-plane/participants/bob") {
      assert.equal(req.headers["x-api-key"], "exchange-key");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, username: "bob" }));
    }
    if (req.url === "/api/events") {
      assert.equal(req.headers.authorization, "Bearer runtime-jwt");
      eventStreamClosed = false;
      res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
      res.write('event: ready\ndata: {"revisions":{"bookings":0}}\n\n');
      const timer = setTimeout(() => res.write('event: change\ndata: {"revisions":{"bookings":1}}\n\n'), 30);
      res.on("close", () => { clearTimeout(timer); eventStreamClosed = true; });
      return;
    }
    proxiedAuthorization = req.headers.authorization;
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  upstreamOrigin = await listen(upstream);
  controlPlane = http.createServer(async (req, res) => {
    assert.equal(req.headers["x-api-key"], "exchange-key");
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/runtime-launch/consume") {
      const payload = await body(req);
      // "valid-grant" is reusable fixture data; "once-*" grants are single-use like the real table.
      if (hangControlPlane && payload.token === "once-hangs") return; // never answers
      const reusable = payload.token === "valid-grant";
      const once = typeof payload.token === "string" && payload.token.startsWith("once-") && !consumed.has(payload.token);
      if (!reusable && !once) { res.statusCode = 401; return res.end(JSON.stringify({ error: "invalid" })); }
      if (once) consumed.add(payload.token);
      const tripId = payload.token === "once-other-trip" ? "trip_otherxyz1" : "trip_abcdefgh";
      return res.end(JSON.stringify({ tripId, userId: "user_abcdefgh", role: payload.token === "once-member-grant" ? "member" : "owner", runtimeUsername: null, audience: "runtime_gateway", sessionId: payload.token === "once-device-b" ? "wsess_deviceb0001" : "wsess_devicea0001", dashboardUrl: payload.token === "once-evil-origin" ? `https://evil.example/trips/${tripId}/setup` : payload.token === "once-other-trip-path" ? `${PORTAL}/trips/trip_somebodyelse/setup` : `${PORTAL}/trips/${tripId}/setup` }));
    }
    if (req.url === "/internal/runtime-sessions/check") {
      const payload = await body(req);
      checkCalls += 1; lastCheck = payload;
      if (hangControlPlane) return; // never answers
      if (payload.role && payload.role !== currentRole) { res.statusCode = 401; return res.end(JSON.stringify({ error: "ROLE_CHANGED" })); }
      if (checkDown) { res.statusCode = 500; return res.end("{}"); }
      if (revokedUsers.has(payload.userId) || revokedSessions.has(payload.sessionId)) { res.statusCode = 401; return res.end(JSON.stringify({ error: "SESSION_REVOKED" })); }
      return res.end(JSON.stringify({ live: true }));
    }
    if (req.url === "/internal/runtime-routes/trip_abcdefgh") return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin, upstreamBasePath: "" }));
    res.statusCode = 404; res.end(JSON.stringify({ error: "missing" }));
  });
  const controlPlaneOrigin = await listen(controlPlane);
  Object.assign(process.env, {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin,
    RUNTIME_EXCHANGE_KEY: "exchange-key", RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random",
    PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test", RUNTIME_SESSION_CHECK_TTL_MS: "200", RUNTIME_UPSTREAM_TIMEOUT_MS: "300",
  });
  const { createRuntimeGateway } = await import(`../server.js?test=${Date.now()}`);
  gateway = createRuntimeGateway();
  gatewayOrigin = await listen(gateway);
});

after(async () => { await Promise.all([close(gateway), close(controlPlane), close(upstream)]); });

test("a form POST from the portal consumes the grant and redirects to the trip with the cookie, token nowhere in a URL", async () => {
  const logged = [];
  const originals = ["log", "error", "warn", "info"].map((name) => [name, console[name]]);
  for (const [name] of originals) console[name] = (...args) => logged.push(args.join(" "));
  let launched;
  try { launched = await formLaunch("once-form-grant"); } finally { for (const [name, fn] of originals) console[name] = fn; }
  assert.equal(launched.status, 303);
  assert.equal(launched.headers.get("location"), "/t/trip_abcdefgh/");
  assert.ok(!launched.headers.get("location").includes("once-form-grant"));
  assert.ok(!logged.join("\n").includes("once-form-grant"), "the grant must not be logged");
  assert.equal(launched.headers.get("cache-control"), "no-store");
  const cookie = launched.headers.get("set-cookie");
  // Per-trip, __Host- prefixed (Secure, Path=/, no Domain), Strict.
  assert.ok(cookie.startsWith("kit_runtime=") === false && cookie.startsWith("__Host-kit_rt_trip_abcdefgh="));
  assert.match(cookie, /; Path=\/(;|$)/);
  assert.ok(!/Domain=/i.test(cookie));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.ok(!cookie.includes("once-form-grant"));
  // The dashboard URL the control plane built travels through the session exchange.
  assert.equal(sessionBodies.at(-1).dashboardUrl, `${PORTAL}/trips/trip_abcdefgh/setup`);
  assert.equal(sessionBodies.at(-1).role, "owner");
});

test("the launch refuses a missing, null or foreign Origin before touching the grant", async () => {
  for (const origin of [null, "null", "https://evil.example", "https://runtime.example.test", `${PORTAL}.evil.example`]) {
    const response = await formLaunch("once-origin-grant", origin);
    assert.equal(response.status, 403, `Origin ${origin}`);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  // The grant was never consumed by the refusals, so the portal's own post still works.
  assert.equal((await formLaunch("once-origin-grant")).status, 303);
});

test("a replayed, wrong-trip or malformed grant is refused and sets no cookie", async () => {
  assert.equal((await formLaunch("once-replay-grant")).status, 303);
  const replay = await formLaunch("once-replay-grant");
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get("set-cookie"), null);
  const wrongTrip = await formLaunch("once-other-trip");
  assert.equal(wrongTrip.status, 401);
  assert.equal(wrongTrip.headers.get("set-cookie"), null);
  assert.equal((await formLaunch("not-a-grant")).status, 401);
  assert.equal((await formLaunch("")).status, 400);
  const html = await replay.text();
  assert.match(html, /could not be opened/);
  assert.ok(!html.includes("once-replay-grant"));
  // Same body for every refusal: no hint which trips exist.
  assert.equal(await (await formLaunch("not-a-grant")).text(), html);
});

test("a cross-site text/plain or multipart form is refused even from the portal's Origin", async () => {
  for (const type of ["text/plain", "multipart/form-data; boundary=x", ""]) {
    const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/__launch`, { method: "POST", redirect: "manual", headers: { "content-type": type, origin: PORTAL }, body: JSON.stringify({ token: "valid-grant" }) });
    assert.equal(response.status, 400, type);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  // The classic login-CSRF shape: enctype=text/plain from a foreign page (Origin foreign or "null").
  for (const origin of ["https://evil.example", "null"]) {
    const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/__launch`, { method: "POST", redirect: "manual", headers: { "content-type": "text/plain", origin }, body: 'token=valid-grant' });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("revoking the person at the portal ends the trip session within the cache window, and an outage fails closed", async () => {
  const launched = await formLaunch("valid-grant");
  const cookie = launched.headers.get("set-cookie").split(";")[0];
  const get = (headers = {}) => fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config`, { redirect: "manual", headers: { cookie, ...headers } });
  assert.equal((await get()).status, 200);
  const before = checkCalls;
  assert.equal((await get()).status, 200);
  assert.equal(checkCalls, before, "a positive answer is cached, not re-asked on every request");
  revokedUsers.add("user_abcdefgh");
  try {
    await new Promise(resolve => setTimeout(resolve, 300)); // past the 200 ms test window
    assert.equal((await get()).status, 401, "portal logout / removal ends the trip session");
    const page = await rawGet("/t/trip_abcdefgh/api/config", { ...NAV, cookie });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), `${PORTAL}/trips/trip_abcdefgh/app`);
  } finally { revokedUsers.delete("user_abcdefgh"); }
  // Back in good standing the same cookie works again; an outage then fails closed.
  assert.equal((await get()).status, 200);
  checkDown = true;
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await get()).status, 401, "when the portal cannot be asked, the answer is no");
  } finally { checkDown = false; }
});

test("signing out on one device ends only the trip session opened from that device", async () => {
  const a = (await formLaunch("once-device-a")).headers.get("set-cookie").split(";")[0];
  const b = (await formLaunch("once-device-b")).headers.get("set-cookie").split(";")[0];
  const get = (cookie) => fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config`, { headers: { cookie } });
  assert.equal((await get(a)).status, 200);
  assert.equal(lastCheck.sessionId, "wsess_devicea0001", "the check names the launching portal session");
  assert.equal((await get(b)).status, 200);
  assert.equal(lastCheck.sessionId, "wsess_deviceb0001");
  revokedSessions.add("wsess_devicea0001"); // device A signs out of the portal; B's portal session is still live
  try {
    await new Promise(resolve => setTimeout(resolve, 300)); // past the 200 ms test window
    assert.equal((await get(a)).status, 401, "the trip session opened from A ends");
    assert.equal((await get(b)).status, 200, "the trip session opened from B keeps working");
  } finally { revokedSessions.delete("wsess_devicea0001"); }
});

test("the dashboard URL is passed on only when it is exactly this portal's setup page for this trip", async () => {
  for (const token of ["once-evil-origin", "once-other-trip-path"]) {
    const response = await formLaunch(token);
    assert.equal(response.status, 303, token);
    assert.equal(sessionBodies.at(-1).dashboardUrl, undefined, `${token} must not reach the trip`);
  }
  assert.equal((await formLaunch("once-good-origin")).status, 303);
  assert.equal(sessionBodies.at(-1).dashboardUrl, `${PORTAL}/trips/trip_abcdefgh/setup`);
});

test("a role change at the control plane ends the session opened with the old role", async () => {
  const cookie = (await formLaunch("once-role-owner")).headers.get("set-cookie").split(";")[0];
  const get = (c) => fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config`, { headers: { cookie: c } });
  assert.equal((await get(cookie)).status, 200);
  assert.equal(lastCheck.role, "owner", "the sealed role is what the check is asked about");
  currentRole = "member"; // demoted in the control plane
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await get(cookie)).status, 401, "the owner-era session is refused");
    const relaunched = (await formLaunch("once-member-grant")).headers.get("set-cookie").split(";")[0];
    assert.equal((await get(relaunched)).status, 200, "relaunching issues a session for the role now held");
    assert.equal(lastCheck.role, "member");
    assert.equal(sessionBodies.at(-1).role, "member");
  } finally { currentRole = "owner"; }
});

test("a hung control plane fails closed within the timeout instead of holding the request", async () => {
  const cookie = (await formLaunch("once-hang-session")).headers.get("set-cookie").split(";")[0];
  hangControlPlane = true;
  try {
    await new Promise(resolve => setTimeout(resolve, 300)); // let any cached answer expire
    const startedAt = Date.now();
    const checked = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config`, { headers: { cookie } });
    assert.equal(checked.status, 401, "no answer from the portal means no session");
    assert.ok(Date.now() - startedAt < 3000, `took ${Date.now() - startedAt} ms`);
    const launchStart = Date.now();
    const launched = await formLaunch("once-hangs");
    assert.equal(launched.status, 503, "a launch whose grant cannot be consumed is a generic failure");
    assert.ok(Date.now() - launchStart < 3000);
  } finally { hangControlPlane = false; }
});

test("the gateway refuses to start when the portal and runtime origins are not the same site", async () => {
  const server = fileURLToPath(new URL("../server.js", import.meta.url));
  const run = (extra) => new Promise((resolve) => {
    const child = spawn(process.execPath, [server], {
      env: { PATH: process.env.PATH, PORT: "0", BIND_HOST: "127.0.0.1", CONTROL_PLANE_INTERNAL_ORIGIN: "http://127.0.0.1:9", RUNTIME_EXCHANGE_KEY: "k", RUNTIME_COOKIE_SECRET: "s", PORTAL_ORIGIN: "https://app.example.test", RUNTIME_ORIGIN: "https://runtime.other.test", ...extra },
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; if (/listening/.test(out)) child.kill(); });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => resolve({ code, out, err }));
    setTimeout(() => child.kill(), 4000);
  });
  const refused = await run({});
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /cross_site_origins/);
  assert.match(refused.err, /same site/);
  assert.equal(refused.out, "");
  const overridden = await run({ RUNTIME_SAME_SITE_OK: "1" });
  assert.match(overridden.out, /listening/);
  assert.match(overridden.err, /cross_site_origins_allowed/, "an override is still loud");
  const sameSiteHosts = await run({ RUNTIME_ORIGIN: "https://runtime.example.test" });
  assert.match(sameSiteHosts.out, /listening/);
  // A shared domain under a public suffix (co.uk) is two sites unless the suffix is declared.
  const ukRefused = await run({ PORTAL_ORIGIN: "https://app.alice.co.uk", RUNTIME_ORIGIN: "https://run.bob.co.uk" });
  assert.notEqual(ukRefused.code, 0);
  const ukDeclared = await run({ PORTAL_ORIGIN: "https://app.alice.co.uk", RUNTIME_ORIGIN: "https://run.alice.co.uk", RUNTIME_PUBLIC_SUFFIXES: "co.uk" });
  assert.match(ukDeclared.out, /listening/);
  const ukSibling = await run({ PORTAL_ORIGIN: "https://app.alice.co.uk", RUNTIME_ORIGIN: "https://run.bob.co.uk", RUNTIME_PUBLIC_SUFFIXES: "co.uk" });
  assert.notEqual(ukSibling.code, 0);
  // Loopback development: same hostname on different ports is one site; two different IPs are not.
  assert.match((await run({ PORTAL_ORIGIN: "http://localhost:5173", RUNTIME_ORIGIN: "http://localhost:4320" })).out, /listening/);
  assert.notEqual((await run({ PORTAL_ORIGIN: "http://localhost:5173", RUNTIME_ORIGIN: "http://127.0.0.1:4320" })).code, 0);
});

test("the JSON launch body still works for compatibility, with the same Origin rule", async () => {
  const send = (origin) => fetch(`${gatewayOrigin}/t/trip_abcdefgh/__launch`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ token: "valid-grant" }) });
  assert.equal((await send(undefined)).status, 403);
  assert.equal((await send(PORTAL)).status, 303);
});

test("an unauthenticated page request redirects to the portal's open-trip route; nothing else is served", async () => {
  const response = await rawGet("/t/trip_abcdefgh/", NAV);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${PORTAL}/trips/trip_abcdefgh/app`);
  assert.equal(response.headers.get("set-cookie"), null);
  // A trip the gateway has never heard of answers identically.
  const unknown = await rawGet("/t/trip_unknown99/", NAV);
  assert.equal(unknown.status, 303);
  assert.equal(unknown.headers.get("location"), `${PORTAL}/trips/trip_unknown99/app`);
  // A deep-link navigation also goes to the portal; an API call or a frame does not.
  const deep = await rawGet("/t/trip_abcdefgh/classic.html", NAV);
  assert.equal(deep.status, 303);
  assert.equal(deep.headers.get("location"), `${PORTAL}/trips/trip_abcdefgh/app`, "no deep path or query is reflected");
  const withNext = await rawGet("/t/trip_abcdefgh/?next=https://evil.example&return_to=//evil.example", NAV);
  assert.equal(withNext.headers.get("location"), `${PORTAL}/trips/trip_abcdefgh/app`);
  const api = await rawGet("/t/trip_abcdefgh/api/config", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "*/*" });
  assert.equal(api.status, 401);
  const framed = await rawGet("/t/trip_abcdefgh/", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" });
  assert.equal(framed.status, 401);
  const post = await rawGet("/t/trip_abcdefgh/", NAV, "POST");
  assert.equal(post.status, 401);
  // Without Fetch Metadata (older clients) Accept: text/html decides.
  assert.equal((await rawGet("/t/trip_abcdefgh/", { accept: "text/html" })).status, 303);
  assert.equal((await rawGet("/t/trip_abcdefgh/", { accept: "application/json" })).status, 401);
});

test("consumes a trip-bound grant and proxies with the runtime session, now as a top-level page", async () => {
  const launched = await formLaunch("valid-grant");
  assert.equal(launched.status, 303);
  const cookie = launched.headers.get("set-cookie").split(";")[0];
  const cookieValue = decodeURIComponent(cookie.slice("kit_runtime=".length));
  assert.ok(!cookieValue.includes("runtime-jwt"), "the runtime JWT must not be exposed as plaintext cookie content");
  for (const part of cookieValue.split(".")) {
    assert.ok(!Buffer.from(part, "base64url").toString("utf8").includes("runtime-jwt"), "the runtime JWT must not be recoverable from an encoded cookie segment");
  }

  const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config?upstream=http://attacker.invalid`, { headers: { cookie, authorization: "Bearer browser-controlled" } });
  assert.equal(response.status, 200);
  assert.equal(proxiedAuthorization, "Bearer runtime-jwt");
  assert.deepEqual(await response.json(), { path: "/api/config?upstream=http://attacker.invalid" });
  // Nothing frames the trip site any more: it is DENY / 'none', not "the portal".
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; frame-ancestors 'none'");
});

test("never serves a postMessage bootstrap or lets anything frame the trip", async () => {
  const signedOut = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/__signed_out`);
  assert.match(signedOut.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const redirect = await rawGet("/t/trip_abcdefgh/", NAV);
  assert.ok(!redirect.text.includes("kinerary:runtime-ready"));
});

test("rejects trip paths without a valid gateway session", async () => {
  const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config`);
  assert.equal(response.status, 401);
});

test("forwards internal participant existence checks", async () => {
  const response = await fetch(`${gatewayOrigin}/internal/t/trip_abcdefgh/participants/bob`, { headers: { "x-api-key": "exchange-key" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, username: "bob" });
});


test("streams authenticated events without buffering, scopes the cookie, and closes the upstream", async () => {
  const launched = await formLaunch("valid-grant");
  const cookie = launched.headers.get("set-cookie").split(";")[0];
  const foreign = await fetch(`${gatewayOrigin}/t/trip_other123/api/events`, { headers: { cookie } });
  assert.equal(foreign.status, 401);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/events`, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body.getReader();
    let frames = "";
    while (!frames.includes("event: change")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      frames += new TextDecoder().decode(chunk.value);
    }
    assert.match(frames, /event: ready/);
    controller.abort();
    for (let attempt = 0; attempt < 100 && !eventStreamClosed; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(eventStreamClosed, true);
  } finally { clearTimeout(timeout); controller.abort(); }
});
