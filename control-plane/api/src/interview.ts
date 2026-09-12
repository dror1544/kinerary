import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { assertCanonicalRecordSafe, UnsafeCanonicalRecordError } from "./canonical.js";
import { consumeEnrollmentInTx } from "./enrollment.js";
import {
  coerceLanguage,
  DEFAULT_LANGUAGE,
  optionLabel,
  readableDate,
  recapLabel,
  uiString,
  type Language,
} from "./intake-copy.js";
import { structuredLog } from "./redaction.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sessionTokenDigest(token: string): string {
  return `sha256:${sha256hex(token)}`;
}

// ── Question schema (versioned) ──────────────────────────────────────────────

// Bumped to 2 when the persona/dietary/pace questions and the 'multi_choice'
// type landed. Nothing branches on this at read time — a stored answer's
// schema_version records which question set produced it, and an answer of
// kind 'multi_choice' could not have come from v1. Releases advertise the
// range they accept via releases.data_schema_min/max, so a bump here needs a
// matching widening there or generatePlan finds no eligible release.
//
// Bumped to 3 when `group_size` and `trip_duration` were REMOVED, headcount
// being counted off the traveler roster and duration being the difference
// between the two date questions (capture ledger, Step 3 #3 and #4).
//
// This bump is doing more work than 1 -> 2 did. That one was additive —
// migration 0018 could widen a single release to serve both because every new
// question was optional and transform_intake reproduced its v1 output exactly
// when they were absent. Removing REQUIRED questions is not additive: a
// release sealed before this change carries a transformer that lists both in
// REQUIRED_QUESTIONS and raises on a v3 intake. The version is what makes that
// release visibly ineligible in generatePlan instead of failing at transform
// time, with a confirmed intake and nowhere to go. See migration 0032.
export const INTAKE_SCHEMA_VERSION = 3;

/**
 * Question ids that USED to be asked and can still appear in a stored intake.
 *
 * An intake version is immutable, so every intake confirmed before v3 still
 * carries `group_size` and `trip_duration` — and a correction to one of those
 * trips submits the whole answer set back. Without this, the correction path's
 * unknown-key check would reject it outright: an organizer fixing a
 * destination on an older trip would be refused because of two fields they
 * never touched, and the transformer's legacy readers would lose the values
 * they still fall back to.
 *
 * Retired ids are carried through corrections unchanged rather than validated
 * (there is no question definition left to validate against) and rather than
 * dropped (that would quietly edit a confirmed record while claiming to
 * correct one field).
 */
export const RETIRED_QUESTION_IDS: ReadonlySet<string> = new Set([
  "group_size",
  "trip_duration",
  // Retired 2026-09-09. Both are facts ABOUT THE ORGANIZER rather than about
  // the trip, and an interview turn is the most expensive place to learn
  // something the signup already implies. `home_country` is derivable from the
  // account and the phone; `budget_detail` belongs on the landing page where
  // someone is already filling in a form, not in a conversation.
  //
  // Consequence, stated rather than discovered later: until signup supplies
  // them, a new intake has neither. The site degrades rather than breaks —
  // consular contacts fall back to generic emergency numbers, and the budget
  // section is simply absent.
  "home_country",
  "budget_detail",
]);

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface IntakeQuestion {
  id: string;
  type: "choice" | "multi_choice" | "text" | "structured";
  prompt: string;
  options?: ChoiceOption[];  // present for 'choice' and 'multi_choice' questions
  allowsOther?: boolean;     // choice only: enables the 'other' follow-up
  otherPrompt?: string;      // follow-up prompt shown when 'other' is chosen
  maxLength?: number;        // max chars for text/other answers
  // structured only: the interviewer submits a JSON payload rather than a
  // string; this only checks the JSON's top-level shape (list vs. object),
  // not a full schema — the interviewer is a capable LLM assembling this
  // from conversation, not a form validating untrusted input.
  dataShape?: "array" | "object";
  /**
   * The FIELD NAMES a structured answer must use, as a compact example.
   *
   * `dataShape` only says array-or-object, which is all `validateAnswer` can
   * check — and that is not enough for anything writing this answer without a
   * person in the loop. The worker's transformer reads specific keys
   * (`transformer.py`'s module docstring is the contract), and an extraction
   * that invents its own passes every check here and produces a broken site:
   * live on 2026-09-08 a booking PDF yielded `phases: [{place, start, end}]`
   * where the transformer wants `name`, so every phase would have arrived
   * nameless.
   *
   * A person answering in conversation never had this problem, because the
   * agent shaped their words. Nothing shapes a document.
   *
   * Kept here rather than in the prompt so the prompt and the transformer read
   * from one place. If this drifts from `transformer.py`, that is a bug in
   * this line, not in the model.
   */
  dataExample?: string;
  required: boolean;
  /**
   * Works this question's answer out from what is already recorded, or returns
   * null when it cannot.
   *
   * A question with a derivation is never PUT to anyone: the moment its inputs
   * exist the answer is written, so it leaves the outstanding set without ever
   * being asked. Run 3 is why — the router asked someone who had just said
   * "Japan" what timezone to show times in, and the prompt itself admits the
   * answer can be inferred. Asking for something you can work out is not
   * diligence, it is a question the organizer has to wonder about.
   *
   * Derivations must be conservative. Returning null is always safe: the
   * question simply stays askable.
   */
  derive?: (answers: AnswerStore) => string | null;
  /**
   * Whether this question applies at all, given what is already recorded.
   *
   * A FOLLOW-UP is not the same thing as an optional question. `required:
   * false` means "you may skip this"; a follow-up means "this only exists in
   * some conversations at all". `dietary_scope` asks whose the dietary needs
   * are — and an organizer who ticked "none of these" has said there are none,
   * so asking whose they are is a question with no possible answer.
   *
   * Live on 2026-09-12: אין was ticked, and the interview asked "זה נוגע
   * לכולם או לאנשים מסוימים?" — the organizer's own note: "if none is selected
   * this question should be avoided".
   *
   * Absent means always applicable, which is every other question today.
   * Scoped to the optional walk and to what the interviewer may nominate: a
   * REQUIRED question that does not apply would be a contradiction, since
   * confirmation is gated on the required set being answered.
   */
  applies?: (answers: AnswerStore) => boolean;
  /**
   * A second, distinct question from "is this the right shape" (`dataShape`,
   * checked before this ever runs): "does this actually establish what the
   * question exists to establish." A structured answer can be a well-formed
   * array or object and still be substantively empty — a real live example,
   * 2026-09-05: `travelers` recorded as `{count: 5, age_group: "adults"}`,
   * which satisfies `dataShape: "array"` [as one object in it] without a
   * single name anywhere in it, even though the prompt above asks for names.
   *
   * Returns null when the answer is substantively complete. Returns an
   * explanatory string when it is not — this becomes the agent-facing
   * `detail` on the rejection (see the `INCOMPLETE_ANSWER` reason), so the
   * agent knows exactly what is still missing and can ask for it directly,
   * the same way it already reads and acts on `ALREADY_ANSWERED`'s detail.
   *
   * A rejection here does not fail the interview: nothing is written to
   * `answers`, so the question simply stays outstanding — exactly like a
   * shape failure — and the router's own "what's still outstanding" logic
   * keeps offering it.
   *
   * Deliberately per-question and opt-in, not a generic content-validation
   * framework: most questions need only a shape check, and inferring a
   * completeness rule from a question's type or shape would be exactly the
   * guess this exists to avoid making. Add one here, on the question it
   * actually concerns, when a similar silent-shortcut risk shows up elsewhere
   * — the mechanism already generalizes; only the check itself is per-question.
   */
  checkComplete?: (data: unknown) => string | null;
  /**
   * Marks this question safe for the router to ask entirely on its own —
   * no agent nomination, no agent judgment, asked the moment it is next and
   * nothing else is pending. The architectural rule: the agent owns
   * judgment, the router owns deterministic progression.
   *
   * Explicitly opt-in, and meant to stay a short, deliberate list. A choice
   * question being fixed-option is necessary but not sufficient — `dietary`
   * is fixed-choice too, but which follow-up it needs and how it reconciles
   * against a document is exactly the conversational judgment that stays
   * with the agent. Router-owned is reserved for questions where the answer
   * requires no context, no prioritization, and no interpretation: naming
   * every one by hand, rather than inferring from type or required-ness, is
   * what stops this from drifting the interview back into the form Track 4
   * was built to get away from.
   *
   * Two effects, both from the same designation:
   *   - `nominateQuestionForChat` refuses to let the agent nominate it
   *     (`ROUTER_OWNED`) — there is exactly one path that ever asks it.
   *   - the router asks it proactively (Track 8) the moment it is next,
   *     including while an agent turn is open and doing something else
   *     entirely (document extraction, an optional-question decision) —
   *     productive progress instead of dead air, without waiting on or
   *     interrupting whatever the agent is doing.
   */
  routerOwned?: boolean;
}

/**
 * At least one entry in a `travelers`-shaped array actually names someone —
 * `\p{L}` rather than a Latin-only pattern because a name is as likely to be
 * written in Hebrew as English here. Loose on purpose: this only needs to
 * catch the shortcut of a bare headcount, not validate that a string is a
 * "real" name, which is not something to adjudicate from a control-plane
 * module.
 */
function hasNamedTraveler(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  return data.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const name = (entry as Record<string, unknown>).name;
    return typeof name === "string" && name.trim().length >= 2 && /\p{L}/u.test(name);
  });
}

/**
 * An IANA timezone for a destination the organizer described in their own words.
 *
 * The `timezone` question derives from `destination` rather than asking someone
 * who just said where they are going. Until 2026-09-07 that derivation copied
 * the destination TEXT — so a trip to "Japan — Tokyo, Hakone, Kyoto, Osaka"
 * stored that whole phrase as its timezone, which is not a timezone, and every
 * consumer downstream got a string it could not use. Run 15 reported it simply
 * as "it did not resolve the time zone".
 *
 * Deliberately a lookup rather than a guess. Returning null when nothing matches
 * leaves the question outstanding for the interviewer to ask, which is the
 * recoverable outcome; inventing a plausible zone would silently show every time
 * on the trip in the wrong one.
 *
 * Matched on the destination text in either script, longest key first so
 * "New York" wins over "York" and a city beats its country.
 */
const DESTINATION_ZONES: ReadonlyArray<readonly [string, string]> = [
  // Japan
  ["tokyo", "Asia/Tokyo"], ["kyoto", "Asia/Tokyo"], ["osaka", "Asia/Tokyo"],
  ["hakone", "Asia/Tokyo"], ["japan", "Asia/Tokyo"], ["יפן", "Asia/Tokyo"],
  ["טוקיו", "Asia/Tokyo"],
  // United States — by zone, because the country spans several
  ["new york", "America/New_York"], ["boston", "America/New_York"],
  ["washington", "America/New_York"], ["orlando", "America/New_York"],
  ["miami", "America/New_York"], ["ניו יורק", "America/New_York"],
  ["chicago", "America/Chicago"], ["dallas", "America/Chicago"],
  ["houston", "America/Chicago"], ["austin", "America/Chicago"],
  ["denver", "America/Denver"], ["phoenix", "America/Phoenix"],
  ["las vegas", "America/Los_Angeles"], ["los angeles", "America/Los_Angeles"],
  ["san francisco", "America/Los_Angeles"], ["seattle", "America/Los_Angeles"],
  ["לאס וגאס", "America/Los_Angeles"], ["לוס אנג'לס", "America/Los_Angeles"],
  ["hawaii", "Pacific/Honolulu"], ["honolulu", "Pacific/Honolulu"],
  // Europe
  ["london", "Europe/London"], ["paris", "Europe/Paris"], ["rome", "Europe/Rome"],
  ["milan", "Europe/Rome"], ["barcelona", "Europe/Madrid"], ["madrid", "Europe/Madrid"],
  ["amsterdam", "Europe/Amsterdam"], ["berlin", "Europe/Berlin"],
  ["athens", "Europe/Athens"], ["greece", "Europe/Athens"], ["יוון", "Europe/Athens"],
  ["לונדון", "Europe/London"], ["פריז", "Europe/Paris"], ["רומא", "Europe/Rome"],
  // Home
  ["israel", "Asia/Jerusalem"], ["ישראל", "Asia/Jerusalem"],
  ["tel aviv", "Asia/Jerusalem"], ["תל אביב", "Asia/Jerusalem"],
  // Elsewhere this product has seen
  ["thailand", "Asia/Bangkok"], ["bangkok", "Asia/Bangkok"],
  ["dubai", "Asia/Dubai"], ["cyprus", "Asia/Nicosia"],
  ["georgia", "Asia/Tbilisi"], ["tbilisi", "Asia/Tbilisi"],
];

