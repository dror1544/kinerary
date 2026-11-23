/**
 * Organizer settings -> Signing in -> "Send a personal invite" (docs/specs/sprint-9/x-member-sign-in.md, slice S2, AC-11).
 *
 * The button goes through the runtime gateway (`/t/<trip>/__member-invites`), which asks the control plane; this page only draws what
 * comes back. What matters more than the drawing:
 *   - it sits BESIDE "Back to the trip password" and "One-time link", replacing nothing;
 *   - when the hop is not there (the site opened on its own hostname, a person who is not this trip's organizer, an outage, a page
 *     instead of JSON) there is NO button, and no request is made without a gateway;
 *   - it produces the link and a forwardable message in Hebrew AND English whatever language the site is in;
 *   - the named answers (someone is signed in as them from the group; they already have a personal sign-in; ...) are explained;
 *   - a click that is already in flight is not sent twice.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizerSettings } from "./App";

const BASE = "/t/trip_abcdefgh";
const LINK = "https://app.example.test/join#token=tok_personal_link_value";
const CONFIG = {
  participants: [
    { username: "alice", name: "אליס", name_en: "Alice", color: "#123456" },
    { username: "ben", name: "בן", name_en: "Ben", color: "#654321" },
  ],
};

type Call = { url: string; method: string; headers: Record<string, string> };
function stubGateway(handler: (call: Call) => { status?: number; body?: unknown; raw?: string } | "network-error", delayMs = 0) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const call = { url: String(input), method: init?.method ?? "GET", headers };
    calls.push(call);
    const answer = handler(call);
    if (answer === "network-error") throw new TypeError("Failed to fetch");
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { "content-type": answer.raw ? "text/html" : "application/json" } });
  }));
  return calls;
}
const probeOnly = (call: Call) => call.url === `${BASE}/__member-invites`;
const creates = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url.startsWith(`${BASE}/__member-invites/`));

function mount(lang: "en" | "he" = "en") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizerSettings lang={lang} isOrganizer config={CONFIG} />
    </QueryClientProvider>,
  );
}
const globals = window as unknown as { KITINERARY_RUNTIME_BASE?: string };
beforeEach(() => { globals.KITINERARY_RUNTIME_BASE = BASE; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete globals.KITINERARY_RUNTIME_BASE; });

const ok = (call: Call) => (probeOnly(call)
  ? { body: { available: true } }
  : { status: 201, body: { joinUrl: LINK, displayName: "Ben Cohen", expiresAt: "2026-11-28T08:00:00.000Z" } });
/** Ben's row of Organizer settings -> Signing in (the list item that carries his @username and his buttons). */
const benRow = async () => within(await waitFor(() => {
  const row = screen.getAllByRole("listitem").find((li) => li.textContent?.includes("@ben") && li.querySelector("button"));
  if (!row) throw new Error("Ben's row is not drawn yet");
  return row;
}));
const benRowButtons = benRow;

