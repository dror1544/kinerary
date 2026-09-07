/**
 * The Trip Bot's update loop — the one consumer of the shared bot's stream.
 *
 * `dispatch.ts` decides; this acts. Everything that touches Telegram or writes
 * an answer happens here, which is what keeps the branch table testable
 * without a token and this module testable with a fake client.
 *
 * **One loop per bot token, and this is it.** Telegram answers a second
 * concurrent getUpdates for the same token with 409 and hands each update to
 * exactly one caller, so a second poller does not duplicate traffic — it
 * steals it, at random. That is why `allowedUpdates` here lists BOTH `message`
 * and `callback_query`: this loop is not free to consume only the update types
 * it cares about, because whatever it filters out is not delivered to anyone
 * else either, it is simply dropped.
 *
 * `startTelegramApprovalPoller` runs a separate loop on the SIGNUP bot's
 * token, which is a different bot — so the two do not contend today. The
 * `approval_callback` branch below exists for the topology where they are
 * merged onto one token, and is unreachable until then.
 */
import type pg from "pg";
import {
  findQuestion,
  parseCallbackData,
  renderConfirmPrompt,
  renderEssentialsDone,
  renderQuestion,
  type InlineKeyboard,
} from "../chat-router.js";
import {
  closeAgentTurn,
  confirmIntakeForChat,
  getSessionForChat,
  AGENT_FLOOR_SECONDS,
  DOCUMENT_FLOOR_SECONDS,
  claimDueRouterPrompts,
  claimFloor,
  markAwaitingMachine,
  claimStalledAgentTurns,
  openAgentTurn,
  queueInboundMessage,
  claimSettledInboundBursts,
  listMachineAwaitingChats,
  submitAnswerForChat,
  type SessionView,
  type IntakeQuestion,
  askForMoreForChat,
  clearPendingAskForChat,
  clearPendingEntryForChat,
  clearPendingSayForChat,
  markOpeningDoneForChat,
  hasOpenAgentTurn,
  markOfferedMoreForChat,
  questionStateForChat,
  recordLastPromptForChat,
  selectedOptionIds,
  setFinishRequestedForChat,
  skipQuestionForChat,
  toggleMultiChoiceForChat,
} from "../interview.js";
import {
  applyProposals,
  burstKey,
  claimInterpretation,
  interpretBurst,
  isInterpretPath,
  markInterpretationCommitted,
  recordInterpretationResult,
  storedOutcomes,
  submitArgsFor,
  type ProposedAnswer,
} from "../interpret.js";
import type { StructuredModelRunner } from "../model-runner.js";
import { digestTelegramId } from "../identity.js";
import { resolveTelegramCallbackRef } from "../adapters/telegram.js";
import { processApprovalCallback, type SignupConfig } from "../signup.js";
import type { MediaDeps } from "./normalize.js";
import { askText, DEFAULT_LANGUAGE, optionLabel, uiString } from "../intake-copy.js";
import { structuredLog } from "../redaction.js";
import {
  dispatchUpdate,
  DEFAULT_STRINGS,
  type BotIdentity,
  type DispatchDecision,
  type DispatchStrings,
} from "./dispatch.js";
import { toWireEvent, type TelegramUpdate } from "./normalize.js";
import { agentTextIsInLanguage } from "./internal-leak.js";
import type { WireMessageEvent } from "./protocol.js";
import type { TelegramClient } from "./telegram-api.js";

/** Just the part of RelayConnector this needs, so tests need no socket. */
export interface InboundSink {
  pushInbound(event: WireMessageEvent): boolean;
  /**
   * Whether a turn for this trip would reach a running companion.
   *
   * Optional so a test double can stay two lines. Absent means "assume
   * reachable" — the behaviour every caller had before trips got their own
   * gateway processes.
   */
  canReachProfile?(profile: string): boolean;
}

export interface TripBotPollerDeps {
  db: pg.Pool;
  telegram: TelegramClient;
  connector: InboundSink;
  strings?: DispatchStrings;
  /**
   * The shared bot's own @username and id, for the group relevance gate.
   * Absent, the gate still works off the trip's assistant names — it just
   * cannot recognise an @mention, and judges a reply by "replying to a bot"
   * rather than "replying to us".
   */
  botIdentity?: BotIdentity;
  /**
   * The Hermes profile that serves written interview answers, from
   * `relay.interviewer_profile`.
   *
   * Absent, a written mid-interview message is answered by the router itself
   * rather than forwarded — the state the bot shipped in.
   */
  interviewerProfile?: string;
  /** Re-host plane for inbound attachments; absent keeps text-only behaviour. */
  media?: MediaDeps;
  /**
   * The bounded-call runner behind the interpret path
   * (docs/interview-without-an-agent.md). Absent, `interpret_path` sessions
   * fall back to the router's own questions — which is a working interview,
   * just a slower one, and is deliberately not an error.
   */
  modelRunner?: StructuredModelRunner;
  /**
   * Signup-approval handling, for the topology where the trip bot and the
   * signup bot are THE SAME BOT.
   *
   * Telegram delivers each update to exactly one getUpdates caller and answers
   * a second concurrent one with 409, so two loops on one token do not split
   * the work — they steal from each other, at random. When the tokens
   * coincide, this loop must therefore subsume telegram-poller.ts's rather
   * than run beside it, and server.ts stands its own poller down.
   *
   * Absent when the two bots are genuinely different, in which case the
   * approval branch is unreachable and stays defensive.
   */
  approvals?: { config: SignupConfig };
  log?: (line: string) => void;
}

export interface PollerOptions {
  /**
   * Telegram's server-side long-poll window. The request blocks there until an
   * update arrives or this elapses, so a busy loop costs one held connection
   * rather than repeated polling.
   */
  longPollSeconds?: number;
  /** How often to deliver what the agent has written, independent of polling. */
  deliverIntervalMs?: number;
  /** Cap on the backoff applied after a poll that looks like a failure. */
  maxBackoffMs?: number;
}

const DEFAULT_LONG_POLL_SECONDS = 25;
// How often the router checks whether the agent has written something to
// deliver. Short, because this is the gap the organizer experiences between
// answering and seeing the next question — it used to be up to a full
// long-poll window.
const DEFAULT_DELIVER_INTERVAL_MS = 700;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

// ── Acting on one decision ───────────────────────────────────────────────────

/**
 * Performs the I/O for one dispatch decision.
 *
 * Exported so the whole decision→effect table can be exercised against a fake
 * Telegram client, with no loop and no network.
 */
/**
 * The interview chat an inbound decision belongs to, if any.
 *
 * Only the kinds that represent the ORGANIZER having just said something. A
 * decision that is itself an outbound reply must not hand the floor back to
 * the machine, or the router would answer its own message.
 */
function interviewChatOf(decision: DispatchDecision): string | null {
  switch (decision.kind) {
    case "interview_callback":
    case "interview_text":
    case "interview_to_gateway":
    case "show_summary":
      return decision.chatId;
    default:
      return null;
  }
}

