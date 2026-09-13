import { useQuery } from "@tanstack/react-query";
import { type TripConfig } from "./api";
import { getTasks, toggleTask, getRates } from "./parity-api";
import {
  bi,
  tr,
  Section,
  QueryState,
  useAction,
  ActionState,
  PackingCheck,
  type Lang,
} from "./parity-ui";

export function Readiness({
  config,
  lang,
}: {
  config?: TripConfig;
  lang: Lang;
}) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: getTasks });
  const action = useAction(lang, ["tasks"], toggleTask);
  const info = config?.travel_info;
  const lists = [
    ["Health", "בריאות", info?.health],
    ["Money", "כסף", info?.money],
    ["Communication", "תקשורת", info?.communication],
  ] as const;
  const packs = [
    {
      id: "general",
      title: tr(lang, "General", "כללי"),
      items: config?.packing_general?.length
        ? config.packing_general
        : [
            [
              { he: "מסמכים", en: "Documents" },
              { he: "דרכון", en: "Passport" },
            ],
            [
              { he: "מסמכים", en: "Documents" },
              { he: "ביטוח נסיעות", en: "Travel insurance" },
            ],
            [
              { he: "אלקטרוניקה", en: "Electronics" },
              { he: "מטען + כבלים", en: "Charger + cables" },
            ],
            [
              { he: "בריאות", en: "Health" },
              { he: "תרופות קבועות", en: "Regular medications" },
            ],
          ],
    },
    ...(config?.phases || []).map((p) => ({
      id: p.id,
      title: bi(p.title, lang) || p.id,
      items: p.packing,
    })),
  ];
  return (
    <div className="parity-layout">
      <Section
        title={tr(
          lang,
          "Readiness and useful information",
          "הכנות ומידע שימושי",
        )}
      >
        <h3>{tr(lang, "Shared tasks", "משימות משותפות")}</h3>
        <QueryState query={tasks} lang={lang} />
        {!config?.tasks?.length && (
          <p>
            {tr(lang, "No tasks have been added.", "עדיין לא נוספו משימות.")}
          </p>
        )}
        {config?.tasks?.map((task) => {
          const done = tasks.data?.find((t) => t.task_id === task.id);
          return (
            <div key={task.id} className="parity-row">
              <label className="parity-check">
                <input
                  type="checkbox"
                  checked={Boolean(done)}
                  disabled={!tasks.data || action.isPending}
                  onChange={() => action.mutate(task.id)}
                />
                {bi(task.text, lang)}
              </label>
              <small>
                {bi(task.owner, lang)}{" "}
                {task.deadline && <time>{task.deadline}</time>}{" "}
                {done &&
                  `${tr(lang, "Completed by", "בוצע על ידי")} ${done.done_by}`}
              </small>
            </div>
          );
        })}
        <ActionState action={action} lang={lang} />
      </Section>
      <Section title={tr(lang, "Packing", "אריזה")}>
        <p>
          {tr(
            lang,
            "Packing ticks are saved on this device, as in Classic.",
            "סימוני האריזה נשמרים במכשיר זה, כמו בגרסה הקלאסית.",
          )}
        </p>
        {packs
          .filter((p) => p.items?.length)
          .map((p) => (
            <div key={p.id}>
              <h3>{p.title}</h3>
              {p.items?.map(([category, item], i) => (
                <PackingCheck
                  key={i}
                  storageKey={`pack-pack-${p.id}-${bi(item, "he")}`}
                  label={`${bi(category, lang)} — ${bi(item, lang)}`}
                />
              ))}
            </div>
          ))}
        {!packs.some((p) => p.items?.length) && (
          <p>
            {tr(
              lang,
              "No packing list has been added.",
              "עדיין לא נוספה רשימת אריזה.",
            )}
          </p>
        )}
      </Section>
      <Section
        title={tr(
          lang,
          "Emergency and country information",
          "חירום ומידע למדינה",
        )}
      >
        {!Object.keys(info?.countries || {}).length &&
          !info?.emergency_contacts?.length && (
            <p>
              {tr(
                lang,
                "No country information has been added.",
                "עדיין לא נוסף מידע למדינה.",
              )}
            </p>
          )}
        {Object.entries(info?.countries || {}).map(([name, c]) => (
          <article key={name}>
            <h3>
              {c.flag} {name}
            </h3>
            <p>
              {c.currency?.name} {c.currency?.symbol} {c.callingCode}
            </p>
            {[
              ["General", "כללי", c.emergency?.general],
              ["Police", "משטרה", c.emergency?.police],
              ["Ambulance", "אמבולנס", c.emergency?.ambulance],
              ["Fire", "כיבוי אש", c.emergency?.fire],
              ["Emergency", "חירום", c.emergency?.unified112 ? "112" : null],
            ].map(
              ([en, he, phone]) =>
                phone && (
                  <p key={en}>
                    {tr(lang, en!, he!)}:{" "}
                    <a href={`tel:${phone.replace(/[^+\d]/g, "")}`} dir="ltr">
                      {phone}
                    </a>
                  </p>
                ),
            )}
          </article>
        ))}
        {info?.emergency_contacts?.map((c, i) => (
          <p key={i}>
            {bi(c.name, lang)}{" "}
            <a href={`tel:${c.phone.replace(/[^+\d]/g, "")}`} dir="ltr">
              {c.phone}
            </a>
          </p>
        ))}
      </Section>
      {lists.map(([en, he, items]) =>
        items?.length ? (
          <Section key={en} title={tr(lang, en, he)}>
            <ul>
              {items.map((item, i) => (
                <li key={i}>{bi(item, lang)}</li>
              ))}
            </ul>
          </Section>
        ) : null,
      )}
      {!!info?.hospitals?.length && (
        <Section title={tr(lang, "Hospitals", "בתי חולים")}>
          <ul>
            {info.hospitals.map((h, i) => (
              <li key={i}>
                {bi(h.area, lang)} — {h.name}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {!!info?.age_notes?.length && (
        <Section title={tr(lang, "Age restrictions", "הגבלות גיל")}>
          <ul>
            {info.age_notes.map((n, i) => (
              <li key={i}>
                {bi(n.who, lang)} — {bi(n.note, lang)}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <CurrencyConverter lang={lang} />
    </div>
  );
}
import { useState } from "react";
export function CurrencyConverter({ lang }: { lang: Lang }) {
  const rates = useQuery({
    queryKey: ["currency-rates"],
    queryFn: getRates,
    staleTime: 3600000,
    retry: false,
  });
  const [amount, setAmount] = useState("1"),
    [from, setFrom] = useState("USD"),
    [to, setTo] = useState("");
  const all: Record<string, number> = { USD: 1, ...rates.data?.rates };
  const target = to || rates.data?.home || "USD";
  const value = (Number(amount) * all[target]) / all[from];
  return (
    <Section title={tr(lang, "Currency conversion", "המרת מטבע")}>
      <QueryState query={rates} lang={lang} />
      {rates.data && (
        <>
          <div className="parity-fields">
            <label>
              {tr(lang, "Amount", "סכום")}
              <input
                type="number"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            {[
              [from, setFrom, tr(lang, "From", "ממטבע")],
              [target, setTo, tr(lang, "To", "למטבע")],
            ].map(([v, set, label]) => (
              <label key={String(label)}>
                {String(label)}
                <select
                  value={String(v)}
                  onChange={(e) => (set as (s: string) => void)(e.target.value)}
                >
                  {Object.keys(all).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <output>
            {Number.isFinite(value) && amount !== ""
              ? `${value.toLocaleString(lang, { maximumFractionDigits: 2 })} ${target}`
              : "—"}
          </output>
          <p>
            {tr(lang, "Rate date", "תאריך שער")}: {rates.data.date || "—"}{" "}
            {rates.data.stale && tr(lang, "(cached rate)", "(שער שמור)")}
          </p>
        </>
      )}
    </Section>
  );
}
