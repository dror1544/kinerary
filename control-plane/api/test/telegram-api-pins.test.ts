/**
 * #443 - the Bot API calls behind the pinned "Open trip" message, and that a URL
 * button reaches Telegram as a URL button (no callback_data, no web_app).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpTelegramClient } from "../src/relay/telegram-api.js";

const TOKEN = "123456:SECRET-token-value";

function stub(reply: { status: number; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const client = () => new HttpTelegramClient(TOKEN, () => {}, undefined, { sleep: async () => {} });

describe("getPinnedMessage", () => {
  test("reduces getChat.pinned_message to sender, text and button URLs", async () => {
    const t = stub({ status: 200, body: { ok: true, result: { id: -100, type: "supergroup", pinned_message: {
      message_id: 41, from: { id: 8463178587, is_bot: true }, text: "The trip is one tap away",
      reply_markup: { inline_keyboard: [[{ text: "Open trip", url: "https://t.me/Kinerary_bot?startapp=trip_abcdefgh" }, { text: "x", callback_data: "y" }]] },
      chat: { id: -100 }, date: 1,
    } } } });
    try {
      const pinned = await client().getPinnedMessage("-100");
      assert.deepEqual(pinned, {
        messageId: "41", fromId: "8463178587", text: "The trip is one tap away",
        buttonUrls: ["https://t.me/Kinerary_bot?startapp=trip_abcdefgh"],
      });
      assert.match(t.calls[0]!.url, /\/getChat$/);
      assert.deepEqual(t.calls[0]!.body, { chat_id: "-100" });
    } finally { t.restore(); }
  });

  test("nothing pinned, or Telegram refusing, is null - never a throw", async () => {
    let t = stub({ status: 200, body: { ok: true, result: { id: -100, type: "supergroup" } } });
    try { assert.equal(await client().getPinnedMessage("-100"), null); } finally { t.restore(); }
    t = stub({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } });
    try { assert.equal(await client().getPinnedMessage("-100"), null); } finally { t.restore(); }
  });
});

describe("unpinChatMessage", () => {
  test("unpins one message by id, and says whether it worked", async () => {
    let t = stub({ status: 200, body: { ok: true, result: true } });
    try {
      assert.equal(await client().unpinChatMessage({ chatId: "-100", messageId: "41" }), true);
      assert.match(t.calls[0]!.url, /\/unpinChatMessage$/);
      assert.deepEqual(t.calls[0]!.body, { chat_id: "-100", message_id: 41 });
    } finally { t.restore(); }
    t = stub({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: not enough rights to unpin a message" } });
    try { assert.equal(await client().unpinChatMessage({ chatId: "-100", messageId: "41" }), false); } finally { t.restore(); }
  });
});

describe("sending the Open trip message", () => {
  test("a URL button goes out as {text, url} - and the pin does not notify the group", async () => {
    const t = stub({ status: 200, body: { ok: true, result: { message_id: 7 } } });
    try {
      const c = client();
      const sent = await c.sendMessage({
        chatId: "-100", text: "hi",
        replyMarkup: { inline_keyboard: [[{ text: "Open trip", url: "https://t.me/Kinerary_bot?startapp=trip_abcdefgh" }]] },
      });
      assert.equal(sent.messageId, "7");
      assert.deepEqual((t.calls[0]!.body.reply_markup as { inline_keyboard: unknown }).inline_keyboard, [[{ text: "Open trip", url: "https://t.me/Kinerary_bot?startapp=trip_abcdefgh" }]]);
      await c.pinChatMessage({ chatId: "-100", messageId: "7" });
      assert.equal(t.calls[1]!.body.disable_notification, true);
    } finally { t.restore(); }
  });
});
