import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  DEFAULT_MIN_CONFIDENCE,
  applyProposals,
  buildInterpretPrompt,
  burstKey,
  evidenceAppears,
  exampleEchoes,
  interpretBurst,
  parseInterpretPayload,
  storedOutcomes,
  submitArgsFor,
  buildExtractIntakePrompt,
  type ProposedAnswer,
} from "../src/interpret.js";
import { fakeRunner, firstJsonObject, isRateLimitText, worthRetrying } from "../src/model-runner.js";
import { INTAKE_QUESTIONS, buildRecap, partitionQuestions, type IntakeQuestion } from "../src/interview.js";
import { documentText, htmlToText, looksLikeIdentityDocument } from "../src/document-text.js";

// A small question set standing in for INTAKE_QUESTIONS, so these tests say
// what they mean rather than depending on the live intake's current shape.
const QUESTIONS: IntakeQuestion[] = [
  { id: "destination", type: "text", prompt: "Where are you going?", required: true, maxLength: 100 },
  {
    id: "trip_type",
    type: "choice",
    prompt: "What kind of trip?",
    required: true,
    options: [
      { id: "family", label: "Family" },
      { id: "friends", label: "Friends" },
    ],
    allowsOther: true,
  },
  {
    id: "dietary",
    type: "multi_choice",
    prompt: "Any dietary needs?",
    required: false,
    options: [
      { id: "kosher_style", label: "Kosher style" },
      { id: "lactose_free", label: "Lactose free" },
    ],
  },
  {
    id: "travelers",
    type: "structured",
    prompt: "Who is coming?",
    required: true,
    dataShape: "array",
    checkComplete: (data) =>
      Array.isArray(data) && data.length > 0 ? null : "needs at least one traveller",
  },
];

function proposal(over: Partial<ProposedAnswer> = {}): ProposedAnswer {
  return {
    questionId: "destination",
    value: { kind: "text", text: "Japan" },
    confidence: 0.9,
    evidence: "Japan",
    sourceMessageId: "101",
    ...over,
  };
}

const CTX = {
  sourceText: "We're going to Japan, family trip, four of us",
  outstanding: ["destination", "trip_type", "dietary", "travelers"],
  answered: [] as string[],
  questions: QUESTIONS,
};

describe("evidenceAppears", () => {
  test("accepts a verbatim span", () => {
    assert.equal(evidenceAppears("Japan", "We're going to Japan"), true);
  });

  test("folds case and whitespace", () => {
    assert.equal(evidenceAppears("  JAPAN  ", "we're going to japan"), true);
    assert.equal(evidenceAppears("four of us", "Family trip,  four   of us"), true);
  });

  test("tolerates punctuation the model quoted along with the span", () => {
    assert.equal(evidenceAppears("Japan,", "going to Japan next year"), true);
    assert.equal(evidenceAppears('"Japan"', "going to Japan next year"), true);
  });

  // The failure this check exists for: a model filling a field from its own
  // prior rather than from the message it was handed.
  test("rejects a span that is not in the message", () => {
    assert.equal(evidenceAppears("Italy", "We're going to Japan"), false);
  });

  test("rejects empty or punctuation-only evidence", () => {
    assert.equal(evidenceAppears("", "anything"), false);
    assert.equal(evidenceAppears("   ", "anything"), false);
    assert.equal(evidenceAppears("-- ,", "anything"), false);
  });

  test("works on Hebrew, which has no case to fold", () => {
    assert.equal(evidenceAppears("יפן", "אנחנו נוסעים ליפן בספטמבר"), true);
    assert.equal(evidenceAppears("איטליה", "אנחנו נוסעים ליפן בספטמבר"), false);
  });

  // A document answer legitimately gathers from several places. Found on the
  // real Japan booking PDF: the phases proposal quoted five stop-and-date lines
  // that sit pages apart, and a contiguous check rejected the four most
  // valuable proposals while accepting only the four that came from one line.
  const BOOKING = [
    "Entire Trip",
    "Sep 19 - Oct 03",
    "Tokyo",
    "Sep 19 - Sep 23",
    "¥300,105.00",
    "Hakone",
    "Sep 23 - Sep 24",
    "Kyoto",
    "Sep 24 - Sep 27",
  ].join("\n");

  test("evidence gathered from several lines is accepted", () => {
    assert.equal(evidenceAppears("Tokyo\nSep 19 - Sep 23\nHakone\nSep 23 - Sep 24", BOOKING), true);
  });

  test("but every line must be there — one invented line fails the whole claim", () => {
    assert.equal(evidenceAppears("Tokyo\nSep 19 - Sep 23\nNagoya", BOOKING), false);
  });

  test("a single invented line fails just as it always did", () => {
    assert.equal(evidenceAppears("Osaka", BOOKING), false);
  });

  test("trivial lines cannot carry a claim on their own", () => {
    assert.equal(evidenceAppears(".\n-\n.", BOOKING), false);
  });
});

