import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudSun } from "lucide-react";
import { getWeather, type ActiveItinerary, type TripConfig } from "./api";

type Lang = "en" | "he";
const label = (value: string | { en?: string; he?: string } | undefined, lang: Lang) =>
  typeof value === "string" ? value : value?.[lang] || value?.en || value?.he || "";
export function weatherPhase(config: TripConfig | undefined, itinerary: ActiveItinerary | undefined, date: string) {
  const day = itinerary?.days.find((entry) => entry.date === date);
  // A dated itinerary day is authoritative, including one with no mapped location.
  if (day) return config?.phases?.find((phase) => phase.id === day.phase_id);
  return config?.phases?.find((phase) => {
    const start = phase.start || phase.dates?.start;
    const end = phase.end || phase.dates?.end;
    return start && end && start <= date && date <= end;
  });
}
const shiftDate = (date: string, offset: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

export function TodayWeather({ config, itinerary, today, lang }: {
  config?: TripConfig; itinerary?: ActiveItinerary; today: string; lang: Lang;
}) {
  const [offset, setOffset] = useState(0);
  const date = shiftDate(today, offset);
  const phase = weatherPhase(config, itinerary, date);
  const stop = phase?.mapStop;
  const mapped = Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);
  // Keep a provider horizon available even on an unmapped day, so navigation
  // can reach subsequent planned destinations without inventing forecast dates.
  const anchor = config?.phases?.find((entry) => Number.isFinite(entry.mapStop?.lat) && Number.isFinite(entry.mapStop?.lng))?.mapStop;
  const horizon = useQuery({ queryKey: ["weather", anchor?.lat, anchor?.lng, today],
    queryFn: () => getWeather(anchor!.lat!, anchor!.lng!, today), enabled: Boolean(anchor) });
  const weather = useQuery({ queryKey: ["weather", stop?.lat, stop?.lng, date],
    queryFn: () => getWeather(stop!.lat!, stop!.lng!, date), enabled: mapped });
  const dates = weather.data?.forecast_dates || horizon.data?.forecast_dates || [];
  const nextDate = shiftDate(date, 1);
  const copy = (en: string, he: string) => lang === "he" ? he : en;
  const name = label(stop?.name, lang) || label(phase?.title, lang) || phase?.id;
  return <section className="mini-panel weather-panel" aria-label={copy("Weather", "מזג אוויר")}>
    <CloudSun size={20} />
    <h3>{copy("Weather", "מזג אוויר")}</h3>
    <strong>{name || copy("No planned location", "אין מיקום מתוכנן")}</strong>
    <div className="weather-date">{offset === 0 ? copy("Today", "היום") : offset === 1 ? copy("Tomorrow", "מחר") : ""}{offset < 2 ? " · " : ""}{new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</div>
    <div aria-live="polite">
      {!mapped ? <p>{copy("No mapped location for this day.", "אין מיקום במפה ליום הזה.")}</p>
        : weather.isPending ? <p>{copy("Loading forecast…", "טוענים תחזית…")}</p>
        : weather.data?.temperature_max != null || weather.data?.temperature_min != null ? <>
          <p>{copy("High", "מקסימום")} {weather.data.temperature_max == null ? "—" : `${Math.round(weather.data.temperature_max)}°C`} · {copy("Low", "מינימום")} {weather.data.temperature_min == null ? "—" : `${Math.round(weather.data.temperature_min)}°C`}</p>
          {weather.data.precipitation_probability != null && <p>{copy("Chance of rain", "סיכוי לגשם")}: {weather.data.precipitation_probability}%</p>}
        </> : <p>{copy("Forecast unavailable for this day.", "אין תחזית זמינה ליום הזה.")}</p>}
      {mapped && weather.data?.stale && <small>{copy("Last known forecast", "התחזית האחרונה הידועה")}{weather.data.fetched_at ? ` · ${new Date(weather.data.fetched_at).toLocaleString(lang === "he" ? "he-IL" : "en-GB")}` : ""}</small>}
    </div>
    <nav className="weather-navigation" aria-label={copy("Forecast days", "ימי התחזית")}>
      <button className="secondary-action" disabled={offset === 0} onClick={() => setOffset(offset - 1)}>{copy("Back", "הקודם")}</button>
      <button className="secondary-action" disabled={!dates.includes(nextDate)} onClick={() => setOffset(offset + 1)}>{copy("Next", "הבא")}</button>
    </nav>
    {dates.length > 0 && !dates.includes(nextDate) && <small>{copy("Latest available forecast day", "היום האחרון בתחזית הזמינה")}</small>}
  </section>;
}
