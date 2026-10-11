// The organizer's "Stops" section of the plan tools: each stop with its dates
// and where the family sleeps, and the edits the stop routes allow (dates,
// both title languages, accommodation; split at a day; restore from history;
// conflicts a rebuild left behind). server/trip-structure.js decides; this
// screen asks it and says, in words, what it refused and what the organizer
// can do about it.
//
// Organizer-only here AND on the server: a member gets nothing rendered and no
// request made, and the routes answer 403 to a member anyway — hiding is not
// the enforcement.
import { useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveEditGuard } from "./live-updates";
import { type Lang, tr } from "./parity-ui";
import {
  bilingualFromInputs, bilingualText, describeStopError, editableAccommodation, getStopHistory, getStops,
  inputsFromBilingual, patchStop, revertStop, splitStop, stopTitle, STOP_CHANGE_KEYS,
  type StopAccommodation, type StopDates, type StopEntry, type StopFields, type StopHistoryEntry,
  type StopRefusal, type StopsPayload,
} from "./stops";

const DateRange = ({ dates, lang }: { dates?: StopDates | null; lang: Lang }) =>
  dates ? <bdi dir="ltr">{dates.start} – {dates.end}</bdi> : <>{tr(lang, "No dates yet", "עדיין אין תאריכים")}</>;

// Every write here goes through one of these: the refusal (if any) in words,
// the last attempt kept so "keep" / "move to" can resend it with on_outside,
// and every query a stop change reaches refetched on success.
function useStopWrite<T>(lang: Lang, onDone?: (result: T) => void) {
  const client = useQueryClient();
  const [refusal, setRefusal] = useState<StopRefusal | null>(null);
  const last = useRef<((onOutside?: string) => Promise<T>) | null>(null);
  const mutation = useMutation({
    mutationFn: ({ send, onOutside }: { send: (onOutside?: string) => Promise<T>; onOutside?: string }) => send(onOutside),
    onMutate: () => setRefusal(null),
    onSuccess: async (result) => {
      await Promise.all(STOP_CHANGE_KEYS.map((key) => client.invalidateQueries({ queryKey: [key] })));
      onDone?.(result);
    },
    onError: (error) => setRefusal(describeStopError(error, lang)),
  });
  return {
    run(send: (onOutside?: string) => Promise<T>) { last.current = send; mutation.mutate({ send }); },
    retry(onOutside: string) { if (last.current) mutation.mutate({ send: last.current, onOutside }); },
    refusal,
    say(text: string) { setRefusal({ kind: "message", text }); },
    clear() { setRefusal(null); },
    pending: mutation.isPending,
  };
}

function Refusal({ refusal, lang, stopId, stops, onRetry, onReload }: {
  refusal: StopRefusal | null;
  lang: Lang;
  stopId: string;
  stops: StopEntry[];
  onRetry: (onOutside: string) => void;
  onReload: () => void;
}) {
  const targets = stops.filter((s) => !s.unplanned && s.id !== stopId);
  const [target, setTarget] = useState(targets[0]?.id || "");
  const selectId = useId();
  if (!refusal) return null;
  if (refusal.kind === "message") return <p role="alert">{refusal.text}</p>;
  if (refusal.kind === "stale") {
    return (
      <div role="alert">
        <p>{tr(lang, "The stops changed since you opened this form. Reload the latest stops — your draft stays here — and save again.", "התחנות השתנו מאז שפתחתם את הטופס. טענו מחדש את התחנות העדכניות — הטיוטה נשארת כאן — ושמרו שוב.")}</p>
        <button type="button" onClick={onReload}>{tr(lang, "Reload stops", "טעינת התחנות מחדש")}</button>
      </div>
    );
  }
  if (refusal.kind !== "outside") return null;
  const chosen = targets.some((t) => t.id === target) ? target : targets[0]?.id || "";
  return (
    <div role="alert" className="stop-refusal">
      <p>{tr(lang, "These plan items fall outside the new dates:", "פריטי המסלול האלה נמצאים מחוץ לתאריכים החדשים:")}</p>
      <ul>
        {refusal.items.map((item) => (
          <li key={item.item_uid}>
            <bdi dir="ltr">{item.date}</bdi>{item.time ? <> · <bdi>{item.time}</bdi></> : null} — {lang === "he" ? item.text_he : item.text_en || item.text_he}
          </li>
        ))}
      </ul>
      <p>{tr(lang, "Keep them in this stop on their own dates, or move their days to another stop.", "אפשר להשאיר אותם בתחנה הזו בתאריכים שלהם, או להעביר את הימים שלהם לתחנה אחרת.")}</p>
      <div className="parity-actions">
        <button type="button" onClick={() => onRetry("keep")}>{tr(lang, "Keep them where they are", "להשאיר אותם במקומם")}</button>
      </div>
      {targets.length ? (
        <div className="parity-fields">
          <label htmlFor={selectId}>{tr(lang, "Move them to", "להעביר אותם לתחנה")}</label>
          <select id={selectId} value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{stopTitle(t.stop, lang)}</option>)}
          </select>
          <button type="button" disabled={!chosen} onClick={() => onRetry(`move_to:${chosen}`)}>{tr(lang, "Move them and save", "העברה ושמירה")}</button>
        </div>
      ) : null}
    </div>
  );
}