describe("parseInterpretPayload — the schema is this function", () => {
  test("parses each value kind", () => {
    const parsed = parseInterpretPayload({
      proposals: [
        { questionId: "destination", value: { kind: "text", text: "Japan" }, confidence: 0.9, evidence: "Japan" },
        { questionId: "trip_type", value: { kind: "choice", optionId: "family" }, confidence: 0.8, evidence: "family" },
        { questionId: "dietary", value: { kind: "multi_choice", optionIds: ["kosher_style"] }, confidence: 0.7, evidence: "kosher" },
        { questionId: "travelers", value: { kind: "structured", data: [{ name: "Dana" }] }, confidence: 0.75, evidence: "Dana" },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.proposals.length, 4);
    assert.equal(parsed.malformed, 0);
  });

  test("null only when the top level is unusable", () => {
    assert.equal(parseInterpretPayload(null), null);
    assert.equal(parseInterpretPayload("nope"), null);
    assert.equal(parseInterpretPayload({ answers: [] }), null);
  });

  // Partial success: five good proposals should not be lost to a sixth bad one.
  test("drops and counts a malformed entry rather than the whole batch", () => {
    const parsed = parseInterpretPayload({
      proposals: [
        proposal(),
        { questionId: "trip_type", value: { kind: "choice" }, confidence: 0.9, evidence: "x" },
        { questionId: "", value: { kind: "text", text: "y" }, confidence: 0.9, evidence: "x" },
        { questionId: "dietary", value: { kind: "text", text: "y" }, confidence: 4, evidence: "x" },
        { questionId: "travelers", value: { kind: "nonsense" }, confidence: 0.9, evidence: "x" },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.proposals.length, 1);
    assert.equal(parsed.malformed, 4);
  });

  test("an empty multi_choice is a decline, not a proposal", () => {
    const parsed = parseInterpretPayload({
      proposals: [{ questionId: "dietary", value: { kind: "multi_choice", optionIds: [] }, confidence: 0.9, evidence: "x" }],
    });
    assert.equal(parsed?.proposals.length, 0);
    assert.equal(parsed?.malformed, 1);
  });

  test("confidence must be a finite number in 0..1", () => {
    for (const confidence of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "0.9", null]) {
      const parsed = parseInterpretPayload({
        proposals: [{ questionId: "destination", value: { kind: "text", text: "Japan" }, confidence, evidence: "Japan" }],
      });
      assert.equal(parsed?.proposals.length, 0, `confidence ${String(confidence)} should be refused`);
    }
  });

  test("an invented sourceMessageId is replaced, never stored", () => {
    const parsed = parseInterpretPayload(
      { proposals: [{ ...proposal(), sourceMessageId: "999" }] },
      ["101", "102"],
    );
    assert.equal(parsed?.proposals[0]?.sourceMessageId, "101");
  });

  test("a real sourceMessageId is kept", () => {
    const parsed = parseInterpretPayload(
      { proposals: [{ ...proposal(), sourceMessageId: "102" }] },
      ["101", "102"],
    );
    assert.equal(parsed?.proposals[0]?.sourceMessageId, "102");
  });

  test("unclear entries survive; malformed ones are skipped", () => {
    const parsed = parseInterpretPayload({
      proposals: [],
      unclear: [{ questionId: "trip_type", why: "said 'a bit of both'" }, { why: "no id" }, 7],
    });
    assert.deepEqual(parsed?.unclear, [{ questionId: "trip_type", why: "said 'a bit of both'" }]);
  });
});

describe("exampleEchoes — a value that came from the prompt, not the person", () => {
  // 2026-09-12. An organizer's confirmed intake recorded their planned places
  // as exactly "Tokyo Skytree" and "TeamLab Planets" — the two values in the
  // `phases` question's own example — from a four-page itinerary naming
  // neither. Their report: "only the one I mentioned as example... which makes
  // me suspicious about the prompt."
  const EXAMPLE = '[{"name": "Tokyo", "planned": ["Tokyo Skytree", "TeamLab Planets"]}]';

  test("catches a value the example contains and the source does not", () => {
    const echoed = exampleEchoes(
      EXAMPLE,
      { kind: "structured", data: [{ name: "Tokyo", planned: ["Tokyo Skytree", "TeamLab Planets"] }] },
      "Day 1: arrive Tokyo. Day 2: Sumo Hall Hirakuza Osaka.",
    );
    assert.deepEqual(echoed.sort(), ["TeamLab Planets", "Tokyo Skytree"]);
  });

  test("lets the same value through when the source really says it", () => {
    assert.deepEqual(
      exampleEchoes(EXAMPLE, { data: [{ planned: ["Tokyo Skytree"] }] }, "Tuesday: Tokyo Skytree at 10:00"),
      [],
      "a real trip to Tokyo Skytree is not an echo — it is an answer",
    );
  });

  test("says nothing about values the example never had", () => {
    assert.deepEqual(exampleEchoes(EXAMPLE, { data: [{ planned: ["Sumo Hall"] }] }, "no mention here"), []);
  });

  test("ignores short tokens, which every trip shares", () => {
    assert.deepEqual(exampleEchoes('["he", "en"]', { data: ["he", "en"] }, "nothing"), []);
  });

  test("never flags a normalized date — the whole false-positive class", () => {
    // The example's dates are real dates. A document that says "19 September"
    // yields "2026-09-19", which is absent from the source for the best of
    // reasons — and the organizer whose report produced this guard departs on
    // exactly the date the example carries.
    assert.deepEqual(
      exampleEchoes('[{"start": "2026-09-19", "end": "2026-09-23"}]',
        { data: [{ start: "2026-09-19", end: "2026-09-23" }] },
        "Tokyo, 19-23 September"),
      [],
    );
  });

  test("a question with no example cannot echo, and a malformed one is not a crash", () => {
    assert.deepEqual(exampleEchoes(undefined, { data: ["anything"] }, ""), []);
    assert.deepEqual(exampleEchoes("{not json", { data: ["anything"] }, ""), []);
  });
});

describe("applyProposals — the gate", () => {
  test("refuses a value copied out of the question's example", () => {
    const questions: IntakeQuestion[] = [
      ...QUESTIONS,
      {
        id: "phases", type: "structured", prompt: "Where are you going, and when?", required: true,
        dataShape: "array",
        dataExample: '[{"name": "Tokyo", "planned": ["Tokyo Skytree", "TeamLab Planets"]}]',
      },
    ];
    const { accepted, rejected } = applyProposals(
      [proposal({
        questionId: "phases",
        value: { kind: "structured", data: [{ name: "Tokyo", planned: ["Tokyo Skytree", "TeamLab Planets"] }] },
        // A REAL quote from the document — which is exactly why the evidence
        // gate passed it and something else had to catch the value.
        evidence: "Tokyo",
      })],
      { ...CTX, questions, outstanding: ["phases"], sourceText: "Tokyo, 19-23 September. Osaka, 24-26." },
    );
    assert.equal(accepted.length, 0);
    assert.equal(rejected[0]?.reason, "EXAMPLE_ECHO");
    assert.match(rejected[0]?.detail ?? "", /Tokyo Skytree/);
  });

  test("accepts a well-evidenced, confident, valid proposal", () => {
    const { accepted, rejected } = applyProposals([proposal()], CTX);
    assert.equal(rejected.length, 0);
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]?.answer, { kind: "text", schema_version: 3, text: "Japan" });
  });

  // The central claim of the design: the model cannot invent an option id,
  // because validateAnswer was always the door and it is unchanged.
  test("an invented option id is refused by validateAnswer, not by a rule here", () => {
    const { accepted, rejected } = applyProposals(
      [proposal({ questionId: "trip_type", value: { kind: "choice", optionId: "honeymoon" }, evidence: "family" })],
      CTX,
    );
    assert.equal(accepted.length, 0);
    assert.equal(rejected[0]?.reason, "UNKNOWN_OPTION");
  });

  test("a structurally empty structured answer is refused by checkComplete", () => {
    const { accepted, rejected } = applyProposals(
      [proposal({ questionId: "travelers", value: { kind: "structured", data: [] }, evidence: "four of us" })],
      CTX,
    );
    assert.equal(accepted.length, 0);
    assert.equal(rejected[0]?.reason, "INCOMPLETE_ANSWER");
    assert.equal(rejected[0]?.detail, "needs at least one traveller");
  });

  test("over-long text is refused", () => {
    const { rejected } = applyProposals(
      [proposal({ value: { kind: "text", text: "x".repeat(200) }, evidence: "Japan" })],
      CTX,
    );
    assert.equal(rejected[0]?.reason, "TEXT_TOO_LONG");
  });

  test("low confidence leaves the question outstanding rather than guessing", () => {
    const { accepted, rejected, askAnyway } = applyProposals(
      [proposal({ confidence: DEFAULT_MIN_CONFIDENCE - 0.01 })],
      CTX,
    );
    assert.equal(accepted.length, 0);
    assert.equal(rejected[0]?.reason, "LOW_CONFIDENCE");
    assert.ok(askAnyway.includes("destination"));
  });

  test("evidence that is not in the message is refused before validation", () => {
    const { rejected } = applyProposals([proposal({ evidence: "Italy" })], CTX);
    assert.equal(rejected[0]?.reason, "EVIDENCE_NOT_IN_SOURCE");
  });

  test("an already-answered question is a change, and changes are not applied here", () => {
    const { accepted, rejected, askAnyway } = applyProposals([proposal()], {
      ...CTX,
      outstanding: ["trip_type"],
      answered: ["destination"],
    });
    assert.equal(accepted.length, 0);
    assert.equal(rejected[0]?.reason, "ALREADY_ANSWERED");
    // Not re-asked either: it is answered.
    assert.equal(askAnyway.includes("destination"), false);
  });

  test("a question the interview is not asking is refused", () => {
    const { rejected } = applyProposals([proposal({ questionId: "trip_type", evidence: "family" })], {
      ...CTX,
      outstanding: ["destination"],
    });
    assert.equal(rejected[0]?.reason, "NOT_OUTSTANDING");
  });

  test("a retired question is refused even if it is somehow outstanding", () => {
    const { rejected } = applyProposals(
      [proposal({ questionId: "group_size", value: { kind: "text", text: "4" }, evidence: "four of us" })],
      { ...CTX, outstanding: ["group_size"] },
    );
    assert.equal(rejected[0]?.reason, "NOT_OUTSTANDING");
    assert.equal(rejected[0]?.detail, "retired question");
  });

  test("two proposals for one question: highest confidence wins", () => {
    const { accepted, rejected } = applyProposals(
      [
        proposal({ value: { kind: "text", text: "Osaka" }, confidence: 0.75 }),
        proposal({ value: { kind: "text", text: "Japan" }, confidence: 0.95 }),
      ],
      CTX,
    );
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]?.answer, { kind: "text", schema_version: 3, text: "Japan" });
    assert.equal(rejected[0]?.reason, "DUPLICATE_PROPOSAL");
  });

  test("a tie goes to the earlier proposal", () => {
    const { accepted } = applyProposals(
      [
        proposal({ value: { kind: "text", text: "Japan" }, confidence: 0.9 }),
        proposal({ value: { kind: "text", text: "Osaka" }, confidence: 0.9 }),
      ],
      CTX,
    );
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]?.answer, { kind: "text", schema_version: 3, text: "Japan" });
  });

  test("several questions from one message — the case the agent kept botching", () => {
    const { accepted } = applyProposals(
      [
        proposal({ questionId: "destination", value: { kind: "text", text: "Japan" }, evidence: "Japan" }),
        proposal({ questionId: "trip_type", value: { kind: "choice", optionId: "family" }, evidence: "family trip" }),
        proposal({
          questionId: "travelers",
          value: { kind: "structured", data: [{ name: "Dana" }, { name: "Yoni" }] },
          evidence: "four of us",
        }),
      ],
      CTX,
    );
    assert.deepEqual(accepted.map((a) => a.questionId).sort(), ["destination", "travelers", "trip_type"]);
  });

  // A rejected proposal must never become a silent gap.
  test("everything refused, plus the model's unclear, becomes a question to ask", () => {
    const { askAnyway } = applyProposals([proposal({ evidence: "Italy" })], {
      ...CTX,
      unclear: [{ questionId: "trip_type", why: "ambiguous" }],
    });
    assert.deepEqual(askAnyway.sort(), ["destination", "trip_type"]);
  });

  test("an accepted question is not also queued to be asked", () => {
    const { askAnyway } = applyProposals([proposal()], {
      ...CTX,
      unclear: [{ questionId: "destination", why: "hedged" }],
    });
    assert.equal(askAnyway.includes("destination"), false);
  });

  test("no proposals is a valid, quiet outcome", () => {
    const { accepted, rejected, askAnyway } = applyProposals([], CTX);
    assert.deepEqual([accepted.length, rejected.length, askAnyway.length], [0, 0, 0]);
  });
});

