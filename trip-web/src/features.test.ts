import { describe, expect, it } from "vitest";
import { configSchema } from "./api";
import { featureOn } from "./features";

// AC-14: the Modern site gates on `features.<name>`; when it is absent the feature's
// entry points do not render, and the parity schema accepts the `features` key.
describe("the parity schema accepts the features key", () => {
  it("keeps features through configSchema.parse (zod strips keys it does not know)", () => {
    const parsed = configSchema.parse({ meta: { title: "T" }, features: { delivery_probe: true } });
    expect(parsed.features).toEqual({ delivery_probe: true });
  });

  it("parses a config with no features key, and one with features: null (null is absent)", () => {
    expect(configSchema.parse({ meta: { title: "T" } }).features).toBeUndefined();
    expect(configSchema.parse({ meta: { title: "T" }, features: null }).features).toBeUndefined();
  });

  it("a surprising value in the map does not throw the whole config away", () => {
    const parsed = configSchema.parse({ meta: { title: "T" }, features: { delivery_probe: "true", other: 1 } });
    expect(parsed.meta?.title).toBe("T");
    expect(featureOn(parsed, "delivery_probe")).toBe(false);
  });
});

describe("featureOn", () => {
  it("is on only for the literal true", () => {
    expect(featureOn({ features: { delivery_probe: true } }, "delivery_probe")).toBe(true);
  });

  it("is off when the entry points' switch is absent: no features, no config, no name", () => {
    expect(featureOn({}, "delivery_probe")).toBe(false);
    expect(featureOn(undefined, "delivery_probe")).toBe(false);
    expect(featureOn(null, "delivery_probe")).toBe(false);
    expect(featureOn({ features: {} }, "delivery_probe")).toBe(false);
    expect(featureOn({ features: { other_switch: true } }, "delivery_probe")).toBe(false);
  });

  it("is off for anything that is not the literal true", () => {
    for (const bad of [false, "true", 1, null, {}, []]) {
      expect(featureOn({ features: { delivery_probe: bad } }, "delivery_probe")).toBe(false);
    }
  });

  it("is off for inherited names", () => {
    expect(featureOn({ features: {} }, "constructor")).toBe(false);
    expect(featureOn({ features: {} }, "toString")).toBe(false);
    expect(featureOn({ features: {} }, "__proto__")).toBe(false);
  });
});
