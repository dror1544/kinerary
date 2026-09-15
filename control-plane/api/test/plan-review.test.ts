/**
 * The plan review, without a database and without a model.
 *
 * Two things are being proved here and they pull in opposite directions:
 *
 *   1. On a THIN plan — the one the pipeline actually produces today, days
 *      built from `travel_anchors` and nothing else — the pass finds the holes
 *      the organizer named: no arrival, no check-in, no transfer between two
 *      cities, places listed and never scheduled.
 *   2. On a GOOD plan — `trips/japan-2025/trip.config.json`, hand-authored and
 *      the bar this work is measured against — it does NOT invent problems.
 *      A reviewer that cries wolf on a good plan is a reviewer nobody opens,
 *      which is the state the trip site's own enrichment queue is already in.
 *
 * The second is why japan-2025 is loaded from the tree rather than copied into
 * a fixture: a rule that starts firing on the reference plan should break a
 * test the day it is written, not the day someone looks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  auditPlan,
  buildPlanReviewPrompt,
  gateModelProposals,
  parsePlanReviewPayload,
  proposalId,
  readGroup,
  readPlan,
  reviewPlan,
  reviewSourceText,
  type PlanProposal,
} from "../src/plan-review.js";
import { fakeRunner } from "../src/model-runner.js";

const JAPAN_CONFIG = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../trips/japan-2025/trip.config.json", import.meta.url)), "utf8"),
);

function text(value: string) {
  return { kind: "text", text: value };
}
function choice(optionId: string) {
  return { kind: "choice", option_id: optionId };
}
function structured(data: unknown) {
  return { kind: "structured", data };
}

/**
 * A config in the shape `transform_intake` + `derive_days_from_anchors`
 * produce: two legs, days holding only the dated things the organizer had
 * already booked. Verified against the real transformer while this was
 * written — it emitted exactly this shape for the same answers.
 */
const THIN_CONFIG = {
  meta: { title: "Japan 2026", defaultLang: "he" },
  phases: [
    {
      id: "tokyo",
      tabLabel: "Tokyo",
      title: { he: "טוקיו", en: "Tokyo" },
      dates: { start: "2026-09-19", end: "2026-09-23" },
      accommodation: { name: "OMO3 Asakusa", name_en: "OMO3 Asakusa", confirmation: "ABC123" },
      venues: [
        { id: "v1", name: { he: "Tokyo Skytree", en: "Tokyo Skytree" } },
        { id: "v2", name: { he: "Senso-ji", en: "Senso-ji" } },
      ],
      days: [
        { date: "2026-09-20", items: [
          { time: "18:00", text: { he: "teamLab Planets", en: "teamLab Planets" } },
          { time: "10:00", text: { he: "Tokyo Skytree", en: "Tokyo Skytree" } },
        ] },
      ],
    },
    {
      id: "kyoto",
      tabLabel: "Kyoto",
      title: { he: "קיוטו", en: "Kyoto" },
      dates: { start: "2026-09-23", end: "2026-09-25" },
      accommodation: { name: "Cross Hotel Kyoto", name_en: "Cross Hotel Kyoto" },
      venues: [{ id: "v3", name: { he: "Fushimi Inari", en: "Fushimi Inari" }, url: "https://inari.jp/" }],
      days: [
        { date: "2026-09-25", items: [{ time: "11:00", text: { he: "Fushimi Inari", en: "Fushimi Inari" } }] },
      ],
    },
  ],
};

const THIN_ANSWERS = {
  destination: text("Japan"),
  trip_pace: choice("balanced"),
  travelers: structured([
    { name: "Dror", name_en: "Dror", age: 47, family: "Elul" },
    { name: "Moshe", name_en: "Moshe", age: 4, family: "Elul" },
  ]),
  travel_anchors: structured([
    { type: "flight", name: "LY075 TLV-NRT", date: "2026-09-19", time: "09:05", confirmation: "LY111" },
  ]),
};

function kinds(proposals: PlanProposal[], kind: string): PlanProposal[] {
  return proposals.filter((proposal) => proposal.kind === kind);
}
function titled(proposals: PlanProposal[], needle: string): PlanProposal | undefined {
  return proposals.find((proposal) => proposal.title.includes(needle));
}