// Four Italy documents, read as one source. On 2026-09-11 the extractor split
// `phases` into two proposals over exactly this shape — the hotels in one, the
// ticketed attractions in the other — and winner-takes-all kept the hotels and
// threw the attractions away. The organizer's summary then showed no places at
// all, which reads as the tickets never having been understood.
describe("applyProposals — a structured answer split across proposals", () => {
  const MERGE_QUESTIONS: IntakeQuestion[] = [
    ...QUESTIONS,
    { id: "phases", type: "structured", prompt: "Stops?", required: true, dataShape: "array" },
    { id: "travel_anchors", type: "structured", prompt: "Bookings?", required: false, dataShape: "array" },
    { id: "constraints", type: "structured", prompt: "Constraints?", required: false, dataShape: "object" },
  ];
  const SOURCE = [
    "Rome: Hotel Artemide, check-in 02 May 2026, check-out 06 May 2026",
    "Florence: Hotel Davanzati, check-in 06 May 2026, check-out 09 May 2026",
    "Colosseum Underground, Rome, 2026-05-03",
    "Uffizi Gallery, Florence, 2026-05-07",
    "Vatican Museums, Rome, 2026-05-04",
    "Outbound LY381 02 May 2026, Return LY382 12 May 2026, booking XR7T2Q",
    "Dana Levi, Omri Levi (12), Yael Levi",
    "Omri uses a wheelchair. Budget is moderate.",
  ].join("\n");
  const MCTX = {
    sourceText: SOURCE,
    outstanding: ["phases", "travel_anchors", "travelers", "constraints", "destination"],
    answered: [] as string[],
    questions: MERGE_QUESTIONS,
  };
  const hotels = [
    { name: "Rome", start: "2026-05-02", end: "2026-05-06", accommodation: { name: "Hotel Artemide" } },
    { name: "Florence", start: "2026-05-06", end: "2026-05-09", accommodation: { name: "Hotel Davanzati" } },
  ];
  const tickets = [
    { name: "Rome", planned: ["Colosseum Underground"] },
    { name: "Florence", planned: ["Uffizi Gallery"] },
  ];
  const part = (questionId: string, data: unknown, evidence: string, confidence = 0.9) =>
    proposal({ questionId, value: { kind: "structured", data }, evidence, confidence });

  test("hotels in one proposal and planned places in another become one answer carrying both", () => {
    const { accepted, rejected } = applyProposals(
      [
        part("phases", hotels, "Rome: Hotel Artemide\nFlorence: Hotel Davanzati", 0.92),
        part("phases", tickets, "Colosseum Underground\nUffizi Gallery", 0.88),
      ],
      MCTX,
    );
    assert.equal(rejected.length, 0);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.mergedFrom, 2);
    const answer = accepted[0]?.answer as { data: unknown };
    assert.deepEqual(answer.data, [
      { name: "Rome", start: "2026-05-02", end: "2026-05-06", accommodation: { name: "Hotel Artemide" }, planned: ["Colosseum Underground"] },
      { name: "Florence", start: "2026-05-06", end: "2026-05-09", accommodation: { name: "Hotel Davanzati" }, planned: ["Uffizi Gallery"] },
    ]);
  });

  test("a stop only one proposal names is kept, and stops come back in date order", () => {
    const { accepted } = applyProposals(
      [
        part("phases", [hotels[1]], "Florence: Hotel Davanzati"),
        part("phases", [hotels[0]], "Rome: Hotel Artemide"),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: { name: string }[] }).data;
    assert.deepEqual(data.map((p) => p.name), ["Rome", "Florence"]);
  });

  test("where both set the same field differently, the more confident proposal wins that field", () => {
    const { accepted } = applyProposals(
      [
        part("phases", [{ name: "Rome", start: "2026-05-02", end: "2026-05-05" }], "Rome: Hotel Artemide", 0.75),
        part("phases", [{ name: "rome", start: "2026-05-02", end: "2026-05-06" }], "check-out 06 May 2026", 0.95),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: { end: string }[] }).data;
    assert.equal(data.length, 1, "the same stop spelled in another case is one stop");
    assert.equal(data[0]?.end, "2026-05-06");
  });

  // A trip that ends where it began: the Hebrew interview harness's own answer
  // was "Tokyo 19-23, Hakone, Kyoto, Osaka, then back to Tokyo until the 3rd".
  // Matching stops by name alone would fold the two Tokyo legs into one.
  test("the same city visited twice stays two stops", () => {
    const itinerary = [
      { name: "Rome", start: "2026-05-02", end: "2026-05-06" },
      { name: "Florence", start: "2026-05-06", end: "2026-05-09" },
      { name: "Rome", start: "2026-05-09", end: "2026-05-12" },
    ];
    const { accepted } = applyProposals(
      [
        part("phases", itinerary, "Rome: Hotel Artemide\nFlorence: Hotel Davanzati", 0.92),
        part("phases", [{ name: "Rome", start: "2026-05-10", planned: ["Vatican Museums"] }], "Vatican Museums", 0.85),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: { name: string; start: string; planned?: string[] }[] }).data;
    assert.deepEqual(data.map((p) => `${p.name} ${p.start}`), ["Rome 2026-05-02", "Florence 2026-05-06", "Rome 2026-05-09"]);
    assert.deepEqual(data[2]?.planned, ["Vatican Museums"], "a dated place lands on the visit its date falls in");
    assert.equal(data[0]?.planned, undefined);
  });

  test("an undated slice joins the first stop of that name, and adds no stop", () => {
    const { accepted } = applyProposals(
      [
        part("phases", [{ name: "Rome", start: "2026-05-02", end: "2026-05-06" }, { name: "Rome", start: "2026-05-09", end: "2026-05-12" }],
          "Rome: Hotel Artemide"),
        part("phases", [{ name: "Rome", planned: ["Colosseum Underground"] }], "Colosseum Underground"),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: { planned?: string[] }[] }).data;
    assert.equal(data.length, 2);
    assert.deepEqual(data[0]?.planned, ["Colosseum Underground"]);
  });

  test("two stays at one hotel on different dates are two bookings", () => {
    const { accepted } = applyProposals(
      [
        part("travel_anchors", [{ type: "hotel", name: "Hotel Artemide", date: "2026-05-02" }], "Rome: Hotel Artemide"),
        part("travel_anchors", [{ type: "hotel", name: "Hotel Artemide", date: "2026-05-09" }], "Rome: Hotel Artemide"),
      ],
      MCTX,
    );
    assert.equal((accepted[0]?.answer as { data: unknown[] }).data.length, 2);
  });

  test("planned places are unioned, without the same place twice", () => {
    const { accepted } = applyProposals(
      [
        part("phases", [{ name: "Rome", planned: ["Colosseum Underground", "Vatican Museums"] }], "Colosseum Underground\nVatican Museums"),
        part("phases", [{ name: "Rome", planned: ["colosseum underground"] }], "Colosseum Underground"),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: { planned: string[] }[] }).data;
    assert.deepEqual(data[0]?.planned, ["Colosseum Underground", "Vatican Museums"]);
  });

  test("bookings from two documents are unioned; the same booking named twice is kept once", () => {
    const flights = [
      { type: "flight", name: "LY381", confirmation: "XR7T2Q" },
      { type: "flight", name: "LY382", confirmation: "XR7T2Q" },
    ];
    const { accepted } = applyProposals(
      [
        part("travel_anchors", flights, "Outbound LY381 02 May 2026, Return LY382 12 May 2026, booking XR7T2Q"),
        part("travel_anchors", [flights[0], { type: "hotel", name: "Hotel Artemide" }], "Rome: Hotel Artemide"),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: { name: string }[] }).data;
    assert.deepEqual(data.map((a) => a.name), ["LY381", "LY382", "Hotel Artemide"],
      "two flights on one booking reference are two bookings, not one");
  });

  test("travelers merge by name, each filling the other's gaps", () => {
    const { accepted } = applyProposals(
      [
        part("travelers", [{ name: "Dana Levi" }, { name: "Omri Levi" }], "Dana Levi, Omri Levi"),
        part("travelers", [{ name: "Omri Levi", age: 12 }, { name: "Yael Levi" }], "Omri Levi (12), Yael Levi"),
      ],
      MCTX,
    );
    const data = (accepted[0]?.answer as { data: unknown }).data;
    assert.deepEqual(data, [{ name: "Dana Levi" }, { name: "Omri Levi", age: 12 }, { name: "Yael Levi" }]);
  });

  test("an object answer merges key by key", () => {
    const { accepted } = applyProposals(
      [
        part("constraints", { mobility: "Omri uses a wheelchair" }, "Omri uses a wheelchair"),
        part("constraints", { budget: "moderate" }, "Budget is moderate"),
      ],
      MCTX,
    );
    assert.deepEqual((accepted[0]?.answer as { data: unknown }).data,
      { mobility: "Omri uses a wheelchair", budget: "moderate" });
  });

  // A merge only combines proposals that were each acceptable on their own. It
  // is not a way for a weak or invented part to ride in on a strong one.
  test("a part that fails confidence contributes nothing, and says why", () => {
    const { accepted, rejected } = applyProposals(
      [
        part("phases", hotels, "Rome: Hotel Artemide\nFlorence: Hotel Davanzati", 0.9),
        part("phases", tickets, "Colosseum Underground\nUffizi Gallery", 0.4),
      ],
      MCTX,
    );
    assert.equal(accepted[0]?.mergedFrom, undefined);
    assert.deepEqual((accepted[0]?.answer as { data: unknown }).data, hotels);
    assert.deepEqual(rejected.map((r) => r.reason), ["LOW_CONFIDENCE"]);
  });

  test("a part whose evidence is not in the source contributes nothing", () => {
    const { accepted, rejected } = applyProposals(
      [
        part("phases", hotels, "Rome: Hotel Artemide\nFlorence: Hotel Davanzati"),
        part("phases", [{ name: "Venice", planned: ["Doge's Palace"] }], "Doge's Palace, Venice"),
      ],
      MCTX,
    );
    assert.deepEqual((accepted[0]?.answer as { data: { name: string }[] }).data.map((p) => p.name), ["Rome", "Florence"]);
    assert.deepEqual(rejected.map((r) => r.reason), ["EVIDENCE_NOT_IN_SOURCE"]);
  });

  test("a merged answer the question refuses falls back to the most confident part, as before", () => {
    const atMostTwo: IntakeQuestion[] = MERGE_QUESTIONS.map((q) =>
      q.id === "phases" ? { ...q, checkComplete: (d: unknown) => (Array.isArray(d) && d.length <= 2 ? null : "too many") } : q);
    const { accepted, rejected } = applyProposals(
      [
        part("phases", hotels, "Rome: Hotel Artemide\nFlorence: Hotel Davanzati", 0.95),
        part("phases", [{ name: "Venice" }], "Uffizi Gallery", 0.8),
      ],
      { ...MCTX, questions: atMostTwo },
    );
    assert.deepEqual((accepted[0]?.answer as { data: unknown }).data, hotels);
    assert.equal(rejected[0]?.reason, "DUPLICATE_PROPOSAL");
    assert.match(rejected[0]?.detail ?? "", /INCOMPLETE_ANSWER/);
  });

  test("the stored outcome says an answer was merged, and from how many", () => {
    const decisions = applyProposals(
      [
        part("phases", hotels, "Rome: Hotel Artemide\nFlorence: Hotel Davanzati", 0.92),
        part("phases", tickets, "Colosseum Underground\nUffizi Gallery", 0.88),
      ],
      MCTX,
    );
    assert.deepEqual(storedOutcomes(decisions, 0).accepted, [{ questionId: "phases", confidence: 0.88, mergedFrom: 2 }]);
  });
});

