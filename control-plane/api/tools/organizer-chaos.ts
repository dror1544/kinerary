/**
 * The chaos organizer: someone who does not follow the interview.
 *
 * tools/auto-organizer.ts plays a cooperative organizer. This is the kind a
 * real family sends: answers the question before the one on screen, gives
 * dates that cannot be, names someone who is not coming as the organizer, types
 * sentences at buttons, drops a document in the middle of choosing the
 * assistant's voice, taps a keyboard from an earlier question, and writes
 * Hebrew and English in turn on a phone set to English — the 2026-09-15 trip
 * that was built English for an organizer who wrote Hebrew.
 *
 * Every question gets its misbehaviour first and a proper answer after, so the
 * run measures RECOVERY: the interview has to notice, say something, and take
 * the real answer on the next try — never go silent, never record the nonsense,
 * never finish on it.
 *
 * Pure on purpose (no CLI, no database, no network) so the plan and the verdict
 * are unit-tested; auto-organizer.ts does the talking.
 */
import { organizerMatch, type AnswerStore } from "../src/interview.js";
import { writtenLanguage, type Language } from "../src/intake-copy.js";

export type ChaosMove =
  | { kind: "type"; text: string; why: string }
  | { kind: "upload"; file: string; why: string }
  | { kind: "tap"; data: string; why: string };

/**
 * Misbehaviour per question, tried in order before the proper answer. Keyed by
 * question id; `opening` is the document offer before any question.
 */
export const CHAOS_PLAN: Readonly<Record<string, readonly ChaosMove[]>> = {
  opening: [{ kind: "type", text: "מה זה הבוט הזה בכלל?", why: "chatter before anything is asked" }],
  trip_type: [{ kind: "type", text: "טיול משפחתי עם הילדים", why: "a sentence typed at buttons" }],
  destination: [{
    kind: "type",
    text: "אנחנו חמישה: אבי כהן 46, רונית כהן 44, תמר כהן 15, יואב כהן 12 ומיכל כהן 9",
    why: "answers a different question (who is coming)",
  }],
  departure_date: [{ kind: "type", text: "31 בפברואר 2027", why: "a date that does not exist" }],
  return_date: [{ kind: "type", text: "1 ביולי 2027", why: "a return before the departure" }],
  phases: [{ kind: "type", text: "?", why: "a bare question mark" }],
  organizer_identity: [{ kind: "type", text: "Grandma Ruth", why: "someone who is not on the roster" }],
  bot_gender: [
    { kind: "upload", file: "hotel-athens.pdf", why: "a booking dropped in the middle of an unrelated question" },
    { kind: "type", text: "female please", why: "English typed at buttons, mid-Hebrew" },
  ],
  bot_tone: [{ kind: "tap", data: "a:trip_type:family", why: "a keyboard from an earlier question" }],
  dietary: [{ kind: "type", text: "we're vegetarian, and Yoav is allergic to nuts", why: "free text on a multi-select" }],
  trip_interests: [{ kind: "upload", file: "shopping-list.md", why: "a document that is not about any trip" }],
};

/** Said once each, after the named question is settled: corrections to earlier answers. */
export const CHAOS_LATE_CORRECTIONS: readonly { after: string; move: ChaosMove }[] = [
  {
    after: "bot_tone",
    move: { kind: "type", text: "Actually my mother Ruth Cohen, 70, is joining us too", why: "a late correction to who is coming" },
  },
  {
    // The Athens hotel booking, dropped in mid-interview, answered the stops
    // question with the one city it covers. The rest of the trip is said here.
    after: "trip_interests",
    move: { kind: "type", text: "אנחנו גם נוסעים לנקסוס 16-21 ביולי ולסנטוריני 21-26 ביולי", why: "a late correction to the stops a document filled in" },
  },
];

/** The facts the proper answers carry — what the confirmed interview must say. */
export const CHAOS_EXPECT = {
  departureDate: "2027-07-12",
  returnDate: "2027-07-26",
  destination: /greece|יוון/i,
  minTravellers: 5,
};

