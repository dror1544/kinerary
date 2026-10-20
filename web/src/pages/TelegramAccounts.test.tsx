import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const link = { id: "tol_0123456789abcdef", scope: "account", via: "interview_link", tripTitle: null, linkedAt: "2026-10-03T10:00:00.000Z", lastSignedInAt: "2026-10-04T10:00:00.000Z" };
const tripLink = { id: "tml_0123456789abcdef", scope: "trip", via: "trip_password", tripTitle: "Rome", linkedAt: "2026-10-05T10:00:00.000Z", lastSignedInAt: null };

function mount(links: unknown[], enabled = true) {
  const calls: string[] = [];
  let current = links;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (path === "/v1/trips") return json({ trips: [] });
    if (path === "/v1/account/telegram-links") return json({ miniAppEnabled: enabled, links: current });
    if (init?.method === "DELETE") { current = current.filter((l) => `/v1/account/telegram-links/${(l as { id: string }).id}` !== path); return json({ status: "unlinked" }); }
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips"]}><App /></MemoryRouter></QueryClientProvider>);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

it("lists every Telegram account that can sign in as you — when, how, which trip — and never an id", async () => {
  mount([link, tripLink]);
  expect(await screen.findByRole("heading", { name: "Telegram accounts that can sign in as you" })).toBeInTheDocument();
  expect(screen.getByText("Opens all of your trips")).toBeInTheDocument();
  expect(screen.getByText("Opens Rome only")).toBeInTheDocument();
  expect(screen.getByText(/by redeeming your interview link in Telegram/)).toBeInTheDocument();
  expect(screen.getByText(/with the trip password inside the Mini App/)).toBeInTheDocument();
  expect(screen.getByText(/Has not signed in with it yet/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/sha256|tol_|tml_/);
});

it("unlinking takes a confirmation and then refreshes the list", async () => {
  const calls = mount([link]);
  fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
  expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm unlink" }));
  expect(await screen.findByText("No Telegram account can sign in as you.")).toBeInTheDocument();
  expect(calls).toContain(`DELETE /v1/account/telegram-links/${link.id}`);
});

it("says nothing when nothing is linked and the feature is off", async () => {
  mount([], false);
  await screen.findByRole("heading", { name: "My trips" });
  expect(screen.queryByRole("heading", { name: "Telegram accounts that can sign in as you" })).toBeNull();
});
