const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const { OAuth2Client } = require('google-auth-library');
const { NEED_TYPES, NEED_SEVERITIES, VISIBILITIES, normalizeSeverity, normalizeVisibility } = require('../shared/needs-schema');
const { AGENT_TONES, AGENT_GENDERS, PROACTIVE_KEYS, publicAgent, normalizeInstructionVisibility, normalizeTone, normalizeGender, normalizeOrganizers } = require('../shared/agent-schema');

const app = express();
// Default (100kb) is too small for /api/bookings/extract, which the browser
// calls with a base64-encoded PDF as the JSON body — base64 alone inflates a
// file ~33%, so even a modest few-MB confirmation PDF blew this immediately.
// Every other route's payloads are trivially small, so one shared limit is
// fine — no route needs its own override.
app.use(express.json({ limit: '30mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const IMMICH_URL    = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const IMMICH_KEY    = process.env.IMMICH_API_KEY || '';
const JWT_SECRET    = process.env.JWT_SECRET || 'trip-dev-secret-change-me';
const HERMES_KEY    = process.env.HERMES_API_KEY || '';
// Optional shared onboarding password for a fresh DB's seeded users. Leave
// unset in production once Telegram/Google login is live — each participant
// then gets an independent random password instead of one shared, guessable
// default (see initData()).
const SEED_PASSWORD = process.env.SEED_PASSWORD || '';
const AGENT_USER    = { username: 'hermes', name: 'Hermes', family: 'system', isAgent: true };

// Optional: "Sign in with Google" as an alternate login method bound to an
// already-predefined user (see /api/auth/google-link). Unset → feature is
// simply absent; the site still works password-only.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Telegram Login is verified server-side and additionally bound to live
// membership in the configured trip group. No bot secret reaches the browser.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Mutable: Telegram gives a bot no way to create or discover a group on its
// own (confirmed against the Bot API docs — no such method exists), so the
// chat_id can't be known at deploy time the way the token/username can. See
// POST /api/agent/telegram-group, the one runtime writer of this value.
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_API_BASE_URL = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');
const TELEGRAM_AUTH_MAX_AGE_SECONDS = Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400);
// Public @handle only — never the token. Safe to serve pre-auth so the login
// screen knows which widget to render.
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const telegramEnabled = () => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
function verifyTelegramLogin(payload) {
  const { hash, ...fields } = payload || {};
  if (!hash || !fields.id || !fields.auth_date) return false;
  const now = Math.floor(Date.now() / 1000), authDate = Number(fields.auth_date);
  if (!Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > TELEGRAM_AUTH_MAX_AGE_SECONDS) return false;
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return hash.length === expected.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}
async function telegramChatMemberStatus(chatId, userId) {
  const url = `${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`;
  return fetch(url).then(r => r.json());
}
function isActiveMemberReply(reply) {
  const status = reply?.result?.status;
  return reply?.ok && ['creator', 'administrator', 'member', 'restricted'].includes(status) && !(status === 'restricted' && reply.result?.is_member === false);
}
async function telegramActiveMember(userId) {
  return isActiveMemberReply(await telegramChatMemberStatus(TELEGRAM_CHAT_ID, userId));
}
async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  return ticket.getPayload(); // { sub, email, ... }
}

const DATA_DIR    = process.env.DATA_DIR || '/app/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CONF_DIR    = path.join(DATA_DIR, 'confirmations');
// Not under DATA_DIR: nginx serves this directory as static content directly
// (docker-compose mounts ./site/avatars to /app/avatars here), so it has to
// live where the web server can reach it, not in the app's private data
// volume. Overridable so tests don't write into the real checked-out dir.
const AVATARS_DIR = process.env.AVATARS_DIR || path.join(__dirname, 'avatars');
// Where systemd's EnvironmentFile= points in production (one level above
// server/, alongside docker-compose.yml). Overridable so tests don't write
// into the real checked-out .env. The only value ever written back here is
// TELEGRAM_CHAT_ID (see POST /api/agent/telegram-group) — every other secret
// stays operator-set, deploy-time only.
const ENV_FILE = process.env.ENV_FILE_PATH || path.join(__dirname, '..', '.env');
function persistEnvVar(key, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* no .env yet — fine, we're creating it */ }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, line) : content.replace(/\n?$/, '\n') + line + '\n';
  fs.writeFileSync(ENV_FILE, content.replace(/^\n/, ''));
}
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');
const PHOTOS_FILE  = path.join(DATA_DIR, 'photos.json');
const DB_FILE      = path.join(DATA_DIR, 'trip.db');

[DATA_DIR, UPLOADS_DIR, CONF_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── TRIP CONFIG ───────────────────────────────────────────────────────────────
const TRIP_DIR = process.env.TRIP_DIR || path.join(__dirname, '..', 'trip');
let TRIP_CONFIG = {};
let TRIP_CONFIG_RAW = null;
try {
  TRIP_CONFIG_RAW = fs.readFileSync(path.join(TRIP_DIR, 'trip.config.json'), 'utf8');
  TRIP_CONFIG = JSON.parse(TRIP_CONFIG_RAW);
  console.log(`Loaded trip config: ${TRIP_CONFIG.meta?.title || '(untitled)'}`);
} catch (e) { console.error('trip.config.json not found:', e.message); }

// Diagnostic only — malformed needs entries are logged, never fatal, so a
// typo in one participant's config can't take the whole trip site down.
// Also collected into CONFIG_WARNINGS (exposed via GET /api/config/warnings)
// since console.warn alone goes to a log nobody reads on a family's hosted box.
// Note: warning objects deliberately omit `type` — GET /api/config/warnings
// is authRequired but not organizer-scoped, so a malformed medical/allergy
// need must not leak its category through this side door around the
// visibility rule below. `severity` alone doesn't identify the category.
const CONFIG_WARNINGS = [];
// Two audiences, two levels of detail. The server log is organizer-only by
// definition (you need shell on the box to read it), so it gets the offending
// value verbatim — that's what makes a typo findable. The API response does
// not: it is authRequired but NOT organizer-scoped, so every authed kid can
// read it. Echoing a bad type there would defeat the visibility rule below,
// since "medicl" identifies the category just as well as "medical" does.
const redact = (label, value, note) => ({
  log:  `${label} "${value}"${note ? ` ${note}` : ''}`,
  api:  `${label} (value withheld — check the server log)${note ? ` ${note}` : ''}`,
});
(TRIP_CONFIG.participants || []).forEach(p => {
  (p.needs || []).forEach(n => {
    const issues = [];
    if (!NEED_TYPES.includes(n.type)) issues.push(redact('unknown type', n.type));
    if (!NEED_SEVERITIES.includes(n.severity)) issues.push(redact('unknown severity', n.severity, '(treated as critical)'));
    if (n.visibility !== undefined && !VISIBILITIES.includes(n.visibility)) issues.push(redact('unknown visibility', n.visibility, '(treated as organizer-only)'));
    if (!n.text?.he || !n.text?.en) issues.push({ log: 'missing bilingual text', api: 'missing bilingual text' });
    for (const issue of issues) {
      console.warn(`trip.config.json: participant "${p.username}" need — ${issue.log}`);
      // Normalized, not raw. A valid severity is safe to return — it says how
      // urgent, never what category — but the raw field is whatever the config
      // author typed, and "crticial" is a config value like any other. The
      // invariant this endpoint holds is simply: no raw config values, ever.
      CONFIG_WARNINGS.push({ username: p.username, severity: normalizeSeverity(n.severity), issue: issue.api });
    }
  });
});

// Same diagnostic treatment for the `agent` block. Note what is deliberately
// NOT reported: the instruction text itself, and which instructions resolved
// to organizer-only. /api/config/warnings is authRequired but not
// organizer-scoped, so echoing either would route sensitive standing
// instructions straight around the visibility filter below. Index only.
(() => {
  const a = TRIP_CONFIG.agent;
  if (!a) return;
  const issues = [];
  if (!a.name) issues.push('missing name (the family has nothing to call the bot)');
  // Blanket rule, applied even to fields that look harmless: NO raw
  // trip.config.json value reaches this endpoint. Judging each field on its
  // merits is how the first three leaks happened — a "cosmetic" tone still
  // echoed a string an author chose, and the exemption list has to be
  // re-audited every time a field is added. One invariant is checkable at a
  // glance; five exceptions are not. The server log keeps every value.
  if (a.tone !== undefined && !AGENT_TONES.includes(a.tone)) issues.push(redact('unknown tone', a.tone, '(treated as warm)'));
  if (a.gender !== undefined && !AGENT_GENDERS.includes(a.gender)) issues.push(redact('unknown gender', a.gender, '(treated as neutral)'));
  for (const org of normalizeOrganizers(a)) {
    if (!(TRIP_CONFIG.participants || []).some(p => p.username === org)) {
      issues.push(redact('agent.organizer(s)', org, 'is not a known participant username'));
    }
  }
  for (const key of Object.keys(a.proactive || {})) {
    if (!PROACTIVE_KEYS.includes(key)) issues.push(redact('unknown proactive key', key, '(ignored)'));
  }
  // Standing instructions are the sensitive half — index and problem only,
  // never the text and never the resolved visibility.
  (a.standing_instructions || []).forEach((ins, i) => {
    if (ins.visibility !== undefined && !VISIBILITIES.includes(ins.visibility)) {
      issues.push(redact(`standing_instructions[${i}]: unknown visibility`, ins.visibility, '(treated as organizer-only)'));
    }
    if (!ins.text?.he || !ins.text?.en) {
      const m = `standing_instructions[${i}]: missing bilingual text`;
      issues.push({ log: m, api: m });
    }
  });
  for (const issue of issues) {
    console.warn(`trip.config.json: agent — ${issue.log}`);
    CONFIG_WARNINGS.push({ scope: 'agent', issue: issue.api });
  }
})();

// ── DATABASE INIT ─────────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    age      INTEGER,
    family   TEXT,
    color    TEXT,
    password TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ratings (
    venue    TEXT NOT NULL,
    username TEXT NOT NULL,
    stars    INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
    PRIMARY KEY (venue, username)
  );

  CREATE TABLE IF NOT EXISTS photos (
    id            TEXT PRIMARY KEY,
    filename      TEXT NOT NULL,
    original_name TEXT,
    phase         TEXT,
    caption       TEXT,
    username      TEXT NOT NULL,
    uploaded_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS venue_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    venue      TEXT NOT NULL,
    username   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rsvps (
    activity   TEXT NOT NULL,
    username   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK(status IN ('yes','no','maybe')),
    note       TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (activity, username)
  );

  CREATE TABLE IF NOT EXISTS photo_reactions (
    photo_id   TEXT NOT NULL,
    username   TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    PRIMARY KEY (photo_id, username, emoji)
  );

  CREATE TABLE IF NOT EXISTS photo_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id   TEXT NOT NULL,
    username   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS task_done (
    task_id TEXT PRIMARY KEY,
    done_by TEXT NOT NULL,
    done_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS lost_found (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT,
    item       TEXT NOT NULL,
    location   TEXT,
    resolved   INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS budget_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phase       TEXT NOT NULL,
    category    TEXT NOT NULL,
    description TEXT NOT NULL,
    amount      REAL NOT NULL DEFAULT 0,
    is_estimate INTEGER DEFAULT 0,
    seed_key    TEXT UNIQUE,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trivia_scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    name       TEXT NOT NULL,
    family     TEXT,
    rank       INTEGER,
    score      INTEGER,
    played_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    phase        TEXT NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('flight','hotel','car','attraction','other')),
    name         TEXT NOT NULL,
    date_from    TEXT,
    date_to      TEXT,
    passengers   TEXT,
    confirmation TEXT,
    pin          TEXT,
    notes        TEXT,
    cost         REAL DEFAULT 0,
    conf_file    TEXT,
    seed_key     TEXT UNIQUE,
    created_by   TEXT NOT NULL DEFAULT 'seed',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trip_config_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version    INTEGER NOT NULL UNIQUE,
    content    TEXT NOT NULL,
    hash       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── TRIP CONFIG VERSIONING ────────────────────────────────────────────────────
// Snapshots trip.config.json into trip_config_versions whenever its content
// changes from the last stored version. Runs once at boot; no write API for
// trip.config.json exists, so a boot-time diff against the last snapshot is
// the change-detection point. Retains every prior version for future diffing.
try {
  if (TRIP_CONFIG_RAW !== null) {
    const hash = crypto.createHash('sha256').update(TRIP_CONFIG_RAW).digest('hex');
    const latest = db.prepare('SELECT hash, version FROM trip_config_versions ORDER BY version DESC LIMIT 1').get();
    if (!latest || latest.hash !== hash) {
      const nextVersion = (latest?.version || 0) + 1;
      db.prepare('INSERT INTO trip_config_versions (version, content, hash) VALUES (?, ?, ?)')
        .run(nextVersion, TRIP_CONFIG_RAW, hash);
      console.log(`Stored trip config version ${nextVersion}`);
    }
  }
} catch (e) { console.error('trip config version snapshot failed:', e.message); }

// ── USER SEED DATA ────────────────────────────────────────────────────────────
const SEED_USERS = (TRIP_CONFIG.participants || []).map(p => ({
  username: p.username, name: p.name, name_en: p.name_en,
  telegram_id: p.telegram_id ? String(p.telegram_id) : null,
  age: p.age, family: p.family, color: p.color,
}));

// ── SCHEMA MIGRATIONS ─────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE photos ADD COLUMN immich_id TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN name_en TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN avatar_file TEXT'); } catch {}
try { db.exec('ALTER TABLE bookings ADD COLUMN apple_wallet_url TEXT'); } catch {}
try { db.exec('ALTER TABLE bookings ADD COLUMN google_wallet_url TEXT'); } catch {}
try { db.exec('ALTER TABLE bookings ADD COLUMN location_url TEXT'); } catch {}
try { db.exec('ALTER TABLE bookings ADD COLUMN pkpass_file TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN google_email TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN google_picture TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN telegram_id TEXT'); } catch {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL'); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS phase_plan_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id     TEXT NOT NULL,
  date         TEXT,
  time         TEXT,
  text_he      TEXT NOT NULL,
  text_en      TEXT,
  location_url TEXT,
  booking_id   INTEGER,
  status       TEXT DEFAULT 'confirmed',
  sort_order   REAL DEFAULT 0,
  created_by   TEXT NOT NULL DEFAULT 'agent',
  created_at   TEXT DEFAULT (datetime('now')),
  CHECK (status IN ('confirmed','needs_review'))
)`); } catch {}
// GET filters by phase_id on every page load and joinBooking() looks up
// booking_id per row; neither had an index.
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_phase   ON phase_plan_items(phase_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_booking ON phase_plan_items(booking_id)`); } catch {}
// Records which bookings the one-off import already consumed. Kept separate
// from phase_plan_items so that deleting an imported item is permanent —
// inferring "already imported" from a surviving row resurrected every deletion.
try { db.exec(`CREATE TABLE IF NOT EXISTS phase_plan_import_log (
  booking_id  INTEGER PRIMARY KEY,
  imported_at TEXT DEFAULT (datetime('now'))
)`); } catch {}
// Backfill name_en for any existing users that don't have it yet
for (const u of SEED_USERS) {
  db.prepare('UPDATE users SET name_en = ? WHERE username = ? AND (name_en IS NULL OR name_en = \'\')').run(u.name_en, u.username);
}
// Unlike name_en, telegram_id is synced from config on every boot, not just
// filled when blank — trip.config.json stays the live source of truth, since
// an organizer normally adds/corrects participants' Telegram IDs long after
// the DB already exists, not before first boot.
for (const u of SEED_USERS) {
  try {
    db.prepare('UPDATE users SET telegram_id = ? WHERE username = ?').run(u.telegram_id, u.username);
  } catch (e) {
    console.error(`Skipped telegram_id sync for ${u.username}: ${e.message}`);
  }
}

// Inserts one brand-new participant's row — used by POST /api/agent/participants
// to add someone to an already-running trip without a restart. Deliberately
// separate from the bulk boot-time seed path above: that path seeds a whole
// config's worth of users in one transaction with its own SEED_PASSWORD/
// random-password branching, and unifying it with a single-row insert risks
// the already-tested boot sequence for no real benefit — both just happen to
// write the same row shape, which is a schema fact, not shared logic.
function insertParticipantUser(p, passwordHash) {
  db.prepare(
    'INSERT INTO users (username, name, name_en, telegram_id, age, family, color, password) VALUES (?,?,?,?,?,?,?,?)'
  ).run(p.username, p.name, p.name_en || null, p.telegram_id || null, p.age ?? null, p.family || null, p.color || null, passwordHash);
}

// Writes the in-memory TRIP_CONFIG back to trip.config.json and snapshots it
// into trip_config_versions, same as boot-time versioning does. Shared by
// every runtime config mutation (add/bind/remove participant) so there's one
// place that defines what "persisting a config change" means.
function persistConfigChange() {
  TRIP_CONFIG_RAW = JSON.stringify(TRIP_CONFIG, null, 2);
  fs.writeFileSync(path.join(TRIP_DIR, 'trip.config.json'), TRIP_CONFIG_RAW);
  try {
    const hash = crypto.createHash('sha256').update(TRIP_CONFIG_RAW).digest('hex');
    const latest = db.prepare('SELECT version FROM trip_config_versions ORDER BY version DESC LIMIT 1').get();
    const nextVersion = (latest?.version || 0) + 1;
    db.prepare('INSERT INTO trip_config_versions (version, content, hash) VALUES (?, ?, ?)').run(nextVersion, TRIP_CONFIG_RAW, hash);
  } catch (e) { console.error('trip config version snapshot failed:', e.message); }
}

// ── STARTUP MIGRATION ─────────────────────────────────────────────────────────
async function initData() {
  // Seed users from JSON (or fresh seed)
  const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (userCount === 0) {
    const existing = (() => {
      try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return null; }
    })();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO users (username, name, name_en, telegram_id, age, family, color, password) VALUES (?,?,?,?,?,?,?,?)'
    );
    if (existing && existing.length > 0) {
      console.log('Migrating users from users.json…');
      const seedMap = Object.fromEntries(SEED_USERS.map(u => [u.username, u.name_en]));
      const tx = db.transaction(() => {
        for (const u of existing) insert.run(u.username, u.name, seedMap[u.username] || null, null, u.age, u.family, u.color, u.password);
      });
      tx();
    } else if (SEED_PASSWORD) {
      // Operator-chosen shared onboarding password (e.g. local/dev, or a
      // trip where password login is still the plan for some participants).
      // Never a hardcoded, source-visible default — deployments must opt in.
      console.log('Seeding users with the configured SEED_PASSWORD — change it from the avatar screen…');
      const hash = await bcrypt.hash(SEED_PASSWORD, 10);
      const tx = db.transaction(() => {
        for (const u of SEED_USERS) insert.run(u.username, u.name, u.name_en, u.telegram_id, u.age, u.family, u.color, hash);
      });
      tx();
    } else {
      // No shared secret to leak or guess: each participant gets an
      // independent, unrecoverable random password. Password login is
      // effectively unavailable until a participant signs in another way
      // (Telegram/Google) and sets their own via PUT /api/auth/password.
      console.log('SEED_PASSWORD not set — seeding users with independent random passwords (password login is unavailable until each participant signs in via Telegram/Google and sets their own).');
      const hashes = {};
      for (const u of SEED_USERS) hashes[u.username] = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      const tx = db.transaction(() => {
        for (const u of SEED_USERS) insert.run(u.username, u.name, u.name_en, u.telegram_id, u.age, u.family, u.color, hashes[u.username]);
      });
      tx();
    }
    console.log('Users ready.');
  }

  // Migrate ratings from JSON
  const ratingCount = db.prepare('SELECT COUNT(*) as n FROM ratings').get().n;
  if (ratingCount === 0) {
    try {
      const data = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
      const insert = db.prepare('INSERT OR IGNORE INTO ratings (venue, username, stars) VALUES (?,?,?)');
      const tx = db.transaction(() => {
        for (const [venue, userMap] of Object.entries(data)) {
          for (const [username, stars] of Object.entries(userMap)) {
            insert.run(venue, username, parseInt(stars));
          }
        }
      });
      tx();
      console.log('Ratings migrated from JSON.');
    } catch { /* no ratings file yet */ }
  }

  // Seed budget items (idempotent via seed_key UNIQUE)
  const BUDGET_SEEDS = TRIP_CONFIG.budget?.seed_items || [];
  const budgetInsert = db.prepare(
    'INSERT OR IGNORE INTO budget_items (phase,category,description,amount,is_estimate,seed_key) VALUES (?,?,?,?,?,?)'
  );
  db.transaction(() => {
    for (const s of BUDGET_SEEDS) budgetInsert.run(s.phase, s.category, s.description, s.amount, s.is_estimate ? 1 : 0, s.seed_key);
  })();
  // Fix car record if it was seeded with old prorated amount
  db.prepare("UPDATE budget_items SET amount=804, description='Budget Ford Explorer DEN · 12–18/7 · רכב A+B' WHERE seed_key='co_car_budget' AND amount=331").run();

  // Migrate photos from JSON
  const photoCount = db.prepare('SELECT COUNT(*) as n FROM photos').get().n;
  if (photoCount === 0) {
    try {
      const data = JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8'));
      const insert = db.prepare(
        'INSERT OR IGNORE INTO photos (id, filename, original_name, phase, caption, username, uploaded_at) VALUES (?,?,?,?,?,?,?)'
      );
      const tx = db.transaction(() => {
        for (const p of data) {
          insert.run(p.id, p.filename, p.originalName || '', p.phase || 'general', p.caption || '', p.username, p.uploadedAt || new Date().toISOString());
        }
      });
      tx();
      console.log('Photos migrated from JSON.');
    } catch { /* no photos file yet */ }
  }

  // Seed bookings (idempotent via seed_key UNIQUE)
  try {
    const bookingSeeds = JSON.parse(fs.readFileSync(path.join(TRIP_DIR, 'bookings.json'), 'utf8'));
    const bookingInsert = db.prepare(
      'INSERT OR IGNORE INTO bookings (phase,type,name,date_from,date_to,passengers,confirmation,pin,notes,cost,conf_file,seed_key,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    db.transaction(() => {
      for (const b of bookingSeeds) {
        bookingInsert.run(b.phase, b.type, b.name, b.date_from || null, b.date_to || null,
          b.passengers || null, b.confirmation || null, b.pin || null,
          b.notes || null, b.cost || 0, b.conf_file || null, b.seed_key, 'seed');
      }
    })();
    console.log('Bookings seeded.');
  } catch (e) { console.error('Bookings seed failed:', e.message); }
}

