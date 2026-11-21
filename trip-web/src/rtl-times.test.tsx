/**
 * AC-11: Hebrew sets dir="rtl", the tab order, header and day card mirror, and every time —
 * including a struck-through one — keeps its digit order ("19:00", never "00:19").
 *
 * jsdom has no bidi engine, so the proof is the one the browser acts on: each time sits in a
 * <bdi dir="ltr"> (an isolated left-to-right run) inside the right-to-left text, and the
 * document direction is rtl so the bar and the rows lay out from the right.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, dayItems, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); localStorage.setItem("tripLang", "he"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

function serve() {
  const items = dayItems();
  stubTripFetch(() => ({ config: config({ plan_change_marks: true }), today: todayContext(items), items }));
}

describe("Hebrew in the video layout", () => {
  it("sets dir=rtl and lang=he on the document, and the header, tabs and card are in Hebrew", async () => {
    serve();
    renderTrip();
    expect(await screen.findByRole("heading", { level: 1, name: "קולמר · היום" })).toBeInTheDocument();
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    expect(document.documentElement.getAttribute("lang")).toBe("he");
    const tabs = within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link").map((link) => link.textContent);
    expect(tabs).toEqual(["היום", "תוכנית", "הזמנות", "תמונות"]);
    expect(await screen.findByRole("heading", { name: "יום חמישי · דרך היין" })).toBeInTheDocument();
  });

  it("every time on the day card is an isolated left-to-right run", async () => {
    serve();
    const { container } = renderTrip();
    await screen.findByRole("heading", { name: "יום חמישי · דרך היין" });
    const times = [...container.querySelectorAll(".day-row-time")];
    expect(times).toHaveLength(4);
    for (const cell of times) {
      const runs = cell.querySelectorAll("bdi[dir='ltr']");
      expect(runs.length, cell.textContent ?? "").toBeGreaterThan(0);
    }
    const text = times.map((cell) => cell.textContent).join("|");
    expect(text).toContain("08:30");
    expect(text).toContain("11:00");
    expect(text).not.toContain("00:19");
  });

  it("the changed dinner keeps both times left-to-right: 20:00 struck through, then 19:00", async () => {
    serve();
    const { container } = renderTrip();
    const row = (await screen.findByRole("button", { name: "ארוחת ערב בווינשטוב" })).closest("li") as HTMLElement;
    const old = row.querySelector("del bdi");
    const current = row.querySelector(".change-time-new");
    expect(old).toHaveAttribute("dir", "ltr");
    expect(current).toHaveAttribute("dir", "ltr");
    expect([old?.textContent, current?.textContent]).toEqual(["20:00", "19:00"]);
    expect(within(row).getByText("עודכן")).toHaveClass("change-badge");
    expect(container.querySelector(".updated-for-everyone")?.textContent).toContain("עודכן לכולם ✓");
    expect(container.querySelector(".updated-ago")?.textContent).toMatch(/לפני 5 דק׳/);
  });
});
