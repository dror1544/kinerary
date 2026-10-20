import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import type { PortalDependencies } from "../src/portal.js";
import { checkBotIdentity } from "../src/telegram-mini-app.js";
import { OTHER_BOT_TOKEN, TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";

// The structural half of POST /v1/auth/telegram-mini-app, with no database:
// every refusal below must happen BEFORE the database is touched, and the pool
// here fails the test if anything reaches it.

const ORIGIN = "http://portal.example.test";
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function appWith(options: { enabled?: boolean; queryLog?: string[]; unlinkedClient?: boolean } = {}) {
  const touched: string[] = options.queryLog ?? [];
  const client = {
    query: async (sql: string) => {
      touched.push(sql.slice(0, 40));
      return /EXISTS/.test(sql) ? { rows: [{ linked: false }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const db = {
    query: async (sql: string) => { touched.push(sql.slice(0, 40)); throw new Error("the database must not be reached"); },
    connect: async () => {
      if (!options.unlinkedClient) { touched.push("connect"); throw new Error("the database must not be reached"); }
      return client;
    },
  } as unknown as PortalDependencies["db"];
  const portal: PortalDependencies = {
    db, runtimeAccounts: {} as PortalDependencies["runtimeAccounts"], publicOrigin: ORIGIN,
    runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "k", runtimeUpstreamHostSuffixes: ["internal"],
    telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
    telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => options.enabled ?? true, log: () => {} },
  };
  return { app: buildApp(profile, { portal }), touched };
}
const post = (app: ReturnType<typeof appWith>["app"], payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST", url: "/v1/auth/telegram-mini-app",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const good = (id = 424242, now = Date.now(), extra: Record<string, string> = {}) => signedInitData(launchFields(id, now, extra));

test("Origin must be exactly ours: evil, absent and the literal null are all refused before the body is read", async () => {
  const { app, touched } = appWith();
  try {
    for (const origin of ["https://evil.example", "null", "http://portal.example.test.evil.example", "http://portal.example.test/"]) {
      const response = await post(app, { initData: good() }, { origin });
      assert.equal(response.statusCode, 403, origin);
      assert.deepEqual(response.json(), { error: "ORIGIN_INVALID" });
      assert.equal(response.headers["cache-control"], "private, no-store");
    }
    const absent = await app.inject({ method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json" }, payload: JSON.stringify({ initData: good() }) });
    assert.equal(absent.statusCode, 403);
    assert.deepEqual(touched, []);
  } finally { await app.close(); }
});

test("only application/json is accepted; everything else is 415 before parsing", async () => {
  const { app, touched } = appWith();
  try {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json-patch+json", "text/html"]) {
      const response = await post(app, `initData=${encodeURIComponent(good())}`, { "content-type": contentType });
      assert.equal(response.statusCode, 415, contentType);
      assert.deepEqual(response.json(), { error: "UNSUPPORTED_MEDIA_TYPE" });
    }
    const none = await app.inject({ method: "POST", url: "/v1/auth/telegram-mini-app", headers: { origin: ORIGIN }, payload: "x" });
    assert.equal(none.statusCode, 415);
    assert.deepEqual(touched, []);
    // application/json with a charset is still JSON.
    const charset = await post(app, { initData: "x" }, { "content-type": "application/json; charset=utf-8" });
    assert.equal(charset.statusCode, 401);
  } finally { await app.close(); }
});

test("a disabled feature is a 503, before rate limits, Origin or parsing", async () => {
  const { app, touched } = appWith({ enabled: false });
  try {
    for (const headers of [{}, { origin: "https://evil.example" }] as Array<Record<string, string>>) {
      const response = await post(app, { initData: good() }, headers);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "TELEGRAM_MINI_APP_UNAVAILABLE" });
    }
    assert.deepEqual(touched, []);
  } finally { await app.close(); }
});

test("every verification failure is the same 401, byte for byte, and never reaches the database", async () => {
  const { app, touched } = appWith();
  try {
    const now = Date.now();
    const base = launchFields(424242, now);
    const forgedUser = good().replace("424242", "100000001");
    const goodString = good();
    const hash = /hash=([0-9a-f]{64})/.exec(goodString)![1]!;
    const bodies: Array<[string, unknown]> = [
      ["forged user.id", { initData: forgedUser }],
      ["other bot", { initData: signedInitData(base, OTHER_BOT_TOKEN) }],
      ["stale", { initData: signedInitData(launchFields(424242, now - 301_000)) }],
      ["future", { initData: signedInitData(launchFields(424242, now + 90_000)) }],
      ["uppercase hash", { initData: goodString.replace(hash, hash.toUpperCase()) }],
      ["trailing nibble", { initData: goodString.replace(hash, `${hash}0`) }],
      ["duplicate keys", { initData: `${goodString}&user=%7B%22id%22%3A1%7D` }],
      ["oversize", { initData: signedInitData({ ...base, padding: "x".repeat(5000) }) }],
      ["initDataUnsafe-shaped body", { initDataUnsafe: { user: { id: 424242 }, auth_date: Math.floor(now / 1000) }, user: { id: 424242 } }],
      ["initData as an object", { initData: { user: { id: 424242 } } }],
      ["missing initData", {}],
      ["array body", [goodString]],
      ["null body", "null"],
      ["empty initData", { initData: "" }],
      ["unsigned query-string fields beside no initData", { query_id: "x", user: "{}", auth_date: "1", hash: "0".repeat(64) }],
    ];
    const seen = new Set<string>();
    for (const [name, payload] of bodies) {
      const response = await post(app, payload);
      assert.equal(response.statusCode, 401, name);
      assert.equal(response.headers["cache-control"], "private, no-store", name);
      assert.equal(response.headers["set-cookie"], undefined, name);
      seen.add(response.body);
    }
    assert.deepEqual([...seen], ['{"error":"TELEGRAM_INIT_DATA_INVALID"}']);
    assert.deepEqual(touched, []);
  } finally { await app.close(); }
});

test("the per-IP budget is spent before verification: the 101st request is 429 whatever it carries", async () => {
  const { app, touched } = appWith();
  try {
    for (let i = 0; i < 100; i++) assert.equal((await post(app, "{}")).statusCode, 401);
    const limited = await post(app, { initData: good() });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: "SIGN_IN_RATE_LIMITED" });
    assert.equal(limited.headers["retry-after"], "60");
    assert.deepEqual(touched, []);
  } finally { await app.close(); }
});

test("the per-person budget is keyed only after verification: forged requests cannot spend or fill it", async () => {
  const { app } = appWith({ unlinkedClient: true });
  try {
    // 30 forged requests naming the same user id: none counts against that person.
    for (let i = 0; i < 30; i++) {
      assert.equal((await post(app, { initData: good(777001).replace("777001", "777002") })).statusCode, 401);
    }
    // The person themselves still has their full 20.
    for (let i = 0; i < 20; i++) {
      const response = await post(app, { initData: good(777002, Date.now(), { query_id: `AA${i}x${Math.random().toString(16).slice(2)}` }) });
      assert.equal(response.statusCode, 401, `request ${i + 1}`);
      assert.equal(response.json().error, "TELEGRAM_NOT_LINKED");
    }
    const over = await post(app, { initData: good(777002, Date.now(), { query_id: "AAoverthelimit" }) });
    assert.equal(over.statusCode, 429);
    // Somebody else is unaffected.
    assert.equal((await post(app, { initData: good(777003) })).json().error, "TELEGRAM_NOT_LINKED");
  } finally { await app.close(); }
});

// ── Boot: the token must belong to the bot the profile names ────────────────

function fakeGetMe(result: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(result), { status })) as unknown as typeof fetch;
}

