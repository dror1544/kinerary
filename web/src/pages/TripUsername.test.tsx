import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { TRIP_USERNAME_PATTERN, normaliseUsername } from "../mini-app/username";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

it("the trip-username pattern accepts what a phone pastes and what the server tolerates", () => {
  // Compiled the way a browser compiles `pattern` (anchored, unicode-sets mode).
  const pattern = new RegExp(`^(?:${TRIP_USERNAME_PATTERN})$`, "v");
  for (const accepted of ["dana", "Dana", " Dana", "dana ", "  Dana.K-1_x  ", "A1"]) expect(pattern.test(accepted), accepted).toBe(true);
  for (const refused of ["", "a", "-dana", "da na", "dana@", "dana/../x", "x".repeat(70)]) expect(pattern.test(refused), refused).toBe(false);
});

it("normalises case and padding", () => {
  expect(normaliseUsername("  Dana.K ")).toBe("dana.k");
});

it("the sign-in page's trip-username field takes a pasted value, lowercases it and sends it trimmed", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let signedIn = false;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    if (path === "/v1/auth/capabilities") return json({ google: false, emailPassword: true });
    if (path === "/v1/me") return signedIn ? json({ id: "user_member", displayName: "Member" }) : json({}, 401);
    if (path === "/v1/auth/password") { bodies.push(JSON.parse(String(init?.body))); signedIn = true; return json({ appPath: "/mini-app/trips/trip_abcdefgh" }); }
    return json({}, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={["/sign-in?return_to=%2Fmini-app%2Ftrips%2Ftrip_abcdefgh"]}><App /></MemoryRouter>
  </QueryClientProvider>);
  const field = await screen.findByLabelText("Trip username") as HTMLInputElement;
  expect(field).toHaveAttribute("autocapitalize", "none");
  expect(field).toHaveAttribute("autocorrect", "off");
  fireEvent.change(field, { target: { value: "  Dana.K " } });
  expect(field.value).toBe("dana.k");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "member-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with trip password" }));
  await vi.waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ runtimeUsername: "dana.k" });
});
