import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

// WhatsApp S2 (docs/specs/sprint-9/625-whatsapp-via-relay.md): the dashboard section. The number below is a test value.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const NUMBER = "15550100123";
const meLink = `https://wa.me/${NUMBER}?text=My%20Kinerary%20code%3A%20KWA-ABCD2345`;
const groupLink = "https://wa.me/?text=Connect%20this%20group%20to%20Kinerary%3A%20KWA-WXYZ2345";
const base = {
  id: "trip_abcdefgh", title: "Alsace", destination: "France", startDate: null, endDate: null, tripType: "family", lifecycleState: "ready_private",
  nextAction: "view_status", interview: null, provisioning: null, runtimeReady: false, invites: [], members: [],
  permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true },
};
const connections = [
  { bindingId: "tcb_aaaaaaaaaaaaaaaa", kind: "group", name: "Family <b>chat</b>", via: "group_code", connectedAt: "2026-11-20T10:00:00.000Z" },
  { bindingId: "tcb_bbbbbbbbbbbbbbbb", kind: "person", name: "Noa", via: "dashboard_code", connectedAt: "2026-11-21T10:00:00.000Z", lastFour: "4567" },
];
afterEach(() => vi.unstubAllGlobals());

function mount(options: { trip?: Record<string, unknown>; me?: Record<string, unknown>; list?: unknown[] } = {}) {
  const calls: { call: string; body?: string }[] = [];
  let list = options.list ?? connections;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); const call = `${init?.method || "GET"} ${path}`; calls.push({ call, body: init?.body as string | undefined });
    if (path === "/v1/me") return json({ id: "user_owner", displayName: "Dana", ...(options.me ?? {}) });
    if (call === "POST /v1/trips/trip_abcdefgh/whatsapp-codes") {
      const kind = JSON.parse(String(init?.body)).kind;
      return json({ link: kind === "me" ? meLink : groupLink, expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201);
    }
    if (call === "GET /v1/trips/trip_abcdefgh/whatsapp-connections") return json({ connections: list });
    if (call.startsWith("DELETE /v1/trips/trip_abcdefgh/whatsapp-connections/")) { list = list.filter((c) => !call.endsWith(String((c as { bindingId: string }).bindingId))); return json({ status: "removed" }); }
    if (path === "/v1/trips/trip_abcdefgh") return json({ ...base, ...(options.trip ?? {}) });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips/trip_abcdefgh/setup"]}><App /></MemoryRouter></QueryClientProvider>);
  return calls;
}

it("shows no WhatsApp section at all when the server sent none (switch off, or no number)", async () => {
  const calls = mount();
  expect(await screen.findByRole("heading", { name: "Alsace" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "WhatsApp" })).toBeNull();
  expect(document.body.textContent?.toLowerCase()).not.toContain("whatsapp");
  expect(calls.some((c) => c.call.includes("whatsapp"))).toBe(false);
});

const codePosts = (calls: { call: string; body?: string }[]) =>
  calls.filter((c) => c.call === "POST /v1/trips/trip_abcdefgh/whatsapp-codes").map((c) => JSON.parse(c.body!).kind);

it("has the code ready when the page is shown, so the person's one click opens WhatsApp - and never shows the code as text", async () => {
  const calls = mount({ trip: { whatsapp: { number: NUMBER, owner: true } } });
  const open = await screen.findByRole("link", { name: "Link WhatsApp" });
  expect(open).toHaveAttribute("href", meLink);
  expect(open).toHaveAttribute("target", "_blank");
  expect(open).toHaveAttribute("rel", "noopener noreferrer");
  expect(document.body.textContent).not.toMatch(/KWA-/);
  // Only the person's own code: the group code is live for whoever sends it, so it waits until it is asked for.
  expect(codePosts(calls)).toEqual(["me"]);
});

