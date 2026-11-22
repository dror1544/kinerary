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
  delete ctx.realUi;
  if (overrides.realUi) delete ctx._updateGoogleConnectUI;
  vm.runInContext(TRANSLATIONS.replace(/^const T\b/m, 'var T'), ctx);
  vm.runInContext(`${extract('_applySignInManagedUI')}\n${extract('disconnectGoogle', true)}`, ctx);
  if (overrides.realUi) {
    // The real Google wiring: what initGoogleAuth does once at load, and what refreshes the block afterwards.
    vm.runInContext(`${extract('_updateGoogleConnectUI')}\n${extract('initGoogleAuth', true)}\nfunction handleGoogleCredential() {}`, ctx);
  }
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

test('a secondary organizer (organizer flags plus sign_in_managed) gets the same hiding and the same line, in either language', () => {
  for (const [lang, line] of [['en', 'You sign in with your Kinerary account.'], ['he', 'הכניסה שלך היא עם חשבון Kinerary.']]) {
    const s = screen({ currentLang: lang });
    Object.assign(s.ctx.currentUser, { is_organizer: true, is_secondary_organizer: true, sign_in_managed: true });
    vm.runInContext('_applySignInManagedUI()', s.ctx);
    assert.equal(s.$('avatar-lb-pw-toggle').style.display, 'none', lang);
    assert.equal(s.$('avatar-lb-sign-in-managed').textContent, line, lang);
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

test('the avatar screen applies it every time it opens', () => {
  assert.match(extract('openAvatarLightbox', true), /_applySignInManagedUI\(\)/);
});

test('the real listener registration: clicking Disconnect Google attempts the DELETE, and a refusal shows the error and keeps the link', async () => {
  for (const [accepted, expectedEmail] of [[false, 'eve@example.test'], [true, null]]) {
    const sent = [];
    const s = screen({ realUi: true, fetch: async (path, init) => { sent.push([path, init.method]); return { ok: accepted, status: accepted ? 200 : 403 }; },
      lbClose() {}, lbGoTo() {} });
    // initAvatarLightbox is what registers every avatar-screen listener, the disconnect one among them
    vm.runInContext(extract('initAvatarLightbox'), s.ctx);
    vm.runInContext('initAvatarLightbox()', s.ctx);
    s.$('avatar-lb-google-disconnect').dispatchEvent(new s.win.Event('click'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(sent, [['/api/auth/google-link', 'DELETE']], 'the click reached the handler and the DELETE was attempted');
    assert.equal(s.ctx.currentUser.google_email, expectedEmail);
    if (!accepted) assert.ok(s.$('avatar-lb-google-status').textContent.length > 0, 'the refusal is shown');
  }
});

// ── one page, several sessions (logout, then another person from the login picker, no reload) ─────────────────────────

async function pageWith({ googleConfigured }) {
  const s = screen({
    realUi: true,
    google: googleConfigured ? { accounts: { id: { initialize() {}, renderButton() {} } } } : undefined,
    fetch: async () => ({ json: async () => ({ googleClientId: googleConfigured ? 'client-id' : null }) }),
  });
  await vm.runInContext('initGoogleAuth()', s.ctx); // once, at page load, exactly as the page does
  const as = (user) => { s.ctx.currentUser = user; vm.runInContext('_applySignInManagedUI(); _updateGoogleConnectUI();', s.ctx); };
  const state = () => ({
    pwButton: s.$('avatar-lb-pw-toggle').style.display !== 'none',
    googleBlock: s.$('avatar-lb-google-wrap').style.display === 'flex',
    disconnect: s.$('avatar-lb-google-disconnect').style.display !== 'none',
    status: s.$('avatar-lb-google-status').textContent,
    line: Boolean(s.$('avatar-lb-sign-in-managed')),
  });
  return { s, as, state };
}
const EVE = { username: 'eve', google_email: 'eve@example.test' };
const FRESH_EVE = { pwButton: true, googleBlock: true, disconnect: true, status: '✓ Connected as eve@example.test', line: false };

test('managed, then a plain user on the SAME page: the Google block comes back exactly as on a fresh page (Google configured)', async () => {
  const fresh = await pageWith({ googleConfigured: true });
  fresh.as(EVE);
  assert.deepEqual(fresh.state(), FRESH_EVE, 'what a fresh page shows the plain user');
  const p = await pageWith({ googleConfigured: true });
  p.as({ username: 'eve', sign_in_managed: true });
  assert.equal(p.state().pwButton, false);
  assert.equal(p.state().googleBlock, false);
  assert.equal(p.state().line, true);
  p.as(EVE);
  assert.deepEqual(p.state(), FRESH_EVE);
  // and an unlinked plain user gets the connect button, not the disconnect one
  p.as({ username: 'eve' });
  assert.deepEqual(p.state(), { pwButton: true, googleBlock: true, disconnect: false, status: '', line: false });
});

test('managed, then plain, on a trip with NO Google client: the Google block stays hidden throughout', async () => {
  const p = await pageWith({ googleConfigured: false });
  p.as(EVE);
  assert.equal(p.state().googleBlock, false, 'not offered on a fresh page');
  p.as({ username: 'eve', sign_in_managed: true });
  assert.equal(p.state().googleBlock, false);
  p.as(EVE);
  assert.equal(p.state().googleBlock, false, 'not offered after the managed session either');
  assert.equal(p.state().pwButton, true);
  assert.equal(p.state().line, false);
  assert.equal(p.s.$('avatar-lb-google-wrap').style.display, 'none', 'still the hidden block the markup ships');
});

test('plain, managed, plain on one page: every switch lands on what a fresh page shows for that session', async () => {
  const p = await pageWith({ googleConfigured: true });
  p.as(EVE);
  assert.deepEqual(p.state(), FRESH_EVE);
  p.as({ username: 'bob', sign_in_managed: true });
  assert.equal(p.state().googleBlock, false);
  assert.equal(p.state().pwButton, false);
  p.as(EVE);
  assert.deepEqual(p.state(), FRESH_EVE);
  p.as({ username: 'bob', sign_in_managed: true });
  p.as(EVE);
  assert.deepEqual(p.state(), FRESH_EVE);
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