describe("submitArgsFor — the mapping onto the router's write path", () => {
  test("each kind maps one-for-one", () => {
    assert.deepEqual(submitArgsFor({ kind: "choice", optionId: "family" }), { optionId: "family" });
    assert.deepEqual(submitArgsFor({ kind: "choice_other", otherText: "reunion" }), {
      optionId: "other",
      otherText: "reunion",
    });
    assert.deepEqual(submitArgsFor({ kind: "multi_choice", optionIds: ["kosher_style"] }), {
      optionId: null,
      optionIds: ["kosher_style"],
    });
    assert.deepEqual(submitArgsFor({ kind: "text", text: "Japan" }), { optionId: null, otherText: "Japan" });
    assert.deepEqual(submitArgsFor({ kind: "structured", data: [1] }), { optionId: null, structuredData: [1] });
  });
});

describe("burstKey — the idempotency key", () => {
  test("stable under order and repeats", () => {
    assert.equal(burstKey(["102", "101"], "x"), burstKey(["101", "102", "101"], "x"));
  });

  test("different bursts get different keys", () => {
    assert.notEqual(burstKey(["101"], "x"), burstKey(["102"], "x"));
  });

  test("falls back to the text when Telegram gave no ids, and is never empty", () => {
    const key = burstKey([], "we're going to Japan");
    assert.match(key, /^text:[0-9a-f]+$/);
    assert.equal(burstKey([], "we're going to Japan"), key);
    assert.notEqual(burstKey([], "we're going to Italy"), key);
  });

  test("blank ids do not produce a blank key", () => {
    assert.match(burstKey(["", "   "], "hello"), /^text:/);
  });
});

