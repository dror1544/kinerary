/**
 * The Today day card and its Go chips (AC-7, AC-8, AC-9 as the page renders them; the link rules
 * themselves are pinned in nav-links.test.ts).
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, dayItems, item, LABELLED_DAY, renderTrip, stubTripFetch, TODAY, todayContext, useJsdomBasics } from "./test/video-fixtures";
import type { ItineraryDay, ItineraryItem, TodayContext } from "./api";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

function serve({ items = dayItems(), today, days }: { items?: ItineraryItem[]; today?: TodayContext; days?: ItineraryDay[] } = {}) {
  stubTripFetch(() => ({ config: config({}), today: today ?? todayContext(items), items, days }));
}
const card = async () => (await screen.findByRole("region", { name: /Thursday|Friday|Wednesday/ }));
const rows = (root: HTMLElement) => within(root).getAllByRole("listitem");

describe("AC-7: one card for the whole day", () => {
  it("is titled \"<weekday> · <day label>\" and lists exactly the day's items in served order, with time and title", async () => {
    serve();
    renderTrip();
    const day = await card();
    expect(within(day).getByRole("heading", { name: "Thursday · Wine Route" })).toBeInTheDocument();
    const list = rows(day);
    expect(list).toHaveLength(4);
    const texts = list.map((row) => row.querySelector(".day-row-title")?.textContent);
    expect(texts).toEqual(["Breakfast at the hotel", "Winery tour", "Free evening", "Dinner at the Winstub"]);
    expect(list.map((row) => row.querySelector(".day-row-time")?.textContent?.replace(/\s+/g, " ").trim().replace(/^20:00 /, ""))).toEqual(["08:30", "11:00", "Evening", "19:00"]);
  });

  it("the `next` item carries the Next marker, and the separate \"Up next\" card is gone", async () => {
    serve();
    const { container } = renderTrip();
    const day = await card();
    const next = rows(day).filter((row) => row.classList.contains("is-next"));
    expect(next).toHaveLength(1);
    expect(within(next[0]!).getByText("Next")).toBeInTheDocument();
    expect(next[0]!.querySelector(".day-row-title")?.textContent).toBe("Winery tour");
    expect(screen.queryByText("Up next")).toBeNull();
    expect(container.querySelector(".upcoming-activity")).toBeNull();
  });

  it("tapping a row title opens it in Plan, as the old Up next title did", async () => {
    serve();
    renderTrip();
    const day = await card();
    fireEvent.click(within(day).getByRole("button", { name: "Winery tour" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Plan" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#journey");
  });

  it("the other Today panels remain: the trip clock (now the board above the card, see today-cards.test.tsx), the weather, trip anchors", async () => {
    serve();
    renderTrip();
    await card();
    expect(document.querySelector(".clock-panel")).not.toBeNull();
    await waitFor(() => expect(document.querySelector(".weather-panel")).not.toBeNull()); // this trip has no flights: weather alone
    expect(screen.getByRole("heading", { name: "Trip anchors" })).toBeInTheDocument(); // replaced the Readiness band, see trip-anchors.test.tsx
  });
});

describe("AC-8: a day with no label, no items, or not started", () => {
  it("falls back to the phase title when the day has no label", async () => {
    serve({ days: [{ phase_id: "colmar", date: TODAY }] });
    renderTrip();
    expect(await screen.findByRole("heading", { name: "Thursday · Colmar" })).toBeInTheDocument();
  });

  it("a trip day with nothing planned says so and links to Plan", async () => {
    serve({ items: [], today: todayContext([], { current: null, next: null }) });
    renderTrip();
    const day = await card();
    expect(within(day).getByText(/Nothing is planned for this day yet/)).toBeInTheDocument();
    expect(within(day).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(day).getByRole("link", { name: "Open the plan" })).toHaveAttribute("href", "#journey");
  });

  it("before the trip: the first trip day, with \"Starts in N days\"", async () => {
    const first = [item({ item_uid: "arrive", text_en: "Arrive in Frankfurt", text_he: "נחיתה", date: "2026-12-02", time: "10:00", time_sort: 600 })];
    const today = todayContext([], { today: "2026-11-27", phase: "pre_trip", countdown_days: 5, first_date: "2026-12-02", current: null, next: first[0]! });
    serve({ items: first, today, days: [{ phase_id: "colmar", date: "2026-12-02", label_en: "Wed 12/2 — Arrival" }] });
    renderTrip();
    const day = await screen.findByRole("region", { name: "Wednesday · Arrival" });
    expect(within(day).getByText("Starts in 5 days")).toBeInTheDocument();
    expect(rows(day).map((row) => row.querySelector(".day-row-title")?.textContent)).toEqual(["Arrive in Frankfurt"]);
  });

  it("after the trip there is no day card and the page is what it is today", async () => {
    const today = todayContext([], { today: "2026-12-09", phase: "post_trip", countdown_days: -7, current: null, next: null });
    serve({ today });
    const { container } = renderTrip();
    expect(await screen.findByRole("heading", { name: "No upcoming activities scheduled." })).toBeInTheDocument();
    expect(container.querySelector(".day-card")).toBeNull();
  });
});

describe("AC-9: the Go chip", () => {
  const goFor = async (title: string) => {
    const day = await card();
    const row = rows(day).find((entry) => entry.querySelector(".day-row-title")?.textContent === title)!;
    return within(row).queryByRole("link", { name: new RegExp(`^Go to ${title}`) });
  };

  it("opens the item's own link, else its booking's, else a Google Maps search on title + destination", async () => {
    serve();
    renderTrip();
    expect(await goFor("Breakfast at the hotel")).toHaveAttribute("href", "https://maps.example/hotel");
    expect(await goFor("Winery tour")).toHaveAttribute("href", "https://maps.example/winery-booking");
    const dinner = await goFor("Dinner at the Winstub");
    expect(dinner).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Dinner%20at%20the%20Winstub%2C%20Colmar");
    expect(dinner).toHaveAttribute("target", "_blank");
    expect(dinner?.getAttribute("rel")).toContain("noreferrer");
  });

  it("free_time, task and note get no Go chip", async () => {
    const extra = [
      item({ item_uid: "task", text_en: "Print the tickets", item_type: "task", time: "07:00", time_sort: 420 }),
      item({ item_uid: "note", text_en: "Bring a jacket", item_type: "note", time: null }),
    ];
    serve({ items: [...extra, ...dayItems()] });
    renderTrip();
    const day = await card();
    for (const title of ["Print the tickets", "Bring a jacket", "Free evening"]) {
      const row = rows(day).find((entry) => entry.querySelector(".day-row-title")?.textContent === title)!;
      expect(row, title).toBeTruthy();
      expect(within(row).queryByRole("link", { name: /Go to/ }), title).toBeNull();
    }
    expect(within(day).getAllByRole("link", { name: /^Go to/ })).toHaveLength(3);
  });

  it("the chevron and the expanded Waze option are gone: no row has a \"More options\" button or a Waze link", async () => {
    serve();
    renderTrip();
    const day = await card();
    expect(within(day).queryByRole("button", { name: /More options/ })).toBeNull();
    expect(within(day).queryByRole("link", { name: "Waze" })).toBeNull();
    expect(day.querySelector(".detail-toggle, .day-row-waze")).toBeNull();
  });

  it("an unsafe stored link is never put in an href: the search fallback is used instead", async () => {
    serve({ items: [item({ item_uid: "bad", text_en: "Odd stop", time: "09:00", time_sort: 540, location_url: "javascript:alert(1)" })] });
    renderTrip();
    const link = await goFor("Odd stop");
    expect(link).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Odd%20stop%2C%20Colmar");
  });

  it("Hebrew: the chip reads ניווט", async () => {
    localStorage.setItem("tripLang", "he");
    serve();
    renderTrip();
    const day = await screen.findByRole("region", { name: /יום חמישי/ });
    expect(within(day).getAllByText("ניווט").length).toBeGreaterThan(0);
    expect(within(day).getByRole("heading", { name: "יום חמישי · דרך היין" })).toBeInTheDocument();
    expect(LABELLED_DAY.label_he).toContain("דרך היין");
  });
});

describe("the Plan row shares the same Go helper", () => {
  it("shows the same link on the Plan tab, with no Waze option in the row's detail", async () => {
    serve();
    renderTrip({ hash: "journey" });
    const winery = (await screen.findByRole("heading", { name: "Winery tour" })).closest("article") as HTMLElement;
    expect(within(winery).getByRole("link", { name: "Go to Winery tour" })).toHaveAttribute("href", "https://maps.example/winery-booking");
    expect(within(winery).queryByRole("link", { name: "Waze" })).toBeNull();
    expect(within(winery).queryByRole("button", { name: "Details" })).toBeNull();
  });
});

describe("the trip's navigation app (Google Maps | Waze) decides where every Go chip goes", () => {
  const winstub = "Dinner at the Winstub";
  const wazeSearch = "https://waze.com/ul?q=Dinner%20at%20the%20Winstub%2C%20Colmar&navigate=yes";

  it("a site that says nothing about it (or says something unknown) is Google Maps", async () => {
    stubTripFetch(() => ({ config: config({}), today: todayContext(dayItems()), items: dayItems(), settings: { nav_app: "apple" } }));
    renderTrip();
    const day = await card();
    expect(within(day).getByRole("link", { name: `Go to ${winstub}` })).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Dinner%20at%20the%20Winstub%2C%20Colmar");
  });

  it("set to Waze: the item's waze_url when it has one, else a Waze search on title + destination (Today row)", async () => {
    stubTripFetch(() => ({ config: config({}), today: todayContext(dayItems()), items: dayItems(), settings: { nav_app: "waze" } }));
    renderTrip();
    const day = await card();
    await waitFor(() => expect(within(day).getByRole("link", { name: "Go to Winery tour" })).toHaveAttribute("href", "https://waze.com/ul?q=winery"));
    expect(within(day).getByRole("link", { name: `Go to ${winstub}` })).toHaveAttribute("href", wazeSearch);
    expect(within(day).getByRole("link", { name: `Go to ${winstub}` })).toHaveAttribute("target", "_blank");
  });

  it("set to Waze: the Plan row's Go chip follows it too", async () => {
    stubTripFetch(() => ({ config: config({}), today: todayContext(dayItems()), items: dayItems(), settings: { nav_app: "waze" } }));
    renderTrip({ hash: "journey" });
    const dinner = (await screen.findByRole("heading", { name: winstub })).closest("article") as HTMLElement;
    await waitFor(() => expect(within(dinner).getByRole("link", { name: `Go to ${winstub}` })).toHaveAttribute("href", wazeSearch));
  });

  it("an unsafe waze_url is never used: the Waze search is", async () => {
    const items = [item({ item_uid: "bad", text_en: "Odd stop", time: "09:00", time_sort: 540, waze_url: "javascript:alert(1)" })];
    stubTripFetch(() => ({ config: config({}), today: todayContext(items), items, settings: { nav_app: "waze" } }));
    renderTrip();
    const day = await card();
    await waitFor(() => expect(within(day).getByRole("link", { name: "Go to Odd stop" })).toHaveAttribute("href", "https://waze.com/ul?q=Odd%20stop%2C%20Colmar&navigate=yes"));
  });
});
