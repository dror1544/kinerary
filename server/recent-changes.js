// "What changed on the plan in the last 24 hours" — video Release 1B
// (docs/specs/sprint-9/x-video-r1-site-look.md).
//
// Derived, never stored: every plan write already makes an immutable version in
// itinerary_plan_versions with the same item_uid carried across, so a change is a
// difference between a version and the one before it. No table, no column, no migration.
//
//   window      the versions in the active plan's parent chain created inside the window.
//   walk        oldest to newest. For each version written by a PERSON, each item is compared
//               with its match in the version before it (matched as markProvenance matches:
//               source_ref, then item_uid). No match = the person added it; a tracked field
//               differs = the person changed it, and the value before the change is remembered.
//   system      a version written by an automatic writer is skipped as a change source: what
//               enrichment, the first-boot import or a config reconcile did is the plan being
//               built, not an edit, so it neither marks an item nor hides a person's change on
//               it (Dror, 2026-11-16). Its effect simply sits in the "before" of later changes.
//   net effect  a field a person changed and changed back carries no marker.
//   when        the created_at of the newest person version that changed the item.
//
// WHAT IT NEVER PUTS ON THE WIRE. `author` is read for exactly one purpose — to tell a system
// version from a person's, through isSystemAuthor() below — and never copied into the result.
// `note` and `created_by` are not read at all. The result is a closed shape (kind, at, fields,
// previous_time, previous_date): a member learns WHAT changed and WHEN, never WHO (spec:
// Security and boundary notes). A test greps this file to hold that line.
//
// Bookings are not inputs (a booking under review is not member-visible), and neither are
// the organizer-only seed flags and plan conflicts.

'use strict';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_VERSIONS = 200;
const RECENT_CHANGE_KEYS = Object.freeze(['kind', 'at', 'fields', 'previous_time', 'previous_date']);

// The automatic writers of plan versions — the closed set, enumerated from every createVersion /
// cloneWith / syncFromLegacy / applyChange call in server/. Anything not listed is a person (an
// organizer's username, the agent key's "hermes", or a Classic-site edit written as legacy-plan-*),
// so a writer this list does not know marks its changes: noise, never a hidden edit.
//   config                      the original plan, and the first active clone, imported from trip.config.json
//   legacy-plan                 the first active plan when it is imported from the compatibility tables
//   legacy-promote-config-days  the first-boot promotion of config days into the plan
//   config-reconcile            the trip file's corrections reaching un-edited seeded items (#382)
//   enrichment                  the background worker filling in the other language, location and links
const SYSTEM_AUTHORS = Object.freeze(new Set(['config', 'legacy-plan', 'legacy-promote-config-days', 'config-reconcile', 'enrichment']));
function isSystemAuthor(author) {
  return typeof author === 'string' && SYSTEM_AUTHORS.has(author);
}

// The closed set of fields a marker may name, in the order they are reported, and
// the columns each one stands for. Anything else on an item (website, tickets,
// booking, confirmation state, duration, order, extra links) is not a change here.
const FIELD_COLUMNS = Object.freeze([
  ['time', ['time']],
  ['date', ['date']],
  ['title', ['text_he', 'text_en']],
  ['place', ['location_url', 'waze_url']],
  ['type', ['item_type']],
]);
const ITEM_COLUMNS = ['item_uid', 'source_ref', 'time', 'date', 'text_he', 'text_en', 'location_url', 'waze_url', 'item_type'];

const memo = new WeakMap();

// SQLite stores datetime('now'): "YYYY-MM-DD HH:MM:SS", UTC. NaN for anything unreadable.
function parseCreatedAt(value) {
  if (typeof value !== 'string') return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return Date.parse(`${value.replace(' ', 'T')}Z`);
  return Date.parse(value);
}

function toIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function indexItems(db, revisionId, cache) {
  if (cache.has(revisionId)) return cache.get(revisionId);
  const rows = db.prepare(`SELECT ${ITEM_COLUMNS.join(', ')} FROM itinerary_plan_items WHERE revision_id = ?`).all(revisionId);
  const entry = {
    rows,
    byRef: new Map(rows.map((row) => [row.source_ref || row.item_uid, row])),
    byUid: new Map(rows.map((row) => [row.item_uid, row])),
  };
  cache.set(revisionId, entry);
  return entry;
}

// The same matching markProvenance uses: source_ref first, then item_uid.
function matchIn(entry, item) {
  return entry.byRef.get(item.source_ref || item.item_uid) || entry.byUid.get(item.item_uid) || null;
}

