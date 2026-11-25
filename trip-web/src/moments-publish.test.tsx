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
    { id: "m1", caption: "Bob's draft", visibility: "draft", author: "bob", photo_ids: ["a", "b"] },
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

const view = (isOrganizer: boolean) => render(
  <QueryClientProvider client={new QueryClient()}><MomentsView lang="en" isOrganizer={isOrganizer} /></QueryClientProvider>,
);

describe("moments: an organizer publishes a draft", () => {
  it("shows the draft's author and a Publish button only on drafts, and PATCHes visibility published", async () => {
    const calls = stub();
    view(true);
    expect(await screen.findByText(/Draft by bob/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Publish" })).toHaveLength(1);
    expect(screen.getByText("2 photo(s)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/moments/m1", body: { visibility: "published" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Publish" })).toBeNull());
  });

  it("a member sees no Publish button", async () => {
    stub();
    view(false);
    expect(await screen.findByText("Bob's draft")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByText(/Private draft/)).toBeInTheDocument();
  });
});
