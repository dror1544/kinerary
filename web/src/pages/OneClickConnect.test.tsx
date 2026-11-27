import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

// #690: one click to the chat, and Telegram and WhatsApp treated the same wherever a chat is linked.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const NUMBER = "15550100123";
const owner = { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true };
const trip = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, destination: "Somewhere", startDate: null, endDate: null, tripType: "family", lifecycleState: "ready_private", nextAction: "view_status",
  interview: null, provisioning: null, runtimeReady: false, invites: [], members: [], permissions: owner,
  telegram: { links: [] }, whatsapp: { number: NUMBER, owner: true }, ...extra,
});

type Mints = { telegram: string[]; whatsapp: string[] };
/** A server that numbers every code it makes, with a clock of its own for how long they last. */
function server(options: { ttlMs?: number; trips?: unknown[]; me?: Record<string, unknown>; tellTelegram?: () => Response | undefined } = {}) {
  const mints: Mints = { telegram: [], whatsapp: [] };
  const ttl = options.ttlMs ?? 900_000;
  const trips = options.trips ?? [trip("trip_romerome", "Rome 2027"), trip("trip_oslooslo", "Oslo 2027"), trip("trip_parisparis", "Paris 2027")];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); const method = init?.method || "GET";
    if (path === "/v1/me") return json({ id: "user_1", displayName: "Dana", ...(options.me ?? {}) });
    if (path === "/v1/trips") return json({ trips });
    const detail = (trips as { id: string }[]).find((t) => path === `/v1/trips/${t.id}`);
    if (detail) return json(detail);
    const telegram = /^\/v1\/trips\/(trip_[a-z]+)\/telegram-link$/.exec(path);
    if (method === "POST" && telegram) {
      const refused = options.tellTelegram?.(); if (refused) return refused;
      mints.telegram.push(telegram[1]!);
      return json({ deepLink: `https://t.me/kinerary_bot?start=lk_T${mints.telegram.length}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, expiresAt: new Date(Date.now() + ttl).toISOString() }, 201);
    }
    const whatsapp = /^\/v1\/trips\/(trip_[a-z]+)\/whatsapp-codes$/.exec(path);
    if (method === "POST" && whatsapp) {
      const kind = JSON.parse(String(init?.body)).kind as string;
      mints.whatsapp.push(`${whatsapp[1]}:${kind}`);
      return json({ link: `https://wa.me/${NUMBER}?text=Code%20KWA-N${mints.whatsapp.length}ABCDEFG`, expiresAt: new Date(Date.now() + ttl).toISOString() }, 201);
    }
    if (/\/whatsapp-connections$/.test(path)) return json({ connections: [] });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  return mints;
}
const show = (route: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={[route]}><App /></MemoryRouter>
  </QueryClientProvider>,
);
const hidden = (value: boolean) => Object.defineProperty(document, "hidden", { configurable: true, get: () => value });

beforeEach(() => hidden(false));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); hidden(false); });

// ── When a code is made ──────────────────────────────────────────────────────

it("viewing the dashboard makes no code at all, however many trips it lists; opening a menu makes exactly one, and opening it again makes none", async () => {
  const mints = server();
  show("/trips");
  const rome = (await screen.findByRole("heading", { name: "Rome 2027" })).closest("article")!;
  await screen.findByRole("heading", { name: "Paris 2027" });
  expect(mints).toEqual({ telegram: [], whatsapp: [] });

  fireEvent.click(within(rome).getByRole("button", { name: "WhatsApp options for Rome 2027" }));
  expect(await within(rome).findByRole("menuitem", { name: "Link WhatsApp" })).toHaveAttribute("href", expect.stringContaining("https://wa.me/"));
  expect(mints).toEqual({ telegram: [], whatsapp: ["trip_romerome:me"] });

  fireEvent.click(within(rome).getByRole("button", { name: "WhatsApp options for Rome 2027" }));   // close
  fireEvent.click(within(rome).getByRole("button", { name: "WhatsApp options for Rome 2027" }));   // open again
  expect(await within(rome).findByRole("menuitem", { name: "Link WhatsApp" })).toBeInTheDocument();
  fireEvent.click(within(rome).getByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(await within(rome).findByRole("menuitem", { name: "Link Telegram" })).toBeInTheDocument();
  expect(mints).toEqual({ telegram: ["trip_romerome"], whatsapp: ["trip_romerome:me"] });
});

it("the trip's page has both links ready when it is shown, one code for each and no group code", async () => {
  const mints = server();
  show("/trips/trip_romerome/setup");
  const whatsapp = await screen.findByRole("link", { name: "Link WhatsApp" });
  const telegram = await screen.findByRole("link", { name: "Link Telegram" });
  expect(whatsapp).toHaveAttribute("target", "_blank");
  expect(telegram).toHaveAttribute("target", "_blank");
  expect(telegram.getAttribute("href")).toMatch(/^https:\/\/t\.me\/kinerary_bot\?start=lk_T1/);
  expect(mints).toEqual({ telegram: ["trip_romerome"], whatsapp: ["trip_romerome:me"] });
  // Coming back to the tab asks for nothing: a new Telegram link would revoke the one just opened.
  act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mints).toEqual({ telegram: ["trip_romerome"], whatsapp: ["trip_romerome:me"] });
});

