// Today's weather and flights in one card with two tabs (video layout only; the current Today keeps its two
// separate panels). Weather is the tab selected first. A trip with no flights shows the weather alone: there is no
// empty tab. A flight that has changed puts a small dot on the Flights tab, named for assistive tech. The tabs are
// part of the card, like folder tabs: the selected one is outlined in the card's frame colour and opens into it, and
// the panels carry no heading of their own, since the tab names them (Dror, 2026-11-18).
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CloudSun, Plane, TicketCheck } from "lucide-react";
import { TodayWeather } from "./TodayWeather";
import type { ActiveItinerary, TripConfig } from "./api";

type Lang = "en" | "he";
const copy = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

// What GET /api/operations/flights returns for one booking (server/living-journey.js flightStatus): the booking's
// own facts, where the observation came from, whether it is a cached copy past its freshness, and — only when the
// provider answered — the provider's status, gates, terminals and scheduled/estimated times.
export type FlightEntry = {
  facts: { id: number; name: string; identifier: string | null };
  source: string;
  stale?: boolean;
  status: unknown;
};

export type FlightChange = "cancelled" | "diverted" | "delayed" | "time_changed";

/** An estimate this far from the schedule is a change (airlines move times by a few minutes all day). */
export const FLIGHT_CHANGE_MINUTES = 15;

const minutesBetween = (scheduled: unknown, estimated: unknown) => {
  if (typeof scheduled !== "string" || typeof estimated !== "string") return null;
  const a = Date.parse(scheduled);
  const b = Date.parse(estimated);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 60000) : null;
};

/**
 * Has this flight changed? Defined from what the site actually knows, and no further:
 *  - the provider's status text says cancelled, diverted or delayed; or
 *  - its estimated departure or arrival is 15 or more minutes off its scheduled one (later: delayed, earlier: time_changed).
 * Not a change: no observation at all (a booking the provider was never asked about, or has no identifier for), a
 * stale cached observation (we do not know it still holds), a status that is merely "scheduled"/"en route"/"landed",
 * and gate or terminal values — the site stores only the current gate, with no earlier one to differ from, so a gate
 * "change" cannot be told from a gate. Unknown is never a change.
 */
export function flightChange(entry: FlightEntry): FlightChange | null {
  if (entry.stale || entry.source !== "flightaware") return null;
  const status = entry.status;
  if (!status || typeof status !== "object") return null;
  const record = status as Record<string, unknown>;
  const text = typeof record.status === "string" ? record.status : "";
  if (/cancel/i.test(text)) return "cancelled";
  if (/divert/i.test(text)) return "diverted";
  if (/delay/i.test(text)) return "delayed";
  const shifts = [minutesBetween(record.scheduled_out, record.estimated_out), minutesBetween(record.scheduled_in, record.estimated_in)]
    .filter((value): value is number => value !== null);
  if (shifts.some((value) => value >= FLIGHT_CHANGE_MINUTES)) return "delayed";
  if (shifts.some((value) => value <= -FLIGHT_CHANGE_MINUTES)) return "time_changed";
  return null;
}

const changeLabel = (change: FlightChange, lang: Lang) => ({
  cancelled: copy(lang, "Cancelled", "בוטלה"),
  diverted: copy(lang, "Diverted", "הוסטה"),
  delayed: copy(lang, "Delayed", "מתעכבת"),
  time_changed: copy(lang, "Time changed", "הזמן השתנה"),
})[change];

export type BookedFlight = { id: number; name: string; date_from?: string | null };

const flightDate = (date: string | null | undefined, lang: Lang) => date && /^\d{4}-\d{2}-\d{2}$/.test(date)
  ? new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))
  : null;

