/**
 * What the organizer sees for a typed change (#206, slice 3): the wording in both
 * languages and the buttons that answer it. Pure — no database, no model.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { changeCallbackData, parseCallbackData, callbackDataFits } from "../src/chat-router.js";
import { UI_STRINGS, readableDate, uiString } from "../src/intake-copy.js";
import { applyOps, type Op } from "../src/typed-changes.js";
import type { AnswerStore } from "../src/interview.js";
import { draftDigest, type Line } from "../src/typed-changes.js";
import { bareReply, confirmable, lineText, renderDraft } from "../src/typed-changes-render.js";

const ID = "pchg_0123456789abcdef0123456789abcdef";
const draft = (over: Record<string, unknown> = {}) => ({
  id: ID, preview: [] as Line[], unresolved: [], blocked: [] as Line[], base: {}, ops: [], result: { phases: { kind: "structured" } }, ...over,
}) as never;
const DG = (over: Record<string, unknown> = {}) => draftDigest(draft(over));
const tokyo = { name: "Tokyo", start: "2026-05-19", end: "2026-05-24" };

describe("the strings", () => {
  test("every change string exists in English AND Hebrew, and they differ", () => {
    const en = Object.keys(UI_STRINGS.en).filter((k) => k.startsWith("change"));
    const he = Object.keys(UI_STRINGS.he).filter((k) => k.startsWith("change"));
    assert.deepEqual([...en].sort(), [...he].sort(), "key parity");
    assert.ok(en.length >= 50, `${en.length} keys`);
    for (const key of en) {
      assert.ok(UI_STRINGS.he[key] && UI_STRINGS.he[key]!.trim() !== "", `he ${key}`);
      assert.notEqual(UI_STRINGS.en[key], UI_STRINGS.he[key], `${key} is translated`);
    }
  });

  test("the same {placeholders} appear in both languages", () => {
    const holes = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const key of Object.keys(UI_STRINGS.en).filter((k) => k.startsWith("change"))) {
      assert.equal(holes(UI_STRINGS.he[key]!), holes(UI_STRINGS.en[key]!), key);
    }
  });
});

describe("buttons", () => {
  test("callback data round-trips, fits Telegram's 64 bytes, and rejects anything else", () => {
    const dg = DG();
    for (const data of [changeCallbackData(ID, dg, "apply"), changeCallbackData(ID, dg, "cancel"), changeCallbackData(ID, dg, "pick", 7)]) {
      assert.ok(callbackDataFits(data), data);
    }
    assert.deepEqual(parseCallbackData(changeCallbackData(ID, dg, "apply")), { kind: "change", draftId: ID, digest: dg, choice: "apply" });
    assert.deepEqual(parseCallbackData(changeCallbackData(ID, dg, "cancel")), { kind: "change", draftId: ID, digest: dg, choice: "cancel" });
    assert.deepEqual(parseCallbackData(changeCallbackData(ID, dg, "pick", 7)), { kind: "change", draftId: ID, digest: dg, choice: "pick", index: 7 });
    // A button from before digests existed still parses, with no digest: it can never match one.
    assert.deepEqual(parseCallbackData(`pc:${ID}:a`), { kind: "change", draftId: ID, digest: null, choice: "apply" });
    for (const forged of [`pc:${ID}:x`, `pc:${ID}`, `pc:nope:a`, `pc:${ID}:r:`, `pc:${ID}:r:123`, `pc:${ID}:a:1`, `pc:${ID}:${dg}`, `pc:${ID}:${dg}:a:1`, `pc:${ID}:ZZZZZZZZ:a`, `pc:${ID}:${dg}0:a`]) {
      assert.equal(parseCallbackData(forged).kind, "unknown", forged);
    }
  });

  test("the widest callback_data that can be generated is under Telegram's 64 bytes", () => {
    // Real ids are `pchg_` + 32 hex; the widest button is a pick with a two-digit index.
    const widest = changeCallbackData(`pchg_${"f".repeat(32)}`, "f".repeat(8), "pick", 99);
    assert.ok(Buffer.byteLength(widest) <= 54, `${Buffer.byteLength(widest)} bytes: ${widest}`);
    assert.ok(callbackDataFits(widest));
  });

  test("the digest names the version: it changes with the operations, the result and the open question, and not otherwise", () => {
    const one = { ops: [{ op: "remove_stop", target: { name: "Kyoto" } }], result: { phases: { kind: "structured", data: [1] } }, unresolved: [], blocked: [], preview: [] as Line[] };
    assert.equal(draftDigest(one as never), draftDigest(JSON.parse(JSON.stringify(one))), "stable across a database round trip");
    assert.match(draftDigest(one as never), /^[0-9a-f]{8}$/);
    for (const changed of [
      { ...one, ops: [...one.ops, { op: "remove_stop", target: { name: "Tokyo" } }] },
      { ...one, result: { phases: { kind: "structured", data: [2] } } },
      { ...one, blocked: [{ key: "blocked.overlap", params: {} }] },
      // What the person was WARNED about is part of the version they saw.
      { ...one, preview: [{ key: "warn.bookingInRemovedStop", params: { booking: { confirmation: "GI-77" } } }] },
    ]) assert.notEqual(draftDigest(changed as never), draftDigest(one as never));
    const plain = { ...one, preview: [{ key: "preview.remove", params: {} }] as Line[] };
    assert.equal(draftDigest(plain as never), draftDigest(one as never), "a preview line that is not a warning does not change it");
  });
});

describe("saying yes or no in words", () => {
  test("a bare yes or no, in either language, punctuation and case aside", () => {
    for (const yes of ["yes", "Yes!", " ok ", "Sure.", "כן", "כן!", "אשר", "go ahead", "that's right", "אוקיי"]) assert.equal(bareReply(yes), "yes", yes);
    for (const no of ["no", "No.", "cancel", "never mind", "לא", "לא!", "בטל", "ביטול"]) assert.equal(bareReply(no), "no", no);
  });

  test("anything MORE than a bare yes or no is not one — it is a change or a question", () => {
    for (const not of ["yes, and add Nara", "no, make it the 21st", "yes but Kyoto is 25", "כן, ותוסיפו את נארה", "לא, זה ה-21", "maybe", "", "tokyo", "yes yes no"]) {
      assert.equal(bareReply(not), null, not);
    }
  });
});

describe("the preview", () => {
  test("a change that validated: what changes, what stays, both buttons, in both languages", () => {
    const preview: Line[] = [
      { key: "preview.field", params: { question: "phases", entry: tokyo, field: "end", from: "2026-05-24", to: "2026-05-25" } },
      { key: "preview.unchanged", params: { question: "phases", entries: [{ name: "Kyoto", start: "2026-05-27", end: "2026-05-30" }] } },
    ];
    const en = renderDraft(draft({ preview }), "en");
    assert.match(en.text, /Tokyo \(May 19, 2026 – May 24, 2026\): end date May 24, 2026 → May 25, 2026/);
    assert.match(en.text, /Staying exactly as it is: Kyoto/);
    assert.deepEqual(en.replyMarkup.inline_keyboard[0]!.map((b) => b.callback_data), [`pc:${ID}:${DG({ preview })}:a`, `pc:${ID}:${DG({ preview })}:c`]);
    const he = renderDraft(draft({ preview }), "he");
    assert.ok(he.text.startsWith(uiString("change.header", "he")));
    assert.match(he.text, /נשאר בדיוק כמו שהוא: Kyoto/);
    assert.ok(en.text !== he.text);
  });

  test("every line key the preview can emit has wording in both languages", () => {
    const lines: Line[] = [
      { key: "preview.add", params: { question: "phases", entry: tokyo } },
      { key: "preview.remove", params: { question: "phases", entry: tokyo } },
      { key: "preview.replace", params: { question: "phases", from: tokyo, to: { name: "Nara" } } },
      { key: "preview.dropsField", params: { question: "phases", entry: tokyo, field: "accommodation" } },
      { key: "preview.reorder", params: { question: "phases", order: [tokyo, { name: "Kyoto" }] } },
      { key: "warn.daysDropped", params: { entry: tokyo, dates: ["2026-05-19"] } },
      { key: "warn.outsideTripDates", params: { entry: tokyo, which: "end", tripDate: "2026-05-30" } },
      { key: "warn.bookingInRemovedStop", params: { stop: tokyo, terms: "unknown", booking: { type: "hotel", name: "Gion Inn", date: "2026-05-25", confirmation: "GI-77" } } },
      { key: "warn.bookingInRemovedStop", params: { stop: tokyo, terms: "non_refundable", booking: { type: "hotel", name: "Gion Inn", date: "2026-05-25", confirmation: "GI-77" } } },
      { key: "warn.bookingForRemovedTraveller", params: { traveller: { name: "Avi" }, terms: "unknown", booking: { type: "flight", name: "LY381", date: "2026-05-19", confirmation: "XR7T2Q" } } },
      { key: "warn.bookingsWhoseNameUnknown", params: { count: 2 } },
      { key: "warn.removesEverything", params: { question: "phases" } },
      { key: "warn.removesEverything", params: { question: "travelers" } },
      { key: "effect.organizerIdentityReopens", params: {} },
      { key: "effect.dietaryScopeNamesNobody", params: { need: "kosher_style", name: "Ruth" } },
    ];
    for (const language of ["en", "he"] as const) {
      for (const line of lines) {
        const text = lineText(line, language);
        assert.ok(text.length > 0, `${language} ${line.key}`);
        assert.doesNotMatch(text, /\{\w+\}/, `${language} ${line.key} has an unfilled placeholder: ${text}`);
        assert.ok(!Object.keys(UI_STRINGS.en).includes(text), "not a raw key");
      }
    }
  });

  test("removing everything is said in plain words, in both languages", () => {
    assert.equal(lineText({ key: "warn.removesEverything", params: { question: "phases" } }, "en"), "⚠️ This would remove every stop — your whole itinerary.");
    assert.match(lineText({ key: "warn.removesEverything", params: { question: "travelers" } }, "en"), /every traveller/);
    assert.match(lineText({ key: "warn.removesEverything", params: { question: "phases" } }, "he"), /כל העצירות/);
    assert.match(lineText({ key: "warn.removesEverything", params: { question: "travelers" } }, "he"), /כל הנוסעים/);
  });

  test("refund terms are claimed only where the line says so", () => {
    const line = (terms: string): Line => ({ key: "warn.bookingInRemovedStop", params: { stop: tokyo, terms, booking: { type: "hotel", name: "Gion Inn", confirmation: "GI-77" } } });
    assert.match(lineText(line("unknown"), "en"), /don't know its cancellation terms/);
    assert.doesNotMatch(lineText(line("unknown"), "en"), /non-refundable/);
    assert.match(lineText(line("non_refundable"), "en"), /non-refundable/);
  });
});

describe("questions and conflicts", () => {
  test("a choice: one button per reading, then No — and no Yes", () => {
    const blocked: Line[] = [{ key: "blocked.chooseOne", params: { opIndex: 0, options: [
      { op: "rename_stop", from: "Hakone", to: "Nagoya" }, { op: "replace_stop", from: "Hakone", to: "Nagoya" }, { op: "add_stop", from: null, to: "Nagoya" },
    ] } }];
    const r = renderDraft(draft({ blocked, result: {} }), "en");
    assert.deepEqual(r.replyMarkup.inline_keyboard.map((row) => row[0]!.callback_data), [`pc:${ID}:${DG({ blocked, result: {} })}:r:0`, `pc:${ID}:${DG({ blocked, result: {} })}:r:1`, `pc:${ID}:${DG({ blocked, result: {} })}:r:2`, `pc:${ID}:${DG({ blocked, result: {} })}:c`]);
    assert.match(r.replyMarkup.inline_keyboard[0]![0]!.text, /Rename Hakone to Nagoya/);
    assert.equal(r.replyMarkup.inline_keyboard.flat().some((b) => b.callback_data.endsWith(":a")), false);
  });

  test("an ambiguous reference lists the candidates from the held answer", () => {
    const base = { travelers: { kind: "structured", data: [{ name: "Ruth Cohen", age: 70 }, { name: "Ruth Levi", age: 60 }] } };
    const unresolved = [{ opIndex: 0, role: "target", family: "traveller", ref: { name: "Ruth" }, candidates: [0, 1] }];
    const r = renderDraft(draft({ unresolved, base, result: {} }), "en");
    assert.match(r.text, /Which one do you mean by "Ruth"\?/);
    assert.deepEqual(r.replyMarkup.inline_keyboard.map((row) => row[0]!.text).slice(0, 2), ["Ruth Cohen (70)", "Ruth Levi (60)"]);
    const none = renderDraft(draft({ unresolved: [{ ...unresolved[0]!, candidates: [] }], base, result: {} }), "he");
    assert.match(none.text, /לא מצאתי את "Ruth"/);
  });

  test("an overlap names every stop, asks for dates, offers no Yes and no fix", () => {
    const blocked: Line[] = [{ key: "blocked.overlap", params: { stops: [tokyo, { name: "Kyoto", start: "2026-05-24", end: "2026-05-27" }] } }];
    const r = renderDraft(draft({ blocked, result: {} }), "en");
    assert.match(r.text, /Tokyo[\s\S]*Kyoto/);
    assert.match(r.text, /tell me the dates you want for all of them — I won't move any of them myself/);
    assert.deepEqual(r.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data), [`pc:${ID}:${DG({ blocked, result: {} })}:c`]);
  });

  test("confirmable: a result and nothing left to ask", () => {
    assert.equal(confirmable(draft()), true);
    assert.equal(confirmable(draft({ result: {} })), false);
    assert.equal(confirmable(draft({ blocked: [{ key: "blocked.overlap", params: {} }] })), false);
    assert.equal(confirmable(draft({ unresolved: [{}] })), false);
  });
});


describe("what the preview says about names and refusals", () => {
  test("placeholders are filled in one pass: a name that looks like one cannot rewrite the line (F)", () => {
    const line: Line = { key: "preview.field", params: { question: "phases", entry: { name: "Kyoto {to}" }, field: "end", from: "2026-05-27", to: "2026-05-31" } };
    const text = lineText(line, "en");
    assert.match(text, /Kyoto \{to\}: end date/, text);
    assert.match(text, /May 27, 2026 \u2192 May 31, 2026$/, "the real values are where they belong");
    const swap: Line = { key: "preview.replace", params: { question: "phases", from: { name: "A {to}" }, to: { name: "B {from}" } } };
    assert.equal(lineText(swap, "en"), "\ud83d\udd01 Replace A {to} with B {from}");
  });

  test("the writer's own refusal is never shown, in either language (G)", () => {
    const raw = "travelers does not establish who is on this trip. Ask for the names directly.";
    for (const language of ["en", "he"] as const) {
      const text = lineText({ key: "blocked.invalid", params: { question: "travelers", reason: "INCOMPLETE_ANSWER", detail: raw } }, language);
      assert.doesNotMatch(text, /establish|Ask for the names directly/);
      assert.match(text, language === "en" ? /leave nobody on the trip/ : /[\u0590-\u05FF]/);
      const other = lineText({ key: "blocked.invalid", params: { question: "phases", reason: "DATA_WRONG_SHAPE", detail: "raw validator text" } }, language);
      assert.doesNotMatch(other, /raw validator text/);
    }
  });
});

describe("EVERY stored field is visible in the preview (C)", () => {
  const structured = (data: unknown[]) => ({ kind: "structured", schema_version: 3, data }) as const;
  const held = (): AnswerStore => ({
    phases: structured([
      { name: "Tokyo", start: "2026-05-19", end: "2026-05-24", accommodation: { name: "Old Inn", confirmation: "OI-1" }, planned: ["Skytree"] },
      { name: "Kyoto", start: "2026-05-27", end: "2026-05-30" },
    ]),
    travelers: structured([{ name: "Ruth Cohen", age: 70 }, { name: "Avi Cohen" }]),
  }) as unknown as AnswerStore;

  const leaves = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) for (const v of value) leaves(v, out);
    else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) leaves(v, out);
    else if (value !== undefined && value !== null) out.push(String(value));
    return out;
  };
  const dataOf = (a: AnswerStore, q: string) => ((a[q] as { data?: unknown[] } | undefined)?.data ?? []) as Record<string, unknown>[];

  /** The fields of every entry the change added or altered, that the person has to be shown. */
  const changedLeaves = (before: AnswerStore, after: Record<string, unknown>): string[] => {
    const out: string[] = [];
    for (const q of Object.keys(after)) {
      const was = dataOf(before, q).map((e) => JSON.stringify(e));
      for (const entry of dataOf(after as AnswerStore, q)) {
        if (was.includes(JSON.stringify(entry))) continue;
        const prior = dataOf(before, q).find((e) => e.name === entry.name);
        for (const [key, value] of Object.entries(entry)) {
          if (prior && JSON.stringify(prior[key]) === JSON.stringify(value)) continue;
          out.push(...leaves(value));
        }
      }
    }
    return out;
  };

  const cases: Array<[string, Op[]]> = [
    ["add_stop with everything", [{ op: "add_stop", fields: { name: "Nara", name_en: "Nara EN", start: "2026-05-30", end: "2026-06-01", accommodation: { name: "Shady Inn", confirmation: "ZZ-999" }, planned: ["Deer park", "Casino"] } }]],
    ["replace_stop with hotel and places", [{ op: "replace_stop", target: { name: "Kyoto" }, fields: { name: "Osaka", accommodation: { name: "Hotel X", confirmation: "HX-1" }, planned: ["USJ"] } }]],
    ["update_stop hotel and places", [{ op: "update_stop", target: { name: "Kyoto" }, fields: { accommodation: { name: "Inn K", confirmation: "K-7" }, planned: ["Fushimi", "Gion"] } }]],
    ["update_stop replaces an existing hotel", [{ op: "update_stop", target: { name: "Tokyo" }, fields: { accommodation: { name: "New Inn", confirmation: "NI-2" }, end: "2026-05-25" } }]],
    ["update_stop English name", [{ op: "update_stop", target: { name: "Kyoto" }, fields: { name_en: "Kyoto City" } }]],
    ["add_traveller with family and English name", [{ op: "add_traveller", fields: { name: "Dana Levi", name_en: "Dana L", family: "Levi household", age: 30 } }]],
    ["update_traveller family", [{ op: "update_traveller", target: { name: "Avi Cohen" }, fields: { family: "Cohen family", name_en: "Avi C" } }]],
    ["update_traveller age", [{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } }]],
    ["two questions at once", [
      { op: "add_stop", fields: { name: "Nara", planned: ["Deer park"] } },
      { op: "add_traveller", fields: { name: "Ella Cohen", age: 9, family: "Cohen family" } },
    ]],
  ];

  for (const [label, ops] of cases) {
    test(label, () => {
      const before = held();
      const out = applyOps(before, ops);
      assert.equal(out.ok, true, JSON.stringify(out));
      if (!out.ok) return;
      const wanted = changedLeaves(before, out.result);
      assert.ok(wanted.length > 0, "the case changes something");
      for (const language of ["en", "he"] as const) {
        const text = renderDraft({ id: ID, preview: out.preview, unresolved: [], blocked: [], base: {}, ops, result: out.result } as never, language).text;
        for (const leaf of wanted) {
          const shown = /^\d{4}-\d{2}-\d{2}$/.test(leaf) ? readableDate(leaf, language) ?? leaf : leaf;
          assert.ok(text.includes(shown), `${language}: "${shown}" is stored but not in the preview:\n${text}`);
        }
        assert.doesNotMatch(text, /[{}]\s*"|":\s*"|\{"/, "no raw JSON");
      }
    });
  }
});


