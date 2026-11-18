/**
 * #612 — the More page of the video layout, reorganised:
 *   - the name/picture in the header opens Account; Account reads: settings, connect Claude/ChatGPT, who is coming;
 *   - "Organizer settings" (organizers only) holds Signing in, Notifications and Trip look, and no module links;
 *   - the classic layout keeps its More page exactly as it was.
 * The whole App against the fetch stand-in of the video-release tests.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, dayItems, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

const VIDEO = { site_video_layout: true, plan_change_group_line: true };
const MEMBER = { username: "bat", name: "בת", name_en: "Bat", is_organizer: false };

/** The trip stand-in, plus the assistant-connection route the shared fixture does not serve. */
function serve(features: Record<string, boolean> | undefined, user?: Record<string, unknown>, mcp: unknown = { enabled: true, url: "https://trip.example/mcp", access: user?.is_organizer === false ? "read" : "read_write", connections: [] }) {
  const items = dayItems();
  const base = stubTripFetch(() => ({ config: config(features), today: todayContext(items), items, user }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (new URL(String(input), "http://trip.test").pathname === "/api/mcp/connection") {
      return new Response(JSON.stringify(mcp), { status: 200, headers: { "content-type": "application/json" } });
    }
    return base(input);
  }));
}

async function openMenu() {
  fireEvent.click(await screen.findByRole("button", { name: /^(More|עוד)$/ }));
  return screen.findByRole("dialog", { name: "Trip menu" });
}

describe("the menu", () => {
  it("an organizer sees Organizer settings, and no Who is coming", async () => {
    serve(VIDEO);
    renderTrip();
    const menu = await openMenu();
    expect(within(menu).getByRole("button", { name: "Organizer settings" })).toBeInTheDocument();
    expect(within(menu).queryByRole("button", { name: "Who is coming" })).toBeNull();
    // The classic organizer fallback stays in the menu's settings section.
    expect(within(menu).getByRole("link", { name: "Open Classic organizer fallback" })).toBeInTheDocument();
  });

  it("a member sees neither", async () => {
    serve(VIDEO, MEMBER);
    renderTrip();
    const menu = await openMenu();
    expect(within(menu).queryByRole("button", { name: "Organizer settings" })).toBeNull();
    expect(within(menu).queryByRole("button", { name: "Who is coming" })).toBeNull();
  });

  it("Hebrew: הגדרות מארגן", async () => {
    localStorage.setItem("tripLang", "he");
    serve(VIDEO);
    renderTrip();
    const menu = await openMenu();
    expect(within(menu).getByRole("button", { name: "הגדרות מארגן" })).toBeInTheDocument();
  });
});

describe("Organizer settings", () => {
  it("has the three titled sections and the toggle, and none of the module links", async () => {
    serve(VIDEO);
    renderTrip();
    fireEvent.click(within(await openMenu()).getByRole("button", { name: "Organizer settings" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Organizer settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Signing in" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trip look" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Tell the group when the plan changes" })).toBeInTheDocument();
    expect(screen.getByText("Change hero picture")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Back to the trip password" }).length).toBeGreaterThan(0);
    // The menu already links Bookings, Map, Budget...; the page does not repeat them, nor the classic fallback.
    const main = document.querySelector("main") as HTMLElement;
    for (const name of ["Map", "Budget", "Readiness", "Account", "Group activities", "Trivia", "Plan tools"]) {
      expect(within(main).queryByRole("link", { name }), name).toBeNull();
    }
    expect(within(main).queryByRole("link", { name: /classic organizer/i })).toBeNull();
    expect(main.querySelector(".workflow-link")).toBeNull();
    // Connecting an assistant is on Account, not here.
    expect(within(main).queryByRole("heading", { name: "Connect your AI assistant" })).toBeNull();
  });

  it("without the group-line switch there is no Notifications section", async () => {
    serve({ site_video_layout: true });
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByRole("heading", { name: "Trip look" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("Hebrew titles", async () => {
    localStorage.setItem("tripLang", "he");
    serve(VIDEO);
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByRole("heading", { level: 2, name: "הגדרות מארגן" })).toBeInTheDocument();
    for (const name of ["כניסה לאתר", "התראות", "מראה הטיול"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("a member who opens it by address is told organizer access is required", async () => {
    serve(VIDEO, MEMBER);
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByText("Organizer access required.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Signing in" })).toBeNull();
    expect(screen.queryByText("Change hero picture")).toBeNull();
  });
});

describe("the identity button opens Account", () => {
  it("Account reads: settings, then connecting an assistant, then who is coming — for an organizer", async () => {
    serve(VIDEO);
    renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: /Signed in as Avi/ }));
    const account = await screen.findByRole("heading", { name: "Your account" });
    const password = screen.getByRole("heading", { name: "Trip password" });
    const connect = await screen.findByRole("heading", { name: "Connect your AI assistant" });
    const coming = screen.getByRole("heading", { name: "Who is coming" });
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(account, password)).toBe(true);
    expect(before(password, connect)).toBe(true);
    expect(before(connect, coming)).toBe(true);
    expect(screen.getByText("Person 3")).toBeInTheDocument(); // a traveller, from the list
    expect(screen.getByText(/make the changes you can make here/i)).toBeInTheDocument(); // read and write
    expect(screen.getByRole("heading", { level: 1, name: "Colmar · Account" })).toBeInTheDocument();
  });

  it("a member gets the same page, with the read-only connection and the traveller list", async () => {
    serve(VIDEO, MEMBER);
    renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: /Signed in as Bat/ }));
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(await screen.findByText(/can read the trip, not change it/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Who is coming" })).toBeInTheDocument();
    expect(screen.queryByText("Change hero picture")).toBeNull();
  });

  it("shows no connection block when the trip has not turned the endpoint on, and still lists the travellers", async () => {
    serve(VIDEO, undefined, { enabled: false });
    renderTrip({ hash: "account" });
    expect(await screen.findByRole("heading", { name: "Who is coming" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Connect your AI assistant" })).toBeNull());
  });

  it("Hebrew: מי משתתף בטיול", async () => {
    localStorage.setItem("tripLang", "he");
    serve(VIDEO);
    renderTrip({ hash: "account" });
    expect(await screen.findByRole("heading", { name: "מי משתתף בטיול" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "חיבור עוזר AI" })).toBeInTheDocument();
  });
});

describe("classic layout unchanged", () => {
  it("More still holds the travellers, the organizer tools and the assistant block; the menu has no Organizer settings", async () => {
    serve(undefined);
    const { container } = renderTrip({ hash: "more" });
    expect(await screen.findByRole("heading", { name: "Who is coming" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Signing in" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Connect your AI assistant" })).toBeInTheDocument();
    expect(container.querySelector(".workflow-link")).not.toBeNull();
    expect(container.querySelector(".video-layout")).toBeNull();
  });

  it("#organizer-settings is not a page there, and Account is the account alone", async () => {
    serve(undefined);
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByRole("heading", { level: 1, name: "Alsace" })).toBeInTheDocument(); // falls back to the tab content (Today)
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("Organizer access required.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Trip look" })).toBeNull();
    cleanup();
    serve(undefined);
    renderTrip({ hash: "account" });
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Who is coming" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect your AI assistant" })).toBeNull();
  });
});
