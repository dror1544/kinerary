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
  conflictCallbackData,
  cutWhole,
  findQuestion,
  parseCallbackData,
  renderConfirmPrompt,
  renderBoundaryAsk,
  renderEssentialsDone,
  renderQuestion,
  renderSuggestion,
  type InlineKeyboard,
  type RenderedQuestion,
} from "../chat-router.js";
import {
  closeAgentTurn,
  confirmIntakeForChat,
  getSessionForChat,
  AGENT_FLOOR_SECONDS,
  DOCUMENT_FLOOR_SECONDS,
  claimDueRouterPrompts,
  claimFloor,
  finalizeMultiChoiceForChat,
  beginOtherAnswerForChat,
  markAwaitingMachine,
  claimStalledAgentTurns,
  openAgentTurn,
  queueInboundMessage,
  claimSettledInboundBursts,
  listMachineAwaitingChats,
  submitAnswerForChat,
  isAnswered,
  setLanguageForChat,
  scopeWithChoice,
  submitPendingOtherForChat,
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
  INTAKE_QUESTIONS,
  claimExpiredSessions,
  claimSessionsDueWarning,
  expiredSessionLanguage,
  touchSessionDeadline,
  answersForChat,
  saveSourceDocumentForChat,
  hasPendingInbound,
  isReadingDocument,
  markReadingDocument,
  deferQuestionForChat,
  deferredRequired,
  undeferAllForChat,
  buildRecap,
  selectedOptionIds,
  setFinishRequestedForChat,
  advancePhaseForChat,
  skipQuestionForChat,
  toggleMultiChoiceForChat,
  saveSuggestionsForChat,
  dismissSuggestionForChat,
  suggestionLabel,
  type SuggestedAnswer,
  typedChoiceAnswer,
  applyPendingChangeForChat,
} from "../interview.js";
import { draftDigest, heldRefLists, parseOps, questionOfOp, type Op } from "../typed-changes.js";
import {
  cancelDraft,
  getDraft,
  getDraftForInterpretation,
  getOpenDraft,
  pickForDraft,
  proposeChange,
  rebuildDraft,
  recordDisplacedPrompt,
  type Draft,
  type ProposeResult,
} from "../typed-changes-store.js";
import { bareReply, confirmable, questionNoun, renderDraft } from "../typed-changes-render.js";
import {
  applyProposals,
  DEFAULT_MIN_CONFIDENCE,
  burstKey,
  documentBurstKey,
  INTERPRET_SOURCE_BUDGET_CHARS,
  claimInterpretation,
  interpretBurst,
  isInterpretPath,
  markInterpretationCommitted,
  readBoundaryReply,
  recordInterpretationResult,
  storedOutcomes,
  submitArgsFor,
  submitArgsForAccepted,
  type BoundaryIntent,
  type ProposedAnswer,
  type InterpretPayload,
  type ProposedValue,
  type StoredOutcomes,
} from "../interpret.js";
import { modelRunnerFromEnv, type StructuredModelRunner } from "../model-runner.js";
import {
  approveCorrection,
  confirmedOrganizerChat,
  correctionDocumentName,
  getCorrection,
  proposeCorrectionsFromReadings,
  rejectCorrection,
  renderCorrection,
  reviewDeliveries,
  tripOwnerUserId,
} from "../document-correction.js";
import {
  applyConflictChoice,
  canonical,
  entryIdentity,
  isRecord as isRecordValue,
  itineraryCoverageComplete,
  matchEntry,
} from "../answer-merge.js";
import {
  getConflict,
  nextOpenConflict,
  openConflict,
  recordAnswerSources,
  resolveConflict,
  type AnswerConflict,
  type AnswerSource,
} from "../answer-provenance.js";
import { listTripDocuments } from "../document-registry.js";
import { contentDigest, type DocumentBlobStore } from "../document-store.js";
import { gateDocumentProposals, type DocumentGateResult } from "../document-gate.js";
import {
  extractRegisteredDocuments,
  ingestDocument,
  type RegisteredDocument,
} from "../document-intake.js";
import { extractItinerary, foldExtractedIntoPhases, ITINERARY_TRUNCATED_WARNING } from "../itinerary-extract.js";
import { parkDeferredVenueLinks } from "../venue-links.js";
import { provisionOnConfirm } from "../planner.js";
import type { RosterChoice } from "../organizer-identity.js";
import type { RelayAssistantEvents, RelayToolOutcome } from "../analytics/emitter.js";

/**
 * Reading a booking PDF and turning it into answers took ~94 seconds on the
 * real Japan document. Generous, because the alternative to waiting is asking
 * the organizer to type what is already in the file.
 */