initData().catch(console.error);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getUser(username) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return null;
  const { password: _p, ...safe } = u;
  return safe;
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  // API key path — for the hermes agent (non-user service account)
  const apiKey = req.headers['x-api-key'];
  if (HERMES_KEY && apiKey === HERMES_KEY) {
    req.user = AGENT_USER;
    return next();
  }

  // JWT path — for family member browser sessions
  const header = req.headers.authorization || '';
  // Allow token in ?_t= for SSE (EventSource can't set headers)
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query._t || null);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    immich: !!(IMMICH_URL && IMMICH_KEY),
    googleClientId: GOOGLE_CLIENT_ID || null,
    telegramBotUsername: telegramEnabled() ? (TELEGRAM_BOT_USERNAME || null) : null,
    telegramGroupBound: Boolean(TELEGRAM_CHAT_ID),
  });
});

// ── TRIP CONFIG ───────────────────────────────────────────────────────────────
// Strip PIN codes, organizer-only needs, and organizer-only agent standing
// instructions before serving to clients — every family member is authed,
// including kids and one-off guests, so auth alone isn't a safety boundary for
// any of these fields. Shared by /api/config and /api/config/versions/:version.
function sanitizeConfig(cfg) {
  const safe = JSON.parse(JSON.stringify(cfg));
  if (safe.phases) safe.phases.forEach(p => {
    if (p.accommodation) delete p.accommodation.pin;
    (p.hotels || []).forEach(h => delete h.pin);
  });
  if (safe.bookings?.hotels) safe.bookings.hotels.forEach(h => delete h.pin);
  if (safe.participants) safe.participants.forEach(p => {
    // Identity links are server-side authentication material, never trip UI data.
    delete p.telegram_id;
    delete p.pin;
    if (p.needs) {
      p.needs = p.needs
        .filter(n => normalizeVisibility(n.visibility, n.type) !== 'organizer')
        .map(n => ({ ...n, severity: normalizeSeverity(n.severity) }));
      // An empty array is itself a disclosure: a participant with no `needs`
      // key looks different from one whose needs were all filtered out, which
      // tells an unauthenticated reader exactly who has something hidden.
      if (!p.needs.length) delete p.needs;
    }
  });
  if (safe.agent) safe.agent = publicAgent(safe.agent);
  return safe;
}