export async function applyDecision(
  decision: DispatchDecision,
  deps: TripBotPollerDeps,
): Promise<void> {
  const strings = deps.strings ?? DEFAULT_STRINGS;
  const log = deps.log ?? (() => {});

  // The organizer has spoken, so the machine owes the next message and the
  // deadline starts now. Restarting it here is the whole point of scoping this
  // to the session: the clock measures how long WE take, never how long a
  // person spends reading a question.
  //
  // A document/photo gets the wider DOCUMENT_FLOOR_SECONDS floor — run 12's
  // evidence that a normal 30s deadline closes the turn out from under an
  // agent still genuinely extracting a PDF. Every other inbound kind keeps the
  // default (undefined here clears any earlier override on this session).
  const chatId = interviewChatOf(decision);
  if (chatId) {
    // The ATTACHMENT decides this, not the re-host. `media_urls` is populated
    // only when re-hosting succeeded, so reading the floor off it gave a failed
    // upload the ordinary 30s budget — the case where the agent has the most to
    // do and the least to work with. Run 14: the watchdog closed such a turn 28
    // seconds in, and every write the agent made after that was refused, so the
    // organizer was told their answer could not be saved. `media_urls` is kept
    // in the test as well, for a companion-route event that carries media
    // without this flag.
    const isDocumentTurn = decision.kind === "interview_to_gateway" &&
      (decision.hadAttachment || (decision.event.media_urls?.length ?? 0) > 0);
    await markAwaitingMachine(deps.db, chatId, isDocumentTurn ? DOCUMENT_FLOOR_SECONDS : undefined);
  }

  switch (decision.kind) {
    case "reply":
      await deps.telegram.sendMessage({
        chatId: decision.reply.chatId,
        text: decision.reply.text,
        replyMarkup: decision.reply.replyMarkup,
      });
      return;

    case "to_gateway": {
      const delivered = deps.connector.pushInbound(decision.event);
      if (delivered) return;
      // Nothing queues. The gateway being down means this turn is gone, so the
      // organizer is told rather than left waiting on an answer that is never
      // coming — see RelayConnector.pushInbound's own note.
      log(structuredLog("warn", "trip_bot.turn_lost", { reason: "GATEWAY_UNAVAILABLE" }));
      await deps.telegram.sendMessage({
        chatId: decision.event.source.chat_id,
        text: strings.gatewayUnavailable,
      });
      return;
    }

    case "show_summary":
      await sendNextStep(decision.view, decision.chatId, deps, strings);
      return;

    case "interview_callback":
      await applyInterviewCallback(decision, deps, strings, log);
      return;

    case "interview_to_gateway": {
      // An upload gets an immediate acknowledgement, from the router rather
      // than the agent. The agent's reply cannot arrive until it has READ the
      // document, which on a PDF is exactly the wait this message exists to
      // cover — so the one side that can answer instantly answers, and it can
      // only do that in the organizer's language because the session records
      // it. Requested during the 2026-09-04 run 3. Unaffected by the settle
      // window below: the organizer should see this the instant the file
      // lands, burst or not.
      if ((decision.event.media_urls?.length ?? 0) > 0) {
        const view = await getSessionForChat(deps.db, decision.chatId);
        await deps.telegram.sendMessage({
          chatId: decision.chatId,
          text: uiString("fileReceived", view.ok ? view.view.language : DEFAULT_LANGUAGE),
        });
      }
      // Queued, not forwarded. Run 9: five rapid messages used to mean five
      // immediate forwards, each tearing down the turn the last one opened —
      // Hermes kept each torn-down turn's own conversation loop running
      // regardless, producing several uncoordinated agent invocations
      // fighting over the same questions. Queuing lets a burst finish before
      // exactly one turn opens for the whole thing. See
      // `flushSettledInboundBursts` for the other half.
      //
      // The settle window is deliberate latency, and Dror named the fix for
      // it unprompted: "the writing… signal give the feeling there is
      // someone on the other side and smooth the 2 sec delay." Best-effort —
      // if it fails, the organizer waits the same two seconds either way.
      await deps.telegram.sendChatAction({ chatId: decision.chatId }).catch(() => {});
      await queueInboundMessage(deps.db, decision.chatId, decision.event);
      return;
    }

    case "interview_text": {
      // Which reply is honest depends on what is actually pending — see the
      // interview_text doc in dispatch.ts.
      const session = await getSessionForChat(deps.db, decision.chatId);
      const pending = session.ok ? session.view.nextQuestion : null;
      const isTappable = pending?.type === "choice" || pending?.type === "multi_choice";
      if (!isTappable) {
        log(structuredLog("info", "trip_bot.written_answer_unsupported", {
          session_id: decision.sessionId,
          question_id: pending?.id ?? null,
          question_type: pending?.type ?? null,
        }));
      }
      await deps.telegram.sendMessage({
        chatId: decision.chatId,
        text: isTappable ? strings.tapAnOption : strings.writtenAnswerUnsupported,
      });
      return;
    }

    case "approval_callback": {
      // Reachable exactly when the trip bot and the signup bot are one bot.
      if (!deps.approvals) {
        // The tokens are different, so this update cannot be ours — some other
        // callback shape arrived. Dropping it is right; handling it would mean
        // acting on an approval this process was never given the config for.
        log(structuredLog("warn", "trip_bot.approval_callback_unconfigured", {}));
        return;
      }
      // Same ref-expansion + verification path POST /v1/signup/callback and
      // telegram-poller.ts both use. The sender identity is derived from the
      // update Telegram delivered to us, never from the callback payload —
      // that distinction is the whole authorization story for this action.
      const resolved = (await resolveTelegramCallbackRef(deps.db, decision.data)) ?? decision.data;
      const senderDigest = digestTelegramId(decision.fromId);
      const result = await processApprovalCallback(
        deps.db, resolved, senderDigest, deps.approvals.config,
      );
      await deps.telegram.answerCallbackQuery({
        callbackQueryId: decision.callbackQueryId,
        text:
          result.outcome === "approved" ? "Approved"
            : result.outcome === "rejected" ? "Rejected"
              : result.outcome === "already_decided" ? "Already decided"
                : "Could not process this action",
      });
      if (result.outcome === "error") {
        log(structuredLog("warn", "trip_bot.approval_rejected", { safe_error_code: result.reason }));
      }
      return;
    }

    case "group_intro": {
      const sent = await deps.telegram.sendMessage({ chatId: decision.chatId, text: decision.text });
      log(structuredLog("info", "trip_bot.group_intro_sent", { ok: sent.ok }));
      // The copyable line, on its own, after the instructions that point at it.
      if (sent.ok && decision.followUp) {
        await deps.telegram.sendMessage({ chatId: decision.chatId, text: decision.followUp });
      }
      // Pinning is best-effort by design. An unpinned introduction is a worse
      // introduction, never a failed arrival — and the overwhelmingly common
      // reason it fails is simply that nobody made the bot an admin.
      if (decision.pin !== false && sent.ok && sent.messageId && deps.telegram.pinChatMessage) {
        const pinned = await deps.telegram.pinChatMessage({
          chatId: decision.chatId,
          messageId: sent.messageId,
        });
        log(structuredLog("info", "trip_bot.group_intro_pin", { pinned }));
      }
      return;
    }

    case "ignore":
      log(structuredLog("info", "trip_bot.ignored", { reason: decision.reason }));
      return;
  }
}

/**
 * A tapped interview button: record it, acknowledge the tap, ask what's next.
 *
 * Note what is NOT passed to the write: no session id and no token. The chat
 * the tap arrived in is the authority, and `submitAnswerForChat` resolves it in
 * the same transaction that stores the answer — so a replayed or forged
 * callback_data can only claim an option within the session its own chat
 * already owns.
 */
