/**
 * What the organizer sees for a typed change (#206, slice 3): the wording in both
 * languages and the buttons that answer it. Pure — no database, no model.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { changeCallbackData, parseCallbackData, callbackDataFits } from "../src/chat-router.js";
import { UI_STRINGS, uiString } from "../src/intake-copy.js";
import type { Line } from "../src/typed-changes.js";
import { bareReply, confirmable, lineText, renderDraft } from "../src/typed-changes-render.js";

const ID = "pchg_0123456789abcdef0123456789abcdef";
const draft = (over: Record<string, unknown> = {}) => ({
  id: ID, preview: [] as Line[], unresolved: [], blocked: [] as Line[], base: {}, result: { phases: { kind: "structured" } }, ...over,
}) as never;
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
    for (const data of [changeCallbackData(ID, "apply"), changeCallbackData(ID, "cancel"), changeCallbackData(ID, "pick", 7)]) {
      assert.ok(callbackDataFits(data), data);
    }
    assert.deepEqual(parseCallbackData(changeCallbackData(ID, "apply")), { kind: "change", draftId: ID, choice: "apply" });
    assert.deepEqual(parseCallbackData(changeCallbackData(ID, "cancel")), { kind: "change", draftId: ID, choice: "cancel" });
    assert.deepEqual(parseCallbackData(changeCallbackData(ID, "pick", 7)), { kind: "change", draftId: ID, choice: "pick", index: 7 });
    for (const forged of [`pc:${ID}:x`, `pc:${ID}`, `pc:nope:a`, `pc:${ID}:r:`, `pc:${ID}:r:123`, `pc:${ID}:a:1`]) {
      assert.equal(parseCallbackData(forged).kind, "unknown", forged);
    }
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
    assert.deepEqual(en.replyMarkup.inline_keyboard[0]!.map((b) => b.callback_data), [`pc:${ID}:a`, `pc:${ID}:c`]);
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
    assert.deepEqual(r.replyMarkup.inline_keyboard.map((row) => row[0]!.callback_data), [`pc:${ID}:r:0`, `pc:${ID}:r:1`, `pc:${ID}:r:2`, `pc:${ID}:c`]);
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
    assert.deepEqual(r.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data), [`pc:${ID}:c`]);
  });

  test("confirmable: a result and nothing left to ask", () => {
    assert.equal(confirmable(draft()), true);
    assert.equal(confirmable(draft({ result: {} })), false);
    assert.equal(confirmable(draft({ blocked: [{ key: "blocked.overlap", params: {} }] })), false);
    assert.equal(confirmable(draft({ unresolved: [{}] })), false);
  });
});
