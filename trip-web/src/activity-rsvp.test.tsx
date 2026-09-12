import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { JourneyView } from "./App";
import { rsvpForItem, venueForItem } from "./activity-rsvp";
import { configSchema, type ItineraryItem } from "./api";
const item: ItineraryItem = { item_uid: "museum-1", phase_id: "ny", date: "2027-03-11", text_he: "מוזיאון", text_en: "Museum", item_type: "activity" };
const config = configSchema.parse({ phases: [{ id: "ny", rsvp_activities: [{ id: "museum-rsvp", item_uid: "museum-1", title: "Museum" }] }] });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("links only marked activities, retaining stable links when the plan changes", () => {
  expect(rsvpForItem({ ...item, text_en: "New name", date: "2027-03-12" }, config)?.id).toBe("museum-rsvp");
  expect(rsvpForItem({ ...item, item_uid: "other" }, config)).toBeUndefined();
  expect(rsvpForItem({ ...item, phase_id: "other" }, config)).toBeUndefined();
});
it("supports an exact legacy match but refuses ambiguous activities", () => {
  const legacy = configSchema.parse({ phases: [{ id: "ny", rsvp_activities: [{ id: "legacy", title: "Museum", date: item.date }] }] });
  expect(rsvpForItem(item, legacy)?.id).toBe("legacy");
  expect(rsvpForItem({ ...item, date: "2027-03-12" }, legacy)).toBeUndefined();
  expect(rsvpForItem(item, legacy, { revision: "r1", days: [], items: [item, { ...item, item_uid: "duplicate" }] })).toBeUndefined();
});
it("opens RSVP inside the marked Journey card and saves to its existing RSVP record", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><JourneyView config={config} itinerary={{ revision: "r1", days: [{ phase_id: "ny", date: item.date! }], items: [item, { ...item, item_uid: "other", text_en: "Lunch" }] }} lang="en" onHeroPhaseChange={vi.fn()} /></QueryClientProvider>);
  expect(screen.queryByRole("link", { name: /Activity RSVPs/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "RSVP" })).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
  const card = screen.getByRole("heading", { name: "Museum" }).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "RSVP" }));
  fireEvent.click(within(card).getByRole("button", { name: "Going" }));
  await waitFor(() => expect(fetch.mock.calls.some(call => (call as unknown as [string, RequestInit])[1]?.method === "POST")).toBe(true));
  const call = fetch.mock.calls.find(call => (call as unknown as [string, RequestInit])[1]?.method === "POST") as unknown as [string, RequestInit];
  expect(call[0]).toBe("/api/rsvps/museum-rsvp");
  expect(JSON.parse(String(call[1].body)).status).toBe("yes");
  client.clear();
});

it("offers venue ratings only for an unambiguous identified venue", () => {
  const linked = configSchema.parse({ phases: [{ id: "ny", venues: [{ id: "venue-1", item_uid: item.item_uid, name: "Renamed museum" }] }] });
  expect(venueForItem(item, linked)?.id).toBe("venue-1");
  expect(venueForItem({ ...item, item_uid: "other" }, linked)).toBeUndefined();
  const ambiguous = configSchema.parse({ phases: [{ id: "ny", venues: [{ id: "a", name: "Museum" }, { id: "b", name: "Museum" }] }] });
  expect(venueForItem(item, ambiguous)).toBeUndefined();
  expect(venueForItem(item, { phases: [{ id: "ny", venues: [{ name: "Museum" }] }] })).toBeUndefined();
});

it("saves an inline rating to the linked venue and shows the user's selection", async () => {
  let saved = false;
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/ratings" && init.method === "POST") saved = true;
    return new Response(JSON.stringify(url === "/api/ratings" ? (saved ? { "museum-venue": { alice: 5 } } : {}) : []), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><JourneyView config={{ phases: [{ id: "ny", venues: [{ id: "museum-venue", name: "Museum" }] }] }} itinerary={{ revision: "r1", days: [{ phase_id: "ny", date: item.date! }], items: [item] }} username="alice" lang="en" onHeroPhaseChange={vi.fn()} /></QueryClientProvider>);
  expect(fetch).not.toHaveBeenCalled();
  const card = screen.getByRole("heading", { name: "Museum" }).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Rate" }));
  fireEvent.click(within(card).getByRole("button", { name: "5 ★" }));
  await waitFor(() => expect(within(card).getByRole("button", { name: "5 ★" })).toHaveAttribute("aria-pressed", "true"));
  const call = fetch.mock.calls.find(([,init]) => init?.method === "POST")!;
  expect(JSON.parse(String(call[1]!.body))).toEqual({ venue: "museum-venue", rating: 5 });
  client.clear();
});
