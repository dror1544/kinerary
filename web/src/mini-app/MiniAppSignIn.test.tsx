import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { digestInitData, launchMarker } from "./launch";

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
    if (path === "/v1/me") return options.authenticated === false ? json({}, 401) : json({ id: "user_existing", displayName: "Organizer" });
    if (path === "/v1/trips") return json({ trips: [] });
    if (path === "/v1/auth/capabilities") return json({ emailPassword: true, google: false, telegramMiniApp: true });
    if (path.endsWith("/launch")) return json({ runtimeOrigin: "https://runtime.example.test", framePath: `/t/${path.split("/")[3]}/`, launchToken: "fixture-grant" });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /><LocationProbe /></MemoryRouter></QueryClientProvider>);
  return { ...view, calls, exchanges: () => calls.filter((c) => c.path === "/v1/auth/telegram-mini-app") };
}
const INIT = "query_id=AAH&user=%7B%22id%22%3A1%7D&auth_date=1&hash=abc";
function telegram(extra: Record<string, unknown> = {}) {
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: { platform: "ios", initData: INIT, initDataUnsafe: { user: { id: 999, first_name: "Forged" } }, ready: vi.fn(), expand: vi.fn(), ...extra } };
}
// The trip site opens top-level (#455): the launcher posts a hidden form instead of mounting a frame,
// and in Telegram's browser clients it offers a button instead (the frame cannot hold a trip site).
let submissions: { action: string; token: string | null }[] = [];
beforeEach(() => {
  submissions = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) { submissions.push({ action: this.action, token: new FormData(this).get("token") as string | null }); });
  window.sessionStorage.clear(); window.history.replaceState(null, "", "/");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as { Telegram?: unknown }).Telegram; window.sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

it("sends the SDK's signed initData and nothing else, ignoring initDataUnsafe", async () => {
  telegram();
  const { exchanges } = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app/trips/trip_abcdefgh" }) : undefined);
  await vi.waitFor(() => expect(submissions).toHaveLength(1));
  expect(exchanges()).toHaveLength(1);
  expect(exchanges()[0].body).toEqual({ initData: INIT });
  expect(JSON.stringify(exchanges())).not.toContain("Forged");
  expect(screen.getByTestId("route")).toHaveTextContent("/mini-app/trips/trip_abcdefgh");
});

it("lands on the trip the server chose, not the one the URL asked for", async () => {
  telegram();
  mount("/mini-app/trips/trip_ijklmnop", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app/trips/trip_abcdefgh", notice: "TRIP_UNAVAILABLE" }) : undefined);
  await vi.waitFor(() => expect(submissions).toHaveLength(1));
  expect(screen.getByTestId("route")).toHaveTextContent("/mini-app/trips/trip_abcdefgh");
  expect(screen.getByText(/isn't available to your account/)).toBeInTheDocument();
});

it("refuses to navigate anywhere the server's appPath does not fit the Mini App shape", async () => {
  telegram();
  const { exchanges } = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "https://evil.test/" }) : undefined);
  // Not a recognised answer: the page behaves as without Telegram sign-in.
  await screen.findByRole("heading", { name: "My trips" });
  expect(screen.getByTestId("route")).toHaveTextContent("/mini-app");
  expect(exchanges()).toHaveLength(1);
});

it("takes the launch fragment out of the address bar once the SDK has read it", async () => {
  window.history.replaceState(null, "", `/mini-app#tgWebAppData=${encodeURIComponent(INIT)}&tgWebAppPlatform=ios`);
  telegram({ initData: "" });
  const { exchanges } = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app" }) : undefined);
  await screen.findByRole("heading", { name: "My trips" });
  // initData came from the fragment (the SDK object had none yet) …
  expect(exchanges()[0].body).toEqual({ initData: INIT });
  // … and the fragment is gone.
  await waitFor(() => expect(window.location.hash).toBe(""));
});

it("a reload of a launch that already signed in does not exchange again", async () => {
  telegram();
  launchMarker.write(await digestInitData(INIT));
  const { exchanges, calls } = mount("/mini-app", () => undefined);
  await screen.findByRole("heading", { name: "My trips" });
  expect(exchanges()).toHaveLength(0);
  expect(calls.some((c) => c.path === "/v1/me")).toBe(true);
});

