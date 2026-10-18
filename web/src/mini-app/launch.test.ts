import { expect, it } from "vitest";
import { miniAppLaunch } from "./launch";

it("accepts only account and opaque trip launch selectors", () => {
  expect(miniAppLaunch("")).toEqual({ kind: "account" });
  expect(miniAppLaunch("?startapp=account")).toEqual({ kind: "account" });
  expect(miniAppLaunch("?tgWebAppStartParam=trip_abcdefgh")).toEqual({ kind: "trip", tripId: "trip_abcdefgh" });
  for (const search of ["?startapp=https://evil.test", "?startapp=//evil.test", "?startapp=trip_../admin", "?startapp=trip_short", "?startapp=account&startapp=trip_abcdefgh", "?startapp=account&tgWebAppStartParam=trip_abcdefgh"]) {
    expect(miniAppLaunch(search)).toEqual({ kind: "invalid" });
  }
});