const DOCUMENT_EXTRACT_TIMEOUT_MS = Number(process.env.DOCUMENT_EXTRACT_TIMEOUT_MS || 240_000);
import { digestTelegramId } from "../identity.js";
import { resolveTelegramCallbackRef } from "../adapters/telegram.js";
import { processApprovalCallback, type SignupConfig } from "../signup.js";
import type { MediaDeps } from "./normalize.js";
import { PendingAttachments } from "./pending-attachments.js";
import { GroupContext } from "./group-context.js";
import {
  askText, DEFAULT_LANGUAGE, optionLabel, readableDate, recapLabel, UI_STRINGS, uiString, writtenLanguage,
  type Language,
} from "../intake-copy.js";
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
import { isPermanentRefusal, type SendResult, type TelegramClient } from "./telegram-api.js";

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
   * Where a group document that addressed nobody waits for its sender's next
   * addressed message. Injectable for tests; the poller makes its own, which
   * lives exactly as long as the poll loop does.
   */
  pendingAttachments?: PendingAttachments;
  groupContext?: GroupContext;
  /**
   * The bounded-call runner behind the interpret path
   * (docs/interview-without-an-agent.md). Absent, `interpret_path` sessions
   * fall back to the router's own questions — which is a working interview,
   * just a slower one, and is deliberately not an error.
   */
  modelRunner?: StructuredModelRunner;
  /**
   * Where uploaded documents' original bytes are kept (`DOCUMENT_STORE_DIR`).
   * Absent, documents are still registered, read and extracted — their bytes
   * are just not kept, and their registry rows say so.
   */
  documentStore?: DocumentBlobStore;
  /**
   * The day-by-day extractor, injectable for tests.
   *
   * Defaults to the real one, which runs on the shared model runner when
   * `EXTRACT_RUNNER` is set — so the router can call it directly, with no
   * Hermes profile and no MCP round trip.
   */
  extractItinerary?: typeof extractItinerary;
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
  /**
   * The signup super admin's subject digest, whichever bot signup runs on. The
   * only person who may switch a task's model from a chat (`/model`).
   */
  superAdminSubjectDigest?: string;
  /**
   * The relay's assistant-event emitter (#177), or absent — the default, and
   * then nothing is recorded and dispatch attaches no descriptor. Every call
   * into it is synchronous and cannot throw; see analytics/emitter.ts.
   */
  assistantEvents?: RelayAssistantEvents;
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

  // WRITING INTO A CLOSED INTERVIEW.
  //
  // Answered here, before the floor is touched or anything is queued, because
  // the alternative is worse than silence: the message would be recorded
  // against a session nobody is going to finish, and the organizer would get
  // no reply and no reason.
  //
  // Only reached when the chat has NO live session — a fresh deep link makes a
  // new one and leaves the expired one alone, so `expiredSessionLanguage`
  // checks for that. A `/start` never lands here anyway: it is a `reply`
  // decision with its own text, not an interview one.
  if (chatId) {
    const closedIn = await expiredSessionLanguage(deps.db, chatId);
    if (closedIn) {
      await deps.telegram.sendMessage({ chatId, text: uiString("expiredWriteAfter", closedIn) });
      log(structuredLog("info", "interview.write_after_expiry", { chat_id_present: true }));
      return;
    }
  }

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
      // Carried only by the companion-unreachable answer: a lost turn.
      if (decision.analytics) deps.assistantEvents?.companionUnreachable(decision.reply.chatId, decision.analytics);
      return;

    case "to_gateway": {
      const delivered = deps.connector.pushInbound(decision.event);
      if (decision.analytics) {
        deps.assistantEvents?.handedOff(decision.event.source.chat_id, decision.analytics, delivered, decision.event.message_id);
      }
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

    case "callback_ack":
      // Answered and nothing more: the button stops spinning and no message is
      // posted, so a tap from a chat we have no business in says nothing to it.
      await deps.telegram.answerCallbackQuery({ callbackQueryId: decision.callbackQueryId, text: decision.text }).catch(() => {});
      return;

    case "callback_reply":
      // Answer the query FIRST. Telegram spins the button until it is
      // answered, so doing this after the send would leave the organizer
      // watching a spinner for the duration of the message they are waiting
      // for. Fire-and-forget by contract — answerCallbackQuery returns void
      // and a failure here must not cost them the sentence itself.
      await deps.telegram.answerCallbackQuery({ callbackQueryId: decision.callbackQueryId });
      await deps.telegram.sendMessage({ chatId: decision.chatId, text: decision.text });
      return;

    case "show_summary":
      await sendNextStep(decision.view, decision.chatId, deps, strings);
      return;

    case "interview_callback":
      await applyInterviewCallback(decision, deps, strings, log);
      return;

    case "document_correction": {
      // Reading takes minutes, and the poll loop must not wait on it: every
      // other chat's messages would queue behind one upload. One chat's
      // uploads are still read one after another, in the order they came.
      const previous = correctionChains.get(decision.chatId) ?? Promise.resolve();
      const relayTurn = decision.analytics ? deps.assistantEvents?.toRelay(decision.chatId, decision.analytics) ?? null : null;
      const next = previous
        .then(async () => {
          const read = await runDocumentCorrection(decision, deps, log);
          deps.assistantEvents?.relayToolCompleted(relayTurn, read.outcome, read.documents);
        })
        .catch((error) => {
          log(structuredLog("error", "trip_bot.document_correction_failed", {
            detail: String((error as Error)?.message ?? error).slice(0, 200),
          }));
          deps.assistantEvents?.relayToolCompleted(relayTurn, "failed_tool", 0);
        });
      correctionChains.set(decision.chatId, next);
      void next.finally(() => {
        if (correctionChains.get(decision.chatId) === next) correctionChains.delete(decision.chatId);
      });
      return;
    }

    case "correction_callback":
      await applyCorrectionCallback(decision, deps, log);
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
        const language = view.ok ? view.view.language : DEFAULT_LANGUAGE;
        // ONE acknowledgement, and this is it.
        //
        // The interpret path used to add a second from `runDocumentPath` after
        // the burst settled, so the organizer got "קיבלתי — קורא את זה עכשיו…"
        // and then, seconds later, "קיבלתי — אני קורא את זה עכשיו. זה לוקח
        // דקה…" — the same sentence twice, with a question wedged between them.
        //
        // Said HERE rather than there because here is instant: the burst has a
        // settle window and reading takes a minute, and the acknowledgement is
        // the one message whose entire job is to arrive immediately. The
        // interpret path's wording is the better one — it sets the
        // expectation — so it is used when that path will do the reading.
        await deps.telegram.sendMessage({
          chatId: decision.chatId,
          text: uiString(
            (await isInterpretPath(deps.db, decision.chatId)) ? "documentReading" : "fileReceived",
            language,
          ),
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
      // The deadline moves before anything slow. A conversation that is
      // happening must never expire under the person having it — including
      // while a model call or a document read is still in flight.
      await touchSessionDeadline(deps.db, decision.chatId);
      await queueInboundMessage(deps.db, decision.chatId, decision.event);
      return;
    }

    case "interview_text": {
      // Which reply is honest depends on what is actually pending — see the
      // interview_text doc in dispatch.ts.
      const session = await getSessionForChat(deps.db, decision.chatId);
      if (session.ok && session.view.otherPending) {
        // A custom choice is deliberately not treated like an ordinary text
        // field. The organizer pressed Other because none of the known values
        // fit, so the interviewer must verify that their words actually answer
        // THIS question before they can become companion context.
        if (!deps.modelRunner) {
          await deps.telegram.sendMessage({
            chatId: decision.chatId,
            text: uiString("otherNeedsReview", session.view.language),
          });
          return;
        }
        const question = session.view.otherPending;
        const reviewed = await interpretBurst(deps.modelRunner, {
          sourceText: decision.text,
          outstanding: [question.id],
          language: session.view.language,
          onScreen: question.id,
        });
        if (!reviewed.ok) {
          await deps.telegram.sendMessage({
            chatId: decision.chatId,
            text: uiString("otherNeedsReview", session.view.language),
          });
          return;
        }
        const decisions = applyProposals(reviewed.payload.proposals, {
          sourceText: decision.text,
          outstanding: [question.id],
          answered: [],
          pendingQuestionId: question.id,
        });
        // Preserve exactly what the organizer wrote. The model validates the
        // meaning; it is not allowed to paraphrase a personal trip descriptor
        // on the way into the companion's context.
        const accepted = decisions.accepted.find((entry) =>
          entry.questionId === question.id
          && entry.answer.kind === "choice_other"
          && entry.answer.other_text === decision.text.trim(),
        );
        if (!accepted) {
          await deps.telegram.sendMessage({
            chatId: decision.chatId,
            text: uiString("otherDoesntFit", session.view.language),
          });
          return;
        }
        const result = await submitPendingOtherForChat(deps.db, decision.chatId, decision.text);
        if (!result.ok) {
          await deps.telegram.sendMessage({ chatId: decision.chatId, text: "I couldn't record that — try again." });
          return;
        }
        await sendNextStep(result.view, decision.chatId, deps, strings);
        return;
      }
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
      // Carried only by NOT_ADDRESSED group messages.
      if (decision.analytics) deps.assistantEvents?.notAddressed(decision.analytics);
      return;
  }
}

/** Post-confirmation document readings in progress, one chain per chat. */
const correctionChains = new Map<string, Promise<void>>();

/** Resolves when every post-confirmation reading started so far has finished. For tests and shutdown. */
export async function settleDocumentCorrections(): Promise<void> {
  await Promise.all([...correctionChains.values()]);
}

/**
 * A document the organizer sent after confirmation: read like any other, then
 * proposed back to them — see document-correction.ts. Nothing here writes the
 * trip; the organizer's Approve does.
 */
async function runDocumentCorrection(
  decision: Extract<DispatchDecision, { kind: "document_correction" }>,
  deps: TripBotPollerDeps,
  log: (line: string) => void,
): Promise<{ outcome: RelayToolOutcome; documents: number }> {
  const { chatId, tripId, language } = decision;
  const say = async (text: string, replyMarkup?: InlineKeyboard) => {
    await deps.telegram.sendMessage({ chatId, text, ...(replyMarkup ? { replyMarkup } : {}) }).catch(() => {});
  };
  await say(uiString("correctionReading", language));

  const documents = documentsInBurst(decision.event, deps);
  // What the read came to, for the relay's assistant events (#177). Here the
  // relay IS the tool, so this is a substantive outcome, not a delivery fact.
  const read = (outcome: RelayToolOutcome) => ({ outcome, documents: documents.length });
  const { registered, identity, unreadable } = await ingestBurstDocuments(
    deps, { sessionId: decision.sessionId, chatId }, tripId, documents, log, "pending",
  );
  if (identity > 0) await say(uiString("documentIdentity", language));
  if (registered.length === 0) {
    if (identity === 0) await say(uiString(unreadable > 0 ? "documentUnreadable" : "documentNothing", language));
    return read(identity > 0 ? "blocked_by_policy" : "failed_tool");
  }
  if (registered.some(readPartially)) await say(uiString("documentPartial", language));
  const runner = deps.modelRunner;
  if (!runner) return read("failed_tool");

  const extracted = await extractRegisteredDocuments(
    { db: deps.db, runner, tripId, language, timeoutMs: DOCUMENT_EXTRACT_TIMEOUT_MS, log },
    registered,
  );
  const usable = extracted.flatMap((e) => (e.kind === "ok" ? [e] : []));
  if (usable.length === 0) {
    await say(uiString("documentExtractFailed", language));
    return read("failed_tool");
  }

  const outcome = await proposeCorrectionsFromReadings(deps.db, {
    tripId,
    chatId,
    readings: usable.map((e) => ({ documentId: e.documentId, text: e.text, payload: e.payload })),
    documentIds: registered.map((d) => d.documentId),
  });
  if (outcome.kind === "no_version") return read("failed_tool");
  if (outcome.corrections.length === 0) {
    await reviewDeliveries(deps.db, tripId, registered.map((d) => d.documentId), "approved");
    await say(uiString("correctionNothingNew", language));
    return read("no_new_information");
  }
  for (const correction of outcome.corrections) {
    if (correction.status !== "pending") {
      await say(uiString("correctionAlreadyDecided", language));
      continue;
    }
    const rendered = renderCorrection(correction, await correctionDocumentName(deps.db, correction), language);
    await say(rendered.text, rendered.replyMarkup);
  }
  log(structuredLog("info", "trip_bot.document_correction_proposed", {
    trip_id: tripId,
    documents: registered.length,
    proposals: outcome.corrections.length,
    new_proposals: outcome.created.filter(Boolean).length,
  }));
  return read("correction_proposed");
}

/**
 * The organizer's decision on a proposal. Accepted only from the chat it was
 * asked in, from the person that private chat is, while that chat is still the
 * trip's confirmed interview chat.
 */
async function applyCorrectionCallback(
  decision: Extract<DispatchDecision, { kind: "correction_callback" }>,
  deps: TripBotPollerDeps,
  log: (line: string) => void,
): Promise<void> {
  const ack = (text?: string) =>
    deps.telegram.answerCallbackQuery({ callbackQueryId: decision.callbackQueryId, text }).catch(() => {});
  const correction = await getCorrection(deps.db, decision.proposalId);
  if (!correction || correction.requestedChatId !== decision.chatId || !decision.fromId || decision.fromId !== decision.chatId) {
    await ack();
    return;
  }
  const organizer = await confirmedOrganizerChat(deps.db, correction.tripId, decision.chatId);
  if (!organizer) {
    await ack();
    return;
  }
  const { language } = organizer;
  const say = (text: string) => deps.telegram.sendMessage({ chatId: decision.chatId, text }).catch(() => {});
  const decidedBy = digestTelegramId(decision.fromId);

  if (decision.choice === "reject") {
    const rejected = await rejectCorrection(deps.db, { id: correction.id, chatId: decision.chatId, decidedBy });
    await ack(uiString(rejected ? "correctionRejected" : "correctionAlreadyDecided", language));
    if (rejected) await say(uiString("correctionRejected", language));
    return;
  }

  const outcome = await approveCorrection(deps.db, { id: correction.id, chatId: decision.chatId, decidedBy });
  switch (outcome.kind) {
    case "already_decided":
      await ack(uiString("correctionAlreadyDecided", language));
      return;
    case "stale":
      await ack();
      await say(uiString("correctionStale", language));
      return;
    case "not_now":
      await ack();
      await say(uiString("correctionNotNow", language));
      return;
    case "failed":
      await ack();
      await say(uiString("correctionFailed", language));
      log(structuredLog("warn", "trip_bot.document_correction_not_applied", { trip_id: correction.tripId, reason: outcome.reason }));
      return;
    case "applied": {
      await ack(uiString("correctionApplied", language));
      // The same step confirming takes: a new version is the organizer's
      // approval, so the site is rebuilt from it.
      const owner = await tripOwnerUserId(deps.db, correction.tripId);
      const provisioned = owner
        ? await provisionOnConfirm(deps.db, correction.tripId, owner).catch(() => ({ ok: false as const, stage: "plan" as const, reason: "THREW" }))
        : ({ ok: false as const, stage: "plan" as const, reason: "NO_SINGLE_OWNER" });
      await say(uiString(provisioned.ok ? "correctionApplied" : "correctionAppliedSiteLater", language));
      log(structuredLog("info", "trip_bot.document_correction_applied", {
        trip_id: correction.tripId,
        version_id: outcome.versionId,
        provisioning: provisioned.ok ? "started" : `not started: ${provisioned.reason}`,
      }));
      return;
    }
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

  /**
   * Answer the tap, and do not let a concurrent scan swallow the answer.
   *
   * `applyDecision` hands the floor to the machine when a tap arrives, so a
   * view built after that says `machine`. If the reply still goes out as
   * nothing, the floor was taken from under it mid-send — the scan's own
   * `sendNextStep` ends by handing the floor back to the organizer whenever
   * the question is already on their screen, which for a SKIP is exactly the
   * question that is no longer on it. One retry, on a fresh view.
   *
   * Only when the view we sent said `machine`: a view that says `person` means
   * the floor was the organizer's before the tap was even processed — the
   * agent's turn, say — and speaking over that is the duplicate-message bug
   * the floor exists to prevent.
   */
  const respond = async (view: SessionView) => {
    if (await sendNextStep(view, decision.chatId, deps, strings)) return;
    // THE TAP THAT ENDS THE INTERVIEW. `view` was built before this tap was
    // recorded, so for the last skip it still carries the question that was
    // just skipped: the send above dedupes it as "already on their screen" and
    // says nothing, correctly. What it cannot see is that the session is now
    // confirmable — and the recap is owed by nobody else, because the due flag
    // that scheduled this turn is spent.
    //
    // Checked before the `machine` floor test below, which is about not
    // speaking over the agent mid-turn: a recap is not an interruption, it is
    // the answer to the tap the organizer just made. Twice on 2026-09-18 an
    // interview ended here in silence, and `/done` produced the recap
    // instantly — it was never missing, only unasked-for.
    const settled = await getSessionForChat(deps.db, decision.chatId);
    if (settled.ok && settled.view.state === "awaiting_confirmation") {
      await markAwaitingMachine(deps.db, decision.chatId);
      const withFloor = await getSessionForChat(deps.db, decision.chatId);
      if (withFloor.ok) {
        await sendNextStep(withFloor.view, decision.chatId, deps, strings);
      }
      return;
    }
    if (view.awaiting !== "machine") return;
    // ONLY IF NOBODY ELSE SPOKE. This retry takes the floor BACK — it is the
    // one place that overrides the arbiter — so it has to be sure the floor
    // was lost to a pass that said nothing, not to one that is mid-send.
    //
    // Both look identical from here: `sendNextStep` returns false either way.
    // What tells them apart is `lastPrompt`, which a speaker now records while
    // it still holds the floor and a dedupe leaves exactly as it found it. On
    // 2026-09-18 this could not tell the difference and asked `trip_interests`
    // and `trip_pace` a second time each, on top of the copy already going out.
    if (settled.ok && (settled.view.lastPrompt ?? "") !== (view.lastPrompt ?? "")) {
      log(structuredLog("info", "trip_bot.tap_reply_covered", {
        session_id: decision.sessionId,
        prompt: settled.view.lastPrompt ?? null,
      }));
      return;
    }
    await markAwaitingMachine(deps.db, decision.chatId);
    const fresh = await getSessionForChat(deps.db, decision.chatId);
    if (fresh.ok) await sendNextStep(fresh.view, decision.chatId, deps, strings);
  };

  // A TYPED CHANGE WAITING FOR THE ORGANIZER (#206): apply it, cancel it, or
  // answer what it asks. Answered on every path — a tap on a draft that is gone,
  // settled or someone else's says so.
  if (parsed.kind === "change") {
    await ack();
    if (parsed.choice === "pick") {
      const now = await getSessionForChat(deps.db, decision.chatId);
      const draft = await getDraft(deps.db, parsed.draftId);
      if (!now.ok || !draft || draft.sessionId !== now.view.sessionId || draft.status !== "pending") {
        await deps.telegram.sendMessage({
          chatId: decision.chatId, text: uiString("change.gone", now.ok ? now.view.language : DEFAULT_LANGUAGE),
        }).catch(() => {});
        return;
      }
      // Checked again under the row lock inside `pickForDraft`; this read only
      // spares the common case a write.
      const picked = parsed.digest === draftDigest(draft)
        ? await pickForDraft(deps.db, { draftId: draft.id, sessionId: now.view.sessionId, k: parsed.index ?? 0, expectedDigest: parsed.digest })
        : "updated" as const;
      if (picked === "updated") {
        await reshowDraft(deps, decision.chatId, now.view, draft, strings, uiString("change.updated", now.view.language));
        return;
      }
      if (picked === "too_big") {
        await deps.telegram.sendMessage({ chatId: decision.chatId, text: uiString("change.droppedTooBig", now.view.language) }).catch(() => {});
        await resumeAfterChange(deps, decision.chatId, strings, draft.displacedPrompt);
        return;
      }
      if (!picked) {
        await deps.telegram.sendMessage({ chatId: decision.chatId, text: uiString("change.gone", now.view.language) }).catch(() => {});
        return;
      }
      await showChangeDraft(deps, decision.chatId, now.view, picked);
      return;
    }
    await settleChange(
      deps,
      // The digest names the version the person tapped on; null (a button from
      // before digests existed) matches nothing, so it is never applied.
      { chatId: decision.chatId, draftId: parsed.draftId, choice: parsed.choice, digest: parsed.digest, ...(decision.messageId ? { messageId: decision.messageId } : {}) },
      strings,
      log,
    );
    return;
  }

  // A DISAGREEMENT BETWEEN DOCUMENTS, settled. The decision is about one field
  // of one entry, and it applies only while that field still holds what the
  // question showed. A tap on a question that has stopped being true — someone
  // corrected the answer, another document landed — is answered as settled and
  // never applied over whatever changed it.
  if (parsed.kind === "conflict") {
    const session = await getSessionForChat(deps.db, decision.chatId);
    if (!session.ok) {
      await ack();
      return;
    }
    const { tripId, language } = session.view;
    const conflict = await getConflict(deps.db, tripId, parsed.conflictId);
    if (!conflict || conflict.status !== "open") {
      await ack(uiString("documentConflictStale", language));
      await respond(session.view);
      return;
    }
    const rendered = await renderConflictQuestion(deps.db, decision.chatId, conflict, language);
    const collapse = async (label: string) => {
      if (!decision.messageId) return;
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: `${rendered.text}\n\n✅ ${label}`,
        replyMarkup: undefined,
      });
    };

    if (parsed.choice === "keep") {
      await resolveConflict(deps.db, { tripId, conflictId: conflict.id, status: "kept", resolvedBy: "organizer" });
      await ack(uiString("documentConflictKept", language));
      await collapse(rendered.keepLabel);
      await respond(session.view);
      return;
    }

    const store = await answersForChat(deps.db, decision.chatId);
    const heldAnswer = store?.answers[conflict.questionId] as { kind?: string; data?: unknown } | undefined;
    let written: Awaited<ReturnType<typeof submitAnswerForChat>> | null = null;
    if (conflict.entryKey === "" && conflict.path === "") {
      // A whole answer — a text or a choice — applies only if it is still
      // exactly the answer the question showed.
      if (heldAnswer && canonical(heldAnswer) === canonical(conflict.held) && isRecordValue(conflict.incoming)) {
        const args = submitArgsFor(conflict.incoming as ProposedValue);
        written = await submitAnswerForChat(
          deps.db, decision.chatId, conflict.questionId,
          args.optionId, args.otherText, args.structuredData, args.optionIds,
          { held: heldAnswer },
        );
      }
    } else if (heldAnswer?.kind === "structured") {
      const next = applyConflictChoice(heldAnswer.data, conflict);
      if (next !== null) {
        written = await submitAnswerForChat(
          deps.db, decision.chatId, conflict.questionId, null, undefined, next, undefined,
          { held: heldAnswer },
        );
      }
    }

    if (!written || (!written.ok && written.reason === "STALE_ANSWER")) {
      await resolveConflict(deps.db, { tripId, conflictId: conflict.id, status: "superseded", resolvedBy: "system" });
      await ack(uiString("documentConflictStale", language));
      await collapse(uiString("documentConflictStale", language));
      await respond(session.view);
      return;
    }
    if (!written.ok) {
      log(structuredLog("warn", "trip_bot.conflict_write_refused", {
        session_id: decision.sessionId,
        question_id: conflict.questionId,
        safe_error_code: written.reason,
      }));
      await ack("I couldn't record that — try again.");
      return;
    }
    await resolveConflict(deps.db, { tripId, conflictId: conflict.id, status: "replaced", resolvedBy: "organizer" });
    await recordAnswerSources(deps.db, [{
      tripId,
      questionId: conflict.questionId,
      entryKey: conflict.entryKey,
      documentId: conflict.documentId,
      disposition: "accepted",
      paths: conflict.path ? [conflict.path] : [],
    }]).catch(() => 0);
    await ack(uiString("documentConflictReplaced", language));
    await collapse(rendered.replaceLabel);
    await respond(written.view);
    return;
  }

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

    // A roster button on a text question carries a position and a fingerprint of
    // the name, not the name. What is recorded is that traveller's own spelling,
    // read from the record NOW — so a keyboard drawn before the roster changed can
    // never record whoever holds that position today.
    let recorded: string = parsed.optionId;
    let pickedLabel: string | null = null;
    let structured: unknown;
    if ((question.type === "text" || question.type === "structured") && question.choicesFrom) {
      const store = await answersForChat(deps.db, decision.chatId);
      const choice = store ? question.choicesFrom(store.answers).find((c) => c.id === parsed.optionId) : undefined;
      if (!choice) {
        log(structuredLog("warn", "trip_bot.stale_choice_tap", {
          session_id: decision.sessionId,
          question_id: question.id,
        }));
        await ack("That list has changed — tap your name again.");
        const fresh = await getSessionForChat(deps.db, decision.chatId);
        if (fresh.ok && decision.messageId) {
          const redrawn = renderQuestion(question, [], fresh.view.language, null, fromRecord(fresh.view, question.id));
          await deps.telegram.editMessageText({
            chatId: decision.chatId,
            messageId: decision.messageId,
            text: redrawn.text,
            replyMarkup: redrawn.replyMarkup ?? undefined,
          });
        }
        return;
      }
      recorded = choice.value;
      // An empty label is the wordless "everyone" button; what it says is
      // written below, where the interview's language is known.
      pickedLabel = choice.label || null;
      // The dietary scope is an object keyed by need, so a tap ADDS to it: the
      // need being asked about gets this traveller (or everyone), and the
      // question stays open while another ticked need still has nobody.
      if (question.type === "structured" && store) structured = scopeWithChoice(store.answers, choice.value);
    }

    const result = structured !== undefined
      ? await submitAnswerForChat(deps.db, decision.chatId, parsed.questionId, null, undefined, structured)
      : await submitAnswerForChat(deps.db, decision.chatId, parsed.questionId, recorded);
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
      const picked = pickedLabel
        ?? (structured !== undefined
          ? uiString("scopeEveryone", result.view.language)
          : optionLabel(question, parsed.optionId, result.view.language));
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: `${askText(question, result.view.language)}\n\n✅ ${picked}`,
        replyMarkup: undefined,
      });
    }
    await respond(result.view);
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

  if (parsed.kind === "other") {
    const question = findQuestion(parsed.questionId);
    const result = await beginOtherAnswerForChat(deps.db, decision.chatId, parsed.questionId);
    if (!result.ok || !question?.otherPrompt) {
      await ack("That option is no longer available.");
      return;
    }
    await ack();
    if (decision.messageId) {
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: uiString("otherPrompt", result.view.language),
        replyMarkup: undefined,
      });
    } else {
      await deps.telegram.sendMessage({ chatId: decision.chatId, text: uiString("otherPrompt", result.view.language) });
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
      // What ENDS the selection. Every tick wrote itself already; this is the
      // moment the question counts as answered and the interview may move on.
      return finalizeMultiChoiceForChat(deps.db, decision.chatId, parsed.questionId);
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
    // THE FLOOR, for this tap only.
    //
    // `skipQuestionForChat` and `finalizeMultiChoiceForChat` return views whose
    // `awaiting` is `buildSessionView`'s default — "person" — regardless of the
    // session. `sendNextStep` reads the floor off the view it is given and says
    // nothing while it is the organizer's turn, so a tapped Skip recorded the
    // skip, collapsed the keyboard to "(דילגו)", and then said nothing at all.
    // Two minutes of that on 2026-09-12, until the organizer typed something
    // and the interpret path carried on as normal.
    //
    // The machine owes this message: `applyDecision` took the floor when the
    // tap arrived. Said here rather than in the view builders because a
    // truthful floor everywhere also lets the router speak over an agent
    // mid-turn, which is a different question with its own tests.
    // A skip can END the optional phase, and the phase is the authority the
    // view projects `state` from. Recording an answer advances it;
    // `skipQuestionForChat` does not — so skipping the LAST optional question
    // left the phase in `optional`, the recap never became due, and the
    // interview simply went quiet. Live, twice, on 2026-09-18; `/done`
    // recovered it each time, because that asks to finish and forces the phase
    // across.
    //
    // Not from `recap`: there the machine deliberately falls back to
    // `optional` when finishing was not requested — that is what Keep planning
    // reopens with, and a skip must never undo a recap on screen.
    if (view.view.phase !== "recap") {
      await advancePhaseForChat(deps.db, decision.chatId);
    }
    const settled = await getSessionForChat(deps.db, decision.chatId);
    await respond({ ...(settled.ok ? settled.view : view.view), awaiting: "machine" });
    return;
  }

  if (parsed.kind === "suggestion_yes" || parsed.kind === "suggestion_no") {
    const question = findQuestion(parsed.questionId);
    const before = await getSessionForChat(deps.db, decision.chatId);
    const suggestion = before.ok ? before.view.suggestions[parsed.questionId] : undefined;
    if (!question || !before.ok || !suggestion) {
      // Answered some other way since — typed, or from a later document. The
      // buttons are stale; what the organizer needs is whatever comes next.
      await ack();
      if (before.ok) await respond({ ...before.view, awaiting: "machine" });
      return;
    }
    const language = before.view.language;

    if (parsed.kind === "suggestion_yes") {
      const label = suggestionLabel(parsed.questionId, suggestion, language);
      const result = await submitAnswerForChat(
        deps.db, decision.chatId, parsed.questionId,
        suggestion.optionId, suggestion.otherText, suggestion.structuredData, suggestion.optionIds,
      );
      if (!result.ok) {
        log(structuredLog("warn", "trip_bot.suggestion_rejected", {
          session_id: decision.sessionId,
          question_id: parsed.questionId,
          safe_error_code: result.reason,
        }));
        // Refused now, so it would be refused again: ask the question plainly.
        const plain = await dismissSuggestionForChat(deps.db, decision.chatId, parsed.questionId);
        await ack("I couldn't record that — try again.");
        if (plain.ok) {
          const rendered = renderQuestion(question, selectedOptionIds(plain.view, question.id), language, null, fromRecord(plain.view, question.id));
          await deps.telegram.sendMessage({ chatId: decision.chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined });
        }
        return;
      }
      await ack();
      log(structuredLog("info", "trip_bot.suggestion_confirmed", { session_id: decision.sessionId, question_id: parsed.questionId }));
      if (decision.messageId) {
        await deps.telegram.editMessageText({
          chatId: decision.chatId,
          messageId: decision.messageId,
          text: suggestionConfirmedText(question, label, language),
          replyMarkup: undefined,
        });
      }
      await respond({ ...result.view, awaiting: "machine" });
      return;
    }

    const declined = await dismissSuggestionForChat(deps.db, decision.chatId, parsed.questionId);
    if (!declined.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    log(structuredLog("info", "trip_bot.suggestion_declined", { session_id: decision.sessionId, question_id: parsed.questionId }));
    // THE SAME MESSAGE becomes the plain question. It is already the last
    // prompt (`q:<id>`), so sending it anew would be deduped into silence —
    // and replacing it in place is also what reads right: the question stays,
    // the reading they said no to goes.
    const rendered = renderQuestion(question, selectedOptionIds(declined.view, question.id), language, null, fromRecord(declined.view, question.id));
    if (decision.messageId) {
      await deps.telegram.editMessageText({
        chatId: decision.chatId,
        messageId: decision.messageId,
        text: rendered.text,
        replyMarkup: rendered.replyMarkup ?? undefined,
      });
    } else {
      await deps.telegram.sendMessage({ chatId: decision.chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined });
    }
    // The question is on their screen: the turn is theirs.
    await claimFloor(deps.db, decision.chatId);
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
    await respond(view.view);
    return;
  }

  if (parsed.kind === "more") {
    const result = await askForMoreForChat(deps.db, decision.chatId);
    if (!result.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    await respond(result.view);
    return;
  }

  if (parsed.kind === "finish") {
    const result = await setFinishRequestedForChat(deps.db, decision.chatId, true);
    if (!result.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    await respond(result.view);
    return;
  }

  if (parsed.kind === "confirm") {
    // READ THE SESSION FIRST. `getSessionForChat` filters on
    // `state <> 'confirmed'`, and confirming sets exactly that state — so once
    // the confirm below succeeds this view can never be fetched again. Reading
    // it afterwards returned NOT_FOUND every single time, which silently cost
    // two things: the confirmation message fell back to English on a Hebrew
    // interview, and `provisionOnConfirm` sat inside an `if (view.ok)` that was
    // never true, so confirming built nothing and did not even log why.
    const sessionBeforeConfirm = await getSessionForChat(deps.db, decision.chatId);
    const result = await confirmIntakeForChat(deps.db, decision.chatId, log);
    if (!result.ok) {
      log(structuredLog("warn", "trip_bot.confirm_rejected", {
        session_id: decision.sessionId,
        safe_error_code: result.reason,
      }));
      // A change waiting for the organizer's answer is not an error and not a
      // missing answer: it is said in the interview's own language, and it says
      // what to do. Every other reason keeps its wording.
      if (result.reason === "PENDING_CHANGE") {
        const language = sessionBeforeConfirm.ok ? sessionBeforeConfirm.view.language : DEFAULT_LANGUAGE;
        await ack(uiString("changePendingBlocksConfirm", language));
        await deps.telegram.sendMessage({ chatId: decision.chatId, text: uiString("changePendingBlocksConfirm", language) });
        // And the change itself, with its buttons — the way to settle it is one tap
        // away. If that preview cannot be sent, the change is dropped out loud and
        // Confirm is free again: a change nobody can see must not block it for good.
        const waiting = sessionBeforeConfirm.ok ? await getOpenDraft(deps.db, sessionBeforeConfirm.view.sessionId) : null;
        if (waiting && sessionBeforeConfirm.ok) {
          await reshowDraft(deps, decision.chatId, sessionBeforeConfirm.view, waiting, strings, undefined, { dropIfUnsent: true });
        }
        return;
      }
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
    // In the interview's own language, and naming the assistant they chose.
    const confirmedView = sessionBeforeConfirm;
    const confirmedLanguage = confirmedView.ok ? confirmedView.view.language : DEFAULT_LANGUAGE;
    const named = await answersForChat(deps.db, decision.chatId);
    const botName = (() => {
      const answer = named?.answers.bot_name as { text?: unknown } | undefined;
      const raw = typeof answer?.text === "string" ? answer.text.trim() : "";
      // A name with markup or a newline in it would arrive as a broken
      // sentence; better to fall back than to send something mangled.
      return raw && raw.length <= 60 && !/[<>\n]/.test(raw) ? raw : "";
    })();
    await deps.telegram.sendMessage({
      chatId: decision.chatId,
      text: botName
        ? uiString("intakeConfirmed", confirmedLanguage).replace("{name}", botName)
        : uiString("intakeConfirmedNoName", confirmedLanguage),
    });

    // CONFIRMING IS THE APPROVAL, so provisioning starts here.
    //
    // A finished interview used to sit with no plan and no job, waiting for the
    // organizer to approve — in a SPA — the thing they had just approved in the
    // conversation. That is a second decision about the first one, and the
    // button for it is not deployed.
    //
    // Best-effort by design: the intake is already confirmed and immutable, and
    // the organizer has just been told their site is being built. A failure here
    // is an operational problem to be retried, not something to take back.
    if (confirmedView.ok) {
      // The trip's owner, read from the membership rather than carried on the
      // confirm result: `issueApproval` records WHO approved, and that has to
      // be the organizer, not whichever session happened to be open.
      const owner = await deps.db.query<{ user_id: string }>(
        `SELECT user_id FROM control_plane.trip_memberships
          WHERE trip_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1`,
        [confirmedView.view.tripId],
      );
      const ownerId = owner.rows[0]?.user_id ?? "";
      const provisioned = await provisionOnConfirm(deps.db, confirmedView.view.tripId, ownerId)
        .catch((error: unknown) => ({ ok: false as const, stage: "plan" as const, reason: String((error as Error)?.message ?? error) }));
      log(structuredLog(provisioned.ok ? "info" : "warn", "interview.provisioning_started", {
        session_id: confirmedView.view.sessionId,
        trip_id: confirmedView.view.tripId,
        ...(provisioned.ok ? { plan_id: provisioned.planId } : { stage: provisioned.stage, safe_error_code: provisioned.reason }),
      }));
    }
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
      await respond(result.view);
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
  // Each descriptor keeps the id of the message it came in, which the combined
  // event's own `message_id` (the last message's) cannot tell it.
  const media = events.flatMap((e) =>
    (e.media ?? []).map((m) => (m.message_id || !e.message_id ? m : { ...m, message_id: e.message_id })),
  );
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

/** The attachments in a burst, resolved back out of the relay's media store. */
function documentsInBurst(
  combined: WireMessageEvent,
  deps: TripBotPollerDeps,
): BurstDocument[] {
  const store = deps.media?.store;
  if (!store?.get) return [];
  const out: BurstDocument[] = [];
  for (const [index, url] of (combined.media_urls ?? []).entries()) {
    // The wire carries `{connector}/relay/media/{id}` — a URL rather than the
    // bytes, because a Telegram file URL embeds the bot token and must never
    // cross. Reading it back locally by id skips an HTTP round trip to
    // ourselves and, more to the point, cannot be redirected anywhere.
    const id = url.split("/").pop() ?? "";
    const stored = id ? store.get(id) : null;
    if (!stored) continue;
    // The message this file came in, for its delivery record. Media
    // descriptors run parallel to `media_urls`.
    const messageId = combined.media?.[index]?.message_id ?? combined.message_id;
    out.push({
      bytes: new Uint8Array(stored.bytes),
      mime: stored.mime,
      ...(stored.filename ? { filename: stored.filename } : {}),
      ...(messageId ? { messageId } : {}),
    });
  }
  return out;
}

/**
 * Read what was uploaded, say what it said, and ask only for what is left.
 *
 * The shape of this is the product requirement, in order: acknowledge
 * immediately (reading takes about ninety seconds and silence for that long
 * reads as broken), read, report back what was taken so it can be corrected,
 * then carry on with the questions the document could not answer.
 *
 * EACH FILE IS ITS OWN DOCUMENT. It is registered once per trip by its content,
 * its bytes are kept, and it is read and extracted on its own — so a re-sent
 * confirmation costs no model call, a retry resumes rather than re-paying, and
 * every answer can be traced to the file that supplied it. What the files say
 * is then decided TOGETHER, by one gate: each proposal must quote the file it
 * came from, and several files' slices of one structured answer merge exactly as
 * they did when the files were read as one string. That is what keeps five
 * uploads describing one trip from becoming five competing sets of phases — the
 * reason the files were once joined in the first place.
 *
 * Every extracted answer still goes through `applyProposals` and
 * `validateAnswer` exactly like a typed one. A document is not a privileged
 * source.
 */
async function runDocumentPath(
  deps: TripBotPollerDeps,
  burst: { sessionId: string; chatId: string },
  documents: BurstDocument[],
  language: Language,
  log: (line: string) => void,
  interpretationId: string,
  tripId: string | null,
): Promise<void> {
  const strings = deps.strings ?? DEFAULT_STRINGS;
  const say = async (text: string) => {
    await deps.telegram.sendMessage({ chatId: burst.chatId, text }).catch(() => {});
  };
  const ask = async () => {
    const after = await getSessionForChat(deps.db, burst.chatId);
    if (after.ok) await sendNextStep(after.view, burst.chatId, deps, strings);
  };
  // The interpretation row claimed for this burst is closed on EVERY exit. The
  // document branch used to return without committing it, so a redelivered
  // upload found an open row and paid for the model call again.
  const commit: CommitDocumentBurst = async ({ outcomes = {}, failureReason = null, proposals = [], durationMs = 0 }) => {
    await recordInterpretationResult(deps.db, interpretationId, { proposals, failureReason, attempts: 0, durationMs });
    await markInterpretationCommitted(deps.db, interpretationId, outcomes);
  };

  // The acknowledgement was already sent, the instant the file landed — see
  // `interview_to_gateway` in `applyDecision`. Sending it again here is what
  // produced the same sentence twice on 2026-09-09.

  if (!tripId) {
    await commit({ failureReason: "NO_SESSION" });
    await ask();
    return;
  }

  const { registered, identity, unreadable } = await ingestBurstDocuments(deps, burst, tripId, documents, log);

  // Said whenever one arrived, even alongside readable files — someone who
  // sent a passport should be told it was left unread, not have it silently
  // disappear into a batch.
  if (identity > 0) await say(uiString("documentIdentity", language));

  if (registered.length === 0) {
    if (identity === 0) await say(uiString(unreadable > 0 ? "documentUnreadable" : "documentNothing", language));
    await commit({ failureReason: "NO_READABLE_DOCUMENT" });
    await ask();
    return;
  }

  // Said before the recap: what follows is built from part of a file, and an
  // organizer reading the recap would otherwise take anything missing from it
  // as not being in the file at all.
  if (registered.some(readPartially)) await say(uiString("documentPartial", language));

  // KEEP IT. The relay's media store is in-memory with a TTL, so once the
  // extraction has run the document is gone — and a confirmed intake built from
  // a four-page itinerary carried `source_document: null`, with no way to ask
  // later where any of it came from, or to re-extract when the extractor gets
  // better. The agent path has always staged it; the interpret path never did.
  // `confirmIntakeVia` still falls back to it until the registry migration
  // lands (docs/test-reports/slice-b-step6-handoff-2026-09-21.md §3).
  void saveSourceDocumentForChat(
    deps.db, burst.chatId, registered.map((d) => d.text).join("\n\n"), registered[0]?.filename ?? undefined,
  ).catch(() => { /* best-effort, exactly like the agent path's */ });

  if (!deps.modelRunner) {
    await say(uiString("documentNothing", language));
    await commit({ failureReason: "NOT_CONFIGURED" });
    await ask();
    return;
  }

  await markReadingDocument(deps.db, burst.chatId, true);
  try {
    await readDocumentsInto(deps, deps.modelRunner, burst, tripId, registered, language, say, commit, log);
  } finally {
    // THE NEXT QUESTION, NOW — after the flag is down, not before. `ask` used to
    // be a closure `readDocumentsInto` called at each of its own exits, all of
    // them still inside this `try` — so `sendNextStep`'s `isReadingDocument`
    // check (a DB-persisted flag, not cleared until this `finally` runs) held
    // every one of those calls and sent nothing. The organizer got the recap and
    // then silence until a later poll tick happened to notice the next question
    // was due — a weaker form of the exact 51-seconds-of-silence incident
    // (2026-09-16) this flag/ask ordering exists to prevent. Found by `consult`
    // review during the #145 forward-port, 2026-09-21, before this landed.
    await markReadingDocument(deps.db, burst.chatId, false);
  }
  await ask();
}

type CommitDocumentBurst = (result: {
  outcomes?: StoredOutcomes;
  failureReason?: string | null;
  proposals?: ProposedAnswer[];
  durationMs?: number;
}) => Promise<void>;

/** A burst attachment, out of the relay's media store. */
interface BurstDocument {
  bytes: Uint8Array;
  mime: string;
  filename?: string;
  /** The message it arrived in — its delivery identity. */
  messageId?: string;
}

/** One delivery of one file, identified within its channel. */
function deliveryRef(chatId: string, messageId: string | undefined): string {
  return `chat:${chatId}:msg:${messageId ?? "unknown"}`;
}

function readPartially(doc: RegisteredDocument): boolean {
  return doc.truncated || doc.coverage.some((unit) => !unit.usable || unit.cut === true);
}

/**
 * Registers every file in a burst: refuses identity documents, keeps the bytes
 * of what it can read, and records each delivery. No model call — which is why
 * it is also safe to run on a burst that was already interpreted.
 */
async function ingestBurstDocuments(
  deps: TripBotPollerDeps,
  burst: { sessionId: string; chatId: string },
  tripId: string,
  documents: BurstDocument[],
  log: (line: string) => void,
  // 'approved' during the interview, where the organizer's own answers are
  // written as they go; 'pending' after confirmation, where a document only
  // proposes and the organizer decides.
  reviewStatus: "approved" | "pending" = "approved",
): Promise<{ registered: RegisteredDocument[]; identity: number; unreadable: number }> {
  const registered: RegisteredDocument[] = [];
  let identity = 0;
  let unreadable = 0;
  for (const doc of documents) {
    const outcome = await ingestDocument(
      {
        db: deps.db,
        store: deps.documentStore,
        tripId,
        provider: "telegram",
        reviewStatus,
        // Photos and scans are read through the relay's own runner, so the super
        // admin's `read_image` choice applies here like every other task's.
        ...(deps.modelRunner ? { vision: deps.modelRunner } : {}),
        log,
      },
      {
        bytes: doc.bytes,
        mime: doc.mime,
        ...(doc.filename ? { filename: doc.filename } : {}),
        sourceRef: deliveryRef(burst.chatId, doc.messageId),
      },
    );
    if (outcome.kind === "registered") {
      const read = outcome.document;
      registered.push(read);
      log(structuredLog("info", "interview.document_read", {
        session_id: burst.sessionId,
        document_id: read.documentId,
        pages: read.pages,
        chars: read.text.length,
        truncated: read.truncated,
        unread_units: read.coverage.filter((unit) => !unit.usable || unit.cut === true).length,
        stored: read.stored,
        duplicate: read.duplicateContent,
      }));
    } else if (outcome.kind === "refused") {
      // Not a failure and not logged as one: refusing a passport is the
      // system working. No detail either — there is nothing about it worth
      // recording beyond that one arrived and was left alone.
      identity += 1;
      log(structuredLog("info", "interview.document_identity_refused", { session_id: burst.sessionId }));
    } else {
      unreadable += 1;
      log(structuredLog("warn", "interview.document_unreadable", {
        session_id: burst.sessionId,
        reason: outcome.reason,
        detail: outcome.detail,
      }));
    }
  }
  // The same file attached twice in one burst is one document, read once.
  const unique = [...new Map(registered.map((doc) => [doc.documentId, doc])).values()];
  return { registered: unique, identity, unreadable };
}

/** How many times a document write is re-gated after the answers changed underneath it. */
const DOCUMENT_WRITE_ATTEMPTS = 3;

/**
 * What each document's claims became, recorded beside the answers (0053), and
 * every disagreement opened as a question for the organizer. Returns how many
 * disagreements are newly open.
 *
 * Attributed per document and per entry: a document is recorded against the
 * entries ITS OWN surviving proposals described, so a voucher is linked to the
 * stay it confirms and not to every stop on the trip. Best-effort — the answers
 * are already written, and a lost provenance row must not undo them.
 */
async function recordDocumentOutcomes(
  deps: TripBotPollerDeps,
  tripId: string,
  gated: DocumentGateResult,
  usable: readonly { documentId: string; payload: InterpretPayload }[],
  recorded: ReadonlySet<string>,
  log: (line: string) => void,
): Promise<number> {
  const { decisions } = gated;
  const readFrom = new Map<unknown, string>();
  for (const reading of usable) for (const proposal of reading.payload.proposals) readFrom.set(proposal, reading.documentId);
  const refused = new Set<unknown>(decisions.rejected.map((r) => r.proposal));
  const rows: AnswerSource[] = [];
  const entriesOf = (value: ProposedValue): unknown[] | null =>
    value.kind === "structured" && Array.isArray(value.data) ? value.data : null;

  for (const accepted of decisions.accepted) {
    if (!recorded.has(accepted.questionId)) continue;
    const changes = accepted.reconciled;
    const heldAnswer = changes?.held as { data?: unknown } | undefined;
    const heldEntries = Array.isArray(heldAnswer?.data) ? heldAnswer.data : [];
    const added = new Set(changes?.added.map((c) => c.entryKey));
    const filled = new Map<string, string[]>();
    for (const change of changes?.filled ?? []) {
      filled.set(change.entryKey, [...(filled.get(change.entryKey) ?? []), change.path]);
    }

    for (const reading of usable) {
      const own = reading.payload.proposals.filter(
        (p) => p.questionId === accepted.questionId && gated.documentOf(p) === reading.documentId && !refused.has(p),
      );
      for (const proposal of own) {
        const entries = entriesOf(proposal.value);
        if (!entries) {
          rows.push({
            tripId, questionId: accepted.questionId, entryKey: "", documentId: reading.documentId,
            disposition: changes ? "filled" : "accepted",
          });
          continue;
        }
        for (const entry of entries) {
          // The key of the HELD entry this one merged into, where it did — a
          // fill can change an entry's identity (a reference is added), and the
          // change was recorded under the entry as it was held.
          let key = entryIdentity(entry);
          if (changes && isRecordValue(entry)) {
            const match = matchEntry(heldEntries, heldEntries.length, entry);
            if (match.kind === "match") key = entryIdentity(heldEntries[match.index]);
          }
          const disposition = !changes || added.has(key) ? "accepted" : filled.has(key) ? "filled" : "unchanged";
          rows.push({
            tripId, questionId: accepted.questionId, entryKey: key, documentId: reading.documentId,
            disposition, paths: filled.get(key) ?? [], entrySnapshot: entry,
          });
        }
      }
    }
  }

  for (const rejection of decisions.rejected) {
    const documentId = readFrom.get(rejection.proposal);
    if (!documentId) continue;
    const agreed = rejection.reason === "NO_NEW_INFORMATION" || rejection.reason === "ALREADY_ANSWERED";
    rows.push({
      tripId, questionId: rejection.questionId, entryKey: "", documentId,
      disposition: agreed ? "unchanged" : "rejected",
      reason: agreed ? null : rejection.reason,
    });
  }

  for (const ambiguity of decisions.ambiguous) {
    const documentId = readFrom.get(ambiguity.proposal);
    if (!documentId) continue;
    rows.push({
      tripId, questionId: ambiguity.questionId, entryKey: ambiguity.entryKey, documentId,
      disposition: "ambiguous", entrySnapshot: ambiguity.incoming, reason: `${ambiguity.candidates} candidates`,
    });
  }

  let opened = 0;
  for (const disagreement of decisions.conflicts) {
    const documentId = readFrom.get(disagreement.proposal);
    if (!documentId) continue;
    try {
      const { created } = await openConflict(deps.db, {
        tripId,
        questionId: disagreement.questionId,
        entryKey: disagreement.entryKey,
        path: disagreement.path,
        held: disagreement.held,
        incoming: disagreement.incoming,
        documentId,
      });
      if (created) opened += 1;
      rows.push({
        tripId, questionId: disagreement.questionId, entryKey: disagreement.entryKey, documentId,
        disposition: "conflict", paths: disagreement.path ? [disagreement.path] : [],
      });
    } catch (error) {
      log(structuredLog("warn", "interview.document_conflict_not_opened", {
        question_id: disagreement.questionId,
        detail: String((error as Error)?.message ?? error).slice(0, 200),
      }));
    }
  }

  try {
    await recordAnswerSources(deps.db, rows);
  } catch (error) {
    log(structuredLog("warn", "interview.document_provenance_failed", {
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    }));
  }
  return opened;
}

/** A disputed value, as the organizer should read it. */
function conflictValueText(value: unknown, language: Language): string {
  if (typeof value === "string") return readableDate(value, language) ?? value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecordValue(value)) {
    for (const key of ["text", "other_text", "otherText", "name", "name_en"]) {
      if (typeof value[key] === "string" && (value[key] as string).trim()) return value[key] as string;
    }
    if (typeof value.option_id === "string") return value.option_id;
    if (typeof value.optionId === "string") return value.optionId;
  }
  return JSON.stringify(value);
}

/** The question for one disagreement, with its two answers as buttons. */
async function renderConflictQuestion(
  db: pg.Pool,
  chatId: string,
  conflict: AnswerConflict,
  language: Language,
): Promise<{ text: string; replyMarkup: InlineKeyboard; keepLabel: string; replaceLabel: string }> {
  const question = findQuestion(conflict.questionId);
  const questionLabel = question ? recapLabel(question, language) : "";

  const fieldKey = `conflictField.${conflict.path}`;
  const what = conflict.path === ""
    ? questionLabel || uiString("conflictField.default", language)
    : UI_STRINGS[language]?.[fieldKey] ?? UI_STRINGS[DEFAULT_LANGUAGE][fieldKey] ?? uiString("conflictField.default", language);

  // The entry by the name the organizer knows it by, from the answer as held.
  let entry = questionLabel;
  if (conflict.entryKey) {
    const store = await answersForChat(db, chatId);
    const answer = store?.answers[conflict.questionId] as { data?: unknown } | undefined;
    const found = (Array.isArray(answer?.data) ? answer.data : []).find((e) => entryIdentity(e) === conflict.entryKey);
    if (isRecordValue(found)) {
      const name = [found.name, found.name_en].find((n) => typeof n === "string" && n.trim());
      if (typeof name === "string") entry = name;
    }
  }

  const documents = await listTripDocuments(db, conflict.tripId);
  const documentName = documents.find((d) => d.id === conflict.documentId)?.filename ?? "";
  const fill = (template: string) =>
    template
      .replace("{what}", what)
      .replace("{entry}", entry)
      .replace("{held}", conflictValueText(conflict.held, language))
      .replace("{incoming}", conflictValueText(conflict.incoming, language))
      .replace("{document}", documentName);

  const keepLabel = fill(uiString("documentConflictKeep", language));
  const replaceLabel = fill(uiString("documentConflictReplace", language));
  return {
    text: fill(uiString("documentConflict", language)),
    replyMarkup: {
      inline_keyboard: [
        [{ text: keepLabel, callback_data: conflictCallbackData(conflict.id, "keep") }],
        [{ text: replaceLabel, callback_data: conflictCallbackData(conflict.id, "replace") }],
      ],
    },
    keepLabel,
    replaceLabel,
  };
}

/**
 * Ask the oldest open disagreement, if there is one and it is not already on
 * screen. Returns whether a message was sent.
 */
async function askOpenConflict(view: SessionView, chatId: string, deps: TripBotPollerDeps): Promise<boolean> {
  const conflict = await nextOpenConflict(deps.db, view.tripId);
  if (!conflict) return false;
  const key = `cfl:${conflict.id}`;
  // Already asked and still on screen: its buttons are there to tap. Asking it
  // again would bury the question under copies of itself, and holding back
  // everything else until it is answered would make a disagreement block the
  // interview, which it must never do.
  if (view.lastPrompt === key) return false;
  if (!(await takeFloor(chatId, view, deps))) return false;
  const rendered = await renderConflictQuestion(deps.db, chatId, conflict, view.language);
  // Through `deliverStep`, like the router's other questions (#225 item 9): this
  // recorded `cfl:` AFTER a send whose result it never read, so a refused ask was
  // marked as on screen and never asked again. Delivered, or owed to the step
  // retry - either way this turn is spoken for.
  await deliverStep(view, chatId, deps, key, { text: rendered.text, replyMarkup: rendered.replyMarkup });
  return true;
}

/**
 * What a suggestion's message becomes once its Yes is tapped: the question, and
 * the reading that was recorded (#225 item 7).
 *
 * The label can come from a document, so it is cut - within 3000 UTF-16 units,
 * the unit Telegram's 4096 limit counts, and on WHOLE characters: half an emoji
 * is not valid UTF-8 and Telegram refuses the whole edit. `cutText` counted code
 * points, so 3000 emoji came out at 6000 units and the edit was refused.
 */
export function suggestionConfirmedText(question: IntakeQuestion, label: string | null, language: Language): string {
  return `${askText(question, language)}\n\n✅ ${cutWhole(label ?? "", SUGGESTION_EDIT_LABEL_MAX)}`;
}
const SUGGESTION_EDIT_LABEL_MAX = 3000;

/**
 * A question as the router draws it: with the answer a document suggested for
 * it when there is one that still validates, plainly otherwise. Every place the
 * router asks a question goes through here, so a suggestion is never shown by
 * one path and silently skipped by another.
 */
function renderStep(question: IntakeQuestion, view: SessionView, phrasing?: string | null): RenderedQuestion {
  const suggestion = view.suggestions[question.id];
  const label = suggestion ? suggestionLabel(question.id, suggestion, view.language) : null;
  return label
    ? renderSuggestion(question, label, view.language, phrasing)
    : renderQuestion(question, selectedOptionIds(view, question.id), view.language, phrasing, fromRecord(view, question.id));
}

/**
 * What the record adds to a question: roster buttons, what the question is about
 * right now, and an answer on record that did not settle it.
 */
function fromRecord(
  view: SessionView, questionId: string,
): { choices?: RosterChoice[]; unsettled?: string; subject?: string } {
  const subject = view.subjects?.[questionId];
  const from = subject ? findQuestion(subject.fromQuestion) : null;
  return {
    choices: view.choices?.[questionId],
    unsettled: view.unsettled?.[questionId],
    subject: from && subject ? optionLabel(from, subject.optionId, view.language) : undefined,
  };
}

/**
 * The read itself — everything that must happen before the router speaks.
 *
 * Deliberately does not ask the next question itself: every exit here runs
 * while the caller still holds `markReadingDocument`, and asking from inside
 * that window is exactly what silently swallowed the question — see the
 * comment at this function's one call site.
 */
async function readDocumentsInto(
  deps: TripBotPollerDeps,
  runner: StructuredModelRunner,
  burst: { chatId: string; sessionId: string },
  tripId: string,
  documents: RegisteredDocument[],
  language: Language,
  say: (text: string) => Promise<void>,
  commit: CommitDocumentBurst,
  log: (line: string) => void,
): Promise<void> {
  const started = Date.now();
  const extracted = await extractRegisteredDocuments(
    { db: deps.db, runner, tripId, language, timeoutMs: DOCUMENT_EXTRACT_TIMEOUT_MS, log },
    documents,
  );
  const usable = extracted.flatMap((e) => (e.kind === "ok" ? [e] : []));
  const failures = extracted.flatMap((e) => (e.kind === "failed" ? [e] : []));
  for (const failure of failures) {
    log(structuredLog("warn", "interview.document_extract_failed", {
      session_id: burst.sessionId,
      document_id: failure.documentId,
      reason: failure.reason,
      // The detail was already being carried and thrown away, which made the
      // first live BAD_OUTPUT unexplainable. Truncated, and it is model output
      // about a document the organizer chose to share — enough to diagnose the
      // shape, not a copy of their booking.
      detail: (failure.detail ?? "").slice(0, 300),
    }));
  }

  if (usable.length === 0) {
    await say(uiString("documentExtractFailed", language));
    await commit({ failureReason: failures[0]?.reason ?? "FAILED", durationMs: Date.now() - started });
    return;
  }

  // THE GATE AND THE WRITE, against the answers held NOW — not when the burst
  // arrived. Extraction takes minutes, and an organizer who corrected an answer
  // in the meantime, or another document that landed first, is exactly what a
  // minutes-old view would overwrite. Each write carries the answer it was
  // merged against; a write refused as stale sends the whole gate round again
  // on what is there now.
  const readings = usable.map((e) => ({ documentId: e.documentId, text: e.text, payload: e.payload }));
  const recordedSet = new Set<string>();
  let gated: DocumentGateResult | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const [store, state] = await Promise.all([
      answersForChat(deps.db, burst.chatId),
      questionStateForChat(deps.db, burst.chatId),
    ]);
    if (!store || !state) {
      await commit({ failureReason: "SESSION_CLOSED", durationMs: Date.now() - started });
      return;
    }
    gated = gateDocumentProposals(readings, {
      outstanding: state.outstanding,
      answered: state.answered,
      held: store.answers,
    });

    let stale = false;
    for (const accepted of gated.decisions.accepted) {
      const args = submitArgsFor(accepted.proposal.value);
      const written = await submitAnswerForChat(
        deps.db, burst.chatId, accepted.questionId,
        args.optionId, args.otherText, args.structuredData, args.optionIds,
        // Unanswered when gated is a precondition too: an answer given by hand
        // since then is merged into, not written over.
        { held: accepted.reconciled ? accepted.reconciled.held : store.answers[accepted.questionId] },
      );
      if (written.ok) recordedSet.add(accepted.questionId);
      else if (written.reason === "STALE_ANSWER") {
        stale = true;
        break;
      } else {
        log(structuredLog("warn", "interview.document_write_refused", {
          session_id: burst.sessionId,
          question_id: accepted.questionId,
          reason: written.reason,
        }));
      }
    }
    if (!stale) break;
    log(structuredLog("info", "interview.document_write_stale", { session_id: burst.sessionId, attempt }));
    if (attempt >= DOCUMENT_WRITE_ATTEMPTS) {
      log(structuredLog("warn", "interview.document_write_gave_up", { session_id: burst.sessionId, attempts: attempt }));
      break;
    }
  }
  const { decisions, sources } = gated!;
  const recorded = [...recordedSet];
  const conflictsOpened = await recordDocumentOutcomes(deps, tripId, gated!, usable, recordedSet, log);

  const proposed = usable.flatMap((e) => e.payload.proposals);
  const malformed = usable.reduce((n, e) => n + (e.payload.malformed ?? 0), 0);

  // UNSURE READINGS, kept to be asked about instead of lost. The gate refused
  // them for confidence alone; the organizer decides with one tap when the
  // question comes up. Only for questions this read did not just answer.
  const suggestions: Record<string, SuggestedAnswer> = {};
  for (const unsureRead of decisions.suggested) {
    if (recorded.includes(unsureRead.questionId)) continue;
    const args = submitArgsFor(unsureRead.proposal.value);
    suggestions[unsureRead.questionId] = {
      optionId: args.optionId,
      ...(args.otherText !== undefined ? { otherText: args.otherText } : {}),
      ...(args.structuredData !== undefined ? { structuredData: args.structuredData } : {}),
      ...(args.optionIds ? { optionIds: [...args.optionIds] } : {}),
    };
  }
  const unsure = Object.keys(suggestions);
  if (unsure.length > 0) await saveSuggestionsForChat(deps.db, burst.chatId, suggestions);

  log(structuredLog("info", "interview.document_committed", {
    session_id: burst.sessionId,
    documents: documents.length,
    // Served from a stored reading rather than a model call — a re-sent file,
    // or a retry after a crash.
    reused: usable.filter((e) => e.reused).length,
    failed: failures.length,
    // PROPOSED vs ACCEPTED, and MALFORMED alongside both. On 2026-09-10 a real
    // booking PDF committed `accepted: 0, rejected: 0`, and those two numbers
    // could not tell "the model proposed nothing" from "nothing it proposed
    // survived parsing".
    proposed: proposed.length,
    malformed,
    accepted: decisions.accepted.length,
    // An answer assembled from several proposals for one question — the case
    // that, before merging, silently dropped a document's attractions.
    merged: decisions.accepted.filter((a) => a.mergedFrom).length,
    rejected: decisions.rejected.length,
    reasons: decisions.rejected.map((r) => r.reason),
    // WHICH question was refused, not only how many and why — a live diagnosis
    // on 2026-09-12 needed exactly this.
    rejected_questions: decisions.rejected.map((r) => `${r.questionId}:${r.reason}`),
    // How many documents each accepted answer was drawn from.
    sources: [...sources].map(([questionId, ids]) => `${questionId}:${ids.length}`),
    // Disagreements kept rather than decided, and entries that could not be
    // placed. Counts only — the values are the organizer's to see, in their
    // own chat, not a log's.
    conflicts: decisions.conflicts.length,
    conflicts_opened: conflictsOpened,
    ambiguous: decisions.ambiguous.length,
    suggested: unsure,
    ms: Date.now() - started,
  }));
  await commit({
    outcomes: storedOutcomes(decisions, malformed),
    proposals: proposed,
    durationMs: Date.now() - started,
  });

  if (recorded.length === 0) {
    // Nothing new — for one of three reasons that must not be confused: every
    // file is one already read, a read failed, or the files genuinely say
    // nothing the interview still needs. And two that are not "nothing" at all:
    // the files disagree with what is held, which the question that follows
    // says far better than any of these sentences would; or they said things
    // the reader was unsure of, which are checked with the organizer instead.
    if (conflictsOpened === 0) {
      const alreadyRead = failures.length === 0 && usable.every((e) => e.reused);
      // The file was read and AGREES with what is held — a second copy of the
      // itinerary, a voucher for a stay already recorded. Telling the organizer
      // "I couldn't find anything about the trip" about a booking that confirms
      // the trip was the reply on 2026-09-13's acceptance run.
      const agreed = proposed.length > 0 &&
        decisions.rejected.some((r) => r.reason === "NO_NEW_INFORMATION" || r.reason === "ALREADY_ANSWERED");
      await say(uiString(
        alreadyRead ? "documentAlreadyRead"
          : failures.length > 0 ? "documentExtractFailed"
          // "Found nothing" would be untrue when it found things it was unsure of.
          : unsure.length > 0 ? "documentUnsure"
          : agreed ? "documentNothingNew"
          : "documentNothing",
        language,
      ));
    }
    return;
  }

  // WHAT IT TOOK, in the organizer's own recap format, so they can correct it.
  // An answer they never gave and cannot see is worse than being asked twice.
  const view = await getSessionForChat(deps.db, burst.chatId);
  if (view.ok) {
    const answers = await answersForChat(deps.db, burst.chatId);
    const lines = buildRecap(answers?.answers ?? {}, INTAKE_QUESTIONS, language)
      .filter((entry) => recorded.includes(entry.questionId))
      .map((entry) => `• ${entry.prompt}: ${entry.answerLabel}`);
    // THE PLANNED PLACES, shown explicitly.
    //
    // They live inside `phases[].planned`, and the recap renders a phase by its
    // NAME — so "Tokyo, Hakone, Kyoto" appeared and TeamLab, Skytree and the
    // rest were invisible. They had been extracted correctly; the organizer
    // reasonably read their absence as the document not having been understood,
    // which is the one thing this message exists to prevent.
    const planned: string[] = [];
    for (const entry of (answers?.answers.phases as { data?: unknown } | undefined)?.data as
      | { planned?: unknown }[]
      | undefined ?? []) {
      for (const place of Array.isArray(entry?.planned) ? entry.planned : []) {
        if (typeof place === "string" && place.trim()) planned.push(place.trim());
      }
    }
    const unique = [...new Set(planned)];
    if (unique.length > 0) {
      const shown = unique.slice(0, 12).join(", ");
      lines.push(`• ${uiString("documentPlanned", language)}: ${shown}${unique.length > 12 ? ` +${unique.length - 12}` : ""}`);
    }

    if (unsure.length > 0) {
      const checking = buildRecap(
        Object.fromEntries(decisions.suggested.filter((x) => unsure.includes(x.questionId)).map((x) => [x.questionId, x.answer])),
        INTAKE_QUESTIONS,
        language,
      ).map((entry) => entry.prompt);
      if (checking.length > 0) lines.push(`• ${uiString("documentWillCheck", language)}: ${checking.join(", ")}`);
    }

    if (lines.length > 0) {
      await say(`${uiString("documentRead", language)}\n\n${lines.join("\n")}\n\n${uiString("documentCorrect", language)}`);
    }
  }

  // IN THE BACKGROUND, AND DELIBERATELY NOT AWAITED. It is a second model call
  // taking up to minutes, and this runs inside the relay's one delivery loop:
  // awaited, it held every chat's next message — including this organizer's
  // answer to the question the caller is about to ask, live on 2026-09-16. It
  // fills in `phases`, which is already answered, so nothing the interview asks
  // depends on it; and it refuses to write over stops that changed while it ran
  // (foldItineraryFromDocument). Before the recap it once left an organizer
  // watching nothing for seven minutes (2026-09-12). Triggering it here rather
  // than waiting for the caller costs nothing — `void` returns control
  // immediately either way — and the caller's `ask()`, once the reading flag is
  // down, is what actually matters for latency, not this line's position.
  void foldItineraryFromDocument(deps, burst, usable.map((e) => e.text).join("\n\n"), log, say, language).catch(() => {
    log(structuredLog("warn", "interview.itinerary_extract_threw", { session_id: burst.sessionId }));
  });
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
// ── A typed change to held stops or travellers (#206) ────────────────────────
//
// The organizer types "actually Tokyo is 20 to 25". The interpreter returns
// operations, the store keeps ONE draft per session, and the organizer is SHOWN
// what would change — and what would not — before anything is written. The
// stored result is what is applied; the model is never asked again.

/** The questions whose held answer a typed message can change only through that flow. */
const CHANGE_QUESTIONS: readonly string[] = ["phases", "travelers"];

/**
 * The preview message last sent for each draft, so a later one (a follow-up
 * merged into the draft, a stale confirmation rebuilt) can take the buttons off
 * it: an old Yes would otherwise apply a change the person is no longer looking
 * at. In memory, and best effort — a relay restart forgets it, and the apply is
 * still refused when the answer moved (`STALE`), never applied blind.
 */
const shownPreviews = new Map<string, string>();

/** Test seam: what a relay restart does to the in-memory map above. Nothing depends on it being kept. */
export function forgetShownPreviewsForTests(): void {
  shownPreviews.clear();
}

/** The `lastPrompt` that says "this exact version of this draft is on the organizer's screen". */
export function changePromptKey(draft: Pick<Draft, "id" | "ops" | "result" | "unresolved" | "blocked" | "preview">): string {
  return `pc:${draft.id}:${draftDigest(draft)}`;
}

/** The digest in a `pc:<id>[:<digest>]` prompt key, or null. */
function promptDigest(lastPrompt: string | null | undefined, draftId: string): string | null {
  const m = new RegExp(`^pc:${draftId}:([0-9a-f]{8})$`).exec(lastPrompt ?? "");
  return m?.[1] ?? null;
}

/**
 * Puts the draft in front of the organizer: the preview with Yes and No, or the
 * question it is asking, or the conflict it found. Records `pc:<id>` as the
 * prompt on screen — which is what lets a typed "yes" mean THIS change and
 * nothing else, and what makes `boundaryOnScreen` and `onScreen` null while it
 * is up.
 *
 * Says what happened: `shown`, `no_floor` (someone else is speaking; nothing was
 * attempted), `send_failed` (Telegram did not take it THIS time - a rate limit,
 * a 5xx, the network; the organizer has seen nothing, and the same message may
 * go through later) or `refused` (Telegram refused this content for good: a
 * `Bad Request`, which it will repeat). A transient failure is always announced
 * with `change.sendFailed`, because the change keeps waiting and "yes" or "no"
 * shows it again. With `tellOnFailure: false` a permanent refusal is not - the
 * caller has something truer to say (`dropUnshowable`).
 *
 * A preview that goes out over a prompt the draft does not already name as
 * displaced records that prompt (#225): it is what the preview covers, and what
 * has to come back when the change is settled.
 */
type ShowOutcome = "shown" | "no_floor" | "send_failed" | "refused";
async function showChangeDraft(
  deps: TripBotPollerDeps,
  chatId: string,
  view: SessionView,
  draft: Draft,
  lead?: string,
  options: { tellOnFailure?: boolean } = {},
): Promise<ShowOutcome> {
  const rendered = renderDraft(draft, view.language);
  if (!(await takeFloor(chatId, view, deps))) return "no_floor";
  // Read now, with the floor held, not from `view`: another speaker may have put
  // something on screen since `view` was built - on the retake in
  // `showProposedChange` it always has.
  const covering = await getSessionForChat(deps.db, chatId);
  const covered = covering.ok ? covering.view.lastPrompt ?? "" : "";
  const previous = shownPreviews.get(draft.id);
  const sent = await deps.telegram.sendMessage({
    chatId,
    text: lead ? `${lead}\n\n${rendered.text}` : rendered.text,
    replyMarkup: rendered.replyMarkup,
  }).catch(() => undefined) as { ok?: boolean; messageId?: string; permanent?: boolean } | undefined;
  if (!sent?.ok) {
    // A refused send returns `ok: false` and does not throw (a throw is caught
    // above and counts as transient). The organizer has seen NOTHING, so
    // nothing may be confirmable by a typed "yes": `lastPrompt` is left as it
    // was, and it names an older version's digest, which matches no current one.
    const permanent = isPermanentRefusal(sent as { ok: boolean; permanent?: boolean } | undefined);
    (deps.log ?? (() => {}))(structuredLog("warn", "interview.change_show_failed", { session_id: view.sessionId, draft_id: draft.id, permanent }));
    if (!permanent || options.tellOnFailure !== false) {
      await deps.telegram
        .sendMessage({ chatId, text: uiString("change.sendFailed", view.language) })
        .catch(() => undefined);
    }
    return permanent ? "refused" : "send_failed";
  }
  // SOMETHING MAY HAVE BEEN SAID WHILE THIS WAS IN FLIGHT. The send is a round
  // trip to Telegram - up to RETRY_AFTER_CAP_SECONDS longer when a 429 is waited
  // out - and the floor is a flag, not a lease: a tap's next step (the boundary
  // offer, sent ONCE) can take it and record itself in that window. The `pc:`
  // key below then goes over it, so it is what this preview covers and has to
  // come back when the change is settled (#225 round 2). A non-`pc:` prompt that
  // differs from the one read before the send was said during it; anything else
  // (unchanged, cleared, another preview) leaves `covered` as it was. What
  // remains is the few DB round trips between this read and the `pc:` record.
  //
  // A read that fails degrades to `covered` (#225 F-b): the preview HAS been
  // delivered, and a throw here left it unrecorded - no `pc:` key, so a typed
  // "yes" could not confirm what the organizer was looking at.
  const landed = await getSessionForChat(deps.db, chatId).catch(() => ({ ok: false as const }));
  const during = landed.ok ? landed.view.lastPrompt ?? "" : "";
  const displaced = during && !during.startsWith("pc:") && during !== covered ? during : covered;
  if (displaced && !displaced.startsWith("pc:") && displaced !== draft.displacedPrompt) {
    await recordDisplacedPrompt(deps.db, { draftId: draft.id, sessionId: view.sessionId, prompt: displaced });
    (deps.log ?? (() => {}))(structuredLog("info", "interview.change_displaced_moved", {
      // The key's first two parts only: a question key can carry an unsettled answer's text after them.
      session_id: view.sessionId, draft_id: draft.id, displaced: displaced.split(":").slice(0, 2).join(":"),
      during_send: displaced !== covered,
    }));
  }
  // Recorded only now that it was delivered, and carrying the digest: a typed
  // "yes" confirms exactly the version whose preview went out.
  await recordLastPromptForChat(deps.db, chatId, changePromptKey(draft));
  if (sent.messageId) shownPreviews.set(draft.id, sent.messageId);
  if (previous && previous !== sent?.messageId) {
    await deps.telegram
      .editMessageText({ chatId, messageId: previous, text: rendered.text, replyMarkup: undefined })
      .catch(() => {});
  }
  (deps.log ?? (() => {}))(structuredLog("info", "interview.change_shown", {
    session_id: view.sessionId,
    draft_id: draft.id,
    confirmable: confirmable(draft),
  }));
  return "shown";
}

/**
 * THE WAY OUT when showing a waiting change was the only thing left to do and
 * Telegram refused it FOR GOOD (a `Bad Request` - `reshowDraft` calls this only
 * for `refused`; a rate limit or an outage keeps the change waiting, #225: it may
 * be one the organizer has already seen). The draft is cancelled - Cancel applies nothing, so it is
 * always safe - the organizer is told so plainly, in the interview's language,
 * and the interview is put back. Without this, a draft whose preview Telegram
 * rejects on every attempt has no button on screen, a typed "no" only tries the
 * send again, and Confirm stays blocked for good.
 */
async function dropUnshowable(
  deps: TripBotPollerDeps,
  chatId: string,
  view: SessionView,
  draft: Pick<Draft, "id" | "displacedPrompt">,
  strings: DispatchStrings,
): Promise<void> {
  const cancelled = await cancelDraft(deps.db, { draftId: draft.id, sessionId: view.sessionId, by: "system" });
  shownPreviews.delete(draft.id);
  if (!cancelled) return; // settled in the meantime: nothing is waiting any more
  (deps.log ?? (() => {}))(structuredLog("warn", "interview.change_dropped_unshowable", { session_id: view.sessionId, draft_id: draft.id }));
  await deps.telegram.sendMessage({ chatId, text: uiString("change.droppedUnshown", view.language) }).catch(() => undefined);
  await resumeAfterChange(deps, chatId, strings, draft.displacedPrompt);
}

/**
 * The interview, put back after a change resolved: what it displaced comes back,
 * or the next step goes out.
 *
 * WHAT IS ON SCREEN NOW wins over what the change once displaced. When the last
 * prompt recorded is not a change preview, something was said AFTER the preview
 * - a tap's next step that raced a follow-up (#225), a summary asked for from the
 * old offer's own button - and that, not the older prompt under the preview, is
 * what the organizer is looking at and what comes back.
 */
async function resumeAfterChange(
  deps: TripBotPollerDeps,
  chatId: string,
  strings: DispatchStrings,
  displacedByChange: string | null,
): Promise<void> {
  const before = await getSessionForChat(deps.db, chatId);
  const onScreen = before.ok ? before.view.lastPrompt ?? "" : "";
  const displaced = onScreen && !onScreen.startsWith("pc:") ? onScreen : displacedByChange;
  await recordLastPromptForChat(deps.db, chatId, "");
  const now = await getSessionForChat(deps.db, chatId);
  if (!now.ok) return;
  // The optional offer is sent ONCE (`sendOptionalOffer`), so once a change has
  // covered it nothing would put it back — and the interview would go silent.
  if (displaced === OPTIONAL_OFFER_PROMPT || displaced?.startsWith(`${BOUNDARY_CONFIRM_PROMPT}:`)) {
    await markAwaitingMachine(deps.db, chatId);
    const fresh = await getSessionForChat(deps.db, chatId);
    if (fresh.ok && (await sendOptionalOffer(fresh.view, chatId, deps))) return;
  }
  await markAwaitingMachine(deps.db, chatId);
  const fresh = await getSessionForChat(deps.db, chatId);
  if (fresh.ok) await sendNextStep(fresh.view, chatId, deps, strings);
}

/**
 * Shows the CURRENT version of a waiting draft again, recomputed against what is
 * held now (which also refreshes the warnings, computed from other answers). A
 * draft that has become too big to show is dropped, out loud, and the interview
 * put back: it must never be left waiting where no button on screen can settle it.
 *
 * `dropIfUnsent`: this re-show is the organizer's only way forward (a typed "no"
 * to a version they never saw, Confirm blocked by the change) - if Telegram
 * refuses it FOR GOOD, the draft is dropped out loud (`dropUnshowable`) rather
 * than left waiting behind a preview that will never go out. A transient failure
 * (a rate limit, a 5xx, the network) drops nothing: the change stays waiting and
 * `change.sendFailed` says so - dropping it would cancel a change the organizer
 * may already have seen, because Telegram was busy for a second (#225).
 */
async function reshowDraft(
  deps: TripBotPollerDeps,
  chatId: string,
  view: SessionView,
  draft: Pick<Draft, "id" | "displacedPrompt">,
  strings: DispatchStrings,
  lead?: string,
  options: { dropIfUnsent?: boolean } = {},
): Promise<void> {
  const say = (text: string) => deps.telegram.sendMessage({ chatId, text }).catch(() => undefined);
  const rebuilt = await rebuildDraft(deps.db, { draftId: draft.id, sessionId: view.sessionId });
  if (rebuilt === "too_big") {
    await say(uiString("change.droppedTooBig", view.language));
    shownPreviews.delete(draft.id);
    await resumeAfterChange(deps, chatId, strings, draft.displacedPrompt);
    return;
  }
  if (!rebuilt) {
    await say(uiString("change.gone", view.language));
    return;
  }
  const shown = await showChangeDraft(deps, chatId, view, rebuilt, lead, { tellOnFailure: !options.dropIfUnsent });
  if (shown === "refused" && options.dropIfUnsent) await dropUnshowable(deps, chatId, view, rebuilt, strings);
}

/**
 * Applies or cancels the session's waiting change — from a tap or from a typed
 * yes or no, which are the same act — says what happened, and puts the interview
 * back. A draft that is not this session's, or is no longer waiting, is answered
 * and never applied.
 */
async function settleChange(
  deps: TripBotPollerDeps,
  args: {
    chatId: string;
    draftId: string;
    choice: "apply" | "cancel";
    messageId?: string;
    /** The version the person confirmed. `undefined`: the caller just read the draft itself. `null`: a button from before digests. */
    digest?: string | null;
  },
  strings: DispatchStrings,
  log: (line: string) => void,
): Promise<void> {
  const say = (text: string) => deps.telegram.sendMessage({ chatId: args.chatId, text }).catch(() => undefined);
  const session = await getSessionForChat(deps.db, args.chatId);
  if (!session.ok) {
    await say(uiString("change.gone", DEFAULT_LANGUAGE));
    return;
  }
  const view = session.view;
  const language = view.language;
  const draft = await getDraft(deps.db, args.draftId);
  if (!draft || draft.sessionId !== view.sessionId) {
    log(structuredLog("warn", "interview.change_refused", { session_id: view.sessionId, reason: "NOT_THIS_SESSIONS" }));
    await say(uiString("change.gone", language));
    return;
  }
  if (draft.status !== "pending") {
    await say(uiString(draft.status === "applied" ? "change.alreadyApplied" : "change.gone", language));
    return;
  }
  // A confirmation of a version that is not the current one applies NOTHING: the
  // current preview is shown instead, with fresh buttons. The same comparison is
  // made again under the row lock at apply, so a merge landing in between is
  // caught there too.
  const showCurrentInstead = () => reshowDraft(deps, args.chatId, view, draft, strings, uiString("change.updated", language));
  // CANCEL needs no digest: cancelling a newer or older version applies nothing,
  // so it is always safe - and it must ALWAYS work, or a change whose buttons are
  // stale could never be got rid of. Only APPLY has to match.
  if (args.choice === "apply" && args.digest !== undefined && args.digest !== draftDigest(draft)) {
    log(structuredLog("info", "interview.change_stale_tap", { session_id: view.sessionId, draft_id: draft.id }));
    await showCurrentInstead();
    return;
  }
  const collapse = async (label: string) => {
    const messageId = args.messageId ?? shownPreviews.get(draft.id);
    if (!messageId) return;
    await deps.telegram
      .editMessageText({ chatId: args.chatId, messageId, text: `${renderDraft(draft, language).text}\n\n${label}`, replyMarkup: undefined })
      .catch(() => {});
  };

  if (args.choice === "cancel") {
    if (!(await cancelDraft(deps.db, { draftId: draft.id, sessionId: view.sessionId, by: "organizer" }))) {
      await say(uiString("change.gone", language));
      return;
    }
    log(structuredLog("info", "interview.change_cancelled", { session_id: view.sessionId, draft_id: draft.id }));
    await collapse(`✖ ${uiString("change.cancelled", language)}`);
    shownPreviews.delete(draft.id);
    await say(uiString("change.cancelled", language));
    await resumeAfterChange(deps, args.chatId, strings, draft.displacedPrompt);
    return;
  }

  const applied = await applyPendingChangeForChat(deps.db, args.chatId, draft.id, args.digest === undefined ? draftDigest(draft) : (args.digest ?? ""));
  if (applied.ok) {
    log(structuredLog("info", "interview.change_applied", {
      session_id: view.sessionId, draft_id: draft.id, questions: applied.questions,
    }));
    await collapse(`✅ ${uiString("change.applied", language)}`);
    shownPreviews.delete(draft.id);
    await say(uiString("change.applied", language));
    await resumeAfterChange(deps, args.chatId, strings, draft.displacedPrompt);
    return;
  }
  log(structuredLog("info", "interview.change_not_applied", { session_id: view.sessionId, draft_id: draft.id, reason: applied.reason }));
  switch (applied.reason) {
    case "STALE": {
      // Nothing was written. The stored operations are recomputed against what is
      // held now and shown again — the old buttons come off first.
      await collapse(`⚠️ ${uiString("change.stale", language)}`);
      shownPreviews.delete(draft.id);
      await reshowDraft(deps, args.chatId, view, draft, strings, uiString("change.stale", language));
      return;
    }
    case "BLOCKED": {
      await showChangeDraft(deps, args.chatId, view, draft, uiString("change.stillBlocked", language));
      return;
    }
    case "UPDATED":
      await showCurrentInstead();
      return;
    case "SESSION_CONFIRMED":
      await say(uiString("change.sessionConfirmed", language));
      return;
    case "ALREADY_APPLIED":
      await say(uiString("change.alreadyApplied", language));
      return;
    case "INVALID":
      await say(uiString("change.blocked.generic", language));
      return;
    default:
      await say(uiString("change.gone", language));
  }
}

/** Reasons a typed proposal for an answered question was refused that the organizer must hear about. */
const ASK_ABOUT_REFUSED: ReadonlySet<string> = new Set([
  "ALREADY_ANSWERED", "LOW_CONFIDENCE", "EVIDENCE_NOT_IN_SOURCE", "CHANGE_NEEDS_CONFIRMATION",
  "DATA_REQUIRED", "DATA_WRONG_SHAPE", "INCOMPLETE_ANSWER", "TEXT_REQUIRED", "TEXT_TOO_LONG",
  "UNKNOWN_OPTION", "CHOICE_REQUIRED", "OPTIONS_REQUIRED", "OTHER_TEXT_REQUIRED", "OTHER_NOT_ALLOWED",
]);

/**
 * Tells the organizer what came of a message's typed operations: the preview of
 * the draft they went into, or - plainly - why there is none. True when a
 * preview was delivered (the caller then stays quiet).
 */
async function announceChange(
  deps: TripBotPollerDeps,
  burst: { sessionId: string; chatId: string },
  made: ProposeResult,
  language: Language,
  log: (line: string) => void,
): Promise<boolean> {
  if (made.kind === "no_session") return false;
  const now = await getSessionForChat(deps.db, burst.chatId);
  if (!now.ok) {
    // A confirmed interview has no live session view, and that is exactly the
    // case that must still be told: the change was typed while Confirm landed.
    if (made.kind !== "confirmed") return false;
    log(structuredLog("info", "interview.change_refused", { session_id: burst.sessionId, reason: "SESSION_CONFIRMED" }));
    await deps.telegram.sendMessage({ chatId: burst.chatId, text: uiString("change.sessionConfirmed", language) }).catch(() => undefined);
    return true;
  }
  // Each of these answers THIS message, so it is never lost to the floor (#225).
  const tell = async (text: string) => {
    await answerThisMessage(deps, burst.chatId, now.view, text, log, "change_refused");
    return true;
  };
  switch (made.kind) {
    case "confirmed":
      log(structuredLog("info", "interview.change_refused", { session_id: burst.sessionId, reason: "SESSION_CONFIRMED" }));
      return tell(uiString("change.sessionConfirmed", language));
    case "too_big":
      log(structuredLog("info", "interview.change_refused", { session_id: burst.sessionId, reason: "TOO_BIG", merged: made.merged }));
      return tell(uiString(made.merged ? "change.tooBig" : "change.tooBigFresh", language));
    case "uneditable":
      log(structuredLog("info", "interview.change_refused", { session_id: burst.sessionId, reason: "UNEDITABLE", question: made.question }));
      // "your stops" / "התחנות שלכם": a noun that reads mid-sentence, and a
      // definite one, which Hebrew needs after "את".
      return tell(uiString("change.uneditable", language)
        .replace("{what}", uiString(made.question === "travelers" ? "change.noun.travellers" : "change.noun.stops", language)));
    default: {
      log(structuredLog("info", "interview.change_proposed", {
        session_id: burst.sessionId,
        kind: made.kind,
        confirmable: confirmable(made.draft),
        unresolved: made.draft.unresolved.length,
        blocked: made.draft.blocked.length,
      }));
      if (made.draft.status !== "pending") return false;
      return showProposedChange(deps, burst.chatId, now.view, made.draft, log);
    }
  }
}

/**
 * The preview of a change the organizer just typed - which is never lost to the
 * floor.
 *
 * The floor makes two speakers racing to answer ONE organizer message produce one
 * reply. On the interpret path nobody else answers this message, so a speaker
 * that holds the floor now was answering something ELSE: in practice a tap on
 * the previous preview, whose "Done" and next question took the floor while this
 * message was being read. Losing to it left the new draft waiting with no
 * preview, the organizer's message with no reply, and Confirm blocked - found by
 * the 20-round race test under load (PR #199 round 4): the tap applied v1, then
 * this message's draft lost the floor to the tap's next question, silently. So
 * the floor is taken back, and the preview goes out after that question - two
 * acts, two answers. Unless this exact version is already on screen (a re-show
 * from the tap path got there first), which would only say it twice.
 *
 * What the tap put on screen - its next question, or the boundary offer, which
 * is sent only once - is what this preview now covers; `showChangeDraft` records
 * it on the draft, so settling the change puts it back (#225).
 */
async function showProposedChange(
  deps: TripBotPollerDeps,
  chatId: string,
  view: SessionView,
  draft: Draft,
  log: (line: string) => void,
): Promise<boolean> {
  const first = await showChangeDraft(deps, chatId, view, draft);
  if (first !== "no_floor") return first === "shown";
  const current = await getDraft(deps.db, draft.id);
  const now = await getSessionForChat(deps.db, chatId);
  if (!current || current.status !== "pending" || !now.ok) return false;
  if (now.view.lastPrompt === changePromptKey(current)) return true;
  const again = await retakeFloor(deps, chatId, view.sessionId, log, "change_preview", { draft_id: draft.id });
  return again !== null && (await showChangeDraft(deps, chatId, again, current)) === "shown";
}

/**
 * THE FLOOR, TAKEN BACK - by a reply to the organizer's own message, and only by
 * one (#199 round 4, widened in #225).
 *
 * The floor makes two speakers racing to answer ONE message produce one reply.
 * On the interpret path nobody else answers this message, so whoever holds the
 * floor now was answering something ELSE - in practice a tap whose reply went
 * out while this message was being read. Losing to it would leave the message
 * with no reply at all. So the floor is handed back to the machine and the reply
 * goes out after the tap's: two acts, two answers. The session the caller must
 * speak from is returned; null when there is none any more.
 *
 * Logged as `interview.change_floor_taken_back` whatever the reply is, so one
 * grep after a deploy finds every time it happened.
 */
async function retakeFloor(
  deps: TripBotPollerDeps,
  chatId: string,
  sessionId: string,
  log: (line: string) => void,
  reply: "change_preview" | "change_refused" | "change_not_understood",
  extra: Record<string, string> = {},
): Promise<SessionView | null> {
  log(structuredLog("info", "interview.change_floor_taken_back", { session_id: sessionId, reply, ...extra }));
  await markAwaitingMachine(deps.db, chatId);
  const again = await getSessionForChat(deps.db, chatId);
  return again.ok ? again.view : null;
}

/**
 * Says `text` in answer to THIS message, taking the floor back once if a
 * concurrent tap holds it (`retakeFloor`). False when the floor could not be had
 * even then - someone claimed it again in between - or the session is gone.
 */
async function answerThisMessage(
  deps: TripBotPollerDeps,
  chatId: string,
  view: SessionView,
  text: string,
  log: (line: string) => void,
  reply: "change_refused" | "change_not_understood",
): Promise<boolean> {
  if (!(await takeFloor(chatId, view, deps))) {
    const again = await retakeFloor(deps, chatId, view.sessionId, log, reply);
    if (!again || !(await takeFloor(chatId, again, deps))) return false;
  }
  await deps.telegram.sendMessage({ chatId, text }).catch(() => undefined);
  return true;
}

async function runInterpretPath(
  deps: TripBotPollerDeps,
  burst: { sessionId: string; chatId: string },
  combined: WireMessageEvent,
  log: (line: string) => void,
): Promise<void> {
  const strings = deps.strings ?? DEFAULT_STRINGS;
  const sourceText = combined.text ?? "";
  const messageIds = combined.message_id ? [combined.message_id] : [];
  if (sourceText.length > INTERPRET_SOURCE_BUDGET_CHARS) {
    log(structuredLog("warn", "interview.interpret_source_truncated", {
      session_id: burst.sessionId,
      chars: sourceText.length,
      budget: INTERPRET_SOURCE_BUDGET_CHARS,
    }));
  }
  // Resolved before the claim, because a burst that carried files is claimed by
  // what the files ARE — see `documentBurstKey`.
  const documents = documentsInBurst(combined, deps);
  const key = documents.length > 0
    ? documentBurstKey(documents.map((doc) => contentDigest(doc.bytes)), sourceText)
    : burstKey(messageIds, sourceText);

  // TAKE THE FLOOR FIRST, before anything slow.
  //
  // The organizer has just written, so it is the machine's turn — and on the
  // agent path that transition came free with `openAgentTurn`, which this path
  // deliberately never calls. Without it `sendNextStep` returns silently at its
  // `awaiting === "person"` guard and `claimFloor` refuses, so every answer
  // would be recorded correctly and the interview would go quiet: the exact
  // symptom of runs 14–15, arrived at from the opposite direction.
  //
  // A document burst has already been given the wider DOCUMENT_FLOOR_SECONDS
  // by the caller; do not narrow it here.
  if ((combined.media_urls?.length ?? 0) === 0) {
    await markAwaitingMachine(deps.db, burst.chatId, AGENT_FLOOR_SECONDS);
  }

  /**
   * THE ORGANIZER SPOKE, SO SOMETHING IS OWED BACK.
   *
   * `sendNextStep` legitimately says nothing in several situations — the floor
   * is not ours, the next thing is already on screen and the dedupe refuses to
   * repeat it, the state is one it does not speak for. Every one of those is
   * correct when NOBODY has spoken. After an organizer's message it is a
   * dead end: they typed, and the interview went quiet.
   *
   * Live on 2026-09-10. The boundary offer — "add more details, or shall I
   * show you a summary?" — carries both buttons, and the organizer answered it
   * in words instead: "לא". `interpret` did its job and proposed nothing,
   * because "no" answers the offer rather than any question in the schema.
   * Nothing was owed by the ordinary rules, the dedupe held the line, and the
   * session sat on `awaiting = 'machine'` until it expired. From the outside
   * that is indistinguishable from a broken bot.
   *
   * So: if we said nothing, say we did not follow, and put back exactly what
   * we are waiting for — with its buttons, so there is always a tap available
   * to someone whose words we cannot parse. Never a bare "I didn't
   * understand": that is the message that makes a person guess.
   */
  const ask = async () => {
    const before = await getSessionForChat(deps.db, burst.chatId);
    if (!before.ok) return;
    if (await sendNextStep(before.view, burst.chatId, deps, strings)) return;

    // IT MAY HAVE GIVEN THE FLOOR AWAY ON ITS WAY OUT.
    //
    // `sendNextStep`'s dedupe branch hands the floor back when what it would
    // ask is already on screen, and it is right to: holding it with nothing to
    // say leaves the session owing a message forever, and the tick scan then
    // rediscovers it every couple of seconds. But `restateExpectation` needs
    // the floor to speak, so after that handback it could not — and said
    // nothing at all.
    //
    // That is the silence this whole function exists to prevent, reached from
    // one step further along. It bites at the BOUNDARY, where the offer is
    // both what is on screen and what the dedupe compares against: every typed
    // message that was not understood there produced total silence, which from
    // the outside is indistinguishable from a broken bot. Found by the
    // fallback tests for `settleBoundary`, 2026-09-18.
    //
    // Only OUR handback is taken back — the floor moving from machine to
    // person across a call that sent nothing is exactly that, and nothing
    // else. A floor somebody else is holding stays theirs.
    const after = await getSessionForChat(deps.db, burst.chatId);
    if (!after.ok) return;
    if (before.view.awaiting === "machine" && after.view.awaiting === "person") {
      await markAwaitingMachine(deps.db, burst.chatId, AGENT_FLOOR_SECONDS);
    }
    await restateExpectation(after.view, burst.chatId, deps, "NOT_UNDERSTOOD");
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
    // A document burst already read. Its deliveries are still recorded — a
    // file re-sent in a new message is a real delivery — but only a NEW
    // delivery is told the file was already read. A redelivered update the
    // organizer never re-sent must not produce a message they did not prompt.
    if (documents.length > 0) {
      const replaying = await getSessionForChat(deps.db, burst.chatId);
      if (replaying.ok) {
        const { registered } = await ingestBurstDocuments(deps, burst, replaying.view.tripId, documents, log);
        if (registered.some((doc) => doc.newDelivery)) {
          await deps.telegram
            .sendMessage({ chatId: burst.chatId, text: uiString("documentAlreadyRead", replaying.view.language) })
            .catch(() => {});
        }
      }
    }
    // A typed change this reading made may have been committed and never shown
    // (the relay died between the two). It is in the database, waiting: show it,
    // unless that version is already on screen.
    const replaying = await getSessionForChat(deps.db, burst.chatId);
    if (replaying.ok) {
      const made = await getDraftForInterpretation(deps.db, burst.sessionId, claim.row.id);
      if (made && made.status === "pending") {
        if (replaying.view.lastPrompt !== changePromptKey(made)) {
          await showChangeDraft(deps, burst.chatId, replaying.view, made);
        }
        return;
      }
    }
    // Committed already, but the organizer may never have seen the question
    // that followed — asking again is safe (the flood dedupe suppresses a
    // genuine repeat), staying silent is not.
    await ask();
    return;
  }

  const state = await questionStateForChat(deps.db, burst.chatId);
  if (!state) return;
  const recorded = await answersForChat(deps.db, burst.chatId);
  const session = await getSessionForChat(deps.db, burst.chatId);
  let language = session.ok ? session.view.language : DEFAULT_LANGUAGE;

  // WHAT THEY WRITE, not what their phone is set to. The session starts from the
  // Telegram app's language as a hint; on the agent path the interviewer then
  // reported the real one, and on this path nothing did — so an organizer with an
  // English phone who wrote in Hebrew got an English interview, site and
  // companion (2026-09-15). Followed here, before the reply and the
  // interpretation are drawn, so both are in the language just written.
  const written = writtenLanguage(sourceText);
  if (written && written !== language) {
    const followed = await setLanguageForChat(deps.db, burst.chatId, written);
    if (followed.ok) {
      log(structuredLog("info", "interview.language_followed", {
        session_id: burst.sessionId,
        from: language,
        to: written,
      }));
      language = written;
    }
  }

  // A DOCUMENT. Read it, and let what it says answer questions.
  //
  // Handled before the text branch and instead of it: someone who uploads a
  // booking and types "it's all in here" has said nothing interpretable, and
  // the file is the message. The whole exchange — acknowledge, read, report
  // back, ask only for what is left — is the reason accepting a file is worth
  // anything, and until now the bot accepted files and read none of them.
  if (documents.length > 0) {
    // Not-fresh-and-uncommitted lands here too: the crash window. Re-running
    // the document path IS the resume — every document already read is served
    // from its stored extraction, so nothing is paid for twice.
    await runDocumentPath(
      deps, burst, documents, language, log,
      claim.fresh ? claim.id : claim.row.id,
      session.ok ? session.view.tripId : null,
    );
    return;
  }
  // Which question is currently on the organizer's screen. Needed after the
  // commit, to decide whether the interview may move past it — see `pace`.
  const onScreen = session.ok && session.view.lastPrompt?.startsWith("q:")
    // The id only: the key may carry `:about:<need>` and `:unsettled:<text>` after it.
    ? session.view.lastPrompt.slice(2).split(":")[0]!
    : null;

  const interpretationId = claim.fresh ? claim.id : claim.row.id;
  let proposals: ProposedAnswer[];
  let malformed = 0;
  let ops: Op[] | undefined;
  let opsError: string | undefined;
  let unclear: { questionId: string; why: string }[] = [];
  // What came of this message's operations: the draft they went into (found, not
  // re-made, on a replay), or the reason they could not.
  let change: ProposeResult | null = null;
  const proposeOps = async () => {
    if (!ops || ops.length === 0 || !session.ok) return;
    change = await proposeChange(deps.db, {
      sessionId: burst.sessionId,
      tripId: session.view.tripId,
      interpretationId,
      ops,
      displacedPrompt: (session.view.lastPrompt ?? "").startsWith("pc:") ? null : session.view.lastPrompt ?? null,
    });
  };

  // A TYPED CHANGE IS WAITING AND ITS PREVIEW IS ON SCREEN: a message that is
  // nothing but a yes or a no answers IT. Exact and deterministic — no model —
  // and only while the preview is what is on screen (`lastPrompt` is
  // `pc:<id>`): a "yes" to any other question must never confirm a change, and
  // the boundary reader is not asked, because the boundary is not on screen.
  // Anything more than a bare yes or no ("yes, and add Nara", "no, make it 21")
  // is interpreted and MERGED into the waiting change, never applied or dropped.
  //
  // A bare yes or no while a change waits is taken as being about the CHANGE
  // whatever else is on screen (decided in round 3 of PR #199: a draft whose
  // preview never went out has nothing on screen to answer, and "yes"/"no" is how
  // `change.sendFailed` tells the organizer to ask for it). The model is not asked.
  const waiting = session.ok ? await getOpenDraft(deps.db, burst.sessionId) : null;
  if (waiting && session.ok) {
    const bare = bareReply(sourceText);
    if (bare) {
      // WHICH VERSION is on screen: the digest `showChangeDraft` recorded when the
      // preview was delivered - null when no preview of this draft ever was.
      const onScreenDigest = promptDigest(session.view.lastPrompt, waiting.id);
      await recordInterpretationResult(deps.db, interpretationId, { proposals: [], attempts: 0, durationMs: 0 });
      await markInterpretationCommitted(deps.db, interpretationId, { accepted: [], rejected: [], askAnyway: [], malformed: 0 });
      // NOTHING HAPPENS TO A CHANGE THE ORGANIZER HAS NOT SEEN. When the version
      // waiting is not the one on their screen - its preview never went out, or a
      // follow-up merged into it and THAT preview never went out - a yes and a no
      // are answered the same way: the current version is shown, and neither is
      // acted on. A "yes" would apply what they never saw; a "no" would cancel it
      // (the merge included) just as unseen. That is what `change.sendFailed`
      // promises for both words. If the re-show is refused too, the draft is
      // dropped out loud on a "no" - their "no" is the way out, and it must not
      // only retry a send that keeps failing. A "yes" keeps it waiting: they asked
      // for it, and "no" still gets them out.
      if (onScreenDigest !== draftDigest(waiting)) {
        log(structuredLog("info", "interview.change_shown_on_request", {
          session_id: burst.sessionId, answer: bare, on_screen: onScreenDigest === null ? "none" : "older_version",
        }));
        await reshowDraft(
          deps, burst.chatId, session.view, waiting, strings,
          onScreenDigest === null ? undefined : uiString("change.updated", session.view.language),
          { dropIfUnsent: bare === "no" },
        );
        return;
      }
      log(structuredLog("info", "interview.change_answered_in_words", { session_id: burst.sessionId, answer: bare }));
      if (bare === "no") {
        await settleChange(deps, { chatId: burst.chatId, draftId: waiting.id, choice: "cancel" }, strings, log);
      } else if (confirmable(waiting)) {
        await settleChange(deps, { chatId: burst.chatId, draftId: waiting.id, choice: "apply", digest: onScreenDigest }, strings, log);
      } else {
        await showChangeDraft(deps, burst.chatId, session.view, waiting, uiString("change.stillBlocked", session.view.language));
      }
      return;
    }
  }

  // The crash window: the model answered and the commit did not land. Its
  // PROPOSALS were stored; its operations were not, so a stored reading with no
  // proposals is asked again rather than resumed as "the model said nothing".
  if (!claim.fresh && (claim.row.proposals.length > 0 || claim.row.failureReason)) {
    // The crash window: the model answered, the commit did not land. Resume
    // from what was stored rather than asking again — the answer is already
    // paid for and re-asking could return something different.
    proposals = claim.row.proposals;
    // The operations are not stored with the reading; the DRAFT they went into is
    // (it is made before the reading is recorded, below), so it is looked up.
    const already = session.ok ? await getDraftForInterpretation(deps.db, burst.sessionId, interpretationId) : null;
    if (already) change = { kind: "replay", draft: already };
    log(structuredLog("info", "interview.interpret_resumed", {
      session_id: burst.sessionId,
      burst_key: key,
      proposals: proposals.length,
      draft: already ? already.id : null,
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
  } else if (onScreen && recorded
             && typedChoiceAnswer(onScreen, sourceText, recorded.answers) !== null) {
    // DECIDABLE WITHOUT A MODEL, so decided without one.
    //
    // The question on screen offers choices drawn from what the control plane
    // already holds, and what was typed names exactly one of them. That is a
    // lookup, and `typedChoiceAnswer` is the same matcher the button path uses
    // — so typing the name and tapping the name now reach the same place, which
    // is the standing rule for every button in this interview.
    //
    // It ran through the model until 2026-09-20 and the model could not do it:
    // an organizer answered `organizer_identity` with their own name, spelled
    // exactly as the roster has it, and `interpret` returned zero proposals
    // twice running. The interview re-asked the same question forever and the
    // trip was never built. The model is not shown a `choicesFrom` question's
    // options at all (`describeQuestion` reads only the static ones), so it was
    // being asked which traveller this is without being given the travellers.
    //
    // Cheaper matters less than correct here, but it is also ~7s of model call
    // saved on a question that has one right answer.
    const value = typedChoiceAnswer(onScreen, sourceText, recorded.answers)!;
    proposals = [{
      questionId: onScreen,
      value: { kind: "text", text: value },
      confidence: 1,
      // The organizer's own words, which is what `evidenceAppears` checks.
      evidence: sourceText.trim(),
      sourceMessageId: messageIds[0] ?? "",
    }];
    await recordInterpretationResult(deps.db, interpretationId, {
      proposals,
      attempts: 0,
      durationMs: 0,
    });
    log(structuredLog("info", "interview.matched_without_model", {
      session_id: burst.sessionId,
      question_id: onScreen,
    }));
  } else {
    // The stops and travellers already held, each under an id, so a CHANGE to
    // either comes back as operations and not as a list (#206). Those two
    // questions are not offered as plain corrections any more.
    const held = recorded ? heldRefLists(recorded.answers) : { stops: [], travellers: [] };
    const result = await interpretBurst(deps.modelRunner, {
      sourceText,
      outstanding: state.outstanding,
      language,
      onScreen,
      messageIds,
      heldLists: held,
      // What they have already told us, so "actually, it's only my wife" is
      // something the model can propose at all (2026-09-16).
      correctable: recorded
        ? buildRecap(recorded.answers, INTAKE_QUESTIONS, language)
            .filter((entry) => !(entry.questionId === "phases" && held.stops.length > 0)
              && !(entry.questionId === "travelers" && held.travellers.length > 0))
            .map((entry) => ({ id: entry.questionId, current: entry.answerLabel }))
        : [],
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
    // Validated here as well as in the parser: whatever a runner hands back, only
    // operations that pass `parseOps` ever reach the store.
    const checked = result.payload.ops === undefined ? null : parseOps(result.payload.ops);
    ops = checked?.ok ? checked.ops : undefined;
    opsError = checked && !checked.ok ? checked.error : result.payload.opsError;
    unclear = result.payload.unclear;
    // THE DRAFT FIRST. It is keyed by this interpretation, so making it twice is
    // one draft; and until it exists nothing below may be recorded as done — a
    // crash between the two used to lose the change for good, because the reading
    // was already marked committed and the replay path only asks the next question.
    await proposeOps();
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
    // What the organizer TYPES may correct what they already said — and a
    // correction to the travellers or the stops adds to them (2026-09-16).
    allowCorrections: true,
    answers: recorded?.answers,
    unclear: [],
    // The reply to the question we just asked is not a volunteered guess, and
    // the confidence floor must not send the router round again to ask it a
    // second time. See ApplyProposalsContext.pendingQuestionId.
    pendingQuestionId: onScreen,
    // The stops and the travellers change only through the confirmed flow.
    changeQuestions: CHANGE_QUESTIONS,
  });

  for (const accepted of decisions.accepted) {
    // The MERGED answer, not the raw reading — see `submitArgsForAccepted`. (The
    // stops and travellers never reach here already answered: they are a change.)
    const args = submitArgsForAccepted(accepted);
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
    merged: decisions.accepted.filter((a) => a.mergedFrom).length,
    rejected: decisions.rejected.length,
    reasons: decisions.rejected.map((r) => r.reason),
  }));

  // ACKNOWLEDGE AN OPEN ANSWER, and only an open one.
  //
  // Typing a list of names into a chat window and getting nothing back but the
  // next question is the part that feels unheard. A BUTTON does not need this:
  // the keyboard disappears and the next question arrives, which is already
  // confirmation, and a message on top of it is noise.
  //
  // The understood VALUE goes with it, because that is the whole point — the
  // organizer needs to see that it landed the way they meant, while correcting
  // it is still cheap. Warmth without the value would be flattery; the value
  // without warmth is a receipt.
  const open = decisions.accepted.filter((a) => {
    const q = INTAKE_QUESTIONS.find((x) => x.id === a.questionId);
    return q?.type === "text" || q?.type === "structured";
  });
  if (open.length > 0) {
    const said = await getSessionForChat(deps.db, burst.chatId);
    const store = await answersForChat(deps.db, burst.chatId);
    if (said.ok && store) {
      const lines = buildRecap(store.answers, INTAKE_QUESTIONS, said.view.language)
        // Only what SETTLED its question. An organizer name that matched nobody is
        // on record without being an answer, and "got it" would say otherwise —
        // the question comes straight back instead, quoting it.
        .filter((entry) => open.some((a) => a.questionId === entry.questionId)
          && INTAKE_QUESTIONS.some((q) => q.id === entry.questionId && isAnswered(q, store.answers)))
        .map((entry) => `${entry.prompt}: ${entry.answerLabel}`);
      if (lines.length === 1) {
        await deps.telegram
          .sendMessage({ chatId: burst.chatId, text: `${uiString("gotIt", said.view.language)} — ${lines[0]}` })
          .catch(() => {});
      } else if (lines.length > 1) {
        await deps.telegram
          .sendMessage({
            chatId: burst.chatId,
            text: `${uiString("gotItMore", said.view.language)}\n\n${lines.map((l) => `• ${l}`).join("\n")}`,
          })
          .catch(() => {});
      }
    }
  }
  await markInterpretationCommitted(deps.db, interpretationId, storedOutcomes(decisions, malformed));

  // A CHANGE TO THE STOPS OR THE TRAVELLERS: shown, never written. The operations
  // go into the session's one waiting draft — merged with what is already
  // waiting — and the organizer sees exactly what would change. The answers
  // above (anything else the message said) were already written and read back.
  // While a change is up the interview does not press on: what was on screen is
  // remembered and comes back when the change is settled.
  let draftShown = false;
  const made = change as ProposeResult | null;
  if (made) draftShown = await announceChange(deps, burst, made, language, log);
  if (draftShown) return;

  // NEVER SILENT. A typed change to something already answered that the gate
  // would not take — an unsure read, a quote that is not in the message, a value
  // the writer refuses, operations that do not parse, a model that said it was
  // unclear about the stops — is ASKED about, not dropped: dropped, the person
  // is left believing it was recorded.
  {
    const covered = new Set((ops ?? []).map(questionOfOp));
    const about = new Set<string>();
    for (const r of decisions.rejected) {
      if (state.answered.includes(r.questionId) && ASK_ABOUT_REFUSED.has(r.reason) && !covered.has(r.questionId as never)) {
        about.add(r.questionId);
      }
    }
    for (const u of unclear) {
      if (CHANGE_QUESTIONS.includes(u.questionId) && state.answered.includes(u.questionId) && !covered.has(u.questionId as never)) {
        about.add(u.questionId);
      }
    }
    if (about.size > 0 || opsError) {
      log(structuredLog("info", "interview.change_not_understood", {
        session_id: burst.sessionId,
        questions: [...about],
        ops_error: opsError ? true : false,
      }));
      const now = await getSessionForChat(deps.db, burst.chatId);
      if (now.ok) {
        const what = [...about].map((id) => questionNoun(id, now.view.language)).join(", ");
        const text = what
          ? uiString("change.notUnderstoodAbout", now.view.language).replace("{what}", what)
          : uiString("change.notUnderstood", now.view.language);
        // It answers THIS message, so a concurrent tap holding the floor does not silence it (#225).
        if (await answerThisMessage(deps, burst.chatId, now.view, text, log, "change_not_understood")) return;
      }
    }
  }

  // PACING. An OPTIONAL question that was on screen and did not get answered
  // is put behind us, so the interview moves to the next one.
  //
  // Without this the interview stalls, and the first end-to-end run showed it:
  // every required question answered, then fifteen turns in a row on
  // `travel_anchors` because the organizer's replies did not answer it and
  // `optionalRemaining[0]` is always the same question. The flood dedupe
  // suppressed the repeat, so the organizer saw nothing at all — the interview
  // simply went quiet on a path that was working perfectly.
  //
  // On the agent path this was the agent's job: `ask_question_for_chat` decides
  // WHICH optional question is worth asking now, what app.ts calls "the pacing
  // half of the split". Removing the agent removed the pacing with it, and this
  // is the deterministic rule that replaces it: each optional question is
  // offered exactly once, in order, and then the interview goes on.
  //
  // Required questions are deliberately NOT skipped — the interview cannot
  // proceed without them, so it re-asks, which is the behaviour it already had.
  const unanswered = onScreen && !decisions.accepted.some((a) => a.questionId === onScreen);
  const onScreenQuestion = onScreen ? INTAKE_QUESTIONS.find((q) => q.id === onScreen) : undefined;

  if (unanswered && onScreenQuestion && !onScreenQuestion.required && !onScreenQuestion.neverPassedOver
      && !state.answered.includes(onScreen)) {
    await skipQuestionForChat(deps.db, burst.chatId, onScreen);
    log(structuredLog("info", "interview.optional_passed_over", {
      session_id: burst.sessionId,
      question_id: onScreen,
    }));
  }

  // THE SILENCE. A REQUIRED question cannot be skipped, so when the organizer
  // writes something that does not answer it the router still wants the same
  // question — and `sendNextStep`'s "never send the same message twice" then
  // suppresses it and sends nothing at all.
  //
  // Found live on 2026-09-08, first real run: three answers recorded perfectly,
  // then a message about a document, then silence with `prompt_deduped
  // q:departure_date` as the last thing in the log. The organizer spoke and got
  // nothing back.
  //
  // The dedupe is right and stays — repeating a question verbatim is what runs
  // 5 and 6 paid to stop. What was missing is the agent's other job: saying the
  // same question a DIFFERENT way when a reply did not answer it. The stall
  // watchdog already does exactly this for the agent path (distinct opening
  // line, same question, buttons intact) and deliberately suppresses itself
  // when the question is already on screen, because there nobody has spoken
  // since. Here somebody has — which is precisely what makes re-asking an
  // answer rather than noise.
  if (unanswered && onScreenQuestion?.required && !state.answered.includes(onScreen)) {
    await deferQuestionForChat(deps.db, burst.chatId, onScreen);
    log(structuredLog("info", "interview.required_deferred", {
      session_id: burst.sessionId,
      question_id: onScreen,
    }));
  }

  // The floor was taken when the burst arrived; the router speaks now. If the
  // interview is at the boundary with an answer still set aside, that is
  // `sendNextStep`'s to handle — for every path, not only this one.
  //
  // Deferring costs nothing because `confirmIntake` refuses without a required
  // answer regardless; the only question was ever WHEN to come back for it:
  // immediately, which pesters ("עוד צריך את זה: מתי הטיול מתחיל?" after every
  // message about something else), or at the point it blocks something.
  //
  // THE BOUNDARY IS READ LAST, on purpose. Everything the message said about
  // the trip is already recorded and already read back, so "wait, I forgot we
  // also want a day at Disney" keeps its detail and still gets an answer to
  // the choice it left open. `settleBoundary` returns without a model call
  // unless the offer is actually on screen; "moved" leaves the floor alone so
  // `ask` sends the recap or the next question, exactly as a tap would.
  const settled = await settleBoundary(deps, burst.chatId, {
    sourceText,
    captured: capturedLabels(decisions.accepted, language),
  }, log);
  if (settled !== "spoke") await ask();
}

/**
 * What this message put on record, in the organizer's own language, as the
 * short recap nouns ("Interests", "תחנות").
 *
 * For the boundary reader only, which needs to know that a message carried
 * trip information without being handed the interview's internal ids.
 */
function capturedLabels(
  accepted: readonly { questionId: string }[],
  language: Language,
): string[] {
  return accepted
    .map((a) => INTAKE_QUESTIONS.find((q) => q.id === a.questionId))
    .filter((q): q is IntakeQuestion => Boolean(q))
    .map((q) => recapLabel(q, language));
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

/**
 * Warns an idle interview that it is about to close, and closes it when it is.
 *
 * Two claims rather than one pass, because they are different events with
 * different copy and each must happen exactly once — both claim-and-mark in a
 * single statement, the same `FOR UPDATE SKIP LOCKED` discipline every other
 * claim here uses, so two ticks cannot both warn or both close.
 *
 * Neither message asks a question or carries a keyboard: there is nothing to
 * tap, and the way back in is to write. Both lead with "nothing is lost",
 * because that is the only thing the person actually wants to know.
 */
export async function closeIdleInterviews(
  deps: TripBotPollerDeps,
  log: (line: string) => void,
): Promise<void> {
  try {
    for (const s of await claimSessionsDueWarning(deps.db)) {
      // "Send anything to keep going" is true and not enough: someone who
      // stopped because they did not know what was wanted is told, again, to
      // send something. Restating the outstanding question — with its buttons
      // — answers the question they actually have, and a tap is a cheaper way
      // back in than composing a sentence. Falls back to the bare notice when
      // there is genuinely nothing outstanding to show.
      const view = await getSessionForChat(deps.db, s.chatId);
      const restated = view.ok && await restateExpectation(view.view, s.chatId, deps, "EXPIRING");
      if (!restated) {
        await deps.telegram.sendMessage({ chatId: s.chatId, text: uiString("expiringSoon", s.language) });
      }
      log(structuredLog("info", "interview.expiry_warned", { session_id: s.sessionId, restated: Boolean(restated) }));
    }
  } catch {
    log(structuredLog("warn", "interview.expiry_warn_failed", {}));
  }

  try {
    for (const s of await claimExpiredSessions(deps.db)) {
      await deps.telegram.sendMessage({ chatId: s.chatId, text: uiString("expired", s.language) });
      log(structuredLog("info", "interview.session_expired", { session_id: s.sessionId }));
    }
  } catch {
    log(structuredLog("warn", "interview.expiry_close_failed", {}));
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
      if (view.lastPrompt?.split(":").slice(0, 2).join(":") === `q:${question.id}`) {
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

      const rendered = renderStep(question, view);
      const sent = await deps.telegram.sendMessage({
        chatId,
        text: `${uiString("resumed", view.language)}\n\n${rendered.text}`,
        replyMarkup: rendered.replyMarkup ?? undefined,
      });
      // Only what ARRIVED is on screen (#225 item 9). The real client returns
      // `ok: false` rather than throwing, and recording the key anyway made the
      // dedupe above suppress, as already asked, a question nobody received.
      if (!sent?.ok) {
        log(structuredLog("warn", "trip_bot.stalled_turn_recovery_failed", {
          session_id: sessionId,
          permanent: isPermanentRefusal(sent),
        }));
        continue;
      }
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
      // ROUTER-OWNED, or anything at all on the interpret path.
      //
      // This scan is what moves an interview forward on a tick, and it only
      // ever proceeded for a ROUTER-OWNED question, because every other
      // question belonged to the agent. On the interpret path nothing belongs
      // to the agent, so an interview whose only remaining questions are
      // ordinary optional ones was never handed to `sendNextStep` at all — it
      // sat awaiting the machine with nobody scheduled to speak.
      //
      // That is the last of today's stalls: the walk was fixed, and then never
      // called.
      const onInterpret = await isInterpretPath(deps.db, chatId);
      const somethingToAsk = onInterpret
        ? Boolean(nextRouterOwnedQuestion(result.view) ?? result.view.nextQuestion ?? result.view.pendingAsk ?? result.view.optionalRemaining[0])
        : Boolean(nextRouterOwnedQuestion(result.view));
      if (!somethingToAsk) continue;
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
/**
 * The day-by-day a document describes, on the phases it describes them for.
 *
 * The general extraction that runs over a shared document answers the
 * interview's questions — destination, dates, who is coming, which stops. It
 * does not produce an itinerary, and asking it to was how a five-day Tokyo leg
 * came back with a single day in it: one prompt cannot both survey a document
 * for twenty answers and transcribe a schedule out of it.
 *
 * `extract_itinerary` is the pass built for exactly that, and it has been
 * unreachable from a chat interview since it was written: it is a token-scoped
 * MCP tool, and the interpret path has no agent to call tools. It needs no
 * Hermes profile any more either — with `EXTRACT_RUNNER` set it runs on the
 * shared model runner, which the relay already has. So the router calls it
 * itself, right after the document's answers land.
 *
 * Best-effort throughout, like every other document step: a failure leaves the
 * interview exactly as the general extraction left it, and the organizer is
 * told nothing, because nothing they asked for has failed.
 */
export async function foldItineraryFromDocument(
  deps: TripBotPollerDeps,
  burst: { chatId: string; sessionId: string },
  documentText: string,
  log: (line: string) => void,
  say?: (text: string) => Promise<void>,
  language: Language = DEFAULT_LANGUAGE,
): Promise<void> {
  const store = await answersForChat(deps.db, burst.chatId);
  const phasesAnswer = store?.answers.phases;
  if (!phasesAnswer || phasesAnswer.kind !== "structured" || !Array.isArray(phasesAnswer.data)) return;
  const phases = phasesAnswer.data as Record<string, unknown>[];
  if (phases.length === 0) return;
  // Every night of every stop already has a day: nothing a document could add.
  // The old test was "every stop has A day", which let one captured day stand
  // for a whole five-day stop, so no later document could fill in the rest.
  if (itineraryCoverageComplete(phases)) return;

  const destinationAnswer = store?.answers.destination;
  const destination = destinationAnswer?.kind === "text" ? destinationAnswer.text
    : destinationAnswer?.kind === "choice_other" ? (destinationAnswer.other_text ?? "")
    : "";
  const travelers = (store?.answers.travelers?.kind === "structured" && Array.isArray(store.answers.travelers.data)
    ? store.answers.travelers.data
    : []
  ).flatMap((t) => {
    const name = (t as { name?: unknown })?.name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });

  const extract = deps.extractItinerary ?? extractItinerary;
  let result: Awaited<ReturnType<typeof extractItinerary>>;
  try {
    result = await extract({
      destination,
      phases: phases.map((phase) => ({
        name: String(phase.name ?? phase.name_en ?? ""),
        ...(typeof phase.start === "string" ? { start: phase.start } : {}),
        ...(typeof phase.end === "string" ? { end: phase.end } : {}),
      })),
      travelers,
      documentText,
    // The relay's own runner, so a super admin's override for the day-by-day
    // task applies here too. Left to its default this would build a runner
    // from the environment and silently ignore the override.
    }, deps.modelRunner ?? modelRunnerFromEnv());
  } catch {
    log(structuredLog("warn", "interview.itinerary_extract_threw", { session_id: burst.sessionId }));
    return;
  }

  if (!result.ok) {
    log(structuredLog("info", "interview.itinerary_extract_failed", {
      session_id: burst.sessionId,
      reason: result.reason,
      detail: (result.detail ?? "").slice(0, 200),
    }));
    return;
  }

  // Park venues whose URL search was rate-limited, so the API's background
  // drain retries them and enrich_config back-fills the link at provision
  // time. The MCP tool has always done this; this path computed the same list
  // and threw it away, so on the agentless path — the default — a venue only
  // ever got a ticket link if the model happened to produce one inline.
  // Deliberately before the staleness and empty-fold returns below: the names
  // are owed whether or not this particular extraction lands.
  if (result.venueLinksDeferred.length) {
    try {
      const queued = await parkDeferredVenueLinks(deps.db, destination, result.venueLinksDeferred);
      log(structuredLog("info", "interview.venue_links_parked", { session_id: burst.sessionId, queued }));
    } catch (error) {
      log(structuredLog("warn", "interview.venue_links_park_failed", {
        session_id: burst.sessionId,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }));
    }
  }

  // It runs behind the interview, so the organizer may have changed the stops
  // while the model worked. Days filed against the list it started from would
  // land on the wrong phase, or undo the change — so the change wins.
  const current = await answersForChat(deps.db, burst.chatId);
  if (JSON.stringify(current?.answers.phases) !== JSON.stringify(phasesAnswer)) {
    log(structuredLog("info", "interview.itinerary_stale", { session_id: burst.sessionId }));
    return;
  }

  const folded = foldExtractedIntoPhases(phases, result.phases);
  if (folded.daysAdded === 0 && folded.venuesAdded === 0) {
    log(structuredLog("info", "interview.itinerary_extract_empty", {
      session_id: burst.sessionId,
      warnings: result.warnings.slice(0, 3),
    }));
    return;
  }

  const written = await submitAnswerForChat(
    deps.db, burst.chatId, "phases", null, undefined, folded.phases,
  );
  log(structuredLog(written.ok ? "info" : "warn", "interview.itinerary_extracted", {
    session_id: burst.sessionId,
    days: folded.daysAdded,
    venues: folded.venuesAdded,
    written: written.ok,
    ...(written.ok ? {} : { reason: written.reason }),
  }));
  // An extraction nobody can see reads as a document that was not understood.
  if (written.ok && folded.daysAdded > 0 && say) await say(uiString("documentDays", language));
  // And a day-by-day built from part of a plan must not pass for all of it: the
  // organizer would reasonably take a missing day as a free one.
  if (written.ok && say && result.warnings.some((w) => w.startsWith(ITINERARY_TRUNCATED_WARNING))) {
    log(structuredLog("warn", "interview.itinerary_truncated", { session_id: burst.sessionId }));
    await say(uiString("itineraryPartial", language));
  }
}

async function handBackToInterviewer(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
): Promise<void> {
  if (!deps.interviewerProfile) return;
  const log = deps.log ?? (() => {});

  // NEVER ON THE INTERPRET PATH. There is no agent to hand back TO.
  //
  // Live on 2026-09-09, and one cause produced four symptoms: a button tap
  // with nothing queued opened an agent turn and pushed to the gateway. The
  // turn was never closed, because nothing on this path closes one. The
  // trip-intake agent woke, found its sidecar down, and wrote "the MCP server
  // is not reachable". Thirty seconds later the stall watchdog reclaimed the
  // floor with "נמשיך מכאן" and repeated the question the organizer had just
  // answered. And in between, the floor was held by a machine that could not
  // act, so the organizer had to type "מה עכשיו" to shake it loose.
  //
  // The interpret path's own `sendNextStep` already covers the case this
  // exists for: it asks the next question, or the boundary message, itself.
  if (await isInterpretPath(deps.db, chatId)) {
    log(structuredLog("info", "trip_bot.handback_skipped", {
      session_id: view.sessionId,
      reason: "INTERPRET_PATH",
    }));
    return;
  }
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
/**
 * Say what the interview is waiting for, in the organizer's language, with
 * whatever buttons that thing carries.
 *
 * The rule this serves: the interview never goes quiet on a person. Whatever
 * the reason we have nothing new to say — a reply we could not parse, a
 * session about to expire — the way out is the same, and it is never a bare
 * "I didn't understand". That sentence tells someone they failed without
 * telling them what would succeed, which is the stall-with-extra-steps.
 *
 * Deliberately re-sends something already on screen. `sendNextStep`'s dedupe
 * is right that repeating a question unprompted is noise; this only runs when
 * the alternative is silence, and then the same question with a line saying
 * why it is back is the most useful thing there is.
 *
 * It re-renders rather than quoting the last message, so the buttons come
 * back live — a keyboard from an older message still works in Telegram, but a
 * person who has typed once and been misunderstood should not have to scroll
 * up to find out that tapping was an option.
 */
async function restateExpectation(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
  reason: "NOT_UNDERSTOOD" | "EXPIRING",
): Promise<boolean> {
  const lead = uiString(reason === "EXPIRING" ? "stillWaitingBeforeExpiry" : "didNotFollow", view.language);

  // What is outstanding, most specific first. The BOUNDARY is the case that
  // needed this: `state` is still `interviewing` there — everything required
  // answered, every optional one skipped, `nextQuestion` null — so keying off
  // the state would miss precisely the session that stalled.
  // THE OFFER FIRST, while it is the thing on screen. Typed at rather than
  // tapped — "לא" is the recorded case — the answer belongs to the offer, not
  // to the optional question behind it, and restating that question instead
  // would ask something they may well have just declined.
  // `boundaryOnScreen` is the same predicate `settleBoundary` uses, widened
  // once since: a CONFIRMATION of a reading ("shall I put your summary
  // together?") is the boundary too, and restating an optional question under
  // it would answer a choice they were in the middle of making.
  const offerOnScreen = boundaryOnScreen(view) !== null;
  const question = offerOnScreen
    ? null
    : view.nextQuestion ?? view.pendingAsk ?? view.optionalRemaining[0] ?? null;
  let rendered: RenderedQuestion;
  if (question) {
    rendered = renderStep(question, view);
  } else if (view.state === "awaiting_confirmation") {
    rendered = renderConfirmPrompt(
      `${uiString("recapHeader", view.language)}\n\n`
      + (view.recap ?? []).map((e) => `• ${e.prompt}\n  ${e.answerLabel}`).join("\n")
      + `\n\n${uiString("recapFooter", view.language)}`,
      view.language,
    );
  } else if (view.offeredMore) {
    rendered = renderEssentialsDone(view.language);
  } else {
    return false;
  }

  if (!(await takeFloor(chatId, view, deps))) return false;
  (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.expectation_restated", {
    session_id: view.sessionId,
    reason,
  }));
  await deps.telegram.sendMessage({
    chatId,
    text: `${lead}\n\n${rendered.text}`,
    replyMarkup: rendered.replyMarkup ?? undefined,
  });
  return true;
}

/**
 * Take the floor to speak, and say so in the log when we cannot.
 *
 * `claimFloor` returning false means somebody else claimed it between our read
 * and our send — in practice the periodic scan, which hands the floor back to
 * the organizer whenever the question is already on their screen. Every call
 * site then did a bare `return false`, so the router went quiet with no line
 * anywhere saying why. On 2026-09-12 an organizer tapped Skip, watched the
 * keyboard collapse, and waited two minutes in front of a relay log that
 * recorded nothing at all.
 */
async function takeFloor(chatId: string, view: SessionView, deps: TripBotPollerDeps): Promise<boolean> {
  if (await claimFloor(deps.db, chatId)) return true;
  (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.floor_lost", {
    session_id: view.sessionId,
  }));
  return false;
}

/**
 * The boundary offer, as a prompt key like any other.
 *
 * It IS a question — "a few more questions, or skip?" — and until 2026-09-18 it
 * was the one router message that recorded nothing, so nothing downstream could
 * tell it was on screen. See `sendOptionalOffer`.
 */
export const OPTIONAL_OFFER_PROMPT = "optional_offer";

/**
 * The boundary between the required questions and the optional ones: sent on
 * its own, asking nothing yet, and RECORDED — which is the whole point.
 *
 * Live on 2026-09-18 the offer went out and the first optional question
 * followed it within the same second, so the choice it offers was never
 * actually open. Two things were missing and both are here:
 *
 *  - it recorded no prompt key, so `ui_state.lastPrompt` still named the
 *    question before it and every dedupe downstream compared against that;
 *  - nothing stopped the optional walk, which reads `offeredMore` — set by
 *    this very message — as permission to start.
 */
async function sendOptionalOffer(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
): Promise<boolean> {
  const offer = renderEssentialsDone(view.language);
  if (!(await takeFloor(chatId, view, deps))) return false;
  await clearPendingEntryForChat(deps.db, chatId);
  await markOfferedMoreForChat(deps.db, chatId);
  await recordLastPromptForChat(deps.db, chatId, OPTIONAL_OFFER_PROMPT);
  await deps.telegram.sendMessage({
    chatId, text: offer.text, replyMarkup: offer.replyMarkup ?? undefined,
  });
  (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.step_sent", {
    session_id: view.sessionId, prompt: OPTIONAL_OFFER_PROMPT,
  }));
  return true;
}

/**
 * A CONFIRMATION OF ONE READING, as its own prompt key.
 *
 * "Sounds like that's everything — shall I put your summary together?" is a
 * different message from the offer itself, and the difference has to survive
 * into the next turn: a bare "yes" means nothing at the boundary and
 * everything under a question that named one exit. The intent being confirmed
 * travels in the key (`optional_offer_confirm:finish`), because the alternative
 * is a second piece of state that can disagree with what is on the screen.
 */
export const BOUNDARY_CONFIRM_PROMPT = "optional_offer_confirm";

/**
 * Act, confirm, or ask — the three tiers, as two numbers.
 *
 * The apply floor IS the interpret gate's floor (`DEFAULT_MIN_CONFIDENCE`),
 * and the same argument applies: above it the reading is worth acting on, below it a
 * question costs one message and a wrong move costs the interview. Between
 * `0.4` and `0.7` there is enough to name a guess and ask about it, which is
 * what a person does when they half-heard something. Below `0.4` there is
 * nothing to say except that we did not follow — the behaviour this whole
 * function is layered on top of, and which stays exactly as it was.
 */
export const BOUNDARY_APPLY_CONFIDENCE = DEFAULT_MIN_CONFIDENCE;
export const BOUNDARY_CONFIRM_CONFIDENCE = 0.4;

interface BoundaryScreen {
  /** The one exit a confirmation named, when what is on screen is a confirmation. */
  pendingConfirmation: BoundaryIntent | null;
}

/**
 * Is the boundary the thing the organizer is looking at?
 *
 * Deliberately keyed on the recorded prompt rather than on `offeredMore`, which
 * only says the choice was shown ONCE, at some point. The distinction matters
 * at exactly one place — a session that was offered more, walked its optional
 * questions and arrived at the recap has `offeredMore` true and is being asked
 * something else entirely.
 */
function boundaryOnScreen(view: SessionView): BoundaryScreen | null {
  if (view.nextQuestion || view.pendingAsk) return null;
  if (view.state !== "interviewing") return null;
  const prompt = view.lastPrompt ?? "";
  if (prompt === OPTIONAL_OFFER_PROMPT) return { pendingConfirmation: null };
  if (prompt.startsWith(`${BOUNDARY_CONFIRM_PROMPT}:`)) {
    const named = prompt.slice(BOUNDARY_CONFIRM_PROMPT.length + 1);
    return { pendingConfirmation: named === "finish" || named === "more" ? named : null };
  }
  return null;
}

/** One of the boundary's sentences, with both buttons still under it. */
async function speakBoundary(
  deps: TripBotPollerDeps,
  chatId: string,
  view: SessionView,
  key: string,
  promptKey: string,
): Promise<boolean> {
  const rendered = renderBoundaryAsk(key, view.language);
  if (!(await takeFloor(chatId, view, deps))) return false;
  await recordLastPromptForChat(deps.db, chatId, promptKey);
  await deps.telegram.sendMessage({
    chatId, text: rendered.text, replyMarkup: rendered.replyMarkup ?? undefined,
  });
  (deps.log ?? (() => {}))(structuredLog("info", "interview.boundary_asked", {
    session_id: view.sessionId, prompt: promptKey, copy: key,
  }));
  return true;
}

export type BoundarySettlement =
  /** Said something itself; the caller owes nothing further. */
  | "spoke"
  /** Applied a transition; the caller's ordinary next step renders it. */
  | "moved"
  /** Not the boundary, or nothing certain enough to act on. Restate. */
  | "not_settled";

/**
 * THE BOUNDARY, ANSWERED IN WORDS.
 *
 * Every action offered as a button is also reachable by saying it (Dror,
 * 2026-09-18). Buttons stay the preferred, fast path — they are one tap and
 * they cannot be misread — but they are a shortcut, not the syntax. "No, I
 * think that's everything" has to finish an interview, because that is what a
 * person says when they are finished.
 *
 * What it replaces: "לא", live on 2026-09-10, read as a failure to follow the
 * UI and answered with the same offer under "I didn't quite follow". The
 * organizer had followed it exactly. The fix is not to show the buttons harder.
 *
 * THE DIVISION OF LABOUR is the whole design, and it is the same one the rest
 * of this path uses (`docs/interview-without-an-agent.md` §4):
 *
 *  - The model READS. It is given one message and returns one of four words
 *    with a confidence. It cannot name a question, a state or an answer, and
 *    `parseBoundaryReading` refuses anything outside the four.
 *  - The ROUTER MOVES. `setFinishRequestedForChat` and `askForMoreForChat` are
 *    the same two functions the buttons call — not a parallel path that can
 *    drift from them, and the only things here that touch interview state.
 *
 * ORDER. Anything the message actually said about the trip is captured and
 * acknowledged BEFORE this runs, so "wait, I forgot we also want a day at
 * Disney" is recorded first and the boundary is put back afterwards. Reading
 * it as an exit first would have thrown the sentence away.
 *
 * COST. One extra model call, and only for a typed message while the offer is
 * on screen — never for a tap, never mid-interview. Dror, 2026-09-18: a
 * cleaner contract is worth the second call for now; folding it into the
 * interpret call to save the latency is a later optimisation, not a reason to
 * give the model a pseudo-question to answer.
 */
async function settleBoundary(
  deps: TripBotPollerDeps,
  chatId: string,
  args: { sourceText: string; captured: readonly string[] },
  log: (line: string) => void,
): Promise<BoundarySettlement> {
  const session = await getSessionForChat(deps.db, chatId);
  if (!session.ok) return "not_settled";
  const view = session.view;
  const screen = boundaryOnScreen(view);
  if (!screen) return "not_settled";

  // No runner is the configured downgrade, not an error — and it lands where
  // every other failure here lands: the offer, restated, with its buttons.
  if (!deps.modelRunner) return "not_settled";

  const read = await readBoundaryReply(deps.modelRunner, {
    sourceText: args.sourceText,
    language: view.language,
    captured: args.captured,
    pendingConfirmation: screen.pendingConfirmation,
  });
  if (!read.ok) {
    log(structuredLog("warn", "interview.boundary_read_failed", {
      session_id: view.sessionId, reason: read.reason, attempts: read.attempts, ms: read.ms,
    }));
    return "not_settled";
  }
  const { intent, confidence } = read.reading;
  log(structuredLog("info", "interview.boundary_read", {
    session_id: view.sessionId,
    intent,
    confidence,
    captured: args.captured.length,
    confirming: screen.pendingConfirmation,
    ms: read.ms,
  }));

  // CONFIDENT: the same transition the button makes, made by the same function.
  if ((intent === "finish" || intent === "more") && confidence >= BOUNDARY_APPLY_CONFIDENCE) {
    const moved = intent === "finish"
      ? await setFinishRequestedForChat(deps.db, chatId, true)
      : await askForMoreForChat(deps.db, chatId);
    if (!moved.ok) {
      log(structuredLog("warn", "interview.boundary_move_refused", {
        session_id: view.sessionId, intent, reason: moved.reason,
      }));
      return "not_settled";
    }
    log(structuredLog("info", "interview.boundary_applied", { session_id: view.sessionId, intent }));
    // The floor is deliberately NOT taken here: what the transition produced —
    // the recap, or the next optional question — is sent by the ordinary next
    // step, exactly as it is for a tap.
    return "moved";
  }

  // LEANING ONE WAY. Name the guess and ask about it — one message from where
  // they were going if it was right, one message from the other exit if it was
  // not. Both buttons stay underneath.
  if ((intent === "finish" || intent === "more") && confidence >= BOUNDARY_CONFIRM_CONFIDENCE) {
    return (await speakBoundary(
      deps, chatId, view,
      intent === "finish" ? "confirmFinish" : "confirmMore",
      `${BOUNDARY_CONFIRM_PROMPT}:${intent}`,
    )) ? "spoke" : "not_settled";
  }

  // THEY ADDED SOMETHING, and said nothing about which way to go. It is on
  // record and was just read back to them; the choice is simply still open, so
  // it is asked again SHORT. Nothing here suggests they failed to follow
  // anything, because they did not — which is why this is keyed on what was
  // CAPTURED rather than on the reading alone. Whatever the model made of the
  // sentence, a detail landing from it means they were understood.
  if (args.captured.length > 0) {
    return (await speakBoundary(deps, chatId, view, "moreOrSummary", OPTIONAL_OFFER_PROMPT))
      ? "spoke" : "not_settled";
  }

  // GENUINELY TWO-SIDED. Ask which, plainly, and without blaming them for it.
  if (intent === "unclear" && confidence >= BOUNDARY_CONFIRM_CONFIDENCE) {
    return (await speakBoundary(deps, chatId, view, "notSureMoreOrDone", OPTIONAL_OFFER_PROMPT))
      ? "spoke" : "not_settled";
  }

  // Not sure enough even to guess: the old behaviour, unchanged. "I didn't
  // quite follow" is the honest thing to say when nothing was understood and
  // nothing was recorded — it is only wrong when it is said to someone who was
  // understood perfectly well.
  return "not_settled";
}

/**
 * What was put in front of the organizer, as `ui_state.last_prompt` records it —
 * the key the dedupe in `sendNextStep` compares against. Two messages that read
 * differently must never share one, or the second is swallowed as a repeat of
 * the first while the organizer is left looking at the first.
 *
 * So the key carries what makes an ask different, not only which question:
 *  - what it is ABOUT (`subjects`): the dietary scope is one question asked once
 *    per ticked need. On 2026-09-16 kosher and vegetarian were ticked, Everyone
 *    was tapped for kosher, and the ask about vegetarian was deduped away — the
 *    bot waited for an answer to a question it never sent.
 *  - an answer on record that did not settle it (`unsettled`): asking again is
 *    "“X” doesn't match anyone on the list", the one reply the organizer needs.
 */
export function routerPromptKey(
  view: Pick<SessionView, "state" | "subjects" | "unsettled">,
  question: IntakeQuestion | null,
): string {
  if (view.state === "awaiting_confirmation") return "recap";
  if (!question) return "";
  const subject = view.subjects?.[question.id];
  const unsettled = view.unsettled?.[question.id];
  return `q:${question.id}${subject ? `:about:${subject.optionId}` : ""}${unsettled ? `:unsettled:${unsettled}` : ""}`;
}

// ── A step Telegram did not take (#225 item 9) ─────────────────────────────────
//
// The router names what it is about to put on screen (`lastPrompt`) and claims
// the floor BEFORE it sends - see `deliverStep`. The real client does not throw
// when Telegram refuses a message, it returns `ok: false`, and nothing read that:
// a question or the summary that never arrived stayed named as on screen, so the
// dedupe suppressed it, and the floor stayed with the organizer, so nothing
// re-sent it. The organizer saw nothing, and the interview never tried again.
//
// WHAT RE-SENDS IT. Not the stall watchdog (`recoverStalledInterviews`): that
// claims only a session with an OPEN AGENT TURN, and the interpret path - every
// new session - opens none. What moves an interpret-path interview on a tick is
// `advanceRouterOwnedQuestions`, which calls `sendNextStep` for every session
// awaiting the machine with something to ask - every 700 ms, and only while
// `state = 'interviewing'`, so never for the summary. Handing the floor back is
// therefore necessary and not sufficient: at 700 ms it would hammer a chat
// Telegram is rate-limiting, repeat a refusal forever, and still never re-send a
// refused summary. So a failed step is also written down here, and:
//  - `sendNextStep` stays quiet for that chat until the backoff has passed
//    (2 s, doubling, at most 60 s);
//  - `retryFailedSteps`, on the deliver tick, re-runs `sendNextStep` once it has
//    - whatever the state, so the summary too;
//  - after STEP_RETRY_MAX_ATTEMPTS failures in a row (about three minutes) it
//    stops, and the floor stays with the organizer: their next message - any
//    message, or a tap - tries afresh;
//  - a PERMANENT refusal (a 400: this content, which Telegram will refuse again)
//    is never retried automatically, for the same reason. It is named and
//    un-named like the rest, so the organizer's next message tries once more
//    rather than being deduped into silence.
// Per Telegram client, i.e. per relay process: a restart forgets the backoff,
// not the floor, so an interviewing session is picked up by the tick scan.

interface StepRetry { attempts: number; notBefore: number }
const stepRetries = new WeakMap<TelegramClient, Map<string, StepRetry>>();
function stepRetriesFor(deps: TripBotPollerDeps): Map<string, StepRetry> {
  let retries = stepRetries.get(deps.telegram);
  if (!retries) {
    retries = new Map();
    stepRetries.set(deps.telegram, retries);
  }
  return retries;
}

/** Transient failures in a row before a step is left to the organizer's next message. */
export const STEP_RETRY_MAX_ATTEMPTS = 8;
const STEP_RETRY_BASE_MS = 2_000;
const STEP_RETRY_MAX_MS = 60_000;
let stepRetryBaseMs = STEP_RETRY_BASE_MS;
/** Tests only: a backoff a suite can wait out. Call with no argument to restore. */
export function setStepRetryBaseMsForTests(ms: number = STEP_RETRY_BASE_MS): void {
  stepRetryBaseMs = ms;
}
function stepRetryDelayMs(attempts: number): number {
  return Math.min(stepRetryBaseMs * 2 ** (attempts - 1), STEP_RETRY_MAX_MS);
}

/**
 * Sends one router step - a question, the summary, a disagreement - named as on
 * screen BEFORE it goes out, and un-named if Telegram did not take it. Returns
 * whether it was delivered.
 *
 * RECORDED BEFORE IT IS SENT, and the gap is the reason. `sendMessage` is a round
 * trip to Telegram - hundreds of milliseconds in which the floor is ours but
 * nothing says what we are saying. A tap handled in that window loses the floor,
 * sees an unchanged `lastPrompt`, concludes nobody spoke, takes the floor back and
 * sends the same question again. That is "I had some duplication" on 2026-09-18:
 * `trip_interests` and `trip_pace` both went out twice, each pair straight after
 * a `floor_lost`. Recording first makes the pair "floor claimed, prompt named" as
 * close to one moment as two statements get, so the loser can tell the two cases
 * apart - see `respond`.
 *
 * The caller has already taken the floor. A step that did not arrive is handed to
 * `stepNotDelivered`, which decides whether and when it is tried again.
 */
async function deliverStep(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
  promptKey: string,
  message: { text: string; replyMarkup?: InlineKeyboard },
): Promise<boolean> {
  const previousPrompt = view.lastPrompt ?? "";
  if (promptKey) await recordLastPromptForChat(deps.db, chatId, promptKey);
  let sent: SendResult | undefined;
  try {
    sent = await deps.telegram.sendMessage({ chatId, text: message.text, replyMarkup: message.replyMarkup });
  } catch (error) {
    await stepNotDelivered(view, chatId, deps, promptKey, previousPrompt, false);
    throw error;
  }
  if (sent?.ok) {
    stepRetriesFor(deps).delete(chatId);
    return true;
  }
  await stepNotDelivered(view, chatId, deps, promptKey, previousPrompt, isPermanentRefusal(sent));
  return false;
}

/**
 * A step Telegram did not take: un-name it, and either leave it to the step retry
 * (transient) or to the organizer's next message (permanent, or retried enough).
 *
 * Only while nobody has spoken since: `lastPrompt` still naming this step means
 * the floor and the screen are as this send left them. Otherwise another speaker
 * has put something on screen, and it is theirs.
 */
async function stepNotDelivered(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
  promptKey: string,
  previousPrompt: string,
  permanent: boolean,
): Promise<void> {
  const log = deps.log ?? (() => {});
  const retries = stepRetriesFor(deps);
  // The key's first two parts only: a question key can carry an unsettled answer's text after them.
  const prompt = promptKey ? promptKey.split(":").slice(0, 2).join(":") : null;
  const now = await getSessionForChat(deps.db, chatId);
  const ours = now.ok && (promptKey ? now.view.lastPrompt === promptKey : now.view.awaiting === "person");
  if (!ours) {
    log(structuredLog("warn", "trip_bot.step_send_failed", {
      session_id: view.sessionId, prompt, permanent, retry: false, reason: "SPOKEN_SINCE",
    }));
    return;
  }
  if (promptKey) await recordLastPromptForChat(deps.db, chatId, previousPrompt);
  if (permanent) {
    retries.delete(chatId);
    log(structuredLog("warn", "trip_bot.step_send_failed", { session_id: view.sessionId, prompt, permanent, retry: false }));
    return;
  }
  const attempts = (retries.get(chatId)?.attempts ?? 0) + 1;
  if (attempts >= STEP_RETRY_MAX_ATTEMPTS) {
    retries.delete(chatId);
    log(structuredLog("error", "trip_bot.step_send_abandoned", { session_id: view.sessionId, prompt, attempts }));
    return;
  }
  const delay = stepRetryDelayMs(attempts);
  retries.set(chatId, { attempts, notBefore: Date.now() + delay });
  // The machine owes this message again - which is what `awaiting = 'machine'`
  // says, to every speaker and to the tick scan.
  await markAwaitingMachine(deps.db, chatId);
  log(structuredLog("warn", "trip_bot.step_send_failed", {
    session_id: view.sessionId, prompt, permanent, retry: true, attempt: attempts, retry_in_ms: delay,
  }));
}

/**
 * Re-runs `sendNextStep` for every chat whose last step failed and whose backoff
 * has passed. On the deliver tick, beside the scans; exported for the tests, which
 * pass a `now` rather than waiting a real backoff out.
 */
export async function retryFailedSteps(
  deps: TripBotPollerDeps,
  strings: DispatchStrings,
  log: (line: string) => void,
  now: number = Date.now(),
): Promise<void> {
  const retries = stepRetriesFor(deps);
  for (const [chatId, entry] of [...retries]) {
    if (entry.notBefore > now) continue;
    try {
      const result = await getSessionForChat(deps.db, chatId);
      if (!result.ok) {
        retries.delete(chatId);
        continue;
      }
      // Due: `sendNextStep` lets it through. A failure replaces the entry.
      entry.notBefore = 0;
      await sendNextStep(result.view, chatId, deps, strings);
      // Nothing new recorded against it - sent, or nothing left to say: done.
      if (retries.get(chatId) === entry) retries.delete(chatId);
    } catch {
      log(structuredLog("warn", "trip_bot.step_retry_failed", {}));
    }
  }
}

/**
 * Exported for the transcript tests: the live failure is a STALE view reaching
 * this function, which a test can only reproduce by handing it one.
 *
 * Returns true when the next step is taken care of: sent, or owed to the step
 * retry (a send Telegram did not take, or one waiting out its backoff) - in
 * which case nobody else may speak for it now. False when nothing was said and
 * nothing is owed by this call.
 */
export async function sendNextStep(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
  _strings: DispatchStrings,
): Promise<boolean> {
  let text: string;
  let replyMarkup: InlineKeyboard | undefined;
  let askedNomination: string | null = null;

  // THE FLOOR. Nothing is sent while it is the organizer's turn — that is a
  // conversation waiting on a human, not a fault. Run 7 got most questions
  // twice because the router and the interviewer each decided independently
  // that something was owed; this is the single fact that arbitrates them.
  if (view.awaiting === "person") {
    (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.floor_held_by_person", {
      session_id: view.sessionId,
    }));
    return false;
  }

  // A STEP FOR THIS CHAT FAILED AND IS WAITING OUT ITS BACKOFF (#225 item 9).
  // `retryFailedSteps` sends it when the wait is over; speaking now would be the
  // hammering the backoff exists to prevent, and a `false` here would invite a
  // caller to fill the gap with "I didn't follow". Silent: the tick asks every
  // 700 ms.
  const owed = stepRetriesFor(deps).get(chatId);
  if (owed && owed.notBefore > Date.now()) return true;

  // A DOCUMENT IS WAITING TO BE READ. Say nothing until it has been.
  //
  // The answer may be in the file, and asking for it first is the thing this
  // whole feature exists to stop. Checked here because every router message
  // comes through this function — `advanceRouterOwnedQuestions` reaches it by
  // scanning for chats awaiting the machine, which an upload sets, and it
  // asked the trip type in the two seconds between the file landing and the
  // burst settling.
  //
  // INTERPRET PATH ONLY, and Track 8 is why: on the AGENT path asking a
  // router-owned question while the agent reads a document is deliberate —
  // the two work in parallel and the test calls it "the original motivating
  // case". It is only wrong here, where the extraction about to run is what
  // answers those same questions.
  const onInterpretPath = await isInterpretPath(deps.db, chatId);
  if (onInterpretPath && (await hasPendingInbound(deps.db, chatId))) {
    (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.held_for_inbound", {
      session_id: view.sessionId,
    }));
    return false;
  }
  // AND WHILE IT IS ACTUALLY BEING READ. The check above covers the queue, and
  // its own note assumed that was enough. It is not: the scan fires on a
  // session merely awaiting the machine once the document floor has passed,
  // and the read outlasts that floor by minutes. So the router asked the trip
  // type in the middle of reading a document that answers it — and the answer
  // given by hand then made the document's own proposal ALREADY_ANSWERED.
  if (onInterpretPath && (await isReadingDocument(deps.db, chatId))) {
    (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.held_for_document_read", {
      session_id: view.sessionId,
    }));
    return false;
  }

  // A DISAGREEMENT BETWEEN DOCUMENTS, waiting on the organizer — asked before
  // anything new, because it is about something they have already been shown
  // and it is cheapest to settle while the document is fresh in their mind. It
  // never blocks anything: the held value stands until they answer, and an
  // unanswered disagreement stops neither the interview nor confirmation.
  //
  // Re-enabled as part of the same step that added the four b2e3051
  // migrations (control_plane.trip_answer_conflicts now exists) — see the
  // #145 forward-port note on `askOpenConflict` for why this was held back.
  if (await askOpenConflict(view, chatId, deps)) return true;

  // THE BOUNDARY. Nothing required left to ask, but a required answer is still
  // missing — one that stepped aside after a reply did not answer it. Bring the
  // set-aside questions back, and say why they are back, BEFORE anything
  // optional and before the summary: this is the point where it actually
  // blocks something, so "I still need this" informs rather than pesters.
  //
  // HERE, and not on the typed-message path where it used to live, because
  // every router message comes through this function. On 2026-09-11 the
  // automated full cycle's stops were read with LOW_CONFIDENCE and stepped
  // aside; the last required question was then answered with a TAP, which
  // never passed the typed path's check — so the router walked on to the
  // optional questions, and "Finished" produced nothing at all, because the
  // summary cannot open with a required answer missing. A person would have
  // been stuck in front of a button that did nothing.
  if (view.state === "interviewing" && !view.nextQuestion) {
    const store = await answersForChat(deps.db, chatId);
    const missing = store ? deferredRequired(store.answers) : [];
    if (missing.length > 0) {
      await undeferAllForChat(deps.db, chatId);
      (deps.log ?? (() => {}))(structuredLog("info", "interview.required_raised_at_boundary", {
        session_id: view.sessionId,
        missing: missing.map((q) => q.id),
      }));
      const back = await getSessionForChat(deps.db, chatId);
      const question = (back.ok ? back.view.nextQuestion : null) ?? missing[0]!;
      if (!(await takeFloor(chatId, view, deps))) return false;
      const rendered = renderStep(question, view);
      // Named before it is sent, for the reason given at the end of this
      // function (`deliverStep`): what is on screen has to be readable by a
      // racing pass while this one is still waiting on Telegram - and un-named
      // again if Telegram did not take it.
      await deliverStep(view, chatId, deps, `q:${question.id}`, {
        text: `${uiString("beforeWeFinish", view.language)}\n\n${rendered.text}`,
        replyMarkup: rendered.replyMarkup ?? undefined,
      });
      return true;
    }
  }

  // What there is to ask, worked out BEFORE the say is handled — because
  // whether the say goes out alone depends on it. See the fold below.
  // WHO WALKS THE OPTIONAL QUESTIONS.
  //
  // `!deps.interviewerProfile` is the agent-era rule: if an interviewer exists,
  // it nominates which optional question is worth asking and the router must
  // not walk them itself. Correct then, and silently wrong now — the relay
  // still has `relay.interviewer_profile` configured, so on the interpret path
  // this evaluated false and the built-in walk was OFF. That is why a skip
  // recorded the answer and said nothing: `question` came out null and there
  // was nothing left to send.
  //
  // On the interpret path there is no agent to nominate, so the router walks
  // them — through THIS path, which already has the dedupe, the prompt key,
  // the flood guard and the logging. An earlier fix added a second walk of its
  // own further down; a second implementation of a thing that already exists
  // is how the two disagree, and it has been removed.
  const autoWalkOptional = !deps.interviewerProfile || onInterpretPath;

  // THE OFFER IS OUTSTANDING, so the walk has not been agreed to yet.
  //
  // `offeredMore` means "they have been shown the choice", and the optional
  // walk below reads it as "they may be asked optional questions" — which was
  // the same thing only while the offer travelled folded on top of the first
  // optional question. Sent on its own it is a question awaiting an answer, and
  // on 2026-09-18 the walk ran anyway: the offer and `bot_proactive` arrived
  // together, so "a few more questions" and "skip" were being offered about a
  // question already on screen.
  //
  // Answered by a TAP, which is why neither exit is blocked here: "a few more
  // questions" nominates the first optional question (`pendingAsk`, checked
  // above this gate), and "skip" asks to finish, which makes the recap due.
  // Typed at instead, `settleBoundary` reads which exit they meant and moves
  // through those same two functions; when it cannot, `restateExpectation`
  // puts the offer back with its buttons.
  //
  // `boundaryOnScreen` rather than the offer's own key, because a CONFIRMATION
  // of a reading ("shall I put your summary together?") leaves the choice just
  // as open. Without it the walk would ask an optional question on top of a
  // question the organizer is in the middle of answering.
  const offerOutstanding = onInterpretPath && boundaryOnScreen(view) !== null;

  const question =
    view.nextQuestion
    ?? view.pendingAsk
    ?? (offerOutstanding
      ? null
      : nextRouterOwnedQuestion(view)
        ?? (autoWalkOptional && view.state === "interviewing" ? view.optionalRemaining[0] ?? null : null));

  // Every agent write asks the router to speak. An agent that recorded five
  // answers off one document therefore asked five times, and the organizer got
  // the same question five times over. Saying nothing when there is nothing
  // new to say is the whole fix.
  // With the offer outstanding, what is on their screen IS the prompt — so the
  // dedupe below recognises it, says nothing, and hands the floor back rather
  // than leaving the session owing a message it will never send. Read off the
  // session rather than fixed to the offer's key: the message on screen may be
  // a confirmation of one exit, and the dedupe has to recognise that too or the
  // session sits `awaiting = machine` with nothing to say, which is the busy
  // loop this branch exists to end.
  const promptKey = offerOutstanding
    ? view.lastPrompt ?? OPTIONAL_OFFER_PROMPT
    : routerPromptKey(view, question);
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
      if (!(await takeFloor(chatId, view, deps))) return false;
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
      return true;
    }
  }

  if (promptKey && promptKey === view.lastPrompt) {
    (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.prompt_deduped", {
      session_id: view.sessionId,
      prompt: promptKey,
    }));
    // THE QUESTION IS ALREADY ON THEIR SCREEN, so the turn is theirs.
    //
    // Returning while still holding the floor left the session `awaiting =
    // machine` with nothing to say, and the tick scan — which looks for exactly
    // that — picked it up again every couple of seconds and deduped again,
    // forever. A busy loop that logs, on the interpret path only, because that
    // scan does not reach these sessions on the agent path.
    //
    // Handing the floor back is also just true: we asked, they have not
    // answered, we are waiting on them.
    if (onInterpretPath) await claimFloor(deps.db, chatId);
    return false;
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
      return sendOptionalOffer(view, chatId, deps);
    }
    // The last answer and the state it produces are not one write, so the view
    // that reaches here can be a moment too old: on 2026-09-18 an organizer
    // skipped the final optional question, this branch saw "nothing to ask,
    // not confirmable yet" and handed back, and the session became
    // `awaiting_confirmation` immediately afterwards — with its due flag
    // already spent. The recap sat there owed, and the interview looked to
    // them like it had simply stopped after the last question. `/done`
    // produced it instantly, which is the tell: it was never missing, only
    // unasked-for. So read once more before going quiet.
    const settled = await getSessionForChat(deps.db, chatId);
    if (settled.ok && settled.view.state === "awaiting_confirmation") {
      return sendNextStep(settled.view, chatId, deps, _strings);
    }
    // After that it is the interviewer's conversation to carry. Saying
    // something anyway is how the router ended up talking over it.
    await handBackToInterviewer(view, chatId, deps);
    return false;
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
    const rendered = renderStep(question, view, phrasing);
    // THE BOUNDARY, SAID WHERE IT IS. On the interpret path the router walks the
    // optional questions itself, so the first of them is where the boundary
    // falls — it used to wait for `!question` below, which on this path means
    // every optional question has already been asked: live on 2026-09-16 it
    // arrived last, right before the summary, and both of its buttons led to
    // the summary.
    // Interpret path only: with an interviewer, the agent nominates the optional
    // questions and the boundary message below is still the router's one offer.
    const announcesOptional = onInterpretPath && !question.required && view.state === "interviewing" && !view.nextQuestion
      && (view.pendingEntry === "optional" || (view.pendingEntry === null && !view.offeredMore));
    if (announcesOptional) {
      // THE BOUNDARY IS ITS OWN MESSAGE, and it asks nothing yet. Folding it
      // above the first optional question meant the only buttons on screen
      // were that question's — "Skip this one" and "Finished" — so the choice
      // an organizer was actually being offered (do you want the optional
      // questions at all?) could only be answered by a button that says the
      // interview is over. Dror, 2026-09-18: it should read "more questions"
      // or "skip".
      //
      // Tapping "a few more questions" nominates the first optional question
      // and the router asks it on the next turn; "Skip" declines them and goes
      // to the recap. Either way the question below is not asked here — and
      // `offerOutstanding` above is what keeps it unasked until they choose.
      return sendOptionalOffer(view, chatId, deps);
    }
    text = rendered.text;
    replyMarkup = rendered.replyMarkup ?? undefined;
    // The nomination is spent once it has been ASKED - cleared below, after the
    // send, not here: a send Telegram did not take has asked nothing, and the
    // retry has to find the same question to ask (#225 item 9).
    askedNomination = view.pendingAsk?.id === question.id ? question.id : null;
  } else {
    // `interviewing` always has a next question now — required ones first,
    // then optional ones not yet answered or skipped — and every other state
    // is handled above, so this stays unreachable.
    text = "Thanks — noted.";
  }

  // The question or the recap. Claimed last, immediately before it goes out,
  // so a slow render cannot leave the floor held by a message nobody sent.
  if (!(await takeFloor(chatId, view, deps))) return false;
  // Named before it is sent and un-named if it did not arrive - `deliverStep`
  // says why. Not delivered is still `true`: the step is owed to the step retry,
  // or (refused for good) to the organizer's next message, and a caller that
  // read `false` as "nothing was said" would say "I didn't follow" over it.
  if (!(await deliverStep(view, chatId, deps, promptKey, { text, replyMarkup }))) return true;
  if (askedNomination) {
    // Only if it is still THIS nomination: one made while the send was in
    // flight is a new one, and is not ours to clear.
    const after = await getSessionForChat(deps.db, chatId);
    if (after.ok && after.view.pendingAsk?.id === askedNomination) await clearPendingAskForChat(deps.db, chatId);
  }
  // WHICH question went out. "Several questions came twice" (2026-09-16) could
  // not be traced to any one of them: the log said a prompt was sent, never
  // which, and nothing else keeps the conversation. The key only — no text.
  (deps.log ?? (() => {}))(structuredLog("info", "trip_bot.step_sent", {
    session_id: view.sessionId,
    prompt: promptKey || null,
  }));
  return true;
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
  const pendingAttachments = deps.pendingAttachments ?? new PendingAttachments();
  // Same lifetime as the attachments beside it: per relay process, so it
  // survives updates and is forgotten on restart.
  const groupContext = deps.groupContext ?? new GroupContext();

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
        // WHAT TELEGRAM ACTUALLY HANDED US, before anything interprets it.
        //
        // Three times running an organizer reported sending a PDF and the relay
        // saw only text. Every downstream stage logs its own failure — a failed
        // re-host warns, a failed dispatch errors — and all of them were
        // silent, which left "the file never arrived" and "we dropped it
        // somewhere before the first log line" indistinguishable. They are not
        // the same problem and they have different fixes, so the earliest
        // possible point says what it received.
        //
        // Shape only: which fields are present and how big. No text, no
        // filenames, no chat id — this runs on every message of every
        // interview, and a diagnostic that logs content is a diagnostic that
        // has to be turned off again.
        {
          const m = (update as { message?: Record<string, unknown> }).message;
          if (m) {
            log(structuredLog("info", "trip_bot.update_shape", {
              has_text: typeof m.text === "string",
              has_caption: typeof m.caption === "string",
              has_document: Boolean(m.document),
              has_photo: Array.isArray(m.photo) && m.photo.length > 0,
              has_video: Boolean(m.video),
              has_audio: Boolean(m.audio) || Boolean(m.voice),
              text_len: typeof m.text === "string" ? m.text.length : 0,
              doc_size: (m.document as { file_size?: number } | undefined)?.file_size ?? 0,
              doc_mime: (m.document as { mime_type?: string } | undefined)?.mime_type ?? null,
            }));
          }
        }
        try {
          const decision = await dispatchUpdate(deps.db, update, strings, log, deps.botIdentity ?? {}, {
            interviewerProfile: deps.interviewerProfile,
            media: deps.media,
            pendingAttachments,
            groupContext,
            ...(deps.superAdminSubjectDigest ? { superAdminSubjectDigest: deps.superAdminSubjectDigest } : {}),
            ...(deps.modelRunner ? { modelRunner: deps.modelRunner } : {}),
            // Descriptors only when something will record them (#177).
            ...(deps.assistantEvents ? { assistantEvents: true } : {}),
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
        // A question or summary Telegram did not take, once its backoff has
        // passed (#225 item 9) - the scans above never re-send a summary.
        await retryFailedSteps(deps, strings, log);
        await recoverStalledInterviews(deps, strings, log);
        await closeIdleInterviews(deps, log);
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
