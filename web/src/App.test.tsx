import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function renderRoute(route: string, authenticated = false) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/v1/me") return new Response(authenticated ? JSON.stringify({ id: "user_test", displayName: "Test Organizer", isProvisioningAdmin: false }) : JSON.stringify({ error: "AUTHENTICATION_REQUIRED" }), { status: authenticated ? 200 : 401, headers: { "content-type": "application/json" } });
    if (url === "/v1/trips") return new Response(JSON.stringify({ trips: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>,
  );
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
});
