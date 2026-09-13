/**
 * Connector-side re-host store for inbound attachments.
 *
 * The relay contract carries media BY REFERENCE, never by value. A Telegram
 * document is behind an auth-gated URL that embeds the bot token, so it cannot
 * be named on the wire — the contract's rule is that the PLATFORM CREDENTIAL
 * NEVER CROSSES. The connector downloads with the token it already holds,
 * keeps the bytes here, and puts `{connector}/relay/media/{id}` on the event
 * instead. The gateway fetches that back with its own per-gateway bearer.
 *
 * Ids are 128 bits of randomness because the reference IS the capability:
 * §"Phase 2 media ingress" makes re-hosts readable by any authenticated
 * gateway, on the reasoning that the attachment was already delivered to every
 * admitted recipient. That only holds while the id cannot be guessed, so the
 * id does the work a per-object ACL would otherwise do.
 *
 * In memory, deliberately. Entries live ~1h and the contract tells the gateway
 * to download on receipt rather than lazily, so nothing here needs to survive a
 * restart — and a restarted connector has no gateway session to serve anyway.
 * Writing organizer attachments to disk would create a second, longer-lived
 * copy of travel documents that nothing else in this system keeps.
 */
import { randomBytes } from "node:crypto";

/** Contract §"Inbound media": connector `mediaStore.ts` MEDIA_MAX_BYTES. */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Contract: "Re-hosts expire (TTL ~1h) — download on receipt, not lazily." */
export const MEDIA_TTL_MS = 60 * 60 * 1000;

export type MediaKind = "image" | "voice" | "audio" | "video" | "document";

export interface StoredMedia {
  id: string;
  kind: MediaKind;
  mime: string;
  size: number;
  filename?: string;
  caption?: string;
  bytes: Buffer;
  expiresAt: number;
}

/** The metadata half of the wire's parallel `media` array (same order as `media_urls`). */
export interface WireMediaDescriptor {
  kind: MediaKind;
  mime: string;
  size: number;
  filename?: string;
  caption?: string;
}

export class MediaStore {
  private readonly entries = new Map<string, StoredMedia>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Stores bytes and returns the reference id.
   *
   * Rejects oversize rather than truncating: a half-file that looks like a
   * document is worse than a refusal, because the agent would summarise it as
   * if it were whole.
   */
  put(input: Omit<StoredMedia, "id" | "expiresAt">): string | null {
    if (input.bytes.length > MEDIA_MAX_BYTES) return null;
    const id = randomBytes(16).toString("hex");
    this.entries.set(id, { ...input, id, expiresAt: this.now() + MEDIA_TTL_MS });
    return id;
  }

  /** Returns the entry, or null when unknown OR expired — the caller cannot tell them apart, deliberately. */
  get(id: string): StoredMedia | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  /** Drops expired entries. Called opportunistically; correctness does not depend on it. */
  sweep(): number {
    const now = this.now();
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.entries.size;
  }

  descriptorFor(id: string): WireMediaDescriptor | null {
    const entry = this.get(id);
    if (!entry) return null;
    const { kind, mime, size, filename, caption } = entry;
    return { kind, mime, size, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) };
  }
}
