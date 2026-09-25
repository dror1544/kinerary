/**
 * A typed change to held stops or travellers, as data (#206).
 *
 * The contract: interpret -> a structured diff against what is HELD -> validate
 * it against the rest of the trip -> show exactly that -> apply exactly that,
 * only after the person confirms. This module is the middle of it and is PURE:
 * no database, no model, no clock. Nothing here is wired to the router yet —
 * slice 1 of #206 — so importing it changes nothing live.
 *
 * WHAT THE MODEL PRODUCES is a short list of OPERATIONS (`Op`), never the
 * resulting list: a model asked for the whole list drops entries, and one asked
 * only for what is added cannot express a removal. What it names is a REFERENCE
 * ("Ruth", "Tokyo"), which THIS module resolves against the held state, in code
 * (`resolveRef`). A reference that names nothing or several is a question for
 * the person, never a guess. The ids the model is shown are hints and count
 * only when the name agrees.
 *
 * WHAT THE PERSON SEES is the same thing that is applied: `applyOps` computes
 * the resulting answer THROUGH `validateAnswer` (so what is shown is what would
 * be stored), and the preview is the field-level difference between held and
 * result — including what the change does elsewhere (a booking it leaves
 * behind, a day it drops, an organizer it un-matches). The preview is data —
 * `{ key, params }` — not sentences: wording, and the person's language, are
 * the router's.
 */
import { createHash } from "node:crypto";
import { canonical, identityFold, isRecord, ordered } from "./answer-merge.js";
import { INTAKE_QUESTIONS, organizerMatch, validateAnswer, type AnswerStore, type IntakeAnswer } from "./interview.js";

// ── Operations ───────────────────────────────────────────────────────────────

/** A pointer at a held entry: the name the person used, and the id the model was shown. */
export interface Ref {
  id?: string;
  name?: string;
  /**
   * SET BY THE ROUTER ONLY, never by the model: the person picked this entry
   * from a list of candidates. It counts only while the entry at `index` still
   * goes by `name` — a list that changed under a tap must not silently point at
   * whoever sits at that position now.
   */
  pin?: { index: number; name: string };
}

export interface Fields {
  name?: string;
  name_en?: string;
  start?: string;
  end?: string;
  age?: number;
  family?: string;
  accommodation?: Record<string, string>;
  planned?: string[];
}

export type Op =
  | { op: "add_stop"; fields: Fields; after?: Ref }
  | { op: "remove_stop"; target: Ref }
  | { op: "rename_stop"; target: Ref; name: string }
  | { op: "replace_stop"; target: Ref; fields: Fields }
  | { op: "move_stop"; target: Ref; after?: Ref; before?: Ref }
  | { op: "update_stop"; target: Ref; fields: Fields }
  | { op: "add_traveller"; fields: Fields }
  | { op: "update_traveller"; target: Ref; fields: Fields }
  | { op: "remove_traveller"; target: Ref }
  /**
   * The words honestly fit two or three different operations ("change Hakone to
   * Nagoya": a rename, a replacement, or one more stop) and nothing settles
   * which. The person is asked; their choice replaces this with that operation.
   */
  | { op: "choose"; options: Exclude<Op, { op: "choose" }>[] };

export type Family = "stop" | "traveller";

export const OP_NAMES = [
  "add_stop", "remove_stop", "rename_stop", "replace_stop", "move_stop", "update_stop",
  "add_traveller", "update_traveller", "remove_traveller", "choose",
] as const;

const MAX_OPS = 20;
/** The most operations one waiting draft may hold once follow-ups are merged into it. */
export const MAX_DRAFT_OPS = 40;
// Bounds on model-supplied text, so a preview built from them is bounded too.
const MAX_TEXT = 80;
const MAX_PLANNED = 12;
const STOP_FIELDS = new Set(["name", "name_en", "start", "end", "accommodation", "planned"]);
const STOP_UPDATE_FIELDS = new Set(["name_en", "start", "end", "accommodation", "planned"]);
const TRAVELLER_FIELDS = new Set(["name", "name_en", "age", "family"]);
const ACCOMMODATION_KEYS = new Set(["name", "confirmation"]);

export function familyOf(op: Op["op"]): Family {
  return op.endsWith("_traveller") ? "traveller" : "stop";
}

/** The question an operation is about. A choice is about what its options are about. */
export function questionOfOp(op: Op): "phases" | "travelers" {
  return questionOf(familyOf(op.op === "choose" ? op.options[0]!.op : op.op));
}

export function questionOf(family: Family): "phases" | "travelers" {
  return family === "stop" ? "phases" : "travelers";
}

export type ParseResult = { ok: true; ops: Op[] } | { ok: false; error: string };

/**
 * Characters a name may never carry, because they let a name draw its own lines
 * or hide what it says: control characters (a newline), the line and paragraph
 * separators, EVERY format character (zero-width space/joiner, word joiner, BOM,
 * soft hyphen, the bidi embedding / override / isolate family, invisible
 * operators, deprecated formats, tags), private use, variation selectors, and
 * the Hangul and combining-grapheme fillers.
 *
 * Except the three directional MARKS - RLM, LRM, ALM: Hebrew and Arabic text uses
 * them legitimately.
 */
export const FORBIDDEN_TEXT = /(?![\u200E\u200F\u061C])[\p{Cc}\p{Cf}\p{Co}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const FORBIDDEN_TEXT_ALL = new RegExp(FORBIDDEN_TEXT.source, "gu");

export function safeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 && t.length <= max && !FORBIDDEN_TEXT.test(t) ? t : null;
}