describe("buildInterpretPrompt", () => {
  test("describes only the outstanding questions", () => {
    const prompt = buildInterpretPrompt({
      sourceText: "Japan",
      outstanding: ["destination"],
      language: "he",
      questions: QUESTIONS,
    });
    assert.match(prompt, /id: destination/);
    assert.equal(prompt.includes("id: trip_type"), false);
  });

  test("names the option ids so the model has no reason to invent one", () => {
    const prompt = buildInterpretPrompt({
      sourceText: "family",
      outstanding: ["trip_type"],
      language: "en",
      questions: QUESTIONS,
    });
    assert.match(prompt, /family = Family/);
    assert.match(prompt, /choice_other/);
  });

  test("asks for verbatim evidence and normalised values, which is the whole contract", () => {
    const prompt = buildInterpretPrompt({ sourceText: "x", outstanding: [], language: "en", questions: QUESTIONS });
    assert.match(prompt, /VERBATIM/);
    assert.match(prompt, /Normalise there/);
  });
});

describe("interpretBurst — failure is a value", () => {
  test("a good reply parses into proposals", async () => {
    const runner = fakeRunner([
      JSON.stringify({
        proposals: [{ questionId: "destination", value: { kind: "text", text: "Japan" }, confidence: 0.9, evidence: "Japan" }],
      }),
    ]);
    const result = await interpretBurst(runner, {
      sourceText: "Japan",
      outstanding: ["destination"],
      language: "en",
      questions: QUESTIONS,
      messageIds: ["101"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.payload.proposals.length, 1);
  });

  test("commentary around the JSON is salvaged", async () => {
    const runner = fakeRunner([
      'Sure! Here you go:\n{"proposals":[{"questionId":"destination","value":{"kind":"text","text":"Japan"},"confidence":0.9,"evidence":"Japan"}]}\nHope that helps.',
    ]);
    const result = await interpretBurst(runner, {
      sourceText: "Japan",
      outstanding: ["destination"],
      language: "en",
      questions: QUESTIONS,
    });
    assert.equal(result.ok, true);
  });

  test("unparseable output is BAD_OUTPUT, not a throw", async () => {
    const runner = fakeRunner(["I'd be happy to help with that!"]);
    const result = await interpretBurst(runner, { sourceText: "x", outstanding: [], language: "en" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "BAD_OUTPUT");
  });

  // The 2026-09-07 failure: a rate limit must reach us as a rate limit, so it
  // can degrade to our own copy rather than to a different model's voice.
  test("a rate limit surfaces as RATE_LIMITED", async () => {
    const runner = fakeRunner([new Error("status=429 rate limit exceeded")]);
    const result = await interpretBurst(runner, { sourceText: "x", outstanding: [], language: "en" });
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
  });
});

describe("model-runner helpers", () => {
  test("isRateLimitText separates a limit from an ordinary failure", () => {
    assert.equal(isRateLimitText("status=429"), true);
    assert.equal(isRateLimitText("quota exceeded"), true);
    assert.equal(isRateLimitText("overloaded"), true);
    assert.equal(isRateLimitText("no such file"), false);
  });

  test("only a transient failure is retried — never to a different model", () => {
    assert.equal(worthRetrying("RATE_LIMITED"), true);
    assert.equal(worthRetrying("TIMED_OUT"), true);
    assert.equal(worthRetrying("BAD_OUTPUT"), false);
    assert.equal(worthRetrying("NOT_CONFIGURED"), false);
    assert.equal(worthRetrying("FAILED"), false);
  });

  test("firstJsonObject salvages, and gives up cleanly", () => {
    assert.deepEqual(firstJsonObject('noise {"a":1} noise'), { a: 1 });
    assert.equal(firstJsonObject("no json here"), null);
    assert.equal(firstJsonObject("{not json}"), null);
  });

  test("an unconfigured task is NOT_CONFIGURED, and the caller carries on", async () => {
    const runner = fakeRunner([]);
    const result = await interpretBurst(runner, { sourceText: "x", outstanding: [], language: "en" });
    assert.equal(result.ok, false);
  });
});

describe("partitionQuestions", () => {
  test("splits answered from outstanding and drops retired ids", () => {
    const { outstanding, answered } = partitionQuestions(
      { destination: { kind: "text", schema_version: 3, text: "Japan" } },
      QUESTIONS,
    );
    assert.deepEqual(answered, ["destination"]);
    assert.deepEqual(outstanding, ["trip_type", "dietary", "travelers"]);
  });

  // Why this exists at all: SessionView.nextQuestion is only the NEXT required
  // question, so a view-derived outstanding set would hide the rest from
  // interpret and defeat multi-answer messages.
  test("outstanding holds every unanswered question, not just the next one", () => {
    const { outstanding } = partitionQuestions({}, QUESTIONS);
    assert.equal(outstanding.length, QUESTIONS.length);
  });
});

/**
 * The field names a structured answer must use.
 *
 * `dataShape` only says array-or-object, which is all `validateAnswer` can
 * check — and is not enough for anything writing an answer without a person in
 * the loop. The worker's transformer reads specific keys, and an extraction
 * that invents its own passes every check on this side and produces a broken
 * site. Live on 2026-09-08 a booking PDF yielded `phases: [{place, start,
 * end}]` where `transformer.py` reads `name`, so every phase would have
 * arrived nameless.
 */
describe("structured questions name their fields", () => {
  const structured = INTAKE_QUESTIONS.filter((q) => q.type === "structured");

  test("there are some, so this suite is not vacuously passing", () => {
    assert.ok(structured.length >= 5, `${structured.length} structured questions`);
  });

  test("every one carries an example of the fields it expects", () => {
    const missing = structured.filter((q) => !q.dataExample).map((q) => q.id);
    assert.deepEqual(missing, [], "a structured question with no field example is one a model will invent keys for");
  });

  test("each example parses, and matches the question's own array/object shape", () => {
    for (const q of structured) {
      const parsed = JSON.parse(q.dataExample!);
      assert.equal(
        Array.isArray(parsed),
        q.dataShape === "array",
        `${q.id}: dataExample is ${Array.isArray(parsed) ? "an array" : "an object"} but dataShape says ${q.dataShape}`,
      );
    }
  });

  // The two the transformer actually projects into trip.config.json. Their key
  // names are a contract with transformer.py's module docstring, and this is
  // the test that fails if either side drifts.
  test("travelers and phases use the keys the transformer reads", () => {
    const travelers = JSON.parse(INTAKE_QUESTIONS.find((q) => q.id === "travelers")!.dataExample!);
    assert.deepEqual(Object.keys(travelers[0]).sort(), ["age", "family", "name", "name_en"]);

    const phases = JSON.parse(INTAKE_QUESTIONS.find((q) => q.id === "phases")!.dataExample!);
    // `planned` is deliberately NOT one the transformer reads — see below.
    assert.deepEqual(
      Object.keys(phases[0]).sort(),
      ["accommodation", "days", "end", "name", "name_en", "planned", "start"],
    );
    assert.equal(typeof phases[0].accommodation, "object", "accommodation is an object, not a string");
    assert.ok("name" in phases[0].accommodation);
  });

  test("a phase's days are shaped the way the site reads them", () => {
    // `_derive_phases` passes `days` straight through to trip.config.json, and
    // both site renderers read {date, label, items:[{time, text}]}. A document
    // with a dated day-by-day had nowhere to land before this: the organizer's
    // report, 2026-09-12 — "there are dates on the document for the planned
    // activities but they were not captured".
    const phases = JSON.parse(INTAKE_QUESTIONS.find((q) => q.id === "phases")!.dataExample!);
    const day = phases[0].days[0];
    assert.deepEqual(Object.keys(day).sort(), ["date", "items", "label"]);
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(day.label).sort(), ["en", "he"], "bilingual, like every other label on the site");
    assert.deepEqual(Object.keys(day.items[0]).sort(), ["text", "time"]);
    assert.deepEqual(Object.keys(day.items[0].text).sort(), ["en", "he"]);
  });

  /**
   * PLANNED is not ANCHORED, and the difference is evidence of booking.
   *
   * A museum with an e-ticket is an anchor; the same museum named in an
   * itinerary is planned, and it becomes an anchor the day a booking for it
   * arrives. Before this the extractor had nowhere to put a planned place and
   * filed them under "interests" — which is what the organizer actually
   * objected to: they are places to visit, not preferences.
   *
   * The transformer ignores `planned` today. That is on purpose and is why it
   * is asserted here: `intake_versions.data` keeps it losslessly, and the
   * enrichment pass that builds day-by-day itineraries is what wants it.
   */
  test("a phase can carry planned places, distinct from booked anchors", () => {
    const phases = JSON.parse(INTAKE_QUESTIONS.find((q) => q.id === "phases")!.dataExample!);
    assert.ok(Array.isArray(phases[0].planned), "planned is a list of place names");
    assert.ok(phases[0].planned.every((p: unknown) => typeof p === "string"));

    const anchors = JSON.parse(INTAKE_QUESTIONS.find((q) => q.id === "travel_anchors")!.dataExample!);
    assert.ok("confirmation" in anchors[0], "an anchor carries its booking evidence; a planned place does not");
  });

  test("the prompt states the planned-versus-anchored rule", () => {
    const prompt = buildExtractIntakePrompt({ documentText: "X", outstanding: ["phases", "travel_anchors"], language: "he" });
    assert.match(prompt, /EVIDENCE OF BOOKING/);
    assert.match(prompt, /A price beside a name is not a booking/);
  });

  test("the example reaches the extraction prompt as FIELD NAMES, not as values to copy", () => {
    // It used to say "use exactly these fields" over a fully realistic
    // example, which for a Japan trip reads as "these are good answers" — and
    // on 2026-09-12 a model answered with the example's own places. The
    // wording is the first half of the fix; `exampleEchoes` is the half that
    // does not depend on a model reading carefully.
    const prompt = buildExtractIntakePrompt({ documentText: "X", outstanding: ["phases"], language: "he" });
    assert.match(prompt, /use exactly these FIELD NAMES/);
    assert.match(prompt, /never copy them/);
    assert.ok(prompt.includes('"name": "Tokyo"'), "the field names themselves are in the prompt");
  });
});

/**
 * A passport is refused before its text goes anywhere.
 *
 * An organizer sending one is not a mistake — they are handing over "the trip
 * documents" and a passport scan is in that pile. But it answers none of the
 * interview's questions, so sending it to a model achieves nothing except
 * putting a passport number in a third party's logs. Declining costs nothing,
 * and is the right default for a bot that has just promised the organizer
 * their documents are safe with it.
 */
describe("identity documents are not read", () => {
  test("an MRZ is decisive, whatever the file is called", () => {
    const mrz = "P<ISRELUL<<DROR<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n1234567890ISR8001011M3001019<<<<<<<<<<<<<<04";
    assert.equal(looksLikeIdentityDocument(mrz, "scan.pdf"), true);
  });

  test("the filler run alone is enough — a photographed page often loses the first line", () => {
    assert.equal(looksLikeIdentityDocument("ELUL<<DROR<<<<<<<<<<<<<<<<", "anything.pdf"), true);
  });

  test("the filename catches a scan whose MRZ did not extract", () => {
    for (const name of ["pass.pdf", "Passport.pdf", "\u05d3\u05e8\u05db\u05d5\u05df.pdf", "passports scan.jpg"]) {
      assert.equal(looksLikeIdentityDocument("(no text extracted)", name), true, name);
    }
  });

  // The half that matters most: booking confirmations carry names, ticket
  // numbers and partial cards. Refusing those would refuse the whole feature.
  test("a booking confirmation is not an identity document", () => {
    const booking = [
      "Booking.com Confirmation",
      "ALOUL MOSHE YOSSI MR",
      "Confirmation number: DC6MJ6",
      "Blue Dolphin Inn — check-in 2026-06-14",
      "Card ending 4242",
    ].join("\n");
    assert.equal(looksLikeIdentityDocument(booking, "Booking.com_ Confirmation - Monterey.pdf"), false);
    assert.equal(looksLikeIdentityDocument(booking, "IRKJJZ - ALOUL CHANA MRS _ Sabre Red Web.pdf"), false);
  });

  test("documentText refuses it by reason, not by throwing", async () => {
    const bytes = new TextEncoder().encode("P<ISRELUL<<DROR<<<<<<<<<<<<<<<<<<<<<<<<<<<<<");
    const result = await documentText(bytes, "text/plain", "scan.txt");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "IDENTITY_DOCUMENT");
  });
});

describe("htmlToText", () => {
  test("keeps the words and drops the markup", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Check-in</p><p>June 14</p></body></html>";
    const text = htmlToText(html);
    assert.match(text, /Check-in/);
    assert.match(text, /June 14/);
    assert.equal(/color:red/.test(text), false, "style contents are gone");
    assert.equal(/<[a-z]/i.test(text), false, "no tags survive");
  });

  test("block tags become line breaks so table rows do not run together", () => {
    assert.match(htmlToText("<tr><td>Tokyo</td></tr><tr><td>Kyoto</td></tr>"), /Tokyo[\s\S]*\n[\s\S]*Kyoto/);
  });

  test("decodes the entities that actually turn up", () => {
    assert.match(htmlToText("<p>Bed &amp; Breakfast&nbsp;&#8212; 2 nights</p>"), /Bed & Breakfast/);
  });
});