it("a marker for a different launch does not skip the exchange, and an expired session falls back to one", async () => {
  telegram();
  launchMarker.write(await digestInitData("some-other-launch"));
  const first = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app" }) : undefined);
  await screen.findByRole("heading", { name: "My trips" });
  expect(first.exchanges()).toHaveLength(1);
  first.unmount();

  // Same launch, but the cookie session is gone: the marker alone is not trusted.
  launchMarker.write(await digestInitData(INIT));
  const second = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app" }) : undefined, { authenticated: false });
  await vi.waitFor(() => expect(second.exchanges()).toHaveLength(1));
});

it("several accounts: shows the chooser, then exchanges again with the chosen trip only", async () => {
  telegram();
  const trips = [
    { tripId: "trip_abcdefgh", title: "Rome", destination: "Italy", startDate: null, endDate: null },
    { tripId: "trip_ijklmnop", title: "Oslo", destination: null, startDate: null, endDate: null },
  ];
  const { exchanges } = mount("/mini-app", (path, init) => {
    if (path !== "/v1/auth/telegram-mini-app") return undefined;
    return JSON.parse(String(init?.body)).tripId ? json({ kind: "session", appPath: "/mini-app/trips/trip_ijklmnop" }) : json({ kind: "choose", trips });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Oslo" }));
  await vi.waitFor(() => expect(submissions).toHaveLength(1));
  expect(exchanges().map((e) => e.body)).toEqual([{ initData: INIT }, { initData: INIT, tripId: "trip_ijklmnop" }]);
  expect(screen.getByTestId("route")).toHaveTextContent("/mini-app/trips/trip_ijklmnop");
});

it("not linked, trip in context: the trip-password form with an unticked 'Next time, open with Telegram'", async () => {
  telegram();
  const { calls } = mount("/mini-app", (path, init) => {
    if (path === "/v1/auth/telegram-mini-app") return json({ error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId: "trip_abcdefgh" }, 401);
    if (path === "/v1/auth/password") return json({ appPath: JSON.parse(String(init?.body)).returnTo, telegramLink: "linked" });
    return undefined;
  }, { authenticated: false });
  const remember = await screen.findByRole("checkbox", { name: /Next time, open with Telegram/ });
  expect(remember).not.toBeChecked();
  // No email form in a Telegram launch.
  expect(screen.queryByLabelText("Email")).toBeNull();

  // Without the consent control ticked, the launch string never rides along.
  fireEvent.change(screen.getByLabelText("Trip username"), { target: { value: "  Dana " } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "member-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with trip password" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/password")).toBe(true));
  const plain = calls.find((c) => c.path === "/v1/auth/password")!;
  expect(plain.body).toEqual({ tripId: "trip_abcdefgh", returnTo: "/mini-app/trips/trip_abcdefgh", runtimeUsername: "dana", password: "member-password" });
  expect(JSON.stringify(plain.body)).not.toContain("initData");
});

it("not linked: ticking the control sends consent with the initData in the same request", async () => {
  telegram();
  const { calls } = mount("/mini-app", (path, init) => {
    if (path === "/v1/auth/telegram-mini-app") return json({ error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId: "trip_abcdefgh" }, 401);
    if (path === "/v1/auth/password") return json({ appPath: JSON.parse(String(init?.body)).returnTo, telegramLink: "linked" });
    return undefined;
  }, { authenticated: false });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Next time, open with Telegram/ }));
  fireEvent.change(screen.getByLabelText("Trip username"), { target: { value: "dana" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "member-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with trip password" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/password")).toBe(true));
  expect(calls.find((c) => c.path === "/v1/auth/password")!.body).toMatchObject({ telegramLink: { initData: INIT, consent: true } });
});

it("a link that was skipped is said out loud rather than assumed", async () => {
  telegram();
  mount("/mini-app", (path, init) => {
    if (path === "/v1/auth/telegram-mini-app") return json({ error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId: "trip_abcdefgh" }, 401);
    if (path === "/v1/auth/password") return json({ appPath: JSON.parse(String(init?.body)).returnTo, telegramLink: "skipped" });
    return undefined;
  }, { authenticated: false });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Next time, open with Telegram/ }));
  fireEvent.change(screen.getByLabelText("Trip username"), { target: { value: "dana" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "member-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with trip password" }));
  expect(await screen.findByText(/Telegram wasn't linked this time/)).toBeInTheDocument();
});

it("not linked and no trip in context: a plain message, no email form, no password form", async () => {
  telegram();
  mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ error: "TELEGRAM_NOT_LINKED", fallback: "none" }, 401) : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "Your Telegram account isn't linked to a trip yet" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.queryByLabelText("Trip username")).toBeNull();
});

