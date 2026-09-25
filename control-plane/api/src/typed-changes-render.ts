/**
 * What the organizer SEES for a waiting typed change (#206): the draft's
 * data — `{ key, params }` lines — put into words in the interview's current
 * language, with the buttons that answer it.
 *
 * The wording is the strings table's (`intake-copy.ts`, English and Hebrew, kept
 * in step by a parity test); this module only assembles it. It renders at SEND
 * time, so the language is whatever the session speaks now.
 *
 * Three shapes, and only the first can be confirmed:
 *  - a change that validated: what changes, what stays, what to watch out for —
 *    with Yes and No;
 *  - a question the words left open (which Ruth? rename or replace?): one button
 *    per answer, and No;
 *  - a conflict (an overlap, a dated stop asked to move): what collides and what
 *    is wanted from them, in words — no Yes, because nothing is proposed yet.
 */
import { changeCallbackData } from "./chat-router.js";
import { readableDate, recapLabel, uiString, type Language } from "./intake-copy.js";
import { INTAKE_QUESTIONS } from "./interview.js";
import { openQuestion, type Line, type Param, type Unresolved } from "./typed-changes.js";
import type { Draft } from "./typed-changes-store.js";

export interface RenderedChange {
  text: string;
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
}

const fill = (template: string, params: Record<string, string>): string =>
  Object.entries(params).reduce((text, [k, v]) => text.split(`{${k}}`).join(v), template);

const isObject = (p: Param | undefined): p is { [key: string]: Param } =>
  typeof p === "object" && p !== null && !Array.isArray(p);

function dateText(value: string, language: Language): string {
  return readableDate(value, language) ?? value;
}

/** "Tokyo, 19 September 2026 – 24 September 2026" — a stop or a traveller, as a person would say it. */
export function entryText(entry: Param | undefined, language: Language): string {
  if (!isObject(entry)) return typeof entry === "string" ? entry : "?";
  const name = typeof entry.name === "string" ? entry.name : "?";
  const bits: string[] = [];
  const start = typeof entry.start === "string" ? dateText(entry.start, language) : null;
  const end = typeof entry.end === "string" ? dateText(entry.end, language) : null;
  if (start && end) bits.push(`${start} – ${end}`);
  else if (start || end) bits.push((start ?? end)!);
  if (typeof entry.age === "number") bits.push(String(entry.age));
  return bits.length > 0 ? `${name} (${bits.join(", ")})` : name;
}

