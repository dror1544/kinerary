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

// The public view of the agent block: persona survives, organizer-only
// standing instructions are removed entirely. Returns undefined for a missing
// block so callers can leave the key off the payload rather than emit an
// empty object (an empty `agent: {}` would itself signal "this trip has a bot
// with instructions you can't see").
function publicAgent(agent) {
  if (!agent || typeof agent !== 'object') return undefined;
  const safe = JSON.parse(JSON.stringify(agent));
  safe.tone   = normalizeTone(safe.tone);
  safe.gender = normalizeGender(safe.gender);
  if (Array.isArray(safe.standing_instructions)) {
    const visible = safe.standing_instructions
      .filter(i => normalizeInstructionVisibility(i.visibility) !== 'organizer');
    // Same reasoning as the empty-object case above: a zero-length array tells
    // a reader that hidden instructions exist. Drop the key instead.
    if (visible.length) safe.standing_instructions = visible;
    else delete safe.standing_instructions;
  }
  return safe;
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
  publicAgent,
};
