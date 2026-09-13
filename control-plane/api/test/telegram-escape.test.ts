/**
 * Who escapes for MarkdownV2, and what the organizer reads when it fails.
 *
 * Live on 2026-09-12, a companion's message arrived as
 *
 *   יש בעיה טכנית עם הדפדפן שלי\.
 *   https://japan\-2026\.ara\-united\.store
 *
 * Two layers had each escaped it. `connector.ts` converted the agent's prose
 * and `sendMessage` converted it again, so every `\.` became `\\\.` — which
 * Telegram rejects as an entity. The fallback then re-sent the text it was
 * GIVEN, escapes and all, as plain text. One converter, and a fallback that
 * sends what a person can read, are the two halves of that.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpTelegramClient } from "../src/relay/telegram-api.js";
import { toTelegramMarkdownV2 } from "../src/relay/markdown.js";

const PROSE = "יש בעיה טכנית עם הדפדפן שלי. תן לי שנייה — https://japan-2026.ara-united.store";

/** Collects each request body; `parseFails` rejects any call carrying parse_mode. */
function stubTelegram(options: { parseFails: boolean }) {
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (options.parseFails && body.parse_mode) {
      return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = realFetch; } };
}

describe("MarkdownV2 escaping", () => {
  test("the caller hands over prose and it is escaped once", async () => {
    const t = stubTelegram({ parseFails: false });
    try {
      const client = new HttpTelegramClient("123:abc", () => {});
      await client.sendMessage({ chatId: "900", text: PROSE, parseMode: "MarkdownV2" });
    } finally {
      t.restore();
    }
    assert.equal(t.bodies[0].text, toTelegramMarkdownV2(PROSE));
    // Escaping is not idempotent, which is exactly why it may happen once.
    assert.notEqual(t.bodies[0].text, toTelegramMarkdownV2(toTelegramMarkdownV2(PROSE)));
  });

  test("when Telegram refuses the entities, the organizer still reads PROSE", async () => {
    const t = stubTelegram({ parseFails: true });
    try {
      const client = new HttpTelegramClient("123:abc", () => {});
      const sent = await client.sendMessage({ chatId: "900", text: PROSE, parseMode: "MarkdownV2" });
      assert.equal(sent.ok, true);
    } finally {
      t.restore();
    }
    assert.equal(t.bodies.length, 2, "one attempt with the dialect, one without");
    const fallback = t.bodies[1];
    assert.equal(fallback.parse_mode, undefined);
    assert.equal(fallback.text, PROSE);
    assert.ok(!String(fallback.text).includes("\\"), "no escape characters reach the reader");
  });

  test("an edit behaves the same — it is agent prose too", async () => {
    const t = stubTelegram({ parseFails: true });
    try {
      const client = new HttpTelegramClient("123:abc", () => {});
      await client.editMessageText({ chatId: "900", messageId: "12", text: PROSE, parseMode: "MarkdownV2" });
    } finally {
      t.restore();
    }
    assert.equal(t.bodies[1].parse_mode, undefined);
    assert.equal(t.bodies[1].text, PROSE);
  });
});

describe("headings become bold lines", () => {
  test("a heading renders as bold, not as a literal hash", () => {
    const out = toTelegramMarkdownV2("## יום 1 — טוקיו\nנחיתה ב-NRT");
    assert.match(out, /\*יום 1 — טוקיו\*/);
    assert.doesNotMatch(out, /\\#/);
  });

  test("every heading level, and closing hashes are dropped", () => {
    assert.match(toTelegramMarkdownV2("# Day one"), /^\*Day one\*$/);
    assert.match(toTelegramMarkdownV2("### Day one ###"), /^\*Day one\*$/);
  });

  test("a hash that is not a heading stays prose", () => {
    // "#1 priority" is how people write "number one", and Telegram is happy to
    // show it — as long as the hash is escaped rather than eaten.
    const out = toTelegramMarkdownV2("#1 priority");
    assert.equal(out, "\\#1 priority");
  });

  test("headings do not disturb the entities around them", () => {
    const out = toTelegramMarkdownV2("## Plan\nsee [the site](https://japan-2026.example) — **today**");
    assert.match(out, /\*Plan\*/);
    assert.match(out, /\[the site\]\(https:\/\/japan-2026\.example\)/);
    assert.match(out, /\*today\*/);
  });
});
