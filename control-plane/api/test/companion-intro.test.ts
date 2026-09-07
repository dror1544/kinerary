import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  groupAddUrl,
  groupIntroText,
  organizerIntroText,
  type CompanionIntroFacts,
} from "../src/companion-intro.js";

const BASE: CompanionIntroFacts = {
  assistantName: "Rio",
  tripTitle: "Japan 2026",
  siteUrl: "https://japan-2026.ara-united.store",
  language: "en",
  loginPassword: "trip-seed-pw",
  botUsername: "Kinerary_bot",
  organizerName: "Dror",
  proactive: { morning_briefing: "07:30", flight_changes: true, photo_recap: false },
};

describe("groupAddUrl", () => {
  test("asks for the admin rights it will need, at the moment they are granted", () => {
    // Pinning the arrival message and reading an invite link both need admin.
    // Requesting them in the add link is the only point where the organizer is
    // already in a permissions dialog — afterwards it is a separate
    // promote-to-admin errand that nobody does.
    const url = groupAddUrl("Kinerary_bot", "trip_abc");
    assert.equal(url, "https://t.me/Kinerary_bot?startgroup=trip_abc&admin=pin_messages+invite_users");
  });

  test("without a bot username there is no link to give", () => {
    // Better to omit the line than to render a t.me/undefined.
    assert.equal(groupAddUrl(null, "trip_abc"), null);
    assert.equal(groupAddUrl("", "trip_abc"), null);
  });

  test("a payload that is not link-safe is dropped rather than mangled", () => {
    const url = groupAddUrl("Kinerary_bot", "trip abc/../x");
    assert.equal(url, "https://t.me/Kinerary_bot?startgroup=&admin=pin_messages+invite_users");
  });
});

describe("organizerIntroText", () => {
  test("introduces itself by name and links the site", () => {
    const text = organizerIntroText(BASE);
    assert.match(text, /Rio/);
    assert.match(text, /Japan 2026/);
    assert.match(text, /https:\/\/japan-2026\.ara-united\.store/);
  });

  test("says what it can actually do, including the two the organizer asked for", () => {
    const text = organizerIntroText(BASE);
    // Changing the plan and keeping booking confirmations retrievable are the
    // two capabilities an organizer cannot guess at.
    assert.match(text, /plan/i);
    assert.match(text, /booking|confirmation/i);
  });

  test("carries the login and the password", () => {
    // The organizer's own DM is the uncontroversial place for this.
    const text = organizerIntroText(BASE);
    assert.match(text, /trip-seed-pw/);
  });

  test("with no password set, it says how to log in without inventing one", () => {
    const text = organizerIntroText({ ...BASE, loginPassword: null });
    assert.doesNotMatch(text, /trip-seed-pw/);
    assert.match(text, /https:\/\/japan-2026\.ara-united\.store/);
  });

  test("offers the group-add link with admin rights", () => {
    const text = organizerIntroText({ ...BASE, tripSlug: "japan-2026" });
    assert.match(text, /startgroup=japan-2026&admin=pin_messages\+invite_users/);
  });

  test("omits the group line entirely when no bot username is known", () => {
    const text = organizerIntroText({ ...BASE, botUsername: null });
    assert.doesNotMatch(text, /t\.me/);
    // …and still says everything else.
    assert.match(text, /Rio/);
  });

  test("announces a configured schedule, and stays silent when there is none", () => {
    // "No scheduled messages" is noise. An absent schedule should read as an
    // absent sentence.
    const withSchedule = organizerIntroText(BASE);
    assert.match(withSchedule, /07:30/);

    const without = organizerIntroText({ ...BASE, proactive: {} });
    assert.doesNotMatch(without, /07:30/);
    assert.doesNotMatch(without, /schedule/i);
  });

  test("a schedule of only false flags is no schedule", () => {
    const text = organizerIntroText({
      ...BASE,
      proactive: { tomorrow_preview: false, photo_recap: false, flight_changes: false },
    });
    assert.doesNotMatch(text, /schedule/i);
  });

  test("speaks Hebrew when the trip does", () => {
    const text = organizerIntroText({ ...BASE, assistantName: "ריו", language: "he" });
    assert.match(text, /ריו/);
    assert.match(text, /[֐-׿]/, "the body is Hebrew, not just the name");
    // Facts stay facts in any language.
    assert.match(text, /https:\/\/japan-2026\.ara-united\.store/);
    assert.match(text, /trip-seed-pw/);
  });
});

describe("groupIntroText", () => {
  test("greets the group and links the site", () => {
    const text = groupIntroText(BASE, { includePassword: true });
    assert.match(text, /Rio/);
    assert.match(text, /https:\/\/japan-2026\.ara-united\.store/);
  });

  test("never offers the add-to-group link — it is already in the group", () => {
    const text = groupIntroText(BASE, { includePassword: true });
    assert.doesNotMatch(text, /startgroup/);
  });

  test("includes the shared password when configured to", () => {
    // The trip's login is shared by design, and this message gets pinned so a
    // member who joins later can scroll back to it.
    const text = groupIntroText(BASE, { includePassword: true });
    assert.match(text, /trip-seed-pw/);
  });

  test("points at the organizer instead when configured not to", () => {
    // The single switch: the password stops being posted and the group is told
    // who to ask. Nothing else about the message changes.
    const text = groupIntroText(BASE, { includePassword: false });
    assert.doesNotMatch(text, /trip-seed-pw/);
    assert.match(text, /Dror/);
  });

  test("with no password to share, it still explains the site", () => {
    const text = groupIntroText({ ...BASE, loginPassword: null }, { includePassword: true });
    assert.match(text, /https:\/\/japan-2026\.ara-united\.store/);
  });

  test("shows the group's own invite link when one could be read", () => {
    const text = groupIntroText(
      { ...BASE, groupInviteUrl: "https://t.me/+abc123" },
      { includePassword: true },
    );
    assert.match(text, /https:\/\/t\.me\/\+abc123/);
  });

  test("announces the schedule to the group too", () => {
    // The group is the audience for a morning briefing, so they are owed the
    // same disclosure the organizer gets.
    const text = groupIntroText(BASE, { includePassword: true });
    assert.match(text, /07:30/);
  });

  test("speaks Hebrew when the trip does", () => {
    const text = groupIntroText({ ...BASE, assistantName: "ריו", language: "he" }, { includePassword: true });
    assert.match(text, /[֐-׿]/);
    assert.match(text, /trip-seed-pw/);
  });
});