app.get('/api/config', authRequired, (_req, res) => {
  const safe = sanitizeConfig(TRIP_CONFIG);
  safe.trivia_available = TRIVIA_QUESTIONS.length > 0;
  res.json(safe);
});

// Deliberately public and deliberately minimal: the login screen needs to
// show a "pick yourself" roster before any session exists, but the full
// /api/config now carries real trip content (itinerary, budget, bookings,
// needs) that shouldn't be world-readable. Hand-picking these four fields
// here — rather than reusing sanitizeConfig() — keeps the public surface
// obvious at a glance instead of depending on a general-purpose sanitizer
// that could grow more fields later.
app.get('/api/config/roster', (_req, res) => {
  const roster = (TRIP_CONFIG.participants || []).map(p => ({
    username: p.username,
    name: p.name,
    name_en: p.name_en,
    color: p.color,
  }));
  res.json({ participants: roster });
});

// Stage 1 groundwork: read-only access to stored config history for a future
// diff view. Content is scrubbed the same way as /api/config; authRequired
// here is defense-in-depth, not the safety boundary.
app.get('/api/config/versions', authRequired, (_req, res) => {
  const rows = db.prepare('SELECT version, created_at, hash FROM trip_config_versions ORDER BY version DESC').all();
  res.json(rows);
});

// Organizer-facing: config validation issues (malformed needs, etc.) that
// only ever went to a server log otherwise. Same authRequired posture as
// /api/config/versions — not organizer-scoped yet, but no longer silent.
app.get('/api/config/warnings', authRequired, (_req, res) => {
  res.json(CONFIG_WARNINGS);
});

// ── AGENT BRIEF ───────────────────────────────────────────────────────────────
// The counterpart to sanitizeConfig(): everything the read path deliberately
// withholds, served to the two principals actually entitled to it.
//
// authRequired is not enough here — it admits every family member including
// kids, which is exactly who organizer-only content is being kept from. This
// middleware narrows to:
//   • the agent service account (X-API-Key), so the companion bot can read the
//     standing instructions it was given; and
//   • the organizer's own browser session, which until now had no read path to
//     organizer-only needs at all — they were stored and visible to nobody.
function organizerOrAgentRequired(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (HERMES_KEY && apiKey === HERMES_KEY) { req.user = AGENT_USER; return next(); }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query._t || null);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'invalid_token' }); }

  const organizers = normalizeOrganizers(TRIP_CONFIG.agent);
  // No configured organizer means nobody qualifies. Failing closed here matters
  // more than convenience: the alternative — treating "unset" as "everyone" —
  // would silently publish every organizer-only note the moment a trip is
  // scaffolded without an agent block.
  if (!organizers.length || !organizers.includes(payload.username)) return res.status(403).json({ error: 'organizer_only' });
  req.user = { username: payload.username };
  next();
}

app.get('/api/agent/brief', organizerOrAgentRequired, (_req, res) => {
  const agent = TRIP_CONFIG.agent || null;
  const instructions = (agent?.standing_instructions || []).map((ins, i) => ({
    index: i,
    visibility: normalizeInstructionVisibility(ins.visibility),
    text: ins.text,
  }));
  // Needs are folded in because they answer the same question the standing
  // instructions do — "what should the bot keep in mind about these people" —
  // and splitting them across two calls invites reading one and not the other.
  const needs = [];
  for (const p of TRIP_CONFIG.participants || []) {
    for (const n of p.needs || []) {
      needs.push({
        username: p.username,
        name: p.name_en || p.name || p.username,
        type: n.type,
        severity: normalizeSeverity(n.severity),
        visibility: normalizeVisibility(n.visibility, n.type),
        text: n.text,
      });
    }
  }
  res.json({
    trip: TRIP_CONFIG.meta?.title || null,
    organizers: normalizeOrganizers(agent),
    persona: agent ? {
      name: agent.name, name_en: agent.name_en,
      gender: normalizeGender(agent.gender), tone: normalizeTone(agent.tone),
      default_language: agent.default_language || TRIP_CONFIG.meta?.defaultLang || 'he',
      timezone: agent.timezone || null,
      proactive: agent.proactive || {},
    } : null,
    standing_instructions: instructions,
    needs,
    // Spelled out in the payload rather than left to documentation, because the
    // consumer is a language model that may only ever see this response.
    disclosure_policy: {
      group: 'Items with visibility "group" may be referred to in the family group chat.',
      organizer: 'Items with visibility "organizer" are for your understanding only. Act on them — adjust plans, avoid topics, flag risks — but never state them, quote them, or allude to their existence in the group. Discuss them only in the private channel with the organizer.',
    },
  });
});

// Single-use, short-lived tokens for participant self-enrollment (the
// password-only path below). Mirrors mcp/provision.js's activation-token
// pattern: in-memory, spent on first use, time-limited.
const pendingEnrollments = new Map();
const ENROLLMENT_TTL_MS = 30 * 60 * 1000;

// The only runtime writer of trip.config.json in this codebase — kept
// deliberately narrow (append one participant, touch nothing else) rather
// than a general config-PUT. Telegram-bound (telegram_id given): login works
// immediately through the widget, gated on live group membership like any
// other Telegram-linked participant. Password-only (telegram_id omitted):
// returns a one-time enrollment token for the organizer to relay — the
// participant sets their own password via POST /api/auth/enroll, it is never
// collected here or in chat.
app.post('/api/agent/participants', organizerOrAgentRequired, async (req, res) => {
  const { username, name, name_en, color, family, telegram_id } = req.body || {};
  if (!username || !name) return res.status(400).json({ error: 'missing_fields' });
  const uname = String(username).toLowerCase().trim();
  if (!/^[a-z0-9_-]+$/.test(uname)) return res.status(400).json({ error: 'invalid_username' });

  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
    return res.status(409).json({ error: 'username_taken' });
  }
  const tgId = telegram_id ? String(telegram_id) : null;
  if (tgId && db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(tgId)) {
    return res.status(409).json({ error: 'telegram_id_taken' });
  }

  const participant = { username: uname, name, name_en: name_en || null, color: color || null, family: family || null, telegram_id: tgId };

  TRIP_CONFIG.participants = TRIP_CONFIG.participants || [];
  TRIP_CONFIG.participants.push(participant);
  persistConfigChange();

  // Independent random, effectively-unusable password unless SEED_PASSWORD is
  // explicitly configured — same posture as every other seeded user. The
  // password-only path immediately overwrites this via the enrollment token.
  const passwordHash = await bcrypt.hash(SEED_PASSWORD || crypto.randomBytes(24).toString('hex'), 10);
  try {
    insertParticipantUser(participant, passwordHash);
  } catch (e) {
    return res.status(500).json({ error: 'user_insert_failed', detail: e.message });
  }

  if (tgId) return res.json({ ok: true, username: uname, telegram_bound: true });

  const token = crypto.randomBytes(24).toString('hex');
  pendingEnrollments.set(token, { username: uname, at: Date.now() });
  res.json({
    ok: true, username: uname, telegram_bound: false,
    enrollment_token: token, expires_in_seconds: ENROLLMENT_TTL_MS / 1000,
  });
});

// Lets an organizer trigger a password reset for an EXISTING participant —
// Telegram-bound or not, since a Telegram-linked participant may still want
// a working password fallback. Mints a fresh one-time enrollment token on
// the same terms as a brand-new participant; redeemed the same way, through
// POST /api/auth/enroll. Does not touch trip.config.json or re-seed the
// user — the row already exists, only its password needs to change.
app.post('/api/agent/participants/:username/reset-password', organizerOrAgentRequired, (req, res) => {
  const uname = String(req.params.username).toLowerCase().trim();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
    return res.status(404).json({ error: 'user_not_found' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  pendingEnrollments.set(token, { username: uname, at: Date.now() });
  res.json({ ok: true, username: uname, enrollment_token: token, expires_in_seconds: ENROLLMENT_TTL_MS / 1000 });
});

// Binds a Telegram identity to an EXISTING participant — e.g. "bind @dror to
// dror": the organizer already knows which site username maps to which
// Telegram account, this just records it. Unlike POST /api/agent/participants,
// this never creates a participant or touches a password.
app.patch('/api/agent/participants/:username/telegram', organizerOrAgentRequired, (req, res) => {
  const uname = String(req.params.username).toLowerCase().trim();
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'missing_telegram_id' });
  const tgId = String(telegram_id);

  const participant = (TRIP_CONFIG.participants || []).find(p => p.username === uname);
  if (!participant || !db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
    return res.status(404).json({ error: 'user_not_found' });
  }
  const conflict = db.prepare('SELECT username FROM users WHERE telegram_id = ? AND username != ?').get(tgId, uname);
  if (conflict) return res.status(409).json({ error: 'telegram_id_taken' });

  participant.telegram_id = tgId;
  persistConfigChange();
  db.prepare('UPDATE users SET telegram_id = ? WHERE username = ?').run(tgId, uname);

  res.json({ ok: true, username: uname, telegram_id: tgId });
});

// Removes a participant from the trip: drops them from trip.config.json and
// revokes DB-level access (clears telegram_id, replaces the password with a
// fresh unusable random hash) rather than deleting the users row outright —
// photos/bookings/ratings reference the username by text, and a hard delete
// would orphan that history. Blocks removing a currently-configured
// organizer; that's a deliberate, separate decision, not something that
// should fall out of a generic remove call.
app.delete('/api/agent/participants/:username', organizerOrAgentRequired, async (req, res) => {
  const uname = String(req.params.username).toLowerCase().trim();
  const idx = (TRIP_CONFIG.participants || []).findIndex(p => p.username === uname);
  if (idx === -1) return res.status(404).json({ error: 'user_not_found' });

  if (normalizeOrganizers(TRIP_CONFIG.agent).includes(uname)) {
    return res.status(409).json({ error: 'cannot_remove_organizer' });
  }

  TRIP_CONFIG.participants.splice(idx, 1);
  persistConfigChange();

  const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  db.prepare('UPDATE users SET telegram_id = NULL, password = ? WHERE username = ?').run(randomPasswordHash, uname);

  res.json({
    ok: true, username: uname,
    // Surfaced in the response, not just a comment — the caller (agent or
    // organizer) should know this doesn't yank an already-open session.
    note: 'Future logins are revoked. An already-issued session token (valid up to 30 days) is not invalidated — this app has no session-revocation mechanism yet.',
  });
});

