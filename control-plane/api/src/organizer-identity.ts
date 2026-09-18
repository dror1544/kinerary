/**
 * Which of the travellers is the person running this interview.
 *
 * The roster is the source of truth, so the interview offers it as buttons and
 * records the roster's own spelling. Typed answers still happen — someone types
 * instead of tapping, or the interpreter reads "me — Nir, 45" off a message — and
 * this decides whether such an answer names exactly one traveller:
 *
 *   1. exactly as written (full name, given name, name + household),
 *   2. the same name in the OTHER alphabet, as a fallback,
 *   3. anything else — nobody, or more than one — is not an organizer, and the
 *      interview asks again with the buttons. It never guesses.
 *
 * 2026-09-15, live: a roster entered only in English letters, an organizer who
 * answered in Hebrew, nothing matched, and a trip was provisioned without its
 * companion. The worker's `_resolve_organizers` (transformer.py) applies the same
 * rules at build time; both are held to contracts/v1/name-matching-cases.json.
 */

import { createHash } from "node:crypto";

export type OrganizerMatch =
  | { kind: "matched"; index: number; name: string }
  | { kind: "ambiguous" }
  | { kind: "unmatched" }
  | { kind: "no_roster" };

export interface RosterChoice {
  /**
   * Button id: the roster position plus a short fingerprint of the name, so a
   * keyboard drawn before the roster changed can never record whoever holds that
   * position now.
   */
  id: string;
  /** What the button says. */
  label: string;
  /** What is recorded when it is tapped: the roster's own spelling. */
  value: string;
}

interface RosterEntry {
  name?: unknown;
  name_en?: unknown;
  family?: unknown;
  family_en?: unknown;
}

/** Casefolded and whitespace-collapsed, as transformer.py's `_normalize_identity`. */
export function normalizeIdentity(value: unknown): string {
  return String(value ?? "").split(/\s+/u).filter(Boolean).join(" ").toLowerCase();
}

const SELF_REFERENCE = /^(?:it'?s\s+me|i\s+am|i'?m|me|myself|זה\s+אני|זאת\s+אני|אני)(?=[\s,:(]|$)[\s,:]*/iu;
const AFTER_NAME = /\s*[,;(—–]\s*|\s+-\s+/u;

function splitOnce(text: string): string[] {
  const m = AFTER_NAME.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text];
}

function stripEnds(text: string): string {
  return text.replace(/^[ )]+|[ )]+$/gu, "");
}

/** The answer as typed, then the name at the front of it ("אני ניר", "Nir, the dad"). */
export function statedNameCandidates(answer: string): string[] {
  const full = normalizeIdentity(answer);
  if (!full) return [];
  const candidates = [full];
  const parts = splitOnce(full.replace(SELF_REFERENCE, ""));
  const head = stripEnds(parts[0] ?? "");
  if (head) candidates.push(head);
  else if (parts.length > 1) candidates.push(stripEnds(splitOnce(parts[1]!)[0] ?? ""));
  return [...new Set(candidates.filter(Boolean))];
}

function rosterEntries(roster: unknown): RosterEntry[] {
  if (!Array.isArray(roster)) return [];
  return roster.filter((e): e is RosterEntry =>
    typeof e === "object" && e !== null
    && (normalizeIdentity((e as RosterEntry).name) !== "" || normalizeIdentity((e as RosterEntry).name_en) !== ""));
}

/** Every way someone might write this traveller's own name. Never the household label alone. */
function identityForms(entry: RosterEntry): Set<string> {
  const names = new Set([normalizeIdentity(entry.name), normalizeIdentity(entry.name_en)].filter(Boolean));
  const families = new Set([normalizeIdentity(entry.family), normalizeIdentity(entry.family_en)].filter(Boolean));
  const forms = new Set(names);
  for (const n of names) for (const f of families) forms.add(`${n} ${f}`);
  for (const n of names) if (n.includes(" ")) forms.add(n.split(" ")[0]!);
  forms.delete("");
  return forms;
}

// ── Sound-alike, across alphabets only ───────────────────────────────────────

const HEBREW_SOUNDS: Record<string, readonly string[]> = {
  "א": [""], "ע": [""], "י": [""], "ו": ["", "b"],
  "ה": ["k"], "ח": ["k"], "כ": ["k"], "ך": ["k"], "ק": ["k"],
  "ב": ["b"], "ג": ["g"], "ד": ["d"], "ז": ["z"], "ט": ["t"], "ת": ["t"],
  "ל": ["l"], "מ": ["m"], "ם": ["m"], "נ": ["n"], "ן": ["n"], "ס": ["s"],
  "ש": ["S", "s"], "צ": ["C", "z"], "ץ": ["C", "z"], "פ": ["p", "f"], "ף": ["f"], "ר": ["r"],
};
const LATIN_DIGRAPHS: Record<string, string> = { sh: "S", ch: "k", kh: "k", tz: "C", ts: "C", th: "t", ph: "f" };
const LATIN_SOUNDS: Record<string, string> = {
  ...Object.fromEntries([..."aeiouyj"].map((c) => [c, ""])),
  b: "b", v: "b", w: "b", c: "k", k: "k", q: "k", h: "k", x: "ks",
  ...Object.fromEntries([..."dfglmnprstz"].map((c) => [c, c])),
};
/** One consonant cannot tell people apart; those names are what the buttons are for. */
const MIN_SKELETON_CONSONANTS = 2;
const SKELETON_VARIANT_CAP = 64;