const FIELD_NAMES: Record<string, [string, string]> = {
  dates: ["the dates", "התאריכים"], accommodation: ["the accommodation", "הלינה"], title: ["the title", "הכותרת"],
  tabLabel: ["the tab label", "תווית הלשונית"], emoji: ["the emoji", "האימוג׳י"],
};
function baseValueText(field: string, value: unknown, lang: Lang): string {
  if (value == null) return tr(lang, "none", "אין");
  if (field === "dates") { const d = value as StopDates; return `${d.start} – ${d.end}`; }
  if (field === "accommodation") return bilingualText((value as StopAccommodation).name, lang) || (value as StopAccommodation).name_en || "—";
  return bilingualText(value, lang) || String(value);
}

// A rebuild changed the base under an organizer's edit. The site shows the
// organizer's version (decision 2); this says so, shows the rebuilt one, and
// settles it: keep mine (re-set the same values, so the base they were set
// over is the current one) or use the rebuilt one (revert the stop to the
// trip file).
function Conflict({ entry, payload, lang, reload }: { entry: StopEntry; payload: StopsPayload; lang: Lang; reload: () => unknown }) {
  const write = useStopWrite(lang);
  const conflict = entry.conflict!;
  const fields = conflict.fields.map((f) => (FIELD_NAMES[f] ? tr(lang, ...FIELD_NAMES[f]) : f));
  const joined = fields.join(tr(lang, " and ", " ו"));
  const keepMine = () => {
    const body: StopFields = {};
    const stop = entry.stop as unknown as Record<string, unknown>;
    for (const f of conflict.fields) {
      if (f === "accommodation") body.accommodation = entry.stop.accommodation ? editableAccommodation(entry.stop.accommodation).keep : null;
      else if (f === "dates") body.dates = entry.stop.dates || null;
      else (body as Record<string, unknown>)[f] = stop[f];
    }
    write.run((onOutside) => patchStop(entry.id, onOutside ? { ...body, on_outside: onOutside } : body, payload.revision));
  };
  return (
    <div role="alert" className="stop-conflict">
      <p>{tr(lang, `The trip was rebuilt and changed ${joined} under your edit. The site shows your version.`, `הטיול נבנה מחדש ושינה את ${joined} מתחת לעריכה שלכם. האתר מציג את הגרסה שלכם.`)}</p>
      <ul>
        {conflict.fields.map((f) => (
          <li key={f}>{tr(lang, "Rebuilt version", "הגרסה שנבנתה מחדש")} — {FIELD_NAMES[f] ? tr(lang, ...FIELD_NAMES[f]) : f}: <bdi dir={f === "dates" ? "ltr" : undefined}>{baseValueText(f, conflict.base[f], lang)}</bdi></li>
        ))}
      </ul>
      <div className="parity-actions">
        <button type="button" disabled={write.pending} onClick={keepMine}>{tr(lang, "Keep my version", "להשאיר את הגרסה שלי")}</button>
        <button type="button" disabled={write.pending} onClick={() => write.run((onOutside) => revertStop(entry.id, onOutside ? { on_outside: onOutside } : {}, payload.revision))}>
          {tr(lang, "Use the rebuilt version", "להשתמש בגרסה שנבנתה מחדש")}
        </button>
      </div>
      <Refusal refusal={write.refusal} lang={lang} stopId={entry.id} stops={payload.stops} onRetry={write.retry} onReload={reload} />
    </div>
  );
}

