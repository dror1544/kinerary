/**
 * The words the relay says itself about trip photos (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B).
 *
 * Relay-owned, in English and Hebrew, and nothing here is a model's. Kept in the relay (not in intake-copy.ts) because it is
 * said by the relay's photo path and by nothing else; a language it does not have reads as English.
 *
 * Hebrew is written without gendered verbs for the bot, because the bot's own grammatical gender is the trip's choice and the
 * relay does not know it.
 */

export type PhotoLanguage = "en" | "he";

export function photoLanguage(value: unknown): PhotoLanguage {
  return value === "he" ? "he" : "en";
}

const TEXT = {
  /** L2: said once in the group when automatic saving is on. */
  autosaveNotice: {
    en: "I save photos posted here to the trip album. An organizer can turn this off in the trip settings.",
    he: "תמונות שמפורסמות כאן נשמרות באלבום של הטיול. מארגן יכול לכבות את זה בהגדרות הטיול.",
  },
  /** A save request and no photo in the window. */
  windowEmpty: {
    en: "I can only reach photos from the last half hour, and I haven't seen any in that time.",
    he: "אפשר לשמור רק תמונות מחצי השעה האחרונה, ולא ראיתי תמונות בזמן הזה.",
  },
  /** A save request for a photo older than the window. */
  windowPast: {
    en: "I can only reach photos from the last half hour, and that one is older.",
    he: "אפשר לשמור רק תמונות מחצי השעה האחרונה, והתמונה הזאת ישנה יותר.",
  },
  /** Every photo asked for is already in the album. */
  alreadySaved: {
    en: "Those photos are already in the trip album.",
    he: "התמונות האלה כבר באלבום של הטיול.",
  },
  /** A request accepted: `{n}` photos are being saved. */
  saving: {
    en: "Saving {n} to the trip album.",
    he: "שומר {n} באלבום של הטיול.",
  },
  savingOne: {
    en: "Saving it to the trip album.",
    he: "שומר את התמונה באלבום של הטיול.",
  },
  /** A photo in a private chat with no words: one question. */
  askDm: {
    en: "Add it to the trip album?",
    he: "להוסיף את התמונה לאלבום של הטיול?",
  },
  /** "No" to the question above. */
  declinedDm: {
    en: "OK, I won't save it.",
    he: "בסדר, לא אשמור אותה.",
  },
  /** The Save button on a drafted moment, and its answers. */
  saveButton: { en: "Save", he: "שמור" },
  tapSaved: { en: "Saving the moment.", he: "שומר את הרגע." },
  tapExpired: {
    en: "That draft is no longer waiting for an answer.",
    he: "הטיוטה הזאת כבר לא ממתינה לתשובה.",
  },
  tapNotMember: {
    en: "Only people on the trip can save this.",
    he: "רק מי שבטיול יכול לשמור את זה.",
  },
  tapUnavailable: {
    en: "I can't save that right now.",
    he: "אי אפשר לשמור את זה כרגע.",
  },
} as const;

export type PhotoTextKey = keyof typeof TEXT;

export function photoText(key: PhotoTextKey, language: PhotoLanguage): string {
  return TEXT[key][language];
}

export function savingText(count: number, language: PhotoLanguage): string {
  if (count === 1) return TEXT.savingOne[language];
  const noun = language === "he" ? `${count} תמונות` : `${count} photos`;
  return TEXT.saving[language].replace("{n}", () => noun);
}
