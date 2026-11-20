/**
 * The words of the group sign-in screens, in English and Hebrew.
 *
 * The rest of this folder is English; these screens are the first a traveller who may not read English sees, so they carry
 * both. The language is the WebView's own first preference (`navigator.languages`), never Telegram's `initDataUnsafe`:
 * `readLaunch` (sdk.ts) is the one place that touches launch data, and a language hint is not worth a second.
 *
 * Nothing here ever says an error code, a trip id or a claim id: a person is reading it.
 */
export type MiniLang = "en" | "he";

export function miniLanguage(): MiniLang {
  const preferred = (typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language) : "") ?? "";
  // "iw" is the legacy code some WebViews still report for Hebrew.
  return /^(he|iw)(-|_|$)/i.test(preferred) ? "he" : "en";
}

export interface ClaimCopy {
  pickTitle: string;
  pickBody: string;
  confirmTitle: string;
  confirmLine: string;
  confirmWarning: string;
  confirmButton: string;
  backButton: string;
  working: string;
  emptyTitle: string;
  emptyBody: string;
  taken: string;
  retryNotice: string;
  retryButton: string;
  staleTitle: string;
  staleBody: string;
  retryTitle: string;
  retryBody: string;
}

export const claimCopy: Record<MiniLang, ClaimCopy> = {
  en: {
    pickTitle: "Which traveller are you?",
    pickBody: "You're in this trip's Telegram group. Choose your own name from the list.",
    confirmTitle: "Is this you?",
    confirmLine: "You are signing in as {name}",
    confirmWarning: "If this is the wrong name, only the organizer can undo it.",
    confirmButton: "Yes, that's me",
    backButton: "Choose a different name",
    working: "Signing in…",
    emptyTitle: "Your name isn't on the list",
    emptyBody: "Ask the organizer to send you a personal invite to the trip.",
    taken: "Someone already signed in as {name}. If that wasn't you, ask the organizer.",
    retryNotice: "We couldn't finish that just now. Please try again.",
    retryButton: "Try again",
    staleTitle: "Please open Kinerary again",
    staleBody: "This took too long. Close this window and open Kinerary from Telegram again.",
    retryTitle: "We couldn't check right now",
    retryBody: "Please try again in a moment.",
  },
  he: {
    pickTitle: "מי מהנוסעים אתם?",
    pickBody: "אתם בקבוצת הטלגרם של הטיול. בחרו את השם שלכם מהרשימה.",
    confirmTitle: "זה אתם?",
    confirmLine: "אתם נכנסים בתור {name}",
    confirmWarning: "אם זה לא השם הנכון, רק המארגן יכול לבטל זאת.",
    confirmButton: "כן, זה אני",
    backButton: "בחירת שם אחר",
    working: "נכנסים…",
    emptyTitle: "השם שלכם לא ברשימה",
    emptyBody: "בקשו מהמארגן שישלח לכם הזמנה אישית לטיול.",
    taken: "מישהו כבר נכנס בתור {name}. אם זה לא אתם, פנו למארגן.",
    retryNotice: "לא הצלחנו להשלים את זה כרגע. נסו שוב.",
    retryButton: "נסו שוב",
    staleTitle: "פתחו את Kinerary מחדש",
    staleBody: "עבר יותר מדי זמן. סגרו את החלון ופתחו את Kinerary שוב מטלגרם.",
    retryTitle: "לא הצלחנו לבדוק כרגע",
    retryBody: "נסו שוב בעוד רגע.",
  },
};