async function applyInterviewCallback(
  decision: Extract<DispatchDecision, { kind: "interview_callback" }>,
  deps: TripBotPollerDeps,
  strings: DispatchStrings,
  log: (line: string) => void,
): Promise<void> {
  const parsed = parseCallbackData(decision.data);
  const ack = (text?: string) =>
    deps.telegram.answerCallbackQuery({ callbackQueryId: decision.callbackQueryId, text });

  if (parsed.kind === "answer") {
    const question = findQuestion(parsed.questionId);
    if (!question) {
      await ack("That question is no longer part of the interview.");
      return;
    }
    // A multi_choice answer is a set, so it arrives as `toggle` taps and a
    // Done, never as a single `answer`. Reaching here with one means a stale
    // keyboard from before multi-select existed.
    if (question.type === "multi_choice") {
      log(structuredLog("warn", "trip_bot.multi_choice_tap_refused", { question_id: question.id }));
      await ack("Tap the options, then Done.");
      return;
    }

    const result = await submitAnswerForChat(deps.db, decision.chatId, parsed.questionId, parsed.optionId);
    if (!result.ok) {
      log(structuredLog("warn", "trip_bot.answer_rejected", {
        session_id: decision.sessionId,
        question_id: parsed.questionId,
        safe_error_code: result.reason,
      }));
      await ack("I couldn't record that — try again.");
      return;
    }
    await ack();
    // Collapse the keyboard the instant it is answered. Raised live on
    // 2026-09-05: a single-choice tap left its own buttons sitting on screen
    // exactly as before, with nothing to say the tap had registered — "on a
    // multiple answer question after clicking a button no immediate response
    // is done feeling it stuck". The organizer's next message is often the
    // NEXT question anyway, arriving on its own schedule; this is the one
    // piece of feedback that can be immediate regardless of how long that
    // takes, because it needs nothing from the agent at all.
    if (decision.messageId) {
      const picked = optionLabel(question, parsed.optionId, result.view.language);
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: `${askText(question, result.view.language)}\n\n✅ ${picked}`,
        replyMarkup: undefined,
      });
    }
    await sendNextStep(result.view, decision.chatId, deps, strings);
    return;
  }

  if (parsed.kind === "toggle") {
    const result = await toggleMultiChoiceForChat(
      deps.db, decision.chatId, parsed.questionId, parsed.optionId,
    );
    if (!result.ok) {
      log(structuredLog("warn", "trip_bot.toggle_rejected", {
        session_id: decision.sessionId,
        question_id: parsed.questionId,
        safe_error_code: result.reason,
      }));
      await ack("I couldn't record that — try again.");
      return;
    }
    await ack();
    // Redraw in place rather than sending a new message: a multi-select takes
    // several taps, and one message per tap would bury the question under its
    // own keyboards.
    const question = findQuestion(parsed.questionId);
    if (question && decision.messageId) {
      const rendered = renderQuestion(question, selectedOptionIds(result.view, parsed.questionId), result.view.language);
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: rendered.text,
        replyMarkup: rendered.replyMarkup ?? undefined,
      });
    }
    return;
  }

  if (parsed.kind === "multi_done" || parsed.kind === "skip") {
    // Done on an untouched multi-select is a skip: the organizer looked at the
    // question and had nothing to add, which is not the same as an empty
    // selection meaning "none of these apply".
    const question = findQuestion(parsed.questionId);
    const beforeFinalize = await getSessionForChat(deps.db, decision.chatId);
    const chosenBefore = beforeFinalize.ok ? selectedOptionIds(beforeFinalize.view, parsed.questionId) : [];
    const view = await (async () => {
      if (parsed.kind === "skip") {
        return skipQuestionForChat(deps.db, decision.chatId, parsed.questionId);
      }
      if (chosenBefore.length === 0) {
        return skipQuestionForChat(deps.db, decision.chatId, parsed.questionId);
      }
      return beforeFinalize;
    })();
    if (!view.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    // Same collapse as a single-choice answer, once the multi-select is
    // actually finalized rather than mid-tick: the live keyboard with its
    // ticks is what the organizer needs while choosing, and exactly what
    // should stop inviting taps the moment Done or Skip is pressed.
    if (question && decision.messageId) {
      const summary = chosenBefore.length > 0
        ? chosenBefore.map((id) => optionLabel(question, id, view.view.language)).join(", ")
        : uiString("skipped", view.view.language);
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: `${askText(question, view.view.language)}\n\n✅ ${summary}`,
        replyMarkup: undefined,
      });
    }
    await sendNextStep(view.view, decision.chatId, deps, strings);
    return;
  }

  if (parsed.kind === "no_document") {
    // Nothing to record — the offer was a courtesy, and declining it just
    // starts the questions. It does end the opening PHASE, though: without a
    // marker an organizer who taps past the offer and then says nothing would
    // sit in `opening` forever, since no answer exists to move them on.
    await markOpeningDoneForChat(deps.db, decision.chatId);
    const view = await getSessionForChat(deps.db, decision.chatId);
    if (!view.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    await sendNextStep(view.view, decision.chatId, deps, strings);
    return;
  }

  if (parsed.kind === "more") {
    const result = await askForMoreForChat(deps.db, decision.chatId);
    if (!result.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    await sendNextStep(result.view, decision.chatId, deps, strings);
    return;
  }

  if (parsed.kind === "finish") {
    const result = await setFinishRequestedForChat(deps.db, decision.chatId, true);
    if (!result.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    await sendNextStep(result.view, decision.chatId, deps, strings);
    return;
  }

  if (parsed.kind === "confirm") {
    const result = await confirmIntakeForChat(deps.db, decision.chatId, log);
    if (!result.ok) {
      log(structuredLog("warn", "trip_bot.confirm_rejected", {
        session_id: decision.sessionId,
        safe_error_code: result.reason,
      }));
      await ack("I couldn't confirm that yet.");
      await deps.telegram.sendMessage({
        chatId: decision.chatId,
        text:
          result.reason === "NOT_ALL_REQUIRED_ANSWERED"
            ? "There are still a few things I need before we lock this in."
            : "Something went wrong confirming that. Nothing was lost — try again in a moment.",
      });
      return;
    }
    await ack("Confirmed");
    await deps.telegram.sendMessage({
      chatId: decision.chatId,
      text: `That's locked in — version ${result.versionNumber} of your trip plan. I'll take it from here and let you know when your trip site is ready.`,
    });
    return;
  }

  if (parsed.kind === "keep_planning") {
    // Clearing the finish request is what makes this button mean something. It
    // used to print this sentence and leave the state untouched, so the recap
    // returned on the very next answer and the organizer was back where they
    // started — the loop the 2026-09-04 run hit twice.
    const result = await setFinishRequestedForChat(deps.db, decision.chatId, false);
    await ack();
    await deps.telegram.sendMessage({
      chatId: decision.chatId,
      text: uiString("keepPlanningReply", result.ok ? result.view.language : DEFAULT_LANGUAGE),
    });
    // With optional questions still open, offering the next one beats waiting
    // for the organizer to invent a topic. Multi-select is tappable now, so
    // the old reason for not doing this is gone.
    if (result.ok && result.view.nextQuestion) {
      await sendNextStep(result.view, decision.chatId, deps, strings);
    }
    return;
  }

  await ack();
  log(structuredLog("info", "trip_bot.unknown_callback", { session_id: decision.sessionId }));
}

/**
 * Sends whatever comes after an answer lands: the next question, or the
 * confirm prompt once every required question is answered.
 */
/**
 * Sends the next question — with its buttons — for every interview the agent
 * has just written to.
 *
 * This is the return half of the router/agent split. The agent resolves what
 * an organizer meant and records it; the router asks what comes next, because
 * only the router can draw a keyboard. Before this existed, the first typed
 * answer ended the tap flow permanently and a finished interview had no
 * Confirm button at all.
 *
 * Failures are swallowed per session: one chat whose send fails must not stop
 * the poll loop or block the other claims in the batch.
 */
/**
 * Takes the floor back from an interviewer that has gone quiet, and speaks.
 *
 * The one failure Track 4 introduced. Making the agent the only voice removed
 * chain-of-thought leaks, numbered lists and both floods — but it also means a
 * stalled agent leaves the organizer looking at nothing, where before they at
 * least got a stray message. Runs 4 and 6 both stalled, so this is a failure
 * that has already happened twice rather than one being pre-empted.
 *
 * `claimStalledAgentTurns` closes the turn; `sendNextStep` then draws the next
 * question from `intake-copy.ts` — the router's own copy, in the interview's
 * language. Flat next to the agent's phrasing, and infinitely better than a
 * conversation that simply stops.
 */

/**
 * Delivers every burst of inbound messages that has gone quiet, as ONE
 * message through ONE opened turn.
 *
 * This is `queueInboundMessage`'s other half. Run 9: five rapid messages used
 * to mean five immediate, independent forwards, each tearing down the turn
 * the last one opened while Hermes kept the torn-down turn's own conversation
 * loop running regardless — several uncoordinated agent invocations fighting
 * over the same questions. Waiting for the burst to settle and forwarding it
 * once removes the race at its source: there is only ever one turn for one
 * burst.
 *
 * Text joins with newlines — five lines about five travellers reads as one
 * paragraph, not five separate messages run together. Media rides on the
 * LAST queued event that carried any: a document arriving mid-burst is the
 * rare case, and whichever one is freshest is the one worth keeping if more
 * than one somehow lands in the same window.
 */
/**
 * Folds a settled burst of inbound messages into the single event the agent
 * sees.
 *
 * The organizer sends several things in one go — a sentence, then four files,
 * then another sentence — and each arrives as its own Telegram update. They are
 * one utterance, so they become one turn.
 *
 * EVERY FILE IS KEPT. Until 2026-09-07 this took the media of the last event
 * that had any and discarded the rest: an organizer who uploaded five documents
 * describing their trip had four silently dropped, and the assistant answered
 * about one. From their side it read as being ignored, on files the bot had
 * visibly accepted.
 *
 * Identity comes from the LAST message — that is the one the organizer is
 * looking at — while text and media accumulate across all of them, in the order
 * they were sent.
 */
export function combineBurst(events: readonly WireMessageEvent[]): WireMessageEvent | null {
  const last = events[events.length - 1];
  if (!last) return null;

  const mediaUrls = events.flatMap((e) => e.media_urls ?? []);
  const media = events.flatMap((e) => e.media ?? []);
  const text = events
    .map((e) => e.text)
    .filter((t) => t.trim().length > 0)
    .join("\n");

  return {
    ...last,
    text,
    // Absent rather than empty when nothing was attached: an empty array is a
    // claim that media was considered, and downstream reads `?.length` either
    // way.
    ...(mediaUrls.length ? { media_urls: mediaUrls } : {}),
    ...(media.length ? { media } : {}),
  };
}

/**
 * The interview without an agent: interpret one settled burst, write what
 * survives the gate, then let the router ask what it always would have.
 *
 * Every message the organizer sees still comes from `intake-copy.ts` by way of
 * `sendNextStep`. Nothing the model returns reaches a screen — its whole output
 * is `ProposedAnswer[]`, and `applyProposals` decides what any of it is allowed
 * to write. That is the entire difference from the agent path.
 *
 * Failure is a value at every step. No runner, a rate limit, unparseable
 * output, low confidence, evidence that is not in the message — each of them
 * lands in the same place: the router asks its own question. A slower
 * interview, never a silent one.
 *
 * Design: docs/interview-without-an-agent.md §3, §4, §6.
 */
async function runInterpretPath(
  deps: TripBotPollerDeps,
  burst: { sessionId: string; chatId: string },
  combined: WireMessageEvent,
  log: (line: string) => void,
): Promise<void> {
  const strings = deps.strings ?? DEFAULT_STRINGS;
  const sourceText = combined.text ?? "";
  const messageIds = combined.message_id ? [combined.message_id] : [];
  const key = burstKey(messageIds, sourceText);

  const ask = async () => {
    const after = await getSessionForChat(deps.db, burst.chatId);
    if (after.ok) await sendNextStep(after.view, burst.chatId, deps, strings);
  };

  // Idempotency (§6). A redelivered burst, or a retry after the relay died
  // mid-call, finds the row rather than paying for a second model call and
  // writing the answers twice.
  const claim = await claimInterpretation(deps.db, {
    sessionId: burst.sessionId,
    chatId: burst.chatId,
    burstKey: key,
    sourceText,
  });
  if (!claim.fresh && claim.row.committedAt) {
    log(structuredLog("info", "interview.interpret_replayed", {
      session_id: burst.sessionId,
      burst_key: key,
    }));
    // Committed already, but the organizer may never have seen the question
    // that followed — asking again is safe (the flood dedupe suppresses a
    // genuine repeat), staying silent is not.
    await ask();
    return;
  }

  const state = await questionStateForChat(deps.db, burst.chatId);
  if (!state) return;
  const session = await getSessionForChat(deps.db, burst.chatId);
  const language = session.ok ? session.view.language : DEFAULT_LANGUAGE;

  const interpretationId = claim.fresh ? claim.id : claim.row.id;
  let proposals: ProposedAnswer[];
  let malformed = 0;

  if (!claim.fresh) {
    // The crash window: the model answered, the commit did not land. Resume
    // from what was stored rather than asking again — the answer is already
    // paid for and re-asking could return something different.
    proposals = claim.row.proposals;
    log(structuredLog("info", "interview.interpret_resumed", {
      session_id: burst.sessionId,
      burst_key: key,
      proposals: proposals.length,
    }));
  } else if (!deps.modelRunner) {
    await recordInterpretationResult(deps.db, interpretationId, {
      failureReason: "NOT_CONFIGURED",
      attempts: 0,
      durationMs: 0,
    });
    await markInterpretationCommitted(deps.db, interpretationId, { askAnyway: state.outstanding.slice(0, 1) });
    await ask();
    return;
  } else {
    const result = await interpretBurst(deps.modelRunner, {
      sourceText,
      outstanding: state.outstanding,
      language,
      messageIds,
    });
    if (!result.ok) {
      log(structuredLog("warn", "interview.interpret_failed", {
        session_id: burst.sessionId,
        reason: result.reason,
        attempts: result.attempts,
        ms: result.ms,
      }));
      await recordInterpretationResult(deps.db, interpretationId, {
        failureReason: result.reason,
        attempts: result.attempts,
        durationMs: result.ms,
      });
      await markInterpretationCommitted(deps.db, interpretationId, { askAnyway: state.outstanding.slice(0, 1) });
      await ask();
      return;
    }
    proposals = result.payload.proposals;
    malformed = result.payload.malformed;
    await recordInterpretationResult(deps.db, interpretationId, {
      proposals,
      attempts: result.attempts,
      durationMs: result.ms,
    });
    log(structuredLog("info", "interview.interpret_ok", {
      session_id: burst.sessionId,
      proposals: proposals.length,
      unclear: result.payload.unclear.length,
      malformed,
      attempts: result.attempts,
      ms: result.ms,
    }));
  }

  const decisions = applyProposals(proposals, {
    sourceText,
    outstanding: state.outstanding,
    answered: state.answered,
    unclear: [],
  });

  for (const accepted of decisions.accepted) {
    const args = submitArgsFor(accepted.proposal.value);
    const written = await submitAnswerForChat(
      deps.db,
      burst.chatId,
      accepted.questionId,
      args.optionId,
      args.otherText,
      args.structuredData,
      args.optionIds,
    );
    if (!written.ok) {
      // The gate passed it and the write refused it — the two validators
      // disagreeing is worth seeing, not swallowing.
      log(structuredLog("warn", "interview.interpret_write_refused", {
        session_id: burst.sessionId,
        question_id: accepted.questionId,
        reason: written.reason,
      }));
    }
  }

  log(structuredLog("info", "interview.interpret_committed", {
    session_id: burst.sessionId,
    accepted: decisions.accepted.length,
    rejected: decisions.rejected.length,
    reasons: decisions.rejected.map((r) => r.reason),
  }));
  await markInterpretationCommitted(deps.db, interpretationId, storedOutcomes(decisions, malformed));

  // The floor was taken when the burst arrived; the router speaks now.
  await ask();
}

export async function flushSettledInboundBursts(
  deps: TripBotPollerDeps,
  log: (line: string) => void,
  settleSeconds?: number,
): Promise<void> {
  let bursts: Awaited<ReturnType<typeof claimSettledInboundBursts>>;
  try {
    bursts = settleSeconds === undefined
      ? await claimSettledInboundBursts(deps.db)
      : await claimSettledInboundBursts(deps.db, 10, settleSeconds);
  } catch {
    log(structuredLog("warn", "trip_bot.inbound_burst_claim_failed", {}));
    return;
  }
  for (const burst of bursts) {
    try {
      const events = burst.events as WireMessageEvent[];
      const combined = combineBurst(events);
      if (!combined) continue;

      log(structuredLog("info", "trip_bot.inbound_burst_flushed", {
        session_id: burst.sessionId,
        messages_combined: events.length,
      }));

      // Same ordering as the old single-message path: the turn opens BEFORE
      // the event goes out, so the agent may call back the moment it is
      // handed the turn without racing a turn opened afterward.
      // A burst carrying files is a document turn, and gets the wider floor —
      // more so than a single upload, since the agent now has several to read.
      // This path builds its own event rather than going through
      // `applyDecision`, so it has to say so itself; without this the five-file
      // burst above ran on the ordinary 30-second budget.
      if ((combined.media_urls?.length ?? 0) > 0) {
        await markAwaitingMachine(deps.db, burst.chatId, DOCUMENT_FLOOR_SECONDS);
      }
      // THE FORK. A session on the interpret path never opens an agent turn:
      // one writer per session (docs/interview-without-an-agent.md §5), and the
      // turn IS the agent's licence to write.
      if (await isInterpretPath(deps.db, burst.chatId)) {
        await runInterpretPath(deps, burst, combined, log);
        continue;
      }

      const turn = await openAgentTurn(deps.db, burst.chatId, burst.sessionId);
      const delivered = deps.connector.pushInbound(combined);
      if (delivered) {
        log(structuredLog("info", "trip_bot.interview_forwarded", {
          session_id: burst.sessionId,
          turn_id: turn.id,
          messages_combined: events.length,
        }));
        continue;
      }
      await closeAgentTurn(deps.db, burst.chatId);
      log(structuredLog("warn", "trip_bot.turn_lost", { reason: "GATEWAY_UNAVAILABLE" }));
    } catch {
      log(structuredLog("warn", "trip_bot.inbound_burst_flush_failed", { session_id: burst.sessionId }));
    }
  }
}

export async function recoverStalledInterviews(
  deps: TripBotPollerDeps,
  strings: DispatchStrings,
  log: (line: string) => void,
  floorSeconds?: number,
): Promise<void> {
  let stalled: Array<{ sessionId: string; chatId: string }>;
  try {
    stalled = floorSeconds === undefined
      ? await claimStalledAgentTurns(deps.db)
      : await claimStalledAgentTurns(deps.db, 10, floorSeconds);
  } catch {
    log(structuredLog("warn", "trip_bot.stalled_turn_claim_failed", {}));
    return;
  }
  for (const { sessionId, chatId } of stalled) {
    try {
      const result = await getSessionForChat(deps.db, chatId);
      if (!result.ok) continue;
      const view = result.view;

      // Rendered here rather than through `sendNextStep`, and the reason is a
      // real interaction the tests found: the flood dedupe suppresses a repeat
      // of the last prompt, and a stalled agent is usually stalled on the
      // question the router just asked. Routed through sendNextStep the
      // watchdog would fall silent exactly when it is needed. Re-sending the
      // identical question instead would break "no message twice" — the run-5
      // and run-6 rule. So the recovery gets its own opening line: distinct
      // text, same question, buttons intact.
      const question = view.nextQuestion ?? view.pendingAsk ?? view.optionalRemaining[0] ?? null;
      if (!question) continue;

      // If this question is ALREADY the last thing on the organizer's screen,
      // re-sending it adds nothing and costs a great deal: a stalling agent
      // makes the watchdog fire on every turn, and the organizer gets the same
      // question again and again. Seen live on 2026-09-05 — "Getting this over
      // and over again: נמשיך מכאן." The recovery exists to break silence, not
      // to fill it.
      if (view.lastPrompt === `q:${question.id}`) {
        (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.recovery_suppressed", {
          session_id: sessionId,
          question_id: question.id,
          reason: "ALREADY_ON_SCREEN",
        }));
        continue;
      }

      log(structuredLog("warn", "trip_bot.agent_floor_reclaimed", {
        session_id: sessionId,
        after_seconds: floorSeconds ?? AGENT_FLOOR_SECONDS,
        question_id: question.id,
      }));

      const rendered = renderQuestion(question, selectedOptionIds(view, question.id), view.language);
      await deps.telegram.sendMessage({
        chatId,
        text: `${uiString("resumed", view.language)}\n\n${rendered.text}`,
        replyMarkup: rendered.replyMarkup ?? undefined,
      });
      await recordLastPromptForChat(deps.db, chatId, `q:${question.id}`);
    } catch {
      log(structuredLog("warn", "trip_bot.stalled_turn_recovery_failed", { session_id: sessionId }));
    }
  }
}