function EditStopForm({ entry, payload, lang, onClose, onReload }: {
  entry: StopEntry; payload: StopsPayload; lang: Lang; onClose: () => void; onReload: () => Promise<StopsPayload | undefined>;
}) {
  const stop = entry.stop;
  const [revision, setRevision] = useState(payload.revision);
  const title0 = inputsFromBilingual(stop.title);
  const [titleHe, setTitleHe] = useState(title0.he);
  const [titleEn, setTitleEn] = useState(title0.en);
  const [start, setStart] = useState(stop.dates?.start || "");
  const [end, setEnd] = useState(stop.dates?.end || "");
  const { keep: accommodation0, dropped } = editableAccommodation(stop.accommodation);
  // A hotel name written as one string (with an optional name_en beside it)
  // stays in that shape; a bilingual one stays bilingual.
  const nameIsString = typeof accommodation0.name === "string";
  const name0 = nameIsString ? { he: accommodation0.name as string, en: accommodation0.name_en || "" } : inputsFromBilingual(accommodation0.name as never);
  const [acc, setAcc] = useState({
    nameHe: name0.he, nameEn: name0.en,
    address: String(accommodation0.address ?? ""), phone: String(accommodation0.phone ?? ""),
    confirmation: String(accommodation0.confirmation ?? ""), location_url: String(accommodation0.location_url ?? ""),
  });
  const write = useStopWrite(lang, onClose);
  const [notice, setNotice] = useState("");
  const ids = { titleHe: useId(), titleEn: useId(), start: useId(), end: useId(), nameHe: useId(), nameEn: useId(), address: useId(), phone: useId(), confirmation: useId(), location: useId() };

  function body(): StopFields {
    const out: StopFields = {};
    const title = bilingualFromInputs(titleHe, titleEn, stop.title);
    if (JSON.stringify(title ?? null) !== JSON.stringify(stop.title ?? null)) out.title = title ?? "";
    if (start !== (stop.dates?.start || "") || end !== (stop.dates?.end || "")) {
      out.dates = start || end ? { start, end } : null;
    }
    const next: StopAccommodation = { ...accommodation0 };
    const set = (key: string, value: unknown) => { if (value === undefined || value === "") delete next[key]; else next[key] = value; };
    if (nameIsString || !accommodation0.name) {
      if (nameIsString) { set("name", acc.nameHe.trim()); set("name_en", acc.nameEn.trim()); }
      else set("name", bilingualFromInputs(acc.nameHe, acc.nameEn));
    } else set("name", bilingualFromInputs(acc.nameHe, acc.nameEn, accommodation0.name as never));
    set("address", acc.address.trim());
    set("phone", acc.phone.trim());
    set("confirmation", acc.confirmation.trim());
    set("location_url", acc.location_url.trim());
    if (JSON.stringify(next) !== JSON.stringify(accommodation0)) {
      out.accommodation = Object.keys(next).length ? next : stop.accommodation ? null : undefined;
      if (out.accommodation === undefined) delete out.accommodation;
    }
    return out;
  }

  function save() {
    const fields = body();
    if (!Object.keys(fields).length) return write.say(tr(lang, "Nothing changed — there is nothing to save.", "לא שונה דבר — אין מה לשמור."));
    const rev = revision;
    setNotice("");
    write.run((onOutside) => patchStop(entry.id, onOutside ? { ...fields, on_outside: onOutside } : fields, rev));
  }

  const input = (id: string, label: string, value: string, onChange: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <label htmlFor={id}>{label}<input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...extra} /></label>
  );
  const range = { min: payload.trip.start || undefined, max: payload.trip.end || undefined };
  return (
    // noValidate: min/max steer the date picker, but the refusal comes from the
    // server, in the site's language — not a browser bubble in the browser's.
    <form
      className="stop-form"
      noValidate
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <fieldset>
        <legend>{tr(lang, "Title", "כותרת")}</legend>
        <div className="parity-fields">
          {input(ids.titleHe, tr(lang, "Hebrew title", "כותרת בעברית"), titleHe, setTitleHe, { dir: "rtl", autoFocus: true })}
          {input(ids.titleEn, tr(lang, "English title", "כותרת באנגלית"), titleEn, setTitleEn, { dir: "ltr" })}
        </div>
      </fieldset>
      <fieldset>
        <legend>{tr(lang, "Dates", "תאריכים")}</legend>
        {payload.trip.start && payload.trip.end ? (
          <p className="stop-hint">{tr(lang, "Inside the trip: ", "בתוך הטיול: ")}<bdi dir="ltr">{payload.trip.start} – {payload.trip.end}</bdi></p>
        ) : null}
        <div className="parity-fields">
          {input(ids.start, tr(lang, "First day", "יום ראשון"), start, setStart, { type: "date", ...range })}
          {input(ids.end, tr(lang, "Last day", "יום אחרון"), end, setEnd, { type: "date", ...range })}
        </div>
      </fieldset>
      <fieldset>
        <legend>{tr(lang, "Accommodation", "לינה")}</legend>
        {dropped.length ? (
          <p className="stop-hint">{tr(lang,
            `Saving a changed hotel replaces it whole. These details are not editable here and will not be kept: ${dropped.join(", ")}.`,
            `שמירת לינה ששונתה מחליפה אותה כולה. הפרטים האלה לא ניתנים לעריכה כאן ולא יישמרו: ${dropped.join(", ")}.`)}</p>
        ) : null}
        <div className="parity-fields">
          {nameIsString ? <>
            {input(ids.nameHe, tr(lang, "Hotel name", "שם המלון"), acc.nameHe, (v) => setAcc({ ...acc, nameHe: v }), { dir: "auto" })}
            {input(ids.nameEn, tr(lang, "English hotel name (optional)", "שם המלון באנגלית (לא חובה)"), acc.nameEn, (v) => setAcc({ ...acc, nameEn: v }), { dir: "ltr" })}
          </> : <>
            {input(ids.nameHe, tr(lang, "Hotel name (Hebrew)", "שם המלון (עברית)"), acc.nameHe, (v) => setAcc({ ...acc, nameHe: v }), { dir: "rtl" })}
            {input(ids.nameEn, tr(lang, "Hotel name (English)", "שם המלון (אנגלית)"), acc.nameEn, (v) => setAcc({ ...acc, nameEn: v }), { dir: "ltr" })}
          </>}
          {input(ids.address, tr(lang, "Address", "כתובת"), acc.address, (v) => setAcc({ ...acc, address: v }))}
          {input(ids.phone, tr(lang, "Phone", "טלפון"), acc.phone, (v) => setAcc({ ...acc, phone: v }), { dir: "ltr", type: "tel" })}
          {input(ids.confirmation, tr(lang, "Confirmation number", "מספר אישור"), acc.confirmation, (v) => setAcc({ ...acc, confirmation: v }), { dir: "ltr" })}
          {input(ids.location, tr(lang, "Map link", "קישור למפה"), acc.location_url, (v) => setAcc({ ...acc, location_url: v }), { dir: "ltr", type: "url", placeholder: "https://" })}
        </div>
      </fieldset>
      <Refusal refusal={write.refusal} lang={lang} stopId={entry.id} stops={payload.stops} onRetry={write.retry}
        onReload={async () => {
          const fresh = await onReload();
          if (fresh) setRevision(fresh.revision);
          write.clear();
          setNotice(tr(lang, "Reloaded the latest stops. Your draft is unchanged — review it and save again.", "התחנות העדכניות נטענו. הטיוטה שלכם לא השתנתה — בדקו אותה ושמרו שוב."));
        }} />
      {notice ? <p role="status">{notice}</p> : null}
      <div className="parity-actions">
        <button type="submit" disabled={write.pending}>{tr(lang, "Save stop", "שמירת התחנה")}</button>
        <button type="button" onClick={onClose}>{tr(lang, "Cancel", "ביטול")}</button>
      </div>
      {write.pending ? <p role="status">{tr(lang, "Saving…", "שומר…")}</p> : null}
    </form>
  );
}

