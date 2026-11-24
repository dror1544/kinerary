import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import type { ScopeRoute } from "../src/relay/outbound-scope.js";

/** Every route the scope check can be handed: a chat router route, or the interviewer's own chat after confirmation. */
type ChatRoute = ScopeRoute;
import { RelayConnector } from "../src/relay/connector.js";
import { SILENCE_SENTINEL } from "../src/relay/stay-silent.js";
import type { ReplyObserver } from "../src/analytics/emitter.js";
import { gatewayFromAuthorization } from "../src/companion-mcp.js";
import { deriveGatewayKey, makeUpgradeToken, type GatewayKeyMode, type WireMessageEvent } from "../src/relay/protocol.js";
import { digestTelegramId } from "../src/identity.js";
import { CHAT_NOT_IN_SCOPE, SCOPE_CHECK_FAILED } from "../src/relay/outbound-scope.js";
import type { ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { hermesIsRetryable, hermesIsTimeout } from "./support/hermes-mirror.js";

const SECRET = "test-gateway-secret";

/** Records what the connector asked Telegram to do, without a token or a network. */
class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string; replyTo?: string }[] = [];
  readonly edited: { chatId: string; messageId: string; text: string }[] = [];
  readonly typing: string[] = [];
  readonly infoCalls: string[] = [];
  failSend = false;
  /** The fixed word HttpTelegramClient returns for a call that failed this way (e.g. "TIMEOUT", "NETWORK"). */
  sendError: string | null = null;
  editError: string | null = null;

  async sendMessage(p: { chatId: string; text: string; replyTo?: string }): Promise<SendResult> {
    if (this.failSend) return { ok: false, error: "chat not found" };
    if (this.sendError) return { ok: false, error: this.sendError };
    this.sent.push(p);
    return { ok: true, messageId: "555" };
  }
  async editMessageText(p: { chatId: string; messageId: string; text: string }): Promise<SendResult> {
    if (this.editError) return { ok: false, error: this.editError };
    this.edited.push(p);
    return { ok: true };
  }
  async sendChatAction(p: { chatId: string }): Promise<void> {
    this.typing.push(p.chatId);
  }
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(chatId: string): Promise<ChatInfo | null> {
    this.infoCalls.push(chatId);
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

/**
 * What `resolveChatRoute` would answer, per chat: an interview chat, an explicit
 * route, or - the default - a companion chat bound to the gateway these tests dial
 * as (`gw_1`), so every outbound test is an action in the caller's own chat.
 */
function defaultRouteResolver(options: {
  interviewChats?: readonly string[];
  routes?: Record<string, ChatRoute>;
  defaultProfile?: string | null;
}): (chatId: string) => Promise<ChatRoute> {
  return async (chatId) => {
    const explicit = options.routes?.[chatId];
    if (explicit) return explicit;
    if (options.interviewChats?.includes(chatId)) return { kind: "interview", sessionId: "s1", tripId: "trip-1" };
    return {
      kind: "companion",
      tripId: "trip-1",
      hermesProfile: options.defaultProfile === undefined ? "gw_1" : options.defaultProfile,
      assistantNames: [],
    };
  };
}

async function withConnector(
  fn: (h: Harness) => Promise<void>,
  options: {
    /** Chats whose route is `interview` (everything else is the caller's own companion chat unless `routes` says so). */
    interviewChats?: readonly string[];
    /** Explicit route per chat id; wins over the default. */
    routes?: Record<string, ChatRoute>;
    /** The Hermes profile the default (unlisted) chats are bound to. `gw_1` unless a test dials as another gateway. */
    defaultProfile?: string | null;
    /** Replaces the route lookup entirely (to make it throw, count calls, or flip a binding mid-test). */
    resolveRoute?: (chatId: string) => Promise<ChatRoute>;
    /** Builds the connector with no route resolver at all. */
    noResolver?: boolean;
    interviewerProfile?: string;
    scopeLookupTimeoutMs?: number;
    /** Whether a profile has an open chat binding (the unmatched-identity warning's only database question). */
    profileHasOpenBinding?: (profile: string) => Promise<boolean>;
    interviewSay?: (chatId: string, text: string) => Promise<boolean>;
    fallbackGatewayId?: string;
    setExpectsReply?: (chatId: string, expects: boolean) => Promise<void>;
    renewConversation?: (chatId: string) => Promise<void>;
    log?: (line: string) => void;
    assistantEvents?: ReplyObserver;
  } = {},
): Promise<void> {
  const telegram = new FakeTelegram();
  const connector = new RelayConnector({
    gatewaySecrets: [SECRET],
    telegram,
    port: 0,
    ...(options.noResolver ? {} : { resolveRoute: options.resolveRoute ?? defaultRouteResolver(options) }),
    ...(options.interviewerProfile ? { interviewerProfile: options.interviewerProfile } : {}),
    ...(options.scopeLookupTimeoutMs ? { scopeLookupTimeoutMs: options.scopeLookupTimeoutMs } : {}),
    ...(options.profileHasOpenBinding ? { profileHasOpenBinding: options.profileHasOpenBinding } : {}),
    ...(options.interviewSay ? { interviewSay: options.interviewSay } : {}),
    ...(options.fallbackGatewayId ? { fallbackGatewayId: options.fallbackGatewayId } : {}),
    ...(options.setExpectsReply ? { setExpectsReply: options.setExpectsReply } : {}),
    ...(options.renewConversation ? { renewConversation: options.renewConversation } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.assistantEvents ? { assistantEvents: options.assistantEvents } : {}),
  });
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

describe("RelayConnector — gateway key mode (#597 K1, AC-K1.2/K1.3/K1.7)", () => {
  const MEDIA_ID = "0123456789abcdef0123456789abcdef";
  /** The derivation master: a secret no gateway profile has held. SECRET is what every profile holds. */
  const MASTER = "derivation-master-no-profile-holds";
  const tokens = {
    shared: makeUpgradeToken("gw_1", SECRET, 300),
    derived: makeUpgradeToken("gw_1", deriveGatewayKey(MASTER, "gw_1"), 300),
    // Derived from what the profiles hold: never a credential, in any mode.
    derivedFromShared: makeUpgradeToken("gw_1", deriveGatewayKey(SECRET, "gw_1"), 300),
    // Signed with the key that belongs to gw_2, naming gw_1.
    crossed: makeUpgradeToken("gw_1", deriveGatewayKey(MASTER, "gw_2"), 300),
  };
  /** What each mode must do with each token, on the upgrade AND the media plane. */
  const expected: Record<GatewayKeyMode, Record<keyof typeof tokens, boolean>> = {
    shared: { shared: true, derived: false, derivedFromShared: false, crossed: false },
    both: { shared: true, derived: true, derivedFromShared: false, crossed: false },
    derived: { shared: false, derived: true, derivedFromShared: false, crossed: false },
  };

  async function withMode(mode: GatewayKeyMode | undefined, fn: (c: RelayConnector, port: number) => Promise<void>) {
    const connector = new RelayConnector({
      gatewaySecrets: [SECRET],
      ...(mode ? { gatewayKeyMode: mode, gatewayKeyMasters: [MASTER] } : {}),
      mediaStore: { get: (id) => (id === MEDIA_ID ? { mime: "text/plain", bytes: Buffer.from("hello") } : null) },
      telegram: new FakeTelegram(),
      port: 0,
    });
    await connector.listen();
    try {
      await fn(connector, connector.address!);
    } finally {
      await connector.close();
    }
  }

  for (const mode of ["shared", "both", "derived"] as GatewayKeyMode[]) {
    test(`${mode}: the upgrade and the media plane agree, and agree with the companion control MCP`, async () => {
      await withMode(mode, async (connector, port) => {
        for (const [name, token] of Object.entries(tokens) as [keyof typeof tokens, string][]) {
          const want = expected[mode][name];
          // WebSocket upgrade.
          if (want) {
            const { ws } = await dial(port, token);
            ws.close();
          } else {
            await assert.rejects(dial(port, token), `${mode}/${name}: upgrade must be refused`);
          }
          // Media plane.
          const res = await fetch(`http://127.0.0.1:${port}/relay/media/${MEDIA_ID}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          assert.equal(res.status, want ? 200 : 401, `${mode}/${name}: media`);
          await res.arrayBuffer();
          // The other checker, one setting.
          assert.equal(
            gatewayFromAuthorization(`Bearer ${token}`, [SECRET], mode, [MASTER]),
            want ? "gw_1" : null,
            `${mode}/${name}: companion-mcp`,
          );
        }
        void connector;
      });
    });
  }

  test("derived, after the changeover: a key derived from the old shared secret is refused for every gateway id, on every surface", async () => {
    await withMode("derived", async (_c, port) => {
      for (const id of ["gw_1", "gw_2", "japan2026", "interviewer"]) {
        const token = makeUpgradeToken(id, deriveGatewayKey(SECRET, id), 300);
        await assert.rejects(dial(port, token), `${id}: upgrade must be refused`);
        const res = await fetch(`http://127.0.0.1:${port}/relay/media/${MEDIA_ID}`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 401, `${id}: media`);
        await res.arrayBuffer();
        assert.equal(gatewayFromAuthorization(`Bearer ${token}`, [SECRET], "derived", [MASTER]), null, `${id}: companion-mcp`);
        // ...while the key derived from the new master, for its own id, is accepted.
        const good = makeUpgradeToken(id, deriveGatewayKey(MASTER, id), 300);
        const { ws } = await dial(port, good);
        ws.close();
        assert.equal(gatewayFromAuthorization(`Bearer ${good}`, [SECRET], "derived", [MASTER]), id);
      }
    });
  });

  test("a connector in both/derived is not built without a derivation master, or with one equal to a shared secret", () => {
    for (const mode of ["both", "derived"] as GatewayKeyMode[]) {
      assert.throws(
        () => new RelayConnector({ gatewaySecrets: [SECRET], gatewayKeyMode: mode, telegram: new FakeTelegram(), port: 0 }),
        /gateway_key_master_refs/,
        `${mode}: no master`,
      );
      assert.throws(
        () => new RelayConnector({ gatewaySecrets: [SECRET], gatewayKeyMasters: [SECRET], gatewayKeyMode: mode, telegram: new FakeTelegram(), port: 0 }),
        (error: Error) => /gateway_key_master_refs.*gateway_secret_refs/.test(error.message) && !error.message.includes(SECRET),
        `${mode}: equal master`,
      );
    }
  });

  test("no mode given behaves as shared", async () => {
    await withMode(undefined, async (_c, port) => {
      const { ws } = await dial(port, tokens.shared);
      ws.close();
      await assert.rejects(dial(port, tokens.derived));
    });
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

  test("prose is handed over unescaped — one converter, and it is telegram-api's", async () => {
    // 2026-09-12: this layer escaped too, so `sendMessage` escaped an escaped
    // string and Telegram rejected the entities. What reached the organizer was
    // the first escaping, delivered as plain text: "…שלי\." and a link written
    // "japan\-2026\.ara\-united\.store". The dialect is honoured one layer
    // down, once, so what crosses this boundary is what the agent wrote.
    await withConnector(async (h) => {
      const content = "אני בודקת את זה עכשיו. הקישור: https://japan-2026.ara-united.store";
      await roundTrip(h, { op: "send", chat_id: "900", content });
      assert.deepEqual(h.telegram.sent, [
        { chatId: "900", text: content, replyTo: undefined, parseMode: "MarkdownV2" },
      ]);
      assert.ok(!h.telegram.sent[0].text.includes("\\"), "no escaping happens here");
    });
  });

  test("on an interview chat the agent cannot send at all", async () => {
    // TRACK 4 · one voice, one writer.
    //
    // The agent reaches an organizer mid-interview through `say_for_chat` and
    // `ask_question_for_chat` only, so the router keeps the keyboard, the
    // record and the order of things. This is the same rule that lived in
    // SOUL.md through runs 2 to 6 and failed every one of them — as
    // chain-of-thought narration, third-person commentary about "the router",
    // the run's own bug reports read back to the organizer, option questions
    // degraded to numbered lists, and a prose approval request no tool could
    // act on. Here it cannot be talked around.
    await withConnector(async (h) => {
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "900",
        content: "The next question is destination — let me record that now.",
      });
      // Reported as delivered: the gateway blocks on a per-request future and
      // there is nothing here it could usefully retry.
      assert.deepEqual(result, { success: true });
      assert.deepEqual(h.telegram.sent, [], "nothing reached the organizer");
    }, { interviewChats: ["900"], interviewerProfile: "gw_1" });
  });

  test("an interview send is routed through say, not lost", async () => {
    // Run 7: 17 refused sends against 3 say_for_chat calls. Dropping was the
    // wrong half of the rule — the organizer silently got less conversation,
    // and a turn that produced nothing looked STALLED, so the watchdog fired
    // every turn and re-asked the same question. Converting keeps the
    // invariant (the router still delivers, still owns the keyboard and the
    // order) without losing a word.
    const routed: Array<{ chatId: string; text: string }> = [];
    await withConnector(async (h) => {
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "900",
        content: "רשמתי — נשאר רק תאריך החזרה.",
      });
      assert.deepEqual(result, { success: true });
      assert.deepEqual(h.telegram.sent, [], "not sent directly — the router delivers it");
      assert.deepEqual(routed, [{ chatId: "900", text: "רשמתי — נשאר רק תאריך החזרה." }]);
    }, {
      interviewChats: ["900"], interviewerProfile: "gw_1",
      interviewSay: async (chatId: string, text: string) => {
        routed.push({ chatId, text });
        return true;
      },
    });
  });

  test("a leaking message is dropped even on the converting path", async () => {
    // Conversion must not become a way for internal vocabulary to reach an
    // organizer. A message naming field ids is one they must not read,
    // whichever door it arrives through.
    const routed: string[] = [];
    await withConnector(async (h) => {
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "900",
        content: "`bot_gender` עדיין ב-optionalRemaining — ואת השאר ישאל הראוטר.",
      });
      assert.deepEqual(result, { success: true });
      assert.deepEqual(h.telegram.sent, [], "nothing reached the organizer");
      assert.deepEqual(routed, [], "and it was not laundered through say either");
    }, {
      interviewChats: ["900"], interviewerProfile: "gw_1",
      interviewSay: async (_chatId: string, text: string) => {
        routed.push(text);
        return true;
      },
    });
  });

  test("a companion chat is untouched by the interview rule", async () => {
    // The restriction is about the interview, where a deterministic router owns
    // the conversation. A trip companion has no router drawing its questions,
    // so silencing it there would silence the product.
    await withConnector(async (h) => {
      const result = await roundTrip(h, { op: "send", chat_id: "901", content: "hello" });
      assert.equal(result.success, true);
      assert.equal(h.telegram.sent.length, 1, "the companion still speaks");
    }, { interviewChats: ["900"], interviewerProfile: "gw_1" });
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

  // Hermes' own reading of the error string the relay answers with
  // (`hermesIsTimeout`, `hermesIsRetryable`) is no longer a hand copy here: it
  // is evaluated over the substrings captured from Hermes' source
  // (`BasePlatformAdapter._is_timeout_error`, `_RETRYABLE_ERROR_PATTERNS`) into
  // test/fixtures/hermes-mirror.json, at the revision hermes-patches/BASE_REV
  // pins (#380; test/hermes-mirror.test.ts AC-1/AC-5 hold the two together).
  //
  // What each verdict does to a companion's reply (`_send_with_retry`): a
  // TIMEOUT is returned as-is - no retry, no re-send, "the message may have been
  // delivered"; RETRYABLE is retried with backoff; ANYTHING ELSE falls to the
  // plain-text fallback, which re-sends the reply prefixed "(Response formatting
  // failed, plain text:)".

  for (const op of ["send", "edit"] as const) {
    test(`round 2 (R5): a companion ${op} that TIMED OUT is answered with a timeout Hermes recognises - not re-sent as plain text, not retried`, async () => {
      await withConnector(async (h) => {
        if (op === "send") h.telegram.sendError = "TIMEOUT";
        else h.telegram.editError = "TIMEOUT";
        const result = await roundTrip(h, op === "send"
          ? { op: "send", chat_id: "900", content: "hello" }
          : { op: "edit", chat_id: "900", message_id: "7", content: "hello" });
        assert.equal(result.success, false);
        const error = String(result.error);
        assert.notEqual(error, "TIMEOUT", "not the client's bare word");
        assert.equal(hermesIsTimeout(error), true, `Hermes reads "${error}" as a timeout: returned as-is, never re-sent`);
        assert.equal(hermesIsRetryable(error), false, `and not as retryable: "${error}"`);
        assert.ok(!/bot|api\.telegram|https?:/i.test(error), `a fixed phrase, no URL or token: "${error}"`);
      });
    });
  }

  test("round 2 (R5): why the phrase - the bare word would have made Hermes re-send the reply (a duplicate if the slow send landed); NETWORK is retried, as before this PR", () => {
    assert.equal(hermesIsTimeout("TIMEOUT"), false);
    assert.equal(hermesIsRetryable("TIMEOUT"), false, "neither: the plain-text fallback, i.e. the reply sent again");
    assert.equal(hermesIsTimeout("NETWORK"), false);
    assert.equal(hermesIsRetryable("NETWORK"), true, "NETWORK is retried with backoff - unchanged by this PR");
  });

  test("round 2 (R5): the client's other fixed word reaches the gateway unchanged", async () => {
    await withConnector(async (h) => {
      h.telegram.sendError = "NETWORK";
      const result = await roundTrip(h, { op: "send", chat_id: "900", content: "hello" });
      assert.deepEqual(result, { success: false, error: "NETWORK" });
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

describe("RelayConnector — reply-expected capture (migration 0053)", () => {
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

  test("a companion send with metadata.expects_reply opens the window", async () => {
    const calls: Array<{ chatId: string; expects: boolean }> = [];
    await withConnector(async (h) => {
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "901",
        content: "what date works for everyone?",
        metadata: { expects_reply: true },
      });
      assert.equal(result.success, true);
      assert.deepEqual(calls, [{ chatId: "901", expects: true }]);
    }, {
      setExpectsReply: async (chatId, expects) => {
        calls.push({ chatId, expects });
      },
    });
  });

  test("a companion send with no expects_reply signal clears any open window", async () => {
    const calls: Array<{ chatId: string; expects: boolean }> = [];
    await withConnector(async (h) => {
      const result = await roundTrip(h, { op: "send", chat_id: "901", content: "sounds good!" });
      assert.equal(result.success, true);
      assert.deepEqual(calls, [{ chatId: "901", expects: false }]);
    }, {
      setExpectsReply: async (chatId, expects) => {
        calls.push({ chatId, expects });
      },
    });
  });

  test("an interview chat never touches the reply-capture window", async () => {
    // That branch returns to the gateway before reaching Telegram at all, so
    // this option must never see an interview chat's send.
    const calls: Array<{ chatId: string; expects: boolean }> = [];
    await withConnector(async (h) => {
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "900",
        content: "The next question is destination.",
        metadata: { expects_reply: true },
      });
      assert.deepEqual(result, { success: true });
      assert.deepEqual(calls, [], "the interview branch never calls setExpectsReply");
    }, {
      interviewChats: ["900"], interviewerProfile: "gw_1",
      setExpectsReply: async (chatId, expects) => {
        calls.push({ chatId, expects });
      },
    });
  });

  test("a failed send does not open or clear the window", async () => {
    const calls: Array<{ chatId: string; expects: boolean }> = [];
    await withConnector(async (h) => {
      h.telegram.failSend = true;
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "901",
        content: "what date works?",
        metadata: { expects_reply: true },
      });
      assert.equal(result.success, false);
      assert.deepEqual(calls, [], "nothing reached Telegram, so nothing here should change");
    }, {
      setExpectsReply: async (chatId, expects) => {
        calls.push({ chatId, expects });
      },
    });
  });

  test("a delivered send renews the conversation window, question or not", async () => {
    const renewed: string[] = [];
    const expects: boolean[] = [];
    await withConnector(async (h) => {
      await roundTrip(h, { op: "send", chat_id: "901", content: "sounds good." });
      await roundTrip(h, { op: "send", chat_id: "901", content: "what date works?", metadata: { expects_reply: true } });
      assert.deepEqual(renewed, ["901", "901"], "renewal is independent of the '?' window: a statement renews too");
      assert.deepEqual(expects, [false, true], "and the '?' window keeps clearing/opening on its own");
    }, {
      renewConversation: async (chatId) => { renewed.push(chatId); },
      setExpectsReply: async (_chatId, e) => { expects.push(e); },
    });
  });

  test("the silence sentinel is dropped: nothing sent, success returned, no renewal, '?' window untouched", async () => {
    const renewed: string[] = [];
    const expects: boolean[] = [];
    const lines: string[] = [];
    await withConnector(async (h) => {
      for (const content of [SILENCE_SENTINEL, `  ${SILENCE_SENTINEL}\n`]) {
        const result = await roundTrip(h, { op: "send", chat_id: "901", content });
        assert.equal(result.success, true, "the gateway's request resolves");
      }
      assert.deepEqual(h.telegram.sent, [], "nothing reached Telegram");
      assert.deepEqual(renewed, [], "silence does not renew the conversation");
      assert.deepEqual(expects, [], "and neither opens nor clears the '?' window");
      assert.equal(lines.filter((l) => l.includes("trip_bot.companion_stayed_silent")).length, 2);
      assert.ok(lines.every((l) => !l.includes("901")), "no chat id in the log");
    }, {
      renewConversation: async (chatId) => { renewed.push(chatId); },
      setExpectsReply: async (_c, e) => { expects.push(e); },
      log: (l) => lines.push(l),
    });
  });

  test("text that merely contains the sentinel is delivered WITHOUT the token, never with it", async () => {
    await withConnector(async (h) => {
      await roundTrip(h, { op: "send", chat_id: "901", content: `Saturday is free. ${SILENCE_SENTINEL}` });
      assert.equal(h.telegram.sent.length, 1);
      assert.equal(h.telegram.sent[0]!.text, "Saturday is free.", "the answer survives, the control token does not");
      await roundTrip(h, { op: "send", chat_id: "901", content: "about [[KINERARY]] nothing" });
      assert.equal(h.telegram.sent[1]!.text, "about [[KINERARY]] nothing", "other bracketed text is untouched");
    }, {});
  });

  test("a sentinel never reaches the chat through an edit, or half-streamed", async () => {
    await withConnector(async (h) => {
      const edit = await roundTrip(h, { op: "edit", chat_id: "901", message_id: "7", content: SILENCE_SENTINEL });
      assert.equal(edit.success, true);
      assert.deepEqual(h.telegram.edited, []);
      const mixed = await roundTrip(h, { op: "edit", chat_id: "901", message_id: "7", content: `Done. ${SILENCE_SENTINEL}` });
      assert.equal(mixed.success, true);
      assert.equal(h.telegram.edited[0]!.text, "Done.");
      // A streaming adapter's first chunk can be the opening of the sentinel.
      for (const partial of ["[[", "[[KINERARY_STAY", SILENCE_SENTINEL.slice(0, -1)]) {
        await roundTrip(h, { op: "send", chat_id: "901", content: partial });
      }
      assert.deepEqual(h.telegram.sent, [], "no fragment of the token is ever sent");
      await roundTrip(h, { op: "send", chat_id: "901", content: "[" });
      assert.equal(h.telegram.sent.length, 1, "but an ordinary one-character message is");
    }, {});
  });

  test("a failed send does not renew the conversation window", async () => {
    const renewed: string[] = [];
    await withConnector(async (h) => {
      h.telegram.failSend = true;
      const result = await roundTrip(h, { op: "send", chat_id: "901", content: "hello" });
      assert.equal(result.success, false);
      assert.deepEqual(renewed, []);
    }, { renewConversation: async (chatId) => { renewed.push(chatId); } });
  });

  test("an interview chat never renews the conversation window", async () => {
    const renewed: string[] = [];
    await withConnector(async (h) => {
      await roundTrip(h, { op: "send", chat_id: "900", content: "The next question is destination." });
      assert.deepEqual(renewed, []);
    }, { interviewChats: ["900"], interviewerProfile: "gw_1", renewConversation: async (chatId) => { renewed.push(chatId); } });
  });

  test("a renewal write failure does not turn a delivered message into a failure, and is logged", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      const result = await roundTrip(h, { op: "send", chat_id: "901", content: "hello" });
      assert.deepEqual(result, { success: true, message_id: "555" });
      assert.ok(lines.some((l) => l.includes("relay.conversation_renew_failed")));
    }, {
      renewConversation: async () => { throw new Error("db unavailable"); },
      log: (l) => lines.push(l),
    });
  });

  test("opening the '?' window is logged (a boolean, no ids); a non-question send logs nothing of the kind", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      await roundTrip(h, { op: "send", chat_id: "901", content: "statement." });
      assert.ok(!lines.some((l) => l.includes("relay.reply_window_opened")));
      await roundTrip(h, { op: "send", chat_id: "901", content: "what date?", metadata: { expects_reply: true } });
      const opened = lines.filter((l) => l.includes("relay.reply_window_opened"));
      assert.equal(opened.length, 1);
      assert.ok(!opened[0]!.includes("901"), "no chat id in the line");
    }, { setExpectsReply: async () => {}, log: (l) => lines.push(l) });
  });

  test("a write failure here does not turn a delivered message into a failure", async () => {
    await withConnector(async (h) => {
      const result = await roundTrip(h, {
        op: "send",
        chat_id: "901",
        content: "what date works?",
        metadata: { expects_reply: true },
      });
      assert.deepEqual(result, { success: true, message_id: "555" });
    }, {
      setExpectsReply: async () => {
        throw new Error("db unavailable");
      },
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
    // The gateway dials as the profile it serves: under one process per trip
    // the authenticated id IS the destination, so `gw_1` — an id that serves
    // no trip — would now be addressed by nothing. See the routing suite below.
    await withConnector(async ({ port, connector }) => {
      const { ws, frames } = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
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
    // Unchanged by per-trip routing: no socket at all is still the case where
    // a silent `true` would be the damaging answer.
    // Nothing here queues, so a silent true would strand the organizer waiting
    // on an answer that is never coming.
    await withConnector(async ({ connector }) => {
      assert.equal(connector.pushInbound(event), false);
    });
  });
});

describe("RelayConnector — per-trip gateway routing", () => {
  /** One event, addressed at the trip whose companion should answer it. */
  function eventFor(profile: string, chatId = "900"): WireMessageEvent {
    return {
      text: "when do we land?",
      message_type: "text",
      source: {
        platform: "telegram",
        chat_id: chatId,
        chat_type: "dm",
        chat_name: null,
        user_id: "777",
        user_name: "Dror",
        thread_id: null,
        chat_topic: null,
        profile,
      },
    };
  }

  const inboundEvents = (frames: Record<string, unknown>[]): WireMessageEvent[] =>
    frames.filter((f) => f.type === "inbound").map((f) => f.event as WireMessageEvent);

  test("an event reaches only the gateway serving its trip", async () => {
    // The property the whole per-trip architecture rests on. With one process
    // per trip, delivering to the wrong socket is not a routing inefficiency —
    // it is one family's companion answering with another family's data.
    await withConnector(async ({ port, connector }) => {
      const japan = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
      const usa = await dial(port, makeUpgradeToken("companion-usa", SECRET, 300));
      await waitFor(() => (connector.connectedGateways === 2 ? true : undefined));

      assert.equal(connector.pushInbound(eventFor("companion-japan")), true);

      const delivered = await waitFor(() => inboundEvents(japan.frames)[0]);
      assert.equal(delivered.source.profile, "companion-japan");
      assert.deepEqual(inboundEvents(usa.frames), []);

      japan.ws.close();
      usa.ws.close();
    });
  });

  test("an event for a trip with no gateway reaches nobody, and says so", async () => {
    // Not delivered anywhere is the only safe answer: nothing here queues, so
    // a `true` would strand the organizer, and a fan-out would leak the turn.
    await withConnector(async ({ port, connector }) => {
      const japan = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
      const usa = await dial(port, makeUpgradeToken("companion-usa", SECRET, 300));
      await waitFor(() => (connector.connectedGateways === 2 ? true : undefined));

      assert.equal(connector.pushInbound(eventFor("companion-greece")), false);
      assert.deepEqual(inboundEvents(japan.frames), []);
      assert.deepEqual(inboundEvents(usa.frames), []);

      japan.ws.close();
      usa.ws.close();
    });
  });

  test("the declared fallback gateway takes turns no per-trip gateway serves", async () => {
    // The multiplexing gateway, named explicitly rather than inferred from a
    // socket count. This is what keeps the interview path working while trips
    // move to their own processes one at a time.
    await withConnector(
      async ({ port, connector }) => {
        const shared = await dial(port, makeUpgradeToken("kinerary-trip-intake", SECRET, 300));
        await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));

        assert.equal(connector.pushInbound(eventFor("trip-intake")), true);
        const delivered = await waitFor(() => inboundEvents(shared.frames)[0]);
        assert.equal(delivered.source.profile, "trip-intake");

        shared.ws.close();
      },
      { fallbackGatewayId: "kinerary-trip-intake" },
    );
  });

  test("a trip's own gateway wins over the fallback", async () => {
    // The cutover moment: the first per-trip gateway connects alongside the
    // multiplexing one, and must take its trip's traffic away from it.
    await withConnector(
      async ({ port, connector }) => {
        const shared = await dial(port, makeUpgradeToken("kinerary-trip-intake", SECRET, 300));
        const japan = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
        await waitFor(() => (connector.connectedGateways === 2 ? true : undefined));

        assert.equal(connector.pushInbound(eventFor("companion-japan")), true);
        await waitFor(() => inboundEvents(japan.frames)[0]);
        assert.deepEqual(inboundEvents(shared.frames), []);

        // ...and the fallback still gets what nobody else serves.
        assert.equal(connector.pushInbound(eventFor("trip-intake")), true);
        await waitFor(() => inboundEvents(shared.frames)[0]);
        assert.equal(inboundEvents(japan.frames).length, 1);

        shared.ws.close();
        japan.ws.close();
      },
      { fallbackGatewayId: "kinerary-trip-intake" },
    );
  });

  test("an event with no profile stamp is undeliverable without a fallback", async () => {
    // `normalize.ts` always stamps one. A frame that reached here without one
    // has lost its trip context, and guessing a destination for it is the
    // failure mode the stamp exists to prevent.
    await withConnector(async ({ port, connector }) => {
      const { ws } = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
      await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));

      const orphan = eventFor("companion-japan");
      delete (orphan.source as { profile?: string }).profile;
      assert.equal(connector.pushInbound(orphan), false);

      ws.close();
    });
  });

  test("a disconnect stops the trip being reachable, and a reconnect restores it", async () => {
    // Reachability has to track the socket, not a row: `gateway stop` must
    // make the trip honestly unreachable rather than silently undelivered.
    await withConnector(async ({ port, connector }) => {
      const first = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
      await waitFor(() => (connector.canReachProfile("companion-japan") ? true : undefined));

      first.ws.close();
      await waitFor(() => (connector.canReachProfile("companion-japan") ? undefined : true));
      assert.equal(connector.pushInbound(eventFor("companion-japan")), false);

      const second = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
      await waitFor(() => (connector.canReachProfile("companion-japan") ? true : undefined));
      assert.equal(connector.pushInbound(eventFor("companion-japan")), true);

      second.ws.close();
    });
  });
});

