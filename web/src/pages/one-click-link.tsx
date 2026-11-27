import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";
import { formatTime } from "./dates";

/**
 * One click to the chat (#690).
 *
 * Connecting Telegram or WhatsApp used to be two clicks: one to ask the server for a one-time code, a second on the link it
 * returned. The second click was there because a browser lets a page open a tab only from a click it can see, not from the
 * answer to a request that came back later. So the code is asked for BEFORE the click, and what the person presses is a
 * plain `<a href target=_blank>` that already holds the deep link.
 *
 * What bounds the cost of asking early (the server's limits, not guesses):
 *  - a code is asked for only when the action becomes available (a menu opens, a card is on the trip's page), never for
 *    every card of the dashboard;
 *  - the answer is kept in the query cache until it expires, so opening the menu again, coming back to the page or
 *    returning from the other tab asks for nothing (a new Telegram link REVOKES the live one, so a re-mint on window focus
 *    would kill the link just opened);
 *  - an expiring code is replaced a little before it ends, only while the page is visible and the action is still on
 *    screen, and only a few times in a row: a forgotten tab mints nothing, and neither does a hidden one;
 *  - the server answers 10 mints a minute per person per kind. Automatic mints are held to a smaller allowance of their own,
 *    remembered across reloads (timestamps only, never a code), so reloading the page cannot spend the person's own clicks;
 *    held, the person gets a button instead of a link.
 *
 * The server holds a code only as a digest and cannot give it back, and nothing tells the page that a code was redeemed. So a
 * click on the link is treated as the spend: the link leaves the page and is not shown again, and a new one is made only when
 * the person asks for it.
 */

export type LinkOffer = { link: string; expiresAt: string };
type Slot = { kind: "offer"; offer: LinkOffer } | { kind: "used" };

const AUTO_MINTS_PER_MINUTE = 5;
const MAX_SILENT_REFRESHES = 3;
const MIN_REFRESH_GAP_MS = 5_000;
const REFRESH_AT = 0.85;
const LOG_KEY = "kinerary.connect-link.mints";

/** When this tab last asked for a code of this kind, as plain timestamps. A storage that refuses just means no memory. */
function mintLog(service: string, record: boolean): number {
  const now = Date.now();
  try {
    const all = JSON.parse(window.sessionStorage.getItem(LOG_KEY) ?? "{}") as Record<string, number[]>;
    const recent = (Array.isArray(all[service]) ? all[service] : []).filter((at) => typeof at === "number" && now - at < 60_000);
    if (record) {
      recent.push(now);
      window.sessionStorage.setItem(LOG_KEY, JSON.stringify({ ...all, [service]: recent }));
    }
    return recent.length;
  } catch {
    return 0;
  }
}

class Held extends Error {}

export type OneClickState =
  | { state: "idle" }
  | { state: "preparing" }
  | { state: "ready"; offer: LinkOffer; onFollow: () => void }
  | { state: "used"; again: () => void }
  | { state: "failed"; message: string; held: boolean; retry: () => void };

/**
 * `limiter` names the server's limiter that counts the mint (one per route: Telegram links, WhatsApp codes of either kind); `service` and `id`
 * name this one code in the cache (which service and kind, which trip). `enabled` is
 * "the action is on screen": false asks for nothing and keeps nothing running.
 */
