/**
 * Planning the open days (issue #133): what the Modern site shows before and
 * after the one action that creates a stop in a gap and writes its plan.
 *
 * The server computes the "days not planned yet" phase from the stops
 * (server/trip-structure.js), so the client has no logic of its own to get
 * wrong — what it must do is draw whatever config and itinerary it is handed.
 * These tests hand JourneyView the two payloads the real server serves around
 * one POST /api/stops (tests/plan-open-days.test.js drives the real server) and
 * assert the user-visible result: the placeholder is there for the open days,
 * and after the action it is gone and the new stop, with its itinerary, is.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JourneyView } from "./App";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const FRANKFURT = { id: "frankfurt", title: { en: "Frankfurt", he: "פרנקפורט" }, dates: { start: "2026-12-02", end: "2026-12-03" } };
const COLMAR = { id: "colmar", title: { en: "Colmar", he: "קולמר" }, dates: { start: "2026-12-06", end: "2026-12-07" } };
const OPEN_DAYS = {
  id: "open-days", unplanned: true, title: { en: "Days not planned yet", he: "ימים שעוד לא תוכננו" },
  dates: { start: "2026-12-04", end: "2026-12-05" },
  note: { en: "2 day(s) of this trip do not belong to a stop yet. Talk to your assistant to add them to one, or open a new stop.", he: "2 ימים" },
};
const STRASBOURG = {
  id: "strasbourg", title: { en: "Strasbourg", he: "שטרסבורג" }, tabLabel: "STRASBOURG",
  dates: { start: "2026-12-04", end: "2026-12-05" }, accommodation: { name: "Hotel Strasbourg Centre" },
};

const BEFORE = { phases: [FRANKFURT, OPEN_DAYS, COLMAR] };
const AFTER = { phases: [FRANKFURT, STRASBOURG, COLMAR] };
const EMPTY = { days: [], items: [] };
// What GET /api/itinerary/active serves once the one action has run.
const PLANNED = {
  days: [
    { phase_id: "strasbourg", date: "2026-12-04", label_en: "The old town", label_he: "העיר העתיקה" },
    { phase_id: "strasbourg", date: "2026-12-05", label_en: null, label_he: null },
  ],
  items: [
    { item_uid: "i1", phase_id: "strasbourg", date: "2026-12-04", time: "10:00", time_sort: 600, item_type: "activity", text_en: "Strasbourg Cathedral", text_he: "קתדרלת שטרסבורג", sort_order: 1, confirmation_state: "verified" },
    { item_uid: "i2", phase_id: "strasbourg", date: "2026-12-05", time: "morning", time_sort: 540, item_type: "activity", text_en: "Christmas market", text_he: "שוק חג המולד", sort_order: 2, confirmation_state: "verified" },
  ],
};

function tree(config: unknown, itinerary: unknown) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JourneyView itinerary={itinerary as never} config={config as never} isOrganizer lang="en" onHeroPhaseChange={vi.fn()} />
    </QueryClientProvider>
  );
}

describe("a trip with days no stop covers", () => {
  it("shows the open days as a phase of their own, with their count, between the two stops", () => {
    render(tree(BEFORE, EMPTY));
    const rail = screen.getByLabelText("Trip phases");
    expect(within(rail).getByText("Days not planned yet")).toBeInTheDocument();
    expect(within(rail).getByText("Frankfurt")).toBeInTheDocument();
    expect(within(rail).getByText("Colmar")).toBeInTheDocument();
    const names = within(rail).getAllByRole("button").map((b) => b.textContent ?? "");
    expect(names.findIndex((n) => /Frankfurt/.test(n))).toBeLessThan(names.findIndex((n) => /Days not planned yet/.test(n)));
    expect(names.findIndex((n) => /Days not planned yet/.test(n))).toBeLessThan(names.findIndex((n) => /Colmar/.test(n)));
  });
});

describe("after the one action that plans them", () => {
  it("the placeholder is gone and the new stop is in the rail, in order, with its days", () => {
    const view = render(tree(BEFORE, EMPTY));
    expect(within(screen.getByLabelText("Trip phases")).queryByText("Days not planned yet")).toBeInTheDocument();
    // The refetch after POST /api/stops: new config, new itinerary, same component.
    view.rerender(tree(AFTER, PLANNED));
    const rail = screen.getByLabelText("Trip phases");
    expect(within(rail).queryByText("Days not planned yet")).not.toBeInTheDocument();
    expect(screen.queryByText(/do not belong to a stop yet/)).not.toBeInTheDocument();
    const names = within(rail).getAllByRole("button").map((b) => b.textContent ?? "");
    expect(names.findIndex((n) => /Frankfurt/.test(n))).toBeLessThan(names.findIndex((n) => /Strasbourg/.test(n)));
    expect(names.findIndex((n) => /Strasbourg/.test(n))).toBeLessThan(names.findIndex((n) => /Colmar/.test(n)));
    expect(within(rail).getAllByText("2 days").length).toBeGreaterThanOrEqual(1);
  });

  it("selecting the new stop shows its itinerary: both days, the headline and the items", () => {
    render(tree(AFTER, PLANNED));
    const rail = screen.getByLabelText("Trip phases");
    fireEvent.click(within(rail).getByText("Strasbourg"));
    const strip = screen.getByLabelText("Days in selected phase");
    expect(within(strip).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("Strasbourg Cathedral")).toBeInTheDocument();
    fireEvent.click(within(strip).getAllByRole("button")[1]!);
    expect(screen.getByText("Christmas market")).toBeInTheDocument();
  });

  it("the stop and its items arrive together: a stop with no items yet still offers its days as open, never the placeholder", () => {
    render(tree(AFTER, EMPTY));
    const rail = screen.getByLabelText("Trip phases");
    expect(within(rail).queryByText("Days not planned yet")).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByText("Strasbourg"));
    expect(within(screen.getByLabelText("Days in selected phase")).getAllByText("open")).toHaveLength(2);
  });
});
