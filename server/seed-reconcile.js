'use strict';
// Boot-time reconcile of what the trip FILES say with what the trip DATABASE
// holds (issue #382, guarantee A: docs/reliability-guarantees.md).
//
// A re-provision rewrites bookings.json and trip.config.json and restarts the
// server on the same data dir. Until this existed the seed was INSERT OR IGNORE,
// so a corrected value never reached the tabs. The rule, for a seeded booking and
// for a plan item imported from the config alike:
//
//   S = the hash of the values the row was last taken from the file with
//   C = the hash of the values the row holds now
//   F = the hash of the values the file holds now
//
//   C == F            nothing to do (converge S so the next boot is quiet)
//   C == S            nobody edited it: take the file's values
//   C != S, F == S    a person edited it and the file did not change: leave it
//   C != S, F != S    a person edited it AND the file changed: keep the edit,
//                     flag it ("keep mine / use the new one")
//   S unknown         a row written before this existed: it cannot be proven
//                     unedited, so it is treated as edited — flagged, never overwritten
//
// Nothing here deletes a row. A key the file no longer has is retired (hidden,
// kept) when unedited, and flagged when edited.
//
// Pure with respect to the process: callers hand in the database and the values.

const crypto = require('crypto');

const BOOKING_FIELDS = ['phase', 'type', 'name', 'date_from', 'date_to', 'passengers', 'confirmation', 'pin', 'notes', 'cost', 'conf_file', 'location_url'];
const PLAN_FIELDS = ['date', 'time', 'time_sort', 'text_he', 'text_en', 'location_url', 'waze_url', 'ticket_url', 'extra_links'];
// The flag is served to organizers; a PIN or a note is not repeated in it.
const WITHHELD_IN_FLAGS = new Set(['pin', 'notes']);
// A column derived from another (time_sort from time): applied with it, never shown beside it.
const DERIVED_IN_FLAGS = new Set(['time_sort']);

const blank = (v) => (v === undefined || v === null || v === '' ? null : v);

// One shape for a value wherever it came from (a JSON file, a REST column).
function normalizeBooking(src) {
  const out = {};
  for (const f of BOOKING_FIELDS) out[f] = blank(src[f]);
  const cost = Number(src.cost);
  out.cost = Number.isFinite(cost) ? cost : 0;
  return out;
}

function normalizePlan(src) {
  const out = {};
  for (const f of PLAN_FIELDS) out[f] = blank(src[f]);
  // An empty link list is "no links", however it was written.
  if (out.extra_links === '[]') out.extra_links = null;
  if (out.time_sort !== null) out.time_sort = Number(out.time_sort);
  return out;
}

function hashOf(values, fields) {
  return crypto.createHash('sha256').update(JSON.stringify(fields.map((f) => values[f] ?? null))).digest('hex');
}

const diffOf = (current, file, fields) => fields.filter((f) => (current[f] ?? null) !== (file[f] ?? null));

// The one decision, for either kind of row. `row` carries { hash, ack, retired }.
function decide({ C, F, S, ack, retired }) {
  if (C === F) return { action: 'converge' };
  if (retired || (S && C === S)) return { action: 'update' };
  if (S && F === S) return { action: 'keep' };
  if (ack && ack === F) return { action: 'keep' };
  return { action: 'flag' };
}

// What an organizer is shown: field -> the file's value, except the ones withheld.
function flagView(pendingJson) {
  if (!pendingJson) return undefined;
  let pending;
  try { pending = JSON.parse(pendingJson); } catch { return undefined; }
  const out = {};
  for (const [k, v] of Object.entries(pending.changed || {})) {
    if (DERIVED_IN_FLAGS.has(k)) continue;
    out[k] = WITHHELD_IN_FLAGS.has(k) ? '[changed]' : v;
  }
  return out;
}

const SEED_INTERNALS = ['seed_hash', 'seed_pending', 'seed_removed', 'seed_ack', 'retired_at'];
const PLAN_INTERNALS = ['config_hash', 'seed_pending', 'seed_removed', 'seed_ack'];