export function ianaZoneFor(destination: string | null | undefined): string | null {
  const haystack = (destination ?? "").toLowerCase();
  if (!haystack.trim()) return null;
  let best: { key: string; zone: string } | null = null;
  for (const [key, zone] of DESTINATION_ZONES) {
    if (!haystack.includes(key)) continue;
    // Longest match wins: a city is more specific than its country, and
    // "new york" must not lose to a shorter accidental substring.
    if (!best || key.length > best.key.length) best = { key, zone };
  }
  return best?.zone ?? null;
}

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    id: "trip_type",
    type: "choice",
    prompt: "What type of trip is this?",
    options: [
      { id: "family", label: "Family" },
      { id: "group_of_families", label: "Group of families" },
      { id: "couple", label: "Couple" },
    ],
    allowsOther: true,
    otherPrompt: "Describe the trip type briefly (max 120 chars):",
    maxLength: 120,
    required: true,
    // Fixed three options (plus a free-text escape hatch that is itself just
    // recorded verbatim, no interpretation) — asking which applies needs no
    // context from the rest of the conversation. See `routerOwned` above.
    routerOwned: true,
  },
  {
    id: "destination",
    type: "text",
    prompt: "Where is the trip? (city/region/country)",
    maxLength: 200,
    required: true,
  },
  {
    id: "trip_interests",
    type: "text",
    prompt: "Any specific interests or must-sees?",
    maxLength: 500,
    required: false,
  },
  // No date format in either prompt, deliberately. The interviewer resolves
  // whatever the organizer says into YYYY-MM-DD before submitting, and
  // confirms its reading back in words ("so departure September 6th?") —
  // that is what catches DD/MM vs MM/DD ambiguity. Naming a format here just
  // leaks an implementation detail at a non-technical organizer.
  {
    id: "departure_date",
    type: "text",
    prompt: "What day does the trip start?",
    maxLength: 40,
    required: true,
  },
  {
    id: "return_date",
    type: "text",
    prompt: "What day does everyone head home?",
    maxLength: 40,
    required: true,
  },
  {
    id: "timezone",
    type: "text",
    prompt: "What timezone should times be shown in? Asia/Tokyo, or just the destination city — we can work it out if you're not sure.",
    maxLength: 100,
    required: false,
    // The prompt says it out loud: "or just the destination city — we can work
    // it out if you're not sure." So work it out. Run 3 put this question to
    // someone who had said "Japan" one message earlier, which is what made the
    // interview read as a form marching through a schema.
    derive: (answers) => {
      const destination = answers.destination;
      if (!destination || destination.kind !== "text") return null;
      return ianaZoneFor(destination.text);
    },
  },
  {
    id: "travelers",
    type: "structured",
    // The Latin spelling is the INTERVIEWER's job, not the organizer's. An
    // earlier version asked the organizer to supply it, and run 13 is why
    // that was wrong: having listed five people in Hebrew, they were then
    // asked to write all five names again in English — the same information,
    // typed twice, for a field they never asked for. Transliterating Hebrew
    // is exactly the low-stakes judgment the agent is good at, and a proposed
    // spelling the organizer can glance at and correct costs them one word
    // ("Sagi, not Sagie") instead of a whole list. Answers overwrite, so a
    // correction arriving later is a plain re-submit of this question.
    prompt: "Who's coming? List each person's name, age, and family/household group. If the names aren't in Latin script, transliterate them YOURSELF and submit that as each person's English spelling — then show the organizer the spellings you chose so they can correct any you got wrong. Never ask them to write the names out a second time.",
    dataShape: "array",
    dataExample: "[{\"name\": \"דנה אלול\", \"name_en\": \"Dana Elul\", \"age\": 12, \"family\": \"Elul\"}]",
    required: true,
    checkComplete: (data) =>
      hasNamedTraveler(data)
        ? null
        : "travelers must include at least one traveler's actual name — a headcount or age summary alone " +
          "(e.g. \"5 adults\") does not establish who is on this trip. Ask for the names directly.",
  },
  {
    id: "phases",
    type: "structured",
    prompt: "Where are you going, and when? List each stop: a short place name (city or region — e.g. \"Dallas\", not \"Dallas (boys; Mavericks game September 6)\"), date range, and accommodation (with confirmation number) if already booked. Keep any extra context — who's on this leg, an event, a plan detail — out of the name; it's fine to just not record it structurally. If a document gives a DATED day-by-day — activities under a date, with or without times — put it in `days`: that is the itinerary the family opens on the day, and without it a leg arrives on the site as a name and a date range. Never invent one: days come from what the document actually says.",
    dataShape: "array",
    // `planned` holds places the trip means to visit on this leg but has NOT
    // booked. The distinction from `travel_anchors` is EVIDENCE OF BOOKING —
    // a confirmation number, a ticket reference — not the kind of place: a
    // museum with an e-ticket is an anchor, the same museum named in an
    // itinerary is planned, and it becomes an anchor the day a booking for it
    // arrives. Recorded per phase because that is where a planned place
    // belongs; `_derive_phases` folds it into that phase's `venues[]`
    // (`_planned_as_venues`, transformer.py) so enrichment geocodes it the
    // same as a venue `extract_itinerary` found, just without a url.
    dataExample: "[{\"name\": \"Tokyo\", \"name_en\": \"Tokyo\", \"start\": \"2026-09-19\", \"end\": \"2026-09-23\", \"accommodation\": {\"name\": \"OMO3 Asakusa\", \"confirmation\": \"ABC123\"}, \"planned\": [\"Tokyo Skytree\", \"TeamLab Planets\"], \"days\": [{\"date\": \"2026-09-19\", \"label\": {\"he\": \"יום 1 — נחיתה\", \"en\": \"Day 1 — arrival\"}, \"items\": [{\"time\": \"10:00\", \"text\": {\"he\": \"נחיתה בנאריטה\", \"en\": \"Land at Narita\"}}]}]}]",
    required: true,
  },
  {
    id: "travel_anchors",
    type: "structured",
    prompt: "Any flights, hotels, or cars already booked? List them with confirmation numbers.",
    dataShape: "array",
    dataExample: "[{\"type\": \"flight|hotel|car\", \"name\": \"LY075 TLV-HND\", \"date\": \"2026-09-19\", \"confirmation\": \"ABC123\"}]",
    required: false,
  },
  {
    id: "constraints",
    type: "structured",
    prompt: "Anything the group needs to know about — mobility needs, budget expectations, or family dynamics?",
    dataShape: "object",
    dataExample: "{\"mobility\": \"...\", \"budget\": \"...\", \"family\": \"...\"}",
    required: false,
  },

  // ── Everything below is optional and tap-answerable ───────────────────────
  // These restore what the older human-driven interview
  // (.agents/skills/create-trip/INTERVIEW.md §9) collected and this one had
  // dropped. None of them block confirmation; they surface to the interviewer
  // through SessionView.optionalRemaining, not nextQuestion.
  //
  // None of the choice questions below set allowsOther. Their answers become
  // bilingual {he,en} strings in trip.config.json (participants[].needs[].text,
  // agent.standing_instructions[].text), and a free-text 'other' would only
  // ever be in the one language the organizer typed. Anything off-menu belongs
  // in bot_limits, which is structured and bilingual by construction.
  {
    id: "trip_pace",
    type: "choice",
    prompt: "What pace suits this group?",
    options: [
      { id: "easygoing", label: "Easygoing — late starts, few things a day" },
      { id: "balanced", label: "Balanced — a main plan a day, room to drift" },
      { id: "intense", label: "Intense — early starts, pack it in" },
    ],
    required: false,
  },
  {
    id: "dietary",
    type: "multi_choice",
    prompt: "Does any of this apply to anyone travelling? (tap all that apply)",
    options: [
      { id: "none", label: "None of these" },
      { id: "kosher", label: "Kosher" },
      { id: "kosher_style", label: "Kosher-style — no pork or shellfish, regular beef and chicken is fine" },
      { id: "vegetarian", label: "Vegetarian" },
      { id: "vegan", label: "Vegan" },
      { id: "lactose_free", label: "Lactose intolerant" },
      { id: "gluten_free", label: "Gluten-free / celiac" },
      { id: "nut_allergy", label: "Nut allergy" },
    ],
    required: false,
  },
  {
    id: "dietary_scope",
    type: "structured",
    prompt: "For each thing ticked above: everyone, or specific people? Keys are the option ids, values are \"everyone\" or a list of traveler names.",
    dataShape: "object",
    dataExample: "{\"kosher_style\": \"everyone\", \"lactose_free\": [\"Dana\"]}",
    required: false,
    // "For each thing ticked above" — so there has to be something ticked, and
    // "none of these" is the one tick that means there is not.
    applies: (answers) => {
      const dietary = answers.dietary;
      if (!dietary || dietary.kind !== "multi_choice") return false;
      return dietary.option_ids.some((id) => id !== EXCLUSIVE_OPTION_ID);
    },
  },
  {
    // REQUIRED as of 2026-09-11. Optional, it was the one skippable question
    // whose absence costs the whole assistant: `build_companion_handoff` will
    // not guess who gets the organizer's private channel, so an organizer who
    // tapped "finish" before reaching it got a site with no companion and a
    // build reported as a success — found by the first automated full cycle.
    //
    // Required does not mean always ASKED. The travelers answer, or a
    // document, often already says who is speaking ("me — Dror, 52, and Noa,
    // 45"; "Three of us: me (Dana), Omri, Yael"), and the interpreter records
    // it from there, so the router only asks when nobody has said.
    id: "organizer_identity",
    type: "text",
    prompt:
      "Which of the travelers is the person you are talking to? Record ONLY that traveler's own name, exactly as the travelers list has it — \"Dror\" or \"Dror Elul\", never \"Dror, the dad\" or \"I am Dror\". " +
      "Answer it WITHOUT asking whenever they have already said which traveler they are: \"me\", \"I\", \"myself\", \"אני\" next to a name in the travelers answer, or a document written in the first person (\"me (Dana)\"). " +
      "Never infer it from anything else — not from who signed up, not from who is listed first.",
    maxLength: 80,
    required: true,
  },
  {
    // The assistant's name, voice and tone are REQUIRED as of 2026-09-07, at the
    // organizer's request after run 15: "bot personality is important questions
    // and not optional". They are also load-bearing rather than decorative —
    // `build_companion_handoff` returns None without a name, so an unanswered
    // bot_name means no companion is built at all, and the trip arrives as a
    // site with nothing behind it. Asking for three short taps is cheaper than
    // that outcome.
    id: "bot_name",
    type: "text",
    // "the name the family would actually type" is literal: it becomes the
    // assistant's wake-word. A group that writes in two languages types it two
    // ways, so ask for both rather than letting the organizer cram them into
    // one field — japan-2026's organizer answered "בוטסאן / botsan" when asked
    // for one name, and both halves ended up in name AND name_en, matching
    // neither of the words anyone actually types.
    prompt:
      "What should the trip assistant be called? Give the name the family would actually type — if your group writes in two languages, give both (for example: בוטסאן / Botsan).",
    maxLength: 80,
    required: true,
  },
  {
    // Hebrew conjugates verbs by gender, so the assistant cannot form a
    // sentence without this. It is grammatical, not social — 'neutral' means
    // "prefer gender-avoidant phrasing", which reads slightly stiffer.
    id: "bot_gender",
    type: "choice",
    prompt: "How should the assistant refer to itself?",
    options: [
      { id: "male", label: "Male" },
      { id: "female", label: "Female" },
      { id: "neutral", label: "Neither — avoid gendered phrasing" },
    ],
    required: true,
    // A fixed three-way pick with no bearing on anything else already
    // answered — nothing here needs the agent's judgment. See `routerOwned`.
    routerOwned: true,
  },
  {
    id: "bot_tone",
    type: "choice",
    prompt: "What tone should it take?",
    options: [
      { id: "warm", label: "Warm" },
      { id: "playful", label: "Playful" },
      { id: "dry", label: "Dry" },
    ],
    required: true,
    routerOwned: true,
  },
  {
    id: "bot_proactive",
    type: "multi_choice",
    prompt: "What should it send on its own, without being asked? (tap all that apply)",
    options: [
      { id: "none", label: "Nothing — only answer when asked" },
      { id: "morning_briefing", label: "Morning briefing — today's plan" },
      { id: "tomorrow_preview", label: "Evening look-ahead at tomorrow" },
      { id: "photo_recap", label: "Photo recap when people upload" },
      { id: "flight_changes", label: "Flight changes" },
      { id: "packing_reminders", label: "Packing reminders the day before" },
    ],
    required: false,
    routerOwned: true,
  },
  {
    id: "bot_limits",
    type: "structured",
    prompt: "Anything it should keep in mind about these people, or stay away from? One entry per thing, each as {he, en}.",
    dataShape: "array",
    dataExample: "[\"never mention the surprise party\", \"Noam is shy about photos\"]",
    required: false,
  },
  // Additive-optional, like phases[].days — no INTAKE_SCHEMA_VERSION bump. A v2
  // intake answered before these existed simply has no entry, and the
  // transformer treats an absent answer as "not provided".
  {
    // Carried to the trip companion rather than acted on here. The interview
    // records STRUCTURE — who, where, when — and an organizer who says "we
    // haven't worked out what to do in Kyoto yet" is describing work the
    // companion does after the site exists, not a gap in the intake. Without
    // somewhere to put it, that ask is either lost or turns the interview into
    // a planning session it is not built to be.
    id: "planning_help",
    type: "text",
    prompt: "Is there anything you'd like help planning once the trip assistant is up — days you haven't worked out, places you're unsure about, bookings still to make? It won't hold up setup.",
    maxLength: 500,
    required: false,
  },
] as const;

// ── Answer store ─────────────────────────────────────────────────────────────

export interface ChoiceAnswer {
  kind: "choice";
  option_id: string;
  schema_version: number;
  other_text: null;
}

export interface OtherAnswer {
  kind: "choice_other";
  option_id: null;
  schema_version: number;
  other_text: string;
}

export interface TextAnswer {
  kind: "text";
  schema_version: number;
  text: string;
}

export interface StructuredAnswer {
  kind: "structured";
  schema_version: number;
  data: unknown;
}

/**
 * A multi-select answer. `option_ids` is deliberately a real array rather than
 * a delimited or JSON-encoded string stuffed into ChoiceAnswer.option_id:
 * encoding it would sail past the length/option validation below and reach the
 * transformer as an opaque blob it would have to re-parse.
 */
export interface MultiChoiceAnswer {
  kind: "multi_choice";
  option_ids: string[];
  schema_version: number;
  other_text: null;
}

export type IntakeAnswer = ChoiceAnswer | OtherAnswer | TextAnswer | StructuredAnswer | MultiChoiceAnswer;

export type AnswerStore = Record<string, IntakeAnswer>;

// ── Validation helpers ────────────────────────────────────────────────────────

export type AnswerValidationResult =
  | { ok: true; answer: IntakeAnswer }
  | {
      ok: false;
      reason: "UNKNOWN_QUESTION" | "UNKNOWN_OPTION" | "OTHER_TEXT_REQUIRED" | "OTHER_NOT_ALLOWED" | "TEXT_TOO_LONG" | "TEXT_REQUIRED" | "CHOICE_REQUIRED" | "SESSION_CONFIRMED" | "DATA_REQUIRED" | "DATA_WRONG_SHAPE" | "OPTIONS_REQUIRED" | "INCOMPLETE_ANSWER";
      // Set only for INCOMPLETE_ANSWER — the question-specific explanation
      // from `checkComplete`, carried through so the caller (ultimately the
      // agent) knows what is actually missing rather than just that
      // something was rejected.
      detail?: string;
    };

export function validateAnswer(
  questionId: string,
  optionId: string | "other" | null,
  otherText: string | null | undefined,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS,
  structuredData?: unknown,
  optionIds?: readonly string[],
): AnswerValidationResult {
  const question = questions.find((q) => q.id === questionId);
  if (!question) return { ok: false, reason: "UNKNOWN_QUESTION" };

  if (question.type === "multi_choice") {
    if (!optionIds) return { ok: false, reason: "OPTIONS_REQUIRED" };
    // Order and repeats come from however the chat UI serialised the taps;
    // neither is meaningful, and both would perturb the intake digest.
    const unique = [...new Set(optionIds)];
    for (const id of unique) {
      if (!question.options?.some((o) => o.id === id)) return { ok: false, reason: "UNKNOWN_OPTION" };
    }
    if (question.required && unique.length === 0) return { ok: false, reason: "CHOICE_REQUIRED" };
    return {
      ok: true,
      answer: { kind: "multi_choice", option_ids: unique.sort(), schema_version: INTAKE_SCHEMA_VERSION, other_text: null },
    };
  }

  if (question.type === "structured") {
    if (structuredData === undefined || structuredData === null) {
      if (question.required) return { ok: false, reason: "DATA_REQUIRED" };
      return { ok: true, answer: { kind: "structured", schema_version: INTAKE_SCHEMA_VERSION, data: question.dataShape === "array" ? [] : {} } };
    }
    const isArray = Array.isArray(structuredData);
    const isPlainObject = typeof structuredData === "object" && !isArray;
    if (question.dataShape === "array" && !isArray) return { ok: false, reason: "DATA_WRONG_SHAPE" };
    if (question.dataShape === "object" && !isPlainObject) return { ok: false, reason: "DATA_WRONG_SHAPE" };
    // Shape is necessary, not sufficient — see `checkComplete`'s doc comment.
    const incomplete = question.checkComplete?.(structuredData);
    if (incomplete) return { ok: false, reason: "INCOMPLETE_ANSWER", detail: incomplete };
    return { ok: true, answer: { kind: "structured", schema_version: INTAKE_SCHEMA_VERSION, data: structuredData } };
  }

  if (question.type === "choice") {
    if (optionId === "other") {
      if (!question.allowsOther) return { ok: false, reason: "OTHER_NOT_ALLOWED" };
      const text = otherText?.trim() ?? "";
      if (text.length === 0) return { ok: false, reason: "OTHER_TEXT_REQUIRED" };
      const max = question.maxLength ?? 500;
      if (text.length > max) return { ok: false, reason: "TEXT_TOO_LONG" };
      return {
        ok: true,
        answer: { kind: "choice_other", option_id: null, schema_version: INTAKE_SCHEMA_VERSION, other_text: text },
      };
    }
    if (!optionId) return { ok: false, reason: "CHOICE_REQUIRED" };
    const match = question.options?.find((o) => o.id === optionId);
    if (!match) return { ok: false, reason: "UNKNOWN_OPTION" };
    return {
      ok: true,
      answer: { kind: "choice", option_id: optionId, schema_version: INTAKE_SCHEMA_VERSION, other_text: null },
    };
  }

  // type === "text"
  const text = (optionId === null ? otherText : optionId) ?? "";
  const trimmed = text.trim();
  if (question.required && trimmed.length === 0) return { ok: false, reason: "TEXT_REQUIRED" };
  const max = question.maxLength ?? 500;
  if (trimmed.length > max) return { ok: false, reason: "TEXT_TOO_LONG" };
  return {
    ok: true,
    answer: { kind: "text", schema_version: INTAKE_SCHEMA_VERSION, text: trimmed },
  };
}

// ── Intake digest ─────────────────────────────────────────────────────────────

/** Canonical JSON serialisation of the intake for digest computation. */
function canonicalIntakePayload(tripId: string, answers: AnswerStore): string {
  const questionIds = INTAKE_QUESTIONS.map((q) => q.id);
  const orderedAnswers: Record<string, unknown> = {};
  for (const qid of questionIds) {
    if (answers[qid] !== undefined) orderedAnswers[qid] = answers[qid];
  }
  return JSON.stringify({
    schema_version: INTAKE_SCHEMA_VERSION,
    trip_id: tripId,
    answers: orderedAnswers,
  });
}

/**
 * Splits the question set into what is still missing and what is already known.
 *
 * `SessionView` cannot answer this: `nextQuestion` is only the NEXT required
 * question, so a view-derived "outstanding" would hide every other required one
 * from `interpret`. That would defeat the case the redesign is most confident
 * about — one message settling several questions at once ("just the four of us,
 * Japan, Sept 19th to Oct 3rd"). Retired ids are in neither list.
 */
/**
 * Whether a NEW session starts on the interpret path.
 *
 * Off unless `INTERPRET_PATH_DEFAULT` says otherwise, so nothing changes for
 * anyone who has not asked for it. It exists because flipping the flag by hand
 * after a session starts is a race the organizer wins: they tap the deep link,
 * the router asks its first question, and if they answer before the flip the
 * agent takes that turn — which is precisely the two-writers state the flag is
 * there to make impossible. The decision has to be made when the session is
 * created, or it is not really a decision.
 */
// ── Session expiry ────────────────────────────────────────────────────────────

/**
 * How long an interview may sit idle before it closes, and how long before that
 * the organizer is warned. Idle, not absolute — see migration 0049.
 */
export const SESSION_TTL_SECONDS = Number(process.env.INTERVIEW_SESSION_TTL_SECONDS || 60 * 60);
export const SESSION_WARN_BEFORE_SECONDS = Number(process.env.INTERVIEW_SESSION_WARN_SECONDS || 10 * 60);

/**
 * Pushes the idle deadline out. Called for every inbound message, before
 * anything slow — a conversation that is happening must never expire under the
 * person having it, including while a model call is in flight.
 *
 * Clears `expiry_warned_at` too: if they were warned and then wrote, the
 * warning did its job and the next idle stretch deserves its own.
 */
