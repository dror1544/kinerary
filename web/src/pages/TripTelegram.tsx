import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  getMe, getTelegramGroups, issueTelegramGroupLink, issueTelegramLink, removeTelegramGroup, restoreTelegramLink, unlinkTelegramLink,
  type TelegramLinkVia, type TripSummary,
} from "../api";
import { ServiceMark, ServiceStatusIcon, type MenuControl } from "./chat-service";
import { formatDay } from "./dates";
import { OneClickLink, useOneClickLink, worksOnce } from "./one-click-link";

const HOW: Record<TelegramLinkVia, string> = {
  interview_link: "via the trip's interview link",
  earlier_interview: "from an earlier interview",
  dashboard_link: "with a link from this page",
  dashboard_restore: "restored from this page",
  trip_password: "with the trip password",
  invite: "with a site invitation",
};

/**
 * Who a Telegram link is, as far as the server may say: the first name, then the @username in a style of its
 * own. They are separate fields on purpose - a first name can say anything, including someone else's @handle
 * (the server strips '@' from it) - and only the second is a handle. Each sits in <bdi> so a right-to-left
 * name cannot reorder the text around it. Display only; nothing acts on it. With neither: "Telegram account".
 */
function Who({ name, username, none = "Telegram account" }: { name?: string; username?: string; none?: string }) {
  if (!name && !username) return <>{none}</>;
  return (
    <>
      {name && <bdi className="telegram-name">{name}</bdi>}
      {name && username && " "}
      {username && <bdi className="telegram-handle">@{username}</bdi>}
    </>
  );
}

/** What the viewer may do with Telegram on this trip, read once for the card's menu and the trip page's card alike. */
function useTelegramAccess(trip: TripSummary) {
  const organizerSide = trip.permissions.dashboard && ["owner", "organizer"].includes(trip.permissions.role);
  // A session a Telegram link minted cannot mint another way in: the server answers 403, so it is not offered. The link is
  // made without being asked for, so "not yet known who is signed in" is "not offered" too, never a request that gets refused.
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const scoped = me.data?.scope === "telegram";
  return { organizerSide, scoped, canLink: organizerSide && me.isSuccess && !scoped };
}

/**
 * Link Telegram: ONE link, already holding the one-time code, for the account that opens it in Telegram (the way to add an
 * account that was never linked; an interview link someone forwarded does not undo an Unlink, and Restore is for the account
 * you Unlinked). `active` says the action is on screen: that is when the code is asked for, and not before (one-click-link.tsx).
 * A new Telegram link revokes the one before it, so a second tab asking replaces the first tab's link: the one most recently
 * made is the one that works.
 */
function LinkTelegram({ trip, active, menu }: { trip: TripSummary; active: boolean; menu?: boolean }) {
  const offer = useOneClickLink({ limiter: "telegram", service: "telegram", id: [trip.id], enabled: active, mint: () => issueTelegramLink(trip.id).then((issued) => ({ link: issued.deepLink, expiresAt: issued.expiresAt })) });
  return (
    <OneClickLink
      offer={offer} label="Link Telegram" mark={<ServiceMark service="telegram" />} role={menu ? "menuitem" : undefined}
      className={menu ? "text-button chat-link chat-service-telegram" : "button button-small chat-link chat-service-telegram"}
      opened="Telegram opened. Press Start there to finish."
      note={(expiresAt) => `${worksOnce(expiresAt)} Open it in the Telegram account you want as your main one. It will run all your trips, now and later, and replaces the main Telegram account you had.`}
    />
  );
}

/**
 * The accounts that can be taken back or let go, with the same two steps for both: ask first, then one request.
 *
 * Restore brings back an account the owner Unlinked, in one click and with no Telegram round trip: it is the same Telegram
 * account, so nothing needs proving in Telegram again. It is a way in, so like Link it is for a password or Google session
 * only - the server answers 403 to a Telegram-minted one and never sends it the list. A restored account signs in fresh;
 * nothing it had open before comes back.
 *
 * Unlink lists each linked Telegram account by WHEN and HOW it was linked, and by the name Telegram gave when the server may
 * say it: the list is for recognising your own phone and spotting the one you did not make.
 */
