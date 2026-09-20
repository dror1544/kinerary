/**
 * What the family said while the assistant was not being spoken to.
 *
 * The relevance gate (addressing.ts) is right to drop those messages — a bot
 * that answers everything in a family group is the thing people remember, and
 * on a shared bot it spends one trip's budget on another trip's small talk.
 * But dropping them from the GATE and dropping them from the assistant's
 * KNOWLEDGE are two different decisions, and until 2026-09-20 they were one.
 *
 * The cost showed up as incoherence. Asked something, the companion answers;
 * the family then talks among themselves for four turns; somebody addresses it
 * again, and it replies to that sentence with no idea what the four turns said.
 * Reported as "the replies are not coherent, one time it answered and the other
 * it doesn't" — which is exactly what a conversation with holes in it reads
 * like from the outside.
 *
 * So unaddressed group messages are REMEMBERED, and the next addressed message
 * in that chat carries them along as context. The properties that keep this
 * cheap and safe are the same ones pending-attachments.ts settled on:
 *
 *   - **Text only, and only what Telegram already delivered.** No files are
 *     fetched, nothing is downloaded, nothing is derived.
 *   - **Nothing is sent until somebody addresses the assistant.** An
 *     unaddressed message on its own still costs zero model turns; this
 *     changes what a turn KNOWS, never how many turns happen.
 *   - **A short window and a hard cap.** Enough to cover the conversation the
 *     addressed message is part of, not enough to become a transcript.
 *   - **Groups only.** A DM is addressed by construction, so nothing is ever
 *     dropped there and there is nothing to carry.
 *   - **Cleared when used.** The same turns are never replayed twice.
 *
 * In memory on purpose, like the attachments beside it: a relay restart
 * forgets what the family said, which is the right direction to fail in for
 * other people's conversation.
 */

/** Long enough to cover the exchange an addressed message belongs to. */
export const GROUP_CONTEXT_TTL_MS = 15 * 60 * 1000;

/** Messages kept per chat; the newest win. */
export const GROUP_CONTEXT_PER_CHAT = 10;

/** Distinct chats held at once, so a busy relay cannot grow without bound. */
export const GROUP_CONTEXT_CHATS_MAX = 1000;

export interface OverheardMessage {
  /** Who said it, as the trip knows them, or as Telegram does. */
  sender: string;
  text: string;
}

interface Entry extends OverheardMessage {
  heldAt: number;
}

export class GroupContext {
  private readonly chats = new Map<string, Entry[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Remember one message nobody addressed to the assistant. */
  hold(chatId: string, sender: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const entries = this.chats.get(chatId) ?? [];
    entries.push({ sender, text: trimmed, heldAt: this.now() });
    while (entries.length > GROUP_CONTEXT_PER_CHAT) entries.shift();
    this.chats.set(chatId, entries);
    // Oldest chat out first, and only when over the cap — an eviction here is
    // a busy relay, not an error.
    while (this.chats.size > GROUP_CONTEXT_CHATS_MAX) {
      const oldest = this.chats.keys().next();
      if (oldest.done) break;
      this.chats.delete(oldest.value);
    }
  }

  /**
   * Everything still fresh for this chat, oldest first, and forget it.
   *
   * Taking rather than reading is deliberate: these turns belong to the one
   * addressed message that is about to carry them. Leaving them would attach
   * the same small talk to every later question too.
   */
  take(chatId: string): OverheardMessage[] {
    const entries = this.chats.get(chatId);
    this.chats.delete(chatId);
    if (!entries) return [];
    const cutoff = this.now() - GROUP_CONTEXT_TTL_MS;
    return entries
      .filter((entry) => entry.heldAt >= cutoff)
      .map(({ sender, text }) => ({ sender, text }));
  }
}