describe("RelayConnector — canReachProfile", () => {
  test("reports the trip whose gateway is connected, and only that one", async () => {
    await withConnector(async ({ port, connector }) => {
      assert.equal(connector.canReachProfile("companion-japan"), false);

      const { ws } = await dial(port, makeUpgradeToken("companion-japan", SECRET, 300));
      await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));

      assert.equal(connector.canReachProfile("companion-japan"), true);
      assert.equal(connector.canReachProfile("companion-usa"), false);

      ws.close();
    });
  });

  test("a connected fallback makes every trip reachable", async () => {
    // True, and deliberately so: while one gateway multiplexes every profile,
    // every profile really is reachable through it. This answer becomes strict
    // on its own when the fallback is withdrawn.
    await withConnector(
      async ({ port, connector }) => {
        const { ws } = await dial(port, makeUpgradeToken("kinerary-trip-intake", SECRET, 300));
        await waitFor(() => (connector.connectedGateways === 1 ? true : undefined));

        assert.equal(connector.canReachProfile("companion-japan"), true);
        assert.equal(connector.canReachProfile("anything-at-all"), true);

        ws.close();
      },
      { fallbackGatewayId: "kinerary-trip-intake" },
    );
  });
});

describe("RelayConnector - silence on a turn that named the assistant (staging run 2026-10-17, A3)", () => {
  const profile = "companion-colmar";
  const turn = (messageId: string): WireMessageEvent => ({
    text: "x",
    message_type: "text",
    message_id: messageId,
    source: {
      platform: "telegram", chat_id: "901", chat_type: "group", chat_name: null,
      user_id: "777", user_name: "Dror", thread_id: null, chat_topic: null, profile,
    },
  });

  /** Dials the trip's gateway, pushes the given turns, then has the companion reply `content` (optionally naming a turn). */
  async function replyAfter(
    h: Harness,
    turns: Array<{ id: string; explicit: boolean }>,
    content: string,
    replyTo?: string,
  ): Promise<Record<string, unknown>> {
    const { ws, frames } = await dial(h.port, makeUpgradeToken(profile, SECRET, 300));
    await waitFor(() => (h.connector.connectedGateways >= 1 ? true : undefined));
    for (const t of turns) assert.equal(h.connector.pushInbound(turn(t.id), { explicit: t.explicit }), true);
    sendFrame(ws, { type: "outbound", requestId: "r1", action: { op: "send", chat_id: "901", content, ...(replyTo ? { reply_to: replyTo } : {}) } });
    const result = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
    ws.close();
    return result.result as Record<string, unknown>;
  }

  function recorder() {
    const calls: Array<{ delivery: string; flags: unknown }> = [];
    const observer: ReplyObserver = {
      replySent: (_chat, delivery, _length, _replyTo, flags) => { calls.push({ delivery, flags }); },
    };
    return { calls, observer };
  }
  const defects = (lines: string[]) => lines.filter((l) => l.includes("trip_bot.silence_on_addressed_turn")).length;

  test("the sentinel on an explicit turn: still nothing sent, logged without ids or text, recorded as silent_on_addressed", async () => {
    const lines: string[] = [];
    const rec = recorder();
    await withConnector(async (h) => {
      const result = await replyAfter(h, [{ id: "4141", explicit: true }], SILENCE_SENTINEL, "4141");
      assert.equal(result.success, true);
      assert.deepEqual(h.telegram.sent, [], "we cannot invent an answer");
      assert.equal(defects(lines), 1);
      assert.equal(lines.filter((l) => l.includes("trip_bot.companion_stayed_silent")).length, 1, "the ordinary line is kept");
      assert.ok(lines.every((l) => !l.includes("901") && !l.includes("4141")), "no chat id, no message id");
      assert.deepEqual(rec.calls, [{ delivery: "suppressed", flags: { silentOnAddressed: true } }]);
    }, { defaultProfile: profile, log: (l) => lines.push(l), assistantEvents: rec.observer });
  });

  test("the sentinel on a window / judge turn is unchanged: no defect log, no flag", async () => {
    const lines: string[] = [];
    const rec = recorder();
    await withConnector(async (h) => {
      await replyAfter(h, [{ id: "42", explicit: false }], SILENCE_SENTINEL, "42");
      assert.deepEqual(h.telegram.sent, []);
      assert.equal(defects(lines), 0);
      assert.equal(lines.filter((l) => l.includes("trip_bot.companion_stayed_silent")).length, 1);
      assert.deepEqual(rec.calls, [{ delivery: "suppressed", flags: undefined }]);
    }, { defaultProfile: profile, log: (l) => lines.push(l), assistantEvents: rec.observer });
  });

  test("correlation: reply_to picks the turn it names; without it the latest forwarded turn decides", async () => {
    const a: string[] = [];
    await withConnector(async (h) => {
      await replyAfter(h, [{ id: "43", explicit: true }, { id: "44", explicit: false }], SILENCE_SENTINEL, "44");
      assert.equal(defects(a), 0, "reply_to names the window turn that followed the explicit one");
    }, { defaultProfile: profile, log: (l) => a.push(l) });
    const b: string[] = [];
    await withConnector(async (h) => {
      await replyAfter(h, [{ id: "45", explicit: true }, { id: "46", explicit: false }], SILENCE_SENTINEL, "45");
      assert.equal(defects(b), 1, "reply_to names the explicit turn");
    }, { defaultProfile: profile, log: (l) => b.push(l) });
    const c: string[] = [];
    await withConnector(async (h) => {
      await replyAfter(h, [{ id: "47", explicit: false }, { id: "48", explicit: true }], SILENCE_SENTINEL);
      assert.equal(defects(c), 1, "no reply_to: the latest forwarded turn");
    }, { defaultProfile: profile, log: (l) => c.push(l) });
  });

  test("a real answer to an explicit turn is delivered and flags nothing; a chat with no remembered turn is never a defect", async () => {
    const lines: string[] = [];
    const rec = recorder();
    await withConnector(async (h) => {
      await replyAfter(h, [{ id: "49", explicit: true }], "The hotel is ten minutes from the centre", "49");
      assert.equal(h.telegram.sent.length, 1);
      assert.equal(defects(lines), 0);
      assert.deepEqual(rec.calls, [{ delivery: "delivered", flags: undefined }]);
      // The same silence in a chat nothing was pushed to (a proactive turn, a restart): unknown is not a defect.
      await replyAfter(h, [], SILENCE_SENTINEL);
      assert.equal(defects(lines), 1, "the earlier explicit turn in this chat is the latest known one");
    }, { defaultProfile: profile, log: (l) => lines.push(l), assistantEvents: rec.observer });
    const fresh: string[] = [];
    await withConnector(async (h) => {
      await replyAfter(h, [], SILENCE_SENTINEL);
      assert.equal(defects(fresh), 0);
    }, { defaultProfile: profile, log: (l) => fresh.push(l) });
  });
});

