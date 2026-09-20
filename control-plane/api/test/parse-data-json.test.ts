/**
 * A structured answer with a stray closing bracket is still the answer it wrote;
 * anything genuinely broken is still refused.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDataJson, parseInterpretPayload } from "../src/interpret.js";

const STOPS = '[{"name":"Tokyo","start":"2026-09-19","end":"2026-09-23","planned":["Tokyo Skytree"]},{"name":"Osaka","start":"2026-09-27","end":"2026-09-30"}]';

describe("parseDataJson", () => {
  test("valid JSON parses as it always did", () => {
    assert.deepEqual(parseDataJson(STOPS), JSON.parse(STOPS));
    assert.deepEqual(parseDataJson('{"a": 1}'), { a: 1 });
  });

  test("a complete value followed only by stray closing brackets is taken as written", () => {
    assert.deepEqual(parseDataJson(`${STOPS}}`), JSON.parse(STOPS), "the 2026-09-13 codex output");
    assert.deepEqual(parseDataJson(`${STOPS} ]}\n`), JSON.parse(STOPS));
  });

  test("brackets inside strings do not end the value", () => {
    const tricky = '[{"name":"Hotel ]} Tokyo","note":"quote \\" and } inside"}]';
    assert.deepEqual(parseDataJson(`${tricky}}`), JSON.parse(tricky));
  });

  test("anything else that does not parse is refused", () => {
    assert.equal(parseDataJson(`${STOPS},{"name":"Kyoto"}]`), undefined, "trailing content is not noise");
    assert.equal(parseDataJson(STOPS.slice(0, -10)), undefined, "a truncated answer is not guessed at");
    assert.equal(parseDataJson("not json"), undefined);
    assert.equal(parseDataJson(`${STOPS}x`), undefined);
  });

  test("a proposal carrying the stray bracket is no longer malformed", () => {
    const payload = parseInterpretPayload({
      proposals: [{
        questionId: "phases",
        confidence: 0.99,
        evidence: "Tokyo Sep 19 - Sep 23",
        value: { kind: "structured", dataJson: `${STOPS}}` },
      }],
      unclear: [],
    }, []);
    assert.equal(payload?.malformed, 0);
    assert.equal(payload?.proposals.length, 1);
  });
});
