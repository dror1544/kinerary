/**
 * ONE group rule, not two (closing round of docs/specs/sprint-9/x-member-sign-in.md).
 *
 * "Is this person still in the trip's group?" is asked by the Mini App launch (`groupLinkVerdict`, telegram-mini-app.ts) and by the
 * sign-in link's gate (`claimGateVerdict`, sign-in-link.ts). It used to be written out twice. It is now `groupSeatVerdict`, which both
 * call. This file pins that three ways:
 *   1. the rule itself, with spies: what it reads, in what order, and what it never calls;
 *   2. a table of situations run through BOTH real entry points (the launch route and the gate), which must give the same verdict;
 *   3. neither entry point carries its own copy of the rule's tail any more.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { claimGateVerdict } from "../src/sign-in-link.js";
import { groupSeatVerdict, type GroupSeatReads, type GroupSeatVerdict } from "../src/telegram-mini-app.js";
import { claim, initDataFor, launch, startHarness, tg, type Harness } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

describe("the rule, with spies", () => {
  function spied(answers: { switchOn?: boolean; chat?: string | null; member?: true | false | "unknown" }) {
    const calls: string[] = [];
    const reads: GroupSeatReads = {
      switchOn: async (tripId) => { calls.push(`switch:${tripId}`); return answers.switchOn ?? true; },
      openChat: async (tripId) => { calls.push(`chat:${tripId}`); return answers.chat === undefined ? "-1001" : answers.chat; },
      isActiveMember: async (chat, user) => { calls.push(`member:${chat}:${user}`); return ("member" in answers ? answers.member : true) as true | false | "unknown"; },
    };
    return { reads, calls };
  }
  const input = { tripId: "trip_abcdefgh", telegramUserId: "777" };

  test("switch, then the one open group, then a live Telegram answer; in | out | unknown", async () => {
    const order = ["switch:trip_abcdefgh", "chat:trip_abcdefgh", "member:-1001:777"];
    for (const [member, expected] of [[true, "in"], [false, "out"], ["unknown", "unknown"]] as const) {
      const { reads, calls } = spied({ member });
      assert.equal(await groupSeatVerdict(reads, input), expected);
      assert.deepEqual(calls, order, `${String(member)}: read in this order, Telegram asked once`);
    }
  });

  test("dormant, and Telegram is never asked: no wiring, the switch off, no single open group", async () => {
    assert.equal(await groupSeatVerdict(undefined, input), "dormant");
    const off = spied({ switchOn: false });
    assert.equal(await groupSeatVerdict(off.reads, input), "dormant");
    assert.deepEqual(off.calls, ["switch:trip_abcdefgh"], "switch off: nothing else is read");
    const noGroup = spied({ chat: null });
    assert.equal(await groupSeatVerdict(noGroup.reads, input), "dormant");
    assert.deepEqual(noGroup.calls, ["switch:trip_abcdefgh", "chat:trip_abcdefgh"], "no open group: Telegram is not asked");
  });

  test("anything that is not exactly `true` from Telegram is never `in`", async () => {
    for (const member of [undefined, null, 0, 1, "true", "member", {}] as unknown[]) {
      const { reads } = spied({ member: member as true });
      assert.notEqual(await groupSeatVerdict(reads, input), "in", JSON.stringify(member));
    }
  });
});

describe("the same verdict from the launch and from the link's gate", { skip: !testDatabaseUrl() }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.stop(); });

  /** A claimed traveller (through the real claim route), then whatever the situation does to the trip and the group. */
  async function claimed() {
    const tripId = await h.mkTrip("Seat verdicts");
    const owner = await h.mkUser("Owner"); await h.mkMember(tripId, owner, "owner");
    const chatId = await h.bindGroup(tripId);
    await h.bindPrivate(tripId, tg());
    await h.switchOn(tripId);
    h.site.set(tripId, [{ username: "dl17", displayName: "Dana Levi", role: "member" }]);
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const app = h.newApp();
    const offer = (await launch(app, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
    const made = await claim(app, initDataFor(person, { tripId }), tripId, offer.travellers[0]!.claimId);
    assert.equal(made.statusCode, 200, made.body);
    return { tripId, chatId, person, app };
  }
  type Situation = Awaited<ReturnType<typeof claimed>>;

  const SITUATIONS: Array<[string, GroupSeatVerdict, (s: Situation) => Promise<void>]> = [
    ["in the group, switch on, one open group", "in", async () => undefined],
    ["the switch is off", "dormant", async (s) => h.switchOn(s.tripId, false)],
    ["the group binding is closed (no open group)", "dormant", async (s) => { await h.pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test_closed' WHERE trip_id = $1 AND chat_id = $2", [s.tripId, s.chatId]); }],
    ["two open groups", "dormant", async (s) => { await h.bindGroup(s.tripId); }],
    ["the person left", "out", async (s) => h.telegram.member(s.chatId, s.person, "left")],
    ["the person was removed", "out", async (s) => h.telegram.member(s.chatId, s.person, "kicked")],
    ["Telegram answers with an error", "unknown", async (s) => h.telegram.member(s.chatId, s.person, "member", { mode: "error" })],
    ["Telegram does not answer in time", "unknown", async (s) => h.telegram.member(s.chatId, s.person, "member", { mode: "timeout" })],
  ];

  for (const [label, expected, apply] of SITUATIONS) {
    test(`${label}: the gate and the launch both say "${expected}"`, async () => {
      const s = await claimed();
      try {
        await apply(s);
        // The gate (read-only, so it can go first).
        const gate = await claimGateVerdict({ db: h.pool, groupSignIn: h.deps().memberGroupSignIn, log: (line) => h.logs.push(line) }, { tripId: s.tripId, telegramUserId: String(s.person) });
        assert.equal(gate, expected, "the sign-in link's gate");
        // The launch, read back as a verdict: a session is "in"; the retryable 503 is "unknown"; otherwise the person is turned away
        // and the claim is either ended ("out") or left alone ("dormant").
        const response = await launch(s.app, initDataFor(s.person, { tripId: s.tripId }));
        const claimEnded = Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NOT NULL", [s.tripId])).rows[0].n) === 1;
        const viaLaunch: GroupSeatVerdict =
          response.statusCode === 200 && (response.json() as { kind?: string }).kind === "session" ? "in"
          : response.statusCode === 503 && (response.json() as { error?: string }).error === "MEMBERSHIP_CHECK_UNAVAILABLE" ? "unknown"
          : claimEnded ? "out" : "dormant";
        assert.equal(viaLaunch, expected, `the Mini App launch (${response.statusCode} ${response.body})`);
      } finally { await s.app.close(); }
    });
  }

  test("a gate with no group wiring, or a claim with no Telegram id, is dormant without asking anyone", async () => {
    const before = await h.telegram.calls("getChatMember");
    assert.equal(await claimGateVerdict({ db: h.pool, groupSignIn: undefined, log: () => undefined }, { tripId: "trip_abcdefgh", telegramUserId: "5" }), "dormant");
    assert.equal(await claimGateVerdict({ db: h.pool, groupSignIn: h.deps().memberGroupSignIn, log: () => undefined }, { tripId: "trip_abcdefgh", telegramUserId: null }), "dormant");
    assert.equal(await h.telegram.calls("getChatMember"), before);
  });
});

describe("neither entry point restates the rule", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  const bodyOf = (text: string, start: string) => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `${start} exists`);
    return text.slice(from, text.indexOf("\n}\n", from));
  };

  test("groupLinkVerdict (launch) and claimGateVerdict (link) call groupSeatVerdict and hold no Telegram-answer branches of their own", () => {
    const launchBody = bodyOf(source("telegram-mini-app.ts"), "async function groupLinkVerdict(");
    const gateBody = bodyOf(source("sign-in-link.ts"), "export async function claimGateVerdict(");
    for (const [name, body] of [["groupLinkVerdict", launchBody], ["claimGateVerdict", gateBody]] as const) {
      assert.ok(body.includes("groupSeatVerdict("), `${name} calls the shared rule`);
      assert.ok(!/\bmember\s*===/.test(body), `${name} does not branch on Telegram's answer itself`);
    }
  });
});