describe("RelayConnector - outbound actions are scoped to the caller's own chats", () => {
  const GW = "companion-colmar";
  const OTHER = "companion-japan";
  const INTERVIEWER = "kinerary-interviewer";
  const MULTIPLEX = "kinerary-trip-intake";
  const own: ChatRoute = { kind: "companion", tripId: "t-colmar", hermesProfile: GW, assistantNames: [] };
  const other: ChatRoute = { kind: "companion", tripId: "t-japan", hermesProfile: OTHER, assistantNames: [] };
  const noProfile: ChatRoute = { kind: "companion", tripId: "t-new", hermesProfile: null, assistantNames: [] };
  const unbound: ChatRoute = { kind: "unbound" };
  const interview: ChatRoute = { kind: "interview", sessionId: "s1", tripId: "t-colmar" };

  const OPS: ReadonlyArray<{ name: string; action: (chat: string) => Record<string, unknown> }> = [
    { name: "send", action: (chat) => ({ op: "send", chat_id: chat, content: "SECRET-TEXT hello", reply_to: "REPLY-9", metadata: { expects_reply: true } }) },
    { name: "edit", action: (chat) => ({ op: "edit", chat_id: chat, message_id: "MSG-12", content: "SECRET-TEXT revised" }) },
    { name: "typing", action: (chat) => ({ op: "typing", chat_id: chat }) },
    { name: "get_chat_info", action: (chat) => ({ op: "get_chat_info", chat_id: chat }) },
  ];

  /** What reached Telegram, whatever the op. */
  const telegramCalls = (t: FakeTelegram): number =>
    t.sent.length + t.edited.length + t.typing.length + t.infoCalls.length;

  /** One outbound frame from a gateway authenticated as `as`; returns the whole wire exchange. */
  async function ask(
    h: Harness,
    as: string,
    action: Record<string, unknown>,
  ): Promise<{ frame: Record<string, unknown>; reply: Record<string, unknown>; result: Record<string, unknown> }> {
    const { ws, frames } = await dial(h.port, makeUpgradeToken(as, SECRET, 300));
    const frame = { type: "outbound", requestId: "req_scope", action };
    sendFrame(ws, frame);
    const reply = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
    ws.close();
    return { frame, reply, result: reply.result as Record<string, unknown> };
  }

  const refusedIn = (lines: string[]) =>
    lines.filter((l) => l.includes("relay.outbound_out_of_scope")).map((l) => JSON.parse(l) as Record<string, unknown>);

  for (const op of OPS) {
    test(`AC-1 ${op.name}: in the caller's own chat it is performed exactly as before`, async () => {
      await withConnector(async (h) => {
        const { result } = await ask(h, GW, op.action("C1"));
        assert.equal(result.success, true);
        if (op.name === "send") {
          assert.equal(result.message_id, "555");
          assert.equal(h.telegram.sent.length, 1);
        }
        if (op.name === "edit") assert.equal(h.telegram.edited.length, 1);
        if (op.name === "typing") assert.deepEqual(h.telegram.typing, ["C1"]);
        if (op.name === "get_chat_info") assert.deepEqual(result, { success: true, name: "Japan Trip", type: "group" });
      }, { routes: { C1: own } });
    });

    test(`AC-2 ${op.name}: in a chat bound to another profile it is refused, with no Telegram call`, async () => {
      const lines: string[] = [];
      await withConnector(async (h) => {
        const { result } = await ask(h, GW, op.action("C2"));
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.equal(refusedIn(lines).length, 1, "one log line per refusal");
      }, { routes: { C2: other }, log: (l) => lines.push(l) });
    });

    test(`AC-3 ${op.name}: an unbound chat and a companion route with no profile refuse every caller, the multiplex gateway included`, async () => {
      await withConnector(async (h) => {
        for (const caller of [GW, OTHER, INTERVIEWER, MULTIPLEX]) {
          for (const chat of ["CU", "CN"]) {
            const { result } = await ask(h, caller, op.action(chat));
            assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE }, `${caller} in ${chat}`);
          }
        }
        assert.equal(telegramCalls(h.telegram), 0);
      }, { routes: { CU: unbound, CN: noProfile }, interviewerProfile: INTERVIEWER, fallbackGatewayId: MULTIPLEX });
    });

    test(`AC-4 ${op.name}: an interview chat refuses a companion gateway`, async () => {
      const said: string[] = [];
      await withConnector(async (h) => {
        const { result } = await ask(h, GW, op.action("CI"));
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.deepEqual(said, [], "and the interview's router was not touched");
      }, {
        routes: { CI: interview },
        interviewerProfile: INTERVIEWER,
        fallbackGatewayId: MULTIPLEX,
        interviewSay: async (_c, text) => { said.push(text); return true; },
      });
    });

    test(`AC-5 ${op.name}: the declared multiplex gateway is allowed on every bound companion chat; undeclared, it is nobody`, async () => {
      await withConnector(async (h) => {
        for (const chat of ["CA", "CB"]) {
          const { result } = await ask(h, MULTIPLEX, op.action(chat));
          assert.equal(result.success, true, chat);
        }
      }, { routes: { CA: own, CB: other }, fallbackGatewayId: MULTIPLEX });
      await withConnector(async (h) => {
        const { result } = await ask(h, MULTIPLEX, op.action("CA"));
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        assert.equal(telegramCalls(h.telegram), 0);
      }, { routes: { CA: own } });
    });

    test(`AC-7 ${op.name}: a failed lookup, or no resolver, is SCOPE_CHECK_FAILED with no Telegram call`, async () => {
      const lines: string[] = [];
      await withConnector(async (h) => {
        const { result } = await ask(h, GW, op.action("C1"));
        assert.deepEqual(result, { success: false, error: SCOPE_CHECK_FAILED });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.equal(refusedIn(lines)[0]?.route_kind, "lookup_failed");
      }, { resolveRoute: async () => { throw new Error("db down"); }, log: (l) => lines.push(l) });
      const noResolverLines: string[] = [];
      await withConnector(async (h) => {
        const { result } = await ask(h, GW, op.action("C1"));
        assert.deepEqual(result, { success: false, error: SCOPE_CHECK_FAILED });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.equal(refusedIn(noResolverLines).length, 1);
      }, { noResolver: true, log: (l) => noResolverLines.push(l) });
    });
  }

  test("the old permissive case, inverted: a gateway sending to a chat that is not its own gets nothing delivered", async () => {
    // Every chat here is bound to gw_1; only gw_1 may send in it.
    await withConnector(async (h) => {
      const mine = await ask(h, "gw_1", { op: "send", chat_id: "900", content: "hello" });
      assert.deepEqual(mine.result, { success: true, message_id: "555" });
      const theirs = await ask(h, OTHER, { op: "send", chat_id: "900", content: "hello" });
      assert.deepEqual(theirs.result, { success: false, error: CHAT_NOT_IN_SCOPE });
      assert.equal(h.telegram.sent.length, 1, "only the owner's send reached Telegram");
    });
  });

  test("AC-4: the interviewer profile and the multiplex gateway keep today's interview behaviour (send converted through say)", async () => {
    for (const caller of [INTERVIEWER, MULTIPLEX]) {
      const routed: Array<{ chatId: string; text: string }> = [];
      await withConnector(async (h) => {
        const { result } = await ask(h, caller, { op: "send", chat_id: "CI", content: "רשמתי." });
        assert.deepEqual(result, { success: true });
        assert.deepEqual(h.telegram.sent, [], "the router delivers it, not the gateway");
        assert.deepEqual(routed, [{ chatId: "CI", text: "רשמתי." }], caller);
      }, {
        routes: { CI: interview },
        interviewerProfile: INTERVIEWER,
        fallbackGatewayId: MULTIPLEX,
        interviewSay: async (chatId, text) => { routed.push({ chatId, text }); return true; },
      });
    }
  });

  test("AC-4: with no interviewer profile configured, the interview chat is the multiplex gateway's alone", async () => {
    await withConnector(async (h) => {
      const viaName = await ask(h, INTERVIEWER, { op: "typing", chat_id: "CI" });
      assert.deepEqual(viaName.result, { success: false, error: CHAT_NOT_IN_SCOPE });
      const viaMux = await ask(h, MULTIPLEX, { op: "typing", chat_id: "CI" });
      assert.equal(viaMux.result.success, true);
    }, { routes: { CI: interview }, fallbackGatewayId: MULTIPLEX });
  });

  test("AC-6: a binding closed between the turn and the reply refuses the reply", async () => {
    let bound = true;
    const resolveRoute = async (): Promise<ChatRoute> => (bound ? own : unbound);
    await withConnector(async (h) => {
      const { ws, frames } = await dial(h.port, makeUpgradeToken(GW, SECRET, 300));
      await waitFor(() => (h.connector.connectedGateways === 1 ? true : undefined));
      const turn: WireMessageEvent = {
        text: "when do we land?", message_type: "text", message_id: "4141",
        source: {
          platform: "telegram", chat_id: "C1", chat_type: "group", chat_name: null,
          user_id: "777", user_name: "Dror", thread_id: null, chat_topic: null, profile: GW,
        },
      };
      assert.equal(h.connector.pushInbound(turn), true);
      await waitFor(() => frames.find((f) => f.type === "inbound"));
      bound = false; // the binding is closed before the companion answers
      sendFrame(ws, { type: "outbound", requestId: "r1", action: { op: "send", chat_id: "C1", content: "Saturday.", reply_to: "4141" } });
      const reply = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
      assert.deepEqual(reply.result, { success: false, error: CHAT_NOT_IN_SCOPE });
      assert.deepEqual(h.telegram.sent, []);
      ws.close();
    }, { resolveRoute });
  });

  test("no cache: a binding switched between two actions takes effect on the next one, one lookup per action", async () => {
    let calls = 0;
    let route: ChatRoute = own;
    await withConnector(async (h) => {
      assert.equal((await ask(h, GW, { op: "typing", chat_id: "C1" })).result.success, true);
      route = other; // e.g. a DM switched to another trip
      assert.deepEqual((await ask(h, GW, { op: "typing", chat_id: "C1" })).result, { success: false, error: CHAT_NOT_IN_SCOPE });
      assert.equal(calls, 2);
      route = own;
      await ask(h, GW, { op: "send", chat_id: "C1", content: "hello" });
      assert.equal(calls, 3, "a send resolves once: the interview branch reuses the same answer");
    }, { resolveRoute: async () => { calls += 1; return route; } });
  });

  test("AC-10: a refused action has no side effect - no window write, no renewal, no say, no assistant event, no silence bookkeeping", async () => {
    const effects: string[] = [];
    const lines: string[] = [];
    const observer: ReplyObserver = { replySent: () => { effects.push("assistantEvents"); } };
    await withConnector(async (h) => {
      for (const content of ["hello", SILENCE_SENTINEL, "`bot_gender` leaks"]) {
        const { result } = await ask(h, GW, { op: "send", chat_id: "C2", content, metadata: { expects_reply: true } });
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        const toInterview = await ask(h, GW, { op: "send", chat_id: "CI", content });
        assert.deepEqual(toInterview.result, { success: false, error: CHAT_NOT_IN_SCOPE });
      }
      assert.deepEqual(effects, []);
      assert.equal(telegramCalls(h.telegram), 0);
      assert.ok(!lines.some((l) => l.includes("companion_stayed_silent") || l.includes("internal_leak") || l.includes("agent_send")), "none of the later branches ran");
    }, {
      routes: { C2: other, CI: interview },
      interviewerProfile: INTERVIEWER,
      setExpectsReply: async () => { effects.push("setExpectsReply"); },
      renewConversation: async () => { effects.push("renewConversation"); },
      interviewSay: async () => { effects.push("interviewSay"); return true; },
      assistantEvents: observer,
      log: (l) => lines.push(l),
    });
  });

  test("AC-8: the refusal line carries op, gateway, a digest of the chat, its kind and the route kind - never the raw chat id or anything of the message", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      for (const chat of ["-100987654", "424242"]) {
        for (const op of OPS) await ask(h, GW, op.action(chat));
      }
      const logged = refusedIn(lines);
      assert.equal(logged.length, 8);
      assert.deepEqual(logged.slice(0, 4).map((l) => l.op), ["send", "edit", "typing", "get_chat_info"]);
      for (const [i, line] of logged.entries()) {
        const group = i < 4;
        assert.equal(line.level, "warn");
        assert.equal(line.gateway_id, GW);
        assert.equal(line.chat_ref, digestTelegramId(group ? "-100987654" : "424242"), "the digest form CHAT_DIGEST_SQL matches");
        assert.equal(line.chat_kind, group ? "group" : "private");
        assert.equal(line.route_kind, "companion");
        assert.equal(typeof line.reason, "string");
        assert.deepEqual(Object.keys(line).sort(), ["chat_kind", "chat_ref", "event", "gateway_id", "level", "op", "reason", "route_kind"]);
      }
      const raw = lines.filter((l) => l.includes("relay.outbound_out_of_scope")).join("\n");
      for (const secret of ["SECRET-TEXT", "REPLY-9", "MSG-12", OTHER, "100987654", "424242"]) {
        assert.ok(!raw.includes(secret), `the line must not contain ${secret}`);
      }
    }, { routes: { "-100987654": other, "424242": other }, log: (l) => lines.push(l) });
  });

  test("AC-8: every route kind logs its own route_kind", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      for (const chat of ["R1", "R2", "R3", "R4"]) await ask(h, GW, { op: "typing", chat_id: chat });
      assert.deepEqual(refusedIn(lines).map((l) => l.route_kind), ["companion", "companion_no_profile", "interview", "unbound"]);
    }, { routes: { R1: other, R2: noProfile, R3: interview, R4: unbound }, log: (l) => lines.push(l) });
  });

  test("AC-7: a route lookup that never answers is bounded: SCOPE_CHECK_FAILED, exactly one result, nothing reaches Telegram", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      for (const op of OPS) {
        const started = Date.now();
        const { ws, frames } = await dial(h.port, makeUpgradeToken(GW, SECRET, 300));
        sendFrame(ws, { type: "outbound", requestId: `hang_${op.name}`, action: op.action("C1") });
        const reply = await waitFor(() => frames.find((f) => f.type === "outbound_result"), 3000);
        assert.deepEqual(reply.result, { success: false, error: SCOPE_CHECK_FAILED }, op.name);
        assert.ok(Date.now() - started < 2500, "answered within the bound, not at the gateway's own timeout");
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(frames.filter((f) => f.type === "outbound_result").length, 1, "exactly one result");
        ws.close();
      }
      assert.equal(telegramCalls(h.telegram), 0);
      const logged = refusedIn(lines);
      assert.equal(logged.length, 4);
      assert.ok(logged.every((l) => l.route_kind === "lookup_failed" && l.reason === "route_lookup_timeout"));
    }, { resolveRoute: () => new Promise<ChatRoute>(() => {}), scopeLookupTimeoutMs: 200, log: (l) => lines.push(l) });
  });

  test("AC-7: every outbound frame gets exactly one outbound_result, refused or not", async () => {
    await withConnector(async (h) => {
      const { ws, frames } = await dial(h.port, makeUpgradeToken(GW, SECRET, 300));
      const ids = ["a", "b", "c", "d", "e"];
      const chats = ["C1", "C2", "CU", "CX", "C1"]; // own, other, unbound, lookup throws, own
      ids.forEach((id, i) => sendFrame(ws, { type: "outbound", requestId: id, action: { op: "typing", chat_id: chats[i] } }));
      await waitFor(() => (frames.filter((f) => f.type === "outbound_result").length >= 5 ? true : undefined));
      await new Promise((r) => setTimeout(r, 100));
      const results = frames.filter((f) => f.type === "outbound_result");
      assert.deepEqual(results.map((f) => f.requestId).sort(), ids);
      const byId = Object.fromEntries(results.map((f) => [f.requestId as string, f.result]));
      assert.deepEqual(byId.a, { success: true });
      assert.deepEqual(byId.b, { success: false, error: CHAT_NOT_IN_SCOPE });
      assert.deepEqual(byId.c, { success: false, error: CHAT_NOT_IN_SCOPE });
      assert.deepEqual(byId.d, { success: false, error: SCOPE_CHECK_FAILED });
      assert.deepEqual(byId.e, { success: true });
      ws.close();
    }, {
      resolveRoute: async (chat) => {
        if (chat === "CX") throw new Error("boom");
        const routes: Record<string, ChatRoute> = { C1: own, C2: other, CU: unbound };
        return routes[chat] ?? unbound;
      },
    });
  });

  test("identity is the upgrade token's: a hello or frame field naming another profile changes nothing", async () => {
    await withConnector(async (h) => {
      const { ws, frames } = await dial(h.port, makeUpgradeToken(GW, SECRET, 300));
      sendFrame(ws, { type: "hello", platform: "telegram", profile: OTHER, gateway_id: OTHER, botId: "1" });
      await waitFor(() => frames.find((f) => f.type === "descriptor"));
      sendFrame(ws, {
        type: "outbound", requestId: "x1", profile: OTHER, gateway_id: OTHER,
        action: { op: "send", chat_id: "C2", content: "hello", profile: OTHER, gateway_id: OTHER, hermes_profile: OTHER },
      });
      const reply = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
      assert.deepEqual(reply.result, { success: false, error: CHAT_NOT_IN_SCOPE });
      assert.deepEqual(h.telegram.sent, []);
      ws.close();
    }, { routes: { C2: other } });
  });

  test("the interviewer keeps its own private chat after the interview is confirmed and before the companion is bound; a companion does not", async () => {
    await withConnector(async (h) => {
      // The interviewer's send goes to Telegram directly: the session is over, there is no router turn to convert it into.
      const mine = await ask(h, INTERVIEWER, { op: "send", chat_id: "HO", content: "your trip is being built" });
      assert.deepEqual(mine.result, { success: true, message_id: "555" });
      assert.equal(h.telegram.sent.length, 1);
      assert.equal((await ask(h, MULTIPLEX, { op: "typing", chat_id: "HO" })).result.success, true);
      for (const op of OPS) {
        assert.deepEqual((await ask(h, GW, op.action("HO"))).result, { success: false, error: CHAT_NOT_IN_SCOPE }, `${op.name} by a companion`);
      }
      assert.equal(h.telegram.sent.length, 1, "the companion's actions reached nothing");
    }, { routes: { HO: { kind: "interview_handover" } }, interviewerProfile: INTERVIEWER, fallbackGatewayId: MULTIPLEX });
  });

  test("Decision 3: while the organizer's private chat is mid-interview, a group of the same trip keeps working; only that private chat refuses the companion", async () => {
    const trip = "t-colmar";
    const privateChat = "700"; // the organizer's DM: a live interview session
    const group = "-1001"; // a group bound to the same trip, companion installed
    await withConnector(async (h) => {
      for (const op of OPS) {
        const inGroup = await ask(h, GW, op.action(group));
        assert.equal(inGroup.result.success, true, `${op.name} in the group`);
        const inPrivate = await ask(h, GW, op.action(privateChat));
        assert.deepEqual(inPrivate.result, { success: false, error: CHAT_NOT_IN_SCOPE }, `${op.name} in the private chat`);
      }
      assert.equal(h.telegram.sent.length, 1);
      assert.equal(h.telegram.sent[0]!.chatId, group);
      // ...and the interviewer's own gateway is the one that speaks in the private chat.
      const interviewer = await ask(h, INTERVIEWER, { op: "typing", chat_id: privateChat });
      assert.equal(interviewer.result.success, true);
    }, {
      routes: {
        [privateChat]: { kind: "interview", sessionId: "s1", tripId: trip },
        [group]: { kind: "companion", tripId: trip, hermesProfile: GW, assistantNames: [] },
      },
      interviewerProfile: INTERVIEWER,
    });
  });
});

