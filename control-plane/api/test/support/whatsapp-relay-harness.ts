/**
 * A whole WhatsApp relay on loopback, for the S3 tests (spec 625): the bridge stand-in
 * (`tools/fake-whatsapp.ts`), the real HTTP client, the real inbound loop, the real
 * connector with its real database-backed scope check, and a fake GATEWAY that speaks
 * the connector protocol over a real WebSocket, as Hermes does. Nothing connects to
 * WhatsApp or leaves loopback.
 *
 * Everything the relay logs goes to `lines`, so a test can scan all of it.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { WebSocket } from "ws";
import { CodeAttemptLimiter } from "../../src/chat-binding-codes.js";
import { whatsappChatAlias, whatsappOpaqueId } from "../../src/identity.js";
import { RelayConnector } from "../../src/relay/connector.js";
import type { GroupJudge, JudgeOutcome, JudgePromptInput } from "../../src/relay/group-judge.js";
import { MediaStore } from "../../src/relay/media-store.js";
import { outboundScopeOptions } from "../../src/relay/outbound-scope.js";
import { makeUpgradeToken } from "../../src/relay/protocol.js";
import type { ChatInfo, SendResult, TelegramClient } from "../../src/relay/telegram-api.js";
import { createHttpWhatsAppClient, type WhatsAppClient } from "../../src/relay/whatsapp/client.js";
import type { ScopeRoute } from "../../src/relay/outbound-scope.js";
import { startWhatsAppLoop, type WhatsAppLoop } from "../../src/relay/whatsapp/poller.js";
import { BridgeStateTracker, WhatsAppMessageLedger } from "../../src/relay/whatsapp/state.js";
import { startFakeWhatsApp, type FakeWhatsApp } from "../../tools/fake-whatsapp.js";
import { mkMember, mkUser, mkWhatsappTrip, openBinding, uid } from "./whatsapp-fixture.js";

export const GATEWAY_SECRET = "relay-whatsapp-test-gateway-secret";
/** The sender-id key: a test value of 40 bytes. */
export const SENDER_KEY = "s3b-sender-key-0123456789abcdef0123456789";
export const BRIDGE_SECRET = `bridge-${randomBytes(20).toString("hex")}`;

export const alias = {
  private: (lid: string) => whatsappChatAlias(SENDER_KEY, lid, "private"),
  group: (realId: string) => whatsappChatAlias(SENDER_KEY, realId, "group"),
  sender: (lid: string) => whatsappOpaqueId(SENDER_KEY, lid),
};

/** Records Telegram calls, so a test can show the WhatsApp path made none, and that Telegram kept working. */
export class RecordingTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string }[] = [];
  readonly calls: string[] = [];
  async sendMessage(p: { chatId: string; text: string }): Promise<SendResult> {
    this.calls.push("sendMessage");
    this.sent.push({ chatId: p.chatId, text: p.text });
    return { ok: true, messageId: String(this.sent.length) };
  }
  async editMessageText(): Promise<SendResult> { this.calls.push("editMessageText"); return { ok: true }; }
  async sendChatAction(): Promise<void> { this.calls.push("sendChatAction"); }
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(): Promise<ChatInfo | null> { this.calls.push("getChatInfo"); return { name: "TG", type: "group" }; }
  async getMe() { return null; }
  async getUpdates(): Promise<unknown[]> { return []; }
  async deleteWebhookIfPresent(): Promise<void> {}
  async fetchFile() { return null; }
}

/** A judge that says no (or what it is told), and keeps every input it was given. */
export class RecordingJudge implements GroupJudge {
  readonly inputs: (JudgePromptInput & { chatId: string })[] = [];
  verdict: "yes" | "no" = "no";
  model(): string | null { return "fake-judge"; }
  async judge(input: JudgePromptInput & { chatId: string }): Promise<JudgeOutcome> {
    this.inputs.push(input);
    return this.verdict === "yes"
      ? { kind: "yes", confidence: 0.95, ms: 1, model: "fake-judge" }
      : { kind: "no", confidence: 0.95, ms: 1, model: "fake-judge", belowThreshold: false };
  }
}

export interface FakeGateway {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  inbound(): Record<string, unknown>[];
  /** Sends one outbound action and waits for its result. */
  act(action: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export async function waitFor<T>(get: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export async function dialGateway(port: number, profile: string): Promise<FakeGateway> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
    headers: { authorization: `Bearer ${makeUpgradeToken(profile, GATEWAY_SECRET, 300)}` },
  });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(`${JSON.stringify({ type: "hello", identity: profile })}\n`);
  await waitFor(() => frames.find((f) => f.type === "descriptor"), 3000, "descriptor");
  let n = 0;
  return {
    ws,
    frames,
    inbound: () => frames.filter((f) => f.type === "inbound"),
    async act(action) {
      n += 1;
      const requestId = `req_${n}_${randomBytes(3).toString("hex")}`;
      ws.send(`${JSON.stringify({ type: "outbound", requestId, action })}\n`);
      const reply = await waitFor(() => frames.find((f) => f.type === "outbound_result" && f.requestId === requestId), 5000, "outbound_result");
      return reply.result as Record<string, unknown>;
    },
    close: () => ws.close(),
  };
}

