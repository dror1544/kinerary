/**
 * Relay ↔ connector wire protocol — the connector half.
 *
 * We are implementing the CONNECTOR side of Hermes's relay contract
 * (`~/.hermes/hermes-agent/docs/relay-connector-contract.md`, v1). The gateway
 * dials OUT to us over a WebSocket; we own the Telegram connection and every
 * platform secret, and the gateway holds none.
 *
 * Frame protocol (`gateway/relay/ws_transport.py`'s module doc is the
 * authority; newline-delimited JSON):
 *
 *   gateway -> connector : hello, outbound, interrupt
 *   connector -> gateway : descriptor, inbound, outbound_result, interrupt_inbound
 *
 * The contract is marked EXPERIMENTAL and may change without a deprecation
 * cycle until two Class-1 platforms have validated it. Everything here is
 * therefore pinned to `CONTRACT_VERSION` and kept in one file, so a contract
 * bump is a diff in one place rather than a hunt.
 *
 * Why the connector is where Sprint 5's rules live: the contract states that
 * tenant is resolved from the event's own discriminator "never from which
 * token/socket/process delivered it", and the gateway "re-validates nothing".
 * That makes this module the trust boundary. `source.profile` — the field that
 * decides WHICH trip's Hermes profile serves a turn — is stamped here from a
 * database lookup on the chat id, and can never be influenced by message
 * content or by the model.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONTRACT_VERSION = 1;

// ── Capability descriptor (handshake reply) ──────────────────────────────────

export interface CapabilityDescriptor {
  contract_version: number;
  platform: string;
  label: string;
  max_message_length: number;
  supports_draft_streaming: boolean;
  supports_edit: boolean;
  supports_threads: boolean;
  markdown_dialect: string;
  len_unit: string;
  emoji?: string;
  platform_hint?: string;
  pii_safe?: boolean;
  supports_context?: boolean;
  supports_inchannel_continuable?: boolean;
  supports_block_formatting?: boolean;
  supported_ops?: string[];
}

/**
 * What this connector advertises for Telegram.
 *
 * `len_unit: "utf16"` is not cosmetic — Telegram counts message length in
 * UTF-16 code units, so a message of emoji or Hebrew hits the 4096 limit at a
 * different point than `String.length` suggests. The contract has a dedicated
 * field for this precisely because getting it wrong truncates mid-character.
 *
 * `supported_ops` is deliberately narrow. The contract's rule is that a NEW op
 * is used only when explicitly advertised, so listing only what is actually
 * implemented means the gateway degrades instead of calling into a hole. Media
 * and prompt ops are absent until their Telegram lanes are built.
 */
export const TELEGRAM_DESCRIPTOR: CapabilityDescriptor = {
  contract_version: CONTRACT_VERSION,
  platform: "telegram",
  label: "Kinerary Trip Bot",
  max_message_length: 4096,
  supports_draft_streaming: false,
  // Telegram's editMessageText exists, so the gateway may stream by editing
  // rather than posting one message per segment.
  supports_edit: true,
  supports_threads: false,
  markdown_dialect: "markdown_v2",
  len_unit: "utf16",
  emoji: "🧭",
  platform_hint: "Telegram",
  pii_safe: true,
  // Model B (passive buffer) is not implemented, so no `context` is attached.
  supports_context: false,
  supports_inchannel_continuable: false,
  supports_block_formatting: false,
  supported_ops: ["send", "edit", "typing", "get_chat_info"],
};

// ── SessionSource (the wire surface, §3) ─────────────────────────────────────

export type ChatType = "dm" | "group" | "channel" | "thread" | "forum";

export interface WireSessionSource {
  platform: string;
  chat_id: string;
  chat_type: ChatType;
  chat_name: string | null;
  user_id: string | null;
  user_name: string | null;
  thread_id: string | null;
  chat_topic: string | null;
  /**
   * The Hermes profile this turn is routed to. THE Trip Context Gateway
   * decision, on the wire.
   *
   * The gateway honours this only when `multiplex_profiles` is enabled, and
   * uses it to namespace session keys (`agent:<profile>:…`) as well as to pick
   * the HERMES_HOME that serves the turn — so it is simultaneously the trip
   * selector and the session-isolation boundary. It is stamped from a chat-id
   * lookup this control plane performs itself; nothing an organizer or a model
   * can say reaches it.
   */
  profile?: string;
  message_id?: string;
}

