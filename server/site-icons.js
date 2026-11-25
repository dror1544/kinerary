const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');

// ── The trip's logo: one resolver, three readers ─────────────────────────────
// docs/specs/sprint-9/x-trip-logo.md. The logo is, in order:
//   1. an upload an organizer made on the site (a PNG WE re-encoded, in MEDIA_DIR, named in the trip SQLite),
//   2. `meta.logo` in trip.config.json, a file inside the TRIP directory (what the scaffolder writes),
//   3. nothing — the callers fall back to the Kinerary mark.
// GET /api/trip/logo, the PWA icons and the settings the site reads (`uiSettings()`) all ask this one function,
// so they cannot disagree again. The containment check is per source: an upload must resolve inside the media
// directory, a config file inside the trip directory.

// Image extensions only. meta.logo is a config value, and realpath containment alone still lets it name
// trip.config.json, .env or a script that sits INSIDE the trip directory; the extension allow-list is what stops that.
const LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
// What an upload is called on disk. Content-addressed, so the same image twice is the same file. The public route
// serves only a name that matches this and is the one the database holds — never a request-derived name — because
// the media directory also holds the trip's private hero pictures.
const UPLOAD_NAME = /^logo-[0-9a-f]{16}\.png$/;
const HASH = /^[0-9a-f]{16}$/;
const NONE = Object.freeze({ file: null, hash: null, source: 'none' });

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

/**
 * @param {object} o
 * @param {string} o.tripDir          where meta.logo is read from
 * @param {string} [o.mediaDir]       where uploads live (omit: no upload source)
 * @param {() => {file?: string, hash?: string}|null|undefined} [o.getUpload]  the stored upload (file name, hash), or nothing
 * @param {() => unknown} o.getConfigLogo   meta.logo as the file says it
 * @returns {() => {file: string|null, hash: string|null, source: 'upload'|'config'|'none'}}
 */
function createEffectiveLogo({ tripDir, mediaDir, getUpload = () => null, getConfigLogo, log = console }) {
  const configHashes = new Map();
  let warnedMissing = null;

  function fromUpload() {
    if (!mediaDir) return null;
    const stored = getUpload();
    const name = stored && stored.file;
    if (typeof name !== 'string' || !UPLOAD_NAME.test(name)) return null;
    try {
      const root = fsSync.realpathSync(mediaDir);
      const file = fsSync.realpathSync(path.join(root, name));
      if (!inside(root, file) || !fsSync.statSync(file).isFile()) return null;
      const hash = typeof stored.hash === 'string' && HASH.test(stored.hash) ? stored.hash : hashOf(fsSync.readFileSync(file));
      return { file, hash, source: 'upload' };
    } catch {
      // The database names a logo whose file is gone: say so once, then use what is below it.
      if (warnedMissing !== name) { warnedMissing = name; log.warn(`trip logo: the stored upload ${name} is not readable; falling back`); }
      return null;
    }
  }

  function fromConfig() {
    const logo = getConfigLogo();
    if (typeof logo !== 'string' || !logo) return null;
    try {
      const root = fsSync.realpathSync(tripDir);
      const file = fsSync.realpathSync(path.resolve(root, logo));
      if (!inside(root, file)) return null;
      if (!LOGO_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
      const stat = fsSync.statSync(file);
      if (!stat.isFile()) return null;
      const key = `${file}:${stat.mtimeMs}:${stat.size}`;
      let hash = configHashes.get(key);
      if (!hash) {
        hash = hashOf(fsSync.readFileSync(file));
        if (configHashes.size >= 8) configHashes.clear();
        configHashes.set(key, hash);
      }
      return { file, hash, source: 'config' };
    } catch { return null; }
  }

  return () => fromUpload() || fromConfig() || NONE;
}

/**
 * An organizer's upload, as the bytes we keep: a PNG we encoded ourselves. Throws `invalid_image` for anything that
 * is not a PNG, JPEG, WebP or GIF (sharp also reads SVG and, with the right build, PDF — the format allow-list, not
 * "sharp could open it", is the check), or that is over 40 megapixels. Orientation is applied, metadata is dropped,
 * and the picture is fitted inside 1024x1024 without being enlarged. A polyglot (an image with a script appended) comes
 * out as just the image: the client's bytes are never served as sent.
 */
async function normalizeLogoUpload(bytes) {
  const invalid = (cause) => Object.assign(new Error('invalid_image'), { code: 'invalid_image', cause });
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw invalid();
  try {
    const image = sharp(bytes, { limitInputPixels: 40000000 });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) throw invalid();
    if (!meta.width || !(meta.pageHeight || meta.height) || meta.width * (meta.pageHeight || meta.height) > 40000000) throw invalid();
    return await image.rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch (err) {
    throw err.code === 'invalid_image' ? err : invalid(err);
  }
}

// What the installed app is called: the trip's title, and its first 12 characters as the short name (D2). By code
// point, so an emoji or a Hebrew letter is never cut in half. No title: Kinerary, as before.
function appNames(title) {
  const name = typeof title === 'string' ? title.trim() : '';
  if (!name) return { name: 'Kinerary', short_name: 'Kinerary' };
  return { name, short_name: [...name].slice(0, 12).join('').trim() || 'Kinerary' };
}

// Public visual identity only; never return config values or filesystem paths.
// `effectiveLogo` is the resolver above; a caller that only has a config value (`getLogo`) gets one over the trip directory.
// `getTitle` is the trip's PUBLIC title (the allow-listed projection, as /api/config/roster picks its fields).
function registerSiteIcons(app, { tripDir, siteDir, getLogo, effectiveLogo, getTitle = () => null }) {
  const resolve = effectiveLogo || createEffectiveLogo({ tripDir, getConfigLogo: getLogo });
  const sizes = new Set([32, 180, 192, 512]);
  const cache = new Map();
  const fallback = path.join(siteDir, 'brand/favicon.svg');

  async function render(file, size) {
    const source = await fs.readFile(file);
    const key = `${createHash('sha256').update(source).digest('hex')}:${size}`;
    if (cache.has(key)) return cache.get(key);
    const png = await sharp(source, { limitInputPixels: 40000000 })
      .rotate().resize(size, size, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' }).png().toBuffer();
    if (cache.size >= 16) cache.clear();
    cache.set(key, png);
    return png;
  }

  app.get('/api/trip/icon/:size.png', async (req, res) => {
    const size = Number(req.params.size);
    if (!sizes.has(size)) return res.sendStatus(404);
    try {
      let png;
      try {
        const logo = resolve();
        if (logo.file) png = await render(logo.file, size);
      } catch { /* Missing or invalid custom logo uses the brand mark. */ }
      png ||= await render(fallback, size);
      res.set('Cache-Control', 'public, max-age=300').type('png').send(png);
    } catch {
      res.sendStatus(503);
    }
  });

  app.get('/api/trip/manifest.webmanifest', (_req, res) => {
    const { hash } = resolve();
    // The version is what makes a changed logo a different icon URL for a browser or an install that cached the old one.
    const version = hash ? `?v=${hash}` : '';
    res.type('application/manifest+json').json({
      ...appNames(getTitle()),
      id: '../../modern/', start_url: '../../modern/', scope: '../../',
      display: 'standalone', background_color: '#ffffff', theme_color: '#0e8f86',
      icons: [192, 512].map(size => ({
        src: `icon/${size}.png${version}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any',
      })),
    });
  });
}
module.exports = { registerSiteIcons, createEffectiveLogo, normalizeLogoUpload, appNames, UPLOAD_NAME, LOGO_EXTENSIONS };