/**
 * Text as it may be ECHOED to a person, whoever wrote it: every forbidden
 * character becomes a space and runs of whitespace collapse, so a name read from
 * a document (or written by the agent) cannot start a line of its own or forge
 * one. The parse refuses such names from the model; this covers everything else.
 */
export function cleanText(value: string): string {
  return value.replace(FORBIDDEN_TEXT_ALL, " ").replace(/\s+/g, " ").trim();
}
const text = safeText;

function parseRef(raw: unknown, where: string): { ref: Ref } | { error: string } {
  if (!isRecord(raw)) return { error: `${where}: a reference is an object` };
  const extra = Object.keys(raw).filter((k) => k !== "id" && k !== "name");
  if (extra.length > 0) return { error: `${where}: unknown reference key ${extra[0]}` };
  const ref: Ref = {};
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string" || !/^[st]\d{1,3}$/.test(raw.id)) return { error: `${where}: bad id` };
    ref.id = raw.id;
  }
  if (raw.name !== undefined) {
    const name = text(raw.name, 120);
    if (!name) return { error: `${where}: bad name` };
    ref.name = name;
  }
  if (ref.id === undefined && ref.name === undefined) return { error: `${where}: a reference needs a name` };
  return { ref };
}

function parseFields(raw: unknown, allowed: ReadonlySet<string>, where: string): { fields: Fields } | { error: string } {
  if (!isRecord(raw)) return { error: `${where}: fields must be an object` };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) return { error: `${where}: field ${key} is not allowed` };
    if (key === "age") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 120) return { error: `${where}: bad age` };
      out.age = value;
    } else if (key === "planned") {
      if (!Array.isArray(value) || value.length > MAX_PLANNED || !value.every((p) => text(p) !== null)) return { error: `${where}: bad planned` };
      out.planned = value.map((p) => (p as string).trim());
    } else if (key === "accommodation") {
      if (!isRecord(value)) return { error: `${where}: bad accommodation` };
      const acc: Record<string, string> = {};
      for (const [k, v] of Object.entries(value)) {
        const t = text(v);
        if (!ACCOMMODATION_KEYS.has(k) || !t) return { error: `${where}: bad accommodation.${k}` };
        acc[k] = t;
      }
      if (Object.keys(acc).length === 0) return { error: `${where}: empty accommodation` };
      out.accommodation = acc;
    } else {
      const t = text(value);
      if (!t) return { error: `${where}: bad ${key}` };
      out[key] = t;
    }
  }
  return { fields: out as Fields };
}

/**
 * The model's operations, or a refusal. An unknown operation, key or field
 * refuses the WHOLE payload: half a change the person never saw is the failure
 * this feature exists to prevent.
 */
export function parseOps(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) return { ok: false, error: "ops must be a list" };
  if (raw.length === 0) return { ok: false, error: "no operations" };
  if (raw.length > MAX_OPS) return { ok: false, error: `more than ${MAX_OPS} operations` };
  const ops: Op[] = [];
  for (const [i, item] of raw.entries()) {
    const where = `ops[${i}]`;
    if (!isRecord(item) || typeof item.op !== "string") return { ok: false, error: `${where}: not an operation` };
    const name = item.op as Op["op"];
    if (!(OP_NAMES as readonly string[]).includes(name)) return { ok: false, error: `${where}: unknown operation ${String(item.op)}` };
    const allowedKeys: Record<Op["op"], string[]> = {
      choose: ["options"],
      add_stop: ["fields", "after"], remove_stop: ["target"], rename_stop: ["target", "name"],
      replace_stop: ["target", "fields"], move_stop: ["target", "after", "before"], update_stop: ["target", "fields"],
      add_traveller: ["fields"], update_traveller: ["target", "fields"], remove_traveller: ["target"],
    };
    const extra = Object.keys(item).filter((k) => k !== "op" && !allowedKeys[name].includes(k));
    if (extra.length > 0) return { ok: false, error: `${where}: unknown key ${extra[0]}` };

    let target: Ref | undefined;
    if (allowedKeys[name].includes("target")) {
      const parsed = parseRef(item.target, `${where}.target`);
      if ("error" in parsed) return { ok: false, error: parsed.error };
      target = parsed.ref;
    }
    const optionalRef = (key: "after" | "before"): { ref?: Ref } | { error: string } => {
      if (item[key] === undefined) return {};
      const parsed = parseRef(item[key], `${where}.${key}`);
      return "error" in parsed ? parsed : { ref: parsed.ref };
    };

    switch (name) {
      case "choose": {
        if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 3) {
          return { ok: false, error: `${where}: a choice has two or three options` };
        }
        if (item.options.some((o) => isRecord(o) && o.op === "choose")) return { ok: false, error: `${where}: a choice cannot contain a choice` };
        const inner = parseOps(item.options);
        if (!inner.ok) return { ok: false, error: `${where}: ${inner.error}` };
        if (new Set(inner.ops.map((o) => familyOf(o.op))).size !== 1) return { ok: false, error: `${where}: options must all be about stops, or all about travellers` };
        ops.push({ op: "choose", options: inner.ops as Exclude<Op, { op: "choose" }>[] });
        break;
      }
      case "remove_stop":
      case "remove_traveller":
        ops.push({ op: name, target: target! });
        break;
      case "rename_stop": {
        const newName = text(item.name);
        if (!newName) return { ok: false, error: `${where}: bad name` };
        ops.push({ op: name, target: target!, name: newName });
        break;
      }
      case "add_stop":
      case "replace_stop": {
        const fields = parseFields(item.fields, STOP_FIELDS, `${where}.fields`);
        if ("error" in fields) return { ok: false, error: fields.error };
        if (!fields.fields.name) return { ok: false, error: `${where}: a stop needs a name` };
        if (name === "add_stop") {
          const after = optionalRef("after");
          if ("error" in after) return { ok: false, error: after.error };
          ops.push({ op: name, fields: fields.fields, ...(after.ref ? { after: after.ref } : {}) });
        } else {
          ops.push({ op: name, target: target!, fields: fields.fields });
        }
        break;
      }
      case "update_stop":
      case "update_traveller": {
        const fields = parseFields(item.fields, name === "update_stop" ? STOP_UPDATE_FIELDS : TRAVELLER_FIELDS, `${where}.fields`);
        if ("error" in fields) return { ok: false, error: fields.error };
        if (Object.keys(fields.fields).length === 0) return { ok: false, error: `${where}: nothing to change` };
        ops.push({ op: name, target: target!, fields: fields.fields });
        break;
      }
      case "add_traveller": {
        const fields = parseFields(item.fields, TRAVELLER_FIELDS, `${where}.fields`);
        if ("error" in fields) return { ok: false, error: fields.error };
        if (!fields.fields.name) return { ok: false, error: `${where}: a traveller needs a name` };
        ops.push({ op: name, fields: fields.fields });
        break;
      }
      case "move_stop": {
        const after = optionalRef("after");
        const before = optionalRef("before");
        if ("error" in after) return { ok: false, error: after.error };
        if ("error" in before) return { ok: false, error: before.error };
        if ((after.ref === undefined) === (before.ref === undefined)) return { ok: false, error: `${where}: say after OR before` };
        ops.push({ op: name, target: target!, ...(after.ref ? { after: after.ref } : {}), ...(before.ref ? { before: before.ref } : {}) });
        break;
      }
    }
  }
  return { ok: true, ops };
}

