import { useState, type FormEvent } from "react";
import { requestSignInLink } from "../api";

type Lang = "en" | "he";

const copy: Record<Lang, {
  open: string; nameLabel: string; emailLabel: string; useEmail: string; useName: string; send: string; sending: string; done: string; intro: string;
}> = {
  en: {
    open: "Send me a sign-in link",
    intro: "We'll send a one-time link to the Telegram chat or the email address your account has, if it has one.",
    nameLabel: "Your name on this trip", emailLabel: "Your email",
    useEmail: "Use my email instead", useName: "Use my name on the trip instead",
    send: "Send the link", sending: "Sending…",
    // One sentence, whatever the server did: it must never say whether an account was found or why nothing came.
    done: "If we found your account, a link is on its way. It works once and expires in 30 minutes.",
  },
  he: {
    open: "שלחו לי קישור כניסה",
    intro: "נשלח קישור חד-פעמי לצ'אט בטלגרם או לכתובת האימייל של החשבון שלכם, אם יש כזה.",
    nameLabel: "השם שלכם בטיול", emailLabel: "האימייל שלכם",
    useEmail: "אפשר להשתמש באימייל", useName: "אפשר להשתמש בשם בטיול",
    send: "שליחת הקישור", sending: "שולחים…",
    done: "אם מצאנו את החשבון שלכם, קישור בדרך אליכם. הוא פועל פעם אחת ותקף ל-30 דקות.",
  },
};

/**
 * "Send me a sign-in link" (docs/specs/sprint-9/x-member-sign-in.md, S3, AC-14). It asks for a name on the trip the person is
 * signing in to (when the screen knows the trip) or an email, and shows ONE confirmation afterwards.
 *
 * THE CONFIRMATION IS NOT A REPORT. The server answers the same 202 whether or not an account was found, so this never reads
 * the answer: it does not look at the body, and a failure (a refusal, a rate limit, a network error) shows the same sentence.
 * A screen that said "couldn't send" for one case and "sent" for another would be the oracle the server took care not to be.
 */
export function SignInLinkRequest({ tripId, lang = "en" }: { tripId?: string | undefined; lang?: Lang }) {
  const words = copy[lang];
  const [open, setOpen] = useState(false);
  const [door, setDoor] = useState<"name" | "email">(tripId ? "name" : "email");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const dir = lang === "he" ? "rtl" : "ltr";

  if (done) return <p className="notice" role="status" lang={lang} dir={dir} data-testid="sign-in-link-done">{words.done}</p>;
  if (!open) {
    return <p className="form-links" lang={lang} dir={dir}><button type="button" className="text-button" onClick={() => setOpen(true)}>{words.open}</button></p>;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = value.trim();
    if (!typed) return;
    setPending(true);
    try {
      await requestSignInLink(door === "name" && tripId ? { tripId, travellerName: typed } : { email: typed, language: lang });
    } catch { /* shown the same on purpose: see above */ }
    setPending(false);
    setDone(true);
  };
  return (
    <form className="compact-form" onSubmit={submit} lang={lang} dir={dir}>
      <p className="subtle">{words.intro}</p>
      {door === "name" && tripId
        ? <label>{words.nameLabel}<input required maxLength={200} autoComplete="name" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        : <label>{words.emailLabel}<input required type="email" maxLength={254} autoComplete="email" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
      <button className="button wide" disabled={pending}>{pending ? words.sending : words.send}</button>
      {tripId && (
        <p className="form-links">
          <button type="button" className="text-button" onClick={() => { setDoor(door === "name" ? "email" : "name"); setValue(""); }}>
            {door === "name" ? words.useEmail : words.useName}
          </button>
        </p>
      )}
    </form>
  );
}
