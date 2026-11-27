/**
 * The Telegram adapter's `leaveChat` (#690, spec 690 D6): what Unlink of a Telegram group asks of the Bot API. A real HTTP stand-in for
 * the Bot API, with the real adapter in front of it, so what is asserted is what goes over the wire. No database is needed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { TelegramApiError, TelegramNotificationAdapter } from "../src/adapters/telegram.js";

const TOKEN = "123456:TEST-TOKEN-NOT-REAL";

describe("TelegramNotificationAdapter.leaveChat", () => {
  const seen: { url: string; body: unknown }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, result: true } };
  let server: Server;
  let root = "";
  const logs: string[] = [];
  before(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      seen.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    root = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  after(async () => { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); });
  const adapter = (apiRoot = root) => new TelegramNotificationAdapter({ botToken: TOKEN, superAdminChatId: "1", db: {} as pg.Pool, apiRoot, log: (line) => logs.push(line) });

  test("posts exactly one leaveChat for the chat, with the bot's own token, and nothing else", async () => {
    seen.length = 0; answer = { status: 200, body: { ok: true, result: true } };
    await adapter().leaveChat("-1002000777");
    assert.deepEqual(seen, [{ url: `/bot${TOKEN}/leaveChat`, body: { chat_id: "-1002000777" } }]);
  });

  test("a refusal (the bot is already gone) throws a TelegramApiError whose message carries neither the token nor the chat id", async () => {
    seen.length = 0; logs.length = 0;
    answer = { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } };
    await assert.rejects(adapter().leaveChat("-1002000778"), (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.httpStatus, 400);
      assert.ok(!error.message.includes(TOKEN) && !error.message.includes("1002000778"), error.message);
      return true;
    });
    assert.ok(!logs.join("\n").includes(TOKEN) && !logs.join("\n").includes("1002000778"), "the adapter's own log line names neither");
  });

  test("an unreachable Bot API throws a TelegramApiError with status 0 and no URL in it", async () => {
    await assert.rejects(adapter("http://127.0.0.1:9").leaveChat("-1002000779"), (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.httpStatus, 0);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  });
});