// Binds the trip's Telegram group once it exists. TELEGRAM_BOT_TOKEN/
// USERNAME are deployment-time secrets, set once and never touched here —
// TELEGRAM_CHAT_ID is the one piece that genuinely can't be known ahead of
// time (a bot can't create or discover a group on its own; there's no
// username→group lookup either), so this is the only runtime write into
// the deployment's .env this codebase has. Everything else stays in
// trip.config.json, which sanitizeConfig() already guards from ever being
// served raw — .env was the deliberate choice to keep this value out of
// that path entirely, consistent with how the other TELEGRAM_* values
// already live in .env rather than the config file.
//
// The caller only ever proves it holds the flat agent key or an organizer
// JWT, never which human actually typed the chat_id — same caveat as every
// other /api/agent/* route. What this route adds on top: it verifies, live
// via getChatMember, that a Telegram-bound organizer is really an active
// member of the given chat before trusting it, so a wrong or made-up
// chat_id can't silently become "the trip group."
app.post('/api/agent/telegram-group', organizerOrAgentRequired, async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(409).json({ error: 'telegram_bot_not_configured' });
  const chatId = String((req.body || {}).chat_id ?? '').trim();
  if (!/^-\d+$/.test(chatId)) return res.status(400).json({ error: 'invalid_chat_id' });

  const organizers = normalizeOrganizers(TRIP_CONFIG.agent);
  const boundOrganizer = (TRIP_CONFIG.participants || []).find(p => organizers.includes(p.username) && p.telegram_id);
  if (!boundOrganizer) return res.status(409).json({ error: 'no_telegram_bound_organizer' });

  let reply;
  try {
    reply = await telegramChatMemberStatus(chatId, boundOrganizer.telegram_id);
  } catch (e) {
    return res.status(502).json({ error: 'telegram_api_unreachable', detail: e.message });
  }
  if (!isActiveMemberReply(reply)) {
    return res.status(422).json({ error: 'organizer_not_member_of_chat', detail: reply?.description || reply?.result?.status || null });
  }

  TELEGRAM_CHAT_ID = chatId;
  persistEnvVar('TELEGRAM_CHAT_ID', chatId);

  res.json({ ok: true, chat_id: chatId, chat_title: (req.body || {}).chat_title || null, telegram_enabled: telegramEnabled() });
});

// Redeems a one-time enrollment token minted by POST /api/agent/participants
// or POST /api/agent/participants/:username/reset-password — the only way a
// password-only participant (or one whose password was just reset) gets a
// real password. No prior session required; the token itself is the
// (already organizer-issued) authorization.
app.post('/api/auth/enroll', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'missing_fields' });
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });

  const pending = pendingEnrollments.get(token);
  if (!pending) return res.status(404).json({ error: 'invalid_or_used_token' });
  pendingEnrollments.delete(token);
  if (Date.now() - pending.at > ENROLLMENT_TTL_MS) return res.status(410).json({ error: 'token_expired' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE username = ?').run(hash, pending.username);
  res.json({ ok: true, username: pending.username });
});

app.get('/api/config/versions/:version', authRequired, (req, res) => {
  const row = db.prepare('SELECT version, content, hash, created_at FROM trip_config_versions WHERE version = ?').get(req.params.version);
  if (!row) return res.status(404).json({ error: 'version not found' });
  let content;
  try { content = sanitizeConfig(JSON.parse(row.content)); } catch { return res.status(500).json({ error: 'stored version is not valid JSON' }); }
  res.json({ version: row.version, created_at: row.created_at, hash: row.hash, content });
});

app.get('/api/trip/logo', (_req, res) => {
  const logoFile = TRIP_CONFIG.meta?.logo;
  if (!logoFile) return res.status(404).end();
  const logoPath = path.join(TRIP_DIR, logoFile);
  if (!fs.existsSync(logoPath)) return res.status(404).end();
  res.sendFile(logoPath);
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'wrong_credentials' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'wrong_credentials' });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _p, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// Telegram identity is accepted only after both cryptographic verification and
// a live membership check. A known participant is linked by telegram_id.
app.post('/api/auth/telegram-login', async (req, res) => {
  if (!telegramEnabled()) return res.status(503).json({ error: 'telegram_not_configured' });
  if (!verifyTelegramLogin(req.body)) return res.status(401).json({ error: 'invalid_telegram_login' });
  try {
    if (!await telegramActiveMember(req.body.id)) return res.status(403).json({ error: 'not_group_member' });
  } catch { return res.status(502).json({ error: 'telegram_membership_check_failed' }); }
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(req.body.id));
  if (!user) return res.status(403).json({ error: 'telegram_account_not_linked' });
  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _p, telegram_id: _tid, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const user = getUser(req.user.username);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const organizers = normalizeOrganizers(TRIP_CONFIG.agent);
  res.json({ ...user, is_organizer: organizers.includes(user.username) });
});

app.put('/api/auth/avatar', authRequired, (req, res) => {
  const { avatar_file } = req.body || {};
  if (!avatar_file) return res.status(400).json({ error: 'missing' });
  db.prepare('UPDATE users SET avatar_file = ? WHERE username = ?').run(avatar_file, req.user.username);
  res.json({ ok: true });
});

// Clears the explicit avatar_file choice — falls back to the connected Google
// picture (if any) or the {Username}.png convention, same as a brand-new user.
app.delete('/api/auth/avatar', authRequired, (req, res) => {
  db.prepare('UPDATE users SET avatar_file = NULL WHERE username = ?').run(req.user.username);
  res.json({ ok: true });
});

app.put('/api/auth/password', authRequired, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'password_too_short' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE username = ?').run(hash, req.user.username);
  res.json({ ok: true });
});

// ── GOOGLE SIGN-IN (bind to an already-predefined user) ───────────────────────
// This never creates accounts — it only links a Google identity onto a
// username the trip admin already seeded in trip.config.json.
app.put('/api/auth/google-link', authRequired, async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'google_not_configured' });
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'missing_id_token' });

  let payload;
  try { payload = await verifyGoogleToken(idToken); }
  catch (e) { return res.status(401).json({ error: 'invalid_id_token' }); }

  const taken = db.prepare('SELECT username FROM users WHERE google_sub = ? AND username != ?')
    .get(payload.sub, req.user.username);
  if (taken) return res.status(409).json({ error: 'already_linked' });

  db.prepare('UPDATE users SET google_sub = ?, google_email = ?, google_picture = ? WHERE username = ?')
    .run(payload.sub, payload.email || null, payload.picture || null, req.user.username);
  res.json({ ok: true, google_email: payload.email || null, google_picture: payload.picture || null });
});

app.delete('/api/auth/google-link', authRequired, (req, res) => {
  db.prepare('UPDATE users SET google_sub = NULL, google_email = NULL, google_picture = NULL WHERE username = ?').run(req.user.username);
  res.json({ ok: true });
});

app.post('/api/auth/google-login', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'google_not_configured' });
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'missing_id_token' });

  let payload;
  try { payload = await verifyGoogleToken(idToken); }
  catch (e) { return res.status(401).json({ error: 'invalid_id_token' }); }

  const user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(payload.sub);
  if (!user) return res.status(404).json({ error: 'not_linked' });

  // Refresh the cached picture URL — Google's URLs can rotate over time.
  if (payload.picture && payload.picture !== user.google_picture) {
    db.prepare('UPDATE users SET google_picture = ? WHERE username = ?').run(payload.picture, user.username);
    user.google_picture = payload.picture;
  }

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _p, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});
try { fs.mkdirSync(path.join(AVATARS_DIR, 'FullPhoto'), { recursive: true }); } catch {}

app.post('/api/auth/avatar/upload', authRequired,
  avatarUpload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'fullPhoto', maxCount: 1 }]),
  (req, res) => {
    const avatarFile    = req.files?.avatar?.[0];
    const fullPhotoFile = req.files?.fullPhoto?.[0];
    if (!avatarFile) return res.status(400).json({ error: 'no_file' });

    // req.user.isAgent is only ever true on the X-API-Key path (see
    // authRequired) — a family member's JWT never carries it, so this can't
    // drift into a checkable-later permission flag. That's what makes the
    // `username` override structurally impossible for a JWT caller, not just
    // disallowed by convention.
    let u;
    if (req.user.isAgent && req.body.username) {
      u = req.body.username.toLowerCase();
      if (!getUser(u)) return res.status(400).json({ error: 'unknown_username' });
    } else {
      u = req.user.username.toLowerCase();
    }
    const cap = u.charAt(0).toUpperCase() + u.slice(1);

    let allFiles = [];
    try { allFiles = fs.readdirSync(AVATARS_DIR); } catch {}

    let newName;
    if (!allFiles.includes(`${cap}.png`)) {
      newName = `${cap}.png`;
    } else {
      let n = 2;
      while (allFiles.includes(`${cap}${n}.png`)) n++;
      newName = `${cap}${n}.png`;
    }

    try {
      fs.writeFileSync(path.join(AVATARS_DIR, newName), avatarFile.buffer);
      fs.writeFileSync(path.join(AVATARS_DIR, 'FullPhoto', newName), (fullPhotoFile || avatarFile).buffer);
    } catch (e) {
      console.error('Avatar write failed:', e.message);
      return res.status(500).json({ error: 'write_failed' });
    }

    db.prepare('UPDATE users SET avatar_file = ? WHERE username = ?').run(newName, u);
    res.json({ ok: true, avatar_file: newName });
  }
);

// ── RATINGS ───────────────────────────────────────────────────────────────────
app.get('/api/ratings', (_req, res) => {
  const rows = db.prepare('SELECT venue, username, stars FROM ratings').all();
  const result = {};
  for (const r of rows) {
    if (!result[r.venue]) result[r.venue] = {};
    result[r.venue][r.username] = r.stars;
  }
  res.json(result);
});

app.post('/api/ratings', authRequired, (req, res) => {
  const { venue, rating } = req.body || {};
  if (!venue || !rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'invalid' });
  db.prepare('INSERT OR REPLACE INTO ratings (venue, username, stars) VALUES (?,?,?)').run(venue, req.user.username, parseInt(rating));
  res.json({ ok: true });
});