describe("RelayConnector - a gateway whose id matches no interviewer identity and no bound companion is warned about, once", () => {
  const unmatched = (lines: string[]) =>
    lines.filter((l) => l.includes("relay.gateway_identity_unmatched")).map((l) => JSON.parse(l) as Record<string, unknown>);
  const settle = () => new Promise((r) => setTimeout(r, 150));

  test("the VM shape - interviewer gateway `kinerary-trip-intake`, interviewer_profile `trip-intake`, no multiplex id - logs exactly one warning, however often it reconnects, and routing is untouched", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      for (let i = 0; i < 3; i += 1) {
        const { ws } = await dial(h.port, makeUpgradeToken("kinerary-trip-intake", SECRET, 300));
        await waitFor(() => (h.connector.connectedGateways === 1 ? true : undefined));
        await settle();
        ws.close();
        await waitFor(() => (h.connector.connectedGateways === 0 ? true : undefined));
      }
      const warned = unmatched(lines);
      assert.equal(warned.length, 1);
      assert.deepEqual(Object.keys(warned[0]!).sort(), ["event", "gateway_id", "level", "reason"]);
      assert.equal(warned[0]!.level, "warn");
      assert.equal(warned[0]!.gateway_id, "kinerary-trip-intake");
      assert.equal(typeof warned[0]!.reason, "string");
      // A warning only: the gateway still connects and is still reachable under its own id.
      const { ws } = await dial(h.port, makeUpgradeToken("kinerary-trip-intake", SECRET, 300));
      await waitFor(() => (h.connector.canReachProfile("kinerary-trip-intake") ? true : undefined));
      ws.close();
    }, { interviewerProfile: "trip-intake", profileHasOpenBinding: async () => false, log: (l) => lines.push(l) });
  });

  test("a matching id logs nothing: the interviewer profile, the multiplex id, a companion with an open binding", async () => {
    const lines: string[] = [];
    const asked: string[] = [];
    await withConnector(async (h) => {
      for (const id of ["trip-intake", "kinerary-mux", "companion-colmar"]) {
        const { ws } = await dial(h.port, makeUpgradeToken(id, SECRET, 300));
        await waitFor(() => (h.connector.canReachProfile(id) ? true : undefined));
        await settle();
        ws.close();
      }
      assert.deepEqual(unmatched(lines), []);
      assert.deepEqual(asked, ["companion-colmar"], "the database is asked only for an id that is neither interviewer identity");
    }, {
      interviewerProfile: "trip-intake",
      fallbackGatewayId: "kinerary-mux",
      profileHasOpenBinding: async (profile) => { asked.push(profile); return profile === "companion-colmar"; },
      log: (l) => lines.push(l),
    });
  });

  test("a failed binding lookup logs no warning and breaks nothing; with no lookup configured nothing is judged", async () => {
    const lines: string[] = [];
    await withConnector(async (h) => {
      const { ws } = await dial(h.port, makeUpgradeToken("anything", SECRET, 300));
      await waitFor(() => (h.connector.connectedGateways === 1 ? true : undefined));
      await settle();
      assert.deepEqual(unmatched(lines), []);
      ws.close();
    }, { profileHasOpenBinding: async () => { throw new Error("db down"); }, log: (l) => lines.push(l) });
    const quiet: string[] = [];
    await withConnector(async (h) => {
      const { ws } = await dial(h.port, makeUpgradeToken("anything", SECRET, 300));
      await waitFor(() => (h.connector.connectedGateways === 1 ? true : undefined));
      await settle();
      assert.deepEqual(unmatched(quiet), []);
      ws.close();
    }, { log: (l) => quiet.push(l) });
  });
});

