import assert from "node:assert/strict";
import { test, describe, before, after, mock } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import {
  TelegramNotificationAdapter,
  resolveTelegramCallbackRef,
  answerTelegramCallbackQuery,
} from "../src/adapters/telegram.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function randomHex(n: number) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}
function generateTestId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomHex(8)}`;
}

// ── answerTelegramCallbackQuery (no DB, mocked network) ────────────────────────

describe("answerTelegramCallbackQuery", () => {
  after(() => mock.restoreAll());

  test("POSTs to Telegram's answerCallbackQuery with the callback id", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await answerTelegramCallbackQuery("bot-token", "cbq_123", "Approved");

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/botbot-token\/answerCallbackQuery$/);
    assert.deepEqual(calls[0].body, { callback_query_id: "cbq_123", text: "Approved", show_alert: false });
    mock.restoreAll();
  });

  test("never throws even when the network call fails", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("network unreachable");
    });

    await assert.doesNotReject(() => answerTelegramCallbackQuery("bot-token", "cbq_123"));
    mock.restoreAll();
  });
});

// ── DB-backed: ref writing and resolution ───────────────────────────────────────

describe("TelegramNotificationAdapter + resolveTelegramCallbackRef", () => {
  let pool: pg.Pool;

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); }
    finally { client.release(); }
  });

  after(async () => {
    if (SKIP) return;
    await pool.end();
  });

  test("sendApprovalRequest writes both refs and calls sendMessage with an inline keyboard", { skip: SKIP }, async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    try {
      const adapter = new TelegramNotificationAdapter({ botToken: "bot-token", superAdminChatId: "391627336", db: pool });
      const expiresAt = new Date(Date.now() + 3600_000);
      const requestId = generateTestId("sreq");

      await adapter.sendApprovalRequest({
        requestId,
        displayName: "Test Organizer",
        tripNameRequest: "Japan 2026",
        approveToken: `approve-token-${randomHex(8)}`,
        rejectToken: `reject-token-${randomHex(8)}`,
        expiresAt,
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/botbot-token\/sendMessage$/);
      assert.equal(calls[0].body.chat_id, "391627336");
      const keyboard = (calls[0].body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
      const [approveButton, rejectButton] = keyboard[0];
      // Real callback_data must fit Telegram's 64-byte limit — this is the
      // whole reason the ref indirection exists.
      assert.ok(Buffer.byteLength(approveButton.callback_data, "utf8") <= 64);
      assert.ok(Buffer.byteLength(rejectButton.callback_data, "utf8") <= 64);

      const approveResolved = await resolveTelegramCallbackRef(pool, approveButton.callback_data);
      const rejectResolved = await resolveTelegramCallbackRef(pool, rejectButton.callback_data);
      assert.match(approveResolved ?? "", /^approve-token-/);
      assert.match(rejectResolved ?? "", /^reject-token-/);
    } finally {
      mock.restoreAll();
    }
  });

  test("resolveTelegramCallbackRef returns null for an unknown ref", { skip: SKIP }, async () => {
    const result = await resolveTelegramCallbackRef(pool, "cbk_doesnotexist00000000");
    assert.equal(result, null);
  });

  test("resolveTelegramCallbackRef returns null for an expired ref", { skip: SKIP }, async () => {
    const ref = `cbk_${randomHex(16)}`;
    await pool.query(
      "INSERT INTO control_plane.telegram_callback_refs (ref, token, expires_at) VALUES ($1, $2, now() - interval '1 second')",
      [ref, "some-token"],
    );
    const result = await resolveTelegramCallbackRef(pool, ref);
    assert.equal(result, null);
  });

  test("sendMessage POSTs a plain DM to the given chat id, no callback refs involved", { skip: SKIP }, async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    try {
      const adapter = new TelegramNotificationAdapter({ botToken: "bot-token", superAdminChatId: "391627336", db: pool });
      await adapter.sendMessage({ chatId: "777000111", text: "Your trip site is ready: https://example.test" });

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/botbot-token\/sendMessage$/);
      assert.equal(calls[0].body.chat_id, "777000111");
      assert.equal(calls[0].body.text, "Your trip site is ready: https://example.test");
      assert.equal(calls[0].body.reply_markup, undefined);
    } finally {
      mock.restoreAll();
    }
  });

  test("sendMessage throws on a non-2xx response, same as sendApprovalRequest", { skip: SKIP }, async () => {
    mock.method(globalThis, "fetch", async () => new Response("Bad Request: chat not found", { status: 400 }));
    try {
      const adapter = new TelegramNotificationAdapter({ botToken: "bot-token", superAdminChatId: "391627336", db: pool });
      await assert.rejects(
        () => adapter.sendMessage({ chatId: "777000111", text: "hi" }),
        /telegram sendMessage failed: HTTP 400/,
      );
    } finally {
      mock.restoreAll();
    }
  });

  test("sendApprovalRequest throws and logs when Telegram returns a non-2xx response", { skip: SKIP }, async () => {
    mock.method(globalThis, "fetch", async () => new Response("Bad Request: chat not found", { status: 400 }));

    try {
      const adapter = new TelegramNotificationAdapter({ botToken: "bot-token", superAdminChatId: "391627336", db: pool });
      await assert.rejects(
        () => adapter.sendApprovalRequest({
          requestId: generateTestId("sreq"),
          displayName: "Test Organizer",
          tripNameRequest: "Japan 2026",
          approveToken: "approve-token",
          rejectToken: "reject-token",
          expiresAt: new Date(Date.now() + 3600_000),
        }),
        /telegram sendMessage failed: HTTP 400/,
      );
    } finally {
      mock.restoreAll();
    }
  });
});
