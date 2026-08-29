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

export type PhaseRef = { name: string; start?: string; end?: string };
type Bi = { he: string; en: string };
export type ItineraryItem = { time: string | null; text: Bi };
export type ItineraryDay = { date: string; label?: Bi; items: ItineraryItem[] };
/** `phaseIndex` is the 0-based position in the `phases` array passed to the
 * extractor — the interviewer folds `days` back in at that index, which
 * disambiguates a name that repeats (e.g. two "Tokyo" stops). */
export type ExtractedPhase = { name: string; phaseIndex: number; days: ItineraryDay[] };

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

  // Accumulate days per phase index (a single model "Tokyo" block can feed two).
  const daysByIndex = new Map<number, ItineraryDay[]>();

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const key = plain(b.name).toLowerCase();
    const candidates = byName.get(key);
    if (!candidates || !candidates.length) {
      if (key) warnings.push(`dropped unknown phase "${plain(b.name)}"`);
      continue;
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
  for (const [index, days] of [...daysByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const ref = phases[index];
    if (!ref) continue;
    days.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : 0));
    out.push({ name: ref.name, phaseIndex: index, days });
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
    ``,
    `Return exactly:`,
    `{ "phases": [ { "name": "<phase name>", "days": [ { "date": "YYYY-MM-DD", "label": { "he": "...", "en": "..." }, "items": [ { "time": "HH:MM" | null, "text": { "he": "...", "en": "..." } } ] } ] } ] }`,
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
  return { ok: true, phases, warnings };
}
