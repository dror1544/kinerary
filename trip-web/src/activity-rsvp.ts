import type { ActiveItinerary, ItineraryItem, TripConfig } from "./api";

// A stable item link survives title/date edits. Older configs can match an
// unambiguous activity by phase, date and exact title in either language.
export function rsvpForItem(item: ItineraryItem, config?: TripConfig, itinerary?: ActiveItinerary) {
  const activities = config?.phases?.find(p => p.id === item.phase_id)?.rsvp_activities || [];
  const normalize = (value?: string | null) => (value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const matches = (activity: typeof activities[number], candidate: ItineraryItem) => {
    if (candidate.phase_id !== item.phase_id) return false;
    if (activity.item_uid) return activity.item_uid === candidate.item_uid;
    if (!candidate.date || activity.date !== candidate.date) return false;
    const title = activity.title || activity.name;
    const names = typeof title === "string" ? [title] : [title?.he, title?.en];
    return names.some(name => normalize(name) && [candidate.text_he, candidate.text_en].some(text => normalize(text) === normalize(name)));
  };
  const matched = activities.filter(activity => matches(activity, item));
  if (matched.length !== 1) return undefined;
  const activity = matched[0];
  if (!activity.item_uid && itinerary && itinerary.items.filter(candidate => matches(activity, candidate)).length !== 1) return undefined;
  return activity;
}