export async function touchSessionDeadline(
  db: pg.Pool,
  chatId: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<void> {
  await db.query(
    `UPDATE control_plane.intake_sessions
        SET expires_at = now() + make_interval(secs => $2),
            expiry_warned_at = NULL
      WHERE telegram_chat_id = $1 AND state <> 'confirmed' AND expired_at IS NULL`,
    [chatId, ttlSeconds],
  );
}

/**
 * Is a document sitting in this chat's burst, waiting to be read?
 *
 * The router must not speak while one is. Clearing `router_prompt_due_at` was
 * not enough: `advanceRouterOwnedQuestions` scans for chats merely AWAITING
 * THE MACHINE, which an upload sets, so it asked the trip type in the two
 * seconds between the file landing and the burst settling — live on
 * 2026-09-09, in between the two acknowledgements.
 *
 * Checked at `sendNextStep`, which every router message goes through, so a
 * seventh caller cannot forget it. Once the burst is claimed `pending_inbound`
 * is empty again and the document path owns the turn synchronously.
 */
export async function hasPendingInbound(db: pg.Pool, chatId: string): Promise<boolean> {
  // ANY pending message, not only a document.
  //
  // It started as a document check, because reading a file takes a minute and
  // the router was asking for things the file was about to answer. The same
  // race is there for TEXT, just narrower: interpreting a typed answer takes
  // seven to fourteen seconds and the burst settles in two, so the router
  // asked the next question in between. Live: "I answered, and immediately it
  // moved to the next question and after reacted."
  //
  // Whatever is waiting to be interpreted may answer what is about to be
  // asked. That is the rule, and the file was only its loudest case.
  const rows = await db.query<{ pending: boolean }>(
    `SELECT jsonb_array_length(pending_inbound) > 0 AS pending
       FROM control_plane.intake_sessions
      WHERE telegram_chat_id = $1 AND state <> 'confirmed' AND expired_at IS NULL`,
    [chatId],
  );
  return rows.rows[0]?.pending === true;
}

export interface ExpiringSession {
  sessionId: string;
  chatId: string;
  language: Language;
}

/**
 * Claims sessions inside the warning window, marking them warned in the same
 * statement so two poll ticks cannot both warn — the identical race
 * `claimSettledInboundBursts` and `claimDueRouterPrompts` already guard.
 */
export async function claimSessionsDueWarning(
  db: pg.Pool,
  limit = 10,
  warnBeforeSeconds: number = SESSION_WARN_BEFORE_SECONDS,
): Promise<ExpiringSession[]> {
  const rows = await db.query<{ id: string; telegram_chat_id: string; language: Language }>(
    `WITH claimed AS (
       SELECT id FROM control_plane.intake_sessions
        WHERE state <> 'confirmed'
          AND expired_at IS NULL
          AND expiry_warned_at IS NULL
          AND telegram_chat_id IS NOT NULL
          AND expires_at IS NOT NULL
          AND expires_at > now()
          AND expires_at <= now() + make_interval(secs => $2)
        ORDER BY expires_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE control_plane.intake_sessions s
        SET expiry_warned_at = now()
       FROM claimed c
      WHERE s.id = c.id
      RETURNING s.id, s.telegram_chat_id, s.language`,
    [limit, warnBeforeSeconds],
  );
  return rows.rows.map((r) => ({ sessionId: r.id, chatId: r.telegram_chat_id, language: r.language }));
}

/** Claims sessions past their deadline, closing them in the same statement. */
export async function claimExpiredSessions(db: pg.Pool, limit = 10): Promise<ExpiringSession[]> {
  const rows = await db.query<{ id: string; telegram_chat_id: string; language: Language }>(
    `WITH claimed AS (
       SELECT id FROM control_plane.intake_sessions
        WHERE state <> 'confirmed'
          AND expired_at IS NULL
          AND telegram_chat_id IS NOT NULL
          AND expires_at IS NOT NULL
          AND expires_at <= now()
        ORDER BY expires_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE control_plane.intake_sessions s
        SET expired_at = now()
       FROM claimed c
      WHERE s.id = c.id
      RETURNING s.id, s.telegram_chat_id, s.language`,
    [limit],
  );
  return rows.rows.map((r) => ({ sessionId: r.id, chatId: r.telegram_chat_id, language: r.language }));
}

/**
 * The language of an expired session on this chat, or null if there is none.
 *
 * Answers "someone wrote — is there a closed interview behind this chat?" The
 * language matters: telling someone their session closed, in English, when the
 * whole interview was in Hebrew, is its own small insult.
 */
export async function expiredSessionLanguage(db: pg.Pool, chatId: string): Promise<Language | null> {
  // The NOT EXISTS is load-bearing, and getting it wrong locks people out: a
  // new deep link creates a NEW session and leaves the expired one where it
  // is, so a query that only asks "is there an expired session here" would
  // answer yes forever and refuse every message of the replacement interview.
  // An expired session only speaks for a chat that has nothing live on it.
  const rows = await db.query<{ language: Language }>(
    `SELECT s.language
       FROM control_plane.intake_sessions s
      WHERE s.telegram_chat_id = $1
        AND s.expired_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM control_plane.intake_sessions live
           WHERE live.telegram_chat_id = $1 AND live.expired_at IS NULL
        )
      ORDER BY s.expired_at DESC LIMIT 1`,
    [chatId],
  );
  const [row] = rows.rows;
  if (!row) return null;
  // `language` is nullable and NULL for any session started without a Telegram
  // language hint — which is most of them. Returning it raw would make null
  // mean two different things, "no expired session" and "expired, language
  // unknown", and the caller reads null as the first: the guard would never
  // fire for exactly the sessions most likely to hit it. Found by the test,
  // not by reading the code.
  return row.language ?? DEFAULT_LANGUAGE;
}

export function interpretPathDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.INTERPRET_PATH_DEFAULT || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function partitionQuestions(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS,
): { outstanding: string[]; answered: string[] } {
  const outstanding: string[] = [];
  const answered: string[] = [];
  for (const q of questions) {
    if (RETIRED_QUESTION_IDS.has(q.id)) continue;
    if (answers[q.id] === undefined) outstanding.push(q.id);
    else answered.push(q.id);
  }
  return { outstanding, answered };
}

/** `partitionQuestions` for a live chat. Null when there is no open session. */
export async function questionStateForChat(
  db: pg.Pool,
  chatId: string,
): Promise<{ outstanding: string[]; answered: string[] } | null> {
  const rows = await db.query<{ answers: AnswerStore }>(
    `SELECT answers FROM control_plane.intake_sessions
      WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId],
  );
  const answers = rows.rows[0]?.answers;
  if (!answers) return null;
  return partitionQuestions(answers);
}

export function computeIntakeDigest(tripId: string, answers: AnswerStore): string {
  const payload = canonicalIntakePayload(tripId, answers);
  return `sha256:${sha256hex(payload)}`;
}

// ── Recap ─────────────────────────────────────────────────────────────────────

export interface RecapEntry {
  questionId: string;
  prompt: string;
  answerLabel: string;
}

/**
 * Returns a human-readable recap of the current answers. For 'other' answers
 * the literal organizer text is shown; it is never reclassified or summarized.
 */
/**
 * Renders a structured answer as something an organizer can actually check.
 *
 * It used to say "5 item(s) recorded". The two questions that most need
 * checking before an immutable version is written — who is coming, and where
 * you are going — were the two whose content the recap hid, so the confirm
 * step asked people to approve a number. Reported on the 2026-09-04 run.
 *
 * Deliberately shape-driven rather than a per-question formatter: `travelers`,
 * `phases`, `travel_anchors` and `budget` all arrive as LLM-assembled JSON
 * whose keys are conventional, not guaranteed, and a formatter that assumed
 * `phases[].name` would print nothing at all the first time one came back as
 * `title`. This reads whichever naming key is present and falls back to the
 * value itself.
 */
function describeStructured(data: unknown): string {
  const NAME_KEYS = ["name", "title", "label", "place", "city", "description"];
  const label = (item: unknown): string => {
    if (item === null || item === undefined) return "";
    if (typeof item !== "object") return String(item);
    // A NESTED ARRAY, summarised rather than stringified.
    //
    // Without this the object branch below fell through to `String(v)` and put
    // "[object Object],[object Object]" on the organizer's screen — live, in
    // the message whose whole job is showing what was taken from their
    // document so they can correct it. `budget_detail` is an object whose
    // `items` is an array, which is an ordinary shape and was the first one
    // tried.
    if (Array.isArray(item)) {
      const inner = item.map(label).filter((l) => l !== "");
      if (inner.length === 0) return item.length > 0 ? `${item.length}` : "";
      const shown = inner.slice(0, 3).join(", ");
      return inner.length > 3 ? `${shown} +${inner.length - 3}` : shown;
    }
    const record = item as Record<string, unknown>;
    const named = NAME_KEYS.map((k) => record[k]).find((v) => typeof v === "string" && v.trim() !== "");
    if (typeof named === "string") return named.trim();
    // No conventional name: show the first short scalar rather than nothing.
    const scalar = Object.values(record).find(
      (v) => (typeof v === "string" && v.trim() !== "" && v.length <= 60) || typeof v === "number",
    );
    return scalar === undefined ? "" : String(scalar);
  };

  if (Array.isArray(data)) {
    if (data.length === 0) return "(none)";
    const labels = data.map(label).filter((l) => l !== "");
    if (labels.length === 0) return `${data.length} recorded`;
    // Long rosters are trimmed rather than wrapped: the recap is one Telegram
    // message and every question is on it.
    const shown = labels.slice(0, 6).join(", ");
    return labels.length > 6 ? `${shown} +${labels.length - 6} more` : shown;
  }

  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    );
    if (entries.length === 0) return "(none)";
    // `String(v)` was the fallback here and it is the hazard: for any object it
    // produces "[object Object]", which is worse than showing nothing at all —
    // the organizer is being asked to check this for mistakes. An entry that
    // cannot be described is dropped instead.
    const described = entries
      .map(([k, v]) => [k, label(v)] as const)
      .filter(([, v]) => v !== "");
    if (described.length === 0) return "(none)";
    const shown = described.slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(", ");
    return described.length > 4 ? `${shown} +${described.length - 4} more` : shown;
  }

  return "(none)";
}

export function buildRecap(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS,
  language: Language = DEFAULT_LANGUAGE,
): RecapEntry[] {
  return questions
    .filter((q) => answers[q.id] !== undefined)
    .map((q) => {
      const ans = answers[q.id]!;
      let answerLabel: string;
      if (ans.kind === "choice") {
        answerLabel = optionLabel(q, ans.option_id, language);
      } else if (ans.kind === "choice_other") {
        // Marked, not just quoted. Free text that reads like a preset ("family
        // reunion" against a "Family" option) must not look like one on the
        // screen where an immutable version gets approved.
        answerLabel = `${uiString("otherPrefix", language)}: ${ans.other_text}`;
      } else if (ans.kind === "multi_choice") {
        answerLabel = ans.option_ids.length === 0
          ? uiString("none", language)
          : ans.option_ids.map((id) => optionLabel(q, id, language)).join(", ");
      } else if (ans.kind === "structured") {
        answerLabel = describeStructured(ans.data);
      } else {
        // A date is stored as YYYY-MM-DD for the transformer and read back in
        // words: an organizer never sees a format (QUESTIONS.md, dates).
        answerLabel = (ans.text && readableDate(ans.text, language)) || ans.text || uiString("skipped", language);
      }
      // `prompt` is the AGENT's field spec — it carries examples and schema
      // instructions no organizer should read, and reading them back on the
      // confirmation screen is where they did the most damage. The recap gets
      // a short noun instead.
      return { questionId: q.id, prompt: recapLabel(q, language), answerLabel };
    });
}

// ── Session state ─────────────────────────────────────────────────────────────

export type SessionState = "interviewing" | "awaiting_confirmation" | "confirmed";

export interface SessionView {
  sessionId: string;
  tripId: string;
  state: SessionState;
  /**
   * The next unanswered REQUIRED question. Required questions are walked by the
   * router on their own: every one has to be asked, so there is no judgement
   * for the interviewer to apply.
   */
  nextQuestion: IntakeQuestion | null;
  /**
   * The optional question the interviewer has nominated for the router to ask
   * next, if any. Optional questions are asked only when nominated — see
   * `InterviewUiState.pendingAsk`.
   */
  pendingAsk: IntakeQuestion | null;
  /**
   * Unanswered *optional* questions, in question order.
   *
   * `nextQuestion` only ever walks required questions, so without this the
   * interviewer had no way to learn an optional question existed — it could
   * only ask the ones it happened to remember from its reference doc, which
   * meant timezone, interests, anchors, dietary and the whole assistant block
   * were silently never asked. This is advisory: it does not gate
   * confirmation, and the organizer can decline any of it.
   */
  optionalRemaining: IntakeQuestion[];
  /** Set when state is 'awaiting_confirmation': the recap for the organizer to review. */
  recap: RecapEntry[] | null;
  /**
   * The language the router should draw in — what the organizer is writing,
   * as reported by the interviewer. English until it says otherwise.
   */
  language: Language;
  /** True once the "essentials done" choice has been put to the organizer. */
  offeredMore: boolean;
  /**
   * Where the interview is, as a phase it entered rather than a value
   * recomputed from the answers. The source of truth; `state` is its
   * projection into the older three-value vocabulary.
   */
  phase: InterviewPhase;
  /**
   * A phase whose entry action has not been performed yet, or null.
   *
   * This is what makes "shown exactly once" a property of the transition. The
   * boundary message and the recap each used to need a flag of their own
   * (`offered_more`, and a recap that re-fired on every write), because a
   * derived state cannot tell the router whether it has already spoken.
   */
  pendingEntry: InterviewPhase | null;
  /**
   * Whose turn it is to speak. Nothing is sent while this is "person" — that
   * is not a failure state, it is a conversation waiting on a human.
   */
  awaiting: AwaitingParty;
  /** One message the interviewer wrote, for the router to deliver verbatim. */
  pendingSay: string | null;
  /** The interviewer's own wording for `pendingAsk`, if it supplied one. */
  pendingAskText: string | null;
  /** What the router last sent, so it does not send it twice running. */
  lastPrompt: string | null;
  /**
   * Option ids currently selected per multi-select question.
   *
   * The router redraws a multi-select keyboard on every tap, and it has to
   * show what is already ticked — otherwise the organizer cannot tell whether
   * their last tap selected or deselected.
   */
  selections: Record<string, string[]>;
}

function currentSelections(answers: AnswerStore): Record<string, string[]> {
  const selections: Record<string, string[]> = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    if (answer && (answer as { kind?: string }).kind === "multi_choice") {
      selections[questionId] = [...((answer as { option_ids?: string[] }).option_ids ?? [])];
    }
  }
  return selections;
}

/**
 * Router UI intent, persisted per session (migration 0034).
 *
 * Not part of the intake: nothing downstream of the interview reads it. It
 * exists so the router can tell "still collecting optional answers" apart from
 * "ready to confirm", which the three-value `state` column cannot express.
 */
export interface InterviewUiState {
  finishRequested?: boolean;
  skipped?: string[];
  /**
   * Required questions that were asked and not answered, stepped aside so the
   * interview can move on instead of repeating one after every message.
   *
   * Distinct from `skipped`, which is final and applies only to optional
   * questions. A deferred question is still owed: `deferredRequired` brings it
   * back at the boundary, and `confirmIntake` refuses without it either way.
   */
  deferred?: string[];
  /**
   * The multi-select question being ticked right now.
   *
   * A multi-select answer IS the whole set, so every tap has to be written down
   * — Telegram keeps no selection state of its own and the ticks are redrawn
   * from what we stored. But a written answer is also what makes a question
   * answered, so on 2026-09-12 the first tap on `dietary` ended the question:
   * the next one went out while `Done` was still sitting on the organizer's
   * screen, mid-selection.
   *
   * So the selection is recorded and the question stays current until `Done` or
   * `Skip` finalizes it. Every other writer — a typed answer through the
   * interpret path, the agent submitting the whole set — clears it, because
   * either of those IS the finalization.
   */
  multiPending?: string;
  /**
   * The optional question the interviewer has asked the router to put next.
   *
   * Optional questions are not walked automatically when an interviewer is
   * configured. WHICH one is worth asking, and whether to ask it at all, is
   * conversational judgement: `timezone` should never be put to someone who
   * has already said Japan. The router owns rendering because only it can draw
   * a keyboard; the agent owns pacing because only it is in the conversation.
   *
   * The 2026-09-04 run 3 is what settled this. Walking the list end to end
   * turned the interview into a form — "it completely drifted" — after run 2
   * had shown the opposite failure, never asking an optional question at all.
   */
  pendingAsk?: string;
  /**
   * What the router last sent, as a coarse key ("q:dietary", "recap").
   *
   * The router is prompted to speak by every agent write, and an agent that
   * writes five answers off one document produced five messages. Repeating
   * what it just said is never useful, so it does not.
   */
  lastPrompt?: string;
  /**
   * Whether the organizer has already been offered the "essentials done"
   * choice. It is sent once, at the boundary — after that the interviewer
   * carries the conversation and a repeat would be the router nagging.
   */
  offeredMore?: boolean;
  /**
   * One message the interviewer has written for the organizer, waiting to be
   * sent by the router.
   *
   * Track 4's central move: the agent is the only VOICE, the router the only
   * WRITER. The agent no longer sends anything itself — it writes here and the
   * router delivers, which is what makes "one message per turn" a property of
   * the schema rather than a rule in a prompt. A single slot, not a queue, on
   * purpose: runs 5 and 6 were both floods, and a slot cannot flood.
   */
  pendingSay?: string;
  /**
   * The interviewer's own wording for the question in `pendingAsk`.
   *
   * The router owns the KEYBOARD, not the sentence. Reciting `intake-copy.ts`
   * at people is what made run 3 read as a form — "it completely drifted" —
   * so the agent phrases the question in the organizer's own language and the
   * router attaches the buttons to it. Absent, the router falls back to its
   * own copy, which is robotic but never stuck.
   */
  pendingAskText?: string;
  /**
   * True once the organizer has done anything at all after the document offer.
   *
   * The opening phase ends on any signal — a document, a tap on "I don't have
   * one", or simply typing. Without a marker, an organizer who taps past the
   * offer and says nothing would sit in `opening` forever, since no answer has
   * been recorded to move them on.
   */
  openingDone?: boolean;
  /** A phase entered whose entry action the router has not performed yet. */
  pendingEntry?: InterviewPhase;
}

function parseUiState(raw: unknown): InterviewUiState {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const skipped = Array.isArray(record.skipped)
    ? record.skipped.filter((id): id is string => typeof id === "string")
    : undefined;
  // Both directions are an explicit allowlist, which is the right shape — but
  // it means a field added to the interface and to a writer, and NOT added
  // here, is written and then silently dropped on the next read. That is what
  // happened to `deferred` first time out: the defer call succeeded, the
  // question came straight back, and nothing anywhere said why.
  const deferred = Array.isArray(record.deferred)
    ? record.deferred.filter((id): id is string => typeof id === "string")
    : undefined;
  return {
    ...(record.finish_requested === true ? { finishRequested: true } : {}),
    ...(skipped && skipped.length > 0 ? { skipped } : {}),
    ...(deferred && deferred.length > 0 ? { deferred } : {}),
    ...(typeof record.pending_ask === "string" ? { pendingAsk: record.pending_ask } : {}),
    ...(record.offered_more === true ? { offeredMore: true } : {}),
    ...(typeof record.last_prompt === "string" ? { lastPrompt: record.last_prompt } : {}),
    ...(typeof record.pending_say === "string" ? { pendingSay: record.pending_say } : {}),
    ...(typeof record.pending_ask_text === "string" ? { pendingAskText: record.pending_ask_text } : {}),
    ...(record.opening_done === true ? { openingDone: true } : {}),
    ...(isInterviewPhase(record.pending_entry) ? { pendingEntry: record.pending_entry } : {}),
    ...(typeof record.multi_pending === "string" ? { multiPending: record.multi_pending } : {}),
  };
}

function serializeUiState(ui: InterviewUiState): string {
  return JSON.stringify({
    ...(ui.finishRequested ? { finish_requested: true } : {}),
    ...(ui.skipped && ui.skipped.length > 0 ? { skipped: ui.skipped } : {}),
    ...(ui.deferred && ui.deferred.length > 0 ? { deferred: ui.deferred } : {}),
    ...(ui.pendingAsk ? { pending_ask: ui.pendingAsk } : {}),
    ...(ui.offeredMore ? { offered_more: true } : {}),
    ...(ui.lastPrompt ? { last_prompt: ui.lastPrompt } : {}),
    ...(ui.pendingSay ? { pending_say: ui.pendingSay } : {}),
    ...(ui.pendingAskText ? { pending_ask_text: ui.pendingAskText } : {}),
    ...(ui.openingDone ? { opening_done: true } : {}),
    ...(ui.pendingEntry ? { pending_entry: ui.pendingEntry } : {}),
    ...(ui.multiPending ? { multi_pending: ui.multiPending } : {}),
  });
}

function isSkipped(ui: InterviewUiState, questionId: string): boolean {
  return (ui.skipped ?? []).includes(questionId);
}

/**
 * The question the router should ask next: required ones in order, then the
 * optional ones the organizer has neither answered nor skipped.
 *
 * Optional questions used to be invisible here — `nextQuestion` walked only
 * required ones — which left them to the agent, and the agent can only ask
 * them with `clarify`. Under relay routing `clarify` cannot draw a keyboard,
 * so every optional question degraded to a numbered list the organizer had to
 * type a number into, with Hermes's own "(Recommended)" label stuck on the
 * first choice. Walking them here is what gives them real buttons.
 */
/**
 * The next required question worth putting now.
 *
 * `deferred` holds required questions the organizer was asked and did not
 * answer. They step aside rather than being repeated: repeating one on every
 * message is nagging, and the first live run of the re-ask produced exactly
 * that — "עוד צריך את זה: מתי הטיול מתחיל?" after every message that was about
 * something else.
 *
 * Stepping aside is not dropping. When nothing un-deferred is left,
 * `deferredRequired` below brings them all back at the boundary, before the
 * summary, where "I still need these to finish" is information rather than
 * pestering. `confirmIntake` refuses without them regardless, so the interview
 * cannot end having quietly lost one.
 */
function nextUnansweredQuestion(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[],
  ui: InterviewUiState = {},
): IntakeQuestion | null {
  const deferred = new Set(ui.deferred ?? []);
  const unanswered = questions.filter(
    (q) => q.required && (answers[q.id] === undefined || ui.multiPending === q.id),
  );
  return unanswered.find((q) => !deferred.has(q.id)) ?? null;
}

/**
 * Required questions still unanswered, whether deferred or not — what the
 * interview cannot finish without. Empty means the summary is reachable.
 */
export function deferredRequired(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[] = INTAKE_QUESTIONS,
): IntakeQuestion[] {
  return questions.filter((q) => q.required && answers[q.id] === undefined);
}

/**
 * Steps a required question aside for now. Never touches `answers`, so the
 * question is still outstanding everywhere that matters — only the ORDER of
 * asking changes.
 */
export async function deferQuestionForChat(
  db: pg.Pool,
  chatId: string,
  questionId: string,
): Promise<void> {
  const question = INTAKE_QUESTIONS.find((q) => q.id === questionId);
  if (!question?.required) return;
  await updateUiStateForChat(db, chatId, (ui) => ({
    ...ui,
    deferred: [...new Set([...(ui.deferred ?? []), questionId])],
  }));
}

/**
 * Brings every deferred question back. Called at the boundary, when there is
 * nothing else left to ask and the interview would otherwise try to finish.
 */
export async function undeferAllForChat(db: pg.Pool, chatId: string): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => ({ ...ui, deferred: [] }));
}

/** The optional question the interviewer nominated, if it is still askable. */
function pendingAskQuestion(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[],
  ui: InterviewUiState,
): IntakeQuestion | null {
  if (!ui.pendingAsk || ui.finishRequested) return null;
  const question = questions.find((q) => q.id === ui.pendingAsk);
  if (!question || isSkipped(ui, question.id)) return null;
  // A nomination cannot revive a question that does not apply: the agent reads
  // `optionalRemaining`, which already excludes it, but nothing stopped it
  // naming one anyway.
  if (question.applies && !question.applies(answers)) return null;
  return question;
}

function unansweredOptionalQuestions(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[],
  ui: InterviewUiState = {},
): IntakeQuestion[] {
  // `!RETIRED` is load-bearing and was missing. The set was consulted by the
  // recap, by corrections and by the proposal gate — but not here, so retiring
  // an OPTIONAL question left the router still asking it. It only ever worked
  // because the two existing entries had been deleted from the list outright.
  return questions.filter(
    (q) =>
      !q.required &&
      !RETIRED_QUESTION_IDS.has(q.id) &&
      (answers[q.id] === undefined || ui.multiPending === q.id) &&
      !isSkipped(ui, q.id) &&
      (q.applies?.(answers) ?? true),
  );
}

// ── The floor ─────────────────────────────────────────────────────────────────

/**
 * Whose turn it is to speak. See `0038_interview_floor.sql` for why this is a
 * property of the SESSION rather than of a turn or a question.
 */
export type AwaitingParty = "person" | "machine";

/**
 * The organizer has spoken; the machine owes the next message.
 *
 * Called on every inbound message and tap. Restarting `awaiting_since` here is
 * the point: the deadline measures how long WE have taken, never how long a
 * person has been reading.
 *
 * `floorSeconds`, when passed, overrides the general `AGENT_FLOOR_SECONDS`
 * watchdog deadline for this session until the next call clears it (omitting
 * it resets to the default, not to whatever was there before) — see
 * `DOCUMENT_FLOOR_SECONDS`. A floor-reclaim call (the agent producing a
 * second, later word) omits it on purpose: by the time the agent has written
 * something once, the silent-stall risk the wider window exists for has
 * already passed.
 */
export async function markAwaitingMachine(
  db: pg.Pool,
  chatId: string,
  floorSeconds?: number,
): Promise<void> {
  await db.query(
    `UPDATE control_plane.intake_sessions
        SET awaiting = 'machine', awaiting_since = now(), awaiting_floor_seconds = $2
      WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId, floorSeconds ?? null],
  );
}