// ── References ───────────────────────────────────────────────────────────────

/** Every name an entry goes by — both the name and its English spelling. */
export function namesOf(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  return [entry.name, entry.name_en].filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/** A name as its whole words: folded, and split at anything that is not a letter, digit or apostrophe. */
export function wordsOf(name: string): string[] {
  return identityFold(name).replace(/[^\p{L}\p{N}'"]+/gu, " ").split(" ").filter((w) => w !== "");
}

/** The id a held entry is shown under, `s2` for the second stop, `t1` for the first traveller. */
export function refId(family: Family, index: number): string {
  return `${family === "stop" ? "s" : "t"}${index + 1}`;
}

export type Resolution =
  | { kind: "resolved"; index: number }
  | { kind: "unresolved"; candidates: number[] };

/**
 * Which held entry a reference means.
 *
 * Matching is WHOLE WORDS, not similarity: every word the person typed must be
 * a whole word of one of the entry's names. "Ruth" is a whole word of "Ruth
 * Cohen", so a lone Ruth resolves; "Ella" is not a whole word of "Bella", so
 * it never does. That is not clip tolerance — nothing is forgiven — and it is
 * why a one-word name works at all (`samePerson` refuses one-word names).
 * An exact match beats a partial one, so "Ruth Cohen" is not ambiguous with
 * "Ruth Cohen Levi". Zero or several candidates is `unresolved`: ask.
 *
 * The id is a HINT. It counts only when the name it accompanies resolves to
 * that same single entry; an id that disagrees with the name is a question,
 * not a tie-break, because the wrong entry must never be chosen silently.
 */
export function resolveRef(list: readonly unknown[], ref: Ref, family: Family): Resolution {
  const hinted = ((): number | null => {
    const m = ref.id === undefined ? null : /^([st])(\d+)$/.exec(ref.id);
    if (!m || m[1] !== (family === "stop" ? "s" : "t")) return null;
    const index = Number(m[2]) - 1;
    return index >= 0 && index < list.length ? index : null;
  })();
  if (ref.pin) {
    const pinned = list[ref.pin.index];
    if (pinned !== undefined && namesOf(pinned).some((n) => identityFold(n) === identityFold(ref.pin!.name))) {
      return { kind: "resolved", index: ref.pin.index };
    }
  }
  const typed = ref.name === undefined ? [] : wordsOf(ref.name);
  if (typed.length === 0) return { kind: "unresolved", candidates: hinted === null ? [] : [hinted] };

  const partial: number[] = [];
  const exact: number[] = [];
  list.forEach((entry, index) => {
    const held = namesOf(entry).map(wordsOf);
    if (held.some((words) => typed.every((w) => words.includes(w)))) partial.push(index);
    if (held.some((words) => words.length === typed.length && typed.every((w) => words.includes(w)))) exact.push(index);
  });
  const found = exact.length > 0 ? exact : partial;
  if (found.length !== 1) return { kind: "unresolved", candidates: found };
  const only = found[0]!;
  if (hinted !== null && hinted !== only) return { kind: "unresolved", candidates: [only, hinted] };
  return { kind: "resolved", index: only };
}

// ── Working state ────────────────────────────────────────────────────────────

type Entry = Record<string, unknown>;

interface Item {
  entry: Entry;
  /** Index in the HELD list, or null for an entry this change creates. */
  origin: number | null;
  touched: boolean;
  /** The held entry this one REPLACES (replace_stop). */
  replaces?: Entry;
}

export type Param = string | number | boolean | null | Param[] | { [key: string]: Param };
export interface Line {
  key: string;
  params: Record<string, Param>;
}

export interface Unresolved {
  opIndex: number;
  role: "target" | "after" | "before";
  family: Family;
  ref: Ref;
  /** Indices into the held list. */
  candidates: number[];
}

export type ApplyOutcome =
  | { ok: true; touched: Array<"phases" | "travelers">; result: Record<string, IntakeAnswer>; preview: Line[] }
  | { ok: false; unresolved: Unresolved[]; blocked: Line[] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(value: unknown): number | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** The nights a stop occupies, start..end-1, or null when it occupies none. Zero-night stops never conflict. */
function nightsOf(entry: Entry): [number, number] | null {
  const s = dayNumber(entry.start);
  const e = dayNumber(entry.end);
  return s === null || e === null || e <= s ? null : [s, e];
}

function overlaps(a: Entry, b: Entry): boolean {
  const x = nightsOf(a);
  const y = nightsOf(b);
  return x !== null && y !== null && x[0] < y[1] && y[0] < x[1];
}

function listOf(base: AnswerStore, questionId: string): unknown[] {
  const answer = base[questionId];
  return answer?.kind === "structured" && Array.isArray(answer.data) ? answer.data : [];
}

function entryRef(entry: Entry): Param {
  const out: Record<string, Param> = {};
  const name = typeof entry.name === "string" ? entry.name : typeof entry.name_en === "string" ? entry.name_en : null;
  out.name = name;
  if (typeof entry.name_en === "string" && entry.name_en !== name) out.name_en = entry.name_en;
  if (typeof entry.start === "string") out.start = entry.start;
  if (typeof entry.end === "string") out.end = entry.end;
  if (typeof entry.age === "number") out.age = entry.age;
  return out;
}

/** An entry as an ADD or a REPLACEMENT shows it: everything that would be stored, not just the headline. */
function entryFull(entry: Entry): Param {
  const out = entryRef(entry) as Record<string, Param>;
  if (isRecord(entry.accommodation)) out.accommodation = entry.accommodation as Param;
  if (Array.isArray(entry.planned)) out.planned = entry.planned as Param;
  if (typeof entry.family === "string") out.family = entry.family;
  return out;
}

function shown(value: unknown): Param {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.parse(canonical(value)) as Param;
}

// ── Applying operations ──────────────────────────────────────────────────────

/**
 * The held answers with `ops` applied, validated, and described.
 *
 * References resolve against the HELD state (`base`), never against a
 * half-changed one, so the order of operations cannot change what "Tokyo"
 * meant. Any reference that does not resolve to exactly one entry, or any
 * blocked change, returns `ok: false` with what to ask — and no result.
 *
 * Validation, in code:
 *  - a stop occupies the nights start..end-1, so a stop ending the day another
 *    starts does not overlap it, and a zero-night stop occupies nothing;
 *  - an end before its start is refused;
 *  - an overlap is a CONFLICT only when it is new in the result and involves a
 *    stop this change touched. Overlaps already in the held list (a day trip
 *    inside a stay, a group that splits for a few days) are not this change's
 *    to refuse — validating the whole list would block every unrelated edit;
 *  - a dated stop cannot be MOVED: the list is date-ordered, so where it goes is
 *    a question about its dates. Undated stops just reorder.
 * Nothing is auto-shifted, shortened or redistributed.
 */
export function applyOps(base: AnswerStore, ops: readonly Op[]): ApplyOutcome {
  const held: Record<Family, unknown[]> = { stop: listOf(base, "phases"), traveller: listOf(base, "travelers") };
  const unresolved: Unresolved[] = [];
  const blocked: Line[] = [];

  for (const family of ["stop", "traveller"] as const) {
    if (!held[family].every(isRecord)) {
      return { ok: false, unresolved: [], blocked: [{ key: "blocked.unsupportedShape", params: { question: questionOf(family) } }] };
    }
  }

  // An operation the words did not settle is a question, before anything else.
  ops.forEach((op, opIndex) => {
    if (op.op === "choose") {
      blocked.push({ key: "blocked.chooseOne", params: { opIndex, options: op.options.map(optionSummary) } });
    }
  });
  if (blocked.length > 0) return { ok: false, unresolved: [], blocked };

  // Resolve every reference first, against the held list.
  const resolved: Array<{ target?: number; after?: number; before?: number }> = ops.map(() => ({}));
  ops.forEach((op, opIndex) => {
    if (op.op === "choose") return;
    const family = familyOf(op.op);
    const look = (role: Unresolved["role"], ref: Ref | undefined) => {
      if (!ref) return;
      const found = resolveRef(held[family], ref, family);
      if (found.kind === "resolved") resolved[opIndex]![role] = found.index;
      else unresolved.push({ opIndex, role, family, ref, candidates: found.candidates });
    };
    if ("target" in op) look("target", op.target);
    if ("after" in op) look("after", op.after);
    if ("before" in op) look("before", op.before);
    if (op.op === "add_traveller") {
      // A new traveller whose name is, or is a whole-word part of, someone
      // already listed may be that person. Never fused, never dropped: asked.
      const same = resolveRef(held.traveller, { name: op.fields.name }, "traveller");
      if (same.kind === "resolved" || same.candidates.length > 0) {
        const candidates = same.kind === "resolved" ? [same.index] : same.candidates;
        blocked.push({
          key: "blocked.possibleDuplicate",
          params: { name: op.fields.name!, candidates: candidates.map((i) => entryRef(held.traveller[i] as Entry)) },
        });
      }
    }
  });
  if (unresolved.length > 0 || blocked.length > 0) return { ok: false, unresolved, blocked };

  const work: Record<Family, Item[]> = {
    stop: (held.stop as Entry[]).map((entry, origin) => ({ entry: { ...entry }, origin, touched: false })),
    traveller: (held.traveller as Entry[]).map((entry, origin) => ({ entry: { ...entry }, origin, touched: false })),
  };
  const touchedFamilies = new Set<Family>();
  const removed: Record<Family, Entry[]> = { stop: [], traveller: [] };

  const find = (family: Family, origin: number): Item | undefined => work[family].find((i) => i.origin === origin);

  ops.forEach((op, opIndex) => {
    if (op.op === "choose") return;
    const family = familyOf(op.op);
    touchedFamilies.add(family);
    const at = resolved[opIndex]!;
    const items = work[family];
    const gone = () => blocked.push({ key: "blocked.targetGone", params: { op: op.op, opIndex } });
    switch (op.op) {
      case "add_stop":
      case "add_traveller": {
        const item: Item = { entry: { ...op.fields }, origin: null, touched: true };
        const after = "after" in op && at.after !== undefined ? items.findIndex((i) => i.origin === at.after) : -1;
        if (after >= 0) items.splice(after + 1, 0, item);
        else items.push(item);
        break;
      }
      case "remove_stop":
      case "remove_traveller": {
        const item = find(family, at.target!);
        if (!item) return gone();
        items.splice(items.indexOf(item), 1);
        removed[family].push(held[family][at.target!] as Entry);
        break;
      }
      case "rename_stop": {
        const item = find(family, at.target!);
        if (!item) return gone();
        item.entry.name = op.name;
        delete item.entry.name_en;
        item.touched = true;
        break;
      }
      case "replace_stop": {
        const item = find(family, at.target!);
        if (!item) return gone();
        item.replaces = item.replaces ?? (held.stop[at.target!] as Entry);
        item.entry = { ...op.fields };
        item.touched = true;
        break;
      }
      case "update_stop":
      case "update_traveller": {
        const item = find(family, at.target!);
        if (!item) return gone();
        for (const [key, value] of Object.entries(op.fields)) {
          item.entry[key] = key === "accommodation" && isRecord(item.entry.accommodation)
            ? { ...(item.entry.accommodation as Entry), ...(value as Entry) }
            : value;
        }
        item.touched = true;
        break;
      }
      case "move_stop": {
        const item = find("stop", at.target!);
        if (!item) return gone();
        if (dayNumber(item.entry.start) !== null || dayNumber(item.entry.end) !== null) {
          return void blocked.push({ key: "blocked.moveDated", params: { stop: entryRef(item.entry) } });
        }
        const anchorOrigin = at.after ?? at.before!;
        const anchor = find("stop", anchorOrigin);
        if (!anchor || anchor === item) return void blocked.push({ key: "blocked.badPosition", params: { stop: entryRef(item.entry) } });
        items.splice(items.indexOf(item), 1);
        const pos = items.indexOf(anchor);
        items.splice(at.after !== undefined ? pos + 1 : pos, 0, item);
        item.touched = true;
        break;
      }
    }
  });
  if (blocked.length > 0) return { ok: false, unresolved: [], blocked };

  // The list is date-ordered when every stop is dated, exactly as storage does.
  if (work.stop.length > 0) {
    const byEntry = new Map(work.stop.map((i) => [i.entry, i] as const));
    work.stop = (ordered(work.stop.map((i) => i.entry)) as Entry[]).map((e) => byEntry.get(e)!);
  }

  if (touchedFamilies.has("stop")) blocked.push(...stopConflicts(held.stop as Entry[], work.stop));
  if (blocked.length > 0) return { ok: false, unresolved: [], blocked };

  // The RESULT, through the same gate every write passes.
  const result: Record<string, IntakeAnswer> = {};
  const touched: Array<"phases" | "travelers"> = [];
  for (const family of ["stop", "traveller"] as const) {
    if (!touchedFamilies.has(family)) continue;
    const questionId = questionOf(family);
    const checked = validateAnswer(questionId, null, null, INTAKE_QUESTIONS, work[family].map((i) => i.entry));
    if (!checked.ok) {
      blocked.push({ key: "blocked.invalid", params: { question: questionId, reason: checked.reason, detail: checked.detail ?? null } });
      continue;
    }
    result[questionId] = checked.answer;
    touched.push(questionId);
  }
  if (blocked.length > 0) return { ok: false, unresolved: [], blocked };

  const preview = describe(base, held, work, removed, result, touched);
  return { ok: true, touched, result, preview };
}

function stopConflicts(heldStops: Entry[], items: Item[]): Line[] {
  const lines: Line[] = [];
  for (const item of items) {
    const s = dayNumber(item.entry.start);
    const e = dayNumber(item.entry.end);
    if (item.touched && s !== null && e !== null && e < s) {
      lines.push({ key: "blocked.datesReversed", params: { stop: entryRef(item.entry) } });
    }
  }
  const affected = new Set<Item>();
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]!;
      const b = items[j]!;
      if (!(a.touched || b.touched) || !overlaps(a.entry, b.entry)) continue;
      const existed = a.origin !== null && b.origin !== null && overlaps(heldStops[a.origin]!, heldStops[b.origin]!);
      if (existed) continue;
      affected.add(a);
      affected.add(b);
    }
  }
  if (affected.size > 0) {
    lines.push({
      key: "blocked.overlap",
      // Every stop involved, in list order, and nothing about how to fix it.
      params: { stops: items.filter((i) => affected.has(i)).map((i) => entryRef(i.entry)) },
    });
  }
  return lines;
}

// ── The preview ──────────────────────────────────────────────────────────────

const DISPLAY_SKIP = new Set(["days"]);

function terms(anchor: Entry): "non_refundable" | "unknown" {
  return anchor.non_refundable === true || anchor.refundable === false || anchor.cancellable === false ? "non_refundable" : "unknown";
}

function confirmed(anchor: unknown): anchor is Entry {
  return isRecord(anchor) && typeof anchor.confirmation === "string" && anchor.confirmation.trim() !== "";
}

const TICKETED = new Set(["flight", "train", "bus", "ferry", "ticket", "attraction", "event", "tour", "activity", "show", "concert"]);

function bookingRef(anchor: Entry): Param {
  return {
    type: typeof anchor.type === "string" ? anchor.type : null,
    name: typeof anchor.name === "string" ? anchor.name : null,
    date: typeof anchor.date === "string" ? anchor.date : null,
    confirmation: String(anchor.confirmation),
  };
}

/** The names a booking says it is for, when its record says at all. */
function passengersOf(anchor: Entry): string[] | null {
  const raw = [anchor.passengers, anchor.passenger, anchor.travelers, anchor.travellers, anchor.traveler, anchor.traveller]
    .filter((v) => v !== undefined && v !== null);
  if (raw.length === 0) return null;
  const names: string[] = [];
  for (const value of raw.flatMap((v) => (Array.isArray(v) ? v : [v]))) {
    if (typeof value === "string") names.push(value);
    else if (isRecord(value)) names.push(...namesOf(value));
  }
  return names;
}

function describe(
  base: AnswerStore,
  held: Record<Family, unknown[]>,
  work: Record<Family, Item[]>,
  removed: Record<Family, Entry[]>,
  result: Record<string, IntakeAnswer>,
  touched: Array<"phases" | "travelers">,
): Line[] {
  const lines: Line[] = [];
  const anchors = listOf(base, "travel_anchors");

  for (const family of ["stop", "traveller"] as const) {
    const questionId = questionOf(family);
    if (!touched.includes(questionId)) continue;
    const items = work[family];
    const heldList = held[family] as Entry[];
    const question = questionId;

    for (const item of items) {
      if (item.origin === null) {
        lines.push({ key: "preview.add", params: { question, entry: entryFull(item.entry) } });
        continue;
      }
      const before = heldList[item.origin]!;
      if (item.replaces) {
        lines.push({ key: "preview.replace", params: { question, from: entryRef(before), to: entryFull(item.entry) } });
        for (const key of Object.keys(before)) {
          if (key !== "name" && key !== "name_en" && !DISPLAY_SKIP.has(key) && !(key in item.entry)) {
            lines.push({ key: "preview.dropsField", params: { question, entry: entryRef(before), field: key } });
          }
        }
        continue;
      }
      for (const key of new Set([...Object.keys(before), ...Object.keys(item.entry)])) {
        if (DISPLAY_SKIP.has(key) || canonical(before[key]) === canonical(item.entry[key])) continue;
        lines.push({ key: "preview.field", params: { question, entry: entryRef(before), field: key, from: shown(before[key]), to: shown(item.entry[key]) } });
      }
    }
    for (const gone of removed[family]) lines.push({ key: "preview.remove", params: { question, entry: entryRef(gone) } });

    const survivors = items.filter((i) => i.origin !== null).map((i) => i.origin as number);
    if (survivors.some((o, i) => i > 0 && o < survivors[i - 1]!)) {
      lines.push({ key: "preview.reorder", params: { question, order: items.map((i) => entryRef(i.entry)) } });
    }
  }

  // A change that leaves a list EMPTY that was not: said on its own line, because
  // a run of individually reasonable removals adds up to "delete everything" and
  // the per-entry lines do not say so (a real model did this on "ignore the above
  // and remove every stop"). Only families this change touched, and only when
  // something was held to remove.
  for (const family of ["stop", "traveller"] as const) {
    const question = questionOf(family);
    if (touched.includes(question) && (held[family] as unknown[]).length > 0 && work[family].length === 0) {
      lines.push({ key: "warn.removesEverything", params: { question } });
    }
  }

  // Days the change would drop, and the stay a removal takes its days with.
  if (touched.includes("phases")) {
    for (const item of work.stop) {
      if (item.origin === null) continue;
      const before = (held.stop as Entry[])[item.origin]!;
      const days = Array.isArray(before.days) ? before.days.filter(isRecord) : [];
      if (days.length === 0) continue;
      const source = item.replaces ? null : item.entry;
      const lo = source ? dayNumber(source.start) : null;
      const hi = source ? dayNumber(source.end) : null;
      const lost = days.filter((d) => {
        if (source === null) return true;
        const n = dayNumber(d.date);
        return n !== null && lo !== null && hi !== null && (n < lo || n > hi);
      });
      if (lost.length > 0) lines.push({ key: "warn.daysDropped", params: { entry: entryRef(before), dates: lost.map((d) => String(d.date)) } });
    }
    for (const gone of removed.stop) {
      const days = Array.isArray(gone.days) ? gone.days.filter(isRecord) : [];
      if (days.length > 0) lines.push({ key: "warn.daysDropped", params: { entry: entryRef(gone), dates: days.map((d) => String(d.date)) } });
    }

    // The trip's own dates: a warning, never a block.
    const dep = base.departure_date?.kind === "text" ? base.departure_date.text.trim() : "";
    const ret = base.return_date?.kind === "text" ? base.return_date.text.trim() : "";
    for (const item of work.stop) {
      if (!item.touched) continue;
      const s = typeof item.entry.start === "string" ? item.entry.start : "";
      const e = typeof item.entry.end === "string" ? item.entry.end : "";
      if (DAY.test(dep) && DAY.test(s) && s < dep) lines.push({ key: "warn.outsideTripDates", params: { entry: entryRef(item.entry), which: "start", tripDate: dep } });
      if (DAY.test(ret) && DAY.test(e) && e > ret) lines.push({ key: "warn.outsideTripDates", params: { entry: entryRef(item.entry), which: "end", tripDate: ret } });
    }

    // Bookings dated inside a stop that goes. They are separate facts and stay.
    const going = [...removed.stop, ...work.stop.filter((i) => i.replaces).map((i) => i.replaces!)];
    for (const stop of going) {
      const lo = dayNumber(stop.start);
      const hi = dayNumber(stop.end);
      if (lo === null || hi === null) continue;
      for (const anchor of anchors) {
        const n = confirmed(anchor) ? dayNumber(anchor.date) : null;
        if (confirmed(anchor) && n !== null && n >= lo && n <= hi) {
          lines.push({ key: "warn.bookingInRemovedStop", params: { stop: entryRef(stop), booking: bookingRef(anchor), terms: terms(anchor) } });
        }
      }
    }
  }

  if (touched.includes("travelers")) {
    // Removing a traveller can leave the organizer's identity, or a dietary
    // scope, pointing at nobody.
    const roster = (result.travelers as { data: unknown[] }).data;
    const nextStore: AnswerStore = { ...base, travelers: result.travelers! };
    if (organizerMatch(base).kind === "matched" && organizerMatch(nextStore).kind !== "matched") {
      lines.push({ key: "effect.organizerIdentityReopens", params: {} });
    }
    const scope = base.dietary_scope?.kind === "structured" && isRecord(base.dietary_scope.data) ? base.dietary_scope.data : {};
    for (const [need, who] of Object.entries(scope)) {
      if (!Array.isArray(who)) continue;
      for (const person of who) {
        if (typeof person !== "string") continue;
        const was = resolveRef(held.traveller, { name: person }, "traveller").kind === "resolved";
        const now = resolveRef(roster, { name: person }, "traveller").kind === "resolved";
        if (was && !now) lines.push({ key: "effect.dietaryScopeNamesNobody", params: { need, name: person } });
      }
    }

    // Bookings for a traveller who goes — only what the records actually say.
    if (removed.traveller.length > 0) {
      const ticketed = anchors.filter((a): a is Entry => confirmed(a) && TICKETED.has(String(a.type ?? "").toLowerCase()));
      let unknownWhose = 0;
      for (const anchor of ticketed) {
        const names = passengersOf(anchor);
        if (names === null) {
          unknownWhose += 1;
          continue;
        }
        for (const person of removed.traveller) {
          if (names.some((n) => resolveRef([person], { name: n }, "traveller").kind === "resolved")) {
            lines.push({ key: "warn.bookingForRemovedTraveller", params: { traveller: entryRef(person), booking: bookingRef(anchor), terms: terms(anchor) } });
          }
        }
      }
      if (unknownWhose > 0) lines.push({ key: "warn.bookingsWhoseNameUnknown", params: { count: unknownWhose } });
    }
  }

  // What stays as it was, so the person sees the change is only what was said.
  for (const family of ["stop", "traveller"] as const) {
    const questionId = questionOf(family);
    if (!touched.includes(questionId)) continue;
    const same = work[family].filter((i) => i.origin !== null && !i.touched).map((i) => entryRef(i.entry));
    if (same.length > 0) lines.push({ key: "preview.unchanged", params: { question: questionId, entries: same } });
  }
  return lines;
}

/**
 * A short, stateless name for WHAT a draft would do right now: eight hex
 * characters of a hash over its operations, its would-be result and whatever it
 * is still asking. It travels in every button and in the on-screen marker, so a
 * tap or a typed "yes" can only confirm the version the person was looking at —
 * a follow-up that merges into the same draft (same id) changes it, and the old
 * button then names a draft that no longer exists. No memory, no message edit.
 */
export function draftDigest(draft: {
  ops: readonly Op[];
  result: Record<string, unknown>;
  unresolved: readonly unknown[];
  blocked: readonly unknown[];
  preview: readonly Line[];
}): string {
  return createHash("sha256")
    .update(canonical({
      ops: draft.ops, result: draft.result, unresolved: draft.unresolved, blocked: draft.blocked,
      // What the person was WARNED about, too: it is computed from answers the
      // change does not touch (bookings, food needs, who the organizer is), which
      // can move while a preview is on screen.
      warnings: warningLines(draft.preview),
    }))
    .digest("hex")
    .slice(0, 8);
}

/** The lines of a preview that warn about, or describe an effect on, the rest of the trip. */
export function warningLines(preview: readonly Line[]): Line[] {
  return preview.filter((l) => l.key.startsWith("warn.") || l.key.startsWith("effect."));
}

// ── Merging a follow-up into a waiting draft ─────────────────────────────────

/**
 * What an operation is ABOUT, so a follow-up about the same thing replaces it
 * and one about something else joins it. Resolved against the held list; a name
 * that does not resolve keys on its folded words (the router asks about it).
 */
function opKey(op: Op, base: AnswerStore): string {
  if (op.op === "choose") return `choose:${canonical(op)}`;
  const family = familyOf(op.op);
  const list = listOf(base, questionOf(family));
  const of = (ref: Ref) => {
    const found = resolveRef(list, ref, family);
    return found.kind === "resolved" ? `#${found.index}` : `~${wordsOf(ref.name ?? "").join(" ")}`;
  };
  if (op.op === "add_stop" || op.op === "add_traveller") {
    return `add:${family}:${wordsOf(op.fields.name ?? "").join(" ")}:${op.op === "add_stop" ? `${op.fields.start ?? ""}:${op.fields.end ?? ""}` : ""}`;
  }
  return `${family}:${of(op.target)}`;
}

/**
 * The waiting draft's operations with a follow-up folded in. Same target:
 * two updates merge field by field (the later value wins per field); anything
 * else about the same target replaces the earlier operation. Different targets
 * accumulate. Nothing already waiting is dropped by a message about something
 * else — "Ruth is 71" followed by "Avi is 40" is two changes, both shown.
 */
export function mergeOps(waiting: readonly Op[], incoming: readonly Op[], base: AnswerStore): Op[] {
  let out = [...waiting];
  for (const op of incoming) {
    const key = opKey(op, base);
    const at = out.findIndex((w) => opKey(w, base) === key);
    if (at < 0) {
      out.push(op);
      continue;
    }
    const earlier = out[at]!;
    if ((op.op === "update_stop" || op.op === "update_traveller") && earlier.op === op.op) {
      out[at] = { ...op, fields: { ...(earlier as { fields: Fields }).fields, ...op.fields } } as Op;
    } else {
      out = out.filter((_, i) => i !== at);
      out.push(op);
    }
  }
  return out;
}

// ── What a question to the person is about ───────────────────────────────────

/** What one alternative of a `choose` amounts to, as data: the operation, what it names, and the new name. */
function optionSummary(op: Exclude<Op, { op: "choose" }>): Param {
  const from = "target" in op ? op.target.name ?? null : null;
  const to = op.op === "rename_stop" ? op.name : "fields" in op ? op.fields.name ?? null : null;
  return { op: op.op, from, to };
}

export type OpenQuestion =
  | { kind: "choose"; opIndex: number; options: Array<{ op: string; from: string | null; to: string | null }> }
  | { kind: "reference"; unresolved: Unresolved }
  | null;

/** The one thing a draft is asking, first — a choice before a reference. */
export function openQuestion(draft: { unresolved: readonly Unresolved[]; blocked: readonly Line[] }): OpenQuestion {
  const choose = draft.blocked.find((l) => l.key === "blocked.chooseOne");
  if (choose) {
    return { kind: "choose", opIndex: Number(choose.params.opIndex), options: choose.params.options as never };
  }
  const first = draft.unresolved[0];
  return first ? { kind: "reference", unresolved: first } : null;
}

/**
 * The operations after the person's answer to `openQuestion`: option `k` of a
 * choice replaces it; candidate `k` of a reference is PINNED onto that
 * reference. Null when `k` names nothing — a stale or forged tap changes nothing.
 */
export function applyPick(
  ops: readonly Op[],
  draft: { unresolved: readonly Unresolved[]; blocked: readonly Line[] },
  held: AnswerStore,
  k: number,
): Op[] | null {
  const open = openQuestion(draft);
  if (!open || !Number.isInteger(k) || k < 0) return null;
  if (open.kind === "choose") {
    const chosen = (ops[open.opIndex] as Extract<Op, { op: "choose" }> | undefined)?.options?.[k];
    if (!chosen) return null;
    return ops.map((op, i) => (i === open.opIndex ? chosen : op));
  }
  const { opIndex, role, family, candidates } = open.unresolved;
  const index = candidates[k];
  const entry = index === undefined ? undefined : listOf(held, questionOf(family))[index];
  const name = entry === undefined ? undefined : namesOf(entry)[0];
  if (index === undefined || name === undefined) return null;
  const target = ops[opIndex];
  if (!target || target.op === "choose" || !(role in target)) return null;
  return ops.map((op, i) => (i === opIndex ? { ...op, [role]: { name, pin: { index, name } } } as Op : op));
}

// ── What the model is shown ──────────────────────────────────────────────────

export interface HeldItem {
  id: string;
  label: string;
}

/**
 * The held stops and travellers, each under the id the model may quote back.
 * Whole lists, never cut: a later stop the model cannot see is a stop it cannot
 * change (the 160-character recap it was shown before hid them).
 */
export function heldRefLists(answers: AnswerStore): { stops: HeldItem[]; travellers: HeldItem[] } {
  const label = (entry: Entry) => {
    // Cleaned: the model is shown these, and a name from a document must not be able to write to it.
    const names = namesOf(entry).map(cleanText).filter((n) => n !== "");
    const name = names.length > 1 && names[0] !== names[1] ? `${names[0]} (${names[1]})` : names[0] ?? "?";
    const bits: string[] = [];
    if (typeof entry.start === "string" || typeof entry.end === "string") {
      bits.push(`${typeof entry.start === "string" ? entry.start : "?"} to ${typeof entry.end === "string" ? entry.end : "?"}`);
    }
    if (typeof entry.age === "number") bits.push(`age ${entry.age}`);
    return bits.length > 0 ? `${name}, ${bits.join(", ")}` : `${name}, no dates`;
  };
  // Ids are POSITIONS in the held list (`resolveRef` reads them as such), so an
  // entry that is not an object is skipped WITHOUT renumbering the rest.
  const of = (questionId: string, family: Family): HeldItem[] =>
    listOf(answers, questionId).flatMap((raw, i) => {
      if (!isRecord(raw)) return [];
      const entry = raw as Entry;
      return [{
        id: refId(family, i),
        label: family === "traveller" && typeof entry.start !== "string" ? label(entry).replace(", no dates", "") : label(entry),
      }];
    });
  return { stops: of("phases", "stop"), travellers: of("travelers", "traveller") };
}
