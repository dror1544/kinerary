import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function LocationProbe() { const location = useLocation(); return <output data-testid="route">{location.pathname}{location.search}</output>; }
function mount(route: string, authenticated = true, runtimeAllowed = false) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/v1/me") return authenticated ? json({ id: "user_existing", displayName: "Organizer" }) : json({}, 401);
    if (path === "/v1/trips") return json({ trips: [] });
    if (path.endsWith("/launch") && runtimeAllowed) return json({ runtimeOrigin: "https://runtime.example.test", framePath: "/t/trip_abcdefgh/", launchToken: "fixture-grant" });
    if (path === "/v1/auth/capabilities") return json({ emailPassword: true, google: false });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /><LocationProbe /></MemoryRouter></QueryClientProvider>);
  return { ...view, calls };
}
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { Telegram?: unknown }).Telegram; });
it("opens private account space in an ordinary browser without Telegram identity", async () => {
  mount("/mini-app?startapp=account");
  expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
  expect(screen.getByText("Your travel companion")).toBeInTheDocument();
});
it("an invalid selector never redirects to an arbitrary URL", async () => {
  const { calls } = mount("/mini-app?startapp=https://evil.test");
  expect(await screen.findByRole("heading", { name: "This launch link is unavailable" })).toBeInTheDocument();
  expect(calls).toEqual([]);
});
it("untrusted Telegram user and chat hints cannot grant trip access", async () => {
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: { platform: "ios", initDataUnsafe: { user: { id: 123 }, chat: { id: 456 } }, ready: vi.fn(), expand: vi.fn() } };
  const { calls } = mount("/mini-app?startapp=trip_abcdefgh");
  expect(await screen.findByText("This trip is not ready to open.")).toBeInTheDocument();
  expect(calls).toContain("POST /v1/trips/trip_abcdefgh/launch");
  expect(screen.queryByTitle("Kinerary trip")).toBeNull();
});
it("hands off to existing sign-in with the Mini App return path", async () => {
  window.history.replaceState(null, "", "/mini-app/trips/trip_abcdefgh");
  mount("/mini-app/trips/trip_abcdefgh", false);
  expect(await screen.findByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
  expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  expect(screen.getByTestId("route")).toHaveTextContent("/sign-in?return_to=%2Fmini-app%2Ftrips%2Ftrip_abcdefgh");
  window.history.replaceState(null, "", "/");
});
it("calls SDK presentation methods, validates styling and cleans up back events", async () => {
  const click = vi.fn(), off = vi.fn(), ready = vi.fn(), expand = vi.fn(), hide = vi.fn();
  const sdk = { platform: "android", ready, expand, themeParams: { bg_color: "#123456", text_color: "url(evil)" }, safeAreaInset: { top: 12, bottom: -100 }, contentSafeAreaInset: { top: 30, left: Infinity }, BackButton: { onClick: click, offClick: off, show: vi.fn(), hide } };
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: sdk };
  const { unmount } = mount("/mini-app/trips/trip_abcdefgh");
  await screen.findByText("This trip is not ready to open.");
  expect(ready).toHaveBeenCalled(); expect(expand).toHaveBeenCalled();
  const shell = screen.getByTestId("mini-app-shell");
  expect(shell.style.getPropertyValue("--mini-bg")).toBe("#123456");
  expect(shell.style.getPropertyValue("--mini-text")).toBe("");
  expect(shell.style.getPropertyValue("--mini-top")).toBe("30px");
  expect(shell.style.getPropertyValue("--mini-bottom")).toBe("0px");
  act(() => click.mock.calls[0][0]());
  expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
  unmount(); expect(off).toHaveBeenCalled(); expect(hide).toHaveBeenCalled();
});

it("an authorized trip launch uses the existing runtime grant and iframe", async () => {
  const { calls } = mount("/mini-app?startapp=trip_abcdefgh", true, true);
  const frame = await screen.findByTitle("Kinerary trip");
  expect(frame).toHaveAttribute("src", "https://runtime.example.test/t/trip_abcdefgh/");
  expect(frame.closest(".mini-app-shell")).toHaveClass("mini-app-trip");
  expect(calls).toContain("POST /v1/trips/trip_abcdefgh/launch");
  expect(screen.getByTestId("route")).toHaveTextContent("/mini-app/trips/trip_abcdefgh");
});
it("loads the SDK only while the Mini App entry is mounted", async () => {
  const ordinary = mount("/trips");
  await screen.findByRole("heading", { name: "My trips" });
  expect(document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')).toBeNull();
  ordinary.unmount();
  const mini = mount("/mini-app");
  await screen.findByRole("heading", { name: "My trips" });
  expect(document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')).not.toBeNull();
  const script = document.querySelector<HTMLScriptElement>('script[src="https://telegram.org/js/telegram-web-app.js"]')!;
  mini.unmount();
  expect(script.onload).toBeNull(); expect(script.onerror).toBeNull();
  expect(document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')).toBeNull();
});

function TripSwitch() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/mini-app/trips/trip_ijklmnop")}>Select another trip</button>;
}
function changingTrip(first: Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = String(input); calls.push(path);
    if (path === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (path === "/v1/trips/trip_abcdefgh/launch") return first;
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={["/mini-app/trips/trip_abcdefgh"]}><App /><TripSwitch /><LocationProbe /></MemoryRouter></QueryClientProvider>);
  return calls;
}
it("clears a previous successful runtime frame when the next selected trip is denied", async () => {
  const calls = changingTrip(Promise.resolve(json({ runtimeOrigin: "https://runtime.example.test", framePath: "/t/trip_abcdefgh/", launchToken: "fixture-first-grant" })));
  expect(await screen.findByTitle("Kinerary trip")).toHaveAttribute("src", "https://runtime.example.test/t/trip_abcdefgh/");
  fireEvent.click(screen.getByRole("button", { name: "Select another trip" }));
  await screen.findByText("This trip is not ready to open.");
  expect(calls).toContain("/v1/trips/trip_ijklmnop/launch");
  expect(screen.queryByTitle("Kinerary trip")).toBeNull();
});
it("a delayed previous-trip response cannot populate the currently denied trip", async () => {
  let resolve!: (value: Response) => void;
  const first = new Promise<Response>(complete => { resolve = complete; });
  const calls = changingTrip(first);
  await vi.waitFor(() => expect(calls).toContain("/v1/trips/trip_abcdefgh/launch"));
  fireEvent.click(screen.getByRole("button", { name: "Select another trip" }));
  await screen.findByText("This trip is not ready to open.");
  await act(async () => { resolve(json({ runtimeOrigin: "https://runtime.example.test", framePath: "/t/trip_abcdefgh/", launchToken: "fixture-delayed-grant" })); await first; });
  expect(screen.getByTestId("route")).toHaveTextContent("/mini-app/trips/trip_ijklmnop");
  expect(screen.queryByTitle("Kinerary trip")).toBeNull();
});