/**
 * We have spoken; it is the organizer's turn.
 *
 * Called after ANY message goes out, whoever wrote it. Claimed atomically: the
 * update only succeeds while the floor is still ours, so two would-be speakers
 * racing to answer one organizer message produce exactly one reply. That is
 * the whole mechanism — run 7 got most questions twice because nothing
 * arbitrated between the router and the interviewer.
 */
export async function claimFloor(db: pg.Pool, chatId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE control_plane.intake_sessions
        SET awaiting = 'person', awaiting_since = now()
      WHERE telegram_chat_id = $1 AND state <> 'confirmed' AND awaiting = 'machine'`,
    [chatId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Phases ────────────────────────────────────────────────────────────────────

/**
 * Where the interview IS, as somewhere it arrived rather than something
 * recomputed from the answers on every read.
 *
 * See `0037_interview_phase.sql` for why. Briefly: a derived state has no
 * notion of ENTERING anything, so the recap re-fired over every later question
 * (run 2), and it can become unreachable, so run 6 answered every required
 * question and still had no path to confirmation.
 */
export const INTERVIEW_PHASES = ["opening", "essentials", "optional", "recap", "confirmed"] as const;
export type InterviewPhase = (typeof INTERVIEW_PHASES)[number];

export function isInterviewPhase(value: unknown): value is InterviewPhase {
  return typeof value === "string" && (INTERVIEW_PHASES as readonly string[]).includes(value);
}

/**
 * The phase this session should be in, given where it is now and what has been
 * recorded since.
 *
 * Only ever moves forward through the questions, with one deliberate exception:
 * `recap -> optional`, which is "Keep planning". Everything else is a one-way
 * door, so an answer arriving late cannot drag a confirmed interview backwards.
 *
 * Returns the SAME phase when nothing should move — callers compare and only
 * run entry actions on an actual change, which is what makes "shown exactly
 * once" a property of the transition rather than a flag someone remembered to
 * set.
 */
export function nextPhase(
  current: InterviewPhase,
  answers: AnswerStore,
  questions: readonly IntakeQuestion[],
  ui: InterviewUiState = {},
): InterviewPhase {
  if (current === "confirmed") return "confirmed";

  const requiredDone = questions.filter((q) => q.required).every((q) => answers[q.id] !== undefined);

  if (current === "opening") {
    // The opening exists to offer the document before anyone types a trip they
    // already have written down (run 5). It ends the moment the organizer does
    // anything at all — including sending that document.
    return Object.keys(answers).length > 0 || ui.openingDone ? (requiredDone ? "optional" : "essentials") : "opening";
  }

  if (current === "essentials") return requiredDone ? "optional" : "essentials";

  if (current === "optional") {
    if (ui.finishRequested) return "recap";
    // Running out is the other way in. Confirmation is gated on the REQUIRED
    // set alone, so arriving here early skips nothing that matters.
    return unansweredOptionalQuestions(answers, questions, ui).length === 0 ? "recap" : "optional";
  }

  // recap: the organizer either confirms (handled by confirmIntake, which sets
  // the phase directly) or reopens the questions with Keep planning.
  return ui.finishRequested ? "recap" : "optional";
}

/**
 * `state` is the old three-value vocabulary, now derived FROM the phase.
 *
 * Kept because every existing reader, API response and confirmation guard
 * speaks it. The phase is the source of truth; this is the projection, so the
 * two can never disagree the way `state` and `ui_state` used to.
 */
export function stateForPhase(phase: InterviewPhase): SessionState {
  if (phase === "confirmed") return "confirmed";
  if (phase === "recap") return "awaiting_confirmation";
  return "interviewing";
}

/**
 * Two conditions, not one. Answering the last required question no longer ends
 * the interview: the organizer either has to run out of optional questions or
 * say they are finished.
 *
 * Confirmation is still gated on the REQUIRED set alone (`confirmIntake`), so
 * finishing early skips nothing that matters — this only decides whether the
 * router asks another question or shows the recap.
 */
function deriveSessionState(
  answers: AnswerStore,
  questions: readonly IntakeQuestion[],
  ui: InterviewUiState = {},
): SessionState {
  const allRequired = questions.filter((q) => q.required);
  const allAnswered = allRequired.every((q) => answers[q.id] !== undefined);
  if (!allAnswered) return "interviewing";
  if (ui.finishRequested) return "awaiting_confirmation";
  return unansweredOptionalQuestions(answers, questions, ui).length === 0
    ? "awaiting_confirmation"
    : "interviewing";
}

// ── Public API ────────────────────────────────────────────────────────────────

export type StartSessionResult =
  | { ok: true; sessionId: string; sessionToken: string; view: SessionView }
  | { ok: false; reason: "INVALID_TOKEN" | "EXPIRED" | "ALREADY_CONSUMED" | "REVOKED" | "TRIP_NOT_DRAFT" };

export type GetSessionResult =
  | { ok: true; view: SessionView }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_ANSWERED" | "ROUTER_OWNED" };

export type SubmitAnswerResult =
  | { ok: true; view: SessionView }
  | {
      ok: false;
      reason: "NOT_FOUND" | "SESSION_CONFIRMED" | "UNKNOWN_QUESTION" | "UNKNOWN_OPTION" | "OTHER_TEXT_REQUIRED" | "OTHER_NOT_ALLOWED" | "TEXT_TOO_LONG" | "TEXT_REQUIRED" | "CHOICE_REQUIRED" | "DATA_REQUIRED" | "DATA_WRONG_SHAPE" | "OPTIONS_REQUIRED" | "INCOMPLETE_ANSWER";
      detail?: string;
    };

export type ConfirmIntakeResult =
  | { ok: true; sessionId: string; intakeVersionId: string; digest: string; versionNumber: number }
  | { ok: false; reason: "NOT_FOUND" | "NOT_ALL_REQUIRED_ANSWERED" | "UNSAFE_ANSWER_CONTENT"; unsafePath?: string };

// A private Telegram chat id is always a positive integer in string form —
// reject anything else rather than storing whatever an LLM tool-call
// argument happened to contain (see migration 0022's header on why this
// value is a best-effort hint, never treated as verified identity).
const TELEGRAM_CHAT_ID_HINT_PATTERN = /^\d{1,20}$/;

// The router-verified binding (0028) accepts the same positive-integer shape,
// and that restriction is load-bearing rather than incidental: a Telegram
// GROUP chat id is negative (supergroups are -100…), so this pattern also
// enforces that only a private 1:1 DM can start an interview. An interview
// carries the organizer's own answers and its enrollment is scoped to one
// owner; conducting it in a group would put that behind whoever else is in
// the room. Group chats bind to a trip's COMPANION instead (0019), after the
// signed organizer action Sprint 5 requires.
const TELEGRAM_PRIVATE_CHAT_ID_PATTERN = /^\d{1,20}$/;

/**
 * Exchanges a valid enrollment token for a session, atomically:
 *   1. Verifies and consumes the enrollment (FOR UPDATE lock)
 *   2. Transitions the trip from 'draft' → 'intake_in_progress'
 *   3. Creates the intake_sessions row with a fresh session token
 *   4. Records telegramChatIdHint (if present and well-formed) as the
 *      trip's best-effort notification delivery hint — see migration 0022.
 *   5. Records verifiedTelegramChatId (if present and well-formed) on the
 *      session itself, binding this chat to this interview — see 0028.
 *
 * The two chat-id parameters are NOT interchangeable, and the difference is
 * the whole point of both migrations:
 *
 *   telegramChatIdHint      relayed by the interviewer LLM as a tool-call
 *                           argument. Unverified. Delivery hint only; must
 *                           never become an identity or routing fact.
 *   verifiedTelegramChatId  read by the Trip Bot router off the Telegram
 *                           update it received on its own authenticated
 *                           connection. No message content or agent can
 *                           influence it, so routing may rely on it.
 *
 * Returns the session ID and raw session token. The raw token is not stored —
 * only its SHA-256 digest is. Subsequent session API calls must present this
 * token to be authenticated.
 */
export async function startSession(
  db: pg.Pool,
  rawEnrollmentToken: string,
  log: (line: string) => void = () => {},
  telegramChatIdHint?: string,
  verifiedTelegramChatId?: string,
  languageHint?: string,
): Promise<StartSessionResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const enrollment = await consumeEnrollmentInTx(client, rawEnrollmentToken);
    if (!enrollment) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "INVALID_TOKEN" };
    }

    // Verify the trip is still in 'draft' (enrollment could be issued and
    // the trip could have moved if something went wrong on a prior attempt).
    const tripRow = await client.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [enrollment.tripId],
    );
    const [trip] = tripRow.rows;
    if (!trip || trip.lifecycle_state !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_DRAFT" };
    }

    // Transition trip to 'intake_in_progress'.
    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress', updated_at = now() WHERE id = $1",
      [enrollment.tripId],
    );

    if (telegramChatIdHint && TELEGRAM_CHAT_ID_HINT_PATTERN.test(telegramChatIdHint)) {
      await client.query(
        "UPDATE control_plane.trips SET notification_chat_id_hint = $1 WHERE id = $2 AND notification_chat_id_hint IS DISTINCT FROM $1",
        [telegramChatIdHint, enrollment.tripId],
      );
    }

    // Create session with a fresh token.
    const rawSessionToken = randomBytes(32).toString("base64url");
    const digest = sessionTokenDigest(rawSessionToken);
    const sessionId = generateId("sess");

    // Bound in the SAME transaction as the session it identifies: a chat
    // bound to a session that then failed to commit would route later
    // messages at nothing, and the router treats "no live session" as
    // unbound (fail closed). Written NULL when the caller is not the
    // router — the HTTP/MCP path has no verified chat id to offer.
    const chatId =
      verifiedTelegramChatId && TELEGRAM_PRIVATE_CHAT_ID_PATTERN.test(verifiedTelegramChatId)
        ? verifiedTelegramChatId
        : null;

    // Telegram hands us the organizer's own client locale on the very first
    // message, so the router can draw its FIRST question in the right language
    // instead of waiting for the interviewer to report one. That wait is not
    // theoretical: on the 2026-09-04 run 4 the file acknowledgement — the one
    // message whose whole purpose is to arrive before the agent can answer —
    // went out in English because nothing had set a language yet.
    //
    // A hint, not a decision. It is the phone's setting rather than what the
    // organizer is actually writing, so `setLanguageForChat` overrides it the
    // moment the interviewer reports what they really typed.
    const language = coerceLanguage(languageHint);

    await client.query(
      `INSERT INTO control_plane.intake_sessions
         (id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id, language, interpret_path)
       VALUES ($1, $2, $3, $4, $5, 'interviewing', '{}'::jsonb, $6, $7, $8)`,
      [sessionId, enrollment.tripId, enrollment.userId, enrollment.enrollmentId, digest, chatId, language, interpretPathDefault()],
    );

    await client.query("COMMIT");

    log(structuredLog("info", "interview.session_started", { session_id: sessionId, trip_id: enrollment.tripId }));

    const view: SessionView = {
      sessionId,
      tripId: enrollment.tripId,
      state: "interviewing",
      nextQuestion: INTAKE_QUESTIONS.find((q) => q.required) ?? null,
      pendingAsk: null,
      optionalRemaining: unansweredOptionalQuestions({}, INTAKE_QUESTIONS),
      recap: null,
      selections: {},
      language: language ?? DEFAULT_LANGUAGE,
      offeredMore: false,
      lastPrompt: null,
      phase: "opening",
      awaiting: "person",
      pendingEntry: null,
      pendingSay: null,
      pendingAskText: null,
    };
    return { ok: true, sessionId, sessionToken: rawSessionToken, view };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Looks up a session by its bearer token and returns the current view.
 * The session token is the sole credential — it was bound to one user and one
 * trip at issuance time, so no additional identity check is required.
 */
export async function getSession(
  db: pg.Pool,
  rawSessionToken: string,
): Promise<GetSessionResult> {
  const digest = sessionTokenDigest(rawSessionToken);
  const row = await db.query<{
    id: string;
    trip_id: string;
    user_id: string;
    state: SessionState;
    phase: string;
    awaiting: string;
    answers: AnswerStore;
    ui_state: unknown;
    language: string | null;
  }>(
    `SELECT id, trip_id, user_id, state, phase, awaiting, answers, ui_state, language
     FROM control_plane.intake_sessions
     WHERE session_token_digest = $1`,
    [digest],
  );
  const [session] = row.rows;
  if (!session) return { ok: false, reason: "NOT_FOUND" };

  return {
    ok: true,
    view: buildSessionView(
      session.id,
      session.trip_id,
      session.state,
      session.answers,
      parseUiState(session.ui_state),
      coerceLanguage(session.language) ?? DEFAULT_LANGUAGE,
      isInterviewPhase(session.phase) ? session.phase : "opening",
      session.awaiting === "machine" ? "machine" : "person",
    ),
  };
}

/**
 * The current view of whichever interview a Telegram chat is conducting.
 *
 * Read-only counterpart to submitAnswerForChat, and addressed the same way —
 * by the router-verified chat id, never a session token. The router needs this
 * to know what is actually pending before it answers a written message: a
 * choice question means "the buttons are right there", a text or structured
 * one means the organizer did as asked and the deterministic layer cannot
 * record it.
 *
 * Unlike the write paths this only considers a LIVE session. There is no
 * idempotency to preserve on a read, and a confirmed session is not something
 * the router should still be narrating.
 */
export async function getSessionForChat(db: pg.Pool, chatId: string): Promise<GetSessionResult> {
  const row = await db.query<{
    id: string;
    trip_id: string;
    state: SessionState;
    phase: string;
    awaiting: string;
    answers: AnswerStore;
    ui_state: unknown;
    language: string | null;
  }>(
    `SELECT id, trip_id, state, phase, awaiting, answers, ui_state, language
     FROM control_plane.intake_sessions
     WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId],
  );
  const [session] = row.rows;
  if (!session) return { ok: false, reason: "NOT_FOUND" };
  return {
    ok: true,
    view: buildSessionView(
      session.id,
      session.trip_id,
      session.state,
      session.answers,
      parseUiState(session.ui_state),
      coerceLanguage(session.language) ?? DEFAULT_LANGUAGE,
      isInterviewPhase(session.phase) ? session.phase : "opening",
      session.awaiting === "machine" ? "machine" : "person",
    ),
  };
}

