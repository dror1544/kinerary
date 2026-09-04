/**
 * The single inbound dispatch — one Telegram update in, one decision out.
 *
 * **One bot token, one getUpdates loop.** Telegram answers a second concurrent
 * getUpdates for the same token with 409 Conflict, and delivers each update
 * exactly once. The control plane already ran such a loop for signup-approval
 * callbacks (telegram-poller.ts), and Hermes's gateway ran another for the
 * conversation. This module is where those merge: every update type is
 * dispatched from here, so there is exactly one consumer of the bot's update
 * stream.
 *
 * The order of the decisions below is the security-relevant part, so it is
 * stated once here rather than inferred from the code:
 *
 *   1. `/start <token>` — handled deterministically, never forwarded. This is
 *      why the router owns the socket at all: Hermes's gateway discards every
 *      `/start` before an agent sees it, which made one-tap onboarding
 *      structurally impossible.
 *   2. A chat mid-interview — served by the router's own intake logic, no LLM.
 *   3. A chat bound to a trip — normalized and handed to the gateway, stamped
 *      with that trip's profile.
 *   4. Anything else — refused. Fail closed.
 *
 * Nothing in a message body moves an update between those branches except the
 * `/start` token, which is verified server-side before it grants anything.
 */
import type pg from "pg";
import {
  parseCallbackData,
  parseInbound,
  renderDocumentOffer,
  renderQuestion,
  resolveChatRoute,
  startFromDeepLink,
  type InlineKeyboard,
} from "../chat-router.js";
import { isAddressedToAssistant } from "./addressing.js";
import {
  describeAttachment,
  normalizeUpdate,
  toWireEventWithMedia,
  type MediaDeps,
  type TelegramUpdate,
} from "./normalize.js";
import { setFinishRequestedForChat, type SessionView } from "../interview.js";
import type { WireMessageEvent } from "./protocol.js";

/** A message the connector should send itself, rather than routing to an agent. */
export interface DirectReply {
  chatId: string;
  text: string;
  replyMarkup?: InlineKeyboard;
}

export type DispatchDecision =
  /** Hand this turn to the Hermes gateway as an `inbound` frame. */
  | { kind: "to_gateway"; event: WireMessageEvent }
  /** The connector answers this one itself. */
  | { kind: "reply"; reply: DirectReply }
  /** The organizer typed /done or /summary — show the recap, whatever else is going on. */
  | { kind: "show_summary"; chatId: string; view: SessionView }
  /** A tapped inline button that belongs to the interview flow. */
  | {
      kind: "interview_callback";
      chatId: string;
      callbackQueryId: string;
      data: string;
      sessionId: string;
      /** The message the button belongs to, so a multi-select can be redrawn in place. */
      messageId?: string;
    }
  /**
   * A WRITTEN message from a chat that is mid-interview.
   *
   * Its own branch rather than a canned nudge, because what should happen to
   * it depends on the question actually pending: an unanswered choice question
   * means the organizer typed instead of tapping, while a text or structured
   * question means they answered exactly as asked and the deterministic layer
   * has no way to record it (dates need normalising, travelers and phases need
   * assembling — both LLM work). The caller looks up which, so this stays a
   * branch table. When the interviewer agent is reachable through the gateway,
   * this is the branch that forwards to it.
   */
  | { kind: "interview_text"; chatId: string; sessionId: string; text: string }
  /**
   * A written mid-interview message being handed to the interviewer agent.
   *
   * The deterministic layer records taps. This is the other half: an answer
   * that needs judgement before it can be stored — `destination` resolving
   * "Vienna and Prague" into a multi-destination trip, a date phrased in
   * words, travelers and phases assembled from conversation.
   *
   * Carries the session the router resolved for the chat, so the caller can
   * open the turn that gates the agent's write path before the event goes out.
   */
  | { kind: "interview_to_gateway"; chatId: string; sessionId: string; event: WireMessageEvent }
  /** A signup-approval callback — the pre-existing telegram-poller path. */
  | { kind: "approval_callback"; callbackQueryId: string; data: string; fromId: string }
  /** Nothing to do. */
  | { kind: "ignore"; reason: string };

/**
 * Who the assistant is on this platform, for the group relevance gate.
 *
 * Both fields are optional and the gate degrades honestly without them: no
 * username means @mentions cannot be recognised, no bot id means a reply is
 * judged by "replying to some bot" rather than "replying to US". The names
 * themselves are NOT here — they are per-trip and arrive on the route.
 */
export interface BotIdentity {
  /** The bot's @username, without the @. */
  username?: string;
  /** The bot's own numeric Telegram id. */
  id?: string;
}

