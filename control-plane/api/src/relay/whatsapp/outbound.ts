/**
 * The WhatsApp transport of the connector's outbound actions (spec 625, AC-20, AC-24,
 * AC-32). The connector decides everything that is the same for both platforms (the
 * scope check, the silence verdict, the leak filter, the reply windows) and then hands
 * the WhatsApp half here, chosen from the BINDING ROW's platform, never from the frame.
 *
 * What this adds on top of the bridge's own refusals:
 *
 * - The address. A gateway names a chat by its alias; the real address is read off the
 *   chat's open binding (`transport_address`) for each action, never cached, never
 *   logged, never returned.
 * - `reply_to` quotes only a message the relay saw in THIS chat; any other id (or one
 *   that is not of WhatsApp's id shape) is dropped and the text goes unquoted, because a
 *   reply is cosmetic and the answer must still arrive.
 * - `edit` changes only a message the number itself sent in THIS chat, checked here
 *   before the bridge is asked (the bridge checks again).
 * - Formatting and length: the companion writes Markdown; WhatsApp gets its own dialect,
 *   split into messages it accepts (`format.ts`). Nothing is dropped.
 * - The error words. A failure carries a fixed word, never the bridge's detail: Hermes
 *   reads the string with its own classifier, and a word like "network" would make it
 *   retry a send that may have been delivered (connector.ts, GATEWAY_TIMEOUT_ERROR).
 */
import { structuredLog } from "../../redaction.js";
import { MESSAGE_ID, type WhatsAppClient, type WhatsAppFailure } from "./client.js";
import { formatForWhatsApp } from "./format.js";
import type { BridgeStateTracker, WhatsAppMessageLedger } from "./state.js";
import { whatsappChatTitle } from "./text.js";

/** No WhatsApp client is configured on this relay, and the chat's binding is a WhatsApp one (AC-20). */
export const PLATFORM_UNAVAILABLE = "PLATFORM_UNAVAILABLE";
/** The bridge could not be reached, is logged out or not connected (AC-32). Not a word Hermes retries. */
export const WHATSAPP_UNAVAILABLE = "WHATSAPP_UNAVAILABLE";
/** The bridge timed out: the message may have been delivered, so it is reported as a timeout, never retried. */
export const WHATSAPP_TIMEOUT = "whatsapp call timed out";
export const WHATSAPP_REFUSED = "WHATSAPP_REFUSED";
export const EDIT_REFUSED = "EDIT_REFUSED";

export interface WhatsAppOutboundDeps {
  client: WhatsAppClient;
  /**
   * The `transport_address` of the alias's open WhatsApp binding OF THIS TRIP (the trip the scope check approved), or
   * null when there is none now. Tied to the trip, not to the alias alone (#655 review, F2): a chat rebound to another
   * trip between the scope check and the send must get nothing from the first trip's gateway.
   */
  addressOf(alias: string, tripId: string): Promise<string | null>;
  ledger: WhatsAppMessageLedger;
  state: BridgeStateTracker;
  log?: (line: string) => void;
}

export type DeliveryResult = { ok: true; messageId?: string } | { ok: false; error: string };

export class WhatsAppOutbound {
  constructor(private readonly deps: WhatsAppOutboundDeps) {}

  private failure(op: string, failure: WhatsAppFailure): DeliveryResult {
    if (failure.reason === "unavailable") {
      this.deps.state.observe(failure.state ?? "unavailable", "outbound");
      return { ok: false, error: failure.detail === "timeout" ? WHATSAPP_TIMEOUT : WHATSAPP_UNAVAILABLE };
    }
    // An answer from the bridge: it is up, whatever it said about this request.
    this.deps.state.observe("connected", "outbound");
    this.deps.log?.(structuredLog("warn", "whatsapp.outbound_refused", { op, reason: failure.reason }));
    return { ok: false, error: failure.reason === "not_found" && op === "edit" ? EDIT_REFUSED : WHATSAPP_REFUSED };
  }

  private async address(alias: string, tripId: string): Promise<string | null> {
    return this.deps.addressOf(alias, tripId);
  }

