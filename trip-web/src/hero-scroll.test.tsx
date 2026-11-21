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
import { tokenStore } from "./api";
import { COMPACT_PX, heroGrowFor, heroIntroExtra, heroOpenExtra, heroScrollState, INTRO_SHARE, markHeroIntroSeen, MAX_PULL_PX, OPEN_AT_PX, resetHeroIntro } from "./hero-scroll";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const FULL = 200; // the header's height at rest
const STICK = FULL - COMPACT_PX;

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  act(() => { window.dispatchEvent(new Event("scroll")); });
}
function touch(type: "touchstart" | "touchmove" | "touchend", y?: number) {
  const event = new Event(type) as Event & { touches: Array<{ clientY: number }> };
  event.touches = y === undefined ? [] : [{ clientY: y }];
  act(() => { window.dispatchEvent(event); });
}
// React listens for the prefixed name under jsdom (its style object has both), the plain one in a browser: send both.
function animationEnd(element: Element) {
  act(() => {
    for (const name of ["animationend", "webkitAnimationEnd"]) element.dispatchEvent(new Event(name, { bubbles: true }));
  });
}
function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
}
function heroElement(over: { lang?: "en" | "he"; pageKey?: string; photo?: boolean } = {}) {
  return <VideoHero config={{ meta: { title: "Alsace", ...(over.photo ? { homePhoto: "/api/ui/hero/photo.png" } : {}) }, phases: [{ id: "colmar", title: { en: "Colmar" } }] } as never}
    lang={over.lang ?? "en"} placePhaseId="colmar" pageName="Today" pageKey={over.pageKey ?? "today"} active="today" openVideoTab={vi.fn()} openMenu={vi.fn()} />;
}
function renderHero(over: Parameters<typeof heroElement>[0] = {}) {
  const view = render(heroElement(over));
  return { ...view, header: view.container.querySelector("header") as HTMLElement };
}

