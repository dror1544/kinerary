'use strict';
// #550 — which plan items claim the same time. Pure: no database, no request. The rule is in
// docs/specs/sprint-8/550-plan-overlap-conflicts.md; living-journey.js decides who is shown it.

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Minutes since midnight for an EXACT time only. A rough time ("morning") has a sort position
// but is not a time anyone is occupying, so it never conflicts.
function startMinutes(item) {
  if (typeof item.time !== 'string' || !HHMM_RE.test(item.time)) return null;
  const [h, m] = item.time.split(':').map(Number);
  return h * 60 + m;
}

// One physical flight, however many bookings are on it. Mirrors the plan board's rule
// (trip-web/src/same-flight.ts, #549), kept self-contained here: same flight number (an IATA-style
// designator then 1-4 digits at the START of the line, optionally after the word "flight") + same
// date + identical wording, case and spacing aside. Two couples booking separately on one flight
// make two plan items at one time; the group is on one plane, so that is not a conflict. A line
// with no flight number ("Museum 12", "Harbortown → Gatecity") is never skipped, and neither is a
// different leg on the same number: only provably the same flight is.
const FLIGHT_NUMBER = /^\s*(?:(?:flight|טיסה)\s+)?([A-Za-z][A-Za-z0-9]|[0-9][A-Za-z])\s?(\d{1,4})(?![\dA-Za-z])/i;
const FLIGHT_PREFIX = /^\s*(?:flight|טיסה)\s/i;

function flightNumberOf(...texts) {
  for (const text of texts) {
    const match = FLIGHT_NUMBER.exec(text || '');
    if (!match) continue;
    // Without the word "flight" in front, only an upper-case designator counts ("Go 12" is prose).
    if (!FLIGHT_PREFIX.test(text || '') && match[1] !== match[1].toUpperCase()) continue;
    return `${match[1]}${match[2]}`.toUpperCase();
  }
  return null;
}

// null when the item is not a flight line: it needs a flight number AND a route marker, a flight
// booking, or the travel type.
function flightKey(item) {
  if (!item.date) return null;
  const number = flightNumberOf(item.text_en, item.text_he);
  if (!number) return null;
  const route = /[→←↔]|->|\bto\b|\bfrom\b/i.test(`${item.text_en || ''} ${item.text_he || ''}`);
  if (!route && item.booking?.type !== 'flight' && item.item_type !== 'travel') return null;
  const wording = (item.text_en || item.text_he || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${String(item.date).slice(0, 10)}|${number}|${wording}`;
}

function sameFlight(a, b) {
  const key = flightKey(a);
  return key !== null && key === flightKey(b);
}

function endMinutes(item, start) {
  const d = Number(item.duration_minutes);
  return start + (Number.isFinite(d) && d > 0 ? d : 0);
}

// Two items meet when they start together, or when one starts before the other has ended.
// Touching ranges (one ends as the next begins) do not meet.
function meets(a, b) {
  if (a.start === b.start) return true;
  return a.start < b.end && b.start < a.end;
}

/**
 * The identity of a conflict, for acceptance. Items are ordered by uid so the same pair is the same
 * key whichever is named first; the date and BOTH times are in it, so moving either item is a
 * different conflict and is raised on its own terms.
 */
function conflictKey(a, b) {
  const [x, y] = String(a.item_uid) < String(b.item_uid) ? [a, b] : [b, a];
  return JSON.stringify([x.item_uid, y.item_uid, x.date, x.time, y.time]);
}

/**
 * Map of item_uid -> the other items it conflicts with ({ item_uid, text_he, text_en, time, key }).
 * Items with no conflict are absent. `items` are itinerary items (item_uid, phase_id, date, time,
 * duration_minutes, booking_id, text_he, text_en).
 */
function findPlanConflicts(items) {
  const byDay = new Map();
  for (const item of items || []) {
    if (!item || !item.date) continue;
    const start = startMinutes(item);
    if (start === null) continue;
    const key = `${item.phase_id}\u001f${item.date}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ item, start, end: endMinutes(item, start) });
  }
  const out = new Map();
  const note = (from, to) => {
    if (!out.has(from.item_uid)) out.set(from.item_uid, []);
    out.get(from.item_uid).push({
      item_uid: to.item_uid,
      text_he: to.text_he ?? null,
      text_en: to.text_en ?? null,
      time: to.time,
      key: conflictKey(from, to),
    });
  };
  for (const day of byDay.values()) {
    for (let i = 0; i < day.length; i++) {
      for (let j = i + 1; j < day.length; j++) {
        const a = day[i], b = day[j];
        // One reservation is one claim on the time, not two (a booking's own legs).
        if (a.item.booking_id != null && a.item.booking_id === b.item.booking_id) continue;
        if (sameFlight(a.item, b.item)) continue;
        if (!meets(a, b)) continue;
        note(a.item, b.item);
        note(b.item, a.item);
      }
    }
  }
  return out;
}

module.exports = { findPlanConflicts, conflictKey, flightNumberOf };
