/**
 * The connector's send guard for trip-moment turns (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B; AC-11).
 *
 * A real RelayConnector over a real socket, a fake Telegram, and a guard the test controls. What it pins: a companion send the guard
 * suppresses reaches no chat and is still answered as delivered (the gateway's per-request future resolves); a guard's buttons ride
 * the send; the guard is asked with the id the send replies to and with the latest turn the connector forwarded to the chat; and with
 * NO guard configured a send is exactly what it always was.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { RelayConnector } from "../src/relay/connector.js";
import { makeUpgradeToken, type WireMessageEvent } from "../src/relay/protocol.js";
import type { ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import type { InlineKeyboard } from "../src/chat-router.js";

const SECRET = "test-gateway-secret";
const PROFILE = "gw_1";

class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string; replyMarkup?: InlineKeyboard; replyTo?: string }[] = [];
  readonly edited: { chatId: string; messageId: string; replyMarkup?: InlineKeyboard }[] = [];
  async sendMessage(p: { chatId: string; text: string; replyMarkup?: InlineKeyboard; replyTo?: string }): Promise<SendResult> {
    this.sent.push(p);
    return { ok: true, messageId: "555" };
  }
  async editMessageText(p: { chatId: string; messageId: string; replyMarkup?: InlineKeyboard }): Promise<SendResult> { this.edited.push(p); return { ok: true }; }
  async sendChatAction(): Promise<void> {}
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(): Promise<ChatInfo | null> { return null; }
  async getUpdates(): Promise<unknown[]> { return []; }
  async deleteWebhookIfPresent(): Promise<void> {}
  async fetchFile() { return null; }
}

type Guard = NonNullable<ConstructorParameters<typeof RelayConnector>[0]["outboundGuard"]>;

async function dial(port: number): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { authorization: `Bearer ${makeUpgradeToken(PROFILE, SECRET, 300)}` } });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => { for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line)); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, frames };
}

async function waitFor<T>(get: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withConnector(guard: Guard | undefined, fn: (h: { connector: RelayConnector; telegram: FakeTelegram; send(content: string, replyTo?: string): Promise<Record<string, unknown>>; edit(messageId: string, content: string): Promise<Record<string, unknown>> }) => Promise<void>): Promise<void> {
  const telegram = new FakeTelegram();
  const connector = new RelayConnector({
    gatewaySecrets: [SECRET],
    telegram,
    port: 0,
    resolveRoute: async () => ({ kind: "companion", tripId: "trip-1", hermesProfile: PROFILE, assistantNames: [] }),
    ...(guard ? { outboundGuard: guard } : {}),
    log: () => {},
  });
  await connector.listen();
  try {
    await fn({
      connector,
      telegram,
      async send(content, replyTo) {
        const { ws, frames } = await dial(connector.address!);
        await waitFor(() => (connector.connectedGateways >= 1 ? true : undefined));
        ws.send(JSON.stringify({ type: "outbound", requestId: `r-${Math.random()}`, action: { op: "send", chat_id: "901", content, ...(replyTo ? { reply_to: replyTo } : {}) } }) + "\n");
        const result = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
        ws.close();
        return result.result as Record<string, unknown>;
      },
      async edit(messageId, content) {
        const { ws, frames } = await dial(connector.address!);
        await waitFor(() => (connector.connectedGateways >= 1 ? true : undefined));
        ws.send(JSON.stringify({ type: "outbound", requestId: `e-${Math.random()}`, action: { op: "edit", chat_id: "901", message_id: messageId, content } }) + "\n");
        const result = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
        ws.close();
        return result.result as Record<string, unknown>;
      },
    });
  } finally {
    await connector.close();
  }
}

const turnEvent = (id: string): WireMessageEvent => ({
  text: "x", message_type: "text", message_id: id,
  source: { platform: "telegram", chat_id: "901", chat_type: "group", chat_name: null, user_id: null, user_name: "Kinerary relay", thread_id: null, chat_topic: null, profile: PROFILE },
});

describe("the connector's outbound guard", () => {
  test("a suppressed send reaches no chat and is still answered as delivered", async () => {
    await withConnector(() => ({ kind: "suppress", reason: "MODE_PUBLISH_POSTS_NOTHING" }), async (h) => {
      const result = await h.send("Here is a draft moment");
      assert.equal(result.success, true);
      assert.deepEqual(h.telegram.sent, []);
    });
  });

  test("a guard's buttons go out with the message", async () => {
    const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: "Save", callback_data: "mom:s:0123456789abcdef" }]] };
    await withConnector(() => ({ kind: "deliver", replyMarkup: keyboard }), async (h) => {
      await h.send("Draft: the donkey and the croissant");
      assert.equal(h.telegram.sent.length, 1);
      assert.deepEqual(h.telegram.sent[0]!.replyMarkup, keyboard);
    });
  });

  test("the guard is told the id the send replies to and the latest turn forwarded to that chat", async () => {
    const asked: Array<[string, string | undefined, string | undefined]> = [];
    await withConnector((chat, replyTo, latest) => { asked.push([chat, replyTo, latest]); return { kind: "deliver" }; }, async (h) => {
      const { ws } = await dial(h.connector.address!);
      await waitFor(() => (h.connector.connectedGateways >= 1 ? true : undefined));
      assert.equal(h.connector.pushInbound(turnEvent("kmoment-1"), { explicit: false }), true);
      ws.close();
      await h.send("hello", "kmoment-1");
      await h.send("hello again");
      assert.deepEqual(asked, [["901", "kmoment-1", "kmoment-1"], ["901", undefined, "kmoment-1"]]);
      assert.equal(h.telegram.sent.length, 2);
      assert.equal(h.telegram.sent[0]!.replyMarkup, undefined, "no buttons unless the guard asks");
    });
  });

  test("the guard is handed the text and, once sent, the Telegram id of the message; the buttons survive the companion's edit of it", async () => {
    const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: "Save", callback_data: "mom:s:0123456789abcdef" }]] };
    const told: string[] = [];
    const contents: string[] = [];
    await withConnector((_chat, _replyTo, _latest, content) => { contents.push(content); return { kind: "deliver", replyMarkup: keyboard, sent: (id) => told.push(id) }; }, async (h) => {
      await h.send("Draft: the donkey");
      assert.deepEqual(contents, ["Draft: the donkey"]);
      assert.deepEqual(told, ["555"]);
      await h.edit("555", "Draft: the donkey and the croissant");
      assert.deepEqual(h.telegram.edited[0]?.replyMarkup, keyboard, "an edit does not take the Save button away");
      await h.edit("556", "some other message");
      assert.equal(h.telegram.edited[1]?.replyMarkup, undefined, "and another message gets none");
    });
  });

  test("the relay's own turn ids are never sent to Telegram as a reply target; a real message id still is", async () => {
    await withConnector(() => ({ kind: "deliver" }), async (h) => {
      await h.send("one", "kmoment-abc-1");
      await h.send("two", "ksave-xyz");
      await h.send("three", "4242");
      assert.deepEqual(h.telegram.sent.map((s) => s.replyTo), [undefined, undefined, "4242"]);
    });
  });

  test("with no guard a send is exactly what it always was", async () => {
    await withConnector(undefined, async (h) => {
      assert.equal((await h.send("plain answer")).success, true);
      assert.deepEqual(h.telegram.sent.map((s) => [s.chatId, s.text, s.replyMarkup]), [["901", "plain answer", undefined]]);
    });
  });
});
