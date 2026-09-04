/**
 * The relay connector server — the socket the Hermes gateway dials OUT to.
 *
 * Per the contract, the gateway never listens; it initiates. So this is a
 * WebSocket SERVER at `/relay`, and the direction of the connection is the
 * reason a hosted or NAT'd gateway needs no inbound port at all.
 *
 * Lifecycle of one gateway link:
 *
 *   1. Gateway upgrades `/relay` with `Authorization: Bearer <token>`.
 *      Rejected with close code 4401 on a bad token — the code the gateway
 *      treats as a revocation once it has handshaked successfully before.
 *   2. Gateway sends `hello` (one per fronted identity).
 *   3. We answer each `hello` with a `descriptor`.
 *   4. We push `inbound` frames; the gateway sends `outbound` actions and we
 *      answer each with an `outbound_result` keyed by its `requestId`.
 *
 * The gateway blocks on a per-request future for every outbound action, so
 * **every `outbound` frame must get exactly one `outbound_result`**, including
 * for ops we do not implement. A missing result is not a dropped message; it
 * is a stalled gateway turn until its timeout.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { structuredLog } from "../redaction.js";
import { detectInternalLeak } from "./internal-leak.js";
import {
  decodeFrame,
  encodeFrame,
  splitFrames,
  parseOutboundAction,
  TELEGRAM_DESCRIPTOR,
  verifyUpgradeToken,
  type OutboundResult,
  type WireMessageEvent,
} from "./protocol.js";
import type { TelegramClient } from "./telegram-api.js";

/** Close codes. 4401 is the contract's "unauthorized"; the gateway keys revocation off it. */
const CLOSE_UNAUTHORIZED = 4401;

// Generous next to any real frame (a descriptor is well under 1 KB, an inbound
// event a few KB), small enough that a peer sending an endless unterminated
// stream cannot exhaust memory.
const MAX_PARTIAL_FRAME_BYTES = 1_000_000;

export interface ConnectorOptions {
  /**
   * Re-host store for inbound attachments. Absent, `/relay/media/{id}` 404s —
   * which is the correct degraded behaviour for a connector that forwards no
   * media rather than a reason to fail startup.
   */
  mediaStore?: { get(id: string): { mime: string; bytes: Buffer; filename?: string } | null };
  /** HMAC verify list for the upgrade token. Multiple entries support rotation. */
  gatewaySecrets: readonly string[];
  telegram: TelegramClient;
  port: number;
  host?: string;
  path?: string;
  log?: (line: string) => void;
}

export class RelayConnector {
  private readonly wss: WebSocketServer;
  private readonly http: Server;
  private readonly sockets = new Set<WebSocket>();
  private readonly log: (line: string) => void;
  private readonly path: string;