// ── #625 S3: one chat id, one platform (AC-20, AC-24) ─────────────────────────────────────
// The transport is chosen from the binding ROW's platform, never from the frame. These
// cases need no database: the route is what `resolveOutboundRoute` would answer.

/** Records what the connector asked the WhatsApp bridge to do. Answers like a connected bridge. */
class RecordingWhatsApp {
  readonly calls: { op: string; chatId: string; text?: string; replyTo?: string; messageId?: string }[] = [];
  private next = 0;
  async health() { return { ok: false as const, reason: "unavailable" as const }; }
  async poll() { return { ok: false as const, reason: "unavailable" as const }; }
  async fetchMedia() { return { ok: false as const, reason: "unavailable" as const }; }
  async send(req: { chatId: string; text: string; replyTo?: string }) {
    this.calls.push({ op: "send", chatId: req.chatId, text: req.text, ...(req.replyTo ? { replyTo: req.replyTo } : {}) });
    this.next += 1;
    return { ok: true as const, value: { messageId: `WAOUT${this.next}`, quoted: false } };
  }
  async edit(req: { chatId: string; messageId: string; text: string }) {
    this.calls.push({ op: "edit", chatId: req.chatId, messageId: req.messageId, text: req.text });
    return { ok: true as const, value: { messageId: req.messageId } };
  }
  async typing(req: { chatId: string }) {
    this.calls.push({ op: "typing", chatId: req.chatId });
    return { ok: true as const, value: undefined };
  }
  async chatInfo(chatId: string) {
    this.calls.push({ op: "get_chat_info", chatId });
    return { ok: true as const, value: { kind: "group" as const, chatId, title: "Family", size: 4 } };
  }
  async isParticipant() { return { ok: false as const, reason: "unavailable" as const }; }
}

