import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  normaliseExtractedItinerary,
  buildExtractPrompt,
  type PhaseRef,
} from "../src/itinerary-extract.js";

const PHASES: PhaseRef[] = [
  { name: "Tokyo", start: "2026-09-19", end: "2026-09-23" },
  { name: "Kyoto", start: "2026-09-24", end: "2026-09-27" },
];

const JAPAN_PHASES: PhaseRef[] = [
  { name: "Tokyo", start: "2026-09-19", end: "2026-09-23" },
  { name: "Hakone", start: "2026-09-23", end: "2026-09-24" },
  { name: "Kyoto", start: "2026-09-24", end: "2026-09-27" },
  { name: "Osaka", start: "2026-09-27", end: "2026-09-30" },
  { name: "Tokyo", start: "2026-09-30", end: "2026-10-03" },
];

describe("normaliseExtractedItinerary", () => {
  test("keeps a well-formed day and mirrors the language it was given", () => {
    const raw = {
      phases: [
        {
          name: "Tokyo",
          days: [
            {
              date: "2026-09-20",
              label: { en: "Arrival & Asakusa" },
              items: [
                { time: "10:00", text: { en: "Tokyo Skytree" } },
                { time: null, text: { he: "אסקוסה בערב" } },
              ],
            },
          ],
        },
      ],
    };
    const { phases, warnings } = normaliseExtractedItinerary(raw, PHASES);
    assert.equal(warnings.length, 0);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].phaseIndex, 0);
    const day = phases[0].days[0];
    assert.deepEqual(day.label, { he: "Arrival & Asakusa", en: "Arrival & Asakusa" });
    assert.equal(day.items[0].time, "10:00");
    assert.deepEqual(day.items[0].text, { he: "Tokyo Skytree", en: "Tokyo Skytree" });
    assert.equal(day.items[1].time, null);
    assert.deepEqual(day.items[1].text, { he: "אסקוסה בערב", en: "אסקוסה בערב" });
  });

  test("drops an unknown phase name and records a warning", () => {
    const raw = { phases: [{ name: "Osaka", days: [{ date: "2026-09-25", items: [{ text: { en: "x" } }] }] }] };
    const { phases, warnings } = normaliseExtractedItinerary(raw, PHASES);
    assert.equal(phases.length, 0);
    assert.match(warnings[0], /Osaka/);
  });

  test("drops days outside the phase range and unparseable dates", () => {
    const raw = {
      phases: [
        {
          name: "Tokyo",
          days: [
            { date: "2026-09-20", items: [{ text: { en: "in range" } }] },
            { date: "2026-09-30", items: [{ text: { en: "out of range" } }] },
            { date: "next tuesday", items: [{ text: { en: "unparseable" } }] },
          ],
        },
      ],
    };
    const { phases, warnings } = normaliseExtractedItinerary(raw, PHASES);
    assert.deepEqual(phases[0].days.map((d) => d.date), ["2026-09-20"]);
    assert.equal(warnings.length, 2);
  });

  test("strips angle brackets from label and text", () => {
    const raw = {
      phases: [
        {
          name: "Tokyo",
          days: [
            {
              date: "2026-09-20",
              label: { en: "<b>Day 1</b>", he: "יום 1" },
              items: [{ text: { en: "<img src=x onerror=alert(1)> museum" } }],
            },
          ],
        },
      ],
    };
    const { phases } = normaliseExtractedItinerary(raw, PHASES);
    const day = phases[0].days[0];
    assert.ok(!/[<>]/.test(day.label!.en));
    assert.ok(!/[<>]/.test(day.items[0].text.en));
    assert.match(day.items[0].text.en, /museum/);
  });

  test("coerces a non-HH:MM time to null and drops an item with empty text", () => {
    const raw = {
      phases: [
        {
          name: "Kyoto",
          days: [
            {
              date: "2026-09-25",
              items: [
                { time: "morning", text: { en: "loose time" } },
                { time: "9:00", text: { en: "single digit hour" } },
                { time: "09:00", text: { en: "" } },
              ],
            },
          ],
        },
      ],
    };
    const { phases } = normaliseExtractedItinerary(raw, PHASES);
    const items = phases[0].days[0].items;
    assert.equal(items.length, 2);
    assert.equal(items[0].time, null);
    assert.equal(items[1].time, null);
  });

  test("a day with no valid items is dropped; a phase with no days is dropped", () => {
    const raw = {
      phases: [
        { name: "Tokyo", days: [{ date: "2026-09-20", items: [{ text: {} }] }, { date: "2026-09-21", items: [] }] },
      ],
    };
    const { phases } = normaliseExtractedItinerary(raw, PHASES);
    assert.equal(phases.length, 0);
  });

  test("accepts a bare array or an {itinerary:[...]} envelope", () => {
    const bare = [{ name: "Tokyo", days: [{ date: "2026-09-20", items: [{ text: { en: "x" } }] }] }];
    assert.equal(normaliseExtractedItinerary(bare, PHASES).phases.length, 1);
    const wrapped = { itinerary: bare };
    assert.equal(normaliseExtractedItinerary(wrapped, PHASES).phases.length, 1);
  });

  test("a repeated phase name is split by date range across both occurrences", () => {
    // The model returns ONE "Tokyo" block spanning both the first stop and the
    // return stop — each day must land on the occurrence whose range holds it.
    const raw = {
      phases: [
        {
          name: "Tokyo",
          days: [
            { date: "2026-09-20", items: [{ text: { en: "Skytree (first stop)" } }] },
            { date: "2026-10-02", items: [{ text: { en: "Shibuya (return stop)" } }] },
          ],
        },
      ],
    };
    const { phases, warnings } = normaliseExtractedItinerary(raw, JAPAN_PHASES);
    assert.equal(warnings.length, 0);
    assert.deepEqual(
      phases.map((p) => [p.phaseIndex, p.days.map((d) => d.date)]),
      [[0, ["2026-09-20"]], [4, ["2026-10-02"]]],
    );
  });

  test("no range on a phase means every parseable date is kept", () => {
    const undated: PhaseRef[] = [{ name: "Roadtrip" }];
    const raw = { phases: [{ name: "Roadtrip", days: [{ date: "2099-01-01", items: [{ text: { en: "far future" } }] }] }] };
    assert.equal(normaliseExtractedItinerary(raw, undated).phases[0].days.length, 1);
  });

  test("venues are collected with a valid url and deduped by name", () => {
    const raw = {
      phases: [
        {
          name: "Tokyo",
          days: [{ date: "2026-09-20", items: [{ text: { en: "Skytree" } }] }],
          venues: [
            { name: { en: "Tokyo Skytree", he: "סקייטרי" }, url: "https://www.tokyo-skytree.jp/en/" },
            { name: { en: "tokyo skytree" }, url: "https://dup" },
            { name: { en: "TeamLab" }, url: "not-a-url" },
            { name: {} },
          ],
        },
      ],
    };
    const { phases } = normaliseExtractedItinerary(raw, PHASES);
    assert.equal(phases[0].venues.length, 2);
    assert.equal(phases[0].venues[0].url, "https://www.tokyo-skytree.jp/en/");
    assert.equal(phases[0].venues[1].url, undefined); // "not-a-url" dropped
  });

  test("a phase with only venues (no days) is still returned", () => {
    const raw = { phases: [{ name: "Kyoto", venues: [{ name: { en: "Fushimi Inari" } }] }] };
    const { phases } = normaliseExtractedItinerary(raw, PHASES);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].phaseIndex, 1);
    assert.equal(phases[0].days.length, 0);
    assert.equal(phases[0].venues[0].name.he, "Fushimi Inari");
  });

  test("a repeated-name phase routes its venues to the first occurrence", () => {
    const raw = { phases: [{ name: "Tokyo", venues: [{ name: { en: "Shibuya Crossing" } }] }] };
    const { phases } = normaliseExtractedItinerary(raw, JAPAN_PHASES);
    assert.deepEqual(phases.map((p) => p.phaseIndex), [0]);
  });

  test("garbage input yields an empty result, not a throw", () => {
    assert.deepEqual(normaliseExtractedItinerary(null, PHASES), { phases: [], warnings: [] });
    assert.deepEqual(normaliseExtractedItinerary("nope", PHASES), { phases: [], warnings: [] });
    assert.deepEqual(normaliseExtractedItinerary({ phases: "not an array" }, PHASES), { phases: [], warnings: [] });
  });
});

describe("buildExtractPrompt", () => {
  test("names each phase with its date range and pins the JSON shape", () => {
    const prompt = buildExtractPrompt({
      destination: "Japan",
      phases: PHASES,
      travelers: ["Nir", "Ella"],
      documentText: "Day 1: land at Narita, transfer to Asakusa.",
    });
    assert.match(prompt, /Tokyo: 2026-09-19 to 2026-09-23/);
    assert.match(prompt, /Travelers: Nir, Ella/);
    assert.match(prompt, /"phases": \[ \{ "name"/);
    assert.match(prompt, /land at Narita/);
    assert.match(prompt, /BOTH "he" \(Hebrew\) and "en"/);
  });

  test("truncates a very long document", () => {
    const prompt = buildExtractPrompt({
      destination: "Japan",
      phases: PHASES,
      documentText: "x".repeat(50000),
    });
    // 20 000-char document cap + a small fixed preamble.
    assert.ok(prompt.length < 22000, `prompt was ${prompt.length}`);
    assert.ok(!prompt.includes("x".repeat(20001)));
  });
});