beforeEach(() => {
  markHeroIntroSeen(); // these tests are about the header's usual mechanics; the first open has its own describe below
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
  it("a finger pull grows the header by half its travel, capped; up or reduced motion grows nothing", () => {
    expect(heroGrowFor(100, false)).toBe(50);
    expect(heroGrowFor(5000, false)).toBe(MAX_PULL_PX);
    expect(heroGrowFor(-30, false)).toBe(0);
    expect(heroGrowFor(100, true)).toBe(0);
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

  it("a short pull grows the header with the finger and springs back when it lifts", () => {
    const { header } = renderHero();
    touch("touchstart", 100);
    touch("touchmove", 180); // grows 40, under OPEN_AT_PX
    expect(header.style.getPropertyValue("--hero-grow")).toBe("40px");
    expect(header.hasAttribute("data-pulling")).toBe(true); // no transition while the finger is down
    touch("touchend");
    expect(header.style.getPropertyValue("--hero-grow")).toBe("0px");
    expect(header.hasAttribute("data-pulling")).toBe(false); // the CSS transition springs it back
  });

  it("a longer pull leaves the photo open, filling most of the screen, after the finger lifts", () => {
    const { header } = renderHero();
    touch("touchstart", 100);
    touch("touchmove", 100 + (OPEN_AT_PX + 10) * 2);
    touch("touchend");
    const extra = heroOpenExtra(FULL, window.innerHeight);
    expect(header.style.getPropertyValue("--hero-grow")).toBe(`${extra}px`);
    expect(header.style.getPropertyValue("--hero-stick")).toBe(`${STICK + extra}px`); // scrolling down closes it too
  });

  it("scrolled down to the compact bar, the opening is let go without moving what is on screen", async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    const { header } = renderHero();
    touch("touchstart", 100);
    touch("touchmove", 400);
    touch("touchend");
    const extra = heroOpenExtra(FULL, window.innerHeight);
    scrollTo(STICK + extra / 2); // part way: still open, the photo reducing as it scrolls
    await waitFor(() => expect(header.style.getPropertyValue("--hero-progress")).not.toBe(""));
    expect(header.style.getPropertyValue("--hero-grow")).toBe(`${extra}px`);
    scrollTo(STICK + extra + 5);
    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith(0, -extra));
    expect(header.style.getPropertyValue("--hero-grow")).toBe("0px");
    expect(header.style.getPropertyValue("--hero-stick")).toBe(`${STICK}px`);
  });

  it("the opened size fills OPEN_SHARE of the screen, and never less than a full pull", () => {
    expect(heroOpenExtra(200, 800)).toBe(Math.round(800 * 0.72 - 200));
    expect(heroOpenExtra(500, 600)).toBe(MAX_PULL_PX);
  });

  it("a finger that starts below the top is an ordinary scroll and grows nothing", () => {
    const { header } = renderHero();
    scrollTo(300);
    touch("touchstart", 100);
    touch("touchmove", 220);
    expect(header.style.getPropertyValue("--hero-grow")).toBe("");
    expect(header.hasAttribute("data-pulling")).toBe(false);
  });

  it("a pull in progress is not counted as the header's own height", async () => {
    const { header } = renderHero();
    await waitFor(() => expect(header.style.getPropertyValue("--hero-stick")).toBe(`${STICK}px`));
    touch("touchstart", 100);
    touch("touchmove", 200);
    act(() => { window.dispatchEvent(new Event("resize")); }); // offsetHeight is stubbed, so this re-measures FULL
    expect(header.style.getPropertyValue("--hero-stick")).toBe(`${STICK - 50}px`);
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
    expect(header).toContain("calc(20px + var(--hero-grow, 0px))"); // the finger pull grows its bottom padding
    expect(header).toMatch(/transition:\s*padding-block-end/); // and it springs back
    expect(css).toMatch(/\.video-layout \.video-hero\[data-pulling\] \{ transition: none; \}/);
  });

  it("the photo and its wash stretch upward by the pull; the big line fades with the progress", () => {
    expect(rule(".video-hero-photo-frame")).toContain("calc(-1 * var(--hero-pull, 0px))"); // the frame carries the reach; the photo fills it
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

describe("the first open of a page load (owner, 2026-11-21)", () => {
  const extra = () => heroIntroExtra(FULL, window.innerHeight);
  beforeEach(() => {
    resetHeroIntro();
    // A real header is as tall as its resting height plus what is open (--hero-grow is bottom padding), so the stub says so.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) { return FULL + (parseFloat(this.style.getPropertyValue("--hero-grow")) || 0); },
    });
  });

  it("the header starts open, big, before anyone touches it: the same open state a pull makes", () => {
    const { header } = renderHero();
    expect(extra()).toBeGreaterThan(0);
    expect(header.style.getPropertyValue("--hero-grow")).toBe(`${extra()}px`);
    expect(header.style.getPropertyValue("--hero-stick")).toBe(`${STICK + extra()}px`); // scrolling down reduces it to the compact bar
    expect(header).not.toHaveClass("is-compact");
    expect(header).toHaveClass("is-intro"); // and its photo is to fade and scale in
  });

  it("it fills INTRO_SHARE of the screen: roughly all of it, but never more than the screen", () => {
    expect(INTRO_SHARE).toBeGreaterThanOrEqual(0.85);
    expect(INTRO_SHARE).toBeLessThanOrEqual(1);
    expect(heroIntroExtra(200, 800)).toBe(Math.round(800 * INTRO_SHARE - 200));
    expect(heroIntroExtra(900, 800)).toBe(0); // a header already taller than the screen is not grown
  });

  it("once per page load: a header mounted again later starts at its usual size", () => {
    const first = renderHero();
    expect(first.header).toHaveClass("is-intro");
    first.unmount();
    const second = renderHero();
    expect(second.header).not.toHaveClass("is-intro");
    expect(second.header.style.getPropertyValue("--hero-grow")).toBe("");
    expect(second.header.style.getPropertyValue("--hero-stick")).toBe(`${STICK}px`);
  });

  it("scrolling down reduces it to the compact bar and lets the opening go; back at the top it is the usual size", async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    const { header } = renderHero();
    scrollTo(STICK + extra() + 5);
    await waitFor(() => expect(header).toHaveClass("is-compact"));
    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith(0, -extra()));
    expect(header.style.getPropertyValue("--hero-grow")).toBe("0px");
    scrollTo(0);
    await waitFor(() => expect(header).not.toHaveClass("is-compact"));
    expect(header.style.getPropertyValue("--hero-grow")).toBe("0px"); // not big again
  });

  it("another tab or page lets an open header go: no tab opens to a full-screen photo again", () => {
    const view = renderHero();
    expect(view.header.style.getPropertyValue("--hero-grow")).toBe(`${extra()}px`);
    view.rerender(heroElement({ pageKey: "journey" }));
    expect(view.header.style.getPropertyValue("--hero-grow")).toBe("0px");
    view.rerender(heroElement({ pageKey: "today" }));
    expect(view.header.style.getPropertyValue("--hero-grow")).toBe("0px"); // and coming back to Today does not reopen it
  });

  it("the language toggle is not a page change: it does not let go of the open header", () => {
    const view = renderHero();
    view.rerender(heroElement({ lang: "he" }));
    expect(view.header.style.getPropertyValue("--hero-grow")).toBe(`${extra()}px`);
  });

  it("works the same in Hebrew (right to left)", () => {
    const { header } = renderHero({ lang: "he" });
    expect(header.style.getPropertyValue("--hero-grow")).toBe(`${extra()}px`);
    expect(header).toHaveClass("is-intro");
  });

  it("reduced motion: the header is just as big, with no animation class at all", () => {
    reducedMotion(true);
    const { header } = renderHero();
    expect(header.style.getPropertyValue("--hero-grow")).toBe(`${extra()}px`);
    expect(header).not.toHaveClass("is-intro");
  });

  it("the skyline (no photo): still the open header, the intro ends with the skyline's animation and does not replay", async () => {
    const { header, container } = renderHero();
    await waitFor(() => expect(header).toHaveAttribute("data-photo-state", "unavailable"));
    expect(header).toHaveClass("is-intro");
    animationEnd(container.querySelector(".skyline-motif")!);
    expect(header).not.toHaveClass("is-intro");
  });

  it("a photo: it sits in a clipping frame, fades in once, and the intro ends with its animation", async () => {
    tokenStore.set("private-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:intro-hero");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("Image", class { src = ""; decode = vi.fn().mockResolvedValue(undefined); });
    const { header, container } = renderHero({ photo: true });
    await waitFor(() => expect(header).toHaveAttribute("data-photo-state", "ready"));
    const photo = container.querySelector(".video-hero-photo-frame .video-hero-photo") as HTMLElement;
    expect(photo.style.backgroundImage).toContain("blob:intro-hero");
    expect(header).toHaveClass("is-intro");
    animationEnd(photo);
    expect(header).not.toHaveClass("is-intro");
    tokenStore.clear();
  });
});

