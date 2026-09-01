/**
 * Trip Bot router — the deterministic layer.
 *
 * Sprint 5's goal is one shared Telegram bot serving every trip without a
 * per-trip bot. The load-bearing rule, stated in the sprint plan and again in
 * Hermes's own relay-connector contract, is that **the model and the message
 * never choose the trip**. Every routing decision in this module is derived
 * from the chat id the router read off its own authenticated Telegram
 * connection, plus rows this control plane wrote itself. Message text is used
 * for exactly one thing — recognising `/start <token>` — and that token is
 * then verified server-side against a single-use, expiring, owner-scoped
 * enrollment before it grants anything.
 *
 * Nothing here talks to Telegram or to an LLM. It decides; the caller acts.
 * That split is what lets the routing rules be tested without a bot token, a
 * network, or a running agent.
 *
 * What this module deliberately does NOT do yet: hand a conversational turn
 * to Hermes. Who owns the Telegram socket in the end — this router, or a
 * relay connector Hermes dials out to — is an open decision recorded in
 * docs/sprint5-trip-bot-router-design.md. The decisions below are the same
 * either way, which is why they are built first.
 */
import type pg from "pg";
import { INTAKE_QUESTIONS, startSession, type IntakeQuestion, type SessionView } from "./interview.js";
import { structuredLog } from "./redaction.js";

// ── Inbound text ─────────────────────────────────────────────────────────────

export type ParsedInbound =
  | { kind: "start"; payload: string | null }
  | { kind: "command"; name: string }
  | { kind: "text"; text: string };

// Telegram addresses a command to a specific bot in group chats by appending
// @botusername. This only needs to strip that suffix, not validate it.
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,32})?(?:\s+([\s\S]*))?$/;

// Telegram's deep-link payload alphabet is A-Z a-z 0-9 _ - and at most 64
// characters. An enrollment token is base64url of 32 random bytes (43 chars),
// so it fits with room to spare. Anything outside this shape is not a token
// this system ever issued, so it is rejected before it reaches a database
// lookup rather than after.
const START_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// A Telegram group/supergroup chat id is negative; a private 1:1 chat id is a
// positive integer. interview.ts records a chat binding only for the private
// shape, so this must be checked BEFORE the enrollment is consumed — see
// startFromDeepLink.
const PRIVATE_CHAT_ID_PATTERN = /^\d{1,20}$/;

/**
 * Classifies one inbound message body. Returns a `start` with a null payload
 * for a bare `/start` — that is a real case (the user tapped the bot's Start
 * button instead of following a deep link) and it needs a different reply
 * from a malformed payload, not the same one.
 */
export function parseInbound(raw: string): ParsedInbound {
  const trimmed = raw.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (!match) return { kind: "text", text: trimmed };

  const name = (match[1] ?? "").toLowerCase();
  const rest = match[2];
  if (name !== "start") return { kind: "command", name };

  const payload = (rest ?? "").trim();
  if (!payload) return { kind: "start", payload: null };
  // A payload that cannot be a token we issued is reported as absent rather
  // than passed down: the caller's "that link isn't valid" reply is the right
  // answer for both, and this keeps arbitrary text out of the lookup path.
  if (!START_PAYLOAD_PATTERN.test(payload)) return { kind: "start", payload: null };
  return { kind: "start", payload };
}

// ── Routing ──────────────────────────────────────────────────────────────────

export type ChatRoute =
  | { kind: "interview"; sessionId: string; tripId: string }
  | { kind: "companion"; tripId: string; hermesProfile: string }
  | { kind: "unbound" };

/**
 * Resolves an inbound chat to exactly one destination, from the chat id alone.
 *
 * Precedence — a LIVE interview outranks a companion binding. This ordering is
 * a requirement, not a tie-break: an organizer whose chat is already bound to
 * their first trip must be able to start a second one from that same DM
 * ("re-enter interview mode for a new trip"), and the opposite precedence
 * would make that impossible — every message would be swallowed by the
 * companion and the new interview could never take a turn. A session stops
 * outranking the binding the moment it is confirmed, so the companion resumes
 * on its own with no extra bookkeeping.
 *
 * `unbound` is the fail-closed default. A chat matching neither row gets no
 * trip context at all, and the caller must accept nothing from it except a
 * verified `/start` token.
 */
