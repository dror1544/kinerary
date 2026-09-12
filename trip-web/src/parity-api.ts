import { api } from "./api";
export type DoneTask = { task_id: string; done_by: string; done_at: string };
export type VenueComment = { id: number; username: string; body: string };
export type Rsvp = {
  username: string;
  status: "yes" | "no" | "maybe";
  note?: string;
};
export type FoundItem = {
  id: number;
  name: string;
  phone: string;
  item: string;
  location: string;
  resolved: number;
};
export type Rates = {
  base: string;
  home: string;
  date: string | null;
  stale?: boolean;
  rates: Record<string, number>;
};
export const getTasks = () => api<DoneTask[]>("/api/tasks/done");
export const toggleTask = (id: string) =>
  api(`/api/tasks/${encodeURIComponent(id)}/done`, { method: "POST" });
export const getRates = () => api<Rates>("/api/currency-rates");
export const getRatings = () =>
  api<Record<string, Record<string, number>>>("/api/ratings");
export const rateVenue = (venue: string, rating: number) =>
  api("/api/ratings", {
    method: "POST",
    body: JSON.stringify({ venue, rating }),
  });
export const getVenueComments = (id: string) =>
  api<VenueComment[]>(`/api/comments/venue/${encodeURIComponent(id)}`);
export const commentVenue = (id: string, body: string) =>
  api(`/api/comments/venue/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
export const removeVenueComment = (id: number) =>
  api(`/api/comments/venue/${id}`, { method: "DELETE" });
export const getRsvps = (id: string) =>
  api<Rsvp[]>(`/api/rsvps/${encodeURIComponent(id)}`);
export const setRsvp = (id: string, status: Rsvp["status"], note: string) =>
  api(`/api/rsvps/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ status, note }),
  });
export const getFound = () => api<FoundItem[]>("/api/lost-found");
export const reportFound = (body: {
  name: string;
  phone: string;
  item: string;
  location: string;
}) => api("/api/lost-found", { method: "POST", body: JSON.stringify(body) });
export const resolveFound = (id: number, resolved: boolean) =>
  api(`/api/lost-found/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ resolved }),
  });