it("a person who reloads the page over and over cannot spend the server's allowance: after a few automatic codes the page offers a button, and the button still works", async () => {
  const mints = server({ trips: [trip("trip_romerome", "Rome 2027")] });
  for (let i = 0; i < 5; i += 1) {
    const view = show("/trips/trip_romerome/setup");
    await screen.findByRole("link", { name: "Link WhatsApp" });
    view.unmount();
  }
  expect(mints.whatsapp).toHaveLength(5);
  show("/trips/trip_romerome/setup");
  const button = await screen.findByRole("button", { name: "Link WhatsApp" });
  expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull();
  expect(mints.whatsapp).toHaveLength(5);
  fireEvent.click(button);
  expect(await screen.findByRole("link", { name: "Link WhatsApp" })).toBeInTheDocument();
  expect(mints.whatsapp).toHaveLength(6);
});

// ── The click ────────────────────────────────────────────────────────────────

it("the link is not swapped under the click, the used link then leaves the page for good, and a new one is made only when asked for", async () => {
  const mints = server({ trips: [trip("trip_romerome", "Rome 2027")] });
  const followed: string[] = [];
  // Runs after React's own handler, where the browser reads the link it is about to open.
  const record = (event: Event) => { event.preventDefault(); followed.push((event.target as HTMLAnchorElement).closest("a")?.getAttribute("href") ?? ""); };
  document.addEventListener("click", record);
  try {
    show("/trips/trip_romerome/setup");
    const link = await screen.findByRole("link", { name: "Link WhatsApp" });
    const first = link.getAttribute("href")!;
    expect(first).toContain("KWA-N1");
    fireEvent.click(link);
    expect(followed).toEqual([first]);
    // The used link is gone and cannot be found again: not as a link, not in the text, not in the markup.
    await vi.waitFor(() => expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull());
    expect(screen.getByText("WhatsApp opened. Press send there to finish.")).toBeInTheDocument();
    expect(document.documentElement.innerHTML).not.toContain("KWA-N1");
    expect(mints.whatsapp).toEqual(["trip_romerome:me"]);
    // Asked for: one new code, a different one.
    fireEvent.click(screen.getAllByRole("button", { name: "Get a new link" })[0]!);
    const next = await screen.findByRole("link", { name: "Link WhatsApp" });
    expect(next.getAttribute("href")).toContain("KWA-N2");
    expect(document.documentElement.innerHTML).not.toContain("KWA-N1");
    expect(mints.whatsapp).toEqual(["trip_romerome:me", "trip_romerome:me"]);
  } finally { document.removeEventListener("click", record); }
});

it("Telegram is the same: a used link is dropped and is not made again by itself, because a new Telegram link would revoke the one just opened", async () => {
  const mints = server({ trips: [trip("trip_romerome", "Rome 2027", { whatsapp: undefined })] });
  document.addEventListener("click", (event) => event.preventDefault(), { once: true });
  show("/trips/trip_romerome/setup");
  fireEvent.click(await screen.findByRole("link", { name: "Link Telegram" }));
  await vi.waitFor(() => expect(screen.queryByRole("link", { name: "Link Telegram" })).toBeNull());
  expect(screen.getByText("Telegram opened. Press Start there to finish.")).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mints.telegram).toEqual(["trip_romerome"]);
  expect(document.documentElement.innerHTML).not.toContain("lk_T1");
});

// ── Expiry ───────────────────────────────────────────────────────────────────

