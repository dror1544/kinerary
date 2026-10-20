/**
 * classic-dashboard-link.test.js — Classic's side menu shows an "Organizer
 * dashboard" entry only when /api/auth/me handed the session a dashboard_url,
 * and never turns a hostile value into a clickable href.
 *
 * The real applyDashboardLink() from site/app.js, extracted by name, against the
 * real side-menu markup from site/classic.html — never reimplemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { Window } from 'happy-dom';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, '..', 'site', 'app.js'), 'utf8');
const HTML = readFileSync(join(HERE, '..', 'site', 'classic.html'), 'utf8');
const TRANSLATIONS = readFileSync(join(HERE, '..', 'site', 'translations.js'), 'utf8');

function extract(name) {
  const start = APP.search(new RegExp(`function ${name}\\(`));
  assert.notEqual(start, -1, `${name}() not found in app.js`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 3);
}

function menu(currentUser) {
  const win = new Window({ url: 'http://localhost/' });
  // The side menu exactly as shipped.
  const from = HTML.indexOf('<aside class="side-menu"');
  win.document.body.innerHTML = HTML.slice(from, HTML.indexOf('</aside>', from) + 8);
  const ctx = vm.createContext({ window: win, document: win.document, currentUser, URL });
  vm.runInContext(`${extract('safeUrl')}\n${extract('applyDashboardLink')}\napplyDashboardLink();`, ctx);
  const section = win.document.getElementById('sm-dashboard-section');
  const link = win.document.getElementById('sm-dashboard-link');
  return { visible: section.style.display !== 'none', href: link.getAttribute('href') };
}

test('the entry shows, with the URL as its href, when the session carries dashboard_url', () => {
  const url = 'https://portal.example.test/trips/trip_abcdefgh/setup';
  assert.deepEqual(menu({ username: 'alice', is_organizer: true, dashboard_url: url }), { visible: true, href: url });
});

test('the entry is hidden for a member, a direct login and a signed-out menu', () => {
  for (const user of [{ username: 'bob' }, { username: 'alice', is_organizer: true }, null]) {
    assert.deepEqual(menu(user), { visible: false, href: null });
  }
});

test('javascript:, data:, relative, credentialed and unparsable values never become an href', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x', '/trips/x/setup', 'https://u:p@portal.example.test/', 'https://', `https://portal.example.test/${'a'.repeat(2100)}`, 42, {}]) {
    assert.deepEqual(menu({ username: 'alice', is_organizer: true, dashboard_url: bad }), { visible: false, href: null }, String(bad).slice(0, 40));
  }
});

test('the link never reaches localStorage (trip-user is shared across trips on the runtime origin)', () => {
  const stored = {};
  const win = new Window({ url: 'http://localhost/' });
  const ctx = vm.createContext({ localStorage: { setItem: (k, v) => { stored[k] = v; } } });
  vm.runInContext(extract('saveTripUser'), ctx);
  ctx.saveTripUser({ username: 'alice', is_organizer: true, dashboard_url: 'https://portal.example.test/trips/trip_abcdefgh/setup' });
  assert.deepEqual(JSON.parse(stored['trip-user']), { username: 'alice', is_organizer: true });
  assert.ok(!/trip-user'?\s*,\s*JSON\.stringify\(currentUser\)/.test(APP), 'every write of currentUser goes through saveTripUser');
  void win;
});

test('both languages carry the label', () => {
  assert.equal((TRANSLATIONS.match(/sm_dashboard:/g) || []).length, 2);
  assert.match(TRANSLATIONS, /sm_dashboard:\s+'🧭 לוח המארגן'/);
  assert.match(TRANSLATIONS, /sm_dashboard:\s+'🧭 Organizer dashboard'/);
});
