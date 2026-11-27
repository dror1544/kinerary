/**
 * The companion gate: one platform-neutral function decides the companion path
 * of the relay (#625, S1).
 *
 * "The companion path" is everything that happens to a turn once it is known to
 * belong to a chat bound to a trip: whether the assistant is meant to answer
 * (explicit addressing, the one-shot reply window, the per-person conversation
 * window, the group judge and its deferral), what rides along (overheard
 * context, held and replied-to attachments, re-hosted media), the marks put on
 * the text, and what is said when the companion is not there at all (the
 * pending-companion branch).
 *
 * This module imports no Telegram type and no platform client. A platform's
 * loop builds an `InboundTurn` from its own message, resolves the chat's route
 * with `resolveInbound` (normalize.ts), calls `companionGate`, and applies the
 * returned `GateDecision` through its own sink. `dispatch.ts` is the Telegram
 * side of that; WhatsApp's loop is the second (S3).
 *
 * S1 moves code; it does not change it. Every await, log line, mark and fixed
 * text below is what `dispatchUpdate` did before, in the same order, and the
 * existing relay suites are the proof. S3 adds the one per-platform difference:
 * with `platformWording: "whatsapp"` (set only by the WhatsApp loop) the addressed
 * mark and the judge's prompt name WhatsApp; absent, every byte is Telegram's.
 *
 * The order of the steps in `eventTurn` is the security-relevant part: nothing is
 * downloaded for a turn that is not for the assistant, an addressed turn marks
 * its text BEFORE the overheard block so that block still leads, and
 * `beforeMarks` runs after the sender is identified and before any mark.
 */
import type pg from "pg";
import {
  companionIntroFacts,
  consumeExpectsReplyWindow,
  groupProactiveLevel,
  inCompanionConversation,
  openCompanionConversation,
  PROACTIVE_JOINS_IN,
  tripLanguage,
  type ChatRoute,
} from "../chat-router.js";
import { classifyTrigger, inboundFacts, type InboundFacts, type JudgeFacts } from "../analytics/relay-facts.js";
import { uiString } from "../intake-copy.js";
import { structuredLog } from "../redaction.js";
import { isAddressedToAssistant } from "./addressing.js";
import type { GroupContext } from "./group-context.js";
import type { GroupJudge, JudgeOutcome } from "./group-judge.js";
import { MEDIA_MAX_BYTES, type MediaKind } from "./media-store.js";
import type { AttachmentRef, HeldAttachment, PendingAttachments } from "./pending-attachments.js";
import { looksLikeAQuestion, type ChatType, type WireMessageEvent } from "./protocol.js";
import { addressedMark, conversationMark, reactionAnswerMark, whatsappMark } from "./stay-silent.js";

export type { AttachmentRef, HeldAttachment };

/** The companion route of a chat: the trip, its assistant's profile and wake-words. */
export type CompanionRoute = Extract<ChatRoute, { kind: "companion" }>;

/** A companion route whose assistant is installed: the only route a turn is forwarded on. */
export type RoutedCompanionRoute = CompanionRoute & { hermesProfile: string };

/**
 * One inbound message, in the platform-neutral shape the gate reads. A platform
 * builds it from its own message; the gate never sees the message itself.
 */
export interface InboundTurn {
  platform: "telegram" | "whatsapp";
  chatId: string;
  chatType: ChatType;
  /** The platform's own chat type, for analytics' channel classification. */
  rawChatType: string;
  chatName: string | null;
  /** The platform's sender id (a Telegram user id; WhatsApp's opaque id). */
  senderId: string | null;
  senderName: string | null;
  /** The text, or the caption when there is no text. */
  text: string;
  caption?: string;
  messageId: string;
  replyToMessageId?: string;
  isReplyToAssistant: boolean;
  /** A replied-to document joins only for the same sender. */
  repliedToSenderId?: string;
  /** For the reaction-answers-question rule. */
  repliedToText?: string;
  /** S1: today's attachment reference (with `fileId`). S3 changes the shape. */
  attachment: AttachmentRef | null;
  /** The attachment of the message replied to, with that message's caption. */
  repliedToAttachment: HeldAttachment | null;
  /** When this message was sent, in ms (the platform's own time). Optional: a platform that does not say leaves it off. */
  sentAtMs?: number;
  /** When the message replied to was sent, in ms. */
  repliedToSentAtMs?: number;
}

/** A person the trip knows, by the control plane's own link record. */
export interface TripPerson {
  username: string;
  displayName: string | null;
  role: string;
}

