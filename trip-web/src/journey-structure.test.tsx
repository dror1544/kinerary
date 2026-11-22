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

// The Plan's day strip lists each phase as a group of day buttons (the old rail and day picker are gone).
const daysOf = (phase: string) => {
  const group = screen.getByRole("heading", { name: phase }).closest(".plan-strip-group") as HTMLElement;
  return within(group).getAllByRole("button");
};

function renderJourney() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JourneyView
        itinerary={{ days: [], items: [] } as never}
        config={CONFIG}
        isOrganizer
        lang="en"
       
      />
    </QueryClientProvider>,
  );
}

describe("a trip with structure and no plan", () => {
  it("offers every day of the selected phase, marked open", () => {
    renderJourney();
    const days = daysOf("Tokyo");
    expect(days).toHaveLength(3);
    expect(days.filter((day) => /open/.test(day.textContent || ""))).toHaveLength(3);
  });

  it("shows each phase with its own days in the strip (3 in Tokyo, 2 in Kyoto)", () => {
    renderJourney();
    expect(daysOf("Tokyo")).toHaveLength(3);
    expect(daysOf("Kyoto")).toHaveLength(2);
  });

  it("starts a new activity on the day you were looking at", () => {
    renderJourney();
    fireEvent.click(daysOf("Tokyo")[1]!);
    fireEvent.click(screen.getByRole("button", { name: /add itinerary item/i }));
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-09-20");
    expect((screen.getByLabelText("Phase") as HTMLSelectElement).value).toBe("tokyo");
  });
});

describe("a phase with part of its plan written", () => {
  // 2026-09-12, from a real trip: Tokyo 19–23 September with a single day
  // planned showed ONE day and hid the other four, while the leg with nothing
  // planned showed its whole range. Under-reporting a trip reads as the site
  // losing the trip, and it is the thing that made the organizer worry.
  function renderPartlyPlanned() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView
          itinerary={{
            days: [{ date: "2026-09-20", phase_id: "tokyo", label_en: "Day 2" }],
            items: [],
          } as never}
          config={CONFIG}
          isOrganizer
          lang="en"
         
        />
      </QueryClientProvider>,
    );
  }

  it("still offers every day of the phase, not only the planned one", () => {
    renderPartlyPlanned();
    const days = daysOf("Tokyo");
    expect(days).toHaveLength(3);
    expect(days.filter((day) => /open/.test(day.textContent || ""))).toHaveLength(2);
  });

  it("shows the whole leg in the strip", () => {
    renderPartlyPlanned();
    expect(daysOf("Tokyo")).toHaveLength(3);
  });

  it("keeps a planned day that falls outside the phase's own range", () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JourneyView
          itinerary={{ days: [{ date: "2026-09-25", phase_id: "tokyo" }], items: [] } as never}
          config={CONFIG}
          isOrganizer
          lang="en"
         
        />
      </QueryClientProvider>,
    );
    expect(daysOf("Tokyo")).toHaveLength(4);
    // Sorted, so the stray day sits after the range rather than first.
    expect(daysOf("Tokyo").at(-1)!.textContent).toMatch(/25/);
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
