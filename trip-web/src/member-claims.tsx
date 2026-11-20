// "Signed in from the Telegram group" — Organizer settings -> Signing in (docs/specs/sprint-9/x-member-sign-in.md, AC-7 and
// amendment A5): who picked a name from the trip's Telegram group, and a Release for a wrong pick.
//
// THE HOP. This page talks only to the trip site, and the trip site cannot call the control plane, so the list and Release go
// through the RUNTIME GATEWAY that serves this site (`<runtime base>/__member-claims`), which asks the control plane with the
// person's own sealed session. Nothing here is a boundary: the control plane decides, again, who is this trip's organizer and
// whether the feature is on. What this file owns is the opposite duty, of not talking about a feature that may not exist:
//
//   - the site opened on its own hostname (no `KITINERARY_RUNTIME_BASE`): no request is made and nothing is drawn;
//   - the route answers anything but a well-formed list (not-found for a feature that is off or a person who is not an
//     organizer, 401, an outage, a page instead of JSON): nothing is drawn;
//   - an empty list: nothing is drawn. The name of an unreleased feature is itself withheld.
//
// Ids (`claimId`) exist only to name the claim in the Release request. They are never on the page.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

type Lang = "en" | "he";
const copy = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

const claimSchema = z.object({
  claimId: z.string().regex(/^tpc_[A-Za-z0-9]{8,64}$/),
  travellerName: z.string(),
  telegramFirstName: z.string().nullable(),
  telegramUsername: z.string().nullable(),
  claimedAt: z.string().nullable(),
});
type Claim = z.infer<typeof claimSchema>;
const listSchema = z.object({ claims: z.array(claimSchema) });

const CLAIMS_KEY = ["member-claims"] as const;

/** The gateway path prefix of the trip this page is served under, or null when the site is not behind a gateway. */
function gatewayBase(): string | null {
  const base = (window as unknown as { KITINERARY_RUNTIME_BASE?: unknown }).KITINERARY_RUNTIME_BASE;
  return typeof base === "string" && /^\/t\/[^/]+$/.test(base) ? base : null;
}

async function fetchClaims(base: string): Promise<Claim[]> {
  const response = await fetch(`${base}/__member-claims`, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("unavailable");
  return listSchema.parse(await response.json()).claims;
}

type ReleaseResult = "released" | "gone" | "dashboard" | "failed";
async function releaseClaim(base: string, claimId: string): Promise<ReleaseResult> {
  try {
    const response = await fetch(`${base}/__member-claims/${encodeURIComponent(claimId)}`, {
      method: "DELETE", credentials: "same-origin",
      // The gateway refuses a Release without this header and this origin: a cross-site form can send neither.
      headers: { "x-kinerary-member-claims": "1", accept: "application/json" },
    });
    if (response.ok) return "released";
    if (response.status === 404) return "gone";
    if (response.status === 403 && (await response.json().catch(() => ({})) as { error?: unknown }).error === "ACCOUNT_SIGN_IN_REQUIRED") return "dashboard";
    return "failed";
  } catch { return "failed"; }
}

type Note = { kind: "released"; name: string } | { kind: "dashboard" } | { kind: "failed" };

export function MemberClaims({ lang }: { lang: Lang }) {
  const base = gatewayBase();
  const queryClient = useQueryClient();
  const claims = useQuery({ queryKey: CLAIMS_KEY, queryFn: () => fetchClaims(base!), enabled: base !== null, retry: false, staleTime: 30_000 });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const inFlight = useRef(false);
  const release = useMutation({
    mutationFn: (claim: Claim) => releaseClaim(base!, claim.claimId),
    onSuccess: (result, claim) => {
      setConfirming(null);
      if (result === "released" || result === "gone") {
        queryClient.setQueryData<Claim[]>(CLAIMS_KEY, (list) => (list ?? []).filter((row) => row.claimId !== claim.claimId));
        setNote(result === "released" ? { kind: "released", name: claim.travellerName } : null);
      } else setNote({ kind: result });
    },
  });

  const rows = claims.data ?? [];
  if (base === null || (rows.length === 0 && !note)) return null;

  const confirmRelease = (claim: Claim) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNote(null);
    release.mutate(claim, { onSettled: () => { inFlight.current = false; } });
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(lang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

  return (
    <div className="member-claims">
      <h4>{copy(lang, "Signed in from the Telegram group", "נכנסו מקבוצת הטלגרם")}</h4>
      <p>{copy(lang,
        "These people picked their own name after opening the trip from the group. If someone picked the wrong name, release it and they can choose again.",
        "אלה אנשים שבחרו את השם שלהם אחרי שפתחו את הטיול מהקבוצה. אם מישהו בחר שם לא נכון, בטלו את הכניסה והוא יוכל לבחור שוב.")}</p>
      {note?.kind === "released" ? (
        <p role="status">{copy(lang, `Released. The name ${note.name} can be picked again.`, `בוצע. אפשר לבחור שוב בשם ${note.name}.`)}</p>
      ) : null}
      {note?.kind === "dashboard" ? (
        <p role="alert">{copy(lang, "Open the dashboard to release this sign-in.", "כדי לבטל כניסה זו, פתחו את לוח הבקרה.")}</p>
      ) : null}
      {note?.kind === "failed" ? (
        <p role="alert">{copy(lang, "That did not go through. Try again.", "זה לא עבר. נסו שוב.")}</p>
      ) : null}
      {rows.length > 0 ? (
        <ul>
          {rows.map((claim) => {
            const who = [claim.telegramFirstName, claim.telegramUsername ? `@${claim.telegramUsername}` : null, when(claim.claimedAt)].filter(Boolean).join(" · ");
            const asking = confirming === claim.claimId;
            return (
              <li key={claim.claimId}>
                <span><strong>{claim.travellerName}</strong> <small>{who}</small></span>
                {asking ? (
                  <span className="member-login-result">
                    {copy(lang,
                      `${claim.telegramFirstName ?? "This person"} will be signed out, and the name can be picked again.`,
                      `${claim.telegramFirstName ?? "האדם הזה"} ינותק, ואפשר יהיה לבחור שוב בשם.`)}
                  </span>
                ) : null}
                <span className="member-login-actions">
                  {asking ? (
                    <>
                      <button type="button" disabled={release.isPending} onClick={() => confirmRelease(claim)}>{copy(lang, "Yes, release", "כן, בטלו")}</button>
                      <button type="button" className="ghost" disabled={release.isPending} onClick={() => setConfirming(null)}>{copy(lang, "Cancel", "ביטול")}</button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => { setNote(null); setConfirming(claim.claimId); }}>{copy(lang, "Release", "ביטול כניסה")}</button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