/** A downloaded file, before it is re-hosted. */
export interface FetchedFile {
  bytes: Buffer;
  mime?: string;
}

/**
 * What a platform's normalisation hands the gate: the wire event for the turn
 * and the chat's route (`kind: "event"`), or why there is no event. A dropped
 * outcome may carry the route it found; `COMPANION_PENDING` needs it.
 */
export type GateOutcome =
  | {
      kind: "event";
      /** Text only. Media is attached here, once the turn is known to go to the assistant. */
      event: WireMessageEvent;
      /**
       * A companion route with a profile - what `resolveInbound` returns for a
       * routed chat. The type says so and the gate checks it anyway (see
       * `routeMismatch`): a second platform's loop is a second caller.
       */
      route: RoutedCompanionRoute;
    }
  | { kind: "dropped"; reason: string; route?: ChatRoute };

/**
 * The platform-neutral decisions. `Extra` is the one place a platform may add a
 * decision of its own: Telegram's organizer-document route returns one from
 * `beforeMarks`.
 */
export type GateDecision<Extra = never> =
  /** Hand this turn to the gateway. `explicit` is set when it carried the addressed mark. */
  | { kind: "to_gateway"; event: WireMessageEvent; analytics?: InboundFacts; explicit?: boolean }
  /** A fixed text to the chat, from the relay itself. */
  | { kind: "reply"; reply: { chatId: string; text: string }; analytics?: InboundFacts }
  /** Only with `deferJudge`: the caller runs `ask()` off its loop and calls the gate again with the verdict. */
  | { kind: "judge_pending"; chatId: string; ask: () => Promise<JudgeOutcome> }
  /** Nothing to do. */
  | { kind: "drop"; reason: string; analytics?: InboundFacts }
  | Extra;

/** What `beforeMarks` is handed beyond the turn and route: the event as it stands, and the analytics builders. */
export interface BeforeMarksContext {
  /** The wire event for this turn, sender already named as the trip knows them. Read-only: only the gate edits it. */
  readonly event: Readonly<WireMessageEvent>;
  /** The gate's verdict as metadata, for the sender's link role. */
  facts(linkRole: string | null | undefined): InboundFacts;
  /** Spreads `{ analytics }` only while assistant events are on; a throwing `build` costs the descriptor, never the decision. */
  withAnalytics(build: () => InboundFacts | Promise<InboundFacts>): Promise<{ analytics?: InboundFacts }>;
}

/**
 * Trip photos and moments, the relay's half (trip-moments.ts; docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B). Optional,
 * like the stores beside it: absent, or with the trip's switches off, the gate does exactly what it did before. Telegram only.
 */
export interface MomentsPort {
  /**
   * A group message nobody addressed to the assistant. A photo in it is held and, with automatic saving on, saved; a `reply` is
   * relay-owned text for the group (the once-only notice that photos are saved).
   */
  unaddressed(turn: InboundTurn, route: RoutedCompanionRoute): Promise<{ reply?: string }>;
  /**
   * A message that is for the assistant: a save request, a private chat's photo. A `reply` ends the turn with that text and NO
   * model turn; a `context` goes on to the companion with that block ahead of the message (a draft moment the message may be the
   * answer to); null leaves it to the companion, exactly as before.
   */
  addressed(turn: InboundTurn, route: RoutedCompanionRoute, how: { explicit: boolean }): Promise<{ reply: string } | { context: string } | null>;
}

