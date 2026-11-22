// Private portal identity bridge. Classic and Modern keep the same local users
// and permissions; this table only binds a global identity to one local user.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { normalizeOrganizers } = require('../shared/agent-schema');
const { revokeBindingGrants } = require('./trip-mcp/oauth');

const userIdValid = value => typeof value === 'string' && /^user_[A-Za-z0-9]{8,64}$/.test(value);
const tripIdValid = value => typeof value === 'string' && /^trip_[A-Za-z0-9]{8,64}$/.test(value);
const usernameValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);

// The link back to the organizer dashboard, which the control plane builds from
// its own configuration and the gateway passes through the session exchange into
// the signed claim. This function checks SHAPE only: https (http only on a
// loopback host, for local development), no credentials, query or fragment, at
// most 2048 characters, and the path pinned to THIS trip's setup page. It does not
// know which origin is the portal, so a caller holding the exchange key could name
// any https host; the gateway, which knows PORTAL_ORIGIN, drops every URL that is
// not exactly PORTAL_ORIGIN + that path before it asks for the session. Anything
// else is dropped rather than rendered into a menu href: javascript:, data:,
// userinfo, control characters and other paths never leave this function.
const MAX_DASHBOARD_URL = 2048;
// Loopback by shape, not by literal: the release build refuses a private-IPv4 literal in shipped code.
const isLoopbackHost = host => host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
function safeDashboardUrl(value, tripId) {
  if (typeof value !== 'string' || !value || value.length > MAX_DASHBOARD_URL || /[\u0000-\u0020\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return null;
  if (!tripIdValid(tripId) || url.pathname !== `/trips/${tripId}/setup`) return null;
  return url.href;
}

// The portal's origin as the control plane's own configuration states it
// (web.public_origin), written by the worker into the identity sidecar on every
// provision. An origin and nothing else, decided on the RAW text before any URL
// parser sees it (a parser forgives what an href must not carry: backslashes,
// %-escapes, Unicode digits and hosts, a trailing dot):
//   https://<ASCII DNS name>[:port]   or   http://<loopback>[:port]
// with at most one trailing slash. The name's last label must not be all digits
// (so no IPv4 literal other than loopback), no trailing dot, no leading-zero port
// or loopback octet. The worker's normalize_portal_origin() applies the same rule
// and both are driven by the one list in tests/fixtures/portal-origin-cases.json.
// Anything else is no origin at all: a bad value shows no dashboard link rather
// than a wrong one. Returns the canonical origin (lower-case, default port and
// slash dropped), or null.
const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const PORT = '(?::[1-9][0-9]{0,4})?';
const OCTET = '(?:0|[1-9][0-9]{0,2})';
const HTTPS_ORIGIN = new RegExp(`^https://${DNS_LABEL}(?:\\.${DNS_LABEL})*${PORT}/?$`);
const LOOPBACK_ORIGIN = new RegExp(`^http://(?:localhost|127(?:\\.${OCTET}){3}|\\[::1\\])${PORT}/?$`);
function safePortalOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_DASHBOARD_URL) return null;
  if (!HTTPS_ORIGIN.test(value) && !LOOPBACK_ORIGIN.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; } // 65536+, an octet above 255
  if (url.protocol === 'https:' && /^[0-9]+$/.test(url.hostname.split('.').pop())) return null;
  return url.origin;
}

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
  // Where the organizer dashboard of THIS trip lives, for an organizer who did not come
  // through the gateway (a direct login on the trip's own hostname, the installed
  // app). From configuration, never from a request: the sidecar's portalOrigin
  // plus this trip's own id. Null when either is missing or malformed.
  const configuredDashboardUrl = identity ? safeDashboardUrl(
    safePortalOrigin(identity.portalOrigin) ? `${safePortalOrigin(identity.portalOrigin)}/trips/${identity.tripId}/setup` : null,
    identity.tripId,
  ) : null;
  if (identity && ![undefined, null, ''].includes(identity.portalOrigin) && !configuredDashboardUrl) {
    console.warn('control_plane.portal_origin_invalid: the identity sidecar\'s portalOrigin is not a plain https origin; organizers reaching this trip directly will see no dashboard link');
  }
  // SECONDARY ORGANIZERS (#523): a person the trip's main organizer added with a trip link. They are an 'organizer' of THIS
  // trip's site and nothing else: no participant row in the config, no password, no Telegram login here, no dashboard. The
  // control plane vouches for them exactly as it does for a member (a launch grant, consumed by the gateway) and this table
  // is what makes the vouching count on this site: a row exists only for a user the exchange-key holder named as an
  // 'organizer' who is NOT one of the configured organizers, and it is tied to THIS trip's id. Removal is the control plane's
  // (the membership ends, the gateway's liveness check fails); the row is only ever a binding, never a grant.
  db.exec(`CREATE TABLE IF NOT EXISTS control_plane_secondary_organizers (
    user_id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, username TEXT NOT NULL UNIQUE REFERENCES users(username) ON DELETE CASCADE
  )`);
  const findSecondary = db.prepare('SELECT * FROM control_plane_secondary_organizers WHERE user_id = ? AND trip_id = ?');
  const secondaryByName = db.prepare('SELECT user_id FROM control_plane_secondary_organizers WHERE username = ?');
  const isSecondaryUsername = username => Boolean(secondaryByName.get(username));
  const find = db.prepare('SELECT * FROM control_plane_identities WHERE user_id = ? AND trip_id = ?');
  const localUser = db.prepare('SELECT username FROM users WHERE username = ?');
  const insert = db.prepare('INSERT INTO control_plane_identities(user_id, trip_id, username, role, invite_id) VALUES (?, ?, ?, ?, ?)');
  const organizers = () => normalizeOrganizers(config().agent);
  // `deadInviteIds` (optional, on provision and adopt): invite ids the control plane has checked, under its own trip lock, are
  // revoked or expired AND were never redeemed. An invite-bound binding is a leftover of a redemption that never completed there (a
  // lost answer, then "send it again"), and is replaced, ONLY when its invite id is in this list: a redeemed member's binding, an
  // owner's, another trip's and a binding whose invite is not named are never displaced. Anything malformed is "no list".
  const deadInviteIdsOf = body => Array.isArray(body?.deadInviteIds) && body.deadInviteIds.length <= 50 &&
    body.deadInviteIds.every(id => typeof id === 'string' && /^invite_[A-Za-z0-9]{8,64}$/.test(id)) ? body.deadInviteIds : [];
  const staleInviteBinding = (row, dead) => Boolean(row && row.role === 'member' && typeof row.invite_id === 'string' && dead.includes(row.invite_id));
  // A binding that carries an invite id is ending (released for a removed member, or replaced as a dead invite's leftover): the
  // assistant connections APPROVED UNDER IT end with it, in the same step, so nobody inherits them (S2c). Only an invite binding
  // can have approved one (a claim's session may not), so a claim binding has nothing to revoke. Never logs: no id, no name.
  const endBindingGrants = row => {
    if (row && row.role === 'member' && typeof row.invite_id === 'string') revokeBindingGrants(db, { userId: row.user_id, inviteId: row.invite_id });
  };
  // Remove one binding row, and (when it is an invite binding) the connections approved under it. Inside the caller's transaction
  // where there is one, so a failed removal does not revoke and a revoked connection is never left behind a removed binding.
  const dropBinding = row => {
    db.prepare('DELETE FROM control_plane_identities WHERE user_id = ? AND trip_id = ?').run(row.user_id, identity.tripId);
    endBindingGrants(row);
  };
  const activeUser = username => localUser.get(username) &&
    ((config().participants || []).some(p => p.username === username) || isSecondaryUsername(username));
  // A secondary organizer is never a 'member' and never an 'owner': the role on its identity row is 'organizer' and the
  // username must be one the secondary table holds. A configured organizer keeps the rules it always had.
  const roleMatchesLocal = (role, username) => {
    if (isSecondaryUsername(username)) return role === 'organizer';
    return role === 'member'
      ? !organizers().includes(username)
      : ['owner', 'organizer'].includes(role) && organizers().includes(username);
  };
  // The local name a secondary organizer gets. Derived from the control-plane user id, so it is stable, unguessable enough to
  // never be typed by hand, and can never be a configured participant's (the `org-` prefix + 12 hex is not a username the
  // scaffolder or the participants route makes: `usernameValid` allows it, the participant routes' own pattern does not
  // forbid it, so the collision check below is what keeps it honest).
  const secondaryUsername = userId => `org-${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12)}`;

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
    const { userId, runtimeUsername, role, dashboardUrl } = req.body || {};
    if (!userIdValid(userId) || !['owner', 'organizer', 'member'].includes(role) ||
        (runtimeUsername !== null && !usernameValid(runtimeUsername))) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    let row = find.get(userId, identity.tripId);
    // A first launch of a SECONDARY organizer (#523): the control plane consumed a grant for a user holding an 'organizer'
    // membership with no dashboard, and this site has never seen them. Bound once, here, to a local name of its own; never to a
    // configured participant (runtimeUsername must be absent), never as the owner. The exchange key is what vouches, as for
    // every other row this route reads.
    if (!row && role === 'organizer' && (runtimeUsername === null || runtimeUsername === undefined)) {
      const username = secondaryUsername(userId);
      const taken = localUser.get(username);
      if (!taken || isSecondaryUsername(username)) {
        try {
          db.transaction(() => {
            // No password anyone knows: a random bcrypt-shaped value that no input matches (login compares with bcrypt).
            if (!taken) db.prepare('INSERT INTO users (username, name, password) VALUES (?, ?, ?)').run(username, 'Organizer', `!${crypto.randomBytes(24).toString('hex')}`);
            db.prepare('INSERT OR IGNORE INTO control_plane_secondary_organizers(user_id, trip_id, username) VALUES (?, ?, ?)').run(userId, identity.tripId, username);
            insert.run(userId, identity.tripId, username, 'organizer', null);
          })();
        } catch { return res.status(409).json({ error: 'IDENTITY_CONFLICT' }); }
        row = find.get(userId, identity.tripId);
      }
    }
    if (!row || row.role !== role || (runtimeUsername !== null && runtimeUsername !== row.username) ||
        !activeUser(row.username) || !roleMatchesLocal(role, row.username)) {
      return res.status(403).json({ error: 'IDENTITY_MISMATCH' });
    }
    // Signed into the session, so it can only come from the exchange-key holder
    // and only an owner/organizer carries it. A member's token never does.
    const dashboard = ['owner', 'organizer'].includes(role) ? safeDashboardUrl(dashboardUrl, identity.tripId) : null;
    // An owner or organizer minted without the link opens a trip with no way
    // back to the dashboard and nothing to say why (staging, 2026-10-20). Say
    // which of the two it was; never the value, which is not ours to echo.
    if (['owner', 'organizer'].includes(role) && !dashboard) {
      console.warn(`control_plane.session_without_dashboard_url: role=${role} reason=${dashboardUrl === undefined || dashboardUrl === null ? 'not_sent' : 'rejected'}`);
    }
    const controlPlane = { userId, tripId: identity.tripId, role, ...(dashboard ? { dashboardUrl: dashboard } : {}) };
    const token = jwt.sign({ username: row.username, controlPlane }, jwtSecret, { expiresIn: '12h' });
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
    if (isSecondaryUsername(runtimeUsername)) return res.status(403).json({ error: 'ORGANIZER_BINDING_FORBIDDEN' });
    let existing = find.get(userId, identity.tripId);
    // This very account's OWN stale binding on this very name (a removed member re-invited, whose release was lost): its old invite is
    // named dead by the control plane, so the binding is replaced by the new invite's.
    if (existing && existing.username === runtimeUsername && staleInviteBinding(existing, deadInviteIdsOf(req.body))) {
      db.transaction(() => dropBinding(existing))();
      existing = undefined;
    }
    if (existing) {
      if (existing.username === runtimeUsername && existing.role === 'member' && existing.invite_id === inviteId) return res.json({ ok: true });
      return res.status(409).json({ error: 'IDENTITY_CONFLICT' });
    }
    // A LEFTOVER claim binding on this name (a group claim whose release never reached this site) is replaced, exactly as
    // adopt replaces one: the control plane is the authority on who holds a traveller, and it only asks after checking
    // under its own lock that no claim on this name is live. Anything else on the name is never displaced: an owner's,
    // another trip's, or another invite's binding (invite_id set) is a 409.
    const onName = db.prepare('SELECT * FROM control_plane_identities WHERE username = ?').get(runtimeUsername);
    const dead = deadInviteIdsOf(req.body);
    if (onName && (onName.role !== 'member' || onName.trip_id !== identity.tripId || (onName.invite_id !== null && !staleInviteBinding(onName, dead)))) return res.status(409).json({ error: 'IDENTITY_CONFLICT' });
    try {
      db.transaction(() => {
        if (onName) dropBinding(onName);
        insert.run(userId, identity.tripId, runtimeUsername, 'member', inviteId);
      })();
    } catch { return res.status(409).json({ error: 'IDENTITY_CONFLICT' }); }
    return res.json({ ok: true });
  });
  // GROUP SIGN-IN (docs/specs/sprint-9/x-member-sign-in.md, slice S1): the control plane lets a person in the trip's
  // Telegram group claim an EXISTING participant, and writes only its own rows. Without a binding here the session
  // exchange answers IDENTITY_MISMATCH, so this is the other half of the claim. ONE mechanism, which the personal invite
  // for an existing traveller (S2) reuses: ADOPT binds a control-plane user to a participant that already exists, and
  // RELEASE ends that binding. Both sit behind `internal` exactly like the routes above (the dedicated exchange key, the
  // trip id in the body, the identity manifest), so a family JWT, the agent key and the Hermes key get 401.
  //
  // ADOPT never creates a participant, never touches its role, password or data, and refuses an organizer, a secondary
  // organizer and a name that is not a current participant (the same three tests the invite route applies). The
  // control plane is the authority on who holds a traveller, and it holds a lock on the trip while it asks, so a binding
  // already on this name that is NOT invite-bound is a leftover of a claim that ended without its release arriving
  // (a site that was down): it is replaced. An invite-bound binding (invite_id set) or an owner's is never displaced:
  // 409 IDENTITY_CONFLICT, with ONE exception: an invite-bound binding whose invite id the control plane names in `deadInviteIds`
  // (revoked or expired and never redeemed, checked under its trip lock: a redemption whose answer was lost) is replaced. RELEASE removes only the binding it is asked about (this user, this name, a member, no invite):
  // it can never end an invited member's or an organizer's, and releasing twice is not an error. Removing the row is
  // what makes a token already issued stop working (validManagedPayload reads it on every request).
  app.post('/api/internal/control-plane/participants/adopt', internal, (req, res) => {
    const { userId, runtimeUsername } = req.body || {};
    if (!userIdValid(userId) || !usernameValid(runtimeUsername)) return res.status(400).json({ error: 'INVALID_REQUEST' });
    if (!activeUser(runtimeUsername)) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!roleMatchesLocal('member', runtimeUsername) || isSecondaryUsername(runtimeUsername)) return res.status(403).json({ error: 'ORGANIZER_BINDING_FORBIDDEN' });
    const onName = db.prepare('SELECT * FROM control_plane_identities WHERE username = ?').get(runtimeUsername);
    if (onName && onName.user_id === userId && onName.trip_id === identity.tripId && onName.role === 'member') return res.json({ ok: true });
    const dead = deadInviteIdsOf(req.body);
    if (onName && (onName.role !== 'member' || onName.trip_id !== identity.tripId || (onName.invite_id !== null && !staleInviteBinding(onName, dead)))) return res.status(409).json({ error: 'IDENTITY_CONFLICT' });
    const ofUser = find.get(userId, identity.tripId);
    if (ofUser && ofUser.username !== runtimeUsername) return res.status(409).json({ error: 'IDENTITY_CONFLICT' });
    try {
      db.transaction(() => {
        if (onName) dropBinding(onName);
        insert.run(userId, identity.tripId, runtimeUsername, 'member', null);
      })();
    } catch { return res.status(409).json({ error: 'IDENTITY_CONFLICT' }); }
    return res.json({ ok: true });
  });

  app.post('/api/internal/control-plane/participants/release', internal, (req, res) => {
    const { userId, runtimeUsername } = req.body || {};
    if (!userIdValid(userId) || !usernameValid(runtimeUsername)) return res.status(400).json({ error: 'INVALID_REQUEST' });
    // A REMOVED MEMBER's invite binding (spec amendment A1: member removal removes the binding): when the call names an `inviteId`, the
    // binding is ended only if the account, the name AND that invite id ALL match the binding, and it is a member's (never an owner's
    // or a secondary organizer's, never another account's, never another trip's). Without an `inviteId` this is the claim's release
    // exactly as before: only a binding that carries no invite. Idempotent either way. A malformed id is a 400, never "no id".
    const { inviteId } = req.body || {};
    if (inviteId !== undefined && (typeof inviteId !== 'string' || !/^invite_[A-Za-z0-9]{8,64}$/.test(inviteId))) return res.status(400).json({ error: 'INVALID_REQUEST' });
    // An invite binding's release also ends the assistant (MCP) connections approved under that binding (S2c), in the same
    // transaction as the row's removal: a release that ends the binding and leaves its connections answering is the hole this
    // closes, and a release that revoked connections but kept the binding would be as wrong. A claim's release (no invite id)
    // has nothing to revoke: a claimed session cannot approve a connection.
    const released = db.transaction(() => {
      const row = inviteId === undefined
        ? db.prepare("SELECT * FROM control_plane_identities WHERE user_id = ? AND trip_id = ? AND username = ? AND role = 'member' AND invite_id IS NULL").get(userId, identity.tripId, runtimeUsername)
        : db.prepare("SELECT * FROM control_plane_identities WHERE user_id = ? AND trip_id = ? AND username = ? AND role = 'member' AND invite_id = ?").get(userId, identity.tripId, runtimeUsername, inviteId);
      if (!row) return false;
      dropBinding(row);
      return true;
    })();
    return res.json({ ok: true, released });
  });

  // Only for a managed session whose claim passed validManagedPayload on this
  // request (so the binding, the participant and the local organizer role were
  // all re-checked just now). A direct login, a member and the agent key have
  // no claim and get nothing from THIS function; dashboardUrlForOrganizer adds the
  // configured address for an organizer who has none.
  function dashboardUrlFor(claim, username) {
    if (!claim || typeof claim !== 'object' || !['owner', 'organizer'].includes(claim.role)) return null;
    // A secondary organizer has no dashboard (#523): whatever a claim says, there is no way back to one for them.
    if (isSecondaryUsername(username)) return null;
    if (!roleMatchesLocal(claim.role, username)) return null;
    return safeDashboardUrl(claim.dashboardUrl, identity?.tripId);
  }
  // An organizer on this trip however they got in: through the gateway (the
  // claim's pinned URL, as above) or directly. The direct case reads no request
  // input at all: the person must be an active participant and a CURRENT local
  // organizer, and the URL is the configured one. Members and the agent key
  // (no username that is an organizer here) get nothing.
  function dashboardUrlForOrganizer(claim, username) {
    const managed = dashboardUrlFor(claim, username);
    // Configuration knows the portal's origin and the gateway's claim need not
    // be trusted for it: where both exist and differ, configuration wins.
    if (managed && (!configuredDashboardUrl || managed === configuredDashboardUrl)) return managed;
    if (!configuredDashboardUrl || !activeUser(username) || !organizers().includes(username)) return null;
    return configuredDashboardUrl;
  }
  // Is this verified payload a session that came from a GROUP CLAIM (docs/specs/sprint-9/x-member-sign-in.md, slice S1)?
  // That is a managed member session whose binding was ADOPTED (no invite behind it): the control plane let a person in
  // the trip's Telegram group stand in for an existing participant, and the binding ends when the claim does. Such a
  // session may OPEN the trip and use it as the traveller, but it must never mint a credential that outlives the
  // binding: a password, a Google link, an MCP connection. Everything else (a plain password login, an invite-bound
  // managed member, an owner or organizer, a secondary organizer) is NOT this. Read from the stored binding on every
  // call, never from the token: the claim in the token is only a pointer to the row.
  function isClaimedSessionPayload(payload) {
    if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'controlPlane')) return false;
    if (!validManagedPayload(payload)) return false;
    const row = find.get(payload.controlPlane.userId, identity.tripId);
    return Boolean(row && row.role === 'member' && (row.invite_id === null || row.invite_id === undefined) && !isSecondaryUsername(row.username));
  }
  // Is this verified payload ANY managed MEMBER session: a group claim OR an invite-bound member? Read from the stored binding on
  // every call, never from the token. NOT a plain password login, not an owner's or an organizer's managed session, not a
  // secondary organizer. (The wider question, "may this session mint a site credential?", is isManagedSignInPayload below.)
  function isManagedMemberPayload(payload) {
    if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'controlPlane')) return false;
    if (!validManagedPayload(payload)) return false;
    const row = find.get(payload.controlPlane.userId, identity.tripId);
    return Boolean(row && row.role === 'member' && !isSecondaryUsername(row.username));
  }
  // Is this verified payload a managed session whose ONLY way in is the control plane's, and so may not mint a credential on this
  // site that outlives it: a group claim, an invite-bound member, or a SECONDARY organizer? Each is a person the control plane
  // vouches for and can stop vouching for; a site password (a direct login on the trip's own hostname holds a plain 30-day JWT no
  // removal reaches) or a Google link would outlive that. NOT the trip's own accounts: the owner's managed session and the
  // configured organizers' plain logins, nor any plain password login. This is the ONE predicate the credential routes and
  // `sign_in_managed` on /api/auth/me use; the claim-only and invite-only predicates stay narrower, for what is specific to them.
  function isManagedSignInPayload(payload) {
    return isManagedMemberPayload(payload) || isSecondaryOrganizerPayload(payload);
  }
  // What an assistant connection approved by this session must remember: { userId, inviteId } of an INVITE binding, else null.
  // Never from the token's claims alone: the row is read. A claim binding (no invite) returns null, and may not approve anyway.
  function inviteBindingOf(payload) {
    if (!isManagedMemberPayload(payload)) return null;
    const row = find.get(payload.controlPlane.userId, identity.tripId);
    return row && typeof row.invite_id === 'string' ? { userId: row.user_id, inviteId: row.invite_id } : null;
  }
  // Is this verified payload a SECONDARY organizer of this trip? Only a managed claim counts - a plain password, Telegram or
  // Google token for a secondary username is nothing here (nobody knows the random password it is created with, and it has no
  // Telegram or Google link) - and it is re-checked against the stored binding on every request, so a removed or never-bound
  // identity is not one. Such a session may not set a site password or link Google (isManagedSignInPayload): the control plane
  // can stop vouching for them, and a site credential would outlive that (owner's decision, 2026-11-22).
  function isSecondaryOrganizerPayload(payload) {
    if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'controlPlane')) return false;
    if (!validManagedPayload(payload)) return false;
    const subject = payload.controlPlane;
    if (subject.role !== 'organizer' || !identity) return false;
    const row = findSecondary.get(subject.userId, identity.tripId);
    return Boolean(row && row.username === payload.username);
  }
  // `internal` is exported so a second module can mount a route behind the same gate (the plan-changes read, video Release 1C).
  return { internal, validManagedPayload, isClaimedSessionPayload, isManagedMemberPayload, isManagedSignInPayload, inviteBindingOf, dashboardUrlFor, dashboardUrlForOrganizer, isSecondaryOrganizerPayload, isSecondaryUsername };
}
module.exports = { createControlPlaneAuth, safeDashboardUrl, safePortalOrigin };
