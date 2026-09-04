/**
 * CommonMark → MarkdownV2, tested against the shapes that actually broke.
 *
 * Every case here traces to a real 400 from Telegram or a real message that
 * rendered as literal asterisks in the יפן 2026 chat.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toTelegramMarkdownV2 } from "../src/relay/markdown.js";

describe("toTelegramMarkdownV2", () => {
  test("bold becomes ONE asterisk, not two", () => {
    // `**bold**` is not bold-with-extra-asterisks in MarkdownV2 — it is an
    // empty entity followed by stray text. This is why it rendered literally.
    assert.equal(toTelegramMarkdownV2("**bold**"), "*bold*");
  });

  test("the reserved characters that produced real 400s are escaped", () => {
    // "Character '-' is reserved" and "Character '.' is reserved" were the two
    // actual failures observed in the relay log.
    assert.equal(toTelegramMarkdownV2("a - b"), "a \\- b");
    assert.equal(toTelegramMarkdownV2("end."), "end\\.");
    assert.equal(toTelegramMarkdownV2("a + b = c!"), "a \\+ b \\= c\\!");
  });

  test("punctuation INSIDE bold is escaped too", () => {
    // The subtle version of the same bug: the entity parses, then the full
    // stop inside it rejects the message anyway.
    assert.equal(toTelegramMarkdownV2("**כן — לאינטייק.**"), "*כן — לאינטייק\\.*");
  });

  test("a real message from the trip chat converts cleanly", () => {
    const input = "יש לי חיבור **ל־MCP של האינטייק** של הטיול.";
    const out = toTelegramMarkdownV2(input);
    assert.ok(out.includes("*ל־MCP של האינטייק*"), "bold uses single asterisks");
    assert.ok(out.endsWith("\\."), "the trailing full stop is escaped");
    assert.ok(!out.includes("**"), "no double asterisks survive");
  });

  test("links keep their target, with the label escaped", () => {
    assert.equal(
      toTelegramMarkdownV2("see [the site](https://japan-2026.ara-united.store/)"),
      "see [the site](https://japan-2026.ara-united.store/)",
    );
    // A dot in the LABEL still needs escaping; a dot in the URL does not.
    assert.equal(
      toTelegramMarkdownV2("[v1.0](https://x.test/a)"),
      "[v1\\.0](https://x.test/a)",
    );
  });

  test("code spans are preserved and not markdown-escaped inside", () => {
    assert.equal(toTelegramMarkdownV2("run `npm test` now"), "run `npm test` now");
    // Reserved characters inside code must NOT be backslash-escaped, or the
    // backslashes show up in the rendered code.
    assert.equal(toTelegramMarkdownV2("`a.b-c`"), "`a.b-c`");
  });

  test("fenced blocks survive with their language stripped", () => {
    assert.equal(toTelegramMarkdownV2("```js\nconst a = 1;\n```"), "```\nconst a = 1;\n```");
  });

  test("italics and strikethrough map to their V2 markers", () => {
    assert.equal(toTelegramMarkdownV2("_soft_"), "_soft_");
    assert.equal(toTelegramMarkdownV2("~~gone~~"), "~gone~");
  });

  test("bold wins over italic when both could match", () => {
    // If `*` were tried first it would consume one asterisk of the `**` pair
    // and everything after it would parse as garbage.
    assert.equal(toTelegramMarkdownV2("**a** and *b*"), "*a* and _b_");
  });

  test("a stray asterisk is escaped rather than opening an entity", () => {
    assert.equal(toTelegramMarkdownV2("2 * 3 = 6"), "2 \\* 3 \\= 6");
  });

  test("plain prose with no markup is left readable", () => {
    assert.equal(
      toTelegramMarkdownV2("Where is the trip?"),
      "Where is the trip?",
      "? is not reserved, so ordinary questions pass through untouched",
    );
  });
});


describe("headings", () => {
  test("## becomes bold, because Telegram has no heading syntax", () => {
    // Otherwise it escapes to a literal "\#\# ..." — which is what appeared in
    // the group chat as visible hashes.
    assert.equal(toTelegramMarkdownV2("## \u05d4\u05ea\u05d5\u05db\u05e0\u05d9\u05ea"), "\n*\u05d4\u05ea\u05d5\u05db\u05e0\u05d9\u05ea*");
  });

  test("every heading level maps the same way", () => {
    for (const hashes of ["#", "###", "######"]) {
      assert.equal(toTelegramMarkdownV2(`${hashes} Title`), "\n*Title*", hashes);
    }
  });

  test("a heading mid-document keeps its own line", () => {
    assert.equal(toTelegramMarkdownV2("intro\n## Plan\nbody"), "intro\n*Plan*\nbody");
  });

  test("a # inside a code fence is left alone", () => {
    // The fence starts earlier in the string, so it wins the earliest-match
    // race and swallows its own contents.
    assert.equal(toTelegramMarkdownV2("```\n# not a heading\n```"), "```\n# not a heading\n```");
  });

  test("a bare # with no following text is not a heading", () => {
    assert.equal(toTelegramMarkdownV2("#hashtag"), "\\#hashtag");
  });
});
