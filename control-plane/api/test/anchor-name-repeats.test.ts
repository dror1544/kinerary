/**
 * A CAR BOOKING'S NAME DOES NOT SAY THE PICK-UP PLACE TWICE (#648).
 *
 * Found in the PR #633 staging test, 2026-11-23: a typed Hertz booking was filed
 * as `name: "רכב מ-Hertz שדה התעופה של לובליאנה שדה התעופה של לובליאנה"` - the
 * reader composes a car's name from its pick-up and its return place, and wrote
 * the same place for both. Type, date, time and confirmation were right.
 *
 * The repair is code, at the one gate every answer passes (`validateAnswer`
 * runs the question's `sanitize`), not another sentence for a model to follow.
 * Both producers go through that gate: a typed answer and a document's reading;
 * this test drives the gate itself.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INTAKE_QUESTIONS, validateAnswer, withoutRepeatedPlaceInCarName } from "../src/interview.js";

const car = (name: string, extra: Record<string, unknown> = {}) => ({ type: "car", name, ...extra });
const nameOf = (data: unknown) => ((data as Record<string, unknown>[])[0]!).name;

describe("withoutRepeatedPlaceInCarName (#648)", () => {
  test("the staging name: the repeated place is said once, every other field is kept", () => {
    const row = car("רכב מ-Hertz שדה התעופה של לובליאנה שדה התעופה של לובליאנה", { date: "2027-05-10", time: "08:30", confirmation: "H-5521" });
    const [out] = withoutRepeatedPlaceInCarName([row]) as Record<string, unknown>[];
    assert.deepEqual(out, { ...row, name: "רכב מ-Hertz שדה התעופה של לובליאנה" });
  });

  test("the same in English, case and trailing punctuation aside", () => {
    assert.equal(nameOf(withoutRepeatedPlaceInCarName([car("Hertz Ljubljana airport Ljubljana airport")])), "Hertz Ljubljana airport");
    assert.equal(nameOf(withoutRepeatedPlaceInCarName([car("Hertz Ljubljana Airport, ljubljana airport")])), "Hertz Ljubljana Airport");
    assert.equal(nameOf(withoutRepeatedPlaceInCarName([car("Hertz Ljubljana Airport ljubljana airport. ")])), "Hertz Ljubljana Airport");
  });

  test("the longest repeat wins, and a name that is a sequence repeated three times collapses to one", () => {
    assert.equal(nameOf(withoutRepeatedPlaceInCarName([car("Hertz Frankfurt airport terminal 1 Frankfurt airport terminal 1")])), "Hertz Frankfurt airport terminal 1");
    assert.equal(nameOf(withoutRepeatedPlaceInCarName([car("Frankfurt airport Frankfurt airport Frankfurt airport")])), "Frankfurt airport");
  });

  test("a different return place is kept: it is information, not a repeat", () => {
    for (const name of [
      "Hertz Ljubljana airport, return Zagreb airport",
      "רכב מ-Hertz שדה התעופה של לובליאנה עד שדה התעופה של זאגרב",
      "Hertz Ljubljana airport then Ljubljana city",
    ]) {
      assert.equal(nameOf(withoutRepeatedPlaceInCarName([car(name)])), name);
    }
  });

  test("a single repeated word is left alone: Bora Bora and Pago Pago are real places", () => {
    for (const name of ["Rental car pick-up Bora Bora", "Hertz Pago Pago airport", "Hertz Hertz"]) {
      assert.equal(nameOf(withoutRepeatedPlaceInCarName([car(name)])), name);
    }
  });

  test("only a car: a hotel or an attraction named like a repeat is the organizer's, and kept", () => {
    const hotel = { type: "hotel", name: "New York New York", confirmation: "NY-1" };
    const show = { type: "attraction", name: "Cirque du Soleil Cirque du Soleil" };
    assert.deepEqual(withoutRepeatedPlaceInCarName([hotel, show]), [hotel, show]);
  });

  test("a row that is not a car with a text name passes through untouched, whatever its shape", () => {
    const rows = [null, "x", 3, [], {}, { type: "car" }, { type: "car", name: 7 }, { type: "car", name: "" }, { name: "A B A B" }];
    assert.deepEqual(withoutRepeatedPlaceInCarName(rows), rows);
    assert.deepEqual(withoutRepeatedPlaceInCarName({ a: 1 }), { a: 1 });
  });

  test("the type is read any way it is written, and a clean name keeps its own spacing", () => {
    assert.equal(nameOf(withoutRepeatedPlaceInCarName([{ type: " Car ", name: "Hertz Nice airport Nice airport" }])), "Hertz Nice airport");
    const clean = car("Rental  car pick-up\tKeflavik airport");
    assert.deepEqual(withoutRepeatedPlaceInCarName([clean]), [clean]);
  });

  test("idempotent", () => {
    const once = withoutRepeatedPlaceInCarName([car("Hertz Ljubljana airport Ljubljana airport")]);
    assert.deepEqual(withoutRepeatedPlaceInCarName(once), once);
  });
});

describe("the travel_anchors gate applies it, beside the flight-number rule (#648)", () => {
  const gate = (data: unknown) => {
    const r = validateAnswer("travel_anchors", null, null, INTAKE_QUESTIONS, data);
    assert.ok(r.ok, JSON.stringify(r));
    return (r.answer as { data: Record<string, unknown>[] }).data;
  };

  test("a typed car and a document's car both arrive here, and leave with the place once", () => {
    const [typed, doc] = gate([
      car("רכב מ-Hertz שדה התעופה של לובליאנה שדה התעופה של לובליאנה", { date: "2027-05-10", confirmation: "H-5521" }),
      car("Europcar Frankfurt airport Frankfurt airport", { date: "2027-12-02" }),
    ]);
    assert.equal(typed!.name, "רכב מ-Hertz שדה התעופה של לובליאנה");
    assert.equal(doc!.name, "Europcar Frankfurt airport");
    assert.equal(typed!.confirmation, "H-5521");
  });

  test("the flight-number rule still runs in the same pass", () => {
    const [flight] = gate([{ type: "flight", name: "VN572 תל אביב-האנוי", confirmation: "VN572", date: "2027-03-04" }]);
    assert.equal(flight!.confirmation, undefined);
    assert.equal(flight!.flight_number, "VN572");
  });
});
