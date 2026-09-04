import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { RelayConnector } from "../src/relay/connector.js";
import { makeUpgradeToken, type WireMessageEvent } from "../src/relay/protocol.js";
import type { ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";

const SECRET = "test-gateway-secret";

/** Records what the connector asked Telegram to do, without a token or a network. */
class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string; replyTo?: string }[] = [];
  readonly edited: { chatId: string; messageId: string; text: string }[] = [];
  readonly typing: string[] = [];
  failSend = false;

  async sendMessage(p: { chatId: string; text: string; replyTo?: string }): Promise<SendResult> {
    if (this.failSend) return { ok: false, error: "chat not found" };
    this.sent.push(p);
    return { ok: true, messageId: "555" };
  }
  async editMessageText(p: { chatId: string; messageId: string; text: string }): Promise<SendResult> {
    this.edited.push(p);
    return { ok: true };
  }
  async sendChatAction(p: { chatId: string }): Promise<void> {
    this.typing.push(p.chatId);
  }
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(chatId: string): Promise<ChatInfo | null> {
    return chatId === "missing" ? null : { name: "Japan Trip", type: "group" };
  }
  async getUpdates(): Promise<unknown[]> {
    return [];
  }
  async deleteWebhookIfPresent(): Promise<void> {}
}

interface Harness {
  connector: RelayConnector;
  telegram: FakeTelegram;
  port: number;
}

async function withConnector(fn: (h: Harness) => Promise<void>): Promise<void> {
  const telegram = new FakeTelegram();
  const connector = new RelayConnector({ gatewaySecrets: [SECRET], telegram, port: 0 });
  await connector.listen();
  const port = connector.address;
  assert.ok(port, "connector should have bound a port");
  try {
    await fn({ connector, telegram, port });
  } finally {
    await connector.close();
  }
}

/**
 * Sends a frame the way the REAL gateway does: `json.dumps(frame) + "\n"`
 * (gateway/relay/ws_transport.py:857). The newline is part of the protocol —
 * a harness that omits it is testing a wire format nothing speaks.
 */
function sendFrame(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame) + "\n");
}

/** Dials the connector the way the gateway does, and collects frames. */
async function dial(port: number, token: string | null): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\n")) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });
  return { ws, frames };
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("RelayConnector — upgrade auth", () => {
  test("a gateway with a valid token connects", async () => {
    await withConnector(async ({ port, connector }) => {
      const { ws } = await dial(port, makeUpgradeToken("gw_1", SECRET, 300));
      await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));
      ws.close();
    });
  });

  test("a bad token is refused at the upgrade", async () => {
    await withConnector(async ({ port }) => {
      await assert.rejects(dial(port, makeUpgradeToken("gw_1", "wrong-secret", 300)));
    });
  });

  test("no Authorization header is refused", async () => {
    await withConnector(async ({ port }) => {
      await assert.rejects(dial(port, null));
    });
  });

  test("an expired token is refused", async () => {
    await withConnector(async ({ port }) => {
      // Expiry is compared at WHOLE-SECOND resolution (`now > exp`), matching
      // the Python gateway's `int(time.time()) > exp` exactly — so a 1s token
      // is still live for up to two wall-clock seconds. Sleeping past that
      // boundary keeps this deterministic rather than racing it. The precise
      // boundary behaviour is pinned in relay-protocol.test.ts, which can
      // inject the clock.
      const expired = makeUpgradeToken("gw_1", SECRET, 1);
      await new Promise((r) => setTimeout(r, 2100));
      await assert.rejects(dial(port, expired));
    });
  });

  test("a secret mid-rotation still authenticates", async () => {
    const telegram = new FakeTelegram();
    const connector = new RelayConnector({
      gatewaySecrets: ["old-secret", SECRET],
      telegram,
      port: 0,
    });
    await connector.listen();
    try {
      const { ws } = await dial(connector.address!, makeUpgradeToken("gw_1", "old-secret", 300));
      await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));
      ws.close();
    } finally {
      await connector.close();
    }
  });
});

describe("RelayConnector — handshake", () => {
  test("hello is answered with the Telegram descriptor", async () => {
    await withConnector(async ({ port }) => {
      const { ws, frames } = await dial(port, makeUpgradeToken("gw_1", SECRET, 300));
      sendFrame(ws, { type: "hello", platform: "telegram", botId: "123" });
      const descriptor = await waitFor(() => frames.find((f) => f.type === "descriptor"));
      const d = descriptor.descriptor as Record<string, unknown>;
      assert.equal(d.platform, "telegram");
      assert.equal(d.len_unit, "utf16");
      assert.equal(d.contract_version, 1);
      ws.close();
    });
  });

  test("each hello gets its own descriptor", async () => {
    // The gateway may front several identities on one socket.
    await withConnector(async ({ port }) => {
      const { ws, frames } = await dial(port, makeUpgradeToken("gw_1", SECRET, 300));
      sendFrame(ws, { type: "hello", platform: "telegram", botId: "1" });
      sendFrame(ws, { type: "hello", platform: "telegram", botId: "2" });
      await waitFor(() => (frames.filter((f) => f.type === "descriptor").length === 2 ? true : undefined));
      ws.close();
    });
  });
});

