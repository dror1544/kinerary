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
 *
 * Outbound actions are scoped to the caller's own chats: the gateway id from
 * the upgrade token (never a frame field) must own the chat the action names,
 * by the same rule inbound routing follows (`outbound-scope.ts`; spec
 * docs/specs/sprint-9/x-relay-chat-scope.md). A refused action has no side
 * effect and is answered `CHAT_NOT_IN_SCOPE` or `SCOPE_CHECK_FAILED`.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { chatKind, chatPlatformOf, digestTelegramId } from "../identity.js";
import { structuredLog } from "../redaction.js";
import { detectInternalLeak } from "./internal-leak.js";
import {
  CHAT_NOT_IN_SCOPE,
  SCOPE_CHECK_FAILED,
  outboundChatAllowed,
  type OutboundRouteKind,
  type ScopeRoute,
} from "./outbound-scope.js";
import { ExplicitTurns, silenceVerdict } from "./stay-silent.js";
import {
  decodeFrame,
  encodeFrame,
  splitFrames,
  parseOutboundAction,
  TELEGRAM_DESCRIPTOR,
  gatewayKeyMasterProblem,
  verifyUpgradeToken,
  type GatewayKeyMode,
  type OutboundResult,
  type WireMessageEvent,
} from "./protocol.js";
import { TIMEOUT_ERROR, type TelegramClient } from "./telegram-api.js";
import type { WhatsAppClient } from "./whatsapp/client.js";
import { PLATFORM_UNAVAILABLE, WhatsAppOutbound } from "./whatsapp/outbound.js";
import { BridgeStateTracker, WhatsAppMessageLedger } from "./whatsapp/state.js";

/**
 * What the gateway is told when a send or edit to Telegram TIMED OUT (#225,
 * round 2). Not the client's bare word "TIMEOUT": Hermes reads the error string
 * with its own classifier (gateway/platforms/base.py, `_is_timeout_error` and
 * `_is_retryable_error`), and "timeout" is neither - so it fell to the
 * plain-text fallback and re-sent the reply, prefixed "(Response formatting
 * failed, plain text:)". A timed-out send may well have been delivered, so the
 * family could see the reply twice. "timed out" is what Hermes reads as a
 * timeout - returned as-is, never retried, never re-sent, exactly as its own 30 s
 * "relay outbound timed out" was before - and the phrase carries none of its
 * retryable words ("network", "connecttimeout" and the rest). Fixed, like the
 * word it replaces: no URL, no token. Only the gateway sees it; the interview
 * reads the client's result directly and still gets a transient failure.
 *
 * Hermes' side of this is not copied here or in the tests: the two predicates'
 * substrings are captured from Hermes' source into
 * `test/fixtures/hermes-mirror.json` (scripts/capture-hermes-mirror.py, at the
 * revision `hermes-patches/BASE_REV` pins) and `test/hermes-mirror.test.ts`
 * (AC-1) fails if this phrase stops being a timeout, or becomes retryable, to
 * the captured classifier.
 */
export const GATEWAY_TIMEOUT_ERROR = "telegram call timed out";

/** The client's error, in words the gateway classifies correctly. */
function gatewayError(error: string | undefined, fallback: string): string {
  if (error === TIMEOUT_ERROR) return GATEWAY_TIMEOUT_ERROR;
  return error ?? fallback;
}
import type { ReplyObserver } from "../analytics/emitter.js";

/**
 * A `Content-Disposition` value that Node will actually accept.
 *
 * Node throws ERR_INVALID_CHAR for any non-ASCII byte in a header value, and
 * this header is built from a filename the ORGANIZER chose and Telegram
 * carried. On 2026-09-07 that was a Hebrew filename on an uploaded trip plan:
 * the throw happened inside the HTTP request handler, took the whole relay
 * process down, and the bot went silent mid-interview with nothing in the
 * interview logs to explain it — the failure was in the media plane, triggered
 * by the gateway fetching a document the organizer had uploaded successfully.
 *
 * RFC 6266 already answers this: `filename` is the ASCII-only fallback and
 * `filename*` carries the real name as percent-encoded UTF-8. Both are sent.
 *
 * Also strips the characters that would let a filename escape its own header —
 * quotes end the quoted-string early, CR/LF inject a header outright.
 */
