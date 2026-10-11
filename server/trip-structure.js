// Stop editing after the interview — the override layer.
//
// WHY A LAYER AND NOT A CONFIG WRITE. The provisioner rewrites trip.config.json
// on every provision, so any runtime edit of that file is lost on the next
// rebuild; the site's SQLite (on the trip's NFS directory) survives it. So the
// trip's STRUCTURE — which stops exist, their dates, where the family sleeps —
// is edited here, in two tables, and merged over the config by
// effectiveConfig(). Precedent: the trip timezone (trip_settings) — the DB
// value wins, unset falls through to the config.
//
// THE BOUNDARY. effectiveConfig() returns a RAW-shaped config. Every member
// path still goes through sanitizeConfig() (the allow-list in
// shared/config-visibility.js) on the result, exactly as it did on the file:
// the layer only ever writes fields that list already names (dates,
// accommodation, title, tabLabel, emoji), never a PIN (refused at the write,
// never copied from a booking), and none of its own bookkeeping — who set a
// stop, from which booking, over which base — is put into the config at all.
// That provenance is served by GET /api/stops, organizer/agent only.
//
// OPEN DAYS ARE COMPUTED. The provisioner writes a synthetic phase per stretch
// of trip days no stop covers (`unplanned: true`, transformer.py
// _open_day_phases) with the day count written into its note. Read once at
// boot, that note went stale the moment anything changed (run notes F8: a plan
// for Colmar left "6 days unplanned" on the site). When the config carries
// that convention, the phases are recomputed here from the stops' dates AND the
// days the active plan has on real stops, with the count written from the
// computation. A config without it (hand-authored, or provisioned with every
// day covered) is served as authored: the layer never invents the convention.
//
// EMPTY LAYER = THE CONFIG. With no override row and no unplanned phase the
// base object itself is returned; with unplanned phases and nothing changed,
// the recomputation reproduces the provisioner's output byte for byte
// (tests/trip-stops-http.test.js pins both against the real provisioner).
const crypto = require('crypto');
const { publicPart } = require('../shared/config-visibility');
const { moveDayRows } = require('./living-journey');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STOP_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
// A stop id is used as a key wherever a phase is looked up by id — a plain
// object keyed by `constructor` answers with Object's own constructor
// (boundary review 2026-10-11, finding 5). Refused whatever the case, since
// STOP_ID_RE only lets lowercase through anyway.
const RESERVED_STOP_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map(s => s.toLowerCase()));
const isReservedStopId = (id) => RESERVED_STOP_IDS.has(String(id).toLowerCase());
const MAX_TEXT = 300;
// The accommodation an override may carry: the allow-list's ACCOMMODATION
// fields an organizer can sensibly type, minus `pin` (refused outright) and the
// legacy/derived ones (notes list, weatherKey, pdf, hotel, title, mapsUrl).
// Null prototype, and read with Object.hasOwn: a key named `constructor` or
// `toString` is not a field (finding 2).
const ACCOMMODATION_KEYS = Object.assign(Object.create(null), {
  name: 'text', name_en: 'scalar', type: 'scalar', address: 'scalar', phone: 'scalar',
  confirmation: 'scalar', location_url: 'url', maps: 'url', waze: 'url', url: 'url',
  guests: 'scalar', rooms: 'scalar', cost: 'scalar', dates: 'text', description: 'text', note: 'text',
});
// Free text that may run over several lines; every other text field is one line.
const MULTILINE_KEYS = new Set(['description', 'note']);