export interface GateDeps<Extra = never> {
  db: pg.Pool;
  log: (line: string) => void;
  /** The bot's @username; unset where the platform has none. */
  assistantHandle?: string;
  resolvePerson(tripId: string, senderId: string): Promise<TripPerson | null>;
  /**
   * The platform's own route, run after the sender is identified and the
   * conversation window written, and before any mark. A decision ends the turn;
   * null lets the marks and the forward go on. It can return only the platform's
   * own decision type (`Extra`), never one of the gate's: a hook that could
   * return `to_gateway` would skip the marks, the overheard block and the
   * attachment scoping. Telegram supplies the organizer's
   * document route here, at the position it always had.
   */
  beforeMarks?(turn: InboundTurn, route: CompanionRoute, context: BeforeMarksContext): Promise<Extra | null>;
  /** Downloads one attachment by its reference. With `mediaStore` and `mediaBaseUrl`, switches re-hosting on. */
  fetchAttachment?(ref: string, maxBytes: number): Promise<FetchedFile | null>;
  mediaStore?: MediaStore;
  mediaBaseUrl?: string;
  /** Where a failed re-host is logged: the media plane's own log, not `log`. */
  mediaLog?: (line: string) => void;
  /** Documents sent to a group addressing nobody, kept for their sender's next addressed message. */
  pendingAttachments?: PendingAttachments;
  /** What the family said while nobody addressed the assistant. */
  groupContext?: GroupContext;
  /** Photos from the trip's group, saved to the album and drafted into moments. Absent: nothing of it happens. */
  moments?: MomentsPort;
  groupJudge?: GroupJudge;
  /** Do not wait for the judge; see `judge_pending`. */
  deferJudge?: boolean;
  /** The judge's verdict on THIS turn, from a `judge_pending` round trip; null is "no usable answer". */
  judgedOutcome?: JudgeOutcome | null;
  /** Attach analytics descriptors to the decisions. */
  assistantEvents?: boolean;
  /** At most one "the assistant is down" line per chat per window. */
  outageNotices: { allow(chatId: string): boolean };
  /** The fixed text for a trip whose assistant has not been announced as up. */
  companionPendingText: string;
  /**
   * Which platform's words the marks and the judge's prompt use (#625 S3). Absent is
   * Telegram, byte for byte as before. Supplied by the platform's own loop rather than
   * read off `turn.platform`: the gate's DECISIONS are the same for both platforms
   * (companion-gate.test.ts pins that, WhatsApp turns included), and only the loop
   * that will deliver the turn knows which chat app the companion is answering in.
   */
  platformWording?: "telegram" | "whatsapp";
}

/** What re-hosting needs of the media plane's store. */
export interface MediaStore {
  put(input: { kind: MediaKind; mime: string; size: number; filename?: string; caption?: string; bytes: Buffer }): string | null;
}

export async function companionGate<Extra = never>(
  turn: InboundTurn,
  outcome: GateOutcome,
  deps: GateDeps<Extra>,
): Promise<GateDecision<Extra>> {
  if (outcome.kind === "event") return eventTurn(turn, outcome, deps);
  if (outcome.reason === "COMPANION_PENDING") return pendingTurn(turn, outcome.route, deps);
  return { kind: "drop", reason: outcome.reason };
}

// ── The event path ──────────────────────────────────────────────────────────────

