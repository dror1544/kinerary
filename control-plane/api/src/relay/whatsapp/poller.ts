/**
 * The WhatsApp inbound loop (spec 625, S3: AC-20 to AC-28, AC-32).
 *
 * The bridge sidecar holds the WhatsApp connection; this loop long-polls it
 * (`WhatsAppClient.poll`), and for each event decides what the relay does, through
 * the SAME companion gate a Telegram message goes through (companion-gate.ts). It is
 * started only when the profile has a `relay.whatsapp` block (server.ts); absent, none
 * of this runs and nothing connects to a bridge (AC-20).
 *
 * ONE MESSAGE, IN ORDER (each step is a reason the next one may not run):
 *
 *   1. The number's own messages are dropped: `fromMe`, or a sender that is one of the
 *      number's own ids from `/health`. Never the bridge's flags alone.
 *   2. The chat's alias is computed: a group from its real id (accepted shapes only,
 *      old groups included), a private chat from its sender's canonical id. Group or
 *      private is read off the ALIAS (`chatKind`), not off anything the bridge says.
 *   3. @mentions are rewritten BEFORE the text is used for anything: the number's own
 *      becomes the assistant's name, anyone else's "someone" (Sender ids). From here on
 *      no id or number is in the text.
 *   4. A command is dropped (AC-25): there is no router command on WhatsApp.
 *   5. A code attempt goes to the code path (AC-8 to AC-12), in any chat, bound or not:
 *      a `me` code rebinds a bound private chat, a `group` code in a group bound to the
 *      same trip is answered "already connected". A code never reaches a companion.
 *   6. An unbound chat: dropped, with no reply and no model (AC-21). The traveller
 *      exchange of AC-29 is S3c's; `unboundPrivateMessage` is where it attaches.
 *   7. A bound chat whose trip has the switch off: dropped (AC-22). A private chat
 *      whose person link's membership has ended: closed and dropped (AC-14).
 *   8. Everything else goes to `companionGate`, and its decision is applied here.
 *
 * WHAT THE RELAY SAYS BY ITSELF (spec, "complete list"): the fixed line answering a code,
 * the group introduction, and the owner's notice. The gate's own `reply` decisions (the
 * companion-pending and companion-unavailable lines) and Telegram's "gateway unavailable"
 * notice are NOT on that list, so on WhatsApp they are withheld and logged.
 *
 * NOTHING IDENTIFYING IS LOGGED. Log lines carry reason codes, counts and booleans; never
 * a chat id, an alias, a sender, a name, a title or text.
 *
 * THE WIRE. The event's `source.platform` is the gateway's PRIMARY platform
 * ("telegram"), never "whatsapp": AC-0 found that a "whatsapp" stamp makes Hermes run
 * the `wa_` alias through its own WhatsApp id canonicaliser, which raises and drops the
 * relay socket. The relay alone knows a chat is WhatsApp, from the binding row.
 */
import type pg from "pg";
import { parseInbound } from "../../chat-router.js";
import {
  CodeAttemptLimiter,
  WHATSAPP_SWITCH,
  cleanChatText,
  closeIfMembershipEnded,
  composeWhatsAppGroupIntroduction,
  extractChatBindingCode,
  handleCodeMessage,
  notifyOwnersOfNewBinding,
  resolveWhatsAppPerson,
  type ReplacedConnection,
} from "../../chat-binding-codes.js";
import { featureEnabled } from "../../feature-switches.js";
import { chatKind, isAcceptedWhatsAppGroupId, whatsappChatAlias, whatsappOpaqueId } from "../../identity.js";
import { structuredLog } from "../../redaction.js";
import type { InboundFacts } from "../../analytics/relay-facts.js";
import { companionGate, type GateDecision, type GateDeps, type GateOutcome, type InboundTurn, type MediaStore } from "../companion-gate.js";
import { GroupContext } from "../group-context.js";
import type { GroupJudge, JudgeOutcome } from "../group-judge.js";
import { resolveInbound } from "../normalize.js";
import { PendingAttachments, type AttachmentRef } from "../pending-attachments.js";
import type { WireMessageEvent } from "../protocol.js";
import { bindGroupByAdding } from "./add-to-bind.js";
import { updateWhatsAppGroupTitle, whatsappAddressOf } from "./bindings.js";
import {
  GROUP_REAL_ID,
  MESSAGE_ID,
  PERSON_REAL_ID,
  type BridgeAddedToGroup,
  type BridgeEvent,
  type BridgeMessage,
  type BridgeParticipantLeft,
  type PollCursor,
  type WhatsAppClient,
} from "./client.js";
import { sendFixedText } from "./outbound.js";
import { BridgeStateTracker, WhatsAppMessageLedger } from "./state.js";

