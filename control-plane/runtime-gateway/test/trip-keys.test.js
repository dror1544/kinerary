// Per-trip exchange keys (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2; AC-K2.3, AC-K2.6).
//
// The gateway holds three things: RUNTIME_EXCHANGE_KEY (the control-plane key, unchanged),
// RUNTIME_TRIP_KEY_MASTER (never leaves the gateway and the worker) and RUNTIME_LEGACY_TRIP_KEY
// (what a `shared` trip is sent once the master is set). Each fake trip below holds exactly one
// key and refuses every other, as server/control-plane-auth.js does.
//
// server.js reads its environment once, at import, so each gateway under test is its own import.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/trip-key-vectors.json", import.meta.url)), "utf8"));
const MASTER = "test-master-do-not-use-0001";
const TRIP_A = "trip_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRIP_B = "trip_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRIP_S = "trip_sharedsharedshared"; // a trip that still holds the legacy key
const TRIP_X = "trip_unknownkindunknown"; // the control plane names a key kind this gateway does not know
const TRIP_N = "trip_nokindnokindnokind"; // an older control plane: no tripKey in the answer at all
const EXCHANGE = "exchange-key";
const LEGACY = "legacy-key-do-not-use";
const PORTAL = "https://app.example.test";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const bodyOf = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString())); });

// A trip site that accepts one key. Every request it sees is recorded, with the key it carried.
function fakeTrip(held, answer401 = false) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const key = req.headers["x-api-key"];
    seen.push({ method: req.method, url: req.url, key });
    await bodyOf(req);
    res.setHeader("content-type", "application/json");
    if (answer401 || key !== held) { res.statusCode = 401; return res.end(JSON.stringify({ error: "AUTHENTICATION_REQUIRED" })); }
    if (req.url.endsWith("/session")) return res.end(JSON.stringify({ token: "runtime-jwt" }));
    return res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

let controlPlane, controlPlaneOrigin;
const controlPlaneKeys = []; // the key each control-plane request carried
const trips = {}; // tripId -> { held, seen, server, origin }
const routeKinds = { [TRIP_A]: "derived", [TRIP_B]: "derived", [TRIP_S]: "shared", [TRIP_X]: "bogus", [TRIP_N]: undefined };
const gateways = [];

before(async () => {
  for (const [id, held] of [[TRIP_A, derive(TRIP_A)], [TRIP_B, derive(TRIP_B)], [TRIP_S, LEGACY], [TRIP_X, derive(TRIP_X)], [TRIP_N, derive(TRIP_N)]]) {
    const trip = fakeTrip(held);
    trips[id] = { held, seen: trip.seen, server: trip.server, origin: await listen(trip.server) };
  }
  controlPlane = http.createServer(async (req, res) => {
    controlPlaneKeys.push(req.headers["x-api-key"]);
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== EXCHANGE) { res.statusCode = 401; return res.end("{}"); }
    if (req.url === "/internal/runtime-launch/consume") {
      const { token } = JSON.parse(await bodyOf(req));
      const tripId = String(token).replace(/^grant-/, "");
      return res.end(JSON.stringify({ tripId, userId: "user_abcdefgh", role: "member", runtimeUsername: null, audience: "runtime_gateway", sessionId: "wsess_devicea0001" }));
    }
    const route = req.url.match(/^\/internal\/runtime-routes\/([^/]+)$/);
    if (route && trips[decodeURIComponent(route[1])]) {
      const id = decodeURIComponent(route[1]);
      const answer = { routeRef: "route_abcdefgh", upstreamOrigin: trips[id].origin, upstreamBasePath: "" };
      if (routeKinds[id] !== undefined) answer.tripKey = routeKinds[id];
      return res.end(JSON.stringify(answer));
    }
    res.statusCode = 404; res.end("{}");
  });
  controlPlaneOrigin = await listen(controlPlane);
});

after(async () => {
  await Promise.all([...gateways.map(close), close(controlPlane), ...Object.values(trips).map((t) => close(t.server))]);
});

// An oracle written here, apart from the gateway's: the label and HMAC of the spec.
function derive(tripId, master = MASTER) {
  return createHmac("sha256", master).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");
}

// Starts a gateway with this environment. `undefined` removes a variable.
async function startGateway(env) {
  const base = {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE,
    RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test",
    RUNTIME_UPSTREAM_TIMEOUT_MS: "1000", RUNTIME_TRIP_KEY_MASTER: undefined, RUNTIME_LEGACY_TRIP_KEY: undefined,
  };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await import(`../server.js?keys=${Math.random()}`);
  const server = mod.createRuntimeGateway();
  const origin = await listen(server);
  gateways.push(server);
  return { origin, mod };
}