/**
 * The router-owned question that is safe to ask right now, if any at all —
 * see `routerOwned` on `IntakeQuestion`. Shared between `sendNextStep` and
 * `advanceRouterOwnedQuestions` so the two can never quietly disagree about
 * what "ready" means.
 *
 * Deliberately does not fire on the optional side until `offeredMore` is
 * true — the organizer has to see the essentials-done "want to add more, or
 * finish?" transition at least once before ANY optional question, router-
 * owned or not. Pre-empting that with a fast, judgment-free question would
 * read exactly like the form Track 4 was built to get away from: no "you're
 * done with the required stuff" moment, just straight into more questions.
 */
function nextRouterOwnedQuestion(view: SessionView): IntakeQuestion | null {
  if (view.nextQuestion) return view.nextQuestion.routerOwned ? view.nextQuestion : null;
  if (!view.offeredMore) return null;
  return view.optionalRemaining.find((q) => q.routerOwned) ?? null;
}

/**
 * Track 8: asks whatever router-owned question is next, on its own clock —
 * during normal progression (skipping the agent round-trip a fixed-choice
 * question never needed) and, just as importantly, while an agent turn is
 * open and doing something else entirely (document extraction, deciding
 * which OTHER optional question to nominate). Productive progress instead of
 * dead air, without touching or interrupting whatever the agent is doing:
 * a router-owned answer is recorded through the same tap-handling path as
 * any other button, which needs no open agent turn at all.
 *
 * Scoped to `awaiting = 'machine'` sessions only — if the organizer holds the
 * floor, nothing is owed yet, so there is nothing to check. Calling
 * `sendNextStep` speculatively for every candidate, every tick, is safe
 * rather than wasteful: its own dedupe against `lastPrompt` (and the floor
 * claim itself) makes a redundant call a silent no-op, the same protection
 * `renderDueRouterPrompts` and the stalled-turn watchdog already lean on.
 *
 * Deliberately does not fall back to `nextQuestion` generally — only a
 * question explicitly marked `routerOwned` ever gets asked here. Asking
 * `destination` the instant a document is queued, before the agent has had
 * any chance to read it, would defeat the entire reason to upload one.
 *
 * WHAT "WHILE A TURN IS OPEN" IS NARROWED TO, AND WHY
 *
 * "An agent turn is open" was the wrong proxy for "the agent is busy with
 * something else". It is also true while the agent is mid-conversation,
 * composing the very next thing it means to say — and in that state a
 * router-owned question does not fill dead air, it talks over the
 * interviewer. Run 13, verbatim: "it again competing with the agent on the
 * questions."
 *
 * So the two cases are separated by what the turn is FOR, not by whether one
 * exists. A turn carrying media is genuine async work: the agent is reading a
 * document and will be a while, and a fixed-choice question asked meanwhile
 * costs it nothing. Any other open turn is a conversation in progress, and
 * the interviewer owns that until it hands the floor back.
 *
 * With no turn open at all, this fires freely — that is the latency half of
 * Track 8, and there is nobody to compete with.
 */
