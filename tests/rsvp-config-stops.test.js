/**
 * rsvp-config-stops.test.js — RSVP and ratings on stops built from config.
 *
 * Review of the 2026-10-10/11 manual test, verified against d72c30c:
 *   (a) an RSVP card never rendered on a config-built stop: the boot loaded
 *       RSVPs into `#rsvps-<id>` while buildPhaseNav() creates `#rsvp-<id>`;
 *   (b) after a click the card never refreshed: setRsvp() spread
 *       RSVP_ACTIVITIES.co / .wc, which a config-built trip does not have,
 *       and the TypeError was swallowed;
 *   (c) loadRatings() threw when a stop named ny/dallas/colorado/wc had no
 *       venues — renderRatings(undefined) — which skipped the config-driven
 *       ratings loop for every stop after it.
 *
 * "RSVP is a feature used mainly on large-group trips" (owner, 2026-10-11).
 *
 * Unlike the extracted-function suites, this boots the REAL site/app.js (and
 * translations.js) against site/classic.html in happy-dom, with fetch stubbed
 * from the fixture trip — the bug in (a) lived between two functions and the
 * boot sequence, which no single extracted function shows. No server, so no
 * port.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Window } from 'happy-dom';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', 'site');
// The page without its scripts: app.js and translations.js are evaluated
// below, and the CDN scripts (Google sign-in, Leaflet, Cropper) are not needed.
const PAGE = readFileSync(join(SITE, 'classic.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const APP = readFileSync(join(SITE, 'app.js'), 'utf8');
const TRANSLATIONS = readFileSync(join(SITE, 'translations.js'), 'utf8');
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// An id with a space and a slash: it must stay URL-encoded on the wire.
const ACT_ID = 'boat tour/1';
const ACTIVITY = { id: ACT_ID, title: { he: 'שייט בנהר', en: 'River boat' }, date: '2027-03-11', price: { he: '20 דולר', en: '$20' } };

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function until(pred, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await settle(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Boot the Classic site with `cfg` as /api/config, signed in as dana.
 * Returns the window, every request made, every POST body, and every
 * unhandled rejection raised while booting (a swallowed boot error is the bug
 * class here, so it is collected rather than ignored).
 */