export function useOneClickLink(input: { limiter: "telegram" | "whatsapp"; service: string; id: readonly string[]; enabled: boolean; mint: () => Promise<LinkOffer> }): OneClickState {
  const queryClient = useQueryClient();
  const queryKey = ["one-click-link", input.service, ...input.id];
  const manual = useRef(false);
  const mint = useRef(input.mint);
  mint.current = input.mint;
  const refreshes = useRef(0);
  const [, setTick] = useState(0);
  const query = useQuery<Slot>({
    queryKey,
    enabled: input.enabled,
    staleTime: Infinity, gcTime: 30 * 60_000,
    refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
    queryFn: async () => {
      const asked = manual.current; manual.current = false;
      if (!asked && mintLog(input.limiter, false) >= AUTO_MINTS_PER_MINUTE) throw new Held();
      mintLog(input.limiter, true);
      return { kind: "offer", offer: await mint.current() };
    },
  });
  const slot = query.data;
  const expiresAt = slot?.kind === "offer" ? Date.parse(slot.offer.expiresAt) : Number.NaN;
  const expired = slot?.kind === "offer" && !(Date.now() < expiresAt);

  const refresh = (asked: boolean) => { manual.current = asked; void query.refetch(); };
  const refreshAuto = useRef(refresh);
  refreshAuto.current = refresh;
  useEffect(() => { if (!input.enabled) refreshes.current = 0; }, [input.enabled]);

  // A code that has expired or is about to, while the action is on screen and the page is visible: replace it, silently.
  useEffect(() => {
    if (!input.enabled || slot?.kind !== "offer" || Number.isNaN(expiresAt)) return;
    const replace = () => {
      if (document.hidden || refreshes.current >= MAX_SILENT_REFRESHES) { setTick((n) => n + 1); return; }
      refreshes.current += 1;
      refreshAuto.current(false);
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { replace(); return; }
    const refreshTimer = window.setTimeout(replace, Math.max(remaining * REFRESH_AT, MIN_REFRESH_GAP_MS));
    const expiryTimer = window.setTimeout(() => setTick((n) => n + 1), remaining);
    const onVisible = () => { if (!document.hidden && Date.now() >= expiresAt - 5_000) replace(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(refreshTimer); window.clearTimeout(expiryTimer); document.removeEventListener("visibilitychange", onVisible); };
  }, [input.enabled, slot, expiresAt]);

  if (!input.enabled && !slot) return { state: "idle" };
  if (slot?.kind === "offer" && !expired) {
    return {
      state: "ready", offer: slot.offer,
      // A later task, never the click's own: the browser reads `href` for its default action once the handlers have run, and
      // the link must not change in that window. (The query cache happens to notify asynchronously already; this does not
      // depend on it.)
      onFollow: () => { window.setTimeout(() => queryClient.setQueryData<Slot>(queryKey, { kind: "used" }), 0); },
    };
  }
  if (query.isFetching) return { state: "preparing" };
  if (query.isError) {
    const held = query.error instanceof Held;
    return {
      state: "failed", held, retry: () => refresh(true),
      message: held ? "" : query.error instanceof ApiError ? query.error.message : "The link could not be prepared. Please try again.",
    };
  }
  if (slot?.kind === "used") return { state: "used", again: () => refresh(true) };
  // An expired code that could not be replaced because the page is hidden or the silent refreshes are used up.
  if (slot?.kind === "offer") return { state: "failed", held: true, message: "", retry: () => refresh(true) };
  return { state: "preparing" };
}

/**
 * The one control for "connect this chat", the same for every service: the link itself when it is ready, a disabled button
 * while it is being prepared, a button (never a dead link) when it could not be, and what the person did once it was used.
 */
export function OneClickLink(props: {
  offer: OneClickState; label: string; className?: string; role?: "menuitem"; mark?: ReactNode;
  /** Said once the link has been opened. */
  opened: string;
  /** Said under the link while it works: when it stops, and what to do with it. */
  note: (expiresAt: string) => ReactNode;
}) {
  const { offer } = props;
  const className = props.className ?? "button button-small";
  if (offer.state === "idle") return null;
  if (offer.state === "preparing") {
    return <button type="button" role={props.role} className={className} disabled>{props.mark}Preparing…</button>;
  }
  if (offer.state === "failed") {
    return (
      <div className="chat-connect-failed">
        {!offer.held && <div className="notice" role="alert">{offer.message}</div>}
        <button type="button" role={props.role} className={className} onClick={offer.retry}>{props.mark}{props.label}</button>
      </div>
    );
  }
  if (offer.state === "used") {
    return (
      <div className="telegram-issued chat-connect-used">
        <small>{props.opened}</small>
        <button type="button" className="text-button" onClick={offer.again}>Get a new link</button>
      </div>
    );
  }
  return (
    <div className="chat-connect-ready">
      <a
        className={className} role={props.role} href={offer.offer.link} target="_blank" rel="noopener noreferrer"
        onClick={offer.onFollow} onAuxClick={(event) => { if (event.button === 1) offer.onFollow(); }}
      >{props.mark}{props.label}</a>
      <small>{props.note(offer.offer.expiresAt)}</small>
    </div>
  );
}

/** "Works once, until 10:15 AM." */
export const worksOnce = (expiresAt: string) => `Works once, until ${formatTime(expiresAt)}.`;
