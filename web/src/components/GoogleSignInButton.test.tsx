import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { GSI_SCRIPT } from "./GoogleSignInButton";

let nonces = 0;
const CLIENT_ID = "123456789012-fixture.apps.googleusercontent.com";
type Callback = (response: { credential?: string }) => void;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stands in for https://accounts.google.com/gsi/client: records what the page asks of it and draws a marker. */
function stubGoogle() {
  const captured: { config?: { client_id: string; nonce?: string; callback: Callback }; rendered: HTMLElement[]; options?: Record<string, unknown> } = { rendered: [] };
  const initialize = vi.fn((config: { client_id: string; nonce?: string; callback: Callback }) => { captured.config = config; });
  const renderButton = vi.fn((parent: HTMLElement, options: Record<string, unknown>) => {
    captured.rendered.push(parent); captured.options = options;
    const marker = document.createElement("div"); marker.textContent = "Google's own button"; parent.appendChild(marker);
  });
  window.google = { accounts: { id: { initialize, renderButton } } };
  return { captured, initialize, renderButton };
}

function mount(route: string, capabilities: Record<string, unknown>, handler: (url: string, init?: RequestInit) => Response = () => json({}, 404)) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/v1/auth/capabilities") return json({ emailPassword: true, emailSignUp: true, ...capabilities });
    if (url === "/v1/me") return json({ error: "AUTHENTICATION_REQUIRED" }, 401);
    if (url === "/v1/auth/google/nonce") return json({ nonce: `nonce-${++nonces}` });
    return handler(url, init);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
  return calls;
}

beforeEach(() => { nonces = 0; vi.unstubAllGlobals(); delete window.google; window.sessionStorage.clear(); document.head.querySelectorAll(`script[src="${GSI_SCRIPT}"]`).forEach((node) => node.remove()); });
afterEach(() => { delete window.google; window.sessionStorage.clear(); });

it("draws Google's button on /sign-in from the client ID the server named, and not before the server says google:true", async () => {
  const { initialize, renderButton } = stubGoogle();
  mount("/sign-in", { google: true, googleClientId: CLIENT_ID });
  expect(await screen.findByText("Google's own button")).toBeInTheDocument();
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize.mock.calls[0]![0].client_id).toBe(CLIENT_ID);
  expect(initialize.mock.calls[0]![0].nonce, "the server's single-use nonce is what Google signs into the token").toBe("nonce-1");
  expect(renderButton).toHaveBeenCalledTimes(1);
});

it("draws it on /sign-up too", async () => {
  const { initialize } = stubGoogle();
  mount("/sign-up", { google: true, googleClientId: CLIENT_ID });
  expect(await screen.findByText("Google's own button")).toBeInTheDocument();
  expect(initialize.mock.calls[0]![0].client_id).toBe(CLIENT_ID);
});

it("draws nothing, and loads nothing from Google, when capabilities says google:false or names no client ID", async () => {
  const { initialize } = stubGoogle();
  mount("/sign-in", { google: false });
  expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  expect(initialize).not.toHaveBeenCalled();
  expect(document.head.querySelector(`script[src="${GSI_SCRIPT}"]`)).toBeNull();
});

it("google:true without a client ID is not enough to draw a button", async () => {
  const { initialize } = stubGoogle();
  mount("/sign-in", { google: true });
  expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  expect(initialize).not.toHaveBeenCalled();
});

it("is hidden inside the Telegram Mini App, where Google's popup cannot open, and does not even load Google's script", async () => {
  window.sessionStorage.setItem("__telegram__initParams", "{}");
  mount("/sign-in", { google: true, googleClientId: CLIENT_ID });
  expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  expect(screen.queryByTestId("google-signin-button")).toBeNull();
  expect(document.head.querySelector(`script[src="${GSI_SCRIPT}"]`)).toBeNull();
});

it("loads Google's script from accounts.google.com on the sign-in page, when it is not already there", async () => {
  mount("/sign-in", { google: true, googleClientId: CLIENT_ID });
  await waitFor(() => expect(document.head.querySelector(`script[src="${GSI_SCRIPT}"]`)).not.toBeNull());
  expect(GSI_SCRIPT).toBe("https://accounts.google.com/gsi/client");
});

it("the callback posts the credential (and where to go next) to /v1/auth/google, then lands on that page", async () => {
  const { captured } = stubGoogle();
  let signedIn = false;
  const calls = mount("/sign-in?return_to=%2Ftrips%2Fnew", { google: true, googleClientId: CLIENT_ID }, (url, init) => {
    if (url === "/v1/auth/google") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ credential: "signed.id.token", returnTo: "/trips/new" });
      signedIn = true;
      return json({ appPath: "/trips/new" });
    }
    if (url === "/v1/trips") return json({ trips: [] });
    return json({}, 404);
  });
  await screen.findByText("Google's own button");
  // After the post the page asks who it is now; make that answer yes.
  const fetchMock = vi.mocked(globalThis.fetch);
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => String(input) === "/v1/me" && signedIn ? json({ id: "user_g", displayName: "Gina" }) : original(input, init));
  captured.config!.callback({ credential: "signed.id.token" });
  expect(await screen.findByRole("heading", { name: "Start with the outline" })).toBeInTheDocument();
  expect(calls).toContain("POST /v1/auth/google");
});

it("a refused credential keeps the person on the page with a plain message, and posts nothing else", async () => {
  const { captured, initialize } = stubGoogle();
  const calls = mount("/sign-up", { google: true, googleClientId: CLIENT_ID }, (url) => url === "/v1/auth/google" ? json({ error: "GOOGLE_SIGN_IN_FAILED" }, 401) : json({}, 404));
  await screen.findByText("Google's own button");
  captured.config!.callback({ credential: "bad" });
  expect(await screen.findByText("Google sign-in didn't work. Please try again, or use your email.")).toBeInTheDocument();
  expect(calls.filter((call) => call.startsWith("POST")).length).toBe(1);
  // The attempt spent the nonce, so the button is armed again with a fresh one.
  await waitFor(() => expect(calls.filter((call) => call === "GET /v1/auth/google/nonce").length).toBe(2));
  await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
  expect(initialize.mock.calls[1]![0].nonce).toBe("nonce-2");
  // An empty callback (the popup closed without a credential) posts nothing at all.
  captured.config!.callback({});
  expect(await screen.findByText("Google sign-in didn't complete. Please try again.")).toBeInTheDocument();
  expect(calls.filter((call) => call === "POST /v1/auth/google").length).toBe(1);
});

it("an address Google is not the authority for (GOOGLE_USE_EMAIL_SIGN_UP) points at the email sign-up and sign-in instead of a bare error", async () => {
  const { captured } = stubGoogle();
  mount("/sign-in?return_to=%2Ftrips%2Fnew", { google: true, googleClientId: CLIENT_ID }, (url) => url === "/v1/auth/google" ? json({ error: "GOOGLE_USE_EMAIL_SIGN_UP" }, 401) : json({}, 404));
  await screen.findByText("Google's own button");
  captured.config!.callback({ credential: "outlook-token" });
  expect(await screen.findByText(/This address isn't a Google account/)).toBeInTheDocument();
  expect(screen.getByText(/sign up or sign in with your email instead/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up?returnTo=%2Ftrips%2Fnew");
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in?return_to=%2Ftrips%2Fnew");
  expect(screen.queryByText(/Google sign-in didn't work/)).toBeNull();
  // The nonce was spent, so the button is armed again for another try.
  await waitFor(() => expect(captured.config!.nonce).toBe("nonce-2"));
});
