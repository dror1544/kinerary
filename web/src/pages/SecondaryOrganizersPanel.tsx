import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, issueSecondaryOrganizerLink, removeSecondaryOrganizer, type TripSummary } from "../api";
import { formatDay, formatTime } from "./dates";

/**
 * "Other organizers" - the trip's main organizer adds a secondary organizer, and takes one away.
 *
 * A secondary organizer organizes THIS trip from Telegram and gets the organizer view on the trip site. They have no
 * dashboard, no account to sign up for and no other trip, and they cannot add organizers or create links: this panel is the
 * only place those happen, and it is shown to the trip's owner only. The server decides who that is - it sends
 * `secondaryOrganizers` to the owner on a password or Google session and to nobody else - so a page that was handed no list
 * shows nothing. A Telegram-minted session may not mint a way into the trip, so it is told to sign in with its password.
 *
 * The trip link works once and for a short while, and whoever opens it in Telegram becomes the organizer: say so.
 * Removal is immediate and asks first. Names are what Telegram says (a first name and an @username); they are shown, never acted on.
 */
export function SecondaryOrganizersPanel({ trip }: { trip: TripSummary }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const scoped = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false }).data?.scope === "telegram";
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["trips"] }),
    queryClient.invalidateQueries({ queryKey: ["trip", trip.id] }),
  ]);
  const link = useMutation({ mutationFn: () => issueSecondaryOrganizerLink(trip.id) });
  const remove = useMutation({
    mutationFn: (secondaryId: string) => removeSecondaryOrganizer(trip.id, secondaryId),
    onSuccess: async () => { setConfirming(null); await refresh(); },
  });
  const mainOrganizer = trip.permissions.dashboard && trip.permissions.role === "owner";
  if (!mainOrganizer) return null;
  if (scoped) {
    return (
      <aside className="workflow-card" id="other-organizers">
        <h2>Other organizers</h2>
        <p>Signed in with Telegram: to add or remove an organizer, sign in with your password.</p>
      </aside>
    );
  }
  const people = trip.secondaryOrganizers ?? [];
  return (
    <aside className="workflow-card" id="other-organizers">
      <h2>Other organizers</h2>
      <p>Add someone who helps organize this trip. They can organize it from Telegram and open its organizer view on the trip site. They can't add organizers, create links or see your other trips, and they have no dashboard.</p>
      {people.length > 0 && (
        <ul className="invite-list">
          {people.map((person) => (
            <li key={person.id}>
              <div>
                <strong>{person.name ? <bdi>{person.name}</bdi> : "Telegram account"}{person.username ? <> <bdi>@{person.username}</bdi></> : null}</strong>
                <small>Joined {formatDay(person.joinedAt)}</small>
              </div>
              {confirming === person.id
                ? <span>
                  <button type="button" className="text-button" onClick={() => remove.mutate(person.id)} disabled={remove.isPending}>Confirm remove</button>
                  <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep</button>
                </span>
                : <button type="button" className="text-button" onClick={() => setConfirming(person.id)}>Remove organizer</button>}
            </li>
          ))}
        </ul>
      )}
      {people.length === 0 && <p className="subtle">No other organizers yet.</p>}
      {!link.data && (
        <button type="button" className="button button-small" onClick={() => link.mutate()} disabled={link.isPending}>
          {link.isPending ? "Preparing link…" : "Add an organizer"}
        </button>
      )}
      {link.data && (
        <div className="telegram-issued">
          <a className="button button-small" href={link.data.deepLink} target="_blank" rel="noopener noreferrer">Open in Telegram</a>
          <small>Works once, until {formatTime(link.data.expiresAt)}. Whoever opens it in Telegram becomes an organizer of this trip, so send it only to the person you mean.</small>
          <input readOnly aria-label="Organizer link" value={link.data.deepLink} onFocus={(event) => event.currentTarget.select()} />
        </div>
      )}
      {remove.isError && <div className="notice" role="alert">{remove.error.message}</div>}
      {link.isError && <div className="notice" role="alert">{link.error.message}</div>}
    </aside>
  );
}