describe("the first open's stylesheet", () => {
  it("fades and scales the photo in over 600-900ms, once, and the skyline rises in; reduced motion switches both off", () => {
    const keyframes = css.slice(css.indexOf("@keyframes hero-intro-photo"), css.indexOf("@keyframes hero-intro-rise"));
    expect(keyframes).toMatch(/from \{ opacity: 0; transform: scale\(1\.\d+\); \}/);
    expect(keyframes).toMatch(/to \{ opacity: 1; transform: scale\(1\); \}/);
    const photoRule = css.match(/\.video-hero\.is-intro \.video-hero-photo \{ animation: hero-intro-photo (\d+)ms [^;]*; \}/);
    expect(photoRule, "the photo's intro animation rule").not.toBeNull();
    expect(Number(photoRule![1])).toBeGreaterThanOrEqual(600);
    expect(Number(photoRule![1])).toBeLessThanOrEqual(900);
    expect(css).toMatch(/\.video-hero\.is-intro \.skyline-motif \{ animation: hero-intro-rise/);
    expect(photoRule![0]).not.toMatch(/infinite/); // once, never a loop
    const reduced = css.slice(css.indexOf("/* The first open is still big"));
    expect(reduced.slice(0, reduced.indexOf("\n}")).replace(/\s+/g, " ")).toMatch(/\.video-hero\.is-intro \.video-hero-photo, \.video-hero\.is-intro \.skyline-motif \{ animation: none; \}/);
  });

  it("the photo's frame clips the scale-in and carries the pull's reach, in logical (direction-free) properties", () => {
    const start = css.indexOf(".video-hero-photo-frame {");
    const frame = css.slice(start, css.indexOf("}", start));
    expect(frame).toMatch(/overflow:\s*hidden/);
    expect(frame).toMatch(/inset-inline:\s*0/);
    expect(frame).not.toMatch(/(^|[\s;])(left|right):/);
  });

  it("the skyline motif is capped, so an open header does not blow it up into a few giant roofs", () => {
    expect(css).toMatch(/\.skyline-motif \{[^}]*height:\s*min\(78%, 170px\)/);
  });
});