function TelegramEntries({ trip, canLink, onDone, menu }: { trip: TripSummary; canLink: boolean; onDone: () => void; menu?: boolean }) {
  const queryClient = useQueryClient();
  const links = trip.telegram?.links ?? [];
  const unlinked = trip.telegram?.unlinked ?? [];
  const [confirming, setConfirming] = useState<string | null>(null);
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["trips"] }),
    queryClient.invalidateQueries({ queryKey: ["trip", trip.id] }),
  ]);
  const restore = useMutation({
    mutationFn: restoreTelegramLink,
    onSuccess: async () => { setConfirming(null); onDone(); await refresh(); },
  });
  const unlink = useMutation({
    mutationFn: unlinkTelegramLink,
    onSuccess: async () => { setConfirming(null); onDone(); await refresh(); },
  });
  const itemRole = menu ? "menuitem" : undefined;
  return (
    <>
      {/* Restore: it asks first - the label (first name, @username) is how the owner recognises the account. The server hands
          the list only to a full session; canLink repeats that here so the button is never a dead end. The label is text
          Telegram's user chose: shown, never acted on. */}
      {canLink && unlinked.map((entry) => (
        confirming === entry.id
          ? <div key={entry.id} className="telegram-confirm" role="group" aria-label="Confirm restore">
            <small>Restore Telegram access for <Who name={entry.name} username={entry.username} none="this Telegram account" />? It will open this trip again, and sign in fresh.</small>
            <span>
              <button type="button" className="text-button" onClick={() => restore.mutate(entry.id)} disabled={restore.isPending}>Confirm restore</button>
              <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep unlinked</button>
            </span>
          </div>
          : <button key={entry.id} type="button" role={itemRole} className="text-button telegram-restore" onClick={() => { restore.reset(); setConfirming(entry.id); }}>
            Restore Telegram · unlinked {formatDay(entry.unlinkedAt)}
            <small><Who name={entry.name} username={entry.username} /> · was linked {formatDay(entry.linkedAt)}, {HOW[entry.via]}</small>
          </button>
      ))}
      {links.map((entry) => (
        confirming === entry.id
          ? <div key={entry.id} className="telegram-confirm" role="group" aria-label="Confirm unlink">
            <small>Unlink this Telegram account (linked {formatDay(entry.linkedAt)})? It will stop opening this trip, and it will disappear from the bot's trip list.</small>
            <span>
              <button type="button" className="text-button" onClick={() => unlink.mutate(entry.id)} disabled={unlink.isPending}>Confirm unlink</button>
              <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep</button>
            </span>
          </div>
          : <button key={entry.id} type="button" role={itemRole} className="text-button telegram-unlink" onClick={() => setConfirming(entry.id)}>
            Unlink Telegram · linked {formatDay(entry.linkedAt)}
            <small>{entry.name || entry.username ? <><Who name={entry.name} username={entry.username} />{" · "}</> : null}{HOW[entry.via]}{entry.lastSignedInAt ? ` · last opened ${formatDay(entry.lastSignedInAt)}` : " · not opened yet"}</small>
          </button>
      ))}
      {unlink.isError && <div className="notice" role="alert">{unlink.error.message}</div>}
      {restore.isError && <div className="notice" role="alert">{restore.error.message}</div>}
    </>
  );
}

/**
 * Telegram groups (#690, docs/specs/sprint-9/690-dashboard-chat-parity.md): the twin of the WhatsApp group steps. They are the trip
 * OWNER's, on a full session: `trip.telegram.groups.owner` says so (the server sends it to an organizer on a full session only),
 * and a co-organizer is given no list and so no "none yet". The group link can only work for a Telegram account that is linked to
 * this trip (the redemption checks the sender), so without one the page says "Link Telegram first" and asks for no link.
 */
function useTelegramGroups(trip: TripSummary, canLink: boolean, active = true) {
  const owner = canLink && Boolean(trip.telegram?.groups?.owner);
  const linked = (trip.telegram?.links.length ?? 0) > 0;
  // `active` is "the list is on screen": a closed menu on the dashboard reads no list, however many trips the page has.
  const groups = useQuery({ queryKey: ["telegram-groups", trip.id], queryFn: () => getTelegramGroups(trip.id), retry: false, enabled: owner && active });
  return { owner, linked, groups, canAdd: owner && linked };
}

