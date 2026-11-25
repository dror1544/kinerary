// ── The Telegram group's photo, from the trip logo (docs/specs/sprint-9/x-trip-group-photo.md) ──────────────────────
// The SITE'S half. This module never calls Telegram and never learns a chat id: it keeps the organizer's REQUEST, hands
// it (and the logo as a 640x640 PNG) to the control plane when the control plane asks through the runtime gateway, and
// records the answer. The control plane resolves the chat from the trip's own open binding, checks the bot's rights in it,
// calls setChatPhoto, and reports the true result back here (control-plane/api/src/group-photo-poller.ts).
//
//   POST /api/group-photo            an organizer (or the agent key) asks. 403 for a member, 409 feature_off, 422 no_logo.
//   GET  /api/group-photo            the newest request and what happened to it.
//   POST .../control-plane/group-photo/claim    the control plane takes the newest pending request (+ the PNG).
//   POST .../control-plane/group-photo/result   the control plane says how it ended.
//
// The request row is the ONLY status. States: pending -> sending -> done | bot_lacks_rights | no_group | no_logo | failed;
// pending older than 24 h -> expired (it never ran); sending older than 10 min -> pending again (the answer was lost),
// at most three times, then failed. Nothing here loops: every transition is a bounded one.

const fs = require('node:fs');
const sharp = require('sharp');

const SWITCH = 'trip_group_photo';
const PHOTO_SIZE = 640; // what Telegram wants for a chat photo
const EXPIRES_AFTER = '-24 hours';
const SENDING_TIMEOUT = '-10 minutes';
const MAX_CLAIMS = 3;
const MAX_DETAIL = 300;
/** What the control plane may report. `pending`, `sending` and `expired` are the site's own words, never taken from it. */
const REPORTABLE = new Set(['done', 'bot_lacks_rights', 'no_group', 'no_logo', 'failed']);
const FINISHED = new Set(['done', 'bot_lacks_rights', 'no_group', 'no_logo', 'failed', 'expired']);

