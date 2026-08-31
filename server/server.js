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
const livingJourney = require('./living-journey');
const { NEED_TYPES, NEED_SEVERITIES, VISIBILITIES, normalizeSeverity, normalizeVisibility } = require('../shared/needs-schema');
const { AGENT_TONES, AGENT_GENDERS, PROACTIVE_KEYS, publicAgent, normalizeInstructionVisibility, normalizeTone, normalizeGender, normalizeOrganizers } = require('../shared/agent-schema');
const { repairDayStamp, stampRest } = require('../shared/day-stamp');

const app = express();
// Default (100kb) is too small for /api/bookings/extract, which the browser
// calls with a base64-encoded PDF as the JSON body — base64 alone inflates a
// file ~33%, so even a modest few-MB confirmation PDF blew this immediately.
// Every other route's payloads are trivially small, so one shared limit is
// fine — no route needs its own override.
app.use(express.json({ limit: '30mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const SITE_DIR = path.join(__dirname, '..', 'site');
const CLASSIC_STATIC_FILES = new Map([
  ['/classic.html', 'classic.html'],
  ['/trivia.html', 'trivia.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/translations.js', 'translations.js'],
  ['/runtime-base.js', 'runtime-base.js'],
  ['/manifest.json', 'manifest.json'],
  ['/apple-wallet-badge.svg', 'apple-wallet-badge.svg'],
  ['/google-wallet-badge.svg', 'google-wallet-badge.svg'],
  ['/brand/favicon.svg', 'brand/favicon.svg'],
  ['/brand/kinerary-icon.svg', 'brand/kinerary-icon.svg'],
  ['/brand/logo.svg', 'brand/logo.svg'],
  ['/brand/logo-reversed.svg', 'brand/logo-reversed.svg'],
  ['/brand/mark.svg', 'brand/mark.svg'],
]);
for (const [route, relativeFile] of CLASSIC_STATIC_FILES) {
  app.get(route, (_req, res) => res.sendFile(path.join(SITE_DIR, relativeFile)));
}
// The root is the variant loader and Modern is a bundled SPA.  These routes
// are deliberately registered before API handlers but only match their exact
// static prefixes, so gateway-prefixed API traffic keeps reaching its routes.
app.get('/', (_req, res) => res.sendFile(path.join(SITE_DIR, 'index.html')));
app.use('/modern', express.static(path.join(SITE_DIR, 'modern'), { index: 'index.html' }));

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
const MEDIA_DIR   = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media');
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

[DATA_DIR, UPLOADS_DIR, CONF_DIR, MEDIA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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
// Extraction creates a private organizer draft first. Existing installations
// need additive migrations because CREATE TABLE IF NOT EXISTS does not change
// their bookings table.
for (const [col, decl] of [
  ['review_status', "TEXT NOT NULL DEFAULT 'approved'"],
]) {
  try { db.exec(`ALTER TABLE bookings ADD COLUMN ${col} ${decl}`); } catch {}
}

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
// Additive columns for AI enrichment and flexible time. CREATE TABLE IF NOT
// EXISTS above is a no-op on a database that already has the table, so new
// columns have to be added separately — each guarded, since ALTER TABLE ADD
// COLUMN throws once the column exists and there's no IF NOT EXISTS for it.
for (const [col, decl] of [
  ['waze_url',          'TEXT'],
  ['website_url',       'TEXT'],
  ['ticket_url',        'TEXT'],
  ['enrichment_status', "TEXT DEFAULT 'none'"],
  ['enriched_at',       'TEXT'],
  ['enrich_attempts',   'INTEGER DEFAULT 0'],
  // Minutes-since-midnight, derived from `time` on write. `time` may hold a
  // rough token ("morning"), which would otherwise sort lexically — "afternoon"
  // before "morning" before "noon" — so ordering uses this instead.
  ['time_sort',         'INTEGER'],
  // Identifies the config day item this row was promoted from, so promoting
  // twice can't duplicate the schedule.
  ['config_ref',        'TEXT'],
  // A compatibility-only identity for the Modern itinerary projection. It is
  // intentionally distinct from config_ref, whose contract is config import.
  ['itinerary_item_uid','TEXT'],
  // Ticketing state. needs_tickets/advance_booking come from enrichment;
  // booking_id (above) is set by deterministic matching against real bookings,
  // never by the model — "is this paid for" is a fact, not a judgment call.
  ['needs_tickets',     'INTEGER'],
  ['advance_booking',   'INTEGER'],
  // A promoted config item may name several places, each separately linked
  // ("Podmore, Foodland Farms, ABC Store…"). The four url columns can only
  // describe ONE place, so the rest are kept here as [{label,url}] — stripping
  // them lost real navigation the organizer had already written.
  ['extra_links',       'TEXT'],
  // Moving a day invalidates what its items SAY. "Tomorrow we climb Diamond
  // Head" on the day before, "unlike Thursday, this beach is calm" — none of
  // that survives a swap, and nothing on the moved day reveals it. A review
  // pass rewrites those, and the superseded wording is kept here so the site
  // can show it struck through: an organizer must be able to see that a
  // sentence they wrote was changed, and what it used to say.
  ['text_he_prev',      'TEXT'],
  ['text_en_prev',      'TEXT'],
  ['correction_note',   'TEXT'],
  ['corrected_at',      'TEXT'],
  // Separate from enrichment_status — that queue is about links, this one is
  // about wording that a date change made wrong.
  ['review_status',     "TEXT DEFAULT 'none'"],
  ['review_attempts',   'INTEGER DEFAULT 0'],
]) {
  try { db.exec(`ALTER TABLE phase_plan_items ADD COLUMN ${col} ${decl}`); } catch {}
}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_config_ref ON phase_plan_items(config_ref) WHERE config_ref IS NOT NULL'); } catch {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_itinerary_item_uid ON phase_plan_items(itinerary_item_uid) WHERE itinerary_item_uid IS NOT NULL'); } catch {}
// A day's headline ("Thu 13/8 — Diamond Head + Waikiki") says what the day IS;
// grouping items by date alone loses it. Kept per (phase, date) rather than on
// each item so it can't drift between rows of the same day.
try { db.exec(`CREATE TABLE IF NOT EXISTS phase_plan_days (
  phase_id          TEXT NOT NULL,
  date              TEXT NOT NULL,
  label_he          TEXT,
  label_en          TEXT,
  enrichment_status TEXT DEFAULT 'none',
  enrich_attempts   INTEGER DEFAULT 0,
  enriched_at       TEXT,
  PRIMARY KEY (phase_id, date)
)`); } catch {}
// Same story as the items above: a headline routinely names its own date
// ("Thu 13/8 — Diamond Head"), so moving it verbatim leaves the day announcing
// the wrong one. The superseded label is kept for the struck-through display.
for (const [col, decl] of [
  ['label_he_prev',    'TEXT'],
  ['label_en_prev',    'TEXT'],
  ['correction_note',  'TEXT'],
  ['corrected_at',     'TEXT'],
  ['review_status',    "TEXT DEFAULT 'none'"],
  ['review_attempts',  'INTEGER DEFAULT 0'],
  // Lets compatibility reconciliation delete only rows it previously wrote.
  ['itinerary_day_key','TEXT'],
]) {
  try { db.exec(`ALTER TABLE phase_plan_days ADD COLUMN ${col} ${decl}`); } catch {}
}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_itinerary_day_key ON phase_plan_days(itinerary_day_key) WHERE itinerary_day_key IS NOT NULL'); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_enrich ON phase_plan_items(enrichment_status)`); } catch {}
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
      'INSERT OR IGNORE INTO bookings (phase,type,name,date_from,date_to,passengers,confirmation,pin,notes,cost,conf_file,location_url,seed_key,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    // A trip DB seeded before bookings.json carried location_url keeps NULL
    // forever — INSERT OR IGNORE is a no-op once the seed_key row exists. Fill
    // it in on a later boot, but only where it is still unset so a hand edit on
    // the Bookings tab is never stomped.
    const bookingBackfillLoc = db.prepare(
      'UPDATE bookings SET location_url = ? WHERE seed_key = ? AND location_url IS NULL'
    );
    db.transaction(() => {
      for (const b of bookingSeeds) {
        bookingInsert.run(b.phase, b.type, b.name, b.date_from || null, b.date_to || null,
          b.passengers || null, b.confirmation || null, b.pin || null,
          b.notes || null, b.cost || 0, b.conf_file || null, b.location_url || null, b.seed_key, 'seed');
        if (b.location_url) bookingBackfillLoc.run(b.location_url, b.seed_key);
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
  // Every reload must see this deploy's config, not a stale copy some
  // intermediary (browser, Cloudflare, a reverse proxy in front of it)
  // decided a GET response was safe to hold onto.
  res.setHeader('Cache-Control', 'no-store');
  res.json(safe);
});

// ── CURRENCY RATES — Info tab: each destination currency vs USD / home ──────
// One shared, server-side cache refreshed at most once/day, not a per-visitor
// fetch — a dozen family members opening the Info tab the same afternoon
// should cost one external call, not a dozen.
// "USD" means the same thing whether it's explicit or just the unset
// default — normalize both to null so the home-currency line never
// duplicates the USD line below.
const HOME_CURRENCY = (() => {
  const c = (TRIP_CONFIG.meta?.homeCurrency || '').toUpperCase();
  return c && c !== 'USD' ? c : null;
})();
const CURRENCY_CACHE_MS = 24 * 60 * 60 * 1000;
let currencyRatesCache = null; // { base, home, rates, date, fetchedAt }

function destinationCurrencyCodes() {
  const countries = TRIP_CONFIG.travel_info?.countries || {};
  // "USD" is always excluded — it's the API's own `from`, and asking it to
  // convert USD to itself is the one pair frankfurter.dev 422s on (a
  // domestic-US trip like a USD destination with no distinct home
  // currency would otherwise fail every request instead of just having
  // nothing worth showing).
  return [...new Set(Object.values(countries).map(c => c.currency?.code).filter(Boolean))]
    .filter(code => code !== 'USD');
}

async function getCurrencyRates() {
  if (currencyRatesCache && (Date.now() - currencyRatesCache.fetchedAt) < CURRENCY_CACHE_MS) {
    return currencyRatesCache;
  }
  const codes = destinationCurrencyCodes();
  if (HOME_CURRENCY && !codes.includes(HOME_CURRENCY)) codes.push(HOME_CURRENCY);
  if (!codes.length) return { base: 'USD', home: HOME_CURRENCY, rates: {}, date: null };

  const r = await fetch(`https://api.frankfurter.dev/v1/latest?from=USD&to=${codes.join(',')}`, { timeout: 8000 });
  if (!r.ok) throw new Error(`rate lookup → ${r.status}`);
  const data = await r.json();
  currencyRatesCache = { base: 'USD', home: HOME_CURRENCY, rates: data.rates || {}, date: data.date, fetchedAt: Date.now() };
  return currencyRatesCache;
}

app.get('/api/currency-rates', authRequired, async (_req, res) => {
  // The 24h reuse window below is an intentional in-process cache — that's
  // the point of this endpoint. This header stops anything in front of the
  // server (browser, Cloudflare, a reverse proxy) from ALSO caching the
  // response and shadowing that logic with a copy of its own.
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await getCurrencyRates());
  } catch (e) {
    console.error('[currency-rates]', e.message);
    // A stale cached rate is still more useful than none on a transient
    // network blip — only a genuine first-ever failure returns nothing.
    if (currencyRatesCache) return res.json(currencyRatesCache);
    res.status(502).json({ error: 'currency rate lookup failed' });
  }
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

const journey = livingJourney.create({
  db,
  config: TRIP_CONFIG,
  raw: TRIP_CONFIG_RAW,
  fetchImpl: fetch,
  mediaDir: MEDIA_DIR,
});

const heroUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => {
      const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || path.extname(file.originalname || '').toLowerCase();
      cb(null, `hero-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext || '.img'}`);
    },
  }),
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)),
  limits: { fileSize: 8 * 1024 * 1024 },
});

