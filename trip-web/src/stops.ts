// The organizer's view of the trip's stops (server/trip-structure.js): the
// effective stop list with provenance and conflicts, and the writes that change
// it. Organizer/agent-only on the server; the site shows the controls only to
// an organizer, but the server's refusal is the enforcement, not the hiding.
import { api, ApiError, type ItineraryDay, type TripConfig } from "./api";
import type { Lang } from "./parity-ui";

export type Bilingual = string | { he?: string; en?: string };
export type StopDates = { start: string; end: string };
export type StopAccommodation = {
  name?: Bilingual;
  name_en?: string;
  type?: string;
  address?: string;
  phone?: string;
  confirmation?: string;
  location_url?: string;
  [key: string]: unknown;
};
export type StopSummary = {
  id: string;
  title?: Bilingual;
  tabLabel?: string;
  emoji?: string;
  dates?: StopDates;
  accommodation?: StopAccommodation;
  unplanned?: boolean;
  note?: Bilingual;
};
export type StopEntry = {
  id: string;
  kind: "config" | "added" | "computed";
  unplanned: boolean;
  stop: StopSummary;
  override: { fields: string[]; booking_id: number | null; updated_by: string; updated_at: string; after_phase_id: string | null } | null;
  conflict: { fields: string[]; base: Record<string, unknown> } | null;
  booking_out_of_sync: boolean;
};
export type StopsPayload = {
  revision: string;
  trip: { start: string | null; end: string | null };
  stops: StopEntry[];
  orphaned_overrides: string[];
};
export type StopHistoryEntry = {
  id: number;
  action: string;
  actor: string;
  note: string | null;
  created_at: string;
  before: { kind: string; fields: Record<string, unknown> } | null;
  after: { kind: string; fields: Record<string, unknown> } | null;
};
export type OutsideItem = { item_uid: string; date: string; time: string | null; text_he: string; text_en: string | null };
export type StopFields = {
  title?: Bilingual;
  dates?: StopDates | null;
  accommodation?: StopAccommodation | null;
  tabLabel?: string;
  emoji?: string;
};

// The query keys a stop change reaches. The config is the effective config
// (stops merged over the file); the itinerary and today follow the rows a
// stop write can move; `stops` and `stop-history` are this editor's own.
export const STOP_CHANGE_KEYS = ["stops", "stop-history", "config", "itinerary", "today", "revisions"];

// The server takes the revision as an entity tag and strips the quotes.
const ifMatch = (revision?: string) => (revision ? { "If-Match": `"${revision}"` } : undefined);

export const getStops = () => api<StopsPayload>("/api/stops");
export const getStopHistory = (id: string) =>
  api<{ phase_id: string; revision: string; history: StopHistoryEntry[] }>(`/api/stops/${encodeURIComponent(id)}/history`);
