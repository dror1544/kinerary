import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDestinationInfoPrompt,
  destinationInfoIsEmpty,
  normaliseDestinationInfo,
} from "../src/destination-info.js";

test("the three rendered lists are parsed and mirrored into both languages", () => {
  const { info } = normaliseDestinationInfo({
    health: [{ he: "מי הברז ראויים לשתייה", en: "Tap water is safe" }],
    money: [{ en: "Cash is still common" }],
    communication: ["eSIM works"],
  });
  assert.equal(info.health[0].en, "Tap water is safe");
  // A model that answered in one language still produces a usable line rather
  // than a dropped one — the site falls back he -> en anyway.
  assert.equal(info.money[0].he, "Cash is still common");
  assert.deepEqual(info.communication[0], { he: "eSIM works", en: "eSIM works" });
});

test("markup is stripped — these lines render through a raw bilingual span", () => {
  const { info } = normaliseDestinationInfo({
    health: [{ he: "<script>alert(1)</script>", en: "<img src=x onerror=alert(1)> boil it" }],
  });
  assert.ok(!info.health[0].en.includes("<"));
  assert.ok(!info.health[0].he.includes("<"));
});

test("hospitals and age notes are never produced, whatever the model returns", () => {
  // BOTH dropped deliberately, on the same ground: hospitals (Dror,
  // 2026-09-19) because a plausible-but-wrong hospital name is the failure mode
  // that decision exists to avoid, and age limits (Dror, 2026-09-22) because no
  // deterministic API answers them, so an age note could only ever be
  // unverifiable model prose about a legal question. The prompt rules out both
  // by name; this proves a model that volunteers them anyway is still ignored,
  // because the exclusion has to hold at the point data enters a trip config
  // and not only in the wording of the request.
  const { info } = normaliseDestinationInfo({
    health: [{ he: "טוב", en: "fine" }],
    hospitals: [{ area: "Tokyo", name: "Invented General Hospital" }],
    age_notes: [{ who: "kids", note: "must be 18" }],
  });
  assert.deepEqual(Object.keys(info).sort(), ["communication", "health", "money"]);
  assert.equal(info.health.length, 1);
});

test("a non-list, an empty line and junk are dropped with a reason", () => {
  const { info, warnings } = normaliseDestinationInfo({
    health: "not a list",
    money: [{ he: "  ", en: "" }, 42, { en: "real" }],
  });
  assert.equal(info.health.length, 0);
  assert.equal(info.money.length, 1);
  assert.ok(warnings.some((w) => w.includes("health")));
});

test("lists are capped so a runaway answer cannot reflow the Info tab", () => {
  const { info, warnings } = normaliseDestinationInfo({
    money: Array.from({ length: 20 }, (_, i) => ({ he: `ה${i}`, en: `line ${i}` })),
  });
  assert.equal(info.money.length, 6);
  assert.ok(warnings.some((w) => w.includes("kept the first 6 of 20")));
});

test("a long line is truncated rather than dropped", () => {
  const { info } = normaliseDestinationInfo({ money: [{ en: "x".repeat(500), he: "y" }] });
  assert.equal(info.money[0].en.length, 220);
});

test("garbage in produces an empty result the caller can detect", () => {
  assert.equal(destinationInfoIsEmpty(normaliseDestinationInfo(null).info), true);
  assert.equal(destinationInfoIsEmpty(normaliseDestinationInfo({ health: [] }).info), true);
  assert.equal(destinationInfoIsEmpty(normaliseDestinationInfo({ health: [{ en: "a" }] }).info), false);
});

test("the prompt forbids the facts an API already answers and the ones we refuse to guess", () => {
  const prompt = buildDestinationInfoPrompt("Japan");
  assert.ok(prompt.includes("Japan"));
  // Deterministic first: asking a model for these would pay for, and risk
  // getting wrong, facts countries.dev and the emergency table already give.
  for (const forbidden of ["hospitals", "emergency phone numbers", "currency", "country calling", "age limits"]) {
    assert.ok(prompt.includes(forbidden), `prompt should rule out ${forbidden}`);
  }
  assert.ok(prompt.includes('"he"') && prompt.includes('"en"'));
});