describe("readPlan", () => {
  test("gives every day item the identity the trip site uses for a config item", () => {
    const plan = readPlan(THIN_CONFIG, "Japan");
    const keys = plan.phases[0]!.days[0]!.items.map((item) => item.key);
    assert.deepEqual(keys, ["tokyo|2026-09-20|0", "tokyo|2026-09-20|1"]);
    // living-journey.js's CONFIG_REF_RE, verbatim — this is the join it makes.
    for (const key of keys) assert.match(key, /^[^|]+\|\d{4}-\d{2}-\d{2}\|\d+$/);
  });

  test("reads both venue name shapes the pipeline produces", () => {
    // The transformer writes {name: {he, en}}; the hand-built trips write
    // {name, name_he}. Both are live.
    const fromBoth = readPlan(
      {
        phases: [
          { id: "a", dates: { start: "2026-01-01", end: "2026-01-02" }, venues: [
            { name: { he: "מקדש", en: "Senso-ji Temple" } },
            { name: "Tokyo Skytree", name_he: "Tokyo Skytree" },
          ] },
        ],
      },
      "Japan",
    );
    assert.deepEqual(
      fromBoth.phases[0]!.venues.map((venue) => venue.name.en),
      ["Senso-ji Temple", "Tokyo Skytree"],
    );
  });

  test("survives a config with nothing in it", () => {
    assert.deepEqual(readPlan(null).phases, []);
    assert.deepEqual(readPlan({ phases: [{}, 7, null] }).phases, []);
  });

  test("defuses markup in a day line", () => {
    // The site renders a config day's text as raw HTML (_biSpan), so anything
    // quoted back into a proposal has to arrive unable to open a tag. Same
    // treatment as itinerary-extract.ts's `plain()`: the angle brackets go,
    // the characters between them are left alone rather than guessed at.
    const plan = readPlan({
      phases: [{ id: "a", dates: { start: "2026-01-01", end: "2026-01-01" }, days: [
        { date: "2026-01-01", items: [{ text: { he: "<b>x</b>", en: "<script>alert(1)</script>Museum" } }] },
      ] }],
    });
    const rendered = plan.phases[0]!.days[0]!.items[0]!.text.en;
    assert.doesNotMatch(rendered, /[<>]/);
    assert.ok(rendered.includes("Museum"));
  });
});

describe("readGroup", () => {
  test("reads pace, ages and a flight anchor's clock", () => {
    const group = readGroup(THIN_ANSWERS);
    assert.equal(group.pace, "balanced");
    assert.deepEqual(group.travelers.map((t) => t.age), [47, 4]);
    assert.equal(group.anchors[0]!.time, "09:05");
  });

  test("finds a time inside a free-text anchor, the shape the agent path writes", () => {
    const group = readGroup({
      travel_anchors: structured([{ type: "activity", detail: "Tokyo Skytree e-ticket — 20 Sep 2026 at 10:00" }]),
    });
    assert.equal(group.anchors[0]!.time, "10:00");
  });

  test("no intake is not an error — it is a review with no pace judgement", () => {
    const group = readGroup(undefined);
    assert.equal(group.pace, null);
    assert.deepEqual(group.anchors, []);
  });
});

