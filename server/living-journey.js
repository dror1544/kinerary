const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROUGH_TIMES = { morning: 9 * 60, noon: 12 * 60, afternoon: 15 * 60, evening: 19 * 60 };
const VALID_ITEM_TYPES = new Set(['travel', 'activity', 'meal', 'lodging', 'free_time', 'booking', 'task', 'note']);
const VALID_CONFIRMATION = new Set(['verified', 'missing', 'needs_review']);
const FLIGHTAWARE_API_BASE = (process.env.FLIGHTAWARE_API_BASE_URL || 'https://aeroapi.flightaware.com/aeroapi').replace(/\/$/, '');
const WEATHER_CACHE_MS = 30 * 60 * 1000;
const FLIGHT_CACHE_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function revisionId(prefix = 'rev') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function readJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function writeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function allConfigLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const url = match[1].replace(/&amp;/g, '&');
    const label = stripTags(match[2]);
    if (!/^https?:\/\//i.test(url) || !label || seen.has(url)) continue;
    seen.add(url);
    out.push({ label, url });
  }
  return out;
}

function firstMapHref(html) {
  const m = String(html || '').match(/href="(https?:\/\/[^"]*(?:google\.[^"]*maps|maps\.google|waze\.com)[^"]*)"/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function planTimeSort(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = String(value).trim();
  if (HHMM_RE.test(t)) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  return ROUGH_TIMES[t] ?? null;
}

function normalizeTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = String(value).trim();
  if (HHMM_RE.test(t) || Object.prototype.hasOwnProperty.call(ROUGH_TIMES, t)) return t;
  return null;
}

function normalizeType(value) {
  return VALID_ITEM_TYPES.has(value) ? value : 'activity';
}

function normalizeConfirmation(value) {
  return VALID_CONFIRMATION.has(value) ? value : 'needs_review';
}

function normalizeUiVariant(value) {
  return value === 'modern' ? 'modern' : 'classic';
}

