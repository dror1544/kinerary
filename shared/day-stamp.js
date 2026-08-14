// A day headline routinely opens with a stamp of its own date —
// "Thu 13/8 — Diamond Head", "ה׳ 13/8 — דיאמונד הד". Move that day and the
// stamp is wrong, while the description after it is still perfectly good.
//
// This is arithmetic, not judgement, so it belongs in code. Two real incidents
// came from treating it as a language problem: a swap left 13/8 announcing
// "Fri 14/8", and a model asked to repair the stamps repaired them AND handed
// each day the other day's description, half-undoing the swap it was called to
// tidy up after. A model is never asked to do this again.
//
// Imported by server.js (CommonJS require) and the test suite (ESM import),
// same arrangement as shared/needs-schema.js.

// Hebrew names weekdays by letter: א׳ = Sunday … ש׳ = Saturday. Index is
// JS getDay(), so the array position IS the weekday number.
const HE_WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const EN_SHORT    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_LONG     = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Weekday token, then d/m, then a dash. The description after the dash is
// captured whole and never touched — that is the part a person wrote.
// Anchored to the start: a date mentioned mid-sentence is prose, not a stamp.
const STAMP_RE = new RegExp(
  '^\\s*'
  + '(?:(?<wd>[A-Za-z]{3,9}|[\\u05D0-\\u05EA]\\u05F3?)\\s+)?'   // weekday, optional
  + '(?<d>\\d{1,2})\\s*/\\s*(?<m>\\d{1,2})'                      // 13/8
  + '\\s*(?<sep>[\\u2014\\u2013-])\\s*'                          // — – -
  + '(?<rest>[\\s\\S]*)$'
);

// Noon avoids every timezone/DST edge that makes a bare YYYY-MM-DD land on the
// previous day in some environments.
function weekdayIndex(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

/**
 * Rebuild a headline's leading date stamp from the date it actually sits on.
 *
 * Returns the corrected label, or null when there is nothing to do — no stamp,
 * an unparseable date, or a stamp that is already right. Null means "leave it
 * alone", so a caller can treat any string result as a real change.
 */
function repairDayStamp(label, isoDate) {
  if (typeof label !== 'string' || !label.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return null;
  const m = STAMP_RE.exec(label);
  if (!m) return null;

  const wdIndex = weekdayIndex(isoDate);
  if (wdIndex === null) return null;
  const [, month, day] = isoDate.split('-').map(Number);

  // Keep whatever convention the author used — Hebrew letter, "Thu", "Thursday"
  // — rather than imposing one. Only the value is wrong, never the style.
  let weekday = '';
  const found = m.groups.wd;
  if (found) {
    if (/^[א-ת]/.test(found)) {
      weekday = `${HE_WEEKDAYS[wdIndex]}׳`;
    } else if (found.length > 3) {
      weekday = EN_LONG[wdIndex];
    } else {
      weekday = EN_SHORT[wdIndex];
    }
  }

  const stamp = `${weekday ? weekday + ' ' : ''}${day}/${month}`;
  const rebuilt = `${stamp} ${m.groups.sep} ${m.groups.rest}`.trim();
  return rebuilt === label.trim() ? null : rebuilt;
}

/** True when the label carries a leading stamp at all. */
function hasDayStamp(label) {
  return typeof label === 'string' && STAMP_RE.test(label);
}

module.exports = { repairDayStamp, hasDayStamp, HE_WEEKDAYS, EN_SHORT, EN_LONG };