export async function resolveChatRoute(db: pg.Pool, chatId: string): Promise<ChatRoute> {
  const live = await db.query<{ id: string; trip_id: string }>(
    `SELECT id, trip_id
     FROM control_plane.intake_sessions
     WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId],
  );
  const [session] = live.rows;
  if (session) return { kind: "interview", sessionId: session.id, tripId: session.trip_id };

  const bound = await db.query<{ trip_id: string; hermes_profile: string }>(
    "SELECT trip_id, hermes_profile FROM control_plane.telegram_chat_bindings WHERE chat_id = $1",
    [chatId],
  );
  const [binding] = bound.rows;
  if (binding) return { kind: "companion", tripId: binding.trip_id, hermesProfile: binding.hermes_profile };

  return { kind: "unbound" };
}

// ── /start deep link ─────────────────────────────────────────────────────────

export type StartLinkOutcome =
  | { kind: "started"; sessionId: string; tripId: string; view: SessionView }
  | { kind: "already_in_interview"; sessionId: string; tripId: string }
  | {
      kind: "rejected";
      reason:
        | "NO_PAYLOAD"
        | "NOT_PRIVATE_CHAT"
        | "INVALID_TOKEN"
        | "EXPIRED"
        | "ALREADY_CONSUMED"
        | "REVOKED"
        | "TRIP_NOT_DRAFT";
    };

/**
 * Exchanges a `/start <enrollment_token>` deep link for an interview session,
 * with no LLM in the path. This is the whole point of the router owning
 * `/start`: Hermes's gateway discards every `/start` before an agent sees it,
 * which is why one-tap onboarding was structurally impossible while that
 * gateway owned the connection.
 *
 * The enrollment token carries the authorization — it is single-use,
 * expiring, and was issued to one owner for one draft trip. This function
 * adds no identity check of its own beyond that, and must not: the chat id is
 * a routing fact, never a credential. Whoever holds the link starts the
 * interview, exactly as the enrollment design already specifies.
 */
export async function startFromDeepLink(
  db: pg.Pool,
  chatId: string,
  payload: string | null,
  log: (line: string) => void = () => {},
): Promise<StartLinkOutcome> {
  // A chat already conducting an interview must not consume a second
  // enrollment. The partial unique index on (telegram_chat_id) would reject
  // the insert anyway, but failing here gives the organizer a sentence that
  // makes sense instead of surfacing a constraint violation — and, more
  // importantly, leaves the second enrollment token unconsumed and still
  // usable once they finish or abandon the first.
  const existing = await resolveChatRoute(db, chatId);
  if (existing.kind === "interview") {
    return { kind: "already_in_interview", sessionId: existing.sessionId, tripId: existing.tripId };
  }

  if (!payload) return { kind: "rejected", reason: "NO_PAYLOAD" };

  // Checked before startSession, not after, and that ordering is the point.
  // An interview started from a group chat cannot be recorded as a binding
  // (interview.ts only accepts the private-chat shape), so it would leave the
  // organizer with a consumed single-use enrollment and a session no chat can
  // reach — the link burnt for nothing. Refusing first keeps the link usable
  // in the DM where it belongs.
  if (!PRIVATE_CHAT_ID_PATTERN.test(chatId)) {
    log(structuredLog("info", "chat_router.start_link_rejected", { safe_error_code: "NOT_PRIVATE_CHAT" }));
    return { kind: "rejected", reason: "NOT_PRIVATE_CHAT" };
  }

  const result = await startSession(db, payload, log, undefined, chatId);
  if (!result.ok) {
    log(structuredLog("info", "chat_router.start_link_rejected", { safe_error_code: result.reason }));
    return { kind: "rejected", reason: result.reason };
  }

  log(
    structuredLog("info", "chat_router.interview_started", {
      session_id: result.sessionId,
      trip_id: result.view.tripId,
    }),
  );
  return { kind: "started", sessionId: result.sessionId, tripId: result.view.tripId, view: result.view };
}

// ── Inline keyboards ─────────────────────────────────────────────────────────

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export interface RenderedQuestion {
  text: string;
  replyMarkup: InlineKeyboard | null;
}

// Telegram rejects callback_data longer than 64 BYTES (not characters).
const CALLBACK_DATA_MAX_BYTES = 64;

export function callbackDataFits(data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_MAX_BYTES;
}

/** `a:<questionId>:<optionId>` — an answer tap. */
export function answerCallbackData(questionId: string, optionId: string): string {
  return `a:${questionId}:${optionId}`;
}

export const CONFIRM_CALLBACK_DATA = "c:confirm";
export const KEEP_PLANNING_CALLBACK_DATA = "c:keep";

export type ParsedCallback =
  | { kind: "answer"; questionId: string; optionId: string }
  | { kind: "confirm" }
  | { kind: "keep_planning" }
  | { kind: "unknown" };

/**
 * Parses callback_data from a tapped button. The result is a claim about
 * WHICH ANSWER was tapped — never about which trip or session it applies to.
 * That still comes from resolveChatRoute on the chat the tap arrived in, so a
 * forged or replayed callback_data cannot reach another organizer's interview.
 */
export function parseCallbackData(data: string): ParsedCallback {
  if (data === CONFIRM_CALLBACK_DATA) return { kind: "confirm" };
  if (data === KEEP_PLANNING_CALLBACK_DATA) return { kind: "keep_planning" };
  const match = /^a:([A-Za-z0-9_]{1,64}):([A-Za-z0-9_]{1,64})$/.exec(data);
  const questionId = match?.[1];
  const optionId = match?.[2];
  if (!questionId || !optionId) return { kind: "unknown" };
  return { kind: "answer", questionId, optionId };
}

/**
 * Renders one intake question as message text plus, for choice questions, a
 * real inline keyboard.
 *
 * The options are deliberately NOT echoed into the message text as a numbered
 * list. The live signup run flagged the bulleted-list-and-type-your-answer
 * form twice; a list beside the buttons reintroduces the same "am I supposed
 * to type this?" ambiguity the buttons exist to remove. One option per row,
 * because trip-type and group-size labels are long enough that two per row
 * truncate on a phone.
 */
export function renderQuestion(question: IntakeQuestion): RenderedQuestion {
  if (question.type !== "choice" && question.type !== "multi_choice") {
    return { text: question.prompt, replyMarkup: null };
  }
  const options = question.options ?? [];
  const rows: InlineButton[][] = [];
  for (const option of options) {
    const data = answerCallbackData(question.id, option.id);
    // An option whose callback_data would not fit is dropped from the keyboard
    // rather than sent truncated — a truncated payload would parse as a
    // DIFFERENT option id and silently record the wrong answer. No intake
    // question is anywhere near the limit today; this is here so that stops
    // being true loudly rather than quietly.
    if (!callbackDataFits(data)) continue;
    rows.push([{ text: option.label, callback_data: data }]);
  }
  return { text: question.prompt, replyMarkup: rows.length > 0 ? { inline_keyboard: rows } : null };
}

/**
 * The confirm step as a button pair.
 *
 * The literal-CONFIRM requirement is about the act being explicit and
 * unambiguous — Sprint 2's "literal CONFIRM creates an immutable intake
 * version". A labelled button satisfies that at least as well as typed
 * capitals (there is no typo or near-miss to interpret), so this changes the
 * mechanism without weakening the rule. Typed CONFIRM stays accepted.
 */
export function renderConfirmPrompt(text: string): RenderedQuestion {
  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✅ Confirm", callback_data: CONFIRM_CALLBACK_DATA },
          { text: "✏️ Keep planning", callback_data: KEEP_PLANNING_CALLBACK_DATA },
        ],
      ],
    },
  };
}

/** Looks up a question by id from the canonical intake set. */
export function findQuestion(questionId: string): IntakeQuestion | null {
  return INTAKE_QUESTIONS.find((q) => q.id === questionId) ?? null;
}
