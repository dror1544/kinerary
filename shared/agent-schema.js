// Single source of truth for the `agent` block in trip.config.json — the
// per-trip personalization layer for the bot that escorts the trip (Telegram
// group companion + private organizer channel). Imported by server.js
// (CommonJS require), driver.mjs and the test suite (ESM import), same
// arrangement as shared/needs-schema.js.
//
// This block does NOT restate the agent's behavioral contract — tone rules,
// the group/organizer two-mode boundary, source precedence, proactive-message
// policy and the rest live in the FamilyTrip-Agent-Handoff and are the same
// for every trip. What lives here is only what changes per trip: what the
// family calls the bot, which language and grammatical gender it speaks in,
// who the organizer is, which proactive messages this family opted into, and
// the standing instructions specific to these people.

const allow = require('./allow-list');

const AGENT_TONES     = ['warm', 'playful', 'dry'];
// Grammatical, not social. Hebrew conjugates verbs by gender, so the bot
// literally cannot form a sentence without knowing which to use — this is a
// language requirement, and it's why 'neutral' is a real option rather than a
// polite default (Hebrew has no clean neuter, so 'neutral' means "prefer
// gender-avoidant phrasing", which the agent handles as a style constraint).
const AGENT_GENDERS   = ['male', 'female', 'neutral'];
const VISIBILITIES    = ['group', 'organizer'];

// Proactive message types the family can opt into. Deliberately a closed set:
// the handoff's §8.2 rule is that proactive messages must be "rare, timely and
// useful", and an open-ended list is how a trip companion turns into a spammer.
const PROACTIVE_KEYS  = [
  'morning_briefing',   // §8.3 — today only, one or two reminders max
  'tomorrow_preview',   // short tomorrow-at-a-glance, evening
  'photo_recap',        // §8.4 — grounded in actual new uploads
  'flight_changes',     // only when materially actionable
  'packing_reminders',  // weather/activity-driven, day-before
];

// A standing instruction is free text an organizer wrote about how to treat
// specific people ("Dana's mum tires easily, keep walks short"). That is
// sensitive by default in a way a dietary preference is not, and /api/config
// is served with no auth at all — so unlike participants[].needs, where only
// medical/allergy default to organizer-only, EVERY standing instruction
// defaults to organizer-only. Group visibility must be opted into explicitly,
// per instruction, by someone who has read the text.
function defaultInstructionVisibility() {
  return 'organizer';
}

// Fail safe, not fail quiet: an omitted visibility takes the restrictive
// default, and an explicit-but-unrecognized one (a typo like "grup") also
// resolves restrictive rather than falling through as visible.
function normalizeInstructionVisibility(visibility) {
  if (visibility === undefined) return defaultInstructionVisibility();
  return VISIBILITIES.includes(visibility) ? visibility : 'organizer';
}

// Cosmetic fields — an unrecognized value here is a config typo, not a
// disclosure risk, so these fall back to the least surprising option rather
// than the most restrictive one.
function normalizeTone(tone) {
  return AGENT_TONES.includes(tone) ? tone : 'warm';
}

function normalizeGender(gender) {
  return AGENT_GENDERS.includes(gender) ? gender : 'neutral';
}

// Couples planning together need two organizers; older configs only ever
// wrote the single `organizer` string. Every consumer (the boot warning,
// organizerOrAgentRequired, driver.mjs, /api/agent/brief) works off this one
// normalized list instead of each branching on which key is present.
function normalizeOrganizers(agent) {
  if (!agent) return [];
  if (Array.isArray(agent.organizers)) return agent.organizers.filter(Boolean);
  if (agent.organizer) return [agent.organizer];
  return [];
}

// The public view of the agent block is an ALLOW-list (issue #172). Until
// 2026-09-25 this deep-copied the block and fixed up tone, gender and the
// standing instructions, so any other key anyone ever wrote into `agent` —
// an internal profile name, a key, a note — was served to every family member.
// Now only the keys below are served; anything else is dropped and reported
// (see shared/allow-list.js).
//
// These are the keys the scaffolder's _derive_agent() writes plus the legacy
// single `organizer`. What they are FOR on the public read path: `name` /
// `name_en` are what the site calls the bot (trip-web App.tsx); the rest is
// the persona the old deny-list already served and GET /api/config's tests
// pin (gender survives because Hebrew needs it to conjugate). Anything
// organizer-only belongs in GET /api/agent/brief, never here.
const INSTRUCTION_PUBLIC = allow.object({ visibility: allow.scalar, text: allow.text });
const AGENT_PUBLIC_FIELDS = {
  name: allow.scalar,
  name_en: allow.scalar,
  // Normalized, never raw: an unrecognized value becomes the default, so a
  // typo cannot put an arbitrary author-chosen string on the wire.
  tone: allow.custom(v => normalizeTone(v)),
  gender: allow.custom(v => normalizeGender(v)),
  default_language: allow.scalar,
  timezone: allow.scalar,
  organizer: allow.scalar,
  organizers: allow.list(allow.scalar),
  // A closed set in the schema already (PROACTIVE_KEYS); an unknown key is a
  // typo the boot warning reports, and is not served.
  proactive: allow.object(Object.fromEntries(PROACTIVE_KEYS.map(k => [k, allow.scalar]))),
  // Group-visible instructions only. An organizer-only one is WITHHELD — known
  // and kept back on purpose — and a zero-length list drops its key: an empty
  // array tells a reader that hidden instructions exist.
  standing_instructions: allow.custom((value, report, path) => {
    if (!Array.isArray(value)) { report.dropped.push(path); return allow.OMIT; }
    const visible = [];
    value.forEach((raw, i) => {
      const at = `${path}[${i}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { report.dropped.push(at); return; }
      // Read once: the visibility that decides is the visibility that is
      // served (see the same rule in config-visibility.js's needs).
      const ins = allow.snapshot(raw);
      if (normalizeInstructionVisibility(ins.visibility) === 'organizer') { report.withheld.push(at); return; }
      const v = allow.project(ins, INSTRUCTION_PUBLIC, report, at);
      if (v !== allow.OMIT) visible.push(v);
    });
    return visible.length ? visible : allow.OMIT;
  }),
};
const AGENT_PUBLIC = allow.object(AGENT_PUBLIC_FIELDS);

// Returns undefined for a missing block so callers can leave the key off the
// payload rather than emit an empty object (an empty `agent: {}` would itself
// signal "this trip has a bot with instructions you can't see").
function projectAgent(agent, report = allow.newReport(), path = 'agent') {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return undefined;
  const a = allow.snapshot(agent);
  const out = allow.project(a, AGENT_PUBLIC, report, path);
  // tone and gender are always present on the public view, as they always
  // were: a renderer never has to guess the default.
  out.tone = normalizeTone(a.tone);
  out.gender = normalizeGender(a.gender);
  return out;
}

function publicAgent(agent) {
  return projectAgent(agent);
}

module.exports = {
  AGENT_TONES,
  AGENT_GENDERS,
  VISIBILITIES,
  PROACTIVE_KEYS,
  defaultInstructionVisibility,
  normalizeInstructionVisibility,
  normalizeTone,
  normalizeGender,
  normalizeOrganizers,
  projectAgent,
  publicAgent,
};
