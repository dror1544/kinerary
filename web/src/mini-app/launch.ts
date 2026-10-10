export type MiniAppLaunch = { kind: "account" } | { kind: "trip"; tripId: string } | { kind: "invalid" };
export const tripIdPattern = /^trip_[A-Za-z0-9]{8,64}$/;

/** Routing hints only; the ordinary API session remains the authority. */
export function miniAppLaunch(search: string): MiniAppLaunch {
  const params = new URLSearchParams(search);
  const selectors = [...params.getAll("startapp"), ...params.getAll("tgWebAppStartParam")];
  if (selectors.length === 0) return { kind: "account" };
  if (selectors.length !== 1) return { kind: "invalid" };
  const value = selectors[0];
  if (value === "account") return { kind: "account" };
  return tripIdPattern.test(value) ? { kind: "trip", tripId: value } : { kind: "invalid" };
}
