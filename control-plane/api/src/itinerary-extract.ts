/**
 * extract_itinerary — turn an uploaded trip-plan document into a per-phase
 * day-by-day itinerary at interview time (Sprint 4.5, §4.5-i).
 *
 * The model (the shared `kinerary-extract` Hermes profile — no tools, no
 * memory, already used by the trip site's Add-Booking /extract) only produces
 * structure. Every invariant the site depends on is enforced here, in reviewed
 * code, not left to the model:
 *   - a day's date must parse and fall inside its phase's range;
 *   - `label`/`text` are plain text — the site renders config `days` text as
 *     raw HTML (`_biSpan`), so a `<...>` payload here is an XSS sink;
 *   - both `he` and `en` are present on every string (mirror the given side);
 *   - `time` is exactly HH:MM or null.
 *
 * `normaliseExtractedItinerary` is pure and is what the tests exercise;
 * `extractItinerary` wraps it with the one-shot CLI call. Any failure returns
 * `{ ok: false }` — the interviewer proceeds without `days[]`, never blocked.
 */
import { execFile } from "node:child_process";

const HERMES_BIN = process.env.HERMES_BIN || "hermes";
const HERMES_EXTRACT_PROFILE = process.env.HERMES_EXTRACT_PROFILE || "";
const EXTRACT_TIMEOUT_MS = Number(process.env.ITINERARY_EXTRACT_TIMEOUT_MS || "60000");
// A profile that can web-search, for filling a venue's official/ticket URL
// when the source document didn't print one. Falls back to the consular
// profile (also "a profile that can search"). Unset -> the step is skipped.
const HERMES_SEARCH_PROFILE = process.env.HERMES_SEARCH_PROFILE || process.env.HERMES_CONSULAR_PROFILE || "";
const VENUE_LINK_TIMEOUT_MS = Number(process.env.VENUE_LINK_TIMEOUT_MS || "90000");

export type PhaseRef = { name: string; start?: string; end?: string };
type Bi = { he: string; en: string };
export type ItineraryItem = { time: string | null; text: Bi };
export type ItineraryDay = { date: string; label?: Bi; items: ItineraryItem[] };
/** A notable place the itinerary names, with any official/ticket URL the
 * source document carried for it. enrich_config geocodes it to add maps/waze;
 * the site renders it as a venue card on the phase page. */
export type ExtractedVenue = { name: Bi; url?: string; area?: string };
/** `phaseIndex` is the 0-based position in the `phases` array passed to the
 * extractor — the interviewer folds `days`/`venues` back in at that index,
 * which disambiguates a name that repeats (e.g. two "Tokyo" stops). */
export type ExtractedPhase = { name: string; phaseIndex: number; days: ItineraryDay[]; venues: ExtractedVenue[] };

export type ExtractItineraryArgs = {
  destination: string;
  phases: PhaseRef[];
  travelers?: string[];
  documentText: string;
};

