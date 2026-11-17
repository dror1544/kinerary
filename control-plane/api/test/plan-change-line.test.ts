import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_LINES, cleanTitle, dayInZone, minutesInZone, renderPlanChangeLine, type PlanChange } from "../src/plan-change-line.js";

// Video Release 1C, "The line" (docs/specs/sprint-9/x-video-r1-group-line.md), as Dror changed it on 2026-11-17:
// every template is NOUN-LED so it agrees with any title (no Hebrew "עבר"/"עברה"), and a date is always written as
// the weekday AND the date ("Thursday, Dec 3" / "יום חמישי, 3 בדצמבר"), never a bare weekday and never YYYY-MM-DD.
// 2026-12-03 is a Thursday; "now" is 14:00 in Paris, in a process that is not in Paris.
const NOW = new Date("2026-12-03T13:00:00Z");
const opts = (language: "en" | "he" = "en") => ({ language, timeZone: "Europe/Paris", now: NOW });

const change = (over: Partial<PlanChange> & { kind: PlanChange["kind"] }): PlanChange => ({
  fields: [], date: "2026-12-03", time: "19:00", text_en: "Dinner", text_he: "ארוחת ערב", ...over,
});
const render = (changes: PlanChange[], language: "en" | "he" = "en") => renderPlanChangeLine(changes, opts(language));

// A masculine and a feminine Hebrew title: the same template must read right for both.
const MASCULINE = { text_en: "Museum visit", text_he: "ביקור במוזיאון" };
const FEMININE = { text_en: "Dinner", text_he: "ארוחת ערב" };

describe("one change is its line alone (the table)", () => {
  test("a time change: 'Plan change: <title> — now at 19:30'", () => {
    const c = change({ kind: "updated", fields: ["time"], time: "19:30", previous_time: "20:00" });
    assert.equal(render([c]), "Plan change: Dinner — now at 19:30 (was 20:00)");
    assert.equal(render([{ ...c, ...FEMININE }], "he"), "שינוי בתוכנית: ארוחת ערב — עכשיו ב-19:30 (במקום 20:00)");
    assert.equal(render([{ ...c, ...MASCULINE }], "he"), "שינוי בתוכנית: ביקור במוזיאון — עכשיו ב-19:30 (במקום 20:00)");
  });

  test("a date change 10 days ahead says the weekday AND the date, in both languages", () => {
    const c = change({ kind: "updated", fields: ["date"], date: "2026-12-13", previous_date: "2026-12-10", time: "20:00" });
    assert.equal(render([c]), "Plan change: Dinner — now on Sunday, Dec 13 (was Thursday, Dec 10)");
    assert.equal(render([{ ...c, ...FEMININE }], "he"), "שינוי בתוכנית: ארוחת ערב — עכשיו ביום ראשון, 13 בדצמבר (במקום יום חמישי, 10 בדצמבר)");
    assert.equal(render([{ ...c, ...MASCULINE }], "he"), "שינוי בתוכנית: ביקור במוזיאון — עכשיו ביום ראשון, 13 בדצמבר (במקום יום חמישי, 10 בדצמבר)");
  });

  test("date and time together", () => {
    const c = change({ kind: "updated", fields: ["time", "date"], date: "2026-12-13", previous_date: "2026-12-10", time: "19:00", previous_time: "20:00" });
    assert.equal(render([c]), "Plan change: Dinner — now on Sunday, Dec 13 at 19:00 (was Thursday, Dec 10 at 20:00)");
    assert.equal(render([{ ...c, ...FEMININE }], "he"), "שינוי בתוכנית: ארוחת ערב — עכשיו ביום ראשון, 13 בדצמבר, ב-19:00 (במקום יום חמישי, 10 בדצמבר, ב-20:00)");
    assert.equal(render([{ ...c, ...MASCULINE }], "he"), "שינוי בתוכנית: ביקור במוזיאון — עכשיו ביום ראשון, 13 בדצמבר, ב-19:00 (במקום יום חמישי, 10 בדצמבר, ב-20:00)");
  });

  test("added, with its day (weekday and date) and time", () => {
    const c = change({ kind: "added", date: "2026-12-13", time: "16:00", text_en: "Winery visit", text_he: "ביקור ביקב" });
    assert.equal(render([c]), "Added to the plan: Winery visit — on Sunday, Dec 13 at 16:00");
    assert.equal(render([c], "he"), "תוספת לתוכנית: ביקור ביקב — ביום ראשון, 13 בדצמבר, ב-16:00");
    assert.equal(render([{ ...c, ...FEMININE }], "he"), "תוספת לתוכנית: ארוחת ערב — ביום ראשון, 13 בדצמבר, ב-16:00");
  });

  test("removed, with the day it had", () => {
    const c = change({ kind: "removed", date: "2026-12-13" });
    assert.equal(render([c]), "Removed from the plan: Dinner (Sunday, Dec 13)");
    assert.equal(render([{ ...c, ...FEMININE }], "he"), "הסרה מהתוכנית: ארוחת ערב (יום ראשון, 13 בדצמבר)");
    assert.equal(render([{ ...c, ...MASCULINE }], "he"), "הסרה מהתוכנית: ביקור במוזיאון (יום ראשון, 13 בדצמבר)");
  });

  test("a title, place or type change says the details changed, and when the item is", () => {
    for (const field of ["title", "place", "type"]) {
      const c = change({ kind: "updated", fields: [field], date: "2026-12-13", ...MASCULINE });
      assert.equal(render([c]), "Plan change: Museum visit — details updated (Sunday, Dec 13)");
      assert.equal(render([c], "he"), "שינוי בתוכנית: ביקור במוזיאון — עדכון פרטים (יום ראשון, 13 בדצמבר)");
      assert.equal(render([{ ...c, ...FEMININE }], "he"), "שינוי בתוכנית: ארוחת ערב — עדכון פרטים (יום ראשון, 13 בדצמבר)");
    }
  });
});

