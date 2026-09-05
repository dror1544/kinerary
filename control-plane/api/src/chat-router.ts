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
import {
  askText,
  DEFAULT_LANGUAGE,
  optionLabel,
  uiString,
  type Language,
} from "./intake-copy.js";
import {
  closeStaleSessionForChat,
  INTAKE_QUESTIONS,
  startSession,
  type IntakeQuestion,
  type SessionView,
} from "./interview.js";
import { peekEnrollmentTripId } from "./enrollment.js";
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
  | {
      kind: "companion";
      tripId: string;
      hermesProfile: string;
      /**
       * The assistant's wake-words (migration 0030), both languages. Carried
       * on the route because the group relevance gate needs them on exactly
       * the same lookup that decided the trip — a second query keyed by
       * something else would be a second chance to disagree about which trip
       * this chat is.
       */
      assistantNames: string[];
    }
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

  // Only an OPEN binding routes. Migration 0029 keeps closed ones as history,
  // and a closed binding that still resolved would be worse than having no
  // lifecycle at all — it would route a group to the trip it was deliberately
  // detached from, which on a shared bot is someone else's trip.
  const bound = await db.query<{
    trip_id: string;
    hermes_profile: string;
    assistant_names: string[] | null;
  }>(
    `SELECT b.trip_id, b.hermes_profile, t.assistant_names
     FROM control_plane.telegram_chat_bindings b
     JOIN control_plane.trips t ON t.id = b.trip_id
     WHERE b.chat_id = $1 AND b.closed_at IS NULL`,
    [chatId],
  );
  const [binding] = bound.rows;
  if (binding) {
    return {
      kind: "companion",
      tripId: binding.trip_id,
      hermesProfile: binding.hermes_profile,
      // NULL and empty mean the same thing to the gate: no names, fall back to
      // @mention and reply. Neither means "answer everything".
      assistantNames: binding.assistant_names ?? [],
    };
  }

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
/**
 * How long a session must have gone untouched, by either side, before a
 * fresh enrollment for a different trip may replace it.
 *
 * Well above any plausible "reading the question" pause and well below "this
 * looks abandoned" — a real interview has activity within seconds to low
 * minutes throughout, so this only ever engages for something that has
 * genuinely gone quiet.
 */
const STALE_SESSION_MINUTES = 10;

/**
 * Whether a session's most recent activity, by either party, is old enough to
 * treat it as abandoned rather than as an interview still in progress.
 */
async function isSessionStale(db: pg.Pool, sessionId: string): Promise<boolean> {
  const row = await db.query<{ stale: boolean }>(
    `SELECT awaiting_since < now() - make_interval(mins => $2) AS stale
       FROM control_plane.intake_sessions WHERE id = $1`,
    [sessionId, STALE_SESSION_MINUTES],
  );
  return row.rows[0]?.stale === true;
}

