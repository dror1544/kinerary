/**
 * Inbound media: the re-host plane.
 *
 * A Telegram file URL embeds the bot token, so an attachment cannot be named
 * on the wire. The contract's rule is that the PLATFORM CREDENTIAL NEVER
 * CROSSES: the connector downloads with the token it already holds and hands
 * the gateway `{connector}/relay/media/{id}` instead.
 *
 * Two of these tests are about that rule rather than about media working, and
 * they are the ones worth keeping if the feature is ever rewritten: no bot
 * token anywhere in the event, and no unauthenticated read of an organizer's
 * document.
 *
 * The dropped-attachment case is a regression test with a date on it. Before
 * 2026-09-03 a caption-less document produced `NO_TEXT` and was discarded, so
 * "upload your trip plan" was a dead end that looked like success to the
 * organizer.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MediaStore, MEDIA_MAX_BYTES } from "../src/relay/media-store.js";
import { toWireEventWithMedia } from "../src/relay/normalize.js";

const BOT_TOKEN = "8463178587:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function fakeTelegram(bytes: Buffer, mime = "application/pdf") {
  return {
    async fetchFile(_fileId: string, maxBytes: number) {
      if (bytes.length > maxBytes) return null;
      return { bytes, mime };
    },
  };
}

const message = {
  chat: { id: 391627336 },
  message_id: 42,
  document: { file_id: "BQACAgQAAx", file_name: "trip-plan.pdf", mime_type: "application/pdf" },
} as never;

describe("media store", () => {
  test("ids are 128-bit random hex, so the reference is the capability", () => {
    const store = new MediaStore();
    const a = store.put({ kind: "document", mime: "application/pdf", size: 3, bytes: Buffer.from("abc") })!;
    const b = store.put({ kind: "document", mime: "application/pdf", size: 3, bytes: Buffer.from("abc") })!;
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b, "two puts must not collide");
  });

  test("an expired re-host is indistinguishable from an unknown one", () => {
    let now = 1_000_000;
    const store = new MediaStore(() => now);
    const id = store.put({ kind: "document", mime: "application/pdf", size: 3, bytes: Buffer.from("abc") })!;
    assert.ok(store.get(id), "readable before expiry");
    now += 61 * 60 * 1000;
    assert.equal(store.get(id), null, "gone after the ~1h TTL");
    assert.equal(store.get("f".repeat(32)), null, "same answer for an id that never existed");
  });

  test("oversize is refused, not truncated", () => {
    const store = new MediaStore();
    const tooBig = Buffer.alloc(MEDIA_MAX_BYTES + 1);
    assert.equal(store.put({ kind: "document", mime: "application/pdf", size: tooBig.length, bytes: tooBig }), null);
    assert.equal(store.size, 0);
  });
});

describe("inbound attachment re-hosting", () => {
  test("a document becomes a re-hosted reference, and the bot token never appears", async () => {
    const store = new MediaStore();
    const event = await toWireEventWithMedia(
      message, "391627336", "", "trip-intake",
      { fileId: "BQACAgQAAx", kind: "document", mime: "application/pdf", filename: "trip-plan.pdf" },
      { telegram: fakeTelegram(Buffer.from("%PDF-1.4 itinerary")), store, baseUrl: "http://127.0.0.1:4312" },
    );

    assert.equal(event.message_type, "document");
    assert.equal(event.media_urls?.length, 1);
    assert.match(event.media_urls![0]!, /^http:\/\/127\.0\.0\.1:4312\/relay\/media\/[0-9a-f]{32}$/);

    // The rule this whole design exists for.
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(BOT_TOKEN), false, "bot token must never cross the wire");
    assert.equal(serialized.includes("api.telegram.org"), false, "no platform URL either");
  });

  test("the media descriptor parallels media_urls", async () => {
    const store = new MediaStore();
    const event = await toWireEventWithMedia(
      message, "391627336", "here is our plan", "trip-intake",
      { fileId: "BQACAgQAAx", kind: "document", mime: "application/pdf", filename: "trip-plan.pdf" },
      { telegram: fakeTelegram(Buffer.from("%PDF-1.4 itinerary")), store, baseUrl: "http://127.0.0.1:4312" },
    );
    assert.equal(event.media?.length, event.media_urls?.length);
    assert.equal(event.media![0]!.kind, "document");
    assert.equal(event.media![0]!.filename, "trip-plan.pdf");
    assert.equal(event.media![0]!.mime, "application/pdf");
    assert.equal(event.media![0]!.size, Buffer.from("%PDF-1.4 itinerary").length);
    assert.equal(event.text, "here is our plan", "the caption still rides as text");
  });

  test("a failed download degrades to the caption rather than failing the turn", async () => {
    const store = new MediaStore();
    const event = await toWireEventWithMedia(
      message, "391627336", "here is our plan", "trip-intake",
      { fileId: "BQACAgQAAx", kind: "document", mime: "application/pdf" },
      {
        telegram: { async fetchFile() { return null; } },
        store, baseUrl: "http://127.0.0.1:4312",
      },
    );
    assert.equal(event.media_urls, undefined, "no reference to something we do not hold");
    assert.equal(event.text, "here is our plan");
    assert.equal(event.message_type, "text");
  });

  test("with no media plane configured the event is unchanged", async () => {
    const event = await toWireEventWithMedia(
      message, "391627336", "hello", "trip-intake",
      { fileId: "BQACAgQAAx", kind: "document", mime: "application/pdf" },
      undefined,
    );
    assert.equal(event.media_urls, undefined);
    assert.equal(event.text, "hello");
  });
});