describe("RelayConnector — outbound actions", () => {
  async function roundTrip(
    h: Harness,
    action: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { ws, frames } = await dial(h.port, makeUpgradeToken("gw_1", SECRET, 300));
    sendFrame(ws, { type: "outbound", requestId: "req_1", action });
    const result = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
    ws.close();
    return result.result as Record<string, unknown>;
  }

  test("send reaches Telegram and returns the message id", async () => {
    await withConnector(async (h) => {
      const result = await roundTrip(h, { op: "send", chat_id: "900", content: "hello" });
      assert.deepEqual(result, { success: true, message_id: "555" });
      // parseMode is part of the contract now: the descriptor advertises
      // markdown_v2, so agent-authored content must be sent as such. Omitting
      // it was why formatting arrived as literal asterisks.
      assert.deepEqual(h.telegram.sent, [
        { chatId: "900", text: "hello", replyTo: undefined, parseMode: "MarkdownV2" },
      ]);
    });
  });

  test("edit and typing are performed", async () => {
    await withConnector(async (h) => {
      const edit = await roundTrip(h, {
        op: "edit",
        chat_id: "900",
        message_id: "12",
        content: "revised",
      });
      assert.equal(edit.success, true);
      assert.deepEqual(h.telegram.edited, [
        { chatId: "900", messageId: "12", text: "revised", parseMode: "MarkdownV2" },
      ]);

      const typing = await roundTrip(h, { op: "typing", chat_id: "900" });
      assert.equal(typing.success, true);
      assert.deepEqual(h.telegram.typing, ["900"]);
    });
  });

  test("get_chat_info returns name and type", async () => {
    await withConnector(async (h) => {
      const result = await roundTrip(h, { op: "get_chat_info", chat_id: "900" });
      assert.deepEqual(result, { success: true, name: "Japan Trip", type: "group" });
    });
  });

  test("an unimplemented op still gets a result, so the gateway never hangs", async () => {
    // The gateway blocks on a per-request future for every outbound action.
    // A missing result is a stalled turn, not a dropped message.
    await withConnector(async (h) => {
      const result = await roundTrip(h, { op: "send_media", chat_id: "900", source_url: "http://x" });
      assert.deepEqual(result, { success: false, error: "UNSUPPORTED_OP" });
    });
  });

  test("a Telegram failure is reported as a failed result, not a dropped frame", async () => {
    await withConnector(async (h) => {
      h.telegram.failSend = true;
      const result = await roundTrip(h, { op: "send", chat_id: "900", content: "hello" });
      assert.equal(result.success, false);
      assert.equal(result.error, "chat not found");
    });
  });

  test("a malformed frame does not close the socket", async () => {
    // A closed socket would make the gateway redial into the same failure.
    await withConnector(async ({ port }) => {
      const { ws, frames } = await dial(port, makeUpgradeToken("gw_1", SECRET, 300));
      // A complete but non-JSON LINE — the realistic corruption. (Unterminated
      // garbage is a different case: under newline framing it legitimately
      // joins the next line, exactly as it would on any delimited stream.)
      ws.send("this is not json\n");
      sendFrame(ws, { type: "hello", platform: "telegram" });
      await waitFor(() => frames.find((f) => f.type === "descriptor"));
      assert.equal(ws.readyState, ws.OPEN);
      ws.close();
    });
  });

  test("frames that need no answer are accepted quietly", async () => {
    await withConnector(async ({ port }) => {
      const { ws, frames } = await dial(port, makeUpgradeToken("gw_1", SECRET, 300));
      sendFrame(ws, { type: "going_idle" });
      sendFrame(ws, { type: "interrupt", session_key: "agent:x" });
      sendFrame(ws, { type: "inbound_ack", bufferId: "b1" });
      sendFrame(ws, { type: "hello", platform: "telegram" });
      await waitFor(() => frames.find((f) => f.type === "descriptor"));
      assert.equal(ws.readyState, ws.OPEN);
      ws.close();
    });
  });
});

describe("RelayConnector — inbound push", () => {
  const event: WireMessageEvent = {
    text: "when do we land?",
    message_type: "text",
    source: {
      platform: "telegram",
      chat_id: "900",
      chat_type: "dm",
      chat_name: null,
      user_id: "777",
      user_name: "Dror",
      thread_id: null,
      chat_topic: null,
      profile: "companion-japan",
    },
  };

  test("an event reaches a connected gateway with its profile intact", async () => {
    await withConnector(async ({ port, connector }) => {
      const { ws, frames } = await dial(port, makeUpgradeToken("gw_1", SECRET, 300));
      await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));

      assert.equal(connector.pushInbound(event), true);
      const inbound = await waitFor(() => frames.find((f) => f.type === "inbound"));
      const delivered = inbound.event as WireMessageEvent;
      assert.equal(delivered.source.profile, "companion-japan");
      assert.equal(delivered.text, "when do we land?");
      ws.close();
    });
  });

  test("with no gateway connected the push reports failure rather than pretending", async () => {
    // Nothing here queues, so a silent true would strand the organizer waiting
    // on an answer that is never coming.
    await withConnector(async ({ connector }) => {
      assert.equal(connector.pushInbound(event), false);
    });
  });
});
