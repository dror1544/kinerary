import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { formatDay, formatTime } from "./dates";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const organizer = { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true };
const base = {
  destination: "Somewhere", startDate: null, endDate: null, tripType: "family", lifecycleState: "ready_private",
  nextAction: "open_trip", interview: null, provisioning: null, runtimeReady: true, invites: [], permissions: organizer,
};
const link = { id: "otl_0123456789abcdef", via: "interview_link", linkedAt: "2026-10-03T10:00:00.000Z", firstSignedInAt: "2026-10-04T10:00:00.000Z", lastSignedInAt: "2026-10-06T10:00:00.000Z" };

type State = { rome: unknown[]; oslo: unknown[] };
function mount(state: State, extra: (path: string, init?: RequestInit) => Response | undefined = () => undefined, trips?: () => unknown[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
    const custom = extra(path, init);
    if (custom) return custom;
    if (path === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (path === "/v1/trips") {
      return json({ trips: trips?.() ?? [
        { ...base, id: "trip_romerome", title: "Rome 2027", telegram: { links: state.rome } },
        { ...base, id: "trip_oslooslo", title: "Oslo 2027", telegram: { links: state.oslo } },
      ] });
    }
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/trips"]}><App /></MemoryRouter></QueryClientProvider>);
  return calls;
}
const card = async (title: string) => (await screen.findByRole("heading", { name: title })).closest("article")!;
afterEach(() => { vi.unstubAllGlobals(); document.documentElement.lang = "en"; });

it("each organizer trip card shows whether Telegram is linked for THAT trip", async () => {
  mount({ rome: [link], oslo: [] });
  expect(within(await card("Rome 2027")).getByRole("img", { name: "Telegram linked" })).toBeInTheDocument();
  expect(within(await card("Oslo 2027")).getByRole("img", { name: "Telegram not linked" })).toBeInTheDocument();
  // The account-level section is gone: the card replaced it.
  expect(screen.queryByText(/Telegram accounts that can sign in as you/)).toBeNull();
});

it("Link produces a one-time t.me link for that trip, and says how long it works", async () => {
  const calls: string[] = [];
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  mount({ rome: [], oslo: [] }, (path, init) => {
    calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/v1/trips/trip_oslooslo/telegram-link" && init?.method === "POST") return json({ deepLink: "https://t.me/kinerary_bot?start=lk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt }, 201);
    return undefined;
  });
  const oslo = within(await card("Oslo 2027"));
  fireEvent.click(oslo.getByRole("button", { name: "Telegram options for Oslo 2027" }));
  expect(oslo.getByText("No Telegram account is linked to this trip.")).toBeInTheDocument();
  expect(calls.some((c) => c.includes("telegram-link"))).toBe(false);
  fireEvent.click(oslo.getByRole("menuitem", { name: "Link Telegram" }));
  const open = await oslo.findByRole("link", { name: "Open in Telegram" });
  expect(open).toHaveAttribute("href", "https://t.me/kinerary_bot?start=lk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  expect(open).toHaveAttribute("rel", "noopener noreferrer");
  expect(oslo.getByText(/Works once, until/)).toBeInTheDocument();
  expect(calls.filter((c) => c.includes("telegram-link"))).toEqual(["POST /v1/trips/trip_oslooslo/telegram-link"]);
});

it("a refused link request says so instead of showing a stale link", async () => {
  mount({ rome: [], oslo: [] }, (path, init) => path.endsWith("/telegram-link") && init?.method === "POST" ? json({ error: "RATE_LIMITED" }, 429) : undefined);
  const oslo = within(await card("Oslo 2027"));
  fireEvent.click(oslo.getByRole("button", { name: "Telegram options for Oslo 2027" }));
  fireEvent.click(oslo.getByRole("menuitem", { name: "Link Telegram" }));
  expect(await oslo.findByRole("alert")).toHaveTextContent("Too many requests");
  expect(oslo.queryByRole("link", { name: "Open in Telegram" })).toBeNull();
});

it("Unlink asks first, unlinks only that trip, and the card goes to 'not linked' while the other stays linked", async () => {
  const state: State = { rome: [link], oslo: [{ ...link, id: "otl_fedcba9876543210" }] };
  const calls = mount(state, (path, init) => {
    if (init?.method === "DELETE" && path === `/v1/account/telegram-links/${link.id}`) { state.rome = []; return json({ status: "unlinked" }); }
    return undefined;
  });
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  // Dates are the page's (English), whatever the browser prefers.
  fireEvent.click(rome.getByRole("menuitem", { name: /Unlink Telegram · linked Oct 3, 2026/ }));
  expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  fireEvent.click(rome.getByRole("button", { name: "Confirm unlink" }));
  await vi.waitFor(() => expect(within(screen.getByRole("heading", { name: "Rome 2027" }).closest("article")!).getByRole("img", { name: "Telegram not linked" })).toBeInTheDocument());
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /v1/account/telegram-links/${link.id}`]);
  expect(within(await card("Oslo 2027")).getByRole("img", { name: "Telegram linked" })).toBeInTheDocument();
});

const unlinkedEntry = { id: "otl_aaaaaaaaaaaaaaaa", via: "interview_link", linkedAt: "2026-10-03T10:00:00.000Z", unlinkedAt: "2026-10-05T10:00:00.000Z" };

it("an Unlinked account is offered Restore; it asks first, then one POST (no Telegram link), and the card goes back to 'linked'", async () => {
  const romeCard = (linked: boolean) => ({ ...base, id: "trip_romerome", title: "Rome 2027", telegram: { links: linked ? [{ ...link, id: "otl_bbbbbbbbbbbbbbbb", via: "dashboard_restore" }] : [], unlinked: linked ? [] : [unlinkedEntry] } });
  let restored = false;
  const calls = mount({ rome: [], oslo: [] }, (path, init) => {
    if (path === "/v1/trips") return json({ trips: [romeCard(restored)] });
    if (init?.method === "POST" && path === `/v1/account/telegram-links/${unlinkedEntry.id}/restore`) { restored = true; return json({ status: "restored" }); }
    return undefined;
  });
  const rome = within(await card("Rome 2027"));
  expect(rome.getByRole("img", { name: "Telegram not linked" })).toBeInTheDocument();
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  fireEvent.click(rome.getByRole("menuitem", { name: /Restore Telegram · unlinked Oct 5, 2026/ }));
  // Asked first: nothing has been sent yet, and an account with no label is still named for what it is.
  expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  expect(rome.getByRole("group", { name: "Confirm restore" })).toHaveTextContent("Restore Telegram access for this Telegram account? It will open this trip again, and sign in fresh.");
  fireEvent.click(rome.getByRole("button", { name: "Confirm restore" }));
  await vi.waitFor(() => expect(within(screen.getByRole("heading", { name: "Rome 2027" }).closest("article")!).getByRole("img", { name: "Telegram linked" })).toBeInTheDocument());
  expect(calls.filter((c) => c.startsWith("POST"))).toEqual([`POST /v1/account/telegram-links/${unlinkedEntry.id}/restore`]);
  expect(calls.some((c) => c.includes("telegram-link") && !c.includes("telegram-links"))).toBe(false);
  expect(document.body.textContent).not.toMatch(/sha256|otl_|tml_/);
});

it("the Restore question and the entries show the first name, then the @username in its own element; Keep unlinked sends nothing; an unnamed entry reads 'Telegram account'", async () => {
  const named = { ...unlinkedEntry, name: "Dana", username: "dana_k" };
  const calls = mount({ rome: [], oslo: [] }, (path) =>
    path === "/v1/trips" ? json({ trips: [{ ...base, id: "trip_romerome", title: "Rome 2027", telegram: { links: [{ ...link, name: "Noa", username: "noa_n" }], unlinked: [named, { ...unlinkedEntry, id: "otl_cccccccccccccccc" }] } }] }) : undefined);
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(rome.getByRole("menuitem", { name: /Unlink Telegram/ })).toHaveTextContent("Noa @noa_n · via the trip's interview link");
  const restoreItems = rome.getAllByRole("menuitem", { name: /Restore Telegram/ });
  expect(restoreItems[0]).toHaveTextContent("Dana @dana_k · was linked Oct 3, 2026");
  expect(restoreItems[1]).toHaveTextContent("Telegram account · was linked Oct 3, 2026");
  const handle = restoreItems[0]!.querySelector(".telegram-handle");
  expect(handle?.textContent).toBe("@dana_k");
  expect(restoreItems[0]!.querySelector(".telegram-name")?.textContent).toBe("Dana");
  expect(handle?.tagName).toBe("BDI");
  fireEvent.click(restoreItems[0]!);
  expect(rome.getByRole("group", { name: "Confirm restore" })).toHaveTextContent("Restore Telegram access for Dana @dana_k? It will open this trip again, and sign in fresh.");
  fireEvent.click(rome.getByRole("button", { name: "Keep unlinked" }));
  expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  expect(rome.queryByRole("group", { name: "Confirm restore" })).toBeNull();
});

it("a name is shown as text, never as markup, and a name that says '@someone' is not a handle element", async () => {
  mount({ rome: [], oslo: [] }, (path) =>
    path === "/v1/trips" ? json({ trips: [{ ...base, id: "trip_romerome", title: "Rome 2027", telegram: { links: [{ ...link, name: "<img src=x onerror=alert(1)> Dror own_p", username: "real_one" }] } }] }) : undefined);
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(rome.getByRole("menuitem", { name: /Unlink Telegram/ })).toHaveTextContent("<img src=x onerror=alert(1)> Dror own_p @real_one");
  expect(document.querySelector("img[src='x']")).toBeNull();
  // Exactly one handle element: the username field. The name never becomes one.
  expect(document.querySelectorAll(".telegram-handle")).toHaveLength(1);
  expect(document.querySelector(".telegram-handle")?.textContent).toBe("@real_one");
});

it("a refused Restore says so", async () => {
  mount({ rome: [], oslo: [] }, (path, init) => {
    if (path === "/v1/trips") return json({ trips: [{ ...base, id: "trip_romerome", title: "Rome 2027", telegram: { links: [], unlinked: [unlinkedEntry] } }] });
    return init?.method === "POST" && path.endsWith("/restore") ? json({ error: "NOT_FOUND" }, 404) : undefined;
  });
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  fireEvent.click(rome.getByRole("menuitem", { name: /Restore Telegram/ }));
  fireEvent.click(rome.getByRole("button", { name: "Confirm restore" }));
  expect(await rome.findByRole("alert")).toBeInTheDocument();
});

it("a Telegram-minted session is never offered Restore, even if the list were present", async () => {
  const calls = mount({ rome: [], oslo: [] }, (path) => {
    if (path === "/v1/me") return json({ id: "user_existing", displayName: "Organizer", scope: "telegram" });
    if (path === "/v1/trips") return json({ trips: [{ ...base, id: "trip_romerome", title: "Rome 2027", telegram: { links: [link], unlinked: [unlinkedEntry] } }] });
    return undefined;
  });
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(await rome.findByText(/to link another Telegram account, sign in with your password/)).toBeInTheDocument();
  expect(rome.queryByRole("menuitem", { name: /Restore Telegram/ })).toBeNull();
  expect(calls.some((c) => c.endsWith("/restore"))).toBe(false);
});

it("Keep leaves the link alone", async () => {
  const calls = mount({ rome: [link], oslo: [] });
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  fireEvent.click(rome.getByRole("menuitem", { name: /Unlink Telegram/ }));
  fireEvent.click(rome.getByRole("button", { name: "Keep" }));
  expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  expect(rome.getByRole("menuitem", { name: /Unlink Telegram/ })).toBeInTheDocument();
});

it("never shows an id, a digest or who the other party is", async () => {
  mount({ rome: [link], oslo: [] });
  const rome = within(await card("Rome 2027"));
  fireEvent.click(rome.getByRole("button", { name: "Telegram options for Rome 2027" }));
  expect(document.body.textContent).not.toMatch(/sha256|otl_|tml_/);
});

it("a member sees the status and can end their own link, but is not offered Link", async () => {
  const member = {
    id: "trip_memberone", title: "Member trip", destination: null, startDate: null, endDate: null, runtimeReady: true,
    permissions: { role: "member", dashboard: false, runtime: true, invite: false, requestProvisioning: false },
    telegram: { links: [{ ...link, id: "tml_0123456789abcdef", via: "trip_password" }] },
  };
  mount({ rome: [], oslo: [] }, () => undefined, () => [member]);
  const mine = within(await card("Member trip"));
  expect(mine.getByRole("img", { name: "Telegram linked" })).toBeInTheDocument();
  fireEvent.click(mine.getByRole("button", { name: "Telegram options for Member trip" }));
  expect(mine.queryByRole("menuitem", { name: /Link/ })).toBeNull();
  expect(mine.getByRole("menuitem", { name: /Unlink Telegram/ })).toBeInTheDocument();
});

it("a member with nothing linked sees no Telegram control at all", async () => {
  const member = {
    id: "trip_memberone", title: "Member trip", destination: null, startDate: null, endDate: null, runtimeReady: true,
    permissions: { role: "member", dashboard: false, runtime: true, invite: false, requestProvisioning: false },
  };
  mount({ rome: [], oslo: [] }, () => undefined, () => [member]);
  const mine = within(await card("Member trip"));
  expect(mine.queryByRole("img", { name: /Telegram/ })).toBeNull();
  expect(mine.queryByRole("button", { name: /Telegram options/ })).toBeNull();
});

// ── Dates follow the page, not the browser ──────────────────────────────────

it("formats dates in the PAGE's language even when the browser prefers another", () => {
  const spy = vi.spyOn(Date.prototype, "toLocaleDateString");
  try {
    document.documentElement.lang = "en";
    expect(formatDay("2026-10-03T10:00:00.000Z")).toBe("Oct 3, 2026");
    expect(spy.mock.calls.at(-1)?.[0], "an explicit locale, never undefined (= the browser's)").toBe("en");
    document.documentElement.lang = "he";
    formatDay("2026-10-03T10:00:00.000Z");
    expect(spy.mock.calls.at(-1)?.[0]).toBe("he");
    // No lang attribute at all: English, not the browser.
    document.documentElement.removeAttribute("lang");
    expect(formatDay("2026-10-03T10:00:00.000Z")).toBe("Oct 3, 2026");
    expect(spy.mock.calls.at(-1)?.[0]).toBe("en");
    // A malformed tag cannot crash a card.
    document.documentElement.lang = "not a language";
    expect(formatDay("2026-10-03T10:00:00.000Z")).toBe("Oct 3, 2026");
    expect(formatDay("garbage")).toBe("");
    expect(formatTime("garbage")).toBe("");
  } finally { spy.mockRestore(); }
});
