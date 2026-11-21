/**
 * The join page for a PERSONAL INVITE for an existing traveller (docs/specs/sprint-9/x-member-sign-in.md, slice S2, AC-13).
 *
 * The page is the one every site invite already uses (`/join#token=`): the invite names a participant that already exists, and
 * the page does not know or care. These tests pin what AC-13 promises, so that nobody "improves" it into something that reads
 * per-trip Google configuration:
 *   - Google AND a password are offered, and which Google is the dashboard origin's (capabilities), never a trip's;
 *   - redeeming with Google asks the server to use the Google session the dashboard's own client already made: the page sends the
 *     token and the word "google", no ID token, no client id, no trip configuration;
 *   - a visitor with no Google session yet is taken to the dashboard's sign-in and brought back to this very link;
 *   - nothing is requested but the capabilities, the invite and the redemption.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

const TOKEN = "personal-invite-token";
const DASHBOARD_GOOGLE = { google: true, googleClientId: "dashboard-client.apps.googleusercontent.com", emailPassword: true };
function Where() { const location = useLocation(); return <output data-testid="where">{location.pathname}{location.search}</output>; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(handler: (url: string, init?: RequestInit) => Response) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { urls.push(`${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`); return handler(String(url), init); }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/join#token=${TOKEN}`]}><App /><Where /></MemoryRouter>
    </QueryClientProvider>,
  );
  return urls;
}
const inspect = { tripTitle: "Alsace in December", displayName: "Dana Levi", status: "unused" };
beforeEach(() => vi.unstubAllGlobals());

it("names the traveller the invite is for, and offers Google (the dashboard's) and a password", async () => {
  mount((url) => (url === "/v1/auth/capabilities" ? json(DASHBOARD_GOOGLE) : url === "/v1/site-invites/inspect" ? json(inspect) : json({}, 404)));
  expect(await screen.findByText("This invitation is intended for Dana Levi.")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Join Alsace in December" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use Google" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use a password" })).toBeInTheDocument();
});

it("with a password: sends the token, the word 'password' and the password, and nothing about Google; then opens the trip", async () => {
  const bodies: unknown[] = [];
  const urls = mount((url, init) => {
    if (url === "/v1/auth/capabilities") return json(DASHBOARD_GOOGLE);
    if (url === "/v1/site-invites/inspect") return json(inspect);
    if (url === "/v1/site-invites/redeem") { bodies.push(JSON.parse(String(init?.body))); return json({ status: "redeemed", tripId: "trip_abcdefgh", appPath: "/trips/trip_abcdefgh/app" }); }
    return json({}, 404);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Use a password" }));
  fireEvent.change(await screen.findByLabelText("Choose a password"), { target: { value: "dana-own-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Join this trip" }));
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trips/trip_abcdefgh/app"));
  expect(bodies).toEqual([{ token: TOKEN, method: "password", password: "dana-own-password" }]);
  expect(urls.filter((u) => !/capabilities|site-invites\/(inspect|redeem)|\/v1\/me$/.test(u) && !u.includes("/trips/trip_abcdefgh"))).toEqual([]);
});

it("with Google: asks the server to use the dashboard's Google session (token and 'google' only: no ID token, no client id, no trip setting), and opens the trip", async () => {
  const bodies: unknown[] = [];
  const urls = mount((url, init) => {
    if (url === "/v1/auth/capabilities") return json(DASHBOARD_GOOGLE);
    if (url === "/v1/site-invites/inspect") return json(inspect);
    if (url === "/v1/site-invites/redeem") { bodies.push(JSON.parse(String(init?.body))); return json({ status: "redeemed", tripId: "trip_abcdefgh", appPath: "/trips/trip_abcdefgh/app" }); }
    return json({}, 404);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Join this trip" }));
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trips/trip_abcdefgh/app"));
  expect(bodies).toEqual([{ token: TOKEN, method: "google" }]);
  expect(JSON.stringify(bodies)).not.toMatch(/client|idToken|credential/i);
  expect(urls.some((u) => /\/t\/|trip\.config|\/api\/config/.test(u))).toBe(false);
});

it("a visitor with no Google session yet is sent to the dashboard's sign-in, and brought back to this very link", async () => {
  mount((url) => {
    if (url === "/v1/auth/capabilities") return json(DASHBOARD_GOOGLE);
    if (url === "/v1/site-invites/inspect") return json(inspect);
    if (url === "/v1/site-invites/redeem") return json({ error: "GOOGLE_SIGN_IN_REQUIRED" }, 401);
    return json({}, 404);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Join this trip" }));
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/sign-in?return_to=${encodeURIComponent(`/join#token=${TOKEN}`)}`));
});

it("a refusal is shown to the person (not swallowed), and the invitation can be used again", async () => {
  let refuse = true;
  mount((url) => {
    if (url === "/v1/auth/capabilities") return json(DASHBOARD_GOOGLE);
    if (url === "/v1/site-invites/inspect") return json(inspect);
    if (url === "/v1/site-invites/redeem") return refuse ? json({ error: "INVITE_UNAVAILABLE" }, 409) : json({ status: "redeemed", tripId: "trip_abcdefgh", appPath: "/trips/trip_abcdefgh/app" });
    return json({}, 404);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Join this trip" }));
  expect(await screen.findByText("INVITE_UNAVAILABLE")).toBeInTheDocument();
  expect(screen.getByTestId("where").textContent).toBe("/join");
  refuse = false;
  fireEvent.click(screen.getByRole("button", { name: "Join this trip" }));
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trips/trip_abcdefgh/app"));
});

it("an invitation that is no longer unused cannot be joined", async () => {
  mount((url) => (url === "/v1/auth/capabilities" ? json(DASHBOARD_GOOGLE) : url === "/v1/site-invites/inspect" ? json({ ...inspect, status: "redeemed" }) : json({}, 404)));
  expect(await screen.findByRole("button", { name: "Join this trip" })).toBeDisabled();
});
