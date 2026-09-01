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
  renderQuestion,
  resolveChatRoute,
  startFromDeepLink,
  type InlineKeyboard,
} from "../chat-router.js";
import { normalizeUpdate, type TelegramUpdate } from "./normalize.js";
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
  /** A tapped inline button that belongs to the interview flow. */
  | { kind: "interview_callback"; chatId: string; callbackQueryId: string; data: string; sessionId: string }
  /** A signup-approval callback — the pre-existing telegram-poller path. */
  | { kind: "approval_callback"; callbackQueryId: string; data: string; fromId: string }
  /** Nothing to do. */
  | { kind: "ignore"; reason: string };

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
};

/**
 * Decides what to do with one Telegram update.
 *
 * Pure with respect to Telegram: it performs database lookups but sends
 * nothing. The caller owns all I/O, which is what makes the branch table above
 * testable without a bot token.
 */
export async function dispatchUpdate(
  db: pg.Pool,
  update: TelegramUpdate,
  strings: DispatchStrings = DEFAULT_STRINGS,
  log: (line: string) => void = () => {},
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
    const outcome = await startFromDeepLink(db, chatId, parsed.payload, log);
    switch (outcome.kind) {
      case "started": {
        // The first question rides back on the same result, so the organizer's
        // very first tap produces a real question rather than a "hold on".
        const question = outcome.view.nextQuestion;
        if (!question) return { kind: "reply", reply: { chatId, text: strings.badLink } };
        const rendered = renderQuestion(question);
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

  const outcome = await normalizeUpdate(db, update);
  if (outcome.kind === "event") return { kind: "to_gateway", event: outcome.event };

  switch (outcome.reason) {
    case "INTERVIEW":
      // A free-text answer mid-interview. Answer capture is the interview
      // layer's job and is not wired through this path yet — the intake
      // questions the router asks are button-answered. Falls through to a
      // gentle nudge rather than silence.
      return {
        kind: "reply",
        reply: { chatId, text: "Tap one of the options above and we'll keep going." },
      };
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
      return {
        kind: "interview_callback",
        chatId: String(chatId),
        callbackQueryId: callback.id,
        data: callback.data,
        sessionId: route.sessionId,
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