// A row as a client may see it: internals never, flags for organizers only.
function shapeSeedRow(row, internals, organizer) {
  if (!row) return row;
  const out = { ...row };
  for (const k of internals) delete out[k];
  if (organizer) {
    const changed = flagView(row.seed_pending);
    if (changed) out.seed_changed = changed;
    if (row.seed_removed) out.seed_removed = true;
  }
  return out;
}
const shapeBooking = (row, organizer) => shapeSeedRow(row, SEED_INTERNALS, organizer);
const shapePlanItem = (row, organizer) => shapeSeedRow(row, PLAN_INTERNALS, organizer);

// The seed's long-standing back-fill: a row seeded before bookings.json carried location_url keeps
// NULL, and is given the file's link on a later boot — only where it is still unset, so a hand edit
// is never stomped. With the reconcile off this is how a later link reaches a row; with it on, a row
// that has a seed_hash is brought up to date by the reconcile itself (`hashlessOnly`), and a fill
// here would read as an edit. A hashed, unedited row that is filled keeps its seed_hash true.
function backfillLocation(db, seeds, { hashlessOnly = false } = {}) {
  const select = db.prepare('SELECT * FROM bookings WHERE seed_key = ? AND location_url IS NULL');
  const fill = db.prepare('UPDATE bookings SET location_url = ?, seed_hash = ? WHERE id = ?');
  db.transaction(() => {
    for (const b of seeds) {
      if (!b || !b.seed_key || !b.location_url) continue;
      const row = select.get(b.seed_key);
      if (!row || (hashlessOnly && row.seed_hash)) continue;
      const unedited = row.seed_hash && hashOf(normalizeBooking(row), BOOKING_FIELDS) === row.seed_hash;
      const after = { ...row, location_url: b.location_url };
      fill.run(b.location_url, unedited ? hashOf(normalizeBooking(after), BOOKING_FIELDS) : row.seed_hash, row.id);
    }
  })();
}

const emptyReport = () => ({ insert: [], update: [], flag: [], flag_removed: [], retire: [], converge: 0, unchanged: 0, refused: [], errors: [] });

