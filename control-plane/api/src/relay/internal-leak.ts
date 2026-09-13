/**
 * Stops the interviewer's internal vocabulary reaching the organizer.
 *
 * The agent is told, in several places and increasingly bluntly, not to
 * narrate its own plumbing. It keeps doing it anyway — the wording that
 * prompted this arrived mid-interview on 2026-09-04 run 5, in Hebrew, from a
 * model that had been swapped mid-run:
 *
 *     `bot_gender`, `bot_tone` ו-`bot_proactive` עדיין ב-optionalRemaining —
 *     הבחירה שנלחצה עוד לא נרשמה. אשאל על `trip_pace` בינתיים, ואת שאלות
 *     הכפתורים הנותרות ישאל הראוטר.
 *
 * Field ids, a tool's response shape, and "the router" as a separate speaker,
 * read out to a non-technical person who asked about a family holiday. A
 * prompt rule cannot be relied on for this: it has been written three times
 * now and each new model finds a new way around it.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It suppresses a message that names internal machinery, and says so in the
 * log. It does NOT rewrite one: a half-redacted sentence is worse than a
 * missing one, because the organizer is left responding to something
 * incoherent. Silence is safe here in a way it would not have been before the
 * router owned the questions — the questions arrive regardless, so a dropped
 * narration costs a pleasantry, not the interview.
 *
 * The list is deliberately narrow: identifiers no organizer would ever type in
 * conversation about their own trip. "Router" is not on it in English —
 * someone might genuinely discuss a wifi router — but its Hebrew
 * transliteration is, because "הראוטר" in a trip interview is only ever this
 * system talking about itself.
 *
 * Two lists, two leak classes: the agent describing its own plumbing
 * (INTERNAL_TERMS, below) and the harness describing its own scheduling
 * (GATEWAY_STATUS_PHRASES). Both reach the organizer through the same door,
 * so both are stopped at it.
 */
import { INTAKE_QUESTIONS } from "../interview.js";

/** Tool and field names that only ever appear when the agent is describing itself. */
const INTERNAL_TERMS: readonly string[] = [
  "optionalRemaining",
  "nextQuestion",
  "pendingAsk",
  "ui_state",
  "submit_answer_for_chat",
  "get_interview_for_chat",
  "ask_question_for_chat",
  "show_summary_for_chat",
  "set_interview_language_for_chat",
  "confirm_intake",
  "start_interview",
  "intake_sessions",
  "הראוטר",
  "הרואטר",
];

/**
 * The gateway's own busy-acknowledgement sentences.
 *
 * A different leak class from the list above, and worth its own constant: it
 * is not the agent narrating itself, it is the HARNESS narrating itself. When
 * an inbound message arrives while a run is active, the Hermes gateway sends
 * the chat a status line of its own — and on 2026-09-05 run 13 an organizer
 * who had just answered the question they were asked got back:
 *
 *     ↪ Redirected current run. I'll adjust using your correction.
 *
 * There was no correction. They answered. The router had handed their reply
 * to an agent that was already mid-run, and the gateway announced its own
 * scheduling decision as though it were a reply — telling the organizer, in
 * English, in a Hebrew interview, that something they did not do had happened.
 *
 * `display.busy_ack_enabled: false` in the trip-intake profile turns these off
 * at the source, which is the actual fix. This is the fail-safe: the profile
 * is not version controlled, the ack is on by default, and one `config.yaml`
 * reset would put it back with nothing to catch it. Matching the sentences is
 * safe because they are fixed English strings about runs and subagents —
 * nothing an organizer discussing a family holiday would ever write.
 */
