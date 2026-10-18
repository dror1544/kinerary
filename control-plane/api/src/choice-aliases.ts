/**
 * A typed answer to a choice question, matched against the question's own
 * options by an explicit alias list — no model.
 *
 * Why this exists: on the star e2e of 2026-10-15 the organizer typed, to the
 * trip-type question, "טיול זוגות ולא משפחה, נהיה שני זוגות". The interpreter
 * sometimes answered {choice: couple} and sometimes {choice_other: "שני זוגות"}
 * — free text, so the site's trip type was not the `couple` option. The prompt
 * tells the model to match by meaning, and it does, about once in two. "Which
 * option did they name" is a lookup over a handful of words, so the gate runs it
 * AFTER the model, on a choice_other the model produced, and resolves it only
 * when exactly one option is named. The model's own answer is never overridden:
 * this acts on `choice_other` alone.
 *
 * It never guesses. Two options named, or none, or a word that signals a
 * different kind of trip ("friends"), leaves the answer as the model gave it.
 *
 * ONE list, here. A question with no entry is not touched. Aliases are matched
 * as whole words (after dropping a Hebrew one-letter prefix), never as
 * substrings: "זוגיות" (relationships) and "familiar" are not "זוג"/"family".
 */

/** questionId → optionId → words or phrases that name that option. */
const ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  trip_type: {
    // "זוגות" is the plural of "couple": "two couples" is the couple option
    // (owner's intent, 2026-10-15), not a group of families.
    couple: ["זוג", "זוגות", "זוגי", "זוגיים", "זוגית", "couple", "couples"],
    family: ["משפחה", "משפחתי", "משפחתית", "family"],
    group_of_families: [
      "קבוצת משפחות", "קבוצה של משפחות", "כמה משפחות", "מספר משפחות",
      "שתי משפחות", "שלוש משפחות", "ארבע משפחות", "משפחות",
      "group of families", "families", "two families", "three families", "several families",
    ],
  },
};

/**
 * Words that say it is some OTHER kind of trip. While one is present un-negated
 * the text is not resolved: "חברים עם המשפחה" is not a family trip.
 */
const OTHER_KIND: Readonly<Record<string, readonly string[]>> = {
  trip_type: ["חברים", "חברות", "חברה", "חבר'ה", "friends", "friend", "עסקים", "עסקי", "business", "סולו", "solo", "לבד", "singles", "רווקים", "קולגות", "colleagues",
    // "a couple of days" is a quantity, not a trip type; children mean the model
    // (or the re-ask) should weigh couple against family, not this list.
    "couple of", "זוג ימים", "זוג לילות", "kids", "children", "ילדים", "ילדות"],
};

const NEGATORS = new Set(["לא", "בלי", "ללא", "not", "no", "non", "without", "neither", "nor"]);
/** After one of these the negation is over: "not X BUT Y" — Y is what it is. */
const RESETS = new Set(["אלא", "but", "rather", "instead", "whereas"]);
/** How far back a negator reaches within a clause: "not a family trip" is 2 away. */
const NEGATION_REACH = 3;
const HEBREW_PREFIXES = ["ו", "ה", "ב", "ל", "כ", "מ", "ש"];

function tokenize(text: string): string[][] {
  // Clauses split on punctuation, so "couples, not family" negates only family.
  return text
    .toLowerCase()
    .replace(/[־]/g, " ") // maqaf
    .replace(/['’](?=s\b)/g, "") // couple's → couples
    .split(/[,;.!?:()\n—–]+/)
    .map((clause) => clause.split(/[^\p{L}\p{N}'"]+/u).map((t) => t.replace(/^["']+|["']+$/g, "")).filter(Boolean))
    .filter((clause) => clause.length > 0);
}

/** A token and what it becomes with one or two Hebrew prefix letters removed. */
function forms(token: string): string[] {
  const out = [token];
  if (/^[֐-׿]/.test(token)) {
    let rest = token;
    for (let i = 0; i < 2 && rest.length > 2 && HEBREW_PREFIXES.includes(rest[0]!); i++) {
      rest = rest.slice(1);
      out.push(rest);
    }
  }
  return out;
}

const negates = (token: string) => forms(token).some((f) => NEGATORS.has(f));
const resets = (token: string) => forms(token).some((f) => RESETS.has(f));

interface Mention { optionId: string; negated: boolean }

/** Every place `phrases` occur in one clause, as token spans, with whether each is negated. */
function mentionsIn(clause: string[], phrases: readonly string[]): { start: number; negated: boolean }[] {
  const found: { start: number; negated: boolean }[] = [];
  for (const phrase of phrases) {
    const words = phrase.toLowerCase().split(" ");
    for (let i = 0; i + words.length <= clause.length; i++) {
      // Word-for-word, with a prefix allowed on the FIRST word only: "ולמשפחה"
      // is "and to a family", but "משפחה" inside "קבוצת" is not anything.
      const matches = words.every((w, k) => (k === 0 ? forms(clause[i]!) : [clause[i + k]!]).includes(w));
      if (!matches) continue;
      let negated = false;
      for (let back = 1; back <= NEGATION_REACH && i - back >= 0; back++) {
        const prior = clause[i - back]!;
        if (resets(prior)) break;
        if (negates(prior)) { negated = true; break; }
      }
      found.push({ start: i, negated });
    }
  }
  return found;
}

/**
 * The one option of `questionId` that `text` plainly names, or null.
 * `optionIds` are the options the question actually offers; an alias list entry
 * for an option the question does not have is ignored.
 */
export function resolveTypedOption(
  questionId: string,
  text: string,
  optionIds: readonly string[],
): string | null {
  const table = ALIASES[questionId];
  if (!table || !text.trim()) return null;

  const clauses = tokenize(text);
  const mentions: Mention[] = [];
  for (const [optionId, aliases] of Object.entries(table)) {
    if (!optionIds.includes(optionId)) continue;
    for (const clause of clauses) {
      for (const m of mentionsIn(clause, aliases)) mentions.push({ optionId, negated: m.negated });
    }
  }

  // "group of families" contains "families" and "משפחות" — a longer phrase for
  // one option must not leave a shorter alias of ANOTHER option to be counted.
  // Only the group option owns plural-family words, so no cross-option overlap
  // exists in the table; the check below is the guard if one is ever added.
  const standing = new Set(mentions.filter((m) => !m.negated).map((m) => m.optionId));
  if (standing.size !== 1) return null;

  for (const clause of clauses) {
    if (mentionsIn(clause, OTHER_KIND[questionId] ?? []).some((m) => !m.negated)) return null;
  }
  return [...standing][0]!;
}
