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
  renderQuestion,
  type InlineKeyboard,
} from "../chat-router.js";
import {
  confirmIntakeForChat,
  getSessionForChat,
  submitAnswerForChat,
  type SessionView,
} from "../interview.js";
import { digestTelegramId } from "../identity.js";
import { resolveTelegramCallbackRef } from "../adapters/telegram.js";
import { processApprovalCallback, type SignupConfig } from "../signup.js";
import { structuredLog } from "../redaction.js";
import {
  dispatchUpdate,
  DEFAULT_STRINGS,
  type BotIdentity,
  type DispatchDecision,
  type DispatchStrings,
} from "./dispatch.js";
import type { TelegramUpdate } from "./normalize.js";
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

    case "interview_callback":
      await applyInterviewCallback(decision, deps, strings, log);
      return;

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
    // A multi_choice tap carries ONE option, but the answer is the whole set —
    // recording a single tap would silently discard every other selection
    // (someone both kosher and lactose-intolerant would end up with one of the
    // two). Accumulating a selection needs a per-chat draft and a Done button;
    // until that exists, refusing is the only non-lossy option. Nothing renders
    // a multi_choice keyboard today, so this is a guard, not a live path.
    if (question.type === "multi_choice") {
      log(structuredLog("warn", "trip_bot.multi_choice_tap_refused", { question_id: question.id }));
      await ack("Multi-select isn't ready yet.");
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
    await ack();
    // Deliberately does not walk into the optional questions. The next ones in
    // line are multi_choice (dietary, bot_proactive), which cannot be answered
    // by a single tap — see the refusal above. Offering a question that cannot
    // be answered correctly would be worse than an open invitation.
    await deps.telegram.sendMessage({
      chatId: decision.chatId,
      text: "Sure — tell me what you'd like to change and we'll go from there.",
    });
    return;
  }

  await ack();
  log(structuredLog("info", "trip_bot.unknown_callback", { session_id: decision.sessionId }));
}

/**
 * Sends whatever comes after an answer lands: the next question, or the
 * confirm prompt once every required question is answered.
 */
async function sendNextStep(
  view: SessionView,
  chatId: string,
  deps: TripBotPollerDeps,
  _strings: DispatchStrings,
): Promise<void> {
  let text: string;
  let replyMarkup: InlineKeyboard | undefined;

  if (view.state === "awaiting_confirmation") {
    const recap = (view.recap ?? [])
      .map((entry) => `• ${entry.prompt}\n  ${entry.answerLabel}`)
      .join("\n");
    const rendered = renderConfirmPrompt(
      `Here's what I have:\n\n${recap}\n\nConfirm to lock this in, or keep planning to change something.`,
    );
    text = rendered.text;
    replyMarkup = rendered.replyMarkup ?? undefined;
  } else if (view.nextQuestion) {
    const rendered = renderQuestion(view.nextQuestion);
    text = rendered.text;
    replyMarkup = rendered.replyMarkup ?? undefined;
  } else {
    // deriveSessionState only reports `interviewing` while a required question
    // is unanswered, so this is unreachable rather than merely unlikely.
    text = "Thanks — noted.";
  }

  await deps.telegram.sendMessage({ chatId, text, replyMarkup });
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
          const decision = await dispatchUpdate(deps.db, update, strings, log, deps.botIdentity ?? {});
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