export async function advanceRouterOwnedQuestions(
  deps: TripBotPollerDeps,
  strings: DispatchStrings,
  log: (line: string) => void,
): Promise<void> {
  let candidates: Array<{ chatId: string; isAsyncWork: boolean }>;
  try {
    candidates = await listMachineAwaitingChats(deps.db);
  } catch {
    log(structuredLog("warn", "trip_bot.router_owned_scan_failed", {}));
    return;
  }
  for (const { chatId, isAsyncWork } of candidates) {
    try {
      const result = await getSessionForChat(deps.db, chatId);
      if (!result.ok || result.view.state !== "interviewing") continue;
      if (!nextRouterOwnedQuestion(result.view)) continue;
      if (!isAsyncWork && (await hasOpenAgentTurn(deps.db, chatId))) {
        log(structuredLog("info", "trip_bot.router_owned_yielded", {
          session_id: result.view.sessionId,
          reason: "AGENT_MID_CONVERSATION",
        }));
        continue;
      }
      await sendNextStep(result.view, chatId, deps, strings);
    } catch {
      log(structuredLog("warn", "trip_bot.router_owned_scan_item_failed", {}));
    }
  }
}

export async function renderDueRouterPrompts(
  deps: TripBotPollerDeps,
  strings: DispatchStrings,
  log: (line: string) => void,
  /**
   * How long the writing has to have stopped before the router speaks.
   *
   * Production waits `ROUTER_PROMPT_SETTLE_SECONDS`, because an agent
   * recording a document's worth of answers asks the router to speak once per
   * write, and run 6 received that as a flood. Tests pass 0: they control the
   * writes exactly, so waiting real seconds would only make the suite slow.
   */
  settleSeconds?: number,
): Promise<void> {
  let due: Array<{ sessionId: string; chatId: string }>;
  try {
    due = settleSeconds === undefined
      ? await claimDueRouterPrompts(deps.db)
      : await claimDueRouterPrompts(deps.db, 10, settleSeconds);
  } catch {
    log(structuredLog("warn", "trip_bot.router_prompt_claim_failed", {}));
    return;
  }
  for (const { sessionId, chatId } of due) {
    try {
      const result = await getSessionForChat(deps.db, chatId);
      if (!result.ok) continue;
      await sendNextStep(result.view, chatId, deps, strings);
      log(structuredLog("info", "trip_bot.router_prompt_sent", {
        session_id: sessionId,
        state: result.view.state,
      }));
    } catch {
      log(structuredLog("warn", "trip_bot.router_prompt_failed", { session_id: sessionId }));
    }
  }
}