async function eventTurn<Extra>(
  turn: InboundTurn,
  outcome: GateOutcome & { kind: "event" },
  deps: GateDeps<Extra>,
): Promise<GateDecision<Extra>> {
  const { log, db } = deps;
  const mismatch = routeMismatch(turn, outcome);
  if (mismatch) {
    // The reason only: no text, no id. The drop itself is logged again by the loop that applies it.
    log(structuredLog("warn", "trip_bot.route_mismatch", { check: mismatch }));
    return { kind: "drop", reason: "ROUTE_MISMATCH" };
  }
  const chatId = turn.chatId;
  const attachment = turn.attachment;
  // The relevance gate. A DM is addressed by construction; a group message
  // has to actually address the assistant, or the shared bot answers a
  // family talking among themselves. See addressing.ts for why this cannot
  // be left to Hermes's mention_patterns under the relay.
  const isReplyToAssistant = turn.isReplyToAssistant;

  // The assistant's own last message here may have asked a question it wants
  // answered, in which case the VERY NEXT message in this chat is addressed to
  // it, whoever sends it - no @mention/name/reply-to needed. Attempted
  // unconditionally, ahead of the ordinary gate below: the atomic claim also
  // clears the window on a hit, so a second message, even one still inside the
  // window, finds nothing left to claim (one-shot).
  // It also reads the group's proactive level (level 1 admits nothing through
  // it), a column a relay running ahead of its migration does not have: a
  // failed claim degrades to "no window", as the conversation window's reads
  // below do, rather than failing the update.
  // The sender is the turn's; `routeMismatch` has checked the event says the same.
  const senderId = turn.senderId;
  const inGroup = outcome.event.source.chat_type !== "dm";
  // EXPLICIT addressing: the assistant's name, an @mention of the bot, or a reply
  // to one of its messages. Decided on the message alone - no window, no model.
  const explicitlyAddressed = isAddressedToAssistant({
    chatType: outcome.event.source.chat_type,
    text: outcome.event.text,
    assistantNames: outcome.route.assistantNames,
    botUsername: deps.assistantHandle,
    isReplyToAssistant,
  });
  // A group message with no letter or digit and no attachment (a laugh, a
  // thumbs-up, a lone "?") is a reaction, not a request - EXCEPT as the answer
  // to a question the assistant asked ("Should I update the site?" - a thumbs-up
  // is consent, owner's decision 2026-10-17). Exactly two things make one an
  // answer: the one-shot "?" window is open (the assistant's latest send ended
  // in a question, unanswered, inside 150 s - consumed below, as for any
  // message), or it is a reply to an assistant message that itself ended in a
  // question. Anything else - a laugh, a thumbs-up to a statement, a reply to a
  // statement - is chatter: the conversation window and the judge never admit
  // it. "The assistant's latest message was a question" is NOT stored anywhere
  // new: the "?" window IS that state, and a reply carries the text it replies to.
  const reactionOnly = inGroup && !attachment && outcome.event.text.trim() !== "" &&
    !judgeableText(outcome.event.text);
  const repliedToText = turn.repliedToText ?? "";
  const reactionAnswersQuestion = reactionOnly && isReplyToAssistant && looksLikeAQuestion(repliedToText);
  // Explicit addressing as it counts for THIS message: a reaction that replies
  // to a statement is not explicit, whoever's message it replies to.
  const explicitHere = explicitlyAddressed && (!reactionOnly || reactionAnswersQuestion);

  let capturedAsReply = false;
  try {
    capturedAsReply = await consumeExpectsReplyWindow(db, chatId);
  } catch (error) {
    log(structuredLog("warn", "trip_bot.reply_window_read_failed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
  }

  // Booleans only in the log: no chat or user id beyond what other events carry.
  if (capturedAsReply) log(structuredLog("info", "trip_bot.reply_window_hit", {}));

  if (reactionOnly && !capturedAsReply && !explicitHere) log(structuredLog("info", "trip_bot.reaction_not_forwarded", {}));
  const addressedOtherwise = capturedAsReply || explicitHere;

  // The per-person conversation window (2026-10-16). Consulted LAST, only for
  // a group message every other route has refused: is the sender the one
  // member the assistant is in conversation with here, inside the window?
  // The sender is the id the platform carried, never anything read from the
  // text. A pure read - the forward below is what renews it.
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
    deps.groupJudge?.model() && judgeableText(outcome.event.text)
  ) {
    if (deps.judgedOutcome !== undefined) {
      // Second pass of a deferred judgement: the verdict is already in.
      judged = deps.judgedOutcome;
    } else {
      const ask = await prepareGroupJudge(db, deps.groupJudge, outcome.route, chatId, outcome.event.text, log, deps.platformWording);
      if (ask === null) judged = null;
      else if (deps.deferJudge) return { kind: "judge_pending", chatId, ask };
      else judged = await ask();
    }
    capturedByJudge = judged?.kind === "yes";
  }
  const addressed = addressedOtherwise || capturedByConversation || capturedByJudge;
  // Trip photos and moments (Part B). A message that IS for the assistant may be a request the relay answers itself - "@bot save
  // this" in reply to a photo, a private chat's photo - with no model turn. It runs before any window is written or mark is put on:
  // the relay answered, nobody was talked with. Never costs the message: a failure is logged and the turn goes on as it always did.
  if (addressed && deps.moments && turn.platform === "telegram") {
    try {
      const answered = await deps.moments.addressed(turn, outcome.route, { explicit: explicitHere });
      if (answered && "reply" in answered) return { kind: "reply", reply: { chatId, text: answered.reply } };
      // The companion's own session never saw the draft this may answer; the block goes ahead of the words, under the marks.
      if (answered) outcome.event.text = `${answered.context}\n\n${outcome.event.text}`;
    } catch (error) {
      log(structuredLog("warn", "relay.moments_failed", { stage: "addressed", safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    }
  }
  // #177: the gate's verdict, as metadata. Only ever called through
  // `withAnalytics`, which never calls it while assistant events are off.
  // The text is taken here, before anything is prefixed to it.
  const heardText = outcome.event.text;
  const routedTripId = outcome.route.tripId;
  const seen = (linkRole: string | null | undefined): InboundFacts => {
    const facts = inboundFacts({
      tripId: routedTripId,
      // The platform's own type for the channel; the gate's mapped one for the trigger.
      telegramChatType: turn.rawChatType,
      trigger: classifyTrigger({
        addressed,
        capturedAsReply,
        capturedByConversation,
        capturedByJudge,
        chatType: outcome.event.source.chat_type,
        text: heardText,
        assistantNames: outcome.route.assistantNames,
        botUsername: deps.assistantHandle,
        isReplyToAssistant,
      }),
      linkRole,
      attachmentKind: attachment?.kind ?? null,
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
    // remembered, by reference, for its sender's next addressed message -
    // "send the file, then say what it is for" is one interaction to the
    // person doing it. Photos are not: in a family group they are the family
    // talking, and a photo followed by an unrelated question is the common case.
    // Remembered, not delivered. Nothing is sent and no model turn happens;
    // this only means the NEXT addressed message knows what it is replying
    // into. Groups only - a DM is addressed by construction, so nothing is
    // ever dropped there.
    // A bare reaction (an emoji, a "?") is not kept either: it adds nothing the
    // companion could use and would only lengthen the block that leads its prompt.
    if (deps.groupContext && outcome.event.source.chat_type !== "dm" && outcome.event.text && !reactionOnly) {
      deps.groupContext.hold(
        chatId,
        outcome.event.source.user_name || "someone",
        outcome.event.text,
        senderId,
      );
    }
    const held = Boolean(deps.pendingAttachments && senderId && attachment?.kind === "document");
    if (deps.pendingAttachments && senderId && attachment?.kind === "document") {
      deps.pendingAttachments.hold(chatId, senderId, attachment, {
        ...(turn.caption ? { caption: turn.caption } : {}),
      });
      log(structuredLog("info", "trip_bot.attachment_held", { kind: attachment.kind }));
    }
    // Trip photos and moments (Part B): a group photo is held by reference and, with the switch and the setting on, saved - no
    // model turn - and the group is told once that this is so. A failure here costs the photo, never the message.
    if (deps.moments && inGroup && turn.platform === "telegram") {
      try {
        const moment = await deps.moments.unaddressed(turn, outcome.route);
        if (moment.reply) return { kind: "reply", reply: { chatId, text: moment.reply } };
      } catch (error) {
        log(structuredLog("warn", "relay.moments_failed", { stage: "unaddressed", safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
      }
    }
    return {
      kind: "drop",
      reason: "NOT_ADDRESSED",
      ...(await withAnalytics(deps.assistantEvents, log, async () => ({
        ...seen(senderId ? (await deps.resolvePerson(routedTripId, senderId))?.role : null),
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

  // WHOSE VOICE THIS IS, when the trip knows. `user_name` arrives from the
  // platform, where every sender writes their own - so the assistant was
  // being told "Dror" by the one party with an interest in the answer, and
  // in a family group it had nothing else to go on at all. A trip person
  // link is the control plane's own record (migration 0051), written at
  // provisioning from the interview chat, so it outranks anything the
  // update carries. Unknown senders keep their platform name: it is what
  // their family calls them, and the alternative is a blank where a person
  // should be.
  let senderLinkRole: string | null = null;
  if (senderId) {
    const person = await deps.resolvePerson(outcome.route.tripId, senderId);
    senderLinkRole = person?.role ?? null;
    if (person?.displayName) {
      outcome.event.source.user_name = person.displayName;
      log(structuredLog("info", "trip_bot.sender_identified", { role: person.role }));
    }
  }
  // The platform's own route for this turn, if it has one (Telegram: a file from
  // the organizer after confirmation, which is read and proposed back rather than
  // handed to the companion). It runs here: after the sender is identified, before
  // anything is marked, and only for a turn that is going to the assistant.
  if (deps.beforeMarks) {
    const early = await deps.beforeMarks(turn, outcome.route, {
      event: outcome.event,
      facts: seen,
      withAnalytics: (build) => withAnalytics(deps.assistantEvents, log, build),
    });
    if (early) return early;
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
  // WhatsApp only (S3, spec Behaviour 8): a forwarded turn that the WhatsApp addressed mark below will not carry (a
  // private turn; a group turn let in by a window or the judge) says it is on WhatsApp and to answer in plain text.
  // Innermost, so the conversation and reaction marks keep their place at the front. Absent wording: nothing changes.
  if (deps.platformWording === "whatsapp" && !(inGroup && explicitHere)) {
    outcome.event.text = `${whatsappMark()}\n\n${outcome.event.text}`.trimEnd();
  }
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
    outcome.event.text = `${deps.platformWording === "whatsapp" ? addressedMark(undefined, "whatsapp") : addressedMark(deps.assistantHandle)}\n\n${outcome.event.text}`.trimEnd();
  } else if (inGroup && reactionOnly && capturedAsReply) {
    // A reaction that took the "?" window: not addressed by name, so a silence
    // is allowed, but it is told what the bare emoji answers.
    outcome.event.text = `${reactionAnswerMark()}\n\n${outcome.event.text}`.trimEnd();
  }

  // The turns this message is a reply INTO. Prefixed onto the text rather
  // than carried in its own field because the gateway forwards `text` and
  // nothing else reaches the model - a new inbound field would be ignored
  // exactly as `expects_reply` was (#122). Clearly fenced and named as
  // overheard so it reads as background, never as something said to the
  // assistant or asked of it. Empty when there is nothing to carry, so a
  // quiet group's turns look exactly as they did before.
  if (deps.groupContext && outcome.event.source.chat_type !== "dm") {
    const overheard = deps.groupContext.take(chatId);
    if (overheard.length) {
      const lines = overheard.map((m) => `${m.sender}: ${m.text}`).join("\n");
      outcome.event.text =
        `[overheard in the group since you last spoke — background only, not addressed to you]\n` +
        `${lines}\n[end of overheard]\n\n${outcome.event.text}`;
      log(structuredLog("info", "trip_bot.group_context_carried", { turns: overheard.length }));
    }
  }

  const attachments = attachmentsForAddressedTurn(turn, chatId, senderId, deps.pendingAttachments);
  if (attachments.joined > 0) {
    log(structuredLog("info", "trip_bot.attachments_joined", {
      held: attachments.held,
      replied: attachments.replied,
    }));
  }
  const forwarded = await attachMediaWith(outcome.event, attachments.list, deps);
  return {
    kind: "to_gateway",
    event: forwarded,
    ...(explicit ? { explicit: true } : {}),
    ...(await withAnalytics(deps.assistantEvents, log, () => ({
      ...seen(senderLinkRole),
      attachmentsJoined: attachments.joined,
      documents: (forwarded.media ?? []).filter((m) => m.kind === "document").length,
    }))),
  };
}

/**
 * Whether the caller's outcome contradicts itself, and which check said so.
 *
 * The gate forwards `outcome.event` to the gateway stamped with the profile it
 * carries - the Trip Context Gateway decision - so the event must be the one
 * the route belongs to: the route a companion with an installed assistant, the
 * profile on the event that route's, the chat the turn's own, and the sender
 * the turn's. A caller that built the event from one message and the route from
 * another would otherwise get a turn delivered to the wrong trip's assistant.
 * Nothing in production can do that today (the Telegram path builds both from
 * one chat id); the check is there for the second platform's loop. The values
 * returned are codes, never ids.
 */
function routeMismatch(turn: InboundTurn, outcome: GateOutcome & { kind: "event" }): string | null {
  const route: ChatRoute = outcome.route;
  if (route.kind !== "companion") return "route_kind";
  if (!route.hermesProfile) return "no_profile";
  const source = outcome.event.source;
  if (source.profile !== route.hermesProfile) return "profile";
  if (source.chat_id !== turn.chatId) return "chat";
  if (source.user_id !== turn.senderId) return "sender";
  return null;
}

// ── The pending-companion branch ────────────────────────────────────────────────

async function pendingTurn<Extra>(
  turn: InboundTurn,
  route: ChatRoute | undefined,
  deps: GateDeps<Extra>,
): Promise<GateDecision<Extra>> {
  const { db, log } = deps;
  const chatId = turn.chatId;
  // Two different situations arrive here, and the family is owed different
  // words for each:
  //   - the trip has NO companion yet (never installed, or mid-install):
  //     the honest "still finishing your assistant", said to whoever writes;
  //   - the trip HAS one and its gateway is not connected right now (an
  //     outage or a restart): the generic line - and never to a family
  //     talking among themselves (#179).
  const chatType = turn.chatType;
  // The relevance gate's verdict, once, for the reply decision and for the
  // record. The expects-reply window is not consulted (claiming it is a
  // write): during an outage the assistant has said nothing to be replied to.
  const gate = {
    chatType,
    text: turn.text,
    assistantNames: route?.kind === "companion" ? route.assistantNames : [],
    botUsername: deps.assistantHandle,
    isReplyToAssistant: turn.isReplyToAssistant,
  };
  const addressed = route?.kind === "companion" && isAddressedToAssistant(gate);
  const facts = () => companionPendingFacts(deps, route, turn, gate, addressed);

  // "Has this trip's assistant ever been announced as up?" - the organizer's
  // `companion_ready` message, sent only after the companion exists. Without
  // it a profile is merely stamped: a first-time organizer must not be told
  // "I'm off for now" about an assistant that has not come up yet. Trips
  // that predate that message also keep the honest wording during an outage
  // (the safe direction).
  const announced = route?.kind === "companion" && route.hermesProfile
    ? await companionAnnounced(db, route.tripId)
    : false;
  if (route?.kind !== "companion" || !announced) {
    return {
      kind: "reply",
      reply: { chatId, text: deps.companionPendingText },
      ...(await withAnalytics(deps.assistantEvents, log, facts)),
    };
  }

  if (chatType !== "dm" && !addressed) {
    // Chatter is never answered, outage or not.
    return {
      kind: "drop",
      reason: "NOT_ADDRESSED",
      ...(await withAnalytics(deps.assistantEvents, log, facts)),
    };
  }
  if (chatType !== "dm" && !deps.outageNotices.allow(chatId)) {
    // Addressed, but this chat was told a moment ago. NO analytics on
    // purpose: a drop carrying facts is recorded as chatter, and this
    // was a lost turn - an absent event undercounts, a wrong one misleads.
    return { kind: "drop", reason: "COMPANION_UNAVAILABLE_NOTICE_LIMITED" };
  }
  const intro = await companionIntroFacts(db, route.tripId);
  return {
    kind: "reply",
    reply: { chatId, text: uiString("companionUnavailable", intro?.language === "he" ? "he" : "en") },
    ...(await withAnalytics(deps.assistantEvents, log, facts)),
  };
}

// ── Helpers moved from dispatch.ts, unchanged ───────────────────────────────────

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
  route: CompanionRoute,
  chatId: string,
  text: string,
  log: (line: string) => void,
  platformWording?: "telegram" | "whatsapp",
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
    // The platform rides along only for WhatsApp, so a Telegram judge input is what it always was.
    const judged = await judge.judge({
      chatId, text, assistantNames: route.assistantNames, language,
      ...(platformWording === "whatsapp" ? { platform: "whatsapp" as const } : {}),
    });
    log(structuredLog("info", "trip_bot.group_judged", {
      verdict: judged.kind,
      latency_ms: judged.ms,
      model: judged.model,
      ...(judged.kind === "fallback" ? { reason: judged.reason } : { confidence: judged.confidence }),
      ...(judged.kind === "no" && judged.belowThreshold ? { below_threshold: true } : {}),
      // The primary was out of quota and `model` is the fallback's (JUDGE_FALLBACK_*).
      ...(judged.usedFallback ? { used_fallback: true } : {}),
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
 * The `analytics` field to spread into a decision - or nothing (#177).
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
 * verdict is the caller's, computed once (see `pendingTurn`), so the record and
 * the reply cannot disagree about who was addressed.
 */
async function companionPendingFacts<Extra>(
  deps: GateDeps<Extra>,
  route: ChatRoute | undefined,
  turn: InboundTurn,
  gate: {
    chatType: ChatType;
    text: string;
    assistantNames: readonly string[];
    botUsername?: string;
    isReplyToAssistant: boolean;
  },
  addressed: boolean,
): Promise<InboundFacts> {
  if (route?.kind !== "companion") throw new Error("NOT_COMPANION_ROUTE");
  const senderId = turn.senderId;
  return inboundFacts({
    tripId: route.tripId,
    telegramChatType: turn.rawChatType,
    trigger: classifyTrigger({ addressed, capturedAsReply: false, ...gate }),
    linkRole: senderId ? (await deps.resolvePerson(route.tripId, senderId))?.role : null,
    attachmentKind: turn.attachment?.kind ?? null,
    textLength: gate.text.length,
  });
}

/**
 * The files an addressed message brings to the assistant, oldest first and
 * each once:
 *
 *   1. documents this sender left in this chat, unaddressed, within the window;
 *   2. the document this message replies to - only when the sender sent it;
 *   3. whatever this message carries itself.
 *
 * Every source is scoped to the sender. Another person's document is never
 * attached to this request: not from the holding area, and not by replying to
 * it, since a reply is a gesture at a message, not a claim on someone else's
 * file. A sender the platform does not identify brings only their own attachment.
 */
function attachmentsForAddressedTurn(
  turn: InboundTurn,
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
    const repliedAttachment = turn.repliedToAttachment;
    if (
      repliedAttachment?.kind === "document"
      && turn.repliedToSenderId !== undefined
      && turn.repliedToSenderId === senderId
    ) {
      add(repliedAttachment);
      replied = true;
    }
  }
  if (turn.attachment) add({ ...turn.attachment, ...(turn.caption ? { caption: turn.caption } : {}) });

  return { list, held, replied, joined: held + (replied ? 1 : 0) };
}

// ── Re-hosting ──────────────────────────────────────────────────────────────────

/**
 * Recognizes a document by its leading bytes when the platform's own metadata
 * did not say what it was.
 *
 * A document's mime type and file name are both optional fields, and go
 * missing often enough for a file exported from a phone's "save/share as
 * PDF" flow - issue #163 traced a real upload that arrived with neither,
 * fell back to `application/octet-stream` with no filename, and was
 * rejected downstream (Hermes's reader saw a useless `.bin` extension).
 * Only signatures unambiguous enough to bet on are worth checking; anything
 * else is left as octet-stream rather than a wrong guess.
 */
export function sniffContentType(bytes: Buffer): { mime: string; extension: string } | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { mime: "application/pdf", extension: "pdf" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mime: "image/png", extension: "png" };
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")
  ) {
    return { mime: "image/gif", extension: "gif" };
  }
  return null;
}

/** message_type reflects the first attachment's kind (contract section "Phase 2 media ingress"). */
function messageTypeFor(kind: MediaKind): "image" | "audio" | "document" {
  if (kind === "image") return "image";
  if (kind === "voice" || kind === "audio") return "audio";
  return "document";
}

/** What re-hosting needs, platform-neutrally. Absent (or incomplete), the event goes over without media. */
export interface RehostDeps {
  fetchAttachment?(ref: string, maxBytes: number): Promise<FetchedFile | null>;
  mediaStore?: MediaStore;
  mediaBaseUrl?: string;
  mediaLog?: (line: string) => void;
}

/**
 * Re-hosts each attachment and adds it to an existing event, in order.
 *
 * The ONLY place an inbound file is downloaded, so it is called only for a
 * turn that is going to an assistant. Each attachment carries the caption of
 * the message it came from - not necessarily this event's message, when a
 * held document joins the instruction that followed it.
 *
 * A failed download or store skips that one file and logs it: the turn still
 * goes over, and the agent is told about exactly the files that arrived.
 * Optional throughout: a relay wired without a media plane keeps its
 * text-only behaviour, and the attachment degrades to its caption.
 */
export async function attachMediaWith(
  event: WireMessageEvent,
  attachments: ReadonlyArray<HeldAttachment>,
  deps: RehostDeps | undefined,
): Promise<WireMessageEvent> {
  if (attachments.length === 0 || !deps?.fetchAttachment || !deps.mediaStore || deps.mediaBaseUrl === undefined) return event;
  const { fetchAttachment, mediaStore, mediaBaseUrl, mediaLog } = deps;

  const urls: string[] = [];
  const descriptors: NonNullable<WireMessageEvent["media"]> = [];
  let firstKind: MediaKind | null = null;
  for (const attachment of attachments) {
    const file = await fetchAttachment(attachment.fileId, MEDIA_MAX_BYTES);
    if (!file) {
      // Degrade, never drop: the turn still goes over so the agent can say it
      // could not read the file, rather than the organizer's upload vanishing.
      // But it must not vanish from the LOGS too.
      mediaLog?.(structuredLog("warn", "relay.media_rehost_failed", {
        stage: "fetch",
        kind: attachment.kind,
        has_filename: Boolean(attachment.filename),
      }));
      continue;
    }

    let mime = file.mime || attachment.mime;
    let filename = attachment.filename;
    if (!mime || mime === "application/octet-stream") {
      const sniffed = sniffContentType(file.bytes);
      if (sniffed) {
        mime = sniffed.mime;
        filename ??= `document.${sniffed.extension}`;
      }
    }

    const id = mediaStore.put({
      kind: attachment.kind,
      mime,
      size: file.bytes.length,
      ...(filename ? { filename } : {}),
      ...(attachment.caption ? { caption: attachment.caption } : {}),
      bytes: file.bytes,
    });
    if (!id) {
      mediaLog?.(structuredLog("warn", "relay.media_rehost_failed", {
        stage: "store",
        kind: attachment.kind,
        size: file.bytes.length,
      }));
      continue;
    }

    firstKind ??= attachment.kind;
    urls.push(`${mediaBaseUrl.replace(/\/$/, "")}/relay/media/${id}`);
    descriptors.push({
      kind: attachment.kind,
      mime,
      size: file.bytes.length,
      ...(filename ? { filename } : {}),
      ...(attachment.caption ? { caption: attachment.caption } : {}),
    });
  }

  if (firstKind === null) return event;
  return { ...event, message_type: messageTypeFor(firstKind), media_urls: urls, media: descriptors };
}
