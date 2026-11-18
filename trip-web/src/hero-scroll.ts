// How the video layout's header behaves as the page scrolls (Dror's review, 2026-11-17), mobile first.
//
//  - Scrolling down, the big header shrinks to a compact bar (logo, trip title, the menu button stay), and grows back as
//    the person scrolls up to the top.
//  - Pulling down at the very top opens the photo up: the header grows with the finger (half its travel), and a pull
//    past OPEN_AT_PX stays open when the finger lifts, the photo taking about OPEN_SHARE of the screen, to be enjoyed
//    (Dror, 2026-11-18: "the photo not only stretch, it remains"). A shorter pull springs back. Scrolling down from
//    the open photo reduces it like any scroll; once the header is down to its compact bar the opening is let go
//    (the page scroll moved by the same amount, so nothing visible moves), and back at the top it is its usual size.
//    This follows the finger itself, not the page's rubber-band: Telegram's in-app browser has no bounce at the top,
//    so a negative scroll position never came. Where the browser does bounce (Safari), the photo also reaches up
//    over the gap the bounce opens, so no bare background shows above it.
//
// How, without moving anything on the page:
//  The header is `position: sticky` with `top: -(its own height - the compact bar's height)`. Its layout box never
//  changes size, so the content below it never jumps; the browser scrolls the header up with the page until only its
//  top COMPACT_PX (the top bar) is left, and holds that there. The scroll is the browser's own, so it is as smooth as
//  scrolling is, including on iOS Safari. JS only does three small things, from ONE passive scroll listener that does
//  its work in a requestAnimationFrame: it tells CSS how far the header has to travel (`--hero-stick`, from a
//  ResizeObserver, not from every scroll), how far through that travel the page is (`--hero-progress`, 0..1, which
//  fades the big title line), and how far the page has bounced (`--hero-pull`, px, the photo reaches up by it).
//  It writes custom properties and reads `scrollY` once per frame; it reads no layout while scrolling. The finger pull
//  is passive touch listeners writing `--hero-grow` (px, added to the header's bottom padding) and `data-pulling`
//  while the finger is down, so the spring back is a CSS transition. Growing does resize the header, but only during
//  a pull at the very top, where there is nothing above it to jump.
//
// prefers-reduced-motion: no stretch (the pull is never applied), no fade (the big line switches off at the compact
// threshold, in one step). The header still follows the page, which is scrolling, not an animation.
import { useEffect, useState, type RefObject } from "react";

/** Height of the compact bar: the header's top padding (14px) plus its top line (48px), with a little air. Matches styles.css. */
export const COMPACT_PX = 64;
/** Pulling further than this adds nothing: the stretch stops here. */
export const MAX_PULL_PX = 160;
/** The header grows by this share of the finger's travel, so it feels like stretching, not dragging. */
export const PULL_RESISTANCE = 0.5;
/** A pull that grew the header this much stays open when the finger lifts; less springs back. */
export const OPEN_AT_PX = 56;
/** Open, the header takes this share of the screen's height. */
export const OPEN_SHARE = 0.72;

/** How much an open header adds to its resting height, so that it fills OPEN_SHARE of the screen (never less than a pull's worth). */
export function heroOpenExtra(restingHeight: number, viewportHeight: number): number {
  return Math.round(Math.max(viewportHeight * OPEN_SHARE - restingHeight, MAX_PULL_PX));
}

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

/** How much a finger that has moved `dy` px down from where it touched grows the header (none when reduced motion is on). */
export function heroGrowFor(dy: number, reducedMotion: boolean, cap = MAX_PULL_PX): number {
  if (reducedMotion) return 0;
  return Math.min(Math.max(dy, 0) * PULL_RESISTANCE, cap);
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
    let touchStartY: number | null = null;
    let grow = 0; // what the finger adds right now
    let open = 0; // what an opened photo adds, after the finger lifted
    let resting = 0; // the header's own height, with neither

    const apply = () => {
      frame = 0;
      const reduced = prefersReducedMotion();
      if (open && window.scrollY >= stick) {
        // Scrolled down to the compact bar: let the opening go. The header loses `open` px of height above the
        // viewport, so the page scroll moves up by the same amount and nothing on screen moves.
        const extra = open;
        open = 0;
        header.setAttribute("data-pulling", ""); // no transition for this one
        writeGrow();
        stick = Math.max(stick - extra, 0);
        header.style.setProperty("--hero-stick", `${stick}px`);
        window.scrollBy(0, -extra);
        window.requestAnimationFrame(() => header.removeAttribute("data-pulling"));
      }
      const state = heroScrollState(window.scrollY, stick, reduced);
      header.style.setProperty("--hero-progress", reduced ? (state.compact ? "1" : "0") : state.progress.toFixed(3));
      header.style.setProperty("--hero-pull", `${Math.round(state.pull)}px`);
      if (state.compact !== wasCompact) { wasCompact = state.compact; setCompact(state.compact); }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    const measure = () => {
      // The box never changes size while scrolling, so this is read when the header (or the viewport) changes, not per frame.
      // A pull in progress is not the header's own height; an open photo is (scrolling down closes it like the rest).
      resting = Math.max(header.offsetHeight - grow - open, 0);
      stick = Math.max(resting + open - COMPACT_PX, 0);
      header.style.setProperty("--hero-stick", `${stick}px`);
      schedule();
    };

    const writeGrow = () => header.style.setProperty("--hero-grow", `${Math.round(open + grow)}px`);
    const setGrow = (next: number) => {
      if (next === grow) return;
      grow = next;
      writeGrow();
    };
    const onTouchStart = (event: TouchEvent) => {
      // Only a pull that starts at the very top stretches; anywhere else it is an ordinary scroll.
      touchStartY = window.scrollY <= 0 && event.touches.length === 1 ? event.touches[0]!.clientY : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchStartY === null) return;
      if (window.scrollY > 0) { touchStartY = null; header.removeAttribute("data-pulling"); setGrow(0); return; }
      header.setAttribute("data-pulling", "");
      // Already open, a pull adds only a little more give, then springs back to open.
      setGrow(heroGrowFor(event.touches[0]!.clientY - touchStartY, prefersReducedMotion(), open ? MAX_PULL_PX / 4 : MAX_PULL_PX));
    };
    const onTouchEnd = () => {
      if (touchStartY === null && !grow) return;
      touchStartY = null;
      header.removeAttribute("data-pulling"); // the transition in styles.css carries it to where it settles
      if (!open && grow >= OPEN_AT_PX) {
        open = heroOpenExtra(resting, window.innerHeight);
        // Scrolling down now has the opening to travel through as well (the ResizeObserver agrees once it settles).
        stick = Math.max(resting + open - COMPACT_PX, 0);
        header.style.setProperty("--hero-stick", `${stick}px`);
      }
      grow = 0;
      writeGrow();
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measure);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(header);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ref]);
  return compact;
}
