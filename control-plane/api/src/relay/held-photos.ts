/**
 * The group's photos from the last half hour, held by reference (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B).
 *
 * The same idea as pending-attachments.ts, for a different question. That store holds a DOCUMENT for its sender's next addressed
 * message; this one holds every PHOTO the group posted, whoever sent it, so "save the last photos" and "@bot save this" (in reply
 * to a photo) can reach one even when automatic saving is off. The properties are the same:
 *
 *   - **A reference, never bytes.** The platform's file id and who sent it and when. Nothing is downloaded until a photo is saved.
 *   - **Thirty minutes, no longer.** A request after the window is answered honestly ("I can only reach photos from the last half
 *     hour"); the window is the limit of what the relay keeps, not a rule it could stretch.
 *   - **Bounded.** A count per chat and a count of chats; the oldest go first.
 *   - **In memory.** A relay restart forgets them, which costs one "I haven't seen any photos" and keeps no family photo reference on
 *     disk.
 *
 * Cleared with the chat when a group moves to another trip.
 */
import type { MediaKind } from "./media-store.js";

/** What "save the last photos" can reach. The spec's number: not configurable, because the answer to a person says it. */
export const HELD_PHOTO_WINDOW_MS = 30 * 60 * 1000;
export const HELD_PHOTOS_PER_CHAT = 60;
export const HELD_PHOTO_CHATS_MAX = 500;

export interface HeldPhoto {
  chatId: string;
  messageId: string;
  fileId: string;
  kind: MediaKind;
  mime: string;
  /** The platform's id of who sent it; null when the platform did not say. */
  senderId: string | null;
  /** Posted in a group (not a private chat): only a group's photos make a moment. */
  group: boolean;
  /** When it was sent (the platform's time), in ms. */
  sentAtMs: number;
  /** Set once the site has it. */
  photoId?: string;
}

export class HeldPhotos {
  private readonly chats = new Map<string, HeldPhoto[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Remember a photo. A message seen twice (an edit) is one entry. */
  note(photo: HeldPhoto): void {
    const list = (this.chats.get(photo.chatId) ?? []).filter((held) => held.messageId !== photo.messageId);
    list.push({ ...photo });
    while (list.length > HELD_PHOTOS_PER_CHAT) list.shift();
    this.chats.delete(photo.chatId);
    this.chats.set(photo.chatId, list);
    while (this.chats.size > HELD_PHOTO_CHATS_MAX) {
      const oldest = this.chats.keys().next();
      if (oldest.done) break;
      this.chats.delete(oldest.value);
    }
  }

  /** Whether a photo sent at `sentAtMs` is still inside the window. */
  withinWindow(sentAtMs: number): boolean {
    return this.now() - sentAtMs <= HELD_PHOTO_WINDOW_MS && sentAtMs <= this.now() + 60_000;
  }

  /** The photos still inside the window, oldest first. */
  recent(chatId: string): HeldPhoto[] {
    return (this.chats.get(chatId) ?? []).filter((held) => this.withinWindow(held.sentAtMs));
  }

  find(chatId: string, messageId: string): HeldPhoto | null {
    return (this.chats.get(chatId) ?? []).find((held) => held.messageId === messageId) ?? null;
  }

  markSaved(chatId: string, messageId: string, photoId: string): void {
    const held = this.find(chatId, messageId);
    if (held) held.photoId = photoId;
  }

  clearChat(chatId: string): void {
    this.chats.delete(chatId);
  }
}