describe("invisible characters are not content", () => {
  const RLM = "\u200f";
  const source = RLM + "\u2022 \u05dc\u05d7\u05e0\u05d4 - \u05dc\u05d0 \u05d9\u05d5\u05ea\u05e8 \u05de-20-30 \u05d3\u05e7\u05d5\u05ea\n"
    + RLM + "\u2022 \u05d9\u05d5\u05e1\u05d9 \u05d5\u05d7\u05e0\u05d4 (75/73)";

  // A Word plan in Hebrew carries a bidi mark on nearly every bullet. They
  // render as nothing, so a model quoting a line back returns the words and not
  // the marks — and a byte comparison then calls the quote invented. Live on
  // the USA trip's own plan: constraints, travel_anchors and budget_detail were
  // all extracted correctly from Hebrew bullets and all three were refused.
  test("a quote missing the document's bidi marks still matches", () => {
    const quoted = "\u2022 \u05dc\u05d7\u05e0\u05d4 - \u05dc\u05d0 \u05d9\u05d5\u05ea\u05e8 \u05de-20-30 \u05d3\u05e7\u05d5\u05ea";
    assert.equal(evidenceAppears(quoted, source), true);
  });

  test("and an invented Hebrew line is still refused", () => {
    const invented = "\u2022 \u05dc\u05d9\u05d5\u05e1\u05d9 - \u05e9\u05e2\u05ea\u05d9\u05d9\u05dd \u05e8\u05e6\u05d5\u05e3";
    assert.equal(evidenceAppears(invented, source), false);
  });

  test("a soft hyphen or BOM in the source does not hide a real quote", () => {
    assert.equal(evidenceAppears("Breckenridge", "Brecken\u00adridge"), true);
    assert.equal(evidenceAppears("Dallas", "\ufeffDallas"), true);
  });
});

