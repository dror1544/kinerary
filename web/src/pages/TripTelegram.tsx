import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { getMe, issueTelegramLink, restoreTelegramLink, unlinkTelegramLink, type TelegramLinkVia, type TripSummary } from "../api";
import { formatDay, formatTime } from "./dates";

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

/**
 * The trip card's Telegram status and its ⋮ menu.
 *
 * A Telegram link is PER TRIP: the account that is linked can open THIS trip in
 * the bot (/trips, /switch) and in the Mini App without a password, and nothing
 * else of the organizer's. So the status and the menu live on the card they
 * describe, and Unlinking one trip leaves the others as they were.
 *
 * Link produces a one-time link for the account that opens it in Telegram (the
 * way to add an account that was never linked; an interview link someone
 * forwarded does not undo an Unlink, and Restore, below, is for the account you
 * Unlinked). Unlink lists each linked Telegram account by WHEN and HOW it was
 * linked — never who: the server does not know a name and will not hand out an
 * id, so the list is for recognising your own phone and spotting the one you
 * did not make. A member sees the same card state and can end their own link,
 * but only an organizer is offered Link.
 *
 * Restore brings back an account the owner Unlinked, in one click and with no
 * Telegram round trip: it is the same Telegram account, so nothing needs
 * proving in Telegram again. It is a way in, so like Link it is for a password
 * or Google session only - the server answers 403 to a Telegram-minted one and
 * never sends it the list. A restored account signs in fresh; nothing it had
 * open before comes back.
 */
export function TripTelegram({ trip }: { trip: TripSummary }) {
  const queryClient = useQueryClient();
  const links = trip.telegram?.links ?? [];
  const unlinked = trip.telegram?.unlinked ?? [];
  const organizerSide = trip.permissions.dashboard && ["owner", "organizer"].includes(trip.permissions.role);
  // A session a Telegram link minted cannot mint another way in: the server answers 403, so it is not offered.
  const scoped = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false }).data?.scope === "telegram";
  const canLink = organizerSide && !scoped;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["trips"] }),
    queryClient.invalidateQueries({ queryKey: ["trip", trip.id] }),
  ]);
  const link = useMutation({ mutationFn: () => issueTelegramLink(trip.id) });
  const restore = useMutation({
    mutationFn: restoreTelegramLink,
    onSuccess: async () => { setConfirming(null); setOpen(false); link.reset(); await refresh(); },
  });
  const unlink = useMutation({
    mutationFn: unlinkTelegramLink,
    onSuccess: async () => { setConfirming(null); setOpen(false); link.reset(); await refresh(); },
  });
  if (!organizerSide && links.length === 0) return null;
  const linked = links.length > 0;
  const state = linked ? "linked" : "not linked";
  return (
    <div className="telegram-status" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setConfirming(null); } }}>
      <span className={linked ? "telegram-icon linked" : "telegram-icon"} role="img" aria-label={`Telegram ${state}`} title={`Telegram ${state}`}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M21.5 3.5 2.7 10.8c-.8.3-.8 1.4 0 1.7l4.6 1.7 1.8 5.5c.2.7 1.1.9 1.6.4l2.6-2.6 4.6 3.4c.6.4 1.4.1 1.6-.6l3.2-15.6c.2-.8-.6-1.4-1.3-1.1Z" />
          {!linked && <path d="M3 3l18 18" stroke="#fff" strokeWidth="5" strokeLinecap="round" />}
          {!linked && <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
        </svg>
      </span>
      <button
        type="button" className="text-button telegram-kebab" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Telegram options for ${trip.title}`} onClick={() => { if (open) { link.reset(); setConfirming(null); } setOpen(!open); }}
      >⋮</button>
      {open && (
        <div className="telegram-menu" role="menu" aria-label={`Telegram for ${trip.title}`}>
          <p className="subtle telegram-state">{linked ? `${links.length === 1 ? "A Telegram account is" : `${links.length} Telegram accounts are`} linked to this trip.` : "No Telegram account is linked to this trip."}</p>
          {organizerSide && scoped && <small>Signed in with Telegram: to link another Telegram account, sign in with your password.</small>}
          {canLink && !link.data && (
            <button type="button" role="menuitem" className="text-button" onClick={() => link.mutate()} disabled={link.isPending}>
              {link.isPending ? "Preparing link…" : linked ? "Link another Telegram" : "Link Telegram"}
            </button>
          )}
          {link.data && (
            <div className="telegram-issued">
              <a className="button button-small" href={link.data.deepLink} target="_blank" rel="noopener noreferrer">Open in Telegram</a>
              <small>Works once, until {formatTime(link.data.expiresAt)}. Open it in the Telegram account you want to link to this trip.</small>
            </div>
          )}
          {/* Restore: no Telegram round trip, but it asks first - the label (first name, @username) is how the owner
              recognises the account. The server hands the list only to a full session; canLink repeats that here so
              the button is never a dead end. The label is text Telegram's user chose: shown, never acted on. */}
          {canLink && unlinked.map((entry) => (
            confirming === entry.id
              ? <div key={entry.id} className="telegram-confirm" role="group" aria-label="Confirm restore">
                <small>Restore Telegram access for <Who name={entry.name} username={entry.username} none="this Telegram account" />? It will open this trip again, and sign in fresh.</small>
                <span>
                  <button type="button" className="text-button" onClick={() => restore.mutate(entry.id)} disabled={restore.isPending}>Confirm restore</button>
                  <button type="button" className="text-button" onClick={() => setConfirming(null)}>Keep unlinked</button>
                </span>
              </div>
              : <button key={entry.id} type="button" role="menuitem" className="text-button telegram-restore" onClick={() => { restore.reset(); setConfirming(entry.id); }}>
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
              : <button key={entry.id} type="button" role="menuitem" className="text-button telegram-unlink" onClick={() => setConfirming(entry.id)}>
                Unlink Telegram · linked {formatDay(entry.linkedAt)}
                <small>{entry.name || entry.username ? <><Who name={entry.name} username={entry.username} />{" · "}</> : null}{HOW[entry.via]}{entry.lastSignedInAt ? ` · last opened ${formatDay(entry.lastSignedInAt)}` : " · not opened yet"}</small>
              </button>
          ))}
          {link.isError && <div className="notice" role="alert">{link.error.message}</div>}
          {unlink.isError && <div className="notice" role="alert">{unlink.error.message}</div>}
          {restore.isError && <div className="notice" role="alert">{restore.error.message}</div>}
        </div>
      )}
    </div>
  );
}
