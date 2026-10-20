/**
 * The organizer's way back to the dashboard. The trip server only sends
 * `dashboard_url` to a managed owner/organizer session, and has already limited
 * it to https (or loopback http); the menu checks again before it becomes an
 * href, so a bad value shows no entry rather than a clickable `javascript:`.
 */
export function dashboardHref(value?: string | null) {
  if (typeof value !== "string" || !value || value.length > 2048) return "";
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}