const launch = (gw, tripId) => fetch(`${gw.origin}/t/${tripId}/__launch`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: PORTAL },
  body: new URLSearchParams({ token: `grant-${tripId}` }).toString(),
});
const internalCall = (gw, tripId, method, key, extra = {}) => fetch(`${gw.origin}/internal/t/${tripId}/participants${method === "GET" ? "/bob" : ""}`, {
  method, headers: { "x-api-key": key, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ tripId, username: "bob", ...extra }) } : {}),
});
const reset = () => { for (const t of Object.values(trips)) t.seen.length = 0; controlPlaneKeys.length = 0; };

test("AC-K2.6: deriveTripKey reproduces every published vector (the worker's test reads the same file)", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER });
  assert.equal(vectors.label, "kinerary-trip-exchange:v1:");
  for (const v of vectors.vectors) assert.equal(gw.mod.deriveTripKey(v.master, v.tripId), v.key, `${v.master} / ${v.tripId}`);
  for (const v of vectors.vectors) assert.equal(derive(v.tripId, v.master), v.key, "the test's own oracle agrees with the file");
});

test("AC-K2.3: with RUNTIME_TRIP_KEY_MASTER unset, trips are sent RUNTIME_EXCHANGE_KEY, whatever the route says", async () => {
  // The route kinds are 'derived' here: with no master the gateway cannot derive, so it does what it always did.
  const held = EXCHANGE;
  const trip = fakeTrip(held);
  const origin = await listen(trip.server);
  const savedOrigin = trips[TRIP_A].origin;
  trips[TRIP_A].origin = origin;
  try {
    const gw = await startGateway({});
    reset();
    const response = await launch(gw, TRIP_A);
    assert.equal(response.status, 303);
    assert.deepEqual(trip.seen.map((r) => r.key), [EXCHANGE]);
    assert.equal((await internalCall(gw, TRIP_A, "POST", EXCHANGE)).status, 200);
    assert.equal((await internalCall(gw, TRIP_A, "GET", EXCHANGE)).status, 200);
    assert.deepEqual(trip.seen.map((r) => r.key), [EXCHANGE, EXCHANGE, EXCHANGE]);
  } finally { trips[TRIP_A].origin = savedOrigin; await close(trip.server); }
});

test("AC-K2.3: a derived trip is sent derive(master, ITS id); trip A's key is refused by trip B", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  assert.equal((await launch(gw, TRIP_A)).status, 303);
  assert.equal((await launch(gw, TRIP_B)).status, 303);
  assert.deepEqual(trips[TRIP_A].seen.map((r) => r.key), [derive(TRIP_A)]);
  assert.deepEqual(trips[TRIP_B].seen.map((r) => r.key), [derive(TRIP_B)]);
  assert.notEqual(derive(TRIP_A), derive(TRIP_B));
  // The point of the change: what trip A holds is no key for trip B.
  const replay = await fetch(`${trips[TRIP_B].origin}/api/internal/control-plane/session`, { method: "POST", headers: { "x-api-key": derive(TRIP_A) }, body: "{}" });
  assert.equal(replay.status, 401, "trip B refuses trip A's key");
  const own = await fetch(`${trips[TRIP_B].origin}/api/internal/control-plane/session`, { method: "POST", headers: { "x-api-key": derive(TRIP_B) }, body: "{}" });
  assert.equal(own.status, 200, "and accepts its own");
  // Neither the legacy key nor the exchange key was handed to a derived trip.
  for (const id of [TRIP_A, TRIP_B]) for (const r of trips[id].seen.slice(0, 1)) assert.ok(![LEGACY, EXCHANGE].includes(r.key));
});

test("AC-K2.3: the participant routes send the derived key too, and still check THEIR caller against RUNTIME_EXCHANGE_KEY", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  assert.equal((await internalCall(gw, TRIP_A, "POST", EXCHANGE)).status, 200);
  assert.equal((await internalCall(gw, TRIP_A, "GET", EXCHANGE)).status, 200);
  assert.deepEqual(trips[TRIP_A].seen.map((r) => r.key), [derive(TRIP_A), derive(TRIP_A)]);
  // The caller's key is the control-plane key. A trip's key, derived or legacy, opens nothing on the gateway.
  reset();
  for (const wrong of [derive(TRIP_A), LEGACY, MASTER, "", "nope"]) {
    assert.equal((await internalCall(gw, TRIP_A, "POST", wrong)).status, 401, `POST with ${wrong ? "a wrong key" : "no key"}`);
    assert.equal((await internalCall(gw, TRIP_A, "GET", wrong)).status, 401);
  }
  assert.deepEqual(trips[TRIP_A].seen, [], "refused callers reach no trip");
});