/**
 * The current view of the interview whose turn the router has open for this
 * chat — the interviewer agent's read path.
 *
 * Addressed and gated exactly like submitAnswerForAgent: the chat named here
 * has to match a turn the router opened when it forwarded, and both halves of
 * "open" are required. Reads are gated as well as writes because the session
 * view carries the organizer's answers so far.
 *
 * FUTURE: replace the supplied chat id with gateway-injected trusted context
 * once the relay contract can carry it.
 */
export type ResolveOpenTurnResult =
  | { ok: true; chatId: string }
  | { ok: false; reason: "NOT_FOUND" | "AMBIGUOUS" };

/**
 * Finds the chat whose interview turn is open, without being told which.
 *
 * The interviewer agent cannot name its own chat. Verified on the live
 * install 2026-09-03: the gateway sets `_chat_id` on the agent object but
 * nothing renders it into the prompt, so the model has no per-turn access to
 * it — the only place a chat id ever appeared was a stored memory belonging
 * to a different profile. An agent asked for a chat id it cannot know either
 * refuses, or guesses; on the first live run it guessed nothing and invented
 * the rest of the interview instead.
 *
 * So the router's turn — already the sole authorization fact for these routes
 * — becomes the selector too. This is strictly SAFER than the chat-addressed
 * form it replaces: there, a wrong id from the model was refused only because
 * no turn matched it; here there is no id to get wrong. Migration 0022's rule
 * is unchanged and better honoured, because nothing the LLM says is read.
 *
 * Both open-ness filters are required, exactly as in the JOIN below: a
 * superseded turn is closed but may not have expired, an abandoned one has
 * expired but was never closed.
 *
 * AMBIGUOUS is deliberate rather than a "pick the newest" heuristic. Two
 * organizers mid-interview is the case where guessing wrong writes one
 * person's answer into the other's trip, which is the exact failure the
 * two-trip matrix exists to prevent. Refusing is recoverable; a silent
 * cross-write is not. LIMIT 2 is all that is needed to tell one from many.
 */
/**
 * Removes an unconfirmed session left occupying a chat by an earlier,
 * unrelated trip attempt — never a confirmed one, and never the caller's own.
 *
 * Why deleting is safe here and would not be anywhere else: `intake_versions`
 * is the durable, immutable record, created only on confirmation.
 * `intake_sessions` in any other state is draft scratch — abandoning it costs
 * nothing that was ever final. This is production's version of what
 * `fresh-interview.py --yes` already does by hand for test resets; the
 * production path needed the same guarantee, because a real organizer can
 * just as easily start a second signup on the same Telegram account after
 * abandoning a first one.
 *
 * Callers MUST have already confirmed the session belongs to a trip other
 * than the one about to start — this has no opinion on that, it only deletes
 * what it is given.
 */
export async function closeStaleSessionForChat(db: pg.Pool, sessionId: string): Promise<void> {
  await db.query("DELETE FROM control_plane.interview_agent_turns WHERE session_id = $1", [sessionId]);
  await db.query(
    "DELETE FROM control_plane.intake_sessions WHERE id = $1 AND state <> 'confirmed'",
    [sessionId],
  );
}

export async function resolveChatFromOpenTurn(db: pg.Pool): Promise<ResolveOpenTurnResult> {
  const rows = await db.query<{ chat_id: string }>(
    `SELECT t.chat_id
     FROM control_plane.interview_agent_turns t
     JOIN control_plane.intake_sessions s ON s.id = t.session_id
     WHERE t.closed_at IS NULL
       AND t.expires_at > now()
       AND s.state <> 'confirmed'
     LIMIT 2`,
  );
  if (rows.rows.length === 0) return { ok: false, reason: "NOT_FOUND" };
  if (rows.rows.length > 1) return { ok: false, reason: "AMBIGUOUS" };
  return { ok: true, chatId: rows.rows[0]!.chat_id };
}

/**
 * Claims the sessions that owe the organizer a router-rendered prompt.
 *
 * `UPDATE ... RETURNING` so the claim and the clear are one statement: two
 * poller iterations overlapping cannot both send the same prompt, and a crash
 * after the claim loses one prompt rather than repeating it forever. Losing
 * one is recoverable — the organizer's next message brings the interview back
 * through the normal path; repeating one means an organizer watching the same
 * question arrive every few seconds.
 */
/**
 * How long the router waits for the interviewer to stop writing before it
 * speaks.
 *
 * Every write schedules a prompt by setting `router_prompt_due_at = now()`, so
 * an agent recording a document's worth of answers schedules one per answer.
 * Deduplication does not help — each write genuinely produces a DIFFERENT next
 * question — and on 2026-09-04 run 6 the organizer got nine messages in a row
 * for it.
 *
 * Each write pushes the timestamp forward, so this is a debounce rather than a
 * delay: the router speaks once, after the burst, about wherever the interview
 * actually ended up. Short enough that a single answer still feels immediate.
 */
export const ROUTER_PROMPT_SETTLE_SECONDS = 3;

// ── Inbound settle: one turn per burst, not one per message ────────────────────
//
// The mirror image of the router-prompt settle window above, on the OTHER
// side of the pipe. Run 9, 2026-09-05: "it still seems that hermes and gw are
// competing." Five rapid Telegram messages (one line per family member)
// produced seven overlapping agent turns, because each message forwarded
// immediately and openAgentTurn tears down whatever turn is open before
// starting the next — while Hermes keeps its OWN, now-orphaned conversation
// loop for the torn-down turn running regardless. Two uncoordinated
// invocations independently deciding to ask the same question is what
// produced the duplicate asks; a checkbox refused because a different
// invocation had already answered that field is what read as "buttons do not
// move it".
//
// Every message in a burst still starts a real turn eventually — nothing here
// drops anything. It only decides WHEN: not on every message, but once the
// burst has genuinely stopped.

/** How long a burst of inbound messages must go quiet before it is forwarded, as one. */
export const INBOUND_SETTLE_SECONDS = 2;

/**
 * Interview.ts does not know the relay's wire format and deliberately does not
 * import it — layering runs relay -> interview, never the other way. This is
 * only what THIS module needs to touch: enough to store and hand back
 * whatever the caller put in, opaquely. The relay layer casts it back to its
 * own `WireMessageEvent` when combining a burst, since it is the only writer
 * and already trusts its own shape.
 */
/**
 * One message inside a settling burst, as it is stored in `pending_inbound`.
 *
 * This type used to say `{ text: string }`, which was not true: the relay
 * queues the whole `WireMessageEvent` and `flushSettledInboundBursts` cast it
 * straight back with `as WireMessageEvent[]`. The declaration being narrower
 * than the data hid `message_id` — already carried from Telegram by
 * `normalize.ts` — from everything downstream, and `interpret` needs it to key
 * an interpretation to the messages that caused it (docs/interview-without-an-agent.md §6).
 *
 * Structural rather than an import of `WireMessageEvent`: the interview does
 * not otherwise know the relay's wire protocol, and the fields below are the
 * ones it actually reads. Extra keys survive the round trip regardless — this
 * is jsonb.
 */
export interface QueuedInboundEvent {
  text: string;
  /** Telegram's message id, when it gave one. Absent for synthesised events. */
  message_id?: string;
  media_urls?: string[];
}

/**
 * Adds one inbound message to the chat's burst, pushing the settle deadline
 * forward — the same "keeps getting further away while writes keep coming"
 * debounce as `scheduleRouterPrompt`, applied to the other direction.
 *
 * Deliberately does NOT open a turn or push anything to the agent. That is
 * the relay layer's job, once, for the whole burst — which is the entire
 * point: a message queued here is one that used to tear down and replace
 * whatever turn was open.
 */
