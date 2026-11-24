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
import { rewriteMentions, whatsappChatTitle, whatsappFilename, whatsappSenderName } from "./text.js";
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

/** A counting semaphore: at most `size` events handled at once, across chats. */
class Slots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly size: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.size) {
      this.running += 1;
      return;
    }
    // The releaser hands its slot straight over, so `running` is not touched here.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

// ── Text that must never carry an id: text.ts (re-exported here, where S3b's tests import them) ──

export { rewriteMentions, whatsappSenderName };

/** Events handled at once across all chats (one per chat; a chat's own events stay in order). */
export const MAX_CONCURRENT_CHATS = 8;
/** Events queued in the lanes before the loop stops polling and waits for them to drain. */
const MAX_QUEUED_EVENTS = 500;

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

  /**
   * Asks the bridge for its state and the number's own ids. True only when it is connected AND its own linked-identity id
   * is known: without that id the relay cannot tell the number's own messages from anyone else's, so nothing is read
   * until it is (#655 review, F3), and that is said once (`own_ids_unknown`). `connected` itself is said only when
   * `sayConnected`, after a poll has worked, so a bridge whose health answers while its message feed fails does not flap.
   */
  async function checkHealth(sayConnected: boolean): Promise<boolean> {
    const health = await deps.client.health();
    if (!health.ok) {
      deps.state.observe(health.state ?? "unavailable", "health");
      return false;
    }
    handler.setOwnIds([health.value.own.lid, health.value.own.phone]);
    if (health.value.state !== "connected") {
      deps.state.observe(health.value.state, "health");
      return false;
    }
    if (!health.value.own.lid) {
      deps.state.observe("own_ids_unknown", "health");
      return false;
    }
    if (sayConnected) deps.state.observe("connected", "health");
    return true;
  }

  async function run(): Promise<void> {
    let cursor: PollCursor = {};
    let knowOwnIds = false;
    log(structuredLog("info", "whatsapp.loop_started", { wait_ms: waitMs, max_concurrent_chats: MAX_CONCURRENT_CHATS }));
    while (!stopped) {
      if (!knowOwnIds) {
        const ok = await checkHealth(false);
        if (stopped) break;
        if (!ok) {
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
      const b = batch.value;
      if (cursor.epoch !== undefined && b.epoch !== cursor.epoch) {
        // The bridge restarted: its numbering began again, and the number's own ids are read again first.
        log(structuredLog("warn", "whatsapp.bridge_restarted", {}));
        knowOwnIds = false;
      }
      // A poll that answers proves the bridge is reachable, not that WhatsApp is connected (a logged-out bridge still
      // answers), and the own ids may have changed. While either is in doubt the bridge's own word is asked for BEFORE
      // the batch is handled; if it is not good, the cursor is NOT advanced, so this batch is read again once it is.
      if (!knowOwnIds || !deps.state.connected) {
        const ok = await checkHealth(true);
        if (stopped) break;
        if (!ok) {
          knowOwnIds = false;
          await fail();
          continue;
        }
        knowOwnIds = true;
      }
      if (b.lost || b.malformed || b.ignored) {
        log(structuredLog("warn", "whatsapp.events_not_handled", { lost: b.lost, malformed: b.malformed, ignored: b.ignored }));
      }
      cursor = { after: b.lastSeq, epoch: b.epoch };
      markReady();
      // Each event goes to its chat's lane: one chat's slow event (a media fetch, a judge call, a slow database) never
      // holds another chat's (#655 review, F5).
      for (const event of b.events) {
        if (stopped) break;
        handler.dispatch(event);
      }
      await handler.drain(MAX_QUEUED_EVENTS);
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
    handle: async (event) => {
      handler.dispatch(event);
      await handler.settled();
    },
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
   * Queues one event on its chat's lane. A chat's events run one at a time, in arrival order, as the Telegram poller
   * serialises a chat; different chats run side by side, at most MAX_CONCURRENT_CHATS at once. A judge call releases
   * its slot while it waits (see `apply`), and keeps its place in the lane.
   */
  dispatch(event: BridgeEvent): void {
    this.queued += 1;
    this.enqueue(event.chatId, async () => {
      await this.slots.acquire();
      try {
        await this.handle(event, { defer: true });
      } finally {
        this.slots.release();
        this.queued -= 1;
      }
    });
  }

  private readonly slots = new Slots(MAX_CONCURRENT_CHATS);
  /** Events dispatched and not yet finished. */
  private queued = 0;

  private enqueue(lane: string, work: () => Promise<void>): void {
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next: Promise<void> = previous.then(work).catch(() => {}).then(() => {
      if (this.lanes.get(lane) === next) this.lanes.delete(lane);
    });
    this.lanes.set(lane, next);
  }

  /** Waits while more than `limit` events are queued: the loop does not read faster than the lanes drain. */
  async drain(limit: number): Promise<void> {
    while (this.queued > limit) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async settled(): Promise<void> {
    while (this.lanes.size > 0) await Promise.all([...this.lanes.values()]);
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
    let title = whatsappChatTitle(event.title);
    if (!title && adder && event.title === undefined) {
      const info = await client.chatInfo(event.chatId);
      if (info.ok && info.value.kind === "group") title = whatsappChatTitle(info.value.title);
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
    // A quoted text that holds a code is not carried at all (#655 review, F1): a code travels nowhere but the code path.
    const quotedRaw = m.quotedText === undefined ? undefined : rewriteMentions(m.quotedText, m.mentionedIds, this.ownIds, ownName);
    const quotedText = quotedRaw !== undefined && extractChatBindingCode(quotedRaw) === null ? quotedRaw : undefined;

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
    // Media is remembered only HERE, for a bound chat whose message is neither a command nor a code (#655 review, F1: a
    // remembered caption reaches the companion with a later reply to it, so a code caption must never be remembered).
    // Metadata only; nothing is downloaded until the message joins a turn (AC-26).
    const attachment: AttachmentRef | null = m.media && messageIdOk
      ? (() => {
          const filename = whatsappFilename(m.media.filename, m.media.kind);
          return { fileId: m.messageId, kind: m.media.kind, mime: m.media.mime || "application/octet-stream", ...(filename ? { filename } : {}) };
        })()
      : null;
    if (attachment) {
      this.deps.ledger.noteMedia(alias, {
        messageId: m.messageId, kind: attachment.kind, mime: attachment.mime, senderId,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        ...(text ? { caption: text } : {}),
      });
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
    // Never stored with a code (see `message`); checked again here so no later change can let one through.
    const rememberedCaption = remembered?.caption !== undefined && extractChatBindingCode(remembered.caption) === null ? remembered.caption : undefined;
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
            ...(rememberedCaption ? { caption: rememberedCaption } : {}),
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
      case "judge_pending": {
        // Still in this chat's lane, so the chat's later events wait behind the verdict; the slot is given back while
        // the model works, so other chats are not held by it.
        this.slots.release();
        let judged: JudgeOutcome | null = null;
        try {
          judged = await decision.ask().catch(() => null);
        } finally {
          await this.slots.acquire();
        }
        await this.handle(m, { defer: false, judgedOutcome: judged });
        return;
      }
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
    // A silenced chat costs nothing: no bridge call, no database read (#655 review, F5).
    if (codeLimiter.silenced(alias)) {
      this.log(structuredLog("info", "whatsapp.code_silenced", {}));
      return;
    }
    let chatTitle: string | null = null;
    if (kind === "group") {
      const info = await client.chatInfo(m.chatId);
      if (info.ok && info.value.kind === "group") chatTitle = whatsappChatTitle(info.value.title);
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