export interface DispatchStrings {
  /** Shown when someone messages the bot with no trip and no valid link. */
  unbound: string;
  /** Shown for a bare `/start` with no deep-link payload. */
  noPayload: string;
  /** Shown when a deep link is expired, already used, or unknown. */
  badLink: string;
  /** Shown when a deep link is opened in a group rather than a private chat. */
  notPrivate: string;
  /** Shown when a link arrives while this chat is already interviewing. */
  alreadyInterviewing: string;
  /** Shown when someone types while a CHOICE question is pending — the buttons are right there. */
  tapAnOption: string;
  /** Shown when someone answers a text/structured question in writing. See interview_text. */
  writtenAnswerUnsupported: string;
  /** Shown when a turn could not be handed to the gateway, so no answer is coming. */
  gatewayUnavailable: string;
}

/**
 * Default copy. Deliberately plain and non-committal about WHY a link failed:
 * the distinctions available today (unknown vs consumed vs revoked all arrive
 * as one reason — see chat-router's note) are not ones the organizer can act
 * on differently, and guessing would be worse than a single honest sentence.
 */
export const DEFAULT_STRINGS: DispatchStrings = {
  unbound:
    "I don't have a trip for this chat yet. Open the link from your Kinerary signup to get started.",
  noPayload:
    "Welcome to Kinerary. To start planning, open the link from your signup email or message — it carries the code I need.",
  badLink: "That link isn't valid any more. Ask for a fresh one and I'll pick up from there.",
  notPrivate: "Let's do this in a private chat — message me directly and open your link there.",
  alreadyInterviewing: "We're already planning a trip in this chat. Let's finish this one first.",
  tapAnOption: "Tap one of the options above and we'll keep going.",
  // Honest rather than reassuring, and deliberately so. The alternative — a
  // "got it!" for something nothing recorded — would read as working while
  // silently dropping the organizer's answer, and they would only find out at
  // the recap. Saying it plainly costs a turn; pretending costs their trust.
  writtenAnswerUnsupported:
    "I can't take written answers just yet — that part of me is still being connected. Anything with buttons works now.",
  gatewayUnavailable:
    "I couldn't reach the trip assistant just now. Give it a moment and send that again.",
};

/**
 * Decides what to do with one Telegram update.
 *
 * Pure with respect to Telegram: it performs database lookups but sends
 * nothing. The caller owns all I/O, which is what makes the branch table above
 * testable without a bot token.
 */
/** Router configuration that varies per deployment rather than per update. */
export interface DispatchOptions {
  /**
   * The Hermes profile that serves written interview answers. Absent means no
   * interviewer is reachable, and the router answers those messages itself.
   */
  interviewerProfile?: string;
  /** Present when the connector runs a media plane; absent keeps text-only behaviour. */
  media?: MediaDeps;
}