export type ExtractItineraryResult =
  | { ok: true; phases: ExtractedPhase[]; warnings: string[] }
  | { ok: false; reason: "EXTRACT_NOT_CONFIGURED" | "EXTRACTION_FAILED"; detail?: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

function plain(value: unknown): string {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

function bilingual(value: unknown): Bi | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const he = plain(o.he);
  const en = plain(o.en);
  if (!he && !en) return null;
  return { he: he || en, en: en || he };
}

function withinRange(date: string, start?: string, end?: string): boolean {
  if (!start || !end || !ISO_DATE.test(start) || !ISO_DATE.test(end)) return true;
  return start <= date && date <= end;
}

/**
 * Enforce every invariant on the model's raw output. Tolerant of the exact
 * envelope: accepts `{ phases: [...] }`, `{ itinerary: [...] }`, or a bare
 * array of phase blocks.
 */
export function normaliseExtractedItinerary(
  raw: unknown,
  phases: PhaseRef[],
): { phases: ExtractedPhase[]; warnings: string[] } {
  const warnings: string[] = [];

  // name -> every phase carrying that name, with its position. A repeated name
  // (two "Tokyo" stops) is resolved per-day by which one's date range the day
  // falls in — otherwise a Map keyed by name alone silently drops one visit.
  const byName = new Map<string, { ref: PhaseRef; index: number }[]>();
  phases.forEach((ref, index) => {
    if (!ref || typeof ref.name !== "string" || !ref.name.trim()) return;
    const key = ref.name.trim().toLowerCase();
    (byName.get(key) ?? byName.set(key, []).get(key)!).push({ ref, index });
  });

  let blocks: unknown[] = [];
  if (Array.isArray(raw)) blocks = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.phases)) blocks = o.phases;
    else if (Array.isArray(o.itinerary)) blocks = o.itinerary;
  }

  // Accumulate days/venues per phase index (a single model "Tokyo" block can feed two).
  const daysByIndex = new Map<number, ItineraryDay[]>();
  const venuesByIndex = new Map<number, ExtractedVenue[]>();

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const key = plain(b.name).toLowerCase();
    const candidates = byName.get(key);
    if (!candidates || !candidates.length) {
      if (key) warnings.push(`dropped unknown phase "${plain(b.name)}"`);
      continue;
    }

    // Venues aren't date-bound; route them to the first occurrence of the name.
    if (Array.isArray(b.venues) && b.venues.length) {
      const venueIndex = candidates[0]!.index;
      const bucket = venuesByIndex.get(venueIndex) ?? venuesByIndex.set(venueIndex, []).get(venueIndex)!;
      for (const rawVenue of b.venues) {
        if (bucket.length >= 12) break;
        if (!rawVenue || typeof rawVenue !== "object") continue;
        const v = rawVenue as Record<string, unknown>;
        const name = bilingual(v.name);
        if (!name) continue;
        if (bucket.some((x) => x.name.en.toLowerCase() === name.en.toLowerCase())) continue;
        const venue: ExtractedVenue = { name };
        const url = plain(v.url);
        if (/^https?:\/\/\S+$/i.test(url)) venue.url = url;
        const area = plain(v.area);
        if (area) venue.area = area;
        bucket.push(venue);
      }
    }

    for (const rawDay of Array.isArray(b.days) ? b.days : []) {
      if (!rawDay || typeof rawDay !== "object") continue;
      const d = rawDay as Record<string, unknown>;
      const date = plain(d.date);
      if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) {
        warnings.push(`dropped day with bad date "${plain(d.date)}" for ${plain(b.name)}`);
        continue;
      }
      const match =
        candidates.find((c) => c.ref.start && c.ref.end && withinRange(date, c.ref.start, c.ref.end)) ??
        candidates.find((c) => !c.ref.start || !c.ref.end);
      if (!match) {
        const ranges = candidates.map((c) => `${c.ref.start}..${c.ref.end}`).join(" / ");
        warnings.push(`dropped ${date} — outside ${plain(b.name)} (${ranges})`);
        continue;
      }

      const items: ItineraryItem[] = [];
      for (const rawItem of Array.isArray(d.items) ? d.items : []) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const it = rawItem as Record<string, unknown>;
        const text = bilingual(it.text);
        if (!text) continue;
        const time = typeof it.time === "string" && HHMM.test(it.time.trim()) ? it.time.trim() : null;
        items.push({ time, text });
      }
      if (!items.length) continue;
      const day: ItineraryDay = { date, items };
      const label = bilingual(d.label);
      if (label) day.label = label;
      (daysByIndex.get(match.index) ?? daysByIndex.set(match.index, []).get(match.index)!).push(day);
    }
  }

  const out: ExtractedPhase[] = [];
  const indices = [...new Set([...daysByIndex.keys(), ...venuesByIndex.keys()])].sort((a, b) => a - b);
  for (const index of indices) {
    const ref = phases[index];
    if (!ref) continue;
    const days = daysByIndex.get(index) ?? [];
    const venues = venuesByIndex.get(index) ?? [];
    if (!days.length && !venues.length) continue;
    days.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : 0));
    out.push({ name: ref.name, phaseIndex: index, days, venues });
  }
  return { phases: out, warnings };
}

