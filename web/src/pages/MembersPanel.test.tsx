import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const trip = {
  id: "trip_abcdefgh", title: "Rome", destination: "Italy", startDate: null, endDate: null, tripType: "family", lifecycleState: "draft",
  nextAction: "continue_interview", interview: null, provisioning: null, runtimeReady: false, invites: [],
  permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true },
  members: [
    { id: "memb_me", displayName: "Olive Organizer", role: "owner", runtimeUsername: null, you: true, removable: false },
    { id: "memb_guest", displayName: "Guest Gal", role: "member", runtimeUsername: "gal", you: false, removable: true },
  ],
};
afterEach(() => vi.unstubAllGlobals());

it("lists the people on the trip and removes a member only after a confirmation", async () => {
  const calls: string[] = [];
  let current = trip;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (init?.method === "DELETE" && path === "/v1/trips/trip_abcdefgh/members/memb_guest") {
      current = { ...trip, members: trip.members.filter((m) => m.id !== "memb_guest") };
      return json({ status: "removed" });
    }
    if (path === "/v1/trips/trip_abcdefgh") return json(current);
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips/trip_abcdefgh/setup"]}><App /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "People on this trip" })).toBeInTheDocument();
  expect(screen.getByText("Olive Organizer (you)")).toBeInTheDocument();
  // You cannot remove yourself: exactly one Remove button, for the guest.
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await vi.waitFor(() => expect(screen.queryByText("Guest Gal")).toBeNull());
  expect(calls).toContain("DELETE /v1/trips/trip_abcdefgh/members/memb_guest");
});

it("a member's trip list, a summary without organizer fields, still renders and offers no setup link", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = String(input);
    if (path === "/v1/me") return json({ id: "user_member", displayName: "Member" });
    if (path === "/v1/trips") return json({ trips: [{
      id: "trip_abcdefgh", title: "Rome", destination: "Italy", startDate: null, endDate: null, runtimeReady: false,
      permissions: { role: "member", dashboard: false, runtime: true, invite: false, requestProvisioning: false },
    }] });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips"]}><App /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Rome" })).toBeInTheDocument();
  expect(screen.getByText("Not ready to open yet")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /view status/i })).toBeNull();
});
