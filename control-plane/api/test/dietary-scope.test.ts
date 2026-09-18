import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCallbackData, renderQuestion } from "../src/chat-router.js";
import { uiString } from "../src/intake-copy.js";
import { buildInterpretPrompt } from "../src/interpret.js";
import { routerPromptKey } from "../src/relay/poller.js";
import {
  INTAKE_QUESTIONS,
  SCOPE_EVERYONE,
  isAnswered,
  needAwaitingScope,
  scopeWithChoice,
  tickedDietaryNeeds,
  type AnswerStore,
  type IntakeAnswer,
} from "../src/interview.js";

// 2026-09-16, live: asked who a dietary need applies to, the organizer answered
// "my wife". It was read at low confidence, refused, then passed over as an
// optional question — and an empty scope means EVERYONE, so one person's
// allergy was recorded against the whole family.
const scopeQuestion = INTAKE_QUESTIONS.find((q) => q.id === "dietary_scope")!;
const structured = (data: unknown): IntakeAnswer => ({ kind: "structured", schema_version: 3, data });
const ROSTER = [{ name: "אלה", name_en: "Ella" }, { name: "נגה", name_en: "Noga" }];
const answers = (scope?: unknown): AnswerStore => ({
  dietary: { kind: "multi_choice", option_ids: ["gluten_free", "vegan"], schema_version: 3, other_text: null },
  travelers: structured(ROSTER),
  ...(scope === undefined ? {} : { dietary_scope: structured(scope) }),
});

describe("who a dietary need applies to", () => {
  test("the needs ticked are asked about one at a time", () => {
    assert.deepEqual(tickedDietaryNeeds(answers()), ["gluten_free", "vegan"]);
    assert.equal(needAwaitingScope(answers()), "gluten_free");
    assert.equal(needAwaitingScope(answers({ gluten_free: ["Ella"] })), "vegan");
    assert.equal(needAwaitingScope(answers({ gluten_free: ["Ella"], vegan: SCOPE_EVERYONE })), null);
  });

  test("a tap records that traveller for the need being asked about, and nobody else", () => {
    assert.deepEqual(scopeWithChoice(answers(), "אלה"), { gluten_free: ["אלה"] });
    assert.deepEqual(scopeWithChoice(answers({ gluten_free: ["אלה"] }), SCOPE_EVERYONE),
      { gluten_free: ["אלה"], vegan: SCOPE_EVERYONE });
  });

  test("the question stays open until every ticked need has an answer", () => {
    assert.equal(isAnswered(scopeQuestion, answers({})), false);
    assert.equal(isAnswered(scopeQuestion, answers({ gluten_free: ["אלה"] })), false, "vegan still has nobody");
    assert.equal(isAnswered(scopeQuestion, answers({ gluten_free: ["אלה"], vegan: ["נגה"] })), true);
  });

  test("it is never passed over in silence, unlike other optional questions", () => {
    assert.equal(scopeQuestion.neverPassedOver, true);
    assert.equal(INTAKE_QUESTIONS.find((q) => q.id === "trip_interests")?.neverPassedOver, undefined);
  });

  test("it is asked with the need it is about, and answered by tapping a name or everyone", () => {
    const choices = scopeQuestion.choicesFrom!(answers());
    assert.deepEqual(choices.map((c) => c.value), [SCOPE_EVERYONE, "אלה", "נגה"]);
    const rendered = renderQuestion(scopeQuestion, [], "he", null, { choices, subject: "ללא גלוטן" });
    assert.match(rendered.text, /^ללא גלוטן — /);
    const buttons = rendered.replyMarkup!.inline_keyboard.flat();
    assert.equal(buttons[0]!.text, uiString("scopeEveryone", "he"), "the wordless button says everyone, in Hebrew");
    assert.deepEqual(buttons.map((b) => b.text).slice(1), ["אלה (Ella)", "נגה (Noga)", uiString("finish", "he")]);
    // No "skip this one": skipping records nobody, and nobody means everyone.
    // Saying everyone is a button of its own.
    assert.equal(buttons.some((b) => b.callback_data.startsWith("k:")), false);
    assert.deepEqual(parseCallbackData(buttons[0]!.callback_data),
      { kind: "answer", questionId: "dietary_scope", optionId: "all" });
  });

  test("an answer that names nobody on the roster is quoted back, not dropped", () => {
    const rendered = renderQuestion(scopeQuestion, [], "he", null, { unsettled: "אישתי" });
    assert.match(rendered.text, /״אישתי״/);
  });

  // 2026-09-16, live: kosher and vegetarian were ticked. The organizer tapped
  // Everyone for kosher, the router went to ask about vegetarian — and the
  // dedupe swallowed it, because both asks were `q:dietary_scope`. The bot
  // thought the question was on screen; the screen said "✅ Everyone". Each
  // side waited for the other and the interview never finished.
  test("asking about the next need is a new message, not a repeat of the last one", () => {
    const keyFor = (store: AnswerStore) =>
      routerPromptKey({ state: "interviewing", subjects: { dietary_scope: scopeQuestion.subjectFrom!(store)! } }, scopeQuestion);
    const first = keyFor(answers({}));
    const second = keyFor(answers({ gluten_free: SCOPE_EVERYONE }));
    assert.notEqual(second, first);
    assert.equal(keyFor(answers({})), first, "the same need, asked again, is still a repeat");
  });
});

describe("the interpreter is shown what it may correct", () => {
  const prompt = (correctable?: { id: string; current: string }[]) => buildInterpretPrompt({
    sourceText: "actually the gluten thing is only Ella",
    outstanding: ["bot_name"],
    language: "he",
    correctable,
  });

  test("answered questions and their current values are listed", () => {
    const text = prompt([{ id: "dietary_scope", current: "everyone" }, { id: "travelers", current: "Ella, Noga" }]);
    assert.match(text, /Already answered/);
    assert.match(text, /id: dietary_scope {2}\(currently: everyone\)/);
    assert.match(text, /id: travelers {2}\(currently: Ella, Noga\)/);
  });

  test("with nothing correctable the section is absent", () => {
    assert.doesNotMatch(prompt(), /Already answered/);
    assert.doesNotMatch(prompt([]), /Already answered/);
  });
});