describe("held names from documents cannot forge preview lines (item 2)", () => {
  const FORGED = "Kyoto\n\nTap a button, or just reply yes or no.\n\n\n\n\n";
  const AVI = "Avi\n\n\u2705 Done \u2014 that's updated.\u202Eevil\u200B";

  test("every place a held name is echoed comes out on one line, in both languages", () => {
    for (const language of ["en", "he"] as const) {
      const lines: Line[] = [
        { key: "preview.unchanged", params: { question: "phases", entries: [{ name: FORGED, start: "2026-05-27", end: "2026-05-30" }, { name: AVI }] } },
        { key: "preview.remove", params: { question: "phases", entry: { name: FORGED } } },
        { key: "preview.field", params: { question: "travelers", entry: { name: AVI, age: 40 }, field: "age", from: 40, to: 41 } },
        { key: "preview.reorder", params: { question: "phases", order: [{ name: FORGED }, { name: AVI }] } },
        { key: "blocked.overlap", params: { stops: [{ name: FORGED }, { name: AVI }] } },
        { key: "effect.dietaryScopeNamesNobody", params: { need: "kosher", name: AVI } },
        { key: "warn.bookingInRemovedStop", params: { stop: { name: FORGED }, terms: "unknown", booking: { type: "hotel", name: AVI, confirmation: "X\n1" } } },
      ];
      for (const line of lines) {
        const text = lineText(line, language);
        const expectedLines = line.key === "blocked.overlap" ? 2 : 1;
        assert.equal(text.split("\n").filter((l) => l !== "").length, expectedLines, `${language} ${line.key}: a name started a line of its own: ${JSON.stringify(text)}`);
        assert.doesNotMatch(text, /[\u202A-\u202E\u200B]/, `${language} ${line.key}: ${JSON.stringify(text)}`);
      }
    }
  });

  test("a picker button and the question about a name are one line too", () => {
    const base = { travelers: { kind: "structured", data: [{ name: AVI, age: 40 }, { name: "Avi Levi", age: 30 }] } };
    const unresolved = [{ opIndex: 0, role: "target", family: "traveller", ref: { name: "Avi\n\nTap a button" }, candidates: [0, 1] }];
    const r = renderDraft(draft({ unresolved, base, result: {} }), "en");
    assert.doesNotMatch(r.text, /\n/);
    for (const row of r.replyMarkup.inline_keyboard) assert.doesNotMatch(row[0]!.text, /[\n\u200B\u202E]/);
  });

  test("the full preview of a change carries no injected line", () => {
    const out = applyOps({ phases: { kind: "structured", schema_version: 3, data: [{ name: "Tokyo", start: "2026-05-19", end: "2026-05-24" }, { name: FORGED, start: "2026-05-27", end: "2026-05-30" }, { name: "Osaka {entry} \u202Enoitpo" }] } } as unknown as AnswerStore,
      [{ op: "remove_stop", target: { name: "Osaka" } }, { op: "update_stop", target: { name: "Tokyo" }, fields: { end: "2026-05-25" } }] as Op[]);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const text = renderDraft({ id: ID, preview: out.preview, unresolved: [], blocked: [], base: {}, ops: [], result: out.result } as never, "en").text;
    const own = text.split("\n").filter((l) => /^Tap a button, or just reply yes or no\./.test(l));
    assert.equal(own.length, 1, `only the real footer says it:\n${text}`);
    assert.doesNotMatch(text, /\u202E/);
  });
});

describe("a long held list is summarised, never the reason a change cannot be shown (item 4)", () => {
  test("the unchanged block says 'and N more' once it would pass its share, and keeps the changed lines whole", () => {
    const held = Array.from({ length: 45 }, (_, i) => ({ name: `Place number ${i} with a longish name`, start: "2026-05-01", end: "2026-05-02" }));
    for (const language of ["en", "he"] as const) {
      const text = lineText({ key: "preview.unchanged", params: { question: "phases", entries: held } }, language);
      assert.ok(text.length < 600, `${text.length} chars`);
      assert.match(text, language === "en" ? /and \d+ more\.$/ : /\u05d5\u05e2\u05d5\u05d3 \d+\.$/);
      assert.match(text, /Place number 0 with a longish name/);
    }
    const few = lineText({ key: "preview.unchanged", params: { question: "phases", entries: held.slice(0, 3) } }, "en");
    assert.doesNotMatch(few, /more/, "a short list is listed in full");
  });
});
