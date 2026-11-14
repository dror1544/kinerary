/**
 * #545 — the "Type" box in the itinerary editor lists every option in the
 * site's language. English is the source; Hebrew is the one curated table
 * (src/item-types.ts) — the eight types are a closed set the server validates
 * (server/living-journey.js VALID_ITEM_TYPES), so nothing is translated at
 * runtime and nothing is left to a model.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JourneyView } from "./App";
import { BookingsView } from "./App";
import { BOOKING_TYPES, bookingTypeLabel, ITEM_TYPES, itemTypeLabel } from "./item-types";

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); localStorage.clear(); });

const CONFIG = { phases: [{ id: "gc", title: { en: "Gatecity", he: "גייטסיטי" }, dates: { start: "2026-11-14", end: "2026-11-16" } }] };
const ITINERARY = {
  revision: "r1",
  days: [{ phase_id: "gc", date: "2026-11-14", label_en: "Arrival", label_he: "הגעה" }],
  items: [{ item_uid: "i1", phase_id: "gc", date: "2026-11-14", time: "10:00", time_sort: 600, item_type: "free_time", text_en: "Rest", text_he: "מנוחה", sort_order: 1, confirmation_state: "verified" }],
};

function openEditor(lang: "en" | "he") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JourneyView itinerary={ITINERARY as never} config={CONFIG as never} isOrganizer lang={lang} onHeroPhaseChange={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: lang === "he" ? /הוספת פריט למסלול/ : /Add itinerary item/ }));
  return screen.getByLabelText(lang === "he" ? "סוג" : "Type") as HTMLSelectElement;
}

describe("#545 activity type options follow the site language", () => {
  it("AC-1 on a Hebrew site every option of the Type box is Hebrew (no Latin letters)", () => {
    const select = openEditor("he");
    const labels = within(select).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(labels).toHaveLength(ITEM_TYPES.length);
    for (const label of labels) expect(label, `option "${label}" must be Hebrew`).toMatch(/^[֐-׿ ]+$/);
    // Values stay the English identifiers the server stores.
    expect(within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual([...ITEM_TYPES]);
  });

  it("AC-2 on an English site the options read as English words, not identifiers", () => {
    const select = openEditor("en");
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["Activity", "Travel", "Meal", "Lodging", "Free time", "Booking", "Task", "Note"]);
  });

  it("AC-3 the type badge on an item card is in the site language too", () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView itinerary={ITINERARY as never} config={CONFIG as never} lang="he" onHeroPhaseChange={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("זמן חופשי")).toBeInTheDocument();
    expect(screen.queryByText("free time")).not.toBeInTheDocument();
  });

  it("AC-4 every type has both a Hebrew and an English label; an unknown type falls back to its identifier, spaced", () => {
    for (const type of ITEM_TYPES) {
      expect(itemTypeLabel(type, "he")).toMatch(/[֐-׿]/);
      expect(itemTypeLabel(type, "en")).toMatch(/^[A-Z][a-z ]+$/);
    }
    expect(itemTypeLabel("some_new_type", "he")).toBe("some new type");
  });
});

describe("#545 the Reservations booking badge follows the site language", () => {
  it("AC-5 a booking card's badge is Hebrew on a Hebrew site and English on an English one", async () => {
    const bookings = [
      { id: 1, phase: "gc", type: "flight", name: "SL 482", date_from: "2026-11-14", review_status: "approved" },
      { id: 2, phase: "gc", type: "hotel", name: "Hotel Rive", date_from: "2026-11-14", review_status: "approved" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.startsWith("/api/bookings") ? bookings : {} })));
    const show = (lang: "en" | "he") => render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BookingsView config={CONFIG as never} lang={lang} />
      </QueryClientProvider>,
    );
    const he = show("he");
    await screen.findAllByRole("article");
    expect([...he.container.querySelectorAll(".booking-card .booking-type")].map((n) => n.textContent)).toEqual(["טיסה", "לינה"]);
    he.unmount();
    const en = show("en");
    await screen.findAllByRole("article");
    expect([...en.container.querySelectorAll(".booking-card .booking-type")].map((n) => n.textContent)).toEqual(["Flight", "Stay"]);
    vi.unstubAllGlobals();
  });

  it("AC-6 every booking type has both labels; an unknown one shows as stored", () => {
    for (const type of BOOKING_TYPES) {
      expect(bookingTypeLabel(type, "he")).toMatch(/^[\u0590-\u05FF ]+$/);
      expect(bookingTypeLabel(type, "en")).toMatch(/^[A-Z][a-z]+$/);
    }
    expect(bookingTypeLabel("toString", "he")).toBe("toString");
    expect(bookingTypeLabel("cruise", "he")).toBe("cruise");
  });
});
