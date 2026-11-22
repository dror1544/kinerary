'use strict';

/**
 * Route registry for the shared trip-mcp bridge (mcp.js with MCP_ROUTES_DIR).
 *
 * One process serves every trip. A companion holds one opaque token; this file
 * turns that token into the trip it may reach. The directory is the whole
 * database: one `<slug>.json` per trip (docs/specs/sprint-9/
 * x-wildcard-host-and-shared-bridge.md, AC-B1.2). Adding a trip is writing a
 * file; removing one is deleting it; neither needs a restart.
 *
 * What a route file holds, and why it is treated with care:
 *   - the trip site's address and its AGENT KEY — this process holds every
 *     trip's key where each per-trip bridge held one, so a file that others can
 *     read, or that is a link to somewhere else, is refused;
 *   - only the SHA-256 of the token, never the token, so reading the directory
 *     does not let anyone speak as a companion.
 *
 * Fail-safe in every direction: a file that does not parse cleanly is ignored
 * (the trip then has no route, which is a 401 — not a guess); two files that
 * claim the same token are BOTH ignored (neither can be said to be the owner);
 * and the log names a trip by its slug and a problem by its reason, never by an
 * address, a key, a token or any part of a file's contents.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const SLUG_RE   = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const HASH_RE   = /^[0-9a-f]{64}$/;
// The same alphabet companion-install-host.sh accepts when it writes the file.
const KEY_RE    = /^[A-Za-z0-9._~+/=-]{16,256}$/;
const MAX_BYTES = 16 * 1024;
const RESCAN_MS = 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** A plain http(s) origin: no credentials, no path, no query, no fragment. */
function plainOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (value.includes('?') || value.includes('#')) return null;
  return u.origin;
}

/**
 * Read and validate one route file. Returns `{ route }` or `{ reason }`.
 * `reason` is a fixed phrase: it must never carry anything from the file.
 */
