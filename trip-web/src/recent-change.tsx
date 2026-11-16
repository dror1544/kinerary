// "Updates are obvious on the site" (video Release 1B, switch plan_change_marks;
// docs/specs/sprint-9/x-video-r1-site-look.md).
//
// The server marks an item that changed in the last 24 hours with `recent_change`
// ({kind, at, fields, previous_time?, previous_date?} — never who). This file is how
// the page draws it: the Updated / New badge, the old time struck through beside the
// new one, "Moved from <weekday>", the "Updated for everyone ✓ · 5 min ago" line under
// the day card, and the short highlight when a change arrives while the page is open.
//
// What it never draws: who changed it, who has seen it. "Updated for everyone" means
// the change is in the one plan every member's site serves — delivered, not read.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ItineraryItem, RecentChange } from "./api";

type Lang = "he" | "en";
const t = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

/** The item's marker, if it carries one this build understands; anything else is "no marker". */
export function changeOf(item: Pick<ItineraryItem, "recent_change"> | null | undefined): RecentChange | undefined {
  const change = item?.recent_change;
  if (!change || (change.kind !== "added" && change.kind !== "updated") || !Number.isFinite(Date.parse(change.at))) return undefined;
  return change;
}

export function changeClass(change: RecentChange | undefined): string {
  return change ? (change.kind === "added" ? " is-added" : " is-updated") : "";
}

export function weekdayName(date: string, lang: Lang): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(lang === "he" ? "he-IL" : "en-US", { weekday: "long" });
}

/** "Moved from Wednesday" for an item whose date changed, else null. */
export function movedFromLabel(change: RecentChange | undefined, lang: Lang): string | null {
  if (!change || change.kind !== "updated" || !change.fields.includes("date") || !change.previous_date) return null;
  return t(lang, `Moved from ${weekdayName(change.previous_date, lang)}`, `הועבר מיום ${weekdayName(change.previous_date, lang)}`);
}

/** Updated — ink text on a coral tint with a coral edge (white on coral is below 4.5:1); New — a coral outline, no fill. */
export function ChangeBadge({ change, lang }: { change: RecentChange | undefined; lang: Lang }) {
  if (!change) return null;
  return change.kind === "added"
    ? <b className="change-badge new">{t(lang, "New", "חדש")}</b>
    : <b className="change-badge updated">{t(lang, "Updated", "עודכן")}</b>;
}

/**
 * A time, and — when it just changed — the old one struck through beside it. Both are isolated
 * left-to-right inside right-to-left text, so "19:00" never renders as "00:19".
 */
export function ChangeTime({ time, previous }: { time: string; previous?: string | null }) {
  return (
    <span className="change-time">
      {previous ? <del className="change-time-old"><bdi dir="ltr">{previous}</bdi></del> : null}
      <bdi dir="ltr" className="change-time-new">{time}</bdi>
    </span>
  );
}

/** How long ago, in the page's language: "5 min. ago" / "לפני 5 דק׳". */
export function relativeAgo(at: string, now: number, lang: Lang): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(at)) / 60_000);
  if (minutes < 1) return t(lang, "just now", "הרגע");
  const rtf = new Intl.RelativeTimeFormat(lang === "he" ? "he" : "en", { numeric: "always", style: "short" });
  return minutes < 60 ? rtf.format(-minutes, "minute") : rtf.format(-Math.floor(minutes / 60), "hour");
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

const AVATAR_LIMIT = 5;

/**
 * Under the day card, when any of its items carries a marker. The avatars are the trip's
 * participants — the people the plan reaches — never the person who made the change.
 */
export function UpdatedForEveryone({ changes, avatars, lang }: { changes: RecentChange[]; avatars: ReactNode[]; lang: Lang }) {
  const now = useNow(30_000);
  if (!changes.length) return null;
  const newest = changes.reduce((latest, change) => (Date.parse(change.at) > Date.parse(latest.at) ? change : latest));
  const extra = avatars.length - AVATAR_LIMIT;
  return (
    <p className="updated-for-everyone" role="status">
      <strong>{t(lang, "Updated for everyone ✓", "עודכן לכולם ✓")}</strong>
      <span className="updated-ago"> · {relativeAgo(newest.at, now, lang)}</span>
      {avatars.length ? (
        <span className="change-avatars">
          {avatars.slice(0, AVATAR_LIMIT).map((avatar, index) => <span key={index} className="change-avatar">{avatar}</span>)}
          {extra > 0 ? <span className="change-avatar-more">+{extra}</span> : null}
        </span>
      ) : null}
    </p>
  );
}

const FRESH_MS = 2800;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The uids whose marker ARRIVED while this page was open: `recent_change.at` newer than anything the
 * page had already shown. The first data the hook sees is the baseline, so opening the page on an
 * already-marked day animates nothing. With prefers-reduced-motion the final state appears with no
 * animation class at all.
 */
export function useFreshChanges(items: Array<Pick<ItineraryItem, "item_uid" | "recent_change">> | undefined): Set<string> {
  const seen = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!items) return;
    const stamps = items.map((item) => [item.item_uid, Date.parse(changeOf(item)?.at ?? "")] as const).filter(([, at]) => Number.isFinite(at));
    const newest = Math.max(0, ...stamps.map(([, at]) => at));
    if (seen.current === null) { seen.current = newest; return; }
    const arrived = stamps.filter(([, at]) => at > seen.current!).map(([uid]) => uid);
    seen.current = Math.max(seen.current, newest);
    if (!arrived.length || prefersReducedMotion()) return;
    setFresh(new Set(arrived));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
  }, [items]);
  return fresh;
}
