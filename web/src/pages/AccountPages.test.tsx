import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function Probe() { return <output data-testid="route">{useLocation().pathname}</output>; }

type Call = { method: string; path: string; body: Record<string, unknown> | null };
function mount(route: string, options: { capabilities?: Record<string, unknown>; signedIn?: boolean; handler?: (path: string, init?: RequestInit) => Response | undefined } = {}) {
  const calls: Call[] = [];
  let signedIn = options.signedIn ?? false;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    calls.push({ method: init?.method || "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const custom = options.handler?.(path, init);
    if (custom) { if (custom.ok && /verify-email|password\/reset/.test(path)) signedIn = true; return custom; }
    if (path === "/v1/auth/capabilities") return json(options.capabilities ?? { google: false, emailPassword: true, emailSignUp: true });
    if (path === "/v1/me") return signedIn ? json({ id: "user_1", displayName: "Dana", scope: "full" }) : json({ error: "AUTHENTICATION_REQUIRED" }, 401);
    if (path === "/v1/trips") return json({ trips: [] });
    return json({ error: "NOT_FOUND" }, 404);
  }));
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <MemoryRouter initialEntries={[route]}><App /><Probe /></MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const field = (label: RegExp | string) => screen.getByLabelText(label);

it("sign-up posts the details with the returnTo it arrived with, then shows 'check your email' (no account is claimed yet)", async () => {
  const calls = mount("/sign-up?returnTo=/trips/new", {
    handler: (path) => path === "/v1/auth/sign-up" ? json({ status: "check_your_email" }, 202) : undefined,
  });
  await screen.findByLabelText("Email");
  fireEvent.change(field("Your name"), { target: { value: "Dana Organizer" } });
  fireEvent.change(field("Email"), { target: { value: "dana@mail.example.test" } });
  expect(screen.queryByLabelText("Password")).toBeNull();   // the password is chosen on the page the emailed link opens
  fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
  expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  expect(screen.getByText("dana@mail.example.test")).toBeInTheDocument();
  const sent = calls.find((c) => c.path === "/v1/auth/sign-up")!;
  expect(sent.method).toBe("POST");
  expect(sent.body).toEqual({ displayName: "Dana Organizer", email: "dana@mail.example.test", returnTo: "/trips/new", language: "en" });
  expect(screen.getByTestId("route")).toHaveTextContent("/sign-up");
});

