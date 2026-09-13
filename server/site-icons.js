const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');

// Public visual identity only; never return config values or filesystem paths.
function registerSiteIcons(app, { tripDir, siteDir, getLogo }) {
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
        const logo = getLogo();
        if (typeof logo === 'string' && logo) {
          const root = await fs.realpath(tripDir);
          const file = await fs.realpath(path.resolve(root, logo));
          if (file.startsWith(root + path.sep)) png = await render(file, size);
        }
      } catch { /* Missing or invalid custom logo uses the brand mark. */ }
      png ||= await render(fallback, size);
      res.set('Cache-Control', 'public, max-age=300').type('png').send(png);
    } catch {
      res.sendStatus(503);
    }
  });

  app.get('/api/trip/manifest.webmanifest', (_req, res) => {
    res.type('application/manifest+json').json({
      name: 'Kinerary', short_name: 'Kinerary',
      id: '../../modern/', start_url: '../../modern/', scope: '../../',
      display: 'standalone', background_color: '#ffffff', theme_color: '#0e8f86',
      icons: [192, 512].map(size => ({
        src: `icon/${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any',
      })),
    });
  });
}
module.exports = { registerSiteIcons };
