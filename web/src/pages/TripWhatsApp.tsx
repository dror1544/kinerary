import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMe, getWhatsAppConnections, issueWhatsAppCode, removeWhatsAppConnection, type TripSummary, type WhatsAppConnection,
} from "../api";
import { formatDay, formatTime } from "./dates";

const HOW: Record<WhatsAppConnection["via"], string> = {
  group_code: "with a group code",
  added_to_group: "by adding the number to the group",
  dashboard_code: "with a code from this page",
  group_membership: "by messaging from the group",
};

/**
 * "WhatsApp" - connect the trip's companion to a private WhatsApp chat or to the family's group, and see and remove what is
 * connected (docs/specs/sprint-9/625-whatsapp-via-relay.md).
 *
 * Shown only when the server says so: `trip.whatsapp` is present when the deployment has a WhatsApp number, the trip's switch
 * is on and the viewer runs the trip. Nothing here decides that, and a trip with the switch off shows no trace of it.
 *
 * Connect my WhatsApp makes a one-time code for the signed-in person and hands back a link that opens WhatsApp on a chat
 * with the deployment's number, the code already written; the person presses send from their own phone. The code is never
 * shown as text and never listed. A group is bound by adding the number to it (the owner, once connected) or by the group
 * code: WhatsApp's share screen with the coded message, where the owner picks the group. Only the trip's owner sees the
 * group steps and the list. The list names groups by title and people by name with the last four digits of their number
 * when known, never more. Group titles and names are what people typed: shown as text, never acted on.
 *
 * A Telegram-minted session cannot mint a way into the trip's chat, so it is told to sign in with its password.
 */
export function TripWhatsApp({ trip }: { trip: TripSummary }) {
  const queryClient = useQueryClient();
  const scoped = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false }).data?.scope === "telegram";
  const [confirming, setConfirming] = useState<string | null>(null);
  const owner = Boolean(trip.whatsapp?.owner);
  const available = Boolean(trip.whatsapp);
  const connections = useQuery({
    queryKey: ["whatsapp-connections", trip.id], queryFn: () => getWhatsAppConnections(trip.id), retry: false,
    enabled: available && owner && !scoped,
  });
  const me = useMutation({ mutationFn: () => issueWhatsAppCode(trip.id, "me") });
  const group = useMutation({ mutationFn: () => issueWhatsAppCode(trip.id, "group") });
  const remove = useMutation({
    mutationFn: (bindingId: string) => removeWhatsAppConnection(trip.id, bindingId),
    onSuccess: async () => { setConfirming(null); await queryClient.invalidateQueries({ queryKey: ["whatsapp-connections", trip.id] }); },
  });
  if (!trip.whatsapp) return null;
  if (scoped) {
    return (
      <aside className="workflow-card" id="whatsapp">
        <h2>WhatsApp</h2>
        <p>Signed in with Telegram: to connect WhatsApp, sign in with your password.</p>
      </aside>
    );
  }
  const number = `+${trip.whatsapp.number}`;
  const list = connections.data ?? [];
  return (
    <aside className="workflow-card" id="whatsapp">
      <h2>WhatsApp</h2>
      <p>Talk to the trip's companion on WhatsApp.</p>

      <h3>Connect my WhatsApp</h3>
      <p className="subtle">Opens WhatsApp with a message already written. Press send from your own phone, and that chat is connected to this trip as you.</p>
      {!me.data && (
        <button type="button" className="button button-small" onClick={() => me.mutate()} disabled={me.isPending}>
          {me.isPending ? "Preparing…" : "Connect my WhatsApp"}
        </button>
      )}
      {me.data && (
        <div className="telegram-issued">
          <a className="button button-small" href={me.data.link} target="_blank" rel="noopener noreferrer">Open WhatsApp</a>
          <small>Works once, until {formatTime(me.data.expiresAt)}. Send it from your own phone and don't forward it.</small>
        </div>
      )}
      {me.isError && <div className="notice" role="alert">{me.error.message}</div>}

      {owner && (
        <>
          <h3>Add the companion to a group</h3>
          <p>Add <bdi dir="ltr">{number}</bdi> to your family's WhatsApp group. Once your own WhatsApp is connected, the group is connected to this trip at once.</p>
          <p className="subtle">If that did not work, or you want the group on another of your trips, add the number to the group first, then use the group code: WhatsApp opens its share screen with a coded message, and you pick the group and send.</p>
          {!group.data && (
            <button type="button" className="button button-small" onClick={() => group.mutate()} disabled={group.isPending}>
              {group.isPending ? "Preparing…" : "Make a group code"}
            </button>
          )}
          {group.data && (
            <div className="telegram-issued">
              <a className="button button-small" href={group.data.link} target="_blank" rel="noopener noreferrer">Choose the group in WhatsApp</a>
              <small>Works once, until {formatTime(group.data.expiresAt)}. Whoever sends it in the group connects that group, so send it yourself.</small>
            </div>
          )}
          {group.isError && <div className="notice" role="alert">{group.error.message}</div>}

          <h3>Connected chats</h3>
          {connections.isError && <div className="notice" role="alert">Could not load the connected chats.</div>}
          {!connections.isError && list.length === 0 && <p className="subtle">Nothing is connected yet.</p>}
          {list.length > 0 && (
            <ul className="invite-list">
              {list.map((entry) => (
                <li key={entry.bindingId}>
                  <div>
                    <strong>{entry.kind === "group" ? "Group" : "Person"}: {entry.name ? <bdi>{entry.name}</bdi> : "unnamed"}</strong>
                    <small>
                      {HOW[entry.via]} · {formatDay(entry.connectedAt)}
                      {entry.lastFour ? ` · number ending ${entry.lastFour}` : ""}
                    </small>
                  </div>
                  {confirming === entry.bindingId
                    ? <span>
                      <button type="button" className="text-button" onClick={() => remove.mutate(entry.bindingId)} disabled={remove.isPending}>Confirm remove</button>
                      <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep</button>
                    </span>
                    : <button type="button" className="text-button" aria-label={`Remove ${entry.kind === "group" ? "group" : "person"} ${entry.name ?? ""}`.trim()} onClick={() => setConfirming(entry.bindingId)}>Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {remove.isError && <div className="notice" role="alert">{remove.error.message}</div>}
          <p className="subtle">Removing a chat tells it nothing. Anyone still in the group can connect again by messaging the number.</p>
        </>
      )}
    </aside>
  );
}
