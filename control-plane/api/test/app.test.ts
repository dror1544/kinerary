import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";

const profile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

test("public skeleton exposes health only, never a provider-action endpoint", async () => {
  const app = buildApp(profile);
  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok", service: "control-plane-api" });
  assert.equal((await app.inject({ method: "POST", url: "/provider/create" })).statusCode, 404);
  await app.close();
});

test("readiness reflects the database and fails closed without leaking an error", async () => {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };

  const ready = buildApp(profile, { readiness: async () => ({ database: "ready", schema_migrations: 2 }), log });
  const response = await ready.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().schema_migrations, 2);
  assert.deepEqual(lines, [], "a healthy check must stay quiet");
  await ready.close();

  const unavailable = buildApp(profile, {
    readiness: async () => { throw Object.assign(new Error("password=do-not-leak"), { code: "08006" }); },
    log,
  });
  const failure = await unavailable.inject({ method: "GET", url: "/readyz" });
  assert.equal(failure.statusCode, 503);
  assert.deepEqual(failure.json(), { status: "not_ready", reason: "database_unavailable" });
  assert.doesNotMatch(failure.body, /password|do-not-leak/);
  // The outage stays opaque to the caller but must not be silent to the
  // operator, and the line it writes carries only the safe fields.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /DATABASE_UNAVAILABLE/);
  assert.match(lines[0], /08006/);
  assert.doesNotMatch(lines[0], /password|do-not-leak/);
  await unavailable.close();

  lines.length = 0;
  const unconfigured = buildApp(profile, { log });
  const missing = await unconfigured.inject({ method: "GET", url: "/readyz" });
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(missing.json(), { status: "not_ready", reason: "readiness_unconfigured" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /READINESS_UNCONFIGURED/);
  await unconfigured.close();
});
