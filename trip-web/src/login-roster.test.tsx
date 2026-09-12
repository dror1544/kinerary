/**
 * The login screen names the people who can use it.
 *
 * 2026-09-12: an organizer finished an interview, got the site's password in
 * the assistant's introduction, opened the site — and found a form asking for a
 * username. The accounts are the travellers and their usernames are DERIVED
 * from their names (`ella`, `nirsolomon`), so there was nothing to type and no
 * way to find out. Classic has offered a picker from `/api/config/roster` all
 * along; this is the same roster, on the modern screen.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderLoggedOut() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("the login screen", () => {
  it("offers the roster's names and fills the username when one is tapped", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/config/roster")) {
        return new Response(JSON.stringify({
          participants: [
            { username: "nirsolomon", name: "ניר סולומון" },
            { username: "ella", name: "אלה" },
          ],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }));

    renderLoggedOut();
    const chip = await screen.findByRole("button", { name: "אלה" });
    fireEvent.click(chip);
    await waitFor(() => {
      const field = screen.getByLabelText(/Username/i) as HTMLInputElement;
      expect(field.value).toBe("ella");
    });
  });

  it("still shows the plain form when the roster cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })));
    renderLoggedOut();
    expect(await screen.findByLabelText(/Username/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "אלה" })).toBeNull();
  });
});