test("boot check: a token for the configured bot enables the feature and reports has_main_web_app", async () => {
  const lines: string[] = [];
  const result = await checkBotIdentity({
    token: TEST_BOT_TOKEN, expectedUsername: "Kinerary_Bot", log: (l) => lines.push(l),
    fetchImpl: fakeGetMe({ ok: true, result: { username: "kinerary_bot", has_main_web_app: true } }),
  });
  assert.deepEqual(result, { ok: true, hasMainWebApp: true });
  assert.ok(lines.some((l) => l.includes('"has_main_web_app":true')));
});

test("boot check: another bot's token keeps the feature off and the log never contains the token", async () => {
  const lines: string[] = [];
  const result = await checkBotIdentity({
    token: OTHER_BOT_TOKEN, expectedUsername: "kinerary_bot", log: (l) => lines.push(l),
    fetchImpl: fakeGetMe({ ok: true, result: { username: "some_other_bot" } }),
  });
  assert.deepEqual(result, { ok: false, reason: "MISMATCH" });
  const mismatch = lines.find((l) => l.includes("mini_app.bot_token_mismatch"));
  assert.ok(mismatch);
  assert.equal(lines.some((l) => l.includes(OTHER_BOT_TOKEN) || l.includes(OTHER_BOT_TOKEN.split(":")[1]!)), false);
});

test("boot check: Telegram errors and malformed answers fail closed and log no URL (the URL carries the token)", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  assert.deepEqual(await checkBotIdentity({ token: TEST_BOT_TOKEN, expectedUsername: "kinerary_bot", log, fetchImpl: fakeGetMe({ ok: false }, 401) }), { ok: false, reason: "UNREACHABLE" });
  assert.deepEqual(await checkBotIdentity({ token: TEST_BOT_TOKEN, expectedUsername: "kinerary_bot", log, fetchImpl: fakeGetMe({ ok: true, result: {} }) }), { ok: false, reason: "UNUSABLE" });
  const throwing = (async () => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${TEST_BOT_TOKEN}/getMe`); }) as unknown as typeof fetch;
  assert.deepEqual(await checkBotIdentity({ token: TEST_BOT_TOKEN, expectedUsername: "kinerary_bot", log, fetchImpl: throwing }), { ok: false, reason: "UNREACHABLE" });
  assert.equal(lines.some((l) => l.includes(TEST_BOT_TOKEN) || l.includes("api.telegram.org")), false);
});