export async function queueInboundMessage(
  db: pg.Pool,
  chatId: string,
  event: QueuedInboundEvent,
): Promise<void> {
  // A DOCUMENT SILENCES THE PENDING QUESTION.
  //
  // Reading a booking takes about two minutes, and the burst does not even
  // settle for two seconds — so a router prompt already owing fires in that
  // gap and asks for the destination while the answer is being read out of the
  // file. Live on 2026-09-08: the organizer uploaded a PDF and was immediately
  // asked the trip type and the destination, both of which were in it.
  //
  // Clearing the deadline rather than adding a "hold" flag, because the
  // document path calls `sendNextStep` when it is done and that schedules
  // whatever is genuinely still needed. Nothing is lost — the question is
  // asked later, if the document did not already answer it, which is the
  // entire point of accepting one.
  if ((event.media_urls?.length ?? 0) > 0) {
    await db.query(
      `UPDATE control_plane.intake_sessions
          SET router_prompt_due_at = NULL
        WHERE telegram_chat_id = $1 AND state <> 'confirmed' AND expired_at IS NULL`,
      [chatId],
    );
  }
  // Set to now(), not now()+settle — matching scheduleRouterPrompt exactly.
  // The settle window lives entirely in claimSettledInboundBursts's WHERE
  // clause ("has it been quiet for N seconds"), not in when this timestamp is
  // written. Writing it as now()+N here would make the two disagree about
  // what the timestamp MEANS, and every later message in the burst pushing it
  // forward again is exactly the debounce this needs.
  await db.query(
    `UPDATE control_plane.intake_sessions
        SET pending_inbound = pending_inbound || to_jsonb($2::jsonb),
            inbound_settle_due_at = now()
      WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId, JSON.stringify(event)],
  );
}

export interface SettledInboundBurst {
  sessionId: string;
  tripId: string;
  chatId: string;
  events: QueuedInboundEvent[];
}

/**
 * Claims every burst that has gone quiet for `settleSeconds`, clearing the
 * buffer atomically as part of the same claim — so two poll ticks can never
 * both flush the same burst, the identical race `claimDueRouterPrompts`
 * already has to guard against.
 */
export async function claimSettledInboundBursts(
  db: pg.Pool,
  limit = 10,
  settleSeconds: number = INBOUND_SETTLE_SECONDS,
): Promise<SettledInboundBurst[]> {
  // A CTE, not a plain UPDATE ... RETURNING: RETURNING reflects the row AFTER
  // the SET, so a naive `RETURNING pending_inbound` on the same statement that
  // clears it to '[]' returns the empty array it just wrote, not the burst
  // being claimed. `claimed` runs the SELECT (and takes the row lock) first,
  // and the outer UPDATE joins against ITS captured pending_inbound — the
  // clear and the read of what is being cleared happen in the same
  // transaction without one seeing the other's result.
  const rows = await db.query<{
    id: string;
    trip_id: string;
    telegram_chat_id: string;
    pending_inbound: QueuedInboundEvent[];
  }>(
    `WITH claimed AS (
       SELECT id, trip_id, telegram_chat_id, pending_inbound
         FROM control_plane.intake_sessions
        WHERE inbound_settle_due_at IS NOT NULL
          AND inbound_settle_due_at < now() - make_interval(secs => $2)
          AND jsonb_array_length(pending_inbound) > 0
          AND telegram_chat_id IS NOT NULL
        ORDER BY inbound_settle_due_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE control_plane.intake_sessions s
        SET pending_inbound = '[]'::jsonb, inbound_settle_due_at = NULL
       FROM claimed c
      WHERE s.id = c.id
      RETURNING s.id, s.trip_id, s.telegram_chat_id, c.pending_inbound`,
    [limit, settleSeconds],
  );
  return rows.rows.map((r) => ({
    sessionId: r.id,
    tripId: r.trip_id,
    chatId: r.telegram_chat_id,
    events: r.pending_inbound,
  }));
}


export async function claimDueRouterPrompts(
  db: pg.Pool,
  limit = 10,
  settleSeconds: number = ROUTER_PROMPT_SETTLE_SECONDS,
): Promise<Array<{ sessionId: string; chatId: string }>> {
  const rows = await db.query<{ id: string; telegram_chat_id: string }>(
    `UPDATE control_plane.intake_sessions
        SET router_prompt_due_at = NULL
      WHERE id IN (
        SELECT id FROM control_plane.intake_sessions
         WHERE router_prompt_due_at IS NOT NULL
           AND router_prompt_due_at < now() - make_interval(secs => $2)
           AND telegram_chat_id IS NOT NULL
         ORDER BY router_prompt_due_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, telegram_chat_id`,
    [limit, settleSeconds],
  );
  return rows.rows.map((r) => ({ sessionId: r.id, chatId: r.telegram_chat_id }));
}

/**
 * How long the interviewer gets to answer before the router takes the floor
 * back and speaks for it.
 *
 * Thirty seconds, chosen by Dror against the latency he actually sat through:
 * long enough that a model reading a shared PDF is not interrupted mid-thought,
 * short enough that nobody is left looking at a silent chat wondering whether
 * it broke.
 *
 * Built 2026-09-05: a document/photo turn now gets `DOCUMENT_FLOOR_SECONDS`
 * instead of this. Run 12 was the evidence — a real document turn ran past a
 * minute before its first write, so this 30s floor closed it out from under a
 * still-working agent and produced two live 404s ("the interview tools
 * returned a 404 NOT_FOUND twice, so the document details were not saved").
 * The interview still finished (the watchdog's own fallback question kept it
 * moving), but Dror's verdict was that the retry-and-recover pattern itself is
 * the UX cost: "later questions asked several times... the race between the
 * agent and router nearly resolved."
 */
export const AGENT_FLOOR_SECONDS = 30;

/**
 * The floor for a turn opened by a document or photo upload, set via
 * `markAwaitingMachine`'s `floorSeconds` override at the one call site that
 * knows a turn started with media (`interview_to_gateway` in the relay
 * poller). Ninety seconds, not thirty: Dror's own read of run 12's timing —
 * long enough that extracting five travelers, five phases and seven booking
 * anchors from a PDF is not interrupted mid-read, short enough that a
 * genuinely stuck agent is still caught inside two minutes.
 */
export const DOCUMENT_FLOOR_SECONDS = 90;

/**
 * Takes the floor back from an interviewer that has gone quiet.
 *
 * Track 4 made the agent the only voice, which removed a whole class of defect
 * and introduced exactly one: if the agent stalls or fumbles a tool call, the
 * organizer now gets SILENCE rather than a stray message. Runs 4 and 6 both had
 * that stall — in run 4 it announced it was "fixing" a fault it cannot fix, in
 * run 6 it simply stopped — so this is not a hypothetical failure being
 * pre-empted.
 *
 * Closing the turn is what hands the floor over: `sendNextStep` will then draw
 * the next question from `intake-copy.ts`. Robotic, and infinitely better than
 * nothing.
 *
 * Claimed with FOR UPDATE SKIP LOCKED and closed in the same statement, so two
 * poll ticks cannot both decide to speak for the same silent agent — which
 * would produce, of all things, the bombardment this design exists to prevent.
 */
export async function claimStalledAgentTurns(
  db: pg.Pool,
  limit = 10,
  floorSeconds: number = AGENT_FLOOR_SECONDS,
): Promise<Array<{ sessionId: string; chatId: string }>> {
  const rows = await db.query<{ session_id: string; chat_id: string }>(
    `UPDATE control_plane.interview_agent_turns
        SET closed_at = now()
      WHERE id IN (
        SELECT t.id
          FROM control_plane.interview_agent_turns t
          JOIN control_plane.intake_sessions s ON s.id = t.session_id
         WHERE t.closed_at IS NULL
           -- The deadline is the SESSION's, not the turn's. A turn opened
           -- while the organizer was still reading used to age against a
           -- person, which is what made the watchdog fire on conversations
           -- that were not stuck at all.
           AND s.awaiting = 'machine'
           -- A document/photo turn carries its own, wider deadline (set by
           -- markAwaitingMachine's floorSeconds override) — the session's own
           -- floor wins over the caller's default when present.
           AND s.awaiting_since < now() - make_interval(secs => COALESCE(s.awaiting_floor_seconds, $2))
           AND s.state <> 'confirmed'
           AND s.telegram_chat_id IS NOT NULL
           -- Nothing waiting to be delivered, and nothing the agent has
           -- written. Only a turn that produced NOTHING AT ALL is a stall.
           --
           -- router_prompt_due_at alone stopped being sufficient once phase
           -- transitions began scheduling prompts of their own: it no longer
           -- means the agent wrote something. The two ui_state slots do mean
           -- exactly that, so they are what the guard asks about.
           AND s.router_prompt_due_at IS NULL
           AND s.ui_state->>'pending_say' IS NULL
           AND s.ui_state->>'pending_ask' IS NULL
         ORDER BY t.opened_at
         FOR UPDATE OF t SKIP LOCKED
         LIMIT $1
      )
      RETURNING session_id, chat_id`,
    [limit, floorSeconds],
  );
  return rows.rows.map((r) => ({ sessionId: r.session_id, chatId: r.chat_id }));
}

/**
 * Chats currently mid-interview with the machine holding the floor — the
 * candidate set Track 8's router-owned-question advancement scans every poll
 * tick. A plain read, unlike `claimStalledAgentTurns`: nothing here claims,
 * locks, or closes anything, so it can run as often as the loop likes. Most
 * ticks find nothing to do — `sendNextStep`'s own dedupe against `lastPrompt`
 * is what makes calling it speculatively, every tick, for every candidate,
 * safe rather than wasteful.
 */
export async function listMachineAwaitingChats(
  db: pg.Pool,
  limit = 25,
): Promise<Array<{ chatId: string; isAsyncWork: boolean }>> {
  const rows = await db.query<{ telegram_chat_id: string; awaiting_floor_seconds: number | null }>(
    `SELECT telegram_chat_id, awaiting_floor_seconds
       FROM control_plane.intake_sessions
      WHERE awaiting = 'machine'
        AND state = 'interviewing'
        AND telegram_chat_id IS NOT NULL
      ORDER BY awaiting_since
      LIMIT $1`,
    [limit],
  );
  return rows.rows.map((r) => ({
    chatId: r.telegram_chat_id,
    // A non-default floor is only ever set for a turn carrying media — see
    // `applyDecision`. It is therefore the one durable signal for "the agent
    // is off doing async work" as opposed to "the agent is mid-conversation",
    // and Track 8 needs exactly that distinction to know whether speaking
    // would be filling dead air or talking over the interviewer.
    isAsyncWork: r.awaiting_floor_seconds !== null,
  }));
}

export async function getSessionForAgent(db: pg.Pool, chatId: string): Promise<GetSessionResult> {
  const row = await db.query<{
    id: string;
    trip_id: string;
    state: SessionState;
    phase: string;
    awaiting: string;
    answers: AnswerStore;
    ui_state: unknown;
    language: string | null;
  }>(
    `SELECT s.id, s.trip_id, s.state, s.phase, s.awaiting, s.answers, s.ui_state, s.language
     FROM control_plane.intake_sessions s
     JOIN control_plane.interview_agent_turns t
       ON t.session_id = s.id
     WHERE t.chat_id = $1
       AND t.closed_at IS NULL
       AND t.expires_at > now()
       AND s.state <> 'confirmed'`,
    [chatId],
  );
  const [session] = row.rows;
  if (!session) return { ok: false, reason: "NOT_FOUND" };
  return {
    ok: true,
    view: buildSessionView(
      session.id,
      session.trip_id,
      session.state,
      session.answers,
      parseUiState(session.ui_state),
      coerceLanguage(session.language) ?? DEFAULT_LANGUAGE,
      isInterviewPhase(session.phase) ? session.phase : "opening",
      session.awaiting === "machine" ? "machine" : "person",
    ),
  };
}

function buildSessionView(
  sessionId: string,
  tripId: string,
  storedState: SessionState,
  answers: AnswerStore,
  ui: InterviewUiState = {},
  language: Language = DEFAULT_LANGUAGE,
  phase: InterviewPhase = "opening",
  awaiting: AwaitingParty = "person",
): SessionView {
  if (storedState === "confirmed") {
    return {
      sessionId, tripId, state: "confirmed", nextQuestion: null, pendingAsk: null,
      optionalRemaining: [], recap: null, selections: currentSelections(answers), language,
      offeredMore: ui.offeredMore === true,
      lastPrompt: ui.lastPrompt ?? null,
      phase: "confirmed",
      awaiting: "person",
      pendingEntry: null,
      pendingSay: null,
      pendingAskText: null,
    };
  }
  // The phase is the authority; `state` is its projection. Deriving it here the
  // old way as well would recreate the dual-authority problem A2 exists to
  // remove — a session whose `state` and `ui_state` disagreed is how run 2's
  // recap re-fired and run 6's confirmation became unreachable.
  const state = stateForPhase(phase);
  return {
    sessionId,
    tripId,
    state,
    nextQuestion: state === "interviewing" ? nextUnansweredQuestion(answers, INTAKE_QUESTIONS, ui) : null,
    pendingAsk: state === "interviewing" ? pendingAskQuestion(answers, INTAKE_QUESTIONS, ui) : null,
    // Listed in both states, unlike nextQuestion/recap: an optional question is
    // still worth offering once the required ones are done, and in practice
    // that's when the good answers arrive — the organizer is warmed up and the
    // roster is already on the table.
    optionalRemaining: unansweredOptionalQuestions(answers, INTAKE_QUESTIONS, ui),
    recap: state === "awaiting_confirmation" ? buildRecap(answers, INTAKE_QUESTIONS, language) : null,
    selections: currentSelections(answers),
    language,
    offeredMore: ui.offeredMore === true,
    lastPrompt: ui.lastPrompt ?? null,
    phase,
    awaiting,
    pendingEntry: ui.pendingEntry ?? null,
    pendingSay: ui.pendingSay ?? null,
    pendingAskText: ui.pendingAskText ?? null,
  };
}

// ── Locating a session ────────────────────────────────────────────────────────

/**
 * How a caller proves it is entitled to act on a session.
 *
 * Two credentials, deliberately not interchangeable:
 *
 *   token  the session bearer token, issued at startSession and held by the
 *          HTTP and MCP callers. Bound to one user and one trip at issuance.
 *   chat   a Telegram chat id the Trip Bot router read off its OWN
 *          authenticated connection to Telegram (migration 0028). No message
 *          body, tool argument, or agent can influence it.
 *
 * The router holds the second and not the first, and that is on purpose: it
 * never sees a session token, and storing one at rest just to satisfy a
 * function signature would create a durable credential where the binding
 * already IS the authorization fact. So the locator is what varies, and
 * everything below it — the confirmed-session guards, validation, versioning —
 * is shared rather than reimplemented per caller.
 */
type SessionLocator =
  | { by: "token"; token: string; expectedSessionId?: string }
  | { by: "chat"; chatId: string }
  | { by: "agent"; chatId: string };

interface LockedSession {
  id: string;
  trip_id: string;
  user_id: string;
  state: SessionState;
  answers: AnswerStore;
  ui_state: unknown;
  language: string | null;
  source_document: unknown;
  /**
   * Available, and deliberately not fed to `buildSessionView` here.
   *
   * Its `phase` and `awaiting` parameters both default — to "opening" and
   * "person" — and the two transactional writers below pass neither, so every
   * view they return claims the organizer holds the floor. That is what made a
   * tapped Skip silent on 2026-09-12: the skip was recorded, the keyboard
   * collapsed, and `sendNextStep` refused to speak on a view that said it was
   * the organizer's turn.
   *
   * Passing them through looks like the fix and is not: `state` is projected
   * from `phase`, and a truthful floor lets the router speak in the middle of
   * an AGENT turn — three Track 8 tests reject exactly that, and they are
   * right to. So the floor is corrected where a tap is being answered
   * (`applyInterviewCallback`), and the defaults here are left alone until
   * someone takes on the arbitration question properly.
   */
  phase: InterviewPhase;
  awaiting: AwaitingParty;
}

/**
 * Selects and row-locks the one session a locator designates.
 *
 * The chat branch does NOT filter out confirmed sessions, and that is what
 * makes a double-tap safe. Two concurrent taps both pass resolveChatRoute
 * while the session is still live; the first confirms and commits, and the
 * second then re-reads the row under the lock. Had the predicate excluded
 * `confirmed`, that second read would find nothing and report NOT_FOUND for
 * what was actually a successful confirmation. Instead it sees the confirmed
 * row and takes the idempotent path.
 *
 * A chat accumulates confirmed sessions over time — one per trip the organizer
 * has onboarded from that DM — so an ordering is needed for the answer to be
 * deterministic: the live session wins, and among confirmed ones the most
 * recently touched. Migration 0028's partial unique index guarantees at most
 * one live session per chat, so the first sort key can never tie.
 */
async function lockSession(
  client: pg.PoolClient,
  locator: SessionLocator,
): Promise<LockedSession | null> {
  const columns = "id, trip_id, user_id, state, answers, ui_state, language, source_document, phase, awaiting";
  if (locator.by === "token") {
    const row = await client.query<LockedSession>(
      `SELECT ${columns}
       FROM control_plane.intake_sessions
       WHERE session_token_digest = $1 AND ($2::text IS NULL OR id = $2)
       FOR UPDATE`,
      [sessionTokenDigest(locator.token), locator.expectedSessionId ?? null],
    );
    return row.rows[0] ?? null;
  }
  if (locator.by === "agent") {
    // Joined rather than looked up separately so the turn is verified in the
    // same transaction — and against the same row — that the write locks.
    // Checking it beforehand would leave a gap in which the turn is closed or
    // the session ends between the check and the write.
    //
    // Both halves of "open" are required here. A turn the router superseded is
    // closed but may not have expired; an abandoned one has expired but was
    // never closed. Either alone would admit a turn that is no longer current.
    const row = await client.query<LockedSession>(
      `SELECT ${columns.split(", ").map((c) => `s.${c}`).join(", ")}
       FROM control_plane.intake_sessions s
       JOIN control_plane.interview_agent_turns t
         ON t.session_id = s.id
       WHERE t.chat_id = $1
         AND t.closed_at IS NULL
         AND t.expires_at > now()
       FOR UPDATE OF s`,
      [locator.chatId],
    );
    return row.rows[0] ?? null;
  }
  const row = await client.query<LockedSession>(
    `SELECT ${columns}
     FROM control_plane.intake_sessions
     WHERE telegram_chat_id = $1
     ORDER BY (state <> 'confirmed') DESC, updated_at DESC
     LIMIT 1
     FOR UPDATE`,
    [locator.chatId],
  );
  return row.rows[0] ?? null;
}

/**
 * Submits an answer to a question in an active session.
 *
 * For choice questions: pass the option id (e.g. "family") or "other" plus
 * the free-text follow-up in otherText.
 * For multi_choice questions: pass every selected option id in optionIds.
 * For text questions: pass the text in optionId (the same parameter slot,
 * since it's the primary answer value).
 *
 * The session must not be confirmed. A second submission for the same question
 * overwrites the previous answer (corrections are allowed before CONFIRM).
 */
export async function submitAnswer(
  db: pg.Pool,
  rawSessionToken: string,
  questionId: string,
  optionId: string | "other" | null,
  otherText?: string,
  expectedSessionId?: string,
  structuredData?: unknown,
  optionIds?: readonly string[],
): Promise<SubmitAnswerResult> {
  return submitAnswerVia(
    db,
    { by: "token", token: rawSessionToken, expectedSessionId },
    questionId, optionId, otherText, structuredData, optionIds,
  );
}

/**
 * How long a forwarded turn stays open.
 *
 * Long enough for an agent to read the session, resolve a written answer and
 * write it back; short enough that an abandoned turn stops being usable
 * without anything having to notice it was abandoned.
 */
export const AGENT_TURN_TTL_SECONDS = 300;

export interface AgentTurn {
  id: string;
  chatId: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * Opens a turn for a chat whose written message the router is forwarding to
 * the interviewer agent, and returns it.
 *
 * Called by the router at the moment it forwards, and only then. A second
 * forward for the same chat supersedes the first rather than opening a rival
 * row — 0031's partial unique index over the open rows would reject the
 * second insert otherwise, and "the newest forward is the live one" is the
 * behaviour that matches how a conversation actually moves.
 */
export async function openAgentTurn(
  db: pg.Pool,
  chatId: string,
  sessionId: string,
  ttlSeconds: number = AGENT_TURN_TTL_SECONDS,
): Promise<AgentTurn> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE control_plane.interview_agent_turns
       SET closed_at = now()
       WHERE chat_id = $1 AND closed_at IS NULL`,
      [chatId],
    );
    const id = generateId("iat");
    const row = await client.query<{ expires_at: Date }>(
      `INSERT INTO control_plane.interview_agent_turns(id, chat_id, session_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       RETURNING expires_at`,
      [id, chatId, sessionId, ttlSeconds],
    );
    await client.query("COMMIT");
    return { id, chatId, sessionId, expiresAt: row.rows[0]!.expires_at };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Does this chat already have a live turn with the interviewer?
 *
 * Asked before handing another one over. On 2026-09-04 run 5 the router handed
 * back to an agent that was already mid-turn, the agent's next write scheduled
 * another router prompt, that found nothing to ask and handed back again:
 * nine turns and twenty-eight messages into one short interview, which the
 * organizer described, accurately, as being bombarded.
 *
 * Filters on BOTH conditions, per 0031's header — a superseded turn is closed
 * but may not have expired, and an abandoned one is expired but never closed.
 */
export async function hasOpenAgentTurn(db: pg.Pool, chatId: string): Promise<boolean> {
  const row = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM control_plane.interview_agent_turns
      WHERE chat_id = $1 AND closed_at IS NULL AND expires_at > now()`,
    [chatId],
  );
  return (row.rows[0]?.n ?? "0") !== "0";
}

/** Closes a chat's open turn, if it has one. */
export async function closeAgentTurn(db: pg.Pool, chatId: string): Promise<void> {
  await db.query(
    `UPDATE control_plane.interview_agent_turns
     SET closed_at = now()
     WHERE chat_id = $1 AND closed_at IS NULL`,
    [chatId],
  );
}

/**
 * Records an answer on behalf of the interviewer agent, for the chat whose
 * turn the router currently has open.
 *
 * Same write path and same rules as every other caller; what differs is only
 * how the session is found. The chat named here is matched against the turn
 * the router opened when it forwarded, inside the write transaction — see
 * lockSession's "agent" branch. A chat with no open turn resolves to no
 * session, so the write is refused the same way an unknown session is.
 *
 * FUTURE: replace the supplied chat id with gateway-injected trusted context
 * once the relay contract can carry it, and this entry point collapses back
 * into submitAnswerForChat.
 */
/** Marks a session as owing its organizer a router-drawn message. */
async function scheduleRouterPrompt(db: pg.Pool, sessionId: string): Promise<void> {
  await db.query(
    "UPDATE control_plane.intake_sessions SET router_prompt_due_at = now() WHERE id = $1",
    [sessionId],
  );
}

export async function submitAnswerForAgent(
  db: pg.Pool,
  chatId: string,
  questionId: string,
  optionId: string | "other" | null,
  otherText?: string,
  structuredData?: unknown,
  optionIds?: readonly string[],
): Promise<SubmitAnswerResult> {
  const result = await submitAnswerVia(
    db,
    { by: "agent", chatId },
    questionId, optionId, otherText, structuredData, optionIds,
  );
  // Hand the turn back to the router. It owns the keyboard — the agent cannot
  // draw one, because `clarify` needs the relay `prompt` op this connector
  // does not advertise. Without this the interview silently loses its buttons
  // for good the first time an organizer types instead of tapping.
  //
  // The floor is reclaimed here too, and for the same reason as sayForChat: an
  // agent recording an extracted answer well after its own first reply already
  // released the floor is exactly what a document with several answers in it
  // does. Scheduling alone is not enough — `sendNextStep`'s floor guard would
  // otherwise swallow the very next-question prompt this comment says must
  // never be lost.
  if (result.ok) {
    await markAwaitingMachine(db, chatId);
    await scheduleRouterPrompt(db, result.view.sessionId);
  }
  return result;
}

/**
 * Records an answer for whichever interview the given Telegram chat is
 * conducting — the Trip Bot router's entry point.
 *
 * The chat id is the credential (see SessionLocator). The router obtained it
 * from Telegram itself, so this needs no further identity check, and crucially
 * no session token: a tapped button carries only WHICH OPTION was chosen, and
 * which session that lands in is decided here, from the chat, in the same
 * transaction that writes the answer.
 */
/**
 * Applies a change to the router's UI state for the interview a chat is
 * conducting: a skipped optional question, or the organizer saying they are
 * finished.
 *
 * Same authority as every other chat-scoped write — the session comes from the
 * chat id the router read off its own authenticated Telegram connection, never
 * from anything the message said.
 */
async function updateUiStateForChat(
  db: pg.Pool,
  chatId: string,
  mutate: (ui: InterviewUiState) => InterviewUiState,
): Promise<GetSessionResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const session = await lockSession(client, { by: "chat", chatId });
    if (!session) { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }
    if (session.state === "confirmed") { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }

    const ui = mutate(parseUiState(session.ui_state));
    const newState = deriveSessionState(session.answers, INTAKE_QUESTIONS, ui);
    await client.query(
      "UPDATE control_plane.intake_sessions SET ui_state = $1, state = $2, updated_at = now() WHERE id = $3",
      [serializeUiState(ui), newState, session.id],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      view: buildSessionView(
        session.id, session.trip_id, newState, session.answers, ui,
        coerceLanguage(session.language) ?? DEFAULT_LANGUAGE,
      ),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The interviewer asks the router to put one optional question next.
 *
 * This is the pacing half of the router/agent split. The agent decides that
 * food is worth asking about now; the router draws the keyboard, because
 * `clarify` cannot. Nominating a question the organizer already answered is
 * allowed — that is how a correction gets re-offered.
 */
/**
 * The interviewer's one message for this turn, for the router to deliver.
 *
 * This is Track 4's `say`. The agent used to send prose straight down the
 * relay, which is how chain-of-thought, third-person narration about "the
 * router", and its own correction notes all reached organizers — every one of
 * those a prompt rule that failed live at least once. Routing the words
 * through here makes the agent the only voice and the router the only writer,
 * so nothing reaches Telegram that was not deliberately addressed to a person.
 *
 * One slot. A second call in the same turn REPLACES the first rather than
 * queueing behind it: the agent's latest thought is the one worth sending, and
 * a queue is the shape both bombardments had.
 */
/**
 * Marks the agent as having spoken properly in its current turn (0047).
 *
 * Called from the real speaking tools, never from the prose conversion — the
 * whole point is to tell the two apart. Silent when there is no open turn: an
 * agent speaking outside one has bigger problems than this flag.
 */
async function markAgentSpoke(db: pg.Pool, chatId: string): Promise<void> {
  await db.query(
    `UPDATE control_plane.interview_agent_turns
        SET agent_spoke_at = COALESCE(agent_spoke_at, now())
      WHERE chat_id = $1 AND closed_at IS NULL`,
    [chatId],
  );
}

/**
 * Whether the agent has already spoken through a real tool in this turn.
 *
 * The conversion of raw prose into a say consults this. Prose INSTEAD of
 * speaking is a message worth rescuing — that is why the conversion exists.
 * Prose AFTER speaking is the agent thinking out loud, and delivering it is how
 * an organizer gets told the assistant is "waiting for your answer" to a
 * question the router never sent.
 */
export async function agentAlreadySpokeThisTurn(db: pg.Pool, chatId: string): Promise<boolean> {
  const { rows } = await db.query<{ spoke: boolean }>(
    `SELECT agent_spoke_at IS NOT NULL AS spoke
       FROM control_plane.interview_agent_turns
      WHERE chat_id = $1 AND closed_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1`,
    [chatId],
  );
  return rows[0]?.spoke ?? false;
}

export async function sayForChat(
  db: pg.Pool,
  chatId: string,
  text: string,
): Promise<GetSessionResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "NOT_FOUND" };
  // The agent explicitly choosing to speak is itself the reason the floor is
  // ours, regardless of what it was a moment ago. Found live on 2026-09-05: a
  // document upload got an immediate "reading it now" reply — floor correctly
  // released to the organizer afterward — and then, ~100 seconds later, once
  // extraction had actually finished, the agent's own completion message sat
  // in ui_state UNDELIVERED for the rest of the session. `sendNextStep`'s very
  // first check is `awaiting === "person"` — return immediately, no send at
  // all — and nothing there was going to flip it back, because the only thing
  // that ever did was the ORGANIZER's next message. The floor was built to
  // stop the ROUTER inserting itself uninvited once someone has already
  // replied; it was never meant to silence the agent's own second, deliberate
  // word about the same turn it is still actively working through.
  await markAwaitingMachine(db, chatId);
  const result = await updateUiStateForChat(db, chatId, (ui) => ({ ...ui, pendingSay: trimmed }));
  if (result.ok) {
    await scheduleRouterPrompt(db, result.view.sessionId);
    await markAgentSpoke(db, chatId);
  }
  return result;
}

/**
 * Fills in every question whose answer can be worked out from what is already
 * recorded.
 *
 * Called after each write, before the phase is advanced, so a derived answer
 * counts toward "are the optional questions done" exactly like a typed one.
 * Silent by design: the organizer is not told that a question was skipped,
 * because from their side it was never a question.
 *
 * Conservative throughout — a derivation returning null leaves the question
 * askable, and an already-answered question is never overwritten. Something
 * the organizer actually said always outranks something we inferred.
 */
export async function applyDerivationsForChat(db: pg.Pool, chatId: string): Promise<string[]> {
  const current = await answersForChat(db, chatId);
  if (!current) return [];

  const derived: string[] = [];
  for (const question of INTAKE_QUESTIONS) {
    if (!question.derive) continue;
    if (current.answers[question.id] !== undefined) continue;
    if (isSkipped(current.ui, question.id)) continue;
    const value = question.derive(current.answers);
    if (value === null) continue;
    const result = await submitAnswerVia(db, { by: "chat", chatId }, question.id, null, value);
    if (result.ok) derived.push(question.id);
  }
  return derived;
}

/**
 * Moves the session to the phase its answers now put it in, and records the
 * entry action owed.
 *
 * Called after every write. Doing nothing when the phase has not changed is
 * the whole point: an entry action fires on the TRANSITION, so the boundary
 * message and the recap are each shown once without a flag per message. Run 2's
 * recap re-fired on every subsequent write precisely because there was no
 * transition to hang it on.
 */
export async function advancePhaseForChat(
  db: pg.Pool,
  chatId: string,
): Promise<{ from: InterviewPhase; to: InterviewPhase } | null> {
  const current = await getSessionForChat(db, chatId);
  if (!current.ok) return null;
  const from = current.view.phase;
  if (from === "confirmed") return null;

  // Anything derivable is filled in first, so it counts toward "the optional
  // questions are done" exactly like an answer the organizer gave.
  await applyDerivationsForChat(db, chatId);

  const answers = await answersForChat(db, chatId);
  if (!answers) return null;

  // Run to a fixpoint, not a single step. One event can legitimately cross two
  // boundaries: recording the last required answer AND asking to finish should
  // land on `recap`, not stop at `optional` because only one transition was
  // applied. Stopping short is what left "that's everything" reporting
  // `interviewing`, with no recap to show.
  //
  // Bounded by the number of phases, so a transition pair that disagreed with
  // each other could never spin here.
  let to: InterviewPhase = from;
  for (let step = 0; step < INTERVIEW_PHASES.length; step += 1) {
    const next = nextPhase(to, answers.answers, INTAKE_QUESTIONS, answers.ui);
    if (next === to) break;
    to = next;
  }
  if (to === from) return null;

  await db.query(
    `UPDATE control_plane.intake_sessions
        SET phase = $2, state = $3
      WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
    [chatId, to, stateForPhase(to)],
  );
  await updateUiStateForChat(db, chatId, (ui) => ({ ...ui, pendingEntry: to }));
  await scheduleRouterPrompt(db, current.view.sessionId);
  return { from, to };
}

/** Reads just the answers and ui_state, for the phase machine. */
export async function answersForChat(
  db: pg.Pool,
  chatId: string,
): Promise<{ answers: AnswerStore; ui: InterviewUiState } | null> {
  const row = await db.query<{ answers: AnswerStore; ui_state: unknown }>(
    `SELECT answers, ui_state FROM control_plane.intake_sessions
      WHERE telegram_chat_id = $1 AND state <> 'confirmed' AND expired_at IS NULL`,
    [chatId],
  );
  const [session] = row.rows;
  if (!session) return null;
  return { answers: session.answers, ui: parseUiState(session.ui_state) };
}

/** Marks an entry action as performed, so the router does not repeat it. */
export async function clearPendingEntryForChat(db: pg.Pool, chatId: string): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => {
    const next = { ...ui };
    delete next.pendingEntry;
    return next;
  });
}

/**
 * The organizer did something after the document offer, so the opening is over.
 *
 * Any signal counts — sending the document, declining it, or simply typing.
 * Without this an organizer who taps past the offer and says nothing would sit
 * in `opening` forever, since no answer has been recorded to move them on.
 */
export async function markOpeningDoneForChat(db: pg.Pool, chatId: string): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => ({ ...ui, openingDone: true }));
  await advancePhaseForChat(db, chatId);
}

