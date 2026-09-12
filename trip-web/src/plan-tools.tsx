import { datesInPhase } from "./phase-calendar";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ActiveItinerary, type TripConfig } from "./api";
import { useLiveEditGuard } from "./live-updates";
import {
  bi,
  tr,
  Section,
  QueryState,
  useAction,
  ActionState,
  type Lang,
} from "./parity-ui";

export function PlanTools({
  itinerary,
  config,
  lang,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  lang: Lang;
}) {
  const [phase, setPhase] = useState(config?.phases?.[0]?.id || "");
  const [dateA, setDateA] = useState(""),
    [dateB, setDateB] = useState("");
  const [he, setHe] = useState(""),
    [en, setEn] = useState(""),
    [editing, setEditing] = useState(false),
    [revision, setRevision] = useState("");
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
        headers: { "If-Match": revision || itinerary?.revision || "" },
      }),
    () => {
      setEditing(false);
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
      setEditing(false);
      setDateA("");
      setDateB("");
    },
  );
  const operation = useAction(
    lang,
    ["itinerary", "today", "config", "revisions"],
    (op: string) => api(`/api/phase-plan/${op}`, { method: "POST" }),
    () => setConfirmed(false),
  );
  const persistedDays = itinerary?.days.filter((d) => d.phase_id === phase) || [];
  const phaseConfig = config?.phases?.find((p) => p.id === phase);
  const selectedDays = [...new Set([
    ...datesInPhase(phaseConfig?.dates || { start: phaseConfig?.start, end: phaseConfig?.end }),
    ...persistedDays.map((d) => d.date),
  ])].sort().map((date) => persistedDays.find((d) => d.date === date) || { phase_id: phase, date });
  function selectDay(value: string) {
    setDateA(value);
    const d = selectedDays.find((d) => d.date === value);
    setHe(d?.label_he || "");
    setEn(d?.label_en || "");
    setRevision(itinerary?.revision || "");
    setEditing(true);
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
                setEditing(false);
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
              <button disabled={label.isPending}>
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
              disabled={!dateB || action.isPending}
              onClick={() =>
                action.mutate({ phase_id: phase, date_a: dateA, date_b: dateB })
              }
            >
              {tr(lang, "Swap these days", "החלפת הימים")}
            </button>

            <button
              onClick={() => {
                setEditing(false);
                setDateA("");
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
        <ActionState action={label} lang={lang} />
        <ActionState action={action} lang={lang} />
      </Section>
      <Section
        title={tr(lang, "Import, enrich and export", "ייבוא, העשרה וייצוא")}
      >
        <p>
          {tr(
            lang,
            "These actions change the shared trip plan. Import reads existing booking notes; export saves the dated plan as the trip’s configured schedule.",
            "פעולות אלה משנות את המסלול המשותף. ייבוא קורא הערות מהזמנות קיימות; ייצוא שומר את המסלול המתוארך כלוח הזמנים של הטיול.",
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
            [
              "promote-config-days",
              "Import original schedule",
              "ייבוא המסלול המקורי",
            ],
            [
              "import-from-bookings",
              "Import booking notes",
              "ייבוא הערות מהזמנות",
            ],
            ["enrich-pending", "Enrich pending items", "העשרת פריטים ממתינים"],
            [
              "export-to-config",
              "Save as configured schedule",
              "שמירה כלוח הזמנים של הטיול",
            ],
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
      <Section title={tr(lang, "Compare with original", "השוואה למקור")}>
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
