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
  migrateChatBinding,
  companionIntroFacts,
} from "../chat-router.js";
import { isAddressedToAssistant } from "./addressing.js";
import { coerceLanguage, uiString } from "../intake-copy.js";
import { companionHelpText, groupBindingCommand, groupIntroText } from "../companion-intro.js";
import {
  extractGroupBindingToken,
  issueGroupBindingToken,
  redeemGroupBindingToken,
} from "../group-binding.js";
import { structuredLog } from "../redaction.js";
import {
  botJoinedGroup,
  describeAttachment,
  migrationOf,
  normalizeUpdate,
  toWireEventWithMedia,
  type MediaDeps,
  type TelegramUpdate,
} from "./normalize.js";
import { getSessionForChat, setFinishRequestedForChat, type SessionView } from "../interview.js";
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
    }
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

  // Added to a group. If that group is already bound to a trip, this is the
  // companion's arrival and it introduces itself; if it is not, saying so is
  // better than sitting silent in a room people just invited it into.
  const joined = botJoinedGroup(update, botIdentity.id);
  if (joined) {
    const route = await resolveChatRoute(db, joined.chatId);
    if (route.kind !== "companion") {
      return { kind: "reply", reply: { chatId: joined.chatId, text: strings.unbound } };
    }
    const facts = await companionIntroFacts(db, route.tripId);
    const assistantName = typeof facts?.assistant_name === "string" ? facts.assistant_name : null;
    // No stored facts means a trip provisioned before migration 0044, or one
    // that never finished. Nothing to introduce, and inventing a name here is
    // exactly what this module refuses to do.
    if (!facts || !assistantName) return { kind: "ignore", reason: "NO_INTRO_FACTS" };
    return {
      kind: "group_intro",
      chatId: joined.chatId,
      text: groupIntroText(
        {
          assistantName,
          tripTitle: typeof facts.trip_title === "string" ? facts.trip_title : null,
          siteUrl: typeof facts.private_url === "string" ? facts.private_url : "",
          language: facts.language === "he" ? "he" : "en",
          loginPassword: typeof facts.login_password === "string" ? facts.login_password : null,
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
    ? extractGroupBindingToken(text)
    : null;
  if (postedToken) {
    const senderId = message.from?.id === undefined ? null : String(message.from.id);
    const redeemed = senderId
      ? await redeemGroupBindingToken(db, postedToken, chatId, senderId)
      : ({ ok: false, reason: "WRONG_SENDER" } as const);
    if (!redeemed.ok) {
      log(structuredLog("info", "trip_bot.group_binding_refused", { reason: redeemed.reason }));
      // Deliberately one message for every refusal. Distinguishing "that token
      // does not exist" from "that token is not yours" would confirm a guess to
      // whoever is guessing, in a room the organizer does not control.
      return { kind: "reply", reply: { chatId, text: strings.groupTokenRefused } };
    }
    log(structuredLog("info", "trip_bot.group_bound", { rebound: redeemed.rebound }));
    const facts = await companionIntroFacts(db, redeemed.tripId);
    const assistantName = typeof facts?.assistant_name === "string" ? facts.assistant_name : null;
    if (!facts || !assistantName) {
      return { kind: "reply", reply: { chatId, text: strings.groupBoundNoIntro } };
    }
    return {
      kind: "group_intro",
      chatId,
      text: groupIntroText(
        {
          assistantName,
          tripTitle: typeof facts.trip_title === "string" ? facts.trip_title : null,
          siteUrl: typeof facts.private_url === "string" ? facts.private_url : "",
          language: facts.language === "he" ? "he" : "en",
          loginPassword: typeof facts.login_password === "string" ? facts.login_password : null,
          organizerName: typeof facts.organizer === "string" ? facts.organizer : null,
          proactive: (facts.proactive as never) ?? null,
        },
        { includePassword: options.groupIntroIncludesPassword ?? true },
      ),
    };
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
    const issued = await issueGroupBindingToken(db, route.tripId, senderId, {
      ttlSeconds: options.groupBindingTtlSeconds ?? 7 * 24 * 3600,
    });
    if (!issued.ok) {
      return { kind: "reply", reply: { chatId, text: strings.groupTokenUnavailable } };
    }
    // Two messages: the instructions, then the line to copy on its own.
    return {
      kind: "group_intro",
      chatId,
      text: strings.groupTokenIssued(issued.token),
      followUp: groupBindingCommand(issued.token),
      pin: false,
    };
  }

  if (parsed.kind === "command" && (parsed.name === "done" || parsed.name === "summary")) {
    const route = await resolveChatRoute(db, chatId);
    if (route.kind === "interview") {
      const result = await setFinishRequestedForChat(db, chatId, true);
      if (result.ok) return { kind: "show_summary", chatId, view: result.view };
    }
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

  const outcome = await normalizeUpdate(db, update, options.media, options.canReachProfile);
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
    case "UNROUTED":
      return { kind: "reply", reply: { chatId, text: strings.unbound } };
    case "COMPANION_PENDING":
      return { kind: "reply", reply: { chatId, text: strings.companionPending } };
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