// ── PHOTOS ────────────────────────────────────────────────────────────────────
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/photos/upload', authRequired, photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const { phase, caption } = req.body || {};
  const now = new Date().toISOString();

  const id = Date.now().toString();
  db.prepare(
    'INSERT INTO photos (id, filename, original_name, phase, caption, username, uploaded_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, req.file.filename, req.file.originalname, phase || 'general', caption || '', req.user.username, now);

  const safeUser = getUser(req.user.username) || { username: req.user.username };
  res.json({ ok: true, photo: { id, filename: req.file.filename, originalName: req.file.originalname, phase: phase || 'general', caption: caption || '', username: req.user.username, uploadedAt: now, user: safeUser } });

  // Push to Immich in background (non-blocking)
  if (IMMICH_URL && IMMICH_KEY) {
    (async () => {
      try {
        const form = new FormData();
        form.append('assetData', fs.createReadStream(req.file.path), {
          filename: req.file.originalname,
          contentType: req.file.mimetype,
          knownLength: req.file.size,
        });
        form.append('deviceAssetId', `${req.file.originalname}-${id}`);
        form.append('deviceId', 'trip-website');
        form.append('fileCreatedAt', now);
        form.append('fileModifiedAt', now);

        const r = await fetch(`${IMMICH_URL}/api/assets`, {
          method: 'POST',
          headers: { 'x-api-key': IMMICH_KEY, ...form.getHeaders() },
          body: form,
        });
        const data = await r.json();
        if (data.id) {
          db.prepare('UPDATE photos SET immich_id = ? WHERE id = ?').run(data.id, id);
          if (phase) {
            const albumId = await getOrCreateAlbum(phase).catch(() => null);
            if (albumId) {
              await fetch(`${IMMICH_URL}/api/albums/${albumId}/assets`, {
                method: 'PUT',
                headers: { 'x-api-key': IMMICH_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [data.id] }),
              }).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error('Immich background upload failed:', e.message);
      }
    })();
  }
});

app.get('/api/photos', (req, res) => {
  const { phase } = req.query;
  const rows = phase
    ? db.prepare('SELECT * FROM photos WHERE phase = ? ORDER BY uploaded_at DESC').all(phase)
    : db.prepare('SELECT * FROM photos ORDER BY uploaded_at DESC').all();

  const photos = rows.map(p => ({
    id: p.id,
    filename: p.filename,
    originalName: p.original_name,
    phase: p.phase,
    caption: p.caption,
    username: p.username,
    uploadedAt: p.uploaded_at,
    user: getUser(p.username) || { username: p.username },
  }));
  res.json(photos);
});

app.get('/api/photos/file/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
  res.sendFile(filePath);
});

app.delete('/api/photos/:id', authRequired, async (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'not_found' });
  if (photo.username !== req.user.username && !req.user.isAgent) return res.status(403).json({ error: 'forbidden' });

  // Delete from Immich
  if (photo.immich_id && IMMICH_URL && IMMICH_KEY) {
    try {
      await fetch(`${IMMICH_URL}/api/assets`, {
        method: 'DELETE',
        headers: { 'x-api-key': IMMICH_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [photo.immich_id], force: true }),
      });
    } catch (e) { console.error('Immich delete failed:', e.message); }
  }

  // Delete file from disk
  try { fs.unlinkSync(path.join(UPLOADS_DIR, photo.filename)); } catch {}

  // Delete DB records (photo + reactions + comments)
  db.transaction(() => {
    db.prepare('DELETE FROM photo_reactions WHERE photo_id = ?').run(photo.id);
    db.prepare('DELETE FROM photo_comments WHERE photo_id = ?').run(photo.id);
    db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  })();

  res.json({ ok: true });
});

// ── VENUE COMMENTS ────────────────────────────────────────────────────────────
app.get('/api/comments/venue/:venueId', (req, res) => {
  const rows = db.prepare('SELECT * FROM venue_comments WHERE venue = ? ORDER BY created_at ASC').all(req.params.venueId);
  const comments = rows.map(c => ({ ...c, user: getUser(c.username) || { username: c.username } }));
  res.json(comments);
});

app.post('/api/comments/venue/:venueId', authRequired, (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'empty_body' });
  const result = db.prepare(
    "INSERT INTO venue_comments (venue, username, body, created_at) VALUES (?,?,?,datetime('now'))"
  ).run(req.params.venueId, req.user.username, body.trim());
  const row = db.prepare('SELECT * FROM venue_comments WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...row, user: getUser(req.user.username) });
});

app.delete('/api/comments/venue/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM venue_comments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.username !== req.user.username) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM venue_comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── RSVPs ─────────────────────────────────────────────────────────────────────
app.get('/api/rsvps/:activityId', (req, res) => {
  const rows = db.prepare('SELECT * FROM rsvps WHERE activity = ?').all(req.params.activityId);
  const rsvps = rows.map(r => ({ ...r, user: getUser(r.username) || { username: r.username } }));
  res.json(rsvps);
});

app.post('/api/rsvps/:activityId', authRequired, (req, res) => {
  const { status, note } = req.body || {};
  if (!['yes', 'no', 'maybe'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  db.prepare(
    "INSERT OR REPLACE INTO rsvps (activity, username, status, note, updated_at) VALUES (?,?,?,?,datetime('now'))"
  ).run(req.params.activityId, req.user.username, status, note || null);
  res.json({ ok: true });
});

// ── PHOTO REACTIONS ───────────────────────────────────────────────────────────
// Bulk fetch — all reactions for all photos (or filtered by comma-separated IDs)
app.get('/api/reactions', (req, res) => {
  const rows = db.prepare('SELECT * FROM photo_reactions').all();
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.photo_id]) grouped[r.photo_id] = {};
    if (!grouped[r.photo_id][r.emoji]) grouped[r.photo_id][r.emoji] = [];
    grouped[r.photo_id][r.emoji].push(r.username);
  }
  res.json(grouped);
});

app.get('/api/reactions/:photoId', (req, res) => {
  const rows = db.prepare('SELECT * FROM photo_reactions WHERE photo_id = ?').all(req.params.photoId);
  // Group by emoji: { '❤️': [{ username, user }], ... }
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.emoji]) grouped[r.emoji] = [];
    grouped[r.emoji].push({ username: r.username, user: getUser(r.username) || { username: r.username } });
  }
  res.json(grouped);
});

app.post('/api/reactions/:photoId', authRequired, (req, res) => {
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: 'no_emoji' });
  const existing = db.prepare('SELECT 1 FROM photo_reactions WHERE photo_id = ? AND username = ? AND emoji = ?').get(req.params.photoId, req.user.username, emoji);
  if (existing) {
    db.prepare('DELETE FROM photo_reactions WHERE photo_id = ? AND username = ? AND emoji = ?').run(req.params.photoId, req.user.username, emoji);
    res.json({ ok: true, action: 'removed' });
  } else {
    db.prepare('INSERT INTO photo_reactions (photo_id, username, emoji) VALUES (?,?,?)').run(req.params.photoId, req.user.username, emoji);
    res.json({ ok: true, action: 'added' });
  }
});

// ── PHOTO COMMENTS ────────────────────────────────────────────────────────────
// Bulk fetch — all photo comments (for gallery preload)
app.get('/api/comments/photo', (req, res) => {
  const rows = db.prepare('SELECT * FROM photo_comments ORDER BY created_at ASC').all();
  const grouped = {};
  for (const c of rows) {
    if (!grouped[c.photo_id]) grouped[c.photo_id] = [];
    grouped[c.photo_id].push({ ...c, user: getUser(c.username) || { username: c.username } });
  }
  res.json(grouped);
});

app.get('/api/comments/photo/:photoId', (req, res) => {
  const rows = db.prepare('SELECT * FROM photo_comments WHERE photo_id = ? ORDER BY created_at ASC').all(req.params.photoId);
  const comments = rows.map(c => ({ ...c, user: getUser(c.username) || { username: c.username } }));
  res.json(comments);
});

app.post('/api/comments/photo/:photoId', authRequired, (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'empty_body' });
  const result = db.prepare(
    "INSERT INTO photo_comments (photo_id, username, body, created_at) VALUES (?,?,?,datetime('now'))"
  ).run(req.params.photoId, req.user.username, body.trim());
  const row = db.prepare('SELECT * FROM photo_comments WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...row, user: getUser(req.user.username) });
});

app.delete('/api/comments/photo/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM photo_comments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.username !== req.user.username) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM photo_comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── TASK DONE ─────────────────────────────────────────────────────────────────
app.get('/api/tasks/done', (req, res) => {
  const rows = db.prepare('SELECT * FROM task_done ORDER BY done_at ASC').all();
  res.json(rows.map(r => ({ ...r, user: getUser(r.done_by) })));
});

app.post('/api/tasks/:taskId/done', authRequired, (req, res) => {
  const { taskId } = req.params;
  const existing = db.prepare('SELECT 1 FROM task_done WHERE task_id = ?').get(taskId);
  if (existing) {
    db.prepare('DELETE FROM task_done WHERE task_id = ?').run(taskId);
    res.json({ done: false, task_id: taskId });
  } else {
    db.prepare("INSERT OR REPLACE INTO task_done (task_id, done_by, done_at) VALUES (?,?,datetime('now'))").run(taskId, req.user.username);
    const row = db.prepare('SELECT * FROM task_done WHERE task_id = ?').get(taskId);
    res.json({ done: true, ...row, user: getUser(req.user.username) });
  }
});

// ── IMMICH PROXY ─────────────────────────────────────────────────────────────
// Album display names, derived from trip.config.json phases — never hardcode
// one trip's phase ids/labels here, since every trip has a different set.
const TRIP_BRAND = TRIP_CONFIG.meta?.brand || TRIP_CONFIG.meta?.title || 'Trip';
const SECTION_NAMES = Object.fromEntries(
  (TRIP_CONFIG.phases || []).map(p => [p.id, `${TRIP_BRAND} — ${p.title?.he || p.title?.en || p.tabLabel || p.id}`])
);

// Album IDs are looked up by name (or created) on first use — see getOrCreateAlbum().
const ALBUM_IDS = {};

async function getOrCreateAlbum(phase) {
  if (ALBUM_IDS[phase]) return ALBUM_IDS[phase];
  const name = SECTION_NAMES[phase];
  if (!name) return null;
  // Search existing albums
  const listRes = await fetch(`${IMMICH_URL}/api/albums`, { headers: { 'x-api-key': IMMICH_KEY } });
  const albums = await listRes.json();
  const existing = albums.find(a => a.albumName === name);
  if (existing) { ALBUM_IDS[phase] = existing.id; return existing.id; }
  // Create new
  const createRes = await fetch(`${IMMICH_URL}/api/albums`, {
    method: 'POST',
    headers: { 'x-api-key': IMMICH_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumName: name }),
  });
  const created = await createRes.json();
  ALBUM_IDS[phase] = created.id;
  return created.id;
}

const SHARE_KEYS = {};
const IMMICH_EXTERNAL = process.env.IMMICH_EXTERNAL_URL || IMMICH_URL;

