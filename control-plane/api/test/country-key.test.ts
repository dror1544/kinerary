import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COUNTRY_KEY_MAX_CHARS, normaliseCountryKey } from "../src/country-key.js";

test("the country_reference key is case-, whitespace- and padding-insensitive", () => {
  const expected = "united states";
  for (const written of ["United States", "  united   states  ", "UNITED STATES", "United  States\n"]) {
    assert.equal(normaliseCountryKey(written), expected, `from ${JSON.stringify(written)}`);
  }
});

test("absent input yields an empty key rather than the string \"undefined\"", () => {
  // Both callers test the result for emptiness and bail; a key of "undefined"
  // would instead be a real row nobody can ever match.
  assert.equal(normaliseCountryKey(undefined), "");
  assert.equal(normaliseCountryKey(null), "");
  assert.equal(normaliseCountryKey("   "), "");
});

test("the key is bounded, and both write paths cut at the same point", () => {
  assert.equal(normaliseCountryKey("a".repeat(500)).length, COUNTRY_KEY_MAX_CHARS);
});

/**
 * A redeclaration of the country-key normaliser, in EITHER form JavaScript
 * offers for one.
 *
 * The original guard matched only `function normaliseCountry`. An arrow
 * reintroduction — `const normaliseCountry = (v) => ...`, which is the form
 * this codebase actually reaches for elsewhere (`const plain = (value) => ...`
 * in consular-lookup.ts, two files away) — sailed straight past it. That is a
 * hole in the protection, not in the thing protected: the test would have
 * stayed green while the two write paths drifted apart, and drift here means
 * the fan-out UPDATE matches zero rows and a paid-for model lookup is thrown
 * away, logged only as destination_info.write_matched_no_rows.
 *
 * `(?:Key)?` covers a redeclaration under either name. An `import { ... as
 * normaliseCountry }` is deliberately NOT matched — aliasing the shared
 * function on import is exactly what interview.ts is supposed to do.
 */
const COUNTRY_KEY_REDECLARATION =
  /(?:function\s+normaliseCountry(?:Key)?\s*\(|(?:const|let|var)\s+normaliseCountry(?:Key)?\s*=)/;

test("the redeclaration guard catches both ways to declare a function", () => {
  // The guard's own protection, asserted rather than assumed — a regex that
  // silently stopped matching would retire the test below without failing it.
  for (const form of [
    "function normaliseCountry(value) { return value; }",
    "const normaliseCountry = (v) => v.trim();",
    "let normaliseCountryKey = function (v) { return v; };",
    "  var normaliseCountry   =   (v) => v;",
    "export function normaliseCountryKey(value: unknown): string {",
  ]) {
    assert.ok(COUNTRY_KEY_REDECLARATION.test(form), `should catch: ${form}`);
  }
  // And must NOT fire on the legitimate shapes, or the guard becomes noise
  // somebody deletes.
  for (const form of [
    'import { normaliseCountryKey as normaliseCountry } from "./country-key.js";',
    'import { normaliseCountryKey } from "./country-key.js";',
    "const dest = normaliseCountryKey(destination);",
    "const home = normaliseCountry(homeCountry);",
  ]) {
    assert.ok(!COUNTRY_KEY_REDECLARATION.test(form), `should not catch: ${form}`);
  }
});

test("only ONE implementation of the country key exists in control-plane/api", async () => {
  // THE FINDING THIS FILE EXISTS FOR. saveConsularContacts INSERTs rows;
  // writeDestinationInfo fans out an UPDATE over the rows it wrote. If the two
  // ever normalise differently the UPDATE matches nothing and a paid-for model
  // lookup is discarded, logged only as destination_info.write_matched_no_rows.
  // They were verbatim copies until #156; this fails if one is reintroduced.
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = ["interview.ts", "destination-info-store.ts"];
  for (const file of files) {
    const source = await readFile(`${srcDir}${file}`, "utf8");
    assert.ok(
      !COUNTRY_KEY_REDECLARATION.test(source),
      `${file} defines its own country-key normaliser again — import normaliseCountryKey from country-key.ts instead`,
    );
    assert.ok(
      source.includes("country-key.js"),
      `${file} should take the country key from the shared module`,
    );
  }
});