describe("the thin plan — what the pipeline ships today", () => {
  const plan = readPlan(THIN_CONFIG, "Japan");
  const group = readGroup(THIN_ANSWERS);
  const found = auditPlan(plan, group);

  test("proposes the landing, with the flight anchor as its evidence", () => {
    const arrival = titled(found, "no arrival on it");
    assert.ok(arrival, "arrival proposal");
    assert.equal(arrival!.kind, "add_item");
    assert.equal(arrival!.patch?.op, "add_item");
    assert.equal((arrival!.patch as { time: string }).time, "09:05");
    assert.equal(arrival!.evidence[0]!.source, "intake");
    assert.match(arrival!.evidence[0]!.quote, /LY075 TLV-NRT/);
  });

  test("asks rather than guesses when there is no flight anchor", () => {
    const noAnchor = auditPlan(plan, readGroup({ trip_pace: choice("balanced") }));
    const arrival = titled(noAnchor, "no arrival on it");
    assert.ok(arrival);
    assert.equal(arrival!.kind, "question");
    assert.equal(arrival!.patch, undefined);
    // The whole point: it must not put an airport or a time on the plan.
    assert.doesNotMatch(arrival!.ask, /\d\d:\d\d/);
  });

  test("proposes check-in by name and with NO time, and asks for the hour", () => {
    const checkin = titled(found, "No check-in on the first day");
    assert.ok(checkin);
    assert.match(checkin!.title, /OMO3 Asakusa/);
    assert.equal((checkin!.patch as { time: string | null }).time, null);
    assert.match(checkin!.ask, /What time is check-in/);
  });

  test("asks how the group gets from one leg to the next", () => {
    const transfer = titled(found, "how you get from Tokyo to Kyoto");
    assert.ok(transfer);
    assert.equal(transfer!.kind, "question");
    // A booked train is a fact we do not have. It must not be proposed.
    assert.equal(transfer!.patch, undefined);
  });

  test("names the places that are on the list and on no day", () => {
    const unscheduled = found.filter((proposal) => proposal.title.includes("on no day"));
    assert.deepEqual(unscheduled.map((proposal) => proposal.phaseId).sort(), ["tokyo"]);
    assert.match(unscheduled[0]!.title, /Senso-ji/);
  });

  test("puts the day's items into clock order", () => {
    const reorder = kinds(found, "reorder_day");
    assert.equal(reorder.length, 1);
    assert.deepEqual((reorder[0]!.patch as { order: string[] }).order, [
      "tokyo|2026-09-20|1",
      "tokyo|2026-09-20|0",
    ]);
  });

  test("asks about each blank day exactly once, including the boundary day", () => {
    const blanks = found.filter((proposal) => proposal.title.includes("is blank"));
    const dates = blanks.map((proposal) => proposal.date);
    // 09-23 is the last day of Tokyo AND the first of Kyoto. One question.
    assert.equal(new Set(dates).size, dates.length);
    assert.ok(dates.includes("2026-09-23"));
  });

  test("does not propose adding the flight to a day that already has it", () => {
    // What `derive_days_from_anchors` really emits for a dated flight anchor:
    // the anchor's own label, "LY075 TLV-NRT", which says nothing about
    // landing or arriving. An earlier version looked at that day and proposed
    // adding the landing — a duplicate, on the very first line of the trip.
    const withFlight = JSON.parse(JSON.stringify(THIN_CONFIG));
    withFlight.phases[0].days.unshift({
      date: "2026-09-19",
      items: [{ time: "09:05", text: { he: "LY075 TLV-NRT", en: "LY075 TLV-NRT" } }],
    });
    const found = auditPlan(readPlan(withFlight, "Japan"), readGroup(THIN_ANSWERS));
    assert.equal(titled(found, "no arrival on it"), undefined);
  });

  test("reads a Hebrew-only day — half the trips on this platform are", () => {
    // The recognisers have to read both sides or they will report that a
    // Hebrew plan has no arrival and no check-in on it, which is the failure
    // mode that would have shipped to the organizers this platform actually
    // has. The strings are the ones japan-2025 really uses, geresh and all.
    const hebrew = JSON.parse(JSON.stringify(THIN_CONFIG));
    hebrew.phases[0].days.unshift({
      date: "2026-09-19",
      items: [
        { time: "09:05", text: { he: "נחיתה ב-NRT בבוקר", en: "" } },
        { time: "13:00", text: { he: "צ׳ק-אין / השארת מזוודות", en: "" } },
      ],
    });
    const tokyo = auditPlan(readPlan(hebrew, "Japan"), readGroup(THIN_ANSWERS))
      .filter((proposal) => proposal.phaseId === "tokyo");
    assert.equal(titled(tokyo, "no arrival on it"), undefined);
    assert.equal(titled(tokyo, "No check-in"), undefined);
  });

  test("every proposal carries evidence, and nothing carries an invented fact", () => {
    for (const proposal of found) {
      assert.ok(proposal.evidence.length > 0, `${proposal.title} has evidence`);
      for (const entry of proposal.evidence) assert.ok(entry.quote.length > 0);
    }
  });

  test("proposal ids are stable across runs — the queue dedups on them", () => {
    const again = auditPlan(readPlan(THIN_CONFIG, "Japan"), readGroup(THIN_ANSWERS));
    assert.deepEqual(again.map((p) => p.id), found.map((p) => p.id));
    assert.equal(new Set(found.map((p) => p.id)).size, found.length, "no duplicate ids");
  });

  test("an id changes when the finding changes, and not when its wording does", () => {
    const base = { kind: "add_item", phaseId: "tokyo", date: "2026-09-19", subject: "arrival" };
    assert.equal(proposalId(base), proposalId({ ...base }));
    assert.notEqual(proposalId(base), proposalId({ ...base, date: "2026-09-20" }));
  });
});

