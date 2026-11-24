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
  // `site_video_layout` is RETIRED (owner, 2026-11-21: the classic layout is gone, the video layout is the only one, so
  // there is nothing left to switch). Removed from this list with its off branch, as 567-feature-switches.md decision 3
  // says a finished switch is. A trip file or a stored setting that still names it is harmless: an unregistered name is
  // off, the site drops it at boot with a log line, and the operator command refuses to set it.
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
  // WhatsApp (docs/specs/sprint-9/625-whatsapp-via-relay.md). RECORDED EXCEPTION to "a switch never widens visibility or
  // permission": this switch gates NEW WAYS TO BIND A CHAT (one-time dashboard codes, adding the number to a group, a
  // traveller connecting from the group) and, in the spec's S5, a way to sign in. It enables code paths; it changes no
  // allow-list and no auth middleware, and every route behind it still checks the session and the membership. Decision 5
  // of the spec, agreed by the owner 2026-11-21; docs/specs/sprint-9/x-member-sign-in.md asks for the same exception.
  // Not member-visible: the name of an unreleased feature is itself withheld.
  Object.freeze({
    name: 'whatsapp',
    summary: 'The trip companion on WhatsApp through the relay: dashboard codes bind a private chat or a group, and the relay serves bound WhatsApp chats',
    surfaces: Object.freeze(['relay', 'control_plane']),
    memberVisible: false,
  }),
  // The trip's own logo (docs/specs/sprint-9/x-trip-logo.md). memberVisible because the site's organizer row reads
  // features.trip_logo, and #567 S2 serves only member-visible names. Display of a stored logo never depends on it.
  Object.freeze({
    name: 'trip_logo',
    summary: 'An organizer can set the trip\'s logo (website, companion, Claude/ChatGPT upload link); shown in the header, login page, favicon and installed-app icon',
    surfaces: Object.freeze(['site', 'companion']),
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
