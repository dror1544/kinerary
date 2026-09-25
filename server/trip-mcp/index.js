// The trip site's own MCP endpoint, for an organizer's Claude or ChatGPT.
//
// Off unless this trip's environment turns it on:
//   TRIP_MCP_ENABLED=1
//   PUBLIC_ORIGIN=https://<this trip's public hostname>
// The origin is required, not derived from the request: behind the tunnel and
// the proxy the request says http and a LAN host, and an OAuth issuer that
// changes with whoever asked is not an issuer. With the flag on and no usable
// origin the endpoint stays off and says why at boot.
//
// Only the trip's direct hostname works, and requests through the managed
// gateway (/t/<trip>) are refused outright. The gateway turns its cookie into
// an Authorization header on every path, so behind it a bearer token cannot
// pass — and, worse, the consent decision's "a header another site cannot
// set" would become "a cookie any script on the shared gateway origin sends".
//
// Nothing here serves a raw trip.config.json value (CLAUDE.md, the
// sanitizeConfig invariant): the trip's name and phases reach the assistant
// only from getPublicConfig(), and only after an organizer signed in.
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createOAuthStore, redirectAllowed, isLoopbackHost, pkceMatches, authenticateClient, SCOPE } = require('./oauth');
const { renderAuthorizePage, renderErrorPage, renderConnectorInfoPage } = require('./authorize-page');
const { registerTools, buildInstructions } = require('./tools');
const { normalizeOrganizers } = require('../../shared/agent-schema');


function resolveOrigin(raw) {
  if (!raw) return { error: 'PUBLIC_ORIGIN is not set' };
  let u;
  try { u = new URL(raw); } catch { return { error: `PUBLIC_ORIGIN is not a URL: ${raw}` }; }
  if (u.pathname !== '/' || u.search || u.hash) return { error: 'PUBLIC_ORIGIN must be an origin with no path (the gateway path cannot carry a bearer token)' };
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) return { error: 'PUBLIC_ORIGIN must be https' };
  return { origin: u.origin };
}

