/**
 * The words of the group line (video Release 1C, docs/specs/sprint-9/x-video-r1-group-line.md, "The line").
 *
 * Pure: structured changes in, one plain-text message out. Fixed templates, English and Hebrew, written
 * here and not by a model. The control plane renders from the structured payload at send time, so what the
 * group reads is decided by this file, not by whatever text happens to ride in a row.
 *
 * NOUN-LED, SO IT AGREES WITH ANY TITLE (Dror, 2026-11-17). A Hebrew verb about the item ("עברה" / "עבר")
 * must agree with the item's gender, and the title is whatever the family typed. So every template opens
 * with a noun label ("שינוי בתוכנית:", "תוספת לתוכנית:", "הסרה מהתוכנית:") and the title is only ever quoted,
 * never the subject of a verb. English follows the same shape ("Plan change: Dinner — now at 19:30").
 *
 * DATES ARE ALWAYS THE DATE (Dror, 2026-11-17): a day is written "Thursday, Dec 3" / "יום חמישי, 3 בדצמבר",
 * never a bare weekday and never YYYY-MM-DD. Today and tomorrow are said in words, and keep the date beside
 * them ("tomorrow (Friday, Dec 4)").
 *
 * WHAT IS IN THE LINE, AND WHAT NEVER IS. The input carries an item's title, date, time and what kind of
 * change it was, which every member already reads on the site. The type below has no field for who made the
 * change, a version note, a booking, a cost, a confirmation number or a person's needs, so a caller cannot
 * pass one by mistake, and the one string that came from a person (the title) is cleaned as data:
 * whitespace folded to one line, control and direction-changing characters removed, length capped. It is
 * sent as plain text (no parse mode), so a title can never be markup either.
 */

export type PlanChangeKind = "updated" | "added" | "removed";

export interface PlanChange {
  kind: PlanChangeKind;
  fields: readonly string[];
  /** YYYY-MM-DD, the item's day now (for a removed item, the day it had). */
  date: string | null;
  /** HH:MM, or a rough word (morning, noon, afternoon, evening), or null for "any time". */
  time: string | null;
  previous_date?: string | null | undefined;
  previous_time?: string | null | undefined;
  text_he?: string | null | undefined;
  text_en?: string | null | undefined;
}

export type LineLanguage = "en" | "he";

export interface RenderOptions {
  language: LineLanguage;
  /** The trip's own IANA zone: "today" and "tomorrow" are the trip's, never the server's. */
  timeZone: string;
  /** The instant the message is about; "today" is this instant's day in `timeZone`. */
  now: Date;
}

/** After this many lines a message says how many more there are on the site. */
export const MAX_LINES = 5;
const MAX_TITLE_LENGTH = 80;

const WEEKDAYS: Record<LineLanguage, readonly string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  he: ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "יום שבת"],
};
const MONTHS: Record<LineLanguage, readonly string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  he: ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"],
};
// Rough times: [English label as the site gives it, Hebrew label, English "at", Hebrew "at"].
const ROUGH_TIMES: Record<string, [string, string, string, string]> = {
  morning: ["Morning", "בוקר", "in the morning", "בבוקר"],
  noon: ["Noon", "צהריים", "at noon", "בצהריים"],
  afternoon: ["Afternoon", "אחר הצהריים", "in the afternoon", "אחר הצהריים"],
  evening: ["Evening", "ערב", "in the evening", "בערב"],
};
const ROUGH_MINUTES: Record<string, number> = { morning: 9 * 60, noon: 12 * 60, afternoon: 15 * 60, evening: 19 * 60 };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DASH = " — ";

// The words of the templates, one place per language.
const WORDS = {
  en: {
    change: "Plan change", added: "Added to the plan", removed: "Removed from the plan", heading: "Plan update",
    now: "now", was: "was", today: "today", tomorrow: "tomorrow", details: "details updated", anytime: "any time",
    more: (n: number) => `+${n} more on the trip site`,
  },
  he: {
    change: "שינוי בתוכנית", added: "תוספת לתוכנית", removed: "הסרה מהתוכנית", heading: "עדכון בתוכנית",
    now: "עכשיו", was: "במקום", today: "היום", tomorrow: "מחר", details: "עדכון פרטים", anytime: "בכל שעה",
    more: (n: number) => `ועוד ${n} באתר הטיול`,
  },
} as const;

