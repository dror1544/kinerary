/**
 * A plan item with no day (an idea nobody has placed yet, or one a companion filed without a date) used to be
 * invisible on the modern site, which lists items per date. The Plan now shows them in a "Not on a day yet"
 * group for the phase, in both layouts; an organizer can put one on a day, a member only reads the list.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyView } from "./App";
import { setItineraryItemDay } from "./api";
import { config, item, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

const CONFIG = {
  phases: [
    { id: "lisbon", title: { en: "Lisbon", he: "ליסבון" }, dates: { start: "2027-03-01", end: "2027-03-03" } },
    { id: "porto", title: { en: "Porto", he: "פורטו" }, dates: { start: "2027-03-04", end: "2027-03-05" } },
  ],
};
const dated = { item_uid: "dated", phase_id: "lisbon", date: "2027-03-01", time: "10:00", item_type: "activity", text_he: "טרם", text_en: "Tram 28" };
const idea = { item_uid: "idea", phase_id: "lisbon", date: null, time: "19:30", item_type: "meal", text_he: "ארוחת ערב מקומית", text_en: "Local dinner" };
const otherStop = { item_uid: "porto-idea", phase_id: "porto", date: null, time: null, item_type: "activity", text_he: "גשר", text_en: "Bridge walk" };
const itinerary = {
  revision: "r1",
  days: [{ phase_id: "lisbon", date: "2027-03-01" }],
  items: [dated, idea, otherStop],
};
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const journey = (props: { isOrganizer: boolean; lang?: "en" | "he"; itinerary?: unknown; videoLayout?: boolean }) => render(
  <QueryClientProvider client={client()}>
    <JourneyView itinerary={(props.itinerary ?? itinerary) as never} config={CONFIG} isOrganizer={props.isOrganizer} lang={props.lang ?? "en"}
      videoLayout={props.videoLayout} onHeroPhaseChange={vi.fn()} />
  </QueryClientProvider>,
);

describe("the plan's 'Not on a day yet' group", () => {
  it("lists the phase's undated items, and only that phase's, for a member — read-only", () => {
    journey({ isOrganizer: false });
    const group = screen.getByRole("region", { name: "Not on a day yet" });
    expect(within(group).getByText("Local dinner")).toBeTruthy();
    expect(within(group).queryByText("Bridge walk")).toBeNull();
    expect(within(group).queryByText("Tram 28")).toBeNull();
    expect(within(group).queryByRole("combobox")).toBeNull();
    expect(within(group).queryByRole("button")).toBeNull();
    // The dated item is still on its day, outside the group.
    expect(screen.getByText("Tram 28").closest("[role=region]")).toBeNull();
  });

  it("renders nothing when the phase has no undated item", () => {
    journey({ isOrganizer: true, itinerary: { ...itinerary, items: [dated, otherStop] } });
    expect(screen.queryByRole("region", { name: "Not on a day yet" })).toBeNull();
    expect(screen.queryByText(/Not on a day yet/)).toBeNull();
  });

  it("shows it when the phase has no planned day at all, instead of the empty-day message hiding it", () => {
    journey({ isOrganizer: false, itinerary: { revision: "r1", days: [], items: [idea] } });
    expect(within(screen.getByRole("region", { name: "Not on a day yet" })).getByText("Local dinner")).toBeTruthy();
  });

  it("is bilingual: Hebrew title, Hebrew item text", () => {
    journey({ isOrganizer: false, lang: "he" });
    const group = screen.getByRole("region", { name: "עדיין לא שובץ ליום" });
    expect(within(group).getByText("ארוחת ערב מקומית")).toBeTruthy();
  });

  it("is the same in the video layout", () => {
    journey({ isOrganizer: false, videoLayout: true });
    expect(within(screen.getByRole("region", { name: "Not on a day yet" })).getByText("Local dinner")).toBeTruthy();
  });

  it("lets an organizer put an item on a day of its phase: PATCH to the item's own route with the day", async () => {
    const calls: Array<[string, string, unknown]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push([String(url), init?.method || "GET", init?.body ? JSON.parse(String(init.body)) : null]);
      return new Response(JSON.stringify({ revision: "r2", item_uid: "idea" }), { headers: { "content-type": "application/json" } });
    }));
    journey({ isOrganizer: true });
    const group = screen.getByRole("region", { name: "Not on a day yet" });
    const picker = within(group).getByRole("combobox", { name: /Put .*Local dinner.* on a day/ });
    // Only Lisbon's own days are offered (a stop's dates are the phase's calendar).
    expect([...(picker as HTMLSelectElement).options].map((option) => option.value).filter(Boolean)).toEqual(["2027-03-01", "2027-03-02", "2027-03-03"]);
    fireEvent.change(picker, { target: { value: "2027-03-02" } });
    await waitFor(() => expect(calls).toContainEqual(["/api/itinerary/items/idea", "PATCH", { phase_id: "lisbon", date: "2027-03-02" }]));
  });

  it("setItineraryItemDay sends only the phase and the day, guarded by the revision it saw", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ revision: "r2", item_uid: "a/b" }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await setItineraryItemDay("a/b", "lisbon", "2027-03-02", "r1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/itinerary/items/a%2Fb");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ phase_id: "lisbon", date: "2027-03-02" }));
    expect((init.headers as Headers).get("If-Match")).toBe("r1");
  });
});

describe("through the whole app", () => {
  const undated = item({ item_uid: "idea", text_en: "Local dinner", text_he: "ארוחת ערב מקומית", date: null as unknown as string, time: "19:30", time_sort: 1170, item_type: "meal" });

  function serve(features: Record<string, boolean> | undefined, user?: Record<string, unknown>) {
    const items = [item({ item_uid: "walk", text_en: "Walk the old town", date: "2026-12-04" }), undated];
    stubTripFetch(() => ({ config: config(features), today: todayContext([]), items, days: [], ...(user ? { user } : {}) }));
  }

  it("default layout: an organizer sees the group on the Plan tab", async () => {
    serve(undefined);
    renderTrip({ hash: "journey" });
    const group = await screen.findByRole("region", { name: "Not on a day yet" });
    expect(within(group).getByText("Local dinner")).toBeTruthy();
    expect(within(group).getByRole("combobox")).toBeTruthy();
  });

  it("video layout (site_video_layout): a member sees the group, without the picker", async () => {
    serve({ site_video_layout: true }, { username: "bat", name: "בת", name_en: "Bat", is_organizer: false });
    renderTrip({ hash: "journey" });
    const group = await screen.findByRole("region", { name: "Not on a day yet" });
    expect(within(group).getByText("Local dinner")).toBeTruthy();
    expect(within(group).queryByRole("combobox")).toBeNull();
  });
});
