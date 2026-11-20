/**
 * Slice S1 of docs/specs/sprint-9/x-member-sign-in.md, server side: a Telegram person who is live in a trip's one open
 * group may launch the Mini App, be offered the unclaimed non-organizer travellers, claim one and get a member-scoped
 * session; leaving the group closes it. AC-1 to AC-6, AC-8 and AC-9. (AC-7, the organizers' side, is
 * member-claims-routes.test.ts.)
 *
 * Postgres and the Fastify routes are real; Telegram is tools/fake-telegram.ts over HTTP; the trip site's participants
 * are a map the test fills. Every test names its criterion.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { digestTelegramId } from "../src/identity.js";
import { scopedSessionDigest } from "../src/portal-scope.js";
import { activeGroupMember } from "../src/telegram-group-membership.js";
import { LINK_MAX_AUTH_AGE_SECONDS } from "../src/telegram-mini-app.js";
import {
  GROUP_BOT_TOKEN, ORIGIN, asCookie, claim, cookieOf, initDataFor, launch, newGroupChat, notLinkedBody, sha256, startHarness, tg,
  type Harness, type SitePerson,
} from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;

before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

// A trip with an owner, one open group, the switch on, and a site that lists these people.
const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
  { username: "tl31", displayName: "Tamar Levi", role: "member" },
  { username: "org1", displayName: "The Organizer", role: "organizer" },
];
async function groupTrip(people: SitePerson[] = PEOPLE, opts: { switchOn?: boolean } = {}) {
  const tripId = await h.mkTrip("Group trip");
  const owner = await h.mkUser("Owner");
  await h.mkMember(tripId, owner, "owner");
  const chatId = await h.bindGroup(tripId);
  if (opts.switchOn !== false) await h.switchOn(tripId);
  h.site.set(tripId, people.map((p) => ({ ...p })));
  return { tripId, owner, chatId };
}
const names = (body: { travellers: { name: string }[] }) => body.travellers.map((t) => t.name).sort();
const offerOf = async (app: ReturnType<Harness["newApp"]>, tripId: string, telegramId: number) => {
  const response = await launch(app, initDataFor(telegramId, { tripId }));
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { kind: string; tripId: string; travellers: { claimId: string; name: string }[] };
};
const claimIdOf = (offer: { travellers: { claimId: string; name: string }[] }, name: string) => {
  const found = offer.travellers.find((t) => t.name === name);
  assert.ok(found, `${name} is offered`);
  return found.claimId;
};

describe("activeGroupMember: what counts as being in the group (AC-2's definition)", { skip }, () => {
  const check = async (status: string, extra: { isMember?: boolean; mode?: "error" | "timeout" } = {}) => {
    const chat = newGroupChat(), user = tg();
    await h.telegram.member(chat, user, status, extra);
    return activeGroupMember(chat, String(user), { botToken: GROUP_BOT_TOKEN, apiRoot: h.telegram.root, timeoutMs: 400, log: (line) => h.logs.push(line) });
  };

  test("creator, administrator, member and restricted-with-is_member are in; left, kicked and restricted-without are out", async () => {
    for (const status of ["creator", "administrator", "member"]) assert.equal(await check(status), true, status);
    assert.equal(await check("restricted", { isMember: true }), true, "restricted, is_member true");
    for (const status of ["left", "kicked"]) assert.equal(await check(status), false, status);
    assert.equal(await check("restricted", { isMember: false }), false, "restricted, is_member false");
  });

  test("anything doubtful is \"unknown\", never true: restricted with no is_member, an error answer, a timeout, a dead host", async () => {
    assert.equal(await check("restricted"), "unknown", "restricted with no is_member says nothing about being in the room");
    assert.equal(await check("member", { mode: "error" }), "unknown");
    const started = Date.now();
    assert.equal(await check("member", { mode: "timeout" }), "unknown");
    assert.ok(Date.now() - started < 3000, "the timeout bounds the wait");
    assert.equal(await activeGroupMember(newGroupChat(), "5", { botToken: GROUP_BOT_TOKEN, apiRoot: "http://127.0.0.1:1", timeoutMs: 400 }), "unknown", "connection refused does not throw");
    assert.equal(await activeGroupMember("", "5", { botToken: GROUP_BOT_TOKEN, apiRoot: h.telegram.root }), false, "no chat is no membership, and asks nobody");
  });
});

describe("the migration widens telegram_member_links' CHECKs; it does not replace them", { skip }, () => {
  test("verified_via keeps every value an earlier migration allowed (a secondary organizer's link is one), and revoked_reason keeps its own", async () => {
    const defs = (await h.pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'control_plane.telegram_member_links'::regclass AND conname IN ('telegram_member_links_verified_via_check', 'telegram_member_links_revoked_reason_check')`)).rows as { conname: string; def: string }[];
    const verifiedVia = defs.find((d) => d.conname === "telegram_member_links_verified_via_check")!.def;
    for (const value of ["mini_app_trip_password", "mini_app_invite_redemption", "secondary_organizer_link", "mini_app_group_membership"]) assert.ok(verifiedVia.includes(`'${value}'`), `verified_via still allows ${value}`);
    const reasons = defs.find((d) => d.conname === "telegram_member_links_revoked_reason_check")!.def;
    for (const value of ["owner_unlinked", "trip_password_changed", "membership_ended", "invite_revoked", "left_group", "claim_released"]) assert.ok(reasons.includes(`'${value}'`), `revoked_reason allows ${value}`);
  });
});

describe("AC-1: the switch decides, and off is today's answer with no Telegram call", { skip }, () => {
  test("OFF (no setting) answers not_linked/trip_password, byte for byte, and Telegram is never asked", async () => {
    const { tripId, chatId } = await groupTrip(PEOPLE, { switchOn: false });
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const before = await h.telegram.calls("getChatMember");
      const snapshot = await h.snapshot();
      const response = await launch(app, initDataFor(person, { tripId }));
      assert.equal(response.statusCode, 401);
      assert.equal(response.body, notLinkedBody(tripId));
      assert.equal(await h.telegram.calls("getChatMember"), before, "no getChatMember while the switch is off");
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });

  test("an explicit OFF setting, and a switch that cannot be read, are the same answer", async () => {
    const { tripId, chatId } = await groupTrip(PEOPLE, { switchOn: false });
    await h.switchOn(tripId, false);
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    // An unreadable switch: the read throws. featureEnabled takes that as OFF (and logs the switch name only).
    // The read is made on the launch's own transaction, so it fails there as a REAL SQL error (which aborts the
    // transaction unless the savepoint around the read is doing its job).
    const unreadable = new Proxy(h.pool, {
      get(target, prop, receiver) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            const query = client.query.bind(client) as (...a: unknown[]) => unknown;
            const original = { query: client.query, release: client.release };
            (client as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) =>
              /feature_enabled/.test(String(sql)) ? query("SELECT 1/0", []) : query(sql, ...rest);
            // The pool reuses this connection: give it back exactly as it was.
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
              Object.assign(client, original);
              return (original.release as (...a: unknown[]) => void).apply(client, args);
            };
            return client;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = h.newApp({ db: unreadable });
    try {
      const before = await h.telegram.calls("getChatMember");
      for (const [name, instance] of [["explicit off", app], ["unreadable", broken]] as const) {
        const response = await launch(instance, initDataFor(person, { tripId }));
        assert.equal(response.statusCode, 401, name);
        assert.equal(response.body, notLinkedBody(tripId), name);
      }
      assert.equal(await h.telegram.calls("getChatMember"), before);
    } finally { await app.close(); await broken.close(); }
  });

  test("a deployment with no group-membership wiring at all behaves as OFF", async () => {
    const { tripId, chatId } = await groupTrip();
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp({ memberGroupSignIn: undefined });
    try {
      const response = await launch(app, initDataFor(person, { tripId }));
      assert.equal(response.statusCode, 401);
      assert.equal(response.body, notLinkedBody(tripId));
    } finally { await app.close(); }
  });
});

describe("AC-2: a person live in the group is offered the travellers", { skip }, () => {
  test("every active status gets { kind: \"claim\", tripId, travellers } with display names and opaque ids only", async () => {
    const { tripId, chatId } = await groupTrip();
    const app = h.newApp();
    try {
      const variants: Array<[string, { isMember?: boolean }]> = [["member", {}], ["administrator", {}], ["creator", {}], ["restricted", { isMember: true }]];
      for (const [status, extra] of variants) {
        const person = tg();
        await h.telegram.member(chatId, person, status, extra);
        const response = await launch(app, initDataFor(person, { tripId }));
        assert.equal(response.statusCode, 200, status);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(cookieOf(response, "kit_session"), null, "an offer is not a session");
        const body = response.json();
        assert.deepEqual(Object.keys(body).sort(), ["kind", "tripId", "travellers"].sort());
        assert.equal(body.kind, "claim");
        assert.equal(body.tripId, tripId);
        assert.deepEqual(names(body), ["Dana Levi", "Noam Levi", "Tamar Levi"], `${status}: the organizer is not on the list`);
        for (const traveller of body.travellers) {
          assert.deepEqual(Object.keys(traveller).sort(), ["claimId", "name"]);
          assert.match(traveller.claimId, /^pick_[0-9a-f]{48}$/);
        }
        for (const hidden of ["dl17", "nl23", "tl31", "org1", "username", "role", "dashboard", "organizer"]) {
          assert.ok(!response.body.toLowerCase().includes(hidden), `${hidden} is nowhere in the offer`);
        }
      }
    } finally { await app.close(); }
  });

  test("the offer writes nothing, and its ids are the same on every launch but differ between trips for the same username", async () => {
    const one = await groupTrip();
    const two = await groupTrip();
    const person = tg();
    await h.telegram.member(one.chatId, person, "member");
    await h.telegram.member(two.chatId, person, "member");
    const app = h.newApp();
    try {
      const snapshot = await h.snapshot();
      const first = await offerOf(app, one.tripId, person);
      const again = await offerOf(app, one.tripId, person);
      const other = await offerOf(app, two.tripId, person);
      assert.deepEqual(first.travellers, again.travellers, "stable across launches, so a reload does not invalidate the screen");
      assert.notEqual(claimIdOf(first, "Dana Levi"), claimIdOf(other, "Dana Levi"), "dana on trip one is not dana on trip two");
      assert.ok(first.travellers.every((t) => !t.claimId.includes("dl17")));
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });

  test("a person with no one left to claim is still told so (an empty list), not turned away", async () => {
    const { tripId, chatId } = await groupTrip([{ username: "org1", displayName: "The Organizer", role: "organizer" }]);
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const body = await offerOf(app, tripId, person);
      assert.deepEqual(body.travellers, []);
    } finally { await app.close(); }
  });

  test("a site that cannot be read is a retryable 503 for someone already proven to be in the group, and writes nothing", async () => {
    const { tripId, chatId } = await groupTrip();
    h.site.set(tripId, "unreachable");
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const snapshot = await h.snapshot();
      const response = await launch(app, initDataFor(person, { tripId }));
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });
});

describe("AC-3: every way of not being let in is AC-1's answer, byte for byte, with nothing written", { skip }, () => {
  test("not in the group (left, kicked, restricted out), Telegram error, Telegram timeout, restricted-with-no-answer", async () => {
    const { tripId, chatId } = await groupTrip();
    const app = h.newApp();
    try {
      const cases: Array<[string, string, { isMember?: boolean; mode?: "error" | "timeout" }]> = [
        ["left", "left", {}], ["kicked", "kicked", {}], ["restricted, is_member false", "restricted", { isMember: false }],
        ["restricted, no is_member", "restricted", {}], ["Telegram answers an error", "member", { mode: "error" }],
        ["Telegram never answers", "member", { mode: "timeout" }],
      ];
      for (const [name, status, extra] of cases) {
        const person = tg();
        await h.telegram.member(chatId, person, status, extra);
        const snapshot = await h.snapshot();
        const response = await launch(app, initDataFor(person, { tripId }));
        assert.equal(response.statusCode, 401, name);
        assert.equal(response.body, notLinkedBody(tripId), name);
        assert.equal(response.headers["set-cookie"], undefined, name);
        assert.deepEqual(await h.snapshot(), snapshot, `${name}: nothing was written`);
      }
    } finally { await app.close(); }
  });

  test("a trip that does not exist, a retired trip, a trip with no open group, with two, and with only a private chat", async () => {
    const app = h.newApp();
    try {
      const person = tg();
      const none = await groupTrip(); await h.pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE trip_id = $1", [none.tripId]);
      const two = await groupTrip(); const secondChat = await h.bindGroup(two.tripId);
      const privateOnly = await groupTrip(); await h.pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE trip_id = $1", [privateOnly.tripId]); await h.bindPrivate(privateOnly.tripId, person);
      const retired = await h.mkTrip("Retired", { retired: true }); const retiredChat = await h.bindGroup(retired); await h.switchOn(retired); h.site.set(retired, PEOPLE.map((p) => ({ ...p })));
      await h.mkMember(retired, await h.mkUser("Old owner"), "owner");
      for (const chat of [none.chatId, two.chatId, secondChat, retiredChat]) await h.telegram.member(chat, person, "member");
      const unknownTrip = "trip_doesnotexist0000";
      const before = await h.telegram.calls("getChatMember");
      for (const [name, tripId] of [["no open binding", none.tripId], ["two open groups", two.tripId], ["a private chat only", privateOnly.tripId], ["retired", retired], ["unknown", unknownTrip]] as const) {
        const snapshot = await h.snapshot();
        const response = await launch(app, initDataFor(person, { tripId }));
        assert.equal(response.statusCode, 401, name);
        assert.equal(response.body, notLinkedBody(tripId), name);
        assert.deepEqual(await h.snapshot(), snapshot, `${name}: nothing was written`);
      }
      assert.equal(await h.telegram.calls("getChatMember"), before, "no trip here has exactly one open group, so nobody is asked");
    } finally { await app.close(); }
  });

  test("a person who is in the group of trip A cannot use that to open trip B: the trip's OWN binding decides", async () => {
    const a = await groupTrip(); const b = await groupTrip();
    const person = tg();
    await h.telegram.member(a.chatId, person, "member");   // in A's group only
    const app = h.newApp();
    try {
      const response = await launch(app, initDataFor(person, { tripId: b.tripId }));
      assert.equal(response.statusCode, 401);
      assert.equal(response.body, notLinkedBody(b.tripId));
    } finally { await app.close(); }
  });
});

describe("AC-4 and AC-8: who is offered, and what a claim can be", { skip }, () => {
  test("organizers and owners are never offered, on the site or in trip_memberships; claimed and mapped travellers are not offered; unknown roles fail safe", async () => {
    const people: SitePerson[] = [
      { username: "dana", displayName: "Dana", role: "member" },
      { username: "mapped", displayName: "Mapped By Invite", role: "member" },
      { username: "creds", displayName: "Has A Trip Password", role: "member" },
      { username: "cporg", displayName: "Organizer In The Control Plane", role: "member" },
      { username: "free", displayName: "Still Free", role: "member" },
      { username: "siteorg", displayName: "Organizer On The Site", role: "organizer" },
      { username: "siteown", displayName: "Owner On The Site", role: "owner" },
      { username: "viewer", displayName: "A Viewer", role: "viewer" },
      { username: "upper", displayName: "Capital M", role: "Member" },
      { username: "norole", displayName: "No Role" },
      { username: "proto", displayName: "Prototype", role: "constructor" },
      { username: "empty", displayName: "Empty Role", role: "" },
      { username: "nameless", displayName: "", role: "member" },
    ];
    const { tripId, chatId } = await groupTrip(people);
    // mapped through a redeemed invite
    const invited = await h.mkUser("Mapped By Invite");
    await h.mkMember(tripId, invited, "member");
    await h.pool.query(
      "INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at, redeemed_by, redeemed_at) VALUES ($1,$2,(SELECT user_id FROM control_plane.trip_memberships WHERE trip_id=$2 AND role='owner'),'Mapped By Invite','mapped',$3,'redeemed',now() + interval '1 day',$4,now())",
      [`invite_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, tripId, sha256(`mapped-${tripId}`), invited]);
    // an organizer of the trip in the control plane whom the SITE calls a plain member (it is the control plane's word that counts too)
    const org = await h.mkUser("CP organizer");
    await h.mkMember(tripId, org, "organizer");
    await h.pool.query("INSERT INTO control_plane.web_password_credentials(user_id, trip_id, runtime_username, password_hash) VALUES ($1,$2,'cporg','scrypt:xxxxxxxxxxxxxxxx:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy')", [org, tripId]);
    // a trip password mapped to a plain member (a person who already holds a control-plane account for the trip)
    const credUser = await h.mkUser("Has A Trip Password");
    await h.mkMember(tripId, credUser, "member");
    await h.pool.query("INSERT INTO control_plane.web_password_credentials(user_id, trip_id, runtime_username, password_hash) VALUES ($1,$2,'creds','scrypt:xxxxxxxxxxxxxxxx:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy')", [credUser, tripId]);
    // dana is claimed by somebody through this very path
    const claimer = tg();
    await h.telegram.member(chatId, claimer, "member");
    const app = h.newApp();
    try {
      const claimerOffer = await offerOf(app, tripId, claimer);
      const won = await claim(app, initDataFor(claimer, { tripId }), tripId, claimIdOf(claimerOffer, "Dana"));
      assert.equal(won.statusCode, 200, won.body);
      const person = tg();
      await h.telegram.member(chatId, person, "member");
      const offer = await offerOf(app, tripId, person);
      assert.deepEqual(names(offer), ["Still Free"], "dana is claimed, the mapped and organizer-held names are not offered, unknown roles fail safe: one name is left");
    } finally { await app.close(); }
  });

  test("the list is exactly the unclaimed non-organizers, and a claim that succeeds is only ever a member with no dashboard", async () => {
    const { tripId, chatId } = await groupTrip();
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const offer = await offerOf(app, tripId, person);
      assert.deepEqual(names(offer), ["Dana Levi", "Noam Levi", "Tamar Levi"]);
      const won = await claim(app, initDataFor(person, { tripId }), tripId, claimIdOf(offer, "Noam Levi"));
      assert.equal(won.statusCode, 200, won.body);
      const row = (await h.pool.query(
        "SELECT m.role, m.status, m.dashboard_access, m.runtime_access, u.display_name FROM control_plane.trip_participant_claims c JOIN control_plane.trip_memberships m ON m.trip_id = c.trip_id AND m.user_id = c.user_id JOIN control_plane.users u ON u.id = c.user_id WHERE c.trip_id = $1 AND c.runtime_username = 'nl23'", [tripId])).rows;
      assert.deepEqual(row, [{ role: "member", status: "active", dashboard_access: false, runtime_access: true, display_name: "Noam Levi" }]);
    } finally { await app.close(); }
  });

  test("AC-8: a traveller whose role the site changed to anything but member between the list and the claim is refused; the site's own word can never raise the role", async () => {
    const { tripId, chatId } = await groupTrip();
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const offer = await offerOf(app, tripId, person);
      for (const role of ["organizer", "owner", "viewer", "guest", undefined, "constructor"]) {
        h.site.set(tripId, PEOPLE.map((p) => (p.username === "dl17" ? { ...p, role } : { ...p })));
        const snapshot = await h.snapshot();
        const response = await claim(app, initDataFor(person, { tripId }), tripId, claimIdOf(offer, "Dana Levi"));
        assert.equal(response.statusCode, 404, `site role ${String(role)}`);
        assert.deepEqual(response.json(), { error: "NOT_FOUND" });
        assert.deepEqual(await h.snapshot(), snapshot, `site role ${String(role)}: nothing written`);
      }
      h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
      const won = await claim(app, initDataFor(person, { tripId }), tripId, claimIdOf(offer, "Dana Levi"));
      assert.equal(won.statusCode, 200, won.body);
      const { rows } = await h.pool.query("SELECT m.role FROM control_plane.trip_participant_claims c JOIN control_plane.trip_memberships m ON m.user_id = c.user_id AND m.trip_id = c.trip_id WHERE c.trip_id = $1", [tripId]);
      assert.deepEqual(rows.map((r) => r.role), ["member"]);
    } finally { await app.close(); }
  });
});

describe("AC-5: the claim", { skip }, () => {
  test("one transaction writes the user, the member membership, the claim and the link, and mints a scoped session that opens the trip as that traveller", async () => {
    const { tripId, chatId } = await groupTrip();
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const offer = await offerOf(app, tripId, person);
      const before = await h.snapshot();
      const response = await claim(app, initDataFor(person, { tripId, firstName: "Maya", username: "maya_tg" }), tripId, claimIdOf(offer, "Dana Levi"));
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { kind: "session", appPath: `/mini-app/trips/${tripId}` });
      assert.equal(response.headers["cache-control"], "private, no-store");
      const after = await h.snapshot();
      assert.equal(after.users! - before.users!, 1);
      assert.equal(after.trip_memberships! - before.trip_memberships!, 1);
      assert.equal(after.trip_participant_claims! - before.trip_participant_claims!, 1);
      assert.equal(after.telegram_member_links! - before.telegram_member_links!, 1);
      assert.equal(after.web_sessions! - before.web_sessions!, 1);

      const link = (await h.pool.query(
        "SELECT l.id, l.verified_via, l.telegram_subject_digest, l.telegram_first_name, l.telegram_username, l.first_signed_in_at, l.user_id FROM control_plane.telegram_member_links l WHERE l.trip_id = $1", [tripId])).rows[0];
      assert.equal(link.verified_via, "mini_app_group_membership");
      assert.equal(link.telegram_subject_digest, digestTelegramId(String(person)));
      assert.equal(link.telegram_first_name, "Maya");
      assert.equal(link.telegram_username, "maya_tg");
      assert.ok(link.first_signed_in_at, "the claim IS the first sign-in");
      const claimRow = (await h.pool.query("SELECT id, user_id, runtime_username, via, released_at FROM control_plane.trip_participant_claims WHERE trip_id = $1", [tripId])).rows[0];
      assert.equal(claimRow.runtime_username, "dl17");
      assert.equal(claimRow.via, "group_membership");
      assert.equal(claimRow.released_at, null);
      assert.equal(claimRow.user_id, link.user_id);

      // the session is the scoped kind a linked launch mints
      const session = (await h.pool.query("SELECT token_digest, telegram_link_id FROM control_plane.web_sessions WHERE user_id = $1", [link.user_id])).rows[0];
      assert.equal(session.telegram_link_id, link.id);
      assert.equal(session.token_digest, scopedSessionDigest(cookieOf(response, "kit_session")!));
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: asCookie(response) } });
      assert.deepEqual(me.json(), { id: link.user_id, displayName: "Dana Levi", scope: "telegram" });

      // …and it opens the trip as Dana: the launch exchange reads the claim before it reads invites
      const launched = await app.inject({
        method: "POST", url: `/v1/trips/${tripId}/launch`,
        headers: { origin: ORIGIN, cookie: asCookie(response), "x-csrf-token": cookieOf(response, "kit_csrf")! },
      });
      assert.equal(launched.statusCode, 200, launched.body);
      const grant = await app.inject({
        method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" },
        payload: JSON.stringify({ token: launched.json().launchToken }),
      });
      assert.equal(grant.statusCode, 200, grant.body);
      assert.equal(grant.json().runtimeUsername, "dl17");
      assert.equal(grant.json().role, "member");
      assert.equal(grant.json().dashboardUrl, null);
    } finally { await app.close(); }
  });

  test("initData older than the link window is refused, and nothing is written", async () => {
    const { tripId, chatId } = await groupTrip();
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const offer = await offerOf(app, tripId, person);
      const snapshot = await h.snapshot();
      const old = initDataFor(person, { tripId, nowMs: Date.now() - (LINK_MAX_AUTH_AGE_SECONDS + 30) * 1000 });
      const response = await claim(app, old, tripId, claimIdOf(offer, "Dana Levi"));
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: "TELEGRAM_INIT_DATA_STALE" });
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });

  test("the group is re-checked at the claim: someone who left after the list was drawn is refused like a stranger", async () => {
    const { tripId, chatId } = await groupTrip();
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    try {
      const offer = await offerOf(app, tripId, person);
      await h.telegram.member(chatId, person, "left");
      const snapshot = await h.snapshot();
      const response = await claim(app, initDataFor(person, { tripId }), tripId, claimIdOf(offer, "Dana Levi"));
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "NOT_FOUND" });
      assert.deepEqual(await h.snapshot(), snapshot);
      // an unreachable Telegram is the same refusal
      await h.telegram.member(chatId, person, "member", { mode: "error" });
      const unreachable = await claim(app, initDataFor(person, { tripId }), tripId, claimIdOf(offer, "Dana Levi"));
      assert.equal(unreachable.statusCode, 404);
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });

  test("refusals never confirm a guess: a bad id, another trip's id, an id for a trip without the switch, and an unknown trip all answer 404 NOT_FOUND", async () => {
    const a = await groupTrip(); const b = await groupTrip(); const off = await groupTrip(PEOPLE, { switchOn: false });
    const person = tg();
    for (const chat of [a.chatId, b.chatId, off.chatId]) await h.telegram.member(chat, person, "member");
    const app = h.newApp();
    try {
      const offerA = await offerOf(app, a.tripId, person);
      const idA = claimIdOf(offerA, "Dana Levi");
      const snapshot = await h.snapshot();
      const attempts: Array<[string, string, string]> = [
        ["a made-up id", a.tripId, `pick_${"0".repeat(48)}`],
        ["a's id against b", b.tripId, idA],
        ["a's id against the switched-off trip", off.tripId, idA],
        ["a's id against an unknown trip", "trip_doesnotexist0000", idA],
      ];
      const bodies = new Set<string>();
      for (const [name, tripId, claimId] of attempts) {
        const response = await claim(app, initDataFor(person, { tripId }), tripId, claimId);
        assert.equal(response.statusCode, 404, name);
        bodies.add(response.body);
      }
      assert.deepEqual([...bodies], ['{"error":"NOT_FOUND"}']);
      assert.deepEqual(await h.snapshot(), snapshot);
      // malformed input is the one place a 400 is allowed: it is about the request's shape, not the world
      const malformed = await claim(app, initDataFor(person, { tripId: a.tripId }), a.tripId, "not-an-id");
      assert.equal(malformed.statusCode, 400);
      assert.deepEqual(malformed.json(), { error: "INVALID_REQUEST" });
    } finally { await app.close(); }
  });

  test("a second claim of the same traveller — later, by someone else — is 409 ALREADY_CLAIMED and writes nothing", async () => {
    const { tripId, chatId } = await groupTrip();
    const first = tg(), second = tg();
    await h.telegram.member(chatId, first, "member"); await h.telegram.member(chatId, second, "member");
    const app = h.newApp();
    try {
      const offerFirst = await offerOf(app, tripId, first);
      const offerSecond = await offerOf(app, tripId, second);   // drawn BEFORE the first claim
      const won = await claim(app, initDataFor(first, { tripId }), tripId, claimIdOf(offerFirst, "Dana Levi"));
      assert.equal(won.statusCode, 200);
      const snapshot = await h.snapshot();
      const lost = await claim(app, initDataFor(second, { tripId }), tripId, claimIdOf(offerSecond, "Dana Levi"));
      assert.equal(lost.statusCode, 409);
      assert.deepEqual(lost.json(), { error: "ALREADY_CLAIMED" });
      assert.deepEqual(await h.snapshot(), snapshot);
      // the same Telegram account may not hold a second traveller on the same trip either
      const greedy = await claim(app, initDataFor(first, { tripId }), tripId, claimIdOf(offerFirst, "Noam Levi"));
      assert.equal(greedy.statusCode, 409);
      assert.deepEqual(greedy.json(), { error: "ALREADY_CLAIMED" });
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });

  test("a truly concurrent double claim: exactly one 200, one 409 ALREADY_CLAIMED, one claim row, one new account", async () => {
    for (let round = 0; round < 4; round++) {
      const { tripId, chatId } = await groupTrip();
      const one = tg(), two = tg();
      await h.telegram.member(chatId, one, "member"); await h.telegram.member(chatId, two, "member");
      // two processes would each hold their own pool; two apps over one pool race the same way
      const appOne = h.newApp(), appTwo = h.newApp();
      try {
        const offerOne = await offerOf(appOne, tripId, one);
        const offerTwo = await offerOf(appTwo, tripId, two);
        const before = await h.snapshot();
        const [a, b] = await Promise.all([
          claim(appOne, initDataFor(one, { tripId }), tripId, claimIdOf(offerOne, "Tamar Levi")),
          claim(appTwo, initDataFor(two, { tripId }), tripId, claimIdOf(offerTwo, "Tamar Levi")),
        ]);
        assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `round ${round}: ${a.body} / ${b.body}`);
        const loser = a.statusCode === 409 ? a : b;
        assert.deepEqual(loser.json(), { error: "ALREADY_CLAIMED" });
        assert.equal(cookieOf(loser, "kit_session"), null, "the loser gets no session");
        const after = await h.snapshot();
        assert.equal(after.trip_participant_claims! - before.trip_participant_claims!, 1, "one claim row");
        assert.equal(after.users! - before.users!, 1, "the loser's account was rolled back with it");
        assert.equal(after.telegram_member_links! - before.telegram_member_links!, 1);
        assert.equal(after.web_sessions! - before.web_sessions!, 1);
        const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = 'tl31' AND released_at IS NULL", [tripId]);
        assert.equal(rows[0].n, 1);
      } finally { await appOne.close(); await appTwo.close(); }
    }
  });
});

describe("AC-6: the group is checked on every launch", { skip }, () => {
  async function claimed() {
    const ctx = await groupTrip();
    const person = tg();
    await h.telegram.member(ctx.chatId, person, "member");
    const app = h.newApp();
    const offer = await offerOf(app, ctx.tripId, person);
    const response = await claim(app, initDataFor(person, { tripId: ctx.tripId }), ctx.tripId, claimIdOf(offer, "Dana Levi"));
    assert.equal(response.statusCode, 200, response.body);
    const link = (await h.pool.query("SELECT id, user_id FROM control_plane.telegram_member_links WHERE trip_id = $1", [ctx.tripId])).rows[0] as { id: string; user_id: string };
    return { ...ctx, person, app, session: response, link };
  }

  test("still in the group: the next launch is a session for the same account, and Telegram was asked", async () => {
    const c = await claimed();
    try {
      const before = await h.telegram.calls("getChatMember");
      const again = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(again.statusCode, 200, again.body);
      assert.deepEqual(again.json(), { kind: "session", appPath: `/mini-app/trips/${c.tripId}` });
      assert.ok(cookieOf(again, "kit_session"));
      assert.equal(await h.telegram.calls("getChatMember") - before, 1, "re-checked live, once");
    } finally { await c.app.close(); }
  });

  test("left the group: the link and its claim are revoked (left_group), the sessions end, and the person gets AC-1's answer", async () => {
    const c = await claimed();
    try {
      await h.telegram.member(c.chatId, c.person, "left");
      const response = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(response.statusCode, 401);
      assert.equal(response.body, notLinkedBody(c.tripId));
      const link = (await h.pool.query("SELECT revoked_at, revoked_reason FROM control_plane.telegram_member_links WHERE id = $1", [c.link.id])).rows[0];
      assert.ok(link.revoked_at); assert.equal(link.revoked_reason, "left_group");
      const claimRow = (await h.pool.query("SELECT released_at, released_reason FROM control_plane.trip_participant_claims WHERE trip_id = $1", [c.tripId])).rows[0];
      assert.ok(claimRow.released_at); assert.equal(claimRow.released_reason, "left_group");
      const live = (await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [c.link.user_id])).rows[0];
      assert.equal(live.n, 0, "the session the claim minted is over");
      // the session cookie the claim handed out no longer opens anything
      const me = await c.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: asCookie(c.session) } });
      assert.equal(me.statusCode, 401);
      // and the traveller can be claimed again
      const newcomer = tg();
      await h.telegram.member(c.chatId, newcomer, "member");
      assert.ok(names(await offerOf(c.app, c.tripId, newcomer)).includes("Dana Levi"));
      // a person who goes back into the group is simply offered the list again
      await h.telegram.member(c.chatId, c.person, "member");
      const back = await offerOf(c.app, c.tripId, c.person);
      assert.ok(names(back).includes("Dana Levi"));
    } finally { await c.app.close(); }
  });

  test("the person's own Unlink ends the claim too: the name is free again and the card says how the link was proved", async () => {
    const c = await claimed();
    try {
      const card = await c.app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: asCookie(c.session) } });
      assert.equal(card.statusCode, 200, card.body);
      assert.deepEqual(card.json().trips[0].telegram.links.map((l: { via: string }) => l.via), ["group"]);
      const unlink = await c.app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${c.link.id}`, headers: { origin: ORIGIN, cookie: asCookie(c.session), "x-csrf-token": cookieOf(c.session, "kit_csrf")! } });
      assert.equal(unlink.statusCode, 200, unlink.body);
      const claimRow = (await h.pool.query("SELECT released_at, released_reason FROM control_plane.trip_participant_claims WHERE trip_id = $1", [c.tripId])).rows[0];
      assert.ok(claimRow.released_at); assert.equal(claimRow.released_reason, "unlinked");
      const newcomer = tg();
      await h.telegram.member(c.chatId, newcomer, "member");
      assert.ok(names(await offerOf(c.app, c.tripId, newcomer)).includes("Dana Levi"));
    } finally { await c.app.close(); }
  });

  test("an already-open trip session ends as an Unlink's does: /internal/runtime-sessions/check says SESSION_REVOKED", async () => {
    const c = await claimed();
    try {
      const launched = await c.app.inject({
        method: "POST", url: `/v1/trips/${c.tripId}/launch`,
        headers: { origin: ORIGIN, cookie: asCookie(c.session), "x-csrf-token": cookieOf(c.session, "kit_csrf")! },
      });
      const grant = await c.app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ token: launched.json().launchToken }) });
      const { sessionId, userId } = grant.json();
      const check = () => c.app.inject({ method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ tripId: c.tripId, userId, sessionId, role: "member" }) });
      assert.equal((await check()).statusCode, 200, "live while the link stands");
      await h.telegram.member(c.chatId, c.person, "kicked");
      await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      const revoked = await check();
      assert.equal(revoked.statusCode, 401);
      assert.deepEqual(revoked.json(), { error: "SESSION_REVOKED" });

      // the same answer an owner's Unlink of a (non-group) member link gives
      const other = await claimed();
      try {
        const launched2 = await other.app.inject({ method: "POST", url: `/v1/trips/${other.tripId}/launch`, headers: { origin: ORIGIN, cookie: asCookie(other.session), "x-csrf-token": cookieOf(other.session, "kit_csrf")! } });
        const grant2 = await other.app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ token: launched2.json().launchToken }) });
        const unlink = await other.app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${other.link.id}`, headers: { origin: ORIGIN, cookie: asCookie(other.session), "x-csrf-token": cookieOf(other.session, "kit_csrf")! } });
        assert.equal(unlink.statusCode, 200, unlink.body);
        const after = await other.app.inject({ method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ tripId: other.tripId, userId: grant2.json().userId, sessionId: grant2.json().sessionId, role: "member" }) });
        assert.equal(after.statusCode, revoked.statusCode);
        assert.equal(after.body, revoked.body);
      } finally { await other.app.close(); }
    } finally { await c.app.close(); }
  });

  test("Telegram unreachable: no session, nothing revoked, and a retryable answer that does not name the trip", async () => {
    const c = await claimed();
    try {
      for (const mode of ["error", "timeout"] as const) {
        await h.telegram.member(c.chatId, c.person, "member", { mode });
        const sessions = (await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions")).rows[0].n;
        const response = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
        assert.equal(response.statusCode, 503, mode);
        assert.deepEqual(response.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
        assert.ok(!response.body.includes(c.tripId), "the answer does not name the trip");
        assert.equal(cookieOf(response, "kit_session"), null);
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions")).rows[0].n, sessions, "no session minted");
        const link = (await h.pool.query("SELECT revoked_at FROM control_plane.telegram_member_links WHERE id = $1", [c.link.id])).rows[0];
        assert.equal(link.revoked_at, null, "nothing revoked on a doubt");
        const claimRow = (await h.pool.query("SELECT released_at FROM control_plane.trip_participant_claims WHERE trip_id = $1", [c.tripId])).rows[0];
        assert.equal(claimRow.released_at, null);
      }
      // …and when Telegram is back, the same link works
      await h.telegram.member(c.chatId, c.person, "member");
      const ok = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json().kind, "session");
    } finally { await c.app.close(); }
  });

  test("the switch turned OFF closes the door again, without a Telegram call and without revoking anything", async () => {
    const c = await claimed();
    try {
      await h.switchOn(c.tripId, false);
      const before = await h.telegram.calls("getChatMember");
      const response = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(response.statusCode, 401);
      assert.equal(response.body, notLinkedBody(c.tripId));
      assert.equal(await h.telegram.calls("getChatMember"), before);
      const link = (await h.pool.query("SELECT revoked_at FROM control_plane.telegram_member_links WHERE id = $1", [c.link.id])).rows[0];
      assert.equal(link.revoked_at, null, "off is dormant, not destructive");
      await h.switchOn(c.tripId, true);
      assert.equal((await launch(c.app, initDataFor(c.person, { tripId: c.tripId }))).statusCode, 200, "and back on, the same link opens again");
    } finally { await c.app.close(); }
  });
});

describe("AC-9: nothing logs an initData string, a Telegram id or its digest, a chat id or a claim id", { skip }, () => {
  test("across offers, claims, refusals, a Telegram timeout, a revocation and a release, the captured log has none of them", async () => {
    h.logs.length = 0;
    const { tripId, chatId } = await groupTrip();
    const person = tg(), stranger = tg(), flaky = tg();
    await h.telegram.member(chatId, person, "member");
    await h.telegram.member(chatId, flaky, "member", { mode: "timeout" });
    const app = h.newApp();
    const secrets = new Set<string>();
    try {
      const initDatas: string[] = [];
      const send = async <T>(telegramId: number, fn: (initData: string) => Promise<T>): Promise<T> => {
        const initData = initDataFor(telegramId, { tripId, firstName: "Maya", username: "maya_tg" });
        initDatas.push(initData);
        return fn(initData);
      };
      const offer = await send(person, (d) => launch(app, d, tripId));
      const ids = (offer.json() as { travellers: { claimId: string }[] }).travellers.map((t) => t.claimId);
      ids.forEach((x) => secrets.add(x));
      await send(stranger, (d) => launch(app, d, tripId));                 // not in the group
      await send(flaky, (d) => launch(app, d, tripId));                    // Telegram never answers
      await send(person, (d) => claim(app, d, tripId, ids[0]!));          // a claim
      await send(person, (d) => claim(app, d, tripId, ids[1]!));          // a refused second claim
      await send(person, (d) => claim(app, d, tripId, `pick_${"1".repeat(48)}`));
      await h.telegram.member(chatId, person, "left");
      await send(person, (d) => launch(app, d, tripId));                  // revoked on leaving
      const rowIds = (await h.pool.query("SELECT id FROM control_plane.trip_participant_claims WHERE trip_id = $1", [tripId])).rows.map((r) => r.id as string);
      const linkIds = (await h.pool.query("SELECT id FROM control_plane.telegram_member_links WHERE trip_id = $1", [tripId])).rows.map((r) => r.id as string);
      [...rowIds, ...linkIds].forEach((x) => secrets.add(x));
      for (const telegramId of [person, stranger, flaky]) { secrets.add(String(telegramId)); secrets.add(digestTelegramId(String(telegramId))); secrets.add(digestTelegramId(String(telegramId)).slice(7)); }
      secrets.add(chatId); secrets.add(chatId.replace(/^-/, ""));
      for (const initData of initDatas) { secrets.add(initData); secrets.add(/hash=([0-9a-f]{64})/.exec(initData)![1]!); }
      secrets.add(GROUP_BOT_TOKEN);
      assert.ok(h.logs.length > 0, "the routes do log (this test would pass vacuously on an empty log)");
      const log = h.logs.join("\n");
      for (const secret of secrets) assert.ok(!log.includes(secret), `a log line carries a ${secret.length}-char secret starting ${secret.slice(0, 6)}…`);
      assert.ok(!/maya_tg/.test(log), "not the Telegram name either");
    } finally { await app.close(); }
  });
});
