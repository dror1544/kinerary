/**
 * The document-extraction prompt and the examples it carries, checked with the
 * same parsers production uses. Deterministic: no model is called. How a model
 * behaves under these rules is measured separately, and differently, by
 * tools/extract-intake-eval.mjs.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyProposals,
  buildExtractIntakePrompt,
  buildInterpretPrompt,
  evidenceAppears,
  exampleEchoes,
  languageName,
  parseInterpretPayload,
} from "../src/interpret.js";
import { INTAKE_QUESTIONS, validateAnswer } from "../src/interview.js";

// The e2e japan fixture as documentText() returned it on 2026-09-13
// (test/fixtures/make_documents.py builds the PDF it comes from).
const JAPAN = [
  "Yapan Tours - Booking Confirmation",
  "Quote 2026-4471 5 adults",
  "Entire Trip: 19 Sep, 2026 - 03 Oct, 2026",
  "Tokyo Sep 19 - Sep 23 OMO3 Asakusa by Hoshino Resorts",
  "Tokyo Skytree 20 Sep 10:00",
  "TeamLab Planets 20 Sep 18:00",
  "Hakone Sep 23 - Sep 24 Hakone Ashinoko Hanaori",
  "Kyoto Sep 24 - Sep 27 Cross Hotel Kyoto",
  "Osaka Sep 27 - Sep 30 Hotel Royal Classic Osaka",
].join("\n");

// What identifies that fixture. None of it may sit in a runtime example: an
// example that IS the fixture cannot show that the document was read.
const FIXTURE_MARKERS = [
  /tokyo/i, /hakone/i, /kyoto/i, /osaka/i, /omo3/i, /skytree/i, /teamlab/i,
  /2026-4471/, /19 sep/i, /5 adults/i, /ABC123/, /LY075/,
];

const ALL = INTAKE_QUESTIONS.map((q) => q.id);
const WITH_EXAMPLES = INTAKE_QUESTIONS.filter((q) => q.dataExample);

/** A dataJson string read exactly as a model's structured answer is read. */
function readDataJson(questionId: string, dataJson: string): unknown {
  const payload = parseInterpretPayload({
    proposals: [{ questionId, value: { kind: "structured", dataJson }, confidence: 0.9, evidence: "x" }],
    unclear: [],
  });
  assert.ok(payload, "the payload parses");
  assert.equal(payload.malformed, 0, "the dataJson string parses");
  const value = payload.proposals[0]!.value;
  assert.equal(value.kind, "structured");
  return (value as { kind: "structured"; data: unknown }).data;
}

describe("question examples — read the way a model's answer is read", () => {
  for (const q of WITH_EXAMPLES) {
    test(`${q.id}: its example is a valid answer to its own question`, () => {
      const data = readDataJson(q.id, q.dataExample!);
      const result = validateAnswer(q.id, null, null, INTAKE_QUESTIONS, data);
      assert.equal(result.ok, true, JSON.stringify(result));
    });
  }

  test("no example carries the e2e japan fixture", () => {
    for (const q of WITH_EXAMPLES) {
      for (const marker of FIXTURE_MARKERS) assert.doesNotMatch(q.dataExample!, marker, `${q.id} matches ${marker}`);
    }
  });

  test("travel_anchors shows one canonical booking type, a clock time, and covers ticketed visits", () => {
    const q = INTAKE_QUESTIONS.find((x) => x.id === "travel_anchors")!;
    const [anchor] = readDataJson(q.id, q.dataExample!) as Record<string, unknown>[];
    assert.doesNotMatch(String(anchor!.type), /\|/);
    assert.equal(anchor!.type, "attraction");
    assert.match(String(anchor!.time), /^([01]\d|2[0-3]):[0-5]\d$/);
    for (const kind of ["ticketed attractions", "tours", "activities", "events", "shuttles", "parking"]) {
      assert.match(q.prompt, new RegExp(kind, "i"));
    }
  });

  test("bot_limits entries are {he, en} objects — the transformer drops anything else", () => {
    const q = INTAKE_QUESTIONS.find((x) => x.id === "bot_limits")!;
    const entries = readDataJson(q.id, q.dataExample!) as unknown[];
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      assert.ok(typeof e.he === "string" && e.he.trim() && typeof e.en === "string" && e.en.trim(), JSON.stringify(entry));
    }
  });

  test("phases shows a stay with a confirmation and a stay without one", () => {
    const q = INTAKE_QUESTIONS.find((x) => x.id === "phases")!;
    const stops = readDataJson(q.id, q.dataExample!) as { accommodation?: { confirmation?: string } }[];
    assert.ok(stops.some((s) => s.accommodation?.confirmation));
    assert.ok(stops.some((s) => s.accommodation && !("confirmation" in s.accommodation)));
  });
});

