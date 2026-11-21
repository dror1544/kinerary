/**
 * The control-plane tests' FAKE site, held to the same case table as the REAL trip site (server/control-plane-auth.js).
 * tests/fixtures/site-binding-cases.json is loaded by relative path: the control-plane workflow checks out the whole
 * repository, so the file is there (control-plane/api/test/child-env-shared.test.ts reaches ../../../shared the same
 * way). The real site runs the same file in tests/control-plane-binding-cases.test.js. No database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAdopt, fakeProvision, fakeRelease, newFakeSiteState, type FakeSitePerson } from "./support/fake-site.js";

interface AdoptCase { dead?: string; name: string; participant: string; existing: string; result: "ok" | "refused" | "conflict"; holder: string }
interface ReleaseCase { name: string; participant: string; existing: string; as: string; released: boolean; holder: string }
const table = JSON.parse(readFileSync(fileURLToPath(new URL("../../../tests/fixtures/site-binding-cases.json", import.meta.url)), "utf8")) as { adopt: AdoptCase[]; release: ReleaseCase[]; provision: AdoptCase[] };

const trip = "trip_cases0001";
const people: FakeSitePerson[] = [{ username: "bob", role: "member" }, { username: "eve", role: "member" }, { username: "alice", role: "organizer" }];
const nameOf = (participant: string) => ({ member: "bob", member2: "eve", organizer: "alice", unknown: "nobody" } as Record<string, string>)[participant]!;
const [ACTOR, PREVIOUS] = ["user_actor000001", "user_previous0001"];

/** What a case's `dead` says the control plane sends (the table's _vocabulary): the binding's own invite id, an unrelated one, or nothing. */
const deadFor = (c: { dead?: string }, bindingInvite: string): { deadInviteIds?: string[] } =>
  c.dead === "binding_invite" ? { deadInviteIds: [bindingInvite] } : c.dead === "other_invite" ? { deadInviteIds: ["invite_unrelated0001"] } : {};

/** Brings the fake to `existing` for `participant`, as the real runner does through the real routes. */
function arrange(state: ReturnType<typeof newFakeSiteState>, existing: string, participant: string) {
  const username = nameOf(participant);
  if (existing === "actor") fakeAdopt(state, people, { tripId: trip, userId: ACTOR, runtimeUsername: username });
  if (existing === "other_user") fakeAdopt(state, people, { tripId: trip, userId: PREVIOUS, runtimeUsername: username });
  if (existing === "invite") { state.bindings.set(`${trip}:${username}`, PREVIOUS); state.invited.add(`${trip}:${username}`); state.inviteIds.set(`${trip}:${username}`, "invite_bindingcases01"); }
  if (existing === "actor_on_other_participant") fakeAdopt(state, people, { tripId: trip, userId: ACTOR, runtimeUsername: "eve" });
}
const holderOf = (state: ReturnType<typeof newFakeSiteState>, participant: string) => {
  const user = state.bindings.get(`${trip}:${nameOf(participant)}`);
  return user === ACTOR ? "actor" : user === PREVIOUS ? "previous" : user === undefined ? "nobody" : "someone else";
};

test("the fake site answers every ADOPT case of the shared table as the real site does", () => {
  for (const c of table.adopt) {
    const state = newFakeSiteState();
    arrange(state, c.existing, c.participant);
    assert.equal(fakeAdopt(state, people, { tripId: trip, userId: ACTOR, runtimeUsername: nameOf(c.participant), ...deadFor(c, "invite_bindingcases01") }), c.result, c.name);
    assert.equal(holderOf(state, c.participant), c.holder, `${c.name}: who holds it afterwards`);
  }
});

test("the fake site answers every RELEASE case of the shared table as the real site does", () => {
  for (const c of table.release) {
    const state = newFakeSiteState();
    arrange(state, c.existing, c.participant);
    const as = c.as === "actor" ? ACTOR : PREVIOUS;
    assert.equal(fakeRelease(state, { tripId: trip, userId: as, runtimeUsername: nameOf(c.participant) }), c.released, c.name);
    assert.equal(holderOf(state, c.participant), c.holder, `${c.name}: who holds it afterwards`);
  }
});

// The personal invite for an existing traveller (S2): the INVITE binding. Same fixture, the `provision` section.
const INVITE = "invite_provisioncase01", OTHER_INVITE = "invite_provisioncase02";
function arrangeProvision(state: ReturnType<typeof newFakeSiteState>, existing: string, participant: string) {
  const username = nameOf(participant);
  if (existing === "actor_invite") assert.equal(fakeProvision(state, people, { tripId: trip, userId: ACTOR, runtimeUsername: username, inviteId: INVITE }), "ok");
  if (existing === "other_user") fakeAdopt(state, people, { tripId: trip, userId: PREVIOUS, runtimeUsername: username });
  if (existing === "invite") assert.equal(fakeProvision(state, people, { tripId: trip, userId: PREVIOUS, runtimeUsername: username, inviteId: OTHER_INVITE }), "ok");
  if (existing === "actor_on_other_participant") fakeAdopt(state, people, { tripId: trip, userId: ACTOR, runtimeUsername: "eve" });
}

test("the fake site answers every PROVISION case of the shared table as the real site does", () => {
  assert.ok(Array.isArray(table.provision) && table.provision.length >= 7, "the table has a provision section");
  for (const c of table.provision) {
    const state = newFakeSiteState();
    arrangeProvision(state, c.existing, c.participant);
    assert.equal(fakeProvision(state, people, { tripId: trip, userId: ACTOR, runtimeUsername: nameOf(c.participant), inviteId: INVITE, ...deadFor(c, OTHER_INVITE) }), c.result, c.name);
    assert.equal(holderOf(state, c.participant), c.holder, `${c.name}: who holds it afterwards`);
  }
});
