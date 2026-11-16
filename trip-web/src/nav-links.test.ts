// AC-9: the Go link order — item link, then the booking's, then a place search — Waze second,
// no chip for items that are not places, and every link passes safeExternalUrl.
import { describe, expect, it } from "vitest";
import { hasGoChip, mapUrlFor, wazeUrlFor } from "./nav-links";

const SEARCH = (query: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

describe("mapUrlFor — the Go chip target", () => {
  it("opens the item's own location_url first", () => {
    expect(mapUrlFor({ location_url: "https://maps.example/item", booking: { location_url: "https://maps.example/booking" } }, "Dinner", "Colmar"))
      .toBe("https://maps.example/item");
  });
  it("falls back to the attached booking's location_url", () => {
    expect(mapUrlFor({ location_url: null, booking: { location_url: "https://maps.example/booking" } }, "Dinner", "Colmar"))
      .toBe("https://maps.example/booking");
  });
  it("falls back to a Google Maps search on title + destination", () => {
    expect(mapUrlFor({}, "Winstub dinner", "Colmar")).toBe(SEARCH("Winstub dinner, Colmar"));
    expect(mapUrlFor({}, "Winstub dinner")).toBe(SEARCH("Winstub dinner"));
  });
  it("never trusts a stored link that is not http(s): it moves on to the next source", () => {
    expect(mapUrlFor({ location_url: "javascript:alert(1)", booking: { location_url: "data:text/html,x" } }, "Dinner", "Colmar"))
      .toBe(SEARCH("Dinner, Colmar"));
    expect(mapUrlFor({ location_url: "javascript:alert(1)", booking: { location_url: "https://maps.example/b" } }, "Dinner")).toBe("https://maps.example/b");
  });
});

describe("wazeUrlFor — the second option", () => {
  it("gives the item's Waze link, else the booking place's, else nothing", () => {
    expect(wazeUrlFor({ waze_url: "https://waze.com/ul?q=x" })).toBe("https://waze.com/ul?q=x");
    expect(wazeUrlFor({ booking: { place: { waze_url: "https://waze.com/ul?q=hotel" } } })).toBe("https://waze.com/ul?q=hotel");
    expect(wazeUrlFor({})).toBeNull();
  });
  it("drops a Waze link that is not http(s)", () => {
    expect(wazeUrlFor({ waze_url: "javascript:alert(1)" })).toBeNull();
    expect(wazeUrlFor({ waze_url: "waze://?q=x" })).toBeNull();
  });
});

describe("hasGoChip", () => {
  it("is false for free_time, task and note, true for places", () => {
    for (const type of ["free_time", "task", "note"]) expect(hasGoChip({ item_type: type }), type).toBe(false);
    for (const type of ["activity", "meal", "travel", "lodging", "booking"]) expect(hasGoChip({ item_type: type }), type).toBe(true);
  });
});