function datesBetween(dates: StopDates): string[] {
  const out: string[] = [];
  for (let d = new Date(`${dates.start}T00:00:00Z`); d <= new Date(`${dates.end}T00:00:00Z`) && out.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function SplitStopForm({ entry, payload, lang, onClose, onDone, reload }: {
  entry: StopEntry; payload: StopsPayload; lang: Lang; onClose: () => void; onDone: (text: string) => void; reload: () => unknown;
}) {
  const dates = entry.stop.dates;
  // Both stops keep a night: the split day is strictly inside the stop.
  const candidates = dates ? datesBetween(dates).filter((d) => d > dates.start && d < dates.end) : [];
  const [at, setAt] = useState("");
  const [he, setHe] = useState("");
  const [en, setEn] = useState("");
  const ids = { at: useId(), he: useId(), en: useId() };
  const write = useStopWrite<{ moved?: { days: string[] }; review?: { detail: string } }>(lang, (result) => {
    const n = result?.moved?.days?.length || 0;
    onDone(n
      ? tr(lang, `Split. ${n === 1 ? "1 day" : `${n} days`} moved to the new stop.`, `פוצל. ${n === 1 ? "יום אחד עבר" : `${n} ימים עברו`} לתחנה החדשה.`)
      : tr(lang, "Split. Nothing planned had to move.", "פוצל. שום דבר מתוכנן לא היה צריך לעבור."));
    onClose();
  });
  if (!dates) return <p role="alert">{tr(lang, "Give this stop dates before splitting it.", "יש לתת לתחנה תאריכים לפני פיצול.")}</p>;
  if (!candidates.length) return <p role="alert">{tr(lang, "This stop is too short to split: each part needs a night.", "התחנה קצרה מכדי לפצל: כל חלק צריך לילה.")}</p>;
  return (
    <form className="stop-form" onSubmit={(e) => {
      e.preventDefault();
      const title = bilingualFromInputs(he, en);
      if (!at) return write.say(tr(lang, "Choose the day to split on.", "יש לבחור את היום שבו מפצלים."));
      if (!title) return write.say(tr(lang, "The new stop needs a title.", "לתחנה החדשה נדרשת כותרת."));
      const rev = payload.revision;
      write.run(() => splitStop(entry.id, { at, new_stop: { title } }, rev));
    }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <p className="stop-hint">{tr(lang, "The new stop starts on the chosen day; this stop ends that morning. Everything planned after it moves to the new stop.", "התחנה החדשה מתחילה ביום שנבחר; התחנה הזו מסתיימת באותו בוקר. כל מה שמתוכנן אחריו עובר לתחנה החדשה.")}</p>
      <div className="parity-fields">
        <label htmlFor={ids.at}>{tr(lang, "Split on", "פיצול ביום")}
          <select id={ids.at} value={at} onChange={(e) => setAt(e.target.value)} autoFocus>
            <option value="">{tr(lang, "Choose a day", "בחירת יום")}</option>
            {candidates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label htmlFor={ids.he}>{tr(lang, "New stop title (Hebrew)", "כותרת התחנה החדשה (עברית)")}<input id={ids.he} dir="rtl" value={he} onChange={(e) => setHe(e.target.value)} /></label>
        <label htmlFor={ids.en}>{tr(lang, "New stop title (English)", "כותרת התחנה החדשה (אנגלית)")}<input id={ids.en} dir="ltr" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      </div>
      <Refusal refusal={write.refusal} lang={lang} stopId={entry.id} stops={payload.stops} onRetry={write.retry} onReload={reload} />
      <div className="parity-actions">
        <button type="submit" disabled={write.pending}>{tr(lang, "Split the stop", "פיצול התחנה")}</button>
        <button type="button" onClick={onClose}>{tr(lang, "Cancel", "ביטול")}</button>
      </div>
    </form>
  );
}

const ACTIONS: Record<string, [string, string]> = {
  update: ["Edited", "נערך"], split: ["Split", "פוצל"], split_create: ["Created by a split", "נוצר בפיצול"],
  from_booking: ["Set from a booking", "נקבע מהזמנה"], revert: ["Restored", "שוחזר"], remove: ["Removed", "הוסר"],
};
function stateSummary(state: StopHistoryEntry["after"], lang: Lang): ReactNode {
  if (!state) return tr(lang, "back to the trip file", "חזרה לקובץ הטיול");
  const f = state.fields || {};
  const parts: ReactNode[] = [];
  if (f.title) parts.push(<span key="t">{bilingualText(f.title, lang)}</span>);
  if (f.dates) parts.push(<DateRange key="d" dates={f.dates as StopDates} lang={lang} />);
  else if ("dates" in f) parts.push(<span key="d">{tr(lang, "no dates", "ללא תאריכים")}</span>);
  const acc = f.accommodation as StopAccommodation | null | undefined;
  if (acc) parts.push(<span key="a">{bilingualText(acc.name, lang) || acc.name_en}</span>);
  else if ("accommodation" in f) parts.push(<span key="a">{tr(lang, "no accommodation", "ללא לינה")}</span>);
  return parts.length ? parts.reduce<ReactNode[]>((acc2, p, i) => (i ? [...acc2, " · ", p] : [p]), []) : "—";
}

function HistoryPanel({ entry, payload, lang, onClose, reload }: { entry: StopEntry; payload: StopsPayload; lang: Lang; onClose: () => void; reload: () => unknown }) {
  const history = useQuery({ queryKey: ["stop-history", entry.id], queryFn: () => getStopHistory(entry.id) });
  const write = useStopWrite(lang);
  const revert = (body: { history_id?: number }) =>
    write.run((onOutside) => revertStop(entry.id, onOutside ? { ...body, on_outside: onOutside } : body, payload.revision));
  const rows = [...(history.data?.history || [])].reverse();
  return (
    <div className="stop-history">
      {history.isPending ? <p role="status">{tr(lang, "Loading…", "טוען…")}</p> : null}
      {history.isError ? <p role="alert">{tr(lang, "Could not load this stop's history.", "לא ניתן לטעון את היסטוריית התחנה.")}</p> : null}
      {history.data && !rows.length ? <p>{tr(lang, "No changes recorded for this stop.", "לא נרשמו שינויים לתחנה הזו.")}</p> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <time dir="ltr">{row.created_at}</time> — {row.actor}: {ACTIONS[row.action] ? tr(lang, ...ACTIONS[row.action]) : row.action}
            {" — "}{stateSummary(row.after, lang)}
            {row.after ? <> <button type="button" disabled={write.pending} onClick={() => revert({ history_id: row.id })}>{tr(lang, "Restore this version", "שחזור הגרסה הזו")}</button></> : null}
          </li>
        ))}
      </ul>
      <div className="parity-actions">
        {entry.kind === "config" && entry.override ? (
          <button type="button" disabled={write.pending} onClick={() => revert({})}>{tr(lang, "Undo all changes to this stop", "ביטול כל השינויים בתחנה")}</button>
        ) : null}
        <button type="button" onClick={onClose}>{tr(lang, "Close history", "סגירת ההיסטוריה")}</button>
      </div>
      <Refusal refusal={write.refusal} lang={lang} stopId={entry.id} stops={payload.stops} onRetry={write.retry} onReload={reload} />
      {write.pending ? <p role="status">{tr(lang, "Saving…", "שומר…")}</p> : null}
    </div>
  );
}

type Open = { kind: "edit" | "split" | "history"; id: string } | null;

function StopRow({ entry, payload, lang, open, setOpen, reload }: {
  entry: StopEntry; payload: StopsPayload; lang: Lang; open: Open; setOpen: (o: Open) => void; reload: () => Promise<StopsPayload | undefined>;
}) {
  const headingId = useId();
  const [notice, setNotice] = useState("");
  const title = stopTitle(entry.stop, lang);
  const acc = entry.stop.accommodation;
  const accName = acc ? bilingualText(acc.name, lang) || acc.name_en : "";
  const mine = open?.id === entry.id ? open.kind : null;
  // The visible word starts the accessible name, so a voice user can say what
  // they see; the stop's title makes each row's buttons distinct.
  const named = (en: string, he: string, enName = en) => ({ children: tr(lang, en, he), "aria-label": tr(lang, `${enName} ${title}`, `${he}: ${title}`) });
  return (
    <article className="parity-row stop-row" aria-labelledby={headingId}>
      <h3 id={headingId}>{entry.stop.emoji ? <span aria-hidden="true">{entry.stop.emoji} </span> : null}{title}</h3>
      <p><DateRange dates={entry.stop.dates} lang={lang} /></p>
      {entry.unplanned ? (
        <p className="stop-hint">{bilingualText(entry.stop.note, lang) || tr(lang, "Computed from the other stops' dates.", "מחושב מתאריכי התחנות האחרות.")}</p>
      ) : (
        <p>{tr(lang, "Accommodation: ", "לינה: ")}{accName || tr(lang, "none yet", "עדיין אין")}</p>
      )}
      {entry.override ? <p className="stop-hint">{tr(lang, `Changed on the site by ${entry.override.updated_by}`, `שונה באתר על ידי ${entry.override.updated_by}`)}{entry.kind === "added" ? tr(lang, " (a stop added on the site)", " (תחנה שנוספה באתר)") : ""}</p> : null}
      {entry.booking_out_of_sync ? <p className="stop-hint">{tr(lang, "The linked hotel booking's dates no longer match this stop.", "תאריכי הזמנת המלון המקושרת כבר לא תואמים את התחנה.")}</p> : null}
      {entry.conflict ? <Conflict entry={entry} payload={payload} lang={lang} reload={reload} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!entry.unplanned ? (
        <div className="parity-actions">
          <button type="button" aria-expanded={mine === "edit"} onClick={() => setOpen(mine === "edit" ? null : { kind: "edit", id: entry.id })} {...named("Edit", "עריכה")} />
          <button type="button" aria-expanded={mine === "split"} onClick={() => setOpen(mine === "split" ? null : { kind: "split", id: entry.id })} {...named("Split", "פיצול")} />
          <button type="button" aria-expanded={mine === "history"} onClick={() => setOpen(mine === "history" ? null : { kind: "history", id: entry.id })} {...named("History", "היסטוריה", "History of")} />
        </div>
      ) : null}
      {mine === "edit" ? <EditStopForm entry={entry} payload={payload} lang={lang} onClose={() => setOpen(null)} onReload={reload} /> : null}
      {mine === "split" ? <SplitStopForm entry={entry} payload={payload} lang={lang} onClose={() => setOpen(null)} onDone={setNotice} reload={reload} /> : null}
      {mine === "history" ? <HistoryPanel entry={entry} payload={payload} lang={lang} onClose={() => setOpen(null)} reload={reload} /> : null}
    </article>
  );
}

export function StopsEditor({ isOrganizer, lang }: { isOrganizer?: boolean; lang: Lang }) {
  const stops = useQuery({ queryKey: ["stops"], queryFn: getStops, enabled: Boolean(isOrganizer) });
  const [open, setOpen] = useState<Open>(null);
  const headingId = useId();
  // While a form is open, a remote change does not refetch under it; the
  // revision it was opened with makes a stale save come back as a reload
  // prompt instead.
  useLiveEditGuard(Boolean(isOrganizer && open && open.kind !== "history"), "stops");
  if (!isOrganizer) return null;
  const reload = async () => (await stops.refetch()).data;
  return (
    <section className="parity-panel stops-editor" aria-labelledby={headingId}>
      <h2 id={headingId}>{tr(lang, "Stops", "תחנות")}</h2>
      <p>{tr(lang,
        "Where the trip goes and where you sleep. Changes are kept on the site and survive a rebuild of the trip.",
        "לאן הטיול הולך ואיפה ישנים. השינויים נשמרים באתר ושורדים בנייה מחדש של הטיול.")}</p>
      {stops.isPending ? <p role="status">{tr(lang, "Loading…", "טוען…")}</p> : null}
      {stops.isError ? (
        <p role="alert">{tr(lang, "Could not load the stops.", "לא ניתן לטעון את התחנות.")} <button type="button" onClick={() => stops.refetch()}>{tr(lang, "Retry", "ניסיון נוסף")}</button></p>
      ) : null}
      {stops.data?.orphaned_overrides?.length ? (
        <p className="stop-hint">{tr(lang,
          `${stops.data.orphaned_overrides.length} earlier stop change(s) refer to a stop the trip no longer has, and are not shown.`,
          `${stops.data.orphaned_overrides.length} שינויים קודמים מתייחסים לתחנה שכבר לא קיימת בטיול, ואינם מוצגים.`)}</p>
      ) : null}
      {stops.data?.stops.map((entry) => (
        <StopRow key={entry.id} entry={entry} payload={stops.data!} lang={lang} open={open} setOpen={setOpen} reload={reload} />
      ))}
    </section>
  );
}