describe("where the button is", () => {
  it("is beside the trip password and the one-time link, for every traveller, and replaces neither", async () => {
    stubGateway(ok);
    mount();
    expect(await screen.findAllByRole("button", { name: "Send a personal invite" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Back to the trip password" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "One-time link" })).toHaveLength(2);
    const row = await benRowButtons();
    expect(row.getByRole("button", { name: "Back to the trip password" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "One-time link" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Send a personal invite" })).toBeInTheDocument();
  });

  it("is Hebrew in a Hebrew site", async () => {
    stubGateway(ok);
    mount("he");
    expect(await screen.findAllByRole("button", { name: "שליחת הזמנה אישית" })).toHaveLength(2);
  });

  it("asks once, with a GET to the gateway path of THIS trip, and nothing client-chosen in it", async () => {
    const calls = stubGateway(ok);
    mount();
    await screen.findAllByRole("button", { name: "Send a personal invite" });
    const probes = calls.filter(probeOnly);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ url: `${BASE}/__member-invites`, method: "GET" });
  });
});

describe("no button when the hop is not there", () => {
  it("the site opened on its own hostname (no gateway): no request, no button, and the other buttons are as before", async () => {
    delete globals.KITINERARY_RUNTIME_BASE;
    const calls = stubGateway(ok);
    mount();
    expect(await screen.findAllByRole("button", { name: "One-time link" })).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("button", { name: /personal invite/i })).toBeNull();
    expect(calls.filter((call) => call.url.includes("__member-invites"))).toHaveLength(0);
  });

  it.each([
    ["not this trip's organizer (404)", { status: 404, body: { error: "NOT_FOUND" } }],
    ["no session (401)", { status: 401, body: { error: "AUTHENTICATION_REQUIRED" } }],
    ["an outage (503)", { status: 503, body: { error: "RUNTIME_UNAVAILABLE" } }],
    ["a page instead of JSON", { raw: "<html>login</html>" }],
    ["an answer that is not available: true", { body: { available: false } }],
    ["an answer of the wrong shape", { body: { available: "yes" } }],
  ])("%s", async (_label, answer) => {
    stubGateway((call) => (probeOnly(call) ? answer : { body: {} }));
    mount();
    expect(await screen.findAllByRole("button", { name: "One-time link" })).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("button", { name: /personal invite/i })).toBeNull();
  });

  it("a network error", async () => {
    stubGateway(() => "network-error");
    mount();
    expect(await screen.findAllByRole("button", { name: "One-time link" })).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("button", { name: /personal invite/i })).toBeNull();
  });
});

describe("sending one", () => {
  it("POSTs for THAT traveller with the header the gateway requires, and shows the link and a forwardable message in Hebrew AND English", async () => {
    const calls = stubGateway(ok);
    mount("en");
    fireEvent.click(await (await benRow()).findByRole("button", { name: "Send a personal invite" }));
    expect(await screen.findByText(LINK, { selector: "code" })).toBeInTheDocument();
    const sent = creates(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `${BASE}/__member-invites/ben`, method: "POST" });
    expect(sent[0]!.headers["x-kinerary-member-invites"]).toBe("1");
    // both messages, each carrying the link and the traveller's name as the trip site has it
    const english = screen.getByLabelText("Message in English");
    const hebrew = screen.getByLabelText("הודעה בעברית");
    for (const box of [english, hebrew]) {
      expect((box as HTMLTextAreaElement).value).toContain(LINK);
      expect((box as HTMLTextAreaElement).value).toContain("Ben Cohen");
    }
    expect((english as HTMLTextAreaElement).value).toMatch(/only for you/i);
    expect((hebrew as HTMLTextAreaElement).value).toMatch(/רק לך/);
    // the expiry is said, and the page says it is not for the group
    expect(screen.getByText(/not for the family group/i)).toBeInTheDocument();
    expect((english as HTMLTextAreaElement).value).toMatch(/28 Nov 2026/);
    // an id never reaches the page
    expect(document.body.textContent).not.toMatch(/invite_|trip_/);
  });

  it("says the same, in Hebrew first, in a Hebrew site", async () => {
    stubGateway(ok);
    mount("he");
    fireEvent.click(await (await benRow()).findByRole("button", { name: "שליחת הזמנה אישית" }));
    expect(await screen.findByText(LINK, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByLabelText("הודעה בעברית")).toBeInTheDocument();
    expect(screen.getByLabelText("Message in English")).toBeInTheDocument();
    expect(screen.getByText(/לא מיועד לקבוצה המשפחתית/)).toBeInTheDocument();
  });

  it("sends one request for a double click (a click already in flight is not sent twice)", async () => {
    const calls = stubGateway(ok, 40);
    mount();
    const button = await (await benRow()).findByRole("button", { name: "Send a personal invite" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(LINK, { selector: "code" });
    expect(creates(calls)).toHaveLength(1);
  });

  it("asking again for the same traveller sends a fresh request and replaces the old link on screen", async () => {
    let n = 0;
    const calls = stubGateway((call) => (call.method === "POST" ? { status: 201, body: { joinUrl: `${LINK}${++n}`, displayName: "Ben Cohen", expiresAt: "2026-11-28T08:00:00.000Z" } } : { body: { available: true } }));
    mount();
    const row = (await benRow());
    fireEvent.click(await row.findByRole("button", { name: "Send a personal invite" }));
    await screen.findByText(`${LINK}1`, { selector: "code" });
    fireEvent.click(row.getByRole("button", { name: /send a personal invite|send again/i }));
    await screen.findByText(`${LINK}2`, { selector: "code" });
    expect(screen.queryByText(`${LINK}1`, { selector: "code" })).toBeNull();
    expect(creates(calls)).toHaveLength(2);
  });
});

describe("the answers that are not a link", () => {
  const press = async (answer: { status: number; body: unknown } | "network-error", lang: "en" | "he" = "en") => {
    stubGateway((call) => (probeOnly(call) ? { body: { available: true } } : answer));
    mount(lang);
    const name = lang === "he" ? "שליחת הזמנה אישית" : "Send a personal invite";
    fireEvent.click(await (await benRow()).findByRole("button", { name }));
  };

  it("someone signed in as them from the group: the organizer is told what to do first", async () => {
    await press({ status: 409, body: { error: "TRAVELLER_CLAIMED_FROM_GROUP" } });
    expect(await screen.findByText(/someone signed in as Ben from the group — release that sign-in first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message in English")).toBeNull();
  });

  it("someone signed in as them from the group, in Hebrew", async () => {
    await press({ status: 409, body: { error: "TRAVELLER_CLAIMED_FROM_GROUP" } }, "he");
    expect(await screen.findByText(/מישהו נכנס בתור בן מהקבוצה — קודם צריך לבטל את הכניסה הזו/)).toBeInTheDocument();
  });

  it.each([
    ["INVITE_ALREADY_EXISTS", /Ben already has a personal sign-in/i],
    ["RUNTIME_PARTICIPANT_NOT_ELIGIBLE", /organizers do not need a personal invite/i],
    ["RUNTIME_PARTICIPANT_NOT_FOUND", /Ben is not on the trip site/i],
    ["RUNTIME_NOT_READY", /trip site did not answer/i],
  ])("%s", async (error, message) => {
    await press({ status: 409, body: { error } });
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("a Telegram-minted organizer session is told to open the dashboard", async () => {
    await press({ status: 403, body: { error: "ACCOUNT_SIGN_IN_REQUIRED" } });
    expect(await screen.findByText(/open the dashboard to send a personal invite/i)).toBeInTheDocument();
  });

  it("anything else, an outage, a network error and a malformed 201 are a plain 'did not go through' that shows no link", async () => {
    for (const answer of [{ status: 404, body: { error: "NOT_FOUND" } }, { status: 503, body: { error: "RUNTIME_UNAVAILABLE" } }, { status: 201, body: { joinUrl: 7 } }, "network-error" as const]) {
      cleanup();
      await press(answer);
      expect(await screen.findByText(/that did not go through\. try again\./i)).toBeInTheDocument();
      expect(screen.queryByText(/tok_/)).toBeNull();
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Send a personal invite" })[0]).toBeEnabled());
    }
  });
});
