import { StarRating } from "./star-rating";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser, TripConfig } from "./api";
import {
  getRatings,
  rateVenue,
  getVenueComments,
  commentVenue,
  removeVenueComment,
  getRsvps,
  setRsvp,
  getFound,
  reportFound,
  resolveFound,
  type Rsvp,
} from "./parity-api";
import {
  bi,
  tr,
  Section,
  QueryState,
  useAction,
  ActionState,
  External,
  type Lang,
} from "./parity-ui";

export function VenueFeedback({
  id,
  username,
  lang,
}: {
  id: string;
  username?: string;
  lang: Lang;
}) {
  const ratings = useQuery({ queryKey: ["ratings"], queryFn: getRatings });
  const comments = useQuery({
    queryKey: ["venue-comments", id],
    queryFn: () => getVenueComments(id),
  });
  const [body, setBody] = useState("");
  const rate = useAction(lang, ["ratings"], (value: number) =>
    rateVenue(id, value),
  );
  const comment = useAction(
    lang,
    ["venue-comments"],
    () => commentVenue(id, body),
    () => setBody(""),
  );
  const remove = useAction(lang, ["venue-comments"], removeVenueComment);
  return (
    <div>
      <QueryState query={ratings} lang={lang} />
      <StarRating lang={lang} value={rate.isPending ? rate.variables : ratings.data?.[id]?.[username || ""]}
        disabled={rate.isPending || ratings.isPending || ratings.isError} onChange={value => rate.mutate(value)} />
      <ActionState action={rate} lang={lang} />
      <ul>
        {Object.entries(ratings.data?.[id] || {}).map(([name, stars]) => (
          <li key={name}>
            {name}: {stars} ★
          </li>
        ))}
      </ul>
      <QueryState query={comments} lang={lang} />
      {comments.data?.map((c) => (
        <article className="parity-row" key={c.id}>
          <strong>{c.username}</strong>
          <p>{c.body}</p>
          {c.username === username && (
            <button
              disabled={remove.isPending}
              onClick={() => remove.mutate(c.id)}
            >
              {tr(lang, "Delete comment", "מחיקת תגובה")}
            </button>
          )}
        </article>
      ))}
      <ActionState action={remove} lang={lang} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          comment.mutate();
        }}
      >
        <label>
          {tr(lang, "Comment", "תגובה")}
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <button disabled={!body.trim() || comment.isPending}>
          {tr(lang, "Post comment", "פרסום תגובה")}
        </button>
        <ActionState action={comment} lang={lang} />
      </form>
    </div>
  );
}
export function ActivityRsvp({ id, lang }: { id: string; lang: Lang }) {
  const rows = useQuery({
    queryKey: ["rsvps", id],
    queryFn: () => getRsvps(id),
  });
  const [note, setNote] = useState("");
  const action = useAction(lang, ["rsvps"], (status: Rsvp["status"]) =>
    setRsvp(id, status, note),
  );
  return (
    <div>
      <QueryState query={rows} lang={lang} />
      <label>
        {tr(lang, "RSVP note (optional)", "הערה להשתתפות (רשות)")}
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="parity-actions">
        {(["yes", "maybe", "no"] as const).map((v, i) => (
          <button
            key={v}
            disabled={action.isPending}
            onClick={() => action.mutate(v)}
          >
            {tr(
              lang,
              ["Going", "Maybe", "Not going"][i],
              ["מגיע/ה", "אולי", "לא מגיע/ה"][i],
            )}
          </button>
        ))}
      </div>
      <ActionState action={action} lang={lang} />
      <ul>
        {rows.data?.map((r) => (
          <li key={r.username}>
            {r.username} —{" "}
            {tr(
              lang,
              { yes: "Going", no: "Not going", maybe: "Maybe" }[r.status],
              { yes: "מגיע/ה", no: "לא מגיע/ה", maybe: "אולי" }[r.status],
            )}{" "}
            {r.note}
          </li>
        ))}
      </ul>
    </div>
  );
}
export function GroupActivities({
  config,
  currentUser,
  lang,
}: {
  config?: TripConfig;
  currentUser?: CurrentUser;
  lang: Lang;
}) {
  return (
    <div className="parity-layout">
      <h2>{tr(lang, "Activities and places", "פעילויות ומקומות")}</h2>
      {!config?.phases?.some(
        (p) => p.venues?.length || p.rsvp_activities?.length,
      ) && (
        <p>
          {tr(
            lang,
            "No group activities or venues have been added.",
            "עדיין לא נוספו פעילויות קבוצתיות או מקומות.",
          )}
        </p>
      )}
      {config?.phases?.map((p) => (
        <div key={p.id}>
          {!!(p.venues?.length || p.rsvp_activities?.length) && (
            <h3>{bi(p.title, lang)}</h3>
          )}
          {p.rsvp_activities?.map((a) => (
            <Section key={a.id} title={bi(a.title || a.name, lang) || a.id}>
              <p>
                {bi(a.desc, lang)} {a.date} {bi(a.price, lang)}
              </p>
              <ActivityRsvp id={a.id} lang={lang} />
            </Section>
          ))}
          {p.venues?.map((v, index) => (
            <Section key={v.id || `${p.id}-${index}`} title={bi(v.name, lang) || v.id || tr(lang, "Place", "מקום")}>
              <div className="parity-actions">
                <External url={v.maps}>{tr(lang, "Maps", "מפה")}</External>
                <External url={v.waze}>Waze</External>
                <External url={v.tickets || v.url}>
                  {tr(lang, "Official site / tickets", "אתר רשמי / כרטיסים")}
                </External>
              </div>
              {v.id && <VenueFeedback
                id={v.id}
                username={currentUser?.username}
                lang={lang}
              />}
            </Section>
          ))}
        </div>
      ))}
    </div>
  );
}
export function LostFound({
  lang,
  authenticated = true,
}: {
  lang: Lang;
  authenticated?: boolean;
}) {
  const rows = useQuery({
    queryKey: ["lost-found"],
    queryFn: getFound,
    enabled: authenticated,
  });
  const [draft, setDraft] = useState({
    name: "",
    phone: "",
    item: "",
    location: "",
  });
  const submit = useAction(
    lang,
    ["lost-found"],
    () => reportFound(draft),
    () => setDraft({ name: "", phone: "", item: "", location: "" }),
  );
  const resolve = useAction(
    lang,
    ["lost-found"],
    (row: { id: number; resolved: number }) =>
      resolveFound(row.id, !row.resolved),
  );
  return (
    <div className="parity-layout">
      <Section title={tr(lang, "Report a found item", "דיווח על חפץ שנמצא")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          {(["name", "phone", "item", "location"] as const).map((key, i) => (
            <label key={key}>
              {tr(
                lang,
                [
                  "Your name",
                  "Phone (optional)",
                  "Found item",
                  "Location (optional)",
                ][i],
                ["שם", "טלפון (רשות)", "החפץ שנמצא", "מיקום (רשות)"][i],
              )}
              <input
                required={key === "name" || key === "item"}
                type={key === "phone" ? "tel" : "text"}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </label>
          ))}
          <button disabled={submit.isPending}>
            {tr(lang, "Send report", "שליחת דיווח")}
          </button>
          <ActionState action={submit} lang={lang} />
        </form>
      </Section>
      {authenticated && (
        <Section title={tr(lang, "Reported items", "חפצים שדווחו")}>
          <QueryState query={rows} lang={lang} />
          {rows.data?.length === 0 && (
            <p>{tr(lang, "No reports yet.", "אין דיווחים עדיין.")}</p>
          )}
          {rows.data?.map((row) => (
            <article className="parity-row" key={row.id}>
              <h3>{row.item}</h3>
              <p>
                {row.name} {row.phone} {row.location}
              </p>
              <p>
                {row.resolved
                  ? tr(lang, "Resolved", "טופל")
                  : tr(lang, "Open", "פתוח")}
              </p>
              <button
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(row)}
              >
                {row.resolved
                  ? tr(lang, "Reopen", "פתיחה מחדש")
                  : tr(lang, "Mark resolved", "סימון כטופל")}
              </button>
            </article>
          ))}
          <ActionState action={resolve} lang={lang} />
        </Section>
      )}
    </div>
  );
}
