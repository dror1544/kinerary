import type { ActiveItinerary, ItineraryItem, TripConfig } from "./api";

// A stable item link survives title/date edits. Older configs can match an
// unambiguous activity by phase, date and exact title in either language.
export function rsvpForItem(item: ItineraryItem, config?: TripConfig, itinerary?: ActiveItinerary) {
  const activities = config?.phases?.find(p => p.id === item.phase_id)?.rsvp_activities || [];
  const matches = (activity: typeof activities[number], candidate: ItineraryItem) => {
    if (candidate.phase_id !== item.phase_id) return false;
    if (activity.item_uid) return activity.item_uid === candidate.item_uid;
    if (!candidate.date || activity.date !== candidate.date) return false;
    const title = activity.title || activity.name;
    return matchesItemName(title, candidate);
  };
  const matched = activities.filter(activity => matches(activity, item));
  if (matched.length !== 1) return undefined;
  const activity = matched[0];
  if (!activity.item_uid && itinerary && itinerary.items.filter(candidate => matches(activity, candidate)).length !== 1) return undefined;
  return activity;
}


// Ratings belong to the venue, so repeated visits share the same record.
export function venueForItem(item: ItineraryItem, config?: TripConfig) {
  const matches = (config?.phases?.find(p => p.id === item.phase_id)?.venues || []).filter(venue => {
    if (!venue.id) return false;
    if (venue.item_uid) return venue.item_uid === item.item_uid;
    return matchesItemName(venue.name, item);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function matchesItemName(name: string | { he?: string; en?: string } | undefined, item: ItineraryItem) {
  const normalize = (value?: string | null) => (value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const names = typeof name === "string" ? [name] : [name?.he, name?.en];
  const titles = [item.text_he, item.text_en].map(normalize);
  return names.some(value => { const normalized = normalize(value); return normalized && titles.includes(normalized); });
}
