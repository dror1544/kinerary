// How the video layout's header behaves as the page scrolls (Dror's review, 2026-11-17), mobile first.
//
//  - Scrolling down, the big header shrinks to a compact bar (logo, trip title, the menu button stay), and grows back as
//    the person scrolls up to the top.
//  - Pulling down at the very top (iOS rubber-band, a negative scroll position) stretches the photo to take more
//    height, from the top, and it springs back when the finger lets go.
//
// How, without moving anything on the page:
//  The header is `position: sticky` with `top: -(its own height - the compact bar's height)`. Its layout box never
//  changes size, so the content below it never jumps; the browser scrolls the header up with the page until only its
//  top COMPACT_PX (the top bar) is left, and holds that there. The scroll is the browser's own, so it is as smooth as
//  scrolling is, including on iOS Safari. JS only does three small things, from ONE passive scroll listener that does
//  its work in a requestAnimationFrame: it tells CSS how far the header has to travel (`--hero-stick`, from a
//  ResizeObserver, not from every scroll), how far through that travel the page is (`--hero-progress`, 0..1, which
//  fades the big title line), and how far the page is being pulled (`--hero-pull`, px, which stretches the photo).
//  It writes custom properties and reads `scrollY` once per frame; it reads no layout while scrolling.
//
// prefers-reduced-motion: no stretch (the pull is never applied), no fade (the big line switches off at the compact
// threshold, in one step). The header still follows the page, which is scrolling, not an animation.
import { useEffect, useState, type RefObject } from "react";

/** Height of the compact bar: the header's top padding (14px) plus its top line (48px), with a little air. Matches styles.css. */
export const COMPACT_PX = 64;
/** Pulling further than this adds nothing: the stretch stops here. */
export const MAX_PULL_PX = 160;

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where a scroll position puts the header: how far through the shrink, whether it is compact, how far it is pulled. */
export function heroScrollState(scrollY: number, stick: number, reducedMotion: boolean) {
  const travel = Math.max(stick, 0);
  const progress = travel > 0 ? Math.min(Math.max(scrollY / travel, 0), 1) : 0;
  return {
    progress,
    // Compact once the header has travelled all the way (a pixel of slack for sub-pixel scroll positions).
    compact: travel > 0 && scrollY >= travel - 1,
    pull: reducedMotion ? 0 : Math.min(Math.max(-scrollY, 0), MAX_PULL_PX),
  };
}

/** Wires the header at `ref` to the page's scroll. Returns whether the header is in its compact state. */
export function useHeroScroll(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const header = ref.current;
    if (!header) return;
    let stick = 0;
    let frame = 0;
    let wasCompact = false;

    const apply = () => {
      frame = 0;
      const reduced = prefersReducedMotion();
      const state = heroScrollState(window.scrollY, stick, reduced);
      header.style.setProperty("--hero-progress", reduced ? (state.compact ? "1" : "0") : state.progress.toFixed(3));
      header.style.setProperty("--hero-pull", `${Math.round(state.pull)}px`);
      if (state.compact !== wasCompact) { wasCompact = state.compact; setCompact(state.compact); }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    const measure = () => {
      // The box never changes size while scrolling, so this is read when the header (or the viewport) changes, not per frame.
      stick = Math.max(header.offsetHeight - COMPACT_PX, 0);
      header.style.setProperty("--hero-stick", `${stick}px`);
      schedule();
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(header);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ref]);
  return compact;
}
