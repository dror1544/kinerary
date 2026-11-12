import type { Lang } from "./parity-ui";

/**
 * The kinds of itinerary item, with the words the site shows for them (#545).
 *
 * English is the source. The set is closed — the server refuses any other
 * value (server/living-journey.js VALID_ITEM_TYPES, server/trip-structure.js
 * ITEM_TYPES) — so the Hebrew is one curated table here rather than a runtime
 * translation: nothing to call, nothing to cache, nothing to get wrong. A type
 * the server learns later falls back to its identifier until it is added.
 *
 * The value an option submits is always the English identifier; only the label
 * is translated.
 */
export const ITEM_TYPES = ["activity", "travel", "meal", "lodging", "free_time", "booking", "task", "note"] as const;

const LABELS: Record<(typeof ITEM_TYPES)[number], readonly [en: string, he: string]> = {
  activity: ["Activity", "פעילות"],
  travel: ["Travel", "נסיעה"],
  meal: ["Meal", "ארוחה"],
  lodging: ["Lodging", "לינה"],
  free_time: ["Free time", "זמן חופשי"],
  booking: ["Booking", "הזמנה"],
  task: ["Task", "משימה"],
  note: ["Note", "הערה"],
};

export function itemTypeLabel(type: string, lang: Lang): string {
  const entry = Object.prototype.hasOwnProperty.call(LABELS, type) ? LABELS[type as (typeof ITEM_TYPES)[number]] : undefined;
  return entry ? entry[lang === "he" ? 1 : 0] : type.replace(/_/g, " ");
}

/**
 * The kinds of booking, with the words the Reservations Type boxes and each
 * booking card's badge show (#545). These are the labels the two Type boxes
 * (add and edit) already carried inline, moved here so the badge reuses them
 * instead of a second copy. The server's list: server/text-rules.js BOOKING_TYPES.
 */
export const BOOKING_TYPES = ["flight", "hotel", "car", "attraction", "other"] as const;

const BOOKING_LABELS: Record<(typeof BOOKING_TYPES)[number], readonly [en: string, he: string]> = {
  flight: ["Flight", "טיסה"],
  hotel: ["Stay", "לינה"],
  car: ["Car", "רכב"],
  attraction: ["Attraction", "אטרקציה"],
  other: ["Other", "אחר"],
};

export function bookingTypeLabel(type: string, lang: Lang): string {
  const entry = Object.prototype.hasOwnProperty.call(BOOKING_LABELS, type) ? BOOKING_LABELS[type as (typeof BOOKING_TYPES)[number]] : undefined;
  return entry ? entry[lang === "he" ? 1 : 0] : type;
}