describe("Hebrew never uses a verb that has to agree with the title (Dror, 2026-11-17)", () => {
  test("no template, for a masculine or a feminine title, contains 'עבר'/'עברה'/'נוסף'/'בוטל'/'עודכן'", () => {
    const shapes: PlanChange[] = [
      change({ kind: "updated", fields: ["time"], previous_time: "20:00" }),
      change({ kind: "updated", fields: ["date"], date: "2026-12-13", previous_date: "2026-12-10" }),
      change({ kind: "updated", fields: ["time", "date"], date: "2026-12-13", previous_date: "2026-12-10", previous_time: "20:00" }),
      change({ kind: "updated", fields: ["title"] }),
      change({ kind: "added" }),
      change({ kind: "removed" }),
    ];
    for (const shape of shapes) {
      for (const title of [MASCULINE, FEMININE]) {
        const out = render([{ ...shape, ...title }], "he")!;
        for (const verb of ["עבר", "עברה", "נוסף", "בוטל", "עודכן", "הועבר", "הועברה"]) {
          assert.ok(!out.split(/[\s,:()—]+/).includes(verb), `${verb} in: ${out}`);
        }
      }
    }
  });

  test("the same holds in a list: the heading is a noun too", () => {
    const out = render([change({ kind: "updated", fields: ["time"], previous_time: "20:00", ...MASCULINE }), change({ kind: "added", ...FEMININE })], "he")!;
    assert.equal(out.split("\n")[0], "עדכון בתוכנית");
  });
});

describe("a date is always the date (Dror, 2026-11-17)", () => {
  test("never a bare weekday, never YYYY-MM-DD", () => {
    const shapes: PlanChange[] = [
      change({ kind: "updated", fields: ["date"], date: "2026-12-13", previous_date: "2026-12-10" }),
      change({ kind: "updated", fields: ["time", "date"], date: "2026-12-13", previous_date: "2026-12-10", previous_time: "20:00" }),
      change({ kind: "added", date: "2026-12-13" }),
      change({ kind: "removed", date: "2026-12-13" }),
      change({ kind: "updated", fields: ["title"], date: "2026-12-13" }),
    ];
    for (const language of ["en", "he"] as const) {
      for (const shape of shapes) {
        const out = render([shape], language)!;
        assert.ok(!/\d{4}-\d{2}-\d{2}/.test(out), `ISO date in: ${out}`);
        assert.match(out, language === "en" ? /Sunday, Dec 13/ : /יום ראשון, 13 בדצמבר/, out);
      }
    }
  });

  test("a different month and a Saturday", () => {
    const c = change({ kind: "removed", date: "2027-01-02" });
    assert.equal(render([c]), "Removed from the plan: Dinner (Saturday, Jan 2)");
    assert.equal(render([c], "he"), "הסרה מהתוכנית: ארוחת ערב (יום שבת, 2 בינואר)");
  });
});

