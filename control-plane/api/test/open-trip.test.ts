import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  asksForTripApp,
  couldAskForTripApp,
  isOurOpenTripMessage,
  openTripMessage,
  tripAppUrl,
} from "../src/relay/open-trip.js";

const TRIP = "trip_0123456789abcdef0123456789abcdef";

describe("tripAppUrl - the only things that go into the button", () => {
  test("is https://t.me/<bot>?startapp=<trip id>, and nothing else", () => {
    assert.equal(tripAppUrl("Kinerary_bot", TRIP), `https://t.me/Kinerary_bot?startapp=${TRIP}`);
    // A configured handle with its @ is the same handle.
    assert.equal(tripAppUrl("@Kinerary_bot", TRIP), `https://t.me/Kinerary_bot?startapp=${TRIP}`);
  });

  test("refuses a handle or a trip id that is not what Telegram and the Mini App accept", () => {
    assert.equal(tripAppUrl(null, TRIP), null);
    assert.equal(tripAppUrl("", TRIP), null);
    assert.equal(tripAppUrl("bad handle", TRIP), null);
    assert.equal(tripAppUrl("Kinerary_bot/../x", TRIP), null);
    assert.equal(tripAppUrl("Kinerary_bot", "not-a-trip"), null);
    assert.equal(tripAppUrl("Kinerary_bot", `${TRIP}&x=1`), null);
    assert.equal(tripAppUrl("Kinerary_bot", `${TRIP}?token=abc`), null);
  });
});

describe("openTripMessage", () => {
  test("one URL button, in the chat's language, carrying no callback and no secret", () => {
    const en = openTripMessage("Kinerary_bot", TRIP, "en");
    const he = openTripMessage("Kinerary_bot", TRIP, "he");
    assert.ok(en && he);
    assert.deepEqual(en.replyMarkup, {
      inline_keyboard: [[{ text: "Open trip", url: `https://t.me/Kinerary_bot?startapp=${TRIP}` }]],
    });
    assert.match(he.replyMarkup.inline_keyboard[0]![0]!.text, /[֐-׿]/);
    assert.match(he.text, /[֐-׿]/);
    assert.match(he.pinFailedText, /[֐-׿]/);
    assert.deepEqual(Object.keys(en.replyMarkup.inline_keyboard[0]![0]!).sort(), ["text", "url"]);
    // Nothing but the URL's own two parts can be in the message.
    assert.equal(JSON.stringify(en).includes("password"), false);
  });

  test("the pin-failure advice names the right and what to do, once, in plain words", () => {
    const en = openTripMessage("Kinerary_bot", TRIP, "en");
    assert.match(en!.pinFailedText, /admin/i);
    assert.match(en!.pinFailedText, /Pin messages/);
  });

  test("no usable handle, no message - never a half-built link", () => {
    assert.equal(openTripMessage(undefined, TRIP, "en"), null);
    assert.equal(openTripMessage("Kinerary_bot", "nope", "en"), null);
  });
});

describe("isOurOpenTripMessage - which pinned message may be replaced", () => {
  const url = `https://t.me/Kinerary_bot?startapp=${TRIP}`;
  test("the bot's own message with a startapp button is ours", () => {
    assert.equal(isOurOpenTripMessage({ fromId: "55", text: "x", buttonUrls: [url] }, "55"), true);
  });
  test("so is the bot's own message with our exact text (a client that hides the keyboard)", () => {
    const text = openTripMessage("Kinerary_bot", TRIP, "he")!.text;
    assert.equal(isOurOpenTripMessage({ fromId: "55", text, buttonUrls: [] }, "55"), true);
  });
  test("someone else's message is never ours, whatever it says or links to", () => {
    assert.equal(isOurOpenTripMessage({ fromId: "99", text: "x", buttonUrls: [url] }, "55"), false);
    assert.equal(isOurOpenTripMessage({ fromId: null, text: "x", buttonUrls: [url] }, "55"), false);
  });
  test("the bot's other pinned messages (the introduction) are not ours to remove", () => {
    assert.equal(isOurOpenTripMessage({ fromId: "55", text: "Hello everyone, I'm Rio", buttonUrls: [] }, "55"), false);
    assert.equal(isOurOpenTripMessage({ fromId: "55", text: "x", buttonUrls: ["https://example.com/?startapp=trip_abcdefgh"] }, "55"), false);
  });
});

describe("asking for the app in plain words", () => {
  const ctx = { assistantNames: ["Rio", "ריו"], botUsername: "Kinerary_bot" };

  test("the requests a family would actually make", () => {
    for (const text of [
      "app",
      "the app",
      "open app",
      "Open the app please",
      "mini app",
      "open trip",
      "Open the trip",
      "can you send me the app",
      "link to the app",
      "Rio, open the app",
      "@Kinerary_bot app",
      "@Kinerary_bot open trip please",
      "אפליקציה",
      "האפליקציה בבקשה",
      "פתח את הטיול",
      "ריו פתח אפליקציה",
      "תשלח לי את האפליקציה",
    ]) {
      assert.equal(asksForTripApp(text, ctx), true, text);
    }
  });

  test("anything beyond the closed vocabulary is a sentence for the companion, not a request", () => {
    for (const text of [
      "",
      "trip",
      "the trip is great",
      "what is the app for?",
      "I don't like the app",
      "open the window",
      "does the app work on my phone",
      "Rio what time do we leave",
      "app app app app app app app app app app",
      "פתח את החלון",
      "מה האפליקציה עושה",
    ]) {
      assert.equal(asksForTripApp(text, ctx), false, text);
    }
  });

  test("the cheap pre-check lets ordinary sentences skip the lookup", () => {
    assert.equal(couldAskForTripApp("good morning everyone"), false);
    assert.equal(couldAskForTripApp("open app"), true);
    assert.equal(couldAskForTripApp("פתח את הטיול"), true);
  });
});