describe("RelayConnector — WhatsApp and Telegram chats never cross (#625 AC-20, AC-24)", () => {
  const GW = "companion-colmar";
  const WA_GROUP = `wa_${"a".repeat(32)}@g`;
  const WA_PRIVATE = `wa_${"b".repeat(32)}@p`;
  const WA_OTHER_TRIP = `wa_${"c".repeat(32)}@g`;
  const TG_GROUP = "-1001234567";
  const REAL_GROUP = "120363000000000001@g.us";
  const waRoute: ChatRoute = { kind: "companion", tripId: "t-colmar", hermesProfile: GW, assistantNames: [], platform: "whatsapp" };
  const tgRoute: ChatRoute = { kind: "companion", tripId: "t-colmar", hermesProfile: GW, assistantNames: [], platform: "telegram" };
  const otherTrip: ChatRoute = { kind: "companion", tripId: "t-japan", hermesProfile: "companion-japan", assistantNames: [], platform: "whatsapp" };
  const OPS: ReadonlyArray<{ name: string; action: (chat: string) => Record<string, unknown> }> = [
    { name: "send", action: (chat) => ({ op: "send", chat_id: chat, content: "**hello** there" }) },
    { name: "edit", action: (chat) => ({ op: "edit", chat_id: chat, message_id: "WAOUT1", content: "revised" }) },
    { name: "typing", action: (chat) => ({ op: "typing", chat_id: chat }) },
    { name: "get_chat_info", action: (chat) => ({ op: "get_chat_info", chat_id: chat }) },
  ];

  async function withWhatsAppConnector(
    routes: Record<string, ChatRoute>,
    fn: (h: { port: number; telegram: FakeTelegram; whatsapp: RecordingWhatsApp; lines: string[] }) => Promise<void>,
    options: { client?: boolean } = {},
  ): Promise<void> {
    const telegram = new FakeTelegram();
    const whatsapp = new RecordingWhatsApp();
    const lines: string[] = [];
    const connector = new RelayConnector({
      gatewaySecrets: [SECRET],
      telegram,
      port: 0,
      log: (l) => lines.push(l),
      resolveRoute: async (chatId) => routes[chatId] ?? { kind: "unbound" },
      ...(options.client === false ? {} : { whatsapp: whatsapp as never, whatsappAddressOf: async (alias: string) => (alias === WA_GROUP ? REAL_GROUP : alias === WA_PRIVATE ? "100000000000001@lid" : null) }),
    });
    await connector.listen();
    try {
      await fn({ port: connector.address!, telegram, whatsapp, lines });
    } finally {
      await connector.close();
    }
  }

  async function askAs(port: number, as: string, action: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { ws, frames } = await dial(port, makeUpgradeToken(as, SECRET, 300));
    sendFrame(ws, { type: "outbound", requestId: "req_wa", action });
    const reply = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
    ws.close();
    return reply.result as Record<string, unknown>;
  }

  const telegramCalls = (t: FakeTelegram) => t.sent.length + t.edited.length + t.typing.length + t.infoCalls.length;

  for (const op of OPS) {
    test(`AC-20 ${op.name}: a WhatsApp binding on a relay with no WhatsApp client is PLATFORM_UNAVAILABLE, and Telegram is never called`, async () => {
      await withWhatsAppConnector({ [WA_GROUP]: waRoute }, async (h) => {
        const result = await askAs(h.port, GW, op.action(WA_GROUP));
        assert.deepEqual(result, { success: false, error: "PLATFORM_UNAVAILABLE" });
        assert.equal(telegramCalls(h.telegram), 0);
      }, { client: false });
    });

    test(`AC-24 ${op.name}: a WhatsApp alias whose row says Telegram is refused, and neither transport is called`, async () => {
      await withWhatsAppConnector({ [WA_GROUP]: tgRoute }, async (h) => {
        const result = await askAs(h.port, GW, op.action(WA_GROUP));
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.equal(h.whatsapp.calls.length, 0);
        const line = h.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "relay.outbound_out_of_scope");
        assert.equal(line?.reason, "platform_mismatch");
        assert.equal(line?.chat_kind, "group", "chat_kind comes from chatKind(), so a WhatsApp alias is classified by its shape");
        assert.ok(!h.lines.join("\n").includes(WA_GROUP), "the alias is logged only as a digest");
      });
    });

    test(`AC-24 ${op.name}: a Telegram id whose row says WhatsApp is refused, and neither transport is called`, async () => {
      await withWhatsAppConnector({ [TG_GROUP]: waRoute }, async (h) => {
        const result = await askAs(h.port, GW, op.action(TG_GROUP));
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.equal(h.whatsapp.calls.length, 0);
      });
    });

    test(`AC-24 ${op.name}: a frame naming another trip's WhatsApp alias is refused CHAT_NOT_IN_SCOPE`, async () => {
      await withWhatsAppConnector({ [WA_OTHER_TRIP]: otherTrip }, async (h) => {
        const result = await askAs(h.port, GW, op.action(WA_OTHER_TRIP));
        assert.deepEqual(result, { success: false, error: CHAT_NOT_IN_SCOPE });
        assert.equal(telegramCalls(h.telegram), 0);
        assert.equal(h.whatsapp.calls.length, 0);
      });
    });
  }

  test("AC-24: the caller's own WhatsApp chat goes through the bridge, to the row's real address, converted; Telegram is not called", async () => {
    await withWhatsAppConnector({ [WA_GROUP]: waRoute, [TG_GROUP]: tgRoute }, async (h) => {
      const sent = await askAs(h.port, GW, OPS[0]!.action(WA_GROUP));
      assert.equal(sent.success, true);
      assert.equal(sent.message_id, "WAOUT1");
      assert.deepEqual(h.whatsapp.calls[0], { op: "send", chatId: REAL_GROUP, text: "*hello* there" });
      assert.equal((await askAs(h.port, GW, OPS[1]!.action(WA_GROUP))).success, true, "an edit of a message the number sent here");
      assert.equal((await askAs(h.port, GW, OPS[2]!.action(WA_GROUP))).success, true);
      const info = await askAs(h.port, GW, OPS[3]!.action(WA_GROUP));
      assert.deepEqual(info, { success: true, name: "Family", type: "group" });
      assert.equal(telegramCalls(h.telegram), 0);
      // The same connector still serves Telegram for a Telegram row.
      const tg = await askAs(h.port, GW, { op: "send", chat_id: TG_GROUP, content: "hi" });
      assert.equal(tg.success, true);
      assert.equal(h.telegram.sent.length, 1);
      assert.equal(h.whatsapp.calls.filter((c) => c.op === "send").length, 1, "the Telegram send did not touch the bridge");
    });
  });

  test("AC-24: an edit of a message the number did not send in that chat is refused before the bridge is asked", async () => {
    await withWhatsAppConnector({ [WA_GROUP]: waRoute, [WA_PRIVATE]: waRoute }, async (h) => {
      await askAs(h.port, GW, OPS[0]!.action(WA_PRIVATE)); // WAOUT1 is sent in the PRIVATE chat
      const result = await askAs(h.port, GW, { op: "edit", chat_id: WA_GROUP, message_id: "WAOUT1", content: "x" });
      assert.deepEqual(result, { success: false, error: "EDIT_REFUSED" });
      assert.equal(h.whatsapp.calls.filter((c) => c.op === "edit").length, 0);
    });
  });

  test("AC-24: a reply_to that is not a message of the same chat is dropped, and the text still goes, unquoted", async () => {
    await withWhatsAppConnector({ [WA_GROUP]: waRoute, [WA_PRIVATE]: waRoute }, async (h) => {
      await askAs(h.port, GW, OPS[0]!.action(WA_PRIVATE)); // WAOUT1, in the private chat
      const result = await askAs(h.port, GW, { op: "send", chat_id: WA_GROUP, content: "answer", reply_to: "WAOUT1" });
      assert.equal(result.success, true);
      const last = h.whatsapp.calls.at(-1)!;
      assert.equal(last.chatId, REAL_GROUP);
      assert.equal(last.replyTo, undefined, "a message of another chat is never quoted");
    });
  });
});
