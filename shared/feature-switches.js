// The registry of per-trip feature switches — the ONE place a switch is named.
//
// A feature is written behind a switch name declared here. An operator turns
// the switch on or off for one trip, for every trip, or for trips created from
// now on (control-plane/api/src/feature-switches.ts resolves it: trip, then
// every trip, then future trips, then OFF). docs/specs/sprint-9/567-feature-switches.md
// is the contract.
//
// CLOSED on purpose. A name that is not in this list is OFF everywhere and the
// operator command refuses to set it: a typo in a switch name must never read
// as "on", and a stored row must never be able to introduce a name the code
// does not know. To add a switch, add an entry here — nothing else registers one.
//
// Entry shape:
//   name           ^[a-z][a-z0-9_]{2,40}$  — also the database's CHECK
//   summary        one line: what turning it on does
//   surfaces       where the feature's code runs — 'relay', 'site', 'companion', 'control_plane'
//                  (the API process: the outbox dispatcher and the pollers that start beside it)
//   memberVisible  true only if a signed-in trip member may be told the switch
//                  is on (the site serves it to them). Default false: the NAME
//                  of an unreleased feature is itself something to withhold.
//
// A switch never widens visibility or permission: it may enable a code path,
// not change an allow-list, `normalizeVisibility`, or which auth middleware a
// route uses.
//
// ONE RECORDED EXCEPTION (Dror, 2026-11-19, decision D3 of
// docs/specs/sprint-9/x-member-sign-in.md): a switch may gate a NEW SIGN-IN PATH,
// as long as it never changes an allow-list, a role or a visibility rule. A
// sign-in path is a permission path by nature (it decides who can open a trip),
// so the rule above cannot hold for it; what must hold is that the path is
// switched OFF unless set, that the person it admits holds no role beyond the
// one the code grants (ROLE_RANK stays an allow-list), and that turning the
// switch off closes the path again. `member_group_sign_in` below is the first
// switch to use this exception; a second one needs its own spec and its own
// line here. `member_sign_in_link` (slice S3 of the same spec: "Send me a
// sign-in link", a recovery path for member accounts) is the second: it adds no
// way in that a person did not already have, only a way back to one, and it
// changes no allow-list, role or visibility rule.
//
// CommonJS, like the other shared/ modules, so the trip site (`require`) and
// the control plane (`import`, via feature-switches.d.ts) read the same list.

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;
const SURFACES = Object.freeze(['relay', 'site', 'companion', 'control_plane']);

const FEATURE_SWITCHES = Object.freeze([
  Object.freeze({
    name: 'delivery_probe',
    summary: 'Renders nothing. Exists so the switch path can be proved end to end on staging.',
    surfaces: Object.freeze(['site']),
    memberVisible: true,
  }),
  Object.freeze({
    name: 'site_video_layout',
    summary: 'Modern site: video layout (Today · Plan · Bookings · Photos, day card, Go chip)',
    surfaces: Object.freeze(['site']),
    memberVisible: true,
  }),
  Object.freeze({
    name: 'plan_change_marks',
    summary: 'Plan items carry recent_change; Updated/New badges and "Updated for everyone" on the site',
    surfaces: Object.freeze(['site']),
    memberVisible: true,
  }),
  // Video Release 1C (docs/specs/sprint-9/x-video-r1-group-line.md). memberVisible because the site's
  // organizer toggle reads features.plan_change_group_line, and #567 S2 serves only member-visible names.
  Object.freeze({
    name: 'plan_change_group_line',
    summary: 'Control plane posts one merged line to the trip group when the plan changes; organizer toggle on the site',
    surfaces: Object.freeze(['control_plane', 'site', 'companion']),
    memberVisible: true,
  }),
  // Trip members sign in without a password (docs/specs/sprint-9/x-member-sign-in.md, slice S1). The one switch that
  // uses the sign-in exception in the header. Control plane only: the trip site never reads it, so it is not
  // member-visible and its name is withheld from /api/config.
  Object.freeze({
    name: 'member_group_sign_in',
    summary: 'A person live in the trip\'s Telegram group may open the Mini App, pick their own name from the unclaimed travellers, and sign in as a member',
    surfaces: Object.freeze(['control_plane']),
    memberVisible: false,
  }),
  // "Send me a sign-in link" (docs/specs/sprint-9/x-member-sign-in.md, slice S3, #614). Control plane only, not member-visible.
  // The name door is gated per trip; the email door has no trip and is gated at the every-trip level (sign-in-link.ts).
  Object.freeze({
    name: 'member_sign_in_link',
    summary: 'A member who cannot get in may ask for a one-time sign-in link, sent to their linked Telegram chat or verified email',
    surfaces: Object.freeze(['control_plane']),
    memberVisible: false,
  }),
]);

// Fail loud at load: a malformed registry is a code bug, not a runtime state.
(function assertRegistryShape() {
  const seen = new Set();
  for (const entry of FEATURE_SWITCHES) {
    if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) {
      throw new Error(`shared/feature-switches.js: bad switch name ${JSON.stringify(entry.name)}`);
    }
    if (seen.has(entry.name)) throw new Error(`shared/feature-switches.js: duplicate switch ${entry.name}`);
    seen.add(entry.name);
    if (typeof entry.summary !== 'string' || !entry.summary.trim()) {
      throw new Error(`shared/feature-switches.js: ${entry.name} has no summary`);
    }
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0
        || !entry.surfaces.every((s) => SURFACES.includes(s))) {
      throw new Error(`shared/feature-switches.js: ${entry.name} has bad surfaces`);
    }
    if (typeof entry.memberVisible !== 'boolean') {
      throw new Error(`shared/feature-switches.js: ${entry.name} memberVisible must be a boolean`);
    }
  }
})();

/** The registry entry for `name`, or null for anything that is not a registered name. */
function findSwitch(name) {
  if (typeof name !== 'string') return null;
  return FEATURE_SWITCHES.find((entry) => entry.name === name) || null;
}

function isRegisteredSwitch(name) {
  return findSwitch(name) !== null;
}

module.exports = {
  NAME_PATTERN,
  SURFACES,
  FEATURE_SWITCHES,
  findSwitch,
  isRegisteredSwitch,
};