describe("exampleEchoes — a category the prompt defines is not copied from its example", () => {
  const example = INTAKE_QUESTIONS.find((q) => q.id === "travel_anchors")!.dataExample!;
  const source = "Vatican Museums - tickets booked, ref VAT-2231, 6 May 09:30";

  test("a booked visit typed `attraction`, like the example, is not an echo", () => {
    const value = { kind: "structured", data: [{ type: "attraction", name: "Vatican Museums", date: "2027-05-06", time: "09:30", confirmation: "VAT-2231" }] };
    assert.deepEqual(exampleEchoes(example, value, source), []);
  });

  test("the example's own place and code still are", () => {
    const [copied] = JSON.parse(example) as Record<string, string>[];
    const value = { kind: "structured", data: [{ ...copied }] };
    const echoed = exampleEchoes(example, value, source);
    assert.ok(echoed.includes(copied!.name!), JSON.stringify(echoed));
    assert.ok(echoed.includes(copied!.confirmation!), JSON.stringify(echoed));
  });
});

describe("buildExtractIntakePrompt — the text the model receives", () => {
  const prompt = buildExtractIntakePrompt({ documentText: JAPAN, outstanding: ALL, language: "he" });
  const exampleOf = (text: string) => {
    const m = text.match(/escape it, e\.g\. ("dataJson":"(?:[^"\\]|\\.)*")/);
    assert.ok(m, "the prompt shows a dataJson example");
    const outer = JSON.parse(`{${m[1]}}`) as { dataJson: string };
    return JSON.parse(outer.dataJson) as Record<string, unknown>[];
  };

  test("its dataJson example is valid JSON as delivered, using a key a question has", () => {
    // It used to render as "dataJson":"[{"place":"Tokyo"}]": invalid, and `place`
    // is a key no question uses.
    const inner = exampleOf(prompt);
    assert.equal(typeof inner[0]!.name, "string");
  });

  test("so is the typed-message prompt's", () => {
    const inner = exampleOf(buildInterpretPrompt({ sourceText: "hello", outstanding: ALL, language: "he" }));
    assert.equal(typeof inner[0]!.name, "string");
  });

  test("the empty result it shows is a complete payload", () => {
    const m = prompt.match(/A document that answers nothing is a valid result: (\{.*\})\./);
    assert.ok(m);
    const raw = JSON.parse(m[1]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), ["proposals", "unclear"]);
    const parsed = parseInterpretPayload(raw);
    assert.ok(parsed);
    assert.equal(parsed.proposals.length, 0);
  });

  test("several evidence lines are asked for as the JSON escape, not a raw line break", () => {
    // A raw line break inside a JSON string is invalid JSON: the runner's parse
    // fails and the whole read is BAD_OUTPUT, not one refused proposal.
    assert.match(prompt, /separated by \\n \(the JSON escape, never a raw line break\)/);
  });

  test("the organizer's language is named, not coded", () => {
    assert.match(prompt, /They write in Hebrew\./);
    assert.equal(languageName("en"), "English");
    assert.equal(languageName("fr"), "fr", "an unknown code is passed through, not dropped");
  });

  test("the document comes last, between markers, byte for byte", () => {
    const open = "<<<DOCUMENT\n";
    const start = prompt.indexOf(open);
    const end = prompt.lastIndexOf("\nDOCUMENT>>>");
    assert.ok(start > 0 && end > start);
    assert.equal(prompt.slice(start + open.length, end), JAPAN);
    assert.ok(prompt.endsWith("\nDOCUMENT>>>"));
  });

  test("only the questions still outstanding are described", () => {
    const partial = buildExtractIntakePrompt({ documentText: JAPAN, outstanding: ["phases", "departure_date"], language: "he" });
    const described = [...partial.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(described, ["departure_date", "phases"]);
  });

  test("its fixed text and examples carry nothing of the japan fixture", () => {
    // `timezone` is left out: its own wording names Asia/Tokyo as an example
    // zone. That is the interviewer's question copy, not an extraction example.
    const fixed = buildExtractIntakePrompt({ documentText: "", outstanding: ALL.filter((id) => id !== "timezone"), language: "he" });
    for (const marker of FIXTURE_MARKERS) assert.doesNotMatch(fixed, marker);
  });

  test("nothing is left unrendered", () => {
    assert.doesNotMatch(prompt.replace(JAPAN, ""), /\$\{|\{\{/);
  });
});

describe("evidenceAppears — lines a model joined with ' / '", () => {
  const LEGS = [
    "Tokyo Sep 19 - Sep 23 OMO3 Asakusa by Hoshino Resorts",
    "Hakone Sep 23 - Sep 24 Hakone Ashinoko Hanaori",
    "Kyoto Sep 24 - Sep 27 Cross Hotel Kyoto",
    "Osaka Sep 27 - Sep 30 Hotel Royal Classic Osaka",
  ];

  test("verbatim lines joined by ' / ' count the same as lines on their own", () => {
    // The form that cost the e2e japan run its stops on 2026-09-13.
    assert.equal(evidenceAppears(LEGS.join(" / "), JAPAN), true);
    assert.equal(evidenceAppears(LEGS.join("\n"), JAPAN), true);
  });

  test("one invented piece still fails the whole claim", () => {
    assert.equal(evidenceAppears(`${LEGS[0]} / Nara Sep 23 - Sep 24 Hotel Nikko`, JAPAN), false);
  });

  test("a source line that itself contains ' / ' still matches", () => {
    assert.equal(evidenceAppears("Room: Deluxe / Twin", "Hotel Borg\nRoom: Deluxe / Twin\n2 nights"), true);
  });
});

describe("the e2e japan document through the gate", () => {
  // The stops as the model returned them in the six controlled runs of
  // 2026-09-13 — identical in every run — with the joined evidence one of them used.
  const STOPS = [
    { name: "Tokyo", name_en: "Tokyo", start: "2026-09-19", end: "2026-09-23", accommodation: { name: "OMO3 Asakusa by Hoshino Resorts" }, planned: ["Tokyo Skytree", "TeamLab Planets"] },
    { name: "Hakone", name_en: "Hakone", start: "2026-09-23", end: "2026-09-24", accommodation: { name: "Hakone Ashinoko Hanaori" } },
    { name: "Kyoto", name_en: "Kyoto", start: "2026-09-24", end: "2026-09-27", accommodation: { name: "Cross Hotel Kyoto" } },
    { name: "Osaka", name_en: "Osaka", start: "2026-09-27", end: "2026-09-30", accommodation: { name: "Hotel Royal Classic Osaka" } },
  ];
  const WHOLE_TRIP = "Entire Trip: 19 Sep, 2026 - 03 Oct, 2026";
  const payload = parseInterpretPayload({
    proposals: [
      { questionId: "departure_date", value: { kind: "text", text: "2026-09-19" }, confidence: 0.95, evidence: WHOLE_TRIP },
      { questionId: "return_date", value: { kind: "text", text: "2026-10-03" }, confidence: 0.95, evidence: WHOLE_TRIP },
      {
        questionId: "phases",
        value: { kind: "structured", dataJson: JSON.stringify(STOPS) },
        confidence: 0.85,
        evidence: JAPAN.split("\n").filter((l) => / - Sep \d\d /.test(l)).join(" / "),
      },
    ],
    unclear: [{ questionId: "travelers", why: "5 adults, no names" }],
  })!;
  const decide = (answered: string[] = []) =>
    applyProposals(payload.proposals, { sourceText: JAPAN, outstanding: ALL.filter((id) => !answered.includes(id)), answered, unclear: payload.unclear });

  test("the stops survive the evidence form that was refused before", () => {
    const decisions = decide();
    assert.deepEqual(decisions.accepted.map((a) => a.questionId).sort(), ["departure_date", "phases", "return_date"]);
    assert.deepEqual(decisions.rejected, []);
  });

  test("four legs, their own hotels and dates, and no confirmation added on the way", () => {
    const phases = decide().accepted.find((a) => a.questionId === "phases")!.answer as unknown as { data: typeof STOPS };
    assert.deepEqual(phases.data, STOPS);
    assert.ok(phases.data.every((s) => !("confirmation" in s.accommodation)));
    assert.ok(phases.data.every((s) => s.end <= "2026-09-30"), "nothing is described after Osaka");
  });

  test("a count without names stays a question, beside the stops that were read", () => {
    const decisions = decide();
    assert.ok(decisions.askAnyway.includes("travelers"));
    assert.ok(!decisions.accepted.some((a) => a.questionId === "travelers"));
  });

  test("a later upload does not overwrite stops already answered", () => {
    const decisions = decide(["phases"]);
    assert.ok(!decisions.accepted.some((a) => a.questionId === "phases"));
    assert.ok(decisions.rejected.some((r) => r.questionId === "phases" && r.reason === "ALREADY_ANSWERED"));
  });

  test("the gate cannot tell a quote number from a hotel confirmation — that rule lives in the prompt", () => {
    // Documented, not endorsed: the code is in the source, so evidence and echo
    // checks pass. Only the prompt's booking rule stands between this and a
    // family's site showing a quote as a reservation.
    const misfiled = structuredClone(STOPS);
    (misfiled[0]!.accommodation as Record<string, string>).confirmation = "2026-4471";
    const lines = JAPAN.split("\n");
    const decisions = applyProposals(
      [{ questionId: "phases", value: { kind: "structured", data: misfiled }, confidence: 0.9, evidence: `${lines[1]}\n${lines[3]}`, sourceMessageId: "doc" }],
      { sourceText: JAPAN, outstanding: ALL, answered: [] },
    );
    assert.ok(decisions.accepted.some((a) => a.questionId === "phases"));
  });
});

describe("weekday dates with no year", () => {
  const outstanding = INTAKE_QUESTIONS.map((q) => q.id);
  const today = new Date(Date.UTC(2026, 4, 23));

  test("the prompt gives the year each one takes, outside the document markers", () => {
    const prompt = buildExtractIntakePrompt({
      documentText: "Hotel Solmar\nCHECK-IN\n23\nJULY\nThursday\nCHECK-OUT\n25\nJULY\nSaturday",
      outstanding, language: "he", today,
    });
    assert.ok(prompt.includes('- "23 JULY Thursday" is 2026-07-23'), "check-in");
    assert.ok(prompt.includes('- "25 JULY Saturday" is 2026-07-25'), "check-out");
    assert.ok(prompt.indexOf("2026-07-23") < prompt.indexOf("<<<DOCUMENT"), "before the document, not inside it");
  });

  test("no list at all when the document has no such date", () => {
    const prompt = buildExtractIntakePrompt({ documentText: "Tokyo Sep 19 - Sep 23 2026", outstanding, language: "he", today });
    assert.equal(prompt.includes("Weekday dates with no year"), false);
  });
});
