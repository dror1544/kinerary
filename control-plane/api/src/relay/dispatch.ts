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
  type ChatRoute,
  type InlineKeyboard,
  migrateChatBinding,
  companionIntroFacts,
  companionIntroLoginUsernames,
  resolveTripPerson,
  renderTripList,
  resolveChatLanguage,
  tripDisplayName,
  consumeExpectsReplyWindow,
  inCompanionConversation,
  openCompanionConversation,
  groupProactiveLevel,
  groupProactiveLevelSetting,
  setGroupProactiveLevel,
  PROACTIVE_JOINS_IN,
  type ProactiveLevel,
  isTripOrganizer,
  tripLanguage,
} from "../chat-router.js";
import { listOrganizerTrips, switchChatToTrip, type OrganizerTrip } from "../organizer-trips.js";
import { redeemTelegramLinkToken, telegramLinkTokenFromStartPayload } from "../telegram-link-token.js";
import { isAddressedToAssistant } from "./addressing.js";
import { addressedMark, conversationMark, reactionAnswerMark } from "./stay-silent.js";
import type { GroupJudge, JudgeOutcome } from "./group-judge.js";
import { classifyTrigger, inboundFacts, type InboundFacts, type JudgeFacts, type LevelChangeFacts } from "../analytics/relay-facts.js";
import { coerceLanguage, uiString, type Language } from "../intake-copy.js";
import {
  companionHelpText,
  groupAddLinkLine,
  groupAddUrl,
  groupBindingCommand,
  groupIntroText,
  proactiveChanged,
  proactiveInPrivateChat,
  proactiveRefused,
  proactiveStatus,
  proactiveUnavailable,
  renameConfirmation,
  renameRefused,
  renameUsage,
} from "../companion-intro.js";
import { getAssistantNames, parseAssistantNames, setAssistantNames } from "../assistant-names.js";
import {
  extractGroupBindingToken,
  groupBindingTokenFromStartPayload,
  groupBindingTokenIsOwn,
  issueGroupBindingToken,
  redeemGroupBindingToken,
} from "../group-binding.js";
import { structuredLog } from "../redaction.js";
import {
  attachMedia,
  botJoinedGroup,
  describeAttachment,
  mapChatType,
  migrationOf,
  normalizeUpdate,
  toWireEventWithMedia,
  type Attachment,
  type MediaDeps,
  type TelegramMessage,
  type TelegramUpdate,
} from "./normalize.js";
import type { HeldAttachment, PendingAttachments } from "./pending-attachments.js";
import type { GroupContext } from "./group-context.js";
import { getSessionForChat, setFinishRequestedForChat, type SessionView } from "../interview.js";
import { organizerDocumentRoute } from "../document-correction.js";
import { visionProcessingConfig } from "../document-vision.js";
import { digestTelegramId, telegramDisplayName } from "../identity.js";
import type { StructuredModelRunner } from "../model-runner.js";
import { handleModelCommand, isSwitchableRunner } from "../model-task-settings.js";
import { looksLikeAQuestion, type ChatType, type WireMessageEvent } from "./protocol.js";
import { asksForTripApp, couldAskForTripApp, openTripMessage, type OpenTripMessage } from "./open-trip.js";
import { normaliseBotUsername } from "../bot-username.js";

/** A message the connector should send itself, rather than routing to an agent. */
export interface DirectReply {
  chatId: string;
  text: string;
  replyMarkup?: InlineKeyboard;
}

export type DispatchDecision =
  /** Hand this turn to the Hermes gateway as an `inbound` frame. */
  | {
      kind: "to_gateway";
      event: WireMessageEvent;
      analytics?: InboundFacts;
      /**
       * True when the group message was addressed to the assistant EXPLICITLY (its
       * name, an @mention, a reply to its message) and so carries the
       * `addressedMark`. The connector remembers it per chat: a silence reply to
       * such a turn is a defect, not a judgement call (stay-silent.ts).
       */
      explicit?: boolean;
    }
  /**
   * The connector answers this one itself. `analytics` is set only on the
   * companion-unreachable answer, which is a lost turn (#177).
   */
  | { kind: "reply"; reply: DirectReply; analytics?: InboundFacts; levelChange?: LevelChangeFacts }
  /**
   * Only with `deferJudge`: the message needs the group judge and the caller must not
   * block on it. `ask` makes the model call (queued and bounded by the judge itself)
   * and never throws; see `DispatchOptions.deferJudge`.
   */
  | { kind: "judge_pending"; chatId: string; ask: () => Promise<JudgeOutcome> }
  | {
      /**
       * The bot has just been added to a group bound to a trip: send the
       * arrival message, then pin it if the group made us an admin.
       *
       * Separate from `reply` because pinning needs the sent message's id back,
       * and `reply` deliberately discards it.
       */
      kind: "group_intro";
      chatId: string;
      text: string;
      /**
       * A second message sent right after, carrying only a line to copy.
       *
       * Its own message on purpose: a token inside a paragraph has to be
       * drag-selected on a phone, and a slightly wrong selection produces a
       * token that does not work with nothing to say why.
       */
      followUp?: string;
      /** Whether to attempt pinning. False for a DM, where there is nothing to pin for. */
      pin?: boolean;
      /**
       * The "Open trip" message (#443): sent after the introduction and pinned
       * under it, replacing one of ours pinned earlier. Absent when no bot handle
       * is known (logged) and on a code hand-over, which binds nothing.
       */
      openTrip?: OpenTripMessage;
    }
  /** The organizer typed /done or /summary — show the recap, whatever else is going on. */
  | { kind: "show_summary"; chatId: string; view: SessionView }
  /**
   * A tapped button the ROUTER has already acted on, with the sentence saying
   * what happened.
   *
   * Distinct from `reply` because a callback query must also be answered, or
   * Telegram leaves the button spinning on the organizer's phone for as long
   * as it takes them to give up on it.
   */
  | {
      kind: "callback_reply";
      chatId: string;
      callbackQueryId: string;
      text: string;
    }
  /** A tap that is answered (the spinner stops) and gets NO message in the chat. */
  | { kind: "callback_ack"; callbackQueryId: string; text: string }
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
  | {
      kind: "interview_to_gateway";
      chatId: string;
      sessionId: string;
      event: WireMessageEvent;
      /**
       * The organizer attached a file to this message.
       *
       * Distinct from `event.media_urls` being non-empty, which additionally
       * requires the re-host to have SUCCEEDED. The two were conflated until
       * run 14: a failed re-host silently downgraded a document turn to the
       * ordinary agent floor, so the agent got less time exactly when it had
       * more to do. What the agent can DO depends on the bytes arriving; how
       * long it may take depends on the organizer having sent a file at all.
       */
      hadAttachment: boolean;
    }
  /**
   * A document the organizer sent their companion after the trip was
   * confirmed. Read and PROPOSED, never written — see document-correction.ts.
   */
  | {
      kind: "document_correction";
      chatId: string;
      tripId: string;
      sessionId: string;
      language: Language;
      event: WireMessageEvent;
      analytics?: InboundFacts;
    }
  /** The organizer's Approve / Keep on one of those proposals. */
  | {
      kind: "correction_callback";
      chatId: string;
      callbackQueryId: string;
      proposalId: string;
      choice: "approve" | "reject";
      fromId: string;
    }
  /** A signup-approval callback — the pre-existing telegram-poller path. */
  | { kind: "approval_callback"; callbackQueryId: string; data: string; fromId: string }
  /** Nothing to do. */
  | { kind: "ignore"; reason: string; analytics?: InboundFacts };

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
  companionPending: string;
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
  /**
   * The organizer's group-binding token, with what to do with it.
   *
   * A function rather than a template string because the token is the whole
   * message: everything around it exists to get it posted in the right place,
   * after the right step.
   */
  groupTokenIssued: (token: string) => string;
  /** Asked for a token somewhere it cannot be issued — not a DM, or no trip. */
  groupTokenUnavailable: string;
  /**
   * ONE message for every reason a token was refused.
   *
   * Distinguishing "no such token" from "that token is not yours" would confirm
   * a guess to whoever is guessing, in a room the organizer does not control.
   */
  groupTokenRefused: string;
  /**
   * Their own live code, pasted in their own chat with the bot instead of in
   * the family group. Says where it goes, rather than quietly doing something
   * else with it.
   */
  groupTokenBelongsInGroup: string;
  /** Bound, but the trip has no introduction facts stored to greet with. */
  groupBoundNoIntro: string;
}

/**
 * Default copy. Deliberately plain and non-committal about WHY a link failed:
 * the distinctions available today (unknown vs consumed vs revoked all arrive
 * as one reason — see chat-router's note) are not ones the organizer can act
 * on differently, and guessing would be worse than a single honest sentence.
 */
