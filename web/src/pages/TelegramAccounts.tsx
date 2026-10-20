import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getTelegramLinks, unlinkTelegramLink, type TelegramLink } from "../api";

const HOW: Record<TelegramLink["via"], string> = {
  interview_link: "by redeeming your interview link in Telegram",
  earlier_interview: "from an interview you did earlier in Telegram",
  trip_password: "with the trip password inside the Mini App",
  invite: "with a site invitation inside the Mini App",
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * "Telegram accounts that can sign in as you."
 *
 * A Telegram link is a way IN: whoever holds the linked Telegram account opens
 * the Mini App as this person, with no password. Most are the person's own phone
 * — but a forwarded interview link makes one that is not, and nothing else would
 * ever show it. So the list is here, on the page every signed-in person sees,
 * with a way to end each one (which also ends the sessions it already opened).
 *
 * What it can show is deliberately small: when, how, which trip, last use. It
 * never shows who the other party is, because the server does not know their
 * name and will not hand out their id (or a piece of it).
 */
export function TelegramAccounts() {
  const queryClient = useQueryClient();
  const links = useQuery({ queryKey: ["telegram-links"], queryFn: getTelegramLinks, retry: false });
  const [confirming, setConfirming] = useState<string | null>(null);
  const unlink = useMutation({
    mutationFn: unlinkTelegramLink,
    onSuccess: () => { setConfirming(null); return queryClient.invalidateQueries({ queryKey: ["telegram-links"] }); },
  });
  if (!links.data) return null;
  // Nothing linked and the feature off: nothing to say.
  if (links.data.links.length === 0 && !links.data.miniAppEnabled) return null;
  return (
    <section className="trip-section" aria-labelledby="telegram-accounts-heading">
      <h2 id="telegram-accounts-heading">Telegram accounts that can sign in as you</h2>
      <p className="subtle">These Telegram accounts open Kinerary's Mini App as you without a password. Remove any you don't recognise.</p>
      {links.data.links.length === 0
        ? <p>No Telegram account can sign in as you.</p>
        : <ul className="invite-list">
          {links.data.links.map((link) => (
            <li key={link.id}>
              <div>
                <strong>{link.scope === "trip" ? `Opens ${link.tripTitle ?? "one trip"} only` : "Opens all of your trips"}</strong>
                <small>
                  Linked on {day(link.linkedAt)} {HOW[link.via]}.{" "}
                  {link.lastSignedInAt ? `Last signed in ${day(link.lastSignedInAt)}.` : "Has not signed in with it yet."}
                </small>
              </div>
              {confirming === link.id
                ? <span>
                  <button className="text-button" onClick={() => unlink.mutate(link.id)} disabled={unlink.isPending}>Confirm unlink</button>
                  <button className="text-button" onClick={() => setConfirming(null)}>Keep</button>
                </span>
                : <button className="text-button" onClick={() => setConfirming(link.id)}>Unlink</button>}
            </li>
          ))}
        </ul>}
      {unlink.isError && <div className="notice" role="alert">{unlink.error.message}</div>}
    </section>
  );
}
