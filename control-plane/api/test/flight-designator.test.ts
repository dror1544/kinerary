/**
 * A flight number is not a confirmation, and that is a rule rather than a
 * judgement.
 *
 * `travel_anchors` means "already booked", and the confirmation is what makes
 * it mean that. On 2026-09-20 the interpreter filled the field with the flight
 * number, from an organizer who had booked nothing and said so, and the site
 * told the family two bookings were confirmed. The count reporting it was
 * already correct (#124) and was being fed this.
 *
 * The cost of over-reaching here is deleting a real booking reference, so the
 * assertions below are as much about what this must NOT touch.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isFlightDesignator,
  validateAnswer,
  withoutFlightNumbersAsConfirmations,
} from "../src/interview.js";

describe("isFlightDesignator", () => {
  test("recognises the ordinary IATA shapes", () => {
    for (const value of ["VN572", "LY381", "BA1", "AF1234", "vn572", "VN 572", "VN-572"]) {
      assert.equal(isFlightDesignator(value), true, value);
    }
  });

  test("recognises airline codes that carry a digit, and ICAO codes", () => {
    // "U2" (easyJet) and "9W" are real two-character codes; BAW is ICAO.
    for (const value of ["U26301", "9W123", "BAW123", "LH400A"]) {
      assert.equal(isFlightDesignator(value), true, value);
    }
  });

  test("does not recognise a booking reference", () => {
    // Six alphanumerics with letters after digits — the ordinary PNR shape.
    for (const value of ["XR7T2Q", "PH-88213", "SL-58213", "ABCDEF", "12345", ""]) {
      assert.equal(isFlightDesignator(value), false, value);
    }
  });
});

describe("withoutFlightNumbersAsConfirmations", () => {
  const anchor = (over: Record<string, unknown> = {}) => ({
    type: "flight", name: "VN572 תל אביב-האנוי", date: "2028-03-05", confirmation: "VN572", ...over,
  });

  test("a flight whose confirmation restates its own name loses it", () => {
    const [out] = withoutFlightNumbersAsConfirmations([anchor()]) as Record<string, unknown>[];
    assert.equal(out!.confirmation, undefined, "not evidence of a booking");
    assert.equal(out!.flight_number, "VN572", "but not thrown away either");
    assert.equal(out!.date, "2028-03-05", "everything else is untouched");
  });

  test("a real booking reference on the same flight is kept", () => {
    const [out] = withoutFlightNumbersAsConfirmations([
      anchor({ confirmation: "XR7T2Q" }),
    ]) as Record<string, unknown>[];
    assert.equal(out!.confirmation, "XR7T2Q");
  });

  test("a hotel confirmation that merely looks designator-shaped is kept", () => {
    // `HB-2217` matches the pattern exactly. This is why the pattern alone
    // must never decide, and why the rule is scoped to flights.
    const [out] = withoutFlightNumbersAsConfirmations([
      { type: "hotel", name: "Hotel Borg", confirmation: "HB-2217" },
    ]) as Record<string, unknown>[];
    assert.equal(out!.confirmation, "HB-2217");
  });

  test("a flight designator NOT in the name is left alone", () => {
    // It cannot be told from a real reference without guessing, and guessing
    // here loses data. Recorded as a deliberate gap, not an oversight.
    const [out] = withoutFlightNumbersAsConfirmations([
      anchor({ name: "flight to Hanoi" }),
    ]) as Record<string, unknown>[];
    assert.equal(out!.confirmation, "VN572");
  });

  test("an existing flight_number is not overwritten", () => {
    const [out] = withoutFlightNumbersAsConfirmations([
      anchor({ flight_number: "VN572A" }),
    ]) as Record<string, unknown>[];
    assert.equal(out!.flight_number, "VN572A");
    assert.equal(out!.confirmation, undefined);
  });

  test("anything that is not a list of anchors passes through untouched", () => {
    assert.deepEqual(withoutFlightNumbersAsConfirmations({ a: 1 }), { a: 1 });
    assert.deepEqual(withoutFlightNumbersAsConfirmations([null, "x", 3]), [null, "x", 3]);
  });
});

describe("the rule is enforced where every path meets", () => {
  test("validateAnswer applies it, so no route can carry a flight number through", () => {
    // The model, the agent, a document and a typed answer all arrive at
    // validateAnswer. Enforcing it here is what makes it authoritative rather
    // than a correction one caller remembers to make.
    const result = validateAnswer("travel_anchors", null, null, undefined, [
      { type: "flight", name: "VN571 סייגון-תל אביב", date: "2028-03-20", confirmation: "VN571" },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [stored] = (result.answer as { data: Record<string, unknown>[] }).data;
    assert.equal(stored!.confirmation, undefined);
    assert.equal(stored!.flight_number, "VN571");
  });

  test("a question with no rule of its own is stored exactly as given", () => {
    const travelers = [{ name: "דרור אלול", name_en: "Dror Elul", family: "Elul" }];
    const result = validateAnswer("travelers", null, null, undefined, travelers);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.answer as { data: unknown }).data, travelers);
  });
});