async function boot(cfg) {
  const rejections = [];
  const onRejection = (e) => rejections.push(String(e?.stack || e));
  process.on('unhandledRejection', onRejection);

  const win = new Window({
    url: 'http://localhost/classic.html',
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  win.document.write(PAGE);   // fires the window's load event once app.js is in

  const rsvps = {};        // the stand-in server's RSVP table: activity id -> [{username, status}]
  const calls = [];
  const posts = [];
  const user = { username: 'dana', name: 'דנה', name_en: 'Dana', color: '#3B82F6' };
  win.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push(`${method} ${path}`);
    const json = (body, status = 200) => new win.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const m = path.match(/^\/api\/rsvps\/([^/?]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'POST') {
        const { status } = JSON.parse(opts.body);
        posts.push({ path, status });
        rsvps[id] = (rsvps[id] || []).filter(r => r.username !== user.username).concat({ username: user.username, status, user });
        return json({ ok: true });
      }
      return json(rsvps[id] || []);
    }
    if (path === '/api/auth/me') return json(user);
    if (path === '/api/config') return json(cfg);
    if (path === '/api/config/roster') return json({ participants: [] });
    if (path === '/api/ratings') return json({});
    if (path === '/api/users') return json([user]);
    return json([]);
  };
  win.localStorage.setItem('trip-token', 'test-token');
  win.localStorage.setItem('trip-user', JSON.stringify(user));

  win.eval(TRANSLATIONS);
  win.eval(APP);
  await until(() => calls.includes('GET /api/ratings'), 'the signed-in boot to reach loadRatings');
  await settle(80);

  const done = async () => {
    process.off('unhandledRejection', onRejection);
    await win.happyDOM.abort();
    win.close();
  };
  return { win, doc: win.document, calls, posts, rejections, done };
}

function rsvpTrip() {
  const cfg = clone(FIXTURE);
  cfg.phases[0].rsvp_activities = [ACTIVITY];
  return cfg;
}

describe('RSVP on a stop built from config', () => {
  test('the card renders inside the stop\'s RSVP container', async () => {
    const t = await boot(rsvpTrip());
    try {
      const container = t.doc.getElementById(`rsvp-${FIXTURE.phases[0].id}`);
      assert.ok(container, 'buildPhaseNav() created the stop\'s RSVP container');
      await until(() => container.querySelector('.rsvp-card'), 'the RSVP card');
      const card = container.querySelector('.rsvp-card');
      assert.equal(card.id, `rsvp-card-${ACT_ID}`);
      assert.match(card.querySelector('.rsvp-title').textContent, /שייט בנהר|River boat/);
      assert.equal(card.querySelectorAll('button[data-act="rsvp"]').length, 3, 'yes / no / maybe for a signed-in member');
      assert.ok(t.calls.includes(`GET /api/rsvps/${encodeURIComponent(ACT_ID)}`), t.calls.join('\n'));
      assert.deepEqual(t.rejections, []);
    } finally { await t.done(); }
  });

  test('a click records the status (id URL-encoded) and the card re-renders with it and the count', async () => {
    const t = await boot(rsvpTrip());
    try {
      const container = t.doc.getElementById(`rsvp-${FIXTURE.phases[0].id}`);
      await until(() => container?.querySelector('.rsvp-card'), 'the RSVP card');
      assert.equal(container.querySelectorAll('.rsvp-chip').length, 0, 'nobody has answered yet');

      container.querySelector('button[data-arg2="yes"]').click();
      await until(() => container.querySelector('.rsvp-btn.active-yes'), 'the card to show "yes" as chosen');
      assert.deepEqual(t.posts, [{ path: `/api/rsvps/${encodeURIComponent(ACT_ID)}`, status: 'yes' }]);
      assert.equal(container.querySelectorAll('.rsvp-card').length, 1, 'the card was replaced, not duplicated');
      assert.equal(container.querySelectorAll('.rsvp-chip').length, 1, 'one response shown');
      assert.match(container.querySelector('.rsvp-chip').textContent, /✅/);

      // Changing the answer replaces it: still one response, now "no".
      container.querySelector('button[data-arg2="no"]').click();
      await until(() => container.querySelector('.rsvp-btn.active-no'), 'the card to show "no" as chosen');
      assert.equal(container.querySelector('.rsvp-btn.active-yes'), null);
      assert.equal(container.querySelectorAll('.rsvp-chip').length, 1);
      assert.match(container.querySelector('.rsvp-chip').textContent, /❌/);
      assert.equal(t.posts.length, 2);
      assert.deepEqual(t.rejections, []);
    } finally { await t.done(); }
  });

  test('a numeric activity id still refreshes its card (data-arg is a string)', async () => {
    const cfg = clone(FIXTURE);
    cfg.phases[0].rsvp_activities = [{ ...ACTIVITY, id: 7 }];
    const t = await boot(cfg);
    try {
      const container = t.doc.getElementById(`rsvp-${FIXTURE.phases[0].id}`);
      await until(() => container?.querySelector('.rsvp-card'), 'the RSVP card');
      container.querySelector('button[data-arg2="maybe"]').click();
      await until(() => container.querySelector('.rsvp-btn.active-maybe'), 'the card to show "maybe" as chosen');
      assert.deepEqual(t.posts, [{ path: '/api/rsvps/7', status: 'maybe' }]);
    } finally { await t.done(); }
  });
});

describe('ratings on a stop with no venues', () => {
  test('a legacy-named stop without venues does not stop later stops\' ratings from rendering', async () => {
    // The fixture's `colorado` stop has no venues; `lyon` comes after it.
    const cfg = clone(FIXTURE);
    assert.equal((cfg.phases.find(p => p.id === 'colorado').venues || []).length, 0, 'fixture precondition');
    cfg.phases.push({ ...clone(cfg.phases[1]), id: 'lyon', short_id: undefined, tabLabel: 'LYON',
      title: { he: 'ליון', en: 'Lyon' }, venues: [{ id: 'lyon-museum', name: { he: 'מוזיאון', en: 'Museum' } }] });
    const t = await boot(cfg);
    try {
      assert.deepEqual(t.rejections, [], 'loadRatings threw during boot');
      assert.ok(t.doc.querySelector('#ratings-lyon #rc-lyon-museum'), 'the stop after `colorado` got its rating card');
      assert.ok(t.doc.querySelector('#ratings-ny .rating-card'), 'the stop with venues still renders');
      assert.equal(t.doc.getElementById('ratings-colorado').children.length, 0, 'no venues, no cards');
    } finally { await t.done(); }
  });

  test('renderRatings tolerates a missing venues list and a hole in one', async () => {
    const t = await boot(clone(FIXTURE));
    try {
      const host = t.doc.createElement('div');
      host.id = 'ratings-dallas';                 // a legacy fixed-name element, no VENUES entry
      t.doc.body.appendChild(host);
      assert.doesNotThrow(() => t.win.renderRatings('ratings-dallas', undefined));
      assert.doesNotThrow(() => t.win.renderRatings('ratings-dallas', null));
      assert.equal(host.children.length, 0);
      assert.doesNotThrow(() => t.win.renderRatings('ratings-dallas', [null, { id: 'v1', name: 'Alpha' }, 'junk']));
      assert.equal(host.querySelectorAll('.rating-card').length, 1);
      assert.ok(host.querySelector('#rc-v1'));
      assert.doesNotThrow(() => t.win.loadRatings());
      await settle(50);
      assert.deepEqual(t.rejections, []);
    } finally { await t.done(); }
  });
});
