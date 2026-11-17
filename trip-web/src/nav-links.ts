// The one Go / Waze / search link builder (video Release 1A, docs/specs/sprint-9/x-video-r1-site-look.md).
//
// Before this each screen built its own: "Up next" always gave Google Maps (falling back to a search),
// and a Journey row showed Map and Waze only when the item carried a URL. Now the Today row, the Plan
// row and "Up next" ask here, so a place is navigated the same way wherever it is shown.
//
// Every URL passes `safeExternalUrl` (http and https only); an item's stored link is never trusted
// as written. The search fallback is built here, from the item's own title and its phase's name.
import { safeExternalUrl } from "./external-url";

// What a link needs from a plan item. Structural, so the Today row, a Plan row and a test
// fixture all qualify without importing the full item type.
export type NavItem = {
  item_type?: string | null;
  location_url?: string | null;
  waze_url?: string | null;
  booking?: { location_url?: string | null; place?: { waze_url?: string | null } | null } | null;
};

// Not a place: "Free evening" searched on a map finds a street, not an evening.
const NOT_A_PLACE = new Set(["free_time", "task", "note"]);

export function hasGoChip(item: Pick<NavItem, "item_type">): boolean {
  return !NOT_A_PLACE.has(item.item_type || "");
}

/** Google Maps: the item's link, else its booking's, else a search on title + destination. */
export function mapUrlFor(item: NavItem, title: string, destination?: string): string {
  return safeExternalUrl(item.location_url)
    || safeExternalUrl(item.booking?.location_url)
    || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([title, destination].filter(Boolean).join(", "))}`;
}

/** Waze, only when there is one to give — Waze has no search URL worth guessing. */
export function wazeUrlFor(item: NavItem): string | null {
  return safeExternalUrl(item.waze_url) || safeExternalUrl(item.booking?.place?.waze_url) || null;
}