export function buildExtractPrompt(args: ExtractItineraryArgs): string {
  const phaseLines = args.phases
    .map((p) => `- ${p.name}: ${p.start || "?"} to ${p.end || "?"}`)
    .join("\n");
  const roster = (args.travelers || []).filter(Boolean).join(", ");
  return [
    `You are a travel itinerary extractor for a trip to ${args.destination || "the destination"}.`,
    `From the document below, produce a day-by-day plan and return ONLY a valid JSON object.`,
    ``,
    `Trip phases and their date ranges:`,
    phaseLines || "- (none given)",
    roster ? `Travelers: ${roster}` : "",
    ``,
    `Rules:`,
    `- Use the phase NAME exactly as written above for each "name".`,
    `- Every "date" MUST be YYYY-MM-DD and fall inside that phase's range. Put the day under that phase.`,
    `- Do NOT invent activities, times, dates or place names the document does not contain. A rough day with no times -> items with "time": null.`,
    `- "label": a 2-6 word day headline. "text": one activity per line, <=120 chars. Both plain text, no markup.`,
    `- Provide BOTH "he" (Hebrew) and "en" (English) for every label and text. You translate; never ask.`,
    `- Omit a day the document does not describe. A phase with nothing described -> "days": [].`,
    `- "venues": real places you could point to on a map that this phase visits (attractions, museums, temples, parks, named tour boats/trains with a station). NOT a rail pass, day-pass, ticket bundle or transport product — those go in a day's items, not here. For each venue give the name in "he" and "en", and "url" ONLY if the document itself prints an official or ticket link for it (never guess a URL). Up to ~10 per phase; [] if none.`,
    ``,
    `Return exactly:`,
    `{ "phases": [ { "name": "<phase name>", "days": [ { "date": "YYYY-MM-DD", "label": { "he": "...", "en": "..." }, "items": [ { "time": "HH:MM" | null, "text": { "he": "...", "en": "..." } } ] } ], "venues": [ { "name": { "he": "...", "en": "..." }, "url": "https://..." } ] } ] }`,
    `No commentary.`,
    ``,
    `Document:`,
    args.documentText.slice(0, 20000),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runExtract(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      HERMES_BIN,
      ["-p", HERMES_EXTRACT_PROFILE, "chat", "-q", prompt, "-Q", "--safe-mode", "--reasoning", "none"],
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error(`hermes CLI not found (HERMES_BIN=${HERMES_BIN})`));
        }
        const why = err.killed || err.signal ? `timed out (${EXTRACT_TIMEOUT_MS}ms)` : `exit ${(err as NodeJS.ErrnoException).code}`;
        reject(new Error(`hermes ${why}${stderr ? ` — ${String(stderr).trim().slice(-200)}` : ""}`));
      },
    );
  });
}

/** Build a prompt asking for an official/ticket URL per venue by web search. */
export function buildVenueLinkPrompt(names: string[], destination: string): string {
  return [
    `For a trip to ${destination || "the destination"}, find the official website (or the`,
    `dedicated ticket page where advance booking is normal) for each place below.`,
    `Use web search. Return ONLY a JSON object mapping the exact name to its URL.`,
    `Omit a place you cannot find a real, first-party URL for — never guess a domain.`,
    ``,
    `Places:`,
    ...names.map((n) => `- ${n}`),
    ``,
    `Return exactly: { "<name>": "https://..." }  — no commentary.`,
  ].join("\n");
}

function runVenueLinkSearch(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      HERMES_BIN,
      ["-p", HERMES_SEARCH_PROFILE, "chat", "-q", prompt, "-Q", "--safe-mode"],
      { timeout: VENUE_LINK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/** Fill `venue.url` for venues that don't have one, by web search. Mutates
 * `phases` in place. Best-effort: any failure just leaves those venues without
 * a URL (the site still shows their Maps/Waze links). */
async function resolveVenueLinks(phases: ExtractedPhase[], destination: string): Promise<void> {
  if (!HERMES_SEARCH_PROFILE) return;
  const missing = phases.flatMap((p) => p.venues.filter((v) => !v.url));
  if (!missing.length) return;
  const names = [...new Set(missing.map((v) => v.name.en))].slice(0, 20);
  let parsed: unknown;
  try {
    parsed = firstJsonObject(await runVenueLinkSearch(buildVenueLinkPrompt(names, destination)));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const map = parsed as Record<string, unknown>;
  const byLowerName = new Map(Object.entries(map).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const p of phases) {
    for (const v of p.venues) {
      if (v.url) continue;
      const hit = plain(byLowerName.get(v.name.en.trim().toLowerCase()));
      if (/^https?:\/\/\S+$/i.test(hit)) v.url = hit;
    }
  }
}

export async function extractItinerary(args: ExtractItineraryArgs): Promise<ExtractItineraryResult> {
  if (!HERMES_EXTRACT_PROFILE) return { ok: false, reason: "EXTRACT_NOT_CONFIGURED" };
  if (!args.documentText || !args.documentText.trim()) {
    return { ok: false, reason: "EXTRACTION_FAILED", detail: "no document text" };
  }
  let stdout: string;
  try {
    stdout = await runExtract(buildExtractPrompt(args));
  } catch (e) {
    return { ok: false, reason: "EXTRACTION_FAILED", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  const parsed = firstJsonObject(stdout);
  if (!parsed) return { ok: false, reason: "EXTRACTION_FAILED", detail: "no JSON object in model output" };
  const { phases, warnings } = normaliseExtractedItinerary(parsed, args.phases);
  // A venue's official/ticket link comes from the document when it prints one;
  // otherwise web-search for it here so the site can show a 🎫 button.
  try {
    await resolveVenueLinks(phases, args.destination);
  } catch { /* best-effort */ }
  return { ok: true, phases, warnings };
}
