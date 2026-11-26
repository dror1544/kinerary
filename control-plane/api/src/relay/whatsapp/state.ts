/**
 * What the WhatsApp side of the relay remembers between messages, in memory only
 * (spec 625, S3). Two small objects, shared by the inbound loop and the connector so
 * the two halves agree:
 *
 * - `BridgeStateTracker`: whether the bridge answered last time. AC-32 asks for ONE
 *   log line per state change, not one per failed call, and the poller and the
 *   connector both meet the bridge: one tracker, so a down bridge is said once.
 *
 * - `WhatsAppMessageLedger`: per chat ALIAS, the message ids the number itself sent
 *   (an `edit` may change only one of those, AC-24; a reply to one is a reply to the
 *   assistant), the inbound message ids seen (a `reply_to` quotes only a message of the
 *   same chat), and the recent inbound media (the bridge's quote carries no media, so a
 *   reply to a document can bring it only if the relay remembers it, AC-26).
 *
 * Neither holds a real WhatsApp id or a phone number: keys are aliases, senders are
 * opaque ids, message ids are WhatsApp's own random tokens. A relay restart forgets
 * both, which costs at most an edit refused or a replied-to document not joined.
 */
import type { MediaKind } from "../media-store.js";
import { structuredLog } from "../../redaction.js";

export type BridgeHealthState = "connected" | "unavailable" | string;

/** Logs `whatsapp.bridge_state` once per change of state, never per call. */
export class BridgeStateTracker {
  private current: BridgeHealthState | null = null;

  constructor(private readonly log: (line: string) => void) {}

  /** The last state observed; null before the first answer. */
  get state(): BridgeHealthState | null {
    return this.current;
  }

  get connected(): boolean {
    return this.current === "connected";
  }

  /**
   * Records what a call to the bridge just showed. `state` is the bridge's own word
   * when it said one (`logged_out`, `disconnected`...), else `connected` for an answer
   * and `unavailable` for none. Only a CHANGE is logged.
   */
  observe(state: BridgeHealthState, source: "poll" | "health" | "outbound"): void {
    if (state === this.current) return;
    const previous = this.current;
    this.current = state;
    this.log(structuredLog(state === "connected" ? "info" : "warn", "whatsapp.bridge_state", {
      state,
      previous: previous ?? "unknown",
      source,
      // Telegram is a separate loop with a separate client: said here so nobody reads a
      // WhatsApp outage as the relay's.
      ...(state === "connected" ? {} : { effect: "whatsapp paused; telegram unaffected" }),
    }));
  }
}

export interface RememberedMedia {
  messageId: string;
  kind: MediaKind;
  mime: string;
  filename?: string;
  caption?: string;
  /** The sender's opaque id: a replied-to document joins only for the same sender. */
  senderId: string | null;
}

const PER_CHAT = 200;
const MAX_CHATS = 2000;

interface ChatLedger {
  sent: Set<string>;
  seen: Set<string>;
  media: Map<string, RememberedMedia>;
}

/** Bounded per-chat memory of message ids and media, keyed by chat alias. */
export class WhatsAppMessageLedger {
  private readonly chats = new Map<string, ChatLedger>();

  private chat(alias: string): ChatLedger {
    let entry = this.chats.get(alias);
    if (entry) {
      // Least recently used first.
      this.chats.delete(alias);
    } else {
      entry = { sent: new Set(), seen: new Set(), media: new Map() };
    }
    this.chats.set(alias, entry);
    while (this.chats.size > MAX_CHATS) {
      const oldest = this.chats.keys().next().value;
      if (oldest === undefined) break;
      this.chats.delete(oldest);
    }
    return entry;
  }

  private static bounded<T>(set: Set<T>, value: T): void {
    set.delete(value);
    set.add(value);
    while (set.size > PER_CHAT) {
      const oldest = set.values().next().value as T;
      set.delete(oldest);
    }
  }

  noteSent(alias: string, messageId: string): void {
    WhatsAppMessageLedger.bounded(this.chat(alias).sent, messageId);
  }

  noteSeen(alias: string, messageId: string): void {
    WhatsAppMessageLedger.bounded(this.chat(alias).seen, messageId);
  }

  noteMedia(alias: string, media: RememberedMedia): void {
    const map = this.chat(alias).media;
    map.delete(media.messageId);
    map.set(media.messageId, media);
    while (map.size > PER_CHAT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** Did the number itself send this message, in this chat? */
  sentHere(alias: string, messageId: string | undefined): boolean {
    return messageId !== undefined && (this.chats.get(alias)?.sent.has(messageId) ?? false);
  }

  /** Is this a message of this chat, either way? */
  knownHere(alias: string, messageId: string | undefined): boolean {
    if (messageId === undefined) return false;
    const entry = this.chats.get(alias);
    return Boolean(entry && (entry.sent.has(messageId) || entry.seen.has(messageId)));
  }

  mediaOf(alias: string, messageId: string | undefined): RememberedMedia | null {
    if (messageId === undefined) return null;
    return this.chats.get(alias)?.media.get(messageId) ?? null;
  }
}
