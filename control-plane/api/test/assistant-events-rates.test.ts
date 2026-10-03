/**
 * `deriveRates` (analytics/rates.ts) — issue #326, Track 2's second slice.
 *
 * No database here: `deriveRates` takes a `DayRollup` and returns numbers, so
 * this is pure unit testing. The two non-empty fixtures below are NOT
 * invented — they are the exact `DayRollup` objects
 * `test/assistant-events-replay.test.ts`'s "the table alone reproduces the
 * hand evaluation's counts" test asserts field-by-field (Monday's four failed
 * DM uploads, Wednesday's family group), captured by running that same
 * replay against `cptest_t2rates` and reading its `console.log('# rollup …')`
 * line. Reusing the fixture without re-running the relay/gateway simulation a
 * second time was a deliberate call — see the handover's Decisions made.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveRates, emptyDayRollup, rate, NOT_MEASURABLE_REASON, RELAY_RESTART_CAVEAT } from "../src/analytics/rates.js";
import type { DayRollup } from "../src/analytics/store.js";

const TRIP_ID = "trip_86f5c7bd4f343b755a9822e84288fd26";

/** Monday: the organizer's DM, four document uploads, every read `failed_tool`. */
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
};

/** Wednesday: the family group — 5 chatter + 1 unaddressed PDF, 5 forwarded requests (one lost), one PDF forwarded and replied to. */
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
};

describe("deriveRates — the DM day (organizer_dm only, nothing forwarded to the companion)", () => {
  test("response/unanswered/lost-turn rates are null — nothing was forwarded that day", () => {
    const rates = deriveRates(DM_DAY);
    assert.deepEqual(rates.response_rate, { value: null, numerator: 0, denominator: 0 });
    assert.deepEqual(rates.unanswered_rate, { value: null, numerator: 0, denominator: 0 });
    // lost_turn_rate's denominator is requests_forwarded + requests_to_relay + lost = 0+4+0 = 4.
    assert.deepEqual(rates.lost_turn_rate, { value: 0, numerator: 0, denominator: 4 });
  });

  test("reply latency is null — no replied turn that day", () => {
    const rates = deriveRates(DM_DAY);
    assert.deepEqual(rates.reply_latency_p50_ms, { value: null, numerator: 0, denominator: 0 });
    assert.deepEqual(rates.reply_latency_p95_ms, { value: null, numerator: 0, denominator: 0 });
  });

  test("group_addressed_share is null — this day has no group traffic", () => {
    assert.deepEqual(deriveRates(DM_DAY).group_addressed_share, { value: null, numerator: 0, denominator: 0 });
  });

  test("document_forwarded_and_replied_rate is null — no document was forwarded (these were relay reads, not companion hand-offs)", () => {
    assert.deepEqual(deriveRates(DM_DAY).document_forwarded_and_replied_rate, { value: null, numerator: 0, denominator: 0 });
  });

  test("relay_read_outcomes: all four reads failed_tool", () => {
    const outcomes = deriveRates(DM_DAY).relay_read_outcomes;
    assert.equal(outcomes.total, 4);
    assert.deepEqual(outcomes.by_outcome, { failed_tool: { value: 1, numerator: 4, denominator: 4 } });
  });

  test("by_channel_role: the organizer_dm/organizer cell is fully addressed, nothing lost", () => {
    const [cell] = deriveRates(DM_DAY).by_channel_role;
    assert.equal(cell!.channel_type, "organizer_dm");
    assert.equal(cell!.requester_role, "organizer");
    assert.deepEqual(cell!.lost_turn_rate, { value: 0, numerator: 0, denominator: 4 });
    assert.deepEqual(cell!.addressed_share, { value: 1, numerator: 4, denominator: 4 });
  });
});

