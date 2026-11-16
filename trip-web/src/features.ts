// Per-trip feature switches, as the Modern site reads them (#567 S2;
// docs/specs/sprint-9/567-feature-switches.md).
//
// A feature's entry points render only when this says its switch is on. The config's
// `features` map carries the switches that are on for this trip AND that members may
// be told about, each as the literal `true`; absent means off. So this is deliberately
// strict — anything but the literal `true` is off, and a name that is not an own key
// is off — and a feature gated here behaves exactly as if its code were absent when
// its switch is off.
//
// Never read `config.features` directly in a component: ask `featureOn`. That one
// function is where "off unless the literal true" lives.
import type { TripConfig } from "./api";

export function featureOn(
  config: Pick<TripConfig, "features"> | undefined | null,
  name: string,
): boolean {
  const features = config?.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  return Object.prototype.hasOwnProperty.call(features, name) && features[name] === true;
}
