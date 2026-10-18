import { datesInPhase, phaseDates } from "./phase-calendar";
import { useEffect, useId, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActiveItinerary, type TripConfig } from "./api";
import { useLiveEditGuard } from "./live-updates";
import { StopsEditor } from "./stops-editor";
import { describeStopError, getStops, moveDay, stopTitle, STOP_CHANGE_KEYS, type StopRefusal } from "./stops";
import {
  bi,
  tr,
  Section,
  QueryState,
  useAction,
  ActionState,
  type Lang,
} from "./parity-ui";

const RESTORE_PATH = "/api/itinerary/restore-original";

// A whole day — its items and its headline — to another stop, in one plan
// revision (POST /api/itinerary/move-day). The editor could swap two days
// inside one stop but not move a day between stops (run notes F6). When both
// days carry a headline the server asks which one stays; so does this.
function MoveDay({ phase, date, revision, targets, lang, onMoved }: {
  phase: string;
  date: string;
  revision: string;
  targets: Array<{ id: string; title: string }>;
  lang: Lang;
  onMoved: (text: string) => void;
}) {
  const client = useQueryClient();
  const [to, setTo] = useState("");
  const [refusal, setRefusal] = useState<StopRefusal | null>(null);
  const selectId = useId();
  const chosen = targets.some((t) => t.id === to) ? to : "";
  const targetTitle = targets.find((t) => t.id === chosen)?.title || chosen;
  const mutation = useMutation({
    mutationFn: (headline?: "keep_target" | "take_source") =>
      moveDay({ from_phase_id: phase, to_phase_id: chosen, date, ...(headline ? { headline } : {}) }, revision),
    onMutate: () => setRefusal(null),
    onSuccess: async (result) => {
      await Promise.all(STOP_CHANGE_KEYS.map((key) => client.invalidateQueries({ queryKey: [key] })));
      onMoved(tr(lang,
        `Day moved to ${targetTitle}. ${result.review?.status === "queued" ? "Descriptions that mention a day are being re-read." : ""}`.trim(),
        `היום הועבר אל ${targetTitle}. ${result.review?.status === "queued" ? "תיאורים שמזכירים יום נבדקים מחדש." : ""}`.trim()));
    },
    onError: (error) => setRefusal(describeStopError(error, lang)),
  });
  const label = (l: { label_he?: string | null; label_en?: string | null }) =>
    (lang === "he" ? l.label_he || l.label_en : l.label_en || l.label_he) || "";
  return (
    <div className="move-day">
      <label htmlFor={selectId}>{tr(lang, "Move this day to stop", "העברת היום לתחנה")}</label>
      <select id={selectId} value={chosen} onChange={(e) => setTo(e.target.value)}>
        <option value="">{tr(lang, "Choose a stop", "בחירת תחנה")}</option>
        {targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
      </select>
      <button type="button" disabled={!revision || !chosen || mutation.isPending} onClick={() => mutation.mutate(undefined)}>
        {tr(lang, "Move day", "העברת היום")}
      </button>
      {refusal?.kind === "headline" ? (
        <div role="alert">
          <p>{tr(lang,
            `Both days have a headline. This day: “${label(refusal.source)}”. ${targetTitle} on that day: “${label(refusal.target)}”. Which one stays?`,
            `לשני הימים יש כותרת. היום הזה: ״${label(refusal.source)}״. ${targetTitle} באותו יום: ״${label(refusal.target)}״. איזו נשארת?`)}</p>
          <div className="parity-actions">
            <button type="button" onClick={() => mutation.mutate("keep_target")}>{tr(lang, "Keep the target day's headline", "להשאיר את הכותרת של יום היעד")}</button>
            <button type="button" onClick={() => mutation.mutate("take_source")}>{tr(lang, "Use this day's headline", "להשתמש בכותרת של היום הזה")}</button>
          </div>
        </div>
      ) : refusal?.kind === "stale" ? (
        <p role="alert">{tr(lang, "The plan changed since you chose this day. Choose the day again to load the latest plan.", "המסלול השתנה מאז שבחרתם את היום. בחרו את היום שוב כדי לטעון את המסלול העדכני.")}</p>
      ) : refusal?.kind === "message" ? (
        <p role="alert">{refusal.text}</p>
      ) : null}
    </div>
  );
}

export function PlanTools({
  itinerary,
  config,
  lang,
  isOrganizer = false,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  lang: Lang;
  isOrganizer?: boolean;
}) {
  const [moveNotice, setMoveNotice] = useState("");
  // Same query (and key) as the stops editor: one request serves both.
  const stops = useQuery({ queryKey: ["stops"], queryFn: getStops, enabled: isOrganizer });
  const [phase, setPhase] = useState(config?.phases?.[0]?.id || "");
  const [dateA, setDateA] = useState(""),
    [dateB, setDateB] = useState("");
  const [he, setHe] = useState(""),
    [en, setEn] = useState(""),
    [revision, setRevision] = useState("");
  const editing = Boolean(dateA);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!phase && config?.phases?.length) setPhase(config.phases[0].id);
  }, [config, phase]);
  useLiveEditGuard(editing, "itinerary");
  const original = useQuery({
    queryKey: ["original"],
    queryFn: () => api<ActiveItinerary>("/api/itinerary/original"),
  });
  const history = useQuery({
    queryKey: ["revisions"],
    queryFn: () =>
      api<
        Array<{
          revision_id: string;
          note: string;
          author: string;
          created_at: string;
        }>
      >("/api/itinerary/revisions"),
  });
  const action = useAction(
    lang,
    ["itinerary", "today", "revisions"],
    (body: object) =>
      api("/api/itinerary/swap-days", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "If-Match": revision },
      }),
    () => {
      setDateA("");
      setDateB("");
    },
  );
  const label = useAction(
    lang,
    ["itinerary", "today", "revisions"],
    () =>
      api("/api/itinerary/days", {
        method: "PATCH",
        body: JSON.stringify({
          phase_id: phase,
          date: dateA,
          label_he: he,
          label_en: en,
        }),
        headers: { "If-Match": revision },
      }),
    () => {
      setDateA("");
      setDateB("");
    },
  );
  const operation = useAction(
    lang,
    ["itinerary", "today", "config", "revisions", "original"],
    (path: string) =>
      api(path, {
        method: "POST",
        headers: path === RESTORE_PATH && itinerary?.revision ? { "If-Match": itinerary.revision } : undefined,
      }),
    () => setConfirmed(false),
  );
  const persistedDays = itinerary?.days.filter((d) => d.phase_id === phase) || [];
  const phaseConfig = config?.phases?.find((p) => p.id === phase);
  const selectedDays = phaseDates(
    datesInPhase(phaseConfig?.dates || { start: phaseConfig?.start, end: phaseConfig?.end }),
    persistedDays.map((d) => d.date),
  ).map((date) => persistedDays.find((d) => d.date === date) || { phase_id: phase, date });
  // A day can go to any real stop but its own. The stop list says which are
  // real (the computed open-days stretch is not a place to send a day); the
  // config is the fallback while it loads.
  const moveTargets = (stops.data?.stops
    ? stops.data.stops.filter((s) => !s.unplanned).map((s) => ({ id: s.id, title: stopTitle(s.stop, lang) }))
    : (config?.phases || []).map((p) => ({ id: p.id, title: bi(p.title, lang) || p.id }))
  ).filter((t) => t.id !== phase);
  function selectDay(value: string) {
    setMoveNotice("");
    setDateA(value);
    setDateB("");
    const d = selectedDays.find((d) => d.date === value);
    setHe(d?.label_he || "");
    setEn(d?.label_en || "");
    setRevision(itinerary?.revision || "");
  }
  const changed =
    itinerary?.items.filter((item) => {
      const old = original.data?.items.find(
        (o) => o.item_uid === item.item_uid,
      );
      return (
        !old ||
        ["date", "time", "text_he", "text_en", "location_url"].some(
          (k) => old[k as keyof typeof old] !== item[k as keyof typeof item],
        )
      );
    }) || [];
  const changedDays =
    itinerary?.days.filter((day) => {
      const old = original.data?.days.find(
        (d) => d.phase_id === day.phase_id && d.date === day.date,
      );
      return (
        !old || old.label_he !== day.label_he || old.label_en !== day.label_en
      );
    }) || [];
  const removed =
    original.data?.items.filter(
      (old) => !itinerary?.items.some((item) => item.item_uid === old.item_uid),
    ) || [];
  return (
    <div className="parity-layout">
      <a className="secondary-action plan-tools-back" href="#journey">
        {lang === "he" ? <ArrowRight size={18} aria-hidden="true" /> : <ArrowLeft size={18} aria-hidden="true" />}
        {tr(lang, "Back to trip planning", "חזרה לתכנון הטיול")}
      </a>
      <StopsEditor isOrganizer={isOrganizer} lang={lang} />
      <Section title={tr(lang, "Organizer plan tools", "כלי מסלול למארגן")}>
        <div className="parity-fields">
          <label>
            {tr(lang, "Phase", "שלב")}
            <select
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value);
                setDateA("");
                setDateB("");
              }}
            >
              {config?.phases?.map((p) => (
                <option key={p.id} value={p.id}>
                  {bi(p.title, lang) || p.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr(lang, "Day", "יום")}
            <select value={dateA} onChange={(e) => selectDay(e.target.value)}>
              <option value="">{tr(lang, "Choose day", "בחירת יום")}</option>
              {selectedDays.map((d) => (
                <option key={d.date}>{d.date}</option>
              ))}
            </select>
          </label>
        </div>
        {dateA && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                label.mutate();
              }}
            >
              <label>
                {tr(lang, "Hebrew day title", "כותרת היום בעברית")}
                <input value={he} onChange={(e) => setHe(e.target.value)} />
              </label>
              <label>
                {tr(lang, "English day title", "כותרת היום באנגלית")}
                <input value={en} onChange={(e) => setEn(e.target.value)} />
              </label>
              <button disabled={!revision || label.isPending || action.isPending}>
                {tr(lang, "Save day title", "שמירת כותרת היום")}
              </button>
            </form>
            <label>
              {tr(lang, "Swap with", "החלפה עם")}
              <select value={dateB} onChange={(e) => setDateB(e.target.value)}>
                <option value="">
                  {tr(lang, "Choose another day", "בחירת יום אחר")}
                </option>
                {selectedDays
                  .filter((d) => d.date !== dateA)
                  .map((d) => (
                    <option key={d.date}>{d.date}</option>
                  ))}
              </select>
            </label>
            <button
              disabled={!revision || !dateB || dateB === dateA || action.isPending || label.isPending}
              onClick={() =>
                action.mutate({ phase_id: phase, date_a: dateA, date_b: dateB })
              }
            >
              {tr(lang, "Swap these days", "החלפת הימים")}
            </button>

            <MoveDay
              phase={phase}
              date={dateA}
              revision={revision}
              targets={moveTargets}
              lang={lang}
              onMoved={(text) => {
                setMoveNotice(text);
                setDateA("");
                setDateB("");
              }}
            />

            <button
              onClick={() => {
                setDateA("");
                setDateB("");
              }}
            >
              {tr(
                lang,
                "Close editor / reload latest before retrying",
                "סגירת העורך / טעינת הגרסה העדכנית לפני ניסיון נוסף",
              )}
            </button>
          </>
        )}
        {moveNotice ? <p role="status">{moveNotice}</p> : null}
        <ActionState action={label} lang={lang} />
        <ActionState action={action} lang={lang} />
      </Section>
      <Section
        title={tr(lang, "Save, restore and import", "שמירה, שחזור וייבוא")}
      >
        <p>
          {tr(
            lang,
            "These actions change the shared trip plan. Save writes the current plan to the trip file and makes it the restore point; restore replaces the live plan with the last saved one, and the change stays in revision history.",
            "פעולות אלה משנות את המסלול המשותף. שמירה כותבת את המסלול הנוכחי לקובץ הטיול והופכת אותו לנקודת השחזור; שחזור מחליף את המסלול החי במסלול השמור האחרון, והשינוי נשמר בהיסטוריית הגרסאות.",
          )}
        </p>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          {tr(
            lang,
            "I have reviewed the plan and want to apply this action.",
            "בדקתי את המסלול וברצוני לבצע את הפעולה.",
          )}
        </label>
        <div className="parity-actions">
          {[
            ["/api/phase-plan/export-to-config", "Save plan as restore point", "שמירת המסלול כנקודת שחזור"],
            [RESTORE_PATH, "Restore saved plan", "שחזור המסלול השמור"],
            ["/api/phase-plan/import-from-bookings", "Import booking notes", "ייבוא הערות מהזמנות"],
            ["/api/phase-plan/enrich-pending", "Enrich pending items", "העשרת פריטים ממתינים"],
          ].map(([op, en, he]) => (
            <button
              key={op}
              disabled={!confirmed || operation.isPending || editing}
              onClick={() => operation.mutate(op)}
            >
              {tr(lang, en, he)}
            </button>
          ))}
        </div>
        <ActionState action={operation} lang={lang} />
      </Section>
      <Section title={tr(lang, "Compare with saved plan", "השוואה למסלול השמור")}>
        <QueryState query={original} lang={lang} />
        {original.data && (
          <>
            {changedDays.map((day) => (
              <article
                className="parity-row"
                key={`${day.phase_id}-${day.date}`}
              >
                <time>{day.date}</time>
                <p>
                  {lang === "he"
                    ? day.label_he || day.label_en
                    : day.label_en || day.label_he}
                </p>
              </article>
            ))}
            <p>
              {changed.length} {tr(lang, "changed or added", "נוספו או השתנו")}{" "}
              · {removed.length} {tr(lang, "removed", "הוסרו")}
            </p>
            {changed.map((item) => {
              const old = original.data.items.find(
                (o) => o.item_uid === item.item_uid,
              );
              return (
                <article key={item.item_uid} className="parity-row">
                  {old && (
                    <p>
                      <del>
                        {old.date} {old.time}{" "}
                        {lang === "he"
                          ? old.text_he
                          : old.text_en || old.text_he}
                      </del>
                    </p>
                  )}
                  <p>
                    {item.date} {item.time}{" "}
                    {lang === "he"
                      ? item.text_he
                      : item.text_en || item.text_he}
                  </p>
                </article>
              );
            })}
            {removed.map((item) => (
              <p key={item.item_uid}>
                <del>
                  {item.date}{" "}
                  {lang === "he" ? item.text_he : item.text_en || item.text_he}
                </del>
              </p>
            ))}
          </>
        )}
      </Section>
      <Section title={tr(lang, "Revision history", "היסטוריית גרסאות")}>
        <QueryState query={history} lang={lang} />
        <ul>
          {history.data?.map((r) => (
            <li key={r.revision_id}>
              <time>{r.created_at}</time> — {r.author}: {r.note}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
