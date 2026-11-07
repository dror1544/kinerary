import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const link = "https://t.me/kinerary_bot?start=so_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const base = {
  id: "trip_abcdefgh", title: "Rome", destination: "Italy", startDate: null, endDate: null, tripType: "family", lifecycleState: "draft",
  nextAction: "continue_interview", interview: null, provisioning: null, runtimeReady: false, invites: [], members: [],
  permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true },
};
const noa = { id: "tso_aaaaaaaaaaaaaaaa", name: "Noa", username: "noa_s", joinedAt: "2026-11-07T10:00:00.000Z" };
afterEach(() => vi.unstubAllGlobals());

function mount(options: { trip?: Record<string, unknown>; me?: Record<string, unknown>; onCall?: (call: string, init?: RequestInit) => Response | undefined } = {}) {
  const calls: string[] = [];
  let current = { ...base, secondaryOrganizers: [noa], ...(options.trip ?? {}) };
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); const call = `${init?.method || "GET"} ${path}`; calls.push(call);
    const custom = options.onCall?.(call, init);
    if (custom) return custom;
    if (path === "/v1/me") return json({ id: "user_owner", displayName: "Olive", ...(options.me ?? {}) });
    if (call === "POST /v1/trips/trip_abcdefgh/secondary-organizer-link") return json({ deepLink: link, expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201);
    if (call === `DELETE /v1/trips/trip_abcdefgh/secondary-organizers/${noa.id}`) { current = { ...current, secondaryOrganizers: [] }; return json({ status: "removed" }); }
    if (path === "/v1/trips/trip_abcdefgh") return json(current);
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips/trip_abcdefgh/setup"]}><App /></MemoryRouter></QueryClientProvider>);
  return calls;
}

it("lists the secondary organizers by the name Telegram gave, and removes one only after a confirmation", async () => {
  const calls = mount();
  expect(await screen.findByRole("heading", { name: "Other organizers" })).toBeInTheDocument();
  expect(screen.getByText("Noa")).toBeInTheDocument();
  expect(screen.getByText("@noa_s")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove organizer" }));
  expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await vi.waitFor(() => expect(screen.queryByText("Noa")).toBeNull());
  expect(calls).toContain(`DELETE /v1/trips/trip_abcdefgh/secondary-organizers/${noa.id}`);
  expect(screen.getByText("No other organizers yet.")).toBeInTheDocument();
});

it("creates a trip link only when asked, and says that whoever opens it becomes an organizer", async () => {
  const calls = mount({ trip: { secondaryOrganizers: [] } });
  fireEvent.click(await screen.findByRole("button", { name: "Add an organizer" }));
  const open = await screen.findByRole("link", { name: "Open in Telegram" });
  expect(open).toHaveAttribute("href", link);
  expect(screen.getByLabelText("Organizer link")).toHaveValue(link);
  expect(screen.getByText(/Whoever opens it in Telegram becomes an organizer of this trip/)).toBeInTheDocument();
  expect(calls.filter((c) => c.includes("secondary-organizer-link"))).toEqual(["POST /v1/trips/trip_abcdefgh/secondary-organizer-link"]);
});

it("is not offered to a co-organizer, a member or anyone but the trip's owner", async () => {
  const calls = mount({ trip: { permissions: { role: "organizer", dashboard: true, runtime: true, invite: true, requestProvisioning: false }, secondaryOrganizers: undefined } });
  expect(await screen.findByRole("heading", { name: "Rome" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Other organizers" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add an organizer" })).toBeNull();
  expect(calls.some((c) => c.includes("secondary-organizer"))).toBe(false);
});

it("a Telegram-minted session is told to sign in with its password, and no link is offered", async () => {
  const calls = mount({ me: { scope: "telegram" } });
  expect(await screen.findByText(/to add or remove an organizer, sign in with your password/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add an organizer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove organizer" })).toBeNull();
  expect(calls.some((c) => c.includes("secondary-organizer"))).toBe(false);
});

it("the server's refusal is shown, not swallowed", async () => {
  mount({ trip: { secondaryOrganizers: [] }, onCall: (call) => call === "POST /v1/trips/trip_abcdefgh/secondary-organizer-link" ? json({ error: "NOT_FOUND" }, 404) : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Add an organizer" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open in Telegram" })).toBeNull();
});
