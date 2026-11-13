/**
 * What the automated organizer says — the part of tools/auto-organizer.ts that
 * can be tested without a relay, a database or a Telegram stand-in.
 *
 * auto-organizer.ts runs its whole interview the moment it is loaded, so
 * nothing in it can be imported by a test. The scenario type, the rule for how
 * a choice question is answered, and the `star` scenario live here instead; the
 * older scenarios still sit in auto-organizer.ts and use this type.
 */
import type { IntakeQuestion } from "../src/interview.js";

export interface Scenario {
  language: "he" | "en";
  documents: boolean;
  text: Record<string, string>;
  choice: Record<string, string>;
  multi: Record<string, string[]>;
  /**
   * Choice questions the organizer answers IN WORDS instead of tapping the
   * button, by question id. The buttons are a shortcut, not syntax: an
   * organizer who types "we're two couples, not a family" has to be understood
   * as well as one who taps Couple. Used by `star`.
   */
  typedChoice?: Record<string, string>;
  /**
   * The documents are PHOTOS, sent together as one album (Telegram's media
   * group), read from the `--photos` directory. Used by `gatecity`. Exclusive
   * with `documents`: that one sends files, one message each.
   */
  photos?: boolean;
  /**
   * Said in words at the summary, before it is confirmed — a correction the
   * organizer thinks of on reading it ("actually we fly back on 22 November").
   * Whatever the interview answers (a draft to apply, or the change applied
   * outright), the summary is confirmed after.
   */
  summaryChange?: string;
  /**
   * Buttons the organizer taps whenever the interview offers them outside a
   * question of its own, by callback data. `y:travelers` is the offer to add a
   * second ticket's passengers to the roster (#412), which the router never
   * asks as a question: the travellers question is already answered.
   */
  tapOffers?: string[];
}

/**
 * How many times a typed choice is typed before the button is tapped instead.
 * Two: the first answer, and the verbatim re-send after the interview asks
 * again. More would be the organizer arguing with the screen; fewer would give
 * up on a re-ask that a person would also have tried once.
 */
export const TYPED_CHOICE_TRIES = 2;

export type ChoicePlan =
  | { kind: "type"; text: string }
  | { kind: "tap"; option: string; fallback: boolean };

/**
 * How to answer a choice question that is on screen. `typedSoFar` is how many
 * times this question has already been typed.
 *
 * Past the cap the button IS tapped — the interview has to finish for the rest
 * of the site to be checked — but the plan says `fallback: true`, and the caller
 * reports it. A silent fallback would let the run go green through the button
 * and hide that the typed answer was never understood.
 */
export function choiceAnswer(
  q: Pick<IntakeQuestion, "id" | "options">,
  s: Scenario,
  typedSoFar: number,
): ChoicePlan {
  const typed = s.typedChoice?.[q.id];
  if (typed && typedSoFar < TYPED_CHOICE_TRIES) return { kind: "type", text: typed };
  const option = s.choice[q.id] ?? q.options?.[0]?.id;
  if (!option) throw new Error(`${q.id} has no options to choose from`);
  return { kind: "tap", option, fallback: Boolean(typed) };
}

export interface TypedFallback { question: string; text: string; tries: number }

/** What the organizer writes about itself for scripts/e2e-full-cycle.py to judge. */
export function buildFindings(fallbacks: TypedFallback[]): { typed_fallbacks: TypedFallback[] } {
  return { typed_fallbacks: fallbacks };
}

/**
 * Scenario 6 — a couples trip from ONE base, with day trips. The owner's manual
 * run of 2026-10-10, retold with made-up people and a December 2027 date so it
 * can never collide with the real December 2026 trip.
 *
 * Consistent with control-plane/api/test/fixtures/make_documents.py "star",
 * whose expectations are checked on the built site (organizer-scenarios.test.ts
 * proves the dates and flights agree).
 *
 * What it is made to provoke, each one a real finding:
 *   - trip_type is typed in WORDS, in the owner's phrasing — it did not map to
 *     the `couple` option;
 *   - "we sleep in Colmar and day-trip from there, no fixed plan yet" — the
 *     interviewer refused it as a stop and re-asked verbatim;
 *   - Frankfurt appears only as where the flights land and the one car is
 *     collected and returned — it became two extra, undated stops;
 *   - one hotel, two rooms, not yet booked (the companion hears the booking
 *     later, in chat).
 */