const MESSAGES = Object.freeze({
  pending: 'The request is on its way to the group. This usually takes a minute or two.',
  sending: 'The bot is setting the group photo now.',
  done: 'Done: the group\'s photo is now the trip logo.',
  bot_lacks_rights: 'Make the bot an admin with "Change group info", then ask again.',
  no_group: 'No Telegram group is connected to this trip yet. Connect a group, then ask again.',
  no_logo: 'This trip has no logo yet. Add one first, then ask again.',
  failed: 'Telegram did not set the photo. Try again in a few minutes.',
  expired: 'The request waited more than 24 hours without running, so it was dropped. Ask again.',
});

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_group_photo_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logo_hash TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','sending','done','bot_lacks_rights','no_group','no_logo','failed','expired')),
      detail TEXT,
      claimed_at TEXT,
      claims INTEGER NOT NULL DEFAULT 0,
      finished_at TEXT
    );
  `);
}

// Telegram's own words, kept short, with no control characters (they are shown to an organizer and logged nowhere else).
function cleanDetail(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
  return text || null;
}

const iso = (sqlite) => (typeof sqlite === 'string' ? `${sqlite.replace(' ', 'T')}Z` : null);

function view(row) {
  if (!row) return { status: 'none', request: null, message: null };
  return {
    status: row.status,
    request: {
      id: row.id,
      status: row.status,
      detail: row.detail,
      requested_by: row.requested_by,
      requested_at: iso(row.requested_at),
      finished_at: iso(row.finished_at),
    },
    message: MESSAGES[row.status] || null,
  };
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {() => {file: string|null, hash: string|null, source: string}} o.effectiveLogo  server/site-icons.js: the ONE answer to "which file is the logo"
 * @param {(name: string) => boolean} o.featureOn  server.js's `featureOn` (the literal true in the trip file's block)
 */
function create({ db, effectiveLogo, featureOn }) {
  schema(db);

  const latest = db.prepare('SELECT * FROM trip_group_photo_requests ORDER BY id DESC LIMIT 1');
  const byId = db.prepare('SELECT * FROM trip_group_photo_requests WHERE id = ?');

  // The time-based transitions, run before every read or write so no timer is needed and none can be missed.
  const sweep = db.transaction(() => {
    db.prepare(
      `UPDATE trip_group_photo_requests SET status = 'expired', finished_at = datetime('now')
       WHERE status = 'pending' AND requested_at < datetime('now', ?)`,
    ).run(EXPIRES_AFTER);
    db.prepare(
      `UPDATE trip_group_photo_requests SET status = 'failed', detail = 'No result came back from the control plane.', finished_at = datetime('now')
       WHERE status = 'sending' AND claimed_at < datetime('now', ?) AND claims >= ?`,
    ).run(SENDING_TIMEOUT, MAX_CLAIMS);
    db.prepare(
      `UPDATE trip_group_photo_requests SET status = 'pending'
       WHERE status = 'sending' AND claimed_at < datetime('now', ?)`,
    ).run(SENDING_TIMEOUT);
  });

  const request = (username) => {
    sweep();
    const logo = effectiveLogo();
    if (!logo || !logo.file) return { refused: 'no_logo' };
    // Two requests in a row are one: the one that has not run yet takes the newer asker and the newer logo.
    const waiting = db.prepare("SELECT id FROM trip_group_photo_requests WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get();
    if (waiting) {
      db.prepare("UPDATE trip_group_photo_requests SET logo_hash = ?, requested_by = ?, requested_at = datetime('now'), claims = 0, detail = NULL WHERE id = ?")
        .run(logo.hash || '', username, waiting.id);
      return { row: byId.get(waiting.id) };
    }
    const info = db.prepare('INSERT INTO trip_group_photo_requests (logo_hash, requested_by) VALUES (?, ?)').run(logo.hash || '', username);
    return { row: byId.get(info.lastInsertRowid) };
  };

  // 640x640, the whole logo on white (the same treatment as the app icons: never cropped, never transparent).
  const render = (file) => sharp(fs.readFileSync(file), { limitInputPixels: 40000000 })
    .rotate()
    .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

  const finish = (id, status, detail) => db.prepare(
    "UPDATE trip_group_photo_requests SET status = ?, detail = ?, finished_at = datetime('now') WHERE id = ? AND status IN ('pending','sending')",
  ).run(status, detail, id);

  /** The newest pending request and its PNG, once; or null. One request is out at a time. */
  const claim = async () => {
    if (!featureOn(SWITCH)) return null;
    sweep();
    if (db.prepare("SELECT 1 FROM trip_group_photo_requests WHERE status = 'sending'").get()) return null;
    const row = db.prepare("SELECT * FROM trip_group_photo_requests WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get();
    if (!row) return null;
    const logo = effectiveLogo();
    if (!logo || !logo.file) { finish(row.id, 'no_logo', null); return null; }
    let png;
    try { png = await render(logo.file); } catch (error) {
      console.warn(`group photo: the logo could not be rendered (${error?.code || error?.name || 'error'})`);
      finish(row.id, 'failed', 'The logo file could not be read.');
      return null;
    }
    // render() was async: only the caller whose update lands owns the request.
    const taken = db.prepare(
      "UPDATE trip_group_photo_requests SET status = 'sending', claimed_at = datetime('now'), claims = claims + 1, logo_hash = ? WHERE id = ? AND status = 'pending'",
    ).run(logo.hash || row.logo_hash, row.id);
    if (taken.changes !== 1) return null;
    const claimed = byId.get(row.id);
    return {
      request: { id: claimed.id, attempt: claimed.claims, logo_hash: claimed.logo_hash, requested_at: iso(claimed.requested_at) },
      photo: { content_type: 'image/png', base64: png.toString('base64') },
    };
  };

  /** The control plane's answer. Returns { status: <http>, body }. */
  const report = (body) => {
    const id = body && body.request_id;
    const status = body && body.status;
    if (!Number.isInteger(id) || id < 1 || !REPORTABLE.has(status) || (body.detail !== undefined && body.detail !== null && typeof body.detail !== 'string')) {
      return { http: 400, body: { error: 'INVALID_REQUEST' } };
    }
    sweep();
    const row = byId.get(id);
    if (!row) return { http: 404, body: { error: 'NOT_FOUND' } };
    if (FINISHED.has(row.status)) {
      // Said twice (a re-report after a lost answer) is fine; a different word for a finished request is not.
      return row.status === status ? { http: 200, body: { ok: true } } : { http: 409, body: { error: 'ALREADY_FINISHED' } };
    }
    finish(id, status, cleanDetail(body.detail));
    return { http: 200, body: { ok: true } };
  };

  /**
   * @param {import('express').Express} app
   * @param {{organizerOrAgentRequired: Function, internal?: Function}} gates
   */
  function registerRoutes(app, { organizerOrAgentRequired, internal }) {
    // WHO may (401/403) is answered before WHETHER it is on (409), and both before anything is stored.
    const switchOn = (_req, res, next) => (featureOn(SWITCH) ? next() : res.status(409).json({ error: 'feature_off' }));
    const who = (req) => (req.user && typeof req.user.username === 'string' && req.user.username) || 'agent';

    app.post('/api/group-photo', organizerOrAgentRequired, switchOn, (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const made = request(who(req));
      if (made.refused) return res.status(422).json({ error: 'no_logo', status: 'no_logo', message: MESSAGES.no_logo });
      res.status(202).json(view(made.row));
    });

    app.get('/api/group-photo', organizerOrAgentRequired, switchOn, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      sweep();
      res.json(view(latest.get()));
    });

    // Mounted only behind the exchange-key gate; a caller that passes none gets no route, never an open one.
    if (typeof internal === 'function') {
      app.post('/api/internal/control-plane/group-photo/claim', internal, async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
          res.json((await claim()) || { request: null });
        } catch (error) {
          console.error(`group photo: claim failed (${error?.code || error?.name || 'error'})`);
          res.status(500).json({ error: 'CLAIM_FAILED' });
        }
      });
      app.post('/api/internal/control-plane/group-photo/result', internal, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const answer = report(req.body || {});
        res.status(answer.http).json(answer.body);
      });
    }
  }

  return { registerRoutes, request, claim, report, sweep, view: () => view(latest.get()) };
}

module.exports = { create, SWITCH, MESSAGES, PHOTO_SIZE, MAX_CLAIMS };