function registerTripMcp({
  app, db, env = process.env, jwt, jwtSecret, jwtSecretIsDefault, validManagedPayload, organizers, userExists,
  getPublicConfig, organizerOrAgentRequired, listenPort, listenHost,
}) {
  const wanted = ['1', 'true'].includes(String(env.TRIP_MCP_ENABLED || '').toLowerCase());
  let resolved = wanted ? resolveOrigin(env.PUBLIC_ORIGIN) : {};
  // The fallback JWT secret is public (it is in this repository). Anyone can
  // mint a session with it, and the consent step trusts sessions, so a public
  // endpoint must never run on it.
  if (wanted && !resolved.error && jwtSecretIsDefault && !isLoopbackHost(new URL(resolved.origin).hostname)) {
    resolved = { error: 'JWT_SECRET is unset or the built-in development value; refusing to publish sign-in on it' };
  }
  if (wanted && resolved.error) console.error(`[trip-mcp] not enabled: ${resolved.error}`);
  const enabled = wanted && !resolved.error;

  if (!enabled) {
    app.get('/api/mcp/connection', organizerOrAgentRequired, (req, res) =>
      (req.user?.isAgent ? res.status(403).json({ error: 'organizer_only' }) : res.json({ enabled: false })));
    return { enabled: false };
  }

  const origin = resolved.origin;
  const mcpUrl = `${origin}/mcp`;
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const extraRedirectUris = String(env.TRIP_MCP_EXTRA_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
  const store = createOAuthStore(db);
  setInterval(() => store.prune(), 60 * 60 * 1000).unref();

  const isOrganizer = username => organizers().includes(username) && userExists(username);
  // For an already-authenticated organizer only (the MCP server's own name).
  const tripTitle = () => {
    const t = getPublicConfig().meta?.title;
    return (t && typeof t === 'object' ? t.en || t.he : t) || 'Trip';
  };
  // The consent page is pre-login, so its language comes from the browser,
  // not from the trip.
  const browserLang = req => (/^he\b|^iw\b/i.test(String(req.headers['accept-language'] || '')) ? 'he' : 'en');
  const sameResource = r => !r || [mcpUrl, origin, `${mcpUrl}/`, `${origin}/`].includes(String(r));

  app.use(['/mcp', '/oauth', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server'], (req, res, next) => {
    if (req.headers['x-forwarded-prefix']) return res.status(404).json({ error: 'not_found' });
    next();
  });
  // Registration deliberately has no per-address limit. Behind the ingress
  // proxy every caller arrives with the same address, so any limit that
  // refuses would let one stranger lock every organizer out; the store's
  // bounds (URI length, five URIs, eviction at the cap) are what hold storage.

  // Metadata, registration, token and the MCP endpoint itself are called by
  // the assistant's servers, and by browser-based tools such as MCP Inspector.
  // None of them use cookies, so an open CORS policy grants nothing. The
  // consent decision is deliberately NOT in this list.
  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); };
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  // ── Discovery ───────────────────────────────────────────────────────────────
  const protectedResource = (_req, res) => res.json({
    resource: mcpUrl,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  });
  app.all(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], cors, protectedResource);
  app.all(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], cors, (_req, res) => res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  }));

  // ── Dynamic client registration (RFC 7591) ─────────────────────────────────
  app.all('/oauth/register', cors, noStore, (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 5 || !uris.every(u => redirectAllowed(u, extraRedirectUris))) {
      // Logged, bounded and quoted, so that when a provider moves its callback
      // the operator can see the new one and add it to
      // TRIP_MCP_EXTRA_REDIRECT_URIS instead of guessing.
      console.warn(`[trip-mcp] registration refused, redirect_uris ${JSON.stringify(uris.slice(0, 5).map(u => u.slice(0, 200)))}`);
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be the assistant\'s own callback (Claude, ChatGPT) or a loopback address' });
    }
    const method = b.token_endpoint_auth_method || 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'unsupported token_endpoint_auth_method' });
    }
    const grants = b.grant_types || ['authorization_code'];
    if (!Array.isArray(grants) || grants.some(g => !['authorization_code', 'refresh_token'].includes(g))) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'unsupported grant_types' });
    }
    const clientName = typeof b.client_name === 'string' ? b.client_name.slice(0, 80) : null;
    const reg = store.registerClient({ clientName, redirectUris: uris, authMethod: method });
    if (reg.error) return res.status(429).json({ error: 'temporarily_unavailable', error_description: 'too many registered clients' });
    res.status(201).json({
      client_id: reg.clientId,
      ...(reg.clientSecret ? { client_secret: reg.clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: reg.issuedAt,
      client_name: clientName || undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    });
  });

  // ── Authorization ───────────────────────────────────────────────────────────
  // Returns { fatal } for a request that must not be redirected anywhere (an
  // unknown client or destination — redirecting would make this an open
  // redirector), { redirectError } for one that can safely go back, or the
  // validated request.
  function validateAuthRequest(p) {
    const client = store.client(p.client_id);
    if (!client) return { fatal: 'The app asking to connect is not registered with this trip. Start the connection again from Claude or ChatGPT.' };
    const registered = JSON.parse(client.redirect_uris);
    const redirectUri = p.redirect_uri || (registered.length === 1 ? registered[0] : null);
    if (!redirectUri || !registered.includes(redirectUri) || !redirectAllowed(redirectUri, extraRedirectUris)) {
      return { fatal: 'The return address in this request does not match the app that registered.' };
    }
    const back = { client, redirectUri, state: p.state };
    if (p.response_type !== 'code') return { ...back, redirectError: 'unsupported_response_type' };
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return { ...back, redirectError: 'invalid_request', description: 'PKCE with S256 is required' };
    if (!sameResource(p.resource)) return { ...back, redirectError: 'invalid_target' };
    return { ...back, codeChallenge: String(p.code_challenge), resource: p.resource ? String(p.resource) : null };
  }

  function redirectWith(uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    u.searchParams.set('iss', origin);
    return u.toString();
  }

  app.get('/oauth/authorize', noStore, (req, res) => {
    const v = validateAuthRequest(req.query);
    if (v.fatal) return res.status(400).type('html').send(renderErrorPage(v.fatal));
    if (v.redirectError) return res.redirect(302, redirectWith(v.redirectUri, { error: v.redirectError, error_description: v.description, state: v.state }));
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://accounts.google.com/gsi/client`,
      `style-src 'nonce-${nonce}' https://accounts.google.com/gsi/style`,
      "connect-src 'self' https://accounts.google.com/gsi/",
      'frame-src https://accounts.google.com/gsi/',
      "img-src 'self' data: https://*.googleusercontent.com",
      "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
    ].join('; '));
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    const host = new URL(v.redirectUri).hostname;
    const q = req.query;
    res.type('html').send(renderAuthorizePage({
      nonce, lang: browserLang(req),
      clientName: v.client.client_name, redirectHost: host, isLoopback: isLoopbackHost(host),
      params: {
        client_id: q.client_id, redirect_uri: v.redirectUri, response_type: q.response_type,
        code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method,
        state: q.state, resource: q.resource, scope: q.scope,
      },
    }));
  });

  // The session is the site's own, presented as a Bearer header by the page
  // above — a header another site's form cannot set. The Origin check is the
  // second lock: fetch() always sends Origin on a POST, and only a page served
  // from this trip's own hostname carries this one.
  function sessionUser(req) {
    if (req.headers.origin !== origin) return null;
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    try {
      const payload = jwt.verify(m[1], jwtSecret, { algorithms: ['HS256'] });
      if (!payload?.username || !validManagedPayload(payload)) return null;
      return payload.username;
    } catch { return null; }
  }

  app.post('/oauth/authorize/decision', noStore, (req, res) => {
    const b = req.body || {};
    const v = validateAuthRequest(b);
    if (v.fatal) return res.status(400).json({ error: 'invalid_request' });
    if (v.redirectError) return res.json({ redirect_to: redirectWith(v.redirectUri, { error: v.redirectError, state: v.state }) });
    const username = sessionUser(req);
    if (!username) return res.status(401).json({ error: 'unauthorized' });
    if (!isOrganizer(username)) return res.status(403).json({ error: 'organizer_only' });
    if (b.decision !== 'allow') return res.json({ redirect_to: redirectWith(v.redirectUri, { error: 'access_denied', state: v.state }) });
    const code = store.createCode({
      clientId: v.client.client_id, username, redirectUri: v.redirectUri,
      codeChallenge: v.codeChallenge, resource: v.resource,
    });
    console.log(`[trip-mcp] ${username} approved ${v.client.client_name || v.client.client_id} (${new URL(v.redirectUri).hostname})`);
    res.json({ redirect_to: redirectWith(v.redirectUri, { code, state: v.state }) });
  });

  // ── Token ───────────────────────────────────────────────────────────────────
  app.all('/oauth/token', cors, noStore, form, (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const b = req.body || {};
    const client = authenticateClient(store, req);
    if (!client) return res.status(401).json({ error: 'invalid_client' });
    const invalid = description => res.status(400).json({ error: 'invalid_grant', ...(description ? { error_description: description } : {}) });

    if (b.grant_type === 'authorization_code') {
      const row = b.code ? store.consumeCode(String(b.code)) : null;
      if (!row || row.client_id !== client.client_id) return invalid();
      if (b.redirect_uri && b.redirect_uri !== row.redirect_uri) return invalid('redirect_uri mismatch');
      if (!pkceMatches(b.code_verifier, row.code_challenge)) return invalid('code_verifier mismatch');
      if (b.resource && !sameResource(b.resource)) return res.status(400).json({ error: 'invalid_target' });
      if (!isOrganizer(row.username)) return invalid('no longer an organizer of this trip');
      return res.json(store.startGrant({ clientId: client.client_id, username: row.username, codeHash: row.code_hash }).tokens);
    }
    if (b.grant_type === 'refresh_token') {
      if (!b.refresh_token) return invalid();
      const r = store.rotateRefresh(String(b.refresh_token), client.client_id, isOrganizer);
      return r.error ? invalid() : res.json(r.tokens);
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.all('/oauth/revoke', cors, noStore, form, (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const client = authenticateClient(store, req);
    if (!client) return res.status(401).json({ error: 'invalid_client' });
    if (req.body?.token) store.revokeByToken(String(req.body.token), client.client_id);
    res.status(200).end();
  });

  // ── The MCP endpoint ────────────────────────────────────────────────────────
  const challenge = (res, error) => {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"${error ? `, error="${error}"` : ''}, scope="${SCOPE}"`);
    res.status(401).json({ error: error || 'unauthorized' });
  };
  function requireAccess(req, res, next) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return challenge(res);
    const grant = store.verifyAccess(m[1]);
    if (!grant) return challenge(res, 'invalid_token');
    // Organizer status lives in the trip config and can be taken away; a
    // connection made by someone who is no longer an organizer ends here.
    if (!isOrganizer(grant.username)) { store.revokeGrant(grant.id); return challenge(res, 'invalid_token'); }
    req.mcpGrant = grant;
    next();
  }

  // Tools reach the site over loopback, authenticated as the organizer with a
  // two-minute site session minted per call — so every route applies exactly
  // the checks it applies to that organizer in a browser.
  // This server's own listener: `localhost` when it listens on every address
  // (the default), otherwise the address it was told to bind.
  const loopHost = !listenHost ? 'localhost' : listenHost.includes(':') ? `[${listenHost}]` : listenHost;
  const siteBase = `http://${loopHost}:${listenPort}`;
  function siteClient(username) {
    const call = async (method, path, body) => {
      const token = jwt.sign({ username }, jwtSecret, { expiresIn: 120 });
      const r = await fetch(`${siteBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300)}`);
      return data;
    };
    return {
      get: path => call('GET', path),
      post: (path, body) => call('POST', path, body ?? {}),
      patch: (path, body) => call('PATCH', path, body ?? {}),
      del: path => call('DELETE', path),
    };
  }

  // Stateless: a fresh server per request, so nothing about one organizer's
  // session can leak into another's, and a restart loses nothing.
  app.post('/mcp', cors, requireAccess, async (req, res) => {
    const server = new McpServer(
      { name: 'kinerary-trip', title: tripTitle(), version: '1.0.0' },
      { instructions: (cfg => buildInstructions(cfg, normalizeOrganizers(cfg.agent)))(getPublicConfig()) },
    );
    registerTools(server, siteClient(req.mcpGrant.username));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[trip-mcp] request failed:', err.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });
  app.options('/mcp', cors);
  // A person who opens the address in a browser (or lands on /modern/mcp,
  // because the site sends browsers to /modern/) gets an explanation instead
  // of a raw error. Only for requests asking for HTML; clients get the 405.
  app.get(['/mcp', '/modern/mcp'], (req, res, next) => {
    if (req.accepts(['json', 'html']) !== 'html') return next();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderConnectorInfoPage({ url: mcpUrl, lang: browserLang(req) }));
  });
  app.all('/mcp', cors, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }));

  // ── The organizer's view of connected assistants ───────────────────────────
  // A person, never the agent key: the companion's context is full of text
  // travellers typed, and one crafted message must not be able to disconnect
  // an organizer's assistant.
  const organizerOnly = (req, res, next) => organizerOrAgentRequired(req, res, () =>
    (req.user?.isAgent ? res.status(403).json({ error: 'organizer_only' }) : next()));
  app.get('/api/mcp/connection', organizerOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: true,
      url: mcpUrl,
      // Someone who is no longer an organizer has lost their connection
      // already (requireAccess ends it on next use); do not list it as live.
      connections: store.activeGrants().filter(g => isOrganizer(g.username)).map(g => {
        let host = null;
        try { host = new URL(JSON.parse(g.redirect_uris || '[]')[0]).hostname; } catch { /* client pruned */ }
        return {
          id: g.id, username: g.username,
          // The name is whatever the app registered with; the host is where
          // its codes go, and is the part nobody can choose freely.
          client: g.client_name || host || 'Unknown app',
          host,
          connected_at: new Date(g.created_at * 1000).toISOString(),
          last_used_at: g.last_used_at ? new Date(g.last_used_at * 1000).toISOString() : null,
        };
      }),
    });
  });
  app.delete('/api/mcp/connections/:id', organizerOnly, (req, res) => {
    const grant = store.grant(req.params.id);
    if (!grant || grant.revoked_at) return res.status(404).json({ error: 'not_found' });
    store.revokeGrant(grant.id);
    console.log(`[trip-mcp] ${req.user.username} disconnected ${grant.id} (${grant.username})`);
    res.json({ ok: true });
  });

  console.log(`[trip-mcp] enabled at ${mcpUrl}`);
  return { enabled: true, mcpUrl };
}

module.exports = { registerTripMcp, resolveOrigin };
