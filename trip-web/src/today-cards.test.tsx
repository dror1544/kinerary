/**
 * Today in the video layout, three changes from Dror's review (2026-11-17):
 *   D. the trip clock and the companion's daily message are an announcement board ABOVE the day card, folded to one
 *      line when there is nothing to announce;
 *   E. weather and flights share one card with two tabs, a dot on Flights only for a real change;
 *   F. the trip conversation is not on Today: it is a page of its own, reached from the header menu or its hash.
 * (Each had a classic counterpart behind a switch; with the classic layout gone, 2026-11-21, those are gone too.)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flightChange, type FlightEntry } from "./today-cards";
import { config, dayItems, renderTrip, stubTripFetch, TODAY, todayContext, useJsdomBasics } from "./test/video-fixtures";
import type { TodayContext } from "./api";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

const VIDEO = {};
const flight = (status: unknown, over: Partial<FlightEntry> = {}): FlightEntry => ({
  facts: { id: 7, name: "TLV → FRA", identifier: "LY345" }, source: "flightaware", stale: false, status, ...over,
});
const DELAYED = { status: "Scheduled", scheduled_out: "2026-12-02T06:00:00Z", estimated_out: "2026-12-02T06:40:00Z", scheduled_in: "2026-12-02T10:00:00Z", estimated_in: "2026-12-02T10:40:00Z" };

function serve({ today, flights, bookings, features = VIDEO }: { today?: Partial<TodayContext>; flights?: unknown[]; bookings?: unknown[]; features?: Record<string, boolean> } = {}) {
  const items = dayItems();
  stubTripFetch(() => ({ config: config(features), today: todayContext(items, today), items, flights, bookings }));
}

describe("flightChange — what counts as a change", () => {
  it("a delay, a cancellation or a diversion in the provider's status is a change", () => {
    expect(flightChange(flight({ status: "Cancelled" }))).toBe("cancelled");
    expect(flightChange(flight({ status: "Diverted to Munich" }))).toBe("diverted");
    expect(flightChange(flight({ status: "Delayed" }))).toBe("delayed");
  });
  it("an estimate 15 minutes or more off the schedule is a change, later or earlier", () => {
    expect(flightChange(flight(DELAYED))).toBe("delayed");
    expect(flightChange(flight({ scheduled_out: "2026-12-02T06:00:00Z", estimated_out: "2026-12-02T05:40:00Z" }))).toBe("time_changed");
  });
  it("a few minutes, an on-time status, a gate or terminal, and no schedule are not changes", () => {
    expect(flightChange(flight({ status: "Scheduled", scheduled_out: "2026-12-02T06:00:00Z", estimated_out: "2026-12-02T06:10:00Z" }))).toBeNull();
    expect(flightChange(flight({ status: "En Route / On Time", gate_origin: "B12", terminal_origin: "3" }))).toBeNull();
    expect(flightChange(flight({ status: "Scheduled", estimated_out: "2026-12-02T06:40:00Z" }))).toBeNull();
    expect(flightChange(flight({ scheduled_out: "garbage", estimated_out: "also garbage" }))).toBeNull();
  });
  it("unknown is not a change: no observation, a stored booking, a stale copy, a non-object", () => {
    expect(flightChange(flight(null))).toBeNull();
    expect(flightChange(flight("Delayed"))).toBeNull();
    expect(flightChange(flight({ status: "Cancelled" }, { source: "stored_booking" }))).toBeNull();
    expect(flightChange(flight({ status: "Cancelled" }, { stale: true }))).toBeNull();
    expect(flightChange(flight(DELAYED, { stale: true }))).toBeNull();
  });
});

describe("D. the announcement board", () => {
  it("is the first thing in the page, above the day card", async () => {
    serve();
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    const board = container.querySelector(".clock-board")!;
    const card = container.querySelector(".day-card")!;
    expect(board).not.toBeNull();
    expect(board.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll(".clock-panel")).toHaveLength(1); // not also under the card
  });

  it("with nothing to announce it is folded to one line (the day line), and a tap unfolds it, and another folds it", async () => {
    serve();
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    const board = container.querySelector(".clock-board") as HTMLElement;
    expect(board).toHaveAttribute("role", "button");
    expect(board).toHaveAttribute("aria-expanded", "false");
    expect(board).toHaveClass("is-folded");
    expect(board.textContent).toMatch(/Day \d in Colmar/);
    expect(board.textContent).not.toMatch(/own pace/);
    fireEvent.click(board);
    const open = container.querySelector(".clock-board") as HTMLElement;
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(open).not.toHaveClass("is-folded");
    expect(open.textContent).toMatch(/Take today at your own pace/);
    fireEvent.click(open);
    expect(container.querySelector(".clock-board")).toHaveAttribute("aria-expanded", "false");
  });

  it("the keyboard works too (Enter and Space), and there is no arrow", async () => {
    serve();
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    const board = container.querySelector(".clock-board") as HTMLElement;
    fireEvent.keyDown(board, { key: "Enter" });
    expect(container.querySelector(".clock-board")).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(container.querySelector(".clock-board")!, { key: " " });
    expect(container.querySelector(".clock-board")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".clock-board svg[class*='chevron'], .clock-board svg[class*='arrow']")).toBeNull();
  });

  it("with the companion's message for today it shows expanded, with the message", async () => {
    serve({ today: { companion_message: { date: TODAY, en: "Wear boots: the vineyards are muddy.", he: "נעלי הליכה" } } });
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    const board = container.querySelector(".clock-board") as HTMLElement;
    expect(board).toHaveAttribute("aria-expanded", "true");
    expect(board.textContent).toContain("Wear boots: the vineyards are muddy.");
    fireEvent.click(board);
    expect(container.querySelector(".clock-board")).toHaveAttribute("aria-expanded", "false");
  });

  it("a message from another day is not an announcement", async () => {
    serve({ today: { companion_message: { date: "2026-12-01", en: "Yesterday's news", he: "חדשות" } } });
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    expect(container.querySelector(".clock-board")).toHaveAttribute("aria-expanded", "false");
  });

});

describe("E. weather and flights, one card, two tabs", () => {
  const tabs = () => screen.getAllByRole("tab");

  it("weather is selected first; Flights is the other tab; each has a tabpanel", async () => {
    serve({ flights: [flight(null, { source: "stored_booking" })] });
    renderTrip();
    const list = await screen.findByRole("tablist", { name: "Weather and flights" });
    const [weather, flights] = within(list).getAllByRole("tab");
    expect(weather).toHaveTextContent("Weather");
    expect(flights).toHaveTextContent("Flights");
    expect(weather).toHaveAttribute("aria-selected", "true");
    expect(flights).toHaveAttribute("aria-selected", "false");
    expect(weather).toHaveAttribute("tabindex", "0");
    expect(flights).toHaveAttribute("tabindex", "-1");
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(2);
    expect(panels[0]).not.toHaveAttribute("hidden");
    expect(panels[1]).toHaveAttribute("hidden");
    expect(weather.getAttribute("aria-controls")).toBe(panels[0]!.id);
    expect(panels[1]!.getAttribute("aria-labelledby")).toBe(flights.id);
    // The two old separate panels are gone from Today.
    expect(document.querySelectorAll(".ops-strip > .mini-panel")).toHaveLength(0);
  });

  it("a click selects Flights and shows the flight; the arrow keys, Home and End move between tabs (left-to-right)", async () => {
    serve({ flights: [flight(null, { source: "stored_booking" })] });
    renderTrip();
    await screen.findByRole("tablist");
    const [weather, flights] = tabs();
    fireEvent.click(flights!);
    expect(flights).toHaveAttribute("aria-selected", "true");
    const panel = document.getElementById(flights!.getAttribute("aria-controls")!)!;
    expect(panel).not.toHaveAttribute("hidden");
    expect(panel).toHaveTextContent("TLV → FRA");
    fireEvent.keyDown(flights!, { key: "ArrowRight" }); // wraps to the first
    expect(weather).toHaveAttribute("aria-selected", "true");
    expect(weather).toHaveFocus();
    fireEvent.keyDown(weather!, { key: "ArrowRight" });
    expect(flights).toHaveAttribute("aria-selected", "true");
    expect(flights).toHaveFocus();
    fireEvent.keyDown(flights!, { key: "Home" });
    expect(weather).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(weather!, { key: "End" });
    expect(flights).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(flights!, { key: "ArrowLeft" });
    expect(weather).toHaveAttribute("aria-selected", "true");
  });

  it("Hebrew (right-to-left): the labels are מזג אוויר | טיסות, and ArrowLeft is the next tab", async () => {
    localStorage.setItem("tripLang", "he");
    serve({ flights: [flight(null, { source: "stored_booking" })] });
    renderTrip();
    await screen.findByRole("tablist");
    const [weather, flights] = tabs();
    expect(weather).toHaveTextContent("מזג אוויר");
    expect(flights).toHaveTextContent("טיסות");
    fireEvent.keyDown(weather!, { key: "ArrowLeft" });
    expect(flights).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(flights!, { key: "ArrowRight" });
    expect(weather).toHaveAttribute("aria-selected", "true");
  });

  it("a flight with a real change puts a dot on the Flights tab, named for assistive tech", async () => {
    serve({ flights: [flight(DELAYED)] });
    renderTrip();
    const tab = await screen.findByRole("tab", { name: "Flights — changed" });
    expect(tab.querySelector(".tab-dot")).not.toBeNull();
    expect(tab.querySelector(".tab-dot")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(tab);
    expect(screen.getByText("Delayed")).toBeInTheDocument();
  });

  it("Hebrew: the dotted tab is named טיסות — שינוי", async () => {
    localStorage.setItem("tripLang", "he");
    serve({ flights: [flight({ status: "Cancelled" })] });
    renderTrip();
    expect(await screen.findByRole("tab", { name: "טיסות — שינוי" })).toBeInTheDocument();
  });

  it("no dot for a flight that has not changed, a stale or stored one, or one only a few minutes off", async () => {
    serve({ flights: [
      flight({ status: "En Route / On Time" }),
      flight(DELAYED, { stale: true, facts: { id: 8, name: "FRA → TLV", identifier: "LY346" } }),
      flight({ status: "Cancelled" }, { source: "stored_booking", facts: { id: 9, name: "Train", identifier: null } }),
      flight({ scheduled_out: "2026-12-02T06:00:00Z", estimated_out: "2026-12-02T06:05:00Z" }, { facts: { id: 10, name: "Short hop", identifier: "XX1" } }),
    ] });
    renderTrip();
    const flights = (await screen.findAllByRole("tab"))[1]!;
    expect(flights).toHaveAccessibleName("Flights");
    expect(flights.querySelector(".tab-dot")).toBeNull();
  });

  it("a trip with no flights shows the weather alone: no tabs, no empty Flights tab", async () => {
    serve({ flights: [] });
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    await waitFor(() => expect(container.querySelector(".weather-panel")).not.toBeNull());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(container.querySelector(".weather-flights.is-single")).not.toBeNull();
  });

  it("stored booking names are the fallback when the status has not come back", async () => {
    serve({ today: { flights: [{ id: 3, name: "LY345 Tel Aviv - Frankfurt" }] }, flights: [] });
    renderTrip();
    const [, flights] = await waitFor(() => { const found = screen.getAllByRole("tab"); expect(found).toHaveLength(2); return found; });
    fireEvent.click(flights!);
    expect(screen.getByText("LY345 Tel Aviv - Frankfurt")).toBeInTheDocument();
  });

  it("the tabs name the panels: no Weather or Flights heading inside the card, and both panels share one cell", async () => {
    serve({ flights: [flight(null, { source: "stored_booking" })] });
    const { container } = renderTrip();
    await screen.findByRole("tablist");
    await waitFor(() => expect(container.querySelector(".weather-flights-body .weather-panel")).not.toBeNull());
    expect(container.querySelector(".weather-flights-body h3")).toBeNull();
    expect(container.querySelector(".weather-flights-body .weather-panel > svg")).toBeNull();
    const body = container.querySelector(".weather-flights-body")!;
    expect(body.querySelectorAll(":scope > [role='tabpanel']")).toHaveLength(2);
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain(".video-layout .weather-flights-body > [role=\"tabpanel\"] { grid-area: 1 / 1;");
    expect(css).toContain(".video-layout .weather-flights-body > [role=\"tabpanel\"][hidden] { display: block; visibility: hidden; }");
  });

  it("a flight row shows its date and opens its booking — the ticket — on the Bookings page", async () => {
    serve({
      today: { flights: [{ id: 7, name: "TLV → FRA", date_from: "2026-12-02" }] },
      flights: [flight(DELAYED)],
      bookings: [{ id: 6, phase: "colmar", type: "hotel", name: "Hotel Colmar" }, { id: 7, phase: "colmar", type: "flight", name: "TLV → FRA", date_from: "2026-12-02", confirmation: "ABC123" }],
    });
    const { container } = renderTrip();
    fireEvent.click(await screen.findByRole("tab", { name: "Flights — changed" }));
    const row = screen.getByRole("button", { name: "TLV → FRA — Delayed — open the booking" });
    expect(row).toHaveTextContent("Wed 2 Dec");
    fireEvent.click(row);
    expect(window.location.hash).toBe("#bookings");
    await waitFor(() => expect(container.querySelector("#booking-7")).not.toBeNull());
    expect(container.querySelector("#booking-7")).toHaveClass("is-focused");
    expect(container.querySelector("#booking-6")).not.toHaveClass("is-focused");
  });

});

describe("F. the trip conversation has a page of its own", () => {
  it("is not on Today", async () => {
    serve();
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    expect(container.querySelector(".companion-panel")).toBeNull();
    expect(screen.queryByText("Your trip conversation")).toBeNull();
  });

  it("the header menu lists it, and opening it shows the conversation, unchanged, at #companion", async () => {
    serve();
    const { container } = renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const menu = await screen.findByRole("dialog", { name: "Trip menu" });
    fireEvent.click(within(menu).getByRole("button", { name: "Trip conversation" }));
    expect(window.location.hash).toBe("#companion");
    expect(await screen.findByText("Your trip conversation")).toBeInTheDocument();
    expect(container.querySelector(".companion-panel")).not.toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Trip conversation" })).toBeInTheDocument();
  });

  it("its hash opens it directly (it can be linked), in Hebrew too", async () => {
    localStorage.setItem("tripLang", "he");
    serve();
    renderTrip({ hash: "companion" });
    expect(await screen.findByText("השיחה של הטיול")).toBeInTheDocument();
    expect(document.querySelector(".companion-panel")).not.toBeNull();
  });
});
