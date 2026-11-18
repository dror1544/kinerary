/**
 * "Updates are obvious on the site" (AC-19..AC-22, and AC-23's client half).
 *
 * The page draws what the server marks: an Updated row with the old time struck through, New for
 * an added item, "Updated for everyone ✓ · N min ago" with up to five participants' avatars, the
 * same treatment on Plan with the teal provenance only in the detail, and the live arrival — a
 * change made while the page is open — animating, or not, with prefers-reduced-motion.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, dayItems, item, PARTICIPANTS, renderTrip, stubTripFetch, todayContext, useJsdomBasics, type Served } from "./test/video-fixtures";
import { relativeAgo } from "./recent-change";
import type { ItineraryItem } from "./api";

const BOTH = { site_video_layout: true, plan_change_marks: true };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

function serve(features: Record<string, boolean>, items: ItineraryItem[]) {
  const state: Served = { config: config(features), today: todayContext(items), items };
  stubTripFetch(() => state);
  return state;
}
const dinnerRow = async () => (await screen.findByRole("button", { name: "Dinner at the Winstub" })).closest("li") as HTMLElement;

describe("AC-19: an Updated row and the line under the card", () => {
  it("the row is coral-tinted with an Updated badge and the old time struck through beside the new one", async () => {
    serve(BOTH, dayItems(ago(5)));
    renderTrip();
    const row = await dinnerRow();
    expect(row).toHaveClass("is-updated");
    expect(within(row).getByText("Updated")).toHaveClass("change-badge", "updated");
    const old = row.querySelector("del");
    expect(old?.textContent).toBe("20:00");
    expect(old?.querySelector("bdi")).toHaveAttribute("dir", "ltr");
    expect(row.querySelector(".change-time-new")?.textContent).toBe("19:00");
    // Only the changed item is marked.
    expect(document.querySelectorAll(".day-row.is-updated")).toHaveLength(1);
  });

  it("an added item shows the New badge (an outline, no fill)", async () => {
    const items = [...dayItems(ago(120)).map((entry) => ({ ...entry, recent_change: undefined })), item({ item_uid: "new", text_en: "Rooftop drinks", text_he: "משקאות", time: "22:00", time_sort: 1320, recent_change: { kind: "added", at: ago(3), fields: [] } })];
    serve(BOTH, items);
    renderTrip();
    const row = (await screen.findByRole("button", { name: "Rooftop drinks" })).closest("li") as HTMLElement;
    expect(row).toHaveClass("is-added");
    expect(within(row).getByText("New")).toHaveClass("change-badge", "new");
    expect(row.querySelector("del")).toBeNull();
  });

  it("under the card: \"Updated for everyone ✓ · 5 min. ago\" beside at most five avatars, then +n", async () => {
    serve(BOTH, dayItems(ago(5)));
    renderTrip();
    const line = await screen.findByRole("status");
    expect(line).toHaveTextContent("Updated for everyone ✓");
    expect(line).toHaveTextContent(/5 min\. ago/);
    expect(line.querySelectorAll(".change-avatar")).toHaveLength(5);
    expect(PARTICIPANTS.length).toBe(7);
    expect(within(line).getByText("+2")).toBeInTheDocument();
  });

  it("takes the newest change on the card for the time", async () => {
    const items = dayItems(ago(40)).map((entry) => (entry.item_uid === "breakfast" ? { ...entry, recent_change: { kind: "updated" as const, at: ago(2), fields: ["place"] } } : entry));
    serve(BOTH, items);
    renderTrip();
    expect(await screen.findByRole("status")).toHaveTextContent(/2 min\. ago/);
  });

  it("never says who: no author, avatar-of-editor or \"changed by\" anywhere on the page", async () => {
    serve(BOTH, dayItems(ago(5)));
    const { container } = renderTrip();
    await dinnerRow();
    expect(container.textContent).not.toMatch(/changed by|updated by|edited by|seen by|read by/i);
  });

  it("with no marker there is no line", async () => {
    serve(BOTH, dayItems(ago(5)).map((entry) => ({ ...entry, recent_change: undefined })));
    renderTrip();
    await dinnerRow();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("with plan_change_marks off the page ignores a marker it was handed", async () => {
    serve({ site_video_layout: true }, dayItems(ago(5)));
    renderTrip();
    await dinnerRow();
    expect(document.querySelector(".change-badge")).toBeNull();
    expect(document.querySelector("del")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("relativeAgo", () => {
  const now = Date.parse("2026-12-03T12:00:00Z");
  it("English, short: just now, minutes, hours", () => {
    expect(relativeAgo("2026-12-03T11:59:40Z", now, "en")).toBe("just now");
    expect(relativeAgo("2026-12-03T11:55:00Z", now, "en")).toBe("5 min. ago");
    expect(relativeAgo("2026-12-03T09:00:00Z", now, "en")).toBe("3 hr. ago");
  });
  it("Hebrew: לפני 5 דק׳", () => {
    expect(relativeAgo("2026-12-03T11:55:00Z", now, "he")).toBe("לפני 5 דק׳");
    expect(relativeAgo("2026-12-03T11:59:50Z", now, "he")).toBe("הרגע");
  });
});

describe("AC-20: the same treatment on Plan, with the teal provenance only in the detail", () => {
  it("shows Updated and the struck-through time on the Plan row; \"Updated from original\" only after the row is opened", async () => {
    const items = dayItems(ago(5)).map((entry) => (entry.item_uid === "dinner" ? { ...entry, provenance: { status: "updated_from_original" } } : entry));
    serve(BOTH, items);
    renderTrip({ hash: "journey" });
    const dinner = (await screen.findByRole("heading", { name: "Dinner at the Winstub" })).closest("article") as HTMLElement;
    expect(dinner).toHaveClass("is-updated");
    expect(within(dinner).getByText("Updated")).toHaveClass("change-badge");
    expect(dinner.querySelector("del")?.textContent).toBe("20:00");
    // The kicker no longer carries the provenance; the detail does.
    expect(within(dinner).queryByText("Updated from original")).toBeNull();
    fireEvent.click(within(dinner).getByRole("button", { name: "Dinner at the Winstub" }));
    const detail = dinner.querySelector(".item-detail") as HTMLElement;
    expect(within(detail).getByText("Updated from original")).toBeInTheDocument();
    expect(dinner.querySelector(".item-kicker")?.textContent).not.toContain("Updated from original");
  });

  it("with the video layout off the provenance stays in the kicker, as today", async () => {
    const items = dayItems(ago(5)).map((entry) => (entry.item_uid === "dinner" ? { ...entry, provenance: { status: "updated_from_original" } } : entry));
    stubTripFetch(() => ({ config: config(undefined), today: todayContext(items), items }));
    renderTrip({ hash: "journey" });
    const dinner = (await screen.findByRole("heading", { name: "Dinner at the Winstub" })).closest("article") as HTMLElement;
    expect(dinner.querySelector(".item-kicker")?.textContent).toContain("Updated from original");
    expect(dinner.querySelector(".change-badge")).toBeNull();
  });

  it("a moved item reads \"Moved from <weekday>\"", async () => {
    const items = dayItems(ago(5)).map((entry) => (entry.item_uid === "winery" ? { ...entry, recent_change: { kind: "updated" as const, at: ago(5), fields: ["date"], previous_date: "2026-12-02" } } : entry));
    serve(BOTH, items);
    renderTrip();
    const row = (await screen.findByRole("button", { name: "Winery tour" })).closest("li") as HTMLElement;
    expect(within(row).getByText("Moved from Wednesday")).toBeInTheDocument();
    expect(within(row).getByText("Updated")).toBeInTheDocument();
    expect(row.querySelector("del")).toBeNull();
  });
});

describe("AC-21 / AC-22: live arrival and expiry, without a reload", () => {
  const before = () => dayItems(ago(120)).map((entry) => (entry.item_uid === "dinner" ? { ...entry, time: "20:00", recent_change: undefined } : entry));
  const dinnerChanged = () => dayItems(ago(0.2));

  async function arrive(state: Served, client: { invalidateQueries: (opts: { queryKey: string[] }) => Promise<void> }, items: ItineraryItem[]) {
    state.items = items;
    state.today = todayContext(items);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["itinerary"] });
      await client.invalidateQueries({ queryKey: ["today"] });
    });
  }

  it("a change made while the page is open turns the row coral with 20:00 struck through, and plays the highlight", async () => {
    const state = serve(BOTH, before());
    const { client } = renderTrip();
    const row = await dinnerRow();
    expect(row).not.toHaveClass("is-updated");
    expect(row.querySelector("del")).toBeNull();
    await arrive(state, client, dinnerChanged());
    await waitFor(() => expect(row.closest("ol")!.querySelector(".day-row.is-updated")).not.toBeNull(), { timeout: 5000 });
    const updated = (await dinnerRow());
    expect(updated.querySelector("del")?.textContent).toBe("20:00");
    expect(updated.querySelector(".change-time-new")?.textContent).toBe("19:00");
    expect(updated).toHaveClass("is-fresh");
    expect(screen.getByRole("status")).toHaveTextContent("Updated for everyone ✓");
  });

  it("with prefers-reduced-motion it reaches the same state with no animation class", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })));
    const state = serve(BOTH, before());
    const { client } = renderTrip();
    await dinnerRow();
    await arrive(state, client, dinnerChanged());
    await waitFor(() => expect(document.querySelector(".day-row.is-updated")).not.toBeNull(), { timeout: 5000 });
    const updated = await dinnerRow();
    expect(updated.querySelector("del")?.textContent).toBe("20:00");
    expect(updated).not.toHaveClass("is-fresh");
    expect(document.querySelector(".is-fresh")).toBeNull();
  });

  it("opening the page on an already-marked day animates nothing", async () => {
    serve(BOTH, dayItems(ago(5)));
    renderTrip();
    const row = await dinnerRow();
    expect(row).toHaveClass("is-updated");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".is-fresh")).toBeNull();
  });

  it("AC-22: when the change leaves the window the marker is gone at the next refresh", async () => {
    const state = serve(BOTH, dayItems(ago(5)));
    const { client } = renderTrip();
    expect(await dinnerRow()).toHaveClass("is-updated");
    await arrive(state, client, dayItems(ago(5)).map((entry) => ({ ...entry, recent_change: undefined })));
    await waitFor(() => expect(document.querySelector(".day-row.is-updated")).toBeNull());
    expect(document.querySelector("del")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("changing it back removes the marker (AC-27's second half)", async () => {
    const state = serve(BOTH, dayItems(ago(1)));
    const { client } = renderTrip();
    expect(await dinnerRow()).toHaveClass("is-updated");
    await arrive(state, client, before());
    await waitFor(() => expect(document.querySelector("del")).toBeNull());
    expect((await dinnerRow()).querySelector(".change-time-new, bdi")?.textContent).toBe("20:00");
  });
});

describe("AC-23, the client half: a marker this build does not understand is dropped, never fatal", () => {
  it("renders the day when recent_change is malformed", async () => {
    const items = dayItems(ago(5)).map((entry) => (entry.item_uid === "dinner" ? { ...entry, recent_change: { kind: "teleported", at: "yesterday-ish" } as never } : entry));
    serve(BOTH, items);
    renderTrip({ hash: "journey" });
    expect(await screen.findByRole("heading", { name: "Dinner at the Winstub" })).toBeInTheDocument();
    expect(document.querySelector(".change-badge")).toBeNull();
  });
});