/**
 * The platform the relay stamps on a WhatsApp turn: the gateway's PRIMARY one (AC-0).
 * A constant, so a test can pin it and nobody "fixes" it to "whatsapp".
 */
export const WHATSAPP_WIRE_PLATFORM = "telegram";

/** What the loop needs of the connector: the same two calls the Telegram poller uses. */
export interface WhatsAppInboundSink {
  pushInbound(event: WireMessageEvent, turn?: { explicit?: boolean }): boolean;
  canReachProfile?(profile: string): boolean;
}

/** What the loop records for assistant events (#177), when recording is on. */
export interface WhatsAppAssistantEvents {
  handedOff(chatKey: string, facts: InboundFacts, delivered: boolean, messageId?: string): void;
  notAddressed(facts: InboundFacts): void;
  companionUnreachable(chatKey: string, facts: InboundFacts): void;
}

/**
 * S3c's hook (AC-29, travellers connecting from the group): called for a PRIVATE message
 * from a chat with no open binding that is not a code attempt. Returns whether it took the
 * message. Absent in S3b: such a message is dropped (AC-21).
 */
export type UnboundPrivateMessageHook = (input: {
  alias: string;
  senderId: string;
  /** The person's real address, in memory, for the one reply the exchange may send. */
  address: string;
  text: string;
}) => Promise<boolean>;

export interface WhatsAppLoopDeps {
  db: pg.Pool;
  client: WhatsAppClient;
  /** The sender-id key (`relay.whatsapp.sender_id_secret_ref`), at least 32 bytes. */
  senderKey: string | Buffer;
  connector: WhatsAppInboundSink;
  ledger: WhatsAppMessageLedger;
  state: BridgeStateTracker;
  /** One per process: failed code attempts are counted per chat, in memory (AC-12). */
  codeLimiter: CodeAttemptLimiter;
  log?: (line: string) => void;
  pendingAttachments?: PendingAttachments;
  groupContext?: GroupContext;
  groupJudge?: GroupJudge;
  /** The media plane the gateway fetches re-hosted attachments from. Absent: text only. */
  media?: { store: MediaStore; baseUrl: string; log?: (line: string) => void };
  assistantEvents?: WhatsAppAssistantEvents;
  outageNotices?: { allow(chatId: string): boolean };
  /** The gate's fixed pending text. Never SENT on WhatsApp (see the header); the gate needs a value. */
  companionPendingText?: string;
  unboundPrivateMessage?: UnboundPrivateMessageHook;
}

export interface WhatsAppLoopOptions {
  /** How long one long-poll waits at the bridge. */
  waitMs?: number;
  /** The longest pause between failed attempts. */
  maxBackoffMs?: number;
  /** The first pause after a failure. */
  minBackoffMs?: number;
}

/** What one message handler run is told, beyond the message. */
interface PassOptions {
  /** Park a judge call on the chat's lane instead of awaiting it. */
  defer: boolean;
  /** The verdict, on the second pass of a deferred judgement. */
  judgedOutcome?: JudgeOutcome | null;
}

// ── Text that must never carry an id ──────────────────────────────────────────────────

const DIGITS_OF = (id: string) => id.slice(0, id.indexOf("@"));

/**
 * Rewrites every @mention in WhatsApp text (spec, Sender ids): each listed id's token,
 * the number's own in either form, and any other `@` followed by seven or more digits.
 * The number's own becomes `ownName`; anyone else's "someone". Pure; never throws.
 */