export function contentDispositionFor(filename: string | undefined): string {
  const name = (filename ?? "").trim();
  if (!name) return "attachment";
  // The ASCII fallback: printable ASCII only, minus the quoting hazards.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const extended = encodeURIComponent(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${extended}`;
}

/** Close codes. 4401 is the contract's "unauthorized"; the gateway keys revocation off it. */
const CLOSE_UNAUTHORIZED = 4401;

// Generous next to any real frame (a descriptor is well under 1 KB, an inbound
// event a few KB), small enough that a peer sending an endless unterminated
// stream cannot exhaust memory.
const MAX_PARTIAL_FRAME_BYTES = 1_000_000;

const SCOPE_LOOKUP_TIMEOUT_MS = 5_000;

class ScopeLookupTimeout extends Error {}

export interface ConnectorOptions {
  /**
   * Re-host store for inbound attachments. Absent, `/relay/media/{id}` 404s —
   * which is the correct degraded behaviour for a connector that forwards no
   * media rather than a reason to fail startup.
   */
  mediaStore?: { get(id: string): { mime: string; bytes: Buffer; filename?: string } | null };
  /**
   * HMAC verify list for the upgrade token in `shared` and `both` mode
   * (`relay.gateway_secret_refs`). Multiple entries support rotation. Not
   * consulted in `derived` mode.
   */
  gatewaySecrets: readonly string[];
  /**
   * The derivation masters (`relay.gateway_key_master_refs`, #597 K1): what
   * `both` and `derived` derive per-gateway keys from. Required in those modes
   * (the constructor refuses without it) and never equal to a `gatewaySecrets`
   * entry: a derivation master is one no gateway profile has held.
   */
  gatewayKeyMasters?: readonly string[];
  /**
   * Which key a gateway signs with (`relay.gateway_key_mode`, #597 K1).
   * Absent is `shared`: a token is signed with a secret itself, as before. One
   * value for both bearer checks, the upgrade and the media plane, because two
   * settings would be two ways to leave one of them on the weaker scheme.
   */
  gatewayKeyMode?: GatewayKeyMode;
  /**
   * The gateway that receives turns no per-trip gateway serves.
   *
   * Under the per-trip architecture (`docs/per-trip-gateway-architecture.md`)
   * a gateway's authenticated id IS the Hermes profile it serves, and routing
   * is exact. This option exists for exactly one transitional reason: the
   * multiplexing gateway serves every profile from one process under one id,
   * so nothing it serves would ever match.
   *
   * Declared rather than inferred. A "if only one gateway is connected, send
   * it everything" rule would look equivalent and behave very differently the
   * moment the single connected gateway happened to be a trip's own — it would
   * hand that companion another trip's conversation. Naming the multiplexing
   * gateway makes the exception visible, auditable, and deletable: remove this
   * option when `multiplex_profiles` goes off and routing becomes strict with
   * no further change.
   */
  fallbackGatewayId?: string;
  telegram: TelegramClient;
  /**
   * The WhatsApp bridge's client (#625 S3), present only when the profile has a
   * `relay.whatsapp` block. The transport of an action is chosen from the chat's
   * BINDING ROW (`route.platform`), never from the frame: a WhatsApp chat with no
   * client here is refused `PLATFORM_UNAVAILABLE`, and no Telegram call is made.
   */
  whatsapp?: WhatsAppClient;
  /**
   * The open WhatsApp binding's real address for a chat alias (`transport_address`),
   * asked once per WhatsApp action after the scope check and never for a Telegram one.
   * Absent with a client: every WhatsApp action fails closed.
   */
  whatsappAddressOf?: (alias: string) => Promise<string | null>;
  /** Shared with the WhatsApp loop, so the two halves agree (edit targets, reply targets, one state line). */
  whatsappLedger?: WhatsAppMessageLedger;
  whatsappState?: BridgeStateTracker;
  port: number;
  host?: string;
  path?: string;
  log?: (line: string) => void;
  /**
   * Resolves a chat to its route (`resolveChatRoute`), once per outbound
   * action and never cached: it decides whether the calling gateway may act in
   * that chat at all (`outbound-scope.ts`), and whether the chat is
   * mid-interview and therefore one the agent may not write to directly.
   *
   * A function rather than a database handle on purpose: the connector's job is
   * the wire, and giving it a pool would make every relay test carry a schema.
   * Absent, every outbound action is refused (`SCOPE_CHECK_FAILED`): fail
   * closed, the direction inbound routing takes with no database.
   */
  resolveRoute?: (chatId: string) => Promise<ScopeRoute>;
  /**
   * `relay.interviewer_profile`: the id the interviewer's gateway may
   * authenticate under, allowed on interview chats alongside the declared
   * `fallbackGatewayId`. Unset, interview chats belong to the fallback gateway
   * alone.
   */
  interviewerProfile?: string;
  /**
   * How long the route lookup may take before the action is refused
   * (`SCOPE_CHECK_FAILED`). The gateway blocks on a result per frame, so a
   * database that accepts the connection and never answers must not leave it
   * waiting for its own timeout. Default 5 seconds.
   */
  scopeLookupTimeoutMs?: number;
  /**
   * Whether a Hermes profile has an open chat binding. Used for one thing only:
   * the `relay.gateway_identity_unmatched` warning when a gateway connects. It
   * never changes routing or any outbound decision. Absent, the warning is not
   * judged at all (nothing to compare a companion id against).
   */
  profileHasOpenBinding?: (profile: string) => Promise<boolean>;
  /**
   * Delivers an agent message on an interview chat through the router.
   *
   * A1 dropped these outright, and the 2026-09-05 run showed why that is the
   * wrong half of the rule: 17 refused sends against 3 `say_for_chat` calls.
   * The agent kept writing prose, the organizer silently got less
   * conversation, and — worse — a turn that produced nothing looked STALLED,
   * so the watchdog fired on every turn and re-asked the same question over
   * and over.
   *
   * Converting instead of dropping keeps the invariant that matters (the
   * router is still the only writer, and still owns the keyboard, the record
   * and the order) while removing the failure mode: nothing the agent says to
   * the organizer is lost, and a turn that spoke is not mistaken for a stall.
   */
  interviewSay?: (chatId: string, text: string) => Promise<boolean>;
  /**
   * Records whether the assistant's last companion (group) send expects a
   * reply, so the router's addressing gate can auto-capture the very next
   * message in that chat for one turn (migration 0053). `expects` mirrors
   * `SendAction.expectsReply`.
   *
   * Never called on an interview chat — that branch above returns before
   * reaching Telegram at all, so this option only ever sees companion sends.
   * A predicate/setter pair rather than a database handle, same reasoning as
   * `resolveRoute`/`interviewSay`: the connector's job is the wire.
   */
  setExpectsReply?: (chatId: string, expects: boolean) => Promise<void>;
  /**
   * Called after every companion send that reached Telegram, to renew the
   * per-person conversation window on the chat's binding (the member the
   * assistant is talking with keeps being heard without its name for five
   * minutes after its last message). Unlike `setExpectsReply` it does not
   * depend on whether the message was a question. Same failure rule: a write
   * error is logged and never turns a delivered message into a failure. Never
   * called on an interview chat.
   */
  renewConversation?: (chatId: string) => Promise<void>;
  /**
   * The relay's assistant-event emitter (#177), told what became of each
   * companion `send` once Telegram has answered. Synchronous and unable to
   * throw, so the reply's own result is never delayed by it. Absent — the
   * default — records nothing. Never called for an interview chat.
   */
  assistantEvents?: ReplyObserver;
}