/**
 * Add the companion to a Telegram group: ONE link, already holding its one-time code. Telegram asks which group, adds the bot as
 * an admin and posts the code there from the person who added it; the binding is made only when that person is this trip's linked
 * main organizer. Asked for when the action is on screen (`active`), kept until it expires, never shown as text.
 */
function AddTelegramGroup({ trip, active, menu }: { trip: TripSummary; active: boolean; menu?: boolean }) {
  const offer = useOneClickLink({
    limiter: "telegram-group", service: "telegram-group", id: [trip.id], enabled: active,
    mint: () => issueTelegramGroupLink(trip.id),
  });
  return (
    <OneClickLink
      offer={offer} label="Add to a Telegram group" mark={<ServiceMark service="telegram" />} role={menu ? "menuitem" : undefined}
      className={menu ? "text-button chat-link chat-service-telegram" : "button button-small chat-link chat-service-telegram"}
      opened="Telegram opened. Pick the group there and approve the companion's admin rights."
      note={(expiresAt) => `${worksOnce(expiresAt)} Open it in the Telegram account linked to this trip: from any other account the group is not connected.`}
    />
  );
}

/** The linked groups, each with Unlink: it asks first, closes the link, and sends nothing to the group (spec 690). Names are what people typed: text, never markup. */
function TelegramGroupEntries({ trip, canLink, onDone, menu }: { trip: TripSummary; canLink: boolean; onDone: () => void; menu?: boolean }) {
  const queryClient = useQueryClient();
  const { owner, groups } = useTelegramGroups(trip, canLink);
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (bindingId: string) => removeTelegramGroup(trip.id, bindingId),
    onSuccess: async () => { setConfirming(null); onDone(); await queryClient.invalidateQueries({ queryKey: ["telegram-groups", trip.id] }); },
  });
  if (!owner) return null;
  const itemRole = menu ? "menuitem" : undefined;
  return (
    <>
      {groups.isError && <div className="notice" role="alert">Could not load the linked groups.</div>}
      {(groups.data ?? []).map((entry) => (
        confirming === entry.bindingId
          ? <div key={entry.bindingId} className="telegram-confirm" role="group" aria-label="Confirm unlink">
            <small>Unlink this Telegram group (linked {formatDay(entry.connectedAt)})? The companion leaves the group quietly and posts nothing there. You can add it again from this page.</small>
            <span>
              <button type="button" className="text-button" onClick={() => remove.mutate(entry.bindingId)} disabled={remove.isPending}>Confirm unlink</button>
              <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep</button>
            </span>
          </div>
          : <button key={entry.bindingId} type="button" role={itemRole} className="text-button telegram-unlink telegram-group-unlink" onClick={() => { remove.reset(); setConfirming(entry.bindingId); }}>
            Unlink Telegram group · linked {formatDay(entry.connectedAt)}
            <small>Group: {entry.name ? <bdi>{entry.name}</bdi> : "unnamed group"}</small>
          </button>
      ))}
      {remove.isError && <div className="notice" role="alert">{remove.error.message}</div>}
    </>
  );
}

const linkedSentence = (count: number) => count > 0
  ? `${count === 1 ? "A Telegram account is" : `${count} Telegram accounts are`} linked to this trip.`
  : "No Telegram account is linked to this trip.";

const MAIN_ACCOUNT_NOTE = "Link Telegram sets your main Telegram account for all your trips. To add someone who helps organize just this trip, use \"Other organizers\" on the trip's page.";

/**
 * The trip card's Telegram status and its ⋮ menu.
 *
 * A Telegram link is PER TRIP: the account that is linked can open THIS trip in the bot (/trips, /switch) and in the Mini
 * App without a password, and nothing else of the organizer's. So the status and the menu live on the card they describe,
 * and Unlinking one trip leaves the others as they were. A member sees the same card state and can end their own link, but
 * only an organizer is offered Link.
 *
 * The menu is where Link Telegram becomes available, so it is where the link is made: opening it asks for ONE code, which
 * stays until it expires; nothing is asked for while the menu is closed, however many cards the page has.
 */
