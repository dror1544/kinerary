import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdResolver, idKind, normalizeId, stripDevice } from "../src/ids.js";
import { ALICE, NEW_GROUP, OLD_GROUP } from "./helpers.mjs";

test("device suffixes are stripped so the number's own ids compare equal", () => {
  assert.equal(stripDevice("100000000000099:7@lid"), "100000000000099@lid");
  assert.equal(stripDevice("200000000099:12@s.whatsapp.net"), "200000000099@s.whatsapp.net");
  assert.equal(stripDevice("100000000000099@lid"), "100000000000099@lid");
  assert.equal(normalizeId("200000000099@c.us"), "200000000099@s.whatsapp.net");
  assert.equal(stripDevice(undefined), "");
});

test("idKind reads shape only: lid, phone, new group, old group, anything else", () => {
  const rows = [
    [ALICE.lid, "lid"],
    [ALICE.phone, "pn"],
    [NEW_GROUP, "group"],
    [OLD_GROUP, "group"],
    ["status@broadcast", "other"],
    ["120363@newsletter", "other"],
    ["abc@lid", "other"],
    ["", "other"],
    [null, "other"],
  ];
  for (const [id, kind] of rows) assert.equal(idKind(id), kind, String(id));
});

test("resolver: both forms present -> lid canonical, phone beside it, and the pair is learned", async () => {
  const resolver = createIdResolver();
  assert.deepEqual(await resolver.resolve(ALICE.lid, ALICE.phone), { lid: ALICE.lid, phone: ALICE.phone });
  // Later, a phone id alone resolves to the same lid with no lookup.
  assert.deepEqual(await resolver.resolve(ALICE.phone), { lid: ALICE.lid, phone: ALICE.phone });
  assert.deepEqual(await resolver.resolve(ALICE.lid), { lid: ALICE.lid, phone: ALICE.phone });
});

test("resolver: a phone id alone is resolved by the library's own mapping, else reported unknown", async () => {
  const asked = [];
  const resolver = createIdResolver({
    lookupLid: async (pn) => {
      asked.push(pn);
      return pn === ALICE.phone ? ALICE.lid : null;
    },
  });
  assert.deepEqual(await resolver.resolve(ALICE.phone), { lid: ALICE.lid, phone: ALICE.phone });
  assert.deepEqual(await resolver.resolve("200000000077@s.whatsapp.net"), { lid: null, phone: "200000000077@s.whatsapp.net" });
  assert.deepEqual(asked, [ALICE.phone, "200000000077@s.whatsapp.net"]);
});

test("resolver: a throwing lookup is an unknown, never an exception", async () => {
  const resolver = createIdResolver({ lookupLid: async () => { throw new Error("boom"); } });
  assert.deepEqual(await resolver.resolve(ALICE.phone), { lid: null, phone: ALICE.phone });
});

test("resolver: junk in, nothing out (a participant it cannot resolve is not guessed)", async () => {
  const resolver = createIdResolver();
  assert.deepEqual(await resolver.resolve(undefined, "", "not-an-id"), { lid: null, phone: null });
});
