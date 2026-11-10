import { expect, it } from "vitest";
import { safeReturnTo } from "./api";

it("safeReturnTo keeps ordinary paths and a join fragment", () => {
  expect(safeReturnTo("/trips/new")).toBe("/trips/new");
  expect(safeReturnTo("/join#token=abc")).toBe("/join#token=abc");
  expect(safeReturnTo("/trips?x=1#y")).toBe("/trips?x=1#y");
});

it("safeReturnTo refuses another site, before and after the URL parser folds dots (/.//host is //host), and is idempotent", () => {
  for (const attack of ["https://evil.example", "//evil.example", "/\\evil.example", "/.//evil.example", "/trips/../..//evil.example", "/a/..//evil.example/x?y=1#z", null, ""]) {
    expect(safeReturnTo(attack), String(attack)).toBe("/trips");
  }
  for (const sample of ["/trips", "/./evil.example", "/.//evil.example", "/join#token=abc", "/a/./b/../c", null]) {
    const once = safeReturnTo(sample);
    expect(safeReturnTo(once)).toBe(once);
    expect(once.startsWith("//")).toBe(false);
  }
});