app.post('/api/ui-settings/hero', organizerOrAgentRequired, heroUpload.single('hero'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file required' });
  const focalX = Number(req.body?.focal_x);
  const focalY = Number(req.body?.focal_y);
  db.prepare(
    "UPDATE trip_ui_settings SET hero_media_file = ?, hero_media_original_name = ?, hero_media_mime = ?, hero_focal_x = ?, hero_focal_y = ?, updated_by = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(
    req.file.filename,
    req.file.originalname || null,
    req.file.mimetype || null,
    Number.isFinite(focalX) ? Math.max(0, Math.min(1, focalX)) : 0.5,
    Number.isFinite(focalY) ? Math.max(0, Math.min(1, focalY)) : 0.45,
    req.user.username
  );
  res.json(journey.uiSettings());
});

journey.registerRoutes(app, { authRequired, organizerOrAgentRequired });

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

// With no enrichment worker, a row left 'pending' shows a permanent
// "Finding links…" spinner. On a control-plane-provisioned trip the links
// were filled at setup, so retire any stale pending rows on boot.
if (!HERMES_URL) {
  try {
    db.prepare("UPDATE phase_plan_items SET enrichment_status = 'none' WHERE enrichment_status = 'pending'").run();
    db.prepare("UPDATE phase_plan_days SET enrichment_status = 'none' WHERE enrichment_status = 'pending'").run();
  } catch { /* tables may not exist yet on a fresh db */ }
}

const extractUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function extractBookingDetails(req) {
  if (!HERMES_URL) throw Object.assign(new Error('HERMES_URL not configured'), { status: 503 });
  const url = req.body?.url;
  // The site's own "Extract Details with AI" upload (site/app.js) sends
  // pdf_base64/pdf_name as a JSON body, not multipart — req.file only gets
  // populated for an actual multipart caller (e.g. a direct API client).
  const pdfBase64 = req.file ? req.file.buffer.toString('base64') : req.body?.pdf_base64;
  const pdfName = req.file ? req.file.originalname : req.body?.pdf_name;
  if (!pdfBase64 && !url) throw Object.assign(new Error('Provide a file or url'), { status: 400 });

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
  return r.json();
}

