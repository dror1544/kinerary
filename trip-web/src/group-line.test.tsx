/**
 * The organizer's "Tell the group when the plan changes" toggle (video Release 1C, AC-23).
 *
 * It renders for an organizer when the trip's switch `plan_change_group_line` is on, and nowhere
 * else: not for a member, not with the switch off, not before the site has said what the setting is.
 * Changing it PATCHes only { group_change_line } and shows what the site stored.
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

const BASE = { participants: [{ username: "alice", name: "אליס", name_en: "Alice", color: "#123456" }] };
const ON = { ...BASE, features: { plan_change_group_line: true } };

function renderMore({ isOrganizer, config, lang = "en" }: { isOrganizer: boolean; config: object; lang?: "en" | "he" }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MoreView lang={lang} isOrganizer={isOrganizer} config={config} openModule={vi.fn()} />
    </QueryClientProvider>,
  );
}

function stubSettings(initial: boolean, { failPatch = false } = {}) {
  let stored = initial;
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/settings") && method === "PATCH") {
      if (failPatch) return json({ error: "organizer_only" }, 403);
      stored = JSON.parse(String(init?.body)).group_change_line;
      return json({ timezone: null, group_change_line: stored });
    }
    if (url.endsWith("/api/settings")) return json({ timezone: null, group_change_line: stored });
    return json({});
  }));
  return calls;
}

describe("the group line toggle", () => {
  it("shows to an organizer when the switch is on, reflecting the stored setting (on by default)", async () => {
    stubSettings(true);
    renderMore({ isOrganizer: true, config: ON });
    const toggle = await screen.findByRole("switch", { name: "Tell the group when the plan changes" });
    expect(toggle).toBeChecked();
  });

  it("is in Hebrew for a Hebrew trip", async () => {
    stubSettings(true);
    renderMore({ isOrganizer: true, config: ON, lang: "he" });
    expect(await screen.findByRole("switch", { name: "לעדכן את הקבוצה כשהתוכנית משתנה" })).toBeInTheDocument();
  });

  it("does not show to a member, and asks the site nothing", async () => {
    const calls = stubSettings(true);
    renderMore({ isOrganizer: false, config: ON });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("switch", { name: /tell the group/i })).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/api/settings"))).toEqual([]);
  });

  it("does not show with the switch off or absent, and asks the site nothing", async () => {
    const calls = stubSettings(true);
    for (const config of [BASE, { ...BASE, features: { plan_change_group_line: "true" } }, { ...BASE, features: {} }]) {
      renderMore({ isOrganizer: true, config });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByRole("switch", { name: /tell the group/i })).toBeNull();
      cleanup();
    }
    expect(calls.filter((c) => c.url.endsWith("/api/settings"))).toEqual([]);
  });

  it("turning it off PATCHes only group_change_line and shows the stored value", async () => {
    const calls = stubSettings(true);
    renderMore({ isOrganizer: true, config: ON });
    const toggle = await screen.findByRole("switch", { name: /tell the group/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: /tell the group/i })).not.toBeChecked());
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toMatch(/\/api\/settings$/);
    expect(patch?.body).toEqual({ group_change_line: false });
  });

  it("a refused save says so and leaves the toggle where the site has it", async () => {
    stubSettings(true, { failPatch: true });
    renderMore({ isOrganizer: true, config: ON });
    fireEvent.click(await screen.findByRole("switch", { name: /tell the group/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save/i);
    expect(screen.getByRole("switch", { name: /tell the group/i })).toBeChecked();
  });

  it("shows no control until the site has said what the setting is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } })));
    renderMore({ isOrganizer: true, config: ON });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole("switch", { name: /tell the group/i })).toBeNull();
  });
});
