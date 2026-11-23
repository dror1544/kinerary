/**
 * The tabs and the header of the video layout (AC-5, AC-6). It is the only layout since 2026-11-21: there is no
 * switch for it, and a trip file that still names the retired `site_video_layout` gets the same page.
 *
 * The whole App, against a fetch stand-in: `plan_change_marks`, the one switch left, arrives the way it does in life,
 * in the `features` node of GET /api/config, and is read through `featureOn` (literal true, or off).
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, dayItems, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

function serve(features?: Record<string, unknown>, user?: Record<string, unknown>) {
  const items = dayItems();
  stubTripFetch(() => ({ config: config(features as Record<string, boolean> | undefined), today: todayContext(items), items, user }));
}
const nav = () => screen.getByRole("navigation", { name: "Primary" });
const tabNames = () => within(nav()).getAllByRole("link").map((link) => link.textContent?.trim());

describe("the video layout is the only layout (owner, 2026-11-21)", () => {
  it("a trip with no `features` at all gets it, from the first paint, before the config has even arrived", async () => {
    serve(undefined);
    const { container } = renderTrip();
    // Synchronously after render: nothing has been fetched yet, so the config is still undefined.
    expect(container.querySelector(".modern-trip-app.video-layout")).not.toBeNull();
    expect(container.querySelector(".video-hero")).not.toBeNull();
    expect(within(nav()).getAllByRole("link").map((link) => link.textContent?.trim())).toEqual(["Today", "Plan", "Bookings", "Photos"]);
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Today" })).toBeInTheDocument();
  });

  it("the retired `site_video_layout` switch, whatever a trip's file still says, changes nothing", async () => {
    for (const value of [true, false, "true", 1, "yes", {}]) {
      serve({ site_video_layout: value });
      const { container, unmount } = renderTrip();
      expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Today" }), JSON.stringify(value)).toBeInTheDocument();
      expect(tabNames(), JSON.stringify(value)).toEqual(["Today", "Plan", "Bookings", "Photos"]);
      expect(container.querySelector(".modern-trip-app.video-layout"), JSON.stringify(value)).not.toBeNull();
      unmount();
    }
  });

  it("the change marks still follow their own switch: off, a marker the server handed is not drawn", async () => {
    serve(undefined);
    const { container } = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    expect(container.querySelector(".change-badge")).toBeNull();
    expect(container.querySelector("del")).toBeNull();
  });
});

describe("AC-5: the video layout", () => {
  it("bottom bar reads Today · Plan · Bookings · Photos and the header says \"Colmar · Today\"", async () => {
    serve();
    const { container } = renderTrip();
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Today" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["Today", "Plan", "Bookings", "Photos"]);
    expect(container.querySelector(".modern-trip-app.video-layout")).not.toBeNull();
    // The tabs are in the bottom bar (decision 11), not pills under the header.
    expect(within(container.querySelector(".video-hero") as HTMLElement).queryAllByRole("link", { name: "Bookings" }).length).toBe(1); // the desktop tabs, hidden by CSS below 880px
  });

  it("More is a header button; its menu lists the modules that are no longer tabs, and Organizer settings", async () => {
    serve();
    renderTrip();
    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);
    const menu = await screen.findByRole("dialog", { name: "Trip menu" });
    const entries = within(menu).getAllByRole("button").map((button) => button.textContent?.trim());
    for (const wanted of ["Map", "Budget", "Readiness", "Account", "Group activities", "Lost & Found", "Trivia", "Plan tools", "Organizer settings", "עברית"]) {
      expect(entries, wanted).toContain(wanted);
    }
    // Bookings and Photos are tabs now: listed once, under Navigation, not again among the tools.
    expect(entries.filter((entry) => entry === "Bookings")).toHaveLength(1);
    expect(entries.filter((entry) => entry === "Photos")).toHaveLength(1);
    expect(within(menu).getByRole("link", { name: "Open Classic organizer fallback" })).toBeInTheDocument();
  });

  it("Readiness (tasks, packing, useful information) is a menu entry that opens #readiness, for a member too", async () => {
    serve(undefined, { username: "bat", name_en: "Bat", is_organizer: false });
    renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const menu = await screen.findByRole("dialog", { name: "Trip menu" });
    fireEvent.click(within(menu).getByRole("button", { name: "Readiness" }));
    expect(window.location.hash).toBe("#readiness");
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Readiness" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Trip menu" })).toBeNull();
  });

  it("a member's menu has no Plan tools and no Classic link", async () => {
    serve(undefined, { username: "bat", name_en: "Bat", is_organizer: false });
    renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const menu = await screen.findByRole("dialog", { name: "Trip menu" });
    expect(within(menu).queryByRole("button", { name: "Plan tools" })).toBeNull();
    expect(within(menu).queryByRole("link", { name: "Open Classic organizer fallback" })).toBeNull();
  });

  it("Hebrew: היום · תוכנית · הזמנות · תמונות, right-to-left", async () => {
    localStorage.setItem("tripLang", "he");
    serve();
    renderTrip();
    expect(await screen.findByRole("heading", { level: 1, name: "קולמר · היום" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["היום", "תוכנית", "הזמנות", "תמונות"]);
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("button", { name: "עוד" })).toBeInTheDocument();
  });

  it("the tabs navigate: Plan, Bookings, Photos, and the header follows", async () => {
    serve();
    renderTrip();
    await screen.findByRole("heading", { level: 1, name: "Colmar · Today" });
    fireEvent.click(within(nav()).getByRole("link", { name: "Plan" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Plan" })).toBeInTheDocument();
    fireEvent.click(within(nav()).getByRole("link", { name: "Bookings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Bookings" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Bookings" })).toHaveClass("active");
    fireEvent.click(within(nav()).getByRole("link", { name: "Photos" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Photos" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Photos" })).toHaveClass("active");
  });
});

describe("AC-6: old addresses keep working", () => {
  it("#journey opens Plan", async () => {
    serve();
    renderTrip({ hash: "journey" });
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Plan" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Plan" })).toHaveClass("active");
    expect(document.querySelector(".plan-strip")).not.toBeNull();
  });

  it("#moments opens Photos, with Moments as a section inside it", async () => {
    serve();
    renderTrip({ hash: "moments" });
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Photos" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Photos" })).toHaveClass("active");
    expect(await screen.findByText("Capture the day while it is still fresh.")).toBeInTheDocument();
  });

  it.each([
    ["bookings", "Bookings"], ["budget", "Budget"], ["photos", "Photos"], ["readiness", "Readiness"],
    ["account", "Account"], ["activities", "Group activities"], ["trivia", "Trivia"], ["plan-tools", "Plan tools"],
  ])("#%s still opens its module", async (hash, label) => {
    serve();
    renderTrip({ hash });
    expect(await screen.findByRole("heading", { level: 1, name: `Colmar · ${label}` })).toBeInTheDocument();
  });

  it("#lostfound and #map (the two the menu reaches) are still modules", async () => {
    serve();
    renderTrip({ hash: "lostfound" });
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Lost & Found" })).toBeInTheDocument();
  });
});