export const DEFAULT_STRINGS: DispatchStrings = {
  groupTokenIssued: (token: string) =>
    [
      "To connect me to your family group:",
      "",
      "1. Add me to the group",
      "2. Make me an admin — I need that to pin the welcome message",
      "3. Post this line in the group:",
      "",
      token,
      "",
      "If you post it before making me an admin, that's fine — just post it again afterwards and I'll set things up properly.",
    ].join("\n"),
  groupTokenUnavailable:
    "I can only set up a group from your own chat with me, once your trip site is ready.",
  groupTokenRefused:
    "That code didn't work here. Ask the trip organizer to send you a fresh one.",
  groupTokenBelongsInGroup:
    "That's your group code — it works in the family group, not here. Add me to the group, make me an admin, and post it there.",
  groupBoundNoIntro: "This group is connected to the trip.",
  unbound:
    "I don't have a trip for this chat yet. Open the link from your Kinerary signup to get started.",
  // Bound, but the assistant behind it is not ready. Says what is true — the
  // trip exists, the site is up — without claiming an assistant that cannot
  // answer. The alternative, `unbound`'s "I don't have a trip for this chat",
  // is what a real organizer was told on 2026-09-06 about a trip that had
  // provisioned perfectly.
  companionPending:
    "Your trip is set up and the site is ready — I'm still finishing your assistant. Try me again shortly.",
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
  /**
   * Documents sent to a group without addressing the assistant, waiting for
   * their sender's next addressed message. Must outlive a single update, so
   * the poller owns it. Absent, such a document is simply dropped.
   */
  pendingAttachments?: PendingAttachments;
  /**
   * What the family said in a group while nobody was addressing the assistant,
   * carried onto the next message that does. Owned by the poller for the same
   * reason as the attachments above: it has to outlive one update. Absent,
   * unaddressed turns are simply forgotten, which is the behaviour before
   * 2026-09-20.
   */
  groupContext?: GroupContext;
  /**
   * Whether a trip's companion gateway is connected right now.
   *
   * Injected rather than looked up so the router keeps its property of
   * performing no I/O of its own. Absent means "assume reachable", which is
   * what every caller did before per-trip gateway processes existed.
   */
  canReachProfile?: (profile: string) => boolean;
  /**
   * Whether the group's arrival message carries the shared site password.
   *
   * The trip login IS shared by design, and the arrival message is pinned so a
   * member who joins later can scroll back to it — that is the argument for.
   * Against: a password in a group is durable, searchable, and visible to
   * everyone ever added to that group, including after the trip. Both are true,
   * the choice is the deployment's, and turning it off changes nothing else
   * about the message (the group is told who to ask instead).
   *
   * Defaults to true, matching the organizer's stated intent on 2026-09-07.
   */
  groupIntroIncludesPassword?: boolean;
  /** How long a group-binding token stays valid. Defaults to a week. */
  groupBindingTtlSeconds?: number;
  /**
   * The bot handle the "Open trip" link points at: `web.telegram_bot_username`,
   * the bot whose Main Mini App signs people in. NOT the relay's own `getMe`
   * handle: no `web` block means no Mini App, whatever bot the relay is.
   */
  tripAppBotUsername?: string | null;
  /**
   * Is the Mini App ready for that bot (relay/trip-app-readiness.ts): enabled,
   * and the bot's Main Mini App is set. Asked on every update, so a flip needs no
   * restart. Absent - and anything but exactly `true` - is NOT ready: no Open
   * trip message on a binding, `/app` answers "not available yet", and the plain
   * words are left to the companion (owner decision 2026-10-20).
   */
  tripAppReady?: () => boolean;
  /**
   * The signup super admin, as the subject digest approvals are checked
   * against. Absent means nobody may switch models from a chat.
   */
  superAdminSubjectDigest?: string;
  /** The relay's runner. `/model` can switch it only when it is switchable. */
  modelRunner?: StructuredModelRunner;
  /**
   * Attach an `analytics` descriptor — metadata only, see
   * analytics/relay-facts.ts — to the companion-route decisions, for the
   * relay's assistant events (#177). Absent or false, the default: every
   * decision is exactly what it was before this option existed, and no extra
   * lookup is made. True adds one read (the sender's trip person link) for an
   * unaddressed group message and one (the chat's route) for a
   * companion-unreachable answer; a failed read drops the descriptor, never
   * the decision.
   */
  assistantEvents?: boolean;
  /**
   * Per-chat limit on the generic "assistant is down" line. Absent, the relay
   * process's own is used; tests pass a fresh one.
   */
  outageNotices?: OutageNoticeLimiter;
  /**
   * The organizer's private-chat document route (#178) — a file the organizer
   * sends after confirmation, read by the relay and proposed back to them,
   * whose Approve re-provisions the site. ON only when exactly `true`, which
   * the relay passes only for ORGANIZER_DOCUMENT_ROUTE_ENABLED=1
   * (document-correction.ts). Absent or false, the default: such a file takes
   * the companion route, exactly as before #178.
   */
  organizerDocumentRoute?: boolean;
  /**
   * The group judge (relay/group-judge.ts): asked, last of all, whether an
   * unaddressed group message is meant for the assistant. Absent - JUDGE_RUNNER
   * unset, the default - nothing is asked and an unaddressed message is
   * NOT_ADDRESSED exactly as before. Injected, like the runner, so this module
   * stays testable without a network.
   */
  groupJudge?: GroupJudge;
  /**
   * Do not wait for the judge. When a group message reaches the judge step, return
   * `{ kind: "judge_pending", ask }` instead of awaiting the model; the caller runs
   * `ask()` OFF its loop (the poller does, one chain per chat so a chat's messages
   * keep their order), then calls `dispatchUpdate` again for the same update with
   * `judgedOutcome` set to the result. Absent or false - the default, and every
   * test and tool that calls this directly - the judge is awaited right here.
   *
   * The second call is safe because everything before the judge step is a read for a
   * message that reaches it: it was not addressed, so the "?" window claim found
   * nothing to consume and the conversation window did not list the sender.
   */
  deferJudge?: boolean;
  /**
   * The judge's verdict on THIS update, from a `judge_pending` round trip. `null` is
   * "not asked or no usable answer": the message is NOT_ADDRESSED. Set, it replaces
   * the call; the judge is never asked twice.
   */
  judgedOutcome?: JudgeOutcome | null;
}

/**
 * At most one "the assistant is down" line per chat per window (#179).
 *
 * In memory, in the relay process, bounded: the oldest chat is evicted first.
 * A relay restart forgets it and may repeat one line - accepted, because the
 * alternative is a table for a courtesy. Deliberately a small object with one
 * question (`allow`) and a clock, so an outage-state design (#187: tell the
 * organizer once per outage, recover, escalate) can replace it without
 * touching the router.
 */
export class OutageNoticeLimiter {
  static readonly WINDOW_MS = 10 * 60 * 1000;
  static readonly MAX_CHATS = 1000;
  private readonly lastSent = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** True, and starts the window, when this chat may be told now. */
  allow(chatId: string): boolean {
    const at = this.now();
    const last = this.lastSent.get(chatId);
    if (last !== undefined && at - last < OutageNoticeLimiter.WINDOW_MS) return false;
    // Re-insert so Map order is "told longest ago first".
    this.lastSent.delete(chatId);
    this.lastSent.set(chatId, at);
    while (this.lastSent.size > OutageNoticeLimiter.MAX_CHATS) {
      const oldest = this.lastSent.keys().next().value;
      if (oldest === undefined) break;
      this.lastSent.delete(oldest);
    }
    return true;
  }
}

/** The relay process's own, used when a caller supplies none. */
const processOutageNotices = new OutageNoticeLimiter();

/** Whether a message replies to something the assistant itself sent. */
function repliesToAssistant(message: TelegramMessage, botIdentity: BotIdentity): boolean {
  const repliedTo = message.reply_to_message?.from;
  if (!repliedTo) return false;
  // Precise when we know our own id: a reply to some OTHER bot in the group is
  // not a reply to us.
  return botIdentity.id ? String(repliedTo.id) === botIdentity.id : Boolean(repliedTo.is_bot);
}

/**
 * The "Open trip" message for a trip, or null with a logged reason. Never
 * silent: a deployment with no bot handle would otherwise lose the button with
 * nothing anywhere to say why (the failure mode bot-username.ts exists for).
 */
function openTripFor(
  tripId: string,
  language: Language,
  options: DispatchOptions,
  botIdentity: BotIdentity,
  log: (line: string) => void,
): OpenTripMessage | null {
  // Unknown is not ready. Quiet on purpose: not being ready is a state, and the
  // readiness module logs its own flips; this runs on every binding.
  if (!tripAppIsReady(options)) return null;
  const handle = normaliseBotUsername(options.tripAppBotUsername);
  const message = openTripMessage(handle, tripId, language);
  if (!message) {
    log(structuredLog("warn", "trip_bot.open_trip_unavailable", { reason: handle ? "BAD_TRIP_ID" : "NO_BOT_USERNAME" }));
  }
  return message;
}

/** Exactly `true` from the readiness check, and nothing else, is ready. */
function tripAppIsReady(options: DispatchOptions): boolean {
  try {
    return options.tripAppReady?.() === true;
  } catch {
    return false;
  }
}

/**
 * A PRIVATE chat with no trip, written to by a Telegram account that has live
 * organizer trip links: answer with the trips list and buttons `/trips` gives
 * (the same one `/app` already answers in an unbound DM) instead of "I don't have
 * a trip for this chat" / "open the link from your signup email" - sentences that
 * are wrong for someone who has trips and just needs to pick one. Reached after an
 * Unlink + Restore on a chat whose route could not be reopened, and in any DM the
 * account has never routed.
 *
 * Null (the caller keeps its old reply) for a group, a sender we cannot see, and a
 * sender with no live link - an unknown sender learns exactly what they did before.
 * The list is re-derived from the update's own verified sender id, and the buttons
 * re-authorise each tap, exactly like `/trips`.
 */
async function unboundDmTripList(
  db: pg.Pool,
  message: { chat?: { type?: string }; from?: { id?: number | string; language_code?: string } },
  chatId: string,
): Promise<DirectReply | null> {
  // The sender must BE the chat: in a private chat the two ids are the same, so any other pairing is not a
  // person writing in their own DM, and gets the old reply rather than a list.
  if (message.chat?.type !== "private" || message.from?.id === undefined || String(message.from.id) !== chatId) return null;
  const trips = await listOrganizerTrips(db, String(message.from.id), chatId);
  if (trips.length === 0) return null;
  const language = await resolveChatLanguage(db, chatId, message.from?.language_code);
  const rendered = renderTripList(trips, language);
  return { chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined };
}

