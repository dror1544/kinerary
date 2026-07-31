// Single source of truth for participants[].needs — imported by server.js
// (CommonJS require) and tests/config.test.js (ESM import). Keeping the
// enums and defaulting rules here means server validation, the read-path
// sanitizer, and the test suite can't drift from each other.

const NEED_TYPES = ['allergy', 'medical', 'dietary', 'mobility', 'other'];
const NEED_SEVERITIES = ['critical', 'firm', 'preference'];
const VISIBILITIES = ['group', 'organizer'];

// medical/allergy needs default to organizer-only since /api/config has no
// auth at all and /api/config/versions/:version is authRequired but not
// organizer-scoped (every family member, including kids, is authed there).
function defaultVisibility(type) {
  return (type === 'medical' || type === 'allergy') ? 'organizer' : 'group';
}

// Fail-safe, not fail-quiet: an unrecognized severity (e.g. a typo) must
// not silently read as non-critical, so it defaults to the most severe
// value instead of passing through as-is or being dropped.
function normalizeSeverity(severity) {
  return NEED_SEVERITIES.includes(severity) ? severity : 'critical';
}

// Same fail-safe reasoning as normalizeSeverity: an explicit-but-invalid
// visibility (e.g. a typo) must not fall through as visible. Omitted →
// the type-based default; present-but-unrecognized → the restrictive one.
function normalizeVisibility(visibility, type) {
  if (visibility === undefined) return defaultVisibility(type);
  return VISIBILITIES.includes(visibility) ? visibility : 'organizer';
}

module.exports = { NEED_TYPES, NEED_SEVERITIES, VISIBILITIES, defaultVisibility, normalizeSeverity, normalizeVisibility };