it("an owner is told which number to add to the group; the group code is made when the owner asks for that fallback, not before", async () => {
  const calls = mount({ trip: { whatsapp: { number: NUMBER, owner: true } } });
  expect(await screen.findByText(`+${NUMBER}`)).toBeInTheDocument();
  await screen.findByRole("link", { name: "Link WhatsApp" });
  expect(codePosts(calls)).toEqual(["me"]);
  fireEvent.click(screen.getByRole("button", { name: "use a group code" }));
  expect(await screen.findByRole("link", { name: "Choose the group in WhatsApp" })).toHaveAttribute("href", groupLink);
  expect(codePosts(calls)).toEqual(["me", "group"]);
  expect(document.body.textContent).not.toMatch(/KWA-/);
});

it("lists connected groups by title and people by name with the last four digits only, and removes one after a confirmation", async () => {
  const calls = mount({ trip: { whatsapp: { number: NUMBER, owner: true } } });
  expect(await screen.findByText("Family <b>chat</b>")).toBeInTheDocument();   // text, never markup
  expect(document.querySelector("b")).toBeNull();
  expect(screen.getByText("Noa")).toBeInTheDocument();
  expect(screen.getByText(/number ending 4567/)).toBeInTheDocument();
  expect(screen.getByText("2 WhatsApp chats are linked to this trip.")).toBeInTheDocument();
  // no number is shown but the deployment's own: every run of seven or more digits on the page is that one
  const longRuns = [...(document.querySelector("#whatsapp")?.textContent ?? "").matchAll(/\d{7,}/g)].map((m) => m[0]);
  expect(longRuns.every((run) => run === NUMBER)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Remove WhatsApp · linked Nov 21, 2026/ }));
  expect(calls.some((c) => c.call.startsWith("DELETE"))).toBe(false);
  expect(screen.getByRole("group", { name: "Confirm remove" })).toHaveTextContent("Nothing is sent to it");
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await vi.waitFor(() => expect(screen.queryByText("Noa")).toBeNull());
  expect(calls.map((c) => c.call)).toContain("DELETE /v1/trips/trip_abcdefgh/whatsapp-connections/tcb_bbbbbbbbbbbbbbbb");
  expect(screen.getByText("Family <b>chat</b>")).toBeInTheDocument();
});

it("a co-organizer gets Link WhatsApp but not the group steps or the list, asks for no connections, and is not told 'not linked'", async () => {
  const calls = mount({ trip: { whatsapp: { number: NUMBER, owner: false }, permissions: { role: "organizer", dashboard: true, runtime: true, invite: true, requestProvisioning: false } } });
  expect(await screen.findByRole("link", { name: "Link WhatsApp" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "use a group code" })).toBeNull();
  expect(screen.queryByText(/WhatsApp chat.* linked to this trip/)).toBeNull();
  expect(calls.some((c) => c.call.includes("whatsapp-connections"))).toBe(false);
  expect(codePosts(calls)).toEqual(["me"]);
});

it("a Telegram-minted session is told to sign in with its password and is offered nothing", async () => {
  const calls = mount({ trip: { whatsapp: { number: NUMBER, owner: true } }, me: { scope: "telegram" } });
  expect(await screen.findByText(/Signed in with Telegram: to connect WhatsApp, sign in with your password/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull();
  expect(calls.some((c) => c.call.includes("whatsapp-codes") || c.call.includes("whatsapp-connections"))).toBe(false);
});

it("refuses a link that is not a wa.me link, instead of opening whatever the server sent", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = String(input);
    if (path === "/v1/me") return json({ id: "u", displayName: "Dana" });
    if (path.endsWith("/whatsapp-codes")) return json({ link: "https://evil.example/?text=x", expiresAt: new Date().toISOString() }, 201);
    if (path.endsWith("/whatsapp-connections")) return json({ connections: [] });
    if (path === "/v1/trips/trip_abcdefgh") return json({ ...base, whatsapp: { number: NUMBER, owner: true } });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips/trip_abcdefgh/setup"]}><App /></MemoryRouter></QueryClientProvider>);
  await vi.waitFor(() => expect(within(document.querySelector("#whatsapp") as HTMLElement).getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull();
  expect(document.querySelector("a[href*='evil']")).toBeNull();
});

