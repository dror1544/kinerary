/**
 * One set of rules for two questions every document raises:
 *
 *   IS THIS THE SAME THING?    a hotel in a plan and a hotel in a confirmation;
 *                              a flight on a PNR and the same flight on a ticket
 *   WHAT MAY IT CHANGE?        fill what is missing, add what is new, and never
 *                              silently replace what is already held
 *
 * Before this, "the same thing" was decided in two places with two answers. The
 * gate merged several slices of ONE model reply by name and overlapping dates;
 * across uploads there was no merge at all — a second document's answer to an
 * already-answered question was refused whole, so a hotel confirmation arriving
 * after the plan could not even add its confirmation number. Both now use these
 * rules, so a slice from one reply and a document from last week are judged the
 * same way.
 *
 * The rules, and why each is shaped as it is:
 *
 *  - A BOOKING REFERENCE decides identity when both sides have one. The same
 *    reference is the same booking; different references are different bookings
 *    even under the same name on the same day — two families on one flight with
 *    their own booking codes are two bookings, not one.
 *  - A reference alone is not enough for a MULTI-SEGMENT booking. One PNR covers
 *    the outbound and the return, so a flight also has to agree on its flight or
 *    its date. A hotel stay has to agree on its dates.
 *  - Without references, NAME AND DATES decide. The same name on overlapping
 *    dates is one visit; the same name on separate dates is a return visit.
 *  - A match that could be more than one held entry is AMBIGUOUS, and is neither
 *    merged nor added. "Tokyo", undated, on a trip that visits Tokyo twice, is not
 *    evidence about either stay — forcing it onto one would be a false merge, and
 *    adding it would be a duplicate.
 *  - Entries of ONE incoming list are never matched against each other. A
 *    confirmation listing two rooms under one reference means two rooms.
 *  - A field the new source does not mention is NOT a deletion. Absence of a
 *    confirmation number in a plan says nothing about the confirmation.
 *  - A field both sides state DIFFERENTLY is a conflict. The held value stays;
 *    the disagreement is reported so a person can decide. Upload order is not
 *    evidence of which document is newer.
 *
 * Pure. No database, no model, no clock.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INVISIBLE = /[​-‏‪-‮⁦-⁩­﻿]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const SINGLE_QUOTES = /[‘’‚‛′‵]/g;
const DOUBLE_QUOTES = /[“”„‟″‶]/g;

/** Booking types whose reference covers several separate legs. */
const SEGMENT_TYPES = new Set(["flight", "train", "bus", "ferry", "transfer"]);