// STORED TEXT IS NEVER MARKUP (boundary review 2026-10-11, finding 1). Every
// value a stop write accepts reaches /api/config, and a renderer that builds
// HTML from it — the Classic site did, unescaped — turns `<img onerror=…>` into
// script in every member's browser. The agent key is enough to write a stop,
// and the companion holding it reads text travellers typed, so this is one
// prompt injection away. Refused at the write, not cleaned: a silently altered
// value is the failure this repository keeps paying for. `<`, `>` and `"` are
// what it takes to open a tag or leave an attribute; control characters have
// no business in a title. A newline is allowed only in the multi-line fields.
// `&` and `'` stay: names carry them, and every renderer escapes them anyway.
const UNSAFE_LINE_RE = /[<>"\u0000-\u001F\u007F-\u009F]/;
const UNSAFE_MULTILINE_RE = /[<>"\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const TEXT_DETAIL = 'text may not contain < > " or control characters (for a Hebrew abbreviation use ״, U+05F4)';
const LINK_DETAIL = 'a link must be an absolute http(s) URL with a host, and no quotes, < >, or whitespace';
const STOP_FIELDS = ['dates', 'accommodation', 'title', 'tabLabel', 'emoji'];
const OPEN_TITLE = { he: 'ימים שעוד לא תוכננו', en: 'Days not planned yet' };
// The same sentence the provisioner writes, so an unchanged trip serves
// byte-identical text — but the number now comes from the computation.
function openNote(n) {
  return {
    he: `${n} ימים בטיול שעוד לא שויכו לתחנה. אפשר לדבר עם העוזר כדי לשבץ אותם לתחנה קיימת או לפתוח תחנה חדשה.`,
    en: `${n} day(s) of this trip do not belong to a stop yet. Talk to your assistant to add them to one, or open a new stop.`,
  };
}

const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 32);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const readJson = (v, fallback) => { if (v == null) return fallback; try { return JSON.parse(v); } catch { return fallback; } };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function isoDay(value) {
  const s = typeof value === 'string' ? value.slice(0, 10) : '';
  return ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// A phase's dates, as the provisioner writes them (dates.start/end) or as a
// hand-authored config may (start/end). Both ends or nothing.
function phaseDates(phase) {
  const start = isoDay(phase?.dates?.start || phase?.start);
  const end = isoDay(phase?.dates?.end || phase?.end);
  return start && end && start <= end ? { start, end } : null;
}
const isUnplanned = (phase) => phase?.unplanned === true;

function tripRange(cfg) {
  const start = isoDay(cfg?.meta?.departure);
  const end = isoDay(cfg?.meta?.returnDate);
  return { start, end };
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_stop_overrides (
      phase_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('config','added')),
      fields TEXT NOT NULL DEFAULT '{}',
      after_phase_id TEXT,
      base_digest TEXT,
      booking_id INTEGER,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trip_stop_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_state TEXT,
      after_state TEXT,
      actor TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trip_stop_history_phase ON trip_stop_history(phase_id, id);
    CREATE TRIGGER IF NOT EXISTS trip_stop_history_no_update BEFORE UPDATE ON trip_stop_history
      BEGIN SELECT RAISE(ABORT, 'trip stop history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trip_stop_history_no_delete BEFORE DELETE ON trip_stop_history
      BEGIN SELECT RAISE(ABORT, 'trip stop history is append-only'); END;
  `);
}

// ── validation ───────────────────────────────────────────────────────────────
function textValue(v) {
  if (typeof v === 'string') return v.trim() && v.length <= MAX_TEXT ? v.trim() : undefined;
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length || keys.some(k => !['he', 'en'].includes(k))) return undefined;
    const out = {};
    for (const k of keys) {
      if (typeof v[k] !== 'string' || v[k].length > MAX_TEXT) return undefined;
      out[k] = v[k].trim();
    }
    return Object.values(out).some(Boolean) ? out : undefined;
  }
  return undefined;
}
function scalarValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length <= MAX_TEXT) return v.trim();
  return undefined;
}
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

// The path of the first string in `value` (a string, or a { he, en } pair)
// that carries text a browser could read as markup — or null.
function unsafeTextAt(value, path, { multiline = false } = {}) {
  const re = multiline ? UNSAFE_MULTILINE_RE : UNSAFE_LINE_RE;
  if (typeof value === 'string') return re.test(value) ? path : null;
  if (isObj(value)) {
    for (const k of Object.keys(value)) if (typeof value[k] === 'string' && re.test(value[k])) return `${path}.${k}`;
  }
  return null;
}
const invalidText = (field) => fail(400, 'invalid_text', { field, detail: TEXT_DETAIL });

// A link a renderer can put in an href as it stands: parsed by the WHATWG URL
// parser (not a prefix check, which passed `https://x/"onmouseover=…`),
// http(s) with a host, and none of the characters that end an attribute or a
// URL in markup. Returned as typed (trimmed), never rewritten.
function safeLink(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > 2000 || /[\s"'<>`\u0000-\u001F\u007F-\u009F]/.test(s)) return undefined;
  let url;
  try { url = new URL(s); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined;
  return s;
}

function validateAccommodation(value, path = 'accommodation') {
  if (value === null) return { value: null };
  if (!isObj(value)) return { error: fail(400, 'invalid_accommodation', { detail: 'accommodation must be an object or null' }) };
  // A door code is not trip UI data. Refused by name, before anything else, so
  // it is never stored even in the organizer-only history.
  if (Object.hasOwn(value, 'pin')) return { error: fail(400, 'pin_not_accepted') };
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(ACCOMMODATION_KEYS, key)) return { error: fail(400, 'unknown_accommodation_field', { field: key }) };
    const kind = ACCOMMODATION_KEYS[key];
    if (raw === null || raw === '') continue;
    const field = `${path}.${key}`;
    let v;
    if (kind === 'url') {
      v = safeLink(raw);
      if (v === undefined) return { error: fail(400, 'invalid_link', { field, detail: LINK_DETAIL }) };
    } else {
      const bad = unsafeTextAt(raw, field, { multiline: MULTILINE_KEYS.has(key) });
      if (bad) return { error: invalidText(bad) };
      v = kind === 'text' ? textValue(raw) : scalarValue(raw);
    }
    if (v === undefined) return { error: fail(400, 'invalid_accommodation', { field: key }) };
    out[key] = v;
  }
  return { value: out };
}

function validateDates(value) {
  if (value === null) return { value: null };
  if (!isObj(value)) return { error: fail(400, 'invalid_dates') };
  const start = typeof value.start === 'string' && ISO_DATE_RE.test(value.start) ? isoDay(value.start) : null;
  const end = typeof value.end === 'string' && ISO_DATE_RE.test(value.end) ? isoDay(value.end) : null;
  if (!start || !end || start > end || Object.keys(value).some(k => !['start', 'end'].includes(k))) {
    return { error: fail(400, 'invalid_dates', { detail: 'dates must be { start, end } as YYYY-MM-DD, start <= end' }) };
  }
  return { value: { start, end } };
}

// The editable fields of a stop, from a request body. Strict: a key the layer
// does not know is refused, not ignored — a silently dropped field is the
// failure this repository keeps paying for.
// `prefix` names where the fields sit in the request (`new_stop.` for a split),
// so a refusal says which field it was.
function validateStopFields(body, { allowed = STOP_FIELDS, extra = [], prefix = '' } = {}) {
  if (!isObj(body)) return { error: fail(400, 'invalid_body') };
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key) && !extra.includes(key)) return { error: fail(400, 'unknown_field', { field: key }) };
  }
  const fields = {};
  if (body.dates !== undefined) {
    const r = validateDates(body.dates);
    if (r.error) return r;
    fields.dates = r.value;
  }
  if (body.accommodation !== undefined) {
    const r = validateAccommodation(body.accommodation, `${prefix}accommodation`);
    if (r.error) return r;
    fields.accommodation = r.value;
  }
  if (body.title !== undefined) {
    const bad = unsafeTextAt(body.title, `${prefix}title`);
    if (bad) return { error: invalidText(bad) };
    const t = textValue(body.title);
    if (t === undefined || (typeof t === 'string' && t.length > 120)) return { error: fail(400, 'invalid_title') };
    fields.title = t;
  }
  for (const [key, max] of [['tabLabel', 40], ['emoji', 16]]) {
    if (body[key] === undefined) continue;
    const bad = unsafeTextAt(body[key], `${prefix}${key}`);
    if (bad) return { error: invalidText(bad) };
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > max) return { error: fail(400, `invalid_${key}`) };
    fields[key] = body[key].trim();
  }
  return { fields };
}

function parseOnOutside(value) {
  if (value === undefined || value === null) return { mode: null };
  if (value === 'keep') return { mode: 'keep' };
  const m = typeof value === 'string' ? /^move_to:(.+)$/.exec(value) : null;
  if (m) return { mode: 'move', target: m[1] };
  return { error: true };
}

