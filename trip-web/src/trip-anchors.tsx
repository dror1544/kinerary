// Today's "Trip anchors" card (owner, 2026-11-21): the trip's must-do and must-attend bookings, in date order, one row
// each — hotels, the rental car, flights, event and concert tickets, the rest. It replaces the old "Readiness" band, whose
// to-do list ("confirmation missing") was about the paperwork, not about where the trip is anchored; the Readiness
// page (tasks, packing, useful information) is still reached from the More menu and at #readiness.
//
// The data is what the Bookings tab reads (GET /api/bookings, query key ["bookings"]), so the two cannot disagree and the
// server's own scoping stands: it already withholds drafts and retired rows from a member. Every booking type renders, a
// type this build does not know included. A member sees the same rows as an organizer — members see all trip data.
//
// Three states, none mistaken for another: still loading, could not load, and loaded with nothing. "Nothing booked yet" is
// said only after a successful read; a failed read says it failed.
import { useQuery } from "@tanstack/react-query";
import { getBookings, type Booking, type TripConfig } from "./api";
import { bookingTypeIcon, bookingTypeLabel } from "./item-types";

type Lang = "en" | "he";
const copy = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

const shortDate = (date: string, lang: Lang) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(lang === "he" ? "he-IL" : "en-US", { month: "short", day: "numeric" });

/** "Dec 2" or "Dec 2 → Dec 6" (a stay, a rental); null when the booking has no date at all. */
export function anchorDateLine(booking: Pick<Booking, "date_from" | "date_to">, lang: Lang): string | null {
  const { date_from: from, date_to: to } = booking;
  if (from && to && from !== to) return `${shortDate(from, lang)} → ${shortDate(to, lang)}`;
  if (from || to) return shortDate((from || to)!, lang);
  return null;
}

/** Date order: by the first date a booking has, the undated last (the server puts them first), then by id so it is stable. */
export function sortAnchors(bookings: Booking[]): Booking[] {
  const key = (booking: Booking) => booking.date_from || booking.date_to || "";
  return [...bookings].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return !ka ? 1 : !kb ? -1 : ka.localeCompare(kb);
    return a.id - b.id;
  });
}

function phaseName(config: TripConfig | undefined, phaseId: string | null | undefined, lang: Lang): string {
  if (!phaseId) return "";
  const title = config?.phases?.find((phase) => phase.id === phaseId)?.title;
  if (!title) return "";
  if (typeof title === "string") return title;
  const record = title as Record<string, string | undefined>;
  return record[lang] || record.en || record.he || "";
}

export function TripAnchorsCard({ config, lang, isOrganizer, onOpenBooking, onOpenBookings }: {
  config?: TripConfig;
  lang: Lang;
  isOrganizer?: boolean;
  /** A tapped row opens that booking on the Bookings page, the same way a flight on Today does. */
  onOpenBooking?: (bookingId: number) => void;
  /** The empty state's way to the Bookings page. */
  onOpenBookings?: () => void;
}) {
  const bookings = useQuery({ queryKey: ["bookings"], queryFn: getBookings });
  const rows = sortAnchors(bookings.data || []);
  // A trip with one place has nothing to tell apart by phase; with several, the row says which one it is in.
  const showPhase = (config?.phases?.length || 0) > 1;
  const title = copy(lang, "Trip anchors", "עוגני הטיול");
  return (
    <section className="section-band trip-anchors" aria-label={title}>
      <div className="section-heading">
        <h2>{title}</h2>
        <p>{copy(lang, "Where you sleep, how you get around, and the tickets you cannot miss.", "איפה ישנים, איך מגיעים, והכרטיסים שאסור לפספס.")}</p>
      </div>
      {bookings.isError && !rows.length ? (
        <p className="empty-state anchors-error">{copy(lang, "Could not load the bookings right now.", "לא ניתן לטעון את ההזמנות כרגע.")}</p>
      ) : bookings.isLoading ? (
        <p className="empty-state anchors-loading">{copy(lang, "Loading the bookings…", "טוענים את ההזמנות…")}</p>
      ) : rows.length ? (
        <ul className="anchor-list">
          {rows.map((booking) => {
            const date = anchorDateLine(booking, lang);
            const phase = showPhase ? phaseName(config, booking.phase, lang) : "";
            return (
              <li key={booking.id}>
                <button type="button" className="anchor-row" data-booking-type={booking.type} onClick={() => onOpenBooking?.(booking.id)}>
                  <span className="anchor-icon" aria-hidden="true">{bookingTypeIcon(booking.type)}</span>
                  <span className="anchor-main">
                    <strong>{booking.name}</strong>
                    <small>{bookingTypeLabel(booking.type, lang)}{phase ? ` · ${phase}` : ""}</small>
                  </span>
                  <span className="anchor-date">{date ?? copy(lang, "No date yet", "ללא תאריך")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-state anchors-empty">
          {isOrganizer
            ? copy(lang, "Nothing booked yet. Add the hotels, flights and tickets in ", "עוד אין הזמנות. מוסיפים מלונות, טיסות וכרטיסים ב")
            : copy(lang, "Nothing booked yet. See ", "עוד אין הזמנות. אפשר לראות ב")}
          <a href="#bookings" onClick={onOpenBookings}>{copy(lang, "Bookings", "הזמנות")}</a>.
        </p>
      )}
    </section>
  );
}