export const STAR_SCENARIO: Scenario = {
  language: "he",
  documents: false,
  text: {
    destination: "אלזס, צרפת",
    departure_date: "2 בדצמבר 2027",
    return_date: "9 בדצמבר 2027",
    travelers: "יותם ברקן, מיכל ברקן, עידו לבנון וליאת לבנון",
    phases:
      "אנחנו שני זוגות וישנים את כל הטיול בקולמר, באותו מלון, שני חדרים — עדיין לא הזמנו — " +
      "ומשם עושים טיולי יום לכפרי שווקי חג המולד באזור. עוד אין תוכנית קבועה לטיולי היום. " +
      "טסים מתל אביב לפרנקפורט ב-2 בדצמבר, אוספים שם רכב שכור אחד ונוסעים לקולמר, " +
      "וב-9 בדצמבר מחזירים את הרכב בפרנקפורט וטסים חזרה. " +
      "טיסה LY8801 ב-2 בדצמבר ב-07:10, וטיסה LY8802 ב-9 בדצמבר ב-15:40.",
    // In case the router asks for the bookings as a question of their own. The
    // flights are the only thing booked; the hotel and the car are not.
    travel_anchors:
      "טיסה LY8801 מתל אביב לפרנקפורט ב-2 בדצמבר 2027 ב-07:10, " +
      "וטיסה LY8802 מפרנקפורט לתל אביב ב-9 בדצמבר 2027 ב-15:40",
    trip_interests: "שווקי חג המולד, יין ואוכל אלזסי",
    bot_name: "ליאו",
    organizer_identity: "מיכל ברקן",
  },
  // trip_type is typed (below); `family` is the button tapped only if the
  // typed answer is never understood — and it is the WRONG answer for this
  // trip, so a fallback cannot pass for a success.
  choice: { trip_type: "family", bot_gender: "female", bot_tone: "warm", trip_pace: "easygoing" },
  multi: {},
  typedChoice: { trip_type: "טיול זוגות ולא משפחה, נהיה שני זוגות" },
};

/**
 * Scenario 7 — Dror's manual Sprint 8 staging test (2026-11-12), replayed.
 *
 * A trip created on the DASHBOARD (so destination, dates and type arrive
 * seeded, #438), an interview in Hebrew, and two e-tickets for the same flight
 * sent as PHOTOS in one album — two couples, two booking references. Everything
 * the interview asks that the seed and the tickets do not settle is answered
 * below, in case it is asked anyway: being asked something already known is a
 * finding the transcript and `asked` (--findings) show, not a stall.
 *
 * Consistent with tools/ticket_photos.py, which draws the tickets and holds the
 * expectations the run checks on the finished trip (organizer-scenarios.test.ts
 * proves the correction and the dates agree).
 *
 * The dashboard seeds a return date one day short of the real one, so the
 * correction at the summary is a real change; `summaryChange` is that sentence.
 */
export const GATECITY_SCENARIO: Scenario = {
  language: "he",
  documents: false,
  photos: true,
  text: {
    destination: "גייטסיטי",
    departure_date: "14 בנובמבר 2026",
    return_date: "22 בנובמבר 2026",
    travelers: "ארלו וספר, לנה וספר, בריה טאליס וקול טאליס",
    phases: "גייטסיטי, 14-22 בנובמבר",
    bot_name: "גיטי",
    trip_interests: "אוכל ושוטטות בעיר",
    organizer_identity: "ארלו וספר",
  },
  choice: { trip_type: "family", bot_gender: "female", bot_tone: "warm", trip_pace: "balanced" },
  multi: { dietary: ["none"] },
  summaryChange: "בעצם אנחנו טסים חזרה ב-22 בנובמבר",
  tapOffers: ["y:travelers"],
};

/** The questions a dashboard-created trip answers before the interview starts (#438): asking one is a regression. */
export const SEEDED_QUESTIONS = ["destination", "departure_date", "return_date", "trip_type"] as const;

/** What the Apply button of a drafted change carries (`changeCallbackData`, chat-router.ts): `pc:<draft>[:<8 hex>]:a`. */
export const APPLY_CHANGE_DATA = /^pc:[a-z]{2,12}_[A-Za-z0-9]{8,64}(?::[0-9a-f]{8})?:a$/;
