import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  DEFAULT_MIN_CONFIDENCE,
  applyProposals,
  buildInterpretPrompt,
  burstKey,
  evidenceAppears,
  interpretBurst,
  parseInterpretPayload,
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

describe("applyProposals — the gate", () => {
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
    assert.deepEqual(Object.keys(phases[0]).sort(), ["accommodation", "end", "name", "name_en", "start"]);
    assert.equal(typeof phases[0].accommodation, "object", "accommodation is an object, not a string");
    assert.ok("name" in phases[0].accommodation);
  });

  test("the example reaches the extraction prompt", () => {
    const prompt = buildExtractIntakePrompt({ documentText: "X", outstanding: ["phases"], language: "he" });
    assert.match(prompt, /use exactly these fields/);
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

  test("an object holding an array of objects reads as words", () => {
    const label = labelFor("budget_detail", {
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