/**
 * Past this many tries at one question, the interview did not recover. The
 * longest plan is two moves; three proper answers after it is generous.
 */
export const MAX_TRIES_PER_QUESTION = 5;

export function chaosMove(questionId: string, tries: number): ChaosMove | null {
  return CHAOS_PLAN[questionId]?.[tries] ?? null;
}

export interface ChaosCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function textOf(answer: unknown): string {
  const text = (answer as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text.trim() : "";
}

function realDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * What the confirmed interview has to say after the chaos. `checks` fail the
 * run; `findings` are reported for a person to read.
 */
export function judgeIntake(
  answers: AnswerStore,
  recordedLanguage: string | null,
  lastWrittenLanguage: Language | null,
): { checks: ChaosCheck[]; findings: string[] } {
  const checks: ChaosCheck[] = [];
  const findings: string[] = [];

  const organizer = organizerMatch(answers);
  checks.push({
    name: "the organizer is exactly one traveller on the roster",
    ok: organizer.kind === "matched",
    detail: organizer.kind === "matched" ? `roster entry ${organizer.index + 1}` : organizer.kind,
  });

  const roster = answers.travelers?.kind === "structured" && Array.isArray(answers.travelers.data)
    ? (answers.travelers.data as Record<string, unknown>[])
    : [];
  const named = roster.filter((t) => typeof t?.name === "string" && (t.name as string).trim().length >= 2);
  checks.push({
    name: `the family survived the chaos (at least ${CHAOS_EXPECT.minTravellers} named travellers)`,
    ok: named.length >= CHAOS_EXPECT.minTravellers,
    detail: `${named.length} named`,
  });
  const everyName = named.map((t) => `${t.name} ${t.name_en ?? ""}`).join(" ");
  checks.push({
    name: "the late correction reached the roster (a grandmother joining)",
    ok: /ruth|רות/i.test(everyName),
    detail: `${named.length} travellers recorded`,
  });

  const departure = textOf(answers.departure_date);
  const ret = textOf(answers.return_date);
  checks.push({
    name: "the dates are the real ones, not the impossible or reversed ones typed first",
    ok: realDate(departure) && realDate(ret) && departure === CHAOS_EXPECT.departureDate && ret === CHAOS_EXPECT.returnDate,
    detail: `${departure || "-"} → ${ret || "-"}`,
  });

  const destination = textOf(answers.destination);
  checks.push({
    name: "the destination was recorded, not the travellers typed at it",
    ok: CHAOS_EXPECT.destination.test(destination) && !/\d{2}/.test(destination),
    detail: destination.slice(0, 60) || "-",
  });

  checks.push({
    name: "the recorded language is the one the organizer last wrote in",
    ok: lastWrittenLanguage === null || recordedLanguage === lastWrittenLanguage,
    detail: `recorded ${recordedLanguage ?? "-"}, last written ${lastWrittenLanguage ?? "-"}`,
  });

  const tripType = answers.trip_type as { option_id?: unknown } | undefined;
  findings.push(tripType?.option_id === "family"
    ? "trip type stayed 'family' through the free text and the stale tap"
    : `trip type ended as ${JSON.stringify(tripType?.option_id ?? null)}`);
  const dietary = (answers.dietary as { option_ids?: unknown } | undefined)?.option_ids;
  findings.push(Array.isArray(dietary)
    ? `dietary recorded as [${dietary.join(", ")}] (typed as free text first)`
    : "dietary was not recorded");

  return { checks, findings };
}

/** Whether a bot message is in the other language from the one just written. A finding, not a failure. */
export function replyInOtherLanguage(expected: Language, botText: string): boolean {
  const hebrew = /[א-ת]/u.test(botText);
  if (expected === "he") return !hebrew && (botText.match(/[A-Za-z]{2,}/g) ?? []).length >= 3;
  return hebrew;
}

export { writtenLanguage };
