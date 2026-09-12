/**
 * The journey shows the trip's shape before anyone has planned a day of it,
 * and questions a date filed under the wrong leg without refusing it.
 *
 * Asked for 2026-09-12: "if from the interview you get the structured trip and
 * it is known (3 days in Tokyo, one in Hakone, 2 in Kyoto) then that structure
 * should be reflected on the journey page, on the days — they may be empty but
 * structured… if he selected a phase and a date out of that phase, he will get
 * a warning that this does not make sense and ask him to verify (but if he
 * approves don't block)."
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JourneyView } from "./App";

// jsdom has no scrollIntoView, and the editor scrolls itself into view on
// open. Nothing about the behaviour under test depends on it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const CONFIG = {
  phases: [
    { id: "tokyo", title: { en: "Tokyo" }, dates: { start: "2026-09-19", end: "2026-09-21" } },
    { id: "kyoto", title: { en: "Kyoto" }, dates: { start: "2026-09-22", end: "2026-09-23" } },
  ],
};

function renderJourney() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JourneyView
        itinerary={{ days: [], items: [] } as never}
        config={CONFIG}
        isOrganizer
        lang="en"
        onHeroPhaseChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("a trip with structure and no plan", () => {
  it("offers every day of the selected phase, marked open", () => {
    renderJourney();
    const strip = screen.getByLabelText("Days in selected phase");
    const days = within(strip).getAllByRole("button");
    expect(days).toHaveLength(3);
    expect(within(strip).getAllByText("open")).toHaveLength(3);
  });

  it("counts the days on each phase in the rail", () => {
    renderJourney();
    const rail = screen.getByLabelText("Trip phases");
    expect(within(rail).getByText("3 days")).toBeInTheDocument();
    expect(within(rail).getByText("2 days")).toBeInTheDocument();
  });

  it("starts a new activity on the day you were looking at", () => {
    renderJourney();
    fireEvent.click(screen.getByLabelText("Days in selected phase").querySelectorAll("button")[1]!);
    fireEvent.click(screen.getByRole("button", { name: /add itinerary item/i }));
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-09-20");
    expect((screen.getByLabelText("Phase") as HTMLSelectElement).value).toBe("tokyo");
  });
});

describe("a date filed under the wrong leg", () => {
  it("says so, and still lets the organizer mean it", async () => {
    const post = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, revision: "r1" }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", post);
    renderJourney();
    fireEvent.click(screen.getByRole("button", { name: /add itinerary item/i }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-23" } });

    expect(await screen.findByText(/not one of Tokyo's days/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Activity name"), { target: { value: "Night train" } });

    // Refusing the question refuses the save — nothing is sent.
    vi.stubGlobal("confirm", vi.fn(() => false));
    fireEvent.click(screen.getByRole("button", { name: /save revision/i }));
    await waitFor(() => expect(post).not.toHaveBeenCalled());

    // Approving it saves exactly what was asked for, on the date given.
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: /save revision/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = JSON.parse(String(post.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ phase_id: "tokyo", date: "2026-09-23", text_he: "Night train" });
  });
});
