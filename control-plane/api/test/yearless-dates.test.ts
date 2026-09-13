import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { yearForWeekday, yearlessDateHints } from "../src/yearless-dates.js";

const MAY_2026 = new Date(Date.UTC(2026, 4, 23));

describe("yearlessDateHints", () => {
  test("a Booking.com print's check-in block, one word per line", () => {
    const text = "CHECK-IN\n23\nJULY\nThursday\n15:00 - 22:00\nCHECK-OUT\n25\nJULY\nSaturday\n06:00 - 11:00";
    assert.deepEqual(yearlessDateHints(text, MAY_2026), [
      { quote: "23 JULY Thursday", iso: "2026-07-23" },
      { quote: "25 JULY Saturday", iso: "2026-07-25" },
    ]);
  });

  test("a car rental's weekday, month and day", () => {
    assert.deepEqual(yearlessDateHints("Pick-up Sat, July 18 12:00 PM\nDrop-off Thu, July 30 10:00 PM", MAY_2026), [
      { quote: "Sat, July 18", iso: "2026-07-18" },
      { quote: "Thu, July 30", iso: "2026-07-30" },
    ]);
  });

  test("weekday, day and month; and month, day and weekday", () => {
    assert.deepEqual(yearlessDateHints("Arrive Thursday, 23rd July", MAY_2026), [{ quote: "Thursday, 23rd July", iso: "2026-07-23" }]);
    assert.deepEqual(yearlessDateHints("July 26, Sunday", MAY_2026), [{ quote: "July 26, Sunday", iso: "2026-07-26" }]);
  });

  test("Hebrew, with and without the ב prefix", () => {
    assert.deepEqual(yearlessDateHints("צ'ק-אין: יום חמישי, 23 ביולי", MAY_2026), [{ quote: "יום חמישי, 23 ביולי", iso: "2026-07-23" }]);
    assert.deepEqual(yearlessDateHints("25 יולי שבת", MAY_2026), [{ quote: "25 יולי שבת", iso: "2026-07-25" }]);
  });

  test("a date that already carries its year is left to the document", () => {
    assert.deepEqual(yearlessDateHints("Sunday, 12 July 2026", MAY_2026), []);
    assert.deepEqual(yearlessDateHints("Mon, Jul 6, 2026 2:00 PM", MAY_2026), []);
    assert.deepEqual(yearlessDateHints("2026 Thursday 23 July", MAY_2026), []);
  });

  test("a weekday that fits no year in the window gives no hint, never a guess", () => {
    // 23 July is a Wednesday only in 2025, which is before the window.
    assert.deepEqual(yearlessDateHints("Wednesday 23 July", MAY_2026), []);
    assert.deepEqual(yearlessDateHints("Monday 23 July", MAY_2026), []);
  });

  test("an impossible date gives no hint", () => {
    assert.deepEqual(yearlessDateHints("Thursday 31 June", MAY_2026), []);
  });

  test("the same date printed twice is one hint", () => {
    assert.equal(yearlessDateHints("Thu 23 Jul ... Thu 23 Jul", MAY_2026).length, 1);
  });

  test("words that only look like dates are not dates", () => {
    assert.deepEqual(yearlessDateHints("Room 12 may sat 3 people", MAY_2026), []);
    assert.deepEqual(yearlessDateHints("יום שני 12 בבוקר", MAY_2026), []);
  });
});

describe("yearForWeekday", () => {
  test("a leap day finds its leap year", () => {
    // 29 February 2028 is a Tuesday.
    assert.equal(yearForWeekday(29, 1, 2, MAY_2026), 2028);
  });

  test("over New Year: next January is in the window", () => {
    // 4 January 2027 is a Monday.
    assert.equal(yearForWeekday(4, 0, 1, new Date(Date.UTC(2026, 11, 20))), 2027);
  });

  test("at most one year fits across the window, whatever the date", () => {
    for (let month = 0; month < 12; month++) {
      for (let day = 1; day <= 31; day++) {
        for (let weekday = 0; weekday < 7; weekday++) {
          const year = yearForWeekday(day, month, weekday, MAY_2026);
          if (year !== null) assert.equal(new Date(Date.UTC(year, month, day)).getUTCDay(), weekday);
        }
      }
    }
  });
});
