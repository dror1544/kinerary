import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CloudSun } from "lucide-react";
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
  const tripDates = itinerary?.days.length
    ? itinerary.days.map((day) => day.date)
    : config?.phases?.map((phase) => phase.end || phase.dates?.end || "") || [];
  const lastTripDay = tripDates.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().at(-1);
  const requestedDate = shiftDate(today, offset);
  const date = lastTripDay && lastTripDay >= today && requestedDate > lastTripDay ? lastTripDay : requestedDate;
  const dayOffset = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
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
  const atTripEnd = Boolean(lastTripDay && date >= lastTripDay);
  const canAdvance = Boolean(lastTripDay && nextDate <= lastTripDay && dates.includes(nextDate));
  const BackArrow = lang === "he" ? ChevronRight : ChevronLeft;
  const NextArrow = lang === "he" ? ChevronLeft : ChevronRight;
  const name = label(stop?.name, lang) || label(phase?.title, lang) || phase?.id;
  return <section className="mini-panel weather-panel" aria-label={copy("Weather", "מזג אוויר")}>
    <CloudSun size={20} />
    <h3>{copy("Weather", "מזג אוויר")}</h3>
    <strong>{name || copy("No planned location", "אין מיקום מתוכנן")}</strong>
    <nav className="weather-navigation" dir={lang === "he" ? "rtl" : "ltr"} aria-label={copy("Forecast days", "ימי התחזית")}>
      <button type="button" aria-label={copy("Back", "הקודם")} title={copy("Back", "הקודם")} disabled={dayOffset === 0} onClick={() => setOffset(dayOffset - 1)}><BackArrow size={20} aria-hidden="true" /></button>
      <div className="weather-date"><span>{dayOffset === 0 ? copy("Today", "היום") : dayOffset === 1 ? copy("Tomorrow", "מחר") : ""}{dayOffset < 2 ? " · " : ""}{new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</span>
        <button className="weather-today" type="button" disabled={dayOffset === 0} onClick={() => setOffset(0)}>{copy("Today", "היום")}</button>
      </div>
      <button type="button" aria-label={copy("Next", "הבא")} title={copy("Next", "הבא")} disabled={!canAdvance} onClick={() => setOffset(dayOffset + 1)}><NextArrow size={20} aria-hidden="true" /></button>
    </nav>
    <div aria-live="polite">
      {!mapped ? <p>{copy("No mapped location for this day.", "אין מיקום במפה ליום הזה.")}</p>
        : weather.isPending ? <p>{copy("Loading forecast…", "טוענים תחזית…")}</p>
        : weather.data?.temperature_max != null || weather.data?.temperature_min != null ? <>
          <p>{copy("High", "מקסימום")} {weather.data.temperature_max == null ? "—" : `${Math.round(weather.data.temperature_max)}°C`} · {copy("Low", "מינימום")} {weather.data.temperature_min == null ? "—" : `${Math.round(weather.data.temperature_min)}°C`}</p>
          {weather.data.precipitation_probability != null && <p>{copy("Chance of rain", "סיכוי לגשם")}: {weather.data.precipitation_probability}%</p>}
        </> : <p>{copy("Forecast unavailable for this day.", "אין תחזית זמינה ליום הזה.")}</p>}
      {mapped && weather.data?.stale && <small>{copy("Last known forecast", "התחזית האחרונה הידועה")}{weather.data.fetched_at ? ` · ${new Date(weather.data.fetched_at).toLocaleString(lang === "he" ? "he-IL" : "en-GB")}` : ""}</small>}
    </div>
    {atTripEnd ? <small>{copy("Last trip day", "היום האחרון בטיול")}</small>
      : dates.length > 0 && !dates.includes(nextDate) && <small>{copy("Latest available forecast day", "היום האחרון בתחזית הזמינה")}</small>}
  </section>;
}
