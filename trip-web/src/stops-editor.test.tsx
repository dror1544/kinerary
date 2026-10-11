/**
 * Stop editing on the site (slice S6). The server side is server/trip-structure.js
 * and tests/trip-stops-http.test.js; this file pins what the organizer sees and
 * what the site sends: the stop list, the PATCH body, every refusal in words
 * (with the list of items a new range leaves outside), split, revert from
 * history, conflicts, and moving a day to another stop from the plan editor.
 * Members never get the controls — and the server refuses them anyway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { PlanTools } from "./plan-tools";
import { StopsEditor } from "./stops-editor";
import { tokenStore } from "./api";
import type { StopsPayload } from "./stops";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(value);
  return value;
}
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = "";
});

const colmar = {
  id: "colmar", kind: "config" as const, unplanned: false,
  stop: {
    id: "colmar", title: { he: "קולמר", en: "Colmar" }, dates: { start: "2026-12-02", end: "2026-12-06" },
    accommodation: { name: "Hotel Rive", address: "1 Quai de la Poissonnerie" },
  },
  override: { fields: ["dates"], booking_id: null, updated_by: "alice", updated_at: "2026-10-10 10:00:00", after_phase_id: null },
  conflict: null, booking_out_of_sync: false,
};
const stopsPayload = (over: Partial<StopsPayload> = {}): StopsPayload => ({
  revision: "st-3",
  trip: { start: "2026-12-02", end: "2026-12-07" },
  stops: [
    { id: "frankfurt", kind: "config", unplanned: false, stop: { id: "frankfurt", title: { he: "פרנקפורט", en: "Frankfurt" } }, override: null, conflict: null, booking_out_of_sync: false },
    colmar,
    { id: "open-days", kind: "computed", unplanned: true, stop: { id: "open-days", title: { he: "ימים שעוד לא תוכננו", en: "Days not planned yet" }, dates: { start: "2026-12-07", end: "2026-12-07" }, unplanned: true }, override: null, conflict: null, booking_out_of_sync: false },
  ],
  orphaned_overrides: [],
  ...over,
});

type Call = { method: string; url: string; body: unknown; ifMatch: string | null };
// A tiny router: `routes["PATCH /api/stops/colmar"]` is a list of responses
// handed out in order (the last one repeats).
function stubServer(routes: Record<string, Array<() => Response>>, fallback: (url: string) => Response = () => json([])) {
  const calls: Call[] = [];
  const served: Record<string, number> = {};
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method || "GET").toUpperCase();
    const key = `${method} ${url}`;
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, ifMatch: new Headers(init.headers).get("If-Match") });
    const list = routes[key];
    if (!list) return fallback(url);
    const i = Math.min(served[key] || 0, list.length - 1);
    served[key] = (served[key] || 0) + 1;
    return list[i]();
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

function renderEditor(lang: "en" | "he" = "en", c = client()) {
  render(<QueryClientProvider client={c}><StopsEditor isOrganizer lang={lang} /></QueryClientProvider>);
  return c;
}

describe("who sees the stops editor", () => {
  function routesFor(isOrganizer: boolean) {
    return stubServer({
      "GET /api/auth/me": [() => json({ username: isOrganizer ? "alice" : "bob", is_organizer: isOrganizer })],
      "GET /api/config": [() => json({ meta: { title: "Alsace" }, phases: [{ id: "frankfurt", title: "Frankfurt" }, { id: "colmar", title: "Colmar", dates: { start: "2026-12-02", end: "2026-12-06" } }] })],
      "GET /api/itinerary/active": [() => json({ revision: "r1", days: [], items: [] })],
      "GET /api/itinerary/original": [() => json({ revision: "r0", days: [], items: [] })],
      "GET /api/today": [() => json({ today: "2026-11-01", phase: "pre_trip", countdown_days: 31, current: null, next: null, events: [], flights: [] })],
      "GET /api/ui-settings": [() => json({ design_variant: "modern", hero: { url: null, focal_x: 50, focal_y: 50 } })],
      "GET /api/hermes/status": [() => json({ identity: { name: "Kin" }, available: false, ask_in_telegram: false, telegram_username: null, verification_freshness: { open_issues: 0, checked_at: "" } })],
      "GET /api/stops": [() => json(stopsPayload())],
      "GET /api/events": [() => new Response(null, { status: 204 })],
    });
  }

  it("an organizer opening plan tools sees every stop with its dates and accommodation", async () => {
    const server = routesFor(true);
    tokenStore.set("organizer-session");
    window.location.hash = "#plan-tools";
    render(<QueryClientProvider client={client()}><App /></QueryClientProvider>);
    const section = await screen.findByRole("region", { name: "Stops" });
    const row = await within(section).findByRole("article", { name: "Colmar" });
    expect(row).toHaveTextContent("2026-12-02 – 2026-12-06");
    expect(row).toHaveTextContent("Hotel Rive");
    expect(within(section).getByRole("article", { name: "Frankfurt" })).toHaveTextContent("No dates yet");
    expect(within(row).getByRole("button", { name: "Edit Colmar" })).toBeInTheDocument();
    // The computed open-days stretch is shown, never offered for editing.
    const open = within(section).getByRole("article", { name: "Days not planned yet" });
    expect(within(open).queryByRole("button")).not.toBeInTheDocument();
    expect(server.calls.some((c) => c.url === "/api/stops")).toBe(true);
  });

  it("a member never sees the controls, and the site never asks the stop routes", async () => {
    const server = routesFor(false);
    tokenStore.set("member-session");
    window.location.hash = "#plan-tools";
    render(<QueryClientProvider client={client()}><App /></QueryClientProvider>);
    await screen.findByText("Organizer access required.");
    expect(screen.queryByRole("region", { name: "Stops" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit Colmar/ })).not.toBeInTheDocument();
    expect(server.calls.some((c) => c.url.startsWith("/api/stops"))).toBe(false);
  });

  it("the editor itself renders nothing and fetches nothing for a non-organizer", () => {
    const server = stubServer({});
    const { container } = render(<QueryClientProvider client={client()}><StopsEditor isOrganizer={false} lang="en" /></QueryClientProvider>);
    expect(container).toBeEmptyDOMElement();
    expect(server.calls).toHaveLength(0);
  });
});

describe("editing a stop", () => {
  it("sends only what changed — both title languages and the dates — with the revision it was shown", async () => {
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload())],
      "PATCH /api/stops/colmar": [() => json({ revision: "st-4", stop: colmar.stop })],
    });
    const c = renderEditor();
    const invalidate = vi.spyOn(c, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Colmar" }));
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Colmar old town" } });
    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2026-12-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save stop" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    const [write] = server.writes();
    expect(write.url).toBe("/api/stops/colmar");
    expect(write.body).toEqual({ title: { he: "קולמר", en: "Colmar old town" }, dates: { start: "2026-12-02", end: "2026-12-05" } });
    expect(write.ifMatch).toBe('"st-3"');
    // The Journey tab reads the config, the itinerary and today: all three refetch.
    await waitFor(() => {
      const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey?.[0]);
      expect(keys).toEqual(expect.arrayContaining(["stops", "config", "itinerary", "today"]));
    });
  });

  it("replaces the accommodation whole, carrying the fields it can, and says which it cannot", async () => {
    const withNotes = { ...colmar, stop: { ...colmar.stop, accommodation: { ...colmar.stop.accommodation, notes: [{ text: "Late check-in" }] } } };
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload({ stops: [withNotes] }))],
      "PATCH /api/stops/colmar": [() => json({ revision: "st-4", stop: colmar.stop })],
    });
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Colmar" }));
    expect(screen.getByText(/not editable here and will not be kept: notes/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Hotel name"), { target: { value: "Hôtel Neuf" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+33 3 89 00 00 00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save stop" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0].body).toEqual({
      accommodation: { name: "Hôtel Neuf", address: "1 Quai de la Poissonnerie", phone: "+33 3 89 00 00 00" },
    });
  });

  it("items outside the new dates are listed, and keep resends the same edit with on_outside: keep", async () => {
    const items = [
      { item_uid: "booking_1_checkin", date: "2026-12-02", time: "afternoon", text_he: "צ׳ק-אין", text_en: "Check-in — Hotel Rive" },
      { item_uid: "x", date: "2026-12-03", time: null, text_he: "ריקוויר", text_en: "Riquewihr" },
    ];
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload())],
      "PATCH /api/stops/colmar": [() => json({ error: "items_outside_stop", items }, 409), () => json({ revision: "st-4", stop: colmar.stop })],
    });
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Colmar" }));
    fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2026-12-04" } });
    fireEvent.click(screen.getByRole("button", { name: "Save stop" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("These plan items fall outside the new dates");
    expect(within(alert).getByText(/Check-in — Hotel Rive/)).toBeInTheDocument();
    expect(within(alert).getByText(/Riquewihr/)).toBeInTheDocument();
    expect(within(alert).getByText(/2026-12-03/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Keep them where they are" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].body).toEqual({ dates: { start: "2026-12-04", end: "2026-12-06" }, on_outside: "keep" });
  });

  it("…or moves them to another real stop with on_outside: move_to:<stop>", async () => {
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload())],
      "PATCH /api/stops/colmar": [() => json({ error: "items_outside_stop", items: [{ item_uid: "x", date: "2026-12-03", time: null, text_he: "ריקוויר", text_en: "Riquewihr" }] }, 409), () => json({ revision: "st-4", stop: colmar.stop })],
    });
    renderEditor("he");
    fireEvent.click(await screen.findByRole("button", { name: "עריכה: קולמר" }));
    fireEvent.change(screen.getByLabelText("יום ראשון"), { target: { value: "2026-12-04" } });
    fireEvent.click(screen.getByRole("button", { name: "שמירת התחנה" }));
    const alert = await screen.findByRole("alert");
    const target = within(alert).getByLabelText("להעביר אותם לתחנה");
    // Only another real stop: not this one, not the computed open days.
    expect(within(target).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual(["frankfurt"]);
    fireEvent.change(target, { target: { value: "frankfurt" } });
    fireEvent.click(within(alert).getByRole("button", { name: "העברה ושמירה" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].body).toEqual({ dates: { start: "2026-12-04", end: "2026-12-06" }, on_outside: "move_to:frankfurt" });
  });

  it("dates outside the trip are refused in words, with the trip's range", async () => {
    stubServer({
      "GET /api/stops": [() => json(stopsPayload())],
      "PATCH /api/stops/colmar": [() => json({ error: "dates_outside_trip", trip: { start: "2026-12-02", end: "2026-12-07" } }, 400)],
    });
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Colmar" }));
    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2026-12-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Save stop" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The dates must be inside the trip (2026-12-02 – 2026-12-07).");
  });

  it("a stale revision asks for a reload, keeps the draft, and the retry carries the new revision", async () => {
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload()), () => json(stopsPayload({ revision: "st-9" }))],
      "PATCH /api/stops/colmar": [() => json({ error: "stops_changed_reload_before_retry", revision: "st-9" }, 409), () => json({ revision: "st-10", stop: colmar.stop })],
    });
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Colmar" }));
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Colmar!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save stop" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The stops changed since you opened this form");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload stops" }));
    await waitFor(() => expect(server.calls.filter((c) => c.url === "/api/stops" && c.method === "GET")).toHaveLength(2));
    expect(screen.getByLabelText("English title")).toHaveValue("Colmar!");
    fireEvent.click(screen.getByRole("button", { name: "Save stop" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].ifMatch).toBe('"st-9"');
  });
});

describe("split and revert", () => {
  it("splits a stop at a day strictly inside it, with the new stop's title", async () => {
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload())],
      "POST /api/stops/colmar/split": [() => json({ revision: "st-5", stops: [], moved: { items: ["a"], days: ["2026-12-06"] }, review: { status: "queued", detail: "re-read" } }, 201)],
    });
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Split Colmar" }));
    const at = screen.getByLabelText("Split on");
    expect(within(at).getAllByRole("option").map((o) => o.getAttribute("value")).filter(Boolean)).toEqual(["2026-12-03", "2026-12-04", "2026-12-05"]);
    fireEvent.change(at, { target: { value: "2026-12-05" } });
    fireEvent.change(screen.getByLabelText("New stop title (English)"), { target: { value: "Near the airport" } });
    fireEvent.click(screen.getByRole("button", { name: "Split the stop" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({
      url: "/api/stops/colmar/split",
      body: { at: "2026-12-05", new_stop: { title: { en: "Near the airport" } } },
      ifMatch: '"st-3"',
    });
    expect(await screen.findByText(/1 day moved to the new stop/)).toBeInTheDocument();
  });

  it("restores a version from the stop's history, or goes back to the trip file", async () => {
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload())],
      "GET /api/stops/colmar/history": [() => json({ phase_id: "colmar", revision: "st-3", history: [
        { id: 2, action: "from_booking", actor: "alice", note: "booking 1", created_at: "2026-10-09 09:00:00", before: null, after: { kind: "config", fields: { dates: { start: "2026-12-02", end: "2026-12-07" } } } },
        { id: 3, action: "update", actor: "alice", note: null, created_at: "2026-10-10 10:00:00", before: null, after: { kind: "config", fields: { dates: { start: "2026-12-02", end: "2026-12-06" } } } },
      ] })],
      "POST /api/stops/colmar/revert": [() => json({ revision: "st-4", stop: colmar.stop })],
    });
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "History of Colmar" }));
    const entry = (await screen.findByText(/2026-10-09 09:00:00/)).closest("li")!;
    expect(entry).toHaveTextContent("2026-12-02 – 2026-12-07");
    fireEvent.click(within(entry as HTMLElement).getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ url: "/api/stops/colmar/revert", body: { history_id: 2 }, ifMatch: '"st-3"' });
    fireEvent.click(screen.getByRole("button", { name: "Undo all changes to this stop" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].body).toEqual({});
  });

  it("shows a conflict the server reports, and resolves it either way", async () => {
    const conflicted = { ...colmar, conflict: { fields: ["dates"], base: { dates: { start: "2026-12-03", end: "2026-12-05" } } } };
    const server = stubServer({
      "GET /api/stops": [() => json(stopsPayload({ stops: [stopsPayload().stops[0], conflicted] }))],
      "PATCH /api/stops/colmar": [() => json({ revision: "st-4", stop: colmar.stop })],
      "POST /api/stops/colmar/revert": [() => json({ revision: "st-5", stop: colmar.stop })],
    });
    renderEditor();
    const row = await screen.findByRole("article", { name: "Colmar" });
    const warning = within(row).getByRole("alert");
    expect(warning).toHaveTextContent("The trip was rebuilt and changed the dates under your edit");
    expect(warning).toHaveTextContent("2026-12-03 – 2026-12-05");
    fireEvent.click(within(warning).getByRole("button", { name: "Keep my version" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0].body).toEqual({ dates: { start: "2026-12-02", end: "2026-12-06" } });
    fireEvent.click(within(warning).getByRole("button", { name: "Use the rebuilt version" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1]).toMatchObject({ url: "/api/stops/colmar/revert", body: {} });
  });
});

describe("moving a day to another stop (the plan editor)", () => {
  const config = { phases: [
    { id: "ny", title: "New York", dates: { start: "2027-03-10", end: "2027-03-12" } },
    { id: "colorado", title: "Colorado", dates: { start: "2027-03-12", end: "2027-03-15" } },
  ] };
  const itinerary = { revision: "r1", days: [{ phase_id: "ny", date: "2027-03-11", label_en: "Museums" }], items: [] };
  const stops = stopsPayload({ stops: [
    { id: "ny", kind: "config", unplanned: false, stop: { id: "ny", title: "New York" }, override: null, conflict: null, booking_out_of_sync: false },
    { id: "colorado", kind: "config", unplanned: false, stop: { id: "colorado", title: "Colorado" }, override: null, conflict: null, booking_out_of_sync: false },
  ] });

  it("moves the whole day with the itinerary revision, and asks which headline to keep when both have one", async () => {
    const server = stubServer({
      "GET /api/stops": [() => json(stops)],
      "GET /api/itinerary/original": [() => json({ revision: "r0", days: [], items: [] })],
      "POST /api/itinerary/move-day": [
        () => json({ error: "target_day_has_headline", source: { label_en: "Museums" }, target: { label_en: "Drive west" } }, 409),
        () => json({ revision: "r2", moved: { items: ["a"], headline: true }, review: { status: "queued", detail: "re-read" } }),
      ],
    });
    render(<QueryClientProvider client={client()}><PlanTools isOrganizer lang="en" config={config} itinerary={itinerary} /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Phase"), { target: { value: "ny" } });
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2027-03-11" } });
    const target = await screen.findByLabelText("Move this day to stop");
    await waitFor(() => expect(within(target).getAllByRole("option").map((o) => o.getAttribute("value")).filter(Boolean)).toEqual(["colorado"]));
    fireEvent.change(target, { target: { value: "colorado" } });
    fireEvent.click(screen.getByRole("button", { name: "Move day" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Drive west");
    expect(alert).toHaveTextContent("Museums");
    expect(server.writes()[0]).toMatchObject({ url: "/api/itinerary/move-day", body: { from_phase_id: "ny", to_phase_id: "colorado", date: "2027-03-11" }, ifMatch: "r1" });
    fireEvent.click(within(alert).getByRole("button", { name: "Use this day's headline" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].body).toEqual({ from_phase_id: "ny", to_phase_id: "colorado", date: "2027-03-11", headline: "take_source" });
    expect(await screen.findByText(/Day moved/)).toBeInTheDocument();
  });
});
