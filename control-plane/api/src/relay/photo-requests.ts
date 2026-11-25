/**
 * What counts as a request to save photos, and as a yes or a no (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B).
 *
 * DELIBERATELY NARROW. The relay answers these itself, with no model turn, so a phrase it recognises is one it acts on; a phrase it
 * does not recognise is NOT a refusal - it returns null and the message goes where it always went (the companion, or nowhere
 * for an unaddressed one). A save request worded in a way this list does not know therefore costs the person one rewording,
 * never a wrong save. Whole-message matches only: "save this photo for the album cover idea, what do you think" is a question for
 * the companion, not a request the relay may take.
 *
 * Text only; nothing here reads a photo.
 */

export type SaveRequest = "this" | "last";

/** The message with the assistant's @handle and names, punctuation and extra spaces taken off, lower-cased. */
export function plainRequestText(text: string, assistantNames: readonly string[] = []): string {
  let out = text.normalize("NFKC").toLowerCase();
  out = out.replace(/@[a-z0-9_]{3,}/g, " ");
  for (const name of assistantNames) {
    const clean = name.normalize("NFKC").toLowerCase().trim();
    if (clean.length >= 2) out = out.split(clean).join(" ");
  }
  out = out.replace(/[.,!?;:"'`´”“’‘()‎‏]/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

const EN_VERB = "(?:please )?(?:save|add|keep|store|put|upload)";
const EN_TARGET = "(?: (?:in|into|to|on|onto))?(?: the)?(?: (?:trip|album|trip album|trip photos|photo album))?(?: please)?";
const EN_THIS = new RegExp(`^${EN_VERB} (?:this|that|it)(?: (?:photo|picture|pic|image|one))?${EN_TARGET}$`);
const EN_LAST = new RegExp(
  `^${EN_VERB} (?:all )?(?:of )?(?:the |these |those )?(?:(?:last|latest|recent|new) )?(?:\\d{1,2} )?(?:photos|pictures|pics|images)(?: (?:from|of) (?:the )?(?:last|past) (?:half hour|30 minutes|thirty minutes))?${EN_TARGET}$`,
);
// "save the last photos" must carry a "last"-like word or "these"/"those"; a bare "save the photos" is too loose to act on.
const EN_LAST_NEEDS = /\b(?:last|latest|recent|these|those|new|all)\b/;

const HE_VERB = "(?:בבקשה )?(?:תשמור|תשמרי|שמור|שמרי|תוסיף|תוסיפי|הוסף|הוסיפי|תעלה|תעלי)";
const HE_TARGET = "(?: (?:ל|ב)?(?:טיול|אלבום|אלבום של הטיול|אלבום הטיול))?(?: בבקשה)?";
const HE_THIS = new RegExp(`^${HE_VERB}(?: את)? (?:זה|זאת|אותה|אותו|התמונה הזאת|התמונה הזו|התמונה)${HE_TARGET}$`);
const HE_LAST = new RegExp(`^${HE_VERB}(?: את)? (?:כל )?(?:ה)?(?:תמונות|תצלומים)(?: ה(?:אחרונות|אלה|אלו|חדשות))?${HE_TARGET}$`);
const HE_LAST_NEEDS = /(?:אחרונות|אלה|אלו|חדשות|כל)/;

/** "this", "last", or null when the message is not a save request this relay knows. `plain` comes from `plainRequestText`. */
export function parseSaveRequest(plain: string): SaveRequest | null {
  if (!plain || plain.length > 120) return null;
  if (EN_THIS.test(plain) || HE_THIS.test(plain)) return "this";
  if (EN_LAST.test(plain) && EN_LAST_NEEDS.test(plain)) return "last";
  if (HE_LAST.test(plain) && HE_LAST_NEEDS.test(plain)) return "last";
  return null;
}

const YES = /^(?:yes|yep|yeah|yup|sure|ok|okay|please|y|do it|go ahead|add it|save it|כן|בטח|סבבה|אשמח|תוסיף|תוסיפי|הוסף|שמור|אוקיי|אוקי)$/;
const NO = /^(?:no|nope|nah|n|not now|no thanks|no thank you|לא|לא תודה|לא עכשיו)$/;

export function isYes(plain: string): boolean {
  return YES.test(plain);
}

export function isNo(plain: string): boolean {
  return NO.test(plain);
}
