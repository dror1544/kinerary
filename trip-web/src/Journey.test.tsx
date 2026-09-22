import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { JourneyView } from "./App";
import type { ItineraryDay } from "./api";

afterEach(cleanup);

describe("Journey lodging", () => {
  it.each([
    ["en", { he: "מלון לדוגמה", en: "Fixture hotel" }, "Tonight: Fixture hotel"],
    ["he", { he: "מלון לדוגמה", en: "Fixture hotel" }, "הלילה: מלון לדוגמה"],
    ["en", { he: "מלון לדוגמה" }, "Tonight: מלון לדוגמה"],
    ["he", "Plain hotel", "הלילה: Plain hotel"],
    ["en", null, null],
  ] as const)("renders %s lodging %j without crashing", (lang, name, expected) => {
    const day: ItineraryDay = {
      phase_id: "ny", date: "2027-03-11", label_en: "Arrival",
      lodging_context: { name },
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView itinerary={{ revision: "test", days: [day], items: [] }}
          lang={lang} isOrganizer onHeroPhaseChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Arrival" })).toBeInTheDocument();
    if (expected) expect(screen.getByText(expected)).toBeInTheDocument();
    else expect(screen.queryByText(/Tonight:/)).not.toBeInTheDocument();
  });

  it("opens the active trip day, while retaining day one before departure", () => {
    const itinerary = {
      revision: "test",
      days: [
        { phase_id: "tokyo", date: "2026-10-01", label_en: "First day" },
        { phase_id: "kyoto", date: "2026-10-02", label_en: "Active day" },
      ],
      items: [],
    };
    const today = { today: "2026-10-02", phase: "active_day" as const, countdown_days: 0, current: null, next: null, events: [], flights: [] };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView itinerary={itinerary} today={today} lang="en" onHeroPhaseChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Active day" })).toBeInTheDocument();

    cleanup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView itinerary={itinerary} today={{ ...today, phase: "pre_trip" }} lang="en" onHeroPhaseChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "First day" })).toBeInTheDocument();
  });
});
