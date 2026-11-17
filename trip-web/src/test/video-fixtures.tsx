// Shared fixtures for the video-release tests (docs/specs/sprint-9/x-video-r1-site-look.md): a small trip
// shaped like the Alsace one — one phase, a labelled day, a full day of items, a changed dinner — and a
// fetch stand-in that answers the routes the app reads. Not a test file: vitest only collects *.test.*.
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "../App";
import { tokenStore, type ItineraryDay, type ItineraryItem, type TodayContext } from "../api";

export const TODAY = "2026-12-03";

export const PARTICIPANTS = ["avi", "bat", "gal", "dan", "eli", "fay", "gil"].map((username, index) => ({
  username, name: `שם ${index}`, name_en: `Person ${index}`, color: "#0e8f86",
}));

export function item(partial: Partial<ItineraryItem> & { item_uid: string; text_en: string }): ItineraryItem {
  return {
    phase_id: "colmar", date: TODAY, time: null, time_sort: null, item_type: "activity",
    text_he: `${partial.text_en} (he)`, location_url: null, waze_url: null, booking: null,
    ...partial,
  } as ItineraryItem;
}

/** Thursday 3 December: breakfast, a winery with a Waze link, a free evening, and a dinner moved 20:00 -> 19:00. */
export function dayItems(changeAt = new Date(Date.now() - 5 * 60_000).toISOString()): ItineraryItem[] {
  return [
    item({ item_uid: "breakfast", text_en: "Breakfast at the hotel", text_he: "ארוחת בוקר במלון", time: "08:30", time_sort: 510, item_type: "meal", location_url: "https://maps.example/hotel" }),
    item({ item_uid: "winery", text_en: "Winery tour", text_he: "סיור ביקב", time: "11:00", time_sort: 660, waze_url: "https://waze.com/ul?q=winery", booking: { id: 4, type: "attraction", name: "Winery", location_url: "https://maps.example/winery-booking" } }),
    item({ item_uid: "free", text_en: "Free evening", text_he: "ערב חופשי", time: "evening", time_sort: 1140, item_type: "free_time" }),
    item({ item_uid: "dinner", text_en: "Dinner at the Winstub", text_he: "ארוחת ערב בווינשטוב", time: "19:00", time_sort: 1140, item_type: "meal",
      recent_change: { kind: "updated", at: changeAt, fields: ["time"], previous_time: "20:00" } }),
  ];
}

export function config(features?: Record<string, boolean>) {
  return {
    meta: { title: "Alsace 2026", destination: "Alsace" },
    phases: [{ id: "colmar", title: { en: "Colmar", he: "קולמר" }, dates: { start: "2026-12-02", end: "2026-12-06" } }],
    participants: PARTICIPANTS,
    ...(features ? { features } : {}),
  };
}

export function todayContext(items: ItineraryItem[], extra: Partial<TodayContext> = {}): TodayContext {
  return {
    today: TODAY, phase: "active_day", countdown_days: -1, first_date: "2026-12-02", last_date: "2026-12-06",
    current: items[0] ?? null, next: items[1] ?? null, events: items, flights: [], companion_message: null,
    ...extra,
  };
}

export type Served = { config: unknown; today: TodayContext; items: ItineraryItem[]; days?: ItineraryDay[]; user?: Record<string, unknown>; settings?: Record<string, unknown>; flights?: unknown[] };

export const LABELLED_DAY: ItineraryDay = { phase_id: "colmar", date: TODAY, label_en: "Thu 12/3 — Wine Route", label_he: "יום ה׳ 3/12 — דרך היין" };

/** A fetch stand-in. `served` is read on every request, so a test can change what the "server" says and invalidate. */
export function stubTripFetch(served: () => Served) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://trip.test");
    const state = served();
    switch (url.pathname) {
      case "/api/config": return json(state.config);
      case "/api/auth/me": return json(state.user ?? { username: "avi", name: "אבי", name_en: "Avi", is_organizer: true });
      case "/api/ui-settings": return json({ design_variant: "modern", hero: { url: null, focal_x: 0.5, focal_y: 0.45 } });
      case "/api/hermes/status": return json({ identity: { name: "Victor" }, available: true, ask_in_telegram: false, telegram_username: null, verification_freshness: { open_issues: 0, checked_at: "" } });
      case "/api/itinerary/active": return json({ revision: "rev_1", days: state.days ?? [LABELLED_DAY], items: state.items });
      case "/api/today": return json(state.today);
      case "/api/settings": return json({ timezone: null, group_change_line: true, nav_app: "google", ...(state.settings ?? {}) });
      case "/api/confirmations/summary": return json({ items: [] });
      case "/api/operations/flights": return json({ statuses: state.flights ?? [] });
      case "/api/moments": return json([]);
      case "/api/photos": return json([]);
      case "/api/bookings": return json([]);
      default: return json({ error: "not stubbed" }, 404);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function renderTrip({ hash = "" }: { hash?: string } = {}) {
  tokenStore.set("test-token");
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  return { client, ...view };
}

export function useJsdomBasics() {
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}