const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it("an expiring code is replaced silently before it ends, and a hidden page makes none until it is seen again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const mints = server({ ttlMs: 100_000, trips: [trip("trip_romerome", "Rome 2027", { telegram: undefined })] });
  show("/trips/trip_romerome/setup");
  await flush(50);
  expect(screen.getByRole("link", { name: "Link WhatsApp" }).getAttribute("href")).toContain("KWA-N1");
  // Silent refresh at 85% of the life: the link on the page is the new one, with no click and no gap.
  await flush(86_000);
  expect(mints.whatsapp).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Link WhatsApp" }).getAttribute("href")).toContain("KWA-N2");

  // The page is hidden when the second code runs out: nothing is made, and what is left is a button, never a dead link.
  hidden(true);
  await flush(120_000);
  expect(mints.whatsapp).toHaveLength(2);
  expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull();
  expect(screen.getByRole("button", { name: "Link WhatsApp" })).toBeInTheDocument();
  // Seen again: a fresh one, silently.
  hidden(false);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await flush(50);
  expect(mints.whatsapp).toHaveLength(3);
  expect(screen.getByRole("link", { name: "Link WhatsApp" }).getAttribute("href")).toContain("KWA-N3");
});

it("a page left open makes only a few silent codes, then waits for a person", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const mints = server({ ttlMs: 100_000, trips: [trip("trip_romerome", "Rome 2027", { telegram: undefined })] });
  show("/trips/trip_romerome/setup");
  await flush(50);
  for (let i = 0; i < 8; i += 1) await flush(101_000);
  // The first, and three replacements.
  expect(mints.whatsapp).toHaveLength(4);
  expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull();
  expect(screen.getByRole("button", { name: "Link WhatsApp" })).toBeInTheDocument();
});

// ── Telegram and WhatsApp alike ──────────────────────────────────────────────

it("on a trip card both services sit side by side with the same menu, the same actions and each its own logo and colour", async () => {
  server({ trips: [trip("trip_romerome", "Rome 2027", { telegram: { links: [{ id: "otl_0123456789abcdef", via: "interview_link", linkedAt: "2026-10-03T10:00:00.000Z", firstSignedInAt: null, lastSignedInAt: null }] } })] });
  show("/trips");
  const rome = within((await screen.findByRole("heading", { name: "Rome 2027" })).closest("article")!);
  const telegramIcon = rome.getByRole("img", { name: "Telegram linked" });
  const whatsappIcon = await rome.findByRole("img", { name: "WhatsApp not linked" });
  expect(telegramIcon.className).toContain("chat-service-telegram");
  expect(whatsappIcon.className).toContain("chat-service-whatsapp");
  expect(telegramIcon.querySelector("svg path")).not.toBeNull();
  expect(whatsappIcon.querySelector("svg path")).not.toBeNull();
  expect(telegramIcon.querySelector("svg path")?.getAttribute("d")).not.toBe(whatsappIcon.querySelector("svg path")?.getAttribute("d"));
  expect(telegramIcon.nextElementSibling?.className).toContain("telegram-kebab");
  // One row, Telegram first, WhatsApp next to it.
  const row = telegramIcon.closest(".chat-statuses")!;
  expect([...row.querySelectorAll("[role=img]")].map((el) => el.getAttribute("aria-label"))).toEqual(["Telegram linked", "WhatsApp not linked"]);

  for (const service of ["Telegram", "WhatsApp"]) {
    fireEvent.click(rome.getByRole("button", { name: `${service} options for Rome 2027` }));
    const menu = within(rome.getByRole("menu", { name: `${service} for Rome 2027` }));
    const link = await menu.findByRole("menuitem", { name: `Link ${service}` });
    expect(link.tagName).toBe("A");
    expect(link.className).toContain(`chat-service-${service.toLowerCase()}`);
    expect(link.querySelector("svg")).not.toBeNull();
    expect(menu.getByText(/Works once, until/)).toBeInTheDocument();
    fireEvent.click(rome.getByRole("button", { name: `${service} options for Rome 2027` }));
  }
});

it("opening one menu on a card closes the other, so two never stack on the same spot", async () => {
  server({ trips: [trip("trip_romerome", "Rome 2027")] });
  show("/trips");
  const rome = within((await screen.findByRole("heading", { name: "Rome 2027" })).closest("article")!);
  fireEvent.click(rome.getByRole("button", { name: "WhatsApp options for Rome 2027" }));
  expect(await rome.findByRole("menu", { name: "WhatsApp for Rome 2027" })).toBeInTheDocument();
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(await rome.findByRole("menu", { name: "Telegram for Rome 2027" })).toBeInTheDocument();
  expect(rome.queryByRole("menu", { name: "WhatsApp for Rome 2027" })).toBeNull();
  expect(rome.getByRole("button", { name: "WhatsApp options for Rome 2027" })).toHaveAttribute("aria-expanded", "false");
});

