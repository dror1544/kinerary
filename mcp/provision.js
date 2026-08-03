'use strict';

process.on('uncaughtException',  e => { console.error('[trip-provision] uncaughtException:', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('[trip-provision] unhandledRejection:', e); process.exit(1); });

/**
 * Trip-site PROVISIONING MCP server — HTTP/SSE transport.
 *
 * This is deliberately a SEPARATE server from mcp.js, with its own port and
 * its own API key. Read that as a security boundary, not an organizational
 * preference:
 *
 *   mcp.js       manages a trip that already exists. Read/write of trip DATA
 *                (photos, bookings, trivia). Safe to expose publicly through
 *                a tunnel so Claude Cowork can reach it.
 *
 *   provision.js CREATES trips. It writes files into the repo, shells out to
 *                the scaffolder, and can repoint the live site at a different
 *                trip. It must NEVER be tunnelled, reverse-proxied, or given
 *                a public hostname. LAN or loopback only.
 *
 * Merging the two would mean the connector you hand to a cloud service also
 * carries the ability to write to your filesystem and restart your containers.
 *
 * Topology this is built for: the trip site and this server run on the site
 * host (the machine holding the repo and running docker compose). The agent —
 * Hermes on a different box — connects over the LAN with X-API-Key.
 */

const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z }                  = require('zod');
const express                = require('express');
const fs                     = require('fs');
const path                   = require('path');
const crypto                 = require('crypto');
const { execFile }           = require('child_process');

const PORT      = parseInt(process.env.PROVISION_PORT || '3002');
// Loopback by default. Widening this to a LAN address is a deliberate act, and
// the startup banner says so out loud — the failure mode being guarded against
// is someone binding 0.0.0.0 on a box that also has a tunnel running.
const BIND_HOST = process.env.PROVISION_BIND || '127.0.0.1';
const API_KEY   = process.env.PROVISION_API_KEY || '';
const REPO_ROOT = path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..'));
const TRIPS_DIR = path.join(REPO_ROOT, 'trips');
// Which trip the running site is currently serving, so list_trips can say so.
// Same value as TRIP_DIR_HOST in docker-compose; optional, purely informational.
const ACTIVE_TRIP_DIR = (process.env.ACTIVE_TRIP_DIR || '').trim();

if (!API_KEY) {
  process.stderr.write('[trip-provision] PROVISION_API_KEY is not set — exiting\n');
  process.exit(1);
}
if (API_KEY.length < 32) {
  process.stderr.write('[trip-provision] PROVISION_API_KEY must be at least 32 chars — this key can write to your filesystem\n');
  process.exit(1);
}
if (API_KEY === (process.env.MCP_API_KEY || process.env.HERMES_API_KEY)) {
  process.stderr.write('[trip-provision] PROVISION_API_KEY must differ from MCP_API_KEY — separate keys are the whole point of a separate server\n');
  process.exit(1);
}
if (!fs.existsSync(path.join(REPO_ROOT, 'server', 'server.js'))) {
  process.stderr.write(`[trip-provision] REPO_ROOT does not look like the kinerary repo: ${REPO_ROOT}\n`);
  process.exit(1);
}

// The canonical scaffolder. Coupling a long-running service to a file inside an
// agent-skill directory is not ideal, but buildConfig() there is the only
// implementation of the answers→config contract, and a second copy here would
// drift the first time someone adds a field.
const DRIVER_CANDIDATES = [
  path.join(REPO_ROOT, '.agents', 'skills', 'create-trip', 'driver.mjs'),
  path.join(REPO_ROOT, '.claude', 'skills', 'create-trip', 'driver.mjs'),
];
function driverPath() {
  const found = DRIVER_CANDIDATES.find(p => fs.existsSync(p));
  if (!found) throw new Error(`create-trip driver.mjs not found under ${REPO_ROOT} (looked in .agents/ and .claude/)`);
  return found;
}

