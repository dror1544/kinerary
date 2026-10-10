import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

const trip = { id: "trip_abcdefgh", title: "Rome", destination: "Rome", startDate: "2027-03-01", endDate: "2027-03-09", tripType: "family", lifecycleState: "draft", nextAction: "continue_interview", permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true }, interview: null, provisioning: null, runtimeReady: false, invites: [] };
function mount(route: string, handler: (url: string, init?: RequestInit) => Response, client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => handler(String(url), init)));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => vi.unstubAllGlobals());
it("signs in an existing email account and refreshes the cached session", async () => {
  let authenticated = false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["trips"], { trips: [{ ...trip, title: "Other account private trip" }] });
  client.setQueryData(["trip", "trip_previous"], { ...trip, title: "Other account private detail" });
  mount("/sign-in?return_to=%2Ftrips%2Fnew", (url, init) => {
    if (url === "/v1/auth/capabilities") return json({ google: false, emailPassword: true });
    if (url === "/v1/me") return authenticated ? json({ id: "user_existing", displayName: "Organizer" }) : json({}, 401);
    if (url === "/v1/auth/email-password") { expect(JSON.parse(String(init?.body))).toEqual({ email: "organizer@example.test", password: "existing-password", returnTo: "/trips/new" }); authenticated = true; return json({ appPath: "/trips/new" }); }
    return json({}, 404);
  }, client);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "organizer@example.test" } });
  fireEvent.change(screen.getByLabelText("Account password"), { target: { value: "existing-password" } });
  expect(screen.queryByRole("button", { name: /google/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("heading", { name: "Start with the outline" })).toBeInTheDocument();
  expect(client.getQueryData(["trips"])).toBeUndefined();
  expect(client.getQueryData(["trip", "trip_previous"])).toBeUndefined();
});
it("keeps wrong credentials on the form with a useful error", async () => {
  mount("/sign-in", (url) => url === "/v1/auth/capabilities" ? json({ google: false, emailPassword: true }) : json({ error: "INVALID_CREDENTIALS" }, 401));
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "organizer@example.test" } });
  fireEvent.change(screen.getByLabelText("Account password"), { target: { value: "bad-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Email or password is incorrect.")).toBeInTheDocument();
});
it("creates the outline and presents a clickable returned Telegram link without a popup", async () => {
  const open = vi.spyOn(window, "open");
  const calls: string[] = [];
  mount("/trips/new", (url, init) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    if (url === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (url === "/v1/trips" && init?.method === "POST") { expect(JSON.parse(String(init.body))).toMatchObject({ destination: "Rome", tripType: "family" }); return json(trip, 201); }
    if (url === `/v1/trips/${trip.id}`) return json(trip);
    if (url.endsWith("/interview-link")) return json({ deepLink: "https://t.me/example_bot?start=fixture-token" }, 201);
    return json({}, 404);
  });
  fireEvent.change(await screen.findByLabelText("Destination"), { target: { value: "Rome" } });
  fireEvent.click(screen.getByRole("button", { name: "Create trip" }));
  expect(await screen.findByRole("heading", { name: "Rome" })).toBeInTheDocument();
  expect(screen.getByText("2027-03-01 → 2027-03-09 · Family trip")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Telegram interview" }));
  expect(await screen.findByRole("link", { name: "Open Telegram interview" })).toHaveAttribute("href", "https://t.me/example_bot?start=fixture-token");
  expect(calls.filter(call => call === "POST /v1/trips")).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});
it("shows interview failure without claiming a link exists", async () => {
  mount(`/trips/${trip.id}`, (url) => url === "/v1/me" ? json({ id: "user_existing", displayName: "Organizer" }) : url.endsWith("/interview-link") ? json({ error: "UNAVAILABLE" }, 503) : json(trip));
  fireEvent.click(await screen.findByRole("button", { name: "Prepare Telegram interview" }));
  expect(await screen.findByText("UNAVAILABLE")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open Telegram interview" })).toBeNull();
});

it("keeps the new trip outline when creation fails", async () => {
  mount("/trips/new", (url) => url === "/v1/me" ? json({ id: "user_existing", displayName: "Organizer" }) : json({ message: "Please retry creating your trip." }, 503));
  fireEvent.change(await screen.findByLabelText("Destination"), { target: { value: "Rome" } });
  fireEvent.click(screen.getByRole("button", { name: "Create trip" }));
  expect(await screen.findByText("Please retry creating your trip.")).toBeInTheDocument();
  expect(screen.getByLabelText("Destination")).toHaveValue("Rome");
});

it("a password invitation stays usable without an unavailable Google choice", async () => {
  const payloads: unknown[] = [];
  mount("/join#token=invite-fixture", (url, init) => {
    if (url === "/v1/auth/capabilities") return json({ google: false, emailPassword: true });
    if (url === "/v1/site-invites/inspect") return json({ tripTitle: "Rome", displayName: "Guest", status: "unused" });
    if (url === "/v1/site-invites/redeem") { payloads.push(JSON.parse(String(init?.body))); return json({ error: "INVITE_UNAVAILABLE" }, 409); }
    return json({}, 404);
  });
  fireEvent.change(await screen.findByLabelText("Choose a password"), { target: { value: "guest-password" } });
  expect(screen.queryByRole("button", { name: "Use Google" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Join this trip" }));
  expect(await screen.findByText("INVITE_UNAVAILABLE")).toBeInTheDocument();
  expect(payloads).toEqual([{ token: "invite-fixture", method: "password", password: "guest-password" }]);
});
it("a configured Google provider remains available for an invitation", async () => {
  mount("/join#token=invite-fixture", (url) => url === "/v1/auth/capabilities" ? json({ google: true, emailPassword: true }) : json({ tripTitle: "Rome", displayName: "Guest", status: "unused" }));
  expect(await screen.findByRole("button", { name: "Use Google" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use a password" })).toBeInTheDocument();
});
