// Group sign-in: pick your own name (docs/specs/sprint-9/x-member-sign-in.md, S1). Same harness as MiniAppSignIn.test.tsx.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

const WAIT = { timeout: 5000 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function LocationProbe() { const location = useLocation(); return <output data-testid="route">{location.pathname}</output>; }

type Handler = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function mount(route: string, handler: Handler, options: { authenticated?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    calls.push({ method: init?.method || "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const custom = await handler(path, init);
    if (custom) return custom;
    if (path === "/v1/me") return options.authenticated === false ? json({}, 401) : json({ id: "user_existing", displayName: "Member" });
    if (path === "/v1/trips") return json({ trips: [] });
    if (path === "/v1/auth/capabilities") return json({ emailPassword: true, google: false, telegramMiniApp: true });
    if (path.endsWith("/launch")) return json({ runtimeOrigin: "https://runtime.example.test", framePath: `/t/${path.split("/")[3]}/`, launchToken: "fixture-grant" });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /><LocationProbe /></MemoryRouter></QueryClientProvider>);
  return { ...view, calls, exchanges: () => calls.filter((c) => c.path === "/v1/auth/telegram-mini-app"), claims: () => calls.filter((c) => c.path === "/v1/mini-app/claim") };
}
const INIT = "query_id=AAH&user=%7B%22id%22%3A1%7D&auth_date=1&hash=abc";
function telegram(extra: Record<string, unknown> = {}) {
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: { platform: "ios", initData: INIT, initDataUnsafe: { user: { id: 999, first_name: "Forged" } }, ready: vi.fn(), expand: vi.fn(), ...extra } };
}
let submissions: { action: string; token: string | null }[] = [];
beforeEach(() => {
  submissions = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) { submissions.push({ action: this.action, token: new FormData(this).get("token") as string | null }); });
  window.sessionStorage.clear(); window.history.replaceState(null, "", "/");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as { Telegram?: unknown }).Telegram; window.sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

const TRIP = "trip_abcdefgh";
const DANA = { claimId: "tpc_danaaaaaaa", name: "Dana" };
const AVI = { claimId: "tpc_aviaaaaaaa", name: "אבי" };
const offer = (travellers: unknown[] = [DANA, AVI]) => json({ kind: "claim", tripId: TRIP, travellers });
const isLaunch = (path: string) => path === "/v1/auth/telegram-mini-app";
const isClaim = (path: string) => path === "/v1/mini-app/claim";
const SESSION = () => json({ kind: "session", appPath: `/mini-app/trips/${TRIP}` });

it("a claim offer lists the names and claims nothing until a name is confirmed", async () => {
  telegram();
  const { claims } = mount("/mini-app", (path) => isLaunch(path) ? offer() : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "Which traveller are you?" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Dana" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "אבי" })).toBeInTheDocument();
  // Picking a name asks "is this you?"; it does not claim.
  fireEvent.click(screen.getByRole("button", { name: "Dana" }));
  expect(await screen.findByText(/You are signing in as/)).toHaveTextContent("You are signing in as Dana");
  expect(screen.getByText(/only the organizer can undo it/)).toBeInTheDocument();
  expect(claims()).toHaveLength(0);
  // "Choose a different name" goes back to the list, still without a claim.
  fireEvent.click(screen.getByRole("button", { name: "Choose a different name" }));
  expect(await screen.findByRole("button", { name: "אבי" })).toBeInTheDocument();
  expect(claims()).toHaveLength(0);
  // Nothing the person reads is an id or a code.
  expect(document.body.textContent).not.toMatch(/tpc_|trip_|ALREADY_CLAIMED|NOT_FOUND/);
});

it("confirming sends ONE claim with the SDK's initData, the trip and the opaque claim id, then lands in the trip", async () => {
  telegram();
  const { claims } = mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? SESSION() : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  await vi.waitFor(() => expect(submissions).toHaveLength(1), WAIT);
  expect(claims()).toHaveLength(1);
  expect(claims()[0].method).toBe("POST");
  expect(claims()[0].body).toEqual({ initData: INIT, tripId: TRIP, claimId: DANA.claimId });
  expect(JSON.stringify(claims()[0].body)).not.toContain("Forged");
  expect(screen.getByTestId("route")).toHaveTextContent(`/mini-app/trips/${TRIP}`);
});

it("a double tap on the confirm button is one claim", async () => {
  telegram();
  let release!: (response: Response) => void;
  const { claims } = mount("/mini-app", (path) => {
    if (isLaunch(path)) return offer();
    if (isClaim(path)) return new Promise<Response>((resolve) => { release = resolve; });
    return undefined;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  const confirm = await screen.findByRole("button", { name: "Yes, that's me" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await vi.waitFor(() => expect(claims()).toHaveLength(1), WAIT);
  expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  release(SESSION());
  await vi.waitFor(() => expect(submissions).toHaveLength(1), WAIT);
  expect(claims()).toHaveLength(1);
});

it("the claim reads initData from the SDK at claim time, not the copy taken at launch", async () => {
  telegram();
  const { claims } = mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? SESSION() : undefined, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  const fresh = "query_id=AAH&user=%7B%22id%22%3A1%7D&auth_date=2&hash=def";
  (window as unknown as { Telegram: { WebApp: { initData: string } } }).Telegram.WebApp.initData = fresh;
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  await vi.waitFor(() => expect(claims()).toHaveLength(1), WAIT);
  expect(claims()[0].body).toMatchObject({ initData: fresh });
});

it("Telegram Web: the claim asks for the cross-site cookie variant, like the exchange", async () => {
  telegram({ platform: "weba" });
  const { claims } = mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? SESSION() : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  await vi.waitFor(() => expect(claims()).toHaveLength(1), WAIT);
  expect(claims()[0].body).toEqual({ initData: INIT, tripId: TRIP, claimId: DANA.claimId, embedded: true });
});

it("an empty list says to ask the organizer for a personal invite, and offers nothing to claim", async () => {
  telegram();
  const { claims } = mount("/mini-app", (path) => isLaunch(path) ? offer([]) : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "Your name isn't on the list" })).toBeInTheDocument();
  expect(screen.getByText(/Ask the organizer to send you a personal invite/)).toBeInTheDocument();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(claims()).toHaveLength(0);
});

it("409: says someone already signed in as that name, then shows the refreshed list without it", async () => {
  telegram();
  let launches = 0;
  const { calls } = mount("/mini-app", (path) => {
    if (isLaunch(path)) { launches += 1; return launches === 1 ? offer([DANA, AVI]) : offer([AVI]); }
    if (isClaim(path)) return json({ error: "ALREADY_CLAIMED" }, 409);
    return undefined;
  }, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  expect(await screen.findByText(/Someone already signed in as/)).toHaveTextContent("Someone already signed in as Dana.");
  expect(screen.queryByRole("button", { name: "Dana" })).toBeNull();
  expect(screen.getByRole("button", { name: "אבי" })).toBeInTheDocument();
  // The refresh is a second launch with the same initData, never a second claim.
  expect(calls.map((c) => c.path).filter((p) => isLaunch(p) || isClaim(p))).toEqual(["/v1/auth/telegram-mini-app", "/v1/mini-app/claim", "/v1/auth/telegram-mini-app"]);
  expect(document.body.textContent).not.toMatch(/ALREADY_CLAIMED|tpc_|trip_/);
});

it("STALE initData says to close and reopen", async () => {
  telegram();
  mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? json({ error: "TELEGRAM_INIT_DATA_STALE" }, 401) : undefined, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  expect(await screen.findByRole("heading", { name: "Please open Kinerary again" })).toBeInTheDocument();
  expect(screen.getByText(/Close this window and open Kinerary from Telegram again/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/STALE|TELEGRAM_/);
});

it("503 on the claim keeps the confirm step and offers to try again; the second try can succeed", async () => {
  telegram();
  let attempts = 0;
  const { claims } = mount("/mini-app", (path) => {
    if (isLaunch(path)) return offer();
    if (isClaim(path)) { attempts += 1; return attempts === 1 ? json({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true }, 503) : SESSION(); }
    return undefined;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Please try again");
  expect(screen.getByText(/You are signing in as/)).toHaveTextContent("Dana");
  expect(document.body.textContent).not.toMatch(/MEMBERSHIP_CHECK_UNAVAILABLE/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(submissions).toHaveLength(1), WAIT);
  expect(claims()).toHaveLength(2);
});

it("404 on the claim falls back to the trip-password view, as 'not linked' does", async () => {
  telegram();
  mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? json({ error: "NOT_FOUND" }, 404) : undefined, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  expect(await screen.findByLabelText("Trip username")).toBeInTheDocument();
});

it("a launch the server could not check (503) offers to try again, and the retry asks the same question", async () => {
  telegram();
  let launches = 0;
  const { exchanges } = mount("/mini-app", (path) => {
    if (!isLaunch(path)) return undefined;
    launches += 1;
    return launches === 1 ? json({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true }, 503) : offer();
  }, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "We couldn't check right now" })).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/MEMBERSHIP_CHECK_UNAVAILABLE/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "Dana" })).toBeInTheDocument();
  expect(exchanges().map((e) => e.body)).toEqual([{ initData: INIT }, { initData: INIT }]);
});

it("a rate-limited claim says so in words, never in codes", async () => {
  telegram();
  mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? json({ error: "SIGN_IN_RATE_LIMITED" }, 429) : undefined, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  expect(await screen.findByRole("heading", { name: "Too many attempts" })).toBeInTheDocument();
});

it("in Hebrew the claim screens are Hebrew and right-to-left, and a name keeps its own direction", async () => {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["he-IL", "en"]);
  telegram();
  mount("/mini-app", (path) => isLaunch(path) ? offer() : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "מי מהנוסעים אתם?" })).toBeInTheDocument();
  expect(screen.getByTestId("mini-app-sign-in")).toHaveAttribute("dir", "rtl");
  fireEvent.click(screen.getByRole("button", { name: "Dana" }));
  expect(await screen.findByText(/אתם נכנסים בתור/)).toHaveTextContent("אתם נכנסים בתור Dana");
  expect(screen.getByRole("button", { name: "כן, זה אני" })).toBeInTheDocument();
  expect(screen.getByTestId("mini-app-sign-in").querySelector("bdi")).toHaveAttribute("dir", "auto");
});

