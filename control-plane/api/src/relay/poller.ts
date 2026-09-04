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
  claimDueRouterPrompts,
  openAgentTurn,
  submitAnswerForChat,
  type SessionView,
  askForMoreForChat,
  clearPendingAskForChat,
  hasOpenAgentTurn,
  markOfferedMoreForChat,
  recordLastPromptForChat,
  selectedOptionIds,
  setFinishRequestedForChat,
  skipQuestionForChat,
  toggleMultiChoiceForChat,
} from "../interview.js";
import { digestTelegramId } from "../identity.js";
import { resolveTelegramCallbackRef } from "../adapters/telegram.js";
import { processApprovalCallback, type SignupConfig } from "../signup.js";
import type { MediaDeps } from "./normalize.js";
import { DEFAULT_LANGUAGE, uiString } from "../intake-copy.js";
import { structuredLog } from "../redaction.js";
import {
  dispatchUpdate,
  DEFAULT_STRINGS,
  type BotIdentity,
  type DispatchDecision,
  type DispatchStrings,
} from "./dispatch.js";
import { toWireEvent, type TelegramUpdate } from "./normalize.js";
import type { WireMessageEvent } from "./protocol.js";
import type { TelegramClient } from "./telegram-api.js";

/** Just the part of RelayConnector this needs, so tests need no socket. */
export interface InboundSink {
  pushInbound(event: WireMessageEvent): boolean;
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
  /** Cap on the backoff applied after a poll that looks like a failure. */
  maxBackoffMs?: number;
}

const DEFAULT_LONG_POLL_SECONDS = 25;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

// ── Acting on one decision ───────────────────────────────────────────────────

/**
 * Performs the I/O for one dispatch decision.
 *
 * Exported so the whole decision→effect table can be exercised against a fake
 * Telegram client, with no loop and no network.
 */
export async function applyDecision(
  decision: DispatchDecision,
  deps: TripBotPollerDeps,
): Promise<void> {
  const strings = deps.strings ?? DEFAULT_STRINGS;
  const log = deps.log ?? (() => {});

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
      // it. Requested during the 2026-09-04 run 3.
      if ((decision.event.media_urls?.length ?? 0) > 0) {
        const view = await getSessionForChat(deps.db, decision.chatId);
        await deps.telegram.sendMessage({
          chatId: decision.chatId,
          text: uiString("fileReceived", view.ok ? view.view.language : DEFAULT_LANGUAGE),
        });
      }
      // The turn opens BEFORE the event goes out. The agent may call back the
      // moment it is handed the turn, so a turn opened afterwards could arrive
      // second and the write would be refused for a turn that genuinely is in
      // flight.
      const turn = await openAgentTurn(deps.db, decision.chatId, decision.sessionId);
      const delivered = deps.connector.pushInbound(decision.event);
      if (delivered) {
        log(structuredLog("info", "trip_bot.interview_forwarded", {
          session_id: decision.sessionId,
          turn_id: turn.id,
        }));
        return;
      }
      // Nothing queues, so the turn this opened will never be used. Closing it
      // rather than letting it lapse means the next forward is the only open
      // one at every instant, instead of racing a five-minute ghost.
      await closeAgentTurn(deps.db, decision.chatId);
      log(structuredLog("warn", "trip_bot.turn_lost", { reason: "GATEWAY_UNAVAILABLE" }));
      await deps.telegram.sendMessage({
        chatId: decision.chatId,
        text: strings.gatewayUnavailable,
      });
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
    const view = await (async () => {
      if (parsed.kind === "skip") {
        return skipQuestionForChat(deps.db, decision.chatId, parsed.questionId);
      }
      const current = await getSessionForChat(deps.db, decision.chatId);
      if (current.ok && selectedOptionIds(current.view, parsed.questionId).length === 0) {
        return skipQuestionForChat(deps.db, decision.chatId, parsed.questionId);
      }
      return current;
    })();
    if (!view.ok) {
      await ack("I couldn't do that — try again.");
      return;
    }
    await ack();
    await sendNextStep(view.view, decision.chatId, deps, strings);
    return;
  }

  if (parsed.kind === "no_document") {
    // Nothing to record — the offer was a courtesy, and declining it just
    // starts the questions.
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
async function renderDueRouterPrompts(
  deps: TripBotPollerDeps,
  strings: DispatchStrings,
  log: (line: string) => void,
): Promise<void> {
  let due: Array<{ sessionId: string; chatId: string }>;
  try {
    due = await claimDueRouterPrompts(deps.db);
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

  const autoWalkOptional = !deps.interviewerProfile;
  const question =
    view.nextQuestion
    ?? view.pendingAsk
    ?? (autoWalkOptional && view.state === "interviewing" ? view.optionalRemaining[0] ?? null : null);

  // Every agent write asks the router to speak. An agent that recorded five
  // answers off one document therefore asked five times, and the organizer got
  // the same question five times over. Saying nothing when there is nothing
  // new to say is the whole fix.
  const promptKey = view.state === "awaiting_confirmation" ? "recap" : question ? `q:${question.id}` : "";
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
    if (!view.offeredMore) {
      const rendered = renderEssentialsDone(view.language);
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
    const rendered = renderQuestion(question, selectedOptionIds(view, question.id), view.language);
    text = rendered.text;
    replyMarkup = rendered.replyMarkup ?? undefined;
    if (view.pendingAsk?.id === question.id) await clearPendingAskForChat(deps.db, chatId);
  } else {
    // `interviewing` always has a next question now — required ones first,
    // then optional ones not yet answered or skipped — and every other state
    // is handled above, so this stays unreachable.
    text = "Thanks — noted.";
  }

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
        allowedUpdates: ["message", "callback_query"],
      });
      const elapsed = Date.now() - startedAt;

      // Render anything the agent handed back. This runs every tick rather
      // than only after an update, because the write that owes a prompt
      // happens out-of-band: the agent calls the control-plane API directly,
      // and this loop is the only process holding the bot connection.
      await renderDueRouterPrompts(deps, strings, log);

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

  void run().catch((error) => {
    log(structuredLog("error", "trip_bot.poll_loop_crashed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
  });

  return () => {
    stopped = true;
  };
}
