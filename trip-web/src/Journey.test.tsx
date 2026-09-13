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
});
