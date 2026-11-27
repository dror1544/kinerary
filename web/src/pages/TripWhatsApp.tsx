import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMe, getWhatsAppConnections, issueWhatsAppCode, removeWhatsAppConnection, type TripSummary, type WhatsAppConnection,
} from "../api";
import { ServiceMark, ServiceStatusIcon, type MenuControl } from "./chat-service";
import { formatDay } from "./dates";
import { OneClickLink, useOneClickLink, worksOnce } from "./one-click-link";

const HOW: Record<WhatsAppConnection["via"], string> = {
  group_code: "with a group code",
  added_to_group: "by adding the number to the group",
  dashboard_code: "with a code from this page",
  group_membership: "by messaging from the group",
};

/**
 * What the viewer may do with WhatsApp on this trip. `trip.whatsapp` is present only when the deployment has a WhatsApp
 * number, the trip's switch is on and the viewer runs the trip on a full session; nothing here decides that, and a trip
 * with the switch off shows no trace of it. The connections are the trip OWNER's to read and to Remove (spec 625, AC-7), so
 * a co-organizer is never shown a "not linked" state: the page has no data to say it from.
 */
function useWhatsAppAccess(trip: TripSummary) {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const scoped = me.data?.scope === "telegram";
  const owner = Boolean(trip.whatsapp?.owner);
  const available = Boolean(trip.whatsapp);
  const connections = useQuery({
    queryKey: ["whatsapp-connections", trip.id], queryFn: () => getWhatsAppConnections(trip.id), retry: false,
    enabled: available && owner && me.isSuccess && !scoped,
  });
  // The code is made without being asked for, so "not yet known who is signed in" is "not offered" too.
  return { scoped, owner, available, connections, canLink: available && me.isSuccess && !scoped };
}

/**
 * Link WhatsApp: ONE link that opens WhatsApp on a chat with the deployment's number, the one-time code already written; the
 * person presses send from their own phone. The code is asked for when the action is on screen (`active`), kept until it
 * expires, and never shown as text or listed. Earlier codes stay valid on the server, but at most ten are live per trip and
 * the oldest is expired to make room, so a code is not made twice for the same view.
 */
function LinkWhatsApp({ trip, active, menu }: { trip: TripSummary; active: boolean; menu?: boolean }) {
  const offer = useOneClickLink({ limiter: "whatsapp", service: "whatsapp-me", id: [trip.id], enabled: active, mint: () => issueWhatsAppCode(trip.id, "me") });
  return (
    <OneClickLink
      offer={offer} label="Link WhatsApp" mark={<ServiceMark service="whatsapp" />} role={menu ? "menuitem" : undefined}
      className={menu ? "text-button chat-link chat-service-whatsapp" : "button button-small chat-link chat-service-whatsapp"}
      opened="WhatsApp opened. Press send there to finish."
      note={(expiresAt) => `${worksOnce(expiresAt)} Send it from your own phone and don't forward it.`}
    />
  );
}

/** Connected chats, for the trip's owner, each with Unlink (asks first; the owner chose the word Telegram uses, 2026-11-27; sends nothing to the chat, spec 625 AC-15). */
function WhatsAppEntries({ trip, onDone, menu }: { trip: TripSummary; onDone: () => void; menu?: boolean }) {
  const queryClient = useQueryClient();
  const { connections, owner, scoped } = useWhatsAppAccess(trip);
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (bindingId: string) => removeWhatsAppConnection(trip.id, bindingId),
    onSuccess: async () => { setConfirming(null); onDone(); await queryClient.invalidateQueries({ queryKey: ["whatsapp-connections", trip.id] }); },
  });
  if (!owner || scoped) return null;
  const list = connections.data ?? [];
  const itemRole = menu ? "menuitem" : undefined;
  return (
    <>
      {connections.isError && <div className="notice" role="alert">Could not load the connected chats.</div>}
      {list.map((entry) => {
        const what = entry.kind === "group" ? "Group" : "Person";
        return confirming === entry.bindingId
          ? <div key={entry.bindingId} className="telegram-confirm" role="group" aria-label="Confirm unlink">
            <small>Unlink this WhatsApp {entry.kind === "group" ? "group" : "chat"} (connected {formatDay(entry.connectedAt)})? Nothing is sent to it, and anyone still in the group can connect again by messaging the number.</small>
            <span>
              <button type="button" className="text-button" onClick={() => remove.mutate(entry.bindingId)} disabled={remove.isPending}>Confirm unlink</button>
              <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep</button>
            </span>
          </div>
          : <button key={entry.bindingId} type="button" role={itemRole} className="text-button whatsapp-unlink" onClick={() => { remove.reset(); setConfirming(entry.bindingId); }}>
            Unlink WhatsApp · linked {formatDay(entry.connectedAt)}
            <small>
              {what}: {entry.name ? <bdi>{entry.name}</bdi> : "unnamed"} · {HOW[entry.via]}{entry.lastFour ? ` · number ending ${entry.lastFour}` : ""}
            </small>
          </button>;
      })}
      {remove.isError && <div className="notice" role="alert">{remove.error.message}</div>}
    </>
  );
}

const linkedSentence = (count: number) => count > 0
  ? `${count === 1 ? "A WhatsApp chat is" : `${count} WhatsApp chats are`} linked to this trip.`
  : "No WhatsApp chat is linked to this trip.";

const LINK_NOTE = "Link WhatsApp opens WhatsApp with a message already written. Press send from your own phone, and that chat is connected to this trip as you.";

