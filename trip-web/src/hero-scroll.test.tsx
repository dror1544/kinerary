/// <reference types="node" />
/**
 * The video layout's header follows the page's scroll (hero-scroll.ts): compact bar going down, stretch when pulled
 * at the top, reduced-motion path. jsdom has no layout, so the header's height is stubbed (offsetHeight) and the scroll
 * position is set by hand; what is asserted is the state the header is put in (class and custom properties) and the
 * rules in the stylesheet that turn that state into pixels. The pixels themselves need a real device (see the hand-back).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoHero } from "./App";
import { COMPACT_PX, heroScrollState, MAX_PULL_PX } from "./hero-scroll";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const FULL = 200; // the header's height at rest
const STICK = FULL - COMPACT_PX;

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  act(() => { window.dispatchEvent(new Event("scroll")); });
}
function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
}
function renderHero() {
  const view = render(<VideoHero config={{ meta: { title: "Alsace" }, phases: [{ id: "colmar", title: { en: "Colmar" } }] } as never}
    lang="en" placePhaseId="colmar" pageName="Today" active="today" openVideoTab={vi.fn()} openMenu={vi.fn()} />);
  return { ...view, header: view.container.querySelector("header") as HTMLElement };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => FULL });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  reducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

describe("heroScrollState", () => {
  it("progress runs 0..1 over the header's travel, and compact is the end of it", () => {
    expect(heroScrollState(0, STICK, false)).toEqual({ progress: 0, compact: false, pull: 0 });
    expect(heroScrollState(STICK / 2, STICK, false)).toMatchObject({ progress: 0.5, compact: false });
    expect(heroScrollState(STICK, STICK, false)).toMatchObject({ progress: 1, compact: true });
    expect(heroScrollState(STICK * 3, STICK, false)).toMatchObject({ progress: 1, compact: true });
  });
  it("a negative scroll position is a pull, capped; reduced motion applies none", () => {
    expect(heroScrollState(-40, STICK, false)).toMatchObject({ progress: 0, compact: false, pull: 40 });
    expect(heroScrollState(-5000, STICK, false).pull).toBe(MAX_PULL_PX);
    expect(heroScrollState(-40, STICK, true).pull).toBe(0);
  });
  it("a header that has not been measured (no travel) never goes compact", () => {
    expect(heroScrollState(500, 0, false)).toMatchObject({ progress: 0, compact: false });
  });
});

describe("the header follows the scroll", () => {
  it("tells CSS how far the header travels (its height minus the compact bar) and starts full", async () => {
    const { header } = renderHero();
    await waitFor(() => expect(header.style.getPropertyValue("--hero-stick")).toBe(`${STICK}px`));
    expect(header).not.toHaveClass("is-compact");
    expect(header.style.height).toBe(""); // its box is never resized, so the content below cannot jump
  });

  it("goes compact past the threshold and grows back when scrolled up to the top", async () => {
    const { header } = renderHero();
    scrollTo(STICK / 2);
    await waitFor(() => expect(header.style.getPropertyValue("--hero-progress")).toBe("0.500"));
    expect(header).not.toHaveClass("is-compact");
    scrollTo(STICK + 40);
    await waitFor(() => expect(header).toHaveClass("is-compact"));
    expect(header.style.getPropertyValue("--hero-progress")).toBe("1.000");
    scrollTo(STICK - 30);
    await waitFor(() => expect(header).not.toHaveClass("is-compact"));
    scrollTo(0);
    await waitFor(() => expect(header.style.getPropertyValue("--hero-progress")).toBe("0.000"));
    expect(header).not.toHaveClass("is-compact");
  });

  it("pulled down at the top it stretches (a pull in px), and lets go when the page springs back", async () => {
    const { header } = renderHero();
    scrollTo(-60);
    await waitFor(() => expect(header.style.getPropertyValue("--hero-pull")).toBe("60px"));
    expect(header).not.toHaveClass("is-compact");
    scrollTo(0);
    await waitFor(() => expect(header.style.getPropertyValue("--hero-pull")).toBe("0px"));
  });

  it("reduced motion: no stretch, no gradual fade — full, then compact in one step", async () => {
    reducedMotion(true);
    const { header } = renderHero();
    scrollTo(-60);
    await waitFor(() => expect(header.style.getPropertyValue("--hero-pull")).toBe("0px"));
    scrollTo(STICK / 2);
    await waitFor(() => expect(header.style.getPropertyValue("--hero-progress")).toBe("0"));
    expect(header).not.toHaveClass("is-compact");
    scrollTo(STICK + 1);
    await waitFor(() => expect(header).toHaveClass("is-compact"));
    expect(header.style.getPropertyValue("--hero-progress")).toBe("1");
  });

  it("listens to the page once, passively, and lets go of it on unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHero();
    const scrolls = add.mock.calls.filter(([type]) => type === "scroll");
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]![2]).toEqual({ passive: true });
    unmount();
    expect(remove.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
  });

  it("with no photo the same shrink applies (the skyline header is the same header)", async () => {
    const { header } = renderHero();
    expect(header.querySelector(".skyline-motif")).not.toBeNull();
    scrollTo(STICK + 10);
    await waitFor(() => expect(header).toHaveClass("is-compact"));
  });
});

describe("the stylesheet turns that state into pixels", () => {
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `a rule for ${selector}`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("the header is sticky with a negative top of its own travel, and is never given a height", () => {
    const header = rule(".video-layout .video-hero");
    expect(header).toMatch(/position:\s*sticky/);
    expect(header).toMatch(/top:\s*calc\(-1 \* var\(--hero-stick, 0px\)\)/);
    expect(header).not.toMatch(/(^|[\s;])(height|max-height):/);
    expect(header).toMatch(/overflow:\s*visible/); // so the photo can reach above it when pulled
  });

  it("the photo and its wash stretch upward by the pull; the big line fades with the progress", () => {
    expect(rule(".video-hero-photo")).toContain("calc(-1 * var(--hero-pull, 0px))");
    expect(rule(".video-hero-wash")).toContain("calc(-1 * var(--hero-pull, 0px))");
    expect(css).toMatch(/\.video-layout \.video-hero-copy \{ opacity: calc\(1 - var\(--hero-progress, 0\)/);
  });

  it("reduced motion: the big line is not faded, it is switched off in one step", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  /* No fade and no stretch"));
    const media = block.slice(0, block.indexOf("\n}\n"));
    expect(media).toMatch(/\.video-layout \.video-hero-copy \{ opacity: 1; \}/);
    expect(media).toMatch(/\.video-hero\.is-compact \.video-hero-copy \{ opacity: 0; \}/);
  });

  it("the compact bar is the header's top 64px: its top padding plus the top line", () => {
    expect(COMPACT_PX).toBe(64);
    expect(rule(".video-layout .video-hero")).toMatch(/padding-block:\s*14px/);
    expect(rule(".video-layout .topline")).toMatch(/min-height:\s*48px/);
  });
});