describe("today and tomorrow, in the TRIP's day, keep the date beside them", () => {
  test("replace the weekday when they apply, and still say the date", () => {
    assert.equal(render([change({ kind: "added", date: "2026-12-03", time: "16:00" })]), "Added to the plan: Dinner — today (Thursday, Dec 3) at 16:00");
    assert.equal(render([change({ kind: "added", date: "2026-12-04", time: "16:00" })]), "Added to the plan: Dinner — tomorrow (Friday, Dec 4) at 16:00");
    assert.equal(render([change({ kind: "removed", date: "2026-12-04" })], "he"), "הסרה מהתוכנית: ארוחת ערב (יום שישי, 4 בדצמבר)");
    assert.equal(
      render([change({ kind: "updated", fields: ["date"], date: "2026-12-04", previous_date: "2026-12-03" })]),
      "Plan change: Dinner — now tomorrow (Friday, Dec 4) (was Thursday, Dec 3)",
    );
  });

  test("AC-16: the day is the trip's, not the process's — 23:30 in Paris is still Thursday there and Friday in Tokyo", () => {
    const lateParis = new Date("2026-12-03T22:30:00Z"); // 23:30 in Paris, 07:30 on Friday in Tokyo
    const c = change({ kind: "added", date: "2026-12-03", time: "23:45" });
    assert.equal(renderPlanChangeLine([c], { language: "en", timeZone: "Europe/Paris", now: lateParis }), "Added to the plan: Dinner — today (Thursday, Dec 3) at 23:45");
    assert.equal(renderPlanChangeLine([c], { language: "en", timeZone: "Asia/Tokyo", now: lateParis }), "Added to the plan: Dinner — on Thursday, Dec 3 at 23:45");
    assert.equal(dayInZone(lateParis, "Europe/Paris"), "2026-12-03");
    assert.equal(dayInZone(lateParis, "Asia/Tokyo"), "2026-12-04");
    assert.equal(minutesInZone(lateParis, "Europe/Paris"), 23 * 60 + 30);
    assert.equal(minutesInZone(lateParis, "Not/AZone"), 22 * 60 + 30, "an unusable zone reads as UTC");
  });
});

describe("times", () => {
  test("a rough-time word is used as the site gives it", () => {
    const c = change({ kind: "updated", fields: ["time"], time: "evening", previous_time: "noon" });
    assert.equal(render([c]), "Plan change: Dinner — now in the evening (was Noon)");
    assert.equal(render([c], "he"), "שינוי בתוכנית: ארוחת ערב — עכשיו בערב (במקום צהריים)");
  });

  test("no time before the change reads 'any time'", () => {
    const c = change({ kind: "updated", fields: ["time"], time: "19:00", previous_time: null });
    assert.equal(render([c]), "Plan change: Dinner — now at 19:00 (was any time)");
    assert.equal(render([c], "he"), "שינוי בתוכנית: ארוחת ערב — עכשיו ב-19:00 (במקום בכל שעה)");
  });

  test("an added item with no time has none in its line", () => {
    assert.equal(render([change({ kind: "added", date: "2026-12-13", time: null })]), "Added to the plan: Dinner — on Sunday, Dec 13");
  });
});

describe("the title is the item's text in the trip's language, falling back to the other", () => {
  test("falls back", () => {
    const c = change({ kind: "added", date: "2026-12-13", time: null, text_he: null });
    assert.equal(render([c], "he"), "תוספת לתוכנית: Dinner — ביום ראשון, 13 בדצמבר");
    assert.equal(render([change({ kind: "added", date: "2026-12-13", time: null, text_en: "" })]), "Added to the plan: ארוחת ערב — on Sunday, Dec 13");
  });

  test("an item with no title at all is not put into words, and a message of nothing is null", () => {
    assert.equal(render([change({ kind: "added", text_en: null, text_he: null })]), null);
    assert.equal(render([]), null);
  });
});

