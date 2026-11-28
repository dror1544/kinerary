import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { formatDay } from "./dates";

// Telegram groups from the dashboard (#690, docs/specs/sprint-9/690-dashboard-chat-parity.md): AC-14 to AC-16.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const TRIP = "trip_abcdefgh";
const groupLink = "https://t.me/kinerary_bot?startgroup=KWA-ABCD2345&admin=change_info+pin_messages+invite_users";
const base = {
  id: TRIP, title: "Alsace", destination: "France", startDate: null, endDate: null, tripType: "family", lifecycleState: "ready_private",
  nextAction: "view_status", interview: null, provisioning: null, runtimeReady: false, invites: [], members: [],
  permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true },
};
const telegramLink = { id: "otl_0123456789abcdef", via: "interview_link", linkedAt: "2026-10-03T10:00:00.000Z", firstSignedInAt: null, lastSignedInAt: null };
const groups = [
  { bindingId: "tcb_aaaaaaaaaaaaaaaa", name: "Family <b>chat</b>", connectedAt: "2026-11-20T10:00:00.000Z" },
  { bindingId: "tcb_bbbbbbbbbbbbbbbb", name: null, connectedAt: "2026-11-21T10:00:00.000Z" },
];
afterEach(() => vi.unstubAllGlobals());

