import type { Booking, ItineraryItem } from "./api";

/**
 * One physical flight, however many bookings are on it (#549).
 *
 * Two couples who book separately on the same flight make two bookings — the
 * data is right, and Reservations keeps a row for each. The plan is about what
 * the group DOES, and the group is on one plane, so the Plan board and the Map
 * show that flight once. Dror, 2026-11-12: "If same flight and date we should
 * see it twice but with ability to distinguish on the planned board it should
 * be once."
 *
 * Identity is flight number + calendar day. A line with no recognisable flight
 * number is never grouped: two unnumbered "Harbortown → Gatecity" lines may be
 * two different trips, and merging them would silently lose one — the failure
 * this repository's reliability guarantees exist to prevent.
 */

// An IATA-style designator (two characters, at least one a letter) then 1-4
// digits, at the START of the line, optionally after the word "flight". Upper
// case in the source text is what the transformer writes ("LY8801 …",
// "SL 482 …"); an agent-typed "flight sl 482" is read too.
const FLIGHT_NUMBER = /^\s*(?:(?:flight|טיסה)\s+)?([A-Za-z][A-Za-z0-9]|[0-9][A-Za-z])\s?(\d{1,4})(?![\dA-Za-z])/i;

/** "SL 482 Harbortown → Gatecity" -> "SL482"; null when the line carries no flight number. */
export function flightNumberOf(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const match = FLIGHT_NUMBER.exec(text || "");
    if (!match) continue;
    // Without the word "flight" in front, only an upper-case designator counts:
    // "Go 12" or "Ab 3" in prose is not a flight, "SL 482" is.
    const hasPrefix = /^\s*(?:flight|טיסה)\s/i.test(text || "");
    if (!hasPrefix && match[1] !== match[1]!.toUpperCase()) continue;
    return `${match[1]}${match[2]}`.toUpperCase();
  }
  return null;
}

const dayOf = (value: string | null | undefined) => (value || "").slice(0, 10);

/** A plan item that is a flight line: its text starts with a flight number AND it says where it goes, or its booking is a flight. */
function flightKeyOfItem(item: ItineraryItem): string | null {
  if (!item.date) return null;
  const number = flightNumberOf(item.text_en, item.text_he);
  if (!number) return null;
  const route = /[→←↔]|->|\bto\b|\bfrom\b/i.test(`${item.text_en || ""} ${item.text_he || ""}`);
  const bookedFlight = item.booking?.type === "flight";
  if (!route && !bookedFlight && item.item_type !== "travel") return null;
  // The same wording too: one flight number can be two legs of one day
  // ("LY8801 TLV → ATH", "LY8801 ATH → CDG"), and a line that differs is not
  // provably the same flight. Collapsing it would lose a leg; a visible
  // duplicate costs nothing. Two bookings of one flight carry identical text.
  const wording = (item.text_en || item.text_he || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${dayOf(item.date)}|${number}|${wording}`;
}

/**
 * The plan's items with each flight once. The first item of a group stays where
 * it is — unless a later one carries a booking and it does not, in which case
 * that one is kept in its place. Every other item is returned untouched.
 */
export function collapseSameFlight(items: ItineraryItem[]): ItineraryItem[];
export function collapseSameFlight(items: ItineraryItem[] | undefined): ItineraryItem[] | undefined;
export function collapseSameFlight(items: ItineraryItem[] | undefined): ItineraryItem[] | undefined {
  if (!items) return items;
  const kept = new Map<string, number>();
  const out: ItineraryItem[] = [];
  for (const item of items) {
    const key = flightKeyOfItem(item);
    if (!key) { out.push(item); continue; }
    const at = kept.get(key);
    if (at === undefined) { kept.set(key, out.length); out.push(item); continue; }
    if (!out[at]!.booking && item.booking) out[at] = item;
  }
  return out.length === items.length ? items : out;
}

export type SameFlight = { position: number; size: number };

/**
 * For Reservations: every flight booking that shares its flight number and day
 * with another, by booking id, with its place in the group (1-based, in the
 * order the list already has — date, then id). A booking nobody shares a
 * flight with is absent.
 */
export function sameFlightGroups(bookings: Booking[]): Map<number, SameFlight> {
  const groups = new Map<string, Booking[]>();
  for (const booking of bookings) {
    if (booking.type !== "flight" || !booking.date_from) continue;
    const number = flightNumberOf(booking.name);
    if (!number) continue;
    const key = `${dayOf(booking.date_from)}|${number}`;
    groups.set(key, [...(groups.get(key) || []), booking]);
  }
  const result = new Map<number, SameFlight>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.forEach((booking, index) => result.set(booking.id, { position: index + 1, size: members.length }));
  }
  return result;
}