export type MessageTypeName = "text" | "command" | "image" | "audio" | "document";

/**
 * One inbound attachment's metadata, parallel to `media_urls` and in the same
 * order. Contract §"Phase 2 media ingress".
 */
export interface WireMediaDescriptor {
  kind: "image" | "voice" | "audio" | "video" | "document";
  mime: string;
  size: number;
  filename?: string;
  caption?: string;
}

export interface WireMessageEvent {
  text: string;
  message_type: MessageTypeName;
  source: WireSessionSource;
  message_id?: string;
  reply_to_message_id?: string;
  /**
   * Fetchable references, never platform URLs. A Telegram file URL embeds the
   * bot token, so attachments are downloaded connector-side and re-hosted as
   * `{connector}/relay/media/{id}` — the platform credential never crosses.
   */
  media_urls?: string[];
  /** Same order as `media_urls`. */
  media?: WireMediaDescriptor[];
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** gateway -> connector */
export interface HelloFrame {
  type: "hello";
  platform: string;
  botId?: string;
  command_manifest?: unknown;
}

export interface OutboundFrame {
  type: "outbound";
  requestId: string;
  action: OutboundAction;
}

export interface InterruptFrame {
  type: "interrupt";
  session_key: string;
  reason?: string;
}

export interface GoingIdleFrame {
  type: "going_idle";
}

export interface InboundAckFrame {
  type: "inbound_ack";
  bufferId: string;
}

export type GatewayFrame = HelloFrame | OutboundFrame | InterruptFrame | GoingIdleFrame | InboundAckFrame;

/** connector -> gateway */
export interface DescriptorFrame {
  type: "descriptor";
  descriptor: CapabilityDescriptor;
}

export interface InboundFrame {
  type: "inbound";
  event: WireMessageEvent;
  bufferId?: string;
}

export interface OutboundResultFrame {
  type: "outbound_result";
  requestId: string;
  result: OutboundResult;
}

export type ConnectorFrame = DescriptorFrame | InboundFrame | OutboundResultFrame;

// ── Outbound actions (§4) ────────────────────────────────────────────────────

export interface SendAction {
  op: "send";
  chat_id: string;
  content: string;
  reply_to?: string;
  metadata?: Record<string, unknown>;
}

export interface EditAction {
  op: "edit";
  chat_id: string;
  message_id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface TypingAction {
  op: "typing";
  chat_id: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface GetChatInfoAction {
  op: "get_chat_info";
  chat_id: string;
}

export type OutboundAction = SendAction | EditAction | TypingAction | GetChatInfoAction;

export interface OutboundResult {
  success: boolean;
  message_id?: string;
  error?: string;
  name?: string;
  type?: string;
}

/**
 * Narrows a decoded frame to a known outbound action.
 *
 * An unrecognised op returns null rather than throwing: the contract's
 * versioning policy is additive, so a newer gateway may send an op this
 * connector predates. Answering that with `success: false` keeps the gateway's
 * per-request future resolving instead of hanging until its timeout.
 */
export function parseOutboundAction(raw: unknown): OutboundAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const action = raw as Record<string, unknown>;
  const op = action.op;
  const chatId = action.chat_id;
  if (typeof op !== "string" || typeof chatId !== "string" || chatId.length === 0) return null;

  switch (op) {
    case "send":
      return typeof action.content === "string"
        ? {
            op: "send",
            chat_id: chatId,
            content: action.content,
            reply_to: typeof action.reply_to === "string" ? action.reply_to : undefined,
          }
        : null;
    case "edit":
      return typeof action.content === "string" && typeof action.message_id === "string"
        ? { op: "edit", chat_id: chatId, message_id: action.message_id, content: action.content }
        : null;
    case "typing":
      return { op: "typing", chat_id: chatId };
    case "get_chat_info":
      return { op: "get_chat_info", chat_id: chatId };
    default:
      return null;
  }
}

// ── Frame codec ──────────────────────────────────────────────────────────────

/**
 * Decodes one newline-delimited JSON frame. Returns null for anything that is
 * not a JSON object carrying a string `type` — a malformed frame must not take
 * the socket down, since the gateway would then reconnect into the same
 * failure and spin.
 */
export function decodeFrame(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const frame = parsed as Record<string, unknown>;
  return typeof frame.type === "string" ? frame : null;
}

/**
 * Encodes one frame for the wire.
 *
 * The trailing newline is REQUIRED, not cosmetic. The gateway's reader
 * accumulates chunks and does `*lines, buf = buf.split("\n")`, handling only
 * complete lines and keeping the remainder as a partial
 * (`gateway/relay/ws_transport.py` ~877). A frame sent without the newline is
 * never handled — it sits in that buffer, and the gateway hangs at handshake
 * waiting for a descriptor it has in fact already received. The gateway sends
 * `json.dumps(frame) + "\n"` for the same reason (~857).
 */
export function encodeFrame(frame: ConnectorFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Splits an inbound chunk into complete frames, returning any trailing partial
 * for the caller to prepend to the next chunk.
 *
 * The gateway sends one frame per WS message today, so a naive
 * one-message-one-frame reader happens to work. This does not rely on that:
 * the protocol is defined as newline-delimited over the socket, so two frames
 * coalesced into one message, or one frame split across two, are both legal
 * and would silently break a reader that assumed otherwise.
 */
export function splitFrames(chunk: string, carry = ""): { frames: string[]; carry: string } {
  const parts = (carry + chunk).split("\n");
  const trailing = parts.pop() ?? "";
  return { frames: parts.filter((line) => line.trim().length > 0), carry: trailing };
}

// ── Upgrade-token auth (§6.1) ────────────────────────────────────────────────

/**
 * Verifies the `Authorization: Bearer <token>` the gateway presents on the
 * `/relay` WebSocket upgrade.
 *
 * This is a byte-for-byte mirror of the gateway's `gateway/relay/auth.py`
 * (`verify_token`), which in turn mirrors the reference connector's
 * `relayAuthToken.ts`. Three implementations of one HMAC scheme is exactly the
 * shape that drifts silently, so the test suite pins it against vectors
 * generated by running the real Python.
 *
 *   token = base64url("<payload>:<exp>:<sig>")   (unpadded)
 *   sig   = HMAC_SHA256("<payload>:<exp>", secret) as lowercase hex
 *   exp   = unix seconds, 0 meaning never
 *
 * `secrets` is a verify LIST so a secret rotation does not invalidate tokens
 * already in flight. Returns the payload (the gateway id) or null.
 */
export function verifyUpgradeToken(token: string, secrets: readonly string[], nowSeconds?: number): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }

