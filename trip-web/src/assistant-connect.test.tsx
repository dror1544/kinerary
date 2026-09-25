/**
 * "Connect your AI assistant" — shown to an organizer only when the trip has
 * turned its MCP endpoint on, with the address to paste into Claude or
 * ChatGPT and a way to disconnect what is already connected.
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

const CONFIG = { participants: [{ username: "alice", name: "אליס", name_en: "Alice", color: "#123456" }] };
const URL_ = "https://orlando.example/mcp";

function renderMore(isOrganizer = true) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MoreView lang="en" isOrganizer={isOrganizer} config={CONFIG} openModule={vi.fn()} />
    </QueryClientProvider>,
  );
}

function stubConnection(state: unknown) {
  const calls: { url: string; method: string }[] = [];
  let current = state;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method });
    if (method === "DELETE") {
      current = { enabled: true, url: URL_, connections: [] };
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    const body = url.includes("/api/mcp/connection") ? current : {};
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
  return calls;
}

describe("connect your AI assistant", () => {
  it("is absent when the trip has not turned it on", async () => {
    const calls = stubConnection({ enabled: false });
    renderMore();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/mcp/connection"))).toBe(true));
    expect(screen.queryByRole("heading", { name: /connect your ai assistant/i })).toBeNull();
  });

  it("is absent for a member", () => {
    stubConnection({ enabled: true, url: URL_, connections: [] });
    renderMore(false);
    expect(screen.queryByRole("heading", { name: /connect your ai assistant/i })).toBeNull();
  });

  it("gives the organizer the address and the steps for Claude and ChatGPT", async () => {
    stubConnection({ enabled: true, url: URL_, connections: [] });
    renderMore();
    expect(await screen.findByRole("heading", { name: /connect your ai assistant/i })).toBeInTheDocument();
    expect(screen.getByText(URL_)).toBeInTheDocument();
    expect(screen.getByText(/Claude: Settings → Connectors/)).toBeInTheDocument();
    expect(screen.getByText(/ChatGPT: Settings/)).toBeInTheDocument();
  });

  it("lists connected assistants and disconnects one", async () => {
    const calls = stubConnection({
      enabled: true, url: URL_,
      connections: [{ id: "grant_1", username: "alice", client: "Claude", connected_at: "2026-09-25T10:00:00Z", last_used_at: null }],
    });
    renderMore();
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    await waitFor(() => expect(screen.queryByText("Claude")).toBeNull());
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/api/mcp/connections/grant_1");
  });
});
