/**
 * day-stamp.test.js — shared/day-stamp.js.
 *
 * A headline that opens with its own date ("Thu 13/8 — Diamond Head") goes
 * wrong the moment the day moves. Two real incidents came from treating that as
 * something a model should sort out: a swap left 13/8 announcing "Fri 14/8",
 * and a model asked to repair the stamps repaired them and ALSO handed each day
 * the other day's description, half-undoing the swap. It is arithmetic. It
 * lives in code, and these are its edges.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { repairDayStamp, hasDayStamp } = require('../shared/day-stamp.js');

// 2026-08-13 is a Thursday; 2026-08-14 a Friday; 2026-09-06 a Sunday.
describe('repairDayStamp()', () => {
  test('rewrites the day and month to the date it now sits on', () => {
    assert.equal(
      repairDayStamp('Fri 14/8 — Southeast Oʻahu + beach', '2026-08-13'),
      'Thu 13/8 — Southeast Oʻahu + beach');
  });

  test('does the same in Hebrew, keeping the letter convention', () => {
    assert.equal(
      repairDayStamp('ו׳ 14/8 — דרום־מזרח אואהו', '2026-08-13'),
      'ה׳ 13/8 — דרום־מזרח אואהו');
  });

  test('repairs a day number that is nonsense, as seen in the real data', () => {
    // "+31 applied to the text without normalising the month" — the japan trip
    // had seven of these.
    assert.equal(
      repairDayStamp('Sun 37/9 — Arrival · Asakusa', '2026-09-06'),
      'Sun 6/9 — Arrival · Asakusa');
  });

  test('leaves a stamp that is already right completely alone', () => {
    assert.equal(repairDayStamp('Thu 13/8 — Diamond Head', '2026-08-13'), null);
    assert.equal(repairDayStamp('ה׳ 13/8 — דיאמונד הד', '2026-08-13'), null);
  });

  test('never touches the description, only the stamp', () => {
    const out = repairDayStamp('Mon 1/1 — Ginza — Itoya, Muji — quality lunch', '2026-08-14');
    assert.equal(out, 'Fri 14/8 — Ginza — Itoya, Muji — quality lunch',
      'only the first dash separates the stamp; the rest is the author\'s text');
  });

  test('keeps the weekday style it was given', () => {
    assert.equal(repairDayStamp('Thursday 1/1 — X', '2026-08-14'), 'Friday 14/8 — X');
    assert.equal(repairDayStamp('Thu 1/1 — X', '2026-08-14'), 'Fri 14/8 — X');
  });

  test('handles a stamp with no weekday at all', () => {
    assert.equal(repairDayStamp('1/1 — X', '2026-08-14'), '14/8 — X');
  });

  test('ignores a headline with no stamp', () => {
    assert.equal(repairDayStamp('Diamond Head + Waikiki', '2026-08-13'), null);
    assert.equal(repairDayStamp('', '2026-08-13'), null);
    assert.equal(repairDayStamp(null, '2026-08-13'), null);
  });

  test('a date mentioned mid-sentence is prose, not a stamp', () => {
    assert.equal(repairDayStamp('Tickets are for 14/8 — bring the passes', '2026-08-13'),
      null, 'the stamp must be anchored at the start');
  });

  test('refuses to guess when the date is unusable', () => {
    assert.equal(repairDayStamp('Thu 13/8 — X', 'not-a-date'), null);
    assert.equal(repairDayStamp('Thu 13/8 — X', ''), null);
  });

  test('is stable across a timezone that would shift a bare date', () => {
    // Parsed at noon UTC precisely so this cannot land on the previous day.
    assert.equal(repairDayStamp('Mon 1/1 — X', '2026-08-13'), 'Thu 13/8 — X');
  });
});

describe('hasDayStamp()', () => {
  test('recognises the shapes that appear in real trips', () => {
    for (const s of ['Thu 13/8 — X', 'ה׳ 13/8 — X', '13/8 — X', 'Sun 37/9 — X']) {
      assert.equal(hasDayStamp(s), true, s);
    }
  });
  test('and rejects what is not one', () => {
    for (const s of ['Diamond Head', 'we land on 14/8', '', null]) {
      assert.equal(hasDayStamp(s), false, String(s));
    }
  });
});