export async function startFromDeepLink(
  db: pg.Pool,
  chatId: string,
  payload: string | null,
  log: (line: string) => void = () => {},
  /** The organizer's Telegram client locale, if the update carried one. */
  languageHint?: string,
): Promise<StartLinkOutcome> {
  // A chat already conducting an interview must not consume a second
  // enrollment. The partial unique index on (telegram_chat_id) would reject
  // the insert anyway, but failing here gives the organizer a sentence that
  // makes sense instead of surfacing a constraint violation — and, more
  // importantly, leaves the second enrollment token unconsumed and still
  // usable once they finish or abandon the first.
  const existing = await resolveChatRoute(db, chatId);
  if (existing.kind === "interview") {
    // Same trip: genuinely already in this interview. Refuse without
    // consuming the token, so it stays usable if this was an accidental
    // double-tap. This branch is unconditional and always wins — nothing
    // below ever second-guesses it.
    //
    // A DIFFERENT trip needs a second question answered before it can be
    // treated as "supersede", and getting this wrong is dangerous in a
    // specific way: `chatId` here is not necessarily the redeeming
    // organizer's OWN chat. The two-trip isolation matrix has a live test for
    // exactly the attack this must never permit — organizer B's chat, already
    // mid-interview, must not be pulled out from under them because someone
    // (attacker, misdirected link, ownership doesn't even enter into it)
    // presents organizer A's token there. Ownership cannot be the signal that
    // decides this either way: two signups made minutes apart by the SAME
    // physical person on this deployment get two entirely different
    // control-plane `user_id`s, checked and confirmed empirically — so
    // "same owner" would fail to permit the exact case this exists for.
    //
    // The signal that actually holds: whether the EXISTING interview looks
    // abandoned. `awaiting_since` moves on every message either side sends
    // (`markAwaitingMachine`, `claimFloor`), so it is a genuine "last activity
    // of any kind" clock. A real, ongoing interview has activity within
    // seconds to low minutes; run 7's session, still sitting here when run 8
    // tapped a fresh link, had been silent for hours. STALE_SESSION_MINUTES is
    // set well above any plausible "still reading the question" pause, so an
    // organizer who steps away mid-interview and comes straight back is never
    // at risk — only a session nobody has touched in a long time is eligible.
    const targetTripId = payload ? await peekEnrollmentTripId(db, payload) : null;
    const isStale = targetTripId && targetTripId !== existing.tripId
      ? await isSessionStale(db, existing.sessionId)
      : false;

    if (!isStale) {
      return { kind: "already_in_interview", sessionId: existing.sessionId, tripId: existing.tripId };
    }

    log(structuredLog("info", "chat_router.stale_session_superseded", {
      stale_session_id: existing.sessionId,
      stale_trip_id: existing.tripId,
      new_trip_id: targetTripId,
    }));
    // `peekEnrollmentTripId` reads the token's target WITHOUT consuming it,
    // purely to make the trip comparison above; `startSession` below
    // re-validates and consumes it for real a moment later, so nothing here
    // is trusted for the actual decision to enroll.
    await closeStaleSessionForChat(db, existing.sessionId);
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

  const result = await startSession(db, payload, log, undefined, chatId, languageHint);
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
/** "That's everything" — stop offering optional questions and show the recap. */
export const FINISH_CALLBACK_DATA = "c:done";
/** "A few more questions" — the organizer asks for the next optional one themselves. */
export const MORE_CALLBACK_DATA = "c:more";
/** "I don't have one" — skip the document offer and start the questions. */
export const NO_DOCUMENT_CALLBACK_DATA = "c:nodoc";

/** `t:<questionId>:<optionId>` — one tick of a multi-select. */
export function toggleCallbackData(questionId: string, optionId: string): string {
  return `t:${questionId}:${optionId}`;
}

/** `k:<questionId>` — skip this optional question. */
export function skipCallbackData(questionId: string): string {
  return `k:${questionId}`;
}

/** `n:<questionId>` — a multi-select is finished; move on. */
export function multiDoneCallbackData(questionId: string): string {
  return `n:${questionId}`;
}

export type ParsedCallback =
  | { kind: "answer"; questionId: string; optionId: string }
  | { kind: "toggle"; questionId: string; optionId: string }
  | { kind: "multi_done"; questionId: string }
  | { kind: "skip"; questionId: string }
  | { kind: "confirm" }
  | { kind: "keep_planning" }
  | { kind: "finish" }
  | { kind: "more" }
  | { kind: "no_document" }
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
  if (data === FINISH_CALLBACK_DATA) return { kind: "finish" };
  if (data === MORE_CALLBACK_DATA) return { kind: "more" };
  if (data === NO_DOCUMENT_CALLBACK_DATA) return { kind: "no_document" };

  const pair = /^([at]):([A-Za-z0-9_]{1,64}):([A-Za-z0-9_]{1,64})$/.exec(data);
  if (pair?.[2] && pair[3]) {
    return pair[1] === "a"
      ? { kind: "answer", questionId: pair[2], optionId: pair[3] }
      : { kind: "toggle", questionId: pair[2], optionId: pair[3] };
  }

  const single = /^([kn]):([A-Za-z0-9_]{1,64})$/.exec(data);
  if (single?.[2]) {
    return single[1] === "k"
      ? { kind: "skip", questionId: single[2] }
      : { kind: "multi_done", questionId: single[2] };
  }

  return { kind: "unknown" };
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
export function renderQuestion(
  question: IntakeQuestion,
  selected: readonly string[] = [],
  language: Language = DEFAULT_LANGUAGE,
  /**
   * The interviewer's own phrasing for this question.
   *
   * The router owns the KEYBOARD; it does not have to own the sentence. Run 3
   * is why: walking `intake-copy.ts` end to end turned the interview into a
   * form — "it completely drifted" — because every question arrived in the
   * same flat voice regardless of what the organizer had just said. When the
   * agent supplies wording, the buttons attach to ITS sentence, so the
   * conversation reads like one person talking while the affordances stay
   * deterministic. Absent, the copy table still answers: robotic, but never
   * stuck, which is what the watchdog will depend on.
   */
  agentText?: string | null,
): RenderedQuestion {
  const rows: InlineButton[][] = [];

  if (question.type === "choice" || question.type === "multi_choice") {
    const multi = question.type === "multi_choice";
    for (const option of question.options ?? []) {
      const data = multi
        ? toggleCallbackData(question.id, option.id)
        : answerCallbackData(question.id, option.id);
      // An option whose callback_data would not fit is dropped from the
      // keyboard rather than sent truncated — a truncated payload would parse
      // as a DIFFERENT option id and silently record the wrong answer. No
      // intake question is anywhere near the limit today; this is here so that
      // stops being true loudly rather than quietly.
      if (!callbackDataFits(data)) continue;
      // The tick is the whole multi-select affordance: Telegram gives no
      // selected state of its own, so without it a second tap is
      // indistinguishable from a first.
      const text = optionLabel(question, option.id, language);
      const label = multi && selected.includes(option.id) ? `✅ ${text}` : text;
      rows.push([{ text: label, callback_data: data }]);
    }
    if (multi) {
      rows.push([{ text: uiString("multiDone", language), callback_data: multiDoneCallbackData(question.id) }]);
    }
  }

  // Optional questions carry their own way out. Without these the only exits
  // from an optional question were to answer it or to type something the agent
  // had to interpret as a refusal — and a question with no visible skip reads
  // as required, which is how "optional" quietly became "mandatory" in the
  // 2026-09-04 run.
  if (!question.required) {
    rows.push([
      // Two exits that do different things, so they have to say which is
      // which: one passes on THIS question, the other ends the questions
      // altogether. "Skip" alone beside "That's everything" read as two ways
      // to do the same thing on the 2026-09-04 run.
      { text: uiString("skip", language), callback_data: skipCallbackData(question.id) },
      { text: uiString("finish", language), callback_data: FINISH_CALLBACK_DATA },
    ]);
  }

  // `askText`, never `question.prompt`: the prompt is the interviewer's field
  // spec, examples and all, and it was being read out to organizers verbatim.
  const text = agentText?.trim() || askText(question, language);
  return { text, replyMarkup: rows.length > 0 ? { inline_keyboard: rows } : null };
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
export function renderConfirmPrompt(
  text: string,
  language: Language = DEFAULT_LANGUAGE,
): RenderedQuestion {
  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: uiString("confirm", language), callback_data: CONFIRM_CALLBACK_DATA },
          { text: uiString("keepPlanning", language), callback_data: KEEP_PLANNING_CALLBACK_DATA },
        ],
      ],
    },
  };
}

