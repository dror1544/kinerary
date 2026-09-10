/**
 * The rule these protect: a message keeps its links AND survives Telegram's
 * parser. Before this, agent text went out raw, Telegram rejected it on the
 * first full stop, and `telegram-api.ts` re-sent it with `parse_mode` removed
 * — delivering the words and silently dropping every link, which is what an
 * organizer reported as "the link is not identified, it looks like plain text".
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeMarkdownV2, toTelegramMarkdownV2 } from "../src/relay/markdown.js";

describe("MarkdownV2 escaping", () => {
  test("ordinary prose survives, punctuation and all", () => {
    // Every one of these characters would otherwise abort the whole message.
    const out = toTelegramMarkdownV2("Landing at 09:40 (FCO) - bring passports.");
    assert.ok(out.includes("\\(FCO\\)"), out);
    assert.ok(out.includes("\\-"), out);
    assert.ok(out.endsWith("passports\\."), out);
  });

  test("a link keeps its label and its URL intact", () => {
    const out = toTelegramMarkdownV2("See [Fushimi Inari](https://maps.google.com/?q=a-b_c.d)");
    // The URL must NOT be prose-escaped: a backslash inside it breaks the link.
    assert.ok(out.includes("(https://maps.google.com/?q=a-b_c.d)"), out);
    assert.ok(out.includes("[Fushimi Inari]"), out);
  });

  test("a label with punctuation is escaped without touching the URL", () => {
    const out = toTelegramMarkdownV2("[Tokyo Skytree (Oshiage)](https://example.com/x.y)");
    assert.ok(out.includes("\\(Oshiage\\)"), out);
    assert.ok(out.includes("(https://example.com/x.y)"), out);
  });

  test("Hebrew prose with a link — the real shape that failed", () => {
    const out = toTelegramMarkdownV2(
      "הנה הקישור: [מקדש פושימי אינארי](https://www.google.com/maps/search/?api=1&query=Fushimi%20Inari) - שווה ביקור.",
    );
    assert.ok(out.includes("[מקדש פושימי אינארי]"), out);
    assert.ok(out.includes("query=Fushimi%20Inari)"), out);
    assert.ok(out.includes("\\-"), out);
  });

  test("bold and italic render as entities, their contents escaped", () => {
    assert.ok(toTelegramMarkdownV2("**day 1.**").includes("*day 1\\.*"));
    assert.ok(toTelegramMarkdownV2("*soon.*").includes("_soon\\._"));
  });

  test("code keeps its contents verbatim apart from backticks", () => {
    const out = toTelegramMarkdownV2("run `a.b-c` now");
    assert.ok(out.includes("`a.b-c`"), out);
  });

  test("a bare URL is escaped rather than half-parsed", () => {
    // Not a link entity, so it must be inert text — Telegram autolinks it
    // anyway, and a half-escaped one is what produced parse errors.
    const out = toTelegramMarkdownV2("https://example.com/a_b.c");
    assert.ok(!out.includes("]("), out);
    assert.ok(out.includes("\\."), out);
  });

  test("an unmatched bracket cannot abort the message", () => {
    const out = toTelegramMarkdownV2("see [this and nothing else");
    assert.ok(out.includes("\\["), out);
  });

  test("escapeMarkdownV2 covers every reserved character", () => {
    for (const ch of "_*[]()~`>#+-=|{}.!") {
      assert.equal(escapeMarkdownV2(ch), `\\${ch}`, `unescaped: ${ch}`);
    }
  });
});