const GATEWAY_STATUS_PHRASES: readonly string[] = [
  "redirected current run",
  "steered into current run",
  "interrupting current task",
  "queued for the next turn",
  "subagent working",
  "compressing context",
  // The harness announcing its own INFRASTRUCTURE, reported live on
  // 2026-09-10 from a family trip companion:
  //
  //     🔄 Switched to fallback model: gpt-5.4-mini via openai-codex →
  //        claude-haiku-4-5-20251001 via anthropic
  //
  // A provider failed over. That is a fact about our billing and our vendors,
  // narrated to someone asking about their holiday — and it names the models
  // behind the assistant, which is the one thing the persona is not supposed
  // to be. Matching is on the fixed English stems the gateway emits; no
  // organizer discussing a trip writes "switched to fallback model".
  "switched to fallback model",
  "falling back to model",
  "switching to model",
  "retrying with model",
  // The gateway's own setup chatter on a fresh chat — a home channel being
  // registered is plumbing, and it arrives as the FIRST thing a family sees.
  "sethome",
  "/sethome",
  "home channel set",
  "set as home channel",
  // The harness asking a FAMILY for permission to run a shell command.
  // Live 2026-09-12, in the family group, in answer to a question about the
  // trip:
  //
  //     ⚠️ Dangerous command requires approval:
  //     cd /opt/data/profiles/japan2026 && python3 -c "…mcp call trip-mcp…"
  //     Reply /approve to execute this one operation, /approve session …
  //
  // Two failures in one message, and the leak is the smaller of them: the
  // companion had no trip-mcp tools (its gateway parked the server at
  // startup) and was improvising a shell command to reach them. The source
  // fixes are elsewhere — the bridge restart in companion-install-host.sh,
  // and `agent.disabled_toolsets` in the companion overlay. This is the
  // fail-safe, because an approval prompt is never something a family can
  // usefully answer and the words are the harness's own.
  "requires approval",
  "reply /approve",
  "/approve session",
  "/approve always",
  "security scan —",
];

/**
 * A question id counts only when it appears as an identifier — backticked, or
 * standing alone amid other machinery. `dietary` and `timezone` are ordinary
 * words in both languages, so matching them bare would suppress real sentences.
 */
const QUESTION_ID_PATTERN = new RegExp(
  "`(" + INTAKE_QUESTIONS.map((q) => q.id).join("|") + ")`",
  "u",
);

export interface LeakVerdict {
  leaks: boolean;
  /** What matched, for the log. Never the message itself — that is the organizer's. */
  term?: string;
}

export function detectInternalLeak(text: string): LeakVerdict {
  if (!text) return { leaks: false };
  const lowered = text.toLowerCase();
  for (const term of INTERNAL_TERMS) {
    if (lowered.includes(term.toLowerCase())) return { leaks: true, term };
  }
  for (const phrase of GATEWAY_STATUS_PHRASES) {
    if (lowered.includes(phrase)) return { leaks: true, term: phrase };
  }
  const idMatch = QUESTION_ID_PATTERN.exec(text);
  if (idMatch) return { leaks: true, term: `\`${idMatch[1]}\`` };
  return { leaks: false };
}

/**
 * Whether the agent's own wording is in the language the interview is being
 * held in.
 *
 * The interviewer is told, firmly and repeatedly, to hold one language for the
 * whole conversation. It mostly does — and then a provider rate-limits, the
 * fallback model takes over mid-interview, and the organizer starts getting
 * English in a Hebrew conversation. Run 15 reported exactly that: "some of the
 * messages from the bot came in English."
 *
 * The router's own copy is fully localised, so this only ever concerns text the
 * AGENT supplied — a `say`, or the phrasing it attached to a question it
 * nominated. When that text is in the wrong language the router has a correct
 * translation of its own to fall back on, which is better than passing through
 * a sentence the organizer cannot read.
 *
 * Deliberately crude, and only in the direction that is safe. A Hebrew
 * interview whose agent text contains NO Hebrew letters at all is wrong —
 * place names, confirmation numbers and the odd English word are normal, but a
 * whole sentence without a single Hebrew character is not a sentence in
 * Hebrew. The reverse is not checked: Hebrew appearing in an English interview
 * is far more likely to be a traveller's name than a language slip.
 */
export function agentTextIsInLanguage(text: string, language: string): boolean {
  if (language !== "he") return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /[\u0590-\u05FF]/.test(trimmed);
}
