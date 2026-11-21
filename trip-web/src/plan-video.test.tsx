/**
 * AC-13: the Plan tab in the video layout — the day strip grouped by phase, a date column per
 * day, the night's lodging line where the day has lodging_context, and a Booked tick only on
 * items with an approved booking attached (the server serves only approved ones).
 */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, dayItems, item, renderTrip, stubTripFetch, TODAY, todayContext, useJsdomBasics } from "./test/video-fixtures";
import type { ItineraryDay } from "./api";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

const days: ItineraryDay[] = [
  { phase_id: "colmar", date: "2026-12-02", label_en: "Wed 12/2 — Arrival" },
  { phase_id: "colmar", date: TODAY, label_en: "Thu 12/3 — Wine Route", lodging_context: { name: "Hôtel Le Colombier", location_url: "https://maps.example/colombier" } },
  { phase_id: "colmar", date: "2026-12-04", label_en: "Fri 12/4 — Old Town" },
];

function serve() {
  const items = [...dayItems(), item({ item_uid: "walk", text_en: "Walk the old town", date: "2026-12-04", time: "10:00", time_sort: 600 })];
  stubTripFetch(() => ({ config: config(), today: todayContext(items.filter((entry) => entry.date === TODAY)), items, days }));
}

describe("the Plan in the video layout", () => {
  it("shows the days across the top, grouped by phase, each with a date column", async () => {
    serve();
    renderTrip({ hash: "journey" });
    const strip = await screen.findByRole("navigation", { name: "Days of the trip" });
    // The strip is on screen before the trip config arrives; its groups come with the config.
    const group = (await within(strip).findByRole("heading", { name: "Colmar" })).closest(".plan-strip-group") as HTMLElement;
    const buttons = within(group).getAllByRole("button");
    // 2–6 December: five calendar days in the one phase, planned or not.
    expect(buttons).toHaveLength(5);
    const thursday = buttons.find((button) => button.textContent?.includes("Wine Route"))!;
    const col = thursday.querySelector(".date-col") as HTMLElement;
    expect([...col.children].map((child) => child.textContent)).toEqual(["3", "Dec", "Thu"]);
    expect(buttons.every((button) => button.querySelector(".date-col"))).toBe(true);
    expect(thursday).toHaveAttribute("aria-pressed", "true");
    // The old rail and pickers are replaced by the strip.
    expect(document.querySelector(".destination-rail, .day-selector, .mobile-day-picker")).toBeNull();
  });

  it("a trip with two phases gets two groups", async () => {
    const items = dayItems();
    const two = { ...config(), phases: [
      { id: "colmar", title: { en: "Colmar" }, dates: { start: "2026-12-02", end: "2026-12-03" } },
      { id: "strasbourg", title: { en: "Strasbourg" }, dates: { start: "2026-12-04", end: "2026-12-05" } },
    ] };
    stubTripFetch(() => ({ config: two, today: todayContext(items), items, days }));
    renderTrip({ hash: "journey" });
    const strip = await screen.findByRole("navigation", { name: "Days of the trip" });
    await within(strip).findByRole("heading", { name: "Strasbourg" });
    expect(within(strip).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Colmar", "Strasbourg"]);
  });

  it("choosing another day shows that day, with its own date column beside the card", async () => {
    serve();
    renderTrip({ hash: "journey" });
    const strip = await screen.findByRole("navigation", { name: "Days of the trip" });
    expect(await screen.findByRole("heading", { name: "Winery tour" })).toBeInTheDocument();
    fireEvent.click(within(strip).getByRole("button", { name: /Old Town/ }));
    expect(await screen.findByRole("heading", { name: "Walk the old town" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Winery tour" })).toBeNull();
    const heading = document.querySelector(".day-heading") as HTMLElement;
    expect([...heading.querySelector(".day-date-col")!.children].map((child) => child.textContent)).toEqual(["4", "Dec", "Fri"]);
  });

  it("the night's lodging line comes from the day's lodging_context", async () => {
    serve();
    renderTrip({ hash: "journey" });
    const line = await screen.findByText(/Tonight:/);
    expect(line).toHaveTextContent("Hôtel Le Colombier");
    expect(within(line).getByRole("link", { name: "Map" })).toHaveAttribute("href", "https://maps.example/colombier");
  });

  it("a Booked tick appears only on the item with an approved booking", async () => {
    serve();
    renderTrip({ hash: "journey" });
    await screen.findByRole("heading", { name: "Winery tour" });
    const ticks = [...document.querySelectorAll(".booked-tick")];
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.closest("article")!.querySelector("h3")?.textContent).toBe("Winery tour");
    expect(ticks[0]).toHaveTextContent("Booked");
  });

  it("there is no second layout: no rail, no day pickers, and the row's own Map and Waze links are the Go chip's job", async () => {
    serve();
    renderTrip({ hash: "journey" });
    await screen.findByRole("heading", { name: "Winery tour" });
    expect(document.querySelector(".destination-rail, .day-selector, .mobile-day-picker")).toBeNull();
    expect(document.querySelector(".plan-strip, .go-chip")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Waze" })).toBeNull();
  });
});