/**
 * The recap is shown to be CHECKED, so it must be readable.
 *
 * Found by the document end-to-end harness on its first run: the budget line
 * read "items: [object Object],[object Object],[object Object]" — in the very
 * message asking the organizer to correct anything the document got wrong.
 * `budget_detail` is an object whose `items` is an array, which is an ordinary
 * shape and was the first one tried.
 */
describe("buildRecap never shows [object Object]", () => {
  function labelFor(questionId: string, data: unknown): string {
    const answers = { [questionId]: { kind: "structured" as const, schema_version: 3, data } };
    return buildRecap(answers, INTAKE_QUESTIONS, "he").find((e) => e.questionId === questionId)?.answerLabel ?? "";
  }

  // `constraints` rather than `budget_detail`: the latter was retired on
  // 2026-09-09 as a question about the organizer rather than the trip. The
  // SHAPE is what matters here — an object whose value is an array of objects,
  // which is ordinary and is what produced "[object Object]" live.
  test("an object holding an array of objects reads as words", () => {
    const label = labelFor("constraints", {
      currency: "JPY",
      party_size: 5,
      items: [{ label: "hotels", amount: 300105 }, { label: "flights", amount: 22000 }],
    });
    assert.equal(/\[object Object\]/.test(label), false, label);
    assert.match(label, /JPY/);
    assert.match(label, /hotels/);
  });

  test("an array of objects with names reads as the names", () => {
    const label = labelFor("phases", [
      { name: "Tokyo", start: "2026-09-19" },
      { name: "Kyoto", start: "2026-09-24" },
    ]);
    assert.match(label, /Tokyo/);
    assert.match(label, /Kyoto/);
  });

  // Dropping an undescribable entry beats printing a placeholder: the
  // organizer is being asked to spot mistakes, and "[object Object]" is noise
  // that makes the whole line untrustworthy.
  test("a value it cannot describe is dropped, not stringified", () => {
    const label = labelFor("constraints", { mobility: "wheelchair", opaque: { a: { b: {} } } });
    assert.equal(/\[object Object\]/.test(label), false, label);
    assert.match(label, /wheelchair/);
  });

  test("deeply nested nonsense still never leaks a placeholder", () => {
    for (const data of [
      { a: [[{}], [{}]] },
      { a: [{ b: [{ c: {} }] }] },
      [{ x: [{}, {}] }],
      { only: {} },
    ]) {
      const label = labelFor("constraints", data);
      assert.equal(/\[object Object\]/.test(label), false, JSON.stringify(data) + " -> " + label);
    }
  });
});