/** Clears the delivered message so the router does not send it twice. */
export async function clearPendingSayForChat(db: pg.Pool, chatId: string): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => {
    const next = { ...ui };
    delete next.pendingSay;
    return next;
  });
}

export async function nominateQuestionForChat(
  db: pg.Pool,
  chatId: string,
  questionId: string,
  text?: string,
): Promise<GetSessionResult> {
  const question = INTAKE_QUESTIONS.find((q) => q.id === questionId);
  if (!question) return { ok: false, reason: "NOT_FOUND" };

  // The router already asks this on its own (Track 8) — there is exactly one
  // path that ever puts a router-owned question in front of the organizer,
  // and this is not it. Refusing here, rather than letting the nomination
  // through, is what keeps that a fact rather than a convention: two
  // independent decisions to ask the same fixed-choice question is exactly
  // the class of duplicate-ask bug this session kept finding.
  if (question.routerOwned) return { ok: false, reason: "ROUTER_OWNED" };

  // Never put a question the record already answers. Run 7: a tapped
  // `bot_gender` was asked again in prose, and a destination the document had
  // supplied was asked for outright. The interviewer's picture of the record is
  // a snapshot in its context; this is a read. Refusing here is kinder than
  // drawing it, because the organizer would have no way to know they were
  // answering something twice.
  const existing = await answersForChat(db, chatId);
  if (existing && existing.answers[questionId] !== undefined) {
    return { ok: false, reason: "ALREADY_ANSWERED" };
  }

  const explicitPhrasing = text?.trim();
  const result = await updateUiStateForChat(db, chatId, (ui) => {
    // Fold in a `say_for_chat` that has not been delivered yet, rather than
    // leaving it to go out as its own message. Raised live on 2026-09-05:
    // "the agent was ahead asked and then the router came in" — the agent
    // said something (queued, undelivered) and, moments later in the same
    // breath, nominated the question — and the two were sent as SEPARATE
    // messages, the agent's prose first, the router's buttoned render
    // second. If `pendingSay` had already been delivered by the time this
    // runs, it is already cleared and there is nothing to fold — a real
    // gap in time between the two is exactly when two separate messages is
    // the right call, which is what the floor-reclaim fix exists to allow.
    // This only catches the rapid, same-breath case.
    const lead = ui.pendingSay?.trim();
    const phrasing = lead && explicitPhrasing
      ? `${lead}\n\n${explicitPhrasing}`
      : lead ?? explicitPhrasing;
    return {
      ...ui,
      pendingAsk: questionId,
      pendingSay: undefined,
      // The agent's own wording, when it supplied one (or the lead-in that
      // would otherwise have gone out separately). Without either the router
      // falls back to intake-copy.ts — correct, localised, and robotic.
      ...(phrasing ? { pendingAskText: phrasing } : { pendingAskText: undefined }),
      // Nominating a question the organizer previously skipped un-skips it:
      // asking for it explicitly is a clearer signal than the earlier decline.
      ...(ui.skipped ? { skipped: ui.skipped.filter((id) => id !== questionId) } : {}),
      // And it is not a finished interview any more.
      finishRequested: false,
    };
  });
  // Nominating a question is the agent choosing, right now, to speak — the
  // same reclaim as sayForChat and submitAnswerForAgent, for the same reason.
  if (result.ok) {
    await markAwaitingMachine(db, chatId);
    await scheduleRouterPrompt(db, result.view.sessionId);
    await markAgentSpoke(db, chatId);
  }
  await advancePhaseForChat(db, chatId);
  return result;
}

/** Records what the router just sent, so it will not send the same thing again. */
export async function recordLastPromptForChat(
  db: pg.Pool,
  chatId: string,
  key: string,
): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => ({ ...ui, lastPrompt: key }));
}

/** Records that the "essentials done" choice has been shown, so it is shown once. */
export async function markOfferedMoreForChat(db: pg.Pool, chatId: string): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => ({ ...ui, offeredMore: true }));
}

/**
 * The organizer asks for more questions themselves.
 *
 * Nominates the next optional question they have neither answered nor skipped
 * — the deterministic counterpart to the interviewer choosing one, and the
 * reason a fumbled nomination can no longer strand anybody.
 */
export async function askForMoreForChat(db: pg.Pool, chatId: string): Promise<GetSessionResult> {
  const current = await getSessionForChat(db, chatId);
  if (!current.ok) return current;
  const next = current.view.optionalRemaining[0];
  if (!next) return setFinishRequestedForChat(db, chatId, true);
  return nominateQuestionForChat(db, chatId, next.id);
}

/** Clears a nomination once the router has actually asked it. */
export async function clearPendingAskForChat(db: pg.Pool, chatId: string): Promise<void> {
  await updateUiStateForChat(db, chatId, (ui) => {
    const next = { ...ui };
    delete next.pendingAsk;
    // The agent's wording belongs to the nomination it was written for. Leaving
    // it behind would put a sentence about dietary requirements above a
    // timezone question the next time the router fell back to its own copy.
    delete next.pendingAskText;
    return next;
  });
}

/**
 * Records the language the interview is being conducted in.
 *
 * Reported by the interviewer, because it is the only side that can read what
 * the organizer wrote. Everything the ROUTER draws — buttons, questions, the
 * recap, the file acknowledgement — is rendered from this; before it existed
 * a Hebrew interview got English buttons and an English confirmation screen.
 *
 * An unrecognised value is refused rather than stored: a language the router
 * cannot draw would silently fall back to English at render time anyway, and
 * storing it would make that look like a translation bug rather than a missing
 * translation.
 */
export async function setLanguageForChat(
  db: pg.Pool,
  chatId: string,
  rawLanguage: string,
): Promise<GetSessionResult> {
  const language = coerceLanguage(rawLanguage);
  if (!language) return { ok: false, reason: "NOT_FOUND" };

  const updated = await db.query<{ id: string }>(
    `UPDATE control_plane.intake_sessions
        SET language = $1, updated_at = now()
      WHERE telegram_chat_id = $2 AND state <> 'confirmed'
      RETURNING id`,
    [language, chatId],
  );
  if (updated.rows.length === 0) return { ok: false, reason: "NOT_FOUND" };
  return getSessionForChat(db, chatId);
}

/** Records that the organizer declined an optional question, so it is not asked again. */
export async function skipQuestionForChat(
  db: pg.Pool,
  chatId: string,
  questionId: string,
): Promise<GetSessionResult> {
  const question = INTAKE_QUESTIONS.find((q) => q.id === questionId);
  // Refusing to skip a required question here rather than trusting the caller:
  // a skipped required question would derive to awaiting_confirmation and then
  // fail at confirm with NOT_ALL_REQUIRED_ANSWERED, which reads to the
  // organizer as the interview breaking at the last step.
  if (!question || question.required) return { ok: false, reason: "NOT_FOUND" };
  return updateUiStateForChat(db, chatId, (ui) => {
    const { multiPending, ...rest } = ui;
    return {
      ...(multiPending === questionId ? rest : ui),
      skipped: [...new Set([...(ui.skipped ?? []), questionId])],
    };
  });
}

/**
 * The organizer says they are done answering, or wants to carry on after all.
 *
 * `false` is what makes "Keep planning" mean something: before this it printed
 * a sentence and left the session exactly where it was, so the recap came
 * straight back on the next answer.
 */
export async function setFinishRequestedForChat(
  db: pg.Pool,
  chatId: string,
  finishRequested: boolean,
  { schedulePrompt = false }: { schedulePrompt?: boolean } = {},
): Promise<GetSessionResult> {
  const result = await updateUiStateForChat(db, chatId, (ui) => {
    const next: InterviewUiState = { ...ui };
    if (finishRequested) {
      next.finishRequested = true;
      // A nomination the organizer never got to is not worth re-raising once
      // they have said they are done.
      delete next.pendingAsk;
    } else {
      delete next.finishRequested;
    }
    return next;
  });
  // The router already sends its own next step when a BUTTON caused this — and
  // by the time it runs, applyDecision's own top-of-turn call has already put
  // the floor back with the machine, so nothing extra is needed there. An
  // agent asking for the summary (show_summary_for_chat) has no such
  // follow-up: it is calling this directly from its own HTTP route, outside
  // the dispatch pipeline entirely, so it has to reclaim the floor itself —
  // exactly the sayForChat / submitAnswerForAgent pattern.
  if (result.ok && schedulePrompt) {
    await markAwaitingMachine(db, chatId);
    await scheduleRouterPrompt(db, result.view.sessionId);
  }
  // `optional -> recap` on finish, `recap -> optional` on Keep planning. Both
  // directions of the one two-way door in the machine, and the reason run 6's
  // organizer could type approval at a session with no path to it: nothing
  // moved when they asked to finish.
  const moved = await advancePhaseForChat(db, chatId);
  if (moved) return await getSessionForChat(db, chatId);
  return result;
}

