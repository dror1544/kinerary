// "Also make it the Telegram group photo" — the organizer's request to have the trip's bot set the Telegram group's
// photo from the trip logo (docs/specs/sprint-9/x-trip-group-photo.md).
//
// It is an OFFER, never a side effect: nothing is requested until the organizer presses the button. It sits under the trip
// logo row of Organizer settings, which only an organizer reaches and which draws it only while the trip's switch
// `trip_group_photo` is on (featureOn); the site refuses anyone else again (403) and a trip without the switch (409).
//
// What it shows is the SITE'S request row and nothing else: pending, sending, done, bot_lacks_rights, no_group, no_logo,
// failed or expired. It never says "done" for a request that is only on its way, and while one is on its way it asks again
// every few seconds until the control plane has answered (a minute or two).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";

type Lang = "en" | "he";

export type GroupPhotoState = "none" | "pending" | "sending" | "done" | "bot_lacks_rights" | "no_group" | "no_logo" | "failed" | "expired";

export interface GroupPhotoStatus {
  status: GroupPhotoState;
  request: { id: number; status: GroupPhotoState; detail: string | null; requested_at: string; finished_at: string | null } | null;
  message: string | null;
}

export const GROUP_PHOTO_KEY = ["group-photo"] as const;
const POLL_MS = 5_000;

const WORDS: Record<Exclude<GroupPhotoState, "none">, { en: string; he: string }> = {
  pending: { en: "The request is on its way to the group. This usually takes a minute or two.", he: "הבקשה בדרך לקבוצה. זה לוקח בדרך כלל דקה או שתיים." },
  sending: { en: "The bot is setting the group photo now.", he: "הבוט מעדכן עכשיו את תמונת הקבוצה." },
  done: { en: "Done: the group's photo is now the trip logo.", he: "בוצע: תמונת הקבוצה היא עכשיו לוגו הטיול." },
  bot_lacks_rights: { en: "Make the bot an admin with \"Change group info\", then ask again.", he: "הפכו את הבוט למנהל עם ההרשאה \"שינוי פרטי הקבוצה\" ובקשו שוב." },
  no_group: { en: "No Telegram group is connected to this trip yet. Connect a group, then ask again.", he: "אין עדיין קבוצת טלגרם מחוברת לטיול. חברו קבוצה ובקשו שוב." },
  no_logo: { en: "This trip has no logo yet. Add one first, then ask again.", he: "לטיול אין עדיין לוגו. הוסיפו אחד ובקשו שוב." },
  failed: { en: "Telegram did not set the photo. Try again in a few minutes.", he: "טלגרם לא עדכן את התמונה. נסו שוב בעוד כמה דקות." },
  expired: { en: "The request waited more than 24 hours without running, so it was dropped. Ask again.", he: "הבקשה חיכתה יותר מ-24 שעות ולא בוצעה, ולכן בוטלה. בקשו שוב." },
};

const busyState = (state: GroupPhotoState | undefined) => state === "pending" || state === "sending";

export function GroupPhotoControl({ lang, offer, hasLogo }: { lang: Lang; offer: boolean; hasLogo: boolean }) {
  const t = (en: string, he: string) => (lang === "he" ? he : en);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: GROUP_PHOTO_KEY,
    queryFn: () => api<GroupPhotoStatus>("/api/group-photo"),
    refetchInterval: (query) => (busyState(query.state.data?.status) ? POLL_MS : false),
  });
  const ask = useMutation({
    mutationFn: () => api<GroupPhotoStatus>("/api/group-photo", { method: "POST", body: "{}" }),
    onSuccess: (stored) => queryClient.setQueryData(GROUP_PHOTO_KEY, stored),
  });
  const state = status.data?.status;
  const busy = busyState(state) || ask.isPending;
  const refusedNoLogo = ask.error instanceof ApiError && ask.error.status === 422;
  const line = state && state !== "none" ? WORDS[state] : null;

  // Nothing at all until there is a logo to use, or a request whose result is still worth showing.
  if (!hasLogo && !line) return null;
  return (
    <div className="group-photo-control">
      {offer && hasLogo && !busy ? <p className="group-photo-offer">{t("Your logo is saved. Want the Telegram group to use it too?", "הלוגו נשמר. רוצים שגם קבוצת הטלגרם תשתמש בו?")}</p> : null}
      {hasLogo ? (
        <button type="button" className="secondary-action" disabled={busy} onClick={() => ask.mutate()}>
          {t("Also make it the Telegram group photo", "להפוך אותו גם לתמונת קבוצת הטלגרם")}
        </button>
      ) : null}
      {line ? (
        <p role="status" className={`group-photo-status group-photo-${state}`}>
          {t(line.en, line.he)}
          {state === "failed" && status.data?.request?.detail ? ` (${status.data.request.detail})` : ""}
        </p>
      ) : null}
      {ask.isError ? (
        <p role="alert">
          {refusedNoLogo
            ? t(WORDS.no_logo.en, WORDS.no_logo.he)
            : ask.error instanceof ApiError && ask.error.status === 409
              ? t("The Telegram group photo is not turned on for this trip.", "תמונת קבוצת הטלגרם אינה פעילה בטיול הזה.")
              : t("Could not ask. Please try again.", "לא ניתן לשלוח את הבקשה. נסו שוב.")}
        </p>
      ) : null}
    </div>
  );
}