test("AC-K2.3: the control-plane calls keep carrying RUNTIME_EXCHANGE_KEY", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  assert.equal((await launch(gw, TRIP_A)).status, 303);
  assert.ok(controlPlaneKeys.length >= 2, "consume + route lookup");
  assert.ok(controlPlaneKeys.every((k) => k === EXCHANGE), `control plane saw: ${[...new Set(controlPlaneKeys)].map((k) => (k === EXCHANGE ? "exchange" : "OTHER")).join(",")}`);
});

test("AC-K2.3: a shared trip is sent RUNTIME_LEGACY_TRIP_KEY", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  assert.equal((await launch(gw, TRIP_S)).status, 303);
  assert.equal((await internalCall(gw, TRIP_S, "POST", EXCHANGE)).status, 200);
  assert.deepEqual(trips[TRIP_S].seen.map((r) => r.key), [LEGACY, LEGACY]);
});

test("AC-K2.3: a shared trip with no legacy key is 503 and NO request reaches the trip", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER });
  reset();
  const launched = await launch(gw, TRIP_S);
  assert.equal(launched.status, 503);
  const post = await internalCall(gw, TRIP_S, "POST", EXCHANGE);
  assert.equal(post.status, 503);
  assert.deepEqual(await post.json(), { error: "RUNTIME_UNAVAILABLE" });
  assert.equal((await internalCall(gw, TRIP_S, "GET", EXCHANGE)).status, 503);
  assert.deepEqual(trips[TRIP_S].seen, [], "nothing was sent to the trip, with any key");
  // A derived trip on the same gateway is unaffected.
  assert.equal((await launch(gw, TRIP_A)).status, 303);
});

test("AC-K2.3: a route kind this gateway does not know, or none at all, fails closed with no request", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  for (const id of [TRIP_X, TRIP_N]) {
    assert.equal((await launch(gw, id)).status, 503);
    assert.equal((await internalCall(gw, id, "POST", EXCHANGE)).status, 503);
    assert.deepEqual(trips[id].seen, [], `${id}: nothing sent`);
  }
});

test("AC-K2.3: a 401 from a derived trip is not retried with another key", async () => {
  const stubborn = fakeTrip("nobody-holds-this-key", true);
  const origin = await listen(stubborn.server);
  const saved = trips[TRIP_A].origin;
  trips[TRIP_A].origin = origin;
  try {
    const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
    reset();
    const launched = await launch(gw, TRIP_A);
    assert.equal(launched.status, 401, "a trip that refuses its key refuses the launch");
    const post = await internalCall(gw, TRIP_A, "POST", EXCHANGE);
    assert.equal(post.status, 401, "the trip's own answer is passed on");
    const get = await internalCall(gw, TRIP_A, "GET", EXCHANGE);
    assert.equal(get.status, 401);
    assert.deepEqual(stubborn.seen.map((r) => r.key), [derive(TRIP_A), derive(TRIP_A), derive(TRIP_A)], "one request per call, always the derived key");
    for (const r of stubborn.seen) assert.ok(![LEGACY, EXCHANGE].includes(r.key), "the legacy and control-plane keys are never offered");
  } finally { trips[TRIP_A].origin = saved; await close(stubborn.server); }
});

test("AC-K2.3: the key comes from the trip the ROUTE was looked up for, never from the request", async () => {
  const gw = await startGateway({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY });
  reset();
  // The body names trip B, the path names trip A: refused before anything is sent, and never keyed for B.
  const mismatch = await fetch(`${gw.origin}/internal/t/${TRIP_A}/participants`, { method: "POST", headers: { "x-api-key": EXCHANGE, "content-type": "application/json" }, body: JSON.stringify({ tripId: TRIP_B }) });
  assert.equal(mismatch.status, 400);
  // Client headers cannot choose the key kind or the key.
  const hostile = await fetch(`${gw.origin}/internal/t/${TRIP_A}/participants/bob`, { headers: { "x-api-key": EXCHANGE, "x-trip-key": LEGACY, "x-control-plane-trip-id": TRIP_B } });
  assert.equal(hostile.status, 200);
  assert.deepEqual(trips[TRIP_B].seen, []);
  assert.deepEqual(trips[TRIP_A].seen.map((r) => r.key), [derive(TRIP_A)]);
});

