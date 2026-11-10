/**
 * The language the page is written in. The document says so (`<html lang>`);
 * the BROWSER's language does not: a Hebrew phone showed "3 באוק׳ 2026" in the
 * middle of an English sentence because dates were formatted with `undefined`
 * (= the browser's locale) while every word around them was English.
 */
export function pageLanguage(): string {
  return document.documentElement.lang || "en";
}

/** "Oct 3, 2026" in the page's language, never the browser's. */
export function formatDay(iso: string, language: string = pageLanguage()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  try {
    return date.toLocaleDateString(language, options);
  } catch {
    // A malformed language tag throws RangeError; the page's default is English.
    return date.toLocaleDateString("en", options);
  }
}

/** "Oct 3, 2026, 10:15 AM" in the page's language, for an expiry the person has to act on. */
export function formatTime(iso: string, language: string = pageLanguage()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  try {
    return date.toLocaleTimeString(language, options);
  } catch {
    return date.toLocaleTimeString("en", options);
  }
}