describe("several changes are one message", () => {
  const winery = change({ kind: "added", date: "2026-12-05", time: "16:00", text_en: "Winery visit", text_he: "ביקור ביקב" });
  const dinner = change({ kind: "updated", fields: ["time"], previous_time: "20:00" });

  test("AC-12: a heading and one line each, in plan order (day, then time), however they arrived", () => {
    assert.equal(
      render([winery, dinner]),
      "Plan update\nDinner — now at 19:00 (was 20:00)\nAdded to the plan: Winery visit — on Saturday, Dec 5 at 16:00",
    );
    assert.equal(
      render([winery, dinner], "he"),
      "עדכון בתוכנית\nארוחת ערב — עכשיו ב-19:00 (במקום 20:00)\nתוספת לתוכנית: ביקור ביקב — ביום שבת, 5 בדצמבר, ב-16:00",
    );
  });

  test("AC-19: more than five lines is five and '+N more on the trip site'", () => {
    const seven = Array.from({ length: 7 }, (_, i) => change({ kind: "added", date: "2026-12-13", time: `1${i}:00`, text_en: `Thing ${i}`, text_he: `דבר ${i}` }));
    const out = render(seven)!.split("\n");
    assert.equal(out.length, 1 + MAX_LINES + 1);
    assert.equal(out[0], "Plan update");
    assert.equal(out[1], "Added to the plan: Thing 0 — on Sunday, Dec 13 at 10:00");
    assert.equal(out.at(-1), "+2 more on the trip site");
    assert.equal(render(seven, "he")!.split("\n").at(-1), "ועוד 2 באתר הטיול");
  });

  test("exactly five lines has no '+N more'", () => {
    const five = Array.from({ length: 5 }, (_, i) => change({ kind: "added", date: "2026-12-13", time: `1${i}:00`, text_en: `Thing ${i}` }));
    assert.ok(!render(five)!.includes("more on the trip site"));
  });

  test("one unwordable change among several leaves the others", () => {
    assert.equal(render([change({ kind: "added", text_en: null, text_he: null }), dinner]), "Plan change: Dinner — now at 19:00 (was 20:00)");
  });
});

describe("AC-28: what a person typed is data, and no person is in the line", () => {
  test("a title is folded to one line, stripped of hidden and direction-changing characters, and bounded", () => {
    assert.equal(cleanTitle("  Wine\n\tcellar ‮ tour​  "), "Wine cellar tour");
    assert.equal(cleanTitle("a".repeat(200)).length, 80);
    assert.ok(cleanTitle("a".repeat(200)).endsWith("…"));
    assert.equal(cleanTitle(42), "");
    assert.equal(cleanTitle(null), "");
  });

  test("a hostile title stays inside one line of plain text: it cannot start a second line or smuggle a heading", () => {
    const c = change({ kind: "added", date: "2026-12-13", time: "16:00", text_en: "Tour\nPlan update\nRemoved: everything <b>x</b>" });
    const out = render([c])!;
    assert.equal(out.split("\n").length, 1);
    assert.equal(out, "Added to the plan: Tour Plan update Removed: everything <b>x</b> — on Sunday, Dec 13 at 16:00");
  });

  test("the input type has no place for an author, a note, a booking, a cost or a need, and extras never reach the text", () => {
    const hostile = {
      ...change({ kind: "updated", fields: ["time"], previous_time: "20:00" }),
      author: "hermes-secret-name", created_by: "alice-secret", note: "private note", confirmation: "ABC123", cost: "999", participant_needs: "celiac",
    } as PlanChange;
    const out = render([hostile])!;
    for (const secret of ["hermes-secret-name", "alice-secret", "private note", "ABC123", "999", "celiac"]) assert.ok(!out.includes(secret), secret);
    assert.equal(out, "Plan change: Dinner — now at 19:00 (was 20:00)");
  });
});
