/// <reference types="node" />
/**
 * Video Release 1, look polish (Dror's review of the live staging site, 2026-11-17):
 *   1. the hero photo shows (no teal wash over it); the teal gradient stays over the skyline when there is no photo;
 *   2. the navigation-app setting lives in Plan tools, organizer only (the Go chips are pinned in day-card.test.tsx);
 *   3. no "More" kicker above the More page's heading;
 *   4. no arrow on any row: a row with detail is itself the control, and Go does not also toggle it;
 *   5. the page keeps room under the fixed bottom bar, and the Go chips share one column.
 * jsdom cannot judge colour or layout, so a style is pinned by the class a node carries and by the rule's text.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoHero } from "./App";
import { tokenStore } from "./api";
import { config, dayItems, item, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); window.location.hash = ""; });

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `a rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
};

function renderHero(photoConfig: object) {
  return render(<VideoHero config={photoConfig as never} lang="en" placePhaseId="colmar" pageName="Today" active="today" openVideoTab={vi.fn()} openMenu={vi.fn()} />);
}

describe("1. the hero photo shows", () => {
  it("with a photo the wash is the photo wash (navy, no teal); with none it is the teal skyline wash", async () => {
    tokenStore.set("t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:hero");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("Image", class { src = ""; decode = vi.fn().mockResolvedValue(undefined); });

    const withPhoto = renderHero({ meta: { title: "Alsace", homePhoto: "/api/ui/hero/photo.png" }, phases: [{ id: "colmar", title: { en: "Colmar" } }] });
    await waitFor(() => expect(withPhoto.container.querySelector("header")).toHaveAttribute("data-photo-state", "ready"));
    const photoWash = withPhoto.container.querySelector(".video-hero-wash")!;
    expect(photoWash).toHaveClass("is-photo");
    expect(photoWash).not.toHaveClass("is-skyline");
    expect(withPhoto.container.querySelector(".skyline-motif")).toBeNull();
    withPhoto.unmount();

    const noPhoto = renderHero({ meta: { title: "Alsace" }, phases: [{ id: "colmar", title: { en: "Colmar" } }] });
    const skylineWash = noPhoto.container.querySelector(".video-hero-wash")!;
    expect(skylineWash).toHaveClass("is-skyline");
    expect(skylineWash).not.toHaveClass("is-photo");
    expect(noPhoto.container.querySelector(".skyline-motif")).not.toBeNull();
  });

  it("the photo wash paints no teal and stays light on top; the skyline wash keeps the teal", () => {
    const photo = rule(".video-hero-wash.is-photo");
    expect(photo).not.toMatch(/14,\s*143,\s*134|10,\s*98,\s*92/); // the two teals of the old wash
    expect(photo).toMatch(/16,\s*38,\s*58/); // navy
    expect(photo).toMatch(/linear-gradient\(180deg/);
    expect(rule(".video-hero-wash.is-skyline")).toMatch(/14,\s*143,\s*134/);
    expect(rule(".video-hero-wash")).not.toContain("background");
  });
});

describe("3. the header's More button is the menu icon alone", () => {
  const serve = (features?: Record<string, boolean>) => {
    const items = dayItems();
    stubTripFetch(() => ({ config: config(features), today: todayContext(items), items }));
  };

  it("video layout: no visible word, still named for assistive tech, and the More page's own label is untouched", async () => {
    serve({});
    const { container } = renderTrip();
    const button = await screen.findByRole("button", { name: "More" });
    expect(button).toHaveAttribute("aria-label", "More");
    expect(button.textContent?.trim()).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".more-button span")).toBeNull();
  });

  it("Hebrew: the button is named עוד and shows no word", async () => {
    localStorage.setItem("tripLang", "he");
    serve({});
    renderTrip();
    const button = await screen.findByRole("button", { name: "עוד" });
    expect(button.textContent?.trim()).toBe("");
  });

  it("the tap target is at least 44px", () => {
    const more = rule(".video-layout .more-button");
    expect(more).toMatch(/min-width:\s*44px/);
    expect(more).toMatch(/min-height:\s*44px/);
  });
});

describe("2. the navigation app setting in Plan tools", () => {
  const serve = (user?: Record<string, unknown>, features: Record<string, boolean> = {}) => {
    const items = dayItems();
    return stubTripFetch(() => ({ config: config(features), today: todayContext(items), items, user, settings: { nav_app: "google" } }));
  };

  it("an organizer sees it, defaulting to Google Maps, and choosing Waze PATCHes only nav_app", async () => {
    const fetchMock = serve();
    renderTrip({ hash: "plan-tools" });
    const select = await screen.findByRole("combobox", { name: "Navigation app" });
    await waitFor(() => expect(select).toHaveValue("google"));
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Google Maps", "Waze"]);
    fireEvent.change(select, { target: { value: "waze" } });
    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo, RequestInit | undefined]>;
      const call = calls.find(([url, init]) => String(url).endsWith("/api/settings") && init?.method === "PATCH");
      expect(call, "a PATCH to /api/settings").toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ nav_app: "waze" });
    });
  });

  it("Hebrew label", async () => {
    localStorage.setItem("tripLang", "he");
    serve();
    renderTrip({ hash: "plan-tools" });
    expect(await screen.findByRole("combobox", { name: "אפליקציית ניווט" })).toBeInTheDocument();
  });

  it("a member gets no setting (the server refuses the write too, see tests/settings-nav-app.test.js)", async () => {
    serve({ username: "bat", name_en: "Bat", is_organizer: false });
    renderTrip({ hash: "plan-tools" });
    await screen.findByText("Organizer access required.");
    expect(screen.queryByRole("combobox", { name: "Navigation app" })).toBeNull();
  });
});

describe("4. no arrow on a row: the row itself is the control", () => {
  const withProvenance = () => dayItems().map((entry) => (entry.item_uid === "dinner" ? { ...entry, provenance: { status: "updated_from_original" } } : entry));
  const servePlan = () => {
    const items = withProvenance();
    stubTripFetch(() => ({ config: config({ plan_change_marks: true }), today: todayContext(items), items }));
  };
  const dinnerRow = async () => (await screen.findByRole("heading", { name: "Dinner at the Winstub" })).closest("article") as HTMLElement;

  it("renders no chevron, arrow or detail-toggle on the Today card or on a Plan row", async () => {
    servePlan();
    const today = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    expect(today.container.querySelector(".detail-toggle, .day-row-waze")).toBeNull();
    expect(today.container.querySelector(".day-row svg[class*='chevron'], .day-row svg[class*='arrow']")).toBeNull();
    expect(screen.queryByRole("button", { name: /More options/ })).toBeNull();
    today.unmount();
    const plan = renderTrip({ hash: "journey" });
    await dinnerRow();
    expect(plan.container.querySelector(".detail-toggle, .timeline-item svg[class*='chevron'], .timeline-item svg[class*='arrow']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("a tap on the row opens its detail (aria-expanded) and a second closes it; the title button does the same by keyboard", async () => {
    servePlan();
    renderTrip({ hash: "journey" });
    const row = await dinnerRow();
    const control = within(row).getByRole("button", { name: "Dinner at the Winstub" });
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(row.querySelector(".item-detail")).toBeNull();
    fireEvent.click(row.querySelector(".item-meta") ?? row); // a tap on the row's own body
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(row.querySelector(".item-detail")).not.toBeNull();
    fireEvent.click(row);
    expect(control).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(control); // the button is the keyboard route (Enter and Space click a button)
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(row.querySelectorAll("[aria-expanded]")).toHaveLength(1); // one control per row, not one plus a side button
  });

  it("tapping Go navigates and does not toggle the row", async () => {
    servePlan();
    renderTrip({ hash: "journey" });
    const row = await dinnerRow();
    const control = within(row).getByRole("button", { name: "Dinner at the Winstub" });
    const go = within(row).getByRole("link", { name: "Go to Dinner at the Winstub" });
    expect(go).toHaveAttribute("href", expect.stringContaining("google.com/maps"));
    fireEvent.click(go);
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(row.querySelector(".item-detail")).toBeNull();
  });

  it("a row with nothing to open has no toggle at all", async () => {
    servePlan();
    renderTrip({ hash: "journey" });
    const winery = (await screen.findByRole("heading", { name: "Winery tour" })).closest("article") as HTMLElement;
    expect(winery.querySelector("[aria-expanded]")).toBeNull();
    expect(winery).not.toHaveClass("has-detail");
  });

  it("the Today rows give every Go chip the same column: the row's third grid column is fixed, not auto", () => {
    expect(rule(".day-row")).toMatch(/grid-template-columns:\s*76px minmax\(0, 1fr\) 88px/);
    expect(css).toMatch(/\.day-row \{ grid-template-columns: 62px minmax\(0, 1fr\) 84px/);
    expect(rule(".day-row-title")).toContain("overflow-wrap: anywhere");
  });
});

describe("5. room under the fixed bottom bar", () => {
  it("the video layout's page keeps the bar's height, its gap and the safe-area inset free at its foot", () => {
    const padding = rule(".video-layout.modern-trip-app");
    expect(padding).toContain("padding-bottom");
    expect(padding).toContain("env(safe-area-inset-bottom");
    expect(padding).toMatch(/64px \+ 12px/); // the bar's min-height and its bottom offset (.bottom-nav)
    expect(rule(".bottom-nav")).toMatch(/bottom:\s*12px/);
    expect(rule(".bottom-nav")).toMatch(/min-height:\s*64px/);
    expect(rule(".video-layout .bottom-nav")).toContain("env(safe-area-inset-bottom");
  });

  it("the app root carries the video-layout class only with the switch on", async () => {
    stubTripFetch(() => ({ config: config({}), today: todayContext(dayItems()), items: dayItems() }));
    const on = renderTrip();
    await screen.findByRole("region", { name: /Thursday/ });
    expect(on.container.querySelector(".modern-trip-app.video-layout")).not.toBeNull();
  });
});
