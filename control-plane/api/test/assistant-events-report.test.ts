/**
 * `renderDailyReport` (analytics/report.ts) — issue #326, Track 2's second
 * slice.
 *
 * Pure unit tests, over the same two `DayRollup` fixtures
 * `assistant-events-rates.test.ts` uses (the replay's known Monday-DM and
 * Wednesday-group days — see that file's header for provenance), plus the
 * empty-trip case. No database.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderDailyReport, type DailyReport } from "../src/analytics/report.js";
import { emptyDayRollup } from "../src/analytics/rates.js";
import type { DayRollup } from "../src/analytics/store.js";

const TRIP_ID = "trip_86f5c7bd4f343b755a9822e84288fd26";
const OTHER_TRIP_ID = "trip_00000000000000000000000000000other";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const DM_DAY: DayRollup = {
  trip_id: TRIP_ID,
  local_day: "2026-09-16",
  group: { addressed: 0, not_addressed: 0 },
  by_channel_role: [
    { channel_type: "organizer_dm", requester_role: "organizer", not_addressed: 0, forwarded: 0, to_relay: 4, lost: 0 },
  ],
  requests_forwarded: 0,
  requests_to_relay: 4,
  turns: { reply_delivered_substantive_outcome_unknown: 0, unanswered: 0, lost: 0 },
  reply_latency_ms: [],
  replies: { delivered: 0, failed: 0, suppressed: 0, unattributed_delivered: 0 },
  documents: {
    held: 0, joined: 0, forwarded: 0,
    forwarded_reply_delivered_substantive_outcome_unknown: 0, forwarded_unanswered: 0,
    relay_read: { failed_tool: 4 },
  },
  assistant_tool_outcomes: { grounded_answer: 0, failed_tool: 0, missing_data: 0, missing_data_by_tool: {} },
};

const GROUP_DAY: DayRollup = {
  trip_id: TRIP_ID,
  local_day: "2026-09-18",
  group: { addressed: 6, not_addressed: 6 },
  by_channel_role: [
    { channel_type: "group", requester_role: "organizer", not_addressed: 3, forwarded: 3, to_relay: 0, lost: 1 },
    { channel_type: "group", requester_role: "unknown", not_addressed: 3, forwarded: 2, to_relay: 0, lost: 0 },
  ],
  requests_forwarded: 5,
  requests_to_relay: 0,
  turns: { reply_delivered_substantive_outcome_unknown: 4, unanswered: 1, lost: 1 },
  reply_latency_ms: [45_000, 12_000, 30_000, 8_000],
  replies: { delivered: 5, failed: 0, suppressed: 0, unattributed_delivered: 0 },
  documents: {
    held: 1, joined: 1, forwarded: 1,
    forwarded_reply_delivered_substantive_outcome_unknown: 1, forwarded_unanswered: 0,
    relay_read: {},
  },
  assistant_tool_outcomes: { grounded_answer: 0, failed_tool: 0, missing_data: 0, missing_data_by_tool: {} },
};

const ALL_SECTION_TITLES = ["Usage", "Value Delivered", "Information Quality", "Learning and Enrichment", "Organizer Enablement"];

function sectionsByTitle(report: DailyReport): Map<string, DailyReport["sections"][number]> {
  return new Map(report.sections.map((s) => [s.title, s]));
}

describe("renderDailyReport — the five sections always render", () => {
  test("group day: exactly the five suggested sections, in order", () => {
    const { json } = renderDailyReport(GROUP_DAY);
    assert.deepEqual(json.sections.map((s) => s.title), ALL_SECTION_TITLES);
  });

  test("empty trip: still the five sections, every line 'no data recorded' or a zero count", () => {
    const { json } = renderDailyReport(emptyDayRollup(TRIP_ID, "2026-01-01"));
    assert.deepEqual(json.sections.map((s) => s.title), ALL_SECTION_TITLES);
    const sections = sectionsByTitle(json);
    // Value Delivered, Learning and Enrichment, Organizer Enablement have no
    // relay-observable source at all, trip empty or not.
    for (const title of ["Value Delivered", "Learning and Enrichment", "Organizer Enablement"]) {
      for (const item of sections.get(title)!.lines) {
        assert.equal(item.no_data, true, `${title}: ${item.label}`);
        assert.equal(item.value, "no data recorded");
      }
    }
    // Usage: "Inbound messages" is a real, honest zero (not "no data") — the
    // rollup DOES observe that nothing happened; "Unique travelers" has no
    // source at all regardless of traffic.
    const usage = sections.get("Usage")!.lines;
    const inbound = usage.find((l) => l.label === "Inbound messages to the bot")!;
    assert.equal(inbound.value, "0");
    const uniqueTravelers = usage.find((l) => l.label === "Unique travelers who used it")!;
    assert.equal(uniqueTravelers.no_data, true);
    // Every rate-based Usage line is "no data recorded" with nothing to divide.
    for (const label of ["Response rate", "Reply latency p50", "Reply latency p95", "Unanswered rate"]) {
      const item = usage.find((l) => l.label === label)!;
      assert.equal(item.value, "no data recorded", label);
    }
  });

  test("empty trip: Markdown and JSON agree — same section titles, same line count", () => {
    const { json, markdown } = renderDailyReport(emptyDayRollup(TRIP_ID, "2026-01-01"));
    for (const section of json.sections) {
      assert.ok(markdown.includes(`## ${section.title}`), section.title);
      for (const item of section.lines) assert.ok(markdown.includes(item.value), `${section.title}: ${item.label} -> ${item.value}`);
    }
  });
});

describe("renderDailyReport — Usage, against the group day's known counts", () => {
  const { json, markdown } = renderDailyReport(GROUP_DAY);
  const usage = json.sections.find((s) => s.title === "Usage")!;

  test("inbound messages = 7 (organizer cell) + 5 (unknown cell) = 12", () => {
    const item = usage.lines.find((l) => l.label === "Inbound messages to the bot")!;
    assert.equal(item.value, "12");
    assert.equal(item.no_data, false);
  });

  test("group vs private usage names only the group channel this day", () => {
    const item = usage.lines.find((l) => l.label === "Group vs. private usage")!;
    assert.equal(item.value, "group: 12");
  });

  test("response rate renders as a percentage with numerator/denominator", () => {
    const item = usage.lines.find((l) => l.label === "Response rate")!;
    assert.equal(item.value, "80.0% (4/5)");
  });

  test("reply latency p50/p95 render in ms with sample size", () => {
    assert.equal(usage.lines.find((l) => l.label === "Reply latency p50")!.value, "12000 ms (n=4)");
    assert.equal(usage.lines.find((l) => l.label === "Reply latency p95")!.value, "45000 ms (n=4)");
  });

  test("Markdown carries the same Usage numbers as the JSON", () => {
    for (const item of usage.lines) assert.ok(markdown.includes(item.value), item.label);
  });
});

describe("renderDailyReport — Information Quality reflects the relay's own document reads", () => {
  test("DM day: 4 relay reads, all failed_tool", () => {
    const { json } = renderDailyReport(DM_DAY);
    const iq = json.sections.find((s) => s.title === "Information Quality")!;
    const item = iq.lines.find((l) => l.label === "Documents uploaded and parsed")!;
    assert.equal(item.no_data, false);
    assert.match(item.value, /failed_tool 100\.0% \(4\/4\)/);
  });

  test("group day: one document forwarded and replied to, but no relay reads (the companion handled it, not the relay)", () => {
    const { json } = renderDailyReport(GROUP_DAY);
    const iq = json.sections.find((s) => s.title === "Information Quality")!;
    const item = iq.lines.find((l) => l.label === "Documents uploaded and parsed")!;
    assert.equal(item.no_data, true, "no relay-side read happened this day");
  });

  test("every other Information Quality line is no data recorded", () => {
    const { json } = renderDailyReport(GROUP_DAY);
    const iq = json.sections.find((s) => s.title === "Information Quality")!;
    for (const label of ["New website records added", "Missing fields that blocked better answers", "Stale or inconsistent website areas", "Private data risks detected"]) {
      const item = iq.lines.find((l) => l.label === label)!;
      assert.equal(item.no_data, true, label);
    }
  });
});

// ── The missing-information control loop (decision 22): "detect a missing
// fact, record it, show the top missing items" — the one new signal this
// slice adds, from the Hermes plugin's tool_call_completed events. ────────

const DAY_WITH_TOOL_CALLS: DayRollup = {
  ...GROUP_DAY,
  assistant_tool_outcomes: {
    grounded_answer: 6, failed_tool: 1, missing_data: 3,
    missing_data_by_tool: { get_booking_confirmation: 2, get_budget: 1 },
  },
};

describe("renderDailyReport — Value Delivered's grounded-answer line, now real", () => {
  test("renders a percentage once the Hermes plugin has reported tool calls that day", () => {
    const { json } = renderDailyReport(DAY_WITH_TOOL_CALLS);
    const vd = json.sections.find((s) => s.title === "Value Delivered")!;
    const item = vd.lines.find((l) => l.label === "Questions answered from verified website data")!;
    assert.equal(item.no_data, false);
    assert.equal(item.value, "60.0% (6/10)");
  });

  test("still no data recorded when nothing reported that day — GROUP_DAY has zero tool calls", () => {
    const { json } = renderDailyReport(GROUP_DAY);
    const vd = json.sections.find((s) => s.title === "Value Delivered")!;
    const item = vd.lines.find((l) => l.label === "Questions answered from verified website data")!;
    assert.equal(item.no_data, true);
  });
});

describe("renderDailyReport — Organizer Enablement's top-missing-items line, now real", () => {
  test("ranks missing_data_by_tool descending, capped at 3", () => {
    const { json } = renderDailyReport(DAY_WITH_TOOL_CALLS);
    const oe = json.sections.find((s) => s.title === "Organizer Enablement")!;
    const item = oe.lines.find((l) => l.label === "Top 3 missing items to request from the organizer")!;
    assert.equal(item.no_data, false);
    assert.equal(item.value, "get_booking_confirmation: 2, get_budget: 1");
  });

  test("the other two Organizer Enablement lines stay no data recorded — next sprint's work", () => {
    const { json } = renderDailyReport(DAY_WITH_TOOL_CALLS);
    const oe = json.sections.find((s) => s.title === "Organizer Enablement")!;
    for (const label of ["The traveler value unlocked by each item", "Suggested message to ask for those items"]) {
      const item = oe.lines.find((l) => l.label === label)!;
      assert.equal(item.no_data, true, label);
    }
  });

  test("no data recorded when no missing-data fact was reported that day", () => {
    const { json } = renderDailyReport(GROUP_DAY);
    const oe = json.sections.find((s) => s.title === "Organizer Enablement")!;
    const item = oe.lines.find((l) => l.label === "Top 3 missing items to request from the organizer")!;
    assert.equal(item.no_data, true);
  });
});

describe("renderDailyReport — the KNOWN LIMIT caveat is carried into the report text, never hidden", () => {
  test("the relay-restart caveat is in notes, and in the rendered Markdown", () => {
    const { json, markdown } = renderDailyReport(GROUP_DAY);
    assert.ok(json.notes.some((n) => /relay restart/.test(n)));
    assert.ok(markdown.includes("relay restart"));
  });

  test("the two remaining not-measurable rates are named in notes, with their reason", () => {
    const { json, markdown } = renderDailyReport(GROUP_DAY);
    assert.ok(json.notes.some((n) => n.includes("traveller self-service rate") && n.includes("post-write trust rate")));
    assert.ok(markdown.includes("traveller self-service rate"));
  });
});

describe("no identifier rides in the report — grep-proof", () => {
  test("the only trip_id anywhere in the rendered Markdown is the one requested", () => {
    const { markdown } = renderDailyReport(GROUP_DAY);
    const tripIdOccurrences = markdown.match(/trip_[A-Za-z0-9]+/g) ?? [];
    assert.ok(tripIdOccurrences.length > 0, "the requested trip_id does appear (the header)");
    for (const occurrence of tripIdOccurrences) assert.equal(occurrence, TRIP_ID);
    assert.ok(!markdown.includes(OTHER_TRIP_ID));
  });

  test("no uuid anywhere in the rendered Markdown", () => {
    const { markdown } = renderDailyReport(GROUP_DAY);
    assert.equal(UUID_RE.test(markdown), false, markdown);
  });

  test("no chat id or user id shape (a Telegram id) anywhere in the rendered Markdown", () => {
    const { markdown } = renderDailyReport(GROUP_DAY);
    // Telegram user/chat ids in this codebase's own fixtures are long digit
    // runs (7123456789, -1009876543210); nothing in the report should ever
    // contain a bare 9+ digit run.
    assert.equal(/-?\d{9,}/.test(markdown), false, markdown);
  });

  test("same check holds for the JSON rendering, serialized", () => {
    const { json } = renderDailyReport(GROUP_DAY);
    const serialized = JSON.stringify(json);
    // "trip_id" the FIELD NAME is not the leak this guards against — only a
    // trip_<id> VALUE matters, and the field name itself matches the same
    // pattern used to scan for one.
    const tripIdOccurrences = (serialized.match(/trip_[A-Za-z0-9]+/g) ?? []).filter((v) => v !== "trip_id");
    for (const occurrence of tripIdOccurrences) assert.equal(occurrence, TRIP_ID);
    assert.equal(UUID_RE.test(serialized), false, serialized);
    assert.equal(/-?\d{9,}/.test(serialized), false, serialized);
  });
});