/**
 * Gives the turn back to the interviewer after a tap it never saw.
 *
 * Taps are recorded by the router alone — no agent is involved, which is the
 * whole point of the deterministic layer. But once the router stops walking
 * the optional questions, a tap that leaves nothing to ask would leave the
 * conversation silent: the organizer answered, and neither side speaks.
 *
 * So the router forwards a short factual note instead. It is deliberately not
 * a script for the agent to read out — `SOUL.md` requires it to call
 * `get_interview_for_chat` and trust that over any text, this note included.
 */
async function handBackToInterviewer(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
): Promise<void> {
  if (!deps.interviewerProfile) return;
  const log = deps.log ?? (() => {});
  // Already talking to it. Handing a second turn to an agent that is mid-turn
  // is how run 5 turned into a bombardment: the handback opened a turn, the
  // agent's next write scheduled another router prompt, that found nothing to
  // ask and handed back again — nine turns and twenty-eight messages deep
  // before anyone stopped it.
  if (await hasOpenAgentTurn(deps.db, chatId)) {
    log(structuredLog("info", "trip_bot.handback_skipped", {
      session_id: view.sessionId,
      reason: "TURN_ALREADY_OPEN",
    }));
    return;
  }
  // Same reasoning as the settle-window ack: a handback can take a while —
  // the agent may be mid-turn on several optional questions — and this is the
  // one thing that can be immediate regardless.
  await deps.telegram.sendChatAction({ chatId }).catch(() => {});
  const turn = await openAgentTurn(deps.db, chatId, view.sessionId);
  const delivered = deps.connector.pushInbound(
    toWireEvent(
      { chat: { id: chatId, type: "private" } } as never,
      chatId,
      "[router] The organizer just answered with a button. Nothing is queued to ask them — "
        + "read the interview state and carry on, or ask for the summary if you have everything.",
      deps.interviewerProfile,
    ),
  );
  log(structuredLog(delivered ? "info" : "warn", "trip_bot.interview_handback", {
    session_id: view.sessionId,
    turn_id: turn.id,
    ...(delivered ? {} : { safe_error_code: "GATEWAY_UNAVAILABLE" }),
  }));
}

/**
 * What the router says after an answer lands: the next required question, the
 * optional question the interviewer nominated, or the confirm recap.
 *
 * It does NOT walk the optional questions on its own while an interviewer is
 * configured. It did for one live run, and marching the whole optional set in
 * schema order turned the interview into a form — the organizer was asked for
 * a timezone having already said Japan. With an interviewer present, which
 * optional question to raise is its call; without one there is nobody else to
 * ask, so the walk stays as the fallback.
 */
