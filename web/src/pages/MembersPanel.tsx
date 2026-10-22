import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, removeTripMember, type TripSummary } from "../api";

const ROLE: Record<string, string> = { owner: "Owner", organizer: "Organizer", member: "Member" };

/**
 * "People on this trip" — and the way to take one off.
 *
 * Removing a member ends their place for real: their trip password stops
 * working, their sign-ins (the portal's and a linked Telegram account's) end, and
 * the invite they came in by is revoked. The server decides who may be removed
 * (`removable`): not yourself, an owner only by an owner, never the last
 * owner or organizer. This panel only asks, after a confirmation, because there
 * is no undo — a removed person needs a fresh invitation.
 */
export function MembersPanel({ trip }: { trip: TripSummary }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (membershipId: string) => removeTripMember(trip.id, membershipId),
    onSuccess: () => { setConfirming(null); return queryClient.invalidateQueries({ queryKey: ["trip", trip.id] }); },
  });
  const scoped = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false }).data?.scope === "telegram";
  if (!trip.permissions.invite || !trip.members?.length) return null;
  if (scoped) {
    return (
      <aside className="workflow-card">
        <h2>People on this trip</h2>
        <p>Signed in with Telegram: to remove people, sign in with your password.</p>
      </aside>
    );
  }
  return (
    <aside className="workflow-card">
      <h2>People on this trip</h2>
      <p>Removing someone ends their access: their trip password, their sign-ins and the invitation they used.</p>
      <ul className="invite-list">
        {trip.members.map((member) => (
          <li key={member.id}>
            <div>
              <strong>{member.displayName}{member.you ? " (you)" : ""}</strong>
              <small>{ROLE[member.role] ?? member.role}{member.runtimeUsername ? ` · ${member.runtimeUsername}` : ""}</small>
            </div>
            {member.removable && (confirming === member.id
              ? <span>
                <button className="text-button" onClick={() => remove.mutate(member.id)} disabled={remove.isPending}>Confirm remove</button>
                <button className="text-button" onClick={() => setConfirming(null)}>Keep</button>
              </span>
              : <button className="text-button" onClick={() => setConfirming(member.id)}>Remove</button>)}
          </li>
        ))}
      </ul>
      {remove.isError && <div className="notice" role="alert">{remove.error.message}</div>}
    </aside>
  );
}