describe("deriveRates — the group day, hand-computed against the replay's own asserted counts", () => {
  const rates = deriveRates(GROUP_DAY);

  test("response_rate = 4 replied / 5 forwarded = 0.8", () => {
    assert.deepEqual(rates.response_rate, rate(4, 5));
    assert.equal(rates.response_rate.value, 0.8);
  });

  test("unanswered_rate = 1 / 5 = 0.2", () => {
    assert.deepEqual(rates.unanswered_rate, rate(1, 5));
  });

  test("lost_turn_rate = 1 lost / (5 forwarded + 0 to_relay + 1 lost) = 1/6", () => {
    assert.deepEqual(rates.lost_turn_rate, rate(1, 6));
  });

  test("reply latency p50/p95, nearest-rank over [8000,12000,30000,45000]", () => {
    // n=4: p50 index = ceil(0.5*4)-1 = 1 -> 12000; p95 index = ceil(0.95*4)-1 = 3 -> 45000.
    assert.deepEqual(rates.reply_latency_p50_ms, { value: 12_000, numerator: 12_000, denominator: 4 });
    assert.deepEqual(rates.reply_latency_p95_ms, { value: 45_000, numerator: 45_000, denominator: 4 });
  });

  test("group_addressed_share = 6 addressed / 12 total = 0.5", () => {
    assert.deepEqual(rates.group_addressed_share, rate(6, 12));
  });

  test("document_forwarded_and_replied_rate = 1/1", () => {
    assert.deepEqual(rates.document_forwarded_and_replied_rate, rate(1, 1));
  });

  test("relay_read_outcomes: no relay reads this day", () => {
    assert.equal(rates.relay_read_outcomes.total, 0);
    assert.deepEqual(rates.relay_read_outcomes.by_outcome, {});
  });

  test("by_channel_role: organizer cell (3 not-addressed, 3 forwarded, 1 lost) and unknown cell (3 not-addressed, 2 forwarded)", () => {
    const organizer = rates.by_channel_role.find((c) => c.requester_role === "organizer")!;
    const unknown = rates.by_channel_role.find((c) => c.requester_role === "unknown")!;
    // organizer: addressed = 3 forwarded + 0 to_relay + 1 lost = 4; total = 4 + 3 not_addressed = 7.
    assert.deepEqual(organizer.lost_turn_rate, rate(1, 4));
    assert.deepEqual(organizer.addressed_share, rate(4, 7));
    // unknown: addressed = 2 + 0 + 0 = 2; total = 2 + 3 = 5.
    assert.deepEqual(unknown.lost_turn_rate, rate(0, 2));
    assert.deepEqual(unknown.addressed_share, rate(2, 5));
  });

  test("known_limits carries the relay-restart caveat (store.ts's KNOWN LIMIT) — the rollup never says whether a restart happened, so it is always attached", () => {
    assert.ok(rates.known_limits.includes(RELAY_RESTART_CAVEAT));
  });
});

describe("the four rates the relay's facts cannot support", () => {
  test("grounded-answer, missing-data, traveller self-service and post-write trust are not_measurable, with a reason — never 0, never a number", () => {
    for (const rollup of [DM_DAY, GROUP_DAY, emptyDayRollup(TRIP_ID, "2026-01-01")]) {
      const rates = deriveRates(rollup);
      for (const key of [
        "grounded_answer_rate",
        "missing_data_rate",
        "traveller_self_service_rate",
        "post_write_trust_rate",
      ] as const) {
        const nm = rates.not_measurable[key];
        assert.equal(nm.not_measurable, true, `${key} on ${rollup.local_day}`);
        assert.equal(nm.reason, NOT_MEASURABLE_REASON);
        assert.ok(nm.reason.length > 0);
      }
    }
  });
});

describe("an empty trip — no divide-by-zero, no fabricated rate", () => {
  const rates = deriveRates(emptyDayRollup(TRIP_ID, "2026-01-01"));

  test("every rate is null-valued, never 0 or NaN, with a zero denominator", () => {
    for (const r of [
      rates.response_rate,
      rates.unanswered_rate,
      rates.lost_turn_rate,
      rates.reply_latency_p50_ms,
      rates.reply_latency_p95_ms,
      rates.group_addressed_share,
      rates.document_forwarded_and_replied_rate,
    ]) {
      assert.equal(r.value, null);
      assert.equal(r.denominator, 0);
      assert.ok(!Number.isNaN(r.numerator));
    }
  });

  test("no channel/role cells and no relay-read outcomes", () => {
    assert.deepEqual(rates.by_channel_role, []);
    assert.equal(rates.relay_read_outcomes.total, 0);
    assert.deepEqual(rates.relay_read_outcomes.by_outcome, {});
  });

  test("the trip/day identity still carries through", () => {
    assert.equal(rates.trip_id, TRIP_ID);
    assert.equal(rates.local_day, "2026-01-01");
  });
});

describe("rate()", () => {
  test("zero denominator is null, never NaN or 0", () => {
    assert.deepEqual(rate(0, 0), { value: null, numerator: 0, denominator: 0 });
    assert.deepEqual(rate(3, 0), { value: null, numerator: 3, denominator: 0 });
  });

  test("a real division", () => {
    assert.deepEqual(rate(1, 4), { value: 0.25, numerator: 1, denominator: 4 });
  });
});
