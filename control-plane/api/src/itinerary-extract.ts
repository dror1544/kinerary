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

/** Whether a web-search profile is configured for venue-link resolution. The
 * API's background drain only schedules itself when this is true. */
export function venueLinkSearchConfigured(): boolean {
  return Boolean(HERMES_SEARCH_PROFILE);
}

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
  | { ok: true; phases: ExtractedPhase[]; warnings: string[]; venueLinksDeferred: string[] }
  | { ok: false; reason: "EXTRACT_NOT_CONFIGURED" | "EXTRACTION_FAILED"; detail?: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

/**
 * A provider "you've hit your quota / too many requests" response, as it
 * surfaces through the Hermes CLI (stderr, stdout, or a non-zero exit). A
 * rate-limited lookup is worth retrying later; a clean "no URL found" is not —
 * the two must not be conflated, or a transient limit becomes a permanent gap.
 */
export function isRateLimited(text: string): boolean {
  return /\b429\b|rate[\s-]?limit|usage limit|too many requests|quota (?:exceeded|reached)|overloaded|capacity/i.test(
    String(text ?? ""),
  );
}

function plain(value: unknown): string {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

// Booking-confirmation / reservation-docket links an uploaded itinerary PDF
// often prints for each item — personal, expiring, sometimes carrying a booking
// reference. They pass a bare "is it a URL" test but must never become a
// public 🎫 button. Also rejects a link with a collapsed line-wrap in it
// (`...` mid-URL) — plain() glues the wrapped remainder on with no space.
const BOOKING_DOCKET_URL =
  /docket|paxfile|bookingref|booking[-_]?id|reservation.*(?:id|ref)|confirmation.*(?:id|ref)|itinerary.*(?:id|ref)|travelbooster|[?&](?:pax|pnr|resid)=/i;

/** A URL fit to show as a venue's official / ticket link: well-formed, http(s),
 * and not a personal booking docket. */
export function acceptableVenueUrl(value: unknown): string {
  const url = plain(value);
  if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(url)) return "";
  if (url.includes("...") || BOOKING_DOCKET_URL.test(url)) return "";
  return url;
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
        const url = acceptableVenueUrl(v.url);
        if (url) venue.url = url;
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
    `- "venues": real places you could point to on a map that this phase visits (attractions, museums, temples, parks, named tour boats/trains with a station). NOT a rail pass, day-pass, ticket bundle or transport product — those go in a day's items, not here. For each venue give the name in "he" and "en", and "url" ONLY if the document prints the place's OWN official site or public ticket page (never guess a URL). Do NOT use a personal booking-confirmation link, a reservation docket, or any URL with a booking reference / customer id in it — omit "url" instead. Up to ~10 per phase; [] if none.`,
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
      // --ignore-rules, not --safe-mode: we still want a clean single-turn run
      // (no AGENTS.md / memory / preloaded skills), but --safe-mode also
      // discards the profile's model config, which is where the
      // kinerary-extract fallback chain (quota escalation) lives.
      ["-p", HERMES_EXTRACT_PROFILE, "chat", "-q", prompt, "-Q", "--ignore-rules", "--reasoning", "none"],
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error(`hermes CLI not found (HERMES_BIN=${HERMES_BIN})`));
        }
        const why = err.killed || err.signal ? `timed out (${EXTRACT_TIMEOUT_MS}ms)` : `exit ${(err as NodeJS.ErrnoException).code}`;
        const tail = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()}`.trim().slice(-250);
        reject(new Error(`hermes ${why}${tail ? ` — ${tail}` : ""}`));
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
      // -t web so the model actually searches instead of answering from memory
      // ("never guess a domain" only holds if it can look); --ignore-rules for
      // a clean run without dropping the profile's fallback chain.
      ["-p", HERMES_SEARCH_PROFILE, "chat", "-q", prompt, "-Q", "--ignore-rules", "-t", "web"],
      { timeout: VENUE_LINK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        // Keep stdout too — a rate-limit notice often comes back as model text,
        // not on stderr — so isRateLimited() upstream can see it.
        const detail = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()}`.trim().slice(-300);
        reject(new Error(`hermes venue-link search failed${detail ? ` — ${detail}` : ""}`));
      },
    );
  });
}

export type VenueUrlSearch =
  | { ok: true; urls: Map<string, string> }
  | { ok: false; rateLimited: boolean };

/**
 * Web-search a batch of venue names for a first-party / ticket URL. Shared by
 * extract_itinerary's inline pass and the API's deferred-retry drain
 * (venue-links.ts). Never throws. Returns `ok: false` with `rateLimited` set
 * when the provider knocked the call back — the caller parks those names for a
 * later retry rather than treating them as "no link exists".
 */
export async function searchVenueUrls(names: string[], destination: string): Promise<VenueUrlSearch> {
  if (!HERMES_SEARCH_PROFILE) return { ok: false, rateLimited: false };
  const unique = [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))].slice(0, 20);
  if (!unique.length) return { ok: true, urls: new Map() };
  let raw: string;
  try {
    raw = await runVenueLinkSearch(buildVenueLinkPrompt(unique, destination));
  } catch (e) {
    return { ok: false, rateLimited: isRateLimited(String((e as Error)?.message ?? e)) };
  }
  const parsed = firstJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return { ok: true, urls: new Map() };
  const urls = new Map<string, string>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const url = acceptableVenueUrl(v);
    if (url) urls.set(k.trim().toLowerCase(), url);
  }
  return { ok: true, urls };
}

/** Fill `venue.url` for venues that don't have one, by web search. Mutates
 * `phases` in place. Returns the venue names left unresolved *because the
 * search was rate-limited* — the caller parks those for the background drain to
 * retry. A clean "no URL found" is not deferred (the site still shows the
 * venue's Maps/Waze links). */
async function resolveVenueLinks(phases: ExtractedPhase[], destination: string): Promise<{ deferred: string[] }> {
  const missingNames = [
    ...new Set(phases.flatMap((p) => p.venues.filter((v) => !v.url).map((v) => v.name.en))),
  ];
  if (!missingNames.length) return { deferred: [] };
  const result = await searchVenueUrls(missingNames, destination);
  if (!result.ok) return { deferred: result.rateLimited ? missingNames : [] };
  for (const p of phases) {
    for (const v of p.venues) {
      if (v.url) continue;
      const hit = result.urls.get(v.name.en.trim().toLowerCase());
      if (hit) v.url = hit;
    }
  }
  return { deferred: [] };
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
  // otherwise web-search for it here so the site can show a 🎫 button. If the
  // search is rate-limited, the names come back in `deferred` for the caller to
  // park in venue_links for the background retry.
  let venueLinksDeferred: string[] = [];
  try {
    ({ deferred: venueLinksDeferred } = await resolveVenueLinks(phases, args.destination));
  } catch { /* best-effort */ }
  return { ok: true, phases, warnings, venueLinksDeferred };
}