export const patchStop = (id: string, body: StopFields & { on_outside?: string }, revision?: string) =>
  api<{ revision: string; stop: StopSummary }>(`/api/stops/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(body), headers: ifMatch(revision),
  });
export const splitStop = (id: string, body: { at: string; new_stop: { title: Bilingual } }, revision?: string) =>
  api<{ revision: string; stops: StopSummary[]; moved: { items: string[]; days: string[] }; review?: { status: string; detail: string } }>(
    `/api/stops/${encodeURIComponent(id)}/split`, { method: "POST", body: JSON.stringify(body), headers: ifMatch(revision) });
export const revertStop = (id: string, body: { history_id?: number; on_outside?: string }, revision?: string) =>
  api<{ revision: string; stop: StopSummary }>(`/api/stops/${encodeURIComponent(id)}/revert`, {
    method: "POST", body: JSON.stringify(body), headers: ifMatch(revision),
  });
// The ITINERARY revision, not the stops revision: move-day is a plan write.
export const moveDay = (body: { from_phase_id: string; to_phase_id: string; date: string; headline?: "keep_target" | "take_source" }, itineraryRevision?: string) =>
  api<{ revision: string; moved: { items: string[]; headline: boolean }; review?: { status: string; detail: string } }>(
    "/api/itinerary/move-day", { method: "POST", body: JSON.stringify(body), headers: itineraryRevision ? { "If-Match": itineraryRevision } : undefined });

export const bilingualText = (value: unknown, lang: Lang): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as { he?: unknown; en?: unknown };
    const pick = lang === "he" ? v.he ?? v.en : v.en ?? v.he;
    return typeof pick === "string" ? pick : typeof v.he === "string" ? v.he : typeof v.en === "string" ? v.en : "";
  }
  return "";
};
export const stopTitle = (stop: StopSummary | undefined, lang: Lang) => bilingualText(stop?.title, lang) || stop?.id || "";

// A form's two language boxes as the server's text shape. A value that was a
// plain string and is still the same string, with no second language added,
// goes back as that string — the editor does not rewrite what it did not touch.
export function bilingualFromInputs(he: string, en: string, original?: Bilingual): Bilingual | undefined {
  const h = he.trim(), e = en.trim();
  if (typeof original === "string" && h === original.trim() && !e) return original;
  if (!h && !e) return undefined;
  return { ...(h ? { he: h } : {}), ...(e ? { en: e } : {}) };
}
export function inputsFromBilingual(value: Bilingual | undefined): { he: string; en: string } {
  if (typeof value === "string") return { he: value, en: "" };
  return { he: value?.he || "", en: value?.en || "" };
}

// The accommodation keys the stop route accepts (ACCOMMODATION_KEYS in
// server/trip-structure.js). Anything else on a served hotel — a notes list,
// a PDF, a weather key — the route refuses, so it cannot be carried through a
// save: the form names those before it replaces the hotel.
export const EDITABLE_ACCOMMODATION_KEYS = [
  "name", "name_en", "type", "address", "phone", "confirmation", "location_url",
  "maps", "waze", "url", "guests", "rooms", "cost", "dates", "description", "note",
];
export function editableAccommodation(acc: StopAccommodation | undefined | null) {
  const keep: StopAccommodation = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(acc || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (EDITABLE_ACCOMMODATION_KEYS.includes(key)) keep[key] = value;
    else dropped.push(key);
  }
  return { keep, dropped };
}

export function stopDatesOf(phase: { dates?: { start?: string; end?: string }; start?: string; end?: string } | undefined): StopDates | null {
  const start = phase?.dates?.start || phase?.start;
  const end = phase?.dates?.end || phase?.end;
  return start && end && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end ? { start, end } : null;
}

// Where the family sleeps on the night of `date`, from the stop that covers it
// in the EFFECTIVE config — not the lodging stored on the day row when the plan
// was imported. That stored copy is null after any legacy write and stale after
// a stop edit (a split, a new hotel); the config is refetched on every stop
// change.
//
// A night belongs to the stop that starts on or before it and ends after it:
// on a transfer day (A ends where B starts, as configs and splits write it)
// the night is B's. Only when no stop runs past the date does a stop that ends
// on it count (a config that writes the last night as the end date). The day's
// own stop wins a tie. Config without dated stops: the stored copy, as before.
export type Lodging = { name?: unknown; name_en?: string | null; address?: unknown; location_url?: string | null };
export function tonightLodging(phases: TripConfig["phases"], day: Pick<ItineraryDay, "phase_id" | "date" | "lodging_context"> | undefined, phaseId: string | undefined, date: string): Lodging | null {
  const stored = (day?.lodging_context ?? null) as Lodging | null;
  const dated = (phases || [])
    .map(phase => ({ phase, dates: stopDatesOf(phase) }))
    .filter((p): p is { phase: NonNullable<TripConfig["phases"]>[number]; dates: StopDates } => Boolean(p.dates));
  if (!date || !dated.length) return stored;
  const prefer = <T extends { phase: { id: string } }>(list: T[]) => list.find(p => p.phase.id === phaseId) || list[0];
  const night = prefer(dated.filter(p => p.dates.start <= date && (date < p.dates.end || p.dates.start === p.dates.end)))
    || prefer(dated.filter(p => p.dates.start <= date && date <= p.dates.end));
  if (!night) return stored;
  const acc = night.phase.accommodation;
  if (acc && (acc.name || acc.name_en)) return { name: acc.name, name_en: acc.name_en, address: acc.address, location_url: acc.location_url };
  // The stop has no hotel the site's config carries (a legacy multi-hotel
  // phase is read on the server): the stored copy, but only if it was written
  // for this very stop — never another stop's hotel after a split.
  return stored && day?.phase_id === night.phase.id ? stored : null;
}
export function lodgingName(lodging: Lodging | null, lang: Lang): string {
  if (!lodging) return "";
  if (lang === "en" && typeof lodging.name === "string" && lodging.name_en) return lodging.name_en;
  return bilingualText(lodging.name, lang) || lodging.name_en || "";
}

// ── refusals, in words ─────────────────────────────────────────────────────
export type StopRefusal =
  | { kind: "outside"; items: OutsideItem[] }
  | { kind: "stale" }
  | { kind: "headline"; source: { label_he?: string | null; label_en?: string | null }; target: { label_he?: string | null; label_en?: string | null } }
  | { kind: "message"; text: string };

const tr = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);
const ACCOMMODATION_FIELD_NAMES: Record<string, [string, string]> = {
  name: ["hotel name", "שם המלון"], name_en: ["English hotel name", "שם המלון באנגלית"], address: ["address", "כתובת"],
  phone: ["phone", "טלפון"], confirmation: ["confirmation number", "מספר אישור"], location_url: ["map link", "קישור למפה"],
};

export function describeStopError(error: unknown, lang: Lang): StopRefusal {
  const code = error instanceof Error ? error.message : "";
  const payload = (error instanceof ApiError ? error.payload : {}) as Record<string, unknown>;
  switch (code) {
    case "items_outside_stop":
      return { kind: "outside", items: Array.isArray(payload.items) ? (payload.items as OutsideItem[]) : [] };
    case "stops_changed_reload_before_retry":
    case "itinerary_changed_reload_before_retry":
      return { kind: "stale" };
    case "target_day_has_headline":
      return { kind: "headline", source: (payload.source as never) || {}, target: (payload.target as never) || {} };
  }
  const trip = payload.trip as { start?: string; end?: string } | undefined;
  const stop = payload.stop as { start?: string; end?: string } | undefined;
  const field = typeof payload.field === "string" ? payload.field : "";
  const fieldName = ACCOMMODATION_FIELD_NAMES[field] ? tr(lang, ...ACCOMMODATION_FIELD_NAMES[field]) : field;
  const messages: Record<string, [string, string]> = {
    dates_outside_trip: [
      `The dates must be inside the trip${trip?.start && trip?.end ? ` (${trip.start} – ${trip.end})` : ""}.`,
      `התאריכים חייבים להיות בתוך תאריכי הטיול${trip?.start && trip?.end ? ` (${trip.start} – ${trip.end})` : ""}.`,
    ],
    invalid_dates: ["Choose a first and a last day; the last day cannot be before the first.", "יש לבחור יום ראשון ויום אחרון; היום האחרון לא יכול להיות לפני הראשון."],
    invalid_title: ["The title is empty or too long (120 characters at most).", "הכותרת ריקה או ארוכה מדי (עד 120 תווים)."],
    invalid_accommodation: [`The accommodation's ${fieldName || "details"} is not valid${field === "location_url" ? " (a link starts with https://)" : ""}.`, `${fieldName || "פרטי הלינה"} אינו תקין${field === "location_url" ? " (קישור מתחיל ב-https://)" : ""}.`],
    unknown_accommodation_field: [`The accommodation's "${field}" cannot be set here.`, `לא ניתן לערוך כאן את השדה "${field}" של הלינה.`],
    pin_not_accepted: ["A door code is not stored on the site.", "קוד כניסה לא נשמר באתר."],
    no_fields: ["Nothing changed — there is nothing to save.", "לא שונה דבר — אין מה לשמור."],
    unknown_stop: ["This stop no longer exists. Reload the stops.", "התחנה הזו כבר לא קיימת. טענו מחדש את התחנות."],
    unplanned_stop_is_computed: ["Days not planned yet are computed from the other stops and cannot be edited directly.", "ימים שעוד לא תוכננו מחושבים מהתחנות האחרות ואי אפשר לערוך אותם ישירות."],
    invalid_split_date: ["Choose the day to split on.", "יש לבחור את היום שבו מפצלים."],
    stop_has_no_dates: ["Give this stop dates before splitting it.", "יש לתת לתחנה תאריכים לפני פיצול."],
    split_date_not_inside_stop: [
      `Split on a day strictly inside the stop${stop?.start && stop?.end ? ` (after ${stop.start} and before ${stop.end})` : ""}, so both stops keep a night.`,
      `יש לפצל ביום שנמצא בתוך התחנה${stop?.start && stop?.end ? ` (אחרי ${stop.start} ולפני ${stop.end})` : ""}, כך שלכל תחנה יישאר לילה.`,
    ],
    new_stop_title_required: ["The new stop needs a title.", "לתחנה החדשה נדרשת כותרת."],
    stop_id_taken: ["A stop with that name already exists.", "כבר קיימת תחנה בשם הזה."],
    invalid_stop_id: ["That stop name cannot be used.", "לא ניתן להשתמש בשם התחנה הזה."],
    history_entry_not_found: ["That version is no longer in this stop's history.", "הגרסה הזו כבר לא בהיסטוריה של התחנה."],
    history_entry_has_no_state: ["That entry has nothing to restore.", "ברשומה הזו אין מה לשחזר."],
    added_stop_has_no_base: ["A stop added on the site has no trip-file version to go back to.", "לתחנה שנוספה באתר אין גרסה מקובץ הטיול לחזור אליה."],
    invalid_on_outside: ["Choose another stop to move the items to.", "יש לבחור תחנה אחרת להעברת הפריטים."],
    same_phase: ["The day is already in that stop.", "היום כבר שייך לתחנה הזו."],
    unknown_phase: ["This day's stop no longer exists. Reload.", "התחנה של היום הזה כבר לא קיימת. טענו מחדש."],
    day_not_found: ["There is nothing planned on this day to move.", "אין ביום הזה שום דבר מתוכנן להעברה."],
    invalid_date: ["Choose a day.", "יש לבחור יום."],
    organizer_only: ["Only the trip organizer can change stops.", "רק מארגן הטיול יכול לשנות תחנות."],
  };
  const known = messages[code];
  return { kind: "message", text: known ? tr(lang, ...known) : tr(lang, "Could not save. Your input is kept; please retry.", "השמירה נכשלה. התוכן נשמר בטופס; נסו שוב.") };
}
