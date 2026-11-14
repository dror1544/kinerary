import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

const trip = { id: "trip_abcdefgh", title: "Rome", destination: "Rome", startDate: "2027-03-01", endDate: "2027-03-09", tripType: "family", lifecycleState: "draft", nextAction: "continue_interview", permissions: { role: "owner", dashboard: true, runtime: true, invite: true, requestProvisioning: true }, interview: null, provisioning: null, runtimeReady: false, invites: [] };
function CurrentPath({ destination }: { destination?: string }) { return <><output data-testid="current-path">{useLocation().pathname}</output>{destination && <Link to={destination}>Review another trip</Link>}</>; }
function mount(route: string, handler: (url: string, init?: RequestInit) => Response, client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }), destination?: string) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => handler(String(url), init)));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /><CurrentPath destination={destination} /></MemoryRouter></QueryClientProvider>);
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

it("offers explicit replacement only for a lost unused link and submits its expected id", async () => {
  const replacements: unknown[] = [];
  mount(`/trips/${trip.id}`, (url, init) => {
    if (url === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (url.endsWith('/interview-link/replace')) { replacements.push(JSON.parse(String(init?.body))); return json({ deepLink: 'https://t.me/example_bot?start=replacement' }, 201); }
    if (url.endsWith('/interview-link')) return init?.method === 'POST' ? json({ error: 'ACTIVE_ENROLLMENT_EXISTS' }, 409) : json({ activeEnrollment: { id: 'enrl_abcdefgh', expiresAt: '2027-03-01' }, recoverable: true, hasInterview: false, telegramChatUrl: 'https://t.me/example_bot' });
    return json(trip);
  });
  expect(screen.queryByRole('button', { name: 'Replace lost interview link' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare Telegram interview' }));
  const replace = await screen.findByRole('button', { name: 'Replace lost interview link' });
  expect(screen.getByText(/Replacing invalidates the previous unused link/)).toBeInTheDocument();
  expect(replacements).toHaveLength(0);
  fireEvent.click(replace);
  expect(await screen.findByRole('link', { name: 'Open Telegram interview' })).toHaveAttribute('href', 'https://t.me/example_bot?start=replacement');
  expect(replacements).toEqual([{ expectedEnrollmentId: 'enrl_abcdefgh' }]);
});
it("directs an existing interview to its chat without offering replacement", async () => {
  mount(`/trips/${trip.id}`, url => url === '/v1/me' ? json({ id: 'user_existing', displayName: 'Organizer' }) : url.endsWith('/interview-link') ? json({ activeEnrollment: null, recoverable: false, hasInterview: true, telegramChatUrl: 'https://t.me/example_bot' }) : json({ ...trip, lifecycleState: 'intake_in_progress', interview: { sessionId: 'sess_existing', state: 'interviewing' } }));
  expect(await screen.findByRole('link', { name: 'Continue in Telegram' })).toHaveAttribute('href', 'https://t.me/example_bot');
  expect(screen.queryByRole('button', { name: 'Replace lost interview link' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Prepare Telegram interview' })).toBeNull();
});
// #513 AC-1: an interview that closed for idleness is paused. The page says so and offers a NEW link; it does not send
// the organizer to "Continue in Telegram" (a chat that has stopped listening) or to "Replace lost interview link".
it("a paused interview offers a new link, not Continue in Telegram or Replace, and shows the issued link", async () => {
  const posts: string[] = [];
  mount(`/trips/${trip.id}`, (url, init) => {
    if (url === '/v1/me') return json({ id: 'user_existing', displayName: 'Organizer' });
    if (url.endsWith('/interview-link')) {
      if (init?.method === 'POST') { posts.push(url); return json({ enrollmentId: 'enrl_abcdefgh', deepLink: 'https://t.me/example_bot?start=resume-token', expiresAt: '2027-03-01' }, 201); }
      return json({ activeEnrollment: null, recoverable: false, hasInterview: false, telegramChatUrl: 'https://t.me/example_bot' });
    }
    return json({ ...trip, lifecycleState: 'intake_in_progress', interview: { sessionId: 'sess_existing', state: 'interviewing', paused: true } });
  });
  const button = await screen.findByRole('button', { name: 'Get a new interview link' });
  expect(screen.getByText(/Your interview is paused/)).toBeInTheDocument();
  expect(screen.getByText(/Interview paused/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Continue in Telegram' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Replace lost interview link' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Prepare Telegram interview' })).toBeNull();
  fireEvent.click(button);
  expect(await screen.findByRole('link', { name: 'Open Telegram interview' })).toHaveAttribute('href', 'https://t.me/example_bot?start=resume-token');
  expect(posts).toEqual([`/v1/trips/${trip.id}/interview-link`]);
  expect(screen.queryByRole('button', { name: 'Get a new interview link' })).toBeNull();
});
it("a live interview still says Continue in Telegram, and a Telegram-minted session is not offered the paused button", async () => {
  mount(`/trips/${trip.id}`, url => url === '/v1/me' ? json({ id: 'user_existing', displayName: 'Organizer' }) : url.endsWith('/interview-link') ? json({ activeEnrollment: null, recoverable: false, hasInterview: true, telegramChatUrl: 'https://t.me/example_bot' }) : json({ ...trip, lifecycleState: 'intake_in_progress', interview: { sessionId: 'sess_existing', state: 'interviewing', paused: false } }));
  expect(await screen.findByRole('link', { name: 'Continue in Telegram' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Get a new interview link' })).toBeNull();
});
it("a session minted by Telegram is not offered the new-link button for a paused interview", async () => {
  mount(`/trips/${trip.id}`, url => url === '/v1/me' ? json({ id: 'user_existing', displayName: 'Organizer', scope: 'telegram' }) : url.endsWith('/interview-link') ? json({ activeEnrollment: null, recoverable: false, hasInterview: false, telegramChatUrl: 'https://t.me/example_bot' }) : json({ ...trip, lifecycleState: 'intake_in_progress', interview: { sessionId: 'sess_existing', state: 'interviewing', paused: true } }));
  expect(await screen.findByText(/to prepare or replace an interview link, sign in with your password/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Get a new interview link' })).toBeNull();
});
it("offers ordinary preparation after the conflicting link has expired", async () => {
  mount(`/trips/${trip.id}`, (url, init) => url === '/v1/me' ? json({ id: 'user_existing', displayName: 'Organizer' }) : url.endsWith('/interview-link') ? init?.method === 'POST' ? json({ error: 'ACTIVE_ENROLLMENT_EXISTS' }, 409) : json({ activeEnrollment: null, recoverable: false, hasInterview: false, telegramChatUrl: 'https://t.me/example_bot' }) : json(trip));
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare Telegram interview' }));
  expect(await screen.findByText('The previous link is no longer active. Prepare a new interview link.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prepare Telegram interview' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replace lost interview link' })).toBeNull();
});
it("offers member password sign-in for a Mini App trip return path", async () => {
  mount('/sign-in?return_to=%2Fmini-app%2Ftrips%2Ftrip_abcdefgh', url => url === '/v1/auth/capabilities' ? json({ google: false, emailPassword: true }) : json({}, 401));
  expect(await screen.findByLabelText('Trip username')).toBeInTheDocument();
});

it("member password login preserves the Mini App trip return path", async () => {
  let loggedIn = false;
  const returnTo = '/mini-app/trips/trip_abcdefgh';
  mount('/sign-in?return_to=' + encodeURIComponent(returnTo), (url, init) => {
    if (url === '/v1/auth/capabilities') return json({ google: false, emailPassword: true });
    if (url === '/v1/me') return loggedIn ? json({ id: 'user_member', displayName: 'Member' }) : json({}, 401);
    if (url === '/v1/auth/password') {
      expect(JSON.parse(String(init?.body))).toEqual({ tripId: trip.id, runtimeUsername: 'member', password: 'member-password', returnTo });
      loggedIn = true; return json({ appPath: returnTo });
    }
    return json(trip);
  });
  fireEvent.change(await screen.findByLabelText('Trip username'), { target: { value: 'member' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'member-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue with trip password' }));
  await screen.findByText(returnTo, { selector: 'output' });
});

it.each([false, true])("does not carry an issued or replaced link into another trip (replacement=%s)", async (replacement) => {
  const other = { ...trip, id: 'trip_ijklmnop', title: 'Another destination' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mount(`/trips/${trip.id}`, (url, init) => {
    if (url === '/v1/me') return json({ id: 'user_existing', displayName: 'Organizer' });
    if (url === `/v1/trips/${other.id}`) return json(other);
    if (url.endsWith('/interview-link/replace')) return json({ deepLink: 'https://t.me/example_bot?start=private-trip-a' }, 201);
    if (url.endsWith('/interview-link')) return init?.method === 'POST' ? replacement ? json({ error: 'ACTIVE_ENROLLMENT_EXISTS' }, 409) : json({ deepLink: 'https://t.me/example_bot?start=private-trip-a' }, 201) : json({ activeEnrollment: { id: 'enrl_abcdefgh', expiresAt: '2027-03-01' }, recoverable: true, hasInterview: false, telegramChatUrl: 'https://t.me/example_bot' });
    return json(trip);
  }, client, `/trips/${other.id}/setup`);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare Telegram interview' }));
  if (replacement) fireEvent.click(await screen.findByRole('button', { name: 'Replace lost interview link' }));
  expect(await screen.findByRole('link', { name: 'Open Telegram interview' })).toHaveAttribute('href', 'https://t.me/example_bot?start=private-trip-a');
  fireEvent.click(screen.getByRole('link', { name: 'Review another trip' }));
  expect(await screen.findByRole('heading', { name: 'Another destination' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open Telegram interview' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Replace lost interview link' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Prepare Telegram interview' })).toBeInTheDocument();
});
it("a stale replacement refreshes metadata and reports conflict without rotating again automatically", async () => {
  let replacements = 0;
  mount(`/trips/${trip.id}`, (url, init) => {
    if (url === '/v1/me') return json({ id: 'user_existing', displayName: 'Organizer' });
    if (url.endsWith('/interview-link/replace')) { replacements++; return json({ error: 'ENROLLMENT_NOT_REPLACEABLE' }, 409); }
    if (url.endsWith('/interview-link')) return init?.method === 'POST' ? json({ error: 'ACTIVE_ENROLLMENT_EXISTS' }, 409) : json({ activeEnrollment: { id: replacements ? 'enrl_ijklmnop' : 'enrl_abcdefgh', expiresAt: '2027-03-01' }, recoverable: true, hasInterview: false, telegramChatUrl: 'https://t.me/example_bot' });
    return json(trip);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare Telegram interview' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Replace lost interview link' }));
  expect(await screen.findByText('This link changed or was already used. Check the trip status before continuing.')).toBeInTheDocument();
  expect(replacements).toBe(1);
  expect(screen.queryByRole('link', { name: 'Open Telegram interview' })).toBeNull();
});
const failedTrip = { ...trip, lifecycleState: "provisioning_approved", nextAction: "retry_provisioning", provisioning: { planId: "plan_abcdefgh", planStatus: "superseded", jobState: "failed", releaseId: null, digest: "sha256:abc", safeErrorCode: "PROVISIONER_ERROR" } };
it("a build that failed for good says so in plain words, hides the error code, and Try again re-runs it", async () => {
  let retried = 0;
  mount(`/trips/${trip.id}/setup`, (url, init) => {
    if (url === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (url === `/v1/trips/${trip.id}/provisioning-retry` && init?.method === "POST") { retried++; return json({ planId: "plan_new", planStatus: "approved", jobId: "job_new" }, 201); }
    if (url === `/v1/trips/${trip.id}`) return json(retried ? { ...failedTrip, nextAction: "track_provisioning", provisioning: { ...failedTrip.provisioning, planStatus: "approved", jobState: "queued", safeErrorCode: null } } : failedTrip);
    return json({}, 404);
  });
  expect(await screen.findByText(/We couldn't finish building your trip site\. This is usually temporary\./)).toBeInTheDocument();
  expect(screen.queryByText(/Provisioner error/i)).toBeNull();
  expect(screen.queryByText(/PROVISIONER_ERROR/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(retried).toBe(1));
  // The page moves on to following the new build; the failure notice is gone.
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
  expect(screen.queryByText(/We couldn't finish building/)).toBeNull();
});
it("a failed Try again is reported without the raw error code", async () => {
  mount(`/trips/${trip.id}/setup`, (url, init) => {
    if (url === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (url === `/v1/trips/${trip.id}/provisioning-retry` && init?.method === "POST") return json({ error: "NO_COMPATIBLE_RELEASE" }, 422);
    if (url === `/v1/trips/${trip.id}`) return json(failedTrip);
    return json({}, 404);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/We couldn't start it again just now/)).toBeInTheDocument();
  expect(screen.queryByText(/NO_COMPATIBLE_RELEASE/)).toBeNull();
});
it("offers no Try again button to someone who is not the trip's owner", async () => {
  mount(`/trips/${trip.id}/setup`, (url) => {
    if (url === "/v1/me") return json({ id: "user_existing", displayName: "Organizer" });
    if (url === `/v1/trips/${trip.id}`) return json({ ...failedTrip, permissions: { ...trip.permissions, role: "organizer", requestProvisioning: false } });
    return json({}, 404);
  });
  expect(await screen.findByText(/We couldn't finish building your trip site/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});