export interface Relay {
  fake: FakeWhatsApp;
  connector: RelayConnector;
  telegram: RecordingTelegram;
  loop: WhatsAppLoop;
  judge: RecordingJudge;
  lines: string[];
  mediaStore: MediaStore;
  state: BridgeStateTracker;
  /** Log lines parsed. */
  events(name?: string): Record<string, unknown>[];
  /** Waits until a log line with this event (and fields) has appeared `count` times in total. */
  until(name: string, fields?: Record<string, unknown>, count?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface RelayOptions {
  whatsappClient?: boolean;
  /** Wraps the HTTP client (a probe that changes what the bridge says). */
  wrapClient?: (client: WhatsAppClient) => WhatsAppClient;
  /** Wraps the connector's route lookup (a probe that changes the database between the scope check and the send). */
  wrapResolve?: (resolve: (chatId: string) => Promise<ScopeRoute>) => (chatId: string) => Promise<ScopeRoute>;
  /** Do not wait for the loop's first cursor (a bridge that never lets it get one). */
  waitReady?: boolean;
  codeAttemptsPerHour?: number;
  mediaTimeoutMs?: number;
}

export async function startRelay(pool: pg.Pool, options: RelayOptions = {}): Promise<Relay> {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const fake = await startFakeWhatsApp({ secret: BRIDGE_SECRET });
  const http = createHttpWhatsAppClient({
    baseUrl: fake.url, secret: BRIDGE_SECRET, requestTimeoutMs: 2000,
    ...(options.mediaTimeoutMs ? { mediaTimeoutMs: options.mediaTimeoutMs } : {}),
  });
  const client = options.wrapClient ? options.wrapClient(http) : http;
  const scope = outboundScopeOptions(pool, undefined, log);
  if (options.wrapResolve && scope.resolveRoute) scope.resolveRoute = options.wrapResolve(scope.resolveRoute);
  const ledger = new WhatsAppMessageLedger();
  const state = new BridgeStateTracker(log);
  const telegram = new RecordingTelegram();
  const mediaStore = new MediaStore();
  const judge = new RecordingJudge();
  const connector = new RelayConnector({
    gatewaySecrets: [GATEWAY_SECRET],
    telegram,
    port: 0,
    mediaStore,
    log,
    ...scope,
    ...(options.whatsappClient === false ? {} : { whatsapp: client, whatsappLedger: ledger, whatsappState: state }),
  });
  await connector.listen();
  const baseUrl = `http://127.0.0.1:${connector.address}`;
  const loop = startWhatsAppLoop({
    db: pool,
    client,
    senderKey: SENDER_KEY,
    connector,
    ledger,
    state,
    codeLimiter: new CodeAttemptLimiter({ log, ...(options.codeAttemptsPerHour ? { perChatPerHour: options.codeAttemptsPerHour } : {}) }),
    log,
    groupJudge: judge,
    media: { store: mediaStore, baseUrl, log },
  }, { waitMs: 150, minBackoffMs: 20, maxBackoffMs: 100 });
  if (options.waitReady !== false) await loop.ready;
  const parsed = () => lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  const matches = (e: Record<string, unknown>, name: string, fields: Record<string, unknown>) =>
    e.event === name && Object.entries(fields).every(([k, v]) => e[k] === v);
  return {
    fake, connector, telegram, loop, judge, lines, mediaStore, state,
    events: (name) => parsed().filter((e) => name === undefined || e.event === name),
    async until(name, fields = {}, count = 1) {
      await waitFor(() => parsed().filter((e) => matches(e, name, fields)).length >= count, 6000, `${name} ${JSON.stringify(fields)} x${count}`);
      await loop.settled();
    },
    async stop() {
      loop.stop();
      // The stand-in first: closing it ends any request a probe left hanging, so the lanes can drain.
      await fake.close();
      await loop.settled();
      await connector.close();
    },
  };
}

export interface WaTrip { tripId: string; ownerId: string; profile: string }

/** A trip with an owner, the switch on, a companion profile, an assistant called Liv and an introduction. */
export async function waTrip(pool: pg.Pool, options: { switchOn?: boolean; title?: string } = {}): Promise<WaTrip> {
  const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: options.title ?? "Alsace", ...(options.switchOn === false ? { switchOn: false } : {}) });
  const profile = `gw-${randomBytes(5).toString("hex")}`;
  await pool.query(
    "UPDATE control_plane.trips SET hermes_profile = $2, assistant_names = ARRAY['Liv'], companion_intro = $3::jsonb WHERE id = $1",
    [tripId, profile, JSON.stringify({ assistant_name: "Liv", trip_title: options.title ?? "Alsace", private_url: "https://trip.example/alsace", language: "en", login_password: "hunter2-secret", organizer: "Dana" })],
  );
  return { tripId, ownerId, profile };
}

/** A private chat already bound to the trip, with a person link for `account` (when given). */
export async function bindPrivate(pool: pg.Pool, trip: WaTrip, lid: string, options: { account?: string | null; name?: string } = {}): Promise<string> {
  const chatId = alias.private(lid);
  const bindingId = await openBinding(pool, { tripId: trip.tripId, chatId, platform: "whatsapp", profile: trip.profile, transportAddress: lid });
  await pool.query(
    `INSERT INTO control_plane.trip_person_links
       (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via, platform, account_user_id)
     VALUES ($1, $2, $3, NULL, $4, 'participant', 'dashboard_code', 'whatsapp', $5)`,
    [uid("tpl"), trip.tripId, alias.sender(lid), options.name ?? null, options.account ?? null],
  );
  return bindingId;
}

export async function bindGroup(pool: pg.Pool, trip: WaTrip, realId: string, title = "Family"): Promise<string> {
  return openBinding(pool, { tripId: trip.tripId, chatId: alias.group(realId), platform: "whatsapp", profile: trip.profile, title, transportAddress: realId });
}

export { mkMember, mkUser };
