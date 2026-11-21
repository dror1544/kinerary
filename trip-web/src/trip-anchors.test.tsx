/**
 * Today's "Trip anchors" card (owner, 2026-11-21), which replaced the "Readiness" band: the trip's must-do and
 * must-attend bookings in date order, one tappable row each. The whole App against the video-release fetch stand-in,
 * so the rows come through the same GET /api/bookings the Bookings tab reads.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOKING_TYPES, bookingTypeIcon } from "./item-types";
import { anchorDateLine, sortAnchors } from "./trip-anchors";
import type { Booking } from "./api";
import { config, dayItems, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

// One booking of every type the server accepts (server/text-rules.js BOOKING_TYPES), deliberately out of date order.
const BOOKINGS = [
  { id: 5, phase: "colmar", type: "attraction", name: "Christmas concert, Colmar", date_from: "2026-12-05", confirmation: "TIX-9" },
  { id: 2, phase: "colmar", type: "hotel", name: "Hôtel Le Colombier", date_from: "2026-12-02", date_to: "2026-12-06", confirmation: "H-1" },
  { id: 4, phase: "colmar", type: "car", name: "Rental car, Europcar", date_from: "2026-12-02", date_to: "2026-12-06" },
  { id: 1, phase: "colmar", type: "flight", name: "TLV → FRA", date_from: "2026-12-02", confirmation: "ABC123" },
  { id: 6, phase: "colmar", type: "other", name: "Cheese tasting" },
  { id: 3, phase: "colmar", type: "attraction", name: "Unterlinden Museum", date_from: "2026-12-04" },
];

function serve(bookings: unknown[] | undefined = BOOKINGS, user?: Record<string, unknown>, features?: Record<string, boolean>) {
  const items = dayItems();
  return stubTripFetch(() => ({ config: config(features), today: todayContext(items), items, bookings, user }));
}

/** The card, once its rows are in (the page shows a loading line first). */
async function card() {
  const region = await screen.findByRole("region", { name: "Trip anchors" });
  await waitFor(() => expect(region.querySelector(".anchor-list, .anchors-empty, .anchors-error")).not.toBeNull());
  return region;
}
const names = (region: HTMLElement) => [...region.querySelectorAll(".anchor-row strong")].map((el) => el.textContent);

describe("what is on the card", () => {
  it("every booking type renders, car included, each with its own icon, name, kind and date", async () => {
    serve();
    renderTrip();
    const region = await card();
    expect(region.querySelectorAll(".anchor-row")).toHaveLength(BOOKINGS.length);
    for (const type of BOOKING_TYPES) {
      const rows = [...region.querySelectorAll(`.anchor-row[data-booking-type="${type}"]`)];
      expect(rows.length, `a ${type} booking is on the card`).toBeGreaterThan(0);
      expect(rows[0]!.querySelector(".anchor-icon")?.textContent).toBe(bookingTypeIcon(type));
    }
    const car = within(region).getByRole("button", { name: /Rental car, Europcar/ });
    expect(car.querySelector(".anchor-icon")?.textContent).toBe("🚗");
    expect(car).toHaveTextContent("Car");
    expect(car).toHaveTextContent("Dec 2 → Dec 6");
    const flight = within(region).getByRole("button", { name: /TLV → FRA/ });
    expect(flight.querySelector(".anchor-icon")?.textContent).toBe("✈️");
    expect(flight).toHaveTextContent("Dec 2");
    expect(within(region).getByRole("button", { name: /Christmas concert/ }).querySelector(".anchor-icon")?.textContent).toBe("🎟️");
    expect(within(region).getByRole("button", { name: /Hôtel Le Colombier/ }).querySelector(".anchor-icon")?.textContent).toBe("🏨");
  });

  it("a booking whose type this build does not know is still a row, with the 'other' pin", async () => {
    serve([...BOOKINGS, { id: 9, phase: "colmar", type: "ferry", name: "Rhine ferry", date_from: "2026-12-03" }]);
    renderTrip();
    const region = await card();
    const row = within(region).getByRole("button", { name: /Rhine ferry/ });
    expect(row.querySelector(".anchor-icon")?.textContent).toBe(bookingTypeIcon("other"));
    expect(row).toHaveTextContent("ferry");
  });

  it("is in date order: by first date, same-day by id, and no date last", async () => {
    serve();
    renderTrip();
    const region = await card();
    expect(names(region)).toEqual([
      "TLV → FRA", "Hôtel Le Colombier", "Rental car, Europcar", // Dec 2, by id
      "Unterlinden Museum", "Christmas concert, Colmar", // Dec 4, Dec 5
      "Cheese tasting", // no date
    ]);
    expect(within(region).getByRole("button", { name: /Cheese tasting/ })).toHaveTextContent("No date yet");
  });

  it("a member sees the same rows as the organizer (members see all trip data)", async () => {
    serve(BOOKINGS, { username: "bat", name_en: "Bat", is_organizer: false });
    renderTrip();
    const region = await card();
    expect(region.querySelectorAll(".anchor-row")).toHaveLength(BOOKINGS.length);
    expect(region.querySelector('.anchor-row[data-booking-type="car"]')).not.toBeNull();
  });

  it("the old Readiness band is gone from Today", async () => {
    serve();
    renderTrip();
    await card();
    expect(screen.queryByRole("heading", { name: "Readiness" })).toBeNull();
    expect(screen.queryByText("Tasks, packing and useful information")).toBeNull();
  });
});

