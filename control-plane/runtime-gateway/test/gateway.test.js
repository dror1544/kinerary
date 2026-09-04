import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let upstream, controlPlane, gateway;
let upstreamOrigin, gatewayOrigin;
let proxiedAuthorization;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function body(req) { return new Promise((resolve) => { const chunks = []; req.on("data", (chunk) => chunks.push(chunk)); req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"))); }); }

before(async () => {
  upstream = http.createServer(async (req, res) => {
    if (req.url === "/api/internal/control-plane/session") {
      assert.equal(req.headers["x-api-key"], "exchange-key");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ token: "runtime-jwt" }));
    }
    if (req.url === "/api/internal/control-plane/participants/bob") {
      assert.equal(req.headers["x-api-key"], "exchange-key");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, username: "bob" }));
    }
    proxiedAuthorization = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  upstreamOrigin = await listen(upstream);
  controlPlane = http.createServer(async (req, res) => {
    assert.equal(req.headers["x-api-key"], "exchange-key");
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/runtime-launch/consume") {
      const payload = await body(req);
      if (payload.token !== "valid-grant") { res.statusCode = 401; return res.end(JSON.stringify({ error: "invalid" })); }
      return res.end(JSON.stringify({ tripId: "trip_abcdefgh", userId: "user_abcdefgh", role: "owner", runtimeUsername: null, audience: "runtime_gateway" }));
    }
    if (req.url === "/internal/runtime-routes/trip_abcdefgh") return res.end(JSON.stringify({ routeRef: "route_abcdefgh", upstreamOrigin, upstreamBasePath: "" }));
    res.statusCode = 404; res.end(JSON.stringify({ error: "missing" }));
  });
  const controlPlaneOrigin = await listen(controlPlane);
  Object.assign(process.env, {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: controlPlaneOrigin,
    RUNTIME_EXCHANGE_KEY: "exchange-key", RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random",
    PORTAL_ORIGIN: "https://app.example.test", RUNTIME_ORIGIN: "https://runtime.example.test",
  });
  const { createRuntimeGateway } = await import(`../server.js?test=${Date.now()}`);
  gateway = createRuntimeGateway();
  gatewayOrigin = await listen(gateway);
});

after(async () => { await Promise.all([close(gateway), close(controlPlane), close(upstream)]); });

test("serves an isolated launch bootstrap without putting a grant in the URL", async () => {
  const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /kinerary:runtime-ready/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors https:\/\/app\.example\.test/);
});

test("consumes a trip-bound grant once and proxies with the runtime session", async () => {
  const launched = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/__launch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "valid-grant" }),
  });
  assert.equal(launched.status, 204);
  const cookie = launched.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("kit_runtime="));
  const cookieValue = decodeURIComponent(cookie.slice("kit_runtime=".length));
  assert.ok(!cookieValue.includes("runtime-jwt"), "the runtime JWT must not be exposed as plaintext cookie content");
  for (const part of cookieValue.split(".")) {
    assert.ok(!Buffer.from(part, "base64url").toString("utf8").includes("runtime-jwt"), "the runtime JWT must not be recoverable from an encoded cookie segment");
  }

  const response = await fetch(`${gatewayOrigin}/t/trip_abcdefgh/api/config?upstream=http://attacker.invalid`, { headers: { cookie, authorization: "Bearer browser-controlled" } });
  assert.equal(response.status, 200);
  assert.equal(proxiedAuthorization, "Bearer runtime-jwt");
  assert.deepEqual(await response.json(), { path: "/api/config?upstream=http://attacker.invalid" });
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
