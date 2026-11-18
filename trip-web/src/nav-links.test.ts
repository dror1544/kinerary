// AC-9: the Go link order — item link, then the booking's, then a place search — Waze second,
// no chip for items that are not places, and every link passes safeExternalUrl.
import { describe, expect, it } from "vitest";
import { hasGoChip, mapUrlFor, navUrlFor, normalizeNavApp, wazeUrlFor } from "./nav-links";

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

describe("navUrlFor — the trip's navigation app decides", () => {
  const winery = { waze_url: "https://waze.com/ul?q=winery", location_url: "https://maps.example/winery" };
  it("google (the default) is exactly mapUrlFor", () => {
    expect(navUrlFor(winery, "Winery", "Colmar", "google")).toBe("https://maps.example/winery");
    expect(navUrlFor({}, "Dinner", "Colmar", "google")).toBe(SEARCH("Dinner, Colmar"));
  });
  it("waze opens the item's waze_url, else its booking place's", () => {
    expect(navUrlFor(winery, "Winery", "Colmar", "waze")).toBe("https://waze.com/ul?q=winery");
    expect(navUrlFor({ booking: { place: { waze_url: "https://waze.com/ul?q=hotel" } } }, "Hotel", "Colmar", "waze")).toBe("https://waze.com/ul?q=hotel");
  });
  it("waze without a waze_url searches Waze on title + destination and starts navigation", () => {
    expect(navUrlFor({ location_url: "https://maps.example/x" }, "Dinner at the Winstub", "Colmar", "waze"))
      .toBe("https://waze.com/ul?q=Dinner%20at%20the%20Winstub%2C%20Colmar&navigate=yes");
    expect(navUrlFor({}, "Dinner", undefined, "waze")).toBe("https://waze.com/ul?q=Dinner&navigate=yes");
  });
  it("an unsafe waze_url is dropped for the Waze search", () => {
    expect(navUrlFor({ waze_url: "javascript:alert(1)" }, "Dinner", "Colmar", "waze")).toBe("https://waze.com/ul?q=Dinner%2C%20Colmar&navigate=yes");
  });
  it("anything unrecognised normalises to google", () => {
    for (const value of [undefined, null, "", "Waze", "apple", 1, {}]) expect(normalizeNavApp(value)).toBe("google");
    expect(normalizeNavApp("waze")).toBe("waze");
  });
});
