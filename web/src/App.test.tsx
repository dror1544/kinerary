import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function renderRoute(route: string, authenticated = false) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/v1/me") return new Response(authenticated ? JSON.stringify({ id: "user_test", displayName: "Test Organizer" }) : JSON.stringify({ error: "AUTHENTICATION_REQUIRED" }), { status: authenticated ? 200 : 401, headers: { "content-type": "application/json" } });
    if (url === "/v1/trips") return new Response(JSON.stringify({ trips: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>,
  );
}

const TRIP_ID = "trip_abcdefgh";

// A trip whose plan is waiting on the organizer's own review — the state the
// retired operations queue used to own.
function renderTripAwaitingReview(planStatus = "pending_approval") {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/v1/me") return json({ id: "user_test", displayName: "Test Organizer" });
    if (url === `/v1/trips/${TRIP_ID}`) return json({
      id: TRIP_ID, title: "Rome 2026", destination: "Rome", startDate: null, endDate: null, tripType: "family",
      lifecycleState: "planned", nextAction: "review_plan",
      permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true },
      interview: { sessionId: "intk_1", state: "confirmed" },
      provisioning: { planId: "plan_xyz", planStatus, jobState: null, releaseId: "rel_7", digest: "sha256:abc123", safeErrorCode: null },
      runtimeReady: false, invites: [],
    });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`/trips/${TRIP_ID}`]}><App /></MemoryRouter></QueryClientProvider>,
  );
  return { ...view, calls };
}

describe("Kinerary SPA routes", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("renders the public landing route and its primary action", async () => {
    renderRoute("/");
    expect(await screen.findByRole("heading", { name: /keep your family trip moving/i })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /start a trip/i }).length).toBeGreaterThan(0);
  });

  it("updates the plans-changed scenario without leaving the route", async () => {
    renderRoute("/");
    const tab = await screen.findByRole("tab", { name: /dinner moves/i });
    fireEvent.click(tab);
    expect(screen.getByRole("heading", { name: /one update, everyone aligned/i })).toBeInTheDocument();
  });

  it("renders the trip-intent route directly", async () => {
    renderRoute("/trips/new", true);
    expect(await screen.findByRole("heading", { name: /start with the outline/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/destination/i)).toBeInTheDocument();
  });

  it("renders the sign-in route directly", async () => {
    renderRoute("/sign-in");
    expect(await screen.findByRole("heading", { name: /sign in to continue/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("renders the authenticated trip dashboard", async () => {
    renderRoute("/trips", true);
    expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /your first trip starts here/i })).toBeInTheDocument();
  });
  it("shows no operations link — provisioning is the organizer's own decision", async () => {
    renderRoute("/trips", true);
    expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /operations/i })).not.toBeInTheDocument();
  });

  it("lets the organizer review and approve their own plan", async () => {
    const { calls } = renderTripAwaitingReview();
    expect(await screen.findByRole("heading", { name: /review and approve the plan/i })).toBeInTheDocument();
    // The exact plan being released is on screen, not just its status.
    expect(screen.getByText("sha256:abc123")).toBeInTheDocument();
    expect(screen.getByText("rel_7")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /approve and provision/i }));
    await vi.waitFor(() => expect(calls).toContain(`POST /v1/trips/${TRIP_ID}/plans/plan_xyz/approve`));
    // No operations endpoint is involved anywhere in the flow.
    expect(calls.some((call) => call.includes("/v1/ops/"))).toBe(false);
  });

  it("lets the organizer reject the plan they are reviewing", async () => {
    const { calls } = renderTripAwaitingReview();
    fireEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    await vi.waitFor(() => expect(calls).toContain(`POST /v1/trips/${TRIP_ID}/plans/plan_xyz/reject`));
  });

  it("offers no decision once the plan is already approved", async () => {
    renderTripAwaitingReview("approved");
    expect(await screen.findByRole("heading", { name: /review and approve the plan/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve and provision/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
  });
});
