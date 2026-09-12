/**
 * A session that no longer works must not look like one that does.
 *
 * Trips reuse hostnames — a slug comes back, a container is rebuilt, and each
 * signs its own tokens — so a browser arrives holding a token from a trip that
 * is gone. The app asked only whether a token was PRESENT, so it rendered the
 * whole shell while every request behind it answered 401: a site that looked
 * empty rather than closed, with no way to tell who, if anyone, was signed in.
 * Both reported 2026-09-12.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { tokenStore, UNAUTHORIZED_EVENT } from "./api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
    </QueryClientProvider>,
  );
}

describe("a token the server refuses", () => {
  it("ends the session instead of rendering an empty trip", async () => {
    tokenStore.set("token-from-a-trip-that-is-gone");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/config/roster")) {
        return new Response(JSON.stringify({ participants: [] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
    }));

    renderApp();

    await waitFor(() => expect(screen.getByLabelText(/Username/i)).toBeInTheDocument());
    expect(tokenStore.get()).toBeNull();
  });

  it("says so with an event, so anything holding session state can react", async () => {
    tokenStore.set("stale");
    const heard: string[] = [];
    window.addEventListener(UNAUTHORIZED_EVENT, () => heard.push("ended"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })));

    renderApp();
    await waitFor(() => expect(heard.length).toBeGreaterThan(0));
  });

  it("leaves a failed LOGIN alone — there is no session to end there", async () => {
    const { login } = await import("./api");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "wrong_credentials" }), { status: 401 })));
    tokenStore.set("someone-elses-live-session");
    await expect(login("ella", "wrong")).rejects.toThrow();
    expect(tokenStore.get()).toBe("someone-elses-live-session");
  });
});