async function sendNextStep(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
  _strings: DispatchStrings,
): Promise<void> {
  let text: string;
  let replyMarkup: InlineKeyboard | undefined;

  // THE FLOOR. Nothing is sent while it is the organizer's turn — that is a
  // conversation waiting on a human, not a fault. Run 7 got most questions
  // twice because the router and the interviewer each decided independently
  // that something was owed; this is the single fact that arbitrates them.
  if (view.awaiting === "person") {
    (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.floor_held_by_person", {
      session_id: view.sessionId,
    }));
    return;
  }

  // What there is to ask, worked out BEFORE the say is handled — because
  // whether the say goes out alone depends on it. See the fold below.
  const autoWalkOptional = !deps.interviewerProfile;
  const question =
    view.nextQuestion
    ?? view.pendingAsk
    ?? nextRouterOwnedQuestion(view)
    ?? (autoWalkOptional && view.state === "interviewing" ? view.optionalRemaining[0] ?? null : null);

  // Every agent write asks the router to speak. An agent that recorded five
  // answers off one document therefore asked five times, and the organizer got
  // the same question five times over. Saying nothing when there is nothing
  // new to say is the whole fix.
  const promptKey = view.state === "awaiting_confirmation" ? "recap" : question ? `q:${question.id}` : "";
  const questionIsNew = Boolean(question) && promptKey !== view.lastPrompt;

  /** The agent's words, folded in above the question rather than sent alone. */
  let leadIn: string | null = null;

  // The interviewer's own words go out first and alone. This is the `say`
  // half of Track 4: the agent no longer reaches Telegram directly, so if it
  // has something to tell the organizer, THIS is the only way it arrives.
  // Delivered verbatim and then cleared, so a message is sent exactly once
  // however many times the router is prompted to speak.
  if (view.pendingSay) {
    // The one deliberate exception to "the agent may always reclaim the
    // floor": once the recap is on screen, the organizer's only outstanding
    // decision is Confirm or Keep planning, and nothing may bury that button.
    // Run 7 ended exactly this way — the agent kept talking after the recap,
    // the organizer said "approved" in prose to it, and nothing happened,
    // because only the button writes an intake version. Discarded rather than
    // queued: the organizer taps Keep planning to reopen the conversation, at
    // which point a fresh, contextual reply is what belongs there, not
    // something written before they'd even seen the recap.
    if (view.state === "awaiting_confirmation") {
      // Suppress the stale say and FALL THROUGH — do not return. Returning
      // here was a real bug, not just a trade-off: it exited the whole
      // function before the recap-rendering code below ever ran, so the one
      // case this was built to protect (an agent write landing in the SAME
      // moment the interview reaches recap) produced total silence instead
      // of the recap. Live on 2026-09-05: the organizer answered the last
      // optional question, the agent tried to acknowledge it, and NOTHING
      // reached the chat at all — not the ack, not the recap, not the
      // Confirm button. The point was only ever to stop the AGENT'S WORDS
      // burying the recap, never to stop the recap itself from being sent.
      (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.say_suppressed_during_recap", {
        session_id: view.sessionId,
      }));
      await clearPendingSayForChat(deps.db, chatId);
    } else if (questionIsNew) {
      // THE FOLD, and the reason `question` is computed above rather than
      // below: a say and a question outstanding at the same moment are one
      // utterance — "here's what I recorded, and here's the next thing" —
      // and sending the say ALONE ends the router's turn, because the send
      // claims the floor and the question is left behind a floor that now
      // belongs to the organizer. Nothing speaks again until they do.
      //
      // That is not hypothetical. Run 13, 2026-09-05, read off the agent log
      // and the turn table:
      //
      //   23:04:47.591  ask_question_for_chat completes — trip_pace nominated,
      //                 with the agent's own phrasing, floor reclaimed
      //   23:04:50.553  the agent's turn ends; its closing text reaches the
      //                 relay and becomes pendingSay
      //   23:04:50.6    the router delivers that say, claims the floor, returns
      //   ...           floor_held_by_person, every pass, for ELEVEN MINUTES
      //   23:15:43      the organizer gives up and types "מה עכשיו?"
      //
      // `trip_pace` was never asked and never answered. The organizer had been
      // TOLD it was asked — the closing text said so — which is why the stall
      // read as the bot ignoring them rather than as the bot being stuck.
      //
      // `nominateQuestionForChat` already folds a say into the nomination, but
      // only one that is still pending when the nomination runs. Here the say
      // arrived AFTER the ask, which no nomination-time fold can catch. This
      // one is race-free by construction: both values are read from the same
      // session row in the same pass, so the order they were written in stops
      // mattering.
      leadIn = view.pendingSay;
      await clearPendingSayForChat(deps.db, chatId);
    } else {
      // Nothing new to ask, so the say IS the message. Claim before sending:
      // if the router got here first this returns false and the message waits
      // for the organizer's next turn rather than landing on top of what was
      // just said.
      if (!(await claimFloor(deps.db, chatId))) return;
      await clearPendingSayForChat(deps.db, chatId);
      await deps.telegram.sendMessage({
        chatId,
        text: view.pendingSay,
        // Agent-authored text is written in the dialect TELEGRAM_DESCRIPTOR
        // advertises, so it has to be SENT in that dialect. The connector
        // always did this; routing the same text through the router instead
        // dropped it, and 2026-09-05's run 7 got raw asterisks for its
        // trouble. Whoever delivers the agent's words owes them the same
        // parse mode.
        parseMode: "MarkdownV2",
      });
      return;
    }
  }

  if (promptKey && promptKey === view.lastPrompt) {
    (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.prompt_deduped", {
      session_id: view.sessionId,
      prompt: promptKey,
    }));
    return;
  }

  if (!question && view.state !== "awaiting_confirmation") {
    // The boundary between the required questions and the optional ones is the
    // one place the router still speaks unprompted. Both exits — more
    // questions, or the summary — are put in front of the organizer exactly
    // once, so a fumbled nomination by the interviewer cannot strand them with
    // no way forward, which is precisely what happened on 2026-09-04's run 4.
    //
    // "Exactly once" is now the ENTRY ACTION of the `optional` phase rather
    // than a flag of its own: entering a phase happens once by definition, so
    // there is nothing to remember to set. `offeredMore` is still read for
    // sessions that predate the phase column and have not transitioned since.
    if (view.pendingEntry === "optional" || (view.pendingEntry === null && !view.offeredMore)) {
      if (!(await claimFloor(deps.db, chatId))) return;
      const rendered = renderEssentialsDone(view.language);
      await clearPendingEntryForChat(deps.db, chatId);
      await markOfferedMoreForChat(deps.db, chatId);
      await deps.telegram.sendMessage({
        chatId,
        text: rendered.text,
        replyMarkup: rendered.replyMarkup ?? undefined,
      });
      return;
    }
    // After that it is the interviewer's conversation to carry. Saying
    // something anyway is how the router ended up talking over it.
    await handBackToInterviewer(view, chatId, deps);
    return;
  }

  if (view.state === "awaiting_confirmation") {
    const recap = (view.recap ?? [])
      .map((entry) => `• ${entry.prompt}\n  ${entry.answerLabel}`)
      .join("\n");
    const rendered = renderConfirmPrompt(
      `${uiString("recapHeader", view.language)}\n\n${recap}\n\n${uiString("recapFooter", view.language)}`,
      view.language,
    );
    text = rendered.text;
    replyMarkup = rendered.replyMarkup ?? undefined;
  } else if (question) {
    // Selections travel with the question: re-asking a half-ticked
    // multi-select without them would show every option unticked and invite
    // the organizer to tap the same ones off again.
    // The agent's wording applies to the question IT nominated, never to a
    // required question the router walked to on its own — otherwise a sentence
    // written for `dietary` would end up above `departure_date`.
    const nominated = view.pendingAsk?.id === question.id ? view.pendingAskText : null;
    // A folded say leads; the nomination's own phrasing follows. Both are the
    // agent's words for this same moment, so they belong in one message in
    // the order they were written — exactly what nominateQuestionForChat
    // produces when it wins its race, produced here whether it did or not.
    const agentPhrasing = leadIn && nominated
      ? `${leadIn}\n\n${nominated}`
      : leadIn ?? nominated;
    // The agent's words, unless they are in the wrong language. The router's own
    // copy is fully localised, so falling back to it beats passing through a
    // sentence the organizer cannot read. Run 15: "some of the messages from the
    // bot came in English" — in an interview held entirely in Hebrew, after a
    // rate-limit swapped the model mid-conversation.
    const wrongLanguage = agentPhrasing !== null && agentPhrasing !== undefined
      && !agentTextIsInLanguage(agentPhrasing, view.language);
    if (wrongLanguage) {
      (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.agent_phrasing_dropped", {
        reason: "WRONG_LANGUAGE",
        language: view.language,
      }));
    }
    const phrasing = wrongLanguage ? null : agentPhrasing;
    const rendered = renderQuestion(
      question,
      selectedOptionIds(view, question.id),
      view.language,
      phrasing,
    );
    text = rendered.text;
    replyMarkup = rendered.replyMarkup ?? undefined;
    if (view.pendingAsk?.id === question.id) await clearPendingAskForChat(deps.db, chatId);
  } else {
    // `interviewing` always has a next question now — required ones first,
    // then optional ones not yet answered or skipped — and every other state
    // is handled above, so this stays unreachable.
    text = "Thanks — noted.";
  }

  // The question or the recap. Claimed last, immediately before it goes out,
  // so a slow render cannot leave the floor held by a message nobody sent.
  if (!(await claimFloor(deps.db, chatId))) return;
  await deps.telegram.sendMessage({ chatId, text, replyMarkup });
  if (promptKey) await recordLastPromptForChat(deps.db, chatId, promptKey);
}

