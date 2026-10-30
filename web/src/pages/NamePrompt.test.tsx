import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";

// AC-11 (#438): an account that never told us its name is asked once on the dashboard, because the Telegram
// interview greets the organizer by it. "Not now" is an answer too.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(me: () => Record<string, unknown>, onName: (body: unknown) => Response = () => json({ ok: true })) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/v1/me") return json(me());
    if (path === "/v1/trips") return json({ trips: [] });
    if (path === "/v1/account/name") return onName(JSON.parse(String(init?.body)));
    return json({}, 404);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={["/trips"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => vi.unstubAllGlobals());

it("AC-11 asks an account with no name what to call it, stores the answer, and stops asking", async () => {
  let needsName = true;
  const bodies: unknown[] = [];
  mount(() => ({ id: "user_1", displayName: "kin.local", needsName }), (body) => { bodies.push(body); needsName = false; return json({ ok: true }); });
  fireEvent.change(await screen.findByLabelText(/What should we call you/), { target: { value: "  Dana  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(screen.queryByLabelText(/What should we call you/)).toBeNull());
  expect(bodies).toEqual([{ displayName: "Dana" }]);
});

it("AC-11 'Not now' is sent as a dismissal, stores no name, and the question goes away", async () => {
  let needsName = true;
  const bodies: unknown[] = [];
  mount(() => ({ id: "user_1", displayName: "kin.local", needsName }), (body) => { bodies.push(body); needsName = false; return json({ ok: true }); });
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Not now" })).toBeNull());
  expect(bodies).toEqual([{ dismiss: true }]);
});

it("AC-11 an account that has a name, or is signed in through Telegram, is not asked", async () => {
  const named = mount(() => ({ id: "user_1", displayName: "Dana", needsName: false }));
  await screen.findByRole("heading", { name: "My trips" });
  expect(screen.queryByLabelText(/What should we call you/)).toBeNull();
  expect(named.some((c) => c.includes("/v1/account/name"))).toBe(false);
});

it("AC-11 a Telegram-minted session is not asked even if the server says it has no name", async () => {
  mount(() => ({ id: "user_1", displayName: "kin.local", scope: "telegram", needsName: true }));
  await screen.findByRole("heading", { name: "My trips" });
  expect(screen.queryByLabelText(/What should we call you/)).toBeNull();
});

it("AC-11 an unusable name is refused by the server and said so, and the prompt stays", async () => {
  mount(() => ({ id: "user_1", displayName: "kin.local", needsName: true }), () => json({ error: "INVALID_NAME" }, 400));
  fireEvent.change(await screen.findByLabelText(/What should we call you/), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter your name");
  expect(screen.getByLabelText(/What should we call you/)).toBeInTheDocument();
});
