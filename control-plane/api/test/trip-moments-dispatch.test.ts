/**
 * Trip photos and moments through the Telegram dispatcher (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part B): the real
 * `dispatchUpdate` over a real control-plane database, a real `TripMoments` over a fake gateway, a fake clock.
 *
 * What the unit file (trip-moments.test.ts) cannot see: that a Telegram message becomes the right turn - the platform's send
 * time, the replied-to photo, a photo sent as a file, an album's photos - that the switch is read from the REAL
 * `control_plane.feature_enabled`, that a Save tap is claimed before the other button shapes, and that a group moved to another trip
 * forgets what it held. A trip with the switches OFF in the database gets exactly the dispatch decision it got before.
 *
 * DB-backed: needs the control-plane test database (CONTROL_PLANE_TEST_DATABASE_URL).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { resolveTripPerson } from "../src/chat-router.js";
import { setFeatureSwitch } from "../src/feature-switches.js";
import { applyMigrations } from "../src/migrations.js";
import { dispatchUpdate, DEFAULT_STRINGS, type DispatchDecision } from "../src/relay/dispatch.js";
import { GroupContext } from "../src/relay/group-context.js";
import type { TelegramMessage, TelegramUpdate } from "../src/relay/normalize.js";
import { TripMoments } from "../src/relay/trip-moments.js";
import type { PhotoToSave, SaveOutcome, SitePhotoSettings, TripPhotoGateway } from "../src/relay/trip-photo-gateway.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const SKIP = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const GROUP = "-1003000222";
const DANA = 5101;
const BEN = 5102;
const T0_S = 1_780_000_000; // Telegram dates are seconds
const HANDLE = "Kinerary_bot";

class FakeSite implements TripPhotoGateway {
  saved: PhotoToSave[] = [];
  settingsNow: SitePhotoSettings = { photosSwitch: true, momentsSwitch: true, autosave: true, mode: "ask_in_chat", noticePending: false };
  async settings(): Promise<SitePhotoSettings> { return this.settingsNow; }
  async savePhoto(_trip: string, photo: PhotoToSave): Promise<SaveOutcome> {
    this.saved.push(photo);
    return { kind: "saved", photoId: `photo-${this.saved.length}`, duplicate: false, guest: false };
  }
  async ackNotice(): Promise<boolean> { return true; }
}

interface Fixture { pool: pg.Pool; tripId: string }

async function withTrip(fn: (fix: Fixture) => Promise<void>): Promise<void> {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const tripId = `trip_${randomBytes(16).toString("hex")}`;
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state, assistant_names) VALUES ($1, $2, 'draft', $3)", [tripId, tripId.replace(/_/g, "-"), ["Liv"]]);
    for (const chat of [GROUP, String(DANA)]) {
      await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colmar')", [chat, tripId]);
    }
    for (const [id, name] of [[DANA, "Dana Levi"], [BEN, "Ben Cohen"]] as const) {
      await pool.query(
        `INSERT INTO control_plane.trip_person_links(id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
         VALUES ('tpl_' || md5(random()::text), $1, $2, $3, $4, 'participant', 'interview_chat')`,
        [tripId, String(id), name.split(" ")[0]!.toLowerCase(), name],
      );
    }
    await fn({ pool, tripId });
  } finally {
    await pool.end();
  }
}

/** The two switches, in the REAL database, through the resolver the relay reads (`control_plane.feature_enabled`). */
async function setSwitches(pool: pg.Pool, tripId: string, enabled: boolean): Promise<void> {
  for (const name of ["chat_photos_to_album", "trip_moments_capture"]) {
    const result = await setFeatureSwitch(pool, { switch: name, enabled, scope: "trip", trip: tripId, live: true });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
}

function build(fix: Fixture, site: FakeSite, pushed: unknown[] = []) {
  const clock = { t: T0_S * 1000 + 5_000 };
  const groupContext = new GroupContext(() => clock.t);
  const moments = new TripMoments({
    db: fix.pool,
    gateway: site,
    groupContext,
    resolvePerson: (tripId, senderId) => resolveTripPerson(fix.pool, tripId, senderId),
    fetchAttachment: async (ref) => ({ bytes: Buffer.from(`bytes-${ref}`), mime: "image/jpeg" }),
    pushInbound: (event, turn) => { pushed.push({ event, turn }); return true; },
    botUsername: () => HANDLE,
    log: () => {},
    now: () => clock.t,
    autoRunSaver: false,
  });
  const dispatch = (message: TelegramMessage): Promise<DispatchDecision> => dispatchUpdate(
    fix.pool,
    { update_id: message.message_id ?? 1, message } as TelegramUpdate,
    DEFAULT_STRINGS,
    () => {},
    { username: HANDLE, id: "9000" },
    { moments, groupContext },
  );
  return { moments, dispatch, clock, groupContext };
}

let nextId = 700;
const msg = (from: number, fields: Partial<TelegramMessage>, chat: { id: string | number; type: string } = { id: GROUP, type: "supergroup" }): TelegramMessage => {
  nextId += 1;
  return { message_id: nextId, from: { id: from, first_name: from === DANA ? "Dana" : "Ben" }, chat: { ...chat, title: "Colmar" }, date: T0_S, ...fields };
};
const photo = (id: string) => [{ file_id: `${id}-small`, file_size: 100 }, { file_id: id, file_size: 9000 }];

describe("Telegram messages through the dispatcher, with trip moments on", () => {
  test("a group photo is held at the platform's send time and saved as its sender's; nothing goes to the companion", { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      await setSwitches(fix.pool, fix.tripId, true);
      const site = new FakeSite();
      const pushed: unknown[] = [];
      const { moments, dispatch } = build(fix, site, pushed);
      const decision = await dispatch(msg(DANA, { photo: photo("ph-1") }));
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
      await moments.saver.runDue();
      assert.equal(site.saved.length, 1);
      assert.equal(site.saved[0]!.sender, String(DANA));
      assert.equal(site.saved[0]!.sentAtMs, T0_S * 1000, "the platform's own send time");
      assert.equal(site.saved[0]!.bytes.toString(), "bytes-ph-1", "the LARGEST size of the photo");
      assert.deepEqual(pushed, []);
    });
  });

  test("an album (a media group) is every photo saved; a photo sent as a file is saved; a PDF is not", { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      await setSwitches(fix.pool, fix.tripId, true);
      const site = new FakeSite();
      const { moments, dispatch } = build(fix, site);
      await dispatch(msg(DANA, { photo: photo("alb-1"), caption: "Day one", media_group_id: "G1" }));
      await dispatch(msg(DANA, { photo: photo("alb-2"), media_group_id: "G1" }));
      await dispatch(msg(DANA, { photo: photo("alb-3"), media_group_id: "G1" }));
      await dispatch(msg(BEN, { document: { file_id: "file-as-photo", file_name: "IMG_1.jpg", mime_type: "image/jpeg" } }));
      await dispatch(msg(BEN, { document: { file_id: "a-pdf", file_name: "plan.pdf", mime_type: "application/pdf" } }));
      await moments.saver.runDue();
      assert.deepEqual(site.saved.map((s) => s.bytes.toString()), ["bytes-alb-1", "bytes-alb-2", "bytes-alb-3", "bytes-file-as-photo"]);
    });
  });

  test('"@bot save this" in reply to a photo, with saving off: the reply\'s own photo and send time are used', { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      await setSwitches(fix.pool, fix.tripId, true);
      const site = new FakeSite();
      site.settingsNow = { ...site.settingsNow, autosave: false };
      const { moments, dispatch } = build(fix, site);
      const original = msg(BEN, { photo: photo("ben-photo") });
      assert.deepEqual(await dispatch(original), { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.equal(site.saved.length, 0);
      const ask = await dispatch(msg(DANA, { text: `@${HANDLE} save this`, reply_to_message: original }));
      assert.equal(ask.kind, "reply");
      assert.equal(ask.kind === "reply" ? ask.reply.text : "", "Saving it to the trip album.");
      await moments.saver.runDue();
      assert.equal(site.saved.length, 1);
      assert.equal(site.saved[0]!.sender, String(BEN));
      assert.equal(site.saved[0]!.mode, "requested");
    });
  });

  test("a photo in a private chat with no words is one question; a yes saves it", { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      await setSwitches(fix.pool, fix.tripId, true);
      const site = new FakeSite();
      const { moments, dispatch } = build(fix, site);
      const dm = { id: DANA, type: "private" };
      const asked = await dispatch(msg(DANA, { photo: photo("dm-1") }, dm));
      assert.equal(asked.kind === "reply" ? asked.reply.text : "", "Add it to the trip album?");
      await moments.saver.runDue();
      assert.equal(site.saved.length, 0);
      const yes = await dispatch(msg(DANA, { text: "yes" }, dm));
      assert.equal(yes.kind === "reply" ? yes.reply.text : "", "Saving it to the trip album.");
      await moments.saver.runDue();
      assert.equal(site.saved.length, 1);
    });
  });

  test("a Save tap becomes its own decision, claimed before the other button shapes; a tap with no sender is ignored", { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      const site = new FakeSite();
      const { dispatch } = build(fix, site);
      const tap = (data: string, from?: { id: number; first_name: string }) => ({ update_id: 1, callback_query: { id: "cb1", data, from, message: { message_id: 9, chat: { id: GROUP, type: "supergroup" } } } }) as unknown as TelegramUpdate;
      const decision = await dispatchUpdate(fix.pool, tap("mom:s:0123456789abcdef", { id: DANA, first_name: "Dana" }), DEFAULT_STRINGS, () => {}, {}, {});
      assert.deepEqual(decision, { kind: "moment_save", callbackQueryId: "cb1", chatId: GROUP, token: "0123456789abcdef", fromId: String(DANA), fromName: "Dana", language: "en" });
      assert.equal((await dispatchUpdate(fix.pool, tap("mom:s:0123456789abcdef"), DEFAULT_STRINGS, () => {}, {}, {})).kind, "ignore");
      // Not the shape: nothing about it is a moment tap.
      for (const data of ["mom:s:xyz", "mom:s:0123456789abcdef0", "mom:x:0123456789abcdef"]) {
        assert.notEqual((await dispatchUpdate(fix.pool, tap(data, { id: DANA, first_name: "Dana" }), DEFAULT_STRINGS, () => {}, {}, {})).kind, "moment_save", data);
      }
    });
  });

  test("with the trip's switches off in the control plane the dispatch decisions are exactly what they were without moments", { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      await setSwitches(fix.pool, fix.tripId, false);
      const site = new FakeSite();
      const { moments, dispatch } = build(fix, site);
      const plain = (message: TelegramMessage) => dispatchUpdate(fix.pool, { update_id: 1, message } as TelegramUpdate, DEFAULT_STRINGS, () => {}, { username: HANDLE, id: "9000" }, { groupContext: new GroupContext() });
      for (const message of [
        msg(DANA, { photo: photo("off-1") }),
        msg(DANA, { text: `@${HANDLE} save the last photos` }),
        msg(DANA, { photo: photo("off-2") }, { id: DANA, type: "private" }),
      ]) {
        assert.deepEqual(await dispatch(message), await plain(message));
      }
      await moments.saver.runDue();
      assert.deepEqual(site.saved, []);
      assert.equal(moments.held.recent(GROUP).length, 0);
    });
  });

  test("moving the group to another trip forgets its held photos", { skip: SKIP }, async () => {
    await withTrip(async (fix) => {
      await setSwitches(fix.pool, fix.tripId, true);
      const site = new FakeSite();
      site.settingsNow = { ...site.settingsNow, autosave: false };
      const { moments, dispatch } = build(fix, site);
      await dispatch(msg(DANA, { photo: photo("mv-1") }));
      assert.equal(moments.held.recent(GROUP).length, 1);
      moments.clearChat(GROUP);
      assert.equal(moments.held.recent(GROUP).length, 0);
    });
  });
});