/**
 * The opening: an offer to read a document before anyone types anything.
 *
 * This used to be the interviewer's job — `SOUL.md` step 3 — and the router
 * split quietly took it away. The router asks the required questions itself
 * now, so it gets there first, and the organizer's first experience became
 * "what date does the trip start?" with no hint that the PDF in their inbox
 * would have answered it. Reported on the 2026-09-04 run 5.
 *
 * It belongs here for the same reason every other opening message does: the
 * router speaks first, and can be relied on to speak at all.
 */
export function renderDocumentOffer(language: Language = DEFAULT_LANGUAGE): RenderedQuestion {
  return {
    text: uiString("documentOffer", language),
    replyMarkup: {
      inline_keyboard: [[
        { text: uiString("noDocument", language), callback_data: NO_DOCUMENT_CALLBACK_DATA },
      ]],
    },
  };
}

/**
 * The one message that stands between "essentials done" and the summary.
 *
 * The router asks no optional question on its own any more — the interviewer
 * nominates them. That is right for pacing and wrong as a single point of
 * failure: on a live run the agent fumbled its first nomination, gave up, and
 * told the organizer the interview could not continue. Nothing was broken,
 * and there was no button anywhere that could have moved them forward.
 *
 * So the boundary itself is deterministic. Whatever the agent does or fails to
 * do, the organizer always has both exits in front of them.
 */
export function renderEssentialsDone(language: Language = DEFAULT_LANGUAGE): RenderedQuestion {
  return {
    text: uiString("essentialsDone", language),
    replyMarkup: {
      inline_keyboard: [[
        { text: uiString("askMore", language), callback_data: MORE_CALLBACK_DATA },
        { text: uiString("finish", language), callback_data: FINISH_CALLBACK_DATA },
      ]],
    },
  };
}

/** Looks up a question by id from the canonical intake set. */
export function findQuestion(questionId: string): IntakeQuestion | null {
  return INTAKE_QUESTIONS.find((q) => q.id === questionId) ?? null;
}
