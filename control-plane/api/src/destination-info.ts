/**
 * Destination info — the Health / Money / Communication lists on a trip site's
 * Info tab (Sprint 6 track 1a, issue #156).
 *
 * DETERMINISTIC FIRST, A MODEL ONLY AT THE GAPS. The facts an API answers —
 * currency, country calling code, emergency numbers — are NOT here. They are
 * computed per trip in the worker (`enrichment._enrich_destination_info`) from
 * what countries.dev and the emergency table already returned for that country,
 * which costs nothing extra and is always present. This module covers only the
 * remainder, for which no keyless API exists: tap water, pharmacies, cash-vs-
 * card, ATMs, tipping, SIM/eSIM, wifi. That remainder is prose, so it is
 * model-sourced, so it is cached cross-trip in country_reference and paid for
 * once per destination per month rather than once per trip.
 *
 * HOSPITALS ARE DELIBERATELY ABSENT (Dror, 2026-09-19). `info.hospitals` is
 * rendered by the site and will stay empty: in an emergency the emergency
 * NUMBER is what matters and it is already sourced and real, whereas a
 * plausible-but-wrong hospital name is a failure mode not worth carrying. The
 * prompt below says so explicitly so a helpful model does not add them back.
 *
 * AGE RESTRICTIONS ARE EXCLUDED ON THE SAME GROUND (Dror, 2026-09-22), and for
 * the same reason rather than by analogy: no deterministic API answers legal
 * age limits, so an age note could only ever be unverifiable model prose about
 * a legal question. `info.age_notes` stays rendered and empty exactly as
 * `info.hospitals` does. The prompt rules both out by name.
 *
 * Everything this returns is marked `source: "model"` when the worker merges it
 * into a trip config, precisely because it is advisory rather than verified.
 */
import { firstJsonObject, plainText, runHermesWebSearch } from "./hermes-search.js";
import { isRateLimited } from "./itinerary-extract.js";

// Same posture as the consular lookup: one HERMES_SEARCH_PROFILE can serve
// every web-search task, with a per-task override for the rare case they want
// a different profile.
const HERMES_DESTINATION_INFO_PROFILE =
  process.env.HERMES_DESTINATION_INFO_PROFILE || process.env.HERMES_SEARCH_PROFILE || "";
const LOOKUP_TIMEOUT_MS = Number(process.env.DESTINATION_INFO_TIMEOUT_MS || "120000");

/** Max items kept per list, and max characters per side of one item. The site
 * renders these as list rows; a model that returns an essay gets truncated
 * rather than allowed to reflow the Info tab. */
const MAX_ITEMS_PER_LIST = 6;
const MAX_ITEM_CHARS = 220;

export const DESTINATION_INFO_LISTS = ["health", "money", "communication"] as const;
export type DestinationInfoList = (typeof DESTINATION_INFO_LISTS)[number];

export type BilingualLine = { he: string; en: string };
export type DestinationInfo = Record<DestinationInfoList, BilingualLine[]>;

export type DestinationInfoResult =
  | { ok: true; info: DestinationInfo; warnings: string[] }
  | { ok: false; reason: "LOOKUP_NOT_CONFIGURED" | "LOOKUP_FAILED" | "RATE_LIMITED"; detail?: string };

export function destinationInfoSearchConfigured(): boolean {
  return Boolean(HERMES_DESTINATION_INFO_PROFILE);
}

/** The profile name, for the log line that says which one produced a row. */
export function destinationInfoProfile(): string {
  return HERMES_DESTINATION_INFO_PROFILE;
}

/** Shared with `normaliseConsularResult` — the site renders both through the
 * same bilingual span, and `site/app.js` builds that span as raw HTML. */
const plain = (value: unknown) => plainText(value, MAX_ITEM_CHARS);

function emptyInfo(): DestinationInfo {
  return { health: [], money: [], communication: [] };
}

