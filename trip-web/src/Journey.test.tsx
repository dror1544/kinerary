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

describe("Tonight follows the effective stop, not the lodging stored on the day", () => {
  const renderDay = (config: unknown, day: ItineraryDay, lang: "en" | "he" = "en") => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JourneyView itinerary={{ revision: "test", days: [day], items: [] }} config={config as never}
        lang={lang} onHeroPhaseChange={() => {}} focus={{ phaseId: day.phase_id, date: day.date }} />
    </QueryClientProvider>,
  );

  it("names the stop's hotel when the stored copy is null (any legacy write nulls it)", () => {
    renderDay({ phases: [{ id: "colmar", title: "Colmar", dates: { start: "2026-12-02", end: "2026-12-06" }, accommodation: { name: { he: "מלון ריב", en: "Hotel Rive" } } }] },
      { phase_id: "colmar", date: "2026-12-03", label_en: "Riquewihr", lodging_context: null });
    expect(screen.getByText("Tonight: Hotel Rive")).toBeInTheDocument();
  });

  it("follows an edited hotel rather than the one stored when the plan was imported", () => {
    renderDay({ phases: [{ id: "colmar", title: "Colmar", dates: { start: "2026-12-02", end: "2026-12-06" }, accommodation: { name: "Hôtel Neuf" } }] },
      { phase_id: "colmar", date: "2026-12-03", label_en: "Riquewihr", lodging_context: { name: "Hotel Rive" } }, "he");
    expect(screen.getByText("הלילה: Hôtel Neuf")).toBeInTheDocument();
  });

  it("after a split, the split day's night belongs to the new stop — not the old stop's hotel", () => {
    renderDay({ phases: [
      { id: "colmar", title: "Colmar", dates: { start: "2026-12-02", end: "2026-12-06" }, accommodation: { name: "Hotel Rive" } },
      { id: "near-the-airport", title: "Near the airport", dates: { start: "2026-12-06", end: "2026-12-07" }, accommodation: { name: "Airport Inn" } },
    ] }, { phase_id: "colmar", date: "2026-12-06", label_en: "Last Colmar morning", lodging_context: { name: "Hotel Rive" } });
    expect(screen.getByText("Tonight: Airport Inn")).toBeInTheDocument();
  });

  it("a new stop with no hotel yet does not inherit the old stop's stored hotel", () => {
    renderDay({ phases: [
      { id: "colmar", title: "Colmar", dates: { start: "2026-12-02", end: "2026-12-06" }, accommodation: { name: "Hotel Rive" } },
      { id: "near-the-airport", title: "Near the airport", dates: { start: "2026-12-06", end: "2026-12-07" } },
    ] }, { phase_id: "colmar", date: "2026-12-06", label_en: "Last Colmar morning", lodging_context: { name: "Hotel Rive" } });
    expect(screen.getByRole("heading", { name: "Last Colmar morning" })).toBeInTheDocument();
    expect(screen.queryByText(/Tonight:/)).not.toBeInTheDocument();
  });
});