export class RelayConnector {
  private readonly wss: WebSocketServer;
  private readonly http: Server;
  /**
   * Connected gateways, keyed by the Hermes profile each one serves.
   *
   * The key comes from the authenticated upgrade token, never from anything a
   * gateway says about itself in-band — same authority rule the tenant stamp
   * follows in `normalize.ts`. A Set per key rather than a single socket
   * because a restarting gateway can briefly overlap with itself, and dropping
   * the old socket early would lose the turn in flight on it.
   */
  private readonly gateways = new Map<string, Set<WebSocket>>();
  private readonly log: (line: string) => void;
  /** Which forwarded group turns named the assistant, so a silence reply to one is counted (stay-silent.ts). */
  private readonly explicitTurns = new ExplicitTurns();
  private readonly path: string;
  /** The WhatsApp transport, when a client is configured. */
  private readonly whatsapp: WhatsAppOutbound | null;

  constructor(private readonly options: ConnectorOptions) {
    // A connector in `both`/`derived` with no usable derivation master, or one
    // that equals a shared secret, would authenticate nothing it should: refuse
    // to be built (field names only, never a value).
    const masterProblem = gatewayKeyMasterProblem(
      options.gatewayKeyMode ?? "shared",
      options.gatewaySecrets,
      options.gatewayKeyMasters ?? [],
    );
    if (masterProblem) throw new Error(masterProblem);
    this.log = options.log ?? (() => {});
    this.path = options.path ?? "/relay";
    this.whatsapp = options.whatsapp
      ? new WhatsAppOutbound({
          client: options.whatsapp,
          addressOf: options.whatsappAddressOf ?? (async () => null),
          ledger: options.whatsappLedger ?? new WhatsAppMessageLedger(),
          state: options.whatsappState ?? new BridgeStateTracker(this.log),
          log: this.log,
        })
      : null;
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
          "content-disposition": contentDispositionFor(entry.filename),
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
      // The identity is re-derived rather than carried from authorizeUpgrade:
      // one place decides what a token means, and the routing key is that
      // decision rather than a copy of it.
      const gatewayId = this.bearerIdentity(request);
      if (!gatewayId) {
        socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, gatewayId));
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
    return verifyUpgradeToken(
      match[1],
      this.options.gatewaySecrets,
      undefined,
      this.options.gatewayKeyMode ?? "shared",
      this.options.gatewayKeyMasters ?? [],
    ) ?? null;
  }

  /** Gateway ids already warned about as matching no identity: once per id per process, not once per reconnect. */
  private readonly unmatchedWarned = new Set<string>();

  /**
   * A gateway whose id is neither an interviewer identity (`interviewerProfile`
   * or the declared multiplex id) nor a companion profile with an open binding
   * is logged once (`relay.gateway_identity_unmatched`, gateway id and a fixed
   * reason, no chat data). Observation only: it runs off the connection path,
   * never throws, and changes no routing. A failed lookup warns nothing, since
   * nothing can be concluded from it.
   */
  private async checkGatewayIdentity(gatewayId: string): Promise<void> {
    const lookup = this.options.profileHasOpenBinding;
    if (!lookup || this.unmatchedWarned.has(gatewayId)) return;
    if (gatewayId === this.options.interviewerProfile || gatewayId === this.options.fallbackGatewayId) return;
    try {
      if (await lookup(gatewayId)) return;
    } catch {
      return;
    }
    if (this.unmatchedWarned.has(gatewayId)) return;
    this.unmatchedWarned.add(gatewayId);
    this.log(structuredLog("warn", "relay.gateway_identity_unmatched", {
      gateway_id: gatewayId,
      reason: "matches_no_interviewer_identity_and_no_open_binding",
    }));
  }

  private onConnection(ws: WebSocket, gatewayId: string): void {
    void this.checkGatewayIdentity(gatewayId);
    let peers = this.gateways.get(gatewayId);
    if (!peers) {
      peers = new Set<WebSocket>();
      this.gateways.set(gatewayId, peers);
    }
    peers.add(ws);
    this.log(
      structuredLog("info", "relay.gateway_connected", {
        gateway_id: gatewayId,
        gateways: this.gateways.size,
        sockets: this.socketCount,
      }),
    );

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
      for (const frame of split.frames) void this.onFrame(ws, frame, gatewayId);
    });
    ws.on("close", () => {
      const set = this.gateways.get(gatewayId);
      set?.delete(ws);
      // Drop the empty key rather than leave it: `canReachProfile` answers off
      // this map, and a key with no sockets would report a stopped trip as
      // reachable — precisely the false healthy state migration 0042 exists to
      // stop us from reporting.
      if (set && set.size === 0) this.gateways.delete(gatewayId);
      this.log(
        structuredLog("info", "relay.gateway_disconnected", {
          gateway_id: gatewayId,
          gateways: this.gateways.size,
          sockets: this.socketCount,
        }),
      );
    });
    ws.on("error", (error) => {
      this.log(
        structuredLog("warn", "relay.socket_error", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
    });
  }

  private async onFrame(ws: WebSocket, raw: string, gatewayId: string): Promise<void> {
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
        await this.onOutbound(ws, frame, gatewayId);
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

  private async onOutbound(ws: WebSocket, frame: Record<string, unknown>, gatewayId: string): Promise<void> {
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
      result = await this.performAction(action, gatewayId);
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

  /**
   * `gatewayId` is the authenticated id closed over at connection, never
   * anything read from a frame. The scope check is the first thing here: a
   * refused action reaches no branch below, so it has no side effect.
   */
  private async performAction(
    action: ReturnType<typeof parseOutboundAction>,
    gatewayId: string,
  ): Promise<OutboundResult> {
    if (!action) return { success: false, error: "UNSUPPORTED_OP" };
    const scope = await this.checkScope(action, gatewayId);
    if (!scope.ok) return scope.result;
    const route = scope.route;
    const telegram = this.options.telegram;
    // The transport, from the binding row (checkScope has already refused a chat whose
    // id shape and row platform disagree). A WhatsApp chat on a relay with no WhatsApp
    // client is refused here, before any branch below, so no Telegram call is made.
    const whatsapp = route.kind === "companion" && route.platform === "whatsapp";
    if (whatsapp && !this.whatsapp) {
      this.log(structuredLog("warn", "relay.outbound_platform_unavailable", { op: action.op, platform: "whatsapp" }));
      return { success: false, error: PLATFORM_UNAVAILABLE };
    }
    switch (action.op) {
      case "send": {
        // Last gate before the organizer. See internal-leak.ts: the agent has
        // been told three times not to narrate its own plumbing and each new
        // model finds a new way to do it, so the check lives here rather than
        // in a prompt. Suppressed, not rewritten — a half-redacted sentence is
        // worse than a missing one.
        // TRACK 4 · one voice, one writer.
        //
        // On an interview chat the agent has exactly two ways to reach the
        // organizer — `say_for_chat` and `ask_question_for_chat` — and both go
        // through the router, which owns the keyboard, the record and the
        // order of things. Anything arriving here instead is the agent talking
        // past all of that, and six live runs say what that produces:
        // chain-of-thought narration, third-person commentary about "the
        // router", its own correction notes read back to the organizer,
        // option questions degraded to numbered lists, prose requests for an
        // approval no tool could act on, and two floods.
        //
        // Every one of those was a prompt rule first, and every prompt rule
        // failed live at least once. This is the same rule expressed where it
        // cannot be talked around.
        if (route.kind === "interview") {
          // The leak filter still applies, and still DROPS rather than
          // converts: a message naming field ids or tool names is one the
          // organizer must not read, whichever door it arrives through.
          const interviewLeak = detectInternalLeak(action.content);
          if (interviewLeak.leaks) {
            this.log(structuredLog("warn", "relay.internal_leak_suppressed", {
              matched: interviewLeak.term ?? "",
            }));
            return { success: true };
          }
          const converted =
            this.options.interviewSay
              ? await this.options.interviewSay(action.chat_id, action.content)
              : false;
          this.log(structuredLog("info", converted ? "relay.agent_send_converted" : "relay.agent_send_refused", {
            chat_id: action.chat_id,
            reason: converted ? "ROUTED_THROUGH_SAY" : "INTERVIEW_ROUTES_THROUGH_ROUTER",
            length: action.content.length,
          }));
          // Reported as delivered either way: the gateway's per-request future
          // has to resolve, and there is nothing here it could usefully retry.
          return { success: true };
        }

        // The companion chose not to answer a message in the conversation
        // window that was not meant for it (stay-silent.ts). Nothing goes to
        // Telegram, success goes back to the gateway (its per-request future has
        // to resolve), and NOTHING else changes: the conversation window is not
        // renewed and the "?" window is neither opened nor cleared, because the
        // companion said nothing. Booleans only in the log.
        const verdict = silenceVerdict(action.content);
        if (verdict.kind === "silent") {
          this.log(structuredLog("info", "trip_bot.companion_stayed_silent", { silent: true }));
          // Silence on a message that NAMED the assistant is a defect, not a
          // judgement call: nothing can be sent (no answer to invent), but it is
          // logged and recorded so the daily report counts it. Booleans only.
          const onAddressed = this.explicitTurns.wasExplicit(action.chat_id, action.reply_to);
          if (onAddressed) this.log(structuredLog("warn", "trip_bot.silence_on_addressed_turn", { silent: true }));
          this.options.assistantEvents?.replySent(
            action.chat_id, "suppressed", action.content.length, action.reply_to,
            onAddressed ? { silentOnAddressed: true } : undefined,
          );
          return { success: true };
        }
        const content = verdict.content;

        const leak = detectInternalLeak(content);
        if (leak.leaks) {
          this.log(structuredLog("warn", "relay.internal_leak_suppressed", {
            matched: leak.term ?? "",
          }));
          this.options.assistantEvents?.replySent(action.chat_id, "suppressed", content.length, action.reply_to);
          // Reported as delivered on purpose: the gateway's per-request future
          // has to resolve, and this is not a transport failure it could
          // usefully retry.
          return { success: true };
        }
        // A send that THROWS is a failed delivery too: recorded, then rethrown
        // untouched so onOutbound answers the gateway exactly as before. The
        // WhatsApp transport (chosen from the row above) converts its own dialect.
        const sent = whatsapp
          ? await this.whatsapp!.send(action.chat_id, content, action.reply_to).catch((error: unknown) => {
              this.options.assistantEvents?.replySent(action.chat_id, "failed", content.length, action.reply_to);
              throw error;
            })
          : await telegram.sendMessage({
          chatId: action.chat_id,
          // Agent-authored, so it is written in the dialect TELEGRAM_DESCRIPTOR
          // advertises. Sending it unparsed was why formatting arrived as
          // literal asterisks: we were announcing markdown_v2 and then not
          // honouring it.
          //
          // ...and announcing it while sending RAW was the other half. MarkdownV2
          // reserves the punctuation ordinary prose is made of, so a message with
          // a full stop in it is rejected whole, and telegram-api.ts's fallback
          // re-sends it with no parse_mode at all — words delivered, every link
          // dropped. Reported as "the link is not identified, it looks like plain
          // text". Escaping the prose and leaving the entities alone is what
          // makes the dialect we advertise true.
          //
          // THE ESCAPE BELONGS TO ONE LAYER, and it is telegram-api.ts:
          // `sendMessage` converts whenever parseMode is set. Escaping here as
          // well ran the converter twice, and \. became \\\., which Telegram
          // rejects as an entity — so the fallback fired and delivered the
          // FIRST escaping as plain text. Live on 2026-09-12: a companion's
          // message reached the organizer as "יש בעיה טכנית עם הדפדפן שלי\." and
          // a link written "japan\-2026\.ara\-united\.store". Raw here; the
          // dialect is honoured one layer down, once.
          text: content,
          replyTo: action.reply_to,
          parseMode: "MarkdownV2",
        }).catch((error: unknown) => {
          this.options.assistantEvents?.replySent(action.chat_id, "failed", content.length, action.reply_to);
          throw error;
        });
        this.options.assistantEvents?.replySent(
          action.chat_id, sent.ok ? "delivered" : "failed", content.length, action.reply_to,
        );
        // Only a message that actually reached Telegram may open (or clear) a
        // capture window — a failed send asked nothing, so nothing here
        // should change. A write failure is logged and swallowed: the send
        // itself already succeeded or failed on its own terms, and there is
        // nothing about this side-effect worth reporting a delivered message
        // as failed over.
        if (sent.ok && this.options.setExpectsReply) {
          try {
            await this.options.setExpectsReply(action.chat_id, action.expectsReply);
            // The "?" window is the only one of the two that was invisible: a
            // missed capture could not be told from a window that never opened.
            if (action.expectsReply) this.log(structuredLog("info", "relay.reply_window_opened", { expects: true }));
          } catch (error) {
            this.log(structuredLog("warn", "relay.expects_reply_write_failed", {
              safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
            }));
          }
        }
        // The per-person conversation window: every delivered companion send,
        // question or not, pushes its deadline out (a no-op unless a
        // conversation is open). Separate from the "?" window above on
        // purpose - a statement clears that one and must not touch this one.
        if (sent.ok && this.options.renewConversation) {
          try {
            await this.options.renewConversation(action.chat_id);
          } catch (error) {
            this.log(structuredLog("warn", "relay.conversation_renew_failed", {
              safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
            }));
          }
        }
        return sent.ok
          ? { success: true, message_id: sent.messageId }
          : { success: false, error: gatewayError(sent.error, "SEND_FAILED") };
      }
      case "edit": {
        // The sentinel must not reach the chat through an edit either (a
        // streaming reply edits a message into its final text). Silence on an
        // edit leaves the message as it stands.
        const editVerdict = silenceVerdict(action.content);
        if (editVerdict.kind === "silent") {
          this.log(structuredLog("info", "trip_bot.companion_stayed_silent", { silent: true }));
          return { success: true };
        }
        if (whatsapp) {
          const done = await this.whatsapp!.edit(action.chat_id, action.message_id, editVerdict.content);
          return done.ok ? { success: true } : { success: false, error: done.error };
        }
        const edited = await telegram.editMessageText({
          chatId: action.chat_id,
          messageId: action.message_id,
          // Same reason as `send`: an edit is agent prose too, and an edit that
          // fails to parse leaves the ORIGINAL message on screen, so the loss
          // is even quieter. Escaped once, by telegram-api.ts.
          text: editVerdict.content,
          parseMode: "MarkdownV2",
        });
        return edited.ok ? { success: true } : { success: false, error: gatewayError(edited.error, "EDIT_FAILED") };
      }
      case "typing":
        if (whatsapp) {
          const typed = await this.whatsapp!.typing(action.chat_id);
          return typed.ok ? { success: true } : { success: false, error: typed.error };
        }
        await telegram.sendChatAction({ chatId: action.chat_id });
        return { success: true };
      case "get_chat_info": {
        if (whatsapp) {
          const info = await this.whatsapp!.chatInfo(action.chat_id);
          return info.ok ? { success: true, name: info.name, type: info.type } : { success: false, error: info.error };
        }
        const info = await telegram.getChatInfo(action.chat_id);
        return info
          ? { success: true, name: info.name, type: info.type }
          : { success: false, error: "CHAT_NOT_FOUND" };
      }
    }
  }

  /**
   * Resolves the action's chat once and decides whether `gatewayId` may act in
   * it. Never throws: a failed or missing lookup is a refusal
   * (`SCOPE_CHECK_FAILED`), like every other input this cannot place.
   * One `relay.outbound_out_of_scope` line per refusal: the op, the gateway,
   * a digest of the chat (never the raw id) and whether it is a group or a
   * private chat, and the kind of route; never content, length, reply or
   * message ids, or a profile other than the caller's own.
   */
  private async checkScope(
    action: NonNullable<ReturnType<typeof parseOutboundAction>>,
    gatewayId: string,
  ): Promise<{ ok: true; route: ScopeRoute } | { ok: false; result: OutboundResult }> {
    const refuse = (error: string, routeKind: OutboundRouteKind | "lookup_failed", reason: string) => {
      // The chat is named by its digest (the form `CHAT_DIGEST_SQL` matches, so
      // a refusal can be traced to a chat in the database) and never by its raw
      // id, which is a person's identifier.
      this.log(structuredLog("warn", "relay.outbound_out_of_scope", {
        op: action.op,
        gateway_id: gatewayId,
        chat_ref: digestTelegramId(action.chat_id),
        chat_kind: chatKind(action.chat_id),
        route_kind: routeKind,
        reason,
      }));
      return { ok: false as const, result: { success: false as const, error } };
    };
    const resolveRoute = this.options.resolveRoute;
    if (!resolveRoute) return refuse(SCOPE_CHECK_FAILED, "lookup_failed", "no_route_resolver");
    let route: ScopeRoute;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ScopeLookupTimeout()), this.options.scopeLookupTimeoutMs ?? SCOPE_LOOKUP_TIMEOUT_MS);
      });
      route = await Promise.race([resolveRoute(action.chat_id), timedOut]);
    } catch (error) {
      return refuse(
        SCOPE_CHECK_FAILED,
        "lookup_failed",
        error instanceof ScopeLookupTimeout ? "route_lookup_timeout" : "route_lookup_failed",
      );
    } finally {
      clearTimeout(timer);
    }
    const verdict = outboundChatAllowed(route, gatewayId, {
      interviewerProfile: this.options.interviewerProfile,
      multiplexGatewayId: this.options.fallbackGatewayId,
    });
    if (!verdict.allowed) return refuse(CHAT_NOT_IN_SCOPE, verdict.routeKind, verdict.reason);
    // One chat id, one platform (spec 625, Chat ids): a WhatsApp alias never goes
    // through Telegram and a Telegram id never through WhatsApp. The row decides; an id
    // whose shape disagrees with its row is refused, whichever way round.
    const rowIsWhatsapp = route.kind === "companion" && route.platform === "whatsapp";
    const idIsWhatsapp = chatPlatformOf(action.chat_id) === "whatsapp";
    if (rowIsWhatsapp !== idIsWhatsapp) {
      return refuse(CHAT_NOT_IN_SCOPE, route.kind === "companion" ? "companion" : "unbound", "platform_mismatch");
    }
    return { ok: true, route };
  }

  /**
   * Pushes one normalized event to the gateway that serves its trip.
   *
   * Addressed, not broadcast. `source.profile` is the trip context decided by
   * `normalize.ts` from the chat binding, and under one-gateway-process-per-trip
   * it is also the destination: the profile a gateway serves is the identity it
   * authenticated as. Sending a turn to a gateway that serves a different trip
   * would put one family's conversation in front of another family's companion,
   * so a turn with no gateway of its own goes nowhere rather than everywhere.
   *
   * Returns whether it reached at least one socket. A `false` is significant:
   * the turn is lost, because nothing here queues. Buffered delivery is part
   * of the contract this connector does not implement yet, so the caller
   * should tell the organizer rather than leave them waiting on an answer that
   * will never come.
   */
  pushInbound(event: WireMessageEvent, turn?: { explicit?: boolean }): boolean {
    const profile = event.source.profile;
    const targets = this.socketsFor(profile);
    let delivered = false;
    for (const ws of targets) {
      if (ws.readyState !== ws.OPEN) continue;
      this.send(ws, { type: "inbound", event });
      delivered = true;
    }
    // Remembered only for a turn that reached a companion, and only when the
    // caller says what it was (a group turn): the companion's silence reply is
    // judged against it in performAction.
    if (delivered && turn && event.source.chat_id) {
      this.explicitTurns.note(event.source.chat_id, event.message_id, turn.explicit === true);
    }
    if (!delivered) {
      this.log(
        structuredLog("warn", "relay.inbound_undelivered", {
          chat_id_present: Boolean(event.source.chat_id),
          profile_present: Boolean(profile),
          gateways: this.gateways.size,
        }),
      );
    }
    return delivered;
  }

  /**
   * Whether a turn for this trip would reach a gateway right now.
   *
   * The router asks before it accepts a turn, so an organizer whose companion
   * is not running is told so instead of waiting on an answer that cannot come
   * (`COMPANION_PENDING`). This reads live socket state on purpose: a binding
   * row proves a companion was installed, never that it is serving.
   */
  canReachProfile(profile: string): boolean {
    for (const ws of this.socketsFor(profile)) {
      if (ws.readyState === ws.OPEN) return true;
    }
    return false;
  }

  /**
   * The sockets allowed to receive a turn for `profile`.
   *
   * Exact match first; the declared fallback gateway only when the trip has no
   * gateway of its own. An unstamped event resolves to nothing but the
   * fallback — with no trip context there is no correct destination to pick,
   * and picking one anyway is the mistake the stamp exists to prevent.
   */
  private socketsFor(profile: string | undefined): Iterable<WebSocket> {
    const own = profile ? this.gateways.get(profile) : undefined;
    if (own && own.size > 0) return own;
    const fallbackId = this.options.fallbackGatewayId;
    if (fallbackId) return this.gateways.get(fallbackId) ?? [];
    return [];
  }

  /** Open sockets across every connected gateway. */
  private get socketCount(): number {
    let total = 0;
    for (const peers of this.gateways.values()) total += peers.size;
    return total;
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
    for (const peers of this.gateways.values()) {
      for (const ws of peers) if (ws.readyState === ws.OPEN) open += 1;
    }
    return open;
  }

  /** The profiles with a gateway connected — the trips that are reachable. */
  get servedProfiles(): readonly string[] {
    return [...this.gateways.keys()];
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
    for (const peers of this.gateways.values()) for (const ws of peers) ws.close();
    this.gateways.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

export { CLOSE_UNAUTHORIZED };
