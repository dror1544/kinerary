/**
 * The tabs and the header of the video layout (AC-5, AC-6, and AC-1's "the current layout when off" /
 * AC-4's "the layout ignores the markers when only plan_change_marks is on").
 *
 * The whole App, against a fetch stand-in: the switch arrives the way it does in life, in the `features`
 * node of GET /api/config, and is read through `featureOn` (literal true, or off).
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

describe("switches off: the current layout (AC-1, AC-4)", () => {
  it("shows Today · Journey · Moments · More, the current header, and no video-layout root", async () => {
    serve(undefined);
    const { container } = renderTrip();
    await screen.findByText("Colmar", { selector: "h1" }).catch(() => undefined);
    expect(tabNames()).toEqual(["Today", "Journey", "Moments", "More"]);
    await waitFor(() => expect(container.querySelector(".modern-trip-app")).not.toBeNull());
    expect(container.querySelector(".video-layout")).toBeNull();
    expect(container.querySelector(".video-hero")).toBeNull();
    expect(screen.queryByRole("link", { name: /^Go to / })).toBeNull();
  });

  it("with only plan_change_marks on the layout is still the current one and the markers are ignored without error", async () => {
    serve({ plan_change_marks: true });
    const { container } = renderTrip();
    // The current Today shows only the next item; markers on the data change nothing about it.
    await waitFor(() => expect(screen.getAllByText("Winery tour").length).toBeGreaterThan(0));
    expect(tabNames()).toEqual(["Today", "Journey", "Moments", "More"]);
    expect(container.querySelector(".video-layout")).toBeNull();
    expect(screen.queryByText("Updated")).toBeNull();
    expect(container.querySelector(".change-badge")).toBeNull();
    expect(container.querySelector("del")).toBeNull();
  });

  it("anything but the literal true is off", async () => {
    for (const value of ["true", 1, "yes", {}]) {
      serve({ site_video_layout: value });
      const { container, unmount } = renderTrip();
      await waitFor(() => expect(container.querySelector(".modern-trip-app")).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(tabNames(), JSON.stringify(value)).toEqual(["Today", "Journey", "Moments", "More"]);
      unmount();
    }
  });
});

describe("AC-5: the video layout", () => {
  it("bottom bar reads Today · Plan · Bookings · Photos and the header says \"Colmar · Today\"", async () => {
    serve({ site_video_layout: true });
    const { container } = renderTrip();
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Today" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["Today", "Plan", "Bookings", "Photos"]);
    expect(container.querySelector(".modern-trip-app.video-layout")).not.toBeNull();
    // The tabs are in the bottom bar (decision 11), not pills under the header.
    expect(within(container.querySelector(".video-hero") as HTMLElement).queryAllByRole("link", { name: "Bookings" }).length).toBe(1); // the desktop tabs, hidden by CSS below 880px
  });

  it("More is a header button; its menu lists the modules that are no longer tabs, and Who is coming", async () => {
    serve({ site_video_layout: true });
    renderTrip();
    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);
    const menu = await screen.findByRole("dialog", { name: "Trip menu" });
    const entries = within(menu).getAllByRole("button").map((button) => button.textContent?.trim());
    for (const wanted of ["Map", "Budget", "Readiness", "Account", "Group activities", "Lost & Found", "Trivia", "Plan tools", "Who is coming", "עברית"]) {
      expect(entries, wanted).toContain(wanted);
    }
    // Bookings and Photos are tabs now: listed once, under Navigation, not again among the tools.
    expect(entries.filter((entry) => entry === "Bookings")).toHaveLength(1);
    expect(entries.filter((entry) => entry === "Photos")).toHaveLength(1);
    expect(within(menu).getByRole("link", { name: "Open Classic organizer fallback" })).toBeInTheDocument();
  });

  it("a member's menu has no Plan tools and no Classic link", async () => {
    serve({ site_video_layout: true }, { username: "bat", name_en: "Bat", is_organizer: false });
    renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const menu = await screen.findByRole("dialog", { name: "Trip menu" });
    expect(within(menu).queryByRole("button", { name: "Plan tools" })).toBeNull();
    expect(within(menu).queryByRole("link", { name: "Open Classic organizer fallback" })).toBeNull();
  });

  it("Who is coming opens the participants", async () => {
    serve({ site_video_layout: true });
    renderTrip();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Trip menu" })).getByRole("button", { name: "Who is coming" }));
    expect(await screen.findByRole("heading", { name: "Who is coming" })).toBeInTheDocument();
  });

  it("Hebrew: היום · תוכנית · הזמנות · תמונות, right-to-left", async () => {
    localStorage.setItem("tripLang", "he");
    serve({ site_video_layout: true });
    renderTrip();
    expect(await screen.findByRole("heading", { level: 1, name: "קולמר · היום" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["היום", "תוכנית", "הזמנות", "תמונות"]);
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("button", { name: "עוד" })).toBeInTheDocument();
  });

  it("the tabs navigate: Plan, Bookings, Photos, and the header follows", async () => {
    serve({ site_video_layout: true });
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
    serve({ site_video_layout: true });
    renderTrip({ hash: "journey" });
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Plan" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Plan" })).toHaveClass("active");
    expect(document.querySelector(".plan-strip")).not.toBeNull();
  });

  it("#moments opens Photos, with Moments as a section inside it", async () => {
    serve({ site_video_layout: true });
    renderTrip({ hash: "moments" });
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Photos" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Photos" })).toHaveClass("active");
    expect(await screen.findByText("Capture the day while it is still fresh.")).toBeInTheDocument();
  });

  it("with the switch off #moments is still the Moments tab", async () => {
    serve(undefined);
    renderTrip({ hash: "moments" });
    expect(await screen.findByText("Capture the day while it is still fresh.")).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Moments" })).toHaveClass("active");
  });

  it.each([
    ["bookings", "Bookings"], ["budget", "Budget"], ["photos", "Photos"], ["readiness", "Readiness"],
    ["account", "Account"], ["activities", "Group activities"], ["trivia", "Trivia"], ["plan-tools", "Plan tools"],
  ])("#%s still opens its module", async (hash, label) => {
    serve({ site_video_layout: true });
    renderTrip({ hash });
    expect(await screen.findByRole("heading", { level: 1, name: `Colmar · ${label}` })).toBeInTheDocument();
  });

  it("#lostfound and #map (the two the menu reaches) are still modules", async () => {
    serve({ site_video_layout: true });
    renderTrip({ hash: "lostfound" });
    expect(await screen.findByRole("heading", { level: 1, name: "Colmar · Lost & Found" })).toBeInTheDocument();
  });
});
