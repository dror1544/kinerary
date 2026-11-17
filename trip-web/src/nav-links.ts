// The one Go / Waze / search link builder (video Release 1A, docs/specs/sprint-9/x-video-r1-site-look.md).
//
// Before this each screen built its own: "Up next" always gave Google Maps (falling back to a search),
// and a Journey row showed Map and Waze only when the item carried a URL. Now the Today row, the Plan
// row and "Up next" ask here, so a place is navigated the same way wherever it is shown.
//
// The trip's navigation app (Google Maps or Waze) decides which of the two the Go chip opens, see `navUrlFor`.
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

/** Waze, only when the item (or its booking's place) carries one. The Go chip falls back to a Waze search itself. */
export function wazeUrlFor(item: NavItem): string | null {
  return safeExternalUrl(item.waze_url) || safeExternalUrl(item.booking?.place?.waze_url) || null;
}

/** The trip's navigation app (`/api/settings` → `nav_app`). Anything unrecognised is Google Maps. */
export type NavApp = "google" | "waze";
export const normalizeNavApp = (value: unknown): NavApp => (value === "waze" ? "waze" : "google");

/**
 * The one Go target: the organizer's chosen app. Google behaves as `mapUrlFor`. Waze opens the item's
 * (or its booking place's) Waze link, else a Waze search on title + destination that starts navigation.
 */
export function navUrlFor(item: NavItem, title: string, destination: string | undefined, app: NavApp): string {
  if (app !== "waze") return mapUrlFor(item, title, destination);
  return wazeUrlFor(item)
    || safeExternalUrl(`https://waze.com/ul?q=${encodeURIComponent([title, destination].filter(Boolean).join(", "))}&navigate=yes`)
    || mapUrlFor(item, title, destination);
}
