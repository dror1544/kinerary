'use strict';

process.on('uncaughtException',  e => { console.error('[trip-mcp] uncaughtException:', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('[trip-mcp] unhandledRejection:', e); process.exit(1); });

/**
 * Trip-site MCP server — HTTP/SSE transport.
 *
 * Works two ways, same server either way:
 *
 * 1. Local agent (e.g. a Hermes/OpenClaw-style always-on assistant on your
 *    own machine/LAN): point it at http://127.0.0.1:3001/sse with header
 *    X-API-Key: <MCP_API_KEY>, and set API_BASE_URL to wherever the trip
 *    site's Express server actually runs (e.g. http://trip-server:3000
 *    inside Docker Compose, or your LAN host otherwise).
 *
 * 2. Claude Cowork / a remote custom connector: this needs a
 *    publicly-reachable HTTPS URL (Cowork's Connectors are remote MCP
 *    servers, not local-only) — put this behind whatever tunnel/reverse
 *    proxy you already use for the site itself (Cloudflare Tunnel, etc.),
 *    then add it as a custom connector with the same X-API-Key header.
 *
 * One instance = one trip (via API_BASE_URL). Run a separate instance per
 * trip if you want an agent to help across more than one at a time.
 */

const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z }                  = require('zod');
const express                = require('express');
const fetch                  = require('node-fetch');

const MCP_PORT    = parseInt(process.env.MCP_PORT || '3001');
const API_BASE    = (process.env.API_BASE_URL || 'http://trip-server:3000').replace(/\/$/, '');
// Public HTTPS fallback for when API_BASE (usually a Docker-internal host) is
// unreachable from wherever this MCP server actually runs — e.g. Claude Cowork.
// No hardcoded default: every deployment has a different public URL, or none.
const PUBLIC_API_BASE = (process.env.TRIP_PUBLIC_URL || '').trim().replace(/\/$/, '');
// MCP_API_KEY is the generic name; HERMES_API_KEY still works as a fallback
// for existing deployments so nobody has to rename an env var mid-trip.
const API_KEY      = process.env.MCP_API_KEY || process.env.HERMES_API_KEY || ''; // agent → MCP auth
const TRIP_API_KEY = process.env.TRIP_API_KEY || API_KEY;                          // MCP → trip website auth (falls back to same key)