async function getOrCreateShareLink(phase) {
  if (SHARE_KEYS[phase]) return SHARE_KEYS[phase];
  const albumId = await getOrCreateAlbum(phase);
  if (!albumId) return null;

  const listRes = await fetch(`${IMMICH_URL}/api/shared-links`, { headers: { 'x-api-key': IMMICH_KEY } });
  const links = await listRes.json();
  const existing = Array.isArray(links) && links.find(l => l.album?.id === albumId && l.type === 'ALBUM');
  if (existing) { SHARE_KEYS[phase] = existing.key; return existing.key; }

  const createRes = await fetch(`${IMMICH_URL}/api/shared-links`, {
    method: 'POST',
    headers: { 'x-api-key': IMMICH_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ALBUM', albumId, allowDownload: true, showMetadata: true }),
  });
  const created2 = await createRes.json();
  SHARE_KEYS[phase] = created2.key;
  return created2.key;
}

app.get('/api/album-share/:phase', async (req, res) => {
  if (!IMMICH_URL || !IMMICH_KEY) return res.status(503).json({ error: 'Immich not configured' });
  try {
    const key = await getOrCreateShareLink(req.params.phase);
    if (!key) return res.status(404).json({ error: 'Album not found' });
    res.json({ url: `${IMMICH_EXTERNAL}/share/${key}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  if (!IMMICH_URL || !IMMICH_KEY) {
    return res.status(503).json({ error: 'Immich not configured on server — set IMMICH_URL and IMMICH_API_KEY in .env' });
  }

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files received' });

  const phase = req.body.phase || req.query.phase || null;
  const albumId = phase ? await getOrCreateAlbum(phase).catch(() => null) : null;

  const now = new Date().toISOString();
  const results = [];
  const uploadedIds = [];

  for (const file of files) {
    try {
      const form = new FormData();
      form.append('assetData', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
        knownLength: file.size,
      });
      form.append('deviceAssetId', `${file.originalname}-${Date.now()}`);
      form.append('deviceId', 'trip-website');
      form.append('fileCreatedAt', now);
      form.append('fileModifiedAt', now);

      const r = await fetch(`${IMMICH_URL}/api/assets`, {
        method: 'POST',
        headers: { 'x-api-key': IMMICH_KEY, ...form.getHeaders() },
        body: form,
      });
      const data = await r.json();
      if (data.id) uploadedIds.push(data.id);
      results.push({ name: file.originalname, ok: r.ok, assetId: data.id, immichStatus: data.status });
    } catch (e) {
      results.push({ name: file.originalname, ok: false, error: e.message });
    }
  }

  // Add all uploaded assets to the phase album in one call
  if (albumId && uploadedIds.length) {
    await fetch(`${IMMICH_URL}/api/albums/${albumId}/assets`, {
      method: 'PUT',
      headers: { 'x-api-key': IMMICH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: uploadedIds }),
    }).catch(() => {});
  }

  res.json({ results, album: albumId || null });
});

// ── LOST & FOUND ──────────────────────────────────────────────────────────────
app.post('/api/lost-found', (req, res) => {
  const { name, phone, item, location } = req.body || {};
  if (!name?.trim() || !item?.trim()) return res.status(400).json({ error: 'name and item are required' });
  const result = db.prepare(
    "INSERT INTO lost_found (name, phone, item, location) VALUES (?,?,?,?)"
  ).run(name.trim(), (phone || '').trim(), item.trim(), (location || '').trim());
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.get('/api/lost-found', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM lost_found ORDER BY created_at DESC').all();
  res.json(rows);
});

app.patch('/api/lost-found/:id', authRequired, (req, res) => {
  const { resolved } = req.body || {};
  db.prepare('UPDATE lost_found SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── PER-PHOTO SHARE PAGE (Open Graph tags for Facebook) ──────────────────────
app.get('/photo/:id', (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).send('Not found');
  const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const imgUrl = `${origin}/api/photos/file/${encodeURIComponent(photo.filename)}`;
  const pageUrl = `${origin}/photo/${photo.id}`;
  const brand = TRIP_CONFIG.meta?.brand || TRIP_CONFIG.meta?.title || 'Trip';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>${brand}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="${brand}">
<meta property="og:title" content="${brand}">
<meta property="og:description" content="Shared photo from ${brand}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:secure_url" content="${imgUrl}">
<meta property="og:url" content="${pageUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imgUrl}">
</head><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box">
<img src="${imgUrl}" style="max-width:min(600px,90vw);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.6)">
<a href="/" style="margin-top:20px;color:#60a5fa;font-size:15px;text-decoration:none">← חזרה לאתר הטיול</a>
</body></html>`);
});

// ── BUDGET ────────────────────────────────────────────────────────────────────
app.get('/api/budget', authRequired, (req, res) => {
  res.json(db.prepare('SELECT * FROM budget_items ORDER BY phase, id').all());
});

app.post('/api/budget', authRequired, (req, res) => {
  const { phase, category, description, amount, is_estimate } = req.body || {};
  if (!phase || !category || !description || amount === undefined)
    return res.status(400).json({ error: 'phase, category, description, amount required' });
  const result = db.prepare(
    'INSERT INTO budget_items (phase,category,description,amount,is_estimate) VALUES (?,?,?,?,?)'
  ).run(phase, category, description, parseFloat(amount) || 0, is_estimate ? 1 : 0);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/budget/:id', authRequired, (req, res) => {
  const { amount, description } = req.body || {};
  if (amount === undefined && description === undefined)
    return res.status(400).json({ error: 'amount or description required' });
  if (amount !== undefined)
    db.prepare('UPDATE budget_items SET amount=? WHERE id=?').run(parseFloat(amount) || 0, req.params.id);
  if (description !== undefined)
    db.prepare('UPDATE budget_items SET description=? WHERE id=?').run(description, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/budget/:id', authRequired, (req, res) => {
  db.prepare('DELETE FROM budget_items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

const HERMES_URL = (process.env.HERMES_URL || '').replace(/\/$/, '');

const extractUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post('/api/bookings/extract', authRequired, extractUpload.single('file'), async (req, res) => {
  if (!HERMES_URL) return res.status(503).json({ error: 'HERMES_URL not configured' });
  const url = req.body?.url;
  // The site's own "Extract Details with AI" upload (site/app.js) sends
  // pdf_base64/pdf_name as a JSON body, not multipart — req.file only gets
  // populated for an actual multipart caller (e.g. a direct API client).
  const pdfBase64 = req.file ? req.file.buffer.toString('base64') : req.body?.pdf_base64;
  const pdfName = req.file ? req.file.originalname : req.body?.pdf_name;
  if (!pdfBase64 && !url) return res.status(400).json({ error: 'Provide a file or url' });

  try {
    const body = url
      ? JSON.stringify({ url })
      : JSON.stringify({ pdf_base64: pdfBase64, pdf_name: pdfName || 'confirmation.pdf' });

    const r = await fetch(`${HERMES_URL}/extract`, {
      method: 'POST',
      headers: { 'X-API-Key': HERMES_KEY, 'Content-Type': 'application/json' },
      body,
      // Longer than trip-mcp's own 45s execFile timeout on the hermes CLI
      // call (mcp/mcp.js) — this used to be shorter (30s), so this call
      // could time out and error here while trip-mcp's own call was still
      // legitimately running, producing a confusing failure under load.
      timeout: 50000,
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`hermes ${r.status}: ${t}`); }
    res.json(await r.json());
  } catch (e) {
    console.error('[extract proxy]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const confUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CONF_DIR),
    filename: (req, _file, cb) => cb(null, `booking-${req.params.id}-${Date.now()}.pdf`),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get('/api/bookings', authRequired, (req, res) => {
  const { phase, type } = req.query;
  let sql = 'SELECT * FROM bookings';
  const params = [];
  const wheres = [];
  if (phase) { wheres.push('phase = ?'); params.push(phase); }
  if (type)  { wheres.push('type = ?');  params.push(type);  }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' ORDER BY date_from, id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/bookings', authRequired, (req, res) => {
  const { phase, type, name, date_from, date_to, passengers, confirmation, pin, notes, cost, apple_wallet_url, google_wallet_url, location_url } = req.body || {};
  if (!phase || !type || !name) return res.status(400).json({ error: 'phase, type, name required' });
  const result = db.prepare(
    'INSERT INTO bookings (phase,type,name,date_from,date_to,passengers,confirmation,pin,notes,cost,apple_wallet_url,google_wallet_url,location_url,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(phase, type, name, date_from || null, date_to || null, passengers || null,
    confirmation || null, pin || null, notes || null, parseFloat(cost) || 0,
    apple_wallet_url || null, google_wallet_url || null, location_url || null, req.user.username);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/bookings/:id', authRequired, (req, res) => {
  const fields = ['phase','type','name','date_from','date_to','passengers','confirmation','pin','notes','cost','apple_wallet_url','google_wallet_url','location_url'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(f === 'cost' ? parseFloat(req.body[f]) || 0 : req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT seed_key FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.seed_key) return res.status(403).json({ error: 'seed bookings cannot be deleted' });
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/bookings/:id/confirmation', authRequired, confUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'pdf file required' });
  db.prepare('UPDATE bookings SET conf_file = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ ok: true, conf_file: req.file.filename });
});

// Serve confirmation PDFs — uploaded ones from CONF_DIR; static ones from site/confirmations/ via Nginx
app.get('/api/bookings/confirmation/:fn', (req, res) => {
  const fn = path.basename(req.params.fn);
  const filePath = path.join(CONF_DIR, fn);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fn}"`);
  fs.createReadStream(filePath).pipe(res);
});

const pkpassUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CONF_DIR),
    filename: (req, _file, cb) => cb(null, `wallet-apple-${req.params.id}-${Date.now()}.pkpass`),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.endsWith('.pkpass') || file.mimetype === 'application/vnd.apple.pkpass'),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post('/api/bookings/:id/wallet-apple', authRequired, pkpassUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'pkpass file required' });
  db.prepare('UPDATE bookings SET pkpass_file = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ ok: true, pkpass_file: req.file.filename });
});

app.get('/api/bookings/wallet-apple/:fn', (req, res) => {
  const fn = path.basename(req.params.fn);
  const filePath = path.join(CONF_DIR, fn);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
  res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── PHASE PLAN ITEMS ──────────────────────────────────────────────────────────
const VALID_PLAN_PHASES = new Set((TRIP_CONFIG.phases || []).map(p => p.id));

function joinBooking(item) {
  if (!item.booking_id) return item;
  const bk = db.prepare('SELECT id, name, confirmation, conf_file FROM bookings WHERE id = ?').get(item.booking_id);
  return { ...item, booking: bk || null };
}

const PLAN_STATUSES = new Set(['confirmed', 'needs_review']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Fails safe, the same way shared/needs-schema.js does: an unrecognized status
// resolves to the MOST restrictive option. The z.enum in mcp/mcp.js only guards
// the agent path — a direct HTTP caller writing 'needs-review' would otherwise
// store it verbatim and the UI, which tests `=== 'needs_review'`, would render
// it as organizer-confirmed and never surface it for review.
function normalizePlanStatus(v) {
  if (v === undefined || v === null || v === '') return null;
  return PLAN_STATUSES.has(v) ? v : 'needs_review';
}

// Validates before binding. better-sqlite3 rejects a non-primitive binding with
// an unhandled throw, which Express renders as a 500 carrying a stack trace and
// absolute server paths.
function planFieldError(body, { requireText }) {
  const isStr = v => typeof v === 'string';
  if (requireText && (!isStr(body.text_he) || !body.text_he.trim())) {
    return 'text_he required (non-empty string)';
  }
  for (const f of ['text_he', 'text_en', 'location_url', 'time']) {
    const v = body[f];
    if (v !== undefined && v !== null && !isStr(v)) return `${f} must be a string`;
  }
  const d = body.date;
  if (d !== undefined && d !== null && d !== '' && (!isStr(d) || !ISO_DATE_RE.test(d))) {
    return 'date must be YYYY-MM-DD';
  }
  const u = body.location_url;
  if (u !== undefined && u !== null && u !== '' && !/^https?:\/\//i.test(u)) {
    return 'location_url must be an http(s) URL';
  }
  const s = body.sort_order;
  if (s !== undefined && s !== null && !Number.isFinite(Number(s))) {
    return 'sort_order must be a number';
  }
  const b = body.booking_id;
  if (b !== undefined && b !== null && b !== '' && !Number.isInteger(Number(b))) {
    return 'booking_id must be an integer';
  }
  return null;
}

app.get('/api/phases/:phase_id/plan', authRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  const rows = db.prepare(
    'SELECT * FROM phase_plan_items WHERE phase_id = ? ORDER BY date ASC, sort_order ASC, time ASC, id ASC'
  ).all(req.params.phase_id);
  res.json(rows.map(joinBooking));
});

app.post('/api/phases/:phase_id/plan', organizerOrAgentRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  const body = req.body || {};
  const bad = planFieldError(body, { requireText: true });
  if (bad) return res.status(400).json({ error: bad });
  const { date, time, text_he, text_en, location_url, booking_id, status, sort_order } = body;
  const result = db.prepare(
    'INSERT INTO phase_plan_items (phase_id,date,time,text_he,text_en,location_url,booking_id,status,sort_order,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(
    req.params.phase_id,
    date || null, time || null, text_he.trim(),
    text_en || null, location_url || null,
    booking_id ? Number(booking_id) : null,
    normalizePlanStatus(status) || 'confirmed',
    sort_order != null ? Number(sort_order) : 0,
    req.user.username
  );
  const created = db.prepare('SELECT * FROM phase_plan_items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(joinBooking(created));
});

app.patch('/api/phases/:phase_id/plan/:id', organizerOrAgentRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  const body = req.body || {};
  const bad = planFieldError(body, { requireText: false });
  if (bad) return res.status(400).json({ error: bad });
  if (body.text_he !== undefined && !String(body.text_he).trim()) {
    return res.status(400).json({ error: 'text_he cannot be empty' });
  }

  // Scope the existence check to this phase. Matching on id alone let a
  // cross-phase PATCH change nothing yet return 200 with the OTHER phase's row,
  // which the caller then cached under the wrong phase.
  const existing = db.prepare('SELECT id FROM phase_plan_items WHERE id = ? AND phase_id = ?')
    .get(req.params.id, req.params.phase_id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const allowed = ['date','time','text_he','text_en','location_url','booking_id','status','sort_order'];
  const updates = [];
  const params = [];
  for (const f of allowed) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      if (f === 'booking_id') params.push(body[f] ? Number(body[f]) : null);
      else if (f === 'sort_order') params.push(Number(body[f]));
      // An explicit empty/unknown status is ambiguous, so it fails safe rather
      // than clearing the column.
      else if (f === 'status') params.push(normalizePlanStatus(body[f]) || 'needs_review');
      else params.push(body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id, req.params.phase_id);
  db.prepare(`UPDATE phase_plan_items SET ${updates.join(', ')} WHERE id = ? AND phase_id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM phase_plan_items WHERE id = ? AND phase_id = ?')
    .get(req.params.id, req.params.phase_id);
  res.json(joinBooking(updated));
});

app.delete('/api/phases/:phase_id/plan/:id', organizerOrAgentRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  const row = db.prepare('SELECT id FROM phase_plan_items WHERE id = ? AND phase_id = ?').get(req.params.id, req.params.phase_id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM phase_plan_items WHERE id = ?').run(req.params.id);
  // Every other DELETE in this file answers {ok:true}, and mcp/mcp.js's
  // apiDelete() parses the body unconditionally — a 204 made the agent's
  // delete_plan_item throw on every successful delete.
  res.json({ ok: true });
});

// One-off migration for a trip whose plan was typed into booking notes before
// this feature existed. Every skip carries a reason so a caller can tell
// "already done" apart from "this booking can't be imported".
app.post('/api/phase-plan/import-from-bookings', organizerOrAgentRequired, (req, res) => {
  const bookings = db.prepare(
    "SELECT * FROM bookings WHERE notes IS NOT NULL AND length(notes) > 80"
  ).all();
  const created = [];
  const skipped = [];
  for (const bk of bookings) {
    // A booking may carry a phase that isn't in trip.config.json (see the fix
    // for the Bookings tab dropping off-config phases). Importing one produced
    // a row that GET/PATCH/DELETE all reject as 'unknown phase' — unreachable
    // forever. Skip it and say so.
    if (!VALID_PLAN_PHASES.has(bk.phase)) {
      skipped.push({ booking_id: bk.id, reason: 'phase not in trip config' });
      continue;
    }
    // Idempotency is recorded here, not inferred from whether a plan item still
    // points at the booking. The intended workflow is import → review → delete
    // the junk, and inferring it resurrected every deleted item on the next run.
    const already = db.prepare('SELECT 1 FROM phase_plan_import_log WHERE booking_id = ?').get(bk.id);
    if (already) { skipped.push({ booking_id: bk.id, reason: 'already imported' }); continue; }

    const text = [bk.name, bk.notes].filter(Boolean).join('\n\n');
    // Carry the booking's own date across — dropping it filed every imported
    // item under "unscheduled" and made the organizer retype a date the DB had.
    const date = ISO_DATE_RE.test(String(bk.date_from || '')) ? bk.date_from : null;
    const result = db.prepare(
      'INSERT INTO phase_plan_items (phase_id,date,text_he,text_en,location_url,booking_id,status,created_by) VALUES (?,?,?,?,?,?,?,?)'
    ).run(bk.phase, date, text, text, bk.location_url || null, bk.id, 'needs_review', 'migration');
    db.prepare('INSERT INTO phase_plan_import_log (booking_id) VALUES (?)').run(bk.id);
    const item = db.prepare('SELECT * FROM phase_plan_items WHERE id = ?').get(result.lastInsertRowid);
    created.push(joinBooking(item));
  }
  res.json({ created, skipped });
});

// ── TRIVIA GAME ───────────────────────────────────────────────────────────────
const TRIVIA_QUESTIONS = (() => {
  // Each trip owns its own trivia_questions.json — no framework-level fallback,
  // so a new trip never inherits another trip's (or nobody's) questions.
  const tripFile = path.join(TRIP_DIR, 'trivia_questions.json');
  try {
    const qs = JSON.parse(fs.readFileSync(tripFile, 'utf8'));
    if (qs.length) console.log(`Loaded ${qs.length} trivia questions from trip/`);
    else console.log('Trip has empty trivia_questions.json — trivia disabled');
    return qs;
  } catch (e) {
    console.error('No trivia_questions.json for this trip — trivia disabled:', e.message);
    return [];
  }
})();
const TRIVIA_ADMIN = TRIP_CONFIG.meta?.admin || TRIP_CONFIG.participants?.[0]?.username;

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// All 17 family participants — each gets exactly 2 questions per game
const PARTICIPANTS = TRIP_CONFIG.trivia?.participants || [];
const TOTAL_QUIZ_QUESTIONS = TRIP_CONFIG.trivia?.total_questions || 40;

function generateQuizSet() {
  const selected = new Map();     // id → question
  const personCount = {};         // username → # of questions already covering them
  PARTICIPANTS.forEach(p => { personCount[p] = 0; });

  // Per-person question pools
  const personPools = {};
  PARTICIPANTS.forEach(p => {
    personPools[p] = TRIVIA_QUESTIONS.filter(q =>
      Array.isArray(q.persons) ? q.persons.includes(p) : q.persons === p
    );
  });

  // Pick 2 per person (random participant order so no one is systematically deprioritised)
  for (const person of shuffleArray(PARTICIPANTS)) {
    const needed = 2 - (personCount[person] || 0);
    if (needed <= 0) continue;
    const pool = shuffleArray(personPools[person].filter(q => !selected.has(q.id)));
    pool.slice(0, needed).forEach(q => {
      selected.set(q.id, q);
      const covered = Array.isArray(q.persons) ? q.persons : [q.persons];
      covered.forEach(p2 => {
        if (p2 in personCount) personCount[p2] = (personCount[p2] || 0) + 1;
      });
    });
  }

  // Fill remaining slots up to 40 with general/trip questions
  const remaining = TOTAL_QUIZ_QUESTIONS - selected.size;
  if (remaining > 0) {
    const fillPool = shuffleArray(
      TRIVIA_QUESTIONS.filter(q => !selected.has(q.id) && (q.persons === 'general' || q.persons === 'trip'))
    );
    fillPool.slice(0, remaining).forEach(q => selected.set(q.id, q));
  }

  // Safety: if still under 40, top up from any remaining questions
  if (selected.size < TOTAL_QUIZ_QUESTIONS) {
    const extra = shuffleArray(TRIVIA_QUESTIONS.filter(q => !selected.has(q.id)));
    extra.slice(0, TOTAL_QUIZ_QUESTIONS - selected.size).forEach(q => selected.set(q.id, q));
  }

  return shuffleArray([...selected.values()]);
}

const triviaState = {
  status: 'idle',          // idle | lobby | question | reveal | leaderboard | gameover
  gameId: null,
  questions: [...TRIVIA_QUESTIONS],
  questionIndex: -1,
  questionStartTime: null,
  pausedRemainingMs: null,
  revealTimer: null,
  players: {},             // username → { name, name_en, family, color, score, delta }
  answers: {}              // username → { answerIndex, answeredAt } for current question
};
let sseClients = [];       // { username, res }
let screenClients = [];    // { res } — unauthenticated TV/projector displays

function sseBroadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(c => {
    try { c.res.write(msg); return true; }
    catch (_) { return false; }
  });
  screenClients = screenClients.filter(c => {
    try { c.res.write(msg); return true; }
    catch (_) { return false; }
  });
}

function triviaPublicState() {
  const q = triviaState.questions[triviaState.questionIndex];
  let question = null;
  if (q) {
    const elapsed = triviaState.questionStartTime
      ? (triviaState.pausedRemainingMs !== null
          ? (q.duration * 1000) - triviaState.pausedRemainingMs
          : Date.now() - triviaState.questionStartTime)
      : 0;
    question = {
      id: q.id,
      he: q.he,
      en: q.en,
      category: q.category,
      duration: q.duration,
      number: triviaState.questionIndex + 1,
      total: triviaState.questions.length,
      answers: q.answers.map((a, i) => ({
        he: a.he,
        en: a.en,
        index: i,
        correct: triviaState.status === 'reveal' || triviaState.status === 'leaderboard' ? a.correct : undefined
      })),
      elapsedMs: elapsed,
      persons: q.persons
    };
  }
  const nextQ = triviaState.questions[triviaState.questionIndex + 1];
  return {
    status: triviaState.status,
    gameId: triviaState.gameId,
    questionIndex: triviaState.questionIndex,
    question,
    nextPersons: nextQ ? nextQ.persons : null,
    players: triviaState.players,
    myAnswer: null // client fills this in
  };
}

function triviaStartQuestion() {
  triviaState.answers = {};
  triviaState.questionStartTime = Date.now();
  triviaState.pausedRemainingMs = null;
  const q = triviaState.questions[triviaState.questionIndex];
  sseBroadcast('state', triviaPublicState());

  triviaState.revealTimer = setTimeout(() => triviaReveal(), q.duration * 1000);
}

function triviaReveal() {
  if (triviaState.revealTimer) { clearTimeout(triviaState.revealTimer); triviaState.revealTimer = null; }
  triviaState.status = 'reveal';
  const q = triviaState.questions[triviaState.questionIndex];
  const correctIndex = q.answers.findIndex(a => a.correct);
  const durationMs = q.duration * 1000;

  // Score players
  Object.entries(triviaState.answers).forEach(([username, ans]) => {
    if (!triviaState.players[username]) return;
    const player = triviaState.players[username];
    const prev = player.score;
    if (ans.answerIndex === correctIndex) {
      const elapsed = ans.answeredAt - triviaState.questionStartTime;
      const points = Math.max(100, Math.round(1000 * (1 - elapsed / durationMs)));
      player.score += points;
    }
    player.delta = player.score - prev;
  });
  // Zero delta for players who did not answer this question
  Object.entries(triviaState.players).forEach(([username, p]) => {
    if (!triviaState.answers[username]) p.delta = 0;
  });

  sseBroadcast('state', triviaPublicState());
}

function triviaLeaderboard() {
  triviaState.status = 'leaderboard';
  sseBroadcast('state', triviaPublicState());
}

function triviaPersistScores() {
  if (!triviaState.gameId) return;
  const sorted = Object.entries(triviaState.players)
    .sort(([, a], [, b]) => b.score - a.score);
  const stmt = db.prepare('INSERT INTO trivia_scores (game_id, username, name, family, rank, score) VALUES (?,?,?,?,?,?)');
  sorted.forEach(([username, p], idx) => {
    try { stmt.run(triviaState.gameId, username, p.name, p.family || '', idx + 1, p.score); }
    catch (e) { console.error('trivia score persist error:', e.message); }
  });
}

// GET /api/trivia/state — public state snapshot
app.get('/api/trivia/state', authRequired, (req, res) => {
  const state = triviaPublicState();
  state.myAnswer = triviaState.answers[req.user.username]?.answerIndex ?? null;
  res.json(state);
});

// GET /api/trivia/events — SSE stream, auto-registers player on connect
app.get('/api/trivia/events', authRequired, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const dbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(req.user.username) || {};
  const u = {
    username: req.user.username,
    name: dbUser.name || req.user.username,
    name_en: dbUser.name_en || dbUser.name || req.user.username,
    family: dbUser.family || '',
    color: dbUser.color || '#888'
  };

  // Register player only during lobby — after launch, new connections are spectators
  if (triviaState.status === 'lobby') {
    if (!triviaState.players[u.username]) {
      triviaState.players[u.username] = {
        name: u.name, name_en: u.name_en,
        family: u.family, color: u.color,
        score: 0, delta: 0
      };
      sseBroadcast('state', triviaPublicState());
    }
  }

  const client = { username: u.username, res };
  sseClients.push(client);

  // Send current state immediately
  const state = triviaPublicState();
  state.myAnswer = triviaState.answers[u.username]?.answerIndex ?? null;
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

  // Heartbeat every 25s to keep connection alive through nginx
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c !== client);
  });
});

// GET /api/trivia/public-events — unauthenticated SSE for TV/projector screen display
app.get('/api/trivia/public-events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify(triviaPublicState())}\n\n`);

  const client = { res };
  screenClients.push(client);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    screenClients = screenClients.filter(c => c !== client);
  });
});

// POST /api/trivia/answer
app.post('/api/trivia/answer', authRequired, (req, res) => {
  if (triviaState.status !== 'question') return res.status(400).json({ error: 'not_in_question' });
  if (triviaState.pausedRemainingMs !== null) return res.status(400).json({ error: 'paused' });
  const { answerIndex } = req.body;
  if (answerIndex === undefined || answerIndex < 0 || answerIndex > 3)
    return res.status(400).json({ error: 'invalid_answer' });
  const username = req.user.username;
  if (triviaState.answers[username]) return res.status(400).json({ error: 'already_answered' });

  triviaState.answers[username] = { answerIndex, answeredAt: Date.now() };

  // Auto-reveal when all lobby-registered players have answered. The admin is
  // optional: counted only when they have an active browser (SSE) connection,
  // since they may be managing the game via MCP with no browser open.
  const sseUsernames = new Set(sseClients.map(c => c.username));
  const activePlayers = Object.keys(triviaState.players)
    .filter(u => u !== TRIVIA_ADMIN || sseUsernames.has(TRIVIA_ADMIN));
  const totalPlayers = activePlayers.length;
  const allAnswered = totalPlayers > 0 && activePlayers.every(u => triviaState.answers[u]);
  if (allAnswered) triviaReveal();
  else sseBroadcast('answer_count', { count: Object.keys(triviaState.answers).length, total: totalPlayers });

  res.json({ ok: true });
});

// POST /api/trivia/control — admin only
app.post('/api/trivia/control', authRequired, (req, res) => {
  if (req.user.username !== TRIVIA_ADMIN && !req.user.isAgent) return res.status(403).json({ error: 'admin_only' });
  const { action } = req.body;

  if (action === 'start') {
    if (triviaState.revealTimer) clearTimeout(triviaState.revealTimer);
    triviaState.status = 'lobby';
    triviaState.gameId = `game_${Date.now()}`;
    triviaState.questions = generateQuizSet();
    triviaState.questionIndex = -1;
    triviaState.players = {};
    triviaState.answers = {};
    triviaState.pausedRemainingMs = null;
    triviaState.revealTimer = null;
    // Auto-register the admin so they participate even when managing via MCP (no SSE connection)
    const adminDbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(TRIVIA_ADMIN);
    if (adminDbUser) {
      triviaState.players[TRIVIA_ADMIN] = {
        name: adminDbUser.name || TRIVIA_ADMIN,
        name_en: adminDbUser.name_en || adminDbUser.name || TRIVIA_ADMIN,
        family: adminDbUser.family || '',
        color: adminDbUser.color || '#3B82F6',
        score: 0,
        delta: 0,
      };
    }
    sseBroadcast('state', triviaPublicState());
    return res.json({ ok: true });
  }

  if (action === 'launch') {
    if (triviaState.status !== 'lobby') return res.status(400).json({ error: 'must_be_lobby' });
    triviaState.status = 'question';
    triviaState.questionIndex = 0;
    triviaStartQuestion();
    return res.json({ ok: true });
  }

  if (action === 'pause') {
    if (triviaState.status !== 'question') return res.status(400).json({ error: 'not_in_question' });
    if (triviaState.revealTimer) {
      clearTimeout(triviaState.revealTimer);
      triviaState.revealTimer = null;
    }
    const q = triviaState.questions[triviaState.questionIndex];
    const elapsed = Date.now() - triviaState.questionStartTime;
    triviaState.pausedRemainingMs = Math.max(0, q.duration * 1000 - elapsed);
    sseBroadcast('state', triviaPublicState());
    return res.json({ ok: true });
  }

  if (action === 'resume') {
    if (triviaState.status !== 'question' || triviaState.pausedRemainingMs === null)
      return res.status(400).json({ error: 'not_paused' });
    triviaState.questionStartTime = Date.now() - (triviaState.questions[triviaState.questionIndex].duration * 1000 - triviaState.pausedRemainingMs);
    triviaState.revealTimer = setTimeout(() => triviaReveal(), triviaState.pausedRemainingMs);
    triviaState.pausedRemainingMs = null;
    sseBroadcast('state', triviaPublicState());
    return res.json({ ok: true });
  }

  if (action === 'reveal') {
    if (triviaState.status !== 'question') return res.status(400).json({ error: 'not_in_question' });
    triviaReveal();
    return res.json({ ok: true });
  }

  if (action === 'leaderboard') {
    if (triviaState.status !== 'reveal') return res.status(400).json({ error: 'not_in_reveal' });
    triviaLeaderboard();
    return res.json({ ok: true });
  }

  if (action === 'next') {
    if (triviaState.status !== 'leaderboard') return res.status(400).json({ error: 'not_in_leaderboard' });
    const nextIdx = triviaState.questionIndex + 1;
    if (nextIdx >= triviaState.questions.length) {
      triviaState.status = 'gameover';
      triviaPersistScores();
      sseBroadcast('state', triviaPublicState());
    } else {
      triviaState.status = 'question';
      triviaState.questionIndex = nextIdx;
      triviaStartQuestion();
    }
    return res.json({ ok: true });
  }

  if (action === 'restart') {
    if (triviaState.revealTimer) clearTimeout(triviaState.revealTimer);
    triviaState.status = 'lobby';
    triviaState.gameId = `game_${Date.now()}`;
    triviaState.questionIndex = -1;
    triviaState.answers = {};
    triviaState.pausedRemainingMs = null;
    triviaState.revealTimer = null;
    Object.values(triviaState.players).forEach(p => { p.score = 0; p.delta = 0; });
    sseBroadcast('state', triviaPublicState());
    return res.json({ ok: true });
  }

  if (action === 'stop') {
    if (triviaState.revealTimer) clearTimeout(triviaState.revealTimer);
    triviaState.status = 'gameover';
    triviaPersistScores();
    sseBroadcast('state', triviaPublicState());
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'unknown_action' });
});

// GET /api/trivia/scores — historical scores
app.get('/api/trivia/scores', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM trivia_scores ORDER BY played_at DESC, rank ASC').all();
  res.json(rows);
});

const TRIVIA_FILE = path.join(TRIP_DIR, 'trivia_questions.json');
// Every trip has a different roster — derive valid question subjects from the
// actual config instead of hardcoding one trip's participant usernames.
const VALID_PERSONS = [...(TRIP_CONFIG.participants || []).map(p => p.username), 'general', 'trip'];

// GET /api/trivia/questions — list questions (admin/agent only)
app.get('/api/trivia/questions', authRequired, (req, res) => {
  if (req.user.username !== TRIVIA_ADMIN && !req.user.isAgent) return res.status(403).json({ error: 'admin_only' });
  const { persons, category } = req.query;
  let qs = TRIVIA_QUESTIONS;
  if (persons) qs = qs.filter(q => Array.isArray(q.persons) ? q.persons.includes(persons) : q.persons === persons);
  if (category) qs = qs.filter(q => q.category === category);
  res.json(qs);
});

// POST /api/trivia/questions — add a question; hot-reloads without server restart
app.post('/api/trivia/questions', authRequired, (req, res) => {
  if (req.user.username !== TRIVIA_ADMIN && !req.user.isAgent) return res.status(403).json({ error: 'admin_only' });
  const { he, en, persons, answers, duration, category } = req.body || {};

  if (!he || !en) return res.status(400).json({ error: 'he and en question text required' });
  if (!Array.isArray(answers) || answers.length < 2 || answers.length > 4)
    return res.status(400).json({ error: 'answers must be an array of 2–4 items' });
  if (answers.filter(a => a.correct).length !== 1)
    return res.status(400).json({ error: 'exactly one answer must have correct: true' });
  for (const a of answers) {
    if (!a.he || !a.en) return res.status(400).json({ error: 'each answer needs he and en text' });
  }

  const personsRaw = persons || 'general';
  const personsArr = Array.isArray(personsRaw) ? personsRaw : [personsRaw];
  const badPerson = personsArr.find(p => !VALID_PERSONS.includes(p));
  if (badPerson) return res.status(400).json({ error: `unknown person: "${badPerson}". Valid: ${VALID_PERSONS.join(', ')}` });

  const newId = TRIVIA_QUESTIONS.length > 0 ? Math.max(...TRIVIA_QUESTIONS.map(q => q.id)) + 1 : 1;
  const question = {
    id: newId,
    he: he.trim(),
    en: en.trim(),
    persons: personsArr.length === 1 ? personsArr[0] : personsArr,
    answers: answers.map(a => ({ he: a.he.trim(), en: a.en.trim(), correct: Boolean(a.correct) })),
    duration: (typeof duration === 'number' && duration > 0) ? duration : 20,
    category: (category || 'family').trim(),
  };

  TRIVIA_QUESTIONS.push(question);
  try {
    fs.writeFileSync(TRIVIA_FILE, JSON.stringify(TRIVIA_QUESTIONS, null, 2));
  } catch (e) {
    TRIVIA_QUESTIONS.pop(); // roll back in-memory add on file write failure
    return res.status(500).json({ error: 'failed to persist: ' + e.message });
  }

  res.json({ ok: true, id: newId, total: TRIVIA_QUESTIONS.length });
});

// Catches what body-parser throws on a still-too-large or malformed body
// (and anything else unhandled) before Express's default HTML error page
// can reach the client — every client-side fetch() here calls r.json() on
// the response no matter what, so an HTML error page shows up in the
// browser as a raw "Unexpected token '<'" JSON.parse crash instead of a
// readable message.
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  console.error('[unhandled]', err.message);
  // err.message is only ever safe to hand back for the one specific,
  // already-vetted case this was written for. Everything else lands here
  // from framework/driver code never audited for what it puts in .message
  // (a DB error, a stack-trace fragment, a file path) — a fixed, generic
  // message is the only safe default for those.
  const message = err.type === 'entity.too.large' ? 'file too large' : 'internal server error';
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Trip server running on :${PORT}`));
