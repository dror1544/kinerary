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
      current = { enabled: true, url: URL_, access: "read_write", connections: [] };
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

  it("shows a member the read-only version", async () => {
    stubConnection({ enabled: true, url: URL_, access: "read", connections: [] });
    renderMore(false);
    expect(await screen.findByRole("heading", { name: /connect your ai assistant/i })).toBeInTheDocument();
    expect(screen.getByText(/can read the trip, not change it/i)).toBeInTheDocument();
  });

  it("gives Claude's install link, pre-filled with this trip's address", async () => {
    stubConnection({ enabled: true, url: URL_, access: "read_write", connections: [] });
    renderMore();
    const link = await screen.findByRole("link", { name: /add to claude/i });
    const href = new URL(link.getAttribute("href")!);
    expect(href.origin + href.pathname).toBe("https://claude.ai/customize/connectors");
    expect(href.searchParams.get("modal")).toBe("add-custom-connector");
    expect(href.searchParams.get("connectorUrl")).toBe(URL_);
    expect(screen.getByText(/make the changes you can make here/i)).toBeInTheDocument();
  });

  it("copies the address and opens ChatGPT, saying where to paste it", async () => {
    stubConnection({ enabled: true, url: URL_, access: "read_write", connections: [] });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderMore();
    fireEvent.click(await screen.findByRole("button", { name: /add to chatgpt/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://chatgpt.com/", "_blank", "noopener"));
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(screen.getByRole("status")).toHaveTextContent(/Developer mode/);
  });

  it("lists connected assistants and disconnects one", async () => {
    const calls = stubConnection({
      enabled: true, url: URL_, access: "read_write",
      connections: [{ id: "grant_1", username: "alice", client: "Claude", connected_at: "2026-09-25T10:00:00Z", last_used_at: null }],
    });
    renderMore();
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    await waitFor(() => expect(screen.queryByText("Claude")).toBeNull());
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/api/mcp/connections/grant_1");
  });
});
