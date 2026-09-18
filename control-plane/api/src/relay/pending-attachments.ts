/**
 * Documents sent to a group without addressing the assistant, held briefly in
 * case their sender's next message does.
 *
 * The relevance gate (addressing.ts) judges one message at a time, and a file
 * with no caption has no text that could address anyone. People do not send
 * files that way: on 2026-09-17 an organizer posted the trip itinerary PDF to
 * the family group, then 4 min 32 s later asked the assistant by name to put
 * it on the site. To the gate those were a file for nobody and an instruction
 * with no file, and the assistant — correctly, from what it was given — said
 * nothing had been uploaded.
 *
 * So a dropped document is remembered, and the SAME sender's next addressed
 * message in the SAME chat brings it along. Three properties are the point:
 *
 *   - **A reference, never bytes.** Only the Telegram file id and what the
 *     message said about the file. Nothing is downloaded unless it actually
 *     goes to the assistant; the family's files stay where they were sent.
 *   - **Keyed by chat AND sender.** One person's document is never attached to
 *     anyone else's request, and never follows them into another chat.
 *   - **Minutes, not a conversation.** The window covers "send the file, then
 *     say what it is for", and ends before an unrelated question much later
 *     could pick the file up.
 *
 * In memory on purpose: a relay restart forgets pending documents, which costs
 * the sender one resend and keeps no family file reference on disk.
 */
import type { Attachment } from "./normalize.js";

/** Long enough for the live case (272 s), short enough to stay one interaction. */
export const PENDING_ATTACHMENT_TTL_MS = 5 * 60 * 1000;

/** Documents kept per sender per chat; the newest win. */
export const PENDING_ATTACHMENTS_PER_SENDER = 5;

/** Distinct (chat, sender) pairs held at once, so a busy relay cannot grow without bound. */
export const PENDING_ATTACHMENT_SENDERS_MAX = 1000;

/** A held document: where to fetch it from, and what its own message said about it. */
export type HeldAttachment = Attachment & { caption?: string };

interface Entry extends HeldAttachment {
  heldAt: number;
}

export interface PendingAttachmentsOptions {
  ttlMs?: number;
  perSender?: number;
  maxSenders?: number;
  /** Injectable clock, for tests of the window. */
  now?: () => number;
}

export class PendingAttachments {
  private readonly held = new Map<string, Entry[]>();
  private readonly ttlMs: number;
  private readonly perSender: number;
  private readonly maxSenders: number;
  private readonly now: () => number;

  constructor(options: PendingAttachmentsOptions = {}) {
    this.ttlMs = options.ttlMs ?? PENDING_ATTACHMENT_TTL_MS;
    this.perSender = options.perSender ?? PENDING_ATTACHMENTS_PER_SENDER;
    this.maxSenders = options.maxSenders ?? PENDING_ATTACHMENT_SENDERS_MAX;
    this.now = options.now ?? Date.now;
  }

  /** Remembers a document `senderId` sent to `chatId` that addressed nobody. */
  hold(chatId: string, senderId: string, attachment: Attachment, context: { caption?: string } = {}): void {
    const now = this.now();
    this.prune(now);
    const key = keyOf(chatId, senderId);
    const entries = (this.held.get(key) ?? []).filter((entry) => entry.fileId !== attachment.fileId);
    entries.push({
      fileId: attachment.fileId,
      kind: attachment.kind,
      mime: attachment.mime,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(context.caption ? { caption: context.caption } : {}),
      heldAt: now,
    });
    // Re-inserted so Map order stays "longest-held sender first" for eviction.
    this.held.delete(key);
    this.held.set(key, entries.slice(-this.perSender));
    while (this.held.size > this.maxSenders) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
  }

  /**
   * Hands over — and forgets — every live document `senderId` holds in
   * `chatId`, oldest first. Anyone else asking gets nothing and consumes
   * nothing.
   */
  take(chatId: string, senderId: string): HeldAttachment[] {
    const now = this.now();
    const key = keyOf(chatId, senderId);
    const entries = this.held.get(key);
    if (!entries) return [];
    this.held.delete(key);
    return entries
      .filter((entry) => this.isLive(entry, now))
      .map(({ heldAt: _heldAt, ...attachment }) => attachment);
  }

  /** (chat, sender) pairs currently holding at least one live document. */
  get size(): number {
    this.prune(this.now());
    return this.held.size;
  }

  private isLive(entry: Entry, now: number): boolean {
    return now - entry.heldAt < this.ttlMs;
  }

  private prune(now: number): void {
    for (const [key, entries] of this.held) {
      const live = entries.filter((entry) => this.isLive(entry, now));
      if (live.length === 0) this.held.delete(key);
      else if (live.length !== entries.length) this.held.set(key, live);
    }
  }
}

function keyOf(chatId: string, senderId: string): string {
  // Unambiguous: ("1", "23") and ("12", "3") are different keys.
  return JSON.stringify([chatId, senderId]);
}
