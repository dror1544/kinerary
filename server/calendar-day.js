// A plan date a caller SENDS must be a day on the calendar (second boundary
// re-check of PR #373, 2026-10-12). The plan routes outside the stop layer
// checked only the shape, so 2027-02-30, 2027-13-01, 0000-00-00, 2027-04-31
// and 9999-99-99 filed rows on days that do not exist — and a later narrowing
// of the stop was refused with a list of them.
//
// Its own module because server/living-journey.js cannot require
// server/trip-structure.js (which requires it: a cycle), and the Classic plan
// handlers in server/server.js use it too. The stop layer keeps its own
// isCalendarDay (trip-structure.js) unchanged; this one also refuses year 0000,
// which no trip is planned in.
//
// Write-time only: nothing on the read path calls it, so a row an older server
// stored on an impossible day is read back as it is and never fails a read.
'use strict';

const SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_DAY_DETAIL = 'a date is YYYY-MM-DD and a real day on the calendar: month 01-12, a day that month has, year 0001-9999';

// Exactly YYYY-MM-DD, nothing after it, and the same day after a round trip
// through the calendar: Date.parse('2027-02-30') is a valid time (it rolls
// over to March 2), so the shape and the parse are not enough on their own.
function isCalendarDay(value) {
  if (typeof value !== 'string' || !SHAPE_RE.test(value) || value.startsWith('0000')) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

module.exports = { isCalendarDay, CALENDAR_DAY_DETAIL };
