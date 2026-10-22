import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function Probe() { return <output data-testid="route">{useLocation().pathname}</output>; }
const trip = {
  id: "trip_romerome", title: "Rome 2027", destination: "Italy", startDate: null, endDate: null, tripType: "family", lifecycleState: "ready_private",
  nextAction: "open_trip", interview: null, provisioning: null, runtimeReady: true, invites: [],
  permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true },
};
function mount(route: string, me: Record<string, unknown>, handler: (path: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    calls.push({ method: init?.method || "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return handler(path, init)
      ?? (path === "/v1/me" ? json(me)
        : path === "/v1/trips" ? json({ trips: [trip] })
        : path === "/v1/auth/capabilities" ? json({ emailPassword: true, google: false })
        : json({ error: "NOT_FOUND" }, 404));
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /><Probe /></MemoryRouter></QueryClientProvider>);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

it("a Telegram-scoped session says so, shows only what the server returned, and offers no new-trip button", async () => {
  mount("/trips", { id: "user_1", displayName: "Olive", scope: "telegram" });
  expect(await screen.findByText(/signed in with Telegram, so you see only the trips linked to this Telegram account/)).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Rome 2027" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Plan a new trip" })).toBeNull();
  const upgrade = screen.getByRole("link", { name: "Sign in with password for the full dashboard" });
  expect(upgrade).toHaveAttribute("href", "/sign-in?return_to=%2Ftrips");
});

it("a full session sees no banner and keeps the new-trip button", async () => {
  mount("/trips", { id: "user_1", displayName: "Olive", scope: "full" });
  expect(await screen.findByRole("link", { name: "Plan a new trip" })).toBeInTheDocument();
  expect(screen.queryByText(/signed in with Telegram/)).toBeNull();
  // An older server that does not say is a full session.
  mount("/trips", { id: "user_1", displayName: "Olive" });
  expect((await screen.findAllByRole("link", { name: "Plan a new trip" })).length).toBeGreaterThan(0);
});

it("a scoped session with no linked trip says so instead of inviting a new trip", async () => {
  mount("/trips", { id: "user_1", displayName: "Olive", scope: "telegram" }, (path) => path === "/v1/trips" ? json({ trips: [] }) : undefined);
  expect(await screen.findByRole("heading", { name: "No trips yet." })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Create a trip" })).toBeNull();
});

it("the sign-in page does not bounce a scoped session away: it is how the person upgrades to the full dashboard", async () => {
  const calls = mount("/sign-in?return_to=%2Ftrips", { id: "user_1", displayName: "Olive", scope: "telegram" }, (path, init) => {
    if (path === "/v1/auth/email-password") return json({ appPath: "/trips" });
    return undefined;
  });
  expect(await screen.findByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
  expect(screen.getByTestId("route")).toHaveTextContent("/sign-in");
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "olive@example.test" } });
  fireEvent.change(screen.getByLabelText("Account password"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/email-password")).toBe(true));
});

it("a server refusal of an account-level action is shown in the server's words", async () => {
  mount("/trips/new", { id: "user_1", displayName: "Olive", scope: "telegram" }, (path, init) =>
    path === "/v1/trips" && init?.method === "POST"
      ? json({ error: "ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in with your password to do this." }, 403) : undefined);
  fireEvent.change(await screen.findByLabelText(/Destination/i), { target: { value: "Lisbon" } });
  fireEvent.click(screen.getByRole("button", { name: /Create|Continue|Save/i }));
  expect(await screen.findByText("Sign in with your password to do this.")).toBeInTheDocument();
});

it("a scoped session is not offered Link on a trip card (the server would refuse it), and is told how to", async () => {
  const link = { id: "otl_0123456789abcdef", via: "interview_link", linkedAt: "2026-10-03T10:00:00.000Z", firstSignedInAt: null, lastSignedInAt: null };
  const calls = mount("/trips", { id: "user_1", displayName: "Olive", scope: "telegram" }, (path) =>
    path === "/v1/trips" ? json({ trips: [{ ...trip, telegram: { links: [link] } }] }) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(await screen.findByText(/to link another Telegram account, sign in with your password/)).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /Link Telegram|Link another Telegram/ })).toBeNull();
  expect(screen.getByRole("menuitem", { name: /Unlink Telegram/ })).toBeInTheDocument();
  expect(calls.some((c) => c.path.endsWith("/telegram-link"))).toBe(false);
});

it("a full session still gets Link", async () => {
  mount("/trips", { id: "user_1", displayName: "Olive", scope: "full" });
  fireEvent.click(await screen.findByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(await screen.findByRole("menuitem", { name: "Link Telegram" })).toBeInTheDocument();
});
