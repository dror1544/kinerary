import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
export type Lang = "he" | "en";
export const tr = (lang: Lang, en: string, he: string) =>
  lang === "he" ? he : en;
export function bi(
  value: string | { he?: string; en?: string } | null | undefined,
  lang: Lang,
) {
  return typeof value === "string"
    ? value
    : value?.[lang] || value?.he || value?.en || "";
}
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="parity-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function QueryState({
  query,
  lang,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  lang: Lang;
}) {
  if (query.isPending)
    return <p role="status">{tr(lang, "Loading…", "טוען…")}</p>;
  if (query.isError)
    return (
      <p role="alert">
        {tr(
          lang,
          "Could not load this information.",
          "לא ניתן לטעון את המידע.",
        )}{" "}
        <button onClick={() => query.refetch()}>
          {tr(lang, "Retry", "ניסיון נוסף")}
        </button>
      </p>
    );
  return null;
}
export function useAction<T = void>(
  lang: Lang,
  keys: string[],
  action: (input: T) => Promise<unknown>,
  onSuccess?: () => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: async () => {
      await Promise.all(
        keys.map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
      onSuccess?.();
    },
  });
}
export function ActionState({
  action,
  lang,
}: {
  action: {
    isError: boolean;
    isSuccess: boolean;
    isPending: boolean;
    error?: unknown;
  };
  lang: Lang;
}) {
  return action.isError ? (
    <p role="alert">
      {action.error instanceof Error &&
      action.error.message === "itinerary_changed_reload_before_retry"
        ? tr(
            lang,
            "The itinerary changed. Your draft is retained; close and reopen the editor to review the latest plan.",
            "המסלול השתנה. הטיוטה נשמרה; סגרו ופתחו מחדש את העורך כדי לבדוק את הגרסה העדכנית.",
          )
        : tr(
            lang,
            "Could not save. Your input is retained; please retry.",
            "השמירה נכשלה. התוכן נשמר בטופס; נסו שוב.",
          )}
    </p>
  ) : action.isPending ? (
    <p role="status">{tr(lang, "Saving…", "שומר…")}</p>
  ) : action.isSuccess ? (
    <p role="status">{tr(lang, "Saved.", "נשמר.")}</p>
  ) : null;
}
export function External({
  url,
  children,
}: {
  url?: string;
  children: ReactNode;
}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
export function PackingCheck({
  storageKey,
  label,
}: {
  storageKey: string;
  label: string;
}) {
  const [checked, setChecked] = useState(
    () => localStorage.getItem(storageKey) === "1",
  );
  return (
    <label className="parity-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          localStorage.setItem(storageKey, e.target.checked ? "1" : "0");
        }}
      />
      {label}
    </label>
  );
}
