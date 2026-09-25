/**
 * The identity and merge rules, against the cases the design names by hand:
 * two rooms under one reference, two stays at one hotel, a return visit to a
 * city, a PNR with two segments, travellers on one flight with their own booking
 * codes, a corrected confirmation, and a document that simply does not mention
 * something. Pure — no database, no model.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  entryIdentity,
  itineraryCoverageComplete,
  matchEntry,
  mergeParts,
  reconcileStructured,
  stripVisitMarkers,
} from "../src/answer-merge.js";

const tokyoFirst = { name: "Tokyo", start: "2026-09-19", end: "2026-09-23" };
const kyoto = { name: "Kyoto", start: "2026-09-23", end: "2026-09-26" };
const tokyoReturn = { name: "Tokyo", start: "2026-10-01", end: "2026-10-03" };

describe("what a new document may add", () => {
  test("a stop the trip did not have is added, and the list stays in date order", () => {
    const out = reconcileStructured([kyoto], [tokyoFirst]);
    assert.deepEqual(out.merged, [tokyoFirst, kyoto]);
    assert.equal(out.added.length, 1);
    assert.equal(out.changed, true);
    assert.deepEqual(out.conflicts, []);
  });

  test("a missing field is filled, and a field the document does not mention is not deleted", () => {
    const held = [{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19" }];
    const confirmation = [{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19", confirmation: "GR-4471" }];
    const filled = reconcileStructured(held, confirmation);
    assert.deepEqual(filled.merged, confirmation);
    assert.deepEqual(filled.filled, [{ entryKey: entryIdentity(held[0]), path: "confirmation" }]);

    const plan = [{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19" }];
    const kept = reconcileStructured(confirmation, plan);
    assert.deepEqual(kept.merged, confirmation, "a plan without the reference does not erase it");
    assert.equal(kept.changed, false);
  });

  test("a value stated differently is a conflict — the held value stays, and upload order decides nothing", () => {
    const held = [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-23" }];
    const corrected = [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }];
    const out = reconcileStructured(held, corrected);
    assert.deepEqual(out.merged, held);
    assert.equal(out.changed, false);
    assert.equal(out.conflicts.length, 1);
    assert.equal(out.conflicts[0]!.path, "end");
    assert.equal(out.conflicts[0]!.held, "2026-09-23");
    assert.equal(out.conflicts[0]!.incoming, "2026-09-24");
  });

  test("the same content in different spelling is not a conflict", () => {
    const out = reconcileStructured(
      [{ type: "hotel", name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" }],
      [{ type: "Hotel", name: "hotel  gracery shinjuku", confirmation: "gr 4471" }],
    );
    assert.equal(out.changed, false);
    assert.deepEqual(out.conflicts, []);
  });

  test("nothing new is reported as nothing new", () => {
    const out = reconcileStructured([tokyoFirst, kyoto], [kyoto]);
    assert.equal(out.changed, false);
    assert.deepEqual(out.added, []);
  });
});

describe("identity", () => {
  test("two rooms under one reference in one document are two rooms", () => {
    const rooms = [
      { type: "hotel", name: "Kyoto Granbell", date: "2026-09-23", confirmation: "KG-1180", room: "Twin" },
      { type: "hotel", name: "Kyoto Granbell", date: "2026-09-23", confirmation: "KG-1180", room: "Double" },
    ];
    const out = reconcileStructured(undefined, rooms);
    assert.equal((out.merged as unknown[]).length, 2, "an incoming list is never collapsed into itself");
  });

  test("two stays at the same hotel on different dates are two stays", () => {
    const out = reconcileStructured(
      [{ type: "hotel", name: "Hotel Gracery Shinjuku", start: "2026-09-19", end: "2026-09-23" }],
      [{ type: "hotel", name: "Hotel Gracery Shinjuku", start: "2026-10-01", end: "2026-10-03" }],
    );
    assert.equal((out.merged as unknown[]).length, 2);
  });

  test("a return visit to a city stays a separate stop, and an undated mention is not forced onto either", () => {
    const trip = [tokyoFirst, kyoto, tokyoReturn];
    assert.equal((reconcileStructured(trip, [tokyoReturn]).merged as unknown[]).length, 3, "the dated return visit matches itself");

    const undated = reconcileStructured(trip, [{ name: "Tokyo", planned: ["TeamLab Planets"] }]);
    assert.deepEqual(undated.merged, trip, "neither merged into one Tokyo nor added as a fourth stop");
    assert.equal(undated.ambiguous.length, 1);
    assert.equal(undated.ambiguous[0]!.candidates, 2);
  });

  test("one PNR covers two segments, and each is matched to its own", () => {
    const held = [
      { type: "flight", name: "LY81 TLV-NRT", date: "2026-09-18", confirmation: "QX7Z2A" },
      { type: "flight", name: "LY82 NRT-TLV", date: "2026-10-03", confirmation: "QX7Z2A" },
    ];
    const ticket = [{ type: "flight", name: "LY82 NRT-TLV", date: "2026-10-03", confirmation: "QX7Z2A", seat: "32C" }];
    const out = reconcileStructured(held, ticket);
    const merged = out.merged as Record<string, unknown>[];
    assert.equal(merged.length, 2);
    assert.equal(merged.find((f) => f.name === "LY82 NRT-TLV")?.seat, "32C");
    assert.equal(merged.find((f) => f.name === "LY81 TLV-NRT")?.seat, undefined, "the outbound is untouched");
  });

  test("travellers on one flight with their own booking codes are separate bookings", () => {
    const out = reconcileStructured(
      [{ type: "flight", name: "LY81 TLV-NRT", date: "2026-09-18", confirmation: "AAA111" }],
      [{ type: "flight", name: "LY81 TLV-NRT", date: "2026-09-18", confirmation: "BBB222" }],
    );
    assert.equal((out.merged as unknown[]).length, 2);
    assert.deepEqual(out.conflicts, []);
  });

  test("a hotel confirmation matches its stay even when the name is spelled differently", () => {
    const match = matchEntry(
      [{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19", confirmation: "GR-4471" }],
      1,
      { type: "hotel", name: "Gracery Shinjuku", date: "2026-09-19", confirmation: "GR-4471" },
    );
    assert.deepEqual(match, { kind: "match", index: 0 });
  });
});

describe("the day-by-day", () => {
  test("merges by date: a held day keeps its date, and a new date is added", () => {
    const heldDay = { date: "2026-09-19", items: [{ time: null, text: { he: "שלי", en: "Mine, corrected" } }] };
    const held = [{ ...tokyoFirst, days: [heldDay] }];
    const incoming = [{
      ...tokyoFirst,
      days: [
        { date: "2026-09-19", items: [{ time: null, text: { he: "מסמך", en: "From the document" } }] },
        { date: "2026-09-20", items: [{ time: "09:00", text: { he: "סנסו-ג'י", en: "Senso-ji" } }] },
      ],
    }];
    const out = reconcileStructured(held, incoming);
    const days = (out.merged as { days: { date: string; items: unknown[] }[] }[])[0]!.days;
    assert.deepEqual(days.map((d) => d.date), ["2026-09-19", "2026-09-20"]);
    assert.deepEqual(days[0], heldDay, "an organizer's correction is never replaced by a document");
    assert.deepEqual(out.conflicts, [], "a day already held is not a dispute, it is already answered");
  });

  test("coverage is measured in nights, and a sparse stop is not complete", () => {
    const day = (date: string) => ({ date, items: [] });
    assert.equal(itineraryCoverageComplete([{ ...tokyoFirst, days: [day("2026-09-19")] }]), false);
    assert.equal(
      itineraryCoverageComplete([{ ...tokyoFirst, days: ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"].map(day) }]),
      true,
      "the checkout date belongs to the next stop",
    );
    assert.equal(itineraryCoverageComplete([{ name: "Hakone", days: [day("2026-09-24")] }]), true, "undated: any day");
    assert.equal(itineraryCoverageComplete([{ name: "Hakone" }]), false);
  });
});

describe("order independence", () => {
  test("conflict-free documents converge on the same answer whichever arrives first", () => {
    const plan = [tokyoFirst, kyoto];
    const hotels = [
      { name: "Tokyo", start: "2026-09-19", end: "2026-09-23", accommodation: { name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" } },
      { name: "Kyoto", start: "2026-09-23", end: "2026-09-26", accommodation: { name: "Kyoto Granbell", confirmation: "KG-1180" } },
    ];
    const tickets = [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-23", planned: ["TeamLab Planets"] }];

    const orders = [
      [plan, hotels, tickets],
      [tickets, hotels, plan],
      [hotels, plan, tickets],
    ];
    const results = orders.map((docs) => docs.reduce<unknown>((held, doc) => reconcileStructured(held, doc).merged, undefined));
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  });

  test("the within-reply merge uses the same rules", () => {
    const merged = mergeParts([[kyoto], [tokyoFirst], [{ ...kyoto, planned: ["Fushimi Inari"] }]]) as Record<string, unknown>[];
    assert.deepEqual(merged.map((p) => p.name), ["Tokyo", "Kyoto"]);
    assert.deepEqual(merged[1]!.planned, ["Fushimi Inari"]);
  });
});

// #114 problem 5: "another three days at the end for Tokyo", said after Tokyo was
// given with no dates, used to REPLACE Tokyo's first stay — the dated proposal was
// filled onto the only held Tokyo and nothing recorded the first stay as gone.
describe("a return leg to a city already held without dates (#114)", () => {
  const held = [{ name: "Tokyo" }, { name: "Hakone" }, { name: "Kyoto" }, { name: "Osaka" }];
  const returnDates = { start: "2026-09-30", end: "2026-10-03" };

  test("marked as an additional visit, it is a second Tokyo and the first stays undated", () => {
    const out = reconcileStructured(held, [{ name: "Tokyo", ...returnDates, additional_visit: true }], { visits: true });
    const tokyos = (out.merged as { name: string; start?: string }[]).filter((e) => e.name === "Tokyo");
    assert.equal(tokyos.length, 2, "two Tokyo stops");
    assert.equal(tokyos.filter((e) => e.start === undefined).length, 1, "the first is still undated");
    assert.equal(tokyos.filter((e) => e.start === "2026-09-30").length, 1);
    assert.equal(out.added.length, 1);
    assert.deepEqual(out.filled, []);
    assert.deepEqual(out.ambiguous, []);
  });

  test("the marker is removed by stripVisitMarkers", () => {
    const out = reconcileStructured(held, [{ name: "Tokyo", ...returnDates, additional_visit: true }], { visits: true });
    assert.doesNotMatch(JSON.stringify(stripVisitMarkers(out.merged)), /additional_visit/);
  });

  test("the same marked visit said twice is one visit, not two", () => {
    const once = reconcileStructured(held, [{ name: "Tokyo", ...returnDates, additional_visit: true }], { visits: true });
    const again = reconcileStructured(once.merged, [{ name: "Tokyo", ...returnDates, additional_visit: true }], { visits: true });
    assert.equal((again.merged as { name: string }[]).filter((e) => e.name === "Tokyo").length, 2);
  });

  test("a marked visit never lands on a held stop that already has different dates", () => {
    const out = reconcileStructured(
      [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }],
      [{ name: "Tokyo", ...returnDates, additional_visit: true }],
      { visits: true },
    );
    assert.equal((out.merged as unknown[]).length, 2);
  });

  test("without the marker the dates are filled onto the one Tokyo, exactly as before", () => {
    const out = reconcileStructured(held, [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }]);
    const tokyos = (out.merged as { name: string; start?: string }[]).filter((e) => e.name === "Tokyo");
    assert.equal(tokyos.length, 1);
    assert.equal(tokyos[0]!.start, "2026-09-19");
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.filled.map((f) => f.path), ["start", "end"]);
  });

  test("a dated first Tokyo plus a dated return is two stops (unchanged)", () => {
    const out = reconcileStructured(
      [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }, { name: "Kyoto", start: "2026-09-24", end: "2026-09-27" }],
      [{ name: "Tokyo", ...returnDates }],
    );
    assert.equal((out.merged as { name: string }[]).filter((e) => e.name === "Tokyo").length, 2);
  });

  test("with the flag off (any list but stops) the marker is ignored — matched as if absent — and still strippable", () => {
    const people = [{ name: "Avi Cohen" }];
    const out = reconcileStructured(people, [{ name: "Avi Cohen", age: 41, additional_visit: true }], { people: true });
    assert.equal((out.merged as unknown[]).length, 1, "one Avi, not two");
    assert.doesNotMatch(JSON.stringify(out.merged), /additional_visit/, "and the marker is not filled onto the held entry");
    const stops = reconcileStructured(held, [{ name: "Tokyo", ...returnDates, additional_visit: true }]);
    assert.equal((stops.merged as { name: string }[]).filter((e) => e.name === "Tokyo").length, 1, "no flag, no second visit");
  });
});