// ── bookings ──────────────────────────────────────────────────────────────────
// `seeds` is bookings.json as parsed. mode: 'apply' writes everything; 'insert-only' writes
// only the rows the file has and the table lacks (what the seed always did); 'report' only
// computes.
function reconcileBookings(db, seeds, { mode = 'apply', log = () => {} } = {}) {
  const apply = mode === 'apply';
  const inserting = mode !== 'report';
  const report = emptyReport();
  const byKey = new Map();
  const keyless = [];
  for (const b of seeds) {
    if (!b || typeof b !== 'object') continue;
    if (!b.seed_key) { keyless.push(b); continue; }
    if (!byKey.has(b.seed_key)) byKey.set(b.seed_key, b); // first wins, as INSERT OR IGNORE did
  }
  const cols = BOOKING_FIELDS.join(',');
  const insert = db.prepare(`INSERT OR IGNORE INTO bookings (${cols},seed_key,seed_hash,created_by) VALUES (${BOOKING_FIELDS.map(() => '?').join(',')},?,?,?)`);
  const select = db.prepare('SELECT * FROM bookings WHERE seed_key = ?');
  const setValues = db.prepare(`UPDATE bookings SET ${BOOKING_FIELDS.map((f) => `${f} = ?`).join(', ')}, seed_hash = ?, seed_pending = NULL, seed_removed = 0, seed_ack = NULL, retired_at = NULL, review_status = CASE WHEN review_status = 'retired' THEN 'approved' ELSE review_status END WHERE id = ?`);
  const converge = db.prepare("UPDATE bookings SET seed_hash = ?, seed_pending = NULL, seed_removed = 0, seed_ack = NULL, retired_at = NULL, review_status = CASE WHEN review_status = 'retired' THEN 'approved' ELSE review_status END WHERE id = ?");
  const setPending = db.prepare('UPDATE bookings SET seed_pending = ?, seed_removed = 0 WHERE id = ?');
  const clearPending = db.prepare('UPDATE bookings SET seed_pending = NULL, seed_removed = 0 WHERE id = ?');

  const work = () => {
    for (const [key, raw] of byKey) {
      const F = normalizeBooking(raw);
      const Fh = hashOf(F, BOOKING_FIELDS);
      const row = select.get(key);
      if (!row) {
        report.insert.push(key);
        if (inserting) insert.run(...BOOKING_FIELDS.map((f) => F[f]), key, Fh, 'seed');
        continue;
      }
      try {
        const C = normalizeBooking(row);
        const Ch = hashOf(C, BOOKING_FIELDS);
        const retired = Boolean(row.retired_at);
        const d = decide({ C: Ch, F: Fh, S: row.seed_hash, ack: row.seed_ack, retired });
        if (d.action === 'converge') {
          const dirty = row.seed_hash !== Fh || row.seed_pending || row.seed_removed || row.seed_ack || retired;
          if (dirty) { report.converge++; if (apply) converge.run(Fh, row.id); } else report.unchanged++;
        } else if (d.action === 'update') {
          report.update.push({ seed_key: key, fields: diffOf(C, F, BOOKING_FIELDS) });
          if (apply) setValues.run(...BOOKING_FIELDS.map((f) => F[f]), Fh, row.id);
        } else if (d.action === 'keep') {
          // The edit stands and there is nothing new to ask. A flag from an older file that
          // the file has since reverted is cleared.
          if (apply && (row.seed_pending || row.seed_removed)) clearPending.run(row.id);
          report.unchanged++;
        } else {
          const fields = diffOf(C, F, BOOKING_FIELDS);
          report.flag.push({ seed_key: key, fields });
          if (apply) {
            const pending = JSON.stringify({ hash: Fh, changed: Object.fromEntries(fields.map((f) => [f, F[f]])) });
            if (row.seed_pending !== pending || row.seed_removed) setPending.run(pending, row.id);
          }
        }
      } catch (e) {
        report.errors.push({ seed_key: key, error: e.message });
        log(`seed reconcile: ${key} skipped: ${e.message}`);
      }
    }

    // Rows the file no longer has. A file that lists nothing while rows were seeded is
    // a truncated write far more often than "the trip has no bookings": refuse, loudly.
    const gone = db.prepare("SELECT * FROM bookings WHERE seed_key IS NOT NULL AND retired_at IS NULL").all()
      .filter((r) => !byKey.has(r.seed_key));
    if (!gone.length) return;
    if (!byKey.size) {
      report.refused.push({ reason: 'bookings.json lists no bookings', rows: gone.length });
      log(`seed reconcile: bookings.json lists no bookings but ${gone.length} seeded row(s) exist — nothing retired`);
      return;
    }
    const retire = db.prepare("UPDATE bookings SET retired_at = datetime('now'), review_status = 'retired', seed_pending = NULL, seed_removed = 0 WHERE id = ?");
    const flagRemoved = db.prepare('UPDATE bookings SET seed_removed = 1, seed_pending = NULL WHERE id = ?');
    for (const row of gone) {
      const edited = !row.seed_hash || hashOf(normalizeBooking(row), BOOKING_FIELDS) !== row.seed_hash;
      if (!edited) { report.retire.push(row.seed_key); if (apply) retire.run(row.id); }
      else if (row.seed_ack === 'removed') report.unchanged++;
      else { report.flag_removed.push(row.seed_key); if (apply && !row.seed_removed) flagRemoved.run(row.id); }
    }
  };
  if (inserting) db.transaction(work)(); else work();
  report.keyless = keyless.length;
  return { report, keyless };
}

// ── plan items imported from the config ──────────────────────────────────────
// `items` is [{ ref, values }] — what the file says for every config_ref. The caller
// projects them the way the import does (server.js configItemProjections), so a value
// compared here is a value the import would have written.
function planDigest(items) {
  const h = crypto.createHash('sha256');
  for (const it of items) h.update(`${it.ref}\u0000${hashOf(normalizePlan(it.values), PLAN_FIELDS)}\n`);
  return h.digest('hex');
}

