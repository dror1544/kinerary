/**
 * #549 — two bookings on one flight (same flight number + date): Reservations
 * keeps one row per booking and each says whose it is; the Plan board and the
 * Map show the flight once. Dror, 2026-11-12: "If same flight and date we
 * should see it twice but with ability to distinguish on the planned board it
 * should be once."
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BookingsView, dailyMapStops, JourneyView, mapPins } from "./App";
import { collapseSameFlight, flightNumberOf, sameFlightGroups } from "./same-flight";

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const CONFIG = { phases: [{ id: "gc", title: { en: "Gatecity", he: "גייטסיטי" }, dates: { start: "2026-11-14", end: "2026-11-16" } }] };
const MAPS = "https://www.google.com/maps/search/?api=1&query=47.1,8.5";
const flightItem = (uid: string, extra: Record<string, unknown> = {}) => ({
  item_uid: uid, phase_id: "gc", date: "2026-11-14", time: "09:30", time_sort: 570, item_type: "activity",
  text_en: "SL 482 Harbortown → Gatecity", text_he: "SL 482 הארבורטאון → גייטסיטי", sort_order: 1, confirmation_state: "verified",
  location_url: MAPS, ...extra,
});
const ITINERARY = {
  revision: "r1",
  days: [{ phase_id: "gc", date: "2026-11-14", label_en: "Arrival", label_he: "הגעה" }],
  // What the build produces today: one day item per booking.
  items: [
    flightItem("f1"),
    flightItem("f2"),
    { ...flightItem("m1"), text_en: "Museum", text_he: "מוזיאון", time: "14:00", time_sort: 840, location_url: null },
  ],
};
const BOOKINGS = [
  { id: 1, phase: "gc", type: "flight", name: "SL 482 Harbortown → Gatecity", date_from: "2026-11-14", passengers: "Arlo Vesper, Lena Vesper", confirmation: "QX7P2M", review_status: "approved" },
  { id: 2, phase: "gc", type: "flight", name: "SL 482 Harbortown → Gatecity", date_from: "2026-11-14", passengers: "Bria Tallis, Cole Tallis", confirmation: "ZT3K9D", review_status: "approved" },
];

function reservations(bookings: unknown[], opts: { isOrganizer?: boolean; lang?: "en" | "he" } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => url.startsWith("/api/bookings") ? bookings : url.startsWith("/api/today") ? { today: "2026-11-01", phase: "pre_trip", countdown_days: 13, current: null, next: null, events: [], flights: [] } : {},
  })));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BookingsView config={CONFIG as never} isOrganizer={opts.isOrganizer} lang={opts.lang ?? "en"} />
    </QueryClientProvider>,
  );
}

describe("#549 flight identity", () => {
  it("AC-1 a flight number is read off the start of the line, spacing and case aside", () => {
    expect(flightNumberOf("SL 482 Harbortown → Gatecity")).toBe("SL482");
    expect(flightNumberOf("LY8801 תל אביב → פרנקפורט")).toBe("LY8801");
    expect(flightNumberOf("Flight sl 482 to Gatecity")).toBe("SL482");
    expect(flightNumberOf("Museum 12")).toBeNull();
    expect(flightNumberOf("Harbortown → Gatecity")).toBeNull();
  });
});

describe("#549 the Plan board and the Map show the flight once", () => {
  it("AC-2 collapseSameFlight keeps one item for one flight number + date and leaves everything else", () => {
    const items = ITINERARY.items as never[];
    expect((collapseSameFlight(items) as { item_uid: string }[]).map((i) => i.item_uid)).toEqual(["f1", "m1"]);
  });

  it("AC-3 a different flight number, a different date, or an unnumbered line is never merged", () => {
    const base = flightItem("a");
    const other = collapseSameFlight([
      base, flightItem("b", { text_en: "SL 483 Gatecity → Harbortown", text_he: "SL 483" }),
      flightItem("c", { date: "2026-11-15" }),
      flightItem("d", { text_en: "Harbortown → Gatecity", text_he: "הארבורטאון → גייטסיטי" }),
      flightItem("e", { text_en: "Harbortown → Gatecity", text_he: "הארבורטאון → גייטסיטי" }),
    ] as never[]) as { item_uid: string }[];
    expect(other.map((i) => i.item_uid)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("AC-3b one flight number on two legs of a day, or a same-numbered return, keeps both lines", () => {
    const kept = collapseSameFlight([
      flightItem("leg1", { text_en: "LY8801 Tel Aviv → Athens", text_he: "LY8801 תל אביב → אתונה" }),
      flightItem("leg2", { text_en: "LY8801 Athens → Paris", text_he: "LY8801 אתונה → פריז" }),
      flightItem("back", { text_en: "SL 482 Gatecity → Harbortown", text_he: "SL 482 גייטסיטי → הארבורטאון" }),
      flightItem("out"),
    ] as never[]) as { item_uid: string }[];
    expect(kept.map((i) => i.item_uid)).toEqual(["leg1", "leg2", "back", "out"]);
  });

  it("AC-4 the Plan board lists the flight once, with the other day items intact", () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView itinerary={ITINERARY as never} config={CONFIG as never} isOrganizer lang="en" onHeroPhaseChange={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText("SL 482 Harbortown → Gatecity")).toHaveLength(1);
    expect(screen.getByText("Museum")).toBeInTheDocument();
  });

  it("AC-5 the Map lists the flight once, as a daily stop and as a pin", () => {
    expect(dailyMapStops(ITINERARY.items as never).map((i) => i.item_uid)).toEqual(["f1"]);
    expect(mapPins(CONFIG as never, ITINERARY.items as never, "en").filter((p) => p.kind === "stop").map((p) => p.itemUid)).toEqual(["f1"]);
  });
});

describe("#549 Reservations keeps both bookings and tells them apart", () => {
  it("AC-6 groups flight bookings by flight number + date, never hotels or unnumbered rows", () => {
    const groups = sameFlightGroups([
      ...BOOKINGS,
      { id: 3, phase: "gc", type: "hotel", name: "SL 482 Hotel", date_from: "2026-11-14" },
      { id: 4, phase: "gc", type: "flight", name: "Harbortown → Gatecity", date_from: "2026-11-14" },
      { id: 5, phase: "gc", type: "flight", name: "Harbortown → Gatecity", date_from: "2026-11-14" },
    ] as never[]);
    expect([...groups.entries()].map(([id, g]) => [id, g.position, g.size])).toEqual([[1, 1, 2], [2, 2, 2]]);
  });

  it("AC-7 organizer: two rows, each with its own travellers and its own reference", async () => {
    reservations(BOOKINGS, { isOrganizer: true });
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("Arlo Vesper, Lena Vesper")).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/QX7P2M/)).toBeInTheDocument();
    expect(within(cards[0]!).queryByText(/ZT3K9D/)).not.toBeInTheDocument();
    expect(within(cards[1]!).getByText("Bria Tallis, Cole Tallis")).toBeInTheDocument();
    expect(within(cards[1]!).getByText(/ZT3K9D/)).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Same flight · booking 1 of 2")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("Same flight · booking 2 of 2")).toBeInTheDocument();
  });

  it("AC-8 member: still two rows told apart by 'booking N of 2' even with no travellers named, and no reference shown", async () => {
    reservations(BOOKINGS.map((b) => ({ ...b, passengers: null })), { isOrganizer: false, lang: "he" });
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("אותה טיסה · הזמנה 1 מתוך 2")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("אותה טיסה · הזמנה 2 מתוך 2")).toBeInTheDocument();
    expect(screen.queryByText(/QX7P2M|ZT3K9D/)).not.toBeInTheDocument();
  });

  it("AC-9 a flight booked once shows nothing extra", async () => {
    reservations([BOOKINGS[0]], { isOrganizer: true });
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).queryByText(/Same flight/)).not.toBeInTheDocument();
    expect(within(cards[0]!).queryByText(/QX7P2M/)).not.toBeInTheDocument();
  });
});