export async function dispatchUpdate(
  db: pg.Pool,
  update: TelegramUpdate,
  strings: DispatchStrings = DEFAULT_STRINGS,
  log: (line: string) => void = () => {},
  botIdentity: BotIdentity = {},
  options: DispatchOptions = {},
): Promise<DispatchDecision> {
  if (update.callback_query) return dispatchCallback(db, update, log);

  // Added to a group. If that group is already bound to a trip, this is the
  // companion's arrival and it introduces itself; if it is not, saying so is
  // better than sitting silent in a room people just invited it into.
  const joined = botJoinedGroup(update, botIdentity.id);
  if (joined) {
    const route = await resolveChatRoute(db, joined.chatId);
    if (route.kind !== "companion") {
      // Not `strings.unbound` ("open the link from your signup"): with the
      // one-tap add link the binding key arrives right after this join, and
      // that sentence would contradict it. Ordinary messages in an unbound
      // chat keep `strings.unbound`; only the join has the owner's wording.
      // The language is the adder's Telegram locale — the only evidence a
      // chat with no trip has.
      const language = coerceLanguage(update.my_chat_member?.from?.language_code) ?? "en";
      return { kind: "reply", reply: { chatId: joined.chatId, text: uiString("joinedUnbound", language) } };
    }
    const facts = await companionIntroFacts(db, route.tripId);
    const assistantName = typeof facts?.assistant_name === "string" ? facts.assistant_name : null;
    // No stored facts means a trip provisioned before migration 0044, or one
    // that never finished. Nothing to introduce, and inventing a name here is
    // exactly what this module refuses to do.
    if (!facts || !assistantName) return { kind: "ignore", reason: "NO_INTRO_FACTS" };
    const joinedOpenTrip = openTripFor(route.tripId, facts.language === "he" ? "he" : "en", options, botIdentity, log);
    return {
      kind: "group_intro",
      chatId: joined.chatId,
      ...(joinedOpenTrip ? { openTrip: joinedOpenTrip } : {}),
      text: groupIntroText(
        {
          assistantName,
          tripTitle: typeof facts.trip_title === "string" ? facts.trip_title : null,
          siteUrl: typeof facts.private_url === "string" ? facts.private_url : "",
          language: facts.language === "he" ? "he" : "en",
          loginPassword: typeof facts.login_password === "string" ? facts.login_password : null,
          loginUsernames: companionIntroLoginUsernames(facts),
          botUsername: botIdentity.username,
          organizerName: typeof facts.organizer === "string" ? facts.organizer : null,
          proactive: (facts.proactive as never) ?? null,
        },
        { includePassword: options.groupIntroIncludesPassword ?? true },
      ),
    };
  }

  // A supergroup migration is repaired BEFORE anything is routed. Telegram
  // delivers it as an ordinary message with no text, so the branches below
  // would drop it on NO_TEXT and the binding would quietly go stale — the
  // companion falling silent in a live family group with nothing in the
  // conversation to explain it.
  const migration = migrationOf(update.message ?? update.edited_message);
  if (migration) {
    const moved = await migrateChatBinding(db, migration.from, migration.to);
    log(structuredLog("info", "trip_bot.chat_migrated", { moved }));
    // Nothing to say to anyone: from the family's side the group simply kept
    // working, which is the whole point.
    return { kind: "ignore", reason: moved ? "CHAT_MIGRATED" : "CHAT_MIGRATION_NOOP" };
  }

  const message = update.message ?? update.edited_message;
  const rawChatId = message?.chat?.id;
  if (!message || rawChatId === undefined || rawChatId === null || rawChatId === "") {
    return { kind: "ignore", reason: "NO_MESSAGE" };
  }
  const chatId = String(rawChatId);
  if (message.from?.is_bot) return { kind: "ignore", reason: "FROM_BOT" };

  const text = message.text ?? message.caption ?? "";
  const parsed = parseInbound(text);

  // The one-tap add-to-group link. Telegram answers `?startgroup=<token>` by
  // adding the bot to the group the organizer picked and then posting
  // `/start@<bot> <token>` THERE, from the organizer. That is a group-binding
  // redemption, not the onboarding `/start` below: it is claimed here, only in a
  // non-private chat and only when the payload is exactly a binding token, and
  // it falls through to the same redemption `/group <token>` goes through. A
  // private `/start <anything>` never gets here (the enrollment path owns it),
  // and a group `/start` with any other payload keeps its old answer.
  const groupStartToken = parsed.kind === "start" && message.chat?.type !== "private"
    ? groupBindingTokenFromStartPayload(parsed.payload)
    : null;

  // The dashboard's "Link Telegram" deep link. Claimed before the enrollment
  // path because the payload shape (lk_ + 32 characters) is not an enrollment
  // token's (43), and the sender id is the update's own, never the message's.
  // Private chats only, and a link opened in a group is NOT consumed. Every
  // refusal is the same sentence (telegram-link-token.ts).
  const linkToken = parsed.kind === "start" ? telegramLinkTokenFromStartPayload(parsed.payload) : null;
  if (linkToken) {
    const language = await resolveChatLanguage(db, chatId, message.from?.language_code);
    if (message.chat?.type !== "private" || message.from?.id === undefined) {
      return { kind: "reply", reply: { chatId, text: strings.notPrivate } };
    }
    const linked = await redeemTelegramLinkToken(db, linkToken, String(message.from.id), telegramDisplayName(message.from));
    log(structuredLog("info", "trip_bot.telegram_link", { outcome: linked.ok ? (linked.alreadyLinked ? "already_linked" : "linked") : "refused" }));
    return {
      kind: "reply",
      reply: {
        chatId,
        text: linked.ok
          ? uiString("telegramLinked", language).replace("{trip}", () => linked.tripTitle)
          : uiString("telegramLinkRefused", language),
      },
    };
  }

  if (parsed.kind === "start" && !groupStartToken) {
    const outcome = await startFromDeepLink(db, chatId, parsed.payload, log, message.from?.language_code, telegramDisplayName(message.from));
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
        const rendered = renderDocumentOffer(outcome.view.language, outcome.returning, outcome.seeded);
        return {
          kind: "reply",
          reply: { chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined },
        };
      }
      case "already_in_interview":
        return { kind: "reply", reply: { chatId, text: strings.alreadyInterviewing } };
      case "rejected": {
        // A bare `/start` in a private chat that has no trip, from an account with live organizer links:
        // its trips to pick from, not "welcome" (a payload we rejected as bad keeps its bad-link answer).
        if (outcome.reason === "NO_PAYLOAD" && !parsed.malformed && (await resolveChatRoute(db, chatId)).kind === "unbound") {
          const list = await unboundDmTripList(db, message, chatId);
          if (list) return { kind: "reply", reply: list };
        }
        return {
          kind: "reply",
          reply: {
            chatId,
            text:
              // A payload we could never have issued is a BAD LINK, not a
              // bare `/start`. Both reach `startFromDeepLink` with no payload
              // — nothing malformed is allowed near the token lookup — so the
              // parse result, not the outcome, is what tells them apart.
              // Without this, `/start <anything>` answered "Welcome to
              // Kinerary", which reads as though the code was accepted.
              outcome.reason === "NO_PAYLOAD" && !parsed.malformed
                ? strings.noPayload
                : outcome.reason === "NOT_PRIVATE_CHAT"
                  ? strings.notPrivate
                  : strings.badLink,
          },
        };
      }
    }
  }

  // `/models` and `/model`: which model serves each task, switched at runtime.
  //
  // The super admin only, in their own DM with the bot, identified by the
  // Telegram sender id Telegram itself delivered — the same digest signup
  // approvals are checked against, never anything written in the message. For
  // anyone else, or anywhere else, this branch does not exist: the command falls
  // through to the answer every other unknown command gets, so asking reveals
  // nothing about who may switch models or that anyone can.
  if (
    parsed.kind === "command"
    && (parsed.name === "model" || parsed.name === "models")
    && message.chat?.type === "private"
    && options.superAdminSubjectDigest
    && message.from?.id !== undefined
    && digestTelegramId(String(message.from.id)) === options.superAdminSubjectDigest
  ) {
    const runner = isSwitchableRunner(options.modelRunner) ? options.modelRunner : undefined;
    const text = await handleModelCommand(db, runner, parsed, options.superAdminSubjectDigest, log);
    return { kind: "reply", reply: { chatId, text } };
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
  // A binding token posted in a group, normally as `/group KIN-XXXXXXXX`.
  //
  // Checked BEFORE routing, because the whole point is that this group is not
  // routed yet — the ordinary path would answer UNROUTED and tell the organizer
  // the bot has no trip for the very group they are binding. And before the
  // `/group` ISSUANCE branch below, because in a group `/group <token>` means
  // redeem, not "send me another token".
  //
  // WHY A COMMAND AND NOT A BARE TOKEN. Telegram privacy mode: a bot that is
  // not an admin receives only commands, replies and mentions in a group. A
  // token pasted as ordinary text would never reach us — and the case that
  // breaks is precisely the one this flow promises to recover, "you posted it
  // before making me an admin, post it again". Under privacy mode that second
  // post would vanish too. A command is delivered either way.
  //
  // A bare token is still accepted, because it costs nothing and works once the
  // bot IS an admin (admins see every message). The instructions teach the
  // command, which is the form that always arrives.
  const postedToken = message.chat?.type !== "private"
    ? groupStartToken ?? extractGroupBindingToken(text)
    : null;
  if (postedToken) {
    const senderId = message.from?.id === undefined ? null : String(message.from.id);
    const redeemed = senderId
      ? await redeemGroupBindingToken(db, postedToken, chatId, senderId)
      : ({ ok: false, reason: "WRONG_SENDER" } as const);
    if (!redeemed.ok) {
      log(structuredLog("info", "trip_bot.group_binding_refused", { reason: redeemed.reason }));
      // A valid code, from its own holder, in a group that belongs to another trip: the sender
      // does not organize both. Said in the GROUP's language (the chat is still bound to the
      // trip it belongs to), one sentence for every way of failing the check.
      if (redeemed.reason === "GROUP_MOVE_NOT_ORGANIZER") {
        const language = await resolveChatLanguage(db, chatId, message.from?.language_code);
        return { kind: "reply", reply: { chatId, text: uiString("groupMoveNotOrganizer", language) } };
      }
      // Deliberately one message for every other refusal. Distinguishing "that token
      // does not exist" from "that token is not yours" would confirm a guess to
      // whoever is guessing, in a room the organizer does not control.
      return { kind: "reply", reply: { chatId, text: strings.groupTokenRefused } };
    }
    log(structuredLog("info", "trip_bot.group_bound", { rebound: redeemed.rebound }));
    if (redeemed.movedFromTripId) {
      // In-memory, chat-keyed state belongs to the trip the group WAS: forget it, so the old
      // trip's overheard messages and held documents never reach the new trip's companion.
      options.groupContext?.clear(chatId);
      options.pendingAttachments?.clearChat(chatId);
      log(structuredLog("info", "trip_bot.group_moved", { from_trip_id: redeemed.movedFromTripId, to_trip_id: redeemed.tripId }));
    }
    const facts = await companionIntroFacts(db, redeemed.tripId);
    const assistantName = typeof facts?.assistant_name === "string" ? facts.assistant_name : null;
    if (!facts || !assistantName) {
      return { kind: "reply", reply: { chatId, text: strings.groupBoundNoIntro } };
    }
    // The way into the Mini App for this trip, posted and pinned right after the
    // introduction (#443). Built from the trip the TOKEN named, never from the
    // message; a re-bind to another trip therefore posts that trip's button, and
    // the poller replaces one of ours pinned earlier.
    const boundOpenTrip = openTripFor(redeemed.tripId, facts.language === "he" ? "he" : "en", options, botIdentity, log);
    // A group carried over from another trip says so first, in the NEW trip's language: the
    // people in it were talking to a different trip's assistant a moment ago.
    const movedNotice = redeemed.movedFromTripId
      ? `${uiString("groupMovedNotice", facts.language === "he" ? "he" : "en").replace(
          "{trip}",
          typeof facts.trip_title === "string" && facts.trip_title.trim()
            ? facts.trip_title.trim()
            : uiString("groupMovedNoticeUntitled", facts.language === "he" ? "he" : "en"),
        )}\n\n`
      : "";
    return {
      kind: "group_intro",
      chatId,
      ...(boundOpenTrip ? { openTrip: boundOpenTrip } : {}),
      text: movedNotice + groupIntroText(
        {
          assistantName,
          tripTitle: typeof facts.trip_title === "string" ? facts.trip_title : null,
          siteUrl: typeof facts.private_url === "string" ? facts.private_url : "",
          language: facts.language === "he" ? "he" : "en",
          loginPassword: typeof facts.login_password === "string" ? facts.login_password : null,
          loginUsernames: companionIntroLoginUsernames(facts),
          botUsername: botIdentity.username,
          organizerName: typeof facts.organizer === "string" ? facts.organizer : null,
          proactive: (facts.proactive as never) ?? null,
        },
        { includePassword: options.groupIntroIncludesPassword ?? true },
      ),
    };
  }

  // THE SAME CODE, PASTED IN THE WRONG CHAT.
  //
  // A group code posted in the organizer's own DM had two ways to go and
  // neither said anything true. As bare text it was not a command, so it fell
  // through to routing and reached the COMPANION, which answered it as
  // conversation — Dror, 2026-09-18: "I gave it invalid token and got a
  // greeting, it should have said unknown". With `/group` in front it hit the
  // issuance branch below, whose argument is ignored, and minted a brand new
  // token — so a wrong code produced a working one and a right code was
  // silently replaced.
  //
  // Checked here: after the group redemption above (which owns the case where
  // this belongs) and before both routing and issuance.
  //
  // `groupBindingTokenIsOwn` reads, never redeems — a DM is not a group and
  // binding one would rebind the very channel the code arrived on. It asks
  // only whether the code is this chat's own live one, so the answer carries
  // nothing the sender did not already hold; everything else gets the same
  // flat refusal a group would give.
  const dmToken = message.chat?.type === "private" ? extractGroupBindingToken(text) : null;
  if (dmToken) {
    const route = await resolveChatRoute(db, chatId);
    const senderId = message.from?.id === undefined ? null : String(message.from.id);
    const own = route.kind === "companion" && senderId !== null
      && await groupBindingTokenIsOwn(db, dmToken, route.tripId, senderId);
    log(structuredLog("info", "trip_bot.group_token_in_dm", { own }));
    return {
      kind: "reply",
      reply: { chatId, text: own ? strings.groupTokenBelongsInGroup : strings.groupTokenRefused },
    };
  }

  // Renaming the assistant: `/name סולו` or `/name סולו / Solo`.
  //
  // Anyone in a chat bound to the trip, group or DM — no approval, by Dror's
  // rule of 2026-09-13. Router-owned because the router is what has to HEAR a
  // new name: a group message reaches the companion only when it names the
  // assistant, and the names that count are `trips.assistant_names`. A family
  // renamed their assistant in conversation that day; it agreed, saved the
  // name to its own memory, and every message using it was dropped here as
  // NOT_ADDRESSED. The companion's `set_assistant_names` tool does the same
  // write from its side (companion-mcp.ts).
  //
  // Mid-interview it is not ours to handle — the assistant's name is still a
  // question there — so it falls through to the command gate's answer.
  if (parsed.kind === "command" && (parsed.name === "name" || parsed.name === "rename")) {
    const route = await resolveChatRoute(db, chatId);
    if (route.kind === "unbound") {
      return { kind: "reply", reply: { chatId, text: strings.unbound } };
    }
    if (route.kind === "companion") {
      const facts = await companionIntroFacts(db, route.tripId);
      const language = facts?.language === "he" ? "he" : "en";
      const argument = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?\s+([\s\S]+)$/.exec(text.trim())?.[1]?.trim() ?? "";
      if (!argument) {
        return { kind: "reply", reply: { chatId, text: renameUsage(language, await getAssistantNames(db, route.tripId)) } };
      }
      const names = parseAssistantNames(argument);
      if (!names.ok) {
        log(structuredLog("info", "trip_bot.rename_refused", { reason: names.reason }));
        return { kind: "reply", reply: { chatId, text: renameRefused(language) } };
      }
      const now = await setAssistantNames(db, route.tripId, names.names);
      log(structuredLog("info", "trip_bot.renamed", { via: "command", names: now?.length ?? 0 }));
      return { kind: "reply", reply: { chatId, text: renameConfirmation(language, now ?? names.names) } };
    }
  }

  // `/proactive`, `/proactive 1|2|3`: how much the assistant takes part in THIS
  // group (chat-router.ts, PROACTIVE_*). A preference, not a privacy switch.
  // Anyone may read it; only the trip's organizer - a fact from the control
  // plane's own links, never from the message - may change it. Router-owned like
  // /name: it changes what the router hears, and Hermes' own command surface is
  // not ours to extend.
  if (parsed.kind === "command" && parsed.name === "proactive") {
    const route = await resolveChatRoute(db, chatId);
    if (route.kind === "unbound") {
      return { kind: "reply", reply: { chatId, text: strings.unbound } };
    }
    if (route.kind === "companion") {
      const language = await tripLanguage(db, route.tripId);
      if (message.chat?.type === "private") {
        return { kind: "reply", reply: { chatId, text: proactiveInPrivateChat(language) } };
      }
      const argument = (parsed.argument ?? "").trim();
      const requested = argument === "1" || argument === "2" || argument === "3" ? (Number(argument) as ProactiveLevel) : null;
      // Nothing, or something that is not 1, 2 or 3: the options. A read never needs a role.
      if (requested === null) {
        const current = (await groupProactiveLevelSetting(db, chatId).catch(() => null)) ?? PROACTIVE_JOINS_IN;
        return { kind: "reply", reply: { chatId, text: proactiveStatus(language, current) } };
      }
      const senderId = message.from?.id === undefined ? null : String(message.from.id);
      if (!senderId || !(await isTripOrganizer(db, route.tripId, senderId))) {
        log(structuredLog("info", "trip_bot.proactive_refused", { reason: "NOT_ORGANIZER" }));
        return { kind: "reply", reply: { chatId, text: proactiveRefused(language) } };
      }
      // A relay running ahead of its migration has no such column: say so to the
      // organizer instead of failing the update (and saying nothing).
      let previous: ProactiveLevel | null;
      try {
        // Keyed by the trip the organizer check above authorised, not by the chat
        // alone: the chat may have been re-bound to another trip since.
        previous = await setGroupProactiveLevel(db, chatId, requested, route.tripId);
      } catch (error) {
        log(structuredLog("warn", "trip_bot.proactive_write_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
        return { kind: "reply", reply: { chatId, text: proactiveUnavailable(language) } };
      }
      if (previous === null) {
        // No open binding of THIS trip on this chat any more: nothing was written.
        log(structuredLog("info", "trip_bot.proactive_not_changed", { reason: "NO_MATCHING_BINDING" }));
        return { kind: "reply", reply: { chatId, text: proactiveUnavailable(language) } };
      }
      // (`level` is a field structuredLog strips: it indexes the line.)
      log(structuredLog("info", "trip_bot.proactive_changed", { proactive_level: requested, previous_level: previous }));
      return {
        kind: "reply",
        reply: { chatId, text: proactiveChanged(language, requested) },
        // Counts only: how many groups turn it down is a KPI. A repeat of the
        // current level is not a change.
        ...(options.assistantEvents && previous !== null && previous !== requested
          ? { levelChange: { tripId: route.tripId, level: requested, direction: requested > previous ? "raised" as const : "lowered" as const } }
          : {}),
      };
    }
  }

  // The organizer asking for a group-binding token, in their own DM. Router-
  // owned rather than agent-owned for the same reason the introduction is: the
  // token is a credential, and one the agent got slightly wrong is a token that
  // binds nothing and an organizer who cannot tell why.
  if (parsed.kind === "command" && (parsed.name === "group" || parsed.name === "bind")) {
    const route = await resolveChatRoute(db, chatId);
    const senderId = message.from?.id === undefined ? null : String(message.from.id);
    if (route.kind !== "companion" || !senderId || message.chat?.type !== "private") {
      // Asked somewhere it cannot be answered. Silence would read as broken.
      return { kind: "reply", reply: { chatId, text: strings.groupTokenUnavailable } };
    }
    // Organizer only, by the same check /proactive makes (a fact from the control
    // plane's own links, never from the message). A private chat bound to the trip
    // is not proof of that: a member's linked DM resolves to the same companion
    // route, and the token (and the link carrying it) binds a group to the trip.
    // A demoted organizer (link revoked) fails it too. Same sentence as every
    // other refusal here; no token is issued.
    if (!(await isTripOrganizer(db, route.tripId, senderId))) {
      log(structuredLog("info", "trip_bot.group_token_refused", { reason: "NOT_ORGANIZER" }));
      return { kind: "reply", reply: { chatId, text: strings.groupTokenUnavailable } };
    }
    const issued = await issueGroupBindingToken(db, route.tripId, senderId, {
      ttlSeconds: options.groupBindingTtlSeconds ?? 7 * 24 * 3600,
    });
    if (!issued.ok) {
      return { kind: "reply", reply: { chatId, text: strings.groupTokenUnavailable } };
    }
    // The one-tap add-to-group link: the greeting's own builder (`groupAddUrl`),
    // with this token as the payload, so what /group hands over and what the
    // post-interview greeting sends are the same link. Without a bot handle
    // there is no link; the reply then goes out as it always did, and the gap
    // is logged rather than silent (the greeting does the same).
    const addUrl = groupAddUrl(botIdentity.username, issued.token);
    if (!addUrl) log(structuredLog("warn", "trip_bot.group_link_unavailable", { reason: "NO_BOT_USERNAME" }));
    const addLine = addUrl ? groupAddLinkLine(await tripLanguage(db, route.tripId), addUrl) : null;
    const instructions = strings.groupTokenIssued(issued.token);
    // Two messages: the instructions (and the link), then the line to copy on its own.
    return {
      kind: "group_intro",
      chatId,
      text: addLine ? `${instructions}\n\n${addLine}` : instructions,
      followUp: groupBindingCommand(issued.token),
      pin: false,
    };
  }

  // "Which trips are mine, and which one is this chat on?" — the two questions
  // a shared bot otherwise gives an organizer no way to ask. See
  // organizer-trips.ts for why the answer is derived from the sender's
  // verified Telegram id rather than from anything typed.
  if (
    parsed.kind === "command" &&
    (parsed.name === "trips" || parsed.name === "switch" || parsed.name === "select")
  ) {
    const senderId = message.from?.id === undefined ? null : String(message.from.id);
    const language = await resolveChatLanguage(db, chatId, message.from?.language_code);

    // DM only, both commands. For /trips because the list would expose trips
    // the rest of the room has no claim to; for /switch because a group's
    // binding belongs to the family, not to whoever typed — on a shared bot,
    // one member could otherwise move the room to another organizer's trip.
    if (message.chat?.type !== "private" || !senderId) {
      return {
        kind: "reply",
        reply: {
          chatId,
          text: uiString(parsed.name === "trips" ? "tripsInGroup" : "switchInGroup", language),
        },
      };
    }

    const trips = await listOrganizerTrips(db, senderId, chatId);

    // `/switch <something>` is the only path that takes an argument. Without
    // one, /switch and /trips are the same thing: the list, with a button per
    // row. That is deliberate — buttons remove the guessing a typed name
    // invites. They are NOT signed, by decision (2026-09-13): a payload only
    // names a row, and the callback branch re-authorizes every tap from the
    // tapper's verified id, exactly as if they had typed the name.
    const target = parsed.name === "trips" ? null : resolveTripArgument(trips, parsed.argument);
    if (!target) {
      if (parsed.name !== "trips" && parsed.argument) {
        // They named something, and it is not one of theirs. Same sentence a
        // non-existent trip gets.
        log(structuredLog("info", "trip_bot.switch_refused", { reason: "NO_MATCH" }));
        return { kind: "reply", reply: { chatId, text: uiString("switchRefused", language) } };
      }
      const rendered = renderTripList(trips, language);
      return {
        kind: "reply",
        reply: { chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined },
      };
    }

    return {
      kind: "reply",
      reply: { chatId, text: await applySwitch(db, senderId, chatId, target, language, log) },
    };
  }

  if (parsed.kind === "command" && (parsed.name === "done" || parsed.name === "summary")) {
    const route = await resolveChatRoute(db, chatId);
    if (route.kind === "interview") {
      const result = await setFinishRequestedForChat(db, chatId, true);
      if (result.ok) return { kind: "show_summary", chatId, view: result.view };
    }
  }

  // `/app`, and the plain words for it: the "Open trip" button for the chat's
  // trip (#443). Router-owned like /name - it is a fixed message, composed from
  // the chat's own binding, and the companion has no business improvising a link.
  //
  // Anyone in the chat may ask: the button only SELECTS the trip, and the Mini
  // App decides who may open it. Plain words are accepted for the same thing (a
  // command is a shortcut, not syntax) and are matched against a closed list,
  // only when the message is addressed to the assistant, only on a chat bound
  // to a trip. See open-trip.ts.
  const appReady = tripAppIsReady(options);
  const appCommand = parsed.kind === "command" && parsed.name === "app";
  // Not ready: the words are not answered at all (they go on to the companion as
  // any sentence does), and the command says plainly that it is not there yet.
  const appWordsMaybe = appReady && parsed.kind === "text" && couldAskForTripApp(text);
  if (appCommand && !appReady) {
    const language = await resolveChatLanguage(db, chatId, message.from?.language_code);
    log(structuredLog("info", "trip_bot.open_trip_requested", { via: "command", available: false, ready: false }));
    return { kind: "reply", reply: { chatId, text: uiString("openTripUnavailable", language) } };
  }
  if (appCommand || appWordsMaybe) {
    const route = await resolveChatRoute(db, chatId);
    const isPrivate = message.chat?.type === "private";
    if (route.kind === "companion") {
      const chatType = mapChatType(message.chat?.type, message.is_topic_message === true && message.message_thread_id !== undefined);
      const addressedWords = chatType === "dm" || isAddressedToAssistant({
        chatType,
        text,
        assistantNames: route.assistantNames,
        botUsername: botIdentity.username,
        isReplyToAssistant: repliesToAssistant(message, botIdentity),
      });
      const wanted = appCommand || (addressedWords && asksForTripApp(text, {
        assistantNames: route.assistantNames,
        botUsername: botIdentity.username,
      }));
      if (wanted) {
        const language = isPrivate
          ? await resolveChatLanguage(db, chatId, message.from?.language_code)
          : await tripLanguage(db, route.tripId);
        const open = openTripFor(route.tripId, language, options, botIdentity, log);
        log(structuredLog("info", "trip_bot.open_trip_requested", { via: appCommand ? "command" : "words", available: Boolean(open) }));
        if (!open) return { kind: "reply", reply: { chatId, text: uiString("openTripUnavailable", language) } };
        return { kind: "reply", reply: { chatId, text: open.text, replyMarkup: open.replyMarkup } };
      }
    } else if (route.kind === "unbound" && appCommand) {
      const senderId = message.from?.id === undefined ? null : String(message.from.id);
      // Nothing is bound: a group gets the same sentence as any command there.
      if (!isPrivate || !senderId) return { kind: "reply", reply: { chatId, text: strings.unbound } };
      // A private chat with no trip yet: the sender's own trips, to pick one -
      // the same list /trips answers, and the same re-authorising buttons.
      const language = await resolveChatLanguage(db, chatId, message.from?.language_code);
      const rendered = renderTripList(await listOrganizerTrips(db, senderId, chatId), language);
      return { kind: "reply", reply: { chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined } };
    }
    // A live interview, or words that did not amount to a request: not ours.
    // /app mid-interview falls to the command gate below (`notMyCommand`).
  }

  // ── A command is answered HERE, or it is not answered at all ───────────────
  //
  // Every command this router owns has been handled above. What is left is
  // somebody else's command surface — and under the relay, "somebody else"
  // means Hermes, whose own slash commands (/help, /model, /reset, /new,
  // /sethome …) arrive as ordinary text and used to be forwarded to the
  // gateway like any sentence. That handed a family group the controls of the
  // runtime their assistant runs on: on 2026-09-12 a group's first contact
  // answered "type /help to see the available commands", and the connector's
  // leak guard then caught `sethome` and a model-fallback notice on their way
  // into the room.
  //
  // Placed before the route-specific branches below so it covers BOTH gateway
  // paths — the companion's and the interviewer's — rather than the one that
  // happened to be reported. A chat with no trip is left alone: `unbound`
  // already says the one true thing about it, and a help text for an assistant
  // that does not exist would be worse.
  if (parsed.kind === "command") {
    const route = await resolveChatRoute(db, chatId);
    if (route.kind === "companion") {
      const facts = await companionIntroFacts(db, route.tripId);
      return {
        kind: "reply",
        reply: {
          chatId,
          text: companionHelpText({
            assistantName: typeof facts?.assistant_name === "string" ? facts.assistant_name : null,
            siteUrl: typeof facts?.private_url === "string" ? facts.private_url : null,
            language: facts?.language === "he" ? "he" : "en",
            isPrivateChat: message.chat?.type === "private",
            unknownCommand: parsed.name === "help" ? null : parsed.name,
          }),
        },
      };
    }
    if (route.kind === "interview") {
      const session = await getSessionForChat(db, chatId);
      const language = session.ok ? coerceLanguage(session.view.language) ?? "en" : "en";
      return { kind: "reply", reply: { chatId, text: uiString("notMyCommand", language) } };
    }
  }

  const outcome = await normalizeUpdate(db, update, options.canReachProfile);
  if (outcome.kind === "event") {
    // The relevance gate. A DM is addressed by construction; a group message
    // has to actually address the assistant, or the shared bot answers a
    // family talking among themselves. See addressing.ts for why this cannot
    // be left to Hermes's mention_patterns under the relay.
    const isReplyToAssistant = repliesToAssistant(message, botIdentity);

    // Migration 0053: the assistant's own last message here may have asked a
    // question it wants answered, in which case the VERY NEXT message in this
    // chat is addressed to it, whoever sends it — no @mention/name/reply-to
    // needed. Attempted unconditionally, ahead of the ordinary gate below: the
    // atomic claim also clears the window on a hit, so a second message, even
    // one still inside the window, finds nothing left to claim (one-shot).
    // `route.kind === "companion"` is structural, not a real branch here —
    // normalizeUpdate never reaches this point for an interview or unbound
    // chat — mirrored only to match the ternary just below it.
    //
    // It now also reads the group's proactive level (level 1 admits nothing
    // through it), a column a relay running ahead of its migration does not have:
    // a failed claim degrades to "no window", as the conversation window's reads
    // below do, rather than failing the update.
    const senderId = outcome.event.source.user_id;
    const inGroup = outcome.route.kind === "companion" && outcome.event.source.chat_type !== "dm";
    // EXPLICIT addressing: the assistant's name, an @mention of the bot, or a reply
    // to one of its messages. Decided on the message alone - no window, no model.
    const explicitlyAddressed = isAddressedToAssistant({
      chatType: outcome.event.source.chat_type,
      text: outcome.event.text,
      assistantNames: outcome.route.kind === "companion" ? outcome.route.assistantNames : [],
      botUsername: botIdentity.username,
      isReplyToAssistant,
    });
    // A group message with no letter or digit and no attachment (a laugh, a
    // thumbs-up, a lone "?") is a reaction, not a request - EXCEPT as the answer
    // to a question the assistant asked ("Should I update the site?" - 👍 is
    // consent, owner's decision 2026-10-17). Exactly two things make one an
    // answer: the one-shot "?" window is open (the assistant's latest send ended
    // in a question, unanswered, inside 150 s - consumed below, as for any
    // message), or it is a Telegram reply to an assistant message that itself
    // ended in a question. Anything else - a laugh, a thumbs-up to a statement,
    // a reply to a statement - is chatter: the conversation window and the judge
    // never admit it. "The assistant's latest message was a question" is NOT
    // stored anywhere new: the "?" window IS that state, and a reply carries the
    // text it replies to.
    const reactionOnly = inGroup && !outcome.attachment && outcome.event.text.trim() !== "" &&
      !judgeableText(outcome.event.text);
    const repliedToText = message.reply_to_message?.text ?? message.reply_to_message?.caption ?? "";
    const reactionAnswersQuestion = reactionOnly && isReplyToAssistant && looksLikeAQuestion(repliedToText);
    // Explicit addressing as it counts for THIS message: a reaction that replies
    // to a statement is not explicit, whoever's message it replies to.
    const explicitHere = explicitlyAddressed && (!reactionOnly || reactionAnswersQuestion);

    let capturedAsReply = false;
    if (outcome.route.kind === "companion") {
      try {
        capturedAsReply = await consumeExpectsReplyWindow(db, chatId);
      } catch (error) {
        log(structuredLog("warn", "trip_bot.reply_window_read_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
      }
    }

    // Booleans only in the log: no chat or user id beyond what other events carry.
    if (capturedAsReply) log(structuredLog("info", "trip_bot.reply_window_hit", {}));

    if (reactionOnly && !capturedAsReply && !explicitHere) log(structuredLog("info", "trip_bot.reaction_not_forwarded", {}));
    const addressedOtherwise = capturedAsReply || explicitHere;

    // The per-person conversation window (2026-10-16). Consulted LAST, only for
    // a group message every other route has refused: is the sender the one
    // member the assistant is in conversation with here, inside the window?
    // The sender is the Telegram user id the update carried, never anything
    // read from the text. A pure read - the forward below is what renews it.
    //
    // A failed lookup degrades to "not in the window" - today's behaviour -
    // rather than failing the whole update: a relay that runs before the
    // migration is applied (a restart applies none) would otherwise throw on
    // every untagged group message and lose its held documents and overheard
    // context with them. Same rule as the writes.
    let capturedByConversation = false;
    if (!addressedOtherwise && inGroup && senderId && !reactionOnly) {
      try {
        capturedByConversation = await inCompanionConversation(db, chatId, senderId);
      } catch (error) {
        log(structuredLog("warn", "trip_bot.conversation_window_read_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
      }
    }
    if (capturedByConversation) log(structuredLog("info", "trip_bot.conversation_window_hit", {}));

    // The group judge (2026-10-16): LAST of all, and only for a group message
    // every rule above has refused. Existing rules first - anything one of them
    // addressed never reaches a model. Text and captions only: an uncaptioned
    // photo or file has nothing to judge and keeps today's hold-until-addressed
    // behaviour. Every way it can fail ends in NOT_ADDRESSED.
    let capturedByJudge = false;
    let judged: JudgeOutcome | null = null;
    if (
      !addressedOtherwise && !capturedByConversation && inGroup && senderId &&
      options.groupJudge?.model() && outcome.route.kind === "companion" && judgeableText(outcome.event.text)
    ) {
      if (options.judgedOutcome !== undefined) {
        // Second pass of a deferred judgement: the verdict is already in.
        judged = options.judgedOutcome;
      } else {
        const ask = await prepareGroupJudge(db, options.groupJudge, outcome.route, chatId, outcome.event.text, log);
        if (ask === null) judged = null;
        else if (options.deferJudge) return { kind: "judge_pending", chatId, ask };
        else judged = await ask();
      }
      capturedByJudge = judged?.kind === "yes";
    }
    const addressed = addressedOtherwise || capturedByConversation || capturedByJudge;
    // #177: the gate's verdict, as metadata. Only ever called through
    // `withAnalytics`, which never calls it while assistant events are off.
    // The text is taken here, before anything is prefixed to it.
    const heardText = outcome.event.text;
    const routedTripId = outcome.route.kind === "companion" ? outcome.route.tripId : null;
    const seen = (linkRole: string | null | undefined): InboundFacts => {
      if (!routedTripId) throw new Error("NOT_COMPANION_ROUTE");
      const facts = inboundFacts({
        tripId: routedTripId,
        // Telegram's own type for the channel; the gate's mapped one for the trigger.
        telegramChatType: message.chat?.type,
        trigger: classifyTrigger({
          addressed,
          capturedAsReply,
          capturedByConversation,
          capturedByJudge,
          chatType: outcome.event.source.chat_type,
          text: heardText,
          assistantNames: outcome.route.kind === "companion" ? outcome.route.assistantNames : [],
          botUsername: botIdentity.username,
          isReplyToAssistant,
        }),
        linkRole,
        attachmentKind: outcome.attachment?.kind ?? null,
        textLength: heardText.length,
      });
      // Memory-only keys (relay-facts.ts): they let the emitter notice that the
      // same sender, right after a judge_no, then addressed the assistant by name.
      return {
        ...facts,
        chatKey: chatId,
        ...(senderId ? { senderKey: senderId } : {}),
        ...(judged ? { judge: judgeFactsOf(judged) } : {}),
      };
    };
    if (!addressed) {
      // Not for the assistant, so nothing is downloaded. A DOCUMENT is still
      // remembered, by reference, for its sender's next addressed message —
      // "send the file, then say what it is for" is one interaction to the
      // person doing it. Photos are not: in a family group they are the family
      // talking, and a photo followed by an unrelated question is the common case.
      // Remembered, not delivered. Nothing is sent and no model turn happens;
      // this only means the NEXT addressed message knows what it is replying
      // into. Groups only — a DM is addressed by construction, so nothing is
      // ever dropped there.
      // A bare reaction (an emoji, a "?") is not kept either: it adds nothing the
      // companion could use and would only lengthen the block that leads its prompt.
      if (options.groupContext && outcome.event.source.chat_type !== "dm" && outcome.event.text && !reactionOnly) {
        options.groupContext.hold(
          chatId,
          outcome.event.source.user_name || "someone",
          outcome.event.text,
        );
      }
      const held = Boolean(options.pendingAttachments && senderId && outcome.attachment?.kind === "document");
      if (options.pendingAttachments && senderId && outcome.attachment?.kind === "document") {
        options.pendingAttachments.hold(chatId, senderId, outcome.attachment, {
          ...(message.caption ? { caption: message.caption } : {}),
        });
        log(structuredLog("info", "trip_bot.attachment_held", { kind: outcome.attachment.kind }));
      }
      return {
        kind: "ignore",
        reason: "NOT_ADDRESSED",
        ...(await withAnalytics(options.assistantEvents, log, async () => ({
          ...seen(senderId && routedTripId ? (await resolveTripPerson(db, routedTripId, senderId))?.role : null),
          ...(held ? { documentHeld: true } : {}),
        }))),
      };
    }

    // This sender is now one of the members the assistant is talking with in this group:
    // they join the conversation (nobody is displaced) and its shared deadline is extended. Written
    // when the message is FORWARDED, not when the assistant answers, so a
    // follow-up sent while it is still working counts. Whatever route
    // addressed the message - name, mention, reply, the "?" window or this
    // window itself. A failed write is logged and never costs the message.
    if (inGroup && senderId) {
      try {
        await openCompanionConversation(db, chatId, senderId);
      } catch (error) {
        log(structuredLog("warn", "trip_bot.conversation_window_write_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
      }
    }

    // WHOSE VOICE THIS IS, when the trip knows. `user_name` arrives from
    // Telegram, where every sender writes their own — so the assistant was
    // being told "Dror" by the one party with an interest in the answer, and
    // in a family group it had nothing else to go on at all. A trip person
    // link is the control plane's own record (migration 0051), written at
    // provisioning from the interview chat, so it outranks anything the
    // update carries. Unknown senders keep their Telegram name: it is what
    // their family calls them, and the alternative is a blank where a person
    // should be.
    let senderLinkRole: string | null = null;
    if (outcome.route.kind === "companion" && outcome.event.source.user_id) {
      const person = await resolveTripPerson(
        db, outcome.route.tripId, outcome.event.source.user_id,
      );
      senderLinkRole = person?.role ?? null;
      if (person?.displayName) {
        outcome.event.source.user_name = person.displayName;
        log(structuredLog("info", "trip_bot.sender_identified", { role: person.role }));
      }
    }
    // A FILE FROM THE ORGANIZER, AFTER CONFIRMATION, is this relay's to read —
    // proposed back to them for approval, never handed to the companion to
    // write onto the site on its own. Only the organizer's own private chat,
    // from the organizer; a group's or a member's file keeps its route.
    // ONLY WITH THE ROUTE SWITCHED ON (ORGANIZER_DOCUMENT_ROUTE_ENABLED=1): an
    // Approve re-provisions the site, which on a live trip is a mid-trip
    // redeploy. Off — the default — `organizerDocumentRoute` answers null
    // before anything is downloaded, and the file takes the companion route
    // below exactly as it did before #178.
    if (outcome.route.kind === "companion") {
      const organizer = await organizerDocumentRoute(db, {
        tripId: outcome.route.tripId,
        chatId,
        chatType: message.chat?.type,
        fromId: message.from?.id === undefined ? undefined : String(message.from.id),
        // The message's OWN attachment, as normalisation described it. The wire
        // event has no media yet - `attachMedia` runs only once the turn is
        // known to go somewhere - so asking it (as this did until #178) was
        // always "no media", and this route never fired.
        mediaKinds: outcome.attachment ? [outcome.attachment.kind] : [],
        hasMedia: outcome.attachment !== null,
        hasRunner: Boolean(options.modelRunner),
        canReadImages: visionProcessingConfig(options.modelRunner) !== null,
        // Strictly `true`: absent — every caller that never heard of the flag —
        // is off.
        enabled: options.organizerDocumentRoute === true,
        log,
      });
      // The reader needs the file itself, so re-host it now. A download that
      // failed leaves nothing to read: fall through to the companion, which
      // tells the organizer it could not read the file.
      const readable = organizer && outcome.attachment
        ? await attachMedia(
            outcome.event,
            [{ ...outcome.attachment, ...(message.caption ? { caption: message.caption } : {}) }],
            options.media,
          )
        : null;
      if (organizer && readable && (readable.media_urls?.length ?? 0) > 0) {
        return {
          kind: "document_correction",
          chatId,
          tripId: outcome.route.tripId,
          sessionId: organizer.sessionId,
          language: organizer.language,
          event: readable,
          // The route itself proves the organizer: their own private chat,
          // from them, on the trip's confirmed interview chat.
          ...(await withAnalytics(options.assistantEvents, log, () => ({
            ...seen("organizer"),
            documents: outcome.attachment ? 1 : 0,
          }))),
        };
      }
    }

    // A message that got here ONLY because its sender is in conversation with
    // the assistant (no name, @mention, reply-to or "?" window) is marked, so the
    // companion can tell a remark to the family from a message to it, and may
    // answer with the silence sentinel (stay-silent.ts; the connector drops it).
    // Named / mentioned / replying messages never get this mark (see addressedMark below). Text is the only
    // field that reaches the model, so the mark is a fenced line on the text,
    // put on BEFORE the overheard block so that block still leads. An empty
    // text (a photo or file with no caption) gets the mark alone.
    // The judge's yes is marked the same way, for the same reason: the companion
    // is told it was not addressed by name and may stay silent (the second guard
    // against a wrong yes).
    if (capturedByConversation || capturedByJudge) {
      outcome.event.text = `${conversationMark()}\n\n${outcome.event.text}`.trimEnd();
    }
    // The opposite fence (2026-10-17, A3 of the staging run): a group message
    // that EXPLICITLY addressed the assistant - its name, an @mention, a reply to
    // it - says so. The companion's prompt never named its own @handle, so it read
    // "@<bot> where is the hotel?" as meant for someone else and answered with the
    // silence sentinel, twice. Said as a fenced line on the text (the only field
    // that reaches the model), carrying the bot's handle so the companion learns
    // it, and ordered exactly like the conversation mark. The "?" window is NOT
    // explicit - the next message after a question may be anyone's remark - so it
    // keeps today's unmarked form. A DM is addressed by construction, never marked.
    const explicit = inGroup && explicitHere;
    if (explicit) {
      outcome.event.text = `${addressedMark(botIdentity.username)}\n\n${outcome.event.text}`.trimEnd();
    } else if (inGroup && reactionOnly && capturedAsReply) {
      // A reaction that took the "?" window: not addressed by name, so a silence
      // is allowed, but it is told what the bare emoji answers.
      outcome.event.text = `${reactionAnswerMark()}\n\n${outcome.event.text}`.trimEnd();
    }

    // The turns this message is a reply INTO. Prefixed onto the text rather
    // than carried in its own field because the gateway forwards `text` and
    // nothing else reaches the model — a new inbound field would be ignored
    // exactly as `expects_reply` was (#122). Clearly fenced and named as
    // overheard so it reads as background, never as something said to the
    // assistant or asked of it. Empty when there is nothing to carry, so a
    // quiet group's turns look exactly as they did before.
    if (options.groupContext && outcome.event.source.chat_type !== "dm") {
      const overheard = options.groupContext.take(chatId);
      if (overheard.length) {
        const lines = overheard.map((m) => `${m.sender}: ${m.text}`).join("\n");
        outcome.event.text =
          `[overheard in the group since you last spoke — background only, not addressed to you]\n` +
          `${lines}\n[end of overheard]\n\n${outcome.event.text}`;
        log(structuredLog("info", "trip_bot.group_context_carried", { turns: overheard.length }));
      }
    }

    const attachments = attachmentsForAddressedTurn(message, outcome.attachment, chatId, senderId, options.pendingAttachments);
    if (attachments.joined > 0) {
      log(structuredLog("info", "trip_bot.attachments_joined", {
        held: attachments.held,
        replied: attachments.replied,
      }));
    }
    const forwarded = await attachMedia(outcome.event, attachments.list, options.media);
    return {
      kind: "to_gateway",
      event: forwarded,
      ...(explicit ? { explicit: true } : {}),
      ...(await withAnalytics(options.assistantEvents, log, () => ({
        ...seen(senderLinkRole),
        attachmentsJoined: attachments.joined,
        documents: (forwarded.media ?? []).filter((m) => m.kind === "document").length,
      }))),
    };
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
      const attachment = describeAttachment(message);
      return {
        kind: "interview_to_gateway",
        chatId,
        sessionId: route.sessionId,
        hadAttachment: attachment !== null,
        event: await toWireEventWithMedia(
          message,
          chatId,
          text,
          options.interviewerProfile,
          attachment,
          options.media,
        ),
      };
    }
    case "UNROUTED": {
      // A plain message in a PRIVATE chat with no trip, from an account that has organizer trips: the list to
      // pick from (what `/trips` and `/app` give), not "open the link from your signup". Others: as before.
      const list = await unboundDmTripList(db, message, chatId);
      return { kind: "reply", reply: list ?? { chatId, text: strings.unbound } };
    }
    case "COMPANION_PENDING": {
      // Two different situations arrive here, and the family is owed different
      // words for each:
      //   - the trip has NO companion yet (never installed, or mid-install):
      //     the honest "still finishing your assistant", said to whoever writes;
      //   - the trip HAS one and its gateway is not connected right now (an
      //     outage or a restart): the generic line - and never to a family
      //     talking among themselves (#179).
      const route = await resolveChatRoute(db, chatId);
      const chatType = mapChatType(
        message.chat?.type,
        message.is_topic_message === true && message.message_thread_id !== undefined,
      );
      // The relevance gate's verdict, once, for the reply decision and for the
      // record. The expects-reply window is not consulted (claiming it is a
      // write): during an outage the assistant has said nothing to be replied to.
      const gate = {
        chatType,
        text,
        assistantNames: route.kind === "companion" ? route.assistantNames : [],
        botUsername: botIdentity.username,
        isReplyToAssistant: repliesToAssistant(message, botIdentity),
      };
      const addressed = route.kind === "companion" && isAddressedToAssistant(gate);
      const facts = () => companionPendingFacts(db, route, message, gate, addressed);

      // "Has this trip's assistant ever been announced as up?" - the organizer's
      // `companion_ready` message, sent only after the companion exists. Without
      // it a profile is merely stamped: a first-time organizer must not be told
      // "I'm off for now" about an assistant that has not come up yet. Trips
      // that predate that message also keep the honest wording during an outage
      // (the safe direction).
      const announced = route.kind === "companion" && route.hermesProfile
        ? await companionAnnounced(db, route.tripId)
        : false;
      if (route.kind !== "companion" || !announced) {
        return {
          kind: "reply",
          reply: { chatId, text: strings.companionPending },
          ...(await withAnalytics(options.assistantEvents, log, facts)),
        };
      }

      if (chatType !== "dm" && !addressed) {
        // Chatter is never answered, outage or not.
        return {
          kind: "ignore",
          reason: "NOT_ADDRESSED",
          ...(await withAnalytics(options.assistantEvents, log, facts)),
        };
      }
      if (chatType !== "dm" && !(options.outageNotices ?? processOutageNotices).allow(chatId)) {
        // Addressed, but this chat was told a moment ago. NO analytics on
        // purpose: an `ignore` carrying facts is recorded as chatter, and this
        // was a lost turn - an absent event undercounts, a wrong one misleads.
        return { kind: "ignore", reason: "COMPANION_UNAVAILABLE_NOTICE_LIMITED" };
      }
      const intro = await companionIntroFacts(db, route.tripId);
      return {
        kind: "reply",
        reply: { chatId, text: uiString("companionUnavailable", intro?.language === "he" ? "he" : "en") },
        ...(await withAnalytics(options.assistantEvents, log, facts)),
      };
    }
    default:
      return { kind: "ignore", reason: outcome.reason };
  }
}

/** A message worth a model call: it carries at least one letter or digit. A lone emoji or "?" is a reaction. */
function judgeableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Prepares the judge's question about one unaddressed group message: null when it
 * must not be asked - the group's level is below 3 (`/proactive`; a trip that opted
 * out of reply capture reads as level 1), or the level could not be read (fail
 * closed: a relay running ahead of its migration judges nothing) - otherwise the
 * function that asks. The reads happen here, now; only the model call is left to
 * `ask`, which never throws, logs the verdict and its speed (never the text), and
 * may be run later and off the caller's loop.
 */
async function prepareGroupJudge(
  db: pg.Pool,
  judge: GroupJudge,
  route: Extract<ChatRoute, { kind: "companion" }>,
  chatId: string,
  text: string,
  log: (line: string) => void,
): Promise<(() => Promise<JudgeOutcome>) | null> {
  try {
    if ((await groupProactiveLevel(db, chatId)) !== PROACTIVE_JOINS_IN) return null;
  } catch (error) {
    log(structuredLog("warn", "trip_bot.group_judge_level_read_failed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    return null;
  }
  const language = await tripLanguage(db, route.tripId).catch(() => "en" as const);
  return async () => {
    const judged = await judge.judge({ chatId, text, assistantNames: route.assistantNames, language });
    log(structuredLog("info", "trip_bot.group_judged", {
      verdict: judged.kind,
      latency_ms: judged.ms,
      model: judged.model,
      ...(judged.kind === "fallback" ? { reason: judged.reason } : { confidence: judged.confidence }),
      ...(judged.kind === "no" && judged.belowThreshold ? { below_threshold: true } : {}),
    }));
    return judged;
  };
}

/** A judge outcome as the analytics descriptor names it. */
function judgeFactsOf(judged: JudgeOutcome): JudgeFacts {
  const base = { latencyMs: judged.ms, model: judged.model };
  if (judged.kind === "yes") {
    return { ...base, outcome: "judge_yes", confidencePct: Math.round(judged.confidence * 100) };
  }
  if (judged.kind === "no") {
    return {
      ...base,
      outcome: "judge_no",
      confidencePct: Math.round(judged.confidence * 100),
      ...(judged.belowThreshold ? { belowThreshold: true } : {}),
    };
  }
  return { ...base, outcome: "judge_fallback", fallbackReason: judged.reason };
}

/**
 * The `analytics` field to spread into a decision — or nothing (#177).
 *
 * Off, it returns `{}` without calling `build`, so the decision is exactly
 * what it was before assistant events existed. On, a `build` that throws (a
 * failed lookup, a route that is not a companion's) costs the descriptor and
 * a log line, never the decision.
 */
async function withAnalytics(
  enabled: boolean | undefined,
  log: (line: string) => void,
  build: () => InboundFacts | Promise<InboundFacts>,
): Promise<{ analytics?: InboundFacts }> {
  if (!enabled) return {};
  try {
    return { analytics: await build() };
  } catch (error) {
    log(structuredLog("warn", "trip_bot.assistant_event_facts_failed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    return {};
  }
}

/** Whether the organizer has been told this trip's assistant is up (outbox `companion_ready`, delivered). */
async function companionAnnounced(db: pg.Pool, tripId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM control_plane.notification_outbox
      WHERE trip_id = $1 AND notification_type = 'companion_ready' AND sent_at IS NOT NULL
      LIMIT 1`,
    [tripId],
  );
  return rows.length > 0;
}

/**
 * The facts of a message the router answered, or deliberately did not, because
 * the companion is not connected - a lost turn when it was addressed. The
 * verdict is the caller's, computed once (see the COMPANION_PENDING case), so
 * the record and the reply cannot disagree about who was addressed.
 */
async function companionPendingFacts(
  db: pg.Pool,
  route: ChatRoute,
  message: TelegramMessage,
  gate: {
    chatType: ChatType;
    text: string;
    assistantNames: readonly string[];
    botUsername?: string;
    isReplyToAssistant: boolean;
  },
  addressed: boolean,
): Promise<InboundFacts> {
  if (route.kind !== "companion") throw new Error("NOT_COMPANION_ROUTE");
  const senderId = message.from?.id === undefined ? null : String(message.from.id);
  return inboundFacts({
    tripId: route.tripId,
    telegramChatType: message.chat?.type,
    trigger: classifyTrigger({ addressed, capturedAsReply: false, ...gate }),
    linkRole: senderId ? (await resolveTripPerson(db, route.tripId, senderId))?.role : null,
    attachmentKind: describeAttachment(message)?.kind ?? null,
    textLength: gate.text.length,
  });
}

/**
 * The files an addressed message brings to the assistant, oldest first and
 * each once:
 *
 *   1. documents this sender left in this chat, unaddressed, within the window;
 *   2. the document this message replies to — only when the sender sent it;
 *   3. whatever this message carries itself.
 *
 * Every source is scoped to the sender. Another person's document is never
 * attached to this request: not from the holding area, and not by replying to
 * it, since a reply is a gesture at a message, not a claim on someone else's
 * file. A sender Telegram does not identify brings only their own attachment.
 */
function attachmentsForAddressedTurn(
  message: TelegramMessage,
  own: Attachment | null,
  chatId: string,
  senderId: string | null,
  pending: PendingAttachments | undefined,
): { list: HeldAttachment[]; held: number; replied: boolean; joined: number } {
  const list: HeldAttachment[] = [];
  const seen = new Set<string>();
  const add = (attachment: HeldAttachment): boolean => {
    if (seen.has(attachment.fileId)) return false;
    seen.add(attachment.fileId);
    list.push(attachment);
    return true;
  };

  let held = 0;
  let replied = false;
  if (senderId) {
    for (const attachment of pending?.take(chatId, senderId) ?? []) {
      if (add(attachment)) held += 1;
    }
    const repliedTo = message.reply_to_message;
    const repliedAttachment = repliedTo ? describeAttachment(repliedTo) : null;
    if (
      repliedAttachment?.kind === "document"
      && repliedTo?.from?.id !== undefined
      && String(repliedTo.from.id) === senderId
    ) {
      add({ ...repliedAttachment, ...(repliedTo.caption ? { caption: repliedTo.caption } : {}) });
      replied = true;
    }
  }
  if (own) add({ ...own, ...(message.caption ? { caption: message.caption } : {}) });

  return { list, held, replied, joined: held + (replied ? 1 : 0) };
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
/**
 * Resolves `/switch <text>` to one of the organizer's OWN trips, or to nothing.
 *
 * EXACT matches only, against the trips already derived from the sender's
 * verified identity. Fuzzy or prefix matching is what turns "switch me to
 * japan" into a silent move to the wrong japan-2026-something, and a routing
 * mistake here is invisible — the next answer is simply about a different
 * trip. When two of the organizer's trips answer to the same name the argument
 * is ambiguous, so it resolves to nothing and they get the tappable list,
 * where the rows are distinguishable.
 *
 * Never widens the set it is given. That is the property that matters; the
 * matching rules are just how a row inside it gets picked.
 */
function resolveTripArgument(
  trips: readonly OrganizerTrip[],
  argument: string | null,
): OrganizerTrip | null {
  if (!argument) return null;
  const needle = argument.trim().toLowerCase();
  if (!needle) return null;

  const matches = trips.filter(
    (trip) =>
      trip.slug.toLowerCase() === needle ||
      tripDisplayName(trip).toLowerCase() === needle ||
      trip.tripId === argument.trim(),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Performs the switch and returns the sentence to send.
 *
 * The refusal branches all answer with copy that says what to do next, because
 * the states they describe are ones the organizer can act on: finish the
 * interview, or look at the list. `NOT_YOURS` deliberately reads the same as a
 * trip that does not exist.
 */
async function applySwitch(
  db: pg.Pool,
  senderId: string,
  chatId: string,
  target: OrganizerTrip,
  language: Language,
  log: (line: string) => void,
): Promise<string> {
  const outcome = await switchChatToTrip(db, senderId, chatId, target.tripId);
  const name = tripDisplayName(target);

  switch (outcome.kind) {
    case "unchanged":
      return `${uiString("switchUnchanged", language)} ${name}.`;
    case "refused":
      log(structuredLog("info", "trip_bot.switch_refused", { reason: outcome.reason }));
      return uiString(
        outcome.reason === "IN_INTERVIEW"
          ? "switchInInterview"
          : outcome.reason === "NOT_PRIVATE_CHAT"
            ? "switchInGroup"
            : "switchRefused",
        language,
      );
    case "switched": {
      log(structuredLog("info", "trip_bot.switched", {
        trip_id: outcome.tripId,
        had_previous: outcome.previousTripId !== null,
        has_companion: outcome.hermesProfile !== null,
      }));
      const lines = [`${uiString("switchDone", language)} ${name}.`];
      // Said at the moment of switching rather than left for the organizer to
      // discover by asking a question and being told the assistant is pending.
      // A trip can be provisioned perfectly and still have no companion
      // reachable from a chat that has never had one (migration 0043).
      if (!outcome.hermesProfile) lines.push("", uiString("switchNoCompanion", language));
      return lines.join("\n");
    }
  }
}

async function dispatchCallback(
  db: pg.Pool,
  update: TelegramUpdate,
  log: (line: string) => void,
): Promise<DispatchDecision> {
  const callback = update.callback_query;
  if (!callback?.data) return { kind: "ignore", reason: "NO_CALLBACK_DATA" };

  const chatId = callback.message?.chat?.id;
  const parsed = parseCallbackData(callback.data);

  // Handled BEFORE the interview block below, which would otherwise swallow a
  // trip-switch tap as a stale interview button — the chat performing a switch
  // has no live interview by definition.
  //
  // Identity is `callback.from.id` — the person who TAPPED — not the chat id.
  // They are the same in a DM, and taking the tapper is the form that stays
  // correct if that ever stops being true. The same provenance
  // `processApprovalCallback` already relies on.
  if (parsed.kind === "switch" && chatId !== undefined && chatId !== null) {
    const fromId = callback.from?.id;
    if (fromId === undefined || fromId === null) return { kind: "ignore", reason: "NO_CALLBACK_SENDER" };
    const senderId = String(fromId);
    const language = await resolveChatLanguage(db, String(chatId), callback.from?.language_code);

    // Re-derived server-side. The payload said WHICH ROW was tapped; whether
    // that row is reachable by this sender is decided here, from their
    // verified id, exactly as if they had typed the name.
    const trips = await listOrganizerTrips(db, senderId, String(chatId));
    const target = trips.find((trip) => trip.tripId === parsed.tripId);
    if (!target) {
      log(structuredLog("info", "trip_bot.switch_refused", { reason: "NOT_YOURS" }));
      return {
        kind: "callback_reply",
        chatId: String(chatId),
        callbackQueryId: callback.id,
        text: uiString("switchRefused", language),
      };
    }
    return {
      kind: "callback_reply",
      chatId: String(chatId),
      callbackQueryId: callback.id,
      text: await applySwitch(db, senderId, String(chatId), target, language, log),
    };
  }

  // A document correction is answered from a CONFIRMED trip's chat, which by
  // definition has no live interview any more — the generic block below would
  // find `route.kind !== "interview"` and discard the tap as a stale interview
  // button. Handled first, and unconditionally: the proposal row itself names
  // its trip (`getCorrection`), and `applyCorrectionCallback` does its own
  // organizer/chat authorization, so nothing here needs the chat's route.
  if (parsed.kind === "correction" && chatId !== undefined && chatId !== null) {
    const fromId = callback.from?.id;
    return {
      kind: "correction_callback",
      chatId: String(chatId),
      callbackQueryId: callback.id,
      proposalId: parsed.proposalId,
      choice: parsed.choice,
      fromId: fromId === undefined || fromId === null ? "" : String(fromId),
    };
  }

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
    // A typed-change button (`pc:`) is ANSWERED, never dropped: an ignored tap
    // leaves the button spinning for whoever pressed it (#206). Answered ONLY: a
    // forged tap must not make the bot post into a chat it is merely a member of.
    if (parsed.kind === "change") {
      return {
        kind: "callback_ack",
        callbackQueryId: callback.id,
        text: uiString("change.gone", await resolveChatLanguage(db, String(chatId), callback.from?.language_code)),
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