describe("tapping a row", () => {
  it("opens that booking on the Bookings page, marked, the same way a flight on Today does", async () => {
    serve();
    const { container } = renderTrip();
    const region = await card();
    fireEvent.click(within(region).getByRole("button", { name: /Rental car, Europcar/ }));
    expect(window.location.hash).toBe("#bookings");
    await waitFor(() => expect(container.querySelector("#booking-4")).not.toBeNull());
    expect(container.querySelector("#booking-4")).toHaveClass("is-focused");
    expect(container.querySelector("#booking-1")).not.toHaveClass("is-focused");
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Bookings" })).toBeInTheDocument();
  });

  it("works for every type (the concert ticket and the 'other' booking too)", async () => {
    serve();
    const { container } = renderTrip();
    let region = await card();
    fireEvent.click(within(region).getByRole("button", { name: /Christmas concert/ }));
    await waitFor(() => expect(container.querySelector("#booking-5")).toHaveClass("is-focused"));
    window.location.hash = "today";
    region = await card();
    fireEvent.click(within(region).getByRole("button", { name: /Cheese tasting/ }));
    await waitFor(() => expect(container.querySelector("#booking-6")).toHaveClass("is-focused"));
  });
});

describe("the states that are not 'some bookings'", () => {
  it("empty: a short line and a link to Bookings, for an organizer", async () => {
    serve([]);
    renderTrip();
    const region = await card();
    expect(region.querySelector(".anchor-list")).toBeNull();
    expect(region).toHaveTextContent("Nothing booked yet. Add the hotels, flights and tickets in Bookings.");
    const link = within(region).getByRole("link", { name: "Bookings" });
    expect(link).toHaveAttribute("href", "#bookings");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Bookings" })).toBeInTheDocument();
  });

  it("empty, for a member: the same link, without telling them to add anything", async () => {
    serve([], { username: "bat", name_en: "Bat", is_organizer: false });
    renderTrip();
    const region = await card();
    expect(region).toHaveTextContent("Nothing booked yet. See Bookings.");
    expect(within(region).getByRole("link", { name: "Bookings" })).toHaveAttribute("href", "#bookings");
  });

  it("still loading is not empty: no 'nothing booked' until the read has succeeded", async () => {
    const base = serve();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      new URL(String(input), "http://trip.test").pathname === "/api/bookings" ? new Promise<Response>(() => undefined) : base(input)));
    renderTrip();
    const region = await screen.findByRole("region", { name: "Trip anchors" });
    await waitFor(() => expect(region.querySelector(".anchors-loading")).not.toBeNull());
    expect(region).not.toHaveTextContent("Nothing booked yet");
  });

  it("a failed read says so, and does not claim there is nothing booked", async () => {
    const base = serve();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input), "http://trip.test").pathname === "/api/bookings" ? new Response(JSON.stringify({ error: "boom" }), { status: 500 }) : base(input)));
    renderTrip();
    const region = await screen.findByRole("region", { name: "Trip anchors" });
    await waitFor(() => expect(region.querySelector(".anchors-error")).not.toBeNull());
    expect(region).toHaveTextContent("Could not load the bookings right now.");
    expect(region).not.toHaveTextContent("Nothing booked yet");
  });
});

