/**
 * A day written in words or with separators, made into `YYYY-MM-DD` — only when the year is written too.
 *
 * Why it exists: the trip's dates are read by the worker as ISO and nothing else. On 2026-11-08 a return date
 * typed at the summary ("actually we fly back on 22 November") was stored as the organizer's Hebrew words, and the
 * trip card, the slug and the site's dates all went wrong with no error anywhere. `validateAnswer` therefore holds
 * the two date questions to this reader: what it can read is stored as ISO, what it cannot is refused and asked
 * again. It is not a general date parser and does not guess:
 *   - a year must be written (a year-less day would need a guess, and a wrong year is a wrong trip);
 *   - "3/4/2026" is read only when both orders agree (day and month equal) or one of them cannot be a month;
 *   - the day must exist (31 June is no day).
 * `yearless-dates.ts` pairs a weekday with a year-less day and `document-dates.ts` completes `--MM-DD`; neither
 * reads a full date in words, so this is its own small reader. Pure: no clock, no model.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const EN_FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/** 1..12 for a month name or abbreviation in English or Hebrew ("בנובמבר" too), else null. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  const hebrew = HE_MONTHS.indexOf(w);
  if (hebrew >= 0) return hebrew + 1;
  const prefixed = HE_MONTHS.indexOf(w.replace(/^ב/u, ""));
  if (prefixed >= 0 && w.startsWith("ב")) return prefixed + 1;
  if (/^[a-z]{3,9}$/.test(w)) {
    const at = EN_FULL.findIndex((full) => full.startsWith(w) || (w === "sept" && full === "september"));
    if (at >= 0) return at + 1;
  }
  return null;
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

const WORD = "([\\p{L}]{3,9}\\.?)";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(\\d{4})";
// "ה-22 בנובמבר", "on the 22nd of November"
const LEAD = "(?:on\\s+)?(?:the\\s+)?(?:[הבל]-?)?";
const SEP = "[\\s,.\\-]*";

const DAY_MONTH_YEAR = new RegExp(`^${LEAD}${DAY}${SEP}(?:of\\s+)?${WORD}${SEP}${YEAR}$`, "iu");
const MONTH_DAY_YEAR = new RegExp(`^${WORD}\\s*${DAY}${SEP}${YEAR}$`, "iu");
const NUMERIC = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/;
const YEAR_FIRST = /^(\d{4})[./](\d{1,2})[./](\d{1,2})$/;

/**
 * `YYYY-MM-DD` for a day written with its year, or null. An ISO day comes back unchanged (and a non-day like
 * 2026-02-31 is null).
 */
export function readFullDate(input: string): string | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > 40) return null;

  const isoMatch = ISO.exec(text);
  if (isoMatch) return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst) return iso(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));

  const numeric = NUMERIC.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = Number(numeric[3]);
    // Day first only when it cannot be anything else; both readings are one when a === b.
    if (a === b) return iso(year, b, a);
    if (a > 12 && b <= 12) return iso(year, b, a);
    if (b > 12 && a <= 12) return iso(year, a, b);
    return null;
  }

  const dayFirst = DAY_MONTH_YEAR.exec(text);
  if (dayFirst) {
    const month = monthOf(dayFirst[2]!);
    return month === null ? null : iso(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }
  const monthFirst = MONTH_DAY_YEAR.exec(text);
  if (monthFirst) {
    const month = monthOf(monthFirst[1]!);
    return month === null ? null : iso(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  return null;
}

// A day and a month with NO year: "22 בנובמבר", "ב-22 בנובמבר", "22 November", "Nov 22", "22nd of November".
const DAY_MONTH = new RegExp(`^${LEAD}${DAY}${SEP}(?:of\\s+)?${WORD}$`, "iu");
const MONTH_DAY = new RegExp(`^${WORD}\\s*${DAY}$`, "iu");
// "22/11", "22.11" - read only when it cannot be month-first ("3/4" could be either, and is not read).
const NUMERIC_SHORT = /^(\d{1,2})[./-](\d{1,2})$/;

/** The day and month of a date written WITHOUT its year, or null (including when the order is ambiguous). */
export function readDayMonth(input: string): { month: number; day: number } | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > 40) return null;
  const numeric = NUMERIC_SHORT.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    if (a === b) return a >= 1 && a <= 12 ? { month: b, day: a } : null;
    if (a > 12 && b <= 12) return { month: b, day: a };
    if (b > 12 && a <= 12) return { month: a, day: b };
    return null;
  }
  const dayFirst = DAY_MONTH.exec(text);
  if (dayFirst) {
    const month = monthOf(dayFirst[2]!);
    return month === null ? null : { month, day: Number(dayFirst[1]) };
  }
  const monthFirst = MONTH_DAY.exec(text);
  if (monthFirst) {
    const month = monthOf(monthFirst[1]!);
    return month === null ? null : { month, day: Number(monthFirst[2]) };
  }
  return null;
}

/** A trip is not longer than this; a year-less day that would make it so was mistyped, not placed. */
const MAX_SPAN_DAYS = 366;

/**
 * The ISO day for a year-less day and month, placed by an anchor the organizer already gave or by today.
 * "onOrAfter": the first such day not before the anchor (a return after the departure; a departure after today).
 * "onOrBefore": the last such day not after it (a departure before the held return).
 * Null when the day does not exist in any nearby year, or the placement lands more than a year from the anchor.
 */
export function placeYearlessDay(
  dm: { month: number; day: number },
  anchor: string,
  direction: "onOrAfter" | "onOrBefore",
): string | null {
  const anchorYear = Number(anchor.slice(0, 4));
  if (!Number.isInteger(anchorYear)) return null;
  const years = direction === "onOrAfter"
    ? [0, 1, 2, 3, 4].map((n) => anchorYear + n)
    : [0, 1, 2, 3, 4].map((n) => anchorYear - n);
  for (const year of years) {
    const day = iso(year, dm.month, dm.day);
    if (day === null) continue;
    if (direction === "onOrAfter" ? day < anchor : day > anchor) continue;
    const span = Math.abs(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000;
    return span <= MAX_SPAN_DAYS ? day : null;
  }
  return null;
}

/** Whether an answer reads as an attempt at a date — a digit or a month word — rather than a placeholder. */
export function looksLikeDate(text: string): boolean {
  if (/\d/.test(text)) return true;
  return text.split(/[\s,.\-]+/u).some((w) => w.length >= 3 && monthOf(w) !== null);
}
