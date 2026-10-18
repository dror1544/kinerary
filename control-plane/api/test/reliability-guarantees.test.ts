/**
 * The two reliability guarantees behind MRD metrics 5.3 and 5.4, as scenarios.
 * Map and open gaps: docs/reliability-guarantees.md.
 *
 *   A. State consistency  — an approved correction is what every later step
 *      reads, and an older state cannot overwrite a newer one.
 *   B. Constraint preservation — a change keeps fixed commitments, and a change
 *      that cannot is refused with the conflict named, never quietly adjusted.
 *
 * Pure: no database, no model. A scenario the product does not yet honour is a
 * `todo` that states the guarantee; it is reported, does not fail the suite,
 * and becomes a plain `test` when the gap closes.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AnswerStore } from "../src/interview.js";
import { applyOps, type ApplyOutcome, type Line, type Op } from "../src/typed-changes.js";
import { auditPlan, readGroup, readPlan } from "../src/plan-review.js";

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data }) as const;
const store = (parts: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(parts).map(([id, data]) => [id, structured(data)])) as unknown as AnswerStore;
const stop = (name: string, start: string, end: string) => ({ name, start, end });
const ok = (o: ApplyOutcome) => {
  assert.equal(o.ok, true, JSON.stringify(o));
  return o as Extract<ApplyOutcome, { ok: true }>;
};
const bad = (o: ApplyOutcome) => {
  assert.equal(o.ok, false, "expected the change to be refused");
  return o as Extract<ApplyOutcome, { ok: false }>;
};
const keys = (lines: readonly Line[]) => lines.map((l) => l.key);
const data = (o: Extract<ApplyOutcome, { ok: true }>, q: string) => (o.result[q] as { data: any[] }).data;

const flight = { type: "flight", name: "TLV-NRT", date: "2026-05-19", time: "08:40", confirmation: "FL-1" };
const hotel = { type: "hotel", name: "Gion Inn", date: "2026-05-25", confirmation: "GI-77" };
const held = () =>
  store({
    phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")],
    travel_anchors: [flight, hotel],
  });

describe("A — state consistency (5.3)", () => {
  test("A3: a second correction applies to the first one's result, and both stay", () => {
    const first = ok(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-23" } }]));
    const second = ok(applyOps(first.result as AnswerStore, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20" } }]));
    assert.deepEqual(data(second, "phases")[0], stop("Tokyo", "2026-05-20", "2026-05-23"));
  });

  test("A3: re-applying an older correction does not bring back the value a newer one replaced", () => {
    const older: Op[] = [{ op: "update_stop", target: { name: "Kyoto" }, fields: { end: "2026-05-28" } }];
    const newer: Op[] = [{ op: "update_stop", target: { name: "Kyoto" }, fields: { end: "2026-05-29" } }];
    const afterNewer = ok(applyOps(ok(applyOps(held(), older)).result as AnswerStore, newer));
    assert.equal(data(afterNewer, "phases")[1].end, "2026-05-29");
  });

  test("A3/A4: applying changes never mutates the held answers they were computed from", () => {
    const base = held();
    const snapshot = JSON.stringify(base);
    ok(applyOps(base, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-23" } }]));
    bad(applyOps(base, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-26" } }]));
    assert.equal(JSON.stringify(base), snapshot, "a preview or a refusal must leave the held answers byte-identical");
  });
});

describe("B — constraint preservation (5.4)", () => {
  test("B3: dates that overlap another destination are refused, naming both stops", () => {
    const refused = bad(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-26" } }]));
    assert.deepEqual(keys(refused.blocked), ["blocked.overlap"]);
  });

  test("B4: removing a stop leaves the confirmed booking inside it in place and says so", () => {
    const out = ok(applyOps(held(), [{ op: "remove_stop", target: { name: "Kyoto" } }]));
    assert.equal(out.touched.includes("travel_anchors"), false, "a booking is never removed as a side effect");
    assert.ok(keys(out.preview).includes("warn.bookingInRemovedStop"));
    assert.deepEqual(data(out, "phases").map((s) => s.name), ["Tokyo"]);
  });

  test("B4: moving a dated stop is a question, not a silent re-dating", () => {
    const refused = bad(applyOps(held(), [{ op: "move_stop", target: { name: "Kyoto" }, after: { name: "Tokyo" } }]));
    assert.ok(refused.blocked.length > 0);
  });

  test("B5: a refused change carries a reason for the organizer and no new answers", () => {
    const refused = bad(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-26" } }]));
    assert.ok(refused.blocked.every((l) => typeof l.key === "string" && l.key.startsWith("blocked.")));
    assert.equal("result" in refused, false);
  });

  // The gaps: the guarantee is stated, the product does not yet honour it.
  test("B3: shrinking a stop so that a confirmed flight falls outside every stop is flagged", { todo: "no check yet; only removed stops are compared with bookings" }, () => {
    const out = ok(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-21" } }]));
    assert.ok(keys(out.preview).some((k) => k.startsWith("warn.booking")), "the 19 May flight now sits before the first stop");
  });

  test("B1: an activity that runs into the transfer to a fixed reservation is flagged", { todo: "plan review compares start times only, not durations" }, () => {
    const plan = {
      phases: [{
        id: "tokyo",
        title: { he: "טוקיו", en: "Tokyo" },
        dates: { start: "2026-09-19", end: "2026-09-19" },
        venues: [
          { name: { he: "A", en: "Senso-ji Temple" }, area: "Asakusa" },
          { name: { he: "B", en: "Shibuya Sky" }, area: "Shibuya" },
        ],
        days: [{ date: "2026-09-19", items: [
          { time: "14:00", duration_minutes: 180, text: { he: "1", en: "Senso-ji Temple" } },
          { time: "16:30", fixed: true, text: { he: "2", en: "Shibuya Sky" } },
        ] }],
      }],
    };
    const found = auditPlan(readPlan(plan), readGroup(undefined));
    assert.ok(found.some((p) => p.title.includes("Asakusa") && p.title.includes("Shibuya")), "14:00 + 180 min leaves no time to cross town");
  });
});