it("a right-click on the link does not use it up; a middle-click does", async () => {
  server({ trips: [trip("trip_romerome", "Rome 2027", { telegram: undefined })] });
  show("/trips/trip_romerome/setup");
  const link = await screen.findByRole("link", { name: "Link WhatsApp" });
  fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.getByRole("link", { name: "Link WhatsApp" })).toBe(link);
  fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
  await vi.waitFor(() => expect(screen.queryByRole("link", { name: "Link WhatsApp" })).toBeNull());
});

it("on the trip's page the two services have a card each, the same shape, the same words", async () => {
  server({ trips: [trip("trip_romerome", "Rome 2027")] });
  show("/trips/trip_romerome/setup");
  await screen.findByRole("link", { name: "Link Telegram" });
  const telegram = within(document.querySelector("#telegram") as HTMLElement);
  const whatsapp = within(document.querySelector("#whatsapp") as HTMLElement);
  await telegram.findByRole("link", { name: "Link Telegram" });
  await whatsapp.findByRole("link", { name: "Link WhatsApp" });
  expect(document.querySelector("#telegram")?.parentElement).toBe(document.querySelector("#whatsapp")?.parentElement);
  expect(telegram.getByRole("heading", { name: "Telegram" })).toBeInTheDocument();
  expect(whatsapp.getByRole("heading", { name: "WhatsApp" })).toBeInTheDocument();
  expect(telegram.getByText("No Telegram account is linked to this trip.")).toBeInTheDocument();
  await vi.waitFor(() => expect(whatsapp.getByText("No WhatsApp chat is linked to this trip.")).toBeInTheDocument());
  expect(document.querySelector("#telegram")?.className).toContain("chat-service-telegram-card");
  expect(document.querySelector("#whatsapp")?.className).toContain("chat-service-whatsapp-card");
  expect(document.querySelector("#telegram h2 svg")).not.toBeNull();
  expect(document.querySelector("#whatsapp h2 svg")).not.toBeNull();
});

it("WhatsApp shows only when the server sent it: without it nothing about WhatsApp is on the card or the page, and Telegram is unchanged", async () => {
  const mints = server({ trips: [trip("trip_romerome", "Rome 2027", { whatsapp: undefined })] });
  show("/trips");
  const rome = within((await screen.findByRole("heading", { name: "Rome 2027" })).closest("article")!);
  expect(await rome.findByRole("img", { name: "Telegram not linked" })).toBeInTheDocument();
  expect(rome.queryByRole("img", { name: /WhatsApp/ })).toBeNull();
  expect(rome.queryByRole("button", { name: /WhatsApp/ })).toBeNull();
  expect(mints.whatsapp).toEqual([]);
});

it("a co-organizer is not told 'not linked' for WhatsApp: the card shows the plain logo and the menu offers Link only", async () => {
  server({ trips: [trip("trip_romerome", "Rome 2027", { whatsapp: { number: NUMBER, owner: false }, permissions: { ...owner, role: "organizer", requestProvisioning: false } })] });
  show("/trips");
  const rome = within((await screen.findByRole("heading", { name: "Rome 2027" })).closest("article")!);
  expect(await rome.findByRole("img", { name: "WhatsApp" })).toBeInTheDocument();
  expect(rome.queryByRole("img", { name: "WhatsApp not linked" })).toBeNull();
  fireEvent.click(rome.getByRole("button", { name: "WhatsApp options for Rome 2027" }));
  expect(await rome.findByRole("menuitem", { name: "Link WhatsApp" })).toBeInTheDocument();
  expect(rome.queryByText(/WhatsApp chat.* linked to this trip/)).toBeNull();
});

it("a Telegram-minted session makes no code for either service", async () => {
  const mints = server({ me: { scope: "telegram" }, trips: [trip("trip_romerome", "Rome 2027", { whatsapp: undefined })] });
  show("/trips/trip_romerome/setup");
  await screen.findByText(/to link another Telegram account, sign in with your password/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(mints).toEqual({ telegram: [], whatsapp: [] });
  expect(screen.queryByRole("link", { name: /^Link / })).toBeNull();
});