describe("pace and effort", () => {
  const busy = {
    phases: [
      {
        id: "tokyo",
        title: { he: "טוקיו", en: "Tokyo" },
        dates: { start: "2026-09-19", end: "2026-09-19" },
        venues: [
          { name: { he: "A", en: "Shibuya Sky" }, area: "Shibuya" },
          { name: { he: "B", en: "Senso-ji Temple" }, area: "Asakusa" },
        ],
        days: [
          { date: "2026-09-19", items: [
            { time: "07:00", text: { he: "1", en: "Senso-ji Temple" } },
            { time: "07:20", text: { he: "2", en: "Shibuya Sky" } },
            { time: "12:00", text: { he: "3", en: "Museum" } },
            { time: "15:00", text: { he: "4", en: "Market" } },
            { time: "18:00", text: { he: "5", en: "Park" } },
            { time: "19:30", text: { he: "6", en: "Arcade" } },
            { time: "21:00", text: { he: "7", en: "Show" } },
          ] },
        ],
      },
    ],
  };

  test("says nothing about pace when the group never answered the pace question", () => {
    // A judgement about whether a day is too full, made against a pace nobody
    // stated, is the module inventing a preference and then enforcing it.
    const found = auditPlan(readPlan(busy), readGroup(undefined));
    assert.equal(kinds(found, "pace").length, 0);
  });

  test("flags an overfull day against the pace they did answer", () => {
    const found = auditPlan(readPlan(busy), readGroup({ trip_pace: choice("easygoing") }));
    const overfull = titled(found, "stops on it");
    assert.ok(overfull);
    assert.equal(overfull!.severity, "warning");
    assert.equal(overfull!.patch, undefined, "how to fix an overfull day is the organizer's call");
    assert.ok(overfull!.evidence.some((e) => e.quote.includes("easygoing")));
  });

  test("tightens the budget for a young child, and quotes the reason", () => {
    // The same seven-stop day, the same stated pace. The only difference is a
    // four-year-old on the roster — which is the adjustment, isolated.
    const adults = auditPlan(readPlan(busy), readGroup({
      trip_pace: choice("intense"),
      travelers: structured([{ name_en: "Dror", age: 47 }]),
    }));
    assert.equal(titled(adults, "stops on it"), undefined, "seven stops is what 'intense' asked for");

    const withToddler = auditPlan(readPlan(busy), readGroup({
      trip_pace: choice("intense"),
      travelers: structured([{ name_en: "Dror", age: 47 }, { name_en: "Moshe", age: 4 }]),
    }));
    const overfull = titled(withToddler, "stops on it");
    assert.ok(overfull, "the same day with a 4-year-old on it is not the same day");
    assert.ok(overfull!.evidence.some((e) => e.quote.includes("Moshe (4)")));
  });

  test("an easygoing group is told about a 07:00 start", () => {
    const found = auditPlan(readPlan(busy), readGroup({ trip_pace: choice("easygoing") }));
    assert.ok(titled(found, "starts at 07:00"));
  });

  test("catches a hop that does not fit between two fixed points", () => {
    const found = auditPlan(readPlan(busy), readGroup(undefined));
    const hop = titled(found, "minutes between Asakusa and Shibuya");
    assert.ok(hop, "20 minutes from Asakusa to Shibuya is not a hop that happens");
    assert.equal(hop!.severity, "warning");
  });

  test("does not flag two stops in the same district", () => {
    const sameArea = JSON.parse(JSON.stringify(busy));
    sameArea.phases[0].venues[0].area = "Asakusa";
    const found = auditPlan(readPlan(sameArea), readGroup(undefined));
    assert.equal(found.filter((p) => p.title.includes("minutes between")).length, 0);
  });
});

