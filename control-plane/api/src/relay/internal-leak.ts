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
  const idMatch = QUESTION_ID_PATTERN.exec(text);
  if (idMatch) return { leaks: true, term: `\`${idMatch[1]}\`` };
  return { leaks: false };
}
