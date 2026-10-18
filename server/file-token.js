// Short-lived signed links for gallery photo files (issues #191/#194).
//
// An <img> tag cannot send an Authorization header, so GET /api/photos/file/:fn
// cannot sit behind a bearer token the way the rest of the API does. The
// authenticated photo listing hands out a signed link per photo instead:
//   /api/photos/file/<fn>?exp=<unix seconds>&sig=<hex hmac>
// and the file route serves a request that carries a valid, unexpired one
// (or that is authenticated the normal way: the agent key, a runtime-gateway
// session). Nothing is stored: the signature is an HMAC over the filename and
// the expiry.
//
// The key is derived from JWT_SECRET, the secret the server already has and
// every trip already sets: no new secret, no new committed value. It is
// derived under its own label, not used directly, so a photo signature can
// never double as anything else keyed by JWT_SECRET (and vice versa).
//
// FAIL SAFE: anything that is not a well-formed, unexpired, matching
// signature is refused. There is no "unsigned is fine" branch.

const { createHmac, timingSafeEqual } = require('node:crypto');

const DEFAULT_TTL_SECONDS = 60 * 60;

function createFileTokens(secret, { ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
  if (typeof secret !== 'string' || !secret) throw new Error('file-token: a signing secret is required');
  const key = createHmac('sha256', secret).update('kinerary:photo-file:v1').digest();
  const mac = (filename, exp) =>
    createHmac('sha256', key).update(`${exp}\n${filename}`).digest('hex');

  function sign(filename, atMs = now()) {
    const exp = Math.floor(atMs / 1000) + ttlSeconds;
    return { exp, sig: mac(String(filename), exp) };
  }

  function verify(filename, exp, sig) {
    if (typeof filename !== 'string' || !filename) return false;
    if (typeof exp !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
    if (Number(exp) * 1000 <= now()) return false;
    return timingSafeEqual(Buffer.from(mac(filename, exp), 'hex'), Buffer.from(sig, 'hex'));
  }

  return { sign, verify };
}

// Capability links for the /photo/:id share page. Unlike a file link this does
// not expire: it is pasted into a chat and must keep working. It is an HMAC of
// the photo id under its OWN label, so a file signature (or anything else keyed
// from JWT_SECRET) can never be replayed as a share signature.
function createShareTokens(secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('share-token: a signing secret is required');
  const key = createHmac('sha256', secret).update('kinerary:photo-share:v1').digest();
  const mac = (id) => createHmac('sha256', key).update(String(id)).digest('hex');
  return {
    sign: (id) => mac(id),
    verify(id, sig) {
      if (typeof id !== 'string' || !id) return false;
      if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
      return timingSafeEqual(Buffer.from(mac(id), 'hex'), Buffer.from(sig, 'hex'));
    },
  };
}

module.exports = { createFileTokens, createShareTokens };
