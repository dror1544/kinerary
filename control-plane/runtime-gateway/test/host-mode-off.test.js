// AC-R1.4: with TRIP_HOST_SUFFIX unset the gateway has no host mode at all.
// (The whole of gateway.test.js, which never sets it, is the other half of this.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let gateway, gatewayPort, controlPlane;
const lookups = [];

before(async () => {
  controlPlane = http.createServer((req, res) => { lookups.push(req.url); res.statusCode = 404; res.end("{}"); });
  await new Promise((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
  delete process.env.TRIP_HOST_SUFFIX;
  Object.assign(process.env, {
    NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: `http://127.0.0.1:${controlPlane.address().port}`,
    RUNTIME_EXCHANGE_KEY: "exchange-key", RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random",
    PORTAL_ORIGIN: "https://app.example.test", RUNTIME_ORIGIN: "https://runtime.example.test",
  });
  const { createRuntimeGateway } = await import(`../server.js?off=${Date.now()}`);
  gateway = createRuntimeGateway();
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayPort = gateway.address().port;
});
after(async () => { await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => controlPlane.close(r))]); });

function send(host, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: gatewayPort, path, headers: { host }, setHost: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

test("a name that would be a trip host in host mode gets today's answers and no by-host lookup", async () => {
  const root = await send("alpha.example.test", "/");
  assert.equal(root.status, 404);
  assert.deepEqual(JSON.parse(root.body), { error: "NOT_FOUND" });
  const health = await send("alpha.example.test", "/health");
  assert.deepEqual(JSON.parse(health.body), { ok: true });
  const internal = await send("alpha.example.test", "/api/internal/x");
  assert.deepEqual(JSON.parse(internal.body), { error: "NOT_FOUND" });
  assert.deepEqual(lookups, []);
});