function valueText(value: Param | undefined, language: Language): string {
  if (value === null || value === undefined) return uiString("change.value.none", language);
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateText(value, language) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function bookingText(booking: Param | undefined): string {
  if (!isObject(booking)) return "?";
  const name = [booking.type, booking.name].filter((p) => typeof p === "string").join(" ");
  return `${name || "booking"} (${String(booking.confirmation ?? "?")})`;
}

function listText(items: Param | undefined, language: Language): string {
  return Array.isArray(items) ? items.map((i) => entryText(i, language)).join(", ") : "";
}

function fieldLabel(field: string, language: Language): string {
  const key = `change.field.${field}`;
  const label = uiString(key, language);
  return label === key ? uiString("change.field.generic", language) : label;
}

/** One line of a draft, in words. Empty for a line this renderer does not know. */
export function lineText(line: Line, language: Language): string {
  const p = line.params;
  const t = (key: string, params: Record<string, string> = {}) => fill(uiString(key, language), params);
  switch (line.key) {
    case "preview.field":
      return t("change.line.field", {
        entry: entryText(p.entry, language),
        field: fieldLabel(String(p.field), language),
        from: valueText(p.from, language),
        to: valueText(p.to, language),
      });
    case "preview.add": return t("change.line.add", { entry: entryText(p.entry, language) });
    case "preview.remove": return t("change.line.remove", { entry: entryText(p.entry, language) });
    case "preview.replace": return t("change.line.replace", { from: entryText(p.from, language), to: entryText(p.to, language) });
    case "preview.dropsField":
      return t("change.line.dropsField", { entry: entryText(p.entry, language), field: fieldLabel(String(p.field), language) });
    case "preview.reorder": return t("change.line.reorder", { order: listText(p.order, language) });
    case "preview.unchanged": return t("change.line.unchanged", { entries: listText(p.entries, language) });
    case "warn.daysDropped":
      return t("change.warn.daysDropped", {
        entry: entryText(p.entry, language),
        dates: Array.isArray(p.dates) ? p.dates.map((d) => dateText(String(d), language)).join(", ") : "",
      });
    case "warn.outsideTripDates":
      return t(`change.warn.outsideTripDates.${p.which === "end" ? "end" : "start"}`, {
        entry: entryText(p.entry, language),
        tripDate: dateText(String(p.tripDate), language),
      });
    case "warn.bookingInRemovedStop":
      return t(`change.warn.bookingInRemovedStop.${p.terms === "non_refundable" ? "non_refundable" : "unknown"}`, {
        booking: bookingText(p.booking), stop: entryText(p.stop, language),
      });
    case "warn.bookingForRemovedTraveller":
      return t(`change.warn.bookingForRemovedTraveller.${p.terms === "non_refundable" ? "non_refundable" : "unknown"}`, {
        booking: bookingText(p.booking), traveller: entryText(p.traveller, language),
      });
    case "warn.removesEverything": return t(p.question === "travelers" ? "change.warn.removesEverything.travelers" : "change.warn.removesEverything.phases");
    case "warn.bookingsWhoseNameUnknown": return t("change.warn.bookingsWhoseNameUnknown", { count: String(p.count ?? "") });
    case "effect.organizerIdentityReopens": return t("change.effect.organizerIdentityReopens");
    case "effect.dietaryScopeNamesNobody":
      return t("change.effect.dietaryScopeNamesNobody", { need: String(p.need), name: String(p.name) });
    case "blocked.overlap": return t("change.blocked.overlap", { stops: listText(p.stops, language) });
    case "blocked.moveDated": return t("change.blocked.moveDated", { stop: entryText(p.stop, language) });
    case "blocked.datesReversed": return t("change.blocked.datesReversed", { stop: entryText(p.stop, language) });
    case "blocked.invalid": return t("change.blocked.invalid", { detail: String(p.detail ?? p.reason ?? "") });
    case "blocked.possibleDuplicate":
      return t("change.blocked.possibleDuplicate", { name: String(p.name), candidates: listText(p.candidates, language) });
    case "blocked.chooseOne": return "";
    default: return t("change.blocked.generic");
  }
}

const noun = (family: Unresolved["family"], language: Language) =>
  uiString(family === "stop" ? "change.noun.stops" : "change.noun.travellers", language);

/** What the recap calls the answer a change is about ("Stops", "Travelers"), for "I wasn't sure what to change about …". */
export function questionNoun(questionId: string, language: Language): string {
  const q = INTAKE_QUESTIONS.find((x) => x.id === questionId);
  return q ? recapLabel(q, language) : questionId;
}

export function renderDraft(draft: Pick<Draft, "id" | "preview" | "unresolved" | "blocked" | "base">, language: Language): RenderedChange {
  const cancel = { text: uiString("change.cancel", language), callback_data: changeCallbackData(draft.id, "cancel") };
  const open = openQuestion(draft);

  if (open?.kind === "choose") {
    const option = (o: { op: string; from: string | null; to: string | null }) =>
      fill(uiString(`change.option.${o.op}`, language), { from: o.from ?? "", to: o.to ?? "" });
    return {
      text: uiString("change.ask.choose", language),
      replyMarkup: {
        inline_keyboard: [
          ...open.options.map((o, k) => [{ text: option(o), callback_data: changeCallbackData(draft.id, "pick", k) }]),
          [cancel],
        ],
      },
    };
  }

  if (open?.kind === "reference") {
    const { unresolved: u } = open;
    const list = draft.base[u.family === "stop" ? "phases" : "travelers"];
    const held = list?.kind === "structured" && Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : [];
    const name = u.ref.name ?? "";
    const text = u.candidates.length > 0
      ? fill(uiString("change.ask.which", language), { name })
      : fill(uiString("change.ask.whichNone", language), { name, noun: noun(u.family, language) });
    const rows = u.candidates.slice(0, 8).map((index, k) => {
      const entry = held[index];
      return [{
        text: entryText(entry ? (entry as unknown as Param) : "?", language).slice(0, 60),
        callback_data: changeCallbackData(draft.id, "pick", k),
      }];
    });
    return { text, replyMarkup: { inline_keyboard: [...rows, [cancel]] } };
  }

  const blocked = draft.blocked.map((l) => lineText(l, language)).filter(Boolean);
  if (blocked.length > 0) {
    return { text: blocked.join("\n\n"), replyMarkup: { inline_keyboard: [[cancel]] } };
  }

  const lines = draft.preview.map((l) => lineText(l, language)).filter(Boolean);
  return {
    text: [uiString("change.header", language), "", ...lines, "", uiString("change.footer", language)].join("\n"),
    replyMarkup: {
      inline_keyboard: [[
        { text: uiString("change.apply", language), callback_data: changeCallbackData(draft.id, "apply") },
        cancel,
      ]],
    },
  };
}

/** Whether the draft can be confirmed at all: it has a result and asks nothing. */
export function confirmable(draft: Pick<Draft, "result" | "unresolved" | "blocked">): boolean {
  return Object.keys(draft.result).length > 0 && draft.unresolved.length === 0 && draft.blocked.length === 0;
}

// ── Saying yes or no in words ────────────────────────────────────────────────

const YES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "sure", "confirm", "confirmed", "apply", "do it", "go ahead",
  "correct", "right", "thats right", "that is right", "sounds good", "looks good", "perfect",
  "כן", "אישור", "אשר", "אשרו", "מאשר", "מאשרת", "בסדר", "אוקיי", "אוקי", "נכון", "סבבה", "בטח", "עדכן", "עדכנו",
]);
const NO = new Set([
  "no", "n", "nope", "cancel", "never mind", "nevermind", "stop", "dont", "do not", "leave it", "forget it",
  "לא", "בטל", "בטלו", "ביטול", "עזוב", "עזבו", "תעזוב", "לא צריך", "לא תודה",
]);

/**
 * A message that is nothing but a yes or a no, folded: case, punctuation and
 * emoji aside. Deterministic on purpose — it is the fast path for the two words
 * everyone types, and it is exact: "yes, and add Nara" is not a yes, it is a
 * change, and goes to interpretation.
 */
export function bareReply(text: string): "yes" | "no" | null {
  const folded = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’׳]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (YES.has(folded)) return "yes";
  if (NO.has(folded)) return "no";
  return null;
}
