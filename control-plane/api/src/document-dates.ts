/**
 * Dates and clock times as documents state them, made into the forms the trip
 * stores: `YYYY-MM-DD` days and 24-hour `HH:MM` times.
 *
 * WHY THIS HAPPENS AT RECONCILIATION. A booking platform's hotel confirmation
 * prints a check-in as "4 MARCH Thursday" and never a year; a car rental prints
 * "Pick-up Thu, March 4". On its own such a document cannot date the stay, and a model
 * told not to guess — correctly — leaves the dates out: on 2026-09-13, four of
 * six hotel stays and both car pick-ups of a real booking folder arrived
 * undated. The year is plain from the other documents in the same upload, but a
 * document's extraction is cached per document and must not depend on its
 * siblings. So the model writes the day as ISO 8601's own year-less form,
 * `--07-06`, and the year is completed here, from the whole trip, only when
 * exactly one year fits.
 *
 * Pure. No model, no database, no clock — "this year" is never a year source.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const YEARLESS = /^--(\d{2})-(\d{2})$/;
const DATE_KEYS = new Set(["start", "end", "date", "check_in", "check_out"]);

/** The first and last day the trip is known to include. */
export interface DateWindow {
  start: string;
  end: string;
}

function isRealDay(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

/**
 * The earliest and latest ISO day anywhere in these values — held answers,
 * proposed stops, anchors, trip dates. Null when none carries a full date.
 */
export function tripWindow(values: readonly unknown[]): DateWindow | null {
  const span: { start: string | null; end: string | null } = { start: null, end: null };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (ISO_DAY.test(value) && isRealDay(value)) {
        if (span.start === null || value < span.start) span.start = value;
        if (span.end === null || value > span.end) span.end = value;
      }
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  values.forEach(visit);
  return span.start !== null && span.end !== null ? { start: span.start, end: span.end } : null;
}

/**
 * One 24-hour `HH:MM`, from "15:47", "9:30" or "3:10 PM". Null for a range
 * ("15:00 - 22:00", a hotel's check-in hours), words, or anything else: the
 * trip site places an anchor on its day only by an exact clock time, and drops
 * any other value without a word.
 */
export function clockTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*([ap])\.?\s*m\.?\s*$/i.exec(value) ?? /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(value);
  if (!m) return null;
  let hour = Number(m[1]);
  const half = m[3]?.toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = half === "a" ? hour % 12 : (hour % 12) + 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

const DAY_MS = 86_400_000;

/** How many days `iso` lies outside the window; 0 inside it. */
function daysOutside(iso: string, window: DateWindow): number {
  const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
  if (iso < window.start) return (at(window.start) - at(iso)) / DAY_MS;
  if (iso > window.end) return (at(iso) - at(window.end)) / DAY_MS;
  return 0;
}

/**
 * Half a year. The trip's known dates are only what has been read so far — a
 * document may extend a stay, or date a part of the trip nothing else has — so
 * a day need not fall inside them. But two readings a year apart cannot both
 * lie this close, so a year chosen within it is never a guess between two.
 */
const NEAR_TRIP_DAYS = 182;

function completeYear(yearless: string, window: DateWindow | null): string | null {
  const m = YEARLESS.exec(yearless);
  if (!m || !window) return null;
  const near: string[] = [];
  for (let year = Number(window.start.slice(0, 4)) - 1; year <= Number(window.end.slice(0, 4)) + 1; year += 1) {
    const iso = `${year}-${m[1]}-${m[2]}`;
    if (isRealDay(iso) && daysOutside(iso, window) <= NEAR_TRIP_DAYS) near.push(iso);
  }
  return near.length === 1 ? near[0]! : null;
}

/**
 * A structured answer with every year-less date (`--MM-DD`) completed to the one
 * year that puts it near `window` (`NEAR_TRIP_DAYS`), and every `time` made
 * `HH:MM`. A date that
 * no year — or more than one — fits, and a time that is not one clock time, is
 * removed rather than kept in a form nothing downstream reads: an undated stop
 * is asked about, while "--07-06" or "15:00 - 22:00" would silently vanish at
 * provisioning. Full ISO dates are never touched.
 */
export function normaliseDatesAndTimes(data: unknown, window: DateWindow | null): unknown {
  if (Array.isArray(data)) return data.map((item) => normaliseDatesAndTimes(item, window));
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (DATE_KEYS.has(key) && typeof value === "string" && YEARLESS.test(value)) {
      const completed = completeYear(value, window);
      if (completed) out[key] = completed;
      continue;
    }
    if (key === "time" && typeof value === "string") {
      const clock = clockTime(value);
      if (clock) out[key] = clock;
      continue;
    }
    out[key] = normaliseDatesAndTimes(value, window);
  }
  return out;
}
