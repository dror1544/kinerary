// "Send a personal invite" — Organizer settings -> Signing in (docs/specs/sprint-9/x-member-sign-in.md, slice S2, AC-11): one
// traveller, one link, and a message to forward in Hebrew and in English. The traveller opens the link on the portal's own page and
// chooses Google or a password, then opens the trip AS THEMSELVES (the invite binds the participant that already exists).
//
// THE HOP. This page talks only to the trip site, and the trip site cannot call the control plane, so the link is made through the
// RUNTIME GATEWAY that serves this site (`<runtime base>/__member-invites`), which asks the control plane with the person's own
// sealed session. Nothing here is a boundary: the control plane decides, again, who is this trip's organizer, whether the traveller
// can be invited and what the link is. What this file owns is the opposite duty, of not offering what cannot work:
//
//   - the site opened on its own hostname (no `KITINERARY_RUNTIME_BASE`): no request is made and no button is drawn;
//   - the probe answers anything but `{ available: true }` (a person who is not this trip's organizer, no session, an outage, a
//     page instead of JSON): no button;
//   - this is NOT behind the group sign-in switch, so nothing here reads one: a personal invite is a full way in for people who are
//     not on Telegram.
//
// An invite id never reaches this file (the gateway does not pass it on). The link is shown to the organizer and nowhere else:
// not logged, not kept in the query cache, gone when the organizer sends another or leaves the page.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

type Lang = "en" | "he";
const copy = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

const PROBE_KEY = ["member-invites-available"] as const;
const createdSchema = z.object({ joinUrl: z.string().regex(/^https?:\/\/\S+$/), displayName: z.string(), expiresAt: z.string() });

/** The gateway path prefix of the trip this page is served under, or null when the site is not behind a gateway. */
function gatewayBase(): string | null {
  const base = (window as unknown as { KITINERARY_RUNTIME_BASE?: unknown }).KITINERARY_RUNTIME_BASE;
  return typeof base === "string" && /^\/t\/[^/]+$/.test(base) ? base : null;
}