export function normaliseDestinationInfo(raw: unknown): { info: DestinationInfo; warnings: string[] } {
  const warnings: string[] = [];
  const info = emptyInfo();
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  for (const key of DESTINATION_INFO_LISTS) {
    const list = source[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      warnings.push(`dropped "${key}" — not a list`);
      continue;
    }
    for (const entry of list.slice(0, MAX_ITEMS_PER_LIST)) {
      // A bare string is accepted and mirrored: the model occasionally answers
      // with one language when the prompt asked for two, and a usable line in
      // one language beats dropping it.
      const asString = typeof entry === "string" ? entry : "";
      const obj = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const he = plain(obj.he ?? asString);
      const en = plain(obj.en ?? asString);
      if (!he && !en) {
        warnings.push(`dropped an empty ${key} line`);
        continue;
      }
      info[key].push({ he: he || en, en: en || he });
    }
    if (list.length > MAX_ITEMS_PER_LIST) {
      warnings.push(`kept the first ${MAX_ITEMS_PER_LIST} of ${list.length} ${key} lines`);
    }
  }
  return { info, warnings };
}

/** True when there is nothing worth storing — every list came back empty. */
export function destinationInfoIsEmpty(info: DestinationInfo): boolean {
  return DESTINATION_INFO_LISTS.every((key) => info[key].length === 0);
}

export function buildDestinationInfoPrompt(destination: string): string {
  return [
    `A family is travelling to ${destination}. Use web search to check current practical advice`,
    `for visitors, then return ONLY a JSON object, no commentary.`,
    ``,
    `Three lists, each a few short practical lines a traveller would act on:`,
    `  "health"        — tap water, vaccinations or health requirements, pharmacies,`,
    `                    travel insurance, anything seasonal worth knowing.`,
    `  "money"         — cash versus card in practice, ATMs, tipping customs,`,
    `                    tax refund for visitors if there is one.`,
    `  "communication" — SIM / eSIM availability, mobile coverage, public wifi,`,
    `                    the power plug type and voltage.`,
    ``,
    `Do NOT list hospitals, clinics or any named medical facility — a wrong name`,
    `is dangerous and the emergency phone numbers are sourced separately.`,
    `Do NOT list emergency phone numbers, the currency, or the country calling`,
    `code — those are already filled in from an API. Do NOT give age limits or`,
    `legal age restrictions. Do not guess: leave a list shorter, or empty,`,
    `rather than writing something you could not check.`,
    ``,
    `Return exactly:`,
    `{ "health": [ { "he": "...", "en": "..." } ], "money": [ ... ], "communication": [ ... ] }`,
    `Provide both "he" (Hebrew) and "en" (English) for every line — you translate.`,
    `One sentence per line, at most ${MAX_ITEMS_PER_LIST} lines per list.`,
  ].join("\n");
}

export async function lookupDestinationInfo(destination: string): Promise<DestinationInfoResult> {
  if (!HERMES_DESTINATION_INFO_PROFILE) return { ok: false, reason: "LOOKUP_NOT_CONFIGURED" };
  if (!destination?.trim()) {
    return { ok: false, reason: "LOOKUP_FAILED", detail: "destination is required" };
  }
  let stdout: string;
  try {
    stdout = await runHermesWebSearch({
      profile: HERMES_DESTINATION_INFO_PROFILE,
      prompt: buildDestinationInfoPrompt(destination.trim()),
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 200);
    // A rate limit is transient and must not burn the row's monthly slot — the
    // store leaves fetched_at alone so the next pass retries.
    return { ok: false, reason: isRateLimited(detail) ? "RATE_LIMITED" : "LOOKUP_FAILED", detail };
  }
  const parsed = firstJsonObject(stdout);
  if (!parsed) return { ok: false, reason: "LOOKUP_FAILED", detail: "no JSON object in model output" };
  const { info, warnings } = normaliseDestinationInfo(parsed);
  if (destinationInfoIsEmpty(info)) {
    return { ok: false, reason: "LOOKUP_FAILED", detail: "no usable lines found" };
  }
  return { ok: true, info, warnings };
}
