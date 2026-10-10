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
import { rosterChoices, rosterChoicesFor } from "../src/organizer-identity.js";

const organizer = INTAKE_QUESTIONS.find((q) => q.id === "organizer_identity")!;
const text = (t: string): IntakeAnswer => ({ kind: "text", schema_version: 3, text: t });
const roster = (people: unknown[]): IntakeAnswer => ({ kind: "structured", schema_version: 3, data: people });

describe("the organizer question, answered from the roster", () => {
  test("the roster is offered as buttons, and each tap parses back to the organizer question", () => {
    const choices = rosterChoices([{ name: "רון מרגולין", name_en: "Ron Margolin" }, { name: "Maya" }]);
    const rendered = renderQuestion(organizer, [], "en", null, { choices });
    const buttons = rendered.replyMarkup!.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ["רון מרגולין (Ron Margolin)", "Maya"]);
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

  // #321: a name that matches two travellers reads its OWN copy — "which one"
  // rather than "doesn't match any" — and offers only the two it could be.
  test("a name that matched two travellers asks which one, and offers only those two buttons", () => {
    const twoDanas = [{ name: "Dana Levi" }, { name: "Dana Cohen" }, { name: "Omri Levi" }];
    const choices = rosterChoicesFor(twoDanas, [0, 1]);
    const en = renderQuestion(organizer, [], "en", null, { choices, unsettled: "Dana", unsettledKind: "ambiguous" });
    assert.match(en.text, /More than one traveller is called “Dana” — which one are you\?/);
    assert.deepEqual(en.replyMarkup!.inline_keyboard.flat().map((b) => b.text), ["Dana Levi", "Dana Cohen"]);

    const he = renderQuestion(organizer, [], "he", null, { unsettled: "דנה", unsettledKind: "ambiguous" });
    assert.match(he.text, /יותר מנוסע אחד נקרא ״דנה״ — מי מהם זה אתה/);
  });

  test("the same unsettled text falls back to the plain 'matched nobody' copy without a matchKind", () => {
    const rendered = renderQuestion(organizer, [], "en", null, { unsettled: "Dana" });
    assert.match(rendered.text, /“Dana” doesn't match any of the names in the travellers list/);
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

  // #321: the question definition's OWN `choicesFrom`/`unsettledMatchKind` —
  // not the helpers directly — end to end, the way `buildSessionView` actually
  // calls them.
  test("the question's own choicesFrom narrows to the ambiguous pair, and unsettledMatchKind reports it", () => {
    const answers: AnswerStore = {
      travelers: roster([{ name: "Dana Levi" }, { name: "Dana Cohen" }, { name: "Omri Levi" }]),
      organizer_identity: text("Dana"),
    };
    assert.equal(organizer.unsettledMatchKind?.(answers), "ambiguous");
    assert.deepEqual(
      organizer.choicesFrom?.(answers).map((c) => c.value),
      ["Dana Levi", "Dana Cohen"],
    );
  });

  test("choicesFrom offers the whole roster when nothing is on record yet, or nobody matched", () => {
    const roster3 = roster([{ name: "Dana Levi" }, { name: "Omri Levi" }]);
    assert.deepEqual(organizer.choicesFrom?.({ travelers: roster3 }).map((c) => c.value), ["Dana Levi", "Omri Levi"]);
    assert.deepEqual(
      organizer.choicesFrom?.({ travelers: roster3, organizer_identity: text("Grandma Ruth") }).map((c) => c.value),
      ["Dana Levi", "Omri Levi"],
      "unmatched has nobody to narrow to, so the whole roster stays offered — only ambiguous narrows",
    );
  });
});