  /** Sends companion text, converted and split. Returns the FIRST message's id (the one a streaming edit targets). */
  async send(alias: string, tripId: string, content: string, replyTo?: string): Promise<DeliveryResult> {
    const address = await this.address(alias, tripId);
    if (!address) return { ok: false, error: "CHAT_NOT_IN_SCOPE" };
    const chunks = formatForWhatsApp(content);
    if (chunks.length === 0) return { ok: true };
    const quote = replyTo !== undefined && MESSAGE_ID.test(replyTo) && this.deps.ledger.knownHere(alias, replyTo) ? replyTo : undefined;
    if (replyTo !== undefined && quote === undefined) {
      this.deps.log?.(structuredLog("info", "whatsapp.reply_to_dropped", { reason: "not_a_message_of_this_chat" }));
    }
    let first: string | undefined;
    for (const [i, text] of chunks.entries()) {
      const sent = await this.deps.client.send({ chatId: address, text, ...(i === 0 && quote ? { replyTo: quote } : {}) });
      if (!sent.ok) return this.failure("send", sent);
      this.deps.state.observe("connected", "outbound");
      this.deps.ledger.noteSent(alias, sent.value.messageId);
      first ??= sent.value.messageId;
    }
    return { ok: true, ...(first ? { messageId: first } : {}) };
  }

  /**
   * Edits a message the number sent in this chat. Text that no longer fits one message
   * edits the first and sends the rest as new messages, so nothing the companion wrote
   * is lost.
   */
  async edit(alias: string, tripId: string, messageId: string, content: string): Promise<DeliveryResult> {
    if (!MESSAGE_ID.test(messageId) || !this.deps.ledger.sentHere(alias, messageId)) {
      this.deps.log?.(structuredLog("warn", "whatsapp.edit_refused", { reason: "not_a_message_the_number_sent_here" }));
      return { ok: false, error: EDIT_REFUSED };
    }
    const address = await this.address(alias, tripId);
    if (!address) return { ok: false, error: "CHAT_NOT_IN_SCOPE" };
    const chunks = formatForWhatsApp(content);
    if (chunks.length === 0) return { ok: true };
    const edited = await this.deps.client.edit({ chatId: address, messageId, text: chunks[0]! });
    if (!edited.ok) return this.failure("edit", edited);
    this.deps.state.observe("connected", "outbound");
    for (const text of chunks.slice(1)) {
      const sent = await this.deps.client.send({ chatId: address, text });
      if (!sent.ok) return this.failure("send", sent);
      this.deps.ledger.noteSent(alias, sent.value.messageId);
    }
    return { ok: true };
  }

  async typing(alias: string, tripId: string, state: "composing" | "paused" = "composing"): Promise<DeliveryResult> {
    const address = await this.address(alias, tripId);
    if (!address) return { ok: false, error: "CHAT_NOT_IN_SCOPE" };
    const typed = await this.deps.client.typing({ chatId: address, ...(state === "paused" ? { state } : {}) });
    if (!typed.ok) return this.failure("typing", typed);
    this.deps.state.observe("connected", "outbound");
    return { ok: true };
  }

  /** A group's title, or a private chat with no name: never an id or a number. */
  async chatInfo(alias: string, tripId: string): Promise<{ ok: true; name: string; type: "group" | "private" } | { ok: false; error: string }> {
    const address = await this.address(alias, tripId);
    if (!address) return { ok: false, error: "CHAT_NOT_IN_SCOPE" };
    const info = await this.deps.client.chatInfo(address);
    if (!info.ok) {
      const failed = this.failure("get_chat_info", info);
      return failed.ok ? { ok: false, error: WHATSAPP_REFUSED } : failed;
    }
    this.deps.state.observe("connected", "outbound");
    if (info.value.kind === "group") return { ok: true, name: whatsappChatTitle(info.value.title) ?? "", type: "group" };
    return { ok: true, name: "", type: "private" };
  }
}

/**
 * The relay's own fixed lines on WhatsApp (spec "What the relay says by itself"): a code
 * reply, the introduction, the owner's notice. Not companion text, so no scope check,
 * no silence verdict, no leak filter; still converted and split, and never logged.
 */
export async function sendFixedText(
  client: WhatsAppClient,
  state: BridgeStateTracker,
  ledger: WhatsAppMessageLedger,
  target: { alias: string; address: string },
  text: string,
): Promise<boolean> {
  for (const chunk of formatForWhatsApp(text)) {
    const sent = await client.send({ chatId: target.address, text: chunk });
    if (!sent.ok) {
      if (sent.reason === "unavailable") state.observe(sent.state ?? "unavailable", "outbound");
      return false;
    }
    state.observe("connected", "outbound");
    ledger.noteSent(target.alias, sent.value.messageId);
  }
  return true;
}