function alphabet(text: string): "he" | "latin" | null {
  const hebrew = /[א-ת]/u.test(text);
  const latin = /[a-z]/u.test(text);
  if (hebrew && !latin) return "he";
  if (latin && !hebrew) return "latin";
  return null;
}

function collapseRepeats(skeleton: string): string {
  let out = "";
  for (const ch of skeleton) if (out.at(-1) !== ch) out += ch;
  return out;
}

function capped(variants: Set<string>): Set<string> {
  if (variants.size <= SKELETON_VARIANT_CAP) return variants;
  // Code-point order, as Python's sorted(): every character here is ASCII.
  return new Set([...variants].sort().slice(0, SKELETON_VARIANT_CAP));
}

function hebrewWordSkeletons(word: string): Set<string> {
  const letters = [...word].filter((ch) => ch in HEBREW_SOUNDS);
  let variants = new Set([""]);
  letters.forEach((ch, i) => {
    const sounds = ch === "ה" && i === letters.length - 1 ? [""] : HEBREW_SOUNDS[ch]!;
    variants = capped(new Set([...variants].flatMap((v) => sounds.map((s) => v + s))));
  });
  return new Set([...variants].map(collapseRepeats));
}

function latinWordSkeleton(word: string): string {
  let letters = [...word.normalize("NFKD")].filter((ch) => ch >= "a" && ch <= "z").join("");
  if (letters.length > 1 && letters.endsWith("h")) letters = letters.slice(0, -1);
  let out = "";
  for (let i = 0; i < letters.length;) {
    const pair = letters.slice(i, i + 2);
    if (pair in LATIN_DIGRAPHS) {
      out += LATIN_DIGRAPHS[pair];
      i += 2;
      continue;
    }
    out += LATIN_SOUNDS[letters[i]!] ?? "";
    i += 1;
  }
  return collapseRepeats(out);
}

function nameSkeletons(name: string): Set<string> {
  const text = normalizeIdentity(name);
  const script = alphabet(text);
  if (!script) return new Set();
  let combos = new Set([""]);
  for (const word of text.split(" ")) {
    const options = script === "he" ? hebrewWordSkeletons(word) : new Set([latinWordSkeleton(word)]);
    combos = capped(new Set([...combos].flatMap((c) => [...options].map((o) => [c, o].filter(Boolean).join(" ")))));
  }
  return new Set([...combos].filter((c) => c.replaceAll(" ", "").length >= MIN_SKELETON_CONSONANTS));
}

/** The same name written in the other alphabet — never the same alphabet. */
export function namesSoundAlike(a: string, b: string): boolean {
  const scriptA = alphabet(normalizeIdentity(a));
  const scriptB = alphabet(normalizeIdentity(b));
  if (!scriptA || !scriptB || scriptA === scriptB) return false;
  const left = nameSkeletons(a);
  for (const s of nameSkeletons(b)) if (left.has(s)) return true;
  return false;
}

// ── The decision ─────────────────────────────────────────────────────────────

function rosterName(entry: RosterEntry): string {
  return String((normalizeIdentity(entry.name) ? entry.name : entry.name_en) ?? "").trim();
}

/** Resolves what someone wrote to exactly one roster position, or says why it cannot. */
export function resolveOrganizer(answer: string, roster: unknown): OrganizerMatch {
  const entries = rosterEntries(roster);
  if (entries.length === 0) return { kind: "no_roster" };
  const candidates = statedNameCandidates(answer);
  if (candidates.length === 0) return { kind: "unmatched" };
  const forms = entries.map(identityForms);

  const decide = (hits: number[]): OrganizerMatch | null => {
    if (hits.length === 1) return { kind: "matched", index: hits[0]!, name: rosterName(entries[hits[0]!]!) };
    if (hits.length > 1) return { kind: "ambiguous" };
    return null;
  };

  for (const needle of candidates) {
    const decided = decide(forms.flatMap((f, i) => (f.has(needle) ? [i] : [])));
    if (decided) return decided;
  }
  // Nothing matched as written: the same name in the other alphabet, under the
  // same rule. Reached only after every stricter reading found nobody.
  for (const needle of candidates) {
    const decided = decide(forms.flatMap((f, i) => ([...f].some((form) => namesSoundAlike(needle, form)) ? [i] : [])));
    if (decided) return decided;
  }
  return { kind: "unmatched" };
}

/** The roster as buttons, in roster order. */
export function rosterChoices(roster: unknown): RosterChoice[] {
  return rosterEntries(roster).map((entry, i) => {
    const name = rosterName(entry);
    const english = String(entry.name_en ?? "").trim();
    const label = english && normalizeIdentity(english) !== normalizeIdentity(name) ? `${name} (${english})` : name;
    const fingerprint = createHash("sha256").update(name).digest("hex").slice(0, 6);
    return { id: `p${i}_${fingerprint}`, label, value: name };
  });
}
