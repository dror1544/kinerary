/**
 * The pure core of a typed change (#206, slice 1): the operations, how a
 * reference resolves against what is held, how a change is validated against
 * the whole trip, and what the preview says. No database, no model.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { identityFold, reconcileStructured, samePerson } from "../src/answer-merge.js";
import type { AnswerStore } from "../src/interview.js";
import {
  applyOps,
  applyPick,
  heldRefLists,
  mergeOps,
  openQuestion,
  parseOps,
  resolveRef,
  wordsOf,
  type ApplyOutcome,
  type Line,
  type Op,
} from "../src/typed-changes.js";

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data }) as const;
const text = (t: string) => ({ kind: "text", schema_version: 3, text: t }) as const;

function store(parts: Record<string, unknown[] | Record<string, unknown>>, extra: Record<string, unknown> = {}): AnswerStore {
  const out: Record<string, unknown> = { ...extra };
  for (const [id, data] of Object.entries(parts)) out[id] = structured(data);
  return out as AnswerStore;
}

const stop = (name: string, start?: string, end?: string, more: Record<string, unknown> = {}) =>
  ({ name, ...(start ? { start } : {}), ...(end ? { end } : {}), ...more });

const ok = (o: ApplyOutcome) => {
  assert.equal(o.ok, true, JSON.stringify(o));
  return o as Extract<ApplyOutcome, { ok: true }>;
};
const bad = (o: ApplyOutcome) => {
  assert.equal(o.ok, false, "expected the change to be refused");
  return o as Extract<ApplyOutcome, { ok: false }>;
};
const keys = (lines: readonly Line[]) => lines.map((l) => l.key);
const dataOf = (o: Extract<ApplyOutcome, { ok: true }>, q: string) => (o.result[q] as { data: any[] }).data;

describe("parseOps — a closed vocabulary, refused whole", () => {
  test("every operation parses", () => {
    const r = parseOps([
      { op: "add_stop", fields: { name: "Nara", start: "2026-05-27" }, after: { name: "Kyoto" } },
      { op: "remove_stop", target: { name: "Kyoto" } },
      { op: "rename_stop", target: { name: "Hakone" }, name: "Nagoya" },
      { op: "replace_stop", target: { name: "Hakone" }, fields: { name: "Nagoya" } },
      { op: "move_stop", target: { name: "Kyoto" }, after: { name: "Osaka" } },
      { op: "update_stop", target: { id: "s1", name: "Tokyo" }, fields: { start: "2026-05-20", end: "2026-05-25" } },
      { op: "add_traveller", fields: { name: "Ella Cohen", age: 9 } },
      { op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } },
      { op: "remove_traveller", target: { name: "Avi" } },
    ]);
    assert.equal(r.ok, true);
  });

  test("an unknown operation refuses the whole payload", () => {
    const r = parseOps([{ op: "remove_stop", target: { name: "Kyoto" } }, { op: "delete_everything" }]);
    assert.equal(r.ok, false);
  });

  test("unknown keys, unknown fields, bad values and empty changes are refused", () => {
    for (const raw of [
      [{ op: "remove_stop", target: { name: "Kyoto" }, force: true }],
      [{ op: "update_stop", target: { name: "Tokyo" }, fields: { name: "Osaka" } }],
      [{ op: "update_stop", target: { name: "Tokyo" }, fields: { additional_visit: true } }],
      [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: -1 } }],
      [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71.5 } }],
      [{ op: "update_traveller", target: { name: "Ruth" }, fields: {} }],
      [{ op: "add_stop", fields: { start: "2026-05-01" } }],
      [{ op: "move_stop", target: { name: "Kyoto" } }],
      [{ op: "move_stop", target: { name: "Kyoto" }, after: { name: "A" }, before: { name: "B" } }],
      [{ op: "remove_stop", target: { id: "x9" } }],
      [{ op: "remove_stop", target: {} }],
      [],
      "remove Kyoto",
    ]) assert.equal(parseOps(raw).ok, false, JSON.stringify(raw));
  });
});

describe("resolveRef — whole words, never similarity", () => {
  const roster = [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen" }];

  test("'Ruth' with ONE Ruth is that Ruth, though samePerson refuses one-word names", () => {
    assert.equal(samePerson("Ruth", "Ruth Cohen"), false);
    assert.deepEqual(resolveRef(roster, { name: "Ruth" }, "traveller"), { kind: "resolved", index: 0 });
  });

  test("'Ruth' with TWO Ruths is a question, and names both", () => {
    const two = [{ name: "Ruth Cohen" }, { name: "Ruth Levi" }, { name: "Avi Cohen" }];
    assert.deepEqual(resolveRef(two, { name: "Ruth" }, "traveller"), { kind: "unresolved", candidates: [0, 1] });
    assert.deepEqual(resolveRef(two, { name: "Ruth Levi" }, "traveller"), { kind: "resolved", index: 1 });
  });

  test("an exact name beats a longer one that contains it", () => {
    const list = [{ name: "Ruth Cohen" }, { name: "Ruth Cohen Levi" }];
    assert.deepEqual(resolveRef(list, { name: "Ruth Cohen" }, "traveller"), { kind: "resolved", index: 0 });
    assert.deepEqual(resolveRef(list, { name: "Ruth Cohen Levi" }, "traveller"), { kind: "resolved", index: 1 });
  });

  test("no clip tolerance: Ella is not Bella, Anna is not Hanna, Vital is not Avital", () => {
    for (const [typed, held] of [["Ella Cohen", "Bella Cohen"], ["Anna Levi", "Hanna Levi"], ["Vital Katz", "Avital Katz"]] as const) {
      assert.equal(samePerson(typed, held), true, `${typed}: a PDF clip still matches`);
      assert.equal(samePerson(typed, held, false), false, `${typed}: typed input does not`);
      assert.deepEqual(resolveRef([{ name: held }], { name: typed }, "traveller"), { kind: "unresolved", candidates: [] });
    }
  });

  test("a stop is found by its Hebrew name or its English one", () => {
    const stops = [{ name: "טוקיו", name_en: "Tokyo" }, { name: "קיוטו", name_en: "Kyoto" }];
    assert.deepEqual(resolveRef(stops, { name: "טוקיו" }, "stop"), { kind: "resolved", index: 0 });
    assert.deepEqual(resolveRef(stops, { name: "Kyoto" }, "stop"), { kind: "resolved", index: 1 });
  });

  test("Hebrew geresh and gershayim fold to the apostrophe and quote people type", () => {
    assert.equal(identityFold("ג׳ורג׳"), identityFold("ג'ורג'"));
    assert.equal(identityFold("צה״ל"), identityFold('צה"ל'));
    assert.deepEqual(resolveRef([{ name: "ג׳ורג׳ כהן" }], { name: "ג'ורג'" }, "traveller"), { kind: "resolved", index: 0 });
    assert.deepEqual(wordsOf("Ruth-Ann O'Neil"), ["ruth", "ann", "o'neil"]);
  });

  test("an id is a hint: it counts only when the name agrees", () => {
    assert.deepEqual(resolveRef(roster, { id: "t1", name: "Ruth" }, "traveller"), { kind: "resolved", index: 0 });
    assert.deepEqual(resolveRef(roster, { id: "t2", name: "Ruth" }, "traveller"), { kind: "unresolved", candidates: [0, 1] });
    assert.deepEqual(resolveRef(roster, { id: "t2" }, "traveller"), { kind: "unresolved", candidates: [1] });
    assert.deepEqual(resolveRef(roster, { id: "s1", name: "Ruth" }, "traveller"), { kind: "resolved", index: 0 }, "a stop id on a traveller is no hint at all");
  });
});

describe("applyOps — the contract's dates", () => {
  const held = () => store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")] });

  test("Tokyo 19-24 beside Kyoto 24-27 share a boundary day and are fine; a change inside that is valid", () => {
    const out = ok(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20" } }]));
    assert.deepEqual(dataOf(out, "phases"), [stop("Tokyo", "2026-05-20", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")]);
    assert.deepEqual(out.touched, ["phases"]);
  });

  test("Tokyo 20-25 against Kyoto 24-27 is a conflict naming BOTH stops, with no suggested fix", () => {
    const refused = bad(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20", end: "2026-05-25" } }]));
    assert.deepEqual(keys(refused.blocked), ["blocked.overlap"]);
    const stops = refused.blocked[0]!.params.stops as { name: string }[];
    assert.deepEqual(stops.map((s) => s.name), ["Tokyo", "Kyoto"]);
    assert.equal(JSON.stringify(refused).includes("shift"), false);
  });

  test("the restated dates for BOTH stops are valid, and Tokyo's half was not lost", () => {
    const ops: Op[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20", end: "2026-05-25" } }];
    const partial = mergeOps(ops, [{ op: "update_stop", target: { name: "Kyoto" }, fields: { start: "2026-05-25", end: "2026-05-28" } }], held());
    const out = ok(applyOps(held(), partial));
    assert.deepEqual(dataOf(out, "phases"), [stop("Tokyo", "2026-05-20", "2026-05-25"), stop("Kyoto", "2026-05-25", "2026-05-28")]);
  });

  test("a zero-night stop never conflicts, and an end before its start is refused", () => {
    ok(applyOps(held(), [{ op: "add_stop", fields: { name: "Nikko", start: "2026-05-21", end: "2026-05-21" } }]));
    const reversed = bad(applyOps(held(), [{ op: "update_stop", target: { name: "Kyoto" }, fields: { end: "2026-05-23" } }]));
    assert.deepEqual(keys(reversed.blocked), ["blocked.datesReversed"]);
  });

  test("an overlap that ALREADY exists does not block an unrelated edit", () => {
    const day = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Nikko", "2026-05-21", "2026-05-23"), stop("Kyoto", "2026-05-24", "2026-05-27")] });
    ok(applyOps(day, [{ op: "update_stop", target: { name: "Kyoto" }, fields: { end: "2026-05-28" } }]));
  });

  test("a NEW overlap with a stop the change touches is refused even beside an old one", () => {
    const day = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Nikko", "2026-05-21", "2026-05-23"), stop("Kyoto", "2026-05-27", "2026-05-30")] });
    bad(applyOps(day, [{ op: "update_stop", target: { name: "Kyoto" }, fields: { start: "2026-05-22" } }]));
  });

  test("start-only and undated stops never overlap anything", () => {
    ok(applyOps(store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto")] }), [{ op: "update_stop", target: { name: "Kyoto" }, fields: { start: "2026-05-20" } }]));
  });

  test("the result goes through validateAnswer: a malformed date is refused, not shown", () => {
    const refused = bad(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "May 20" } }]));
    assert.deepEqual(keys(refused.blocked), ["blocked.invalid"]);
  });

  test("a date change that re-sorts a dated list shows the reorder as its own line", () => {
    const three = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27"), stop("Osaka", "2026-05-27", "2026-05-30")] });
    const out = ok(applyOps(three, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-06-02", end: "2026-06-05" } }]));
    assert.deepEqual(dataOf(out, "phases").map((s) => s.name), ["Kyoto", "Osaka", "Tokyo"]);
    assert.ok(keys(out.preview).includes("preview.reorder"));
  });

  test("the preview is the field-level difference and says what stays", () => {
    const out = ok(applyOps(held(), [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-20" } }]));
    assert.deepEqual(out.preview.find((l) => l.key === "preview.field")?.params, {
      question: "phases", entry: { name: "Tokyo", start: "2026-05-19", end: "2026-05-24" }, field: "start", from: "2026-05-19", to: "2026-05-20",
    });
    const unchanged = out.preview.find((l) => l.key === "preview.unchanged");
    assert.deepEqual((unchanged?.params.entries as { name: string }[]).map((e) => e.name), ["Kyoto"]);
  });

  test("a date change names the days it would drop", () => {
    const withDays = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24", { days: [{ date: "2026-05-19" }, { date: "2026-05-23" }] })] });
    const out = ok(applyOps(withDays, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-21" } }]));
    assert.deepEqual(out.preview.find((l) => l.key === "warn.daysDropped")?.params.dates, ["2026-05-19"]);
  });

  test("a stop outside the trip's own dates is a warning, not a block", () => {
    const b = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24")] }, { departure_date: text("2026-05-19"), return_date: text("2026-05-30") });
    const out = ok(applyOps(b, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-05-17", end: "2026-05-31" } }]));
    assert.equal(out.preview.filter((l) => l.key === "warn.outsideTripDates").length, 2);
  });
});

describe("applyOps — adding, removing, renaming, replacing, moving stops", () => {
  const three = () => store({ phases: [stop("Tokyo"), stop("Hakone"), stop("Kyoto")] });

  test("a return leg is an ADD, beside the first visit, which stays as it was", () => {
    const b = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")] });
    const out = ok(applyOps(b, [{ op: "add_stop", fields: { name: "Tokyo", start: "2026-05-30", end: "2026-06-02" } }]));
    assert.deepEqual(dataOf(out, "phases").map((s) => [s.name, s.start]), [["Tokyo", "2026-05-19"], ["Kyoto", "2026-05-24"], ["Tokyo", "2026-05-30"]]);
    assert.deepEqual(keys(out.preview), ["preview.add", "preview.unchanged"]);
  });

  test("removal shows what goes and what remains, and does not touch the rest", () => {
    const out = ok(applyOps(three(), [{ op: "remove_stop", target: { name: "Hakone" } }]));
    assert.deepEqual(dataOf(out, "phases").map((s) => s.name), ["Tokyo", "Kyoto"]);
    assert.ok(keys(out.preview).includes("preview.remove"));
    assert.deepEqual((out.preview.find((l) => l.key === "preview.unchanged")?.params.entries as { name: string }[]).map((e) => e.name), ["Tokyo", "Kyoto"]);
  });

  test("removing EVERY stop says so, in its own line; removing some does not", () => {
    const all = ok(applyOps(three(), [
      { op: "remove_stop", target: { name: "Tokyo" } },
      { op: "remove_stop", target: { name: "Hakone" } },
      { op: "remove_stop", target: { name: "Kyoto" } },
    ]));
    assert.deepEqual(dataOf(all, "phases"), []);
    assert.deepEqual(all.preview.filter((l) => l.key === "warn.removesEverything").map((l) => l.params), [{ question: "phases" }]);
    const some = ok(applyOps(three(), [{ op: "remove_stop", target: { name: "Tokyo" } }, { op: "remove_stop", target: { name: "Kyoto" } }]));
    assert.equal(keys(some.preview).includes("warn.removesEverything"), false);
    const swapped = ok(applyOps(three(), [
      { op: "remove_stop", target: { name: "Tokyo" } },
      { op: "remove_stop", target: { name: "Hakone" } },
      { op: "remove_stop", target: { name: "Kyoto" } },
      { op: "add_stop", fields: { name: "Nara" } },
    ]));
    assert.equal(keys(swapped.preview).includes("warn.removesEverything"), false, "a stop was added: the list is not empty");
    // A list that was already empty is not "removed".
    const nothing = ok(applyOps(store({ phases: [] }), [{ op: "add_stop", fields: { name: "Nara" } }]));
    assert.equal(keys(nothing.preview).includes("warn.removesEverything"), false);
  });

  test("removing every traveller is refused by the gate before any warning is needed; some is fine and quiet", () => {
    const two = store({ travelers: [{ name: "Ruth Cohen" }, { name: "Avi Cohen" }] });
    bad(applyOps(two, [{ op: "remove_traveller", target: { name: "Ruth" } }, { op: "remove_traveller", target: { name: "Avi" } }]));
    const one = ok(applyOps(two, [{ op: "remove_traveller", target: { name: "Avi" } }]));
    assert.equal(keys(one.preview).includes("warn.removesEverything"), false);
  });

  test("removing a stop names the days that go with it", () => {
    const b = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24", { days: [{ date: "2026-05-20" }] })] });
    const out = ok(applyOps(b, [{ op: "remove_stop", target: { name: "Tokyo" } }]));
    assert.deepEqual(out.preview.find((l) => l.key === "warn.daysDropped")?.params.dates, ["2026-05-20"]);
  });

  test("rename keeps the stop's dates and drops the stale English spelling; replace starts a new stop", () => {
    const b = store({ phases: [stop("Hakone", "2026-05-19", "2026-05-22", { name_en: "Hakone", accommodation: { name: "Gora Hotel" } })] });
    const renamed = ok(applyOps(b, [{ op: "rename_stop", target: { name: "Hakone" }, name: "Nagoya" }]));
    assert.deepEqual(dataOf(renamed, "phases"), [stop("Nagoya", "2026-05-19", "2026-05-22", { accommodation: { name: "Gora Hotel" } })]);
    const replaced = ok(applyOps(b, [{ op: "replace_stop", target: { name: "Hakone" }, fields: { name: "Nagoya" } }]));
    assert.deepEqual(dataOf(replaced, "phases"), [{ name: "Nagoya" }]);
    assert.ok(keys(replaced.preview).includes("preview.replace"));
    assert.ok(replaced.preview.some((l) => l.key === "preview.dropsField" && l.params.field === "accommodation"), "what the replacement throws away is said");
  });

  test("moving an undated stop reorders it; moving a DATED stop is a question about its dates", () => {
    const out = ok(applyOps(three(), [{ op: "move_stop", target: { name: "Hakone" }, after: { name: "Kyoto" } }]));
    assert.deepEqual(dataOf(out, "phases").map((s) => s.name), ["Tokyo", "Kyoto", "Hakone"]);
    assert.ok(keys(out.preview).includes("preview.reorder"));
    const dated = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")] });
    assert.deepEqual(keys(bad(applyOps(dated, [{ op: "move_stop", target: { name: "Kyoto" }, before: { name: "Tokyo" } }])).blocked), ["blocked.moveDated"]);
  });

  test("an ambiguous or missing reference returns what to ask, and no result", () => {
    const twice = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Tokyo", "2026-05-30", "2026-06-02")] });
    const refused = bad(applyOps(twice, [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }]));
    assert.deepEqual(refused.unresolved.map((u) => [u.opIndex, u.role, u.candidates]), [[0, "target", [0, 1]]]);
    const missing = bad(applyOps(three(), [{ op: "remove_stop", target: { name: "Nara" } }]));
    assert.deepEqual(missing.unresolved[0]?.candidates, []);
  });

  test("references resolve against the HELD list, so operation order cannot change what a name meant", () => {
    const out = ok(applyOps(three(), [
      { op: "remove_stop", target: { name: "Hakone" } },
      { op: "move_stop", target: { name: "Tokyo" }, after: { name: "Kyoto" } },
    ]));
    assert.deepEqual(dataOf(out, "phases").map((s) => s.name), ["Kyoto", "Tokyo"]);
  });

  test("an operation on an unanswered question has nothing to resolve against", () => {
    bad(applyOps({} as AnswerStore, [{ op: "remove_stop", target: { name: "Tokyo" } }]));
    ok(applyOps({} as AnswerStore, [{ op: "add_stop", fields: { name: "Tokyo" } }]));
  });
});

describe("applyOps — travellers", () => {
  const roster = () => store({ travelers: [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen", age: 41 }] });

  test("Ruth 70 -> 71, Avi kept, and the preview says exactly that", () => {
    const out = ok(applyOps(roster(), [{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]));
    assert.deepEqual(dataOf(out, "travelers"), [{ name: "Ruth Cohen", age: 71 }, { name: "Avi Cohen", age: 41 }]);
    assert.deepEqual(out.preview.find((l) => l.key === "preview.field")?.params.from, 70);
    assert.equal(out.preview.find((l) => l.key === "preview.field")?.params.to, 71);
  });

  test("Ella beside a held Bella is added, never fused", () => {
    const out = ok(applyOps(store({ travelers: [{ name: "Bella Cohen", age: 12 }] }), [{ op: "add_traveller", fields: { name: "Ella Cohen", age: 9 } }]));
    assert.deepEqual(dataOf(out, "travelers").map((p) => p.name), ["Bella Cohen", "Ella Cohen"]);
  });

  test("a new traveller who may already be listed is asked about, not added and not dropped", () => {
    const refused = bad(applyOps(roster(), [{ op: "add_traveller", fields: { name: "Ruth" } }]));
    assert.deepEqual(keys(refused.blocked), ["blocked.possibleDuplicate"]);
    assert.equal((refused.blocked[0]!.params.candidates as unknown[]).length, 1);
  });

  test("a name change is an update, and a Hebrew roster works", () => {
    const he = store({ travelers: [{ name: "רות כהן", name_en: "Ruth Cohen", age: 70 }] });
    const out = ok(applyOps(he, [{ op: "update_traveller", target: { name: "רות" }, fields: { name: "רות לוי" } }]));
    assert.equal(dataOf(out, "travelers")[0].name, "רות לוי");
  });

  test("the roster cannot be emptied: the gate refuses it", () => {
    bad(applyOps(store({ travelers: [{ name: "Ruth Cohen" }] }), [{ op: "remove_traveller", target: { name: "Ruth" } }]));
  });

  test("removing a traveller says what it does to the organizer's identity and to a dietary scope", () => {
    const b = store(
      { travelers: [{ name: "Ruth Cohen" }, { name: "Avi Cohen" }], dietary_scope: { kosher_style: ["Ruth Cohen"] } },
      { organizer_identity: text("Ruth Cohen") },
    );
    const out = ok(applyOps(b, [{ op: "remove_traveller", target: { name: "Ruth" } }]));
    assert.ok(keys(out.preview).includes("effect.organizerIdentityReopens"));
    assert.deepEqual(out.preview.find((l) => l.key === "effect.dietaryScopeNamesNobody")?.params, { need: "kosher_style", name: "Ruth Cohen" });
    const quiet = ok(applyOps(b, [{ op: "remove_traveller", target: { name: "Avi" } }]));
    assert.equal(keys(quiet.preview).some((k) => k.startsWith("effect.")), false);
  });
});

describe("applyOps — bookings the change leaves behind (deterministic warnings)", () => {
  const stops = [stop("Kyoto", "2026-05-24", "2026-05-27")];
  const hotel = { type: "hotel", name: "Gion Inn", date: "2026-05-25", confirmation: "GI-77" };

  test("removing a stop with a CONFIRMED booking inside it lists the booking and says the terms are unknown", () => {
    const out = ok(applyOps(store({ phases: stops, travel_anchors: [hotel] }), [{ op: "remove_stop", target: { name: "Kyoto" } }]));
    const line = out.preview.find((l) => l.key === "warn.bookingInRemovedStop");
    assert.equal((line?.params.booking as { confirmation: string }).confirmation, "GI-77");
    assert.equal(line?.params.terms, "unknown", "the data carries no refund terms, so none are claimed");
  });

  test("non-refundable is said only where the record says it", () => {
    const out = ok(applyOps(store({ phases: stops, travel_anchors: [{ ...hotel, non_refundable: true }] }), [{ op: "remove_stop", target: { name: "Kyoto" } }]));
    assert.equal(out.preview.find((l) => l.key === "warn.bookingInRemovedStop")?.params.terms, "non_refundable");
  });

  test("no confirmation, or outside the range, means no warning", () => {
    for (const anchors of [[{ ...hotel, confirmation: undefined }], [{ ...hotel, date: "2026-06-30" }], []]) {
      const out = ok(applyOps(store({ phases: stops, travel_anchors: anchors }), [{ op: "remove_stop", target: { name: "Kyoto" } }]));
      assert.equal(keys(out.preview).some((k) => k.startsWith("warn.booking")), false);
    }
  });

  test("removing a traveller: bookings that name them are listed; bookings that do not say whose are admitted", () => {
    const flightForAvi = { type: "flight", name: "LY381", date: "2026-05-19", confirmation: "XR7T2Q", passengers: ["Avi Cohen"] };
    const flightUnnamed = { type: "flight", name: "LY382", date: "2026-06-02", confirmation: "XR7T2R" };
    const b = store({ travelers: [{ name: "Ruth Cohen" }, { name: "Avi Cohen" }], travel_anchors: [flightForAvi, flightUnnamed] });
    const out = ok(applyOps(b, [{ op: "remove_traveller", target: { name: "Avi" } }]));
    assert.equal((out.preview.find((l) => l.key === "warn.bookingForRemovedTraveller")?.params.booking as { name: string }).name, "LY381");
    assert.deepEqual(out.preview.find((l) => l.key === "warn.bookingsWhoseNameUnknown")?.params, { count: 1 });
  });

  test("removing a traveller with no confirmed flights or tickets says nothing extra", () => {
    const b = store({ travelers: [{ name: "Ruth Cohen" }, { name: "Avi Cohen" }], travel_anchors: [{ type: "flight", name: "LY381", date: "2026-05-19" }, hotel] });
    const out = ok(applyOps(b, [{ op: "remove_traveller", target: { name: "Avi" } }]));
    assert.equal(keys(out.preview).some((k) => k.startsWith("warn.booking")), false);
  });
});

describe("mergeOps — a follow-up joins the waiting change, never replaces it", () => {
  const b = store({ travelers: [{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen", age: 41 }] });
  const ruth71: Op = { op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } };

  test("a change about someone else accumulates", () => {
    const merged = mergeOps([ruth71], [{ op: "update_traveller", target: { name: "Avi" }, fields: { age: 40 } }], b);
    assert.equal(merged.length, 2);
    assert.deepEqual(dataOf(ok(applyOps(b, merged)), "travelers").map((p) => p.age), [71, 40]);
  });

  test("two updates to the same entry merge field by field, the later value winning", () => {
    const merged = mergeOps([ruth71], [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 72, family: "Cohen" } }], b);
    assert.deepEqual(merged, [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 72, family: "Cohen" } }]);
  });

  test("a different kind of operation on the same entry replaces the earlier one", () => {
    const merged = mergeOps([ruth71], [{ op: "remove_traveller", target: { name: "Ruth" } }], b);
    assert.deepEqual(merged.map((o) => o.op), ["remove_traveller"]);
  });
});

describe("PINNED KNOWN GAP — the background itinerary fold can resurrect a removed stop", () => {
  // Not fixed by #206 (design §7 (v)): `foldItineraryFromDocument` merges a
  // document's stops into what is held BY NAME, so a stop the organizer just
  // removed comes back with its days. This test asserts today's behaviour so
  // the gap stays visible; when it is fixed, this assertion is the one to flip.
  test("held without Kyoto, a document that lists Kyoto brings it back", () => {
    const afterRemoval = [stop("Tokyo", "2026-05-19", "2026-05-24")];
    const fromDocument = [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27")];
    const merged = reconcileStructured(afterRemoval, fromDocument, {}).merged as { name: string }[];
    assert.deepEqual(merged.map((s) => s.name), ["Tokyo", "Kyoto"]);
  });
});

describe("a question the words left open (#206, slice 3)", () => {
  const rename = { op: "rename_stop", target: { name: "Hakone" }, name: "Nagoya" } as const;
  const replace = { op: "replace_stop", target: { name: "Hakone" }, fields: { name: "Nagoya" } } as const;
  const add = { op: "add_stop", fields: { name: "Nagoya" } } as const;
  const held = () => store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Hakone", "2026-05-24", "2026-05-27")] });

  test("choose parses with two or three complete options, and never nests", () => {
    assert.equal(parseOps([{ op: "choose", options: [rename, replace, add] }]).ok, true);
    assert.equal(parseOps([{ op: "choose", options: [rename] }]).ok, false);
    assert.equal(parseOps([{ op: "choose", options: [rename, replace, add, add] }]).ok, false);
    assert.equal(parseOps([{ op: "choose", options: [rename, { op: "choose", options: [replace, add] }] }]).ok, false);
    assert.equal(parseOps([{ op: "choose", options: [rename, { op: "add_traveller", fields: { name: "Ella" } }] }]).ok, false, "one subject");
  });

  test("an unsettled choice is a question, before anything is validated or shown", () => {
    const refused = bad(applyOps(held(), [{ op: "choose", options: [rename, replace, add] }]));
    assert.deepEqual(keys(refused.blocked), ["blocked.chooseOne"]);
    const open = openQuestion({ unresolved: refused.unresolved, blocked: refused.blocked });
    assert.equal(open?.kind, "choose");
    assert.deepEqual((open as { options: { op: string }[] }).options.map((o) => o.op), ["rename_stop", "replace_stop", "add_stop"]);
  });

  test("the person's pick REPLACES the choice with that operation, and a bad pick changes nothing", () => {
    const ops: Op[] = [{ op: "choose", options: [rename, replace, add] }];
    const refused = bad(applyOps(held(), ops));
    const picked = applyPick(ops, refused, held(), 0)!;
    assert.deepEqual(picked, [rename]);
    assert.deepEqual(dataOf(ok(applyOps(held(), picked)), "phases")[1], stop("Nagoya", "2026-05-24", "2026-05-27"), "renamed, dates kept");
    assert.deepEqual(dataOf(ok(applyOps(held(), applyPick(ops, refused, held(), 2)!)), "phases").map((s) => s.name), ["Tokyo", "Hakone", "Nagoya"], "the third reading adds");
    assert.equal(applyPick(ops, refused, held(), 3), null);
    assert.equal(applyPick(ops, refused, held(), -1), null);
  });

  test("an ambiguous reference: the pick is PINNED to that entry, so two identical names cannot be confused", () => {
    const twice = store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto", "2026-05-24", "2026-05-27"), stop("Tokyo", "2026-05-30", "2026-06-02")] });
    const ops: Op[] = [{ op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-06-03" } }];
    const refused = bad(applyOps(twice, ops));
    const open = openQuestion({ unresolved: refused.unresolved, blocked: refused.blocked });
    assert.equal(open?.kind, "reference");
    const picked = applyPick(ops, refused, twice, 1)!;
    assert.deepEqual(dataOf(ok(applyOps(twice, picked)), "phases").map((s) => s.end), ["2026-05-24", "2026-05-27", "2026-06-03"]);
  });

  test("a pin counts only while that entry still goes by that name", () => {
    const list = [{ name: "Tokyo" }, { name: "Tokyo" }];
    assert.deepEqual(resolveRef(list, { name: "Tokyo", pin: { index: 1, name: "Tokyo" } }, "stop"), { kind: "resolved", index: 1 });
    assert.deepEqual(resolveRef([{ name: "Kyoto" }, { name: "Tokyo" }], { name: "Tokyo", pin: { index: 0, name: "Tokyo" } }, "stop"), { kind: "resolved", index: 1 }, "index 0 is Kyoto now: the pin is void and the name decides");
    assert.equal(parseOps([{ op: "remove_stop", target: { name: "Tokyo", pin: { index: 0, name: "Tokyo" } } }]).ok, false, "the model cannot pin");
  });

  test("a follow-up about the same choice replaces it; the model is shown every held entry, with ids", () => {
    const b = held();
    const merged = mergeOps([{ op: "choose", options: [rename, replace] }], [{ op: "choose", options: [rename, replace] }], b);
    assert.equal(merged.length, 1);
    const lists = heldRefLists(store({ phases: [stop("Tokyo", "2026-05-19", "2026-05-24"), stop("Kyoto")], travelers: [{ name: "רות כהן", name_en: "Ruth Cohen", age: 70 }] }));
    assert.deepEqual(lists.stops, [{ id: "s1", label: "Tokyo, 2026-05-19 to 2026-05-24" }, { id: "s2", label: "Kyoto, no dates" }]);
    assert.deepEqual(lists.travellers, [{ id: "t1", label: "רות כהן (Ruth Cohen), age 70" }]);
    const many = heldRefLists(store({ phases: Array.from({ length: 30 }, (_, i) => stop(`Stop ${i}`)) }));
    assert.equal(many.stops.length, 30, "never cut");
  });
});


describe("model-supplied text cannot write into the preview (F)", () => {
  const refused = (raw: unknown) => assert.equal(parseOps(raw).ok, false, JSON.stringify(raw));
  test("newlines, control characters and bidi controls are refused wherever a name is accepted", () => {
    const bad = [
      "Nara\n\n\u2705 Done \u2014 that's updated.",
      "Nara\u202Eevil",
      "Nara\u2066x\u2069",
      "Nara\u0007",
      "Nara\u2028line",
      "Nara\r\nStaying exactly as it is: Tokyo",
    ];
    for (const name of bad) {
      refused([{ op: "add_stop", fields: { name } }]);
      refused([{ op: "add_traveller", fields: { name } }]);
      refused([{ op: "update_stop", target: { name }, fields: { end: "2026-05-25" } }]);
      refused([{ op: "rename_stop", target: { name: "Kyoto" }, name }]);
      refused([{ op: "add_stop", fields: { name: "Nara", planned: [name] } }]);
      refused([{ op: "add_stop", fields: { name: "Nara", accommodation: { name } } }]);
      refused([{ op: "add_traveller", fields: { name: "Dana", family: name } }]);
    }
  });

  test("ordinary names, Hebrew, and the directional MARKS Hebrew uses are still accepted", () => {
    for (const name of ["Nara", "Kyoto {to}", "\u05e0\u05d0\u05e8\u05d4", "Ho Chi Minh City \u2014 day trip", "\u200f\u05d8\u05d5\u05e7\u05d9\u05d5\u200f"]) {
      assert.equal(parseOps([{ op: "add_stop", fields: { name } }]).ok, true, name);
    }
  });

  test("the bounds that keep a preview bounded", () => {
    assert.equal(parseOps([{ op: "add_stop", fields: { name: "x".repeat(81) } }]).ok, false);
    assert.equal(parseOps([{ op: "add_stop", fields: { name: "x", planned: Array.from({ length: 13 }, () => "p") } }]).ok, false);
    assert.equal(parseOps([{ op: "add_stop", fields: { name: "x", planned: Array.from({ length: 12 }, () => "p".repeat(80)) } }]).ok, true);
  });
});

describe("held lists that are not all objects (H)", () => {
  test("the model is shown ids that are POSITIONS in the held list, skipping what is not an entry", () => {
    const lists = heldRefLists(store({ phases: ["Tokyo", stop("Kyoto", "2026-05-27", "2026-05-30"), 7, stop("Osaka")] }));
    assert.deepEqual(lists.stops.map((i) => i.id), ["s2", "s4"], "Kyoto is s2 and Osaka s4, as resolveRef will count them");
  });

  test("a change to a list that cannot be edited is blocked as unsupportedShape, never applied", () => {
    const out = bad(applyOps(store({ phases: ["Tokyo", stop("Kyoto")] }), [{ op: "update_stop", target: { name: "Kyoto" }, fields: { end: "2026-05-31" } }]));
    assert.deepEqual(keys(out.blocked), ["blocked.unsupportedShape"]);
  });
});