function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function stripQuotes(tag) {
  return typeof tag === 'string' ? tag.replace(/^W\//, '').replace(/^"|"$/g, '') : tag;
}

// ── the merge ────────────────────────────────────────────────────────────────
// Applied to a COPY of the base phase. Key order is kept, so a stop whose
// override only says what the base already says serves the same JSON.
function applyFields(phase, fields) {
  const out = { ...phase };
  if (Object.hasOwn(fields, 'dates')) {
    if (fields.dates === null) {
      delete out.dates;
      if (typeof out.start === 'string' && out.start) out.start = null;
      if (typeof out.end === 'string' && out.end) out.end = null;
    } else {
      // `dates.display` is text written for the old range; it does not survive.
      out.dates = { start: fields.dates.start, end: fields.dates.end };
      if (typeof out.start === 'string' && out.start) out.start = fields.dates.start;
      if (typeof out.end === 'string' && out.end) out.end = fields.dates.end;
    }
  }
  if (Object.hasOwn(fields, 'accommodation')) {
    // Replaced whole, never merged: a base hotel's address, phone or PIN must
    // not ride along under another hotel's name.
    if (fields.accommodation === null) delete out.accommodation;
    else out.accommodation = clone(fields.accommodation);
  }
  for (const key of ['title', 'tabLabel', 'emoji']) {
    if (Object.hasOwn(fields, key)) out[key] = clone(fields[key]);
  }
  return out;
}

function addedPhase(id, fields) {
  const p = { id };
  for (const key of ['title', 'tabLabel', 'emoji', 'dates', 'accommodation']) {
    if (fields[key] !== undefined && fields[key] !== null) p[key] = clone(fields[key]);
  }
  return p;
}

// What a stop's field was in the base, for conflict detection.
function baseValue(phase, key) {
  if (!phase) return null;
  if (key === 'dates') return phaseDates(phase);
  return phase[key] ?? null;
}

function createTripStructure({ db, baseConfig, journey, queuePhaseReview = () => {}, reviewConfigured = () => false }) {
  schema(db);

  const q = {
    overrides: db.prepare('SELECT rowid AS seq, * FROM trip_stop_overrides ORDER BY rowid ASC'),
    override: db.prepare('SELECT * FROM trip_stop_overrides WHERE phase_id = ?'),
    upsert: db.prepare(
      `INSERT INTO trip_stop_overrides (phase_id, kind, fields, after_phase_id, base_digest, booking_id, updated_by, updated_at)
       VALUES (@phase_id, @kind, @fields, @after_phase_id, @base_digest, @booking_id, @updated_by, datetime('now'))
       ON CONFLICT(phase_id) DO UPDATE SET kind = excluded.kind, fields = excluded.fields, after_phase_id = excluded.after_phase_id,
         base_digest = excluded.base_digest, booking_id = excluded.booking_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ),
    remove: db.prepare('DELETE FROM trip_stop_overrides WHERE phase_id = ?'),
    history: db.prepare('INSERT INTO trip_stop_history (phase_id, action, before_state, after_state, actor, note) VALUES (?, ?, ?, ?, ?, ?)'),
    maxHistory: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM trip_stop_history'),
    historyFor: db.prepare('SELECT id, phase_id, action, before_state, after_state, actor, note, created_at FROM trip_stop_history WHERE phase_id = ? ORDER BY id ASC'),
    historyRow: db.prepare('SELECT * FROM trip_stop_history WHERE id = ?'),
    reparent: db.prepare('UPDATE trip_stop_overrides SET after_phase_id = ? WHERE after_phase_id = ?'),
    linkedElsewhere: db.prepare('SELECT phase_id FROM trip_stop_overrides WHERE booking_id = ? AND phase_id <> ? ORDER BY rowid LIMIT 1'),
  };
  const base = () => baseConfig() || {};
  const rowsOf = () => journey()?.activeRows?.() || { days: [], items: [] };

  function parseRow(row) {
    if (!row) return null;
    return {
      phase_id: row.phase_id,
      kind: row.kind,
      fields: readJson(row.fields, {}),
      after_phase_id: row.after_phase_id || null,
      base_digest: readJson(row.base_digest, {}),
      booking_id: row.booking_id ?? null,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
      seq: row.seq,
    };
  }
  // What history records: the override as it stood, without timestamps.
  const snapshot = (o) => (o ? { kind: o.kind, fields: o.fields, after_phase_id: o.after_phase_id, booking_id: o.booking_id } : null);

  function revision() {
    return `st-${q.maxHistory.get().id}`;
  }

  // ── effective config ──────────────────────────────────────────────────────
  let cache = null;
  function compute() {
    const cfg = base();
    const basePhases = Array.isArray(cfg.phases) ? cfg.phases : [];
    const overrides = q.overrides.all().map(parseRow);
    const recompute = basePhases.some(isUnplanned);
    if (!overrides.length && !recompute) return { config: cfg, realIds: new Set(basePhases.map(p => p?.id)) };

    const range = tripRange(cfg);
    // With no stated trip range there is nothing to measure a gap against:
    // the provisioner's open-days phases then stay exactly as it wrote them.
    const measurable = recompute && range.start && range.end && range.start <= range.end;
    const byId = new Map(overrides.map(o => [o.phase_id, o]));
    const baseIds = new Set(basePhases.map(p => p?.id));
    let list = [];
    for (const phase of basePhases) {
      if (measurable && isUnplanned(phase)) continue;
      const o = byId.get(phase?.id);
      list.push(o && !isUnplanned(phase) ? applyFields(phase, o.fields) : phase);
    }
    // Added stops, in creation order, each right after the stop it came from.
    for (const o of overrides) {
      if (o.kind !== 'added' || baseIds.has(o.phase_id)) continue;
      const at = list.findIndex(p => p?.id === o.after_phase_id);
      const phase = addedPhase(o.phase_id, o.fields);
      if (at >= 0) list.splice(at + 1, 0, phase); else list.push(phase);
    }
    const realIds = new Set(list.filter(p => !isUnplanned(p)).map(p => p?.id));
    if (measurable) list = withOpenDays(list, basePhases, realIds, range);
    return { config: { ...cfg, phases: list }, realIds };
  }

  function withOpenDays(list, basePhases, realIds, range) {
    const covered = new Set();
    for (const phase of list) {
      const d = phaseDates(phase);
      if (!d) continue;
      for (let day = d.start; day <= d.end; day = addDays(day, 1)) covered.add(day);
    }
    // A day the active plan has on a REAL stop belongs to the trip's structure
    // even when that stop has no dates yet. A day planned under an open-days
    // phase is still a day no stop has claimed. "Planned" means an item or a
    // headline: an empty day row (what a moved item leaves behind) is not a plan.
    const rows = rowsOf();
    const planned = [
      ...(rows.items || []),
      ...(rows.days || []).filter(d => d?.label_he || d?.label_en),
    ];
    for (const entry of planned) {
      const day = isoDay(entry?.date);
      if (day && realIds.has(entry.phase_id)) covered.add(day);
    }
    const gaps = [];
    for (let day = range.start; day <= range.end; day = addDays(day, 1)) {
      if (covered.has(day)) continue;
      const last = gaps.at(-1);
      if (last && last.end === addDays(day, -1)) last.end = day, last.days++;
      else gaps.push({ start: day, end: day, days: 1 });
    }
    const baseOpen = new Map(basePhases.filter(isUnplanned).map(p => [p.id, p]));
    const out = [...list];
    gaps.forEach((gap, i) => {
      const id = gaps.length === 1 ? 'open-days' : `open-days-${i + 1}`;
      const prior = baseOpen.get(id);
      const phase = prior
        ? { ...prior, dates: { start: gap.start, end: gap.end }, note: openNote(gap.days) }
        : { id, unplanned: true, title: clone(OPEN_TITLE), tabLabel: '?', dates: { start: gap.start, end: gap.end }, note: openNote(gap.days) };
      // Before the first stop that starts later — where the provisioner's own
      // sort by start date put it.
      const at = out.findIndex(p => { const d = phaseDates(p); return d && d.start > gap.start; });
      if (at >= 0) out.splice(at, 0, phase); else out.push(phase);
    });
    return out;
  }

  function current() {
    const cfg = base();
    const key = `${q.maxHistory.get().id}|${journey()?.activeRevision?.() ?? ''}`;
    if (cache && cache.key === key && cache.base === cfg && cache.phases === cfg.phases) return cache.value;
    const value = compute();
    cache = { key, base: cfg, phases: cfg.phases, value };
    return value;
  }

  // The config as the trip is now: the file, with the stop layer merged over
  // it. Raw-shaped — anything served to a member still goes through
  // sanitizeConfig(). Shared across callers: never mutate the result.
  function effectiveConfig() {
    return current().config;
  }

  function effectivePhase(id) {
    return (effectiveConfig().phases || []).find(p => p?.id === id) || null;
  }
  function basePhase(id) {
    return (base().phases || []).find(p => p?.id === id) || null;
  }
  // A phase id any route may file plan rows under: a stop as it is now, or
  // any phase the config itself names (an open-days id the computation no
  // longer produces stays reachable, so nothing filed under it is orphaned).
  function isPhase(id) {
    if (typeof id !== 'string' || !id) return false;
    return Boolean(effectivePhase(id) || basePhase(id));
  }
  // A real stop: not a computed open-days phase.
  function isStop(id) {
    return typeof id === 'string' && current().realIds.has(id);
  }
  function isComputed(id) {
    return isUnplanned(effectivePhase(id)) || isUnplanned(basePhase(id));
  }

  // ── reading the plan ───────────────────────────────────────────────────────
  function itemsOutside(stopId, dates) {
    if (!dates) return [];
    return (rowsOf().items || [])
      .filter(i => i.phase_id === stopId && i.date && (i.date < dates.start || i.date > dates.end))
      .map(i => ({ item_uid: i.item_uid, date: i.date, time: i.time || null, text_he: i.text_he, text_en: i.text_en || null }));
  }

  function references(stopId) {
    const rows = rowsOf();
    const count = (sql) => { try { return db.prepare(sql).get(stopId)?.n || 0; } catch { return 0; } };
    return {
      plan_items: (rows.items || []).filter(i => i.phase_id === stopId).length,
      plan_days: (rows.days || []).filter(d => d.phase_id === stopId).length,
      bookings: count('SELECT COUNT(*) n FROM bookings WHERE phase = ?'),
      budget_items: count('SELECT COUNT(*) n FROM budget_items WHERE phase = ?'),
      photos: count('SELECT COUNT(*) n FROM photos WHERE phase = ?'),
      moments: count('SELECT COUNT(*) n FROM trip_moments WHERE phase_id = ?'),
    };
  }

  // Move every item and the headline of the given days from one stop to
  // another, inside the caller's itinerary transform.
  // The same move POST /api/itinerary/move-day makes, one day at a time. A
  // headline already on the target day is kept (the target stop's own words).
  function moveDaysInRows(rows, fromId, toId, dates) {
    const target = effectivePhase(toId);
    for (const date of new Set(dates)) {
      moveDayRows(rows, { from: fromId, to: toId, date, lodging: journey().dayContext(target, date), headline: 'keep_target' });
    }
  }

  // ── writing ────────────────────────────────────────────────────────────────
  function write(phaseId, next, action, actor, note) {
    const before = parseRow(q.override.get(phaseId));
    if (next === null) q.remove.run(phaseId);
    else {
      q.upsert.run({
        phase_id: phaseId,
        kind: next.kind,
        fields: JSON.stringify(next.fields || {}),
        after_phase_id: next.after_phase_id || null,
        base_digest: JSON.stringify(next.base_digest || {}),
        booking_id: next.booking_id ?? null,
        updated_by: actor,
      });
    }
    q.history.run(phaseId, action, JSON.stringify(snapshot(before)), next === null ? null : JSON.stringify(snapshot(next)), actor, note || null);
  }

  // The override after setting `fields` on a stop: merged over what it had,
  // with the base's value under each newly set key recorded for conflicts.
  function nextOverride(stopId, fields, extra = {}) {
    const existing = parseRow(q.override.get(stopId));
    const bp = basePhase(stopId);
    const digests = { ...(existing?.base_digest || {}) };
    for (const key of Object.keys(fields)) digests[key] = digest(baseValue(bp, key));
    return {
      kind: existing?.kind || (bp ? 'config' : 'added'),
      fields: { ...(existing?.fields || {}), ...clone(fields) },
      after_phase_id: existing?.after_phase_id || null,
      base_digest: digests,
      booking_id: Object.hasOwn(extra, 'booking_id') ? extra.booking_id : existing?.booking_id ?? null,
    };
  }

  function revisionMatches(ifMatch) {
    return !ifMatch || stripQuotes(ifMatch) === revision();
  }
  const stale = () => fail(409, 'stops_changed_reload_before_retry', { revision: revision() });

  function rangeError(dates) {
    if (!dates) return null;
    const range = tripRange(base());
    if ((range.start && dates.start < range.start) || (range.end && dates.end > range.end)) {
      return fail(400, 'dates_outside_trip', { trip: { start: range.start, end: range.end } });
    }
    return null;
  }

  // Decision 5: a stop's new range that leaves plan items outside it is
  // refused with the list, unless the caller says keep or move_to:<stop>.
  function outsidePlan(stopId, dates, onOutside, { ignore = [] } = {}) {
    const parsed = parseOnOutside(onOutside);
    if (parsed.error) return { error: fail(400, 'invalid_on_outside', { detail: 'on_outside is "keep" or "move_to:<stop id>"' }) };
    if (parsed.mode === 'move' && (parsed.target === stopId || !isStop(parsed.target))) {
      return { error: fail(400, 'invalid_on_outside', { detail: 'move_to must name another stop' }) };
    }
    const outside = itemsOutside(stopId, dates).filter(i => !ignore.includes(i.item_uid));
    if (outside.length && !parsed.mode) return { error: fail(409, 'items_outside_stop', { items: outside }) };
    const moveDates = parsed.mode === 'move' ? [...new Set(outside.map(i => i.date))] : [];
    // Headlines on days outside the range travel with them.
    if (parsed.mode === 'move' && dates) {
      for (const d of rowsOf().days || []) {
        if (d.phase_id === stopId && (d.date < dates.start || d.date > dates.end) && !moveDates.includes(d.date)) moveDates.push(d.date);
      }
    }
    return { outside, mode: parsed.mode, target: parsed.target, moveDates };
  }

  function stopSummary(id) {
    const phase = effectivePhase(id);
    if (!phase) return null;
    return publicPart('phase', {
      id: phase.id, title: phase.title, tabLabel: phase.tabLabel, emoji: phase.emoji,
      dates: phaseDates(phase) || undefined, accommodation: phase.accommodation,
      unplanned: phase.unplanned, note: phase.note,
    }) || { id };
  }

  function requireStop(id) {
    if (isComputed(id) && !isStop(id)) return fail(400, 'unplanned_stop_is_computed');
    if (!isStop(id)) return fail(404, 'unknown_stop');
    return null;
  }

  // Runs one stop operation as ONE transaction: the override, its history,
  // the itinerary rows it moves and the review it queues land together or not
  // at all.
  function atomically(fn) {
    let result;
    // The cache is dropped on a rollback too: AUTOINCREMENT rolls back with
    // the transaction, so the next write would reuse a history id — and with
    // it the cache key of a state that never committed.
    try { db.transaction(() => { result = fn(); })(); } finally { cache = null; }
    return result;
  }

  function applyItinerary(actor, note, transform) {
    return journey().applyChange(actor, note, transform);
  }

  function reviewInfo(phases) {
    return {
      status: reviewConfigured() ? 'queued' : 'unavailable',
      scope: 'phases',
      phases,
      detail: reviewConfigured()
        ? 'Descriptions mentioning a day may now be wrong; re-read the plan of each stop shortly.'
        : 'No reviewer configured — descriptions were not checked for stale day references.',
    };
  }

  const ops = {
    update(id, body, actor, ifMatch) {
      const missing = requireStop(id);
      if (missing) return missing;
      const v = validateStopFields(body, { extra: ['on_outside'] });
      if (v.error) return v.error;
      if (!Object.keys(v.fields).length) return fail(400, 'no_fields');
      if (!revisionMatches(ifMatch)) return stale();
      const fields = v.fields;
      let plan = { outside: [], mode: null, moveDates: [] };
      if (Object.hasOwn(fields, 'dates')) {
        const bad = rangeError(fields.dates);
        if (bad) return bad;
        plan = outsidePlan(id, fields.dates, body.on_outside);
        if (plan.error) return plan.error;
      }
      return atomically(() => {
        write(id, nextOverride(id, fields), 'update', actor, null);
        let itineraryRevision = null;
        if (plan.mode === 'move' && plan.moveDates.length) {
          itineraryRevision = applyItinerary(actor, `Moved days outside ${id} to ${plan.target}`,
            rows => moveDaysInRows(rows, id, plan.target, plan.moveDates));
          queuePhaseReview(id); queuePhaseReview(plan.target);
        }
        return { status: 200, body: {
          revision: revision(), stop: stopSummary(id),
          ...(plan.outside.length ? { outside: { mode: plan.mode, target: plan.target || null, items: plan.outside } } : {}),
          ...(itineraryRevision ? { itinerary_revision: itineraryRevision, review: reviewInfo([id, plan.target]) } : {}),
        } };
      });
    },

    split(id, body, actor, ifMatch) {
      const missing = requireStop(id);
      if (missing) return missing;
      if (!isObj(body)) return fail(400, 'invalid_body');
      for (const key of Object.keys(body)) if (!['at', 'new_stop'].includes(key)) return fail(400, 'unknown_field', { field: key });
      const at = typeof body.at === 'string' && ISO_DATE_RE.test(body.at) ? isoDay(body.at) : null;
      if (!at) return fail(400, 'invalid_split_date');
      const dates = phaseDates(effectivePhase(id));
      if (!dates) return fail(400, 'stop_has_no_dates');
      // Both stops keep at least one night: the new one starts on `at`, the
      // old one ends there (a shared transfer day, as configs write it).
      if (!(dates.start < at && at < dates.end)) return fail(400, 'split_date_not_inside_stop', { stop: dates });
      const ns = isObj(body.new_stop) ? body.new_stop : {};
      const { id: wantedId, ...rest } = ns;
      const v = validateStopFields(rest, { allowed: ['title', 'tabLabel', 'emoji', 'accommodation'], prefix: 'new_stop.' });
      if (v.error) return v.error;
      if (!v.fields.title) return fail(400, 'new_stop_title_required');
      let newId;
      if (wantedId !== undefined) {
        if (typeof wantedId !== 'string' || !STOP_ID_RE.test(wantedId) || /^open-days/.test(wantedId)) return fail(400, 'invalid_stop_id');
        if (isReservedStopId(wantedId)) return fail(400, 'invalid_stop_id', { detail: 'a reserved name' });
        if (isPhase(wantedId) || q.override.get(wantedId)) return fail(409, 'stop_id_taken');
        newId = wantedId;
      } else {
        const title = v.fields.title;
        const seed = slugify(typeof title === 'string' ? title : title.en || '') || `${id}-2`;
        const root = /^open-days/.test(seed) || isReservedStopId(seed) ? `${id}-2` : seed;
        newId = root;
        for (let n = 2; isPhase(newId) || q.override.get(newId); n++) newId = `${root}-${n}`;
      }
      if (!revisionMatches(ifMatch)) return stale();
      const moveDates = [...new Set([
        ...(rowsOf().items || []).filter(i => i.phase_id === id && i.date && i.date > at).map(i => i.date),
        ...(rowsOf().days || []).filter(d => d.phase_id === id && d.date > at).map(d => d.date),
      ])].sort();
      return atomically(() => {
        write(id, nextOverride(id, { dates: { start: dates.start, end: at } }), 'split', actor, `split at ${at} into ${newId}`);
        write(newId, {
          kind: 'added',
          fields: { ...v.fields, dates: { start: at, end: dates.end } },
          after_phase_id: id,
          base_digest: {},
          booking_id: null,
        }, 'split_create', actor, `split from ${id} at ${at}`);
        cache = null;
        const moved = { items: (rowsOf().items || []).filter(i => i.phase_id === id && moveDates.includes(i.date)).map(i => i.item_uid), days: moveDates };
        let itineraryRevision = null;
        if (moveDates.length) {
          itineraryRevision = applyItinerary(actor, `Split ${id} at ${at}`, rows => moveDaysInRows(rows, id, newId, moveDates));
        }
        queuePhaseReview(id);
        queuePhaseReview(newId);
        return { status: 201, body: {
          revision: revision(), itinerary_revision: itineraryRevision,
          stops: [stopSummary(id), stopSummary(newId)], moved, review: reviewInfo([id, newId]),
        } };
      });
    },

    fromBooking(id, body, actor, ifMatch) {
      const missing = requireStop(id);
      if (missing) return missing;
      if (!isObj(body)) return fail(400, 'invalid_body');
      for (const key of Object.keys(body)) if (!['booking_id', 'create_items', 'on_outside'].includes(key)) return fail(400, 'unknown_field', { field: key });
      const bookingId = Number(body.booking_id);
      if (!Number.isInteger(bookingId) || bookingId <= 0 || typeof body.booking_id === 'boolean') return fail(400, 'invalid_booking_id');
      if (body.create_items !== undefined && typeof body.create_items !== 'boolean') return fail(400, 'invalid_create_items');
      const booking = db.prepare('SELECT id, phase, type, name, date_from, date_to, confirmation, location_url, review_status FROM bookings WHERE id = ?').get(bookingId);
      if (!booking) return fail(404, 'booking_not_found');
      // A draft is still in organizer review: it shapes nothing. Nothing of it
      // is echoed back either.
      if ((booking.review_status || 'approved') !== 'approved') return fail(409, 'booking_is_draft');
      if (booking.type !== 'hotel') return fail(400, 'booking_not_hotel');
      // A booking shapes only its own stop (finding 3): one filed under another
      // stop, or already linked to one, would otherwise move that stop's
      // check-in and check-out here. A booking filed under no stop — a
      // trip-wide bucket, or the computed open days — may be linked anywhere,
      // once. The same stop again stays idempotent.
      if (typeof booking.phase === 'string' && booking.phase !== id && isStop(booking.phase)) {
        return fail(409, 'booking_belongs_to_another_stop', { stop: booking.phase });
      }
      const linked = q.linkedElsewhere.get(bookingId, id);
      if (linked) return fail(409, 'booking_linked_to_another_stop', { stop: linked.phase_id });
      const start = isoDay(booking.date_from);
      const end = isoDay(booking.date_to);
      if (!start || !end || start > end) return fail(400, 'booking_has_no_dates');
      const dates = { start, end };
      const bad = rangeError(dates);
      if (bad) return bad;
      // From the booking: its name, confirmation and map link. Never its PIN
      // and never its notes — neither is trip UI data. Each goes through the
      // same validation a PATCH does: a booking name is typed text too, and a
      // hostile one is refused here rather than stored (finding 1). A link
      // that is not one used to be dropped without a word; now it is said.
      const copied = { type: 'hotel', name: String(booking.name || '').slice(0, MAX_TEXT) };
      if (booking.confirmation) copied.confirmation = String(booking.confirmation).slice(0, MAX_TEXT);
      if (typeof booking.location_url === 'string' && booking.location_url.trim()) copied.location_url = booking.location_url;
      const checked = validateAccommodation(copied);
      if (checked.error) return { ...checked.error, body: { ...checked.error.body, source: 'booking' } };
      const accommodation = checked.value;
      if (!revisionMatches(ifMatch)) return stale();
      const uids = { checkin: `booking_${bookingId}_checkin`, checkout: `booking_${bookingId}_checkout` };
      const plan = outsidePlan(id, dates, body.on_outside, { ignore: Object.values(uids) });
      if (plan.error) return plan.error;
      const createItems = body.create_items !== false;
      return atomically(() => {
        write(id, nextOverride(id, { dates, accommodation }, { booking_id: bookingId }), 'from_booking', actor, `booking ${bookingId}`);
        cache = null;
        let itineraryRevision = null;
        if (createItems || (plan.mode === 'move' && plan.moveDates.length)) {
          itineraryRevision = applyItinerary(actor, `Stop ${id} set from booking ${bookingId}`, rows => {
            if (plan.mode === 'move' && plan.moveDates.length) moveDaysInRows(rows, id, plan.target, plan.moveDates);
            if (createItems) upsertBookingItems(rows, id, booking, uids);
          });
        }
        if (plan.mode === 'move' && plan.moveDates.length) { queuePhaseReview(id); queuePhaseReview(plan.target); }
        return { status: 200, body: {
          revision: revision(), stop: stopSummary(id),
          items: createItems ? uids : null, itinerary_revision: itineraryRevision,
          ...(plan.outside.length ? { outside: { mode: plan.mode, target: plan.target || null, items: plan.outside } } : {}),
        } };
      });
    },

    revert(id, body, actor, ifMatch) {
      const missing = requireStop(id);
      if (missing) return missing;
      body = isObj(body) ? body : {};
      for (const key of Object.keys(body)) if (!['history_id', 'on_outside'].includes(key)) return fail(400, 'unknown_field', { field: key });
      const existing = parseRow(q.override.get(id));
      let target = null;
      if (body.history_id !== undefined) {
        const hid = Number(body.history_id);
        const row = Number.isInteger(hid) ? q.historyRow.get(hid) : null;
        if (!row || row.phase_id !== id) return fail(404, 'history_entry_not_found');
        target = readJson(row.after_state, null);
        if (!target) return fail(409, 'history_entry_has_no_state');
      } else if (existing?.kind === 'added' || !basePhase(id)) {
        return fail(409, 'added_stop_has_no_base', { detail: 'an added stop is removed with DELETE' });
      }
      if (!revisionMatches(ifMatch)) return stale();
      // Back to the config with no override: the stop already IS the config.
      // Nothing is written — no null->null history row, no new revision
      // (finding 4) — and the answer is the stop as it stands, like any
      // idempotent write that finds its work done.
      if (!target && !existing) return { status: 200, body: { revision: revision(), stop: stopSummary(id), unchanged: true } };
      const newDates = target
        ? (Object.hasOwn(target.fields || {}, 'dates') ? target.fields.dates : phaseDates(basePhase(id)))
        : phaseDates(basePhase(id));
      const bad = rangeError(newDates);
      if (bad && target) return bad;
      const plan = outsidePlan(id, newDates, body.on_outside);
      if (plan.error) return plan.error;
      return atomically(() => {
        if (target) {
          const bp = basePhase(id);
          const digests = {};
          for (const key of Object.keys(target.fields || {})) digests[key] = digest(baseValue(bp, key));
          write(id, { ...target, after_phase_id: target.after_phase_id ?? existing?.after_phase_id ?? null, base_digest: digests },
            'revert', actor, `to history ${body.history_id}`);
        } else {
          write(id, null, 'revert', actor, 'to the config');
        }
        cache = null;
        let itineraryRevision = null;
        if (plan.mode === 'move' && plan.moveDates.length) {
          itineraryRevision = applyItinerary(actor, `Moved days outside ${id} to ${plan.target}`,
            rows => moveDaysInRows(rows, id, plan.target, plan.moveDates));
          queuePhaseReview(id); queuePhaseReview(plan.target);
        }
        return { status: 200, body: { revision: revision(), stop: stopSummary(id), ...(itineraryRevision ? { itinerary_revision: itineraryRevision } : {}) } };
      });
    },

    remove(id, actor, ifMatch) {
      const missing = requireStop(id);
      if (missing) return missing;
      const existing = parseRow(q.override.get(id));
      // Decision 8: only a stop this layer added, never one the config names.
      if (!existing || existing.kind !== 'added' || basePhase(id)) return fail(409, 'only_added_stops_can_be_removed');
      const refs = references(id);
      if (Object.values(refs).some(n => n > 0)) return fail(409, 'stop_in_use', { references: refs });
      if (!revisionMatches(ifMatch)) return stale();
      return atomically(() => {
        // A stop split off this one is re-hung on this one's parent.
        q.reparent.run(existing.after_phase_id, id);
        write(id, null, 'remove', actor, null);
        return { status: 200, body: { ok: true, revision: revision() } };
      });
    },
  };

  function upsertBookingItems(rows, stopId, booking, uids) {
    const name = String(booking.name || '').slice(0, 200);
    const specs = [
      { uid: uids.checkin, date: isoDay(booking.date_from), time: 'afternoon', he: `צ׳ק-אין — ${name}`, en: `Check-in — ${name}` },
      { uid: uids.checkout, date: isoDay(booking.date_to), time: 'morning', he: `צ׳ק-אאוט — ${name}`, en: `Check-out — ${name}` },
    ];
    for (const spec of specs) {
      const existing = rows.items.find(i => i.item_uid === spec.uid);
      if (existing) {
        // Idempotent: same item, re-pointed at the booking's current date and
        // this stop. Wording an organizer edited is left alone.
        existing.phase_id = stopId;
        existing.date = spec.date;
        existing.booking_id = booking.id;
      } else {
        rows.items.push({
          item_uid: spec.uid, phase_id: stopId, date: spec.date, time: spec.time,
          time_sort: spec.time === 'morning' ? 9 * 60 : 15 * 60,
          // 'booking', not 'lodging': it is what a Classic write turns any row
          // carrying a booking_id into, so the type does not flip later.
          item_type: 'booking', text_he: spec.he, text_en: spec.en,
          location_url: typeof booking.location_url === 'string' && /^https?:\/\//i.test(booking.location_url) ? booking.location_url : null,
          waze_url: null, website_url: null, ticket_url: null, booking_id: booking.id,
          confirmation_state: booking.confirmation ? 'verified' : 'needs_review',
          duration_minutes: null, sort_order: rows.items.length + 1, source_ref: spec.uid,
          created_by: 'booking', extra_links: null,
        });
      }
      if (!rows.days.some(d => d.phase_id === stopId && d.date === spec.date)) {
        rows.days.push({ phase_id: stopId, date: spec.date, label_he: null, label_en: null,
          ...journey().dayContext(effectivePhase(stopId), spec.date), sort_order: rows.days.length });
      }
    }
  }

  // A booking's dates changed: its own check-in/check-out items follow. The
  // stop's dates do not move by themselves — GET /api/stops reports the stop
  // as out of sync, and re-running from-booking applies the new range with
  // every refusal intact.
  function onBookingChanged(bookingId, actor = 'booking') {
    const id = Number(bookingId);
    if (!Number.isInteger(id)) return null;
    const booking = db.prepare("SELECT id, date_from, date_to, COALESCE(review_status, 'approved') AS review_status FROM bookings WHERE id = ?").get(id);
    if (!booking || booking.review_status !== 'approved') return null;
    // A Map, not an object literal: every item uid is looked up in it, and an
    // object answers `constructor` with a function.
    const want = new Map([[`booking_${id}_checkin`, isoDay(booking.date_from)], [`booking_${id}_checkout`, isoDay(booking.date_to)]]);
    const items = (rowsOf().items || []).filter(i => want.has(i.item_uid));
    if (!items.some(i => want.get(i.item_uid) && want.get(i.item_uid) !== i.date)) return null;
    return atomically(() => applyItinerary(actor, `Booking ${id} dates changed`, rows => {
      const left = [];
      for (const item of rows.items) {
        const date = want.get(item.item_uid);
        if (!date || item.date === date) continue;
        left.push({ phase_id: item.phase_id, date: item.date });
        item.date = date;
        if (!rows.days.some(d => d.phase_id === item.phase_id && d.date === date)) {
          rows.days.push({ phase_id: item.phase_id, date, label_he: null, label_en: null,
            ...journey().dayContext(effectivePhase(item.phase_id), date), sort_order: rows.days.length });
        }
      }
      // The day the item left, if nothing else is on it and it has no
      // headline, goes too — it was only there for this item.
      rows.days = rows.days.filter(d => !left.some(l => l.phase_id === d.phase_id && l.date === d.date)
        || d.label_he || d.label_en
        || rows.items.some(i => i.phase_id === d.phase_id && i.date === d.date));
    }));
  }

  // ── organizer/agent read model ─────────────────────────────────────────────
  function listStops() {
    const phases = effectiveConfig().phases || [];
    const overrides = new Map(q.overrides.all().map(parseRow).map(o => [o.phase_id, o]));
    const stops = phases.map(phase => {
      const o = overrides.get(phase.id) || null;
      const bp = basePhase(phase.id);
      let conflict = null;
      if (o && bp) {
        const fields = Object.keys(o.fields).filter(key => {
          const now = baseValue(bp, key);
          return Object.hasOwn(o.base_digest, key) && o.base_digest[key] !== digest(now) && !sameJson(now, o.fields[key]);
        });
        if (fields.length) {
          const baseSummary = publicPart('phase', Object.fromEntries(fields.map(k => [k, baseValue(bp, k) ?? undefined]))) || {};
          conflict = { fields, base: Object.fromEntries(fields.map(k => [k, baseSummary[k] ?? null])) };
        }
      }
      let bookingOutOfSync = false;
      if (o?.booking_id) {
        const b = db.prepare('SELECT date_from, date_to FROM bookings WHERE id = ?').get(o.booking_id);
        const d = phaseDates(phase);
        bookingOutOfSync = !b || !d || isoDay(b.date_from) !== d.start || isoDay(b.date_to) !== d.end;
      }
      return {
        id: phase.id,
        kind: isUnplanned(phase) ? 'computed' : (o?.kind || 'config'),
        unplanned: isUnplanned(phase),
        stop: stopSummary(phase.id),
        override: o ? { fields: Object.keys(o.fields), booking_id: o.booking_id, updated_by: o.updated_by, updated_at: o.updated_at, after_phase_id: o.after_phase_id } : null,
        conflict,
        booking_out_of_sync: bookingOutOfSync,
      };
    });
    const range = tripRange(base());
    return { revision: revision(), trip: { start: range.start, end: range.end }, stops, orphaned_overrides: orphanedOverrides() };
  }

  // Overrides of a stop the config no longer has (a rebuild dropped it).
  // They hold only the fields that were changed — no title, nothing to draw a
  // stop from — so they are not served; this is how that stays visible.
  function orphanedOverrides() {
    const baseIds = new Set((base().phases || []).map(p => p?.id));
    return q.overrides.all().map(parseRow).filter(o => o.kind === 'config' && !baseIds.has(o.phase_id)).map(o => o.phase_id);
  }

  function historyOf(id) {
    return q.historyFor.all(id).map(row => ({
      id: row.id, action: row.action, actor: row.actor, note: row.note, created_at: row.created_at,
      before: readJson(row.before_state, null), after: readJson(row.after_state, null),
    }));
  }

  function registerRoutes(app, { organizerOrAgentRequired }) {
    const send = (res, r) => res.status(r.status).json(r.body);
    app.get('/api/stops', organizerOrAgentRequired, (_req, res) => {
      const body = listStops();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('ETag', `"${body.revision}"`);
      res.json(body);
    });
    app.get('/api/stops/:phase_id/history', organizerOrAgentRequired, (req, res) => {
      if (!isPhase(req.params.phase_id) && !q.historyFor.all(req.params.phase_id).length) return send(res, fail(404, 'unknown_stop'));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ phase_id: req.params.phase_id, revision: revision(), history: historyOf(req.params.phase_id) });
    });
    app.patch('/api/stops/:phase_id', organizerOrAgentRequired, (req, res) =>
      send(res, ops.update(req.params.phase_id, req.body || {}, req.user.username, req.headers['if-match'])));
    app.post('/api/stops/:phase_id/split', organizerOrAgentRequired, (req, res) =>
      send(res, ops.split(req.params.phase_id, req.body || {}, req.user.username, req.headers['if-match'])));
    app.post('/api/stops/:phase_id/from-booking', organizerOrAgentRequired, (req, res) =>
      send(res, ops.fromBooking(req.params.phase_id, req.body || {}, req.user.username, req.headers['if-match'])));
    app.post('/api/stops/:phase_id/revert', organizerOrAgentRequired, (req, res) =>
      send(res, ops.revert(req.params.phase_id, req.body || {}, req.user.username, req.headers['if-match'])));
    app.delete('/api/stops/:phase_id', organizerOrAgentRequired, (req, res) =>
      send(res, ops.remove(req.params.phase_id, req.user.username, req.headers['if-match'])));
  }

  return {
    effectiveConfig, isPhase, isStop, revision, listStops, historyOf, ops, registerRoutes, onBookingChanged, orphanedOverrides,
    phaseTitle: (id) => effectivePhase(id)?.title || null,
  };
}

module.exports = { createTripStructure, openNote, phaseDates };
