import assert from "node:assert/strict";
import { test, describe, before, after, mock } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { digestTelegramId } from "../src/identity.js";
import { signApprovalAction } from "../src/approval-action.js";
import { startSignup, type NotificationAdapter, type SignupConfig } from "../src/signup.js";
import { deleteWebhookIfPresent, handleTelegramUpdate, startTelegramApprovalPoller } from "../src/telegram-poller.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const ACTION_SECRET = "test-action-secret-poller";
const SUPER_ADMIN_ID = "500000001";
const SUPER_ADMIN_DIGEST = digestTelegramId(SUPER_ADMIN_ID);
const BOT_TOKEN = "poller-test-bot-token";

const testConfig: SignupConfig = {
  superAdminSubjectDigest: SUPER_ADMIN_DIGEST,
  actionSecret: ACTION_SECRET,
  actionTtlSeconds: 3600,
  messagingAdapter: "fake",
  signupRateLimitCooldownSeconds: 0,
};

class NullNotification implements NotificationAdapter {
  async sendApprovalRequest() {}
  async sendMessage() {}
}

async function resetDb(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

async function freshPool(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: DB_URL });
  const client = await pool.connect();
  await resetDb(client);
  await applyMigrations(client, migrationsDir);
  client.release();
  return pool;
}

after(() => mock.restoreAll());

describe("handleTelegramUpdate", () => {
  test("approves a real pending request from a callback_query", { skip: SKIP }, async () => {
    const pool = await freshPool();
    try {
      const answerCalls: unknown[] = [];
      mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        answerCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const { requestId } = await startSignup(
        pool,
        { provider: "telegram", providerSubjectDigest: digestTelegramId("600000001"), providerSubjectId: "600000001", displayName: "Test" },
        "Poller Trip",
        testConfig,
        new NullNotification(),
      );
      assert.ok(requestId);
      const { token } = signApprovalAction(requestId!, "approve", ACTION_SECRET);

      await handleTelegramUpdate(
        { update_id: 1, callback_query: { id: "cbq_1", data: token, from: { id: Number(SUPER_ADMIN_ID) } } },
        { db: pool, botToken: BOT_TOKEN, config: testConfig },
      );

      const trips = await pool.query("SELECT count(*)::int AS c FROM control_plane.trips");
      assert.equal(trips.rows[0].c, 1);
      assert.equal(answerCalls.length, 1);
      mock.restoreAll();
    } finally {
      await pool.end();
    }
  });

  test("ignores an update with no callback_query", { skip: SKIP }, async () => {
    const pool = await freshPool();
    try {
      let fetchCalled = false;
      mock.method(globalThis, "fetch", async () => { fetchCalled = true; return new Response("{}"); });

      await handleTelegramUpdate({ update_id: 2 }, { db: pool, botToken: BOT_TOKEN, config: testConfig });

      assert.equal(fetchCalled, false);
      mock.restoreAll();
    } finally {
      await pool.end();
    }
  });

  test("ignores a callback_query missing data or a sender id", { skip: SKIP }, async () => {
    const pool = await freshPool();
    try {
      let fetchCalled = false;
      mock.method(globalThis, "fetch", async () => { fetchCalled = true; return new Response("{}"); });

      await handleTelegramUpdate(
        { update_id: 3, callback_query: { id: "cbq_2", from: { id: 123 } } },
        { db: pool, botToken: BOT_TOKEN, config: testConfig },
      );

      assert.equal(fetchCalled, false);
      mock.restoreAll();
    } finally {
      await pool.end();
    }
  });
});

describe("startTelegramApprovalPoller", () => {
  test("advances the offset past processed updates on the next poll", { skip: SKIP }, async () => {
    const pool = await freshPool();
    try {
      const requestedOffsets: number[] = [];
      let call = 0;
      mock.method(globalThis, "fetch", async (url: string) => {
        call += 1;
        const parsed = new URL(url);
        requestedOffsets.push(Number(parsed.searchParams.get("offset")));
        if (call === 1) {
          return new Response(JSON.stringify({ ok: true, result: [{ update_id: 41 }, { update_id: 42 }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      });

      const stop = startTelegramApprovalPoller({ db: pool, botToken: BOT_TOKEN, config: testConfig }, 5);
      await new Promise((resolve) => setTimeout(resolve, 30));
      stop();

      assert.ok(call >= 2, `expected at least 2 polls, got ${call}`);
      assert.equal(requestedOffsets[0], 0);
      assert.equal(requestedOffsets[1], 43);
      mock.restoreAll();
    } finally {
      await pool.end();
    }
  });

  test("stop() halts further polling", { skip: SKIP }, async () => {
    const pool = await freshPool();
    try {
      let call = 0;
      mock.method(globalThis, "fetch", async () => {
        call += 1;
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      });

      const stop = startTelegramApprovalPoller({ db: pool, botToken: BOT_TOKEN, config: testConfig }, 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stop();
      const callsAtStop = call;
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(call, callsAtStop);
      mock.restoreAll();
    } finally {
      await pool.end();
    }
  });
});

describe("deleteWebhookIfPresent", () => {
  test("deletes an existing webhook", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      calls.push(url);
      if (url.includes("getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "https://example.invalid/webhook" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await deleteWebhookIfPresent(BOT_TOKEN);

    assert.equal(calls.length, 2);
    assert.match(calls[1], /deleteWebhook$/);
    mock.restoreAll();
  });

  test("does nothing when no webhook is registered", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, result: { url: "" } }), { status: 200 });
    });

    await deleteWebhookIfPresent(BOT_TOKEN);

    assert.equal(calls.length, 1);
    mock.restoreAll();
  });
});