// F2 of the owner's review of #599: rotation is part of the rollout, so the gateway enforces it.
test("AC-K2.8: with a master set, the gateway refuses to start when any two of the exchange key, the master and the legacy key are equal, naming variables and never a value", async () => {
  const server = fileURLToPath(new URL("../server.js", import.meta.url));
  const run = (extra) => new Promise((resolve) => {
    const child = spawn(process.execPath, [server], {
      env: { PATH: process.env.PATH, PORT: "0", BIND_HOST: "127.0.0.1", CONTROL_PLANE_INTERNAL_ORIGIN: "http://127.0.0.1:9", RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: PORTAL, RUNTIME_ORIGIN: "https://runtime.example.test", ...extra },
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; if (/listening/.test(out)) child.kill(); });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => resolve({ code, out, err }));
    setTimeout(() => child.kill(), 4000);
  });
  const SAME = "the-one-value-reused-0001";
  const cases = [
    ["RUNTIME_EXCHANGE_KEY and RUNTIME_LEGACY_TRIP_KEY", { RUNTIME_EXCHANGE_KEY: SAME, RUNTIME_TRIP_KEY_MASTER: "m-0001", RUNTIME_LEGACY_TRIP_KEY: SAME }], // the documented rollout, un-rotated
    ["RUNTIME_EXCHANGE_KEY and RUNTIME_TRIP_KEY_MASTER", { RUNTIME_EXCHANGE_KEY: SAME, RUNTIME_TRIP_KEY_MASTER: SAME, RUNTIME_LEGACY_TRIP_KEY: "l-0001" }],
    ["RUNTIME_EXCHANGE_KEY and RUNTIME_TRIP_KEY_MASTER", { RUNTIME_EXCHANGE_KEY: SAME, RUNTIME_TRIP_KEY_MASTER: SAME }], // no legacy key at all
    ["RUNTIME_TRIP_KEY_MASTER and RUNTIME_LEGACY_TRIP_KEY", { RUNTIME_EXCHANGE_KEY: "e-0001", RUNTIME_TRIP_KEY_MASTER: SAME, RUNTIME_LEGACY_TRIP_KEY: SAME }],
  ];
  for (const [named, env] of cases) {
    const refused = await run(env);
    console.log(`refusal for ${named}: exit=${refused.code}\n${refused.err.split("\n").filter((l) => l.startsWith("runtime_gateway.")).join("\n")}`);
    assert.notEqual(refused.code, 0, named);
    assert.equal(refused.out, "", `${named}: nothing is listening`);
    assert.match(refused.err, /runtime_gateway\.trip_keys_not_distinct/, named);
    assert.ok(refused.err.includes(named), `names ${named}: ${refused.err}`);
    assert.ok(!refused.err.includes(SAME), "the value is never printed");
  }
  const allThree = await run({ RUNTIME_EXCHANGE_KEY: SAME, RUNTIME_TRIP_KEY_MASTER: SAME, RUNTIME_LEGACY_TRIP_KEY: SAME });
  assert.notEqual(allThree.code, 0);
  assert.match(allThree.err, /RUNTIME_EXCHANGE_KEY and RUNTIME_TRIP_KEY_MASTER; RUNTIME_EXCHANGE_KEY and RUNTIME_LEGACY_TRIP_KEY; RUNTIME_TRIP_KEY_MASTER and RUNTIME_LEGACY_TRIP_KEY/);
  // Three different values start; so do per-trip keys left off (no master), which is today's single-key deployment.
  assert.match((await run({ RUNTIME_EXCHANGE_KEY: "e-0001", RUNTIME_TRIP_KEY_MASTER: "m-0001", RUNTIME_LEGACY_TRIP_KEY: "l-0001" })).out, /listening/);
  assert.match((await run({ RUNTIME_EXCHANGE_KEY: "e-0001", RUNTIME_TRIP_KEY_MASTER: "m-0001" })).out, /listening/, "no legacy key set: nothing to compare it with");
  assert.match((await run({ RUNTIME_EXCHANGE_KEY: SAME })).out, /listening/, "per-trip keys off: one key, as before");
});