export function TripTelegram({ trip, menu }: { trip: TripSummary; menu?: MenuControl }) {
  const links = trip.telegram?.links ?? [];
  const { organizerSide, scoped, canLink } = useTelegramAccess(trip);
  const groupAccess = useTelegramGroups(trip, canLink, false);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = menu?.open ?? ownOpen;
  const setOpen = menu?.setOpen ?? setOwnOpen;
  const [confirmKey, setConfirmKey] = useState(0);
  if (!organizerSide && links.length === 0) return null;
  const linked = links.length > 0;
  const close = () => { setOpen(false); setConfirmKey((n) => n + 1); };
  return (
    <div className="telegram-status chat-status" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <ServiceStatusIcon service="telegram" linked={linked} />
      <button
        type="button" className="text-button telegram-kebab" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Telegram options for ${trip.title}`} onClick={() => (open ? close() : setOpen(true))}
      >⋮</button>
      {open && (
        <div className="telegram-menu chat-menu" role="menu" aria-label={`Telegram for ${trip.title}`}>
          <p className="subtle telegram-state">{linkedSentence(links.length)}</p>
          {organizerSide && scoped && <small>Signed in with Telegram: to link another Telegram account, sign in with your password.</small>}
          {canLink && <small className="subtle">{MAIN_ACCOUNT_NOTE}</small>}
          {canLink && <LinkTelegram trip={trip} active={open} menu />}
          {groupAccess.canAdd && <AddTelegramGroup trip={trip} active={open} menu />}
          {groupAccess.owner && !groupAccess.linked && <small className="subtle">Link Telegram first, then add the companion to a group from your own Telegram.</small>}
          <TelegramEntries key={confirmKey} trip={trip} canLink={canLink} onDone={close} menu />
          <TelegramGroupEntries key={`groups-${confirmKey}`} trip={trip} canLink={canLink} onDone={close} menu />
        </div>
      )}
    </div>
  );
}

/**
 * The same thing on the trip's own page, where the action is available from the moment the page is shown: Link Telegram is
 * one link already holding its code, beside the accounts that can be Unlinked or Restored. It is the twin of the WhatsApp
 * card next to it (TripWhatsApp.tsx), with the same actions in the same words.
 */
export function TripTelegramCard({ trip }: { trip: TripSummary }) {
  const links = trip.telegram?.links ?? [];
  const { organizerSide, scoped, canLink } = useTelegramAccess(trip);
  const groupAccess = useTelegramGroups(trip, canLink);
  if (!organizerSide && links.length === 0) return null;
  const groupCount = groupAccess.groups.data?.length ?? 0;
  return (
    <aside className="workflow-card chat-card chat-service-telegram-card" id="telegram">
      <h2><ServiceMark service="telegram" size={22} /> Telegram</h2>
      <p>Talk to the trip's companion on Telegram.</p>
      <p className="subtle telegram-state">{linkedSentence(links.length)}</p>
      {organizerSide && scoped && <p>Signed in with Telegram: to link another Telegram account, sign in with your password.</p>}
      {canLink && <p className="subtle">{MAIN_ACCOUNT_NOTE}</p>}
      {canLink && <LinkTelegram trip={trip} active />}
      <div className="chat-entries">
        <TelegramEntries trip={trip} canLink={canLink} onDone={() => undefined} />
      </div>

      {groupAccess.owner && (
        <>
          <h3>Add the companion to a group</h3>
          {groupAccess.linked
            ? <>
              <p>Add the companion to your family's Telegram group in one step: Telegram asks which group and adds it as an admin, so it can pin the trip button.</p>
              <AddTelegramGroup trip={trip} active />
            </>
            : <p>Link Telegram first, then add the companion to a group from your own Telegram.</p>}
          <div className="chat-entries">
            <TelegramGroupEntries trip={trip} canLink={canLink} onDone={() => undefined} />
          </div>
          {groupAccess.groups.isSuccess && groupCount === 0 && <p className="subtle">No group is linked yet.</p>}
          <p className="subtle">Unlinking a group makes the companion leave it quietly: nothing is posted there.</p>
        </>
      )}
    </aside>
  );
}
