/**
 * AC-17 of docs/specs/sprint-9/x-member-sign-in.md: a traveller who exists only on the trip site (no control-plane account) is told, on
 * the trip site's own login screen, how to get in: ask the organizer for a personal invite, or open the trip from the Telegram group if the organizer has turned that on
 * (the line shows on every trip, including trips where group sign-in is off, so it says so rather than promising it).
 *
 * It is a STATIC line. The trip site sends nothing about it and learns nothing about accounts: "Send me a sign-in link" lives on the
 * portal and the Mini App, never here, and the test pins that by listing every request this screen makes.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderLoggedOut(): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requested.push(String(input));
    if (String(input).includes("/api/config/roster")) return new Response(JSON.stringify({ participants: [] }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return requested;
}

describe("the trip site's login screen says how to get in without a trip-site account", () => {
  it("in English", async () => {
    localStorage.setItem("tripLang", "en");
    const requested = renderLoggedOut();
    const line = await screen.findByText("Not on the list here? Ask the organizer for a personal invite, or open the trip from the Telegram group if your organizer has turned that on.");
    expect(line).toBeInTheDocument();
    await waitFor(() => expect(requested.some((url) => url.includes("/api/config/roster"))).toBe(true));
    // The trip site asks nothing about accounts and sends nothing to anyone: only its own roster, and no sign-in-link call at all.
    expect(requested.filter((url) => /sign-in-link|\/v1\/|password\/forgot/.test(url))).toEqual([]);
  });

  it("in Hebrew", async () => {
    localStorage.setItem("tripLang", "he");
    renderLoggedOut();
    expect(await screen.findByText("לא ברשימה כאן? בקשו מהמארגן הזמנה אישית, או פתחו את הטיול מקבוצת הטלגרם אם המארגן הפעיל את האפשרות הזו.")).toBeInTheDocument();
  });

  it("offers no button or form of its own for it: it is a sentence, not a request", async () => {
    localStorage.setItem("tripLang", "en");
    renderLoggedOut();
    const line = await screen.findByText(/open the trip from the Telegram group/);
    expect(line.tagName).toBe("P");
    expect(line.querySelector("button, a, form, input")).toBeNull();
    expect(screen.queryByRole("button", { name: /sign-in link/i })).toBeNull();
  });
});
