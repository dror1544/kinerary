// One hotel, one place: the screens agree on where it is (server/hotel-place.js
// resolves the links; these tests pin what each screen does with them).
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JourneyView, MapView, UpcomingActivity, mapPins } from "./App";
import type { ItineraryItem, TripConfig } from "./api";

afterEach(cleanup);

const MAPS = "https://www.google.com/maps/search/?api=1&query=Hotel%20Vignoble%20Dore%2C%20Colmar";
const WAZE = "https://waze.com/ul?q=Hotel%20Vignoble%20Dore%2C%20Colmar&navigate=yes";
const config = (accommodation: Record<string, unknown>, mapStop?: Record<string, unknown>) => ({
  phases: [{ id: "colmar", title: { he: "קולמר", en: "Colmar" }, start: "2090-03-10", end: "2090-03-14", dates: { start: "2090-03-10", end: "2090-03-14" }, ...(mapStop ? { mapStop } : {}), accommodation }],
}) as unknown as TripConfig;
const resolved = { type: "hotel", name: "Hotel Vignoble Dore", location_url: MAPS, waze: WAZE };

describe("Today", () => {
  const checkin: ItineraryItem = { item_uid: "booking_1_checkin", phase_id: "colmar", date: "2090-03-10", time: "afternoon", item_type: "booking", text_he: "צ׳ק-אין — Hotel Vignoble Dore", text_en: "Check-in — Hotel Vignoble Dore", location_url: MAPS, waze_url: WAZE, location_derived: true };
  it("offers the hotel's Google Maps AND Waze links, the same ones the other screens open", () => {
    render(<UpcomingActivity item={checkin} lang="en" onOpenItinerary={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", MAPS);
    expect(screen.getByRole("link", { name: "Waze" })).toHaveAttribute("href", WAZE);
  });
});

describe("Journey 'Tonight'", () => {
  it("names the hotel and links the same Google Maps and Waze", () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView itinerary={{ revision: "t", days: [{ phase_id: "colmar", date: "2090-03-11", label_en: "Walk", lodging_context: null }], items: [] }}
          config={config(resolved, { lat: 48.0794, lng: 7.3585, name: "Colmar" })} lang="en" onHeroPhaseChange={() => {}} focus={{ phaseId: "colmar", date: "2090-03-11" }} />
      </QueryClientProvider>,
    );
    const tonight = document.querySelector(".tonight-lodging") as HTMLElement;
    expect(tonight).toHaveTextContent("Tonight: Hotel Vignoble Dore");
    expect(within(tonight).getByRole("link", { name: "Map" })).toHaveAttribute("href", MAPS);
    expect(within(tonight).getByRole("link", { name: "Waze" })).toHaveAttribute("href", WAZE);
  });
});

describe("Map tab", () => {
  it("a hotel on a stop with no map pin still gets its card, with the resolved links (never undefined,undefined)", () => {
    render(<MapView config={config(resolved)} itinerary={undefined} lang="en" onOpenItinerary={vi.fn()} />);
    const card = screen.getByText(/Hotel Vignoble Dore/).closest("article") as HTMLElement;
    expect(within(card).getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", MAPS);
    expect(within(card).getByRole("link", { name: "Waze" })).toHaveAttribute("href", WAZE);
    expect(card.innerHTML).not.toContain("undefined");
  });

  it("with no resolved links (a hotel the file carries) the fallback is a search for the hotel, not for coordinates that are not there", () => {
    render(<MapView config={config({ name: { he: "מלון", en: "Hotel Rive" } })} itinerary={undefined} lang="en" onOpenItinerary={vi.fn()} />);
    const card = screen.getByText(/Hotel Rive/).closest("article") as HTMLElement;
    expect(within(card).getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Hotel%20Rive%2C%20Colmar");
    expect(within(card).getByRole("link", { name: "Waze" })).toHaveAttribute("href", "https://waze.com/ul?q=Hotel%20Rive%2C%20Colmar&navigate=yes");
  });

  it("the pin is the hotel's own coordinates when its link carries them, else the stop's town pin — never a search link's text", () => {
    const own = "https://www.google.com/maps/place/Hotel/@48.0911,7.3590,17z";
    const town = { lat: 48.0794, lng: 7.3585, name: "Colmar" };
    expect(mapPins(config({ ...resolved, location_url: own }, town), [], "en")[0]).toMatchObject({ id: "stay:colmar", lat: 48.0911, lng: 7.359 });
    expect(mapPins(config(resolved, town), [], "en")[0]).toMatchObject({ id: "stay:colmar", lat: 48.0794, lng: 7.3585 });
    expect(mapPins(config(resolved), [], "en")).toEqual([]);
  });
});