it("in English the screens are left-to-right", async () => {
  telegram();
  mount("/mini-app", (path) => isLaunch(path) ? offer() : undefined, { authenticated: false });
  await screen.findByRole("heading", { name: "Which traveller are you?" });
  expect(screen.getByTestId("mini-app-sign-in")).toHaveAttribute("dir", "ltr");
});

// ── S1b test gaps (found in review): what is NEVER on screen, the in-flight guard on its own, and the Hebrew states ─────────────────

/** No id, no code, in the words OR in any attribute: what a person reads and what a script on the page could read. */
const NO_IDS = /tpc_|trip_|claimId|ALREADY_CLAIMED|NOT_FOUND|TELEGRAM_|MEMBERSHIP_CHECK|SIGN_IN_RATE_LIMITED|INVALID_REQUEST|retryable/;
const expectNoIds = (container: HTMLElement) => {
  expect(document.body.textContent).not.toMatch(NO_IDS);
  expect(container.innerHTML).not.toMatch(NO_IDS);
};

it("no claim id, trip id or error code is rendered on the empty, confirm and retry screens (words or attributes)", async () => {
  telegram();
  // empty
  const empty = mount("/mini-app", (path) => isLaunch(path) ? offer([]) : undefined, { authenticated: false });
  await screen.findByRole("heading", { name: "Your name isn't on the list" });
  expectNoIds(empty.container);
  empty.unmount();
  // confirm, then retry (a 503 on the claim)
  let attempts = 0;
  const flow = mount("/mini-app", (path) => {
    if (isLaunch(path)) return offer();
    if (isClaim(path)) { attempts += 1; return attempts === 1 ? json({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true }, 503) : SESSION(); }
    return undefined;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  await screen.findByRole("heading", { name: "Is this you?" });
  expectNoIds(flow.container);
  fireEvent.click(screen.getByRole("button", { name: "Yes, that's me" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Please try again");
  expectNoIds(flow.container);
  // the working state, too (the claim is in flight)
  expect(flow.claims()).toHaveLength(1);
});

it("taps that land before the button is re-rendered as disabled are one claim (the in-flight guard, independent of the disabled attribute)", async () => {
  telegram();
  let release!: (response: Response) => void;
  const { claims } = mount("/mini-app", (path) => {
    if (isLaunch(path)) return offer();
    if (isClaim(path)) return new Promise<Response>((resolve) => { release = resolve; });
    return undefined;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  const confirm = await screen.findByRole("button", { name: "Yes, that's me" });
  // Three taps that all land BEFORE React has re-rendered the button as disabled (one batch): React's own disabled check never gets a
  // chance, so only the component's ref says "one claim is in flight". (Clicks on an already-disabled button are swallowed by React
  // whatever the DOM attribute says, so the earlier double-tap test cannot tell the guard from the attribute.)
  act(() => { confirm.click(); confirm.click(); confirm.click(); });
  await vi.waitFor(() => expect(claims()).toHaveLength(1), WAIT);
  expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  release(SESSION());
  await vi.waitFor(() => expect(submissions).toHaveLength(1), WAIT);
  expect(claims()).toHaveLength(1);
});

it("the guard lets go when the claim ends in a retry: the next tap is a second claim", async () => {
  telegram();
  let attempts = 0;
  const { claims } = mount("/mini-app", (path) => {
    if (isLaunch(path)) return offer();
    if (isClaim(path)) { attempts += 1; return attempts === 1 ? json({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true }, 503) : SESSION(); }
    return undefined;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, that's me" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(claims()).toHaveLength(2), WAIT);
});

it("Hebrew: the empty list, a name somebody else took, a stale launch and both retry states are Hebrew, right-to-left, and say no code", async () => {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["he-IL", "en"]);
  telegram();
  // empty
  const empty = mount("/mini-app", (path) => isLaunch(path) ? offer([]) : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "השם שלכם לא ברשימה" })).toBeInTheDocument();
  expect(screen.getByText("בקשו מהמארגן שישלח לכם הזמנה אישית לטיול.")).toBeInTheDocument();
  expect(screen.getByTestId("mini-app-sign-in")).toHaveAttribute("dir", "rtl");
  expectNoIds(empty.container);
  empty.unmount();
  // taken: the refreshed list, and the sentence about the name somebody else signed in as
  let launches = 0;
  const taken = mount("/mini-app", (path) => {
    if (isLaunch(path)) { launches += 1; return launches === 1 ? offer([DANA, AVI]) : offer([AVI]); }
    if (isClaim(path)) return json({ error: "ALREADY_CLAIMED" }, 409);
    return undefined;
  }, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "כן, זה אני" }));
  expect(await screen.findByText(/מישהו כבר נכנס בתור/)).toHaveTextContent("מישהו כבר נכנס בתור Dana. אם זה לא אתם, פנו למארגן.");
  expectNoIds(taken.container);
  taken.unmount();
  // stale
  const stale = mount("/mini-app", (path) => isLaunch(path) ? offer() : isClaim(path) ? json({ error: "TELEGRAM_INIT_DATA_STALE" }, 401) : undefined, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "כן, זה אני" }));
  expect(await screen.findByRole("heading", { name: "פתחו את Kinerary מחדש" })).toBeInTheDocument();
  expect(screen.getByText("עבר יותר מדי זמן. סגרו את החלון ופתחו את Kinerary שוב מטלגרם.")).toBeInTheDocument();
  expectNoIds(stale.container);
  stale.unmount();
  // retry on the claim: the notice and the button
  let attempts = 0;
  const retry = mount("/mini-app", (path) => {
    if (isLaunch(path)) return offer();
    if (isClaim(path)) { attempts += 1; return attempts === 1 ? json({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true }, 503) : SESSION(); }
    return undefined;
  }, { authenticated: false });
  fireEvent.click(await screen.findByRole("button", { name: "Dana" }));
  fireEvent.click(await screen.findByRole("button", { name: "כן, זה אני" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("לא הצלחנו להשלים את זה כרגע. נסו שוב.");
  expect(screen.getByRole("button", { name: "נסו שוב" })).toBeInTheDocument();
  expectNoIds(retry.container);
  retry.unmount();
  // retry on the launch itself
  let tries = 0;
  const launchRetry = mount("/mini-app", (path) => {
    if (!isLaunch(path)) return undefined;
    tries += 1;
    return tries === 1 ? json({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true }, 503) : offer();
  }, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "לא הצלחנו לבדוק כרגע" })).toBeInTheDocument();
  expect(screen.getByText("נסו שוב בעוד רגע.")).toBeInTheDocument();
  expectNoIds(launchRetry.container);
});