describe("Hebrew, right to left", () => {
  it("the heading, the kinds and the empty state are in Hebrew", async () => {
    localStorage.setItem("tripLang", "he");
    serve();
    renderTrip();
    const region = await screen.findByRole("region", { name: "עוגני הטיול" });
    await waitFor(() => expect(region.querySelector(".anchor-list")).not.toBeNull());
    const car = within(region).getByRole("button", { name: /Rental car, Europcar/ });
    expect(car).toHaveTextContent("רכב");
    expect(car.querySelector(".anchor-icon")?.textContent).toBe("🚗");
    expect(document.documentElement.dir).toBe("rtl");
    cleanup();
    serve([]);
    renderTrip();
    const empty = await screen.findByRole("region", { name: "עוגני הטיול" });
    await waitFor(() => expect(empty.querySelector(".anchors-empty")).not.toBeNull());
    expect(within(empty).getByRole("link", { name: "הזמנות" })).toHaveAttribute("href", "#bookings");
  });
});

describe("the helpers", () => {
  const booking = (over: Partial<Booking> & { id: number }) => ({ type: "other", name: "x", ...over }) as Booking;
  it("every booking type the server knows has an icon, and only 'other' gets the pin", () => {
    for (const type of BOOKING_TYPES) expect(bookingTypeIcon(type)).toBeTruthy();
    expect(new Set(BOOKING_TYPES.map(bookingTypeIcon)).size).toBe(BOOKING_TYPES.length); // no two types share one
    expect(bookingTypeIcon("car")).toBe("🚗");
    expect(bookingTypeIcon("nonsense")).toBe(bookingTypeIcon("other"));
    expect(bookingTypeIcon("toString")).toBe(bookingTypeIcon("other")); // not an inherited property
  });
  it("anchorDateLine: a day, a range, one end only, nothing", () => {
    expect(anchorDateLine(booking({ id: 1, date_from: "2026-12-02" }), "en")).toBe("Dec 2");
    expect(anchorDateLine(booking({ id: 1, date_from: "2026-12-02", date_to: "2026-12-02" }), "en")).toBe("Dec 2");
    expect(anchorDateLine(booking({ id: 1, date_from: "2026-12-02", date_to: "2026-12-06" }), "en")).toBe("Dec 2 → Dec 6");
    expect(anchorDateLine(booking({ id: 1, date_to: "2026-12-06" }), "en")).toBe("Dec 6");
    expect(anchorDateLine(booking({ id: 1 }), "en")).toBeNull();
  });
  it("sortAnchors does not mutate its input, and puts the undated last whatever order they arrive in", () => {
    const input = [booking({ id: 1 }), booking({ id: 2, date_from: "2026-12-09" }), booking({ id: 3, date_from: "2026-12-01" })];
    expect(sortAnchors(input).map((b) => b.id)).toEqual([3, 2, 1]);
    expect(input.map((b) => b.id)).toEqual([1, 2, 3]);
  });
});
