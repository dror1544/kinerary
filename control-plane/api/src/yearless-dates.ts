/**
 * Dates a document prints with a weekday but no year, and the one year that fits.
 *
 * Booking.com's print version shows a stay as "CHECK-IN / 23 / JULY / Thursday"
 * with no year anywhere near it, and car rentals say "Pick-up Sat, July 18". The
 * extraction prompt forbids guessing a year, correctly — a wrong year is a wrong
 * trip — so those stays were left out every time: 0 of 4 runs kept two
 * such hotel stays on 2026-09-13, while the same hotel prints that
 * happened to mention the year in a cancellation deadline were kept.
 *
 * The weekday settles it, and settling it is arithmetic, not judgement. A date
 * moves one or two weekdays a year, so across this year and the next two it
 * falls on a given weekday at most once. Done here rather than asked of the
 * model because models are unreliable at calendar arithmetic, and this has to
 * be right every time or not at all: no year fits, no hint.
 */

export interface YearlessDateHint {
  /** The words as the document prints them, whitespace collapsed. */
  quote: string;
  iso: string;
}

/** Years tried, counted from today's: plans are for this year or the next two. */
const YEARS_AHEAD = 2;
const MAX_HINTS = 30;

const EN_MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const EN_WEEKDAY = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const HE_MONTH = "ב?(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)";
// "יום" is required: "שני" alone is also "second", and a bare Hebrew weekday
// word is far more often something else. Saturday is the one said without it.
const HE_WEEKDAY = "(?:יום\\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי)|(שבת))";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const GAP = "[\\s,.]{1,6}";
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";

const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const EN_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const HE_WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

type Order = "wdm" | "wmd" | "dmw" | "mdw";

interface Pattern {
  re: RegExp;
  order: Order;
  hebrew: boolean;
}

const pattern = (parts: string[], order: Order, hebrew: boolean): Pattern => ({
  re: new RegExp(`${START}${parts.join(GAP)}${END}`, "giu"),
  order,
  hebrew,
});

const PATTERNS: Pattern[] = [
  pattern([EN_WEEKDAY, DAY, EN_MONTH], "wdm", false),
  pattern([EN_WEEKDAY, EN_MONTH, DAY], "wmd", false),
  pattern([DAY, EN_MONTH, EN_WEEKDAY], "dmw", false),
  pattern([EN_MONTH, DAY, EN_WEEKDAY], "mdw", false),
  pattern([HE_WEEKDAY, DAY, HE_MONTH], "wdm", true),
  pattern([DAY, HE_MONTH, HE_WEEKDAY], "dmw", true),
];

/** A four-digit year right beside the match means the document gave the year. */
const YEAR_AFTER = /^[\s,.]{0,6}(?:19|20)\d{2}(?!\d)/;
const YEAR_BEFORE = /(?<!\d)(?:19|20)\d{2}[\s,.]{0,6}$/;

function parts(m: RegExpExecArray, p: Pattern): { day: number; month: number; weekday: number } | null {
  // Capture groups in pattern order; the Hebrew weekday has two alternatives.
  const g = m.slice(1).filter((x): x is string => x !== undefined);
  const byOrder: Record<Order, [number, number, number]> = {
    wdm: [1, 2, 0],
    wmd: [2, 1, 0],
    dmw: [0, 1, 2],
    mdw: [1, 0, 2],
  };
  const [dayAt, monthAt, weekdayAt] = byOrder[p.order];
  const day = Number(g[dayAt]);
  const monthWord = String(g[monthAt] ?? "").toLowerCase();
  const weekdayWord = String(g[weekdayAt] ?? "").toLowerCase();
  const month = p.hebrew ? HE_MONTHS.indexOf(monthWord) : EN_MONTHS.indexOf(monthWord.slice(0, 3));
  const weekday = p.hebrew ? HE_WEEKDAYS.indexOf(weekdayWord) : EN_WEEKDAYS.indexOf(weekdayWord.slice(0, 3));
  if (!Number.isInteger(day) || day < 1 || day > 31 || month < 0 || weekday < 0) return null;
  return { day, month, weekday };
}

/** The single year in the window on which day/month falls on `weekday`, or null. */
export function yearForWeekday(day: number, month: number, weekday: number, today: Date): number | null {
  const first = today.getUTCFullYear();
  const fits: number[] = [];
  for (let year = first; year <= first + YEARS_AHEAD; year++) {
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) continue; // 31 June, 29 February
    if (date.getUTCDay() === weekday) fits.push(year);
  }
  return fits.length === 1 ? fits[0]! : null;
}

export function yearlessDateHints(text: string, today: Date = new Date()): YearlessDateHint[] {
  const candidates: { start: number; end: number; hint: YearlessDateHint }[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      const start = m.index;
      const end = m.index + m[0].length;
      const before = text.slice(Math.max(0, start - 12), start);
      const after = text.slice(end, end + 12);
      if (YEAR_BEFORE.test(before) || YEAR_AFTER.test(after)) continue;
      const read = parts(m, p);
      if (!read) continue;
      const year = yearForWeekday(read.day, read.month, read.weekday, today);
      if (year === null) continue;
      const iso = `${year}-${String(read.month + 1).padStart(2, "0")}-${String(read.day).padStart(2, "0")}`;
      candidates.push({ start, end, hint: { quote: m[0].replace(/\s+/g, " ").trim(), iso } });
    }
  }
  // Two patterns can read across neighbouring dates — "Thu 23 Jul ... Thu 23 Jul"
  // is also "23 Jul ... Thu". Earliest match wins and nothing overlapping it is
  // read again, so a weekday is only ever paired with the date it sits beside.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const taken: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  const hints: YearlessDateHint[] = [];
  for (const c of candidates) {
    if (taken.some((t) => c.start < t.end && t.start < c.end)) continue;
    taken.push(c);
    const key = `${c.hint.quote.toLowerCase()}|${c.hint.iso}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(c.hint);
    if (hints.length >= MAX_HINTS) break;
  }
  return hints;
}
