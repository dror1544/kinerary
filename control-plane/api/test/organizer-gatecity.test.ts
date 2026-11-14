import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTAKE_QUESTIONS } from "../src/interview.js";
import {
  APPLY_CHANGE_DATA,
  GATECITY_SCENARIO,
  SEEDED_QUESTIONS,
} from "../tools/organizer-scenarios.js";
import { changeCallbackData, parseCallbackData } from "../src/chat-router.js";

const tools = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
/** The scenario's facts, as the python half (ticket_photos.py) holds them. */
const facts = JSON.parse(
  execFileSync(
    "python3",
    ["-c", "import json,sys; sys.path.insert(0, sys.argv[1]); from ticket_photos import GATECITY; print(json.dumps(GATECITY))", tools],
    { encoding: "utf8" },
  ),
) as {
  organizer_name: string; destination: string; language: string; trip_type: string;
  departure_date: string; seed_return_date: string; return_date: string; summary_change: string;
  travellers: number; tickets: { passengers: string[] }[];
};

describe("the gatecity scenario: the manual Sprint 8 staging test, as the automated organizer plays it", () => {
  test("it is a Hebrew interview whose documents are photos, not files", () => {
    assert.equal(GATECITY_SCENARIO.language, "he");
    assert.equal(facts.language, "he");
    assert.equal(GATECITY_SCENARIO.photos, true);
    assert.equal(GATECITY_SCENARIO.documents, false);
  });

  test("it answers every required question, so the run cannot stall on a gap in the script", () => {
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      if (q.type === "choice") {
        assert.ok(GATECITY_SCENARIO.choice[q.id] || q.options?.length, q.id);
      } else if (q.type === "multi_choice") {
        assert.ok(GATECITY_SCENARIO.multi[q.id], q.id);
      } else if (q.id !== "timezone") {
        assert.ok(GATECITY_SCENARIO.text[q.id], `no answer for required question ${q.id}`);
      }
    }
  });

  test("its fallback answers agree with the dashboard values the python half seeds", () => {
    assert.equal(GATECITY_SCENARIO.choice.trip_type, facts.trip_type);
    assert.match(GATECITY_SCENARIO.text.departure_date!, /^14 בנובמבר 2026$/);
    assert.equal(facts.departure_date, "2026-11-14");
    assert.match(GATECITY_SCENARIO.text.return_date!, /^22 בנובמבר 2026$/);
    assert.equal(facts.return_date, "2026-11-22");
  });

  test("the correction at the summary changes the return date to the real one, in words", () => {
    // The seed is one day short, so the correction is a change and not a repeat.
    assert.equal(facts.seed_return_date, "2026-11-21");
    assert.equal(GATECITY_SCENARIO.summaryChange, facts.summary_change);
    assert.match(GATECITY_SCENARIO.summaryChange!, /22 בנובמבר/);
    assert.doesNotMatch(GATECITY_SCENARIO.summaryChange!, /\d{4}-\d{2}-\d{2}/, "words, never an ISO date");
  });

  test("it taps the second ticket's travellers offer, which is never a question of its own", () => {
    assert.deepEqual(GATECITY_SCENARIO.tapOffers, ["y:travelers"]);
  });

  test("four travellers, two per ticket, and the organizer is one of them", () => {
    assert.equal(facts.travellers, 4);
    assert.equal(facts.tickets.flatMap((t) => t.passengers).length, 4);
    assert.ok(GATECITY_SCENARIO.text.travelers!.includes(GATECITY_SCENARIO.text.organizer_identity!));
  });

  test("the seeded questions are exactly the ones a dashboard trip answers, and all exist in the interview", () => {
    const ids = new Set(INTAKE_QUESTIONS.map((q) => q.id));
    for (const id of SEEDED_QUESTIONS) assert.ok(ids.has(id), id);
    assert.deepEqual([...SEEDED_QUESTIONS].sort(), ["departure_date", "destination", "return_date", "trip_type"]);
  });
});

describe("APPLY_CHANGE_DATA recognises the Apply button of a drafted change and nothing else", () => {
  const draft = "draft_ab12cd34ef56";

  test("it matches what the router emits for apply, with and without a digest", () => {
    assert.match(changeCallbackData(draft, "0a1b2c3d", "apply"), APPLY_CHANGE_DATA);
    assert.match(`pc:${draft}:a`, APPLY_CHANGE_DATA);
  });

  test("it does not match cancel, a pick, or any other button", () => {
    assert.doesNotMatch(changeCallbackData(draft, "0a1b2c3d", "cancel"), APPLY_CHANGE_DATA);
    assert.doesNotMatch(changeCallbackData(draft, "0a1b2c3d", "pick", 1), APPLY_CHANGE_DATA);
    for (const data of ["c:confirm", "y:travelers", "a:trip_type:family"]) assert.doesNotMatch(data, APPLY_CHANGE_DATA);
  });

  test("whatever it matches, the router reads as an apply", () => {
    const parsed = parseCallbackData(changeCallbackData(draft, "0a1b2c3d", "apply"));
    assert.equal(parsed.kind, "change");
    assert.equal((parsed as { choice: string }).choice, "apply");
  });
});