/**
 * Toggles one option of a multi-select question, and returns the whole
 * resulting set.
 *
 * A multi_choice tap carries one option but the answer is the set, so each tap
 * rewrites the full selection. `none` is exclusive on purpose: "None of these"
 * alongside "Vegan" is not a preference anyone holds, and letting both stand
 * would hand the trip assistant a contradiction to reason about.
 */
export async function toggleMultiChoiceForChat(
  db: pg.Pool,
  chatId: string,
  questionId: string,
  optionId: string,
): Promise<SubmitAnswerResult> {
  const question = INTAKE_QUESTIONS.find((q) => q.id === questionId);
  if (!question || question.type !== "multi_choice") return { ok: false, reason: "UNKNOWN_QUESTION" };
  if (!question.options?.some((o) => o.id === optionId)) return { ok: false, reason: "UNKNOWN_OPTION" };

  const current = await getSessionForChat(db, chatId);
  if (!current.ok) return { ok: false, reason: "NOT_FOUND" };
  const existing = selectedOptionIds(current.view, questionId);

  let next: string[];
  if (existing.includes(optionId)) next = existing.filter((id) => id !== optionId);
  else if (optionId === EXCLUSIVE_OPTION_ID) next = [EXCLUSIVE_OPTION_ID];
  else next = [...existing.filter((id) => id !== EXCLUSIVE_OPTION_ID), optionId];

  // Deliberately NOT `submitAnswerForChat`: that advances the phase, and a tick
  // mid-selection is exactly the moment the interview must not move.
  return submitAnswerVia(db, { by: "chat", chatId }, questionId, null, undefined, undefined, next, true);
}

/**
 * `Done` on a multi-select: the set on screen is the answer.
 *
 * Nothing new is recorded — every tick already wrote itself — so this only ends
 * the ticking, which is what makes the question answered and lets the interview
 * move on.
 */
export async function finalizeMultiChoiceForChat(
  db: pg.Pool,
  chatId: string,
  questionId: string,
): Promise<GetSessionResult> {
  const cleared = await updateUiStateForChat(db, chatId, (ui) =>
    ui.multiPending === questionId ? (({ multiPending: _drop, ...rest }) => rest)(ui) : ui,
  );
  if (!cleared.ok) return cleared;
  // The phase advance every other answer gets from `submitAnswerForChat`. The
  // last required answer ends `essentials`, and on a multi-select that answer
  // is finished HERE, not at the first tick.
  const moved = await advancePhaseForChat(db, chatId);
  return moved ? await getSessionForChat(db, chatId) : cleared;
}

/** The option ids currently recorded for a multi-select question. */
export function selectedOptionIds(view: SessionView, questionId: string): string[] {
  return [...(view.selections[questionId] ?? [])];
}

/** "None of these" — the one option that cannot coexist with the others. */
export const EXCLUSIVE_OPTION_ID = "none";

export async function submitAnswerForChat(
  db: pg.Pool,
  chatId: string,
  questionId: string,
  optionId: string | "other" | null,
  otherText?: string,
  structuredData?: unknown,
  optionIds?: readonly string[],
): Promise<SubmitAnswerResult> {
  const result = await submitAnswerVia(
    db,
    { by: "chat", chatId },
    questionId, optionId, otherText, structuredData, optionIds,
  );
  // A recorded answer is the main thing that can move the interview on — the
  // last required one ends `essentials`, the last optional one ends `optional`.
  // Advancing here rather than in the caller means every writer gets it, which
  // is what run 6 needed: an answer arriving from the AGENT has to be able to
  // finish the interview, not just an answer arriving from a button.
  if (result.ok) {
    const moved = await advancePhaseForChat(db, chatId);
    if (moved) return await getSessionForChat(db, chatId) as SubmitAnswerResult;
  }
  return result;
}

async function submitAnswerVia(
  db: pg.Pool,
  locator: SessionLocator,
  questionId: string,
  optionId: string | "other" | null,
  otherText?: string,
  structuredData?: unknown,
  optionIds?: readonly string[],
  /** A tick on a multi-select keyboard, not a finished answer. */
  ticking = false,
): Promise<SubmitAnswerResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const session = await lockSession(client, locator);
    if (!session) { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }
    if (session.state === "confirmed") { await client.query("ROLLBACK"); return { ok: false, reason: "SESSION_CONFIRMED" }; }

    const validation = validateAnswer(questionId, optionId, otherText, INTAKE_QUESTIONS, structuredData, optionIds);
    if (!validation.ok) {
      await client.query("ROLLBACK");
      return { ok: false, reason: validation.reason, ...(validation.detail ? { detail: validation.detail } : {}) };
    }

    const updatedAnswers = { ...session.answers, [questionId]: validation.answer };
    const stored = parseUiState(session.ui_state);
    // Ticking keeps the question current; anything else is a finished answer,
    // and a finished answer on the question being ticked ends the ticking.
    const ui: InterviewUiState = ticking
      ? { ...stored, multiPending: questionId }
      : stored.multiPending === undefined
        ? stored
        : (({ multiPending: _drop, ...rest }) => rest)(stored);
    const newState = deriveSessionState(updatedAnswers, INTAKE_QUESTIONS, ui);

    await client.query(
      "UPDATE control_plane.intake_sessions SET answers = $1, state = $2, ui_state = $3::jsonb, updated_at = now() WHERE id = $4",
      [JSON.stringify(updatedAnswers), newState, serializeUiState(ui), session.id],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      view: buildSessionView(
        session.id, session.trip_id, newState, updatedAnswers, ui,
        coerceLanguage(session.language) ?? DEFAULT_LANGUAGE,
      ),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Confirms the intake: creates an immutable intake_versions row and transitions
 * the trip to 'intake_confirmed'. Idempotent: a second CONFIRM returns the
 * existing version without creating a duplicate.
 *
 * The session token remains valid after confirmation so the caller can call
 * CONFIRM a second time and get the same result. Answer writes are blocked by
 * the SESSION_CONFIRMED guard in submitAnswer.
 */
export async function confirmIntake(
  db: pg.Pool,
  rawSessionToken: string,
  log: (line: string) => void = () => {},
  expectedSessionId?: string,
): Promise<ConfirmIntakeResult> {
  return confirmIntakeVia(db, { by: "token", token: rawSessionToken, expectedSessionId }, log);
}

/**
 * Confirms whichever interview the given Telegram chat is conducting — the
 * router's counterpart to submitAnswerForChat, and what makes the Confirm
 * button a real confirmation rather than a prompt to go type the word.
 *
 * Sprint 2's rule is that a literal CONFIRM creates the immutable intake
 * version. A labelled button satisfies "explicit and unambiguous" at least as
 * well as typed capitals — there is no typo or near-miss to interpret — so
 * this changes the mechanism, not the rule. Typed CONFIRM still works through
 * confirmIntake above.
 */
export async function confirmIntakeForChat(
  db: pg.Pool,
  chatId: string,
  log: (line: string) => void = () => {},
): Promise<ConfirmIntakeResult> {
  return confirmIntakeVia(db, { by: "chat", chatId }, log);
}

async function confirmIntakeVia(
  db: pg.Pool,
  locator: SessionLocator,
  log: (line: string) => void = () => {},
): Promise<ConfirmIntakeResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const session = await lockSession(client, locator);
    if (!session) { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }

    // Idempotency: already confirmed — return the existing intake version.
    if (session.state === "confirmed") {
      const existing = await client.query<{ id: string; version: number; digest: string }>(
        "SELECT id, version, digest FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
        [session.trip_id],
      );
      await client.query("ROLLBACK");
      const [ver] = existing.rows;
      if (!ver) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, sessionId: session.id, intakeVersionId: ver.id, digest: ver.digest, versionNumber: ver.version };
    }

    // All required questions must be answered.
    const allRequired = INTAKE_QUESTIONS.filter((q) => q.required);
    const allAnswered = allRequired.every((q) => session.answers[q.id] !== undefined);
    if (!allAnswered) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_ALL_REQUIRED_ANSWERED" };
    }

    // Answers are organizer-controlled free-form content (free text, "other"
    // follow-ups, and structured travelers/phases/travel_anchors/constraints
    // payloads) about to become an immutable, durable record. Check it here
    // for a named field path in the error; the database CHECK constraint on
    // intake_versions.data (migration 0015) is the actual backstop, same
    // relationship validateBeforeProvider has to its own profile checks.
    try {
      assertCanonicalRecordSafe(session.answers);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof UnsafeCanonicalRecordError) {
        return { ok: false, reason: "UNSAFE_ANSWER_CONTENT", unsafePath: error.path };
      }
      throw error;
    }

    // Compute the digest and determine the next version number.
    const intakeDigest = computeIntakeDigest(session.trip_id, session.answers);
    const versionRow = await client.query<{ max: number | null }>(
      "SELECT MAX(version) AS max FROM control_plane.intake_versions WHERE trip_id = $1",
      [session.trip_id],
    );
    const nextVersion = (versionRow.rows[0]?.max ?? 0) + 1;
    const versionId = generateId("intk");
    const artifactRef = `intake:sessions:${session.id}:v${nextVersion}`;

    await client.query(
      `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data, source_document, language)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, $8::jsonb, $9)`,
      [
        versionId, session.trip_id, nextVersion, artifactRef, intakeDigest,
        INTAKE_SCHEMA_VERSION, JSON.stringify(session.answers),
        session.source_document ? JSON.stringify(session.source_document) : null,
        // The language the interview was actually held in, copied onto the
        // version because the SESSION does not survive: it is deleted on reset
        // and superseded on correction, while the transformer reads the
        // version. Until migration 0046 the one place that knew this was not
        // the place that needed it, and a wholly Hebrew interview produced a
        // trip that greeted the family in English.
        //
        // NOT part of the digest: the digest covers the organizer's ANSWERS,
        // and two confirmations of identical answers must stay identical
        // whatever language they were typed in.
        session.language ?? null,
      ],
    );

    // Transition trip to 'intake_confirmed'.
    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1",
      [session.trip_id],
    );

    // Mark session confirmed. Token remains valid for idempotent re-confirmation.
    await client.query(
      "UPDATE control_plane.intake_sessions SET state = 'confirmed', updated_at = now() WHERE id = $1",
      [session.id],
    );

    await client.query("COMMIT");

    log(structuredLog("info", "interview.confirmed", {
      session_id: session.id,
      trip_id: session.trip_id,
      intake_version_id: versionId,
      version: nextVersion,
    }));

    return { ok: true, sessionId: session.id, intakeVersionId: versionId, digest: intakeDigest, versionNumber: nextVersion };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Looks up a session by its ID (not token) for the confirmed-idempotency path
 * and status display. Does not expose answers or transcripts — returns only
 * lifecycle state and the intake version if confirmed.
 */
export async function getSessionStatus(
  db: pg.Pool,
  sessionId: string,
  userId: string,
): Promise<
  | { ok: true; state: SessionState; intakeVersionId?: string; digest?: string }
  | { ok: false; reason: "NOT_FOUND" | "WRONG_USER" }
> {
  const row = await db.query<{ user_id: string; trip_id: string; state: SessionState }>(
    "SELECT user_id, trip_id, state FROM control_plane.intake_sessions WHERE id = $1",
    [sessionId],
  );
  const [session] = row.rows;
  if (!session) return { ok: false, reason: "NOT_FOUND" };
  if (session.user_id !== userId) return { ok: false, reason: "WRONG_USER" };

  if (session.state === "confirmed") {
    const ver = await db.query<{ id: string; digest: string }>(
      "SELECT id, digest FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
      [session.trip_id],
    );
    const [v] = ver.rows;
    return {
      ok: true,
      state: "confirmed",
      intakeVersionId: v?.id,
      digest: v?.digest,
    };
  }

  return { ok: true, state: session.state };
}

// ── source document: the raw plan an organizer shared, kept for re-extraction ─

const SOURCE_DOCUMENT_MAX_CHARS = 200_000;

/** Stage the plan document text on the session. It is copied onto the
 * immutable intake_versions row at confirm. Best-effort — a failure here never
 * blocks the interview (the interviewer already extracted from it live). */
export async function saveSourceDocument(
  db: pg.Pool,
  rawSessionToken: string,
  text: string,
  filename?: string,
): Promise<{ ok: true; chars: number } | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" }> {
  const body = String(text ?? "");
  if (!body.trim()) return { ok: false, reason: "INVALID_REQUEST" };
  const doc = {
    filename: String(filename ?? "").replace(/[<>]/g, "").slice(0, 200) || null,
    text: body.slice(0, SOURCE_DOCUMENT_MAX_CHARS),
    savedAt: new Date().toISOString(),
  };
  const res = await db.query(
    `UPDATE control_plane.intake_sessions
     SET source_document = $2::jsonb, updated_at = now()
     WHERE session_token_digest = $1 AND state <> 'confirmed'`,
    [sessionTokenDigest(rawSessionToken), JSON.stringify(doc)],
  );
  if (res.rowCount === 0) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true, chars: doc.text.length };
}

// ── country_reference: cross-trip consular contacts ──────────────────────────

export type ConsularContact = { name: { he: string; en: string }; phone: string };

const CONSULAR_MAX_AGE_DAYS = 180;

function normaliseCountry(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

/** The site renders contact.name through `_biSpan` (raw HTML) and phone into a
 * `tel:` href — same XSS posture as the itinerary `days` text, so strip markup
 * here rather than trust the search model's output. */
function cleanConsularContacts(raw: unknown): ConsularContact[] {
  if (!Array.isArray(raw)) return [];
  const plain = (v: unknown) => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  const out: ConsularContact[] = [];
  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const nameObj = (e.name && typeof e.name === "object" ? e.name : {}) as Record<string, unknown>;
    const nameStr = typeof e.name === "string" ? e.name : "";
    const he = plain(nameObj.he ?? nameStr);
    const en = plain(nameObj.en ?? nameStr);
    const phone = plain(e.phone).replace(/[^\d+()\-\s]/g, "").trim().slice(0, 40);
    if ((!he && !en) || !phone) continue;
    out.push({ name: { he: he || en, en: en || he }, phone });
  }
  return out;
}

export async function sessionActive(db: pg.Pool, rawSessionToken: string): Promise<boolean> {
  const row = await db.query(
    "SELECT 1 FROM control_plane.intake_sessions WHERE session_token_digest = $1 AND state <> 'confirmed'",
    [sessionTokenDigest(rawSessionToken)],
  );
  return row.rows.length > 0;
}

/** Read a cached consular row. `found` is true only when a row exists and is
 * fresher than CONSULAR_MAX_AGE_DAYS — the interviewer's tool then skips the
 * web search entirely. */
export async function consularContactsFor(
  db: pg.Pool,
  rawSessionToken: string,
  destinationCountry: string,
  homeCountry: string,
): Promise<
  | { ok: true; found: boolean; contacts: ConsularContact[]; fetchedAt?: string }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" }
> {
  const dest = normaliseCountry(destinationCountry);
  const home = normaliseCountry(homeCountry);
  if (!dest || !home) return { ok: false, reason: "INVALID_REQUEST" };
  if (!(await sessionActive(db, rawSessionToken))) return { ok: false, reason: "NOT_FOUND" };

  const row = await db.query<{ contacts: unknown; fetched_at: string; stale: boolean }>(
    `SELECT contacts, fetched_at,
            (fetched_at < now() - ($3 || ' days')::interval) AS stale
     FROM control_plane.country_reference
     WHERE destination_country = $1 AND home_country = $2`,
    [dest, home, String(CONSULAR_MAX_AGE_DAYS)],
  );
  const [hit] = row.rows;
  if (!hit) return { ok: true, found: false, contacts: [] };
  return {
    ok: true,
    found: !hit.stale,
    contacts: cleanConsularContacts(hit.contacts),
    fetchedAt: hit.fetched_at,
  };
}

/** Upsert a consular row the interviewer's web search produced, for every later
 * trip to the same (destination, home) pair to reuse. */
export async function saveConsularContacts(
  db: pg.Pool,
  rawSessionToken: string,
  destinationCountry: string,
  homeCountry: string,
  contacts: unknown,
  source?: string,
): Promise<
  | { ok: true; contacts: ConsularContact[] }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" | "NO_USABLE_CONTACTS" }
> {
  const dest = normaliseCountry(destinationCountry);
  const home = normaliseCountry(homeCountry);
  if (!dest || !home) return { ok: false, reason: "INVALID_REQUEST" };
  if (!(await sessionActive(db, rawSessionToken))) return { ok: false, reason: "NOT_FOUND" };

  const clean = cleanConsularContacts(contacts);
  if (clean.length === 0) return { ok: false, reason: "NO_USABLE_CONTACTS" };

  await db.query(
    `INSERT INTO control_plane.country_reference (destination_country, home_country, contacts, source, fetched_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (destination_country, home_country)
     DO UPDATE SET contacts = EXCLUDED.contacts, source = EXCLUDED.source, fetched_at = now()`,
    [dest, home, JSON.stringify(clean), (source ?? "").slice(0, 200) || null],
  );
  return { ok: true, contacts: clean };
}
