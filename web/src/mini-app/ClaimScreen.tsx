import { useRef, useState, type ReactNode } from "react";
import type { MiniAppTraveller } from "../api";
import { claimCopy, type MiniLang } from "./claim-copy";

/** Puts a name into a sentence, in its own direction (a Hebrew name in an English sentence, and the other way round). */
function withName(template: string, name: string) {
  const [before, after = ""] = template.split("{name}");
  return <>{before}<bdi dir="auto">{name}</bdi>{after}</>;
}

/**
 * "Which traveller are you?" — the group sign-in screen (docs/specs/sprint-9/x-member-sign-in.md, S1).
 *
 * Three steps and no shortcut between them: the list, an explicit "You are signing in as <name>", then the claim. A wrong
 * pick takes an organizer to undo, so tapping a name never claims it: only the confirm button does, and only one claim
 * can be in flight (a double tap is one request).
 *
 * The component decides nothing. The server says who is on the list and whether a pick is allowed; the parent sends the
 * claim and navigates on a session. An empty list is the answer "your name is not here": ask the organizer.
 * A claim id is passed to `onClaim` and never rendered.
 */
export function ClaimScreen({ lang, travellers, takenName, onClaim }: {
  lang: MiniLang;
  travellers: MiniAppTraveller[];
  /** The name somebody else signed in as while this person was choosing; the list below is the refreshed one. */
  takenName: string | null;
  /** Resolves "retry" when the claim could not be completed and may be tried again; anything else leaves this screen. */
  onClaim: (traveller: MiniAppTraveller) => Promise<"retry" | void>;
}) {
  const copy = claimCopy[lang];
  const [picked, setPicked] = useState<MiniAppTraveller | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);
  const inFlight = useRef(false);

  const confirm = async () => {
    if (!picked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRetry(false);
    try {
      if ((await onClaim(picked)) === "retry") setRetry(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const shell = (title: string, body: ReactNode) => (
    <main className="mini-app-unavailable" data-testid="mini-app-sign-in" lang={lang} dir={lang === "he" ? "rtl" : "ltr"}>
      <p className="eyebrow">Kinerary</p>
      <h1>{title}</h1>
      {body}
    </main>
  );

  if (travellers.length === 0) {
    return shell(copy.emptyTitle, <>
      {takenName && <p role="status">{withName(copy.taken, takenName)}</p>}
      <p>{copy.emptyBody}</p>
    </>);
  }

  if (picked) {
    return shell(copy.confirmTitle, <>
      <p role="status">{withName(copy.confirmLine, picked.name)}</p>
      <p className="subtle">{copy.confirmWarning}</p>
      {retry && <p className="notice" role="alert">{copy.retryNotice}</p>}
      <button className="button wide" disabled={busy} onClick={() => void confirm()}>
        {busy ? copy.working : retry ? copy.retryButton : copy.confirmButton}
      </button>
      <button className="button wide secondary" disabled={busy} onClick={() => { setPicked(null); setRetry(false); }}>{copy.backButton}</button>
    </>);
  }

  return shell(copy.pickTitle, <>
    {takenName && <p className="notice" role="status">{withName(copy.taken, takenName)}</p>}
    <p>{copy.pickBody}</p>
    <ul className="mini-app-trip-choices">
      {travellers.map((traveller) => (
        <li key={traveller.claimId}>
          {/* A name may be Hebrew inside an English page or the other way round: it reads in its own direction. */}
          <button className="button wide" onClick={() => setPicked(traveller)}><bdi dir="auto">{traveller.name}</bdi></button>
        </li>
      ))}
    </ul>
  </>);
}