app.post('/api/bookings/extract', authRequired, extractUpload.single('file'), async (req, res) => {
  try {
    res.json(await extractBookingDetails(req));
  } catch (e) {
    console.error('[extract proxy]', e.message);
    res.status(e.status || 500).json({ error: e.message });
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
  // Drafts are a private organizer workflow. Members only ever receive
  // approved bookings, even if they guess the status query parameter.
  const canReviewDrafts = req.user?.isAgent || normalizeOrganizers(TRIP_CONFIG.agent).includes(req.user?.username);
  if (!canReviewDrafts) wheres.push("review_status = 'approved'");
  if (phase) { wheres.push('phase = ?'); params.push(phase); }
  if (type)  { wheres.push('type = ?');  params.push(type);  }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' ORDER BY date_from, id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/bookings/extract-draft', organizerOrAgentRequired, extractUpload.single('file'), async (req, res) => {
  try {
    const extracted = await extractBookingDetails(req);
    const phase = typeof extracted.phase === 'string' ? extracted.phase : '';
    const type = typeof extracted.type === 'string' ? extracted.type : 'other';
    const name = typeof extracted.name === 'string' ? extracted.name.trim() : '';
    const validTypes = new Set(['flight', 'hotel', 'car', 'attraction', 'other']);
    if (!VALID_PLAN_PHASES.has(phase) || !validTypes.has(type) || !name) {
      return res.status(422).json({ error: 'Extraction needs a valid phase, type, and name before a draft can be created', extracted });
    }
    const text = (key) => typeof extracted[key] === 'string' && extracted[key].trim() ? extracted[key].trim() : null;
    const result = db.prepare(
      "INSERT INTO bookings (phase,type,name,date_from,date_to,passengers,confirmation,pin,notes,cost,created_by,review_status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft')"
    ).run(phase, type, name, text('date_from'), text('date_to'), text('passengers'), text('confirmation'), text('pin'), text('notes'), 0, req.user.username);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ok: true, booking, extracted });
  } catch (e) {
    console.error('[extract draft]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/bookings/:id/approve', organizerOrAgentRequired, (req, res) => {
  const result = db.prepare("UPDATE bookings SET review_status = 'approved' WHERE id = ? AND review_status = 'draft'").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'draft booking not found' });
  res.json({ ok: true });
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

// Surfaces a reviewer's rewrite as one object rather than four loose columns,
// so a caller can test `item.correction` instead of knowing the schema. The
// superseded wording rides along: the site strikes it through, and an agent
// relaying the change to the organizer can quote what it used to say.
function withCorrection(row) {
  if (!row) return row;
  if (!row.correction_note && !row.text_he_prev && !row.text_en_prev
      && !row.label_he_prev && !row.label_en_prev) return row;
  return {
    ...row,
    correction: {
      note: row.correction_note || null,
      at:   row.corrected_at || null,
      previous: {
        text_he:  row.text_he_prev  ?? null,
        text_en:  row.text_en_prev  ?? null,
        label_he: row.label_he_prev ?? null,
        label_en: row.label_en_prev ?? null,
      },
    },
  };
}

function joinBooking(item) {
  const withCorr = withCorrection(item);
  if (!item.booking_id) return withCorr;
  const bk = db.prepare('SELECT id, name, confirmation, conf_file FROM bookings WHERE id = ?').get(item.booking_id);
  return { ...withCorr, booking: bk || null };
}

const PLAN_STATUSES = new Set(['confirmed', 'needs_review']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 24-hour HH:MM. Matches what <input type="time"> submits and what the config
// schedule already uses, so a DB plan item sorts against the same shape.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// A plan item's time may be exact ("09:00") or rough ("morning"). Rough values
// are a closed vocabulary rather than free text so they stay translatable and
// sortable; the minutes below are only a sort position, never displayed.
const ROUGH_TIMES = { morning: 9 * 60, noon: 12 * 60, afternoon: 15 * 60, evening: 19 * 60 };
const ENRICHMENT_STATUSES = new Set(['none', 'pending', 'done', 'failed']);

function isValidPlanTime(t) {
  return HHMM_RE.test(t) || Object.prototype.hasOwnProperty.call(ROUGH_TIMES, t);
}

// Minutes since midnight, so an exact time and a rough one order against each
// other ("morning" lands between 08:00 and 10:00). Null time sorts last.
function planTimeSort(t) {
  if (t === undefined || t === null || t === '') return null;
  if (HHMM_RE.test(t)) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  return ROUGH_TIMES[t] ?? null;
}

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
  for (const f of ['text_he', 'text_en', 'location_url', 'time',
                   'waze_url', 'website_url', 'ticket_url']) {
    const v = body[f];
    if (v !== undefined && v !== null && !isStr(v)) return `${f} must be a string`;
  }
  const d = body.date;
  if (d !== undefined && d !== null && d !== '' && (!isStr(d) || !ISO_DATE_RE.test(d))) {
    return 'date must be YYYY-MM-DD';
  }
  const t = body.time;
  if (t !== undefined && t !== null && t !== '' && (!isStr(t) || !isValidPlanTime(t))) {
    return `time must be HH:MM (24-hour) or one of: ${Object.keys(ROUGH_TIMES).join(', ')}`;
  }
  // Every link field, not just location_url — these are rendered as hrefs, and
  // the enrichment worker writes three of them from model output.
  for (const f of ['location_url', 'waze_url', 'website_url', 'ticket_url']) {
    const u = body[f];
    if (u !== undefined && u !== null && u !== '' && !/^https?:\/\//i.test(u)) {
      return `${f} must be an http(s) URL`;
    }
  }
  const s = body.sort_order;
  if (s !== undefined && s !== null && !Number.isFinite(Number(s))) {
    return 'sort_order must be a number';
  }
  // PATCH exposes this so an operator can re-queue a single item; without a
  // check any string would land in the column, and the worker's WHERE clauses
  // would then silently never match it again.
  const es = body.enrichment_status;
  if (es !== undefined && es !== null && !ENRICHMENT_STATUSES.has(es)) {
    return `enrichment_status must be one of: ${[...ENRICHMENT_STATUSES].join(', ')}`;
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
    // time_sort, not time: a rough token would otherwise sort lexically, putting
    // "afternoon" before "morning". COALESCE parks untimed items at the end.
    'SELECT * FROM phase_plan_items WHERE phase_id = ? ' +
    'ORDER BY date ASC, sort_order ASC, COALESCE(time_sort, 99999) ASC, id ASC'
  ).all(req.params.phase_id);
  res.json(rows.map(joinBooking));
});

// Day headlines for a phase. Separate from the item list so /plan keeps its
// array shape, which the agent tools and existing callers rely on.
app.get('/api/phases/:phase_id/plan/days', authRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  res.json(db.prepare(
    'SELECT phase_id, date, label_he, label_en, enrichment_status, ' +
    'label_he_prev, label_en_prev, correction_note, corrected_at, review_status ' +
    'FROM phase_plan_days WHERE phase_id = ? ORDER BY date ASC'
  ).all(req.params.phase_id).map(withCorrection));
});

// Rewrites the leading date stamp of each given date's headline to match the
// date it now sits on, recording it as an ordinary correction so the site shows
// the old stamp struck through. Deterministic and immediate: no model, nothing
// queued, no way for it to come back with the wrong answer.
function repairStampsOn(phaseId, dates) {
  const read = db.prepare(
    'SELECT label_he, label_en, label_he_prev, label_en_prev FROM phase_plan_days WHERE phase_id = ? AND date = ?');
  const write = db.prepare(
    'UPDATE phase_plan_days SET label_he = ?, label_en = ?, ' +
    'label_he_prev = COALESCE(label_he_prev, ?), label_en_prev = COALESCE(label_en_prev, ?), ' +
    "correction_note = ?, corrected_at = datetime('now') WHERE phase_id = ? AND date = ?");
  const repaired = [];
  for (const date of dates) {
    const row = read.get(phaseId, date);
    if (!row) continue;
    const he = repairDayStamp(row.label_he, date);
    const en = repairDayStamp(row.label_en, date);
    if (!he && !en) continue;
    write.run(
      he || row.label_he, en || row.label_en,
      he ? row.label_he : null, en ? row.label_en : null,
      'date in the headline updated to the day it now falls on',
      phaseId, date
    );
    repaired.push(date);
  }
  return repaired;
}

// A date change makes wording wrong somewhere else, not where it happened:
// "tomorrow we climb Diamond Head" sits on the day BEFORE the day that moved.
// So the whole phase goes back through review, not just the dates touched.
// Rows the reviewer already corrected are re-queued too — a second swap can
// invalidate the correction the first one produced.
function queuePhaseReview(phaseId) {
  db.prepare(
    "UPDATE phase_plan_items SET review_status = 'pending', review_attempts = 0 WHERE phase_id = ?"
  ).run(phaseId);
  db.prepare(
    "UPDATE phase_plan_days SET review_status = 'pending', review_attempts = 0 WHERE phase_id = ?"
  ).run(phaseId);
}

// Every dated item belongs to a day that should have a headline; queue one if
// this is the first item on that date.
function ensurePlanDay(phaseId, date) {
  if (!date) return;
  db.prepare(
    "INSERT OR IGNORE INTO phase_plan_days (phase_id,date,enrichment_status) VALUES (?,?,?)"
  ).run(phaseId, date, HERMES_URL ? 'pending' : 'none');
}

app.post('/api/phases/:phase_id/plan', organizerOrAgentRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  const body = req.body || {};
  const bad = planFieldError(body, { requireText: true });
  if (bad) return res.status(400).json({ error: bad });
  const { date, time, text_he, text_en, location_url, booking_id, status, sort_order,
          waze_url, website_url, ticket_url } = body;
  const result = db.prepare(
    'INSERT INTO phase_plan_items (phase_id,date,time,time_sort,text_he,text_en,location_url,' +
    'waze_url,website_url,ticket_url,booking_id,status,sort_order,created_by,enrichment_status) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    req.params.phase_id,
    date || null, time || null, planTimeSort(time), text_he.trim(),
    text_en || null, location_url || null,
    waze_url || null, website_url || null, ticket_url || null,
    // Whether a booking already covers this is a lookup, not a judgment, so it
    // resolves here rather than waiting on the enrichment worker — which may be
    // minutes behind, or unreachable entirely.
    booking_id ? Number(booking_id)
               : findMatchingBooking({ phase_id: req.params.phase_id, text_he, text_en }),
    normalizePlanStatus(status) || 'confirmed',
    sort_order != null ? Number(sort_order) : 0,
    req.user.username,
    // Queued rather than enriched inline: the request returns immediately and
    // the worker fills the links in, retrying if Hermes isn't reachable. With
    // no worker configured (HERMES_URL unset — the usual case for a
    // control-plane-provisioned site, where link enrichment already ran at
    // setup) there is nothing to move it off 'pending', so it would show a
    // permanent "Finding links…" spinner — record 'none' instead.
    HERMES_URL ? 'pending' : 'none'
  );
  const created = db.prepare('SELECT * FROM phase_plan_items WHERE id = ?').get(result.lastInsertRowid);
  ensurePlanDay(req.params.phase_id, date || null);
  journey.syncFromLegacy('legacy-plan-create');
  kickEnrichmentSoon();
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
  // date comes back too: a PATCH that moves an item to another date has to
  // re-review the phase, and that needs the value it is moving away from.
  const existing = db.prepare('SELECT id, date FROM phase_plan_items WHERE id = ? AND phase_id = ?')
    .get(req.params.id, req.params.phase_id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const allowed = ['date','time','text_he','text_en','location_url','booking_id','status','sort_order',
                   'waze_url','website_url','ticket_url','enrichment_status'];
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
  // time and time_sort must never drift apart, so the derived column is written
  // alongside rather than left to a separate caller.
  if (body.time !== undefined) { updates.push('time_sort = ?'); params.push(planTimeSort(body.time)); }
  // A direct organizer rewrite supersedes any pending review correction: the
  // struck-through "corrected" indicator must not outlive the wording that
  // triggered it, or it keeps showing stale text next to what's now the
  // organizer's own deliberate edit with no way to dismiss it.
  if (body.text_he !== undefined || body.text_en !== undefined) {
    updates.push('text_he_prev = NULL', 'text_en_prev = NULL', 'correction_note = NULL', 'corrected_at = NULL');
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id, req.params.phase_id);
  db.prepare(`UPDATE phase_plan_items SET ${updates.join(', ')} WHERE id = ? AND phase_id = ?`).run(...params);
  // Moving a single item to another date is a schedule change too, and carries
  // the same risk of leaving "tomorrow we…" behind on a neighbouring day.
  // Only when the date actually moved — a text or link edit isn't a reshuffle.
  const dateMoved = body.date !== undefined && body.date !== existing.date;
  if (dateMoved) { queuePhaseReview(req.params.phase_id); kickEnrichmentSoon(); }
  const updated = db.prepare('SELECT * FROM phase_plan_items WHERE id = ? AND phase_id = ?')
    .get(req.params.id, req.params.phase_id);
  journey.syncFromLegacy('legacy-plan-update');
  res.json({ ...joinBooking(updated), ...(dateMoved ? { review: { status: HERMES_URL ? 'queued' : 'unavailable', scope: 'phase' } } : {}) });
});

app.delete('/api/phases/:phase_id/plan/:id', organizerOrAgentRequired, (req, res) => {
  if (!VALID_PLAN_PHASES.has(req.params.phase_id)) return res.status(400).json({ error: 'unknown phase' });
  const row = db.prepare('SELECT id FROM phase_plan_items WHERE id = ? AND phase_id = ?').get(req.params.id, req.params.phase_id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM phase_plan_items WHERE id = ?').run(req.params.id);
  journey.syncFromLegacy('legacy-plan-delete');
  // Every other DELETE in this file answers {ok:true}, and mcp/mcp.js's
  // apiDelete() parses the body unconditionally — a 204 made the agent's
  // delete_plan_item throw on every successful delete.
  res.json({ ok: true });
});

// ── Active-plan day headlines: the part that says what a day IS ──────────────
// Every existing writer of a headline is write-once: ensurePlanDay() inserts no
// label at all, and both the enrichment worker and promote-config-days write
// theirs through COALESCE, which only fills a NULL. So once a day had a name,
// no API call could change it — re-plan a day and its items moved while the
// headline stayed behind, describing yesterday's plan. This is the explicit
// overwrite path that was missing.
app.patch('/api/phases/:phase_id/plan/days/:date', organizerOrAgentRequired, (req, res) => {
  const phaseId = req.params.phase_id;
  if (!VALID_PLAN_PHASES.has(phaseId)) return res.status(400).json({ error: 'unknown phase' });
  const { date } = req.params;
  if (!ISO_DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const body = req.body || {};
  for (const f of ['label_he', 'label_en']) {
    if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') {
      return res.status(400).json({ error: `${f} must be a string` });
    }
  }
  if (body.label_he === undefined && body.label_en === undefined) {
    return res.status(400).json({ error: 'no fields to update' });
  }
  // Only the fields actually sent are touched; an omitted one keeps what's
  // stored rather than being cleared to NULL.
  const existing = db.prepare('SELECT label_he, label_en FROM phase_plan_days WHERE phase_id = ? AND date = ?')
    .get(phaseId, date);
  // An explicit null clears the field directly — String(null).trim() would
  // otherwise stringify it to the literal text "null" and store that.
  const pick = (f) => {
    if (body[f] === undefined) return existing?.[f] ?? null;
    if (body[f] === null) return null;
    return String(body[f]).trim() || null;
  };
  const labelHe = pick('label_he');
  const labelEn = pick('label_en');
  // A day that now has a headline has nothing left for the worker to write; one
  // whose headline was just cleared goes back in the queue instead of staying
  // blank forever.
  const status = (labelHe || labelEn) ? 'done' : (HERMES_URL ? 'pending' : 'none');
  // A direct organizer rewrite supersedes any pending review correction, the
  // same way the item PATCH above does — otherwise the struck-through
  // "corrected" indicator would keep pointing at wording the organizer has
  // since deliberately replaced, with no way to dismiss it.
  const clearCorrection = body.label_he !== undefined || body.label_en !== undefined;
  db.prepare(
    'INSERT INTO phase_plan_days (phase_id,date,label_he,label_en,enrichment_status,enrich_attempts) ' +
    'VALUES (?,?,?,?,?,0) ON CONFLICT(phase_id,date) DO UPDATE SET ' +
    'label_he = excluded.label_he, label_en = excluded.label_en, ' +
    'enrichment_status = excluded.enrichment_status, enrich_attempts = 0' +
    (clearCorrection ? ', label_he_prev = NULL, label_en_prev = NULL, correction_note = NULL, corrected_at = NULL' : '')
  ).run(phaseId, date, labelHe, labelEn, status);
  journey.syncFromLegacy('legacy-plan-day-update');
  res.json(db.prepare(
    'SELECT phase_id, date, label_he, label_en, enrichment_status FROM phase_plan_days ' +
    'WHERE phase_id = ? AND date = ?'
  ).get(phaseId, date));
});

// Swapping two days of the active plan is one operation, not a batch of edits.
// Done as N separate PATCHes there is no intermediate state that is correct —
// halfway through, both days' items carry the same date and the site renders
// them as one merged block — and a partial failure strands the schedule there.
// It also cannot move the headlines at all, so 13/8 would keep announcing
// "Diamond Head" while listing the Southeast Oahu items. Everything moves
// together, in one transaction, or nothing does.
app.post('/api/phases/:phase_id/plan/swap-days', organizerOrAgentRequired, (req, res) => {
  const phaseId = req.params.phase_id;
  if (!VALID_PLAN_PHASES.has(phaseId)) return res.status(400).json({ error: 'unknown phase' });
  const { date_a, date_b } = req.body || {};
  for (const [name, v] of [['date_a', date_a], ['date_b', date_b]]) {
    if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) {
      return res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
    }
  }
  if (date_a === date_b) return res.status(400).json({ error: 'date_a and date_b must differ' });

  db.transaction(() => {
    // One statement, not two: moving A→B and then B→A as separate UPDATEs
    // collides in the middle and lands everything on a single date.
    db.prepare(
      'UPDATE phase_plan_items SET date = CASE date WHEN ? THEN ? ELSE ? END ' +
      'WHERE phase_id = ? AND date IN (?, ?)'
    ).run(date_a, date_b, date_a, phaseId, date_a, date_b);

    // The headline describes the day's content, so it travels with it — and so
    // does any correction history riding on it: a headline the reviewer already
    // corrected once is still the same correction after it moves to a new date,
    // not something to silently forget.
    const read = db.prepare(
      'SELECT label_he, label_en, label_he_prev, label_en_prev, correction_note, corrected_at ' +
      'FROM phase_plan_days WHERE phase_id = ? AND date = ?'
    );
    const fromA = read.get(phaseId, date_a);
    const fromB = read.get(phaseId, date_b);
    db.prepare('DELETE FROM phase_plan_days WHERE phase_id = ? AND date IN (?, ?)')
      .run(phaseId, date_a, date_b);
    const write = db.prepare(
      'INSERT INTO phase_plan_days (phase_id,date,label_he,label_en,label_he_prev,label_en_prev,' +
      'correction_note,corrected_at,enrichment_status,enrich_attempts) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,0)'
    );
    // A date that carried no headline row still needs one once it holds items —
    // queued as 'pending' so the worker names it after what is now there.
    const put = (date, src) => {
      const hasItems = db.prepare(
        'SELECT 1 FROM phase_plan_items WHERE phase_id = ? AND date = ? LIMIT 1'
      ).get(phaseId, date);
      if (!src && !hasItems) return;
      write.run(phaseId, date, src?.label_he ?? null, src?.label_en ?? null,
                src?.label_he_prev ?? null, src?.label_en_prev ?? null,
                src?.correction_note ?? null, src?.corrected_at ?? null,
                (src?.label_he || src?.label_en) ? 'done' : (HERMES_URL ? 'pending' : 'none'));
    };
    put(date_a, fromB);
    put(date_b, fromA);
    // A headline that stamps its own date is now stamped with the date it came
    // from. That repair is arithmetic, so it happens here and now rather than
    // being queued for a model — which got it wrong in practice anyway.
    repairStampsOn(phaseId, [date_a, date_b]);
  })();

  // Read back both days in the same response. Verifying a swap means looking at
  // what the schedule says afterwards, not at whether the write returned 200.
  const items = db.prepare(
    'SELECT * FROM phase_plan_items WHERE phase_id = ? AND date IN (?, ?) ' +
    'ORDER BY date ASC, sort_order ASC, COALESCE(time_sort, 99999) ASC, id ASC'
  ).all(phaseId, date_a, date_b);
  // Same columns as GET /plan/days, so a swap response and a fresh fetch carry
  // the same shape — including `correction`, which repairStampsOn() may have
  // just written synchronously above. Without it, an agent reading this
  // response straight off the swap (as swap_plan_days's own tool description
  // tells it to) would have no way to see that a headline was just rewritten.
  const days = db.prepare(
    'SELECT phase_id, date, label_he, label_en, enrichment_status, ' +
    'label_he_prev, label_en_prev, correction_note, corrected_at, review_status ' +
    'FROM phase_plan_days WHERE phase_id = ? AND date IN (?, ?) ORDER BY date ASC'
  ).all(phaseId, date_a, date_b).map(withCorrection);
  // Wording that referred to the old order is now wrong somewhere in this
  // phase. Queued, not run inline: a Hermes call takes ~30-90s and the laptop
  // it runs on is routinely closed — a schedule edit must not depend on that.
  queuePhaseReview(phaseId);
  journey.syncFromLegacy('legacy-plan-swap-days');
  kickEnrichmentSoon();
  res.json({
    ok: true, phase_id: phaseId, swapped: [date_a, date_b], days,
    items: items.map(joinBooking),
    // The caller has to come back for this. get_phase_plan returns whatever
    // the reviewer has written by then, and an agent that made this change is
    // expected to relay those corrections to the organizer.
    review: {
      status: HERMES_URL ? 'queued' : 'unavailable',
      scope:  'phase',
      detail: HERMES_URL
        ? 'Descriptions mentioning a day ("tomorrow", "Thursday", a date) may now be wrong. ' +
          'Re-read get_phase_plan shortly and relay any item or day carrying a `correction` to the organizer.'
        : 'No reviewer configured (HERMES_URL unset) — descriptions were not checked for stale day references.',
    },
  });
});

// ── Plan-item AI enrichment ───────────────────────────────────────────────────
// Enrichment runs out-of-band, never inside the save request. Hermes lives on
// the organizer's own machine (mcp/mcp.js shells out to the hermes CLI), so it
// is routinely unreachable — a laptop that's closed. An item therefore stays
// 'pending' and is retried on the next pass rather than being marked failed and
// forgotten. Attempts are capped so a permanently bad item stops burning calls.
const ENRICH_MAX_ATTEMPTS = 4;
const ENRICH_INTERVAL_MS  = 30000;
const ENRICH_BATCH        = 3;
let enrichTimer = null;
let enrichRunning = false;

// Items and day headlines are both worked by the same pass, so "in flight"
// has to count both or the button under-reports and looks stalled.
function enrichableCount() {
  const items = db.prepare(
    "SELECT COUNT(*) c FROM phase_plan_items WHERE enrichment_status = 'pending' AND enrich_attempts < ?"
  ).get(ENRICH_MAX_ATTEMPTS).c;
  const days = db.prepare(
    "SELECT COUNT(*) c FROM phase_plan_days WHERE enrichment_status = 'pending' AND enrich_attempts < ?"
  ).get(ENRICH_MAX_ATTEMPTS).c;
  return items + days;
}

async function enrichOne(item) {
  const r = await fetch(`${HERMES_URL}/enrich`, {
    method: 'POST',
    headers: { 'X-API-Key': HERMES_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: item.text_en || item.text_he,
      text_he: item.text_he,
      date: item.date || null,
      // Phase title gives the model the city/region, without which "the museum"
      // is unresolvable.
      context: (TRIP_CONFIG.phases || []).find(p => p.id === item.phase_id)?.title || null,
    }),
    // Must outlast trip-mcp's own 90s CLI budget, or this side gives up while
    // the model is still legitimately working and the item looks like a failure.
    timeout: 100000,
    // Belt and braces. node-fetch@2 honours `timeout`, but that is an
    // implementation detail of this one dependency — native fetch and
    // node-fetch@3 both ignore it silently. If it ever stopped working here a
    // single hung call would leave enrichRunning stuck true and stall the whole
    // enrichment subsystem, with nothing logged, until a restart.
    signal: AbortSignal.timeout(100000),
  });
  if (!r.ok) throw new Error(`hermes ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Only http(s) survives; anything else is dropped rather than stored, so the
// renderer never has to trust model output.
function cleanLink(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

function cleanBool(v) {
  if (v === true || v === 1 || v === 'true') return 1;
  if (v === false || v === 0 || v === 'false') return 0;
  return null;                       // "didn't say" stays distinct from "no"
}

// Deterministic booking match — whether tickets are already paid for is a fact
// sitting in the bookings table, so it is looked up here rather than asked of
// the model (same reasoning as resolveCost() doing its own currency maths).
// Requires a distinctive token match, so "Tokyo" alone can't link a booking.
const MATCH_STOPWORDS = new Set([
  'the', 'and', 'tour', 'ticket', 'tickets', 'admission', 'visit', 'entry', 'pass',
  'day', 'trip', 'hotel', 'to', 'at', 'in', 'of', 'a', 'an',
]);

// Three characters, not four: real venue names lean on short words — SHIBUYA
// SKY, Tokyo Bay, Ueno Zoo — and a 4-char floor silently dropped them, leaving
// a single token that then failed the two-hit rule. Generic short words are
// excluded by the stopword list instead of by length.
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(w => w.length >= 3 && !MATCH_STOPWORDS.has(w));
}

function findMatchingBooking(item) {
  const hay = new Set([...tokenize(item.text_en), ...tokenize(item.text_he)]);
  if (!hay.size) return null;
  const candidates = db.prepare(
    'SELECT id, name, phase, confirmation FROM bookings WHERE phase = ?'
  ).all(item.phase_id);
  let best = null;
  for (const b of candidates) {
    const toks = tokenize(b.name);
    if (!toks.length) continue;
    const hits = toks.filter(t => hay.has(t)).length;
    // Two distinctive words minimum. A single shared word is not enough — a
    // booking called "Museum Admission Ticket" reduces to just "museum" and
    // would otherwise claim every museum on the trip. Failing to link is
    // recoverable (the organizer links it by hand); wrongly showing a green
    // "already booked" tag sends someone to a gate they haven't paid for.
    if (hits >= 2) {
      if (!best || hits > best.hits) best = { id: b.id, hits };
    }
  }
  return best ? best.id : null;
}

// A day with no headline gets one written from its own items — the same idea as
// item enrichment, but summarising rather than looking anything up.
async function enrichDay(day) {
  const items = db.prepare(
    'SELECT time, text_he, text_en FROM phase_plan_items WHERE phase_id = ? AND date = ? ' +
    'ORDER BY COALESCE(time_sort, 99999) ASC, id ASC LIMIT 20'
  ).all(day.phase_id, day.date);
  if (!items.length) return null;
  const r = await fetch(`${HERMES_URL}/enrich`, {
    method: 'POST',
    headers: { 'X-API-Key': HERMES_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'day',
      date: day.date,
      context: (TRIP_CONFIG.phases || []).find(p => p.id === day.phase_id)?.title || null,
      items: items.map(i => ({ time: i.time, text: i.text_en || i.text_he })),
    }),
    timeout: 100000,
    // Belt and braces. node-fetch@2 honours `timeout`, but that is an
    // implementation detail of this one dependency — native fetch and
    // node-fetch@3 both ignore it silently. If it ever stopped working here a
    // single hung call would leave enrichRunning stuck true and stall the whole
    // enrichment subsystem, with nothing logged, until a restart.
    signal: AbortSignal.timeout(100000),
  });
  if (!r.ok) throw new Error(`hermes ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function runDayEnrichmentPass() {
  // Only days that actually lack a headline — the write COALESCEs, so running
  // the model for a day that already has one would be a wasted call.
  const days = db.prepare(
    "SELECT * FROM phase_plan_days WHERE enrichment_status = 'pending' AND enrich_attempts < ? " +
    '  AND label_he IS NULL AND label_en IS NULL ' +
    'ORDER BY date ASC LIMIT ?'
  ).all(ENRICH_MAX_ATTEMPTS, ENRICH_BATCH);

  for (const day of days) {
    db.prepare('UPDATE phase_plan_days SET enrich_attempts = enrich_attempts + 1 WHERE phase_id = ? AND date = ?')
      .run(day.phase_id, day.date);
    try {
      const out = await enrichDay(day);
      if (!out) {                       // no items yet — nothing to summarise
        db.prepare("UPDATE phase_plan_days SET enrichment_status = 'none', enrich_attempts = 0 WHERE phase_id = ? AND date = ?")
          .run(day.phase_id, day.date);
        continue;
      }
      // stripTags, not just trim: the renderer puts a day headline through
      // _biSpan(), which emits raw HTML by design so hand-authored config
      // markup keeps working. A model-written label must therefore arrive as
      // plain text — and its content is reachable by any family member, since
      // POST /api/bookings is only authRequired and its notes feed the import
      // that this headline summarises.
      const he = typeof out.label_he === 'string' ? stripTags(out.label_he).slice(0, 120) : null;
      const en = typeof out.label_en === 'string' ? stripTags(out.label_en).slice(0, 120) : null;
      db.prepare(
        "UPDATE phase_plan_days SET label_he = COALESCE(label_he, ?), label_en = COALESCE(label_en, ?), " +
        "enrichment_status = 'done', enriched_at = datetime('now') WHERE phase_id = ? AND date = ?"
      ).run(he, en, day.phase_id, day.date);
    } catch (e) {
      const a = db.prepare('SELECT enrich_attempts a FROM phase_plan_days WHERE phase_id = ? AND date = ?')
        .get(day.phase_id, day.date)?.a || 0;
      if (a >= ENRICH_MAX_ATTEMPTS) {
        db.prepare("UPDATE phase_plan_days SET enrichment_status = 'failed' WHERE phase_id = ? AND date = ?")
          .run(day.phase_id, day.date);
      }
      console.error(`[enrich] day ${day.phase_id}/${day.date} attempt ${a}: ${e.message}`);
    }
  }
}

async function runEnrichmentPass() {
  if (enrichRunning || !HERMES_URL) return;
  enrichRunning = true;
  try {
    const batch = db.prepare(
      "SELECT * FROM phase_plan_items WHERE enrichment_status = 'pending' AND enrich_attempts < ? " +
      'ORDER BY id ASC LIMIT ?'
    ).all(ENRICH_MAX_ATTEMPTS, ENRICH_BATCH);

    for (const item of batch) {
      db.prepare('UPDATE phase_plan_items SET enrich_attempts = enrich_attempts + 1 WHERE id = ?').run(item.id);
      try {
        const out = await enrichOne(item);
        // Link a real booking if one plainly matches, but never overwrite a
        // link an organizer or agent already set by hand.
        const bookingId = item.booking_id || findMatchingBooking(item);
        db.prepare(
          "UPDATE phase_plan_items SET location_url = COALESCE(?, location_url), waze_url = ?, " +
          'website_url = ?, ticket_url = ?, needs_tickets = ?, advance_booking = ?, ' +
          "booking_id = COALESCE(?, booking_id), enrichment_status = 'done', " +
          "enriched_at = datetime('now') WHERE id = ?"
        ).run(cleanLink(out.maps_url), cleanLink(out.waze_url),
              cleanLink(out.website_url), cleanLink(out.ticket_url),
              cleanBool(out.needs_tickets), cleanBool(out.advance_booking),
              bookingId, item.id);
      } catch (e) {
        const attempts = db.prepare('SELECT enrich_attempts a FROM phase_plan_items WHERE id = ?').get(item.id)?.a || 0;
        if (attempts >= ENRICH_MAX_ATTEMPTS) {
          db.prepare("UPDATE phase_plan_items SET enrichment_status = 'failed' WHERE id = ?").run(item.id);
        }
        console.error(`[enrich] item ${item.id} attempt ${attempts}: ${e.message}`);
      }
    }
    // Days last: a headline is summarised from the day's items, so it reads
    // better once those items have been through enrichment themselves.
    await runDayEnrichmentPass();
    // Review last of all: it judges wording against the schedule as a whole, so
    // it should see headlines that this same pass may have just written.
    await runScheduleReviewPass();
  } finally {
    enrichRunning = false;
  }
}

// ── Post-reorder wording review ──────────────────────────────────────────────
// One call per phase, not per item: "is this sentence still true?" can only be
// answered against the whole day-by-day schedule, and a per-item call would ask
// the model to judge a line with no idea what day it now sits on.
const REVIEW_MAX_ATTEMPTS = 3;

function phaseScheduleForReview(phaseId) {
  const items = db.prepare(
    'SELECT id, date, time, text_he, text_en FROM phase_plan_items WHERE phase_id = ? ' +
    'ORDER BY date ASC, sort_order ASC, COALESCE(time_sort, 99999) ASC, id ASC'
  ).all(phaseId);
  const labelRows = db.prepare('SELECT date, label_he, label_en FROM phase_plan_days WHERE phase_id = ?').all(phaseId);
  const labels = Object.fromEntries(labelRows.map(d => [d.date, d]));
  const byDate = new Map();
  const dayEntry = (date) => {
    const key = date || 'unscheduled';
    if (!byDate.has(key)) {
      byDate.set(key, {
        date: date || null,
        weekday: date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }) : null,
        label_he: labels[date]?.label_he || null,
        label_en: labels[date]?.label_en || null,
        items: [],
      });
    }
    return byDate.get(key);
  };
  for (const it of items) {
    dayEntry(it.date).items.push({ id: it.id, time: it.time || null, text_he: it.text_he, text_en: it.text_en });
  }
  // A day may carry a headline with no items under it at all (set via
  // set_plan_day_label before anything was scheduled) — it still needs to be
  // reviewed, so it can't be reached only by walking items.
  for (const d of labelRows) dayEntry(d.date);
  return [...byDate.values()].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

async function reviewPhase(phaseId, days) {
  const r = await fetch(`${HERMES_URL}/enrich`, {
    method: 'POST',
    headers: { 'X-API-Key': HERMES_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'schedule_review',
      context: (TRIP_CONFIG.phases || []).find(p => p.id === phaseId)?.title || null,
      days,
    }),
    timeout: 120000,
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`hermes ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Writes one correction, keeping the superseded wording. Never overwrites an
// existing *_prev: after two reorders the ORIGINAL is what an organizer wants
// to see struck through, not the reviewer's own previous attempt.
//
// Scoped by phase_id, not id alone: item ids are one auto-increment sequence
// shared across every phase, so a correction the reviewer meant for phase A
// could otherwise silently land on an unrelated row that just happens to
// share that id in phase B.
function applyItemCorrection(phaseId, c, note) {
  const row = db.prepare('SELECT text_he, text_en, text_he_prev, text_en_prev FROM phase_plan_items WHERE id = ? AND phase_id = ?').get(c.id, phaseId);
  if (!row) return false;
  const changedHe = c.text_he !== undefined && c.text_he !== row.text_he;
  const changedEn = c.text_en !== undefined && c.text_en !== row.text_en;
  if (!changedHe && !changedEn) return false;
  db.prepare(
    'UPDATE phase_plan_items SET ' +
    'text_he = COALESCE(?, text_he), text_en = COALESCE(?, text_en), ' +
    'text_he_prev = COALESCE(text_he_prev, ?), text_en_prev = COALESCE(text_en_prev, ?), ' +
    "correction_note = ?, corrected_at = datetime('now'), status = 'needs_review' " +
    'WHERE id = ? AND phase_id = ?'
  ).run(
    changedHe ? c.text_he : null, changedEn ? c.text_en : null,
    changedHe ? row.text_he : null, changedEn ? row.text_en : null,
    note, c.id, phaseId
  );
  return true;
}

// The description part of a headline, with any leading date/weekday stamp
// removed — "Thu 13/8 — Tsukiji, Ginza" and "Wed 40/9 — Tsukiji, Ginza" are the
// same day being described, differently dated. Shares shared/day-stamp.js's
// stamp parsing rather than re-detecting it with a narrower one: that one only
// stripped an em dash, so a stamp separated by an en dash or hyphen (both of
// which STAMP_RE itself accepts) slipped through with the date still attached,
// and this safety check could then miss content that had actually moved.
function headlineGist(label) {
  return stampRest(label).toLowerCase().replace(/[\s.,:;·/–—-]+/g, ' ').trim();
}

// Seen on the first real run: asked to repair stale dates after a swap, the
// reviewer corrected the dates AND handed each day the OTHER day's description,
// quietly half-undoing the swap. A headline whose new text is another date's
// current headline is not a repair, it is content moving between days — which
// the reviewer is explicitly forbidden to do. Refuse it here too, because a
// prompt is guidance and this is an invariant.
function dayCorrectionMovesContent(phaseId, c) {
  const others = db.prepare(
    'SELECT date, label_he, label_en FROM phase_plan_days WHERE phase_id = ? AND date != ?'
  ).all(phaseId, c.date);
  const proposed = [c.label_he, c.label_en].filter(Boolean).map(headlineGist).filter(Boolean);
  if (!proposed.length) return false;
  return others.some(o =>
    [o.label_he, o.label_en].filter(Boolean).map(headlineGist)
      .some(gist => gist && proposed.includes(gist)));
}

function applyDayCorrection(phaseId, c, note) {
  const row = db.prepare('SELECT label_he, label_en FROM phase_plan_days WHERE phase_id = ? AND date = ?')
    .get(phaseId, c.date);
  if (!row) return false;
  if (dayCorrectionMovesContent(phaseId, c)) {
    console.error(`[review] ${phaseId} ${c.date}: refused a headline that belongs to another date`);
    return false;
  }
  const changedHe = c.label_he !== undefined && c.label_he !== row.label_he;
  const changedEn = c.label_en !== undefined && c.label_en !== row.label_en;
  if (!changedHe && !changedEn) return false;
  db.prepare(
    'UPDATE phase_plan_days SET ' +
    'label_he = COALESCE(?, label_he), label_en = COALESCE(?, label_en), ' +
    'label_he_prev = COALESCE(label_he_prev, ?), label_en_prev = COALESCE(label_en_prev, ?), ' +
    "correction_note = ?, corrected_at = datetime('now') " +
    'WHERE phase_id = ? AND date = ?'
  ).run(
    changedHe ? c.label_he : null, changedEn ? c.label_en : null,
    changedHe ? row.label_he : null, changedEn ? row.label_en : null,
    note, phaseId, c.date
  );
  return true;
}

async function runScheduleReviewPass() {
  if (!HERMES_URL) return;
  // A phase whose active plan is headline-only (days set via
  // set_plan_day_label but no items under them yet) has nothing in
  // phase_plan_items at all — discovering pending phases from that table
  // alone left such a phase queued forever, its attempts ceiling never
  // engaging either since that too was only ever computed over items.
  const phases = db.prepare(
    "SELECT DISTINCT phase_id FROM (" +
    "  SELECT phase_id, review_status, review_attempts FROM phase_plan_items " +
    '  UNION ALL ' +
    "  SELECT phase_id, review_status, review_attempts FROM phase_plan_days" +
    ") WHERE review_status = 'pending' AND review_attempts < ?"
  ).all(REVIEW_MAX_ATTEMPTS).map(r => r.phase_id);

  for (const phaseId of phases) {
    db.prepare(
      'UPDATE phase_plan_items SET review_attempts = review_attempts + 1 WHERE phase_id = ? AND review_status = ?'
    ).run(phaseId, 'pending');
    db.prepare(
      'UPDATE phase_plan_days SET review_attempts = review_attempts + 1 WHERE phase_id = ? AND review_status = ?'
    ).run(phaseId, 'pending');
    try {
      const days = phaseScheduleForReview(phaseId);
      const { corrections = [] } = await reviewPhase(phaseId, days);
      let applied = 0;
      db.transaction(() => {
        for (const c of corrections) {
          const note = c.note || 'wording referred to the previous day order';
          if (c.kind === 'item' ? applyItemCorrection(phaseId, c, note) : applyDayCorrection(phaseId, c, note)) applied++;
        }
        db.prepare("UPDATE phase_plan_items SET review_status = 'done' WHERE phase_id = ? AND review_status = 'pending'").run(phaseId);
        db.prepare("UPDATE phase_plan_days  SET review_status = 'done' WHERE phase_id = ? AND review_status = 'pending'").run(phaseId);
      })();
      if (applied) console.log(`[review] ${phaseId}: corrected ${applied} line(s) after a reorder`);
    } catch (e) {
      const attempts = db.prepare(
        'SELECT MAX(a) a FROM (' +
        '  SELECT review_attempts a FROM phase_plan_items WHERE phase_id = ?' +
        '  UNION ALL' +
        '  SELECT review_attempts a FROM phase_plan_days WHERE phase_id = ?' +
        ')'
      ).get(phaseId, phaseId)?.a || 0;
      if (attempts >= REVIEW_MAX_ATTEMPTS) {
        db.prepare("UPDATE phase_plan_items SET review_status = 'failed' WHERE phase_id = ? AND review_status = 'pending'").run(phaseId);
        db.prepare("UPDATE phase_plan_days  SET review_status = 'failed' WHERE phase_id = ? AND review_status = 'pending'").run(phaseId);
      }
      console.error(`[review] phase ${phaseId} attempt ${attempts}: ${e.message}`);
    }
  }
}

// Nudges the loop so a freshly-saved item doesn't wait a full interval, without
// running the model inside the request.
function kickEnrichmentSoon() {
  if (!HERMES_URL) return;
  setTimeout(() => { runEnrichmentPass().catch(() => {}); }, 500).unref?.();
}

if (HERMES_URL) {
  enrichTimer = setInterval(() => { runEnrichmentPass().catch(() => {}); }, ENRICH_INTERVAL_MS);
  enrichTimer.unref?.();
}

// Backfill: queue everything that has never been enriched. Deliberately
// organizer-triggered rather than an automatic sweep, so deploying this doesn't
// fire a batch of model calls at every item that already exists.
app.post('/api/phase-plan/enrich-pending', organizerOrAgentRequired, (req, res) => {
  // No enrichment worker (HERMES_URL unset — the usual case for a
  // control-plane-provisioned trip): don't move anything to 'pending', or every
  // line would render a permanent "Finding links…". The links this button would
  // fetch were already baked into the config at trip setup. Also sweep any
  // rows a pre-fix press left stuck.
  if (!HERMES_URL) {
    db.prepare("UPDATE phase_plan_items SET enrichment_status = 'none' WHERE enrichment_status = 'pending'").run();
    db.prepare("UPDATE phase_plan_days SET enrichment_status = 'none' WHERE enrichment_status = 'pending'").run();
    return res.json({ queued: 0, in_flight: 0, hermes_configured: false });
  }
  // Requeue what was never attempted ('none'/NULL), what gave up ('failed'),
  // and what is stuck — 'pending' with its attempts exhausted, which the worker
  // skips forever. A 'pending' item that still has attempts left is already
  // being worked on; resetting it would only restart its backoff.
  const info = db.prepare(
    "UPDATE phase_plan_items SET enrichment_status = 'pending', enrich_attempts = 0 " +
    "WHERE enrichment_status IS NULL OR enrichment_status IN ('none','failed') " +
    '   OR (enrichment_status = \'pending\' AND enrich_attempts >= ?)'
  ).run(ENRICH_MAX_ATTEMPTS);
  // Everything the worker will actually pick up, including what was just
  // requeued. Without this the button reported "0" whenever items were already
  // in flight, which looked identical to it being broken.
  // Days with no headline are part of the same backfill — a schedule missing
  // its day titles is exactly what an organizer clicks this to fix.
  const dayInfo = db.prepare(
    "UPDATE phase_plan_days SET enrichment_status = 'pending', enrich_attempts = 0 " +
    "WHERE (label_he IS NULL AND label_en IS NULL) " +
    "  AND (enrichment_status IS NULL OR enrichment_status IN ('none','failed') " +
    '       OR (enrichment_status = \'pending\' AND enrich_attempts >= ?))'
  ).run(ENRICH_MAX_ATTEMPTS);
  const inFlight = enrichableCount();
  kickEnrichmentSoon();
  res.json({
    queued: info.changes + dayInfo.changes,
    in_flight: inFlight,
    hermes_configured: !!HERMES_URL,
  });
});

// ── Seed the active plan from the original plan ──────────────────────────────
// The original plan (phases[].days[] in trip.config.json) is read-only and
// can't be enriched. This copies it into phase_plan_items once, so the schedule
// an organizer already has becomes the active plan — editable and enrichable.
// The original stays exactly where it is; it keeps rendering below, organizer-
// only, as the "original schedule", so nothing is replaced.
//
// This is also the right way to start editing a phase whose active plan is
// still empty: renderDays() switches a phase to the active plan on its FIRST
// item, so adding items one at a time would hide the rest of that phase's
// schedule from participants until the last one lands.

// Config day text may contain markup: the USA-2026-style inline <a> links are
// authored straight into trip.config.json and rendered raw by _biSpan. Plan
// items are escaped on render, so that markup would show up as literal tags.
// The href is worth keeping though, so pull the first map link out first.
function firstMapHref(html) {
  const m = String(html || '').match(/href="(https?:\/\/[^"]*(?:google\.[^"]*maps|maps\.google|waze\.com)[^"]*)"/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

// Every anchor in an authored config item, with the place name it wrapped.
// A single item routinely names half a dozen places, each linked — keeping only
// the first threw away navigation the organizer had already done by hand.
function allConfigLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const url = decodeEntities(m[1]);
    const label = stripTags(m[2]);
    if (!/^https?:\/\//i.test(url) || !label || seen.has(url)) continue;
    seen.add(url);
    out.push({ label, url });
  }
  return out;
}

function decodeEntities(s) {
  // &amp;amp; appears in real data — an earlier migration escaped an already
  // escaped ampersand — so this loops rather than substituting once.
  let prev = String(s ?? '');
  for (let i = 0; i < 3; i++) {
    const next = prev
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

app.post('/api/phase-plan/promote-config-days', organizerOrAgentRequired, (req, res) => {
  const created = [];
  const skipped = [];
  // No enrichment worker (HERMES_URL unset) → 'none', not a permanent
  // "Finding links…"; link enrichment for a provisioned trip ran at setup.
  const enrichSeed = HERMES_URL ? 'pending' : 'none';
  const insert = db.prepare(
    'INSERT OR IGNORE INTO phase_plan_items ' +
    '(phase_id,date,time,time_sort,text_he,text_en,location_url,waze_url,ticket_url,extra_links,booking_id,status,sort_order,created_by,enrichment_status,config_ref) ' +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?)"
  );
  // Re-running promote repairs a row whose links weren't available (or the
  // column didn't exist) the first time — filling only what is still NULL, so
  // an organizer edit is never stomped. Not gated on extra_links: a row
  // promoted from an inline-linked config item has non-null extra_links but
  // may still be missing a Waze / ticket sibling a later enrichment added.
  const backfillLinks = db.prepare(
    'UPDATE phase_plan_items SET ' +
    'extra_links = COALESCE(extra_links, ?), location_url = COALESCE(location_url, ?), ' +
    'waze_url = COALESCE(waze_url, ?), ticket_url = COALESCE(ticket_url, ?) ' +
    'WHERE config_ref = ?'
  );
  // Provision-time enrichment attaches maps/waze/url straight onto a config day
  // item (matched from phases[].venues[]) — siblings of text/time, never inline
  // <a>, so allConfigLinks()/firstMapHref() below never see them.
  const httpOrNull = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

  const upsertDay = db.prepare(
    'INSERT INTO phase_plan_days (phase_id,date,label_he,label_en,enrichment_status) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(phase_id,date) DO UPDATE SET ' +
    '  label_he = COALESCE(phase_plan_days.label_he, excluded.label_he), ' +
    '  label_en = COALESCE(phase_plan_days.label_en, excluded.label_en), ' +
    // The row may already exist as 'pending' because a dated item was added
    // before promoting. Once it has a headline there is nothing left to write,
    // so clear it rather than spend an enrichment call that COALESCE discards.
    '  enrichment_status = CASE WHEN COALESCE(phase_plan_days.label_he, excluded.label_he) IS NOT NULL ' +
    '                             OR COALESCE(phase_plan_days.label_en, excluded.label_en) IS NOT NULL ' +
    "                        THEN 'done' ELSE phase_plan_days.enrichment_status END"
  );

  for (const phase of (TRIP_CONFIG.phases || [])) {
    (phase.days || []).forEach((day, di) => {
      // Carry the day's headline across. A day that has none is queued so the
      // worker can write one from the day's own items.
      if (day.date) {
        const he = stripTags(day.label?.he ?? day.label ?? '');
        const en = stripTags(day.label?.en ?? '');
        upsertDay.run(phase.id, day.date, he || null, en || null,
                      (he || en) ? 'done' : enrichSeed);
      }
      (day.items || []).forEach((item, ii) => {
        const ref = `${phase.id}|${day.date || `d${di}`}|${ii}`;
        const links = [...allConfigLinks(item.text?.he), ...allConfigLinks(item.text?.en)]
          .filter((l, i, arr) => arr.findIndex(x => x.url === l.url) === i);
        const linksJson = links.length ? JSON.stringify(links) : null;

        const mapsHref  = firstMapHref(item.text?.he) || firstMapHref(item.text?.en) || httpOrNull(item.maps);
        const wazeHref  = httpOrNull(item.waze);
        const ticketHref = httpOrNull(item.url);

        const existing = db.prepare(
          'SELECT location_url, waze_url, ticket_url, extra_links FROM phase_plan_items WHERE config_ref = ?'
        ).get(ref);
        if (existing) {
          // Only report a backfill when a NULL column actually had a value to take.
          const filled =
            (existing.extra_links  == null && linksJson  != null) ||
            (existing.location_url == null && mapsHref    != null) ||
            (existing.waze_url     == null && wazeHref    != null) ||
            (existing.ticket_url   == null && ticketHref  != null);
          if (filled) backfillLinks.run(linksJson, mapsHref, wazeHref, ticketHref, ref);
          skipped.push({ config_ref: ref, reason: filled ? 'already promoted (links backfilled)' : 'already promoted' });
          return;
        }
        const rawTime = typeof item.time === 'string' ? item.time.trim() : '';
        const time = isValidPlanTime(rawTime) ? rawTime : null;
        // A config schedule may carry a range ("06:30–07:00"), which the plan
        // item's time column can't represent. Keep it in the text rather than
        // dropping a detail the organizer wrote.
        const prefix = rawTime && !time ? `${rawTime} — ` : '';
        const he = prefix + stripTags(item.text?.he ?? item.text ?? '');
        const en = prefix + stripTags(item.text?.en ?? '');
        if (!he && !en) { skipped.push({ config_ref: ref, reason: 'no text' }); return; }

        const info = insert.run(
          phase.id, day.date || null, time, planTimeSort(time),
          he || en, en || null,
          mapsHref, wazeHref, ticketHref,
          linksJson,
          findMatchingBooking({ phase_id: phase.id, text_he: he, text_en: en }),
          di * 1000 + ii, req.user.username, enrichSeed, ref
        );
        if (info.changes) created.push({ id: info.lastInsertRowid, phase_id: phase.id, config_ref: ref });
        else skipped.push({ config_ref: ref, reason: 'already promoted' });
      });
    });
  }
  kickEnrichmentSoon();
  journey.syncFromLegacy('legacy-promote-config-days');
  res.json({ created: created.length, skipped: skipped.length, items: created });
});

// ── Export the enriched plan back into trip.config.json ──────────────────────
// Deliberately API-only: no button anywhere. This rewrites the trip's source of
// truth — the file that --sync-config pushes and that people hand-edit — so it
// should be a considered act, not something reachable by a stray tap on a phone.
// Writes through persistConfigChange(), which snapshots into
// trip_config_versions, so an export is revertible.
//
// Enrichment links are folded into the day item text as inline <a>, because
// phases[].days[] has no field for them and _biSpan renders text raw. That
// matches how such links are authored by hand today.
function planItemToConfigItem(item) {
  const links = [
    [item.location_url, '🗺️'],
    [item.waze_url,     '🔵'],
    [item.website_url,  '🌐'],
    [item.ticket_url,   '🎟️'],
  ].filter(([u]) => typeof u === 'string' && /^https?:\/\//i.test(u));

  const suffix = links
    .map(([u, icon]) => ` <a href="${escapeConfigAttr(u)}" target="_blank" rel="noopener">${icon}</a>`)
    .join('');

  const flag = item.booking_id ? '' : (item.needs_tickets ? ' 🎟️' : '');
  const out = { text: {} };
  if (item.time) out.time = item.time;
  out.text.he = `${escapeConfigText(item.text_he || '')}${flag}${suffix}`;
  out.text.en = `${escapeConfigText(item.text_en || item.text_he || '')}${flag}${suffix}`;
  return out;
}

// The stored text is plain (plan items are escaped on render). Going back into
// the config it becomes raw HTML again, so the text itself must be escaped or a
// stray '<' would break the day block for everyone.
function escapeConfigText(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeConfigAttr(s) {
  return escapeConfigText(s).replace(/"/g, '&quot;');
}

app.post('/api/phase-plan/export-to-config', organizerOrAgentRequired, (req, res) => {
  if (!TRIP_CONFIG_RAW) return res.status(503).json({ error: 'trip config not loaded' });
  const phases = [];

  for (const phase of (TRIP_CONFIG.phases || [])) {
    const items = db.prepare(
      'SELECT * FROM phase_plan_items WHERE phase_id = ? AND date IS NOT NULL ' +
      'ORDER BY date ASC, sort_order ASC, COALESCE(time_sort, 99999) ASC, id ASC'
    ).all(phase.id);
    if (!items.length) continue;

    const byDate = new Map();
    for (const it of items) {
      if (!byDate.has(it.date)) byDate.set(it.date, []);
      byDate.get(it.date).push(it);
    }

    const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
      const meta = db.prepare('SELECT label_he, label_en FROM phase_plan_days WHERE phase_id = ? AND date = ?')
        .get(phase.id, date);
      // Fall back to whatever the config already called this day, so an export
      // can't blank out a headline the plan layer never had.
      const prev = (phase.days || []).find(d => d.date === date);
      return {
        date,
        label: {
          he: meta?.label_he || prev?.label?.he || date,
          en: meta?.label_en || prev?.label?.en || meta?.label_he || date,
        },
        items: rows.map(planItemToConfigItem),
      };
    });

    phase.days = days;
    phases.push({ phase_id: phase.id, days: days.length, items: items.length });
  }

  if (!phases.length) return res.status(400).json({ error: 'no dated plan items to export' });
  persistConfigChange();
  const version = db.prepare('SELECT version FROM trip_config_versions ORDER BY version DESC LIMIT 1').get()?.version;
  res.json({ exported: phases, config_version: version ?? null });
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
  journey.syncFromLegacy('legacy-import-from-bookings');
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
const HOST = process.env.HOST || undefined;
app.listen(PORT, HOST, () => console.log(`Trip server running on ${HOST || '*'}:${PORT}`));