// Control characters, zero-width and joiner characters, and the marks that change text direction or display
// (the same family the trip site refuses to store). A title keeps its Hebrew letters and its own marks of
// punctuation; it loses what could make a line read differently from how it is written.
// Built from a string so no raw line-separator character sits in this source file.
const UNSAFE = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]",
  "g",
);

/** A person-typed title, as data: one line, no hidden characters, bounded. */
export function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const folded = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  const chars = [...folded];
  return chars.length > MAX_TITLE_LENGTH ? `${chars.slice(0, MAX_TITLE_LENGTH - 1).join("").trimEnd()}…` : folded;
}

function titleOf(change: PlanChange, language: LineLanguage): string {
  const own = cleanTitle(language === "he" ? change.text_he : change.text_en);
  return own || cleanTitle(language === "he" ? change.text_en : change.text_he);
}

/** The calendar day `now` falls on in `timeZone` (YYYY-MM-DD). An unusable zone reads as UTC. */
export function dayInZone(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value;
    return `${pick("year")}-${pick("month")}-${pick("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Minutes since midnight of `now` in `timeZone`. An unusable zone reads as UTC. */
export function minutesInZone(now: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const minutes = pick("hour") * 60 + pick("minute");
    return Number.isFinite(minutes) ? minutes : now.getUTCHours() * 60 + now.getUTCMinutes();
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/** "Thursday, Dec 3" / "יום חמישי, 3 בדצמבר": the weekday and the date, never ISO. */
function dateText(day: string, language: LineLanguage): string {
  const [, m, d] = day.split("-").map(Number);
  const weekday = WEEKDAYS[language][new Date(dayNumber(day) * 86_400_000).getUTCDay()]!;
  const month = MONTHS[language][m! - 1] ?? "";
  return language === "he" ? `${weekday}, ${d} ב${month}` : `${weekday}, ${month} ${d}`;
}

/** The day on its own, after "was" and inside brackets: always the weekday and the date, never "today" (no nested brackets). */
function dayBare(day: string, _today: string, language: LineLanguage): string {
  return dateText(day, language);
}

/**
 * The day after "now" / "added": "today (Thursday, Dec 3)" and "tomorrow (…)" keep the date beside the word;
 * any other day is the date with its preposition ("on Thursday, Dec 3" / "ביום חמישי, 3 בדצמבר").
 */
function dayAt(day: string, today: string, language: LineLanguage): string {
  const offset = dayNumber(day) - dayNumber(today);
  const w = WORDS[language];
  if (offset === 0) return `${w.today} (${dateText(day, language)})`;
  if (offset === 1) return `${w.tomorrow} (${dateText(day, language)})`;
  return language === "he" ? `ב${dateText(day, language)}` : `on ${dateText(day, language)}`;
}

/** "at 19:00" / "ב-19:00"; a rough word as a phrase; no time as "any time". */
function timeAt(time: string | null, language: LineLanguage): string {
  if (!time) return language === "he" ? WORDS.he.anytime : `at ${WORDS.en.anytime}`;
  const rough = ROUGH_TIMES[time];
  if (rough) return language === "he" ? rough[3] : rough[2];
  return language === "he" ? `ב-${time}` : `at ${time}`;
}

/** The time on its own, for "was": "20:00", or the site's word for a rough time. */
function timeBare(time: string | null, language: LineLanguage): string {
  if (!time) return language === "he" ? WORDS.he.anytime : WORDS.en.anytime;
  const rough = ROUGH_TIMES[time];
  if (rough) return language === "he" ? rough[1] : rough[0];
  return time;
}

const cleanDay = (value: string | null | undefined): string | null => (typeof value === "string" && ISO_DAY.test(value) ? value : null);
const cleanTime = (value: string | null | undefined): string | null => (typeof value === "string" && (HHMM.test(value) || value in ROUGH_TIMES) ? value : null);

function timeMinutes(time: string | null): number {
  if (!time) return Number.MAX_SAFE_INTEGER;
  if (time in ROUGH_MINUTES) return ROUGH_MINUTES[time]!;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

interface Line {
  /** The line as a message of its own: "<label>: <body>". */
  single: string;
  /** The line inside a list under the heading. A change line drops the label the heading already carries. */
  listed: string;
}

function lineFor(change: PlanChange, today: string, language: LineLanguage): Line | null {
  const title = titleOf(change, language);
  if (!title) return null; // nothing to name: say nothing rather than "something changed"
  const he = language === "he";
  const w = WORDS[language];
  const day = cleanDay(change.date);
  const time = cleanTime(change.time);
  const labelled = (label: string, body: string): Line => ({ single: `${label}: ${body}`, listed: `${label}: ${body}` });
  const unlabelled = (label: string, body: string): Line => ({ single: `${label}: ${body}`, listed: body });

  if (change.kind === "added") {
    // "Added to the plan: Winery visit — on Thursday, Dec 3 at 16:00" (no time, no "at"; no day, no tail).
    const when = [day ? dayAt(day, today, language) : "", time ? timeAt(time, language) : ""].filter(Boolean).join(he ? ", " : " ");
    return labelled(w.added, `${title}${when ? `${DASH}${when}` : ""}`);
  }
  if (change.kind === "removed") {
    return labelled(w.removed, `${title}${day ? ` (${dayBare(day, today, language)})` : ""}`);
  }

  const dateMoved = change.fields.includes("date");
  const timeMoved = change.fields.includes("time");
  if (!dateMoved && !timeMoved) {
    // Title, place or type: say that the details changed, and when the item is.
    return unlabelled(w.change, `${title}${DASH}${w.details}${day ? ` (${dayBare(day, today, language)})` : ""}`);
  }
  if (dateMoved && !day) return null;
  const previousDay = cleanDay(change.previous_date) ?? day;
  const previousTime = timeMoved ? cleanTime(change.previous_time) : time;
  const join = he ? ", " : " ";
  let now: string;
  let was: string;
  if (dateMoved && timeMoved) {
    now = `${dayAt(day!, today, language)}${join}${timeAt(time, language)}`;
    was = `${previousDay ? `${dayBare(previousDay, today, language)}${join}` : ""}${timeAt(previousTime, language)}`;
  } else if (dateMoved) {
    now = dayAt(day!, today, language);
    was = previousDay ? dayBare(previousDay, today, language) : "";
  } else {
    now = timeAt(time, language);
    was = timeBare(previousTime, language);
  }
  return unlabelled(w.change, `${title}${DASH}${w.now} ${now}${was ? ` (${w.was} ${was})` : ""}`);
}

/**
 * The message for a set of net changes, or null when none of them can be put into words.
 * One change is its line alone ("<label>: <title> — …"); several are a heading and one line each, in plan
 * order (date, then time), and after five lines "+N more on the trip site".
 */
export function renderPlanChangeLine(changes: readonly PlanChange[], options: RenderOptions): string | null {
  const today = dayInZone(options.now, options.timeZone);
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => (cleanDay(a.change.date) ?? "9999-99-99").localeCompare(cleanDay(b.change.date) ?? "9999-99-99")
      || timeMinutes(cleanTime(a.change.time)) - timeMinutes(cleanTime(b.change.time))
      || a.index - b.index)
    .map(({ change }) => change);
  const lines = ordered.flatMap((change) => lineFor(change, today, options.language) ?? []);
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0]!.single;
  const w = WORDS[options.language];
  const out = [w.heading, ...lines.slice(0, MAX_LINES).map((line) => line.listed)];
  if (lines.length > MAX_LINES) out.push(w.more(lines.length - MAX_LINES));
  return out.join("\n");
}