export async function dispatchUpdate(
  db: pg.Pool,
  update: TelegramUpdate,
  strings: DispatchStrings = DEFAULT_STRINGS,
  log: (line: string) => void = () => {},
  botIdentity: BotIdentity = {},
  options: DispatchOptions = {},
): Promise<DispatchDecision> {
  if (update.callback_query) return dispatchCallback(db, update);

  const message = update.message ?? update.edited_message;
  const rawChatId = message?.chat?.id;
  if (!message || rawChatId === undefined || rawChatId === null || rawChatId === "") {
    return { kind: "ignore", reason: "NO_MESSAGE" };
  }
  const chatId = String(rawChatId);
  if (message.from?.is_bot) return { kind: "ignore", reason: "FROM_BOT" };

  const text = message.text ?? message.caption ?? "";
  const parsed = parseInbound(text);

  if (parsed.kind === "start") {
    const outcome = await startFromDeepLink(db, chatId, parsed.payload, log, message.from?.language_code);
    switch (outcome.kind) {
      case "started": {
        // The opening is the document offer, not the first question. Asking
        // for a start date before mentioning that a PDF would answer it is
        // how run 5 began, and typing out a trip you already have written
        // down is the single biggest waste of an organizer's patience.
        //
        // The first question follows the moment they answer it — by sending
        // the document, by tapping "I don't have one", or by just typing.
        if (!outcome.view.nextQuestion) {
          return { kind: "reply", reply: { chatId, text: strings.badLink } };
        }
        const rendered = renderDocumentOffer(outcome.view.language);
        return {
          kind: "reply",
          reply: { chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined },
        };
      }
      case "already_in_interview":
        return { kind: "reply", reply: { chatId, text: strings.alreadyInterviewing } };
      case "rejected":
        return {
          kind: "reply",
          reply: {
            chatId,
            text:
              outcome.reason === "NO_PAYLOAD"
                ? strings.noPayload
                : outcome.reason === "NOT_PRIVATE_CHAT"
                  ? strings.notPrivate
                  : strings.badLink,
          },
        };
    }
  }

  // A way to the summary that depends on nothing else working.
  //
  // Reaching the recap normally means either the interviewer calling
  // `show_summary_for_chat` or the organizer tapping the boundary message.
  // On 2026-09-04 run 6 neither happened: the agent asked for approval in
  // prose, the organizer said yes, and nothing occurred — only the router's
  // Confirm button writes an intake version, and it had never been sent. A
  // typed command is the one path that survives an agent doing anything at
  // all, so it exists.
  if (parsed.kind === "command" && (parsed.name === "done" || parsed.name === "summary")) {
    const route = await resolveChatRoute(db, chatId);
    if (route.kind === "interview") {
      const result = await setFinishRequestedForChat(db, chatId, true);
      if (result.ok) return { kind: "show_summary", chatId, view: result.view };
    }
  }

  const outcome = await normalizeUpdate(db, update, options.media);
  if (outcome.kind === "event") {
    // The relevance gate. A DM is addressed by construction; a group message
    // has to actually address the assistant, or the shared bot answers a
    // family talking among themselves. See addressing.ts for why this cannot
    // be left to Hermes's mention_patterns under the relay.
    const repliedTo = message.reply_to_message?.from;
    const isReplyToAssistant = repliedTo
      ? botIdentity.id
        // Precise when we know our own id: a reply to some OTHER bot in the
        // group is not a reply to us.
        ? String(repliedTo.id) === botIdentity.id
        : Boolean(repliedTo.is_bot)
      : false;

    const addressed = isAddressedToAssistant({
      chatType: outcome.event.source.chat_type,
      text: outcome.event.text,
      assistantNames: outcome.route.kind === "companion" ? outcome.route.assistantNames : [],
      botUsername: botIdentity.username,
      isReplyToAssistant,
    });
    if (!addressed) return { kind: "ignore", reason: "NOT_ADDRESSED" };
    return { kind: "to_gateway", event: outcome.event };
  }

  switch (outcome.reason) {
    case "INTERVIEW": {
      // A written message mid-interview. Which session it belongs to comes
      // from the chat, never from the text — same authority as every other
      // branch here.
      const route = await resolveChatRoute(db, chatId);
      if (route.kind !== "interview") return { kind: "ignore", reason: "INTERVIEW_ENDED" };
      // With no interviewer profile configured there is nowhere to forward to,
      // so the router answers the message itself — see interview_text.
      if (!options.interviewerProfile) {
        return { kind: "interview_text", chatId, sessionId: route.sessionId, text };
      }
      // Re-hosted the same way the companion route does it. This branch used
      // to call the plain `toWireEvent`, so an uploaded document reached the
      // interviewer as `text: ""` — an empty message, from the one route that
      // asks for a document in the first place. The organizer saw a successful
      // upload and the agent saw nothing.
      return {
        kind: "interview_to_gateway",
        chatId,
        sessionId: route.sessionId,
        event: await toWireEventWithMedia(
          message,
          chatId,
          text,
          options.interviewerProfile,
          describeAttachment(message),
          options.media,
        ),
      };
    }
    case "UNROUTED":
      return { kind: "reply", reply: { chatId, text: strings.unbound } };
    default:
      return { kind: "ignore", reason: outcome.reason };
  }
}

/**
 * Callback queries fan out to two owners: the interview's own buttons, and the
 * pre-existing signup-approval buttons that telegram-poller.ts handles.
 *
 * They are told apart by callback_data shape, but the AUTHORITY for an
 * interview callback is still the chat it arrived in — `parseCallbackData`
 * yields only which answer was tapped, never which session it applies to. A
 * forged or replayed payload therefore cannot reach another organizer's
 * interview; it can only claim an option within whatever session its own chat
 * already owns.
 */
async function dispatchCallback(db: pg.Pool, update: TelegramUpdate): Promise<DispatchDecision> {
  const callback = update.callback_query;
  if (!callback?.data) return { kind: "ignore", reason: "NO_CALLBACK_DATA" };

  const chatId = callback.message?.chat?.id;
  const parsed = parseCallbackData(callback.data);

  if (parsed.kind !== "unknown" && chatId !== undefined && chatId !== null) {
    const route = await resolveChatRoute(db, String(chatId));
    if (route.kind === "interview") {
      const messageId = (callback.message as { message_id?: unknown } | undefined)?.message_id;
      return {
        kind: "interview_callback",
        chatId: String(chatId),
        callbackQueryId: callback.id,
        data: callback.data,
        sessionId: route.sessionId,
        ...(messageId !== undefined && messageId !== null ? { messageId: String(messageId) } : {}),
      };
    }
    // An interview-shaped callback from a chat with no live interview is
    // stale — a button from a finished session. Not an approval token, so it
    // must not fall through to the approval path.
    return { kind: "ignore", reason: "STALE_INTERVIEW_CALLBACK" };
  }

  const fromId = callback.from?.id;
  if (fromId === undefined || fromId === null) return { kind: "ignore", reason: "NO_CALLBACK_SENDER" };
  return {
    kind: "approval_callback",
    callbackQueryId: callback.id,
    data: callback.data,
    fromId: String(fromId),
  };
}
