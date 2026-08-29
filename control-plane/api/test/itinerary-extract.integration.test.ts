/**
 * itinerary-extract.integration.test.ts — one real end-to-end extraction
 * against a fixture itinerary, asserting the OUTPUT FORMAT (not its content,
 * which the model produces non-deterministically).
 *
 * The pure normaliser is covered exhaustively in itinerary-extract.test.ts;
 * this proves a live model call, run through the same normaliser, yields
 * something the site's config contract accepts:
 *   - phases map to the ones we passed (by name), phaseIndex is a real index;
 *   - every day.date is YYYY-MM-DD inside its phase range;
 *   - every label/text carries both he and en, plain text (no `<` or `>`);
 *   - every item.time is exactly HH:MM or null;
 *   - every venue.name is bilingual; venue.url, when present, is a plain
 *     http(s) URL and not a personal booking docket.
 *
 * Skipped unless HERMES_EXTRACT_PROFILE is set (same gate style as the
 * DB-backed suites). Set HERMES_SEARCH_PROFILE too to also exercise the
 * venue-link web search.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractItinerary, acceptableVenueUrl, type PhaseRef } from "../src/itinerary-extract.js";

const skip = !process.env.HERMES_EXTRACT_PROFILE;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

const PHASES: PhaseRef[] = [
  { name: "Tokyo", start: "2026-09-19", end: "2026-09-23" },
  { name: "Hakone", start: "2026-09-23", end: "2026-09-24" },
  { name: "Kyoto", start: "2026-09-24", end: "2026-09-27" },
  { name: "Osaka", start: "2026-09-27", end: "2026-09-30" },
  { name: "Tokyo", start: "2026-09-30", end: "2026-10-03" },
];

const documentText = readFileSync(
  fileURLToPath(new URL("./fixtures/itinerary-sample.txt", import.meta.url)),
  "utf8",
);

const bi = (v: unknown, where: string) => {
  assert.ok(v && typeof v === "object", `${where}: not an object`);
  const o = v as Record<string, unknown>;
  assert.equal(typeof o.he, "string", `${where}.he not a string`);
  assert.equal(typeof o.en, "string", `${where}.en not a string`);
  assert.ok((o.he as string).length > 0 && (o.en as string).length > 0, `${where}: empty side`);
  assert.ok(!/[<>]/.test(o.he as string) && !/[<>]/.test(o.en as string), `${where}: markup leaked`);
};

test("a real extraction of the fixture conforms to the site's day/venue contract", { skip }, async () => {
  const result = await extractItinerary({
    destination: "Japan",
    phases: PHASES,
    travelers: ["Nir", "Ella", "Noa", "Maya", "Shai"],
    documentText,
  });

  assert.equal(result.ok, true, `extraction failed: ${JSON.stringify(result)}`);
  if (!result.ok) return;

  assert.ok(Array.isArray(result.phases), "phases is not an array");
  assert.ok(result.phases.length > 0, "no phases extracted from a rich document");
  assert.ok(Array.isArray(result.warnings));
  assert.ok(Array.isArray(result.venueLinksDeferred));

  const known = new Set(PHASES.map((p) => p.name.toLowerCase()));

  for (const phase of result.phases) {
    assert.ok(known.has(phase.name.toLowerCase()), `unknown phase name "${phase.name}"`);
    assert.ok(Number.isInteger(phase.phaseIndex) && PHASES[phase.phaseIndex], `bad phaseIndex ${phase.phaseIndex}`);
    assert.equal(PHASES[phase.phaseIndex]!.name.toLowerCase(), phase.name.toLowerCase());
    assert.ok(Array.isArray(phase.days) && Array.isArray(phase.venues));
    assert.ok(phase.days.length || phase.venues.length, `phase "${phase.name}" has neither days nor venues`);

    const { start, end } = PHASES[phase.phaseIndex]!;
    for (const day of phase.days) {
      assert.ok(ISO.test(day.date), `day.date "${day.date}" is not YYYY-MM-DD`);
      assert.ok(!Number.isNaN(Date.parse(day.date)), `day.date "${day.date}" does not parse`);
      if (start && end) assert.ok(start <= day.date && day.date <= end, `day ${day.date} outside ${phase.name} ${start}..${end}`);
      if (day.label !== undefined) bi(day.label, `${phase.name} ${day.date} label`);
      assert.ok(Array.isArray(day.items) && day.items.length > 0, `${phase.name} ${day.date}: no items`);
      for (const [i, item] of day.items.entries()) {
        assert.ok(item.time === null || HHMM.test(item.time), `${phase.name} ${day.date} item ${i}: time "${item.time}"`);
        bi(item.text, `${phase.name} ${day.date} item ${i} text`);
      }
    }

    for (const [i, venue] of phase.venues.entries()) {
      bi(venue.name, `${phase.name} venue ${i} name`);
      if (venue.url !== undefined) {
        assert.match(venue.url, /^https?:\/\/\S+$/i, `${phase.name} venue ${i}: url "${venue.url}"`);
        assert.equal(acceptableVenueUrl(venue.url), venue.url, `${phase.name} venue ${i}: url is a booking docket / malformed`);
      }
      if (venue.area !== undefined) {
        assert.equal(typeof venue.area, "string");
        assert.ok(!/[<>]/.test(venue.area), `${phase.name} venue ${i}: area markup`);
      }
    }
  }
});