/**
 * The trip card's WhatsApp status and its ⋮ menu: the twin of the Telegram one beside it (TripTelegram.tsx), with the same
 * actions in the same words. Shown only when the server sent `trip.whatsapp`. The menu is where Link WhatsApp becomes
 * available, so it is where the code is asked for: once, on opening it, and not at all for the cards whose menu stays closed.
 */
export function TripWhatsAppMenu({ trip, menu }: { trip: TripSummary; menu?: MenuControl }) {
  const { scoped, owner, available, connections, canLink } = useWhatsAppAccess(trip);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = menu?.open ?? ownOpen;
  const setOpen = menu?.setOpen ?? setOwnOpen;
  const [confirmKey, setConfirmKey] = useState(0);
  if (!available || scoped) return null;
  const close = () => { setOpen(false); setConfirmKey((n) => n + 1); };
  // Only the owner can read the connections, so only the owner is told whether anything is linked.
  const known = owner && connections.data !== undefined;
  const count = connections.data?.length ?? 0;
  return (
    <div className="telegram-status chat-status" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <ServiceStatusIcon service="whatsapp" linked={known ? count > 0 : null} />
      <button
        type="button" className="text-button telegram-kebab" aria-haspopup="menu" aria-expanded={open}
        aria-label={`WhatsApp options for ${trip.title}`} onClick={() => (open ? close() : setOpen(true))}
      >⋮</button>
      {open && (
        <div className="telegram-menu chat-menu" role="menu" aria-label={`WhatsApp for ${trip.title}`}>
          {known && <p className="subtle telegram-state">{linkedSentence(count)}</p>}
          <small className="subtle">{LINK_NOTE}</small>
          {canLink && <LinkWhatsApp trip={trip} active={open} menu />}
          <WhatsAppEntries key={confirmKey} trip={trip} onDone={close} menu />
        </div>
      )}
    </div>
  );
}

/**
 * "WhatsApp" on the trip's page - connect the trip's companion to a private WhatsApp chat or to the family's group, and see
 * and remove what is connected (docs/specs/sprint-9/625-whatsapp-via-relay.md). The twin of the Telegram card beside it.
 *
 * Link WhatsApp is one link, ready when the page is shown: it opens WhatsApp on a chat with the deployment's number, the code
 * already written. The code is never shown as text and never listed. A group is bound by adding the number to it (the owner,
 * once connected) or by the group code: WhatsApp's share screen with the coded message, where the owner picks the group.
 * The group code is made only when the owner asks for that fallback: it is live for whoever sends it, and most owners never
 * need it. Only the trip's owner sees the group steps and the list. The list names groups by title and people by name with
 * the last four digits of their number when known, never more. Group titles and names are what people typed: shown as text,
 * never acted on.
 *
 * A Telegram-minted session cannot mint a way into the trip's chat, so it is told to sign in with its password.
 */
export function TripWhatsApp({ trip }: { trip: TripSummary }) {
  const { scoped, owner, available, connections, canLink } = useWhatsAppAccess(trip);
  const [groupCode, setGroupCode] = useState(false);
  const group = useOneClickLink({
    limiter: "whatsapp", service: "whatsapp-group", id: [trip.id], enabled: groupCode && owner && canLink, mint: () => issueWhatsAppCode(trip.id, "group"),
  });
  if (!trip.whatsapp || !available) return null;
  if (scoped) {
    return (
      <aside className="workflow-card chat-card chat-service-whatsapp-card" id="whatsapp">
        <h2><ServiceMark service="whatsapp" size={22} /> WhatsApp</h2>
        <p>Signed in with Telegram: to connect WhatsApp, sign in with your password.</p>
      </aside>
    );
  }
  const number = `+${trip.whatsapp.number}`;
  const count = connections.data?.length ?? 0;
  return (
    <aside className="workflow-card chat-card chat-service-whatsapp-card" id="whatsapp">
      <h2><ServiceMark service="whatsapp" size={22} /> WhatsApp</h2>
      <p>Talk to the trip's companion on WhatsApp.</p>
      {owner && connections.data !== undefined && <p className="subtle telegram-state">{linkedSentence(count)}</p>}
      <p className="subtle">{LINK_NOTE}</p>
      <LinkWhatsApp trip={trip} active={canLink} />

      {owner && (
        <>
          <h3>Add the companion to a group</h3>
          <p>Add <bdi dir="ltr">{number}</bdi> to your family's WhatsApp group. Once your own WhatsApp is connected, the group is connected to this trip at once.</p>
          {!groupCode && (
            <p className="subtle">
              If that did not work, or you want the group on another of your trips, add the number to the group first, then{" "}
              <button type="button" className="text-button" onClick={() => setGroupCode(true)}>use a group code</button>.
            </p>
          )}
          {groupCode && (
            <>
              <p className="subtle">Add the number to the group first, then use the group code: WhatsApp opens its share screen with a coded message, and you pick the group and send.</p>
              <OneClickLink
                offer={group} label="Choose the group in WhatsApp" mark={<ServiceMark service="whatsapp" />}
                className="button button-small chat-link chat-service-whatsapp"
                opened="WhatsApp opened. Pick the group and press send to finish."
                note={(expiresAt) => `${worksOnce(expiresAt)} Whoever sends it in the group connects that group, so send it yourself.`}
              />
            </>
          )}
          <div className="chat-entries">
            <WhatsAppEntries trip={trip} onDone={() => undefined} />
          </div>
          {connections.isSuccess && count === 0 && <p className="subtle">Nothing is connected yet.</p>}
          <p className="subtle">Unlinking a chat tells it nothing. Anyone still in the group can connect again by messaging the number.</p>
        </>
      )}
    </aside>
  );
}