  // Split from the RIGHT: a payload may itself contain colons, and the gateway
  // ids in the wild do (`gw:with:colons` is in the conformance vectors).
  const parts = decoded.split(":");
  if (parts.length < 3) return null;
  const sig = parts[parts.length - 1] ?? "";
  const expRaw = parts[parts.length - 2] ?? "";
  const payload = parts.slice(0, -2).join(":");

  if (!/^\d+$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (exp !== 0 && now > exp) return null;

  return verifySignature(`${payload}:${exp}`, sig, secrets) ? payload : null;
}

/** Constant-time HMAC check against any secret in the rotation list. */
export function verifySignature(payload: string, sigHex: string, secrets: readonly string[]): boolean {
  if (!/^[0-9a-f]+$/i.test(sigHex) || sigHex.length === 0 || sigHex.length % 2 !== 0) return false;
  const provided = Buffer.from(sigHex, "hex");
  if (provided.length === 0) return false;

  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(payload, "utf8").digest();
    // Compare every candidate rather than returning on the first hit: an early
    // return leaks, through timing, WHICH secret in a rotation list matched.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) matched = true;
  }
  return matched;
}

/** Builds a token — used by the tests and by any local harness standing in for a gateway. */
export function makeUpgradeToken(payload: string, secret: string, ttlSeconds = 0): string {
  const exp = ttlSeconds > 0 ? Math.floor(Date.now() / 1000) + ttlSeconds : 0;
  const signed = `${payload}:${exp}`;
  const sig = createHmac("sha256", secret).update(signed, "utf8").digest("hex");
  return Buffer.from(`${signed}:${sig}`, "utf8").toString("base64url");
}