// Each flight is one tap to its booking, where the ticket is (Dror, 2026-11-18). A row says what the site knows: the
// flight, its date, and a change when there is one, or "on schedule" when the provider answered and nothing changed.
function FlightsPanel({ entries, booked, lang, bare, onOpenFlight }: {
  entries: FlightEntry[]; booked: BookedFlight[]; lang: Lang; bare?: boolean; onOpenFlight?: (bookingId: number | null) => void;
}) {
  const dates = new Map(booked.map((flight) => [flight.id, flight.date_from]));
  const rows = entries.length
    ? entries.map((entry) => ({ id: entry.facts.id, name: entry.facts.name, date: dates.get(entry.facts.id), change: flightChange(entry),
      stale: Boolean(entry.stale), live: entry.source === "flightaware" && !entry.stale && Boolean(entry.status) && typeof entry.status === "object" }))
    : booked.map((flight) => ({ id: flight.id, name: flight.name, date: flight.date_from, change: null as FlightChange | null, stale: false, live: false }));
  return (
    <div className="mini-panel flights-panel">
      {bare ? null : <><Plane size={20} aria-hidden="true" /><h3>{copy(lang, "Flights", "טיסות")}</h3></>}
      <ul>
        {rows.map((row) => (
          <li key={row.id} className={row.change ? "flight-changed" : undefined}>
            <button type="button" className="flight-row" onClick={() => onOpenFlight?.(row.id)}
              aria-label={`${row.name}${row.change ? ` — ${changeLabel(row.change, lang)}` : ""} — ${copy(lang, "open the booking", "פתיחת ההזמנה")}`}>
              <span className="flight-row-main">
                <strong>{row.name}</strong>
                <span className="flight-row-meta">
                  {flightDate(row.date, lang) ? <span>{flightDate(row.date, lang)}</span> : null}
                  {row.change ? <b className="flight-change">{changeLabel(row.change, lang)}</b>
                    : row.live ? <span className="flight-ok">{copy(lang, "On schedule", "לפי הלו״ז")}</span> : null}
                </span>
                {row.stale ? <small>{copy(lang, "Using last known status", "מציגים את המצב האחרון הידוע")}</small> : null}
              </span>
              <TicketCheck size={20} aria-hidden="true" className="flight-row-ticket" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WeatherFlightsCard({ config, itinerary, today, flights, bookedFlights, lang, onOpenFlight }: {
  config?: TripConfig;
  itinerary?: ActiveItinerary;
  today?: string;
  /** GET /api/operations/flights `statuses`; empty until it has answered. */
  flights: FlightEntry[];
  /** The stored flight bookings from /api/today: their dates, and the rows shown when no status has come back. */
  bookedFlights: BookedFlight[];
  lang: Lang;
  /** A tapped flight opens its booking. */
  onOpenFlight?: (bookingId: number | null) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<"weather" | "flights">("weather");
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const hasFlights = flights.length > 0 || bookedFlights.length > 0;
  const changed = flights.some((entry) => flightChange(entry) !== null);

  // One thing to show: show it, with no tabs around it.
  if (!hasFlights) return today ? <div className="weather-flights is-single"><TodayWeather key={today} config={config} itinerary={itinerary} today={today} lang={lang} /></div> : null;
  if (!today) return <div className="weather-flights is-single"><FlightsPanel entries={flights} booked={bookedFlights} lang={lang} onOpenFlight={onOpenFlight} /></div>;
  const weather = <TodayWeather key={today} config={config} itinerary={itinerary} today={today} lang={lang} bare />;

  const order = ["weather", "flights"] as const;
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const forward = lang === "he" ? "ArrowLeft" : "ArrowRight"; // right-to-left: the next tab is on the left
    const back = lang === "he" ? "ArrowRight" : "ArrowLeft";
    const index = order.indexOf(selected);
    let next: (typeof order)[number] | null = null;
    if (event.key === forward) next = order[(index + 1) % order.length]!;
    else if (event.key === back) next = order[(index + order.length - 1) % order.length]!;
    else if (event.key === "Home") next = order[0];
    else if (event.key === "End") next = order[order.length - 1]!;
    if (!next) return;
    event.preventDefault();
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const tabProps = (name: (typeof order)[number]) => ({
    id: `${id}-tab-${name}`,
    role: "tab" as const,
    type: "button" as const,
    "aria-selected": selected === name,
    "aria-controls": `${id}-panel-${name}`,
    tabIndex: selected === name ? 0 : -1,
    className: selected === name ? "active" : undefined,
    onClick: () => setSelected(name),
    onKeyDown: move,
    ref: (node: HTMLButtonElement | null) => { tabs.current[name] = node; },
  });
  return (
    <section className="weather-flights" aria-label={copy(lang, "Weather and flights", "מזג אוויר וטיסות")}>
      <div role="tablist" className="weather-flights-tabs" aria-label={copy(lang, "Weather and flights", "מזג אוויר וטיסות")}>
        <button {...tabProps("weather")}><CloudSun size={16} aria-hidden="true" />{copy(lang, "Weather", "מזג אוויר")}</button>
        <button {...tabProps("flights")} aria-label={changed ? copy(lang, "Flights — changed", "טיסות — שינוי") : undefined}>
          <Plane size={16} aria-hidden="true" />{copy(lang, "Flights", "טיסות")}
          {changed ? <i className="tab-dot" aria-hidden="true" /> : null}
        </button>
      </div>
      {/* Both panels share one grid cell, so the card is as tall as the taller one and does not change size between tabs. */}
      <div className={`weather-flights-body is-${selected}`}>
        <div role="tabpanel" id={`${id}-panel-weather`} aria-labelledby={`${id}-tab-weather`} hidden={selected !== "weather"}>{weather}</div>
        <div role="tabpanel" id={`${id}-panel-flights`} aria-labelledby={`${id}-tab-flights`} hidden={selected !== "flights"}>
          <FlightsPanel entries={flights} booked={bookedFlights} lang={lang} bare onOpenFlight={onOpenFlight} />
        </div>
      </div>
    </section>
  );
}