const columnsOf = Object.fromEntries(FIELD_COLUMNS);
const fieldDiffers = (name, a, b) => columnsOf[name].some((column) => (a[column] || null) !== (b[column] || null));
const changedFields = (before, after) => FIELD_COLUMNS.map(([name]) => name).filter((name) => fieldDiffers(name, before, after));

function walkChain(db, activeId) {
  const select = db.prepare('SELECT revision_id, parent_revision_id, created_at, author FROM itinerary_plan_versions WHERE revision_id = ?');
  const chain = [];
  const seen = new Set();
  let id = activeId;
  while (id && chain.length < MAX_VERSIONS && !seen.has(id)) {
    seen.add(id);
    const row = select.get(id);
    if (!row) break;
    chain.push({ id: row.revision_id, parent: row.parent_revision_id, ms: parseCreatedAt(row.created_at), system: isSystemAuthor(row.author) });
    id = row.parent_revision_id;
  }
  return chain; // newest first
}

function compute(db, activeId, now, windowMs) {
  const result = new Map();
  const chain = walkChain(db, activeId);
  const windowStart = now - windowMs;
  // Versions inside the window, newest first. An unreadable timestamp counts as old: the
  // doubtful reading is the one that marks nothing.
  let inWindow = chain.findIndex((version) => !(version.ms >= windowStart));
  if (inWindow === -1) inWindow = chain.length;
  if (inWindow === 0) return result;

  const cache = new Map();
  const tracked = new Map(); // item_uid -> { kind, at, before: { field: row before its first change by a person } }
  for (let i = inWindow - 1; i >= 0; i--) { // oldest first
    const version = chain[i];
    const parent = chain[i + 1];
    if (version.system || !parent) continue; // an automatic write, or a version with nothing before it to compare with
    const parentIndex = indexItems(db, parent.id, cache);
    for (const item of indexItems(db, version.id, cache).rows) {
      const before = matchIn(parentIndex, item);
      let entry = tracked.get(item.item_uid);
      if (!before) {
        if (!entry) { entry = { kind: 'added', at: version.ms, before: {} }; tracked.set(item.item_uid, entry); }
        else entry.at = version.ms;
        continue;
      }
      const fields = changedFields(before, item);
      if (!fields.length) continue;
      if (!entry) { entry = { kind: 'updated', at: version.ms, before: {} }; tracked.set(item.item_uid, entry); }
      entry.at = version.ms;
      for (const name of fields) if (!entry.before[name]) entry.before[name] = before;
    }
  }

  for (const item of indexItems(db, chain[0].id, cache).rows) {
    const entry = tracked.get(item.item_uid);
    if (!entry) continue;
    if (entry.kind === 'added') {
      result.set(item.item_uid, { kind: 'added', at: toIso(entry.at), fields: [] });
      continue;
    }
    // Net effect: a field a person changed and changed back is not a change.
    const fields = FIELD_COLUMNS.map(([name]) => name).filter((name) => entry.before[name] && fieldDiffers(name, entry.before[name], item));
    if (!fields.length) continue;
    result.set(item.item_uid, {
      kind: 'updated',
      at: toIso(entry.at),
      fields,
      ...(fields.includes('time') ? { previous_time: entry.before.time.time || null } : {}),
      ...(fields.includes('date') ? { previous_date: entry.before.date.date || null } : {}),
    });
  }
  return result;
}

/**
 * Map(item_uid -> recent_change) for the active plan. `now` is milliseconds (injectable
 * for tests); `windowMs` defaults to a plain 24 hours (Dror, 2026-11-16: markers are not
 * cleared at the start of a trip day). Memoised per (active revision, minute, window).
 */
function recentChanges(db, { now = Date.now(), windowMs = WINDOW_MS } = {}) {
  const state = db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
  if (!state?.active_version_id) return new Map();
  const key = `${state.active_version_id}|${Math.floor(now / 60_000)}|${windowMs}`;
  const hit = memo.get(db);
  if (hit && hit.key === key) return hit.value;
  const value = compute(db, state.active_version_id, now, windowMs);
  memo.set(db, { key, value });
  return value;
}

/** An item with its marker attached, or the item itself when it has none. */
function withRecentChange(item, marks) {
  const marker = item && marks ? marks.get(item.item_uid) : null;
  return marker ? { ...item, recent_change: marker } : item;
}

module.exports = { recentChanges, withRecentChange, isSystemAuthor, SYSTEM_AUTHORS, RECENT_CHANGE_KEYS, WINDOW_MS, MAX_VERSIONS };