it("sign-up says 'Sign-up isn't open yet' when the server has no email configured, and never shows the form", async () => {
  mount("/sign-up", { capabilities: { google: false, emailPassword: true, emailSignUp: false } });
  expect(await screen.findByRole("heading", { name: "Sign-up isn't open yet" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in?return_to=%2Ftrips");
});

it("a 503 SIGN_UP_UNAVAILABLE from the server turns the page into the same closed state", async () => {
  mount("/sign-up", { handler: (path) => path === "/v1/auth/sign-up" ? json({ error: "SIGN_UP_UNAVAILABLE" }, 503) : undefined });
  await screen.findByLabelText("Email");
  fireEvent.change(field("Your name"), { target: { value: "D" } });
  fireEvent.change(field("Email"), { target: { value: "d@mail.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
  expect(await screen.findByRole("heading", { name: "Sign-up isn't open yet" })).toBeInTheDocument();
});

it("a rate-limit or short-password refusal is shown on the form, not swallowed", async () => {
  mount("/sign-up", { handler: (path) => path === "/v1/auth/sign-up" ? json({ error: "SIGN_UP_RATE_LIMITED" }, 429) : undefined });
  await screen.findByLabelText("Email");
  fireEvent.change(field("Your name"), { target: { value: "D" } });
  fireEvent.change(field("Email"), { target: { value: "d@mail.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Too many requests/);
  expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
});

const choose = (password: string, repeat = password) => {
  fireEvent.change(field("Password"), { target: { value: password } });
  fireEvent.change(field("Repeat it"), { target: { value: repeat } });
  fireEvent.click(screen.getByRole("button", { name: "Create account and sign in" }));
};

it("opening the verify link spends NOTHING; only the submit sends the token with the chosen password, once, and the address is scrubbed", async () => {
  const calls = mount("/verify-email#token=ev_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", {
    handler: (path) => path === "/v1/auth/verify-email" ? json({ appPath: "/trips/new" }) : undefined,
  });
  expect(await screen.findByRole("heading", { name: "Choose your password" })).toBeInTheDocument();
  expect(window.location.hash).toBe("");
  // Settled, rendered, StrictMode double-run done: still no call that could spend the token.
  expect(calls.some((c) => c.path === "/v1/auth/verify-email")).toBe(false);
  choose("a brand new passphrase");
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/trips/new"));
  const verifies = calls.filter((c) => c.path === "/v1/auth/verify-email");
  expect(verifies).toHaveLength(1);
  expect(verifies[0]!.method).toBe("POST");
  expect(verifies[0]!.body).toEqual({ token: "ev_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", password: "a brand new passphrase" });
});

it("two different passwords are refused on the page, before anything is sent; a too-short one from the server keeps the form (the link is not burned)", async () => {
  const calls = mount("/verify-email#token=ev_keep", {
    handler: (path) => path === "/v1/auth/verify-email" ? json({ error: "PASSWORD_TOO_SHORT" }, 400) : undefined,
  });
  await screen.findByRole("heading", { name: "Choose your password" });
  choose("a brand new passphrase", "something else entirely");
  expect(await screen.findByRole("alert")).toHaveTextContent("don't match");
  expect(calls.some((c) => c.path === "/v1/auth/verify-email")).toBe(false);
  choose("longenough");
  await waitFor(() => expect(calls.filter((c) => c.path === "/v1/auth/verify-email")).toHaveLength(1));
  expect(await screen.findByRole("alert")).toHaveTextContent("at least 8 characters");
  expect(screen.getByRole("heading", { name: "Choose your password" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create account and sign in" })).toBeEnabled();
});

it("the verify page also reads a ?token= query, and a refused token says so with a way forward", async () => {
  const calls = mount("/verify-email?token=ev_fromquery", {
    handler: (path) => path === "/v1/auth/verify-email" ? json({ error: "TOKEN_INVALID" }, 400) : undefined,
  });
  await screen.findByRole("heading", { name: "Choose your password" });
  choose("a brand new passphrase");
  expect(await screen.findByRole("heading", { name: "This link didn't work" })).toBeInTheDocument();
  expect(calls.find((c) => c.path === "/v1/auth/verify-email")!.body).toEqual({ token: "ev_fromquery", password: "a brand new passphrase" });
  expect(screen.getByRole("link", { name: "Start sign-up again" })).toHaveAttribute("href", "/sign-up");
});

it("the verify page with no token never calls the server and never shows the form", async () => {
  const calls = mount("/verify-email");
  expect(await screen.findByRole("heading", { name: "This link didn't work" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(calls.some((c) => c.path === "/v1/auth/verify-email")).toBe(false);
});

it("a token spent after the address got an account some other way says so and offers sign-in and reset", async () => {
  mount("/verify-email#token=ev_x", { handler: (path) => path === "/v1/auth/verify-email" ? json({ error: "ACCOUNT_EXISTS" }, 409) : undefined });
  await screen.findByRole("heading", { name: "Choose your password" });
  choose("a brand new passphrase");
  expect(await screen.findByRole("heading", { name: "You already have an account" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "reset your password" })).toHaveAttribute("href", "/forgot-password");
});

it("forgot-password gives one answer whatever the address, and closes when email is unconfigured", async () => {
  const calls = mount("/forgot-password", { handler: (path) => path === "/v1/auth/password/forgot" ? json({ status: "check_your_email" }, 202) : undefined });
  await screen.findByLabelText("Email");
  fireEvent.change(field("Email"), { target: { value: "anyone@mail.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
  expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  expect(screen.getByText(/If there's an account for/)).toBeInTheDocument();
  expect(calls.find((c) => c.path === "/v1/auth/password/forgot")!.body).toEqual({ email: "anyone@mail.example.test", language: "en" });
});

it("forgot-password says it isn't open when the server has no email", async () => {
  mount("/forgot-password", { capabilities: { google: false, emailPassword: true } });
  expect(await screen.findByRole("heading", { name: "Password reset isn't open yet" })).toBeInTheDocument();
});

it("reset-password checks the two entries match, sends the token and new password, and signs in", async () => {
  const calls = mount("/reset-password#token=pr_resettoken", {
    handler: (path) => path === "/v1/auth/password/reset" ? json({ appPath: "/trips" }) : undefined,
  });
  await screen.findByRole("heading", { name: "Choose a new password" });
  expect(window.location.hash).toBe("");
  fireEvent.change(field("New password"), { target: { value: "a brand new passphrase" } });
  fireEvent.change(field("Repeat it"), { target: { value: "something else entirely" } });
  fireEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("don't match");
  expect(calls.some((c) => c.path === "/v1/auth/password/reset")).toBe(false);
  fireEvent.change(field("Repeat it"), { target: { value: "a brand new passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/trips"));
  expect(calls.find((c) => c.path === "/v1/auth/password/reset")!.body).toEqual({ token: "pr_resettoken", password: "a brand new passphrase" });
});

it("reset-password with a spent or expired link offers a fresh one; with no token it never shows the form", async () => {
  mount("/reset-password#token=pr_old", { handler: (path) => path === "/v1/auth/password/reset" ? json({ error: "TOKEN_INVALID" }, 400) : undefined });
  await screen.findByRole("heading", { name: "Choose a new password" });
  fireEvent.change(field("New password"), { target: { value: "a brand new passphrase" } });
  fireEvent.change(field("Repeat it"), { target: { value: "a brand new passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(await screen.findByRole("heading", { name: "This link didn't work" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Ask for a new one" })).toHaveAttribute("href", "/forgot-password");
});

it("reset-password without a token shows the broken-link state", async () => {
  mount("/reset-password");
  expect(await screen.findByRole("heading", { name: "This link didn't work" })).toBeInTheDocument();
  expect(screen.queryByLabelText("New password")).toBeNull();
});

it("the sign-in page links to forgot-password and sign-up, carrying where the person was going", async () => {
  mount("/sign-in?returnTo=/trips/new");
  expect(await screen.findByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
  expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/sign-up?returnTo=%2Ftrips%2Fnew");
});