type Options = { trip?: Record<string, unknown>; telegram?: Record<string, unknown>; me?: Record<string, unknown>; list?: unknown[]; at?: "page" | "trips" };
function mount(options: Options = {}) {
  const calls: { call: string; body?: string }[] = [];
  let list = options.list ?? groups;
  const trip = { ...base, telegram: { links: [telegramLink], groups: { owner: true }, ...(options.telegram ?? {}) }, ...(options.trip ?? {}) };
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); const call = `${init?.method || "GET"} ${path}`; calls.push({ call, body: init?.body as string | undefined });
    if (path === "/v1/me") return json({ id: "user_owner", displayName: "Dana", ...(options.me ?? {}) });
    if (call === `POST /v1/trips/${TRIP}/telegram-group-link`) return json({ link: groupLink, expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201);
    if (call === `POST /v1/trips/${TRIP}/telegram-link`) return json({ deepLink: "https://t.me/kinerary_bot?start=lk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201);
    if (call === `GET /v1/trips/${TRIP}/telegram-groups`) return json({ groups: list });
    if (call.startsWith(`DELETE /v1/trips/${TRIP}/telegram-groups/`)) { list = list.filter((g) => !call.endsWith(String((g as { bindingId: string }).bindingId))); return json({ status: "removed" }); }
    if (path === `/v1/trips/${TRIP}`) return json(trip);
    if (path === "/v1/trips") return json({ trips: [trip] });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={[options.at === "trips" ? "/trips" : `/trips/${TRIP}/setup`]}><App /></MemoryRouter></QueryClientProvider>);
  return calls;
}
const groupLinkPosts = (calls: { call: string }[]) => calls.filter((c) => c.call === `POST /v1/trips/${TRIP}/telegram-group-link`).length;
const nothingAskedFor = (calls: { call: string }[]) => calls.some((c) => c.call.includes("telegram-group"));

it("the trip page offers the owner ONE link to add the companion to a group, with the code already in it and never shown as text", async () => {
  const calls = mount();
  const open = await screen.findByRole("link", { name: "Add to a Telegram group" });
  expect(open).toHaveAttribute("href", groupLink);
  expect(open).toHaveAttribute("target", "_blank");
  expect(open).toHaveAttribute("rel", "noopener noreferrer");
  expect(document.body.textContent).not.toMatch(/KWA-/);
  expect(screen.getAllByText(/Works once, until/).length).toBeGreaterThan(0);
  expect(groupLinkPosts(calls)).toBe(1);
});

it("lists the linked groups by name and day, as plain text, and Unlink asks first, then sends one DELETE and the group goes", async () => {
  const calls = mount();
  const entry = await screen.findByRole("button", { name: new RegExp(`Unlink Telegram group · linked ${formatDay("2026-11-20T10:00:00.000Z")}`) });
  // The name is text somebody typed: shown, never turned into markup.
  expect(entry).toHaveTextContent("Family <b>chat</b>");
  expect(entry.querySelector("b")).toBeNull();
  expect(screen.getByText(/unnamed group/)).toBeInTheDocument();
  fireEvent.click(entry);
  expect(calls.some((c) => c.call.startsWith("DELETE"))).toBe(false);
  // It says what Unlink does and does not do before it does it.
  const confirm = screen.getByRole("group", { name: "Confirm unlink" });
  expect(confirm).toHaveTextContent("The companion leaves the group quietly and posts nothing there");
  expect(confirm).not.toHaveTextContent("remove it in Telegram");
  expect(document.body.textContent).not.toMatch(/remove the companion from the group/i);
  fireEvent.click(within(confirm).getByRole("button", { name: "Confirm unlink" }));
  await vi.waitFor(() => expect(screen.queryByText(/Family <b>chat<\/b>/)).toBeNull());
  expect(calls.filter((c) => c.call.startsWith("DELETE")).map((c) => c.call)).toEqual([`DELETE /v1/trips/${TRIP}/telegram-groups/tcb_aaaaaaaaaaaaaaaa`]);
  expect(screen.getByText(/unnamed group/)).toBeInTheDocument();
});

it("Keep sends nothing", async () => {
  const calls = mount();
  fireEvent.click(await screen.findByRole("button", { name: /Unlink Telegram group · linked Nov 20/ }));
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(calls.some((c) => c.call.startsWith("DELETE"))).toBe(false);
  expect(screen.getByRole("button", { name: /Unlink Telegram group · linked Nov 20/ })).toBeInTheDocument();
});

it("an owner with no Telegram linked is told to link it first, and no group link is minted", async () => {
  const calls = mount({ telegram: { links: [] }, list: [] });
  expect(await screen.findByText(/Link Telegram first/)).toBeInTheDocument();
  await screen.findByRole("link", { name: "Link Telegram" });
  expect(screen.queryByRole("link", { name: "Add to a Telegram group" })).toBeNull();
  expect(groupLinkPosts(calls)).toBe(0);
});

it("a co-organizer sees no group section and asks for nothing about groups; nor does a Telegram-minted session", async () => {
  const co = mount({ trip: { permissions: { role: "organizer", dashboard: true, runtime: true, invite: true, requestProvisioning: true } }, telegram: { groups: { owner: false } } });
  await screen.findByRole("heading", { name: "Telegram" });
  await screen.findByRole("link", { name: "Link Telegram" });
  expect(screen.queryByRole("link", { name: "Add to a Telegram group" })).toBeNull();
  expect(screen.queryByText(/Add the companion to a group/)).toBeNull();
  expect(nothingAskedFor(co)).toBe(false);
});

it("a Telegram-minted session is offered no group action and asks for none", async () => {
  const calls = mount({ me: { scope: "telegram" }, telegram: { links: [telegramLink], groups: undefined } });
  await screen.findByRole("heading", { name: "Telegram" });
  expect(screen.queryByRole("link", { name: "Add to a Telegram group" })).toBeNull();
  expect(nothingAskedFor(calls)).toBe(false);
});

it("in the trip card's menu the same two actions are there, and nothing about groups is asked for until the menu opens", async () => {
  const calls = mount({ at: "trips" });
  const menuButton = await screen.findByRole("button", { name: "Telegram options for Alsace" });
  expect(nothingAskedFor(calls)).toBe(false);
  fireEvent.click(menuButton);
  const open = await screen.findByRole("menuitem", { name: "Add to a Telegram group" });
  expect(open.tagName).toBe("A");
  expect(open).toHaveAttribute("href", groupLink);
  expect(await screen.findByRole("menuitem", { name: /Unlink Telegram group · linked Nov 20/ })).toBeInTheDocument();
  expect(groupLinkPosts(calls)).toBe(1);
});

it("refuses a group link that is not a t.me startgroup link, instead of opening whatever the server sent", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/v1/me") return json({ id: "user_owner", displayName: "Dana" });
    if (path === `/v1/trips/${TRIP}/telegram-group-link`) return json({ link: "https://evil.example/?startgroup=KWA-ABCD2345", expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201);
    if (path === `/v1/trips/${TRIP}/telegram-link`) return json({ deepLink: "https://t.me/kinerary_bot?start=lk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201);
    if (path === `/v1/trips/${TRIP}/telegram-groups`) return json({ groups: [] });
    if (path === `/v1/trips/${TRIP}`) return json({ ...base, telegram: { links: [telegramLink], groups: { owner: true } } });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[`/trips/${TRIP}/setup`]}><App /></MemoryRouter></QueryClientProvider>);
  await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Add to a Telegram group" }).length).toBeGreaterThan(0));
  expect(screen.queryByRole("link", { name: "Add to a Telegram group" })).toBeNull();
});