function configVersion(db, raw) {
  const latest = db.prepare('SELECT version, hash FROM trip_config_versions ORDER BY version DESC LIMIT 1').get();
  return {
    version: latest?.version ?? null,
    digest: latest?.hash || digest(raw || ''),
  };
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_ui_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      design_variant TEXT NOT NULL DEFAULT 'classic' CHECK(design_variant IN ('classic','modern')),
      hero_media_file TEXT,
      hero_media_original_name TEXT,
      hero_media_mime TEXT,
      hero_focal_x REAL NOT NULL DEFAULT 0.5,
      hero_focal_y REAL NOT NULL DEFAULT 0.45,
      presentation_prefs TEXT,
      updated_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS itinerary_plan_versions (
      revision_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('original','active')),
      source_config_version INTEGER,
      source_config_digest TEXT NOT NULL,
      parent_revision_id TEXT,
      author TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(parent_revision_id) REFERENCES itinerary_plan_versions(revision_id)
    );

    CREATE TABLE IF NOT EXISTS itinerary_plan_days (
      revision_id TEXT NOT NULL REFERENCES itinerary_plan_versions(revision_id),
      phase_id TEXT NOT NULL,
      date TEXT NOT NULL,
      label_he TEXT,
      label_en TEXT,
      lodging_context TEXT,
      pickup_context TEXT,
      sort_order REAL DEFAULT 0,
      PRIMARY KEY(revision_id, phase_id, date)
    );

    CREATE TABLE IF NOT EXISTS itinerary_plan_items (
      revision_id TEXT NOT NULL REFERENCES itinerary_plan_versions(revision_id),
      item_uid TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      date TEXT,
      time TEXT,
      time_sort INTEGER,
      item_type TEXT NOT NULL DEFAULT 'activity',
      text_he TEXT NOT NULL,
      text_en TEXT,
      location_url TEXT,
      waze_url TEXT,
      website_url TEXT,
      ticket_url TEXT,
      booking_id INTEGER,
      confirmation_state TEXT NOT NULL DEFAULT 'needs_review',
      duration_minutes INTEGER,
      sort_order REAL DEFAULT 0,
      source_ref TEXT,
      created_by TEXT NOT NULL DEFAULT 'system',
      extra_links TEXT,
      PRIMARY KEY(revision_id, item_uid)
    );

    CREATE TABLE IF NOT EXISTS trip_itinerary_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      original_version_id TEXT NOT NULL REFERENCES itinerary_plan_versions(revision_id),
      active_version_id TEXT NOT NULL REFERENCES itinerary_plan_versions(revision_id),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trip_moments (
      id TEXT PRIMARY KEY,
      date TEXT,
      phase_id TEXT,
      item_uid TEXT,
      author TEXT NOT NULL,
      caption TEXT NOT NULL,
      body TEXT,
      photo_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'draft' CHECK(visibility IN ('draft','published')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trip_quality_issues (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK(source IN ('engine','user','hermes')),
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','ignored')),
      phase_id TEXT,
      date TEXT,
      item_uid TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      created_by TEXT,
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS provider_observations (
      provider TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      normalized TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(provider, cache_key)
    );

    CREATE TRIGGER IF NOT EXISTS itinerary_versions_no_update
      BEFORE UPDATE ON itinerary_plan_versions
      BEGIN SELECT RAISE(ABORT, 'itinerary plan versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS itinerary_versions_no_delete
      BEFORE DELETE ON itinerary_plan_versions
      BEGIN SELECT RAISE(ABORT, 'itinerary plan versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS itinerary_days_no_update
      BEFORE UPDATE ON itinerary_plan_days
      BEGIN SELECT RAISE(ABORT, 'itinerary plan days are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS itinerary_days_no_delete
      BEFORE DELETE ON itinerary_plan_days
      BEGIN SELECT RAISE(ABORT, 'itinerary plan days are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS itinerary_items_no_update
      BEFORE UPDATE ON itinerary_plan_items
      BEGIN SELECT RAISE(ABORT, 'itinerary plan items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS itinerary_items_no_delete
      BEFORE DELETE ON itinerary_plan_items
      BEGIN SELECT RAISE(ABORT, 'itinerary plan items are immutable'); END;
  `);
  db.prepare('INSERT OR IGNORE INTO trip_ui_settings (id, design_variant) VALUES (1, ?)').run(normalizeUiVariant(process.env.TRIP_DESIGN_VARIANT));
}

function dayContextForPhase(phase, date) {
  const accommodation = phase?.accommodation || (Array.isArray(phase?.hotels) ? phase.hotels.find((h) => {
    const from = h.date_from || h.check_in || h.from;
    const to = h.date_to || h.check_out || h.to;
    return (!from || from <= date) && (!to || date <= to);
  }) : null);
  return {
    lodging_context: accommodation ? JSON.stringify({
      name: accommodation.name || accommodation.hotel || accommodation.title || null,
      address: accommodation.address || null,
      location_url: accommodation.location_url || accommodation.url || null,
    }) : null,
    pickup_context: phase?.pickup ? JSON.stringify(phase.pickup) : null,
  };
}

function rowsFromConfig(config) {
  const days = [];
  const items = [];
  for (const phase of config.phases || []) {
    for (const [dayIndex, day] of (phase.days || []).entries()) {
      const date = day.date || null;
      if (!date || !ISO_DATE_RE.test(date)) continue;
      const labelHe = stripTags(day.label?.he ?? day.label ?? '');
      const labelEn = stripTags(day.label?.en ?? '');
      const context = dayContextForPhase(phase, date);
      days.push({
        phase_id: phase.id,
        date,
        label_he: labelHe || null,
        label_en: labelEn || null,
        lodging_context: context.lodging_context,
        pickup_context: context.pickup_context,
        sort_order: dayIndex,
      });
      for (const [itemIndex, item] of (day.items || []).entries()) {
        const rawTime = typeof item.time === 'string' ? item.time.trim() : '';
        const time = normalizeTime(rawTime);
        const heText = stripTags(item.text?.he ?? item.text ?? '');
        const enText = stripTags(item.text?.en ?? '');
        const prefix = rawTime && !time ? `${rawTime} - ` : '';
        const text = prefix + (heText || enText);
        if (!text) continue;
        const links = [...allConfigLinks(item.text?.he), ...allConfigLinks(item.text?.en)]
          .filter((link, i, arr) => arr.findIndex((other) => other.url === link.url) === i);
        const ref = `${phase.id}|${date}|${itemIndex}`;
        items.push({
          item_uid: `cfg_${digest(ref).slice(0, 16)}`,
          phase_id: phase.id,
          date,
          time,
          time_sort: planTimeSort(time),
          item_type: normalizeType(item.type),
          text_he: text,
          text_en: enText || null,
          location_url: firstMapHref(item.text?.he) || firstMapHref(item.text?.en) || null,
          waze_url: null,
          website_url: null,
          ticket_url: null,
          booking_id: null,
          confirmation_state: normalizeConfirmation(item.confirmation_state || 'verified'),
          duration_minutes: Number.isFinite(Number(item.duration_minutes)) ? Number(item.duration_minutes) : null,
          sort_order: dayIndex * 1000 + itemIndex,
          source_ref: ref,
          created_by: 'config',
          extra_links: links.length ? JSON.stringify(links) : null,
        });
      }
    }
  }
  return { days, items };
}

function rowsFromLegacyPlan(db) {
  const days = db.prepare(
    'SELECT phase_id, date, label_he, label_en FROM phase_plan_days ORDER BY date ASC'
  ).all().map((row, index) => ({
    phase_id: row.phase_id,
    date: row.date,
    label_he: row.label_he || null,
    label_en: row.label_en || null,
    lodging_context: null,
    pickup_context: null,
    sort_order: index,
  }));
  const items = db.prepare(
    'SELECT * FROM phase_plan_items ORDER BY date ASC, sort_order ASC, COALESCE(time_sort, 99999) ASC, id ASC'
  ).all().map((row, index) => ({
    item_uid: row.itinerary_item_uid || (row.config_ref ? `cfg_${digest(row.config_ref).slice(0, 16)}` : `legacy_${row.id}`),
    phase_id: row.phase_id,
    date: row.date || null,
    time: row.time || null,
    time_sort: row.time_sort ?? planTimeSort(row.time),
    item_type: row.booking_id ? 'booking' : 'activity',
    text_he: row.text_he || row.text_en || '',
    text_en: row.text_en || null,
    location_url: row.location_url || null,
    waze_url: row.waze_url || null,
    website_url: row.website_url || null,
    ticket_url: row.ticket_url || null,
    booking_id: row.booking_id || null,
    confirmation_state: row.status === 'confirmed' ? 'verified' : 'needs_review',
    duration_minutes: null,
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : index,
    source_ref: row.config_ref || `legacy:${row.id}`,
    created_by: row.created_by || 'legacy',
    extra_links: row.extra_links || null,
  })).filter((row) => row.text_he);
  const hasDay = new Set(days.map((day) => `${day.phase_id}|${day.date}`));
  for (const item of items) {
    if (!item.date || hasDay.has(`${item.phase_id}|${item.date}`)) continue;
    days.push({
      phase_id: item.phase_id,
      date: item.date,
      label_he: null,
      label_en: null,
      lodging_context: null,
      pickup_context: null,
      sort_order: days.length,
    });
    hasDay.add(`${item.phase_id}|${item.date}`);
  }
  return { days, items };
}

function insertVersionRows(db, versionId, rows) {
  const insertDay = db.prepare(
    'INSERT INTO itinerary_plan_days (revision_id, phase_id, date, label_he, label_en, lodging_context, pickup_context, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertItem = db.prepare(
    'INSERT INTO itinerary_plan_items (revision_id,item_uid,phase_id,date,time,time_sort,item_type,text_he,text_en,location_url,waze_url,website_url,ticket_url,booking_id,confirmation_state,duration_minutes,sort_order,source_ref,created_by,extra_links) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (const day of rows.days) {
    insertDay.run(versionId, day.phase_id, day.date, day.label_he, day.label_en, day.lodging_context, day.pickup_context, day.sort_order || 0);
  }
  for (const item of rows.items) {
    insertItem.run(
      versionId, item.item_uid, item.phase_id, item.date, item.time, item.time_sort, normalizeType(item.item_type),
      item.text_he, item.text_en, item.location_url, item.waze_url, item.website_url, item.ticket_url,
      item.booking_id, normalizeConfirmation(item.confirmation_state), item.duration_minutes, item.sort_order || 0,
      item.source_ref, item.created_by || 'system', item.extra_links || null
    );
  }
}

function createVersion(db, { kind, parent, author, note, configVersionInfo, rows }) {
  const id = revisionId(kind);
  db.prepare(
    'INSERT INTO itinerary_plan_versions (revision_id, kind, source_config_version, source_config_digest, parent_revision_id, author, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, kind, configVersionInfo.version, configVersionInfo.digest, parent || null, author || 'system', note || null);
  insertVersionRows(db, id, rows);
  return id;
}

function seedState(db, config, raw) {
  const current = db.prepare('SELECT * FROM trip_itinerary_state WHERE id = 1').get();
  if (current) return current;
  const cfg = configVersion(db, raw);
  let state;
  db.transaction(() => {
    const originalId = createVersion(db, {
      kind: 'original',
      author: 'config',
      note: 'Imported immutable plan from trip.config.json',
      configVersionInfo: cfg,
      rows: rowsFromConfig(config),
    });
    const legacyRows = rowsFromLegacyPlan(db);
    const activeRows = legacyRows.items.length || legacyRows.days.length ? legacyRows : rowsFromConfig(config);
    const activeId = createVersion(db, {
      kind: 'active',
      parent: originalId,
      author: legacyRows.items.length || legacyRows.days.length ? 'legacy-plan' : 'config',
      note: legacyRows.items.length || legacyRows.days.length ? 'Imported active plan from phase_plan_* compatibility tables' : 'Active plan cloned from original',
      configVersionInfo: cfg,
      rows: activeRows,
    });
    db.prepare('INSERT INTO trip_itinerary_state (id, original_version_id, active_version_id) VALUES (1, ?, ?)').run(originalId, activeId);
    state = { id: 1, original_version_id: originalId, active_version_id: activeId };
  })();
  return state;
}

function getState(db) {
  return db.prepare('SELECT * FROM trip_itinerary_state WHERE id = 1').get();
}

function getVersionRows(db, revisionIdValue) {
  const version = db.prepare('SELECT * FROM itinerary_plan_versions WHERE revision_id = ?').get(revisionIdValue);
  if (!version) return null;
  const days = db.prepare(
    'SELECT * FROM itinerary_plan_days WHERE revision_id = ? ORDER BY date ASC, sort_order ASC'
  ).all(revisionIdValue).map((day) => ({
    ...day,
    lodging_context: readJson(day.lodging_context, null),
    pickup_context: readJson(day.pickup_context, null),
  }));
  const items = db.prepare(
    'SELECT * FROM itinerary_plan_items WHERE revision_id = ? ORDER BY date ASC, sort_order ASC, COALESCE(time_sort, 99999) ASC, item_uid ASC'
  ).all(revisionIdValue).map((item) => ({
    ...item,
    extra_links: readJson(item.extra_links, []),
  }));
  return { version, days, items };
}

function activeRows(db) {
  const state = getState(db);
  return state ? getVersionRows(db, state.active_version_id) : null;
}

function markProvenance(db, payload) {
  const state = getState(db);
  if (!state) return payload;
  const original = getVersionRows(db, state.original_version_id);
  const byRef = new Map((original?.items || []).map((item) => [item.source_ref || item.item_uid, item]));
  const byUid = new Map((original?.items || []).map((item) => [item.item_uid, item]));
  return {
    ...payload,
    items: payload.items.map((item) => {
      const originalItem = byRef.get(item.source_ref || item.item_uid) || byUid.get(item.item_uid);
      if (!originalItem) return { ...item, provenance: { status: 'added' } };
      const changed = ['date', 'time', 'text_he', 'text_en', 'location_url', 'item_type'].some((field) => (originalItem[field] || null) !== (item[field] || null));
      return changed ? { ...item, provenance: { status: 'updated_from_original' } } : { ...item, provenance: { status: 'original' } };
    }),
  };
}

function serializeItinerary(db, rows, { includeOriginal = false } = {}) {
  // A booking imported for organizer review is not participant-visible yet.
  // Every participant-facing itinerary projection must enforce that boundary;
  // filtering only /api/bookings leaked draft details through attached cards.
  const bookingsById = new Map(db.prepare("SELECT id, type, name, date_from, date_to, confirmation, conf_file, location_url, google_wallet_url, apple_wallet_url, pkpass_file FROM bookings WHERE COALESCE(review_status, 'approved') = 'approved'").all().map((booking) => [booking.id, booking]));
  const payload = {
    revision: rows.version.revision_id,
    kind: rows.version.kind,
    created_at: rows.version.created_at,
    source_config_version: rows.version.source_config_version,
    days: rows.days,
    items: rows.items.map((item) => ({
      ...item,
      booking: item.booking_id ? bookingsById.get(item.booking_id) || null : null,
    })),
  };
  return includeOriginal ? payload : markProvenance(db, payload);
}

function issueFingerprint(issue) {
  return digest([issue.source, issue.severity, issue.phase_id || '', issue.date || '', issue.item_uid || '', issue.title].join('|'));
}

function upsertIssue(db, issue) {
  const fingerprint = issueFingerprint(issue);
  const existing = db.prepare('SELECT id FROM trip_quality_issues WHERE fingerprint = ?').get(fingerprint);
  if (existing) {
    db.prepare(
      "UPDATE trip_quality_issues SET status = CASE WHEN status IN ('resolved', 'ignored') THEN status ELSE 'open' END, detail = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(issue.detail || null, existing.id);
    return existing.id;
  }
  const id = revisionId('issue');
  db.prepare(
    'INSERT INTO trip_quality_issues (id,fingerprint,source,severity,phase_id,date,item_uid,title,detail,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, fingerprint, issue.source || 'engine', issue.severity || 'warning', issue.phase_id || null, issue.date || null, issue.item_uid || null, issue.title, issue.detail || null, issue.created_by || null);
  return id;
}

function recomputeQualityIssues(db) {
  const rows = activeRows(db);
  if (!rows) return [];
  const issues = [];
  const byDate = new Map();
  for (const item of rows.items) {
    if (!item.date) issues.push({ severity: 'warning', item_uid: item.item_uid, phase_id: item.phase_id, title: 'Missing day', detail: item.text_he });
    if (!item.time) issues.push({ severity: 'info', item_uid: item.item_uid, phase_id: item.phase_id, date: item.date, title: 'Missing time', detail: item.text_he });
    if (!item.location_url && ['travel', 'activity', 'meal', 'lodging'].includes(item.item_type)) {
      issues.push({ severity: 'info', item_uid: item.item_uid, phase_id: item.phase_id, date: item.date, title: 'Missing location', detail: item.text_he });
    }
    if (item.confirmation_state !== 'verified' && ['travel', 'booking', 'lodging'].includes(item.item_type)) {
      issues.push({ severity: 'warning', item_uid: item.item_uid, phase_id: item.phase_id, date: item.date, title: 'Confirmation needs review', detail: item.text_he });
    }
    if (item.date && item.time_sort != null) {
      const key = `${item.phase_id}|${item.date}`;
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(item);
    }
  }
  for (const items of byDate.values()) {
    items.sort((a, b) => a.time_sort - b.time_sort);
    for (let i = 1; i < items.length; i++) {
      const previous = items[i - 1];
      const current = items[i];
      const previousEnd = previous.duration_minutes ? previous.time_sort + previous.duration_minutes : previous.time_sort;
      if (previousEnd > current.time_sort) {
        issues.push({
          severity: 'warning',
          phase_id: current.phase_id,
          date: current.date,
          item_uid: current.item_uid,
          title: 'Overlapping events',
          detail: `${previous.text_he} overlaps ${current.text_he}`,
        });
      }
    }
  }
  const ids = issues.map((issue) => upsertIssue(db, { source: 'engine', ...issue }));
  return db.prepare(`SELECT * FROM trip_quality_issues WHERE id IN (${ids.map(() => '?').join(',') || "''"}) ORDER BY created_at DESC`).all(...ids);
}

function etagForPayload(payload) {
  return `"${digest(JSON.stringify(payload)).slice(0, 24)}"`;
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (typeof body?.[field] !== 'string' || !body[field].trim()) return `${field} is required`;
  }
  return null;
}

function cloneWith(db, author, note, transform) {
  const state = getState(db);
  const rows = getVersionRows(db, state.active_version_id);
  const nextRows = {
    days: rows.days.map((day) => ({
      ...day,
      lodging_context: writeJson(day.lodging_context),
      pickup_context: writeJson(day.pickup_context),
    })),
    items: rows.items.map((item) => ({ ...item, extra_links: writeJson(item.extra_links) })),
  };
  transform(nextRows);
  const cfg = {
    version: rows.version.source_config_version,
    digest: rows.version.source_config_digest,
  };
  let nextId;
  db.transaction(() => {
    nextId = createVersion(db, {
      kind: 'active',
      parent: state.active_version_id,
      author,
      note,
      configVersionInfo: cfg,
      rows: nextRows,
    });
    db.prepare("UPDATE trip_itinerary_state SET active_version_id = ?, updated_at = datetime('now') WHERE id = 1").run(nextId);
  })();
  recomputeQualityIssues(db);
  return nextId;
}

function updateLegacyFromActive(db) {
  const rows = activeRows(db);
  if (!rows) return;
  db.transaction(() => {
    // Existing compatibility rows are the source of the initial active
    // revision. Adopt only rows identified by that active revision, then all
    // later deletes are scoped to explicit Modern ownership keys.
    const adoptByConfigRef = db.prepare('UPDATE phase_plan_items SET itinerary_item_uid = ? WHERE itinerary_item_uid IS NULL AND config_ref = ?');
    const adoptByLegacyId = db.prepare('UPDATE phase_plan_items SET itinerary_item_uid = ? WHERE itinerary_item_uid IS NULL AND id = ?');
    for (const item of rows.items) {
      if (typeof item.source_ref === 'string' && /^[^|]+\|\d{4}-\d{2}-\d{2}\|\d+$/.test(item.source_ref)) adoptByConfigRef.run(item.item_uid, item.source_ref);
      const legacyId = /^legacy_(\d+)$/.exec(item.item_uid || '')?.[1];
      if (legacyId) adoptByLegacyId.run(item.item_uid, Number(legacyId));
    }
    const dayInsert = db.prepare(
      `INSERT INTO phase_plan_days (phase_id,date,label_he,label_en,enrichment_status,itinerary_day_key) VALUES (?,?,?,?, 'done', ?)
       ON CONFLICT(phase_id,date) DO UPDATE SET label_he = excluded.label_he, label_en = excluded.label_en, itinerary_day_key = excluded.itinerary_day_key`
    );
    for (const day of rows.days) {
      dayInsert.run(day.phase_id, day.date, day.label_he, day.label_en, `${day.phase_id}\u001f${day.date}`);
    }
    const itemInsert = db.prepare(
      `INSERT INTO phase_plan_items (phase_id,date,time,time_sort,text_he,text_en,location_url,waze_url,website_url,ticket_url,booking_id,status,sort_order,created_by,enrichment_status,config_ref,itinerary_item_uid,extra_links)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(itinerary_item_uid) WHERE itinerary_item_uid IS NOT NULL DO UPDATE SET
         phase_id=excluded.phase_id, date=excluded.date, time=excluded.time, time_sort=excluded.time_sort,
         text_he=excluded.text_he, text_en=excluded.text_en, location_url=excluded.location_url,
         waze_url=excluded.waze_url, website_url=excluded.website_url, ticket_url=excluded.ticket_url,
         booking_id=excluded.booking_id, status=excluded.status, sort_order=excluded.sort_order,
         extra_links=excluded.extra_links`
    );
    for (const item of rows.items) {
      const configRef = typeof item.source_ref === 'string' && /^[^|]+\|\d{4}-\d{2}-\d{2}\|\d+$/.test(item.source_ref) ? item.source_ref : null;
      itemInsert.run(
        item.phase_id, item.date, item.time, item.time_sort, item.text_he, item.text_en,
        item.location_url, item.waze_url, item.website_url, item.ticket_url, item.booking_id,
        item.confirmation_state === 'verified' ? 'confirmed' : 'needs_review',
        item.sort_order || 0, item.created_by || 'modern', 'none', configRef, item.item_uid, writeJson(item.extra_links)
      );
    }
    const dayKeys = rows.days.map((day) => `${day.phase_id}\u001f${day.date}`);
    if (dayKeys.length) db.prepare(`DELETE FROM phase_plan_days WHERE itinerary_day_key IS NOT NULL AND itinerary_day_key NOT IN (${dayKeys.map(() => '?').join(',')})`).run(...dayKeys);
    else db.prepare('DELETE FROM phase_plan_days WHERE itinerary_day_key IS NOT NULL').run();
    const itemUids = rows.items.map((item) => item.item_uid);
    if (itemUids.length) db.prepare(`DELETE FROM phase_plan_items WHERE itinerary_item_uid IS NOT NULL AND itinerary_item_uid NOT IN (${itemUids.map(() => '?').join(',')})`).run(...itemUids);
    else db.prepare('DELETE FROM phase_plan_items WHERE itinerary_item_uid IS NOT NULL').run();
  })();
}

function syncFromLegacy(db, raw, author = 'legacy-api') {
  const state = getState(db);
  if (!state) return null;
  const rows = rowsFromLegacyPlan(db);
  if (!rows.items.length && !rows.days.length) return state.active_version_id;
  const current = getVersionRows(db, state.active_version_id);
  const comparable = (value) => ({
    days: value.days.map(({ phase_id, date, label_he, label_en, lodging_context, pickup_context, sort_order }) => ({
      phase_id, date, label_he, label_en, lodging_context: writeJson(lodging_context), pickup_context: writeJson(pickup_context), sort_order,
    })),
    items: value.items.map(({ item_uid, phase_id, date, time, time_sort, item_type, text_he, text_en, location_url, waze_url, website_url, ticket_url, booking_id, confirmation_state, duration_minutes, sort_order, source_ref, created_by, extra_links }) => ({
      item_uid, phase_id, date, time, time_sort, item_type, text_he, text_en, location_url, waze_url, website_url, ticket_url, booking_id, confirmation_state, duration_minutes, sort_order, source_ref, created_by, extra_links: writeJson(extra_links),
    })),
  });
  const nextDigest = digest(JSON.stringify(comparable(rows)));
  const currentDigest = digest(JSON.stringify(comparable(current)));
  if (nextDigest === currentDigest) return state.active_version_id;
  const cfg = configVersion(db, raw);
  let nextId;
  db.transaction(() => {
    nextId = createVersion(db, {
      kind: 'active',
      parent: state.active_version_id,
      author,
      note: 'Synchronized from compatibility phase_plan_* write',
      configVersionInfo: cfg,
      rows,
    });
    db.prepare("UPDATE trip_itinerary_state SET active_version_id = ?, updated_at = datetime('now') WHERE id = 1").run(nextId);
  })();
  recomputeQualityIssues(db);
  return nextId;
}

function heroPublicUrl(file) {
  return file ? `/api/ui/hero/${encodeURIComponent(file)}` : null;
}

function uiSettings(db) {
  const row = db.prepare('SELECT * FROM trip_ui_settings WHERE id = 1').get();
  return {
    design_variant: normalizeUiVariant(row?.design_variant),
    hero: {
      url: heroPublicUrl(row?.hero_media_file),
      original_name: row?.hero_media_original_name || null,
      mime: row?.hero_media_mime || null,
      focal_x: Number(row?.hero_focal_x ?? 0.5),
      focal_y: Number(row?.hero_focal_y ?? 0.45),
    },
    presentation_prefs: readJson(row?.presentation_prefs, {}),
    updated_at: row?.updated_at || null,
  };
}

function flightIdentifier(booking) {
  const text = [booking.name, booking.confirmation, booking.notes].filter(Boolean).join(' ');
  const match = text.match(/\b([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])\s?([0-9]{1,4})\b/);
  return match ? `${match[1]}${match[2]}`.toUpperCase() : null;
}

function withinFlightWindow(booking, clock = new Date()) {
  if (!booking.date_from || !ISO_DATE_RE.test(String(booking.date_from).slice(0, 10))) return false;
  const start = new Date(`${String(booking.date_from).slice(0, 10)}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000;
  const end = new Date(`${String(booking.date_to || booking.date_from).slice(0, 10)}T23:59:59Z`).getTime() + 4 * 60 * 60 * 1000;
  const t = clock.getTime();
  return t >= start && t <= end;
}

function tripTimeZone(config) {
  return config.meta?.timezone || config.timezone || config.phases?.find((phase) => phase.timezone)?.timezone || 'UTC';
}

function localClock(config, date = new Date()) {
  const timeZone = tripTimeZone(config);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return {
      date: `${pick('year')}-${pick('month')}-${pick('day')}`,
      minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
      time_zone: timeZone,
    };
  } catch {
    return {
      date: date.toISOString().slice(0, 10),
      minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
      time_zone: 'UTC',
    };
  }
}

function cachedObservation(db, provider, cacheKey) {
  const row = db.prepare('SELECT * FROM provider_observations WHERE provider = ? AND cache_key = ?').get(provider, cacheKey);
  if (!row) return null;
  const payload = readJson(row.normalized, null);
  return payload ? { ...payload, fetched_at: row.fetched_at, stale: new Date(row.expires_at).getTime() <= Date.now() } : null;
}

function writeObservation(db, provider, cacheKey, normalized, ttlMs) {
  const fetched = nowIso();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    'INSERT INTO provider_observations (provider, cache_key, normalized, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, cache_key) DO UPDATE SET normalized = excluded.normalized, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at'
  ).run(provider, cacheKey, JSON.stringify(normalized), fetched, expires);
  return { ...normalized, fetched_at: fetched, stale: false };
}

async function flightStatus(db, fetchImpl, booking) {
  const ident = flightIdentifier(booking);
  const facts = {
    id: booking.id,
    name: booking.name,
    date_from: booking.date_from,
    date_to: booking.date_to,
    confirmation: booking.confirmation || null,
    conf_file: booking.conf_file || null,
    identifier: ident,
  };
  if (!ident) return { facts, source: 'stored_booking', status: null, stale: false };
  const cacheKey = `${ident}|${booking.date_from || ''}`;
  const cached = cachedObservation(db, 'flightaware', cacheKey);
  if (cached && !cached.stale) return { facts, ...cached };
  if (!process.env.FLIGHTAWARE_API_KEY || !withinFlightWindow(booking)) {
    return { facts, ...(cached || { source: 'stored_booking', status: null, stale: false }) };
  }
  try {
    const response = await fetchImpl(`${FLIGHTAWARE_API_BASE}/flights/${encodeURIComponent(ident)}`, {
      headers: { 'x-apikey': process.env.FLIGHTAWARE_API_KEY, accept: 'application/json' },
      timeout: 8000,
    });
    if (!response.ok) throw new Error(`FlightAware ${response.status}`);
    const raw = await response.json();
    const flight = Array.isArray(raw.flights) ? raw.flights[0] : raw;
    const normalized = {
      source: 'flightaware',
      status: flight?.status || flight?.progress_percent != null ? {
        status: flight?.status || null,
        gate_origin: flight?.gate_origin || null,
        gate_destination: flight?.gate_destination || null,
        terminal_origin: flight?.terminal_origin || null,
        terminal_destination: flight?.terminal_destination || null,
        scheduled_out: flight?.scheduled_out || null,
        estimated_out: flight?.estimated_out || null,
        scheduled_in: flight?.scheduled_in || null,
        estimated_in: flight?.estimated_in || null,
      } : null,
    };
    return { facts, ...writeObservation(db, 'flightaware', cacheKey, normalized, FLIGHT_CACHE_MS) };
  } catch {
    return { facts, ...(cached || { source: 'stored_booking', status: null, stale: false }) };
  }
}

async function weatherObservation(db, fetchImpl, query) {
  const latitude = Number(query.lat);
  const longitude = Number(query.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: 'lat and lon are required' };
  }
  const date = ISO_DATE_RE.test(String(query.date || '')) ? String(query.date) : new Date().toISOString().slice(0, 10);
  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}|${date}`;
  const cached = cachedObservation(db, 'weather', cacheKey);
  if (cached && !cached.stale) return cached;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=14&timezone=auto`;
  try {
    const response = await fetchImpl(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`weather ${response.status}`);
    const raw = await response.json();
    const index = raw?.daily?.time?.indexOf(date) ?? -1;
    const normalized = {
      source: 'open-meteo',
      date,
      temperature_max: index >= 0 ? raw.daily.temperature_2m_max?.[index] ?? null : null,
      temperature_min: index >= 0 ? raw.daily.temperature_2m_min?.[index] ?? null : null,
      precipitation_probability: index >= 0 ? raw.daily.precipitation_probability_max?.[index] ?? null : null,
    };
    return writeObservation(db, 'weather', cacheKey, normalized, WEATHER_CACHE_MS);
  } catch {
    return cached || { source: 'unavailable', date, stale: true, fetched_at: null };
  }
}

function buildTodayContext(db, config) {
  const rows = activeRows(db);
  const clock = localClock(config);
  const today = clock.date;
  const datedItems = rows?.items.filter((item) => item.date).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.time_sort ?? 99999) - (b.time_sort ?? 99999)) || [];
  const firstDate = datedItems[0]?.date || config.meta?.departure || null;
  const lastDate = datedItems[datedItems.length - 1]?.date || null;
  let phase = 'pre_trip';
  if (firstDate && today < firstDate) phase = 'pre_trip';
  else if (lastDate && today > lastDate) phase = 'post_trip';
  else phase = 'active_day';
  const todayItems = datedItems.filter((item) => item.date === today);
  const nextItem = todayItems.find((item) => item.time_sort == null || item.time_sort >= clock.minutes) || datedItems.find((item) => item.date >= today) || null;
  const flightToday = db.prepare("SELECT id, type, name, date_from, date_to, confirmation, conf_file, notes FROM bookings WHERE type = 'flight' AND COALESCE(review_status, 'approved') = 'approved' AND (date_from = ? OR date_to = ?) ORDER BY date_from ASC").all(today, today);
  if (flightToday.length) phase = 'flight_day';
  return {
    today,
    time_zone: clock.time_zone,
    phase,
    first_date: firstDate,
    last_date: lastDate,
    countdown_days: firstDate ? Math.ceil((new Date(`${firstDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000) : null,
    current: todayItems[0] || null,
    next: nextItem,
    events: todayItems,
    flights: flightToday,
  };
}

function confirmationSummary(db) {
  const bookings = db.prepare("SELECT id, type, name, confirmation, conf_file, date_from, date_to FROM bookings WHERE COALESCE(review_status, 'approved') = 'approved' ORDER BY date_from ASC, id ASC").all();
  return bookings.map((booking) => {
    const hasConfirmation = Boolean(booking.confirmation || booking.conf_file);
    return {
      id: booking.id,
      type: booking.type,
      name: booking.name,
      date_from: booking.date_from,
      date_to: booking.date_to,
      state: hasConfirmation ? 'verified' : 'missing',
      document_present: Boolean(booking.conf_file),
      last_verification: null,
      next_action: hasConfirmation ? null : `Add confirmation for ${booking.name}`,
    };
  });
}

function registerRoutes({ app, db, config, raw, fetchImpl, mediaDir, authRequired, organizerOrAgentRequired }) {
  app.get('/api/ui-bootstrap', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      design_variant: uiSettings(db).design_variant,
      routes: {
        classic: '/classic.html',
        modern: '/modern/',
      },
    });
  });

  app.get('/api/ui-settings', authRequired, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(uiSettings(db));
  });

  app.patch('/api/ui-settings', organizerOrAgentRequired, (req, res) => {
    const body = req.body || {};
    if (body.design_variant !== undefined && !['classic', 'modern'].includes(body.design_variant)) {
      return res.status(400).json({ error: 'design_variant must be classic or modern' });
    }
    const prefs = body.presentation_prefs !== undefined ? JSON.stringify(body.presentation_prefs || {}) : undefined;
    db.prepare(
      "UPDATE trip_ui_settings SET design_variant = COALESCE(?, design_variant), hero_focal_x = COALESCE(?, hero_focal_x), hero_focal_y = COALESCE(?, hero_focal_y), presentation_prefs = COALESCE(?, presentation_prefs), updated_by = ?, updated_at = datetime('now') WHERE id = 1"
    ).run(
      body.design_variant ?? null,
      Number.isFinite(Number(body.hero_focal_x)) ? Math.max(0, Math.min(1, Number(body.hero_focal_x))) : null,
      Number.isFinite(Number(body.hero_focal_y)) ? Math.max(0, Math.min(1, Number(body.hero_focal_y))) : null,
      prefs,
      req.user.username
    );
    res.json(uiSettings(db));
  });

  app.post('/api/ui-settings/hero/revert', organizerOrAgentRequired, (_req, res) => {
    db.prepare("UPDATE trip_ui_settings SET hero_media_file = NULL, hero_media_original_name = NULL, hero_media_mime = NULL, hero_focal_x = 0.5, hero_focal_y = 0.45, updated_at = datetime('now') WHERE id = 1").run();
    res.json(uiSettings(db));
  });

  app.get('/api/ui/hero/:filename', authRequired, (req, res) => {
    const filename = path.basename(req.params.filename);
    const file = path.join(mediaDir, filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    res.sendFile(file);
  });

  app.get('/api/itinerary/active', authRequired, (req, res) => {
    const rows = activeRows(db);
    if (!rows) return res.status(404).json({ error: 'itinerary_not_ready' });
    const payload = serializeItinerary(db, rows);
    const etag = etagForPayload(payload);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json(payload);
  });

  app.get('/api/itinerary/original', organizerOrAgentRequired, (_req, res) => {
    const state = getState(db);
    const rows = state ? getVersionRows(db, state.original_version_id) : null;
    if (!rows) return res.status(404).json({ error: 'itinerary_not_ready' });
    res.json(serializeItinerary(db, rows, { includeOriginal: true }));
  });

  app.get('/api/itinerary/revisions', organizerOrAgentRequired, (_req, res) => {
    res.json(db.prepare('SELECT revision_id, kind, source_config_version, parent_revision_id, author, note, created_at FROM itinerary_plan_versions ORDER BY created_at DESC').all());
  });

  app.get('/api/itinerary/diff', organizerOrAgentRequired, (_req, res) => {
    const state = getState(db);
    const original = getVersionRows(db, state.original_version_id);
    const active = getVersionRows(db, state.active_version_id);
    res.json({
      original_revision: state.original_version_id,
      active_revision: state.active_version_id,
      changed_items: markProvenance(db, { items: active.items }).items.filter((item) => item.provenance.status !== 'original'),
      day_count_delta: active.days.length - original.days.length,
      item_count_delta: active.items.length - original.items.length,
    });
  });

  app.post('/api/itinerary/items', organizerOrAgentRequired, (req, res) => {
    const body = req.body || {};
    const bad = requireFields(body, ['phase_id', 'date', 'text_he']);
    if (bad) return res.status(400).json({ error: bad });
    if (!ISO_DATE_RE.test(body.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const uid = revisionId('item');
    const nextId = cloneWith(db, req.user.username, 'Organizer added itinerary item', (rows) => {
      if (!rows.days.some((day) => day.phase_id === body.phase_id && day.date === body.date)) {
        rows.days.push({ phase_id: body.phase_id, date: body.date, label_he: null, label_en: null, lodging_context: null, pickup_context: null, sort_order: rows.days.length });
      }
      rows.items.push({
        item_uid: uid,
        phase_id: body.phase_id,
        date: body.date,
        time: normalizeTime(body.time),
        time_sort: planTimeSort(body.time),
        item_type: normalizeType(body.item_type),
        text_he: body.text_he.trim(),
        text_en: typeof body.text_en === 'string' ? body.text_en.trim() || null : null,
        location_url: typeof body.location_url === 'string' ? body.location_url || null : null,
        waze_url: null,
        website_url: null,
        ticket_url: null,
        booking_id: body.booking_id == null || (typeof body.booking_id === 'string' && body.booking_id.trim() === '') ? null : Number.isInteger(Number(body.booking_id)) ? Number(body.booking_id) : null,
        confirmation_state: normalizeConfirmation(body.confirmation_state),
        duration_minutes: Number.isFinite(Number(body.duration_minutes)) ? Number(body.duration_minutes) : null,
        sort_order: rows.items.length + 1,
        source_ref: uid,
        created_by: req.user.username,
        extra_links: null,
      });
    });
    updateLegacyFromActive(db);
    res.status(201).json({ revision: nextId, item_uid: uid });
  });

  app.patch('/api/itinerary/items/:item_uid', organizerOrAgentRequired, (req, res) => {
    const uid = req.params.item_uid;
    const body = req.body || {};
    for (const field of ['phase_id', 'date', 'text_he']) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim())) {
        return res.status(400).json({ error: `${field} must not be empty` });
      }
    }
    if (body.date !== undefined && !ISO_DATE_RE.test(body.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    let touched = false;
    const nextId = cloneWith(db, req.user.username, 'Organizer edited itinerary item', (rows) => {
      rows.items = rows.items.map((item) => {
        if (item.item_uid !== uid) return item;
        touched = true;
        const next = { ...item };
        for (const field of ['phase_id', 'date', 'text_he', 'text_en', 'location_url']) {
          if (body[field] !== undefined) next[field] = typeof body[field] === 'string' ? body[field].trim() || null : null;
        }
        if (body.time !== undefined) {
          next.time = normalizeTime(body.time);
          next.time_sort = planTimeSort(body.time);
        }
        if (body.item_type !== undefined) next.item_type = normalizeType(body.item_type);
        if (body.confirmation_state !== undefined) next.confirmation_state = normalizeConfirmation(body.confirmation_state);
        if (body.duration_minutes !== undefined) next.duration_minutes = Number.isFinite(Number(body.duration_minutes)) ? Number(body.duration_minutes) : null;
        return next;
      });
    });
    if (!touched) return res.status(404).json({ error: 'not found' });
    updateLegacyFromActive(db);
    res.json({ revision: nextId, item_uid: uid });
  });

  app.delete('/api/itinerary/items/:item_uid', organizerOrAgentRequired, (req, res) => {
    const uid = req.params.item_uid;
    let touched = false;
    const nextId = cloneWith(db, req.user.username, 'Organizer removed itinerary item', (rows) => {
      const before = rows.items.length;
      rows.items = rows.items.filter((item) => item.item_uid !== uid);
      touched = rows.items.length !== before;
    });
    if (!touched) return res.status(404).json({ error: 'not found' });
    updateLegacyFromActive(db);
    res.json({ ok: true, revision: nextId });
  });

  app.post('/api/itinerary/swap-days', organizerOrAgentRequired, (req, res) => {
    const { phase_id, date_a, date_b } = req.body || {};
    if (!phase_id || !ISO_DATE_RE.test(date_a || '') || !ISO_DATE_RE.test(date_b || '') || date_a === date_b) {
      return res.status(400).json({ error: 'phase_id, date_a and date_b are required' });
    }
    const nextId = cloneWith(db, req.user.username, 'Organizer swapped itinerary days', (rows) => {
      for (const item of rows.items) {
        if (item.phase_id !== phase_id) continue;
        if (item.date === date_a) item.date = date_b;
        else if (item.date === date_b) item.date = date_a;
      }
      for (const day of rows.days) {
        if (day.phase_id !== phase_id) continue;
        if (day.date === date_a) day.date = date_b;
        else if (day.date === date_b) day.date = date_a;
      }
    });
    updateLegacyFromActive(db);
    res.json({ revision: nextId });
  });

  app.get('/api/today', authRequired, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildTodayContext(db, config));
  });

  app.get('/api/confirmations/summary', authRequired, (_req, res) => {
    res.json({ items: confirmationSummary(db) });
  });

  app.get('/api/operations/flights', authRequired, async (_req, res) => {
    const flights = db.prepare("SELECT * FROM bookings WHERE type = 'flight' AND COALESCE(review_status, 'approved') = 'approved' ORDER BY date_from ASC, id ASC").all();
    const statuses = [];
    for (const booking of flights) statuses.push(await flightStatus(db, fetchImpl, booking));
    res.json({ provider: 'flightaware', statuses });
  });

  app.get('/api/operations/weather', authRequired, async (req, res) => {
    const result = await weatherObservation(db, fetchImpl, req.query || {});
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  });

  app.get('/api/hermes/status', authRequired, (_req, res) => {
    const issues = db.prepare("SELECT COUNT(*) AS count FROM trip_quality_issues WHERE status = 'open'").get().count;
    res.json({
      identity: {
        name: config.agent?.name || 'Hermes',
        profile: config.agent?.profile || null,
      },
      available: Boolean(process.env.HERMES_URL || process.env.HERMES_API_KEY),
      ask_in_telegram: Boolean(process.env.TELEGRAM_BOT_USERNAME),
      telegram_username: process.env.TELEGRAM_BOT_USERNAME || null,
      verification_freshness: {
        open_issues: issues,
        checked_at: nowIso(),
      },
    });
  });

  app.get('/api/issues', organizerOrAgentRequired, (_req, res) => {
    recomputeQualityIssues(db);
    res.json(db.prepare('SELECT * FROM trip_quality_issues ORDER BY status ASC, created_at DESC').all());
  });

  app.post('/api/issues/report', authRequired, (req, res) => {
    const body = req.body || {};
    if (typeof body.title !== 'string' || !body.title.trim()) return res.status(400).json({ error: 'title required' });
    const id = upsertIssue(db, {
      source: 'user',
      severity: ['info', 'warning', 'critical'].includes(body.severity) ? body.severity : 'warning',
      phase_id: body.phase_id,
      date: body.date,
      item_uid: body.item_uid,
      title: body.title.trim(),
      detail: typeof body.detail === 'string' ? body.detail.slice(0, 1000) : null,
      created_by: req.user.username,
    });
    res.status(201).json({ id });
  });

  app.patch('/api/issues/:id', organizerOrAgentRequired, (req, res) => {
    const status = ['open', 'resolved', 'ignored'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'status must be open, resolved or ignored' });
    db.prepare("UPDATE trip_quality_issues SET status = ?, resolved_by = ?, resolved_at = CASE WHEN ? IN ('resolved','ignored') THEN datetime('now') ELSE NULL END, resolution_note = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, req.user.username, status, req.body?.resolution_note || null, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/moments', authRequired, (req, res) => {
    const rows = db.prepare(
      "SELECT * FROM trip_moments WHERE visibility = 'published' OR author = ? ORDER BY COALESCE(date, created_at) DESC, created_at DESC"
    ).all(req.user.username);
    res.json(rows);
  });

  app.post('/api/moments', authRequired, (req, res) => {
    const body = req.body || {};
    if (typeof body.caption !== 'string' || !body.caption.trim()) return res.status(400).json({ error: 'caption required' });
    const id = revisionId('moment');
    const visibility = body.visibility === 'published' ? 'published' : 'draft';
    db.prepare(
      'INSERT INTO trip_moments (id,date,phase_id,item_uid,author,caption,body,photo_id,visibility) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, body.date || null, body.phase_id || null, body.item_uid || null, req.user.username, body.caption.trim(), body.body || null, body.photo_id || null, visibility);
    res.status(201).json(db.prepare('SELECT * FROM trip_moments WHERE id = ?').get(id));
  });

  app.patch('/api/moments/:id', authRequired, (req, res) => {
    const row = db.prepare('SELECT * FROM trip_moments WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const organizers = Array.isArray(config.agent?.organizers)
      ? config.agent.organizers
      : [config.agent?.organizer].filter(Boolean);
    if (row.author !== req.user.username && !organizers.includes(req.user.username) && !req.user.isAgent) return res.status(403).json({ error: 'forbidden' });
    db.prepare("UPDATE trip_moments SET caption = COALESCE(?, caption), body = COALESCE(?, body), visibility = COALESCE(?, visibility), updated_at = datetime('now') WHERE id = ?")
      .run(req.body?.caption ?? null, req.body?.body ?? null, ['draft', 'published'].includes(req.body?.visibility) ? req.body.visibility : null, req.params.id);
    res.json(db.prepare('SELECT * FROM trip_moments WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/moments/:id', authRequired, (req, res) => {
    const row = db.prepare('SELECT * FROM trip_moments WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const organizers = Array.isArray(config.agent?.organizers)
      ? config.agent.organizers
      : [config.agent?.organizer].filter(Boolean);
    if (row.author !== req.user.username && !organizers.includes(req.user.username) && !req.user.isAgent) return res.status(403).json({ error: 'forbidden' });
    db.prepare('DELETE FROM trip_moments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
}

function create(options) {
  const { db, config, raw, mediaDir } = options;
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  schema(db);
  seedState(db, config, raw);
  recomputeQualityIssues(db);
  return {
    registerRoutes: (app, middlewares) => registerRoutes({ ...options, app, ...middlewares }),
    syncFromLegacy: (author) => syncFromLegacy(db, raw, author),
    updateLegacyFromActive: () => updateLegacyFromActive(db),
    uiSettings: () => uiSettings(db),
  };
}

module.exports = { create };