export function rewriteMentions(
  text: string,
  mentionedIds: readonly string[],
  ownIds: ReadonlySet<string>,
  ownName: string,
): string {
  if (!text.includes("@")) return text;
  const replacement = new Map<string, string>();
  for (const id of mentionedIds) {
    const digits = DIGITS_OF(id);
    if (/^[0-9]+$/.test(digits)) replacement.set(digits, ownIds.has(id) ? ownName : "someone");
  }
  for (const id of ownIds) {
    const digits = DIGITS_OF(id);
    if (/^[0-9]+$/.test(digits)) replacement.set(digits, ownName);
  }
  return text.replace(/@\+?([0-9]+)/g, (whole, digits: string) => {
    const known = replacement.get(digits);
    if (known !== undefined) return known;
    return digits.length >= 7 ? "someone" : whole;
  });
}

/**
 * A sender's display name as the companion may see it: one clean line, and EMPTY rather
 * than a number (a WhatsApp name a person never set is often their number written out).
 */
export function whatsappSenderName(raw: string | null | undefined): string | null {
  const cleaned = cleanChatText(raw, 64);
  if (!cleaned) return null;
  if ((cleaned.match(/[0-9]/g)?.length ?? 0) >= 7) return null;
  if (/@/.test(cleaned) && /[0-9]{5,}/.test(cleaned)) return null;
  return cleaned;
}

// ── The loop ──────────────────────────────────────────────────────────────────────────

export interface WhatsAppLoop {
  stop(): void;
  /** Resolves once the loop has a cursor: from then on, every event the bridge buffers is read. */
  ready: Promise<void>;
  /** Resolves when every lane (parked judge calls and what queued behind them) is empty. For tests. */
  settled(): Promise<void>;
  /** Handles one event as the loop would (for tests that drive the stand-in step by step). */
  handle(event: BridgeEvent): Promise<void>;
}

