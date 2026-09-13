/**
 * The config the server actually sends — nulls included — must parse.
 *
 * 2026-09-13, a live trip built from an interview: five day items carried
 * `"time": null` (a hotel check-in has no time), `parity-schema.ts` typed that
 * field `z.string().optional()`, and `configSchema.parse` threw on the whole
 * config. The site answered 200 to every request and still showed "Offline or
 * stale data", no hero photo, no map stops, and only the days that had a plan —
 * every one of those fed from the config that failed to parse.
 *
 * The fixture is that trip's shape, trimmed: the fields that were null there
 * are null here.
 */
import { describe, expect, it } from "vitest";
import { configSchema } from "./api";

const SERVED = {
  meta: { title: "Japan 2026 — Family", defaultLang: "he", departure: "2026-09-19T00:00:00+00:00", returnDate: "2026-10-03" },
  map: { center: [35.252, 137.9809], zoom: 6, stops: [{ lat: 35.67, lng: 139.76, name: { he: "Tokyo", en: "Tokyo" } }] },
  travel_info: { countries: { Japan: { emergency: { general: null, police: "110", ambulance: "119" } } } },
  phases: [
    {
      id: "tokyo",
      title: { he: "טוקיו", en: "Tokyo" },
      dates: { start: "2026-09-19", end: "2026-09-23" },
      hero: { photo: "https://upload.wikimedia.org/wikipedia/commons/b/b2/Skyscrapers_of_Shinjuku_2009_January.jpg" },
      mapStop: { lat: 35.67, lng: 139.76, name: { he: "Tokyo", en: "Tokyo" } },
      venues: [{ id: "tokyo-skytree", name: { he: "טוקיו סקייטרי", en: "Tokyo Skytree" }, maps: "https://maps.example/skytree", url: null, waze: null }],
      days: [
        {
          date: "2026-09-19",
          label: { he: "הגעה", en: "Arrival" },
          items: [{ time: null, text: { he: "צ'ק-אין במלון", en: "Check in at OMO3 Asakusa" } }],
        },
      ],
    },
  ],
};

describe("the config the server sends parses, nulls and all", () => {
  it("accepts an untimed day item — the null that took the site down", () => {
    const parsed = configSchema.safeParse(SERVED);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });

  it("keeps everything the hero, the map and the day strip are built from", () => {
    const config = configSchema.parse(SERVED);
    const tokyo = config.phases?.[0];
    expect(tokyo?.hero?.photo).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
    expect(tokyo?.dates).toEqual({ start: "2026-09-19", end: "2026-09-23" });
    expect(tokyo?.mapStop?.lat).toBe(35.67);
  });
});
