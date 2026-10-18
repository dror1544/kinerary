import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTAKE_QUESTIONS } from "../src/interview.js";
import {
  STAR_SCENARIO,
  TYPED_CHOICE_TRIES,
  buildFindings,
  choiceAnswer,
  type Scenario,
} from "../tools/organizer-scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureSpec = (name: string): Record<string, string> =>
  JSON.parse(
    execFileSync(
      "python3",
      ["-c", `import json,sys; sys.path.insert(0, sys.argv[1]); from make_documents import SCENARIOS; print(json.dumps(SCENARIOS[sys.argv[2]]))`,
        join(here, "fixtures"), name],
      { encoding: "utf8" },
    ),
  );

const TRIP_TYPE = INTAKE_QUESTIONS.find((q) => q.id === "trip_type")!;
const BOT_TONE = INTAKE_QUESTIONS.find((q) => q.id === "bot_tone")!;

describe("choiceAnswer: a choice is tapped unless the scenario types it in words", () => {
  const typed: Scenario = { language: "he", documents: false, text: {}, choice: { trip_type: "family" },
    multi: {}, typedChoice: { trip_type: "טיול זוגות ולא משפחה" } };
  const tapped: Scenario = { ...typed, typedChoice: undefined };

  test("a typed choice is typed first", () => {
    assert.deepEqual(choiceAnswer(TRIP_TYPE, typed, 0), { kind: "type", text: "טיול זוגות ולא משפחה" });
  });

  test("it is typed again when the interview re-asks, up to the cap", () => {
    assert.equal(choiceAnswer(TRIP_TYPE, typed, TYPED_CHOICE_TRIES - 1).kind, "type");
  });

  test("after the cap the button is tapped, and the fallback is flagged so it can be reported", () => {
    // Silently tapping would let the run pass on the button and hide that the
    // typed answer was never understood — the defect the scenario exists for.
    assert.deepEqual(choiceAnswer(TRIP_TYPE, typed, TYPED_CHOICE_TRIES),
      { kind: "tap", option: "family", fallback: true });
  });

  test("a choice the scenario does not type is tapped, from its own answer", () => {
    assert.deepEqual(choiceAnswer(TRIP_TYPE, tapped, 0), { kind: "tap", option: "family", fallback: false });
  });

  test("with no scripted answer the first option is tapped, as before", () => {
    assert.deepEqual(choiceAnswer(BOT_TONE, tapped, 0), { kind: "tap", option: BOT_TONE.options![0]!.id, fallback: false });
  });

  test("a question with nothing to tap and nothing to type is an error, not a guess", () => {
    assert.throws(() => choiceAnswer({ id: "x", options: [] } as never, tapped, 0), /no options/);
  });
});

describe("buildFindings: what the organizer reports about itself", () => {
  test("no fallbacks is an empty list, not a missing key", () => {
    assert.deepEqual(buildFindings([]), { typed_fallbacks: [] });
  });

  test("a fallback names the question and how many times it was typed", () => {
    assert.deepEqual(buildFindings([{ question: "trip_type", text: "טיול זוגות", tries: 2 }]),
      { typed_fallbacks: [{ question: "trip_type", text: "טיול זוגות", tries: 2 }] });
  });
});

describe("the star scenario", () => {
  const spec = fixtureSpec("star");

  test("it answers every required question, so the run cannot stall on a gap in the script", () => {
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      if (q.type === "choice") {
        assert.ok(STAR_SCENARIO.typedChoice?.[q.id] || STAR_SCENARIO.choice[q.id] || q.options?.length, q.id);
      } else if (q.type === "multi_choice") {
        assert.ok(STAR_SCENARIO.multi[q.id], q.id);
      } else if (q.id !== "timezone") {
        assert.ok(STAR_SCENARIO.text[q.id], `no answer for required question ${q.id}`);
      }
    }
  });

  test("the trip type is typed in words and means couples, not the family option", () => {
    const typedText = STAR_SCENARIO.typedChoice?.trip_type;
    assert.ok(typedText, "trip_type is typed");
    assert.match(typedText!, /זוגות/);
    assert.notEqual(STAR_SCENARIO.choice.trip_type, "couple", "the button is not what is under test");
  });

  test("it is a Hebrew interview with no documents, like the other typed scenarios", () => {
    assert.equal(STAR_SCENARIO.language, "he");
    assert.equal(STAR_SCENARIO.documents, false);
  });

  test("its dates are the fixture's: December 2027, the 2nd to the 9th", () => {
    // The two files are written separately (Hebrew prose here, ISO there);
    // this is the one place that proves they describe the same trip.
    assert.equal(spec.departure_date, "2027-12-02");
    assert.equal(spec.return_date, "2027-12-09");
    assert.match(STAR_SCENARIO.text.departure_date!, /^2 בדצמבר 2027$/);
    assert.match(STAR_SCENARIO.text.return_date!, /^9 בדצמבר 2027$/);
  });

  test("both flights the fixture expects on the site are given in the interview", () => {
    const spoken = `${STAR_SCENARIO.text.phases} ${STAR_SCENARIO.text.travel_anchors}`;
    for (const ref of (spec as unknown as { expect_anchor_text: string[] }).expect_anchor_text) {
      assert.ok(spoken.includes(ref), `${ref} is never said`);
    }
  });

  test("the base is a stop, the gateway is named only as where the flights land", () => {
    assert.match(STAR_SCENARIO.text.phases!, /קולמר/);
    assert.match(STAR_SCENARIO.text.phases!, /פרנקפורט/);
  });

  test("one hotel, two rooms, and one car picked up and returned at the gateway", () => {
    assert.match(STAR_SCENARIO.text.phases!, /שני חדרים/);
    assert.match(STAR_SCENARIO.text.phases!, /רכב שכור אחד/);
  });

  test("the travellers are two couples with made-up surnames", () => {
    const roster = STAR_SCENARIO.text.travelers!;
    assert.equal(roster.split(/,| ו/).filter((s) => s.trim()).length, 4);
    for (const real of ["אלול", "כהן", "לוי"]) assert.ok(!roster.includes(real), real);
  });

  test("the organizer is one of the travellers", () => {
    assert.ok(STAR_SCENARIO.text.travelers!.includes(STAR_SCENARIO.text.organizer_identity!));
  });
});
