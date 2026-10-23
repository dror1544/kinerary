import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

// Round-3 staging test, 2026-10-23: the My trips list gave no way to the trip's own page (progress, Telegram
// status); the owner only got there through the trip site's "Organizer dashboard" entry. The card is the way in.

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function Probe() { return <output data-testid="route">{useLocation().pathname}</output>; }
const organizer = { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true };
const member = { role: "member", dashboard: false, runtime: true, invite: false, requestProvisioning: false };
const base = {
  destination: "Somewhere", startDate: null, endDate: null, tripType: "family", lifecycleState: "ready_private",
  nextAction: "open_trip", interview: null, provisioning: null, runtimeReady: true, invites: [],
};
const trips = [
  { ...base, id: "trip_romerome", title: "Rome 2027", permissions: organizer },
  { ...base, id: "trip_oslooslo", title: "Oslo 2027", permissions: member },
];

function mount(route: string, me: Record<string, unknown> = { id: "user_1", displayName: "Olive" }) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = String(input);
    if (path === "/v1/me") return json(me);
    if (path === "/v1/trips") return json({ trips });
    // The destination pages mount too once navigated to; a 404 keeps them inert.
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /><Probe /></MemoryRouter></QueryClientProvider>);
}
const card = async (title: string) => (await screen.findByRole("heading", { name: title })).closest("article")!;
const route = () => screen.getByTestId("route").textContent;
afterEach(() => vi.unstubAllGlobals());

it("clicking an organizer's trip card opens that trip's page", async () => {
  mount("/trips");
  const rome = await card("Rome 2027");
  expect(route()).toBe("/trips");
  fireEvent.click(within(rome).getByText("Somewhere"));
  expect(route()).toBe("/trips/trip_romerome/setup");
});

it("the card is a real link for the keyboard: the title links to the trip's page", async () => {
  mount("/trips");
  const rome = within(await card("Rome 2027"));
  expect(rome.getByRole("link", { name: "Rome 2027" })).toHaveAttribute("href", "/trips/trip_romerome/setup");
});

it("Open trip stays its own action: it goes to the trip, not also to the card's page", async () => {
  mount("/trips");
  const rome = within(await card("Rome 2027"));
  const open = rome.getByRole("link", { name: "Open trip" });
  expect(open).toHaveAttribute("href", "/trips/trip_romerome/app");
  fireEvent.click(open);
  expect(route()).toBe("/trips/trip_romerome/app");
});

it("the Telegram menu on the card does not navigate away", async () => {
  mount("/trips");
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  fireEvent.click(rome.getByText("No Telegram account is linked to this trip."));
  expect(route()).toBe("/trips");
});

it("a member without a dashboard has no trip page to go to: the card is not a link and a click goes nowhere", async () => {
  mount("/trips");
  const oslo = await card("Oslo 2027");
  expect(within(oslo).queryByRole("link", { name: "Oslo 2027" })).toBeNull();
  fireEvent.click(within(oslo).getByText("Somewhere"));
  expect(route()).toBe("/trips");
});

it("in the Mini App's list (a Telegram-scoped session) the card opens the trip page too", async () => {
  mount("/mini-app", { id: "user_1", displayName: "Olive", scope: "telegram" });
  const rome = await card("Rome 2027");
  fireEvent.click(within(rome).getByText("Somewhere"));
  expect(route()).toBe("/trips/trip_romerome/setup");
});
