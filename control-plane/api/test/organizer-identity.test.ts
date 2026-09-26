import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { namesSoundAlike, resolveOrganizer, rosterChoices, statedNameCandidates } from "../src/organizer-identity.js";

// Shared with the worker's NameMatchingContractTests, so the interview and the
// build cannot come to disagree about who the organizer is.
const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../contracts/v1/name-matching-cases.json", import.meta.url)), "utf8"),
) as {
  alike: [string, string][];
  not_alike: [string, string][];
  resolve: { why: string; roster: unknown[]; answer: string; expect: number | null }[];
};

describe("organizer identity: the shared name-matching cases", () => {
  for (const [a, b] of cases.alike) {
    test(`alike: ${a} / ${b}`, () => {
      assert.equal(namesSoundAlike(a, b), true);
      assert.equal(namesSoundAlike(b, a), true);
    });
  }
  for (const [a, b] of cases.not_alike) {
    test(`not alike: ${a} / ${b}`, () => assert.equal(namesSoundAlike(a, b), false));
  }
  for (const c of cases.resolve) {
    test(`resolve: ${c.why}`, () => {
      const result = resolveOrganizer(c.answer, c.roster);
      assert.equal(result.kind === "matched" ? result.index : null, c.expect);
    });
  }
});

describe("organizer identity", () => {
  test("a Hebrew answer resolves to an English-only roster entry, recording the roster's spelling", () => {
    const result = resolveOrganizer("ניר", [{ name: "Nir", name_en: "Nir" }, { name: "Maya", name_en: "Maya" }]);
    assert.deepEqual(result, { kind: "matched", index: 0, name: "Nir" });
  });

  test("an ambiguous sound-alike is reported as ambiguous, never assigned", () => {
    assert.deepEqual(resolveOrganizer("דנה", [{ name: "Dana" }, { name: "Dina" }]), { kind: "ambiguous" });
  });

  test("someone who is not on the roster is unmatched", () => {
    assert.deepEqual(resolveOrganizer("Grandma Ruth", [{ name: "Nir" }]), { kind: "unmatched" });
  });

  test("no roster yet is its own answer, not a failed match", () => {
    assert.deepEqual(resolveOrganizer("Nir", undefined), { kind: "no_roster" });
  });

  test("the name at the front of a sentence is read, not a name buried later", () => {
    assert.deepEqual(statedNameCandidates("Nir, the dad"), ["nir, the dad", "nir"]);
    assert.deepEqual(statedNameCandidates("I'm Nir"), ["i'm nir", "nir"]);
  });

  test("roster buttons carry the roster's spelling and show the English one beside it", () => {
    const choices = rosterChoices([{ name: "רון מרגולין", name_en: "Ron Margolin" }, { name: "Maya" }]);
    assert.deepEqual(choices.map(({ label, value }) => ({ label, value })), [
      { label: "רון מרגולין (Ron Margolin)", value: "רון מרגולין" },
      { label: "Maya", value: "Maya" },
    ]);
    // Position plus a fingerprint of the name: a valid callback token, and a
    // different id when a different person holds the same position.
    assert.match(choices[0]!.id, /^p0_[0-9a-f]{6}$/);
    assert.notEqual(rosterChoices([{ name: "Maya" }])[0]!.id, rosterChoices([{ name: "Omer" }])[0]!.id);
  });
});