describe("the reference plan — trips/japan-2025", () => {
  const plan = readPlan(JAPAN_CONFIG, "Japan");
  const found = auditPlan(plan, readGroup(undefined));

  test("does not claim the arrival, the check-in or the order are missing", () => {
    assert.equal(titled(found, "no arrival on it"), undefined);
    assert.equal(titled(found, "No check-in"), undefined);
    assert.equal(kinds(found, "reorder_day").length, 0);
    assert.equal(found.filter((p) => p.title.includes("is blank")).length, 0);
  });

  test("finds the two holes that really are in it", () => {
    const questions = kinds(found, "question");
    assert.deepEqual(
      questions.map((proposal) => proposal.title).sort(),
      [
        "Fushimi Inari is on the list for Kyoto but on no day",
        "Nothing says how you get from Tokyo to Hakone / Fuji",
      ],
    );
  });

  test("does not report a place the days name under a shorter name", () => {
    // "Gion District" is the venue; the days say "Gion in the evening". An
    // earlier version of the matcher reported it as never scheduled.
    assert.equal(titled(found, "Gion District is on the list"), undefined);
  });

  test("offers the venue links the day lines never got", () => {
    const links = kinds(found, "attach_link");
    assert.ok(links.length > 10, `${links.length} link proposals`);
    for (const link of links) {
      const patch = link.patch as { links: { url?: string; maps?: string } };
      const url = patch.links.url ?? patch.links.maps ?? "";
      assert.match(url, /^https?:\/\//);
      // Every link must be one the config already holds — never composed here.
      assert.ok(link.evidence.some((entry) => entry.quote.includes(url)));
    }
  });
});

describe("the model half", () => {
  const plan = readPlan(THIN_CONFIG, "Japan");
  const group = readGroup(THIN_ANSWERS);
  const phase = plan.phases[0]!;
  const document = "Day 2 — Tokyo Skytree at 10:00, then Senso-ji Temple in Asakusa, then teamLab Planets in the evening.";
  const promptArgs = { plan, group, documentText: document, phase };

  test("the prompt carries the day keys the model must reorder by", () => {
    const prompt = buildPlanReviewPrompt(promptArgs);
    assert.ok(prompt.includes("tokyo|2026-09-20|0"));
    assert.ok(prompt.includes("Never output a URL"));
    assert.ok(prompt.includes(document.slice(0, 30)));
  });

  test("accepts an addition that names a place on the trip and quotes the document", () => {
    const payload = parsePlanReviewPayload({
      days: [{
        date: "2026-09-20",
        add: [{
          time: "14:00",
          text: { he: "Senso-ji", en: "Senso-ji Temple, Asakusa" },
          place: "Senso-ji",
          evidence: "then Senso-ji Temple in Asakusa",
        }],
      }],
    });
    const gated = gateModelProposals(payload!, promptArgs);
    assert.equal(gated.rejected.length, 0);
    assert.equal(gated.proposals.length, 1);
    assert.equal(gated.proposals[0]!.origin, "model");
    assert.equal((gated.proposals[0]!.patch as { time: string }).time, "14:00");
    assert.equal(gated.proposals[0]!.evidence[0]!.source, "document");
  });

  test("refuses a museum the trip does not name — the invented-place case", () => {
    const payload = parsePlanReviewPayload({
      days: [{
        date: "2026-09-20",
        add: [{
          time: "14:00",
          text: { he: "מוזיאון אדו", en: "Edo-Tokyo Museum" },
          place: "Edo-Tokyo Museum",
          evidence: "then Senso-ji Temple in Asakusa",
        }],
      }],
    });
    const gated = gateModelProposals(payload!, promptArgs);
    assert.deepEqual(gated.proposals, []);
    assert.equal(gated.rejected[0]!.reason, "UNKNOWN_PLACE");
  });

  test("refuses a ticket link, however plausible", () => {
    const payload = parsePlanReviewPayload({
      days: [{
        date: "2026-09-20",
        add: [{
          time: "10:00",
          text: { he: "כרטיסים", en: "Book at https://www.tokyo-skytree.jp/en/ticket/" },
          place: "Tokyo Skytree",
          evidence: "Day 2 — Tokyo Skytree at 10:00",
        }],
      }],
    });
    const gated = gateModelProposals(payload!, promptArgs);
    assert.deepEqual(gated.proposals, []);
    assert.equal(gated.rejected[0]!.reason, "MODEL_SUPPLIED_URL");
  });

  test("refuses an addition whose evidence is in neither the plan nor the document", () => {
    const payload = parsePlanReviewPayload({
      days: [{
        date: "2026-09-20",
        add: [{
          time: "14:00",
          text: { he: "x", en: "Senso-ji at dawn" },
          place: "Senso-ji",
          evidence: "the itinerary says to visit at dawn",
        }],
      }],
    });
    const gated = gateModelProposals(payload!, promptArgs);
    assert.deepEqual(gated.proposals, []);
    assert.equal(gated.rejected[0]!.reason, "EVIDENCE_NOT_IN_SOURCE");
  });

  test("refuses a reorder that adds or drops a row", () => {
    const payload = parsePlanReviewPayload({
      days: [{ date: "2026-09-20", order: ["tokyo|2026-09-20|0", "tokyo|2026-09-20|9"] }],
    });
    const gated = gateModelProposals(payload!, promptArgs);
    assert.equal(gated.rejected[0]!.reason, "NOT_A_PERMUTATION");
  });

  test("refuses a date that is not a day of the leg", () => {
    const payload = parsePlanReviewPayload({ days: [{ date: "2026-12-25", order: [] }] });
    const gated = gateModelProposals(payload!, promptArgs);
    assert.equal(gated.rejected[0]!.reason, "MALFORMED");
  });

  test("the source text is what the evidence gate checks against", () => {
    const source = reviewSourceText(promptArgs);
    assert.ok(source.includes("OMO3 Asakusa"));
    assert.ok(source.includes("tokyo|2026-09-20|0"));
  });

  test("a malformed answer is not half-read", () => {
    assert.equal(parsePlanReviewPayload(null), null);
    assert.equal(parsePlanReviewPayload({ days: "nope" }), null);
    // A day that cannot be read is dropped; the rest of the answer survives.
    const partial = parsePlanReviewPayload({ days: [{ date: "nope" }, { date: "2026-09-20" }] });
    assert.equal(partial!.days.length, 1);
  });
});

describe("reviewPlan", () => {
  test("with no runner it is a smaller review, and says so", async () => {
    const review = await reviewPlan({ config: THIN_CONFIG, answers: THIN_ANSWERS, destination: "Japan" });
    assert.ok(review.proposals.length > 5);
    assert.equal(review.modelUsed, false);
    assert.equal(review.modelSkipped, "NO_RUNNER");
  });

  test("with a runner, accepted model proposals join the rules' own", async () => {
    const runner = fakeRunner([
      JSON.stringify({
        days: [{
          date: "2026-09-20",
          headline: { he: "יום 2 — טוקיו", en: "Day 2 — Skytree and Asakusa" },
          add: [{ time: "14:00", text: { he: "Senso-ji", en: "Senso-ji Temple" }, place: "Senso-ji", evidence: "Senso-ji" }],
        }],
      }),
      JSON.stringify({ days: [] }),
    ]);
    const review = await reviewPlan({
      config: THIN_CONFIG,
      answers: THIN_ANSWERS,
      destination: "Japan",
      documentText: "Day 2 — Tokyo Skytree, Senso-ji, teamLab Planets.",
      runner,
    });
    assert.equal(review.modelUsed, true);
    assert.equal(review.modelSkipped, null);
    assert.equal(runner.calls[0]!.task, "plan_review");
    assert.ok(review.proposals.some((p) => p.origin === "model" && p.title.includes("Senso-ji Temple")));
  });

  test("a rate-limited runner degrades to the rules, visibly", async () => {
    const runner = fakeRunner([new Error("429 rate limit"), new Error("429 rate limit")]);
    const review = await reviewPlan({ config: THIN_CONFIG, answers: THIN_ANSWERS, runner });
    assert.equal(review.modelUsed, false);
    assert.equal(review.modelSkipped, "RATE_LIMITED");
    assert.ok(review.proposals.length > 0, "the deterministic half still ran");
  });

  test("a runner that throws does not take the review with it", async () => {
    const review = await reviewPlan({
      config: THIN_CONFIG,
      answers: THIN_ANSWERS,
      runner: { run: async () => { throw new Error("boom"); } },
    });
    assert.equal(review.modelUsed, false);
    assert.ok(review.proposals.length > 0);
  });

  test("arithmetic beats the model where they disagree about the same finding", async () => {
    // Both halves can reach "this day is out of order". The rules' version is
    // merged first and the ids match, so the model's is dropped — and the
    // surviving patch is the one that was computed, not the one that was
    // guessed.
    const runner = fakeRunner([
      JSON.stringify({ days: [{ date: "2026-09-20", order: ["tokyo|2026-09-20|0", "tokyo|2026-09-20|1"] }] }),
      JSON.stringify({ days: [] }),
    ]);
    const review = await reviewPlan({ config: THIN_CONFIG, answers: THIN_ANSWERS, runner });
    const reorders = review.proposals.filter((p) => p.kind === "reorder_day");
    assert.equal(reorders.length, 1);
    assert.equal(reorders[0]!.origin, "rules");
    assert.deepEqual((reorders[0]!.patch as { order: string[] }).order, [
      "tokyo|2026-09-20|1",
      "tokyo|2026-09-20|0",
    ]);
  });
});
