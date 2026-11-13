/**
 * #550 — two plan items at the same time: the organizer is shown it and can keep both.
 * Spec: docs/specs/sprint-8/550-plan-overlap-conflicts.md (AC-10). The server decides who receives
 * `plan_conflicts` (organizer only); the screen also refuses to draw it for a member.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JourneyView, PlanConflictNotice } from "./App";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const CONFIG = { phases: [{ id: "paris", title: { en: "Paris" }, dates: { start: "2027-03-12", end: "2027-03-12" } }] };
const other = { item_uid: "item_b", text_he: "שיעור קדרות", text_en: "Pottery class", time: "10:00" };

describe("PlanConflictNotice", () => {
  it("names the other item and its time, and Keep both posts the other uid", async () => {
    const calls: Array<[string, string, unknown]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push([String(url), init?.method || "GET", init?.body ? JSON.parse(String(init.body)) : null]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }));
    render(<QueryClientProvider client={client()}><PlanConflictNotice itemUid="item a/1" conflicts={[other]} lang="en" /></QueryClientProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Same time as");
    expect(screen.getByRole("status")).toHaveTextContent("Pottery class");
    expect(screen.getByRole("status")).toHaveTextContent("10:00");
    fireEvent.click(screen.getByRole("button", { name: /keep both/i }));
    await waitFor(() => expect(calls).toContainEqual(["/api/itinerary/items/item%20a%2F1/keep-both", "POST", { with: "item_b" }]));
  });

  it("speaks Hebrew with the Hebrew item name", () => {
    render(<QueryClientProvider client={client()}><PlanConflictNotice itemUid="item_a" conflicts={[other]} lang="he" /></QueryClientProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("שיעור קדרות");
    expect(screen.getByRole("button", { name: "להשאיר את שניהם" })).toBeTruthy();
  });

  it("renders nothing when the server sent no conflict", () => {
    const { container } = render(<QueryClientProvider client={client()}><PlanConflictNotice itemUid="item_a" lang="en" /></QueryClientProvider>);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<QueryClientProvider client={client()}><PlanConflictNotice itemUid="item_a" conflicts={[]} lang="en" /></QueryClientProvider>);
    expect(empty.container).toBeEmptyDOMElement();
  });
});

describe("the Journey", () => {
  const itinerary = {
    revision: "r1",
    days: [{ date: "2027-03-12", phase_id: "paris" }],
    items: [
      { item_uid: "item_a", phase_id: "paris", date: "2027-03-12", time: "10:00", item_type: "activity", text_he: "מוזיאון הלובר", text_en: "Louvre visit", plan_conflicts: [other] },
      { item_uid: "item_b", phase_id: "paris", date: "2027-03-12", time: "10:00", item_type: "activity", text_he: other.text_he, text_en: other.text_en },
    ],
  };
  const journey = (isOrganizer: boolean) => render(
    <QueryClientProvider client={client()}>
      <JourneyView itinerary={itinerary as never} config={CONFIG} isOrganizer={isOrganizer} lang="en" onHeroPhaseChange={vi.fn()} />
    </QueryClientProvider>,
  );

  it("shows the organizer the conflict under the item, with the button", () => {
    journey(true);
    expect(screen.getByText(/Same time as/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep both/i })).toBeTruthy();
  });

  it("never draws it for a member, even if a payload carried it", () => {
    journey(false);
    expect(screen.queryByText(/Same time as/)).toBeNull();
    expect(screen.queryByRole("button", { name: /keep both/i })).toBeNull();
  });
});
