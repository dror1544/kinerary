/**
 * The Moments list for an organizer shows every draft (the site serves them) with the author and a Publish action;
 * a member gets no Publish button and the old "Private draft" label.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MomentsView } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stub() {
  let rows = [
    { id: "m1", caption: "Bob's draft", visibility: "draft", author: "bob", source: "connector", photo_ids: ["a", "b"] },
    { id: "m3", caption: "Bob's site draft", visibility: "draft", author: "bob", source: "site", photo_ids: [] },
    { id: "m2", caption: "Already out", visibility: "published", author: "alice", photo_ids: [] },
  ];
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "PATCH" && url.endsWith("/api/moments/m1")) {
      rows = rows.map((r) => (r.id === "m1" ? { ...r, visibility: "published" } : r));
      return json(rows[0]);
    }
    if (url.endsWith("/api/moments")) return json(rows);
    return json({});
  }));
  return calls;
}

const view = (isOrganizer: boolean, username = isOrganizer ? "alice" : "bob", momentsOn = true) => render(
  <QueryClientProvider client={new QueryClient()}><MomentsView lang="en" isOrganizer={isOrganizer} username={username} momentsOn={momentsOn} /></QueryClientProvider>,
);

describe("moments: an organizer publishes a draft", () => {
  it("shows the draft's author and a Publish button only on drafts, and PATCHes visibility published", async () => {
    const calls = stub();
    view(true);
    expect(await screen.findAllByText(/Draft by bob/)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Publish" })).toHaveLength(2);
    expect(screen.getByText("2 photo(s)")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Publish" })[0]);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/moments/m1", body: { visibility: "published" } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Publish" })).toHaveLength(1));
  });

  it("with trip_moments_capture OFF the list looks exactly as before: no Publish, no photo count, only the old label", async () => {
    stub();
    view(true, "alice", false);
    expect((await screen.findAllByText(/Private draft/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByText(/Draft by/)).toBeNull();
    expect(screen.queryByText(/photo\(s\)/)).toBeNull();
    expect(screen.queryByText(/you and the organizers/)).toBeNull();
  });

  it("a member sees no Publish button", async () => {
    stub();
    view(false);
    expect(await screen.findByText("Bob's draft")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByText(/Draft — you and the organizers can see it/)).toBeInTheDocument();
    expect(screen.getByText(/Private draft/)).toBeInTheDocument();
  });
});
