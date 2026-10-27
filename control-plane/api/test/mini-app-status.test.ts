import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { createBotCheckRound, createMiniAppStatus, withMiniAppReadiness } from "../src/mini-app-status.js";

const profile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

async function readyz(status: ReturnType<typeof createMiniAppStatus>) {
  const app = buildApp(profile, {
    readiness: withMiniAppReadiness(async () => ({ database: "ready", schema_migrations: 2 }), status),
  });
  const response = await app.inject({ method: "GET", url: "/readyz" });
  await app.close();
  return response;
}

test("/readyz reports has_main_web_app from the last getMe check, and stays ready either way", async () => {
  const status = createMiniAppStatus();

  // Nothing configured: the state a deployment without the Mini App is in.
  let response = await readyz(status);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().telegram_mini_app, { configured: false, enabled: false, has_main_web_app: null });
  assert.equal(response.json().schema_migrations, 2, "the database detail is still there");

  // Configured and Telegram says the BotFather step is NOT done: a confirmed gap, not a failure of the API.
  status.markConfigured();
  status.record({ ok: true, hasMainWebApp: false });
  response = await readyz(status);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().telegram_mini_app, { configured: true, enabled: true, has_main_web_app: false });

  // Done in BotFather; the boot retry (or a restart) sees it.
  status.record({ ok: true, hasMainWebApp: true });
  response = await readyz(status);
  assert.equal(response.json().telegram_mini_app.has_main_web_app, true);
});

test("a failed or unreadable check never turns 'unknown' into 'no', and never erases a known answer", () => {
  const status = createMiniAppStatus();
  status.markConfigured();
  status.record({ ok: false });
  assert.deepEqual(status.snapshot(), { configured: true, enabled: false, has_main_web_app: null });
  status.record({ ok: true, hasMainWebApp: null });
  assert.deepEqual(status.snapshot(), { configured: true, enabled: true, has_main_web_app: null });
  status.record({ ok: true, hasMainWebApp: true });
  status.record({ ok: false });
  assert.deepEqual(status.snapshot(), { configured: true, enabled: false, has_main_web_app: true });
});

test("the readiness detail carries booleans only - no token, handle or origin", async () => {
  const status = createMiniAppStatus();
  status.markConfigured();
  status.record({ ok: true, hasMainWebApp: true });
  const body = (await readyz(status)).body;
  assert.deepEqual(Object.keys(JSON.parse(body).telegram_mini_app).sort(), ["configured", "enabled", "has_main_web_app"]);
});

test("the boot check keeps asking while the Main Mini App is missing, announces it once, and a blip never turns a confirmed feature off", async () => {
  const answers = [
    { ok: false, reason: "UNREACHABLE" },
    { ok: true, hasMainWebApp: false },
    { ok: false, reason: "UNREACHABLE" },
    { ok: true, hasMainWebApp: false },
    { ok: true, hasMainWebApp: true },
  ];
  const status = createMiniAppStatus();
  status.markConfigured();
  let enabled = false;
  let announced = 0;
  const round = createBotCheckRound({
    check: async () => answers.shift() as never,
    status,
    setEnabled: (value) => { enabled = value; },
    onMainWebAppMissing: () => { announced += 1; },
  });

  assert.equal(await round(), false, "unreachable is not a verdict");
  assert.equal(enabled, false);
  assert.equal(await round(), false, "confirmed, but BotFather's step is not done: keep asking");
  assert.equal(enabled, true);
  assert.deepEqual(status.snapshot(), { configured: true, enabled: true, has_main_web_app: false });
  assert.equal(await round(), false);
  assert.equal(enabled, true, "a blip after a confirmation does not switch sign-in off");
  assert.deepEqual(status.snapshot(), { configured: true, enabled: true, has_main_web_app: false });
  assert.equal(await round(), false);
  assert.equal(announced, 1, "said once, not every minute");
  assert.equal(await round(), true, "BotFather done: settled, no more asking");
  assert.deepEqual(status.snapshot(), { configured: true, enabled: true, has_main_web_app: true });
});

test("a token for another bot is final, and never reads as a gap in the Main Mini App", async () => {
  const status = createMiniAppStatus();
  const round = createBotCheckRound({
    check: async () => ({ ok: false, reason: "MISMATCH" }),
    status,
    setEnabled: () => {},
    onMainWebAppMissing: () => { throw new Error("must not be announced"); },
  });
  assert.equal(await round(), true);
  assert.deepEqual(status.snapshot(), { configured: false, enabled: false, has_main_web_app: null });
});
