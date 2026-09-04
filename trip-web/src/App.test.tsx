import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createItineraryItem, deleteItineraryItem, tokenStore, updateItineraryItem } from "./api";
import App, { classicHrefForLocation } from "./App";

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
