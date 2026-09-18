import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCallbackData, renderQuestion } from "../src/chat-router.js";
import {
  INTAKE_QUESTIONS,
  isAnswered,
  partitionQuestions,
  type AnswerStore,
  type IntakeAnswer,
} from "../src/interview.js";
import { rosterChoices } from "../src/organizer-identity.js";

const organizer = INTAKE_QUESTIONS.find((q) => q.id === "organizer_identity")!;
const text = (t: string): IntakeAnswer => ({ kind: "text", schema_version: 3, text: t });
const roster = (people: unknown[]): IntakeAnswer => ({ kind: "structured", schema_version: 3, data: people });

describe("the organizer question, answered from the roster", () => {
  test("the roster is offered as buttons, and each tap parses back to the organizer question", () => {
    const choices = rosterChoices([{ name: "ניר סולומון", name_en: "Nir Solomon" }, { name: "Maya" }]);
    const rendered = renderQuestion(organizer, [], "en", null, { choices });
    const buttons = rendered.replyMarkup!.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ["ניר סולומון (Nir Solomon)", "Maya"]);
    buttons.forEach((button, i) => {
      assert.deepEqual(parseCallbackData(button.callback_data), {
        kind: "answer", questionId: "organizer_identity", optionId: choices[i]!.id,
      });
    });
  });

  test("with no roster yet there are no buttons, only the question", () => {
    const rendered = renderQuestion(organizer, [], "en", null, {});
    assert.equal(rendered.replyMarkup, null);
  });

  test("a name that matched nobody is quoted back, in either language, over any agent phrasing", () => {
    const en = renderQuestion(organizer, [], "en", "Which one are you?", { unsettled: "Grandma Ruth" });
    assert.match(en.text, /“Grandma Ruth” doesn't match any of the names in the travellers list/);
    const he = renderQuestion(organizer, [], "he", null, { unsettled: "רות" });
    assert.match(he.text, /״רות״ לא תואם לאף אחד מהשמות ברשימת הנוסעים/);
  });

  test("an organizer answer counts only when it names exactly one traveller", () => {
    const base: AnswerStore = { travelers: roster([{ name: "Dana" }, { name: "Dina" }]) };
    assert.equal(isAnswered(organizer, { ...base, organizer_identity: text("Dana") }), true);
    assert.equal(isAnswered(organizer, { ...base, organizer_identity: text("דנה") }), false, "sounds like both: never assigned");
    assert.equal(isAnswered(organizer, { ...base, organizer_identity: text("Grandma Ruth") }), false, "not on the roster");
    assert.equal(isAnswered(organizer, { organizer_identity: text("Dana") }), false, "no roster to name anyone from");
  });

  test("an unsettled organizer answer stays outstanding, so the interpreter may answer it again", () => {
    const answers: AnswerStore = { travelers: roster([{ name: "Nir" }]), organizer_identity: text("Grandma Ruth") };
    const { outstanding, answered } = partitionQuestions(answers);
    assert.ok(outstanding.includes("organizer_identity"));
    assert.ok(!answered.includes("organizer_identity"));
  });
});
