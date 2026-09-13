import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { HttpTelegramClient, TELEGRAM_API_ROOT, telegramApiRoot } from "../src/relay/telegram-api.js";

// Every request to the Bot API root carries the bot token in its path. The
// root is configurable so a whole cycle can run against a local stand-in
// (tools/fake-telegram.ts) — which makes WHERE it may point a question about
// who gets to read the token.
describe("telegramApiRoot — where the bot token may be sent", () => {
  test("unset is Telegram's own", () => {
    assert.equal(telegramApiRoot(undefined), TELEGRAM_API_ROOT);
    assert.equal(telegramApiRoot("   "), TELEGRAM_API_ROOT);
  });

  test("https anywhere, and plain http only to this machine", () => {
    assert.equal(telegramApiRoot("https://bot-api.example.org/"), "https://bot-api.example.org");
    assert.equal(telegramApiRoot("http://127.0.0.1:4399"), "http://127.0.0.1:4399");
    assert.equal(telegramApiRoot("http://localhost:4399/"), "http://localhost:4399");
  });

  test("plain http to another host is refused — the token would cross the wire readable", () => {
    assert.throws(() => telegramApiRoot("http://192.168.0.45:8081"), /bot token/);
    assert.throws(() => telegramApiRoot("http://127.0.0.1.evil.example"), /bot token/);
  });

  test("not a URL is refused, not defaulted", () => {
    assert.throws(() => telegramApiRoot("api.telegram.org"), /not a URL/);
  });

  test("the client refuses a bad root at construction, before any request", () => {
    assert.throws(() => new HttpTelegramClient("123:abc", () => {}, "http://10.0.0.5"), /bot token/);
  });

  test("methods AND file downloads go to the configured root", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/getFile")) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/a.pdf", file_size: 3 } }));
      }
      return new Response("pdf", { headers: { "content-type": "application/pdf" } });
    }) as typeof fetch;
    try {
      const client = new HttpTelegramClient("123:abc", () => {}, "http://127.0.0.1:4399");
      const file = await client.fetchFile("F1", 1000);
      assert.equal(file?.bytes.toString(), "pdf");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(seen, [
      "http://127.0.0.1:4399/bot123:abc/getFile",
      "http://127.0.0.1:4399/file/bot123:abc/documents/a.pdf",
    ]);
  });
});
