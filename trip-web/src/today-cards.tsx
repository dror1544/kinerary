// Today's weather and flights in one card with two tabs (video layout only; the current Today keeps its two
// separate panels). Weather is the tab selected first. A trip with no flights shows the weather alone: there is no
// empty tab. A flight that has changed puts a small dot on the Flights tab, named for assistive tech.
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CloudSun, Plane } from "lucide-react";
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

function FlightsPanel({ entries, fallback, lang }: { entries: FlightEntry[]; fallback: string[]; lang: Lang }) {
  const rows = entries.length
    ? entries.map((entry) => ({ key: entry.facts.id, name: entry.facts.name, change: flightChange(entry), stale: Boolean(entry.stale) }))
    : fallback.map((name, index) => ({ key: index, name, change: null as FlightChange | null, stale: false }));
  return (
    <div className="mini-panel flights-panel">
      <Plane size={20} aria-hidden="true" />
      <h3>{copy(lang, "Flights", "טיסות")}</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.key} className={row.change ? "flight-changed" : undefined}>
            <span>{row.name}</span>
            {row.change ? <b className="flight-change">{changeLabel(row.change, lang)}</b> : null}
            {row.stale ? <small>{copy(lang, "Using last known status", "מציגים את המצב האחרון הידוע")}</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WeatherFlightsCard({ config, itinerary, today, flights, fallbackFlights, lang }: {
  config?: TripConfig;
  itinerary?: ActiveItinerary;
  today?: string;
  /** GET /api/operations/flights `statuses`; empty until it has answered. */
  flights: FlightEntry[];
  /** The stored bookings' names from /api/today, shown when no status has come back. */
  fallbackFlights: string[];
  lang: Lang;
}) {
  const id = useId();
  const [selected, setSelected] = useState<"weather" | "flights">("weather");
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const hasFlights = flights.length > 0 || fallbackFlights.length > 0;
  const changed = flights.some((entry) => flightChange(entry) !== null);
  const weather = today ? <TodayWeather key={today} config={config} itinerary={itinerary} today={today} lang={lang} /> : null;

  // One thing to show: show it, with no tabs around it.
  if (!hasFlights) return weather ? <div className="weather-flights is-single">{weather}</div> : null;
  if (!today) return <div className="weather-flights is-single"><FlightsPanel entries={flights} fallback={fallbackFlights} lang={lang} /></div>;

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
      <div role="tabpanel" id={`${id}-panel-weather`} aria-labelledby={`${id}-tab-weather`} hidden={selected !== "weather"}>{weather}</div>
      <div role="tabpanel" id={`${id}-panel-flights`} aria-labelledby={`${id}-tab-flights`} hidden={selected !== "flights"}>
        <FlightsPanel entries={flights} fallback={fallbackFlights} lang={lang} />
      </div>
    </section>
  );
}
