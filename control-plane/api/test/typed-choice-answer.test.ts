/**
 * Typing the name must work as well as tapping it.
 *
 * The standing rule for every button in this interview is that it is a
 * shortcut, not syntax. `organizer_identity` broke it completely: the question
 * is roster-backed, the buttons worked, and an organizer who typed their own
 * name — exactly as the roster spells it, exactly as the question's prompt asks
 * for — was never understood. `interpret` returned zero proposals, the router
 * re-asked, and the interview never completed (2026-09-20, found by the
 * `vietnam` e2e scenario on its first run).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { typedChoiceAnswer } from "../src/interview.js";
import type { AnswerStore } from "../src/interview.js";

const ROSTER: AnswerStore = {
  travelers: {
    kind: "structured",
    schema_version: 3,
    data: [
      { name: "דרור אלול", name_en: "Dror Elul", family: "Elul" },
      { name: "שירן אלול", name_en: "Shiran Elul", family: "Elul" },
      { name: "נועם אלול", name_en: "Noam Elul", family: "Elul" },
    ],
  },
} as unknown as AnswerStore;

describe("typedChoiceAnswer", () => {
  test("the exact roster spelling is recorded, which is what the prompt asks for", () => {
    assert.equal(typedChoiceAnswer("organizer_identity", "דרור אלול", ROSTER), "דרור אלול");
  });

  test("a first name alone is enough, as it is for the button", () => {
    assert.equal(typedChoiceAnswer("organizer_identity", "דרור", ROSTER), "דרור אלול");
  });

  test("the same name in the other alphabet resolves to the roster's own spelling", () => {
    assert.equal(typedChoiceAnswer("organizer_identity", "Dror Elul", ROSTER), "דרור אלול");
  });

  test("a self-description around the name still finds the person", () => {
    assert.equal(typedChoiceAnswer("organizer_identity", "דרור, אבא של המשפחה", ROSTER), "דרור אלול");
  });

  test("a name that matches nobody is left to the model and the re-ask", () => {
    // Not a guess, and not an error either: the model may still make sense of
    // it, and if nothing does the router asks again with the buttons.
    assert.equal(typedChoiceAnswer("organizer_identity", "מישהו אחר", ROSTER), null);
  });

  test("an answer that names two travellers is refused rather than guessed", () => {
    // Guessing between two people is the one failure this cannot afford: it
    // hands a stranger the organizer's private channel.
    const twins: AnswerStore = {
      travelers: {
        kind: "structured",
        schema_version: 3,
        data: [
          { name: "דרור אלול", name_en: "Dror Elul", family: "Elul" },
          { name: "דרור כהן", name_en: "Dror Cohen", family: "Cohen" },
        ],
      },
    } as unknown as AnswerStore;
    assert.equal(typedChoiceAnswer("organizer_identity", "דרור", twins), null);
  });

  test("a question with no choices of its own is not this function's business", () => {
    assert.equal(typedChoiceAnswer("destination", "וייטנאם", ROSTER), null);
    assert.equal(typedChoiceAnswer("bot_name", "פאם", ROSTER), null);
  });

  test("an empty or whitespace answer matches nothing", () => {
    assert.equal(typedChoiceAnswer("organizer_identity", "   ", ROSTER), null);
  });

  test("with no roster recorded yet there is nothing to match against", () => {
    assert.equal(typedChoiceAnswer("organizer_identity", "דרור אלול", {} as AnswerStore), null);
  });
});
