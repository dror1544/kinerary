import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { normaliseConsularResult, buildConsularPrompt } from "../src/consular-lookup.js";

describe("normaliseConsularResult", () => {
  test("keeps a well-formed contact and mirrors the missing name side", () => {
    const raw = {
      contacts: [
        { name: { he: "שגרירות ישראל", en: "Embassy of Israel" }, phone: "+81-3-3264-0911" },
        { name: { en: "Emergency line" }, phone: "+81 90 1234 5678" },
      ],
    };
    const { contacts, warnings } = normaliseConsularResult(raw);
    assert.equal(warnings.length, 0);
    assert.equal(contacts.length, 2);
    assert.deepEqual(contacts[1].name, { he: "Emergency line", en: "Emergency line" });
  });

  test("accepts a bare array and an {emergency_contacts:[...]} envelope", () => {
    const bare = [{ name: { en: "X" }, phone: "+1 202 000 0000" }];
    assert.equal(normaliseConsularResult(bare).contacts.length, 1);
    assert.equal(normaliseConsularResult({ emergency_contacts: bare }).contacts.length, 1);
  });

  test("strips angle brackets from the name and non-dial characters from the phone", () => {
    const raw = { contacts: [{ name: { en: "<b>Embassy</b>" }, phone: "tel:+1 (202) 555-0100 ext.9" }] };
    const { contacts } = normaliseConsularResult(raw);
    assert.ok(!/[<>]/.test(contacts[0].name.en));
    assert.match(contacts[0].name.en, /Embassy/);
    assert.equal(contacts[0].phone, "+1 (202) 555-0100 9");
  });

  test("drops a contact with no phone or no name, with a warning", () => {
    const raw = { contacts: [
      { name: { en: "No phone" } },
      { phone: "+1 202 000 0000" },
      { name: { en: "Good" }, phone: "+1 202 111 2222" },
    ] };
    const { contacts, warnings } = normaliseConsularResult(raw);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name.en, "Good");
    assert.equal(warnings.length, 2);
  });

  test("garbage yields an empty result, not a throw", () => {
    assert.deepEqual(normaliseConsularResult(null), { contacts: [], warnings: [] });
    assert.deepEqual(normaliseConsularResult("nope"), { contacts: [], warnings: [] });
    assert.deepEqual(normaliseConsularResult({ contacts: 3 }), { contacts: [], warnings: [] });
  });

  test("caps the list at 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: { en: `Office ${i}` }, phone: `+1 202 000 00${i}` }));
    assert.equal(normaliseConsularResult({ contacts: many }).contacts.length, 8);
  });
});

describe("buildConsularPrompt", () => {
  test("names both countries, asks for web search and pins the JSON shape", () => {
    const prompt = buildConsularPrompt({ destination: "Japan", homeCountry: "Israel" });
    assert.match(prompt, /Israel embassy .* in Japan/);
    assert.match(prompt, /web search/i);
    assert.match(prompt, /"contacts": \[ \{ "name"/);
    assert.match(prompt, /both "he" \(Hebrew\) and "en"/);
  });
});
