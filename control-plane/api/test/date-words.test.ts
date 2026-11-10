import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { looksLikeDate, placeYearlessDay, readDayMonth, readFullDate } from "../src/date-words.js";

describe("readFullDate", () => {
  test("reads a day written with its year, in either language", () => {
    for (const [text, want] of [
      ["2026-11-22", "2026-11-22"],
      ["22 בנובמבר 2026", "2026-11-22"],
      ["22 בנובמבר, 2026", "2026-11-22"],
      ["ה-22 בנובמבר 2026", "2026-11-22"],
      ["ב-22 בנובמבר 2026", "2026-11-22"],
      ["22 November 2026", "2026-11-22"],
      ["22nd of November 2026", "2026-11-22"],
      ["Nov 22, 2026", "2026-11-22"],
      ["November 22 2026", "2026-11-22"],
      ["22 Sept 2026", "2026-09-22"],
      ["22/11/2026", "2026-11-22"],
      ["22.11.2026", "2026-11-22"],
      ["11/22/2026", "2026-11-22"],
      ["5/5/2026", "2026-05-05"],
      ["2026/11/22", "2026-11-22"],
    ] as const) assert.equal(readFullDate(text), want, text);
  });

  test("refuses what it would have to guess", () => {
    for (const text of [
      "22 November", // no year
      "22 בנובמבר", // no year
      "3/4/2026", // day first or month first?
      "31 June 2026", // no such day
      "2026-02-31",
      "next week",
      "x",
      "",
      "22 Foo 2026",
    ]) assert.equal(readFullDate(text), null, text);
  });

  test("readDayMonth reads a day and month with no year, and refuses an ambiguous or impossible one", () => {
    assert.deepEqual(readDayMonth("22 בנובמבר"), { month: 11, day: 22 });
    assert.deepEqual(readDayMonth("ב-22 בנובמבר"), { month: 11, day: 22 });
    assert.deepEqual(readDayMonth("22nd of November"), { month: 11, day: 22 });
    assert.deepEqual(readDayMonth("Nov 22"), { month: 11, day: 22 });
    assert.deepEqual(readDayMonth("22/11"), { month: 11, day: 22 });
    assert.deepEqual(readDayMonth("5/5"), { month: 5, day: 5 });
    assert.equal(readDayMonth("3/4"), null);
    assert.equal(readDayMonth("22 November 2026"), null, "has a year: readFullDate's");
    assert.equal(readDayMonth("soon"), null);
  });

  test("placeYearlessDay: on or after / on or before an anchor, never a year away", () => {
    assert.equal(placeYearlessDay({ month: 11, day: 22 }, "2026-11-14", "onOrAfter"), "2026-11-22");
    assert.equal(placeYearlessDay({ month: 11, day: 10 }, "2026-11-14", "onOrAfter"), "2027-11-10");
    assert.equal(placeYearlessDay({ month: 11, day: 13 }, "2026-11-21", "onOrBefore"), "2026-11-13");
    assert.equal(placeYearlessDay({ month: 12, day: 28 }, "2027-01-03", "onOrBefore"), "2026-12-28");
    assert.equal(placeYearlessDay({ month: 2, day: 30 }, "2026-11-14", "onOrAfter"), null);
  });

  test("looksLikeDate separates an attempt from a placeholder", () => {
    assert.equal(looksLikeDate("22 בנובמבר"), true);
    assert.equal(looksLikeDate("November"), true);
    assert.equal(looksLikeDate("x"), false);
  });
});
