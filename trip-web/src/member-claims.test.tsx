/**
 * Organizer settings -> Signing in -> "Signed in from the Telegram group"
 * (docs/specs/sprint-9/x-member-sign-in.md, AC-7 and amendment A5).
 *
 * The list and Release go through the runtime gateway (`/t/<trip>/__member-claims`), which asks the control plane; this page
 * only draws what comes back. Two things matter more than the drawing:
 *   - when the hop is not there (the site opened on its own hostname, the feature off so the route answers not-found, an
 *     outage, an empty list) the section renders NOTHING: the name of an unreleased feature is itself withheld;
 *   - a Release is confirmed first, goes out with the header the gateway requires, and says what happened.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberClaims } from "./member-claims";
import { OrganizerSettings } from "./App";

const BASE = "/t/trip_abcdefgh";
const DANA = { claimId: "tpc_danaaaaaaaaa", travellerName: "Dana Levi", telegramFirstName: "Maya", telegramUsername: "maya_tg", via: "group_membership", claimedAt: "2026-11-20T08:00:00.000Z", lastSignedInAt: null };
const NOAM = { claimId: "tpc_noamaaaaaaaaa", travellerName: "נועם לוי", telegramFirstName: "Avi", telegramUsername: null, via: "group_membership", claimedAt: "2026-11-21T09:30:00.000Z", lastSignedInAt: "2026-11-22T10:00:00.000Z" };

type Call = { url: string; method: string; headers: Record<string, string> };
function stubGateway(handler: (call: Call) => { status?: number; body?: unknown } | "network-error") {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const call = { url: String(input), method: init?.method ?? "GET", headers };
    calls.push(call);
    const answer = handler(call);
    if (answer === "network-error") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

function mount(lang: "en" | "he" = "en") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemberClaims lang={lang} /></QueryClientProvider>);
}
const globals = window as unknown as { KITINERARY_RUNTIME_BASE?: string };

beforeEach(() => { globals.KITINERARY_RUNTIME_BASE = BASE; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete globals.KITINERARY_RUNTIME_BASE; });

describe("the list", () => {
  it("shows who signed in from the group: the traveller, the Telegram first name and @username when there is one, and the date", async () => {
    const calls = stubGateway(() => ({ body: { claims: [DANA, NOAM] } }));
    mount();
    expect(await screen.findByRole("heading", { name: "Signed in from the Telegram group" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Dana Levi");
    expect(rows[0]).toHaveTextContent("Maya");
    expect(rows[0]).toHaveTextContent("@maya_tg");
    expect(rows[0]).toHaveTextContent(/20 Nov 2026/);
    expect(rows[1]).toHaveTextContent("נועם לוי");
    expect(rows[1]).toHaveTextContent("Avi");
    expect(rows[1]).not.toHaveTextContent("@");
    // One GET, to the gateway path of THIS trip, with nothing client-chosen in it.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${BASE}/__member-claims`, method: "GET" });
    // Ids are for the Release request only: never on the page.
    expect(document.body.textContent).not.toMatch(/tpc_|trip_/);
  });

  it("is Hebrew in a Hebrew site", async () => {
    stubGateway(() => ({ body: { claims: [DANA] } }));
    mount("he");
    expect(await screen.findByRole("heading", { name: "נכנסו מקבוצת הטלגרם" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ביטול כניסה" })).toBeInTheDocument();
  });
});

describe("renders nothing when there is nothing to say", () => {
  it("an empty list", async () => {
    const calls = stubGateway(() => ({ body: { claims: [] } }));
    const { container } = mount();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/telegram group/i)).toBeNull();
  });

  it("the site opened directly (no gateway base): no request is made at all", async () => {
    delete globals.KITINERARY_RUNTIME_BASE;
    const calls = stubGateway(() => ({ body: { claims: [DANA] } }));
    const { container } = mount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["the route answers not-found (feature off, or not an organizer)", { status: 404, body: { error: "NOT_FOUND" } }],
    ["no session", { status: 401, body: { error: "AUTHENTICATION_REQUIRED" } }],
    ["an outage", { status: 503, body: { error: "RUNTIME_UNAVAILABLE" } }],
    ["a body that is not a list", { status: 200, body: { claims: "x" } }],
    ["a page instead of JSON (the trip site's own fallback)", { status: 200, body: undefined }],
  ])("%s", async (_name, answer) => {
    const calls = stubGateway(() => answer);
    const { container } = mount();
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it("a network error", async () => {
    const calls = stubGateway(() => "network-error");
    const { container } = mount();
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Release", () => {
  async function openDana(handler: (call: Call) => { status?: number; body?: unknown }) {
    const calls = stubGateway(handler);
    mount();
    const row = (await screen.findByText("Dana Levi")).closest("li")!;
    return { calls, row };
  }

  it("asks first: the button does not release, and Cancel leaves the row alone", async () => {
    const { calls, row } = await openDana(() => ({ body: { claims: [DANA] } }));
    fireEvent.click(within(row).getByRole("button", { name: "Release" }));
    expect(within(row).getByText(/Maya will be signed out/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).getByRole("button", { name: "Release" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("confirming sends ONE DELETE to the gateway with the header it requires, the row goes, and a note says the name can be picked again", async () => {
    const claims = [DANA, NOAM];
    const { calls, row } = await openDana((call) => call.method === "DELETE" ? { body: { status: "released" } } : { body: { claims } });
    fireEvent.click(within(row).getByRole("button", { name: "Release" }));
    const confirm = within(row).getByRole("button", { name: "Yes, release" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByText("Dana Levi")).toBeNull());
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(`${BASE}/__member-claims/${DANA.claimId}`);
    expect(deletes[0]!.headers["x-kinerary-member-claims"]).toBe("1");
    expect(await screen.findByRole("status")).toHaveTextContent("Released. The name Dana Levi can be picked again.");
    expect(screen.getByText("נועם לוי")).toBeInTheDocument();
  });

  it("releasing the last one leaves the note, not an empty box", async () => {
    const { row } = await openDana((call) => call.method === "DELETE" ? { body: { status: "released" } } : { body: { claims: [DANA] } });
    fireEvent.click(within(row).getByRole("button", { name: "Release" }));
    fireEvent.click(within(row).getByRole("button", { name: "Yes, release" }));
    expect(await screen.findByRole("status")).toHaveTextContent("can be picked again");
    expect(screen.queryByText("Dana Levi", { selector: "strong" })).toBeNull();
  });

  it("a Telegram-opened organizer session (403) is sent to the dashboard, and the row stays", async () => {
    const { row } = await openDana((call) => call.method === "DELETE" ? { status: 403, body: { error: "ACCOUNT_SIGN_IN_REQUIRED" } } : { body: { claims: [DANA] } });
    fireEvent.click(within(row).getByRole("button", { name: "Release" }));
    fireEvent.click(within(row).getByRole("button", { name: "Yes, release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Open the dashboard to release this sign-in.");
    expect(screen.getByText("Dana Levi")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ACCOUNT_SIGN_IN_REQUIRED/);
  });

  it("any other failure says so and keeps the row, so it can be tried again", async () => {
    let attempts = 0;
    const { row } = await openDana((call) => {
      if (call.method !== "DELETE") return { body: { claims: [DANA] } };
      attempts += 1;
      return attempts === 1 ? { status: 503, body: { error: "RUNTIME_UNAVAILABLE" } } : { body: { status: "released" } };
    });
    fireEvent.click(within(row).getByRole("button", { name: "Release" }));
    fireEvent.click(within(row).getByRole("button", { name: "Yes, release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not go through. Try again.");
    expect(document.body.textContent).not.toMatch(/RUNTIME_UNAVAILABLE|503/);
    fireEvent.click(within(screen.getByText("Dana Levi").closest("li")!).getByRole("button", { name: "Release" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, release" }));
    await waitFor(() => expect(screen.queryByText("Dana Levi", { selector: "strong" })).toBeNull());
  });

  it("a claim that is already gone (404) is dropped from the list rather than reported as an error", async () => {
    const { row } = await openDana((call) => call.method === "DELETE" ? { status: 404, body: { error: "NOT_FOUND" } } : { body: { claims: [DANA] } });
    fireEvent.click(within(row).getByRole("button", { name: "Release" }));
    fireEvent.click(within(row).getByRole("button", { name: "Yes, release" }));
    await waitFor(() => expect(screen.queryByText("Dana Levi", { selector: "strong" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("where it sits", () => {
  function renderMore(isOrganizer: boolean) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OrganizerSettings lang="en" isOrganizer={isOrganizer} config={{ participants: [{ username: "alice", name: "אליס", name_en: "Alice", color: "#123456" }] }} />
      </QueryClientProvider>,
    );
  }

  it("organizers see it under Signing in", async () => {
    stubGateway(() => ({ body: { claims: [DANA] } }));
    renderMore(true);
    const heading = await screen.findByRole("heading", { name: "Signed in from the Telegram group" });
    expect(heading.closest(".member-logins")).not.toBeNull();
  });

  it("a member never asks and never sees it", async () => {
    const calls = stubGateway(() => ({ body: { claims: [DANA] } }));
    renderMore(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.url.includes("__member-claims"))).toHaveLength(0);
    expect(screen.queryByText(/telegram group/i)).toBeNull();
  });

  it("an organizer on a site without the hop sees Signing in exactly as before", async () => {
    delete globals.KITINERARY_RUNTIME_BASE;
    stubGateway(() => ({ body: { claims: [DANA] } }));
    renderMore(true);
    expect(screen.getByRole("heading", { name: /signing in/i })).toBeInTheDocument();
    expect(screen.queryByText(/telegram group/i)).toBeNull();
  });
});
