import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

/**
 * Slice S3 of docs/specs/sprint-9/x-member-sign-in.md ("Send me a sign-in link", #614), the screens: the request form on the
 * sign-in screens a member sees (the portal's /sign-in, and the Mini App's trip-password view), and the page the link opens.
 */
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function Probe() { return <output data-testid="route">{useLocation().pathname}</output>; }

type Call = { method: string; path: string; body: Record<string, unknown> | null };
type Handler = (path: string, init?: RequestInit) => Response | undefined;
function mount(route: string, handler?: Handler, options: { signedIn?: boolean } = {}) {
  const calls: Call[] = [];
  let signedIn = options.signedIn ?? false;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    calls.push({ method: init?.method || "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const custom = handler?.(path, init);
    if (custom) { if (custom.ok && path === "/v1/auth/sign-in-link/redeem") signedIn = true; return custom; }
    if (path === "/v1/auth/capabilities") return json({ google: false, emailPassword: true, emailSignUp: true });
    if (path === "/v1/me") return signedIn ? json({ id: "user_1", displayName: "Dana", scope: "full" }) : json({ error: "AUTHENTICATION_REQUIRED" }, 401);
    if (path === "/v1/trips") return json({ trips: [] });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[route]}><App /><Probe /></MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}
beforeEach(() => { window.history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const NEUTRAL = /If we found your account, a link is on its way/;
const TRIP = "trip_abcdefgh12";
const requests = (calls: Call[]) => calls.filter((c) => c.path === "/v1/auth/sign-in-link");

it("the portal sign-in for a trip offers 'Send me a sign-in link' by traveller name, and shows one neutral confirmation", async () => {
  const calls = mount(`/sign-in?return_to=/trips/${TRIP}/app`, (path) => path === "/v1/auth/sign-in-link" ? json({ status: "request_received" }, 202) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Send me a sign-in link" }));
  fireEvent.change(screen.getByLabelText(/Your name on this trip/), { target: { value: "  Dana Levi " } });
  fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
  expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  expect(requests(calls)).toHaveLength(1);
  expect(requests(calls)[0]!.method).toBe("POST");
  expect(requests(calls)[0]!.body).toEqual({ tripId: TRIP, travellerName: "Dana Levi" });
});

it("the confirmation is the same whatever the server did: a refusal, a rate limit, an outage, a rejected request", async () => {
  for (const response of [json({ error: "SIGN_IN_RATE_LIMITED" }, 429), json({ error: "ORIGIN_INVALID" }, 403), json({ error: "INVALID_REQUEST" }, 400), json({}, 500)]) {
    const view = mount(`/sign-in?return_to=/trips/${TRIP}/app`, (path) => path === "/v1/auth/sign-in-link" ? response.clone() : undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Send me a sign-in link" }));
    fireEvent.change(screen.getByLabelText(/Your name on this trip/), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/rate|origin|invalid|too many|error|failed/i);
    void view;
    cleanup(); vi.unstubAllGlobals();
  }
});

it("the portal sign-in with no trip in it asks for the email instead, and sends { email, language }", async () => {
  const calls = mount("/sign-in", (path) => path === "/v1/auth/sign-in-link" ? json({ status: "request_received" }, 202) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Send me a sign-in link" }));
  expect(screen.queryByLabelText(/Your name on this trip/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Your email"), { target: { value: "dana@mail.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
  expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  expect(requests(calls)[0]!.body).toEqual({ email: "dana@mail.example.test", language: "en" });
});

it("a person on a trip's sign-in can switch to their email, and back", async () => {
  const calls = mount(`/sign-in?return_to=/trips/${TRIP}/app`, (path) => path === "/v1/auth/sign-in-link" ? json({ status: "request_received" }, 202) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Send me a sign-in link" }));
  fireEvent.click(screen.getByRole("button", { name: "Use my email instead" }));
  fireEvent.change(screen.getByLabelText("Your email"), { target: { value: "dana@mail.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
  expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  expect(requests(calls)[0]!.body).toEqual({ email: "dana@mail.example.test", language: "en" });
});

// ── the Mini App's not-linked view ─────────────────────────────────────────


const INIT = "query_id=AAH&user=%7B%22id%22%3A1%7D&auth_date=1&hash=abc";
function telegram() {
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: { platform: "ios", initData: INIT, initDataUnsafe: {}, ready: vi.fn(), expand: vi.fn() } };
}
it("the Mini App's trip-password view offers it too, by name, for that trip", async () => {
  telegram();
  try {
    const calls = mount("/mini-app/trips/" + TRIP, (path) => {
      if (path === "/v1/auth/telegram-mini-app") return json({ error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId: TRIP }, 401);
      if (path === "/v1/auth/sign-in-link") return json({ status: "request_received" }, 202);
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Send me a sign-in link" }, { timeout: 5000 }));
    fireEvent.change(screen.getByLabelText(/Your name on this trip/), { target: { value: "Noam Levi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(requests(calls)[0]!.body).toEqual({ tripId: TRIP, travellerName: "Noam Levi" });
  } finally { delete (window as unknown as { Telegram?: unknown }).Telegram; }
});

// ── the page the link opens ────────────────────────────────────────────────

const TOKEN = `sl_${"A".repeat(43)}`;
const redeemCalls = (calls: Call[]) => calls.filter((c) => c.path === "/v1/auth/sign-in-link/redeem");

it("opening the link does NOT spend it: nothing is posted until the person presses the button, and the token leaves the address bar", async () => {
  window.history.replaceState(null, "", `/sign-in-link#token=${TOKEN}`);
  const calls = mount(`/sign-in-link#token=${TOKEN}`);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(redeemCalls(calls)).toHaveLength(0);
  expect(window.location.hash).toBe("");
  expect(window.location.href).not.toContain(TOKEN);
});

it("pressing Sign in posts the token, then goes where the server says when there is no password to set", async () => {
  const calls = mount(`/sign-in-link#token=${TOKEN}`, (path) => path === "/v1/auth/sign-in-link/redeem" ? json({ appPath: "/trips", canSetPassword: false }) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/trips"));
  expect(redeemCalls(calls)).toHaveLength(1);
  expect(redeemCalls(calls)[0]!.method).toBe("POST");
  expect(redeemCalls(calls)[0]!.body).toEqual({ token: TOKEN });
});

it("when the account has a password to replace, it offers to set a new one: once, and the person can skip", async () => {
  const calls = mount(`/sign-in-link#token=${TOKEN}`, (path) => {
    if (path === "/v1/auth/sign-in-link/redeem") return json({ appPath: "/trips", canSetPassword: true });
    if (path === "/v1/auth/sign-in-link/password") return json({ ok: true });
    return undefined;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("heading", { name: /Set a new password/ })).toBeInTheDocument();
  expect(screen.getByTestId("route")).toHaveTextContent("/sign-in-link");
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a brand new passphrase" } });
  fireEvent.change(screen.getByLabelText("Repeat it"), { target: { value: "a different one entirely" } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(await screen.findByText(/don't match/)).toBeInTheDocument();
  expect(calls.filter((c) => c.path === "/v1/auth/sign-in-link/password")).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Repeat it"), { target: { value: "a brand new passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/trips"));
  expect(calls.filter((c) => c.path === "/v1/auth/sign-in-link/password")[0]!.body).toEqual({ password: "a brand new passphrase" });
});

it("'Skip for now' goes on without setting anything", async () => {
  const calls = mount(`/sign-in-link#token=${TOKEN}`, (path) => path === "/v1/auth/sign-in-link/redeem" ? json({ appPath: "/trips", canSetPassword: true }) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/trips"));
  expect(calls.filter((c) => c.path === "/v1/auth/sign-in-link/password")).toHaveLength(0);
});

it("a used, expired or unknown link says one thing and points back to the sign-in screen, never why", async () => {
  mount(`/sign-in-link#token=${TOKEN}`, (path) => path === "/v1/auth/sign-in-link/redeem" ? json({ error: "TOKEN_INVALID" }, 400) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /sign-in screen/ })).toHaveAttribute("href", "/sign-in");
});

it("an incomplete link (no token) says so and offers nothing to press", async () => {
  const calls = mount("/sign-in-link");
  expect(await screen.findByText(/incomplete/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(redeemCalls(calls)).toHaveLength(0);
});
