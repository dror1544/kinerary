// Private portal identity bridge. Classic and Modern keep the same local users
// and permissions; this table only binds a global identity to one local user.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { normalizeOrganizers } = require('../shared/agent-schema');

const userIdValid = value => typeof value === 'string' && /^user_[A-Za-z0-9]{8,64}$/.test(value);
const tripIdValid = value => typeof value === 'string' && /^trip_[A-Za-z0-9]{8,64}$/.test(value);
const usernameValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);

function createControlPlaneAuth({ app, db, tripDir, config, ready, jwtSecret }) {
  const key = process.env.CONTROL_PLANE_EXCHANGE_KEY || '';
  let identity;
  try {
    const value = JSON.parse(fs.readFileSync(process.env.CONTROL_PLANE_IDENTITY_FILE || path.join(tripDir, 'control-plane.identity.json'), 'utf8'));
    if (value.version !== 1 || !tripIdValid(value.tripId) || !userIdValid(value.owner?.userId) || !usernameValid(value.owner?.username)) throw new Error('invalid identity manifest');
    identity = value;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Control-plane identity manifest invalid; portal login disabled.');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS control_plane_identities (
    user_id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, username TEXT NOT NULL UNIQUE REFERENCES users(username) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'organizer', 'member')),
    invite_id TEXT UNIQUE
  )`);
  const find = db.prepare('SELECT * FROM control_plane_identities WHERE user_id = ? AND trip_id = ?');
  const localUser = db.prepare('SELECT username FROM users WHERE username = ?');
  const insert = db.prepare('INSERT INTO control_plane_identities(user_id, trip_id, username, role, invite_id) VALUES (?, ?, ?, ?, ?)');
  const organizers = () => normalizeOrganizers(config().agent);
  const activeUser = username => localUser.get(username) && (config().participants || []).some(p => p.username === username);
  const roleMatchesLocal = (role, username) => role === 'member'
    ? !organizers().includes(username)
    : ['owner', 'organizer'].includes(role) && organizers().includes(username);

  async function internal(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const supplied = req.headers['x-api-key'];
    // Never use authRequired here: a traveler or the companion must not mint
    // another traveler's identity. A dedicated, configured key is mandatory.
    if (!key || key === process.env.HERMES_API_KEY || key === jwtSecret || typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(key) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
      return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    }
    if (!identity) return res.status(503).json({ error: 'RUNTIME_IDENTITY_NOT_CONFIGURED' });
    const tripId = req.method === 'GET' ? req.headers['x-control-plane-trip-id'] : req.body?.tripId;
    if (tripId !== identity.tripId) return res.status(403).json({ error: 'TRIP_MISMATCH' });
    try {
      await ready;
      const owner = identity.owner;
      if (!activeUser(owner.username) || !organizers().includes(owner.username)) {
        return res.status(503).json({ error: 'OWNER_MAPPING_INVALID' });
      }
      const existing = find.get(owner.userId, identity.tripId);
      if (!existing) insert.run(owner.userId, identity.tripId, owner.username, 'owner', null);
      else if (existing.username !== owner.username || existing.role !== 'owner') throw new Error('owner mapping conflict');
      next();
    } catch {
      return res.status(503).json({ error: 'RUNTIME_IDENTITY_UNAVAILABLE' });
    }
  }

  function validManagedPayload(payload) {
    if (!Object.prototype.hasOwnProperty.call(payload, 'controlPlane')) return true; // Existing local/Telegram/Google JWTs.
    const subject = payload.controlPlane;
    if (!subject || typeof subject !== 'object') return false;
    if (!identity || subject.tripId !== identity.tripId || !userIdValid(subject.userId)) return false;
    const row = find.get(subject.userId, identity.tripId);
    if (row?.role === 'owner' && (subject.userId !== identity.owner.userId || row.username !== identity.owner.username)) return false;
    return Boolean(row && row.username === payload.username && row.role === subject.role &&
      activeUser(row.username) && roleMatchesLocal(row.role, row.username));
  }

  app.post('/api/internal/control-plane/session', internal, (req, res) => {
    const { userId, runtimeUsername, role } = req.body || {};
    if (!userIdValid(userId) || !['owner', 'organizer', 'member'].includes(role) ||
        (runtimeUsername !== null && !usernameValid(runtimeUsername))) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    const row = find.get(userId, identity.tripId);
    if (!row || row.role !== role || (runtimeUsername !== null && runtimeUsername !== row.username) ||
        !activeUser(row.username) || !roleMatchesLocal(role, row.username)) {
      return res.status(403).json({ error: 'IDENTITY_MISMATCH' });
    }
    const token = jwt.sign({ username: row.username, controlPlane: { userId, tripId: identity.tripId, role } }, jwtSecret, { expiresIn: '12h' });
    return res.json({ token });
  });

  app.get('/api/internal/control-plane/participants/:username', internal, (req, res) => {
    const username = req.params.username;
    if (!usernameValid(username) || !activeUser(username)) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json({ username });
  });

  app.post('/api/internal/control-plane/participants', internal, (req, res) => {
    const { userId, runtimeUsername, inviteId } = req.body || {};
    if (!userIdValid(userId) || !usernameValid(runtimeUsername) || typeof inviteId !== 'string' || !/^invite_[A-Za-z0-9]{8,64}$/.test(inviteId)) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    // Invitations bind an existing participant. They never rename an account,
    // replace a Classic password, or grant organizer privileges.
    if (!activeUser(runtimeUsername)) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!roleMatchesLocal('member', runtimeUsername)) return res.status(403).json({ error: 'ORGANIZER_BINDING_FORBIDDEN' });
    const existing = find.get(userId, identity.tripId);
    if (existing) {
      if (existing.username === runtimeUsername && existing.role === 'member' && existing.invite_id === inviteId) return res.json({ ok: true });
      return res.status(409).json({ error: 'IDENTITY_CONFLICT' });
    }
    try { insert.run(userId, identity.tripId, runtimeUsername, 'member', inviteId); }
    catch { return res.status(409).json({ error: 'IDENTITY_CONFLICT' }); }
    return res.json({ ok: true });
  });
  return { validManagedPayload };
}
module.exports = { createControlPlaneAuth };
