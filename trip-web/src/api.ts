import { z } from "zod";

export const runtimeUrl = (window as unknown as { runtimePath?: (path: string) => string }).runtimePath || ((path: string) => path);

export const tokenStore = {
  get: () => localStorage.getItem("tripToken") || localStorage.getItem("trip-token") || localStorage.getItem("token"),
  set: (token: string) => localStorage.setItem("tripToken", token),
  clear: () => {
    localStorage.removeItem("tripToken");
    localStorage.removeItem("trip-token");
    localStorage.removeItem("token");
  },
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(runtimeUrl(path), { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const bilingualSchema = z.union([
  z.string(),
  z.object({ he: z.string().optional(), en: z.string().optional() }),
]).optional();

export const configSchema = z.object({
  meta: z.object({
    title: z.string().optional(),
    destination: z.string().optional(),
    homePhoto: z.string().optional(),
    mapPhoto: z.string().optional(),
    // Optional trip-owned mark shown in the hero. Keep it outside git/runtime
    // storage when it is an uploaded image; a public HTTPS URL also works.
    logo: z.string().optional(),
    logoAlt: z.string().optional(),
  }).optional(),
  phases: z.array(z.object({
    id: z.string(),
    title: bilingualSchema,
    start: z.string().optional(),
    end: z.string().optional(),
    hero: z.object({ photo: z.string().optional() }).optional(),
    mapStop: z.object({ lat: z.number().optional(), lng: z.number().optional(), name: bilingualSchema }).optional(),
    accommodation: z.object({
      name: bilingualSchema,
      name_en: z.string().optional(),
      address: z.string().optional(),
      location_url: z.string().optional(),
    }).optional(),
  })).optional(),
  agent: z.object({
    name: z.string().optional(),
    name_en: z.string().optional(),
    profile: z.string().optional(),
  }).optional(),
  participants: z.array(z.object({
    username: z.string(),
    name: z.string().optional(),
    name_en: z.string().optional(),
    color: z.string().optional(),
  })).optional(),
});

const extraLinkSchema = z.object({
  label: bilingualSchema,
  title: bilingualSchema,
  name: bilingualSchema,
  url: z.string().optional(),
  href: z.string().optional(),
}).passthrough();

export const itemSchema = z.object({
  item_uid: z.string(),
  phase_id: z.string(),
  date: z.string().nullable().optional(),
  time: z.string().nullable().optional(),
  time_sort: z.number().nullable().optional(),
  item_type: z.string(),
  text_he: z.string(),
  text_en: z.string().nullable().optional(),
  location_url: z.string().nullable().optional(),
  waze_url: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
  ticket_url: z.string().nullable().optional(),
  extra_links: z.array(extraLinkSchema).nullable().optional(),
  booking: z.object({
    id: z.number(),
    type: z.string(),
    name: z.string(),
    confirmation: z.string().nullable().optional(),
    conf_file: z.string().nullable().optional(),
    location_url: z.string().nullable().optional(),
    google_wallet_url: z.string().nullable().optional(),
    apple_wallet_url: z.string().nullable().optional(),
    pkpass_file: z.string().nullable().optional(),
  }).nullable().optional(),
  confirmation_state: z.string().optional(),
  provenance: z.object({ status: z.string() }).optional(),
});

export type TripConfig = z.infer<typeof configSchema>;
export type ItineraryItem = z.infer<typeof itemSchema>;
export type ItineraryDay = {
  phase_id: string;
  date: string;
  label_he?: string | null;
  label_en?: string | null;
  lodging_context?: { name?: string | null; address?: string | null; location_url?: string | null } | null;
};

export type ActiveItinerary = {
  revision: string;
  days: ItineraryDay[];
  items: ItineraryItem[];
};

export type TodayContext = {
  today: string;
  phase: "pre_trip" | "flight_day" | "active_day" | "transfer_day" | "post_trip";
  countdown_days: number | null;
  current: ItineraryItem | null;
  next: ItineraryItem | null;
  events: ItineraryItem[];
  flights: Array<{ id: number; name: string; date_from?: string | null; confirmation?: string | null }>;
};

const bookingSchema = z.object({
  id: z.number(),
  phase: z.string().nullable().optional(),
  type: z.string(),
  name: z.string(),
  date_from: z.string().nullable().optional(),
  date_to: z.string().nullable().optional(),
  passengers: z.string().nullable().optional(),
  confirmation: z.string().nullable().optional(),
  conf_file: z.string().nullable().optional(),
  location_url: z.string().nullable().optional(),
  google_wallet_url: z.string().nullable().optional(),
  apple_wallet_url: z.string().nullable().optional(),
  pkpass_file: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  review_status: z.enum(["approved", "draft"]).optional(),
});

export type Booking = z.infer<typeof bookingSchema>;

export async function login(username: string, password: string) {
  const payload = await api<{ token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  tokenStore.set(payload.token);
  return payload;
}

export const getConfig = () => api<unknown>("/api/config").then((value) => configSchema.parse(value));
export const getMe = () => api<{ username: string; name?: string; name_en?: string; is_organizer?: boolean }>("/api/auth/me");
export const getUiSettings = () => api<{ design_variant: "classic" | "modern"; hero: { url: string | null; focal_x: number; focal_y: number } }>("/api/ui-settings");
export const getToday = () => api<TodayContext>("/api/today");
export const getItinerary = () => api<unknown>("/api/itinerary/active").then((value) => z.object({
  revision: z.string(),
  days: z.array(z.any()),
  items: z.array(itemSchema),
}).parse(value) as ActiveItinerary);
export const getBookings = () => api<unknown>("/api/bookings").then((value) => z.array(bookingSchema).parse(value));
export const extractBookingDetails = (body: FormData) => api<unknown>("/api/bookings/extract", { method: "POST", body });
export const extractBookingDraft = (body: FormData) => api<{ ok: true; booking: Booking; extracted: unknown }>("/api/bookings/extract-draft", { method: "POST", body });
export const approveBookingDraft = (id: number) => api<{ ok: true }>(`/api/bookings/${id}/approve`, { method: "POST" });
export const getMoments = () => api<Array<{ id: string; caption: string; body?: string | null; date?: string | null; visibility: string; author: string }>>("/api/moments");
export const createMoment = (input: { caption: string; body?: string; date?: string; visibility?: "draft" | "published" }) => api("/api/moments", { method: "POST", body: JSON.stringify(input) });
export const getHermes = () => api<{ identity: { name: string }; available: boolean; ask_in_telegram: boolean; telegram_username: string | null; verification_freshness: { open_issues: number; checked_at: string } }>("/api/hermes/status");
export const reportIssue = (input: { title: string; detail?: string; phase_id?: string | null; date?: string | null; item_uid?: string | null; severity?: "info" | "warning" | "critical" }) => api<{ id: string }>("/api/issues/report", { method: "POST", body: JSON.stringify(input) });
export const getConfirmations = () => api<{ items: Array<{ id: number; type: string; name: string; state: string; next_action?: string | null }> }>("/api/confirmations/summary");
export const getFlightStatus = () => api<{ statuses: Array<{ facts: { id: number; name: string; identifier: string | null }; source: string; stale?: boolean; status: unknown }> }>("/api/operations/flights");
export const getWeather = (lat: number, lon: number, date: string) => api<{ source: string; date: string; stale?: boolean; fetched_at?: string | null; temperature_max?: number | null; temperature_min?: number | null; precipitation_probability?: number | null }>(`/api/operations/weather?lat=${lat}&lon=${lon}&date=${date}`);
