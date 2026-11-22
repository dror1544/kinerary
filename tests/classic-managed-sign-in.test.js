/**
 * classic-managed-sign-in.test.js — the classic page and S2c (x-member-sign-in).
 *
 *  1. A session whose /api/auth/me says `sign_in_managed` (a group claim or a personal invite) is refused by the site on the
 *     password and Google-link routes, so the classic avatar screen must not offer them, and says where sign-in lives.
 *  2. The Google "disconnect" button used to clear the link locally and say "disconnected" whatever the server answered. It now
 *     checks the response: a refusal (any session, not only managed ones) leaves the link in place and shows the error string.
 *
 * The real functions from site/app.js, extracted by name (the classic page has no build step and no browser harness: this is the
 * same happy-dom + vm pattern as classic-dashboard-link.test.js), against the real avatar-screen markup from site/classic.html.
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

function extract(name, async = false) {
  const start = APP.search(new RegExp(`${async ? 'async ' : ''}function ${name}\\(`));
  assert.notEqual(start, -1, `${name}() not found in app.js`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 3);
}

function screen(overrides = {}) {
  const win = new Window({ url: 'http://localhost/' });
  const from = HTML.indexOf('<div class="avatar-lightbox" id="avatar-lightbox">');
  win.document.body.innerHTML = HTML.slice(from, HTML.indexOf('<script src="translations.js', from));
  const calls = { save: 0, updateUi: 0, showLoggedIn: 0 };
  const ctx = vm.createContext({
    window: win, document: win.document, URL, currentLang: 'en',
    currentUser: { username: 'eve', google_email: 'eve@example.test', google_picture: 'p' },
    lbState: { username: 'eve' },
    localStorage: { getItem: () => 'tok' },
    saveTripUser: () => { calls.save++; },
    _updateGoogleConnectUI: () => { calls.updateUi++; },
    showLoggedIn: () => { calls.showLoggedIn++; },
    ...overrides,
  });
  vm.runInContext(TRANSLATIONS.replace(/^const T\b/m, 'var T'), ctx);
  vm.runInContext(`${extract('_applySignInManagedUI')}\n${extract('disconnectGoogle', true)}`, ctx);
  return { win, ctx, calls, $: id => win.document.getElementById(id) };
}

test('a managed session: no password button, no Google block, one line saying where sign-in lives (English and Hebrew)', () => {
  for (const [lang, line] of [['en', 'You sign in with your Kinerary account.'], ['he', 'הכניסה שלך היא עם חשבון Kinerary.']]) {
    const s = screen({ currentLang: lang });
    s.ctx.currentUser.sign_in_managed = true;
    s.$('avatar-lb-google-wrap').style.display = 'flex'; // initGoogleAuth turned it on
    vm.runInContext('_applySignInManagedUI()', s.ctx);
    assert.equal(s.$('avatar-lb-pw-toggle').style.display, 'none', lang);
    assert.equal(s.$('avatar-lb-google-wrap').style.display, 'none', lang);
    assert.equal(s.$('avatar-lb-sign-in-managed').textContent, line, lang);
    vm.runInContext('_applySignInManagedUI()', s.ctx); // opening the screen twice draws the line once
    assert.equal(s.win.document.querySelectorAll('#avatar-lb-sign-in-managed').length, 1);
  }
});

test('every other session: the password button and the Google block are left exactly as they were, and no line appears', () => {
  const s = screen();
  s.$('avatar-lb-google-wrap').style.display = 'flex';
  vm.runInContext('_applySignInManagedUI()', s.ctx);
  assert.notEqual(s.$('avatar-lb-pw-toggle').style.display, 'none');
  assert.equal(s.$('avatar-lb-google-wrap').style.display, 'flex');
  assert.equal(s.$('avatar-lb-sign-in-managed'), null);
});

test('the avatar screen applies it every time it opens, and the disconnect button runs the checked handler', () => {
  assert.match(extract('openAvatarLightbox', true), /_applySignInManagedUI\(\)/);
  assert.match(APP, /getElementById\('avatar-lb-google-disconnect'\)\?\.addEventListener\('click', disconnectGoogle\)/);
});

test('Google disconnect: a refusal leaves the link in place and shows the error string; only a success clears it', async () => {
  // the server refused (a managed session, an expired token...): nothing is cleared, nothing says "disconnected"
  let s = screen({ fetch: async () => ({ ok: false, status: 403 }) });
  await vm.runInContext('disconnectGoogle()', s.ctx);
  assert.equal(s.ctx.currentUser.google_email, 'eve@example.test');
  assert.equal(s.ctx.currentUser.google_picture, 'p');
  assert.deepEqual(s.calls, { save: 0, updateUi: 0, showLoggedIn: 0 });
  assert.equal(s.$('avatar-lb-google-status').textContent, vm.runInContext("T.en.avatar_google_error", s.ctx));
  assert.ok(s.$('avatar-lb-google-status').textContent.length > 0);
  // the network failed: the same
  s = screen({ fetch: async () => { throw new Error('offline'); } });
  await vm.runInContext('disconnectGoogle()', s.ctx);
  assert.equal(s.ctx.currentUser.google_email, 'eve@example.test');
  assert.ok(s.$('avatar-lb-google-status').textContent.length > 0);
  // the server accepted: the link is cleared locally, as before
  const sent = [];
  s = screen({ fetch: async (path, init) => { sent.push([path, init.method, init.headers.Authorization]); return { ok: true, status: 200 }; } });
  await vm.runInContext('disconnectGoogle()', s.ctx);
  assert.deepEqual(sent, [['/api/auth/google-link', 'DELETE', 'Bearer tok']]);
  assert.equal(s.ctx.currentUser.google_email, null);
  assert.equal(s.ctx.currentUser.google_picture, null);
  assert.deepEqual(s.calls, { save: 1, updateUi: 1, showLoggedIn: 1 });
});