function loadRouteFile(dir, name) {
  const full = path.join(dir, name);
  const slug = name.slice(0, -'.json'.length);
  if (!SLUG_RE.test(slug)) return { reason: 'file name is not a valid trip slug' };

  let fd;
  try {
    // O_NOFOLLOW closes the gap between the lstat that found the file and this
    // open: a link swapped in between is refused by the kernel, not followed.
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (e) {
    return { reason: e && e.code === 'ELOOP' ? 'is a symlink' : 'cannot be opened' };
  }
  let raw;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { reason: 'is not a regular file' };
    // Any group/other bit, not only read: a file others can write is a file
    // others can point a trip's key at their own server with.
    if (st.mode & 0o077) return { reason: 'is accessible to group or others' };
    if (st.size > MAX_BYTES) return { reason: 'is too large' };
    raw = fs.readFileSync(fd, 'utf8');
  } catch {
    return { reason: 'cannot be read' };
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing to do */ }
  }

  let doc;
  try { doc = JSON.parse(raw); } catch { return { reason: 'is not valid JSON' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { reason: 'is not a JSON object' };
  if (doc.schema_version !== SCHEMA_VERSION) return { reason: 'has an unknown schema_version' };
  if (doc.trip !== slug) return { reason: 'names a different trip than its file name' };

  const apiBase = plainOrigin(doc.api_base_url);
  if (!apiBase) return { reason: 'has an api_base_url that is not a plain http(s) origin' };

  let publicBase = null;
  if (doc.public_url !== undefined && doc.public_url !== null) {
    publicBase = plainOrigin(doc.public_url);
    if (!publicBase) return { reason: 'has a public_url that is not a plain http(s) origin' };
  }

  if (typeof doc.trip_api_key !== 'string' || !KEY_RE.test(doc.trip_api_key)) {
    return { reason: 'has a trip_api_key that is missing or malformed' };
  }
  if (typeof doc.token_sha256 !== 'string' || !HASH_RE.test(doc.token_sha256)) {
    return { reason: 'has a token_sha256 that is not 64 lowercase hex characters' };
  }

  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  return {
    route: Object.freeze({
      slug,
      apiBase,
      publicBase,
      tripKey: doc.trip_api_key,
      tripKeyHash: sha256(doc.trip_api_key),
      tokenHash: Buffer.from(doc.token_sha256, 'hex'),
      tokenHex: doc.token_sha256,
      digest,
    }),
  };
}

/**
 * @param {object}   opts
 * @param {string}   opts.dir          MCP_ROUTES_DIR
 * @param {function} opts.log          one-line logger (never given a secret)
 * @param {function} opts.onChange     called with the effective routes Map after
 *                                     any scan that added, removed or altered one
 * @param {number}   [opts.intervalMs] rescan period; also the floor between scans
 */
function createRouteRegistry({ dir, log, onChange, intervalMs = RESCAN_MS }) {
  const cache  = new Map();   // file name -> { fp, route, reason, dup }
  let effective = new Map();  // slug -> route
  let lastScan  = 0;
  let timer     = null;
  let dirOk     = true;

  function scan() {
    lastScan = Date.now();
    let names = null;
    try {
      names = fs.readdirSync(dir);
      if (!dirOk) { dirOk = true; log('routes directory is readable again'); }
    } catch {
      names = [];
      if (dirOk) { dirOk = false; log('routes directory cannot be read; no trip is routable'); }
    }

    const seen = new Set();
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      let lst;
      try { lst = fs.lstatSync(path.join(dir, name)); } catch { continue; }
      seen.add(name);
      const fp = [lst.ino, lst.size, lst.mtimeMs, lst.ctimeMs, lst.mode].join(':');
      const prev = cache.get(name);
      if (prev && prev.fp === fp) continue;

      let result;
      if (lst.isSymbolicLink()) result = { reason: 'is a symlink' };
      else result = loadRouteFile(dir, name);

      const entry = { fp, route: result.route || null, reason: result.reason || null, dup: false };
      // An unchanged file keeps its route object, so "did this route change?"
      // is an identity check everywhere else (open sessions, /messages).
      if (entry.route && prev && prev.route && prev.route.digest === entry.route.digest) entry.route = prev.route;
      if (entry.reason && (!prev || prev.reason !== entry.reason)) {
        log(`route file ${safeName(name)} ignored: ${entry.reason}`);
      }
      cache.set(name, entry);
    }
    for (const name of [...cache.keys()]) if (!seen.has(name)) cache.delete(name);

    // Two files, one token: neither is the owner, so neither is routable.
    const byHash = new Map();
    for (const e of cache.values()) {
      if (!e.route) continue;
      byHash.set(e.route.tokenHex, (byHash.get(e.route.tokenHex) || 0) + 1);
    }
    const next = new Map();
    for (const [name, e] of cache) {
      if (!e.route) continue;
      const isDup = byHash.get(e.route.tokenHex) > 1;
      if (isDup && !e.dup) log(`route file ${safeName(name)} ignored: shares its token with another route`);
      e.dup = isDup;
      if (!isDup) next.set(e.route.slug, e.route);
    }

    let changed = next.size !== effective.size;
    for (const [slug, route] of next) {
      if (effective.get(slug) !== route) {
        changed = true;
        if (!effective.has(slug)) log(`route ${slug} added`);
      }
    }
    for (const slug of effective.keys()) {
      if (!next.has(slug)) { changed = true; log(`route ${slug} removed`); }
    }
    effective = next;
    if (changed) onChange(effective);
  }

  /** Rescan if the last scan is older than the interval. Cheap enough per request. */
  function refresh() {
    if (Date.now() - lastScan >= intervalMs) scan();
  }

  function start() {
    scan();
    timer = setInterval(scan, intervalMs);
    timer.unref();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  /**
   * The route whose token this is, or null. The presented value is hashed and
   * compared against EVERY route's hash in constant time, without stopping at
   * the first hit, so the time taken says nothing about which route (if any)
   * it was close to.
   */
  function resolveToken(presented) {
    if (!presented) return null;
    const h = sha256(presented);
    let hit = null;
    for (const r of effective.values()) {
      if (crypto.timingSafeEqual(h, r.tokenHash)) hit = r;
    }
    return hit;
  }

  /**
   * The route whose own trip key this is — for the two routes the trip SITE
   * calls (/extract, /enrich), which hold the trip key and no token. Two trips
   * sharing a key is ambiguous and therefore refused.
   */
  function resolveTripKey(presented) {
    if (!presented) return null;
    const h = sha256(presented);
    const hits = [];
    for (const r of effective.values()) {
      if (crypto.timingSafeEqual(h, r.tripKeyHash)) hits.push(r);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  return {
    start, stop, refresh, scan, resolveToken, resolveTripKey,
    get: (slug) => effective.get(slug) || null,
    get size() { return effective.size; },
  };
}

/** A file name safe to put in a log line. */
function safeName(name) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) ? name : '<unprintable name>';
}

module.exports = { createRouteRegistry, loadRouteFile, plainOrigin, SCHEMA_VERSION, KEY_RE };
