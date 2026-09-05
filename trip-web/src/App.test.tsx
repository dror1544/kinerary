import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createItineraryItem, deleteItineraryItem, tokenStore, updateItineraryItem } from "./api";
import App, { classicHrefForLocation, coordinatesFromLocationUrl, dailyMapStops, mapPins, wrappedMapIndex } from "./App";

describe("Modern trip SPA", () => {
  it("shows the login experience when no runtime token exists", () => {
    localStorage.clear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: /open your trip/i })).toBeInTheDocument();
  });

  it("recognizes the gateway runtime session marker", () => {
    localStorage.clear();
    localStorage.setItem("trip-token", "runtime-gateway-session");
    expect(tokenStore.get()).toBe("runtime-gateway-session");
  });

  it("points Classic fallback at the API server during local Vite preview", () => {
    expect(classicHrefForLocation("/classic.html", "127.0.0.1", "4185")).toBe("http://127.0.0.1:3000/classic.html");
    expect(classicHrefForLocation("/t/demo/classic.html", "example.com", "")).toBe("/t/demo/classic.html");
  });

  it("keeps only dated itinerary locations and orders them chronologically for the map", () => {
    const stops = dailyMapStops([
      { item_uid: "later", phase_id: "tokyo", date: "2026-05-02", time: "09:00", time_sort: 540, item_type: "activity", text_he: "מאוחר", location_url: "https://maps.example/later" },
      { item_uid: "no-link", phase_id: "tokyo", date: "2026-05-01", time: "08:00", time_sort: 480, item_type: "activity", text_he: "ללא קישור" },
      { item_uid: "waze", phase_id: "tokyo", date: "2026-05-01", time: "11:00", time_sort: 660, item_type: "activity", text_he: "וייז", waze_url: "https://waze.com/ul?q=stop" },
      { item_uid: "early", phase_id: "tokyo", date: "2026-05-01", time: "10:00", time_sort: 600, item_type: "activity", text_he: "מוקדם", location_url: "https://maps.example/early" },
      { item_uid: "undated", phase_id: "tokyo", item_type: "activity", text_he: "ללא תאריך", location_url: "https://maps.example/undated" },
    ]);

    expect(stops.map((item) => item.item_uid)).toEqual(["early", "waze", "later"]);
  });

  it("uses only explicit coordinates from saved map links for map pins", () => {
    expect(coordinatesFromLocationUrl("https://www.google.com/maps/@31.7683,35.2137,14z")).toEqual({ lat: 31.7683, lng: 35.2137 });
    expect(coordinatesFromLocationUrl("https://maps.google.com/?q=31.7683,35.2137")).toEqual({ lat: 31.7683, lng: 35.2137 });
    expect(coordinatesFromLocationUrl("https://www.google.com/maps/search/?api=1&query=Old+City")).toBeNull();
    expect(coordinatesFromLocationUrl("https://maps.example/?q=91,181")).toBeNull();
  });

  it("orders map pins by phase visit order, then daily stop order", () => {
    const config = {
      phases: [
        { id: "tokyo", title: { en: "Tokyo", he: "טוקיו" }, mapStop: { lat: 35.67, lng: 139.65 } },
        { id: "kyoto", title: { en: "Kyoto", he: "קיוטו" }, mapStop: { lat: 35.01, lng: 135.76 } },
      ],
    } as unknown as Parameters<typeof mapPins>[0];
    const items = [{
      item_uid: "kyoto-stop", phase_id: "kyoto", date: "2026-05-03", time: "10:00", time_sort: 600,
      item_type: "activity", text_he: "קיוטו", text_en: "Kyoto stop", location_url: "https://www.google.com/maps/@35.02,135.77,14z",
    }, {
      item_uid: "kyoto-waze", phase_id: "kyoto", date: "2026-05-03", time: "12:00", time_sort: 720,
      item_type: "activity", text_he: "מקדש", text_en: "Temple", waze_url: "https://waze.com/ul?ll=35.03%2C135.78&navigate=yes",
    }];

    expect(mapPins(config, items, "en").map((pin) => pin.id)).toEqual(["stay:tokyo", "stay:kyoto", "stop:kyoto-stop", "stop:kyoto-waze"]);
    expect(mapPins(config, items, "en")[3]).toMatchObject({ phaseId: "kyoto", date: "2026-05-03", itemUid: "kyoto-waze" });
  });

  it("wraps map navigation from either end of the visit order", () => {
    expect([wrappedMapIndex(-1, 4), wrappedMapIndex(0, 4), wrappedMapIndex(4, 4), wrappedMapIndex(5, 4)]).toEqual([3, 0, 0, 1]);
    expect(wrappedMapIndex(-1, 0)).toBe(0);
  });

  it("uses the living-itinerary endpoints for organizer revisions", async () => {
    localStorage.clear();
    tokenStore.set("organizer-token");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ revision: "rev_2", item_uid: "item_1", ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const input = { phase_id: "tokyo", date: "2026-05-01", text_he: "ארוחת ערב", text_en: "Dinner", time: "19:00", item_type: "meal" };

    await createItineraryItem(input);
    await updateItineraryItem("item/1", input);
    await deleteItineraryItem("item/1");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/itinerary/items", "POST"],
      ["/api/itinerary/items/item%2F1", "PATCH"],
      ["/api/itinerary/items/item%2F1", "DELETE"],
    ]);
    const postHeaders = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(postHeaders.get("Authorization")).toBe("Bearer organizer-token");
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(input));
    vi.unstubAllGlobals();
  });
});
