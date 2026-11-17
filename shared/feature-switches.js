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