if (!API_KEY) {
  process.stderr.write('[trip-mcp] MCP_API_KEY is not set — exiting\n');
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const h = () => ({ 'x-api-key': TRIP_API_KEY, 'content-type': 'application/json' });

async function errorSuffix(r) {
  try {
    const body = (await r.text()).trim();
    if (!body) return '';
    return ` body=${JSON.stringify(body.slice(0, 300))}`;
  } catch {
    return '';
  }
}

async function fetchTrip(path, options = {}) {
  const targets = [API_BASE, ...(PUBLIC_API_BASE && PUBLIC_API_BASE !== API_BASE ? [PUBLIC_API_BASE] : [])];
  let lastErr;

  for (let i = 0; i < targets.length; i++) {
    const base = targets[i];
    try {
      return await fetch(`${base}${path}`, options);
    } catch (err) {
      lastErr = err;
      if (i < targets.length - 1) {
        process.stderr.write(`[trip-mcp] ${base}${path} failed (${err.message}); retrying via ${targets[i + 1]}\n`);
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error(`No API targets configured for ${path}`);
}

async function apiGet(path) {
  const r = await fetchTrip(path, { headers: h() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}${await errorSuffix(r)}`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetchTrip(path, {
    method: 'POST', headers: h(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}${await errorSuffix(r)}`);
  return r.json();
}
async function apiPatch(path, body) {
  const r = await fetchTrip(path, {
    method: 'PATCH', headers: h(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status}${await errorSuffix(r)}`);
  return r.json();
}
async function apiDelete(path) {
  const r = await fetchTrip(path, { method: 'DELETE', headers: h() });
  if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}${await errorSuffix(r)}`);
  return r.json();
}
async function apiPostFile(path, filePath, fieldName, contentType, fields = {}) {
  const fs = require('fs');
  const FormData = require('form-data');
  const form = new FormData();
  form.append(fieldName, fs.createReadStream(filePath), {
    filename: require('path').basename(filePath),
    contentType,
  });
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  }
  const r = await fetchTrip(path, {
    method: 'POST',
    headers: { 'x-api-key': TRIP_API_KEY, ...form.getHeaders() },
    body: form,
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}${await errorSuffix(r)}`);
  return r.json();
}
async function apiPostPdf(path, filePath) {
  return apiPostFile(path, filePath, 'file', 'application/pdf');
}

const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ── MCP server + tools ────────────────────────────────────────────────────────
function buildMcpServer() {
const mcp = new McpServer({ name: 'trip-site', version: '1.0.0' });

mcp.tool('health_check', 'Check if the trip server is online and Immich is reachable', {},
  async () => ok(await apiGet('/api/health')));

mcp.tool('get_config', 'Get the trip config: meta, participants, families, phases (with their venue/rsvp ids), budget, trivia. Start here to discover valid ids for the other tools — this trip\'s phases/venues/participants are never fixed.', {},
  async () => ok(await apiGet('/api/config')));

mcp.tool('get_agent_brief',
  'READ THIS FIRST, before your first message of the day. Your persona for this trip (name, grammatical gender, tone, language, timezone) plus the standing instructions and per-person needs the organizer gave you. ' +
  'Some entries are marked visibility:"organizer" — act on them, but never say them, quote them, or hint that they exist in the family group. ' +
  'get_config does NOT contain this; organizer-only items are stripped from it by design.',
  {},
  async () => ok(await apiGet('/api/agent/brief')));

mcp.tool('get_photos', 'Fetch trip photos, optionally filtered by phase', {
  phase: z.string().optional().describe('Phase id from trip.config.json (see get_config). Omit for all.'),
}, async ({ phase }) => ok(await apiGet(`/api/photos${phase ? `?phase=${phase}` : ''}`)));

mcp.tool('add_photo',
  'Upload a photo into the trip gallery and its phase album (synced to Immich in the background if configured). ' +
  'filePath must be an absolute path on the machine running this MCP server.', {
  filePath: z.string().describe('Absolute filesystem path to an image file on this machine'),
  phase:    z.string().optional().describe('Phase id from trip.config.json (see get_config) — determines which album the photo is added to. Omit to land in the general/unsorted album.'),
  caption:  z.string().optional().describe('Caption for the photo'),
}, async ({ filePath, phase, caption }) => {
  const ext = require('path').extname(filePath).toLowerCase();
  const contentType = IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream';
  return ok(await apiPostFile('/api/photos/upload', filePath, 'photo', contentType, { phase, caption }));
});

mcp.tool('delete_photo',
  'Delete a photo from the trip gallery and its Immich album (if synced). Unlike a family member on the site, ' +
  'the agent may delete any photo, not just ones it uploaded — use with care.', {
  photoId: z.string().describe('Photo ID from get_photos'),
}, async ({ photoId }) => ok(await apiDelete(`/api/photos/${photoId}`)));

mcp.tool('set_participant_avatar',
  'Set a participant\'s avatar photo — e.g. after they send the bot a selfie. ' +
  'Unlike the site\'s own upload, this can target any participant, not just the caller. ' +
  'filePath must be an absolute path on the machine running this MCP server.', {
  username: z.string().describe('Participant username from get_config'),
  filePath: z.string().describe('Absolute filesystem path to an image file on this machine'),
}, async ({ username, filePath }) => {
  const ext = require('path').extname(filePath).toLowerCase();
  const contentType = IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream';
  return ok(await apiPostFile('/api/auth/avatar/upload', filePath, 'avatar', contentType, { username }));
});

// ── Participant management ──────────────────────────────────────────────────
// These write identity/login data, not trip content — a meaningfully
// different blast radius than photos/bookings/comments. The underlying
// routes verify an organizer JWT OR this server's own key; when called
// through this MCP server they always authenticate as the latter, so the
// site cannot itself confirm which human asked. That verification has to
// happen upstream, in whatever's driving this MCP connection.
mcp.tool('add_participant',
  'Add a new participant to the live trip — Telegram-bound (immediate login via the widget, gated on group membership) if telegramId is given, ' +
  'otherwise password-only (returns a one-time enrollment link for the organizer to relay; never collect a password directly in chat).', {
  username: z.string().describe('Site username — lowercase letters, numbers, underscore, hyphen only'),
  name: z.string().describe('Display name'),
  nameEn: z.string().optional().describe('English display name'),
  color: z.string().optional().describe('Hex color for their avatar/picker chip'),
  family: z.string().optional().describe('Family group key from get_config'),
  telegramId: z.string().optional().describe('Numeric Telegram user ID — omit for the password-only path'),
}, async ({ username, name, nameEn, color, family, telegramId }) =>
  ok(await apiPost('/api/agent/participants', { username, name, name_en: nameEn, color, family, telegram_id: telegramId })));

mcp.tool('reset_participant_password',
  'Trigger a password reset for an existing participant (Telegram-bound or not — they may still want a password fallback). ' +
  'Returns a one-time enrollment link for the organizer to relay; never collect the new password directly in chat.', {
  username: z.string().describe('Existing participant username'),
}, async ({ username }) => ok(await apiPost(`/api/agent/participants/${encodeURIComponent(username)}/reset-password`, {})));

mcp.tool('bind_participant_telegram',
  'Bind a Telegram numeric ID to an EXISTING participant, enabling Telegram login for them — e.g. "bind @dror to dror". ' +
  'Does not create a participant or touch their password; use add_participant for a brand-new person.', {
  username: z.string().describe('Existing site username to bind'),
  telegramId: z.string().describe('Numeric Telegram user ID'),
}, async ({ username, telegramId }) =>
  ok(await apiPatch(`/api/agent/participants/${encodeURIComponent(username)}/telegram`, { telegram_id: telegramId })));

mcp.tool('remove_participant',
  'Remove a participant from the trip — e.g. "remove dror from the website". Drops them from the roster and revokes future logins ' +
  '(clears their Telegram link, replaces their password with an unusable one). Does not delete their photos/bookings/comments history, ' +
  'and does not invalidate a session token they already have (valid up to 30 days) — there is no session-revocation mechanism yet. ' +
  'Refuses to remove a currently-configured trip organizer.', {
  username: z.string().describe('Existing participant username to remove'),
}, async ({ username }) => ok(await apiDelete(`/api/agent/participants/${encodeURIComponent(username)}`)));

mcp.tool('set_telegram_group',
  'Bind the trip\'s Telegram group once it exists, turning on Telegram Login for the site — e.g. once the organizer creates the group, ' +
  'adds this bot, and you observe a message there. Pass the chat_id you saw it on (a negative number — group and supergroup chat IDs ' +
  'always are). Verifies live that a Telegram-bound organizer is actually an active member of that chat before accepting it, so it will ' +
  'refuse a wrong or made-up chat_id. Requires an organizer to already have a telegram_id bound (bind_participant_telegram) — bind the ' +
  'organizer first if this fails with no_telegram_bound_organizer.', {
  chatId: z.string().describe('Telegram chat_id of the group, e.g. "-1002345678901" — negative, as seen on an incoming message\'s chat.id'),
  chatTitle: z.string().optional().describe('Group title, for confirmation purposes only — not verified against Telegram'),
}, async ({ chatId, chatTitle }) => ok(await apiPost('/api/agent/telegram-group', { chat_id: chatId, chat_title: chatTitle })));

mcp.tool('get_budget', 'Get all trip budget items grouped by phase', {},
  async () => ok(await apiGet('/api/budget')));

mcp.tool('get_rsvps', 'Get RSVP status for a specific activity', {
  activityId: z.string().describe('Activity id from a phase\'s rsvp_activities[] in trip.config.json'),
}, async ({ activityId }) => ok(await apiGet(`/api/rsvps/${activityId}`)));

mcp.tool('get_ratings', 'Get star ratings for all venues from all family members', {},
  async () => ok(await apiGet('/api/ratings')));

mcp.tool('get_tasks', 'Get completed packing / preparation task IDs', {},
  async () => ok(await apiGet('/api/tasks/done')));

mcp.tool('get_lost_found', 'Get all lost & found entries (resolved and unresolved)', {},
  async () => ok(await apiGet('/api/lost-found')));

mcp.tool('post_lost_found', 'Report a lost item on behalf of a family member', {
  name:     z.string().describe("Name of the person who lost the item"),
  item:     z.string().describe('Description of the lost item'),
  location: z.string().optional().describe('Where it was last seen'),
  phone:    z.string().optional().describe('Contact phone number'),
}, async (args) => ok(await apiPost('/api/lost-found', args)));

mcp.tool('resolve_lost_found', 'Mark a lost & found entry as resolved or reopen it', {
  id:       z.number().describe('Entry ID from get_lost_found'),
  resolved: z.boolean().describe('true to mark found/resolved, false to reopen'),
}, async ({ id, resolved }) => ok(await apiPatch(`/api/lost-found/${id}`, { resolved })));

mcp.tool('get_venue_comments', 'Get comments posted about a venue', {
  venueId: z.string().describe('Venue id from a phase\'s venues[] in trip.config.json'),
}, async ({ venueId }) => ok(await apiGet(`/api/comments/venue/${venueId}`)));

mcp.tool('post_venue_comment', 'Post a comment on a venue as the connected agent', {
  venueId: z.string().describe('Venue slug'),
  body:    z.string().describe('Comment text'),
}, async ({ venueId, body }) => ok(await apiPost(`/api/comments/venue/${venueId}`, { body })));

mcp.tool('get_photo_comments', 'Get all photo comments across the trip. Returns a grouped object: { photoId: [comment, ...] }', {},
  async () => ok(await apiGet('/api/comments/photo')));

mcp.tool('post_photo_comment', 'Post a comment on a specific photo', {
  photoId: z.string().describe('Photo ID from get_photos'),
  body:    z.string().describe('Comment text'),
}, async ({ photoId, body }) => ok(await apiPost(`/api/comments/photo/${photoId}`, { body })));

mcp.tool('get_bookings', 'Get trip bookings (flights, hotels, cars, attractions), optionally filtered', {
  phase: z.string().optional().describe('Phase id from trip.config.json (see get_config or the site\'s phase tabs for valid values), plus "intl_flights" for international flights'),
  type:  z.enum(['flight','hotel','car','attraction','other']).optional().describe('Filter by type'),
}, async ({ phase, type }) => {
  const qs = new URLSearchParams();
  if (phase) qs.set('phase', phase);
  if (type)  qs.set('type', type);
  return ok(await apiGet(`/api/bookings${qs.toString() ? '?' + qs : ''}`));
});

mcp.tool('add_booking', 'Add a new booking entry to the trip site', {
  phase:        z.string().describe('Phase id from trip.config.json (see get_config), plus "intl_flights" for international flights'),
  type:         z.enum(['flight','hotel','car','attraction','other']).describe('Booking type'),
  name:         z.string().describe('Booking name / description'),
  date_from:    z.string().optional().describe('Start date YYYY-MM-DD'),
  date_to:      z.string().optional().describe('End date YYYY-MM-DD'),
  passengers:   z.string().optional().describe('Passengers / guests'),
  confirmation: z.string().optional().describe('Confirmation number'),
  pin:          z.string().optional().describe('PIN code'),
  cost:              z.number().optional().describe('Cost in USD'),
  notes:             z.string().optional().describe('Additional notes'),
  apple_wallet_url:  z.string().url().optional().describe('Apple Wallet pass URL (.pkpass)'),
  google_wallet_url: z.string().url().optional().describe('Google Wallet pass URL'),
  location_url:      z.string().url().optional().describe('Location URL (Google Maps, Waze, etc.)'),
}, async (args) => ok(await apiPost('/api/bookings', args)));

mcp.tool('update_booking', 'Update an existing booking by ID', {
  id:           z.number().describe('Booking ID from get_bookings'),
  name:         z.string().optional(),
  date_from:    z.string().optional(),
  date_to:      z.string().optional(),
  passengers:   z.string().optional(),
  confirmation: z.string().optional(),
  pin:          z.string().optional(),
  cost:              z.number().optional(),
  notes:             z.string().optional(),
  apple_wallet_url:  z.string().url().optional(),
  google_wallet_url: z.string().url().optional(),
  location_url:      z.string().url().optional(),
}, async ({ id, ...fields }) => ok(await apiPatch(`/api/bookings/${id}`, fields)));

mcp.tool('delete_booking', 'Delete a non-seed booking by ID (seed bookings cannot be deleted)', {
  id: z.number().describe('Booking ID from get_bookings'),
}, async ({ id }) => ok(await apiDelete(`/api/bookings/${id}`)));

mcp.tool('upload_booking_confirmation',
  'Upload a PDF confirmation file for a booking. filePath must be an absolute path on the machine running this MCP server. Accepts PDF only. Returns { conf_file } on success.', {
  id:       z.number().describe('Booking ID from get_bookings'),
  filePath: z.string().describe('Absolute filesystem path to a PDF file on this machine'),
}, async ({ id, filePath }) => ok(await apiPostPdf(`/api/bookings/${id}/confirmation`, filePath)));

// ── Trivia / Kahoot tools ─────────────────────────────────────────────────────

mcp.tool('get_trivia_state',
  'Get the current state of the family trivia (Kahoot-style) game. ' +
  'Status values: idle (no game), lobby (waiting for players), question (question active), ' +
  'reveal (showing answer), leaderboard (score screen), gameover (game ended). ' +
  'Returns players, current question number, and scores.',
  {},
  async () => ok(await apiGet('/api/trivia/state')));

mcp.tool('trivia_control',
  'Control the family trivia game as the host. ' +
  'Actions and when to use them:\n' +
  '  start      — create a new game and open the lobby (players can join)\n' +
  '  launch     — begin the first question (from lobby)\n' +
  '  pause      — freeze the current question timer\n' +
  '  resume     — unfreeze the timer\n' +
  '  reveal     — force-reveal the answer before the timer runs out\n' +
  '  leaderboard — advance from reveal to the score screen\n' +
  '  next       — move from leaderboard to the next question (or gameover if last)\n' +
  '  restart    — reset scores and go back to lobby without changing players\n' +
  '  stop       — end the game immediately and persist scores', {
  action: z.enum(['start','launch','pause','resume','reveal','leaderboard','next','restart','stop'])
    .describe('Host action to perform'),
}, async ({ action }) => ok(await apiPost('/api/trivia/control', { action })));

mcp.tool('get_trivia_scores',
  'Get historical trivia game scores across all past games, sorted by most recent first.',
  {},
  async () => ok(await apiGet('/api/trivia/scores')));

mcp.tool('get_trivia_questions',
  'List all trivia questions in the question bank. ' +
  'Optionally filter by persons (participant username or "general"/"trip") or category.',
  {
    persons:  z.string().optional().describe('Filter by person: a participant username from get_config, or "general"/"trip"'),
    category: z.string().optional().describe('Filter by category tag (e.g. "family")'),
  },
  async ({ persons, category }) => {
    const qs = new URLSearchParams();
    if (persons)  qs.set('persons', persons);
    if (category) qs.set('category', category);
    return ok(await apiGet(`/api/trivia/questions${qs.toString() ? '?' + qs : ''}`));
  });

mcp.tool('add_trivia_question',
  'Add a new question to the trivia bank. Takes effect immediately for the next game — no server restart needed. ' +
  'Persisted to trivia_questions.json so it survives restarts.',
  {
    he:      z.string().describe('Question text in Hebrew'),
    en:      z.string().describe('Question text in English'),
    persons: z.union([
      z.string(),
      z.array(z.string()),
    ]).describe(
      'Who this question is about. Use a participant username from get_config, ' +
      'an array of usernames, or "general" / "trip" for non-personal questions.'
    ),
    answers: z.array(z.object({
      he:      z.string().describe('Answer option in Hebrew'),
      en:      z.string().describe('Answer option in English'),
      correct: z.boolean().describe('true for the single correct answer'),
    })).min(2).max(4).describe('2–4 answer options; exactly one must have correct: true'),
    duration: z.number().optional().describe('Seconds players have to answer (default 20)'),
    category: z.string().optional().describe('Category tag (default "family")'),
  },
  async (args) => ok(await apiPost('/api/trivia/questions', args)));

return mcp;
}

// ── Express / SSE transport ───────────────────────────────────────────────────
const app      = express();
const sessions = new Map();

async function disposeSession(sessionId, { closeTransport = false } = {}) {
  const session = sessions.get(sessionId);
  if (!session || session.closing) return;
  session.closing = true;
  sessions.delete(sessionId);

  if (closeTransport) {
    try {
      await session.transport.close();
    } catch (_) {}
  }

  try {
    if (typeof session.server.close === 'function') await session.server.close();
  } catch (_) {}
}

// ── /extract — AI booking data extraction ────────────────────────────────────
// Built fresh per request from the live trip config — phase ids and dates are
// never the same across trips, so this can't be a static prompt.
async function buildExtractSystem() {
  let title = 'this trip', phaseLines = '- intl_flights: international flights';
  try {
    const cfg = await apiGet('/api/config');
    title = cfg.meta?.title || title;
    const lines = (cfg.phases || []).map(p => {
      const d = p.dates || {};
      return `- ${p.id}: ${d.display || `${d.start || '?'}–${d.end || '?'}`}`;
    });
    if (lines.length) phaseLines = ['- intl_flights: international flights', ...lines].join('\n');
  } catch (_) { /* fall back to the generic defaults above */ }

  return `You are a travel booking data extractor for "${title}".
Extract structured booking data from the provided content and return ONLY a valid JSON object.

Trip phase date ranges:
${phaseLines}

JSON fields (omit any field you cannot determine):
{
  "phase": one of the phase ids listed above,
  "type": one of ["flight","hotel","car","attraction","other"],
  "name": "booking name / venue / flight number",
  "date_from": "YYYY-MM-DD",
  "date_to": "YYYY-MM-DD",
  "passengers": "passenger or guest names",
  "confirmation": "confirmation / reservation number",
  "pin": "PIN code if present",
  "cost": numeric USD amount,
  "notes": "any relevant notes"
}

Return ONLY the JSON object, no commentary.`;
}

// Auth middleware — X-API-Key header, ?key= query param, or Authorization:
// Bearer. The Bearer form exists specifically because `hermes mcp add`'s
// standard connectivity flow always sends the key that way — without this,
// no Hermes profile can use this server through its normal setup path at
// all, not just a scripted one (confirmed against hermes_cli/mcp_config.py's
// _bearer_auth_headers()).
function requireKey(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const key = req.headers['x-api-key'] || req.query.key || bearerKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/extract', requireKey, express.json({ limit: '30mb' }), async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set for trip-mcp' });

  const { url, pdf_base64, pdf_name } = req.body || {};
  if (!url && !pdf_base64) return res.status(400).json({ error: 'Provide url or pdf_base64' });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  try {
    let userContent;

    if (pdf_base64) {
      userContent = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
        { type: 'text', text: `Extract booking details from this PDF confirmation${pdf_name ? ` (${pdf_name})` : ''}.` },
      ];
    } else {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TripBot/1.0)' },
        timeout: 10000,
      });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/pdf')) {
        const buf = await r.buffer();
        userContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
          { type: 'text', text: 'Extract booking details from this PDF confirmation.' },
        ];
      } else {
        const html = await r.text();
        const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
        userContent = [{ type: 'text', text: `URL: ${url}\n\nPage content:\n${plain}\n\nExtract the booking information.` }];
      }
    }

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: await buildExtractSystem(),
      messages: [{ role: 'user', content: userContent }],
    });

    const text = (msg.content[0]?.text || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    res.json(JSON.parse(m[0]));
  } catch (e) {
    console.error('[extract]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/sse', requireKey, async (req, res) => {
  // Allow more than one client at a time — a persistent always-on agent session
  // alongside short-lived CLI diagnostics shouldn't close each other's session.
  const transport = new SSEServerTransport('/messages', res);
  const server = buildMcpServer();
  sessions.set(transport.sessionId, { transport, server, closing: false });
  transport.onclose = () => {
    disposeSession(transport.sessionId).catch(() => {});
  };
  req.on('close', () => {
    disposeSession(transport.sessionId).catch(() => {});
  });
  await server.connect(transport);
});

app.post('/messages', express.json(), async (req, res) => {
  const session = sessions.get(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  await session.transport.handlePostMessage(req, res, req.body);
});

app.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`[trip-mcp] listening on 0.0.0.0:${MCP_PORT}  →  API: ${API_BASE}`);
});