/** Case, width, invisible marks, and the punctuation two sources spell differently. */
export function identityFold(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    // Hebrew geresh and gershayim are the abbreviation and acronym marks a
    // keyboard cannot type; people write ' and " instead, and ג'ורג' is one name.
    .replace(/\u05F3/g, "'")
    .replace(/\u05F4/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key order must not make two identical entries look different. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isoOf(value: unknown): string | null {
  return typeof value === "string" && ISO_DAY.test(value) ? value : null;
}

function nameOf(entry: Record<string, unknown>): string | null {
  const name = [entry.name_en, entry.name].find((n) => typeof n === "string" && n.trim() !== "");
  return typeof name === "string" ? name : null;
}

function typeOf(entry: Record<string, unknown>): string {
  return typeof entry.type === "string" ? identityFold(entry.type) : "";
}

function referenceOf(entry: Record<string, unknown>): string | null {
  const ref = entry.confirmation;
  if (typeof ref !== "string" || ref.trim() === "") return null;
  return identityFold(ref).replace(/[\s-]/g, "");
}

function startOf(entry: Record<string, unknown>): string | null {
  return isoOf(entry.start) ?? isoOf(entry.date) ?? isoOf(entry.check_in);
}

function endOf(entry: Record<string, unknown>): string | null {
  return isoOf(entry.end) ?? isoOf(entry.check_out);
}

function sameName(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const x = nameOf(a);
  const y = nameOf(b);
  return x !== null && y !== null && identityFold(x) === identityFold(y);
}

export interface MergeOptions {
  /**
   * The list holds PEOPLE (`travelers`), so names are compared as people's
   * names — see `samePerson` — rather than as place or booking names.
   */
  people?: boolean;
}

/** Titles and passenger codes travel documents print beside a name. */
const NAME_TITLES = new Set(["mr", "mrs", "ms", "miss", "mstr", "master", "dr", "chd", "inf", "adt"]);

/** A person's name as its words, in order: case, commas, slashes, hyphens and titles aside. */
function personWords(name: string): string[] {
  return identityFold(name).replace(/[/,.\-]/g, " ").split(" ").filter((w) => w !== "" && !NAME_TITLES.has(w));
}

/**
 * `part` is `whole` with one or two letters cut from its start (a PDF column
 * clipped at its margin) or, `fromEnd`, from its end (a letter dropped in
 * transcription). Four letters must remain: "Dan" is not a clipped "Idan".
 */
function cutShort(part: string, whole: string, fromEnd: boolean): boolean {
  if (part.length < 4 || part.length >= whole.length || whole.length - part.length > 2) return false;
  return fromEnd ? whole.startsWith(part) : whole.endsWith(part);
}

/**
 * Every word of `names` found in `other` — as a word, as two of its words run
 * together ("MOSHEYOSSI"), or as one word cut short. At most one word may be cut
 * short, and one cut at its END needs two other words to agree exactly.
 */
function accountedFor(names: readonly string[], other: readonly string[], clip: boolean): boolean {
  if (names.length < 2) return false;
  const forms = new Set(other);
  for (let i = 0; i + 1 < other.length; i += 1) forms.add(`${other[i]}${other[i + 1]}`);
  let exact = 0;
  let cutAtStart = 0;
  let cutAtEnd = 0;
  for (const word of names) {
    if (forms.has(word)) exact += 1;
    // Either printing may be the clipped one: "Noa Barak" and a clipped
    // "ARAK/NOALEE" are one person, a middle name and a cut apart.
    else if (clip && other.some((w) => cutShort(word, w, false) || cutShort(w, word, false))) cutAtStart += 1;
    else if (clip && other.some((w) => cutShort(word, w, true) || cutShort(w, word, true))) cutAtEnd += 1;
    else return false;
  }
  if (cutAtStart + cutAtEnd > 1) return false;
  return cutAtEnd === 0 || exact >= 2;
}

/**
 * Whether two spellings name one person.
 *
 * On 2026-09-13 one family's real booking folder printed the same traveller in
 * the forms "Noa Barak", "BARAK, NOA" and "BARAK/NOA MS"; one airline dropped a
 * middle name another printed; and a PDF clipped at its left margin printed the
 * form "ARAK/NOA". Compared as exact strings, 7 people became 9 and 16
 * travellers, and a matched traveller's printed name was asked about as a
 * disagreement. (Names here are invented; the folder's stay out of the repo.)
 *
 * The same words in any order are one person. So are a name and the same name
 * with a middle name added, or with two given names run together — unless
 * another traveller matches too, which `matchEntry` reports as ambiguous rather
 * than merging. One word may be cut short (see `cutShort`). A different
 * transliteration of a surname is NOT matched: telling "Cohen" from "Kohen" apart
 * from two different families needs a person, not a letter count.
 *
 * `clip: false` drops the cut-short tolerance. It exists for a PDF clipped at its
 * margin; a person TYPING a name has not clipped it, and "Ella" is not "Bella".
 */
export function samePerson(a: string, b: string, clip = true): boolean {
  const x = personWords(a);
  const y = personWords(b);
  if (x.length === 0 || y.length === 0) return false;
  if ([...x].sort().join(" ") === [...y].sort().join(" ")) return true;
  return accountedFor(x, y, clip) || accountedFor(y, x, clip);
}

/** Every name an entry is given under, English spelling first. */
function namesOf(entry: Record<string, unknown>): string[] {
  return [entry.name_en, entry.name].filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/** Whether two entries carry the same name — as people when the list holds people. */
function namesAgree(a: Record<string, unknown>, b: Record<string, unknown>, options: MergeOptions): boolean {
  if (!options.people) return sameName(a, b);
  return namesOf(a).some((x) => namesOf(b).some((y) => samePerson(x, y)));
}

/**
 * Same visit? A trip can return to a city and a hotel can be booked twice, so
 * the dates decide when both sides have them: the same start, or one starting
 * inside the other's range. An undated side has nothing to contradict it.
 */
export function sameVisit(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aStart = startOf(a);
  const bStart = startOf(b);
  if (!aStart || !bStart || aStart === bStart) return true;
  const aEnd = endOf(a);
  const bEnd = endOf(b);
  return (aEnd !== null && bStart > aStart && bStart < aEnd) || (bEnd !== null && aStart > bStart && aStart < bEnd);
}

/**
 * A cheap key for "the same entry" in simple lists — planned place names,
 * venues — where there are no references or dates to weigh.
 */
export function entryKey(entry: unknown): string {
  if (typeof entry === "string") return `s:${identityFold(entry)}`;
  if (isRecord(entry)) {
    const name = nameOf(entry);
    if (name !== null) return `n:${typeOf(entry)}|${identityFold(name)}`;
  }
  return `j:${canonical(entry)}`;
}

/**
 * A stable label for one entry, for provenance and for asking about it. Built
 * from what identifies the entry rather than from its position, so it survives
 * the list being re-sorted.
 */
export function entryIdentity(entry: unknown): string {
  if (!isRecord(entry)) return entryKey(entry);
  const type = typeOf(entry);
  const ref = referenceOf(entry);
  const name = nameOf(entry);
  const start = startOf(entry) ?? "";
  if (ref) return `c:${type}|${ref}|${SEGMENT_TYPES.has(type) ? identityFold(name ?? start) : start}`;
  if (name !== null) return `n:${type}|${identityFold(name)}|${start}`;
  return `j:${canonical(entry)}`;
}

export type EntryMatch =
  | { kind: "new" }
  | { kind: "match"; index: number }
  | { kind: "ambiguous"; candidates: number };

/**
 * Which held entry, if any, an incoming entry describes. Only the first `limit`
 * held entries are candidates — entries appended from the same incoming list
 * are never matched against their siblings.
 */
export function matchEntry(
  held: readonly unknown[],
  limit: number,
  incoming: Record<string, unknown>,
  options: MergeOptions = {},
): EntryMatch {
  const type = typeOf(incoming);
  const ref = referenceOf(incoming);
  const candidates: number[] = [];

  for (let i = 0; i < limit; i += 1) {
    const candidate = held[i];
    if (!isRecord(candidate) || typeOf(candidate) !== type) continue;
    const heldRef = referenceOf(candidate);

    if (ref && heldRef) {
      if (ref !== heldRef) continue;
      let agrees: boolean;
      if (SEGMENT_TYPES.has(type)) {
        agrees = namesAgree(candidate, incoming, options) || (startOf(candidate) !== null && startOf(candidate) === startOf(incoming));
      } else if (type === "hotel") {
        agrees = sameVisit(candidate, incoming);
      } else {
        agrees =
          (nameOf(candidate) === null || nameOf(incoming) === null || namesAgree(candidate, incoming, options)) &&
          sameVisit(candidate, incoming);
      }
      if (agrees) candidates.push(i);
      continue;
    }

    if (nameOf(candidate) === null && nameOf(incoming) === null) {
      if (canonical(candidate) === canonical(incoming)) candidates.push(i);
      continue;
    }
    if (namesAgree(candidate, incoming, options) && sameVisit(candidate, incoming)) candidates.push(i);
  }

  if (candidates.length === 0) return { kind: "new" };
  if (candidates.length === 1) return { kind: "match", index: candidates[0]! };
  return { kind: "ambiguous", candidates: candidates.length };
}

// ── Field-level merge ────────────────────────────────────────────────────────

export interface FieldChange {
  /** `entryIdentity` of the entry changed, or "" for the answer as a whole. */
  entryKey: string;
  /** Dotted path within the entry — `confirmation`, `accommodation.name`, `days[2026-09-20]`. */
  path: string;
}

export interface MergeConflict extends FieldChange {
  held: unknown;
  incoming: unknown;
}

export interface MergeAmbiguity {
  entryKey: string;
  incoming: unknown;
  candidates: number;
}

export interface ReconcileResult {
  merged: unknown;
  /** Entries that were not held at all. */
  added: FieldChange[];
  /** Fields held entries lacked and now have. */
  filled: FieldChange[];
  /** Fields both sides state differently. The held value was kept. */
  conflicts: MergeConflict[];
  /** Entries that could describe more than one held entry. Neither merged nor added. */
  ambiguous: MergeAmbiguity[];
  /** Whether `merged` says anything `held` did not. */
  changed: boolean;
}

interface Accumulator {
  added: FieldChange[];
  filled: FieldChange[];
  conflicts: MergeConflict[];
  ambiguous: MergeAmbiguity[];
  /** Names are compared as people's names (`MergeOptions.people`). */
  people: boolean;
}

/** Fields that hold a calendar day, wherever they sit in an entry. */
const DATE_FIELD = /(^|\.)(start|end|date|check_in|check_out)$/;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12,
};

/**
 * A day written the way a document writes it — "2 May", "May 2", "2 May 2026",
 * "2 במאי" — as day, month and, if it says one, year. Null for anything else;
 * this reads month names, not numeric forms, because "2/5" is 2 May or 5
 * February depending on who wrote it.
 */
function spokenDay(text: string): { day: number; month: number; year: number | null } | null {
  // ISO 8601's own form for a day with no year. claude-sonnet-5 wrote a notes
  // file's "Rome 2-6 May" as "--05-02" in 2 of 3 benchmark runs.
  const yearless = /^--(\d{2})-(\d{2})$/.exec(text.trim());
  if (yearless) {
    const month = Number(yearless[1]);
    const day = Number(yearless[2]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { day, month, year: null } : null;
  }
  const t = identityFold(text).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const monthOf = (word: string) => {
    const bare = word.replace(/\.$/, "");
    return MONTHS[bare] ?? MONTHS[bare.slice(0, 3)] ?? (bare.startsWith("ב") ? MONTHS[bare.slice(1)] : undefined) ?? null;
  };
  let m = /^(\d{1,2})(?:st|nd|rd|th)? (\S+)(?: (\d{4}))?$/.exec(t);
  let day: number;
  let month: number | null;
  let year: string | undefined;
  if (m) {
    day = Number(m[1]);
    month = monthOf(m[2]!);
    year = m[3];
  } else {
    m = /^(\S+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t);
    if (!m) return null;
    month = monthOf(m[1]!);
    day = Number(m[2]);
    year = m[3];
  }
  if (!month || day < 1 || day > 31) return null;
  return { day, month, year: year ? Number(year) : null };
}

/** Whether a spoken day and an ISO day are the same day. A spoken day with no year agrees with any year. */
function sameDay(spoken: string, iso: string): boolean {
  const parsed = spokenDay(spoken);
  if (!parsed) return false;
  const [y, mo, d] = iso.split("-").map(Number);
  return parsed.day === d && parsed.month === mo && (parsed.year === null || parsed.year === y);
}

function sameScalar(path: string, a: unknown, b: unknown, people = false): boolean {
  if (typeof a === "string" && typeof b === "string") {
    // A traveller already matched as one person under two printings of their
    // name — "Noa Barak", "BARAK, NOA" — is not then asked about as two names
    // that disagree: four such questions on 2026-09-13, all false.
    if (people && /(^|\.)name(_en)?$/.test(path) && samePerson(a, b)) return true;
    // An entry already matched — by its booking reference and its flight or
    // dates — is not then disputed over what a document CALLS it: "XY 305
    // Home-Gateway" and "Sky Air XY 305" are one booked flight, and asking which
    // label is right is noise (two such questions on 2026-09-13). The held label
    // is kept. A NESTED name — the hotel a stop sleeps in — is still a fact.
    if (path === "name" || path === "name_en") return true;
    // "2 May" from an organizer's notes and 2026-05-02 from a hotel booking are
    // one day. Reported as a disagreement, the organizer is asked to choose
    // between a date and itself — six times, for one three-city trip, in the
    // 2026-09-13 benchmark.
    if (DATE_FIELD.test(path)) {
      if (isoOf(a) && !isoOf(b)) return sameDay(b, a);
      if (isoOf(b) && !isoOf(a)) return sameDay(a, b);
    }
    // A booking reference is written with and without its separators —
    // GR-4471, GR 4471 — and matching already treats those as one reference.
    // Comparing the field any stricter would report a disagreement with the
    // very entry it was just matched to.
    if (/(^|\.)confirmation$/.test(path)) {
      return identityFold(a).replace(/[\s-]/g, "") === identityFold(b).replace(/[\s-]/g, "");
    }
    return identityFold(a) === identityFold(b);
  }
  return canonical(a) === canonical(b);
}

function mergeField(path: string, held: unknown, incoming: unknown, acc: Accumulator, key: string): unknown {
  // Absence is not deletion.
  if (isBlank(incoming)) return held;
  if (isBlank(held)) {
    acc.filled.push({ entryKey: key, path });
    return incoming;
  }
  if (Array.isArray(held) && Array.isArray(incoming)) return mergeNestedList(path, held, incoming, acc, key);
  if (isRecord(held) && isRecord(incoming)) return mergeRecordFields(`${path}.`, held, incoming, acc, key);
  if (sameScalar(path, held, incoming, acc.people)) {
    // The same day, and only one side wrote it as a date the site can use: keep
    // that one. A stop whose start stays "2 May" has no dates on the site.
    if (DATE_FIELD.test(path) && !isoOf(held) && isoOf(incoming)) {
      acc.filled.push({ entryKey: key, path });
      return incoming;
    }
    return held;
  }
  acc.conflicts.push({ entryKey: key, path, held, incoming });
  return held;
}

function mergeRecordFields(
  prefix: string,
  held: Record<string, unknown>,
  incoming: Record<string, unknown>,
  acc: Accumulator,
  key: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...held };
  for (const [field, value] of Object.entries(incoming)) {
    merged[field] = mergeField(`${prefix}${field}`, held[field], value, acc, key);
  }
  return merged;
}

/**
 * A list inside an entry. A phase's `days` merge BY DATE — a held day always
 * wins its date, because it may be one an organizer corrected, and a new date
 * is added. Anything else (planned places, venues) is a union by name.
 */
function mergeNestedList(path: string, held: unknown[], incoming: unknown[], acc: Accumulator, key: string): unknown[] {
  const field = path.split(".").pop();
  if (field === "days") {
    const out = [...held];
    const dates = new Set(held.map((d) => (isRecord(d) ? isoOf(d.date) : null)).filter(Boolean));
    for (const day of incoming) {
      const date = isRecord(day) ? isoOf(day.date) : null;
      if (!date || dates.has(date)) continue;
      dates.add(date);
      out.push(day);
      acc.filled.push({ entryKey: key, path: `${path}[${date}]` });
    }
    return out.sort((a, b) => String(isRecord(a) ? a.date : "").localeCompare(String(isRecord(b) ? b.date : "")));
  }
  const out = [...held];
  const keys = new Set(held.map(entryKey));
  for (const item of incoming) {
    const k = entryKey(item);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(item);
    acc.filled.push({ entryKey: key, path: `${path}[]` });
  }
  return out;
}

/** Dated lists come back in date order, with a stable tie-break, so arrival order leaves no trace. */
export function ordered(list: unknown[]): unknown[] {
  if (list.length === 0 || !list.every((e) => isRecord(e) && startOf(e) !== null)) return list;
  return [...list].sort((a, b) => {
    const byDate = startOf(a as Record<string, unknown>)!.localeCompare(startOf(b as Record<string, unknown>)!);
    return byDate !== 0 ? byDate : entryIdentity(a).localeCompare(entryIdentity(b));
  });
}

/**
 * What an incoming structured answer adds to the one already held.
 *
 * `held` is never mutated. When `held` is absent the incoming answer is taken
 * whole — still checked entry by entry, so an incoming list is never collapsed
 * into itself.
 */
export function reconcileStructured(held: unknown, incoming: unknown, options: MergeOptions = {}): ReconcileResult {
  const acc: Accumulator = { added: [], filled: [], conflicts: [], ambiguous: [], people: options.people === true };
  const done = (merged: unknown): ReconcileResult => ({
    merged,
    added: acc.added,
    filled: acc.filled,
    conflicts: acc.conflicts,
    ambiguous: acc.ambiguous,
    changed: acc.added.length > 0 || acc.filled.length > 0,
  });

  if (isBlank(incoming)) return done(held);

  if (Array.isArray(incoming)) {
    const base = Array.isArray(held) ? [...held] : [];
    const limit = base.length;
    for (const entry of incoming) {
      if (!isRecord(entry)) {
        const k = entryKey(entry);
        if (!base.some((e) => entryKey(e) === k)) {
          base.push(entry);
          acc.added.push({ entryKey: k, path: "" });
        }
        continue;
      }
      const match = matchEntry(base, limit, entry, options);
      if (match.kind === "new") {
        base.push(entry);
        acc.added.push({ entryKey: entryIdentity(entry), path: "" });
      } else if (match.kind === "ambiguous") {
        acc.ambiguous.push({ entryKey: entryIdentity(entry), incoming: entry, candidates: match.candidates });
      } else {
        const target = base[match.index] as Record<string, unknown>;
        base[match.index] = mergeRecordFields("", target, stripVisitMarkers(entry) as Record<string, unknown>, acc, entryIdentity(target));
      }
    }
    return done(ordered(base));
  }

  if (isRecord(incoming)) {
    return done(mergeRecordFields("", isRecord(held) ? held : {}, incoming, acc, ""));
  }

  // A scalar where a structure was expected: the same rules at one level.
  if (isBlank(held)) {
    acc.filled.push({ entryKey: "", path: "" });
    return done(incoming);
  }
  if (!sameScalar("", held, incoming)) acc.conflicts.push({ entryKey: "", path: "", held, incoming });
  return done(held);
}

/**
 * Several slices of one structured answer, combined in precedence order — the
 * first part is held, each later part is reconciled into it. The within-reply
 * merge the gate always did, now on the same rules as merging across documents.
 */
export function mergeParts(parts: readonly unknown[], options: MergeOptions = {}): unknown {
  const [first, ...rest] = parts;
  let merged = Array.isArray(first) ? ordered([...first]) : first;
  for (const part of rest) merged = reconcileStructured(merged, part, options).merged;
  return merged;
}

/**
 * Whether a phase list's day-by-day already covers every night of every dated
 * phase. An undated phase counts as covered once it has any day, because there
 * is no range to measure it against.
 *
 * Replaces "every phase has at least one day", which let a five-day stop with
 * one captured day block every later document from filling in the other four.
 */
export function itineraryCoverageComplete(phases: readonly unknown[]): boolean {
  return phases.every((phase) => {
    if (!isRecord(phase)) return true;
    const days = Array.isArray(phase.days) ? phase.days : [];
    const have = new Set(days.map((d) => (isRecord(d) ? isoOf(d.date) : null)).filter(Boolean));
    const start = isoOf(phase.start);
    const end = isoOf(phase.end);
    if (!start || !end || end < start) return days.length > 0;
    // Nights, not calendar days: the checkout date is the next stop's first day.
    const cursor = new Date(`${start}T00:00:00Z`);
    const last = new Date(`${end}T00:00:00Z`);
    if (start === end) return have.has(start);
    while (cursor < last) {
      if (!have.has(cursor.toISOString().slice(0, 10))) return false;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return true;
  });
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(record: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> | null {
  const [head, ...rest] = path.split(".");
  if (!head) return null;
  if (rest.length === 0) return { ...record, [head]: value };
  const child = record[head];
  if (!isRecord(child)) return null;
  const updated = setPath(child, rest.join("."), value);
  return updated ? { ...record, [head]: updated } : null;
}

/**
 * The held structured data with one disputed field taken from the document —
 * an organizer's "use the document's value" answer to a conflict.
 *
 * Returns null when the conflict no longer describes what is held: the entry it
 * named is gone or has become ambiguous, or the held field no longer holds the
 * value the conflict was raised against. In every one of those cases the
 * organizer's tap answers a question that has stopped being true, and applying
 * it anyway would overwrite whatever changed in the meantime.
 */
export function applyConflictChoice(
  held: unknown,
  conflict: { entryKey: string; path: string; held: unknown; incoming: unknown },
): unknown | null {
  const stillHeld = (record: Record<string, unknown>) => {
    const current = conflict.path === "" ? record : getPath(record, conflict.path);
    return sameScalar(conflict.path, current, conflict.held);
  };

  if (conflict.entryKey === "") {
    if (conflict.path === "") return sameScalar("", held, conflict.held) ? conflict.incoming : null;
    if (!isRecord(held) || !stillHeld(held)) return null;
    return setPath(held, conflict.path, conflict.incoming);
  }

  if (!Array.isArray(held)) return null;
  const matches = held.flatMap((entry, index) => (entryIdentity(entry) === conflict.entryKey ? [index] : []));
  if (matches.length !== 1) return null;
  const index = matches[0]!;
  const target = held[index];
  if (!isRecord(target) || !stillHeld(target)) return null;
  const updated = setPath(target, conflict.path, conflict.incoming);
  if (!updated) return null;
  const out = [...held];
  out[index] = updated;
  return ordered(out);
}

// ── A leftover marker ────────────────────────────────────────────────────────

/**
 * The key an earlier version of the interpreter asked the model to put on a stop
 * that was an additional visit (#114). #206 replaced that with the `add_stop`
 * operation, so nothing sets it any more; it is still STRIPPED at the one gate
 * every write passes (`validateAnswer`), for one release, so a stored proposal or
 * a reply from a model that has not caught up cannot leave it in an answer.
 */
export const ADDITIONAL_VISIT = "additional_visit";

/**
 * The answer with that key removed from each entry of a list (or from the answer
 * itself, if it is one entry). It looks at an entry's own top level only.
 */
export function stripVisitMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVisitMarkers);
  if (isRecord(value) && ADDITIONAL_VISIT in value) {
    const { [ADDITIONAL_VISIT]: _marker, ...rest } = value;
    return rest;
  }
  return value;
}