async function probe(base: string): Promise<boolean> {
  const response = await fetch(`${base}/__member-invites`, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("unavailable");
  const body = (await response.json()) as { available?: unknown };
  if (body.available !== true) throw new Error("unavailable");
  return true;
}

export type InviteOutcome =
  | { username: string; kind: "link"; link: string; name: string; expiresAt: string }
  | { username: string; kind: "claimed" | "exists" | "not_eligible" | "not_found" | "not_ready" | "dashboard" | "failed"; name: string };

const NAMED: Record<string, Exclude<InviteOutcome["kind"], "link" | "dashboard" | "failed">> = {
  TRAVELLER_CLAIMED_FROM_GROUP: "claimed",
  INVITE_ALREADY_EXISTS: "exists",
  RUNTIME_PARTICIPANT_NOT_ELIGIBLE: "not_eligible",
  RUNTIME_PARTICIPANT_NOT_FOUND: "not_found",
  RUNTIME_NOT_READY: "not_ready",
};

async function createInvite(base: string, username: string, shownName: string): Promise<InviteOutcome> {
  try {
    const response = await fetch(`${base}/__member-invites/${encodeURIComponent(username)}`, {
      method: "POST", credentials: "same-origin",
      // The gateway refuses this without the header and this origin: a cross-site form can send neither.
      headers: { "x-kinerary-member-invites": "1", accept: "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (response.status === 201) {
      const made = createdSchema.parse(body);
      return { username, kind: "link", link: made.joinUrl, name: made.displayName, expiresAt: made.expiresAt };
    }
    if (response.status === 403 && body.error === "ACCOUNT_SIGN_IN_REQUIRED") return { username, kind: "dashboard", name: shownName };
    if (response.status === 409 && typeof body.error === "string" && body.error in NAMED) return { username, kind: NAMED[body.error]!, name: shownName };
    return { username, kind: "failed", name: shownName };
  } catch { return { username, kind: "failed", name: shownName }; }
}

/**
 * Whether the button may be drawn, and the click. One send at a time: a click already in flight is dropped (the ref, not only the
 * disabled attribute, is what holds, because two clicks can land before a re-render disables anything).
 */
export function usePersonalInvites() {
  const base = gatewayBase();
  const probed = useQuery({ queryKey: PROBE_KEY, queryFn: () => probe(base!), enabled: base !== null, retry: false, staleTime: 60_000 });
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null);
  const [pending, setPending] = useState("");
  const inFlight = useRef(false);
  const send = async (username: string, shownName: string) => {
    if (base === null || inFlight.current) return;
    inFlight.current = true;
    setPending(username);
    setOutcome(null);
    try { setOutcome(await createInvite(base, username, shownName)); }
    finally { inFlight.current = false; setPending(""); }
  };
  return { available: base !== null && probed.data === true, pending, outcome, send, clear: () => setOutcome(null) };
}

const when = (iso: string, lang: Lang) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(lang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
};

/** The two messages the organizer forwards: one in each language, whatever language this site is in. */
export function inviteMessages(name: string, link: string, expiresAt: string) {
  const en = when(expiresAt, "en"), he = when(expiresAt, "he");
  return {
    en: `Hi ${name}, this is your personal link to our trip. Open it and sign in with Google, or choose a password. It is only for you, so please do not forward it.${en ? ` It works until ${en}.` : ""}\n\n${link}`,
    he: `היי ${name}, זה הקישור האישי שלך לטיול שלנו. פתחו אותו והיכנסו עם Google, או בחרו סיסמה. הוא מיועד רק לך, אז בבקשה אל תעבירו אותו הלאה.${he ? ` הוא תקף עד ${he}.` : ""}\n\n${link}`,
  };
}

function MessageBox({ label, text, dir, lang }: { label: string; text: string; dir: "ltr" | "rtl"; lang: Lang }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copyIt = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { box.current?.select(); }
  };
  return (
    <div className="personal-invite-message">
      <span>{label}</span>
      <textarea ref={box} readOnly dir={dir} rows={5} aria-label={label} value={text} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="ghost" onClick={copyIt}>{copied ? copy(lang, "Copied", "הועתק") : copy(lang, "Copy", "העתקה")}</button>
    </div>
  );
}

/** What came back for one traveller: the link and both messages, or the reason there is no link. */
export function PersonalInviteResult({ outcome, lang }: { outcome: InviteOutcome; lang: Lang }) {
  if (outcome.kind === "link") {
    const messages = inviteMessages(outcome.name, outcome.link, outcome.expiresAt);
    return (
      <span className="member-login-result personal-invite-result">
        {copy(lang,
          "Send them this link — it works once, and it is not for the family group.",
          "שלחו להם את הקישור הזה — הוא חד-פעמי, ולא מיועד לקבוצה המשפחתית.")}
        <code>{outcome.link}</code>
        <MessageBox label="Message in English" text={messages.en} dir="ltr" lang={lang} />
        <MessageBox label="הודעה בעברית" text={messages.he} dir="rtl" lang={lang} />
      </span>
    );
  }
  const name = outcome.name;
  const text: Record<typeof outcome.kind, string> = {
    claimed: copy(lang, `Someone signed in as ${name} from the group — release that sign-in first.`, `מישהו נכנס בתור ${name} מהקבוצה — קודם צריך לבטל את הכניסה הזו.`),
    exists: copy(lang, `${name} already has a personal sign-in.`, `ל${name} כבר יש כניסה אישית.`),
    not_eligible: copy(lang, "Organizers do not need a personal invite.", "מארגנים לא צריכים הזמנה אישית."),
    not_found: copy(lang, `${name} is not on the trip site.`, `${name} לא מופיע באתר הטיול.`),
    not_ready: copy(lang, "The trip site did not answer. Try again in a moment.", "אתר הטיול לא ענה. נסו שוב בעוד רגע."),
    dashboard: copy(lang, "Open the dashboard to send a personal invite.", "כדי לשלוח הזמנה אישית, פתחו את לוח הבקרה."),
    failed: copy(lang, "That did not go through. Try again.", "זה לא עבר. נסו שוב."),
  };
  return <span className="member-login-result" role="alert">{text[outcome.kind]}</span>;
}

export const personalInviteLabel = (lang: Lang) => copy(lang, "Send a personal invite", "שליחת הזמנה אישית");