  constructor(private readonly options: ConnectorOptions) {
    this.log = options.log ?? (() => {});
    this.path = options.path ?? "/relay";
    this.http = createServer((req, res) => {
      // The media plane is the one HTTP surface here: the gateway GETs a
      // re-hosted attachment it was handed by reference on an inbound event.
      // Same bearer scheme as the WS upgrade (contract §"Inbound media"), so
      // an unauthenticated caller cannot read an organizer's document.
      const url = new URL(req.url ?? "/", "http://localhost");
      const media = /^\/relay\/media\/([0-9a-f]{32})$/.exec(url.pathname);
      if (media && req.method === "GET") {
        if (!this.authorizeBearer(req)) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
        const entry = this.options.mediaStore?.get(media[1]!);
        if (!entry) {
          // Unknown and expired are one answer on purpose: distinguishing them
          // would confirm that an id was once valid.
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, {
          "content-type": entry.mime || "application/octet-stream",
          "content-length": String(entry.bytes.length),
          ...(entry.filename
            ? { "content-disposition": `attachment; filename="${entry.filename.replace(/"/g, "")}"` }
            : {}),
        });
        res.end(entry.bytes);
        return;
      }
      // The relay endpoint is WS-only; a plain GET is a misconfiguration, not
      // a health check, so it should say so rather than 200.
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Upgrade required");
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (request, socket, head) => {
      if (!this.authorizeUpgrade(request)) {
        // Reject at the HTTP layer before the WS handshake completes; the
        // gateway reads this as a refused upgrade.
        socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        this.log(structuredLog("warn", "relay.upgrade_rejected", {}));
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== this.path) {
        socket.write(`HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws));
    });
  }

  /**
   * Verifies the `Authorization: Bearer` upgrade token (§6.1).
   *
   * The authenticated identity comes from the token payload alone. The
   * contract is explicit that the tenant must never be taken from the `hello`
   * frame, so nothing the gateway asserts about itself in-band is trusted
   * here.
   */
  private authorizeUpgrade(request: IncomingMessage): boolean {
    const gatewayId = this.bearerIdentity(request);
    if (!gatewayId) return false;
    this.log(structuredLog("info", "relay.gateway_authenticated", { gateway_id: gatewayId }));
    return true;
  }

  /** The media plane uses the same token scheme, without the connect log line. */
  private authorizeBearer(request: IncomingMessage): boolean {
    return this.bearerIdentity(request) !== null;
  }

  private bearerIdentity(request: IncomingMessage): string | null {
    const header = request.headers.authorization;
    if (typeof header !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) return null;
    return verifyUpgradeToken(match[1], this.options.gatewaySecrets) ?? null;
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    this.log(structuredLog("info", "relay.gateway_connected", { sockets: this.sockets.size }));

    // Newline-delimited over the socket, NOT one frame per WS message. The
    // gateway happens to send one per message today, but the protocol is
    // defined by the delimiter, so carry a partial across chunks rather than
    // assuming message boundaries line up with frame boundaries.
    let carry = "";
    ws.on("message", (raw) => {
      const split = splitFrames(String(raw), carry);
      carry = split.carry;
      // A peer that never sends a newline would otherwise grow this buffer
      // without bound. Drop the partial rather than accumulate it: the next
      // newline resynchronises the stream, and one lost frame beats unbounded
      // memory growth driven by whatever is on the other end of the socket.
      if (carry.length > MAX_PARTIAL_FRAME_BYTES) {
        this.log(structuredLog("warn", "relay.partial_frame_discarded", { bytes: carry.length }));
        carry = "";
      }
      for (const frame of split.frames) void this.onFrame(ws, frame);
    });
    ws.on("close", () => {
      this.sockets.delete(ws);
      this.log(structuredLog("info", "relay.gateway_disconnected", { sockets: this.sockets.size }));
    });
    ws.on("error", (error) => {
      this.log(
        structuredLog("warn", "relay.socket_error", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
    });
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    const frame = decodeFrame(raw);
    // A malformed frame must not close the socket: the gateway would redial
    // straight into the same failure and spin.
    if (!frame) {
      this.log(structuredLog("warn", "relay.malformed_frame", {}));
      return;
    }

    switch (frame.type) {
      case "hello":
        // One descriptor per hello — the gateway may front several identities
        // on one socket and resolves its handshake on the first descriptor.
        this.send(ws, { type: "descriptor", descriptor: TELEGRAM_DESCRIPTOR });
        return;
      case "outbound":
        await this.onOutbound(ws, frame);
        return;
      case "interrupt":
      case "going_idle":
      case "inbound_ack":
        // Accepted and ignored: none of these need an answer, and a connector
        // that closed on them would break a gateway that legitimately sends
        // them. Buffered delivery and scale-to-zero are not implemented.
        return;
      default:
        this.log(structuredLog("info", "relay.unknown_frame_type", { frame_type: String(frame.type) }));
        return;
    }
  }

  private async onOutbound(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const requestId = frame.requestId;
    if (typeof requestId !== "string") {
      // Without a requestId there is nothing to resolve, so this can only be
      // logged — answering would resolve some other request.
      this.log(structuredLog("warn", "relay.outbound_without_request_id", {}));
      return;
    }

    const action = parseOutboundAction(frame.action);
    if (!action) {
      // Unimplemented or malformed op. The gateway is blocked on this
      // requestId, so it gets an explicit failure rather than a timeout.
      this.send(ws, {
        type: "outbound_result",
        requestId,
        result: { success: false, error: "UNSUPPORTED_OP" },
      });
      return;
    }

    let result: OutboundResult;
    try {
      result = await this.performAction(action);
    } catch (error) {
      this.log(
        structuredLog("error", "relay.outbound_failed", {
          op: action.op,
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
      result = { success: false, error: "SEND_FAILED" };
    }
    this.send(ws, { type: "outbound_result", requestId, result });
  }

  private async performAction(action: ReturnType<typeof parseOutboundAction>): Promise<OutboundResult> {
    if (!action) return { success: false, error: "UNSUPPORTED_OP" };
    const telegram = this.options.telegram;
    switch (action.op) {
      case "send": {
        // Last gate before the organizer. See internal-leak.ts: the agent has
        // been told three times not to narrate its own plumbing and each new
        // model finds a new way to do it, so the check lives here rather than
        // in a prompt. Suppressed, not rewritten — a half-redacted sentence is
        // worse than a missing one.
        const leak = detectInternalLeak(action.content);
        if (leak.leaks) {
          this.log(structuredLog("warn", "relay.internal_leak_suppressed", {
            matched: leak.term ?? "",
          }));
          // Reported as delivered on purpose: the gateway's per-request future
          // has to resolve, and this is not a transport failure it could
          // usefully retry.
          return { success: true };
        }
        const sent = await telegram.sendMessage({
          chatId: action.chat_id,
          text: action.content,
          replyTo: action.reply_to,
          // Agent-authored, so it is written in the dialect TELEGRAM_DESCRIPTOR
          // advertises. Sending it unparsed was why formatting arrived as
          // literal asterisks: we were announcing markdown_v2 and then not
          // honouring it.
          parseMode: "MarkdownV2",
        });
        return sent.ok
          ? { success: true, message_id: sent.messageId }
          : { success: false, error: sent.error ?? "SEND_FAILED" };
      }
      case "edit": {
        const edited = await telegram.editMessageText({
          chatId: action.chat_id,
          messageId: action.message_id,
          text: action.content,
          parseMode: "MarkdownV2",
        });
        return edited.ok ? { success: true } : { success: false, error: edited.error ?? "EDIT_FAILED" };
      }
      case "typing":
        await telegram.sendChatAction({ chatId: action.chat_id });
        return { success: true };
      case "get_chat_info": {
        const info = await telegram.getChatInfo(action.chat_id);
        return info
          ? { success: true, name: info.name, type: info.type }
          : { success: false, error: "CHAT_NOT_FOUND" };
      }
    }
  }

  /**
   * Pushes one normalized event to the connected gateway(s).
   *
   * Returns whether it reached at least one socket. A `false` is significant:
   * the turn is lost, because nothing here queues. Buffered delivery is part
   * of the contract this connector does not implement yet, so the caller
   * should tell the organizer rather than leave them waiting on an answer that
   * will never come.
   */
  pushInbound(event: WireMessageEvent): boolean {
    let delivered = false;
    for (const ws of this.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      this.send(ws, { type: "inbound", event });
      delivered = true;
    }
    if (!delivered) {
      this.log(
        structuredLog("warn", "relay.inbound_undelivered", { chat_id_present: Boolean(event.source.chat_id) }),
      );
    }
    return delivered;
  }

  private send(ws: WebSocket, frame: Parameters<typeof encodeFrame>[0]): void {
    try {
      ws.send(encodeFrame(frame));
    } catch (error) {
      this.log(
        structuredLog("warn", "relay.send_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
    }
  }

  get connectedGateways(): number {
    let open = 0;
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) open += 1;
    return open;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.http.listen(this.options.port, this.options.host ?? "127.0.0.1", () => resolve());
    });
    this.log(
      structuredLog("info", "relay.listening", { port: this.options.port, path: this.path }),
    );
  }

  /** The bound port — useful when the caller asked for port 0. */
  get address(): number | null {
    const addr = this.http.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

export { CLOSE_UNAUTHORIZED };