// ── The loop ─────────────────────────────────────────────────────────────────

/** Narrows one getUpdates element to something with a usable update_id. */
function asUpdate(raw: unknown): TelegramUpdate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { update_id?: unknown };
  if (typeof candidate.update_id !== "number") return null;
  return raw as TelegramUpdate;
}

/**
 * Starts the update loop and returns a stop function.
 *
 * Awaits each poll rather than running on a timer: a long poll can outlast any
 * sensible interval, and two overlapping getUpdates on one token is the 409
 * this module exists to avoid.
 */
export function startTripBotPoller(
  deps: TripBotPollerDeps,
  options: PollerOptions = {},
): () => void {
  const log = deps.log ?? (() => {});
  const strings = deps.strings ?? DEFAULT_STRINGS;
  const longPollSeconds = options.longPollSeconds ?? DEFAULT_LONG_POLL_SECONDS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const deliverIntervalMs = options.deliverIntervalMs ?? DEFAULT_DELIVER_INTERVAL_MS;

  let offset = 0;
  let stopped = false;
  let backoffMs = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Never hold the process open on a backoff nap.
      timer.unref?.();
    });

  async function run(): Promise<void> {
    // Telegram refuses getUpdates outright while a webhook is registered for
    // the same token, so this must happen before the first poll, not per tick.
    await deps.telegram.deleteWebhookIfPresent();
    log(structuredLog("info", "trip_bot.polling_started", { long_poll_seconds: longPollSeconds }));

    while (!stopped) {
      const startedAt = Date.now();
      const raw = await deps.telegram.getUpdates({
        offset,
        timeoutSeconds: longPollSeconds,
        // `my_chat_member` is how the bot learns it was added to a group — the
        // moment the companion should introduce itself. Additive: an update
        // type left out of this list is not delivered to anyone else either,
        // it is simply dropped, so nothing loses traffic by its being here.
        allowedUpdates: ["message", "callback_query", "my_chat_member"],
      });
      const elapsed = Date.now() - startedAt;

      // Delivery is NOT done here — it runs on its own timer (`deliver`), so
      // an agent reply written during a 25-second long poll is not held until
      // that poll returns. Keeping it here as well would only add a duplicate
      // claim attempt on a schedule the organizer cannot feel.

      if (raw.length > 0) {
        backoffMs = 0;
      } else if (elapsed < longPollSeconds * 500) {
        // A long poll that returns nothing should have blocked for roughly the
        // full window. Returning empty and immediately means the call failed —
        // getUpdates swallows its own errors and reports `[]` — so back off
        // rather than spin a failing request as fast as the network allows.
        backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, maxBackoffMs);
        log(structuredLog("warn", "trip_bot.poll_backoff", { backoff_ms: backoffMs }));
      } else {
        backoffMs = 0;
      }

      for (const item of raw) {
        const update = asUpdate(item);
        if (!update) continue;
        // Advance the offset BEFORE handling. Telegram redelivers everything
        // at or after `offset` until it moves, so an update that throws every
        // time would otherwise be retried forever and block every update
        // behind it — one poisoned message silencing the whole bot.
        offset = Math.max(offset, update.update_id + 1);
        try {
          const decision = await dispatchUpdate(deps.db, update, strings, log, deps.botIdentity ?? {}, {
            interviewerProfile: deps.interviewerProfile,
            media: deps.media,
            // Asked per update rather than cached: a gateway can stop between
            // one message and the next, and a stale "reachable" spends the
            // organizer's turn on a socket that is gone.
            ...(deps.connector.canReachProfile
              ? { canReachProfile: (profile: string) => deps.connector.canReachProfile!(profile) }
              : {}),
          });
          await applyDecision(decision, deps);
        } catch (error) {
          log(structuredLog("error", "trip_bot.update_failed", {
            safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
          }));
        }
      }

      // Unconditional, even at zero. `await` on an already-resolved promise
      // only drains the microtask queue, so a getUpdates that returns without
      // real I/O — a stubbed client, or a long-poll window of zero — would
      // starve the macrotask queue entirely: timers would never fire and the
      // stop flag below would never get a chance to be observed. A setTimeout
      // of 0 is a macrotask, which is the point of it.
      if (!stopped) await sleep(backoffMs);
    }
    log(structuredLog("info", "trip_bot.polling_stopped", {}));
  }

  /**
   * Delivers what the agent has written, on its OWN clock.
   *
   * This used to run only inside the poll loop, right after `getUpdates`
   * returns — which coupled every agent-authored message to the Telegram
   * long-poll cycle. The sequence that produces was reported live on
   * 2026-09-05 as "it takes a lot of time for the next question": the
   * organizer answers, `getUpdates` returns immediately with their message,
   * the loop finds nothing owed yet and blocks on the NEXT poll for 25
   * seconds, and the agent's reply — written two seconds later — waits out
   * that whole window before anyone sees it.
   *
   * Nothing about delivery has anything to do with when Telegram next hands us
   * an update, so it gets its own timer. The claims are atomic
   * (FOR UPDATE SKIP LOCKED), so running alongside the poll loop is safe.
   */
  async function deliver(): Promise<void> {
    while (!stopped) {
      try {
        // Flushing a settled burst comes first: it is what opens the turn and
        // gives the agent something to write, which the next two calls then
        // deliver or watch for a stall on.
        await flushSettledInboundBursts(deps, log);
        await advanceRouterOwnedQuestions(deps, strings, log);
        await renderDueRouterPrompts(deps, strings, log);
        await recoverStalledInterviews(deps, strings, log);
      } catch (error) {
        log(structuredLog("warn", "trip_bot.deliver_tick_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
      }
      await sleep(deliverIntervalMs);
    }
  }

  void run().catch((error) => {
    log(structuredLog("error", "trip_bot.poll_loop_crashed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
  });

  void deliver().catch((error) => {
    log(structuredLog("error", "trip_bot.deliver_loop_crashed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
  });

  return () => {
    stopped = true;
  };
}
