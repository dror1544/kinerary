import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../site/runtime-base.js', import.meta.url), 'utf8');
function fixture({ path = '/t/trip_fixture01/classic.html', status = 200, framed = false } = {}) {
  const calls = [], removed = [], navigations = [], messages = [];
  const window = {
    fetch: async (...args) => { calls.push(args); return { ok: status === 200, json: async () => ({ portalUrl: 'https://portal.example' }) }; },
    EventSource: function () {},
  };
  window.parent = framed ? { postMessage: (...args) => messages.push(args) } : window;
  const context = {
    window, location: { pathname: path, origin: 'https://runtime.example', assign: url => navigations.push(url), replace: url => navigations.push(url) },
    localStorage: { setItem() {}, removeItem: key => removed.push(key) },
    XMLHttpRequest: function () {}, MutationObserver: class { observe() {} },
    document: { documentElement: {}, querySelectorAll: () => [] }, URL,
  };
  context.XMLHttpRequest.prototype.open = () => {};
  vm.runInNewContext(script, context);
  return { window, calls, removed, navigations, messages };
}

test('Classic and Modern share gateway logout, clearing storage only after cookie expiration succeeds', async () => {
  const f = fixture(); await f.window.runtimeLogout();
  assert.equal(f.calls[0][0], '/t/trip_fixture01/__logout');
  assert.equal(f.calls[0][1].method, 'POST');
  assert.equal(f.calls[0][1].headers['X-Kinerary-Logout'], '1');
  assert.deepEqual(f.removed.sort(), ['token', 'trip-token', 'trip-user', 'tripToken'].sort());
  assert.deepEqual(f.navigations, ['https://portal.example']);
  const failed = fixture({ status: 503 });
  await assert.rejects(failed.window.runtimeLogout(), /Sign out failed/);
  assert.deepEqual(failed.removed, []); assert.deepEqual(failed.navigations, []);
});

test('a framed trip returns control to its portal instead of nesting the portal inside itself', async () => {
  const f = fixture({ framed: true }); await f.window.runtimeLogout();
  assert.equal(f.messages[0][0].type, 'kinerary:runtime-logout');
  assert.equal(f.messages[0][1], 'https://portal.example');
  assert.deepEqual(f.navigations, ['/t/trip_fixture01/__signed_out']);
});

test('direct Classic and Modern logins do not acquire a gateway logout handler', () => {
  assert.equal(fixture({ path: '/classic.html' }).window.runtimeLogout, undefined);
  assert.equal(fixture({ path: '/modern/' }).window.runtimeLogout, undefined);
});

// The runtime origin is shared by every trip, so one localStorage serves them all.
function storageFixture(path, data = new Map()) {
  class Storage {
    getItem(key) { return data.has(key) ? data.get(key) : null; }
    setItem(key, value) { data.set(key, String(value)); }
    removeItem(key) { data.delete(key); }
  }
  const localStorage = new Storage();
  const window = { fetch: async () => ({ ok: true, json: async () => ({ portalUrl: 'https://portal.example' }) }), EventSource: function () {}, localStorage };
  window.parent = window;
  const context = {
    window, Storage, localStorage, location: { pathname: path, origin: 'https://runtime.example', assign() {}, replace() {} },
    XMLHttpRequest: function () {}, MutationObserver: class { observe() {} }, document: { documentElement: {}, querySelectorAll: () => [] }, URL,
  };
  context.XMLHttpRequest.prototype.open = () => {};
  vm.runInNewContext(script, context);
  return { localStorage, data };
}

test('session keys are scoped to the trip, so trips sharing the runtime origin never read each other\'s', () => {
  const shared = new Map(); // one origin, one localStorage
  const a = storageFixture('/t/trip_aaaaaaaa/classic.html', shared);
  assert.equal(a.localStorage.getItem('trip-token'), 'runtime-gateway-session');
  assert.ok(shared.has('/t/trip_aaaaaaaa:trip-token'), [...shared.keys()].join());
  assert.ok(!shared.has('trip-token'));
  a.localStorage.setItem('trip-user', '{"username":"alice"}');
  assert.ok(shared.has('/t/trip_aaaaaaaa:trip-user'));
  assert.equal(a.localStorage.getItem('trip-user'), '{"username":"alice"}');
  // Another trip's page on the same origin cannot see it: its keys carry its own base.
  const b = storageFixture('/t/trip_bbbbbbbb/classic.html', shared);
  assert.equal(b.localStorage.getItem('trip-user'), null);
  // Unrelated keys (language, caches) are not renamed.
  a.localStorage.setItem('tripLang', 'he');
  assert.ok(shared.has('tripLang'));
  a.localStorage.removeItem('trip-user');
  assert.equal(a.localStorage.getItem('trip-user'), null);
});

test('direct Classic and Modern logins keep their plain keys', () => {
  const direct = storageFixture('/classic.html');
  direct.localStorage.setItem('trip-token', 'jwt');
  assert.ok(direct.data.has('trip-token'));
});