// ── helpers ───────────────────────────────────────────────────────────────────
const ok   = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = msg  => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }, null, 2) }], isError: true });

function runNode(args, { cwd = REPO_ROOT, timeout = 120_000 } = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Slugs come from model-generated titles and are used to build filesystem
// paths. Anything that isn't a plain slug is rejected rather than sanitized —
// silently "fixing" a traversal attempt hides the fact that one happened.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function tripDirFor(slug) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug "${slug}" — expected lowercase letters, digits and hyphens`);
  const dir = path.join(TRIPS_DIR, slug);
  const rel = path.relative(TRIPS_DIR, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`slug "${slug}" resolves outside trips/`);
  return dir;
}

function readTrip(slug) {
  const f = path.join(tripDirFor(slug), 'trip.config.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// activate_trip is two-step: the first call reports what would change and
// returns a token, the second call must echo it back. A single hallucinated
// tool call therefore cannot repoint a live family trip site. Tokens are
// in-memory, single-use and short-lived.
const pendingActivations = new Map();
const ACTIVATION_TTL_MS = 5 * 60 * 1000;

// ── validation (pre-flight) ───────────────────────────────────────────────────
// Cheap checks that let the interview catch problems while the person is still
// in the conversation. create_trip re-runs the authoritative validation inside
// driver.mjs — this is a fast fail, not a substitute.
function preflight(answers) {
  const problems = [];
  if (!answers || typeof answers !== 'object') return ['answers is not an object'];
  if (!answers.meta?.title) problems.push('meta.title is required');
  if (!Array.isArray(answers.participants) || !answers.participants.length) {
    problems.push('participants[] is required and must be non-empty');
  }
  if (!Array.isArray(answers.phases) || !answers.phases.length) {
    problems.push('phases[] is required and must be non-empty');
  }

  const usernames = new Set();
  for (const [i, p] of (answers.participants || []).entries()) {
    if (!p.username) { problems.push(`participants[${i}] has no username`); continue; }
    if (!/^[a-z0-9_-]+$/.test(p.username)) problems.push(`participants[${i}].username "${p.username}" must be lowercase, no spaces`);
    if (usernames.has(p.username)) problems.push(`duplicate username "${p.username}"`);
    usernames.add(p.username);
    if (!p.family) problems.push(`participants[${i}] ("${p.username}") has no family id`);
  }
  for (const [i, f] of (answers.families || []).entries()) {
    for (const m of f.members || []) {
      if (!usernames.has(m)) problems.push(`families[${i}] ("${f.id}") references unknown member "${m}"`);
    }
  }
  const phaseIds = new Set();
  for (const [i, ph] of (answers.phases || []).entries()) {
    if (!ph.id) { problems.push(`phases[${i}] has no id`); continue; }
    if (phaseIds.has(ph.id)) problems.push(`duplicate phase id "${ph.id}"`);
    phaseIds.add(ph.id);
  }
  if (answers.agent) {
    if (!answers.agent.name) problems.push('agent.name is required when an agent block is present');
    if (answers.agent.organizer && !usernames.has(answers.agent.organizer)) {
      problems.push(`agent.organizer "${answers.agent.organizer}" is not a participant username`);
    }
  }
  return problems;
}

// ── MCP server ────────────────────────────────────────────────────────────────
function buildMcpServer() {
  const mcp = new McpServer({ name: 'trip-provision', version: '1.0.0' });

  mcp.tool('provision_health',
    'Check the provisioning server: repo root, whether the scaffolder is reachable, and how many trips exist. Call this first to confirm you are talking to the right machine.',
    {},
    async () => {
      let driver = null, driverError = null;
      try { driver = path.relative(REPO_ROOT, driverPath()); } catch (e) { driverError = e.message; }
      let trips = [];
      try { trips = fs.readdirSync(TRIPS_DIR).filter(d => fs.existsSync(path.join(TRIPS_DIR, d, 'trip.config.json'))); } catch {}
      return ok({
        ok: !driverError,
        repo_root: REPO_ROOT,
        driver,
        driver_error: driverError,
        trip_count: trips.length,
        active_trip_dir: ACTIVE_TRIP_DIR || null,
        node: process.version,
      });
    });

  mcp.tool('list_trips',
    'List every scaffolded trip with its title, participant count and whether it is the one the live site is currently serving. Use before create_trip to avoid colliding with an existing slug.',
    {},
    async () => {
      let dirs = [];
      try { dirs = fs.readdirSync(TRIPS_DIR); } catch { return ok([]); }
      const trips = dirs
        .filter(d => fs.existsSync(path.join(TRIPS_DIR, d, 'trip.config.json')))
        .map(slug => {
          const cfg = readTrip(slug) || {};
          let questions = 0;
          try {
            const q = JSON.parse(fs.readFileSync(path.join(TRIPS_DIR, slug, 'trivia_questions.json'), 'utf8'));
            questions = Array.isArray(q) ? q.length : 0;
          } catch {}
          return {
            slug,
            title: cfg.meta?.title || null,
            participants: (cfg.participants || []).map(p => p.username),
            phases: (cfg.phases || []).map(p => p.id),
            trivia_questions: questions,
            has_agent: !!cfg.agent,
            is_active: !!ACTIVE_TRIP_DIR && path.resolve(REPO_ROOT, ACTIVE_TRIP_DIR) === path.join(TRIPS_DIR, slug),
          };
        });
      return ok(trips);
    });

  mcp.tool('validate_answers',
    'Dry-run check of an answers object mid-interview — required fields, duplicate usernames, families referencing unknown members, agent.organizer not being a participant. Writes nothing. Call this before create_trip so problems surface while the person is still in the conversation.',
    { answers: z.record(z.any()).describe('The answers object being assembled, shaped like answers.example.json') },
    async ({ answers }) => {
      const problems = preflight(answers);
      return ok({
        valid: problems.length === 0,
        problems,
        note: problems.length ? 'Fix these before calling create_trip.' : 'Pre-flight passed. create_trip runs the authoritative validation.',
      });
    });

  mcp.tool('create_trip',
    'Scaffold a new trip from a completed answers object. Writes trips/<slug>/trip.config.json and trivia_questions.json via the canonical create-trip scaffolder. Does NOT make the trip live — the site keeps serving whatever it was serving. Returns the slug and what was written.',
    {
      answers: z.record(z.any()).describe('Completed answers object, shaped like .agents/skills/create-trip/answers.example.json'),
      force:   z.boolean().optional().describe('Overwrite an existing trips/<slug>/ — default false. Ask the organizer before setting this.'),
    },
    async ({ answers, force }) => {
      const problems = preflight(answers);
      if (problems.length) return fail(`answers failed pre-flight validation: ${problems.join('; ')}`);

      const tmp = path.join(require('os').tmpdir(), `trip-answers-${crypto.randomBytes(6).toString('hex')}.json`);
      fs.writeFileSync(tmp, JSON.stringify(answers, null, 2), 'utf8');
      try {
        const args = [driverPath(), 'generate', tmp];
        if (force) args.push('--force');
        const r = await runNode(args);
        if (r.code !== 0) return fail(`scaffolder rejected the answers: ${(r.stdout + r.stderr).trim().slice(0, 1200)}`);

        const m = r.stdout.match(/trips\/([a-z0-9-]+)\//);
        const slug = m ? m[1] : null;
        const cfg = slug ? readTrip(slug) : null;
        return ok({
          created: true,
          slug,
          title: cfg?.meta?.title || null,
          participants: (cfg?.participants || []).map(p => p.username),
          phases: (cfg?.phases || []).map(p => p.id),
          has_agent: !!cfg?.agent,
          live: false,
          next: `Run verify_trip("${slug}"), then get_activation_plan("${slug}") when the organizer is ready to switch the site over.`,
          scaffolder_output: r.stdout.trim(),
        });
      } finally {
        // The answers object can contain organizer-only standing instructions.
        // Don't leave it lying in /tmp.
        try { fs.unlinkSync(tmp); } catch {}
      }
    });

  mcp.tool('verify_trip',
    'Boot the real trip server against a scaffolded trip on a throwaway port and temp database, then render the real site code against the served config. Proves the trip actually works before anyone switches the live site to it. Takes ~10s. Does not touch the running site.',
    { slug: z.string().describe('Trip slug from create_trip or list_trips') },
    async ({ slug }) => {
      try { tripDirFor(slug); } catch (e) { return fail(e.message); }
      if (!readTrip(slug)) return fail(`trips/${slug}/trip.config.json not found`);
      const r = await runNode([driverPath(), 'verify', slug], { timeout: 180_000 });
      return ok({
        slug,
        passed: r.code === 0,
        report: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim(),
      });
    });

  mcp.tool('set_trip_logo',
    'Install a logo image into a scaffolded trip and point meta.logo at it. The file must already exist on THIS machine (the site host) — pass an absolute path. Only affects the given trip; if it is the live one, the site picks it up after the next restart.',
    {
      slug:     z.string().describe('Trip slug'),
      filePath: z.string().describe('Absolute path to a PNG/JPG/SVG on the site host'),
    },
    async ({ slug, filePath }) => {
      let dir;
      try { dir = tripDirFor(slug); } catch (e) { return fail(e.message); }
      if (!readTrip(slug)) return fail(`trips/${slug}/trip.config.json not found`);
      if (!path.isAbsolute(filePath)) return fail('filePath must be absolute');
      if (!fs.existsSync(filePath)) return fail(`file not found on the site host: ${filePath}`);
      const ext = path.extname(filePath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) return fail(`unsupported logo type "${ext}"`);

      const destName = `Logo${ext}`;
      fs.copyFileSync(filePath, path.join(dir, destName));
      const cfgFile = path.join(dir, 'trip.config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      cfg.meta = cfg.meta || {};
      cfg.meta.logo = destName;
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      return ok({ slug, logo: destName, note: 'Served at /api/trip/logo once this trip is live.' });
    });

  mcp.tool('get_activation_plan',
    'Explain exactly what switching the live site to a trip would change, and return a one-time confirmation token. Read the summary out to the organizer and get an explicit yes before calling activate_trip. This tool changes nothing.',
    { slug: z.string().describe('Trip slug to make live') },
    async ({ slug }) => {
      try { tripDirFor(slug); } catch (e) { return fail(e.message); }
      const cfg = readTrip(slug);
      if (!cfg) return fail(`trips/${slug}/trip.config.json not found`);

      const token = crypto.randomBytes(16).toString('hex');
      pendingActivations.set(token, { slug, at: Date.now() });

      const currentSlug = ACTIVE_TRIP_DIR ? path.basename(path.resolve(REPO_ROOT, ACTIVE_TRIP_DIR)) : null;
      const currentCfg  = currentSlug ? readTrip(currentSlug) : null;
      return ok({
        will_switch_to: { slug, title: cfg.meta?.title || null, participants: (cfg.participants || []).length },
        will_replace: currentSlug ? { slug: currentSlug, title: currentCfg?.meta?.title || null } : 'unknown (ACTIVE_TRIP_DIR not configured)',
        effects: [
          'The site restarts — anyone using it right now gets a brief outage.',
          'The site begins serving the new trip. The previous trip\'s config is untouched on disk and can be switched back.',
          'Accounts, photos, comments, ratings and trivia scores live in the SQLite database, which is NOT per-trip — the previous trip\'s data stays in the same database.',
          'Every participant in the new trip is seeded with the default password 1234 on first boot.',
        ],
        confirmation_token: token,
        token_expires_in_seconds: ACTIVATION_TTL_MS / 1000,
        required_next_step: 'Ask the organizer to confirm in their own words, then call activate_trip with this exact token. Never call activate_trip off your own judgement.',
      });
    });

  mcp.tool('activate_trip',
    'Point the live site at a trip and restart it. Requires a fresh confirmation_token from get_activation_plan AND an explicit yes from the organizer. Causes a brief outage. Never call this without having been told to.',
    {
      slug:               z.string().describe('Trip slug — must match the one the token was issued for'),
      confirmation_token: z.string().describe('Token from get_activation_plan, used once, expires in 5 minutes'),
    },
    async ({ slug, confirmation_token }) => {
      const pending = pendingActivations.get(confirmation_token);
      if (!pending) return fail('unknown or already-used confirmation_token — call get_activation_plan first and confirm with the organizer');
      pendingActivations.delete(confirmation_token);
      if (Date.now() - pending.at > ACTIVATION_TTL_MS) return fail('confirmation_token expired — re-confirm with the organizer and call get_activation_plan again');
      if (pending.slug !== slug) return fail(`token was issued for "${pending.slug}", not "${slug}"`);
      if (!readTrip(slug)) return fail(`trips/${slug}/trip.config.json not found`);

      // Persist the choice where docker-compose reads it, then recreate. Writing
      // .env rather than passing an inline env var means a later `docker compose
      // up` by hand keeps serving the same trip instead of silently reverting.
      const envFile = path.join(REPO_ROOT, '.env');
      let env = '';
      try { env = fs.readFileSync(envFile, 'utf8'); } catch {}
      const line = `TRIP_DIR_HOST=./trips/${slug}`;
      env = /^TRIP_DIR_HOST=.*$/m.test(env)
        ? env.replace(/^TRIP_DIR_HOST=.*$/m, line)
        : (env.trimEnd() + (env.trim() ? '\n' : '') + line + '\n');
      fs.writeFileSync(envFile, env, 'utf8');

      const r = await new Promise(resolve => {
        execFile('docker', ['compose', 'up', '-d', '--force-recreate', 'trip-server'],
          { cwd: REPO_ROOT, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
      });

      return ok({
        slug,
        env_updated: line,
        restarted: r.code === 0,
        output: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim().slice(0, 2000),
        next: r.code === 0
          ? 'Confirm with health_check on the trip MCP, then hand the organizer their onboarding pack.'
          : 'Restart failed — report the output above to the organizer verbatim. Do not retry automatically.',
      });
    });

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
  if (closeTransport) { try { await session.transport.close(); } catch (_) {} }
  try { if (typeof session.server.close === 'function') await session.server.close(); } catch (_) {}
}

function requireKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  // Constant-time compare — this key is worth more than the data one.
  const a = Buffer.from(String(key || ''));
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'trip-provision' }));

app.get('/sse', requireKey, async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const server = buildMcpServer();
  sessions.set(transport.sessionId, { transport, server, closing: false });
  transport.onclose = () => { disposeSession(transport.sessionId).catch(() => {}); };
  req.on('close', () => { disposeSession(transport.sessionId).catch(() => {}); });
  await server.connect(transport);
});

app.post('/messages', requireKey, async (req, res) => {
  const session = sessions.get(req.query.sessionId);
  if (!session) return res.status(400).json({ error: 'no such session' });
  await session.transport.handlePostMessage(req, res);
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`[trip-provision] listening on ${BIND_HOST}:${PORT}  →  repo: ${REPO_ROOT}`);
  if (BIND_HOST === '0.0.0.0') {
    console.warn('[trip-provision] WARNING: bound to 0.0.0.0. This server can write files and restart containers.');
    console.warn('[trip-provision] Make sure it is not reachable from a tunnel, reverse proxy or port-forward.');
  }
});