it("a refused or rate-limited launch says to reopen from Telegram", async () => {
  telegram();
  mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ error: "TELEGRAM_INIT_DATA_INVALID" }, 401) : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "We couldn't verify this Telegram launch" })).toBeInTheDocument();
});

it("Telegram Web (a frame on another site) asks for the cross-site cookie variant and signs in; other platforms never do", async () => {
  for (const platform of ["weba", "webk", "web"]) {
    telegram({ platform });
    const { exchanges, unmount } = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app/trips/trip_abcdefgh" }) : undefined);
    await screen.findByRole("button", { name: "Open trip in a new tab" });
    expect(exchanges()).toHaveLength(1);
    expect(exchanges()[0].body).toEqual({ initData: INIT, embedded: true });
    unmount();
    window.sessionStorage.clear();
  }
  telegram({ platform: "ios" });
  const native = mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app" }) : undefined);
  await screen.findByRole("heading", { name: "My trips" });
  expect(native.exchanges()[0].body, "a native WebView keeps the ordinary Lax cookies").toEqual({ initData: INIT });
});

it("Telegram Web: the chooser's follow-up and the trip-password sign-in carry the same request", async () => {
  telegram({ platform: "weba" });
  const trips = [
    { tripId: "trip_abcdefgh", title: "Rome", destination: null, startDate: null, endDate: null },
    { tripId: "trip_ijklmnop", title: "Oslo", destination: null, startDate: null, endDate: null },
  ];
  const chosen = mount("/mini-app", (path, init) => {
    if (path !== "/v1/auth/telegram-mini-app") return undefined;
    return JSON.parse(String(init?.body)).tripId ? json({ kind: "session", appPath: "/mini-app/trips/trip_ijklmnop" }) : json({ kind: "choose", trips });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Oslo" }));
  await screen.findByRole("button", { name: "Open trip in a new tab" });
  expect(chosen.exchanges().map((e) => e.body)).toEqual([{ initData: INIT, embedded: true }, { initData: INIT, tripId: "trip_ijklmnop", embedded: true }]);
  chosen.unmount();
  window.sessionStorage.clear();

  const { calls } = mount("/mini-app", (path, init) => {
    if (path === "/v1/auth/telegram-mini-app") return json({ error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId: "trip_abcdefgh" }, 401);
    if (path === "/v1/auth/password") return json({ appPath: JSON.parse(String(init?.body)).returnTo });
    return undefined;
  }, { authenticated: false });
  fireEvent.change(await screen.findByLabelText("Trip username"), { target: { value: "dana" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "member-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with trip password" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/password")).toBe(true));
  expect(calls.find((c) => c.path === "/v1/auth/password")!.body).toMatchObject({ embedded: true });
});

it("Telegram Web where the browser refuses the cross-site cookie: says to use the Telegram app instead of showing a blank page", async () => {
  telegram({ platform: "weba" });
  // The exchange succeeds, but the session cookie never sticks: /v1/me is unauthorised right after.
  mount("/mini-app", (path) => path === "/v1/auth/telegram-mini-app" ? json({ kind: "session", appPath: "/mini-app" }) : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "Open Kinerary in the Telegram app" })).toBeInTheDocument();
  expect(screen.getByText(/third-party cookies/)).toBeInTheDocument();
  expect(launchMarker.read(), "a launch that did not stick is not remembered as signed in").toBeNull();
});

it("with the feature off (503) the page behaves as before: the ordinary sign-in", async () => {
  telegram();
  mount("/mini-app/trips/trip_abcdefgh", (path) => path === "/v1/auth/telegram-mini-app" ? json({ error: "TELEGRAM_MINI_APP_UNAVAILABLE" }, 503) : undefined, { authenticated: false });
  expect(await screen.findByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
});

it("outside Telegram nothing is exchanged", async () => {
  const { exchanges } = mount("/mini-app", () => undefined);
  await screen.findByRole("heading", { name: "My trips" });
  expect(exchanges()).toHaveLength(0);
});