export function startWhatsAppLoop(deps: WhatsAppLoopDeps, options: WhatsAppLoopOptions = {}): WhatsAppLoop {
  const log = deps.log ?? (() => {});
  const handler = new WhatsAppEventHandler(deps);
  const waitMs = options.waitMs ?? 25_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const minBackoffMs = options.minBackoffMs ?? 1_000;
  const abort = new AbortController();
  let stopped = false;
  let backoffMs = 0;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  const fail = async () => {
    backoffMs = backoffMs === 0 ? minBackoffMs : Math.min(backoffMs * 2, maxBackoffMs);
    await sleep(backoffMs);
  };

  async function run(): Promise<void> {
    let cursor: PollCursor = {};
    let knowOwnIds = false;
    log(structuredLog("info", "whatsapp.loop_started", { wait_ms: waitMs }));
    while (!stopped) {
      if (!knowOwnIds) {
        const health = await deps.client.health();
        if (stopped) break;
        if (!health.ok) {
          deps.state.observe(health.state ?? "unavailable", "health");
          await fail();
          continue;
        }
        handler.setOwnIds([health.value.own.lid, health.value.own.phone]);
        // Not connected (logged out, pairing, reconnecting): nothing to read. Ask again.
        // "Connected" itself is said only after a poll has worked (below), so a bridge
        // whose health answers while its message feed fails does not flap the state line.
        if (health.value.state !== "connected") {
          deps.state.observe(health.value.state, "health");
          await fail();
          continue;
        }
        knowOwnIds = true;
      }
      const batch = await deps.client.poll(cursor, { waitMs, signal: abort.signal });
      if (stopped) break;
      if (!batch.ok) {
        deps.state.observe(batch.state ?? "unavailable", "poll");
        knowOwnIds = false;
        await fail();
        continue;
      }
      backoffMs = 0;
      // A poll that answers proves the bridge is reachable, not that WhatsApp is
      // connected (a logged-out bridge still answers). While the last word was not
      // "connected", the bridge's own state is asked for, so a recovery is said once
      // and an outage is never "recovered" by a reachable but logged-out bridge.
      if (!deps.state.connected) {
        const health = await deps.client.health();
        if (health.ok) handler.setOwnIds([health.value.own.lid, health.value.own.phone]);
        deps.state.observe(health.ok ? health.value.state : health.state ?? "unavailable", "health");
      }
      const b = batch.value;
      if (cursor.epoch !== undefined && b.epoch !== cursor.epoch) {
        // The bridge restarted: its numbering began again, and the number's own ids are
        // read again before the next batch is handled.
        log(structuredLog("warn", "whatsapp.bridge_restarted", {}));
        knowOwnIds = false;
      }
      if (b.lost || b.malformed || b.ignored) {
        log(structuredLog("warn", "whatsapp.events_not_handled", { lost: b.lost, malformed: b.malformed, ignored: b.ignored }));
      }
      cursor = { after: b.lastSeq, epoch: b.epoch };
      markReady();
      if (!knowOwnIds && b.events.length > 0) {
        // Own ids first, then this batch: an own message must never be read as someone else's.
        const health = await deps.client.health();
        if (health.ok) {
          handler.setOwnIds([health.value.own.lid, health.value.own.phone]);
          knowOwnIds = health.value.state === "connected";
        }
      }
      for (const event of b.events) {
        if (stopped) break;
        await handler.dispatch(event);
      }
      // A macrotask between polls, so a stand-in that answers at once cannot starve timers.
      if (!stopped && !b.more) await sleep(0);
    }
    log(structuredLog("info", "whatsapp.loop_stopped", {}));
  }

  void run().catch((error) => {
    log(structuredLog("error", "whatsapp.loop_crashed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
  });

  return {
    stop() {
      stopped = true;
      abort.abort();
    },
    ready,
    settled: () => handler.settled(),
    handle: (event) => handler.dispatch(event),
  };
}

// ── One event ─────────────────────────────────────────────────────────────────────────

class WhatsAppEventHandler {
  private ownIds = new Set<string>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly log: (line: string) => void;
  private readonly pendingAttachments: PendingAttachments;
  private readonly groupContext: GroupContext;
  private readonly outageNotices: { allow(chatId: string): boolean };

  constructor(private readonly deps: WhatsAppLoopDeps) {
    this.log = deps.log ?? (() => {});
    this.pendingAttachments = deps.pendingAttachments ?? new PendingAttachments();
    this.groupContext = deps.groupContext ?? new GroupContext();
    // Never consulted for a SEND on WhatsApp (the gate's reply is withheld), but the gate asks.
    this.outageNotices = deps.outageNotices ?? { allow: () => true };
  }

  setOwnIds(ids: ReadonlyArray<string | null>): void {
    this.ownIds = new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0));
  }

  private drop(reason: string): void {
    this.log(structuredLog("info", "whatsapp.inbound_dropped", { reason }));
  }

  /**
   * One chat at a time, as the Telegram poller serialises a chat: a chat whose judge call
   * is out holds its later events behind it; every other chat goes straight on.
   */
  async dispatch(event: BridgeEvent): Promise<void> {
    const lane = event.chatId;
    if (this.lanes.has(lane)) {
      this.enqueue(lane, () => this.handle(event, { defer: false }));
      return;
    }
    this.inFlight += 1;
    try {
      await this.handle(event, { defer: true });
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Events being handled on the loop itself right now (not parked on a lane). */
  private inFlight = 0;

  private enqueue(lane: string, work: () => Promise<void>): void {
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next: Promise<void> = previous.then(work).catch(() => {}).then(() => {
      if (this.lanes.get(lane) === next) this.lanes.delete(lane);
    });
    this.lanes.set(lane, next);
  }

  async settled(): Promise<void> {
    while (this.lanes.size > 0 || this.inFlight > 0) {
      if (this.lanes.size > 0) await Promise.all([...this.lanes.values()]);
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async handle(event: BridgeEvent, pass: PassOptions): Promise<void> {
    try {
      switch (event.type) {
        case "message": return await this.message(event, pass);
        case "added_to_group": return await this.added(event);
        case "title_changed": {
          if (!isAcceptedWhatsAppGroupId(event.chatId)) return this.drop("BAD_CHAT_ID");
          const alias = whatsappChatAlias(this.deps.senderKey, event.chatId, "group");
          const changed = await updateWhatsAppGroupTitle(this.deps.db, alias, event.title);
          this.log(structuredLog("info", "whatsapp.group_title_changed", { bound: changed }));
          return;
        }
        case "participant_left": return this.left(event);
      }
    } catch (error) {
      this.log(structuredLog("error", "whatsapp.event_failed", {
        type: event.type,
        safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
      }));
    }
  }

  /**
   * A participant left a group. When it is the number itself the spec says nothing about
   * the binding ("Leaving the group is a later slice", Non-goals), so nothing is closed:
   * the state is logged for the operator. Anyone else is S3c's (AC-30).
   */
  private left(event: BridgeParticipantLeft): void {
    const self = this.ownIds.has(event.participantId);
    this.log(structuredLog(self ? "warn" : "info", "whatsapp.participant_left", {
      self,
      ...(self ? { effect: "binding left open; remove it on the trip's WhatsApp page" } : {}),
    }));
  }

  // ── added_to_group (AC-28) ──

  private async added(event: BridgeAddedToGroup): Promise<void> {
    const { db, senderKey, client } = this.deps;
    if (!isAcceptedWhatsAppGroupId(event.chatId)) return this.drop("BAD_CHAT_ID");
    const alias = whatsappChatAlias(senderKey, event.chatId, "group");
    const adder = event.addedBy && PERSON_REAL_ID.test(event.addedBy) ? whatsappOpaqueId(senderKey, event.addedBy) : null;
    let title = cleanChatText(event.title);
    if (!title && adder) {
      const info = await client.chatInfo(event.chatId);
      if (info.ok && info.value.kind === "group") title = cleanChatText(info.value.title);
    }
    const result = await bindGroupByAdding(db, { groupAlias: alias, groupRealId: event.chatId, adderId: adder, title, log: this.log });
    this.log(structuredLog("info", "whatsapp.added_to_group", result.bound ? { bound: true } : { bound: false, reason: result.reason }));
    if (!result.bound) return;
    await this.introduce(alias, event.chatId, result.tripId);
    await this.notifyOwners(result.bindingId, null);
  }

  // ── message ──

  private async message(m: BridgeMessage, pass: PassOptions): Promise<void> {
    const { db, senderKey } = this.deps;
    // 1. The number's own messages, by either flag or id.
    if (m.fromMe || (m.senderId !== null && this.ownIds.has(m.senderId))) return this.drop("OWN_MESSAGE");

    // 2. The alias, and group or private from its shape.
    let alias: string;
    if (GROUP_REAL_ID.test(m.chatId)) {
      if (!isAcceptedWhatsAppGroupId(m.chatId)) return this.drop("BAD_CHAT_ID");
      alias = whatsappChatAlias(senderKey, m.chatId, "group");
    } else {
      // A private chat's address is its person; a sender the bridge could not resolve, or
      // one that is not the chat's own person, is not a sender this relay can name.
      if (m.senderId === null || m.senderId !== m.chatId) return this.drop("PRIVATE_SENDER_UNRESOLVED");
      alias = whatsappChatAlias(senderKey, m.senderId, "private");
    }
    const kind = chatKind(alias);
    if (kind === "unknown") return this.drop("BAD_CHAT_ID");
    const senderId = m.senderId === null ? null : whatsappOpaqueId(senderKey, m.senderId);
    const messageIdOk = MESSAGE_ID.test(m.messageId);
    if (messageIdOk) this.deps.ledger.noteSeen(alias, m.messageId);

    const resolution = await resolveInbound(db, alias, this.deps.connector.canReachProfile
      ? (profile) => this.deps.connector.canReachProfile!(profile)
      : undefined);
    const route = resolution.kind === "routed" ? resolution.route : resolution.route;
    const assistantNames = route?.kind === "companion" ? route.assistantNames : [];
    const ownName = assistantNames.map((n) => n.trim()).find(Boolean) ?? "the assistant";

    // 3. Mentions, before the text is used for anything.
    const text = rewriteMentions(m.text, m.mentionedIds, this.ownIds, ownName);
    const quotedText = m.quotedText === undefined ? undefined : rewriteMentions(m.quotedText, m.mentionedIds, this.ownIds, ownName);

    // Media is remembered (metadata only, nothing downloaded) so a later reply can bring it (AC-26).
    const attachment: AttachmentRef | null = m.media && messageIdOk
      ? { fileId: m.messageId, kind: m.media.kind, mime: m.media.mime || "application/octet-stream", ...(m.media.filename ? { filename: m.media.filename } : {}) }
      : null;
    if (attachment) {
      this.deps.ledger.noteMedia(alias, {
        messageId: m.messageId, kind: attachment.kind, mime: attachment.mime, senderId,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        ...(text ? { caption: text } : {}),
      });
    }

    // 4. Commands (AC-25).
    if (parseInbound(text).kind !== "text") return this.drop("COMMAND");

    // 5. Codes, in any chat (AC-8 to AC-12). Never forwarded.
    if (extractChatBindingCode(text) !== null) return this.code(m, alias, kind, senderId, text);

    // 6. Unbound (AC-21).
    if (resolution.kind === "dropped" && resolution.reason === "UNROUTED") {
      if (kind === "private" && senderId && this.deps.unboundPrivateMessage) {
        const taken = await this.deps.unboundPrivateMessage({ alias, senderId, address: m.chatId, text });
        if (taken) return;
      }
      return this.drop("UNROUTED");
    }
    if (resolution.kind === "dropped" && resolution.reason === "INTERVIEW") return this.drop("INTERVIEW");
    if (!route || route.kind !== "companion" || route.platform !== "whatsapp") return this.drop("PLATFORM_MISMATCH");

    // 7. The switch (AC-22), then a private chat whose membership has ended (AC-14).
    if (!(await featureEnabled(db, route.tripId, WHATSAPP_SWITCH, this.log))) return this.drop("SWITCHED_OFF");
    if (kind === "private" && (await closeIfMembershipEnded(db, alias)).closed) {
      this.log(structuredLog("info", "whatsapp.membership_ended_closed", {}));
      return this.drop("MEMBERSHIP_ENDED");
    }
    if (!text.trim() && !attachment) return this.drop("NO_TEXT");

    // 8. The gate.
    const turn = this.turnOf(m, alias, kind === "group" ? "group" : "dm", senderId, text, quotedText, attachment);
    const outcome: GateOutcome = resolution.kind === "routed"
      ? { kind: "event", event: this.eventOf(turn, resolution.route.hermesProfile), route: resolution.route }
      : { kind: "dropped", reason: resolution.reason, ...(resolution.route ? { route: resolution.route } : {}) };
    const decision = await companionGate(turn, outcome, this.gateDeps(m.chatId, pass));
    await this.apply(decision, m, alias);
  }

  private turnOf(
    m: BridgeMessage,
    alias: string,
    chatType: "group" | "dm",
    senderId: string | null,
    text: string,
    quotedText: string | undefined,
    attachment: AttachmentRef | null,
  ): InboundTurn {
    const { ledger, senderKey } = this.deps;
    const quotedId = m.quotedMessageId;
    const quotedBy = m.quotedParticipant ? whatsappOpaqueId(senderKey, m.quotedParticipant) : undefined;
    const isReplyToAssistant = (m.quotedParticipant !== undefined && this.ownIds.has(m.quotedParticipant)) || ledger.sentHere(alias, quotedId);
    const remembered = ledger.mediaOf(alias, quotedId);
    const repliedToSenderId = quotedBy ?? remembered?.senderId ?? undefined;
    return {
      platform: "whatsapp",
      chatId: alias,
      chatType,
      // The words analytics' channel classification reads (channelTypeOf).
      rawChatType: chatType === "group" ? "group" : "private",
      chatName: null,
      senderId,
      senderName: whatsappSenderName(m.senderName),
      text,
      ...(attachment && text ? { caption: text } : {}),
      messageId: m.messageId,
      ...(quotedId ? { replyToMessageId: quotedId } : {}),
      isReplyToAssistant,
      ...(repliedToSenderId ? { repliedToSenderId } : {}),
      ...(quotedText ? { repliedToText: quotedText } : {}),
      attachment,
      repliedToAttachment: remembered
        ? {
            fileId: remembered.messageId, kind: remembered.kind, mime: remembered.mime,
            ...(remembered.filename ? { filename: remembered.filename } : {}),
            ...(remembered.caption ? { caption: remembered.caption } : {}),
          }
        : null,
    };
  }

  /** The wire event, stamped with the gateway's primary platform (AC-0), the alias and the opaque sender. */
  private eventOf(turn: InboundTurn, profile: string): WireMessageEvent {
    return {
      text: turn.text,
      message_type: "text",
      source: {
        platform: WHATSAPP_WIRE_PLATFORM,
        chat_id: turn.chatId,
        chat_type: turn.chatType,
        chat_name: null,
        user_id: turn.senderId,
        user_name: turn.senderName,
        thread_id: null,
        chat_topic: null,
        profile,
      },
      message_id: turn.messageId,
      reply_to_message_id: turn.replyToMessageId,
    };
  }

  private gateDeps(realChatId: string, pass: PassOptions): GateDeps {
    const { db, client, media, groupJudge, state } = this.deps;
    return {
      db,
      log: this.log,
      resolvePerson: (tripId, senderId) => resolveWhatsAppPerson(db, tripId, senderId),
      // Only ever called by the gate's re-host, which runs only for a turn that is going
      // to the companion (AC-26). The reference is the message id in THIS chat.
      fetchAttachment: async (ref, maxBytes) => {
        const fetched = await client.fetchMedia(realChatId, ref, { maxBytes });
        if (!fetched.ok) {
          if (fetched.reason === "unavailable") state.observe(fetched.state ?? "unavailable", "outbound");
          return null;
        }
        return { bytes: fetched.value.bytes, mime: fetched.value.mime };
      },
      ...(media ? { mediaStore: media.store, mediaBaseUrl: media.baseUrl, ...(media.log ? { mediaLog: media.log } : {}) } : {}),
      pendingAttachments: this.pendingAttachments,
      groupContext: this.groupContext,
      ...(groupJudge ? { groupJudge } : {}),
      ...(pass.defer ? { deferJudge: true } : {}),
      ...(pass.judgedOutcome !== undefined ? { judgedOutcome: pass.judgedOutcome } : {}),
      ...(this.deps.assistantEvents ? { assistantEvents: true } : {}),
      outageNotices: this.outageNotices,
      companionPendingText: this.deps.companionPendingText ?? "",
      platformWording: "whatsapp",
    };
  }

  /** The WhatsApp sink for the gate's decisions. */
  private async apply(decision: GateDecision, m: BridgeMessage, alias: string): Promise<void> {
    const events = this.deps.assistantEvents;
    switch (decision.kind) {
      case "to_gateway": {
        const delivered = this.deps.connector.pushInbound(decision.event, { explicit: decision.explicit === true });
        if (decision.analytics) events?.handedOff(alias, decision.analytics, delivered, decision.event.message_id);
        // Nothing queues and nothing is said: the gateway-unavailable notice is not a line
        // the relay sends on WhatsApp (see the header).
        if (!delivered) this.log(structuredLog("warn", "whatsapp.turn_lost", { reason: "GATEWAY_UNAVAILABLE" }));
        return;
      }
      case "judge_pending":
        this.enqueue(m.chatId, async () => {
          const judged = await decision.ask().catch(() => null);
          await this.handle(m, { defer: false, judgedOutcome: judged });
        });
        return;
      case "reply":
        if (decision.analytics) events?.companionUnreachable(alias, decision.analytics);
        this.log(structuredLog("info", "whatsapp.relay_reply_withheld", { reason: "not_a_whatsapp_fixed_line" }));
        return;
      case "drop":
        if (decision.analytics) events?.notAddressed(decision.analytics);
        return this.drop(decision.reason);
    }
  }

  // ── Codes (AC-8 to AC-12), the introduction (AC-10) and the owner's notice (AC-18) ──

  private async code(m: BridgeMessage, alias: string, kind: "private" | "group", senderId: string | null, text: string): Promise<void> {
    const { db, client, codeLimiter } = this.deps;
    if (kind === "private" && !senderId) return this.drop("PRIVATE_SENDER_UNRESOLVED");
    let chatTitle: string | null = null;
    if (kind === "group") {
      const info = await client.chatInfo(m.chatId);
      if (info.ok && info.value.kind === "group") chatTitle = cleanChatText(info.value.title);
    }
    const outcome = await handleCodeMessage(db, codeLimiter, {
      text,
      chatId: alias,
      // A group code binds the group whoever sent it (AC-10); the sender is checked only in a private chat.
      senderId: senderId ?? "",
      transportAddress: m.chatId,
      ...(kind === "private" && m.senderPhoneLast4 ? { phoneLast4: m.senderPhoneLast4 } : {}),
      ...(chatTitle ? { chatTitle } : {}),
      log: this.log,
    });
    if (!outcome.handled) return;
    if (outcome.silenced) {
      this.log(structuredLog("info", "whatsapp.code_silenced", {}));
      return;
    }
    const result = outcome.result;
    this.log(structuredLog("info", "whatsapp.code_attempt", result.ok
      ? { ok: true, kind: result.kind, ...(result.kind === "group" ? { already_connected: result.alreadyConnected } : {}) }
      : { ok: false, reason: result.reason, spent: result.spent }));
    if (outcome.reply) await this.say({ alias, address: m.chatId }, outcome.reply);
    if (!result.ok) return;
    if (result.kind === "group") {
      if (result.alreadyConnected) return;
      await this.introduce(alias, m.chatId, result.tripId);
      await this.notifyOwners(result.bindingId, null);
      return;
    }
    await this.notifyOwners(result.bindingId, result.replacedOwnerChat);
  }

  private async introduce(alias: string, address: string, tripId: string): Promise<void> {
    const intro = await composeWhatsAppGroupIntroduction(this.deps.db, tripId);
    if (!intro) {
      this.log(structuredLog("warn", "whatsapp.introduction_unavailable", {}));
      return;
    }
    await this.say({ alias, address }, intro);
  }

  private async say(target: { alias: string; address: string }, text: string): Promise<boolean> {
    const sent = await sendFixedText(this.deps.client, this.deps.state, this.deps.ledger, target, text);
    if (!sent) this.log(structuredLog("warn", "whatsapp.fixed_line_failed", {}));
    return sent;
  }

  private async notifyOwners(bindingId: string, replaced: ReplacedConnection | null): Promise<void> {
    const { db, client, state, ledger } = this.deps;
    const notices = await notifyOwnersOfNewBinding(db, {
      // To the owner's connected private chat, by alias; a failure throws so the notice falls back to Telegram.
      sendWhatsApp: async (chatAlias, text) => {
        const address = await whatsappAddressOf(db, chatAlias);
        if (!address || !(await sendFixedText(client, state, ledger, { alias: chatAlias, address }, text))) {
          throw new Error("WHATSAPP_NOTICE_FAILED");
        }
      },
      // To a chat whose binding has just closed: the address is in memory, for this one send. Never logged, never kept.
      sendWhatsAppToAddress: async (target, text) => {
        if (!(await sendFixedText(client, state, ledger, { alias: target.chatId, address: target.transportAddress }, text))) {
          throw new Error("WHATSAPP_NOTICE_FAILED");
        }
      },
      log: this.log,
    }, { bindingId, replaced });
    this.log(structuredLog("info", "whatsapp.owner_notice", { channels: notices.map((n) => n.channel).join(",") || "none" }));
  }
}
