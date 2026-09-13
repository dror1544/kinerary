/**
 * The organizer can get someone back into the site.
 *
 * Usernames are derived from names and the password is shared with the whole
 * group, so the only person who can be locked out is one who set their own and
 * forgot it. Until now the way back ran through the assistant; this is the same
 * two options where the organizer already is.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoreView } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const CONFIG = {
  participants: [
    { username: "alice", name: "אליס", name_en: "Alice", color: "#123456" },
    { username: "ben", name: "בן", name_en: "Ben", color: "#654321" },
  ],
};

function renderMore(isOrganizer: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MoreView lang="en" isOrganizer={isOrganizer} config={CONFIG} openModule={vi.fn()} />
    </QueryClientProvider>,
  );
}

function stubFetch(response: { status?: number; body: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

describe("member logins", () => {
  it("is organizer-only", () => {
    renderMore(false);
    expect(screen.queryByRole("heading", { name: /signing in/i })).toBeNull();
    renderMore(true);
    expect(screen.getByRole("heading", { name: /signing in/i })).toBeInTheDocument();
  });

  it("puts a forgotten password back to the trip password", async () => {
    const calls = stubFetch({ body: { ok: true, username: "ben", restored: "trip_password" } });
    renderMore(true);
    fireEvent.click(screen.getAllByRole("button", { name: /back to the trip password/i })[1]);

    await waitFor(() => expect(screen.getByText(/they can use the trip password again/i)).toBeInTheDocument());
    expect(calls[0].url).toContain("/api/agent/participants/ben/reset-password");
    expect(calls[0].body).toEqual({ to: "trip_password" });
  });

  it("hands over a one-time link, and says it is not for the group", async () => {
    stubFetch({ body: { ok: true, username: "alice", enrollment_token: "tok_abc" } });
    renderMore(true);
    fireEvent.click(screen.getAllByRole("button", { name: /one-time link/i })[0]);

    await waitFor(() => expect(screen.getByText(/works once, and it is not for the family group/i)).toBeInTheDocument());
    expect(screen.getByText(/#enroll=tok_abc/)).toBeInTheDocument();
  });

  it("says what to do when the trip has no shared password", async () => {
    stubFetch({ status: 409, body: { error: "no_trip_password" } });
    renderMore(true);
    fireEvent.click(screen.getAllByRole("button", { name: /back to the trip password/i })[0]);

    await waitFor(() => expect(screen.getByText(/no shared password — send a one-time link instead/i)).toBeInTheDocument());
  });
});
