/**
 * The relay's client for a trip's photo routes (relay/trip-photo-gateway.ts) and the phrases it acts on (relay/photo-requests.ts).
 *
 * The client: what it sends (the exchange key to the gateway's origin only, the sender's Telegram id and never a username, the
 * bytes whole), how it classifies every answer (saved / refused / unreachable), and that a setting the site does not state exactly
 * is off and an unknown mode is organizer_draft. The phrases: a table of what is a save request, and what is NOT - the relay acts
 * on a recognised phrase with no model turn, so anything it does not recognise must come back as null.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpTripPhotoGateway } from "../src/relay/trip-photo-gateway.js";
import { isNo, isYes, parseSaveRequest, plainRequestText } from "../src/relay/photo-requests.js";

const ORIGIN = "https://runtime.example.test";
const KEY = "exchange-key-for-tests";
const TRIP = "trip_chatphotos001";

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown; redirect?: string }

function client(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { calls, gateway: new HttpTripPhotoGateway({ runtimeOrigin: `${ORIGIN}/`, exchangeKey: KEY, fetchImpl }) };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PHOTO = { sender: "101", messageKey: "-100:7", mode: "auto" as const, sentAtMs: Date.UTC(2026, 11, 3, 12), mime: "image/jpeg", bytes: Buffer.from("jpeg-bytes") };

describe("saving a photo", () => {
  test("goes to the gateway's route with the exchange key, the Telegram id, the idempotency key and the bytes; nothing names a username", async () => {
    const { gateway, calls } = client(() => json(200, { ok: true, duplicate: false, photo: { id: "p1", username: "dana", guest: false } }));
    const outcome = await gateway.savePhoto(TRIP, PHOTO);
    assert.deepEqual(outcome, { kind: "saved", photoId: "p1", duplicate: false, guest: false });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${ORIGIN}/internal/t/${TRIP}/photos`);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["x-api-key"], KEY);
    assert.equal(call.redirect, "manual", "the key is never sent where a redirect points");
    assert.deepEqual(call.body, { tripId: TRIP, sender: "101", messageKey: "-100:7", mode: "auto", sentAt: "2026-12-03T12:00:00.000Z", mime: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64") });
    assert.ok(!("username" in (call.body as object)) && !("uploaded_for" in (call.body as object)));
  });

  test("a duplicate answer is a save (the photo is there)", async () => {
    const { gateway } = client(() => json(200, { ok: true, duplicate: true, photo: { id: "p1", guest: true } }));
    assert.deepEqual(await gateway.savePhoto(TRIP, PHOTO), { kind: "saved", photoId: "p1", duplicate: true, guest: true });
  });

  test("a 4xx is a refusal that carries the site's reason; a 5xx, a timeout and a network error are unreachable", async () => {
    for (const [status, body] of [[409, { error: "autosave_off" }], [403, { error: "guest_requires_autosave" }], [401, { error: "AUTHENTICATION_REQUIRED" }], [400, { error: "unsupported_file_type" }], [413, { error: "BODY_TOO_LARGE" }]] as const) {
      const { gateway } = client(() => json(status, body));
      assert.deepEqual(await gateway.savePhoto(TRIP, PHOTO), { kind: "refused", status, error: body.error }, String(status));
    }
    for (const status of [500, 502, 503, 504, 408, 429]) {
      const { gateway } = client(() => json(status, { error: "RUNTIME_UNAVAILABLE" }));
      assert.equal((await gateway.savePhoto(TRIP, PHOTO)).kind, "unreachable", String(status));
    }
    const down = client(() => { throw new TypeError("fetch failed"); });
    assert.deepEqual(await down.gateway.savePhoto(TRIP, PHOTO), { kind: "unreachable", reason: "NETWORK" });
    const slow = client(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
    assert.deepEqual(await slow.gateway.savePhoto(TRIP, PHOTO), { kind: "unreachable", reason: "TIMEOUT" });
  });

  test("a 200 that is not an answer is a refusal and a redirect is unreachable (retried within the TTL) - never a save", async () => {
    assert.equal((await client(() => json(200, { ok: true })).gateway.savePhoto(TRIP, PHOTO)).kind, "refused");
    assert.equal((await client(() => new Response("<html>nope</html>", { status: 200 })).gateway.savePhoto(TRIP, PHOTO)).kind, "refused");
    const redirect = await client(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })).gateway.savePhoto(TRIP, PHOTO);
    assert.equal(redirect.kind, "unreachable");
  });
});

describe("the settings read", () => {
  test("reads the two settings; the trip id is in the path, the key in the header, and nothing is sent in a body", async () => {
    const { gateway, calls } = client(() => json(200, { chat_photos_to_album: true, trip_moments_capture: true, group_photo_autosave: true, moment_capture_mode: "publish", autosave_notice_pending: true, participants: [{ telegram_id: "4242", username: "bob", name: "בוב", name_en: "Bob" }, { telegram_id: "x", username: "bad" }, "junk"] }));
    assert.deepEqual(await gateway.settings(TRIP), { photosSwitch: true, momentsSwitch: true, autosave: true, mode: "publish", noticePending: true, participants: [{ telegramId: "4242", username: "bob", name: "בוב", nameEn: "Bob" }] });
    assert.equal(calls[0]!.url, `${ORIGIN}/internal/t/${TRIP}/photo-settings`);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.body, undefined);
  });

  test("anything but a literal true is off, and an unknown mode is organizer_draft", async () => {
    const odd = client(() => json(200, { chat_photos_to_album: "true", trip_moments_capture: 1, group_photo_autosave: "yes", moment_capture_mode: "Publish", autosave_notice_pending: "true" }));
    assert.deepEqual(await odd.gateway.settings(TRIP), { photosSwitch: false, momentsSwitch: false, autosave: false, mode: "organizer_draft", noticePending: false, participants: [] });
    const empty = client(() => json(200, {}));
    assert.deepEqual(await empty.gateway.settings(TRIP), { photosSwitch: false, momentsSwitch: false, autosave: false, mode: "organizer_draft", noticePending: false, participants: [] });
  });

  test("an unreadable site is null, which the relay reads as 'save nothing'", async () => {
    for (const answer of [() => json(401, {}), () => json(503, {}), () => new Response("not json", { status: 200 }), () => { throw new TypeError("down"); }]) {
      assert.equal(await client(answer).gateway.settings(TRIP), null);
    }
  });

  test("the notice acknowledgement is a POST with the trip id in the body", async () => {
    const { gateway, calls } = client(() => json(200, { ok: true }));
    assert.equal(await gateway.ackNotice(TRIP), true);
    assert.equal(calls[0]!.url, `${ORIGIN}/internal/t/${TRIP}/photo-notice`);
    assert.deepEqual(calls[0]!.body, { tripId: TRIP });
    assert.equal(await client(() => json(409, { error: "feature_off" })).gateway.ackNotice(TRIP), false);
  });
});

describe("what is a save request", () => {
  const plain = (text: string) => plainRequestText(text, ["Liv"]);

  test("requests that mean a photo", () => {
    for (const text of ["@KinneryBot save this", "Liv, save this!", "@KinneryBot please save this photo", "@KinneryBot Save it to the trip", "add this to the album", "@Bot keep this picture in the trip album please", "תשמור את זה", "@Bot שמור את זה לאלבום", "תוסיף את התמונה לטיול"]) {
      assert.equal(parseSaveRequest(plain(text)), "this", text);
    }
    for (const text of ["@KinneryBot save the last photos", "save the last 3 photos", "@Bot save these photos to the album", "save all the latest pictures", "תשמור את התמונות האחרונות", "@Bot שמור את כל התמונות"]) {
      assert.equal(parseSaveRequest(plain(text)), "last", text);
    }
  });

  test("everything else is null, so it goes to the companion as before", () => {
    for (const text of [
      "save this photo for the album cover idea, what do you think", "save that as a trip moment", "save the photos", "what do you think of the last photos",
      "can you save this?", "do not save this", "save", "save this for me to read later on the train tomorrow morning at nine", "תשמור את זה כרגע ותספר לי מה השעה",
      "", "@KinneryBot", "delete this photo", "save the date",
    ]) {
      assert.equal(parseSaveRequest(plain(text)), null, text);
    }
  });

  test("yes and no, whole-message only", () => {
    for (const word of ["yes", "Yes!", "ok", "sure", "כן", "בטח", "save it"]) assert.equal(isYes(plain(word)), true, word);
    for (const word of ["yes but not that one", "yesterday", "maybe", "no photos please", ""]) assert.equal(isYes(plain(word)), false, word);
    for (const word of ["no", "No thanks", "nope", "לא", "לא תודה"]) assert.equal(isNo(plain(word)), true, word);
    for (const word of ["no way, that is great", "not sure", ""]) assert.equal(isNo(plain(word)), false, word);
  });
});
