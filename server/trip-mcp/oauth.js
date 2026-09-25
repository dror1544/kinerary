// OAuth 2.1 authorization server for the trip site's own MCP endpoint.
//
// The site is both the authorization server and the protected resource, so an
// organizer connects Claude or ChatGPT by pasting one URL and signing in with
// the login they already use here. Nothing is shared between trips: every
// client, code, grant and token lives in this trip's own database, so a token
// issued by one trip cannot mean anything to another.
//
// Access and refresh tokens are OPAQUE random strings stored only as hashes —
// never a JWT. A site JWT carries no audience, so any JWT signed with this
// trip's secret is a full site session; issuing JWTs here would make every
// MCP token a website login as well. Opaque tokens also give revocation, which
// site sessions do not have.
const crypto = require('crypto');
const net = require('net');

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
// What a connection may do, fixed when it is approved: an organizer grants
// read and write, anyone else on the trip grants read only. A grant never
// widens later — a member promoted to organizer keeps a read-only connection
// until they approve a new one, so nobody holds write access they did not see
// on the consent page.
const SCOPE = 'trip';
const READ_SCOPE = 'trip:read';
// Registration is unauthenticated by design (every MCP client registers itself
// on first connect), so it is bounded instead. A client that has not finished a
// sign-in within this window is dropped (a code only lives five minutes), and
// at the cap the oldest such client is evicted rather than the newcomer
// refused — a refusal would let anyone fill the table and lock organizers out.
const MAX_CLIENTS = 200;
const UNUSED_CLIENT_TTL_S = 15 * 60;

// Where an authorization code may be sent. A code is only as safe as the place
// it lands, and registration is open — and when an attacker starts the flow,
// PKCE is theirs — so the destination is the control. Exact callback URLs of
// the hosted assistants, not whole hosts: any other path or port on those
// hosts is somewhere this trip has no reason to send a code. Plus loopback for
// a local app (Claude Code, MCP Inspector — RFC 8252 §7.3), where the code
// stays on the organizer's own machine. Refused at registration AND authorize.
// TRIP_MCP_EXTRA_REDIRECT_URIS adds exact URLs when a provider moves its own.
const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];
// Loopback by meaning, not by a list of literals: localhost, ::1, or a dotted
// IPv4 address in 127/8. (The release scan rejects IPv4 literals in the
// shipped tree, loopback included, so the range is tested, not spelled.)
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || (net.isIPv4(h) && h.split('.')[0] === '127');
}
const MAX_URI_LENGTH = 2048;

const now = () => Math.floor(Date.now() / 1000);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function redirectAllowed(uri, extraUris = []) {
  if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) return false;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  // Loopback only as written in dotted or named form: `http://2130706433`
  // parses to a loopback address too, and nothing legitimate registers that.
  if (u.protocol === 'http:') {
    const authority = uri.slice('http://'.length).split(/[/?]/)[0].toLowerCase();
    const literal = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
    return literal.replace(/^\[|\]$/g, '') === u.hostname.replace(/^\[|\]$/g, '') && isLoopbackHost(literal);
  }
  return [...DEFAULT_REDIRECT_URIS, ...extraUris].includes(uri);
}

function createOAuthStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      client_name TEXT,
      redirect_uris TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      username TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      grant_id TEXT
    );
    CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
  `);
  // Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS
  // never alters an existing table, and a statement prepared below against a
  // missing column throws at boot — so every later column is added here.
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!columns('mcp_oauth_codes').has('grant_id')) db.exec('ALTER TABLE mcp_oauth_codes ADD COLUMN grant_id TEXT');
  // Rows from before scopes existed were all organizer grants.
  if (!columns('mcp_oauth_codes').has('scope')) db.exec(`ALTER TABLE mcp_oauth_codes ADD COLUMN scope TEXT NOT NULL DEFAULT '${SCOPE}'`);
  if (!columns('mcp_oauth_grants').has('scope')) db.exec(`ALTER TABLE mcp_oauth_grants ADD COLUMN scope TEXT NOT NULL DEFAULT '${SCOPE}'`);

  const q = {
    client: db.prepare('SELECT * FROM mcp_oauth_clients WHERE client_id = ?'),
    countClients: db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients'),
    pruneClients: db.prepare('DELETE FROM mcp_oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM mcp_oauth_grants WHERE revoked_at IS NULL)'),
    evictOldestUnused: db.prepare(`DELETE FROM mcp_oauth_clients WHERE client_id = (
      SELECT client_id FROM mcp_oauth_clients WHERE client_id NOT IN (SELECT client_id FROM mcp_oauth_grants WHERE revoked_at IS NULL)
      ORDER BY created_at ASC LIMIT 1)`),
    insertClient: db.prepare('INSERT INTO mcp_oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at) VALUES (?,?,?,?,?,?)'),
    insertCode: db.prepare('INSERT INTO mcp_oauth_codes (code_hash, client_id, username, redirect_uri, code_challenge, resource, expires_at, scope) VALUES (?,?,?,?,?,?,?,?)'),
    code: db.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash = ?'),
    useCode: db.prepare('UPDATE mcp_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'),
    linkCode: db.prepare('UPDATE mcp_oauth_codes SET grant_id = ? WHERE code_hash = ?'),
    pruneCodes: db.prepare('DELETE FROM mcp_oauth_codes WHERE expires_at < ?'),
    insertGrant: db.prepare('INSERT INTO mcp_oauth_grants (id, client_id, username, created_at, scope) VALUES (?,?,?,?,?)'),
    grant: db.prepare('SELECT * FROM mcp_oauth_grants WHERE id = ?'),
    touchGrant: db.prepare('UPDATE mcp_oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)'),
    revokeGrant: db.prepare('UPDATE mcp_oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeGrantTokens: db.prepare('UPDATE mcp_oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL'),
    activeGrants: db.prepare(`SELECT g.id, g.username, g.scope, g.created_at, g.last_used_at, c.client_name, c.redirect_uris
      FROM mcp_oauth_grants g LEFT JOIN mcp_oauth_clients c ON c.client_id = g.client_id
      WHERE g.revoked_at IS NULL ORDER BY g.created_at DESC`),
    insertToken: db.prepare('INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?,?,?,?)'),
    token: db.prepare('SELECT * FROM mcp_oauth_tokens WHERE token_hash = ?'),
    revokeToken: db.prepare('UPDATE mcp_oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'),
    narrowGrant: db.prepare('UPDATE mcp_oauth_grants SET scope = ? WHERE id = ?'),
    revokeGrantAccess: db.prepare("UPDATE mcp_oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND kind = 'access' AND revoked_at IS NULL"),
    pruneTokens: db.prepare('DELETE FROM mcp_oauth_tokens WHERE expires_at < ?'),
  };

  function revokeGrant(id) {
    const t = now();
    db.transaction(() => { q.revokeGrant.run(t, id); q.revokeGrantTokens.run(t, id); })();
  }

  function issueTokens(grantId, scope) {
    const access = randomToken(), refresh = randomToken(), t = now();
    q.insertToken.run(hash(access), grantId, 'access', t + ACCESS_TTL_S);
    q.insertToken.run(hash(refresh), grantId, 'refresh', t + REFRESH_TTL_S);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  return {
    client: id => (id ? q.client.get(String(id)) : undefined),

    registerClient({ clientName, redirectUris, authMethod }) {
      const t = now();
      q.pruneClients.run(t - UNUSED_CLIENT_TTL_S);
      if (q.countClients.get().n >= MAX_CLIENTS && !q.evictOldestUnused.run().changes) return { error: 'too_many_clients' };
      const clientId = `mcp_${randomToken(16)}`;
      const secret = authMethod === 'none' ? null : randomToken();
      q.insertClient.run(clientId, secret ? hash(secret) : null, clientName, JSON.stringify(redirectUris), authMethod, t);
      return { clientId, clientSecret: secret, issuedAt: t };
    },

    createCode({ clientId, username, redirectUri, codeChallenge, resource, scope }) {
      const code = randomToken();
      q.pruneCodes.run(now() - CODE_TTL_S);
      q.insertCode.run(hash(code), clientId, username, redirectUri, codeChallenge, resource || null, now() + CODE_TTL_S, scope);
      return code;
    },

    // Single use is enforced by the UPDATE ... WHERE used_at IS NULL, so two
    // concurrent exchanges of one code cannot both win. A code presented a
    // second time means someone else has it (RFC 6749 §4.1.2), so the
    // connection it already produced ends too.
    consumeCode(code) {
      const row = q.code.get(hash(code));
      if (!row) return null;
      if (row.used_at) { if (row.grant_id) revokeGrant(row.grant_id); return null; }
      if (row.expires_at < now()) return null;
      if (q.useCode.run(now(), row.code_hash).changes !== 1) return null;
      return row;
    },

    startGrant({ clientId, username, codeHash, scope }) {
      const id = `grant_${randomToken(12)}`;
      q.insertGrant.run(id, clientId, username, now(), scope);
      if (codeHash) q.linkCode.run(id, codeHash);
      return { grantId: id, tokens: issueTokens(id, scope) };
    },

    // Rotation with reuse detection: presenting a refresh token that was
    // already rotated away means two parties hold it, so the whole grant goes.
    rotateRefresh(refreshToken, clientId, stillAllowed, lostWrite = () => false) {
      const row = q.token.get(hash(refreshToken));
      if (!row || row.kind !== 'refresh') return { error: 'invalid_grant' };
      const grant = q.grant.get(row.grant_id);
      if (!grant || grant.revoked_at || grant.client_id !== clientId) return { error: 'invalid_grant' };
      if (row.revoked_at) { revokeGrant(grant.id); return { error: 'invalid_grant' }; }
      if (row.expires_at < now()) return { error: 'invalid_grant' };
      if (!stillAllowed(grant.username)) { revokeGrant(grant.id); return { error: 'invalid_grant' }; }
      if (grant.scope === SCOPE && lostWrite(grant.username)) { q.narrowGrant.run(READ_SCOPE, grant.id); grant.scope = READ_SCOPE; }
      // The refresh replaces the whole pair: the access token it was paired
      // with stops working now, not at the end of its hour.
      db.transaction(() => { q.revokeToken.run(now(), row.token_hash); q.revokeGrantAccess.run(now(), grant.id); })();
      return { tokens: issueTokens(grant.id, grant.scope) };
    },

    // Resolves a bearer token to the grant it belongs to, or null.
    verifyAccess(accessToken) {
      const row = q.token.get(hash(accessToken));
      if (!row || row.kind !== 'access' || row.revoked_at || row.expires_at < now()) return null;
      const grant = q.grant.get(row.grant_id);
      if (!grant || grant.revoked_at) return null;
      const t = now();
      q.touchGrant.run(t, grant.id, t - 60);
      return grant;
    },

    // RFC 7009 allows revoking just the presented token; revoking the grant is
    // what "disconnect" means to the person who asked, so both kinds end it.
    // Only the client the token was issued to may do it (§2.1); anyone else
    // gets the same silent 200, so the endpoint says nothing about the token.
    revokeByToken(token, clientId) {
      const row = q.token.get(hash(token));
      const grant = row && q.grant.get(row.grant_id);
      if (grant && grant.client_id === clientId) revokeGrant(grant.id);
    },

    revokeGrant,
    // Narrowing only: a connection's scope can go down, never up.
    narrowToRead: id => q.narrowGrant.run(READ_SCOPE, id),
    activeGrants: () => q.activeGrants.all(),
    grant: id => q.grant.get(String(id)),
    prune() { const t = now(); q.pruneTokens.run(t); q.pruneCodes.run(t - CODE_TTL_S); },
  };
}

function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return safeEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
}

// client_secret_basic, client_secret_post, or none — as registered. A client
// may not downgrade to a weaker method than the one it registered with.
function authenticateClient(store, req) {
  let clientId = req.body?.client_id, secret = req.body?.client_secret;
  const basic = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    try {
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    } catch { return null; }
  }
  const client = store.client(clientId);
  if (!client) return null;
  if (client.token_endpoint_auth_method === 'none') return client;
  if (!secret || !client.client_secret_hash || !safeEqual(hash(secret), client.client_secret_hash)) return null;
  if (client.token_endpoint_auth_method === 'client_secret_basic' && !basic) return null;
  return client;
}

module.exports = {
  createOAuthStore, redirectAllowed, isLoopbackHost, pkceMatches, authenticateClient, hash,
  SCOPE, READ_SCOPE, ACCESS_TTL_S, DEFAULT_REDIRECT_URIS, MAX_URI_LENGTH,
};
