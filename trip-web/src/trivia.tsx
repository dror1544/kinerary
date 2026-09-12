import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  runtimeUrl,
  tokenStore,
  type CurrentUser,
  type TripConfig,
} from "./api";
import {
  tr,
  bi,
  Section,
  QueryState,
  useAction,
  ActionState,
  type Lang,
} from "./parity-ui";
export type TriviaState = {
  status: string;
  gameId: string;
  questionIndex: number;
  myAnswer: number | null;
  pausedRemainingMs?: number | null;
  question: null | {
    he: string;
    en: string;
    id: number;
    number: number;
    total: number;
    duration: number;
    elapsedMs: number;
    answers: Array<{
      he: string;
      en: string;
      index: number;
      correct?: boolean;
    }>;
  };
  players: Record<
    string,
    { name: string; name_en: string; score: number; delta: number }
  >;
};
const getState = () => api<TriviaState>("/api/trivia/state");
// Authenticated streaming registers a player in the lobby. No token in URLs.
export function useTriviaConnection(
  enabled: boolean,
  gameId?: string,
  status?: string,
) {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      controller: AbortController;
    let delay = 1000;
    async function connect() {
      controller = new AbortController();
      try {
        const token = tokenStore.get();
        const response = await fetch(runtimeUrl("/api/trivia/events"), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok || !response.body)
          throw new Error("Stream unavailable");
        setConnected(true);
        delay = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            if (buffer.length > 65536) throw new Error("Event too large");
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (
                frame.includes("event: state") ||
                frame.includes("event: answer_count")
              ) {
                void client.invalidateQueries({ queryKey: ["trivia"] });
                if (frame.includes("event: state"))
                  void client.invalidateQueries({
                    queryKey: ["trivia-scores"],
                  });
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        /* Polling also refreshes state while reconnecting. */
      } finally {
        if (!stopped) {
          setConnected(false);
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 15000);
        }
      }
    }
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [enabled, client, gameId, status === "lobby"]);
  return connected;
}
export function Trivia({
  currentUser,
  config,
  lang,
}: {
  currentUser?: CurrentUser;
  config?: TripConfig;
  lang: Lang;
}) {
  const state = useQuery({
    queryKey: ["trivia"],
    queryFn: getState,
    refetchInterval: 5000,
  });
  const history = useQuery({
    queryKey: ["trivia-scores"],
    queryFn: () =>
      api<
        Array<{
          game_id: string;
          username: string;
          score: number;
          rank: number;
          played_at: string;
        }>
      >("/api/trivia/scores"),
  });
  const connected = useTriviaConnection(
    true,
    state.data?.gameId,
    state.data?.status,
  );
  const answer = useAction(lang, ["trivia"], (answerIndex: number) =>
    api("/api/trivia/answer", {
      method: "POST",
      body: JSON.stringify({ answerIndex }),
    }),
  );
  const control = useAction(
    lang,
    ["trivia", "trivia-scores"],
    (action: string) =>
      api("/api/trivia/control", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
  );
  const admin =
    currentUser?.username ===
    (config?.meta?.admin || config?.participants?.[0]?.username);
  const q = state.data?.question;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const remaining = q
    ? Math.max(
        0,
        Math.ceil(
          (state.data?.pausedRemainingMs ??
            q.duration * 1000 -
              q.elapsedMs -
              Math.max(0, now - state.dataUpdatedAt)) / 1000,
        ),
      )
    : 0;
  const status = state.data?.status || "idle";
  const actions =
    status === "lobby"
      ? ["launch", "stop"]
      : status === "question"
        ? [
            state.data?.pausedRemainingMs != null ? "resume" : "pause",
            "reveal",
            "stop",
          ]
        : status === "reveal"
          ? ["leaderboard", "stop"]
          : status === "leaderboard"
            ? ["next", "stop"]
            : ["start"];
  const labels: Record<string, [string, string]> = {
    start: ["Start game", "משחק חדש"],
    launch: ["Begin questions", "התחלת שאלות"],
    pause: ["Pause", "השהיה"],
    resume: ["Resume", "המשך"],
    reveal: ["Reveal answer", "חשיפת התשובה"],
    leaderboard: ["Leaderboard", "טבלת ניקוד"],
    next: ["Next question", "השאלה הבאה"],
    stop: ["End game", "סיום המשחק"],
  };
  return (
    <div className="parity-layout">
      <Section title={tr(lang, "Trivia", "טריוויה")}>
        <QueryState query={state} lang={lang} />
        <p role="status">
          {connected
            ? tr(lang, "Connected", "מחובר")
            : tr(lang, "Reconnecting…", "מתחבר מחדש…")}
        </p>
        {status === "lobby" && (
          <p>
            {tr(
              lang,
              "You are in the lobby. Wait for the host to begin.",
              "אתם בחדר ההמתנה. ממתינים למנחה.",
            )}
          </p>
        )}
        {status === "gameover" && (
          <h3>{tr(lang, "Game finished", "המשחק הסתיים")}</h3>
        )}
        {q && (
          <>
            <h3>{bi(q, lang)}</h3>
            <p>
              {q.number} / {q.total}{" "}
              {status === "question" &&
                `${remaining} ${tr(lang, "seconds", "שניות")}`}{" "}
              {state.data?.pausedRemainingMs != null &&
                tr(lang, "Paused", "מושהה")}
            </p>
            <div className="trivia-answers">
              {q.answers.map((a) => (
                <button
                  key={a.index}
                  aria-pressed={state.data?.myAnswer === a.index}
                  disabled={
                    status !== "question" ||
                    state.data?.myAnswer != null ||
                    answer.isPending ||
                    state.data?.pausedRemainingMs != null ||
                    !connected
                  }
                  onClick={() => answer.mutate(a.index)}
                >
                  {bi(a, lang)} {a.correct === true ? "✓" : ""}
                </button>
              ))}
            </div>
            <ActionState action={answer} lang={lang} />
          </>
        )}
        <h3>{tr(lang, "Players", "שחקנים")}</h3>
        <ol>
          {Object.entries(state.data?.players || {})
            .sort((a, b) => b[1].score - a[1].score)
            .map(([id, p]) => (
              <li key={id}>
                {lang === "he" ? p.name : p.name_en || p.name}: {p.score}{" "}
                {p.delta > 0 ? `(+${p.delta})` : ""}
              </li>
            ))}
        </ol>
        {admin && (
          <div className="parity-actions">
            {actions.map((a) => (
              <button
                key={a}
                disabled={control.isPending}
                onClick={() => control.mutate(a)}
              >
                {tr(lang, ...labels[a])}
              </button>
            ))}
            <ActionState action={control} lang={lang} />
          </div>
        )}
      </Section>
      <Section title={tr(lang, "Past scores", "תוצאות קודמות")}>
        <QueryState query={history} lang={lang} />
        <ul>
          {history.data?.map((r, i) => (
            <li key={i}>
              {r.played_at} — {r.rank}. {r.username}: {r.score}
            </li>
          ))}
        </ul>
      </Section>
      {admin && <QuestionBank lang={lang} />}
    </div>
  );
}
function QuestionBank({ lang }: { lang: Lang }) {
  const rows = useQuery({
    queryKey: ["trivia-questions"],
    queryFn: () =>
      api<Array<{ id: number; he: string; en: string }>>(
        "/api/trivia/questions",
      ),
  });
  const [he, setHe] = useState(""),
    [en, setEn] = useState(""),
    [correct, setCorrect] = useState(0),
    [duration, setDuration] = useState(20);
  const [answers, setAnswers] = useState(
    Array.from({ length: 4 }, () => ({ he: "", en: "" })),
  );
  const add = useAction(
    lang,
    ["trivia-questions"],
    () =>
      api("/api/trivia/questions", {
        method: "POST",
        body: JSON.stringify({
          he,
          en,
          duration,
          persons: "general",
          answers: answers.map((a, i) => ({ ...a, correct: i === correct })),
        }),
      }),
    () => {
      setHe("");
      setEn("");
      setAnswers(Array.from({ length: 4 }, () => ({ he: "", en: "" })));
    },
  );
  return (
    <Section title={tr(lang, "Question bank", "מאגר שאלות")}>
      <QueryState query={rows} lang={lang} />
      <details>
        <summary>
          {tr(lang, "Existing questions", "שאלות קיימות")} (
          {rows.data?.length || 0})
        </summary>
        <ul>
          {rows.data?.map((q) => (
            <li key={q.id}>{bi(q, lang)}</li>
          ))}
        </ul>
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label>
          {tr(lang, "Question in Hebrew", "שאלה בעברית")}
          <input required value={he} onChange={(e) => setHe(e.target.value)} />
        </label>
        <label>
          {tr(lang, "Question in English", "שאלה באנגלית")}
          <input required value={en} onChange={(e) => setEn(e.target.value)} />
        </label>
        {answers.map((a, i) => (
          <fieldset key={i}>
            <legend>
              {tr(lang, "Answer", "תשובה")} {i + 1}
            </legend>
            {(["he", "en"] as const).map((l) => (
              <label key={l}>
                {l === "he"
                  ? tr(lang, "Hebrew", "עברית")
                  : tr(lang, "English", "אנגלית")}
                <input
                  required
                  value={a[l]}
                  onChange={(e) =>
                    setAnswers(
                      answers.map((v, j) =>
                        j === i ? { ...v, [l]: e.target.value } : v,
                      ),
                    )
                  }
                />
              </label>
            ))}
            <label>
              <input
                type="radio"
                name="correct"
                checked={i === correct}
                onChange={() => setCorrect(i)}
              />
              {tr(lang, "Correct answer", "תשובה נכונה")}
            </label>
          </fieldset>
        ))}
        <label>
          {tr(lang, "Seconds", "שניות")}
          <input
            type="number"
            min={5}
            max={120}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </label>
        <button disabled={add.isPending}>
          {tr(lang, "Add question", "הוספת שאלה")}
        </button>
        <ActionState action={add} lang={lang} />
      </form>
    </Section>
  );
}
