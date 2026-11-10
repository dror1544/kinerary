import type { ComponentPropsWithRef } from "react";

/** The day after an ISO `YYYY-MM-DD` date, or `undefined` when the input is not a real date. */
export function nextDay(isoDate: string | undefined): string | undefined {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * A date input that follows the page's language and direction (the <html>
 * `lang`/`dir`), not the device's. On a phone whose system language is Hebrew
 * the native control otherwise renders right-to-left on an English page (#433).
 */
export function DateInput(props: Omit<ComponentPropsWithRef<"input">, "type">) {
  const root = typeof document === "undefined" ? null : document.documentElement;
  return <input lang={root?.lang || "en"} dir={root?.dir || "ltr"} {...props} type="date" />;
}