function reconcilePlanItems(db, items, { mode = 'apply' } = {}) {
  const apply = mode === 'apply';
  const report = { update: [], flag: [], flag_removed: [], converge: 0, unchanged: 0, not_in_plan: 0 };
  const byRef = new Map(items.map((it) => [it.ref, it]));
  const select = db.prepare('SELECT * FROM phase_plan_items WHERE config_ref = ?');
  const setValues = db.prepare(`UPDATE phase_plan_items SET ${PLAN_FIELDS.map((f) => `${f} = ?`).join(', ')}, config_hash = ?, seed_pending = NULL, seed_removed = 0, seed_ack = NULL WHERE id = ?`);
  const converge = db.prepare('UPDATE phase_plan_items SET config_hash = ?, seed_pending = NULL, seed_removed = 0, seed_ack = NULL WHERE id = ?');
  const setPending = db.prepare('UPDATE phase_plan_items SET seed_pending = ?, seed_removed = 0 WHERE id = ?');
  const clearPending = db.prepare('UPDATE phase_plan_items SET seed_pending = NULL, seed_removed = 0 WHERE id = ?');
  const flagRemoved = db.prepare('UPDATE phase_plan_items SET seed_removed = 1, seed_pending = NULL WHERE id = ?');
  let changed = false;

  const work = () => {
    for (const [ref, it] of byRef) {
      const row = select.get(ref);
      if (!row) { report.not_in_plan++; continue; }
      const F = normalizePlan(it.values);
      const Fh = hashOf(F, PLAN_FIELDS);
      const C = normalizePlan(row);
      const Ch = hashOf(C, PLAN_FIELDS);
      const d = decide({ C: Ch, F: Fh, S: row.config_hash, ack: row.seed_ack, retired: false });
      if (d.action === 'converge') {
        if (row.config_hash !== Fh || row.seed_pending || row.seed_removed || row.seed_ack) { report.converge++; if (apply) converge.run(Fh, row.id); }
        else report.unchanged++;
      } else if (d.action === 'update') {
        report.update.push({ config_ref: ref, fields: diffOf(C, F, PLAN_FIELDS) });
        if (apply) { setValues.run(...PLAN_FIELDS.map((f) => F[f]), Fh, row.id); changed = true; }
      } else if (d.action === 'keep') {
        if (apply && (row.seed_pending || row.seed_removed)) clearPending.run(row.id);
        report.unchanged++;
      } else {
        const fields = diffOf(C, F, PLAN_FIELDS);
        report.flag.push({ config_ref: ref, fields });
        if (apply) {
          const pending = JSON.stringify({ hash: Fh, changed: Object.fromEntries(fields.map((f) => [f, F[f]])) });
          if (row.seed_pending !== pending || row.seed_removed) setPending.run(pending, row.id);
        }
      }
    }
    // A config item the file no longer has at that position: flagged for the organizer, never
    // removed — the plan has no "retired" and deleting a person's plan on a boot is not ours to do.
    for (const row of db.prepare("SELECT id, config_ref, seed_removed, seed_ack FROM phase_plan_items WHERE config_ref IS NOT NULL AND config_ref <> ''").all()) {
      if (byRef.has(row.config_ref)) continue;
      if (row.seed_ack === 'removed') { report.unchanged++; continue; }
      report.flag_removed.push(row.config_ref);
      if (apply && !row.seed_removed) flagRemoved.run(row.id);
    }
  };
  if (apply) db.transaction(work)(); else work();
  return { report, changed };
}

module.exports = {
  BOOKING_FIELDS, PLAN_FIELDS,
  normalizeBooking, normalizePlan, hashOf, diffOf, decide, flagView,
  shapeBooking, shapePlanItem,
  reconcileBookings, reconcilePlanItems, planDigest, backfillLocation,
};
