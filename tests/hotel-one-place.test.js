/**
 * hotel-one-place.test.js — a hotel is ONE place, wherever the site shows it.
 *
 * Live finding (2026-10-15, a star trip): the companion added "Hotel Vignoble
 * Dore" as a booking (type hotel, location_url null), the organizer linked it
 * to the Colmar stop (so the stop's accommodation is {type: hotel, name} and
 * the override carries booking_id), and the plan got a check-in and a check-out
 * item with location_url null. The site then showed it differently on every
 * screen: a Google Maps link on one, none on the next, a search for the
 * check-in's own wording ("Check-in — Hotel…") on Today, no Waze anywhere.
 *
 * server/hotel-place.js is the one resolver. These tests drive the real server
 * through that exact shape and read the hotel back from EVERY route a screen
 * reads it from — config (map tab, hotel card), bookings, the active itinerary
 * (Journey items, "Tonight"), Today, and Classic's plan — and assert that they
 * agree on the name, the Google Maps link and the Waze link.
 *
 * What it does NOT do: invent coordinates. With nothing but a name, the link
 * is a search for name + the stop's city; coordinates appear only when a link
 * the organizer or the booking supplied carries them.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PORTS } from './helpers/ports.js';
import { createRenderContext } from './helpers/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const require = createRequire(import.meta.url);
const AGENT_KEY = 'test-hermes-key';
const Database = require('../server/node_modules/better-sqlite3');
const { resolveHotelPlace } = require('../server/hotel-place.js');

const HOTEL = 'Hotel Vignoble Dore';
// Far in the future so GET /api/today's "next" is always the check-in.
const IN = '2090-03-10';
const OUT = '2090-03-14';

function colmarConfig() {
  return {
    meta: { title: 'Alsace 2090', brand: 'ALSACE', departure: `${IN}T00:00:00+00:00`, returnDate: OUT, totalDays: 5, deploymentNonce: 'hotel-one-place', defaultLang: 'he' },
    participants: [
      { username: 'alice', name: 'אליס', name_en: 'Alice', family: 'a', color: '#3B82F6' },
      { username: 'bob', name: 'בוב', name_en: 'Bob', family: 'a', color: '#10B981' },
    ],
    phases: [
      // Dateless, hotelless, with a map pin for the town — the F3 shape.
      { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', mapStop: { lat: 48.0794, lng: 7.3585, name: { he: 'קולמר', en: 'Colmar' } } },
      { id: 'basel', title: { he: 'באזל', en: 'Basel' }, tabLabel: 'BASEL' },
    ],
    agent: { name: 'עוזר', name_en: 'Helper', organizer: 'alice' },
  };
}

async function boot(config, port) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hotel-one-place-'));
  const tripDir = join(dataDir, 'trip');
  mkdirSync(tripDir, { recursive: true });
  writeFileSync(join(tripDir, 'trip.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(tripDir, 'bookings.json'), '[]');
  mkdirSync(join(dataDir, 'site'), { recursive: true });
  const proc = spawn('node', [join(REPO, 'server', 'server.js')], {
    cwd: join(REPO, 'server'),
    env: { ...process.env, PORT: String(port), TRIP_DIR: tripDir, DATA_DIR: dataDir,
      SITE_DIR: join(dataDir, 'site'), AVATARS_DIR: join(dataDir, 'avatars'),
      JWT_SECRET: 'test-secret-000', IMMICH_URL: '', IMMICH_API_KEY: '', HERMES_URL: '',
      HERMES_API_KEY: AGENT_KEY, SEED_PASSWORD: '1234' },
  });
  let log = '';
  proc.stdout.on('data', c => { log += c; });
  proc.stderr.on('data', c => { log += c; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (log.includes('Trip server running on')) { clearInterval(t); resolve(); } }, 20);
    proc.on('exit', code => { clearInterval(t); reject(new Error(`server exited ${code}: ${log.slice(-600)}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error(`boot timeout: ${log.slice(-600)}`)); }, 10_000);
  });
  const base = `http://localhost:${port}`;
  const server = {
    dataDir,
    async call(path, { method = 'GET', token, apiKey, body } = {}) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (apiKey) headers['X-API-Key'] = apiKey;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, text, body: json };
    },
    async login(username) {
      for (let i = 0; i < 40; i++) {
        const r = await server.call('/api/auth/login', { method: 'POST', body: { username, password: '1234' } });
        if (r.status === 200) return r.body.token;
        await new Promise(res => setTimeout(res, 100));
      }
      throw new Error(`login ${username} failed`);
    },
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise(res => proc.once('exit', res));
        proc.kill('SIGTERM');
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return server;
}

// What every screen reads, as { view: { name, maps, waze } }. A view that does
// not carry the hotel at all is a failure of its own, so each read asserts.
async function readEveryView(server, member) {
  const get = async (path) => {
    const r = await server.call(path, { token: member });
    assert.equal(r.status, 200, `${path}: ${r.text}`);
    return r.body;
  };
  const views = {};

  // Modern map tab + Classic hotel card: GET /api/config.
  const colmar = (await get('/api/config')).phases.find(p => p.id === 'colmar');
  const acc = colmar.accommodation;
  assert.ok(acc, 'config: colmar carries its accommodation');
  views['config accommodation'] = { name: acc.name, maps: acc.location_url, waze: acc.waze };

  // Bookings tab (both sites).
  const booking = (await get('/api/bookings')).find(b => b.type === 'hotel');
  assert.ok(booking, 'bookings: the hotel booking');
  views['bookings'] = { name: booking.name, maps: booking.place?.maps_url, waze: booking.place?.waze_url };

  // Journey: the check-in and check-out items, and the "Tonight" line.
  const active = await get('/api/itinerary/active');
  const nameOf = (item) => item.text_en.replace(/^Check-(in|out) — /, '');
  for (const kind of ['checkin', 'checkout']) {
    const item = active.items.find(i => i.item_uid.endsWith(`_${kind}`));
    assert.ok(item, `itinerary: the ${kind} item`);
    views[`journey ${kind}`] = { name: nameOf(item), maps: item.location_url, waze: item.waze_url };
    views[`journey ${kind} booking card`] = { name: item.booking?.name, maps: item.booking?.place?.maps_url, waze: item.booking?.place?.waze_url };
  }
  const night = active.days.find(d => d.phase_id === 'colmar' && d.date === '2090-03-11');
  assert.ok(night?.lodging_context, 'itinerary: a day row with tonight\'s lodging');
  views['journey tonight'] = { name: night.lodging_context.name, maps: night.lodging_context.location_url, waze: night.lodging_context.waze_url };

  // Today: the next activity (the check-in).
  const today = await get('/api/today');
  assert.ok(today.next?.item_uid?.endsWith('_checkin'), `today: next is the check-in (got ${today.next?.item_uid})`);
  views['today next'] = { name: nameOf(today.next), maps: today.next.location_url, waze: today.next.waze_url };

  // Classic's plan route.
  const plan = await get('/api/phases/colmar/plan');
  for (const kind of ['checkin', 'checkout']) {
    const item = plan.find(i => i.itinerary_item_uid?.endsWith?.(`_${kind}`) || (i.text_en || '').startsWith(kind === 'checkin' ? 'Check-in' : 'Check-out'));
    assert.ok(item, `classic plan: the ${kind} item`);
    views[`classic plan ${kind}`] = { name: nameOf(item), maps: item.location_url, waze: item.waze_url };
    views[`classic plan ${kind} booking card`] = { name: item.booking?.name, maps: item.booking?.place?.maps_url, waze: item.booking?.place?.waze_url };
  }
  return views;
}

// A day of the stay with something planned, so the itinerary has a row whose
// "Tonight" line can be read (check-in and check-out are the only other rows).
async function dayInTheMiddle(server, token) {
  const r = await server.call('/api/phases/colmar/plan', { method: 'POST', token, body: { date: '2090-03-11', time: '10:00', text_he: 'סיור', text_en: 'Walking tour' } });
  assert.equal(r.status, 201, r.text);
}

function assertAllAgree(views, { maps, waze }) {
  for (const [view, v] of Object.entries(views)) {
    assert.equal(v.name, HOTEL, `${view}: name`);
    assert.equal(v.maps, maps, `${view}: Google Maps link`);
    assert.equal(v.waze, waze, `${view}: Waze link`);
  }
}

describe('a companion-added hotel (booking with no location_url) is one place in every view', () => {
  let server, alice, bob, bookingId;
  before(async () => {
    server = await boot(colmarConfig(), PORTS.hotelOnePlace);
    alice = await server.login('alice');
    bob = await server.login('bob');
    // Exactly the live shape: a hotel booking with no location, filed under the
    // stop, then linked to it.
    const created = await server.call('/api/bookings', { method: 'POST', token: alice, body: {
      phase: 'colmar', type: 'hotel', name: HOTEL, date_from: IN, date_to: OUT, confirmation: 'VD-1',
    } });
    assert.equal(created.status, 200, created.text);
    bookingId = created.body.id;
    const linked = await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: bookingId } });
    assert.equal(linked.status, 200, linked.text);
    await dayInTheMiddle(server, alice);
  });
  after(async () => { await server?.stop(); });

  test('precondition: the stored rows are the live shape (no link anywhere)', async () => {
    const raw = (await server.call('/api/bookings', { token: alice })).body.find(b => b.id === bookingId);
    assert.equal(raw.location_url, null, 'the booking has no location_url');
    const stop = (await server.call('/api/stops', { token: alice })).body.stops.find(s => s.id === 'colmar');
    assert.equal(stop.override.booking_id, bookingId);
    assert.deepEqual(stop.stop.accommodation, { type: 'hotel', name: HOTEL, confirmation: 'VD-1' }, 'the stop editor reads the stored hotel — no derived link written back');
  });

  test('every view gives the same name, the same Google Maps link and the same Waze link', async () => {
    const views = await readEveryView(server, bob);
    const query = encodeURIComponent(`${HOTEL}, Colmar`);
    assertAllAgree(views, {
      maps: `https://www.google.com/maps/search/?api=1&query=${query}`,
      waze: `https://waze.com/ul?q=${query}&navigate=yes`,
    });
  });

  test('the derived link is a search, never coordinates (none were supplied)', async () => {
    const views = await readEveryView(server, bob);
    for (const [view, v] of Object.entries(views)) {
      assert.ok(!/@-?\d|[?&]ll=|[?&]query=-?\d/.test(`${v.maps} ${v.waze}`), `${view}: no invented coordinates`);
    }
  });

  test('items served with a derived link say so, so an editor does not save it back', async () => {
    const active = (await server.call('/api/itinerary/active', { token: bob })).body;
    const checkin = active.items.find(i => i.item_uid.endsWith('_checkin'));
    assert.equal(checkin.location_derived, true);
    const db = new Database(join(server.dataDir, 'trip.db'), { readonly: true });
    const stored = db.prepare("SELECT location_url, waze_url FROM itinerary_plan_items WHERE item_uid LIKE '%\\_checkin' ESCAPE '\\'").all();
    db.close();
    assert.ok(stored.length > 0);
    assert.ok(stored.every(r => r.location_url == null && r.waze_url == null), 'the stored rows stay empty — the link is resolved at serve time');
  });

  test('a link on an item the organizer wrote is left alone, and only hotel bookings are filled', async () => {
    const own = 'https://maps.example/reception';
    const added = await server.call('/api/phases/colmar/plan', { method: 'POST', token: alice, body: {
      date: '2090-03-12', time: '10:00', text_he: 'דלפק', text_en: 'Front desk', location_url: own, booking_id: bookingId,
    } });
    assert.equal(added.status, 201, added.text);
    const active = (await server.call('/api/itinerary/active', { token: bob })).body;
    const item = active.items.find(i => i.text_en === 'Front desk');
    assert.equal(item.location_url, own);
    assert.ok(!item.location_derived);
    const flight = await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'attraction', name: 'Unterlinden Museum', date_from: '2090-03-12', date_to: '2090-03-12' } });
    const museum = await server.call('/api/phases/colmar/plan', { method: 'POST', token: alice, body: {
      date: '2090-03-12', time: '14:00', text_he: 'מוזיאון', text_en: 'Museum', booking_id: flight.body.id,
    } });
    assert.equal(museum.status, 201, museum.text);
    const after = (await server.call('/api/itinerary/active', { token: bob })).body.items.find(i => i.text_en === 'Museum');
    assert.equal(after.location_url ?? null, null, 'a non-hotel booking gets no invented link');
    const listed = (await server.call('/api/bookings', { token: bob })).body.find(b => b.id === flight.body.id);
    assert.equal(listed.place, undefined, 'only hotel bookings carry a place');
  });

  test('the organizer\'s map link on the stop wins, in every view, including the items that stored nothing', async () => {
    const link = 'https://www.google.com/maps/place/Hotel+Vignoble+Dore/@48.0911,7.3590,17z';
    const patched = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { accommodation: { type: 'hotel', name: HOTEL, confirmation: 'VD-1', location_url: link } } });
    assert.equal(patched.status, 200, patched.text);
    const views = await readEveryView(server, bob);
    // The coordinates come from THEIR link; Waze is pointed at them.
    assertAllAgree(views, { maps: link, waze: 'https://waze.com/ul?ll=48.0911%2C7.3590&navigate=yes' });
  });
});

describe('a hotel booking that carries its own link: that link, everywhere', () => {
  let server, alice, bob;
  const link = 'https://www.google.com/maps/place/Hotel+Vignoble+Dore/@48.0802,7.3601,17z';
  before(async () => {
    server = await boot(colmarConfig(), PORTS.hotelOnePlace);
    alice = await server.login('alice');
    bob = await server.login('bob');
    const created = await server.call('/api/bookings', { method: 'POST', token: alice, body: {
      phase: 'colmar', type: 'hotel', name: HOTEL, date_from: IN, date_to: OUT, location_url: link,
    } });
    assert.equal(created.status, 200, created.text);
    const linked = await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: created.body.id } });
    assert.equal(linked.status, 200, linked.text);
    await dayInTheMiddle(server, alice);
  });
  after(async () => { await server?.stop(); });

  test('same name, same link, and Waze pointed at the link\'s coordinates', async () => {
    const views = await readEveryView(server, bob);
    assertAllAgree(views, { maps: link, waze: 'https://waze.com/ul?ll=48.0802%2C7.3601&navigate=yes' });
  });

  test('an item whose link came from the booking is flagged too: it is the hotel\'s link, not the item\'s own', async () => {
    const active = (await server.call('/api/itinerary/active', { token: bob })).body;
    for (const kind of ['checkin', 'checkout']) {
      const item = active.items.find(i => i.item_uid.endsWith(`_${kind}`));
      assert.equal(item.location_derived, true, kind);
    }
  });
});

// Boundary review of PR #397, finding 1: a link that came from the stop or the
// booking (not a derived search) must be flagged too, or the Modern editor
// prefills it and an edit freezes it into the item row.
describe('editing a hotel item never freezes the hotel\'s link into it', () => {
  let server, alice, bob;
  const L1 = 'https://www.google.com/maps/place/Dore/@48.0802,7.3601,17z';
  const L2 = 'https://www.google.com/maps/place/Dore/@48.1111,7.4222,17z';
  const stopLink = (location_url) => server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { accommodation: { type: 'hotel', name: HOTEL, confirmation: 'VD-1', location_url } } });
  const itemsNow = async () => {
    const items = (await server.call('/api/itinerary/active', { token: bob })).body.items;
    return { checkin: items.find(i => i.item_uid.endsWith('_checkin')), checkout: items.find(i => i.item_uid.endsWith('_checkout')) };
  };
  before(async () => {
    server = await boot(colmarConfig(), PORTS.hotelOnePlace);
    alice = await server.login('alice');
    bob = await server.login('bob');
    const created = await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'hotel', name: HOTEL, date_from: IN, date_to: OUT, confirmation: 'VD-1' } });
    assert.equal((await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: created.body.id } })).status, 200);
  });
  after(async () => { await server?.stop(); });

  test('stop link L1 -> edit the check-in as the Modern editor does -> stop link L2: both items follow L2', async () => {
    assert.equal((await stopLink(L1)).status, 200);
    const { checkin } = await itemsNow();
    assert.equal(checkin.location_url, L1);
    assert.equal(checkin.location_derived, true, 'a link from the stop is flagged, not only a derived search');
    // The editor prefills location_url "" when the flag is set, and sends null.
    const edited = await server.call(`/api/itinerary/items/${checkin.item_uid}`, { method: 'PATCH', token: alice, body: {
      text_he: checkin.text_he, text_en: `${checkin.text_en} (late)`, location_url: checkin.location_derived ? null : checkin.location_url } });
    assert.equal(edited.status, 200, edited.text);
    const db = new Database(join(server.dataDir, 'trip.db'), { readonly: true });
    const { active_version_id: rev } = db.prepare('SELECT active_version_id FROM trip_itinerary_state WHERE id = 1').get();
    const row = db.prepare("SELECT location_url, waze_url FROM itinerary_plan_items WHERE revision_id = ? AND item_uid LIKE '%\\_checkin' ESCAPE '\\'").get(rev);
    db.close();
    assert.equal(row.location_url, null, 'the edit did not store L1 in the item row');
    assert.equal((await stopLink(L2)).status, 200);
    const now = await itemsNow();
    assert.equal(now.checkin.text_en.endsWith('(late)'), true, 'the edit itself was kept');
    assert.equal(now.checkin.location_url, L2, 'check-in follows the new link');
    assert.equal(now.checkout.location_url, L2, 'check-out follows the new link');
  });
});

// Finding 2: a booking's name is not validated at the booking write the way a
// stop's is; the fallback into the served config must not carry what the stop
// write would refuse.
describe('the booking-name fallback in /api/config is validated like a stop\'s hotel name', () => {
  let server, alice, bob, bookingId;
  before(async () => {
    server = await boot(colmarConfig(), PORTS.hotelOnePlace);
    alice = await server.login('alice');
    bob = await server.login('bob');
    bookingId = (await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'hotel', name: HOTEL, date_from: IN, date_to: OUT } })).body.id;
    assert.equal((await server.call('/api/stops/colmar/from-booking', { method: 'POST', token: alice, body: { booking_id: bookingId } })).status, 200);
    // The stop's hotel loses its name but keeps the booking link.
    const p = await server.call('/api/stops/colmar', { method: 'PATCH', token: alice, body: { accommodation: { type: 'hotel', address: '1 Rue du Lac' } } });
    assert.equal(p.status, 200, p.text);
  });
  after(async () => { await server?.stop(); });
  const rename = (name) => {
    const db = new Database(join(server.dataDir, 'trip.db'));
    db.prepare('UPDATE bookings SET name = ? WHERE id = ?').run(name, bookingId);
    db.close();
  };
  const colmarAcc = async () => {
    const r = await server.call('/api/config', { token: bob });
    return { acc: r.body.phases.find(p => p.id === 'colmar').accommodation, text: r.text };
  };

  test('a clean booking name is the fallback', async () => {
    rename(HOTEL);
    assert.equal((await colmarAcc()).acc.name, HOTEL);
  });

  test('an old row with markup, a bidi override, a zero-width space and 6000 characters is not served', async () => {
    rename(`<script>alert(1)</script>‮​${'x'.repeat(6000)}`);
    const { acc, text } = await colmarAcc();
    assert.equal(acc.name, undefined, 'no name rather than a refused one');
    assert.ok(!text.includes('<script>') && !text.includes('‮') && !text.includes('​'), 'nothing of it reaches /api/config');
    assert.ok(text.length < 20000, 'and not 6000 characters of it');
    // The address still resolves the place.
    assert.match(acc.location_url, /query=1%20Rue%20du%20Lac$/);
  });
});

// Finding 3: the resolver reads the allow-list projection (the same gate the
// config goes through), so what it can serve is bounded by the allow-list.
describe('the resolver works from the allow-list projection', () => {
  const { createHotelPlaces } = require('../server/hotel-place.js');
  test('a non-string address is not used, and withheld keys never reach a resolved place', () => {
    const phase = { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' },
      accommodation: { name: HOTEL, pin: 'PIN-LEAK-1', door_code: 'DOOR-LEAK-2', notes_internal: 'NOTE-LEAK-3', address: { not: 'a string' } } };
    const booking = { id: 1, type: 'hotel', name: HOTEL, phase: 'colmar', location_url: null };
    const places = createHotelPlaces({ getConfig: () => ({ phases: [phase] }), sources: () => new Map([['colmar', { booking_id: 1 }]]), bookingById: () => booking });
    const place = places.forBooking(booking);
    assert.ok(!/LEAK/.test(JSON.stringify(place)), JSON.stringify(place));
    assert.equal(place.maps_url, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${HOTEL}, Colmar`)}`);
  });
});

// Finding 4: the active itinerary's booking card must carry the booking's own
// stop, so a hotel not linked to a stop keeps ITS town.
describe('a hotel booking not linked to a stop keeps its own town on the itinerary', () => {
  let server, alice, bob;
  before(async () => {
    server = await boot(colmarConfig(), PORTS.hotelOnePlace);
    alice = await server.login('alice');
    bob = await server.login('bob');
    const b = await server.call('/api/bookings', { method: 'POST', token: alice, body: { phase: 'colmar', type: 'hotel', name: HOTEL, date_from: IN, date_to: OUT } });
    // Filed under Colmar, not linked to any stop, shown on an item under Basel.
    const item = await server.call('/api/phases/basel/plan', { method: 'POST', token: alice, body: { date: '2090-03-12', time: '10:00', text_he: 'דלפק', text_en: 'Desk', booking_id: b.body.id } });
    assert.equal(item.status, 201, item.text);
  });
  after(async () => { await server?.stop(); });
  test('active itinerary, Classic plan and bookings all search "<hotel>, Colmar"', async () => {
    const want = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${HOTEL}, Colmar`)}`;
    const active = (await server.call('/api/itinerary/active', { token: bob })).body.items.find(i => i.text_en === 'Desk');
    assert.equal(active.booking.place.maps_url, want);
    assert.equal(active.location_url, want);
    const classic = (await server.call('/api/phases/basel/plan', { token: bob })).body.find(i => i.text_en === 'Desk');
    assert.equal(classic.booking.place.maps_url, want);
    assert.equal((await server.call('/api/bookings', { token: bob })).body.find(x => x.type === 'hotel').place.maps_url, want);
  });
});

describe('resolveHotelPlace (the one resolver)', () => {
  const phase = { id: 'colmar', title: { he: 'קולמר', en: 'Colmar' } };
  test('precedence: the stop\'s own link, then the booking\'s, then a search', () => {
    const booking = { id: 1, name: HOTEL, location_url: 'https://maps.example/booking' };
    assert.equal(resolveHotelPlace({ booking, accommodation: { name: HOTEL, location_url: 'https://maps.example/stop' }, phase }).maps_url, 'https://maps.example/stop');
    assert.equal(resolveHotelPlace({ booking, accommodation: { name: HOTEL }, phase }).maps_url, 'https://maps.example/booking');
    assert.match(resolveHotelPlace({ booking: { id: 1, name: HOTEL }, accommodation: { name: HOTEL }, phase }).maps_url, /query=Hotel%20Vignoble%20Dore%2C%20Colmar$/);
  });
  test('an address is a better query than the town; a bilingual name uses the English', () => {
    const p = resolveHotelPlace({ accommodation: { name: { he: 'מלון', en: 'Grand Hotel' }, address: '1 Rue du Lac' }, phase });
    assert.match(p.maps_url, /query=Grand%20Hotel%2C%201%20Rue%20du%20Lac$/);
  });
  test('a link that is not http(s) is never served; with no name and no address there is nothing to resolve', () => {
    const p = resolveHotelPlace({ accommodation: { name: HOTEL, location_url: 'javascript:alert(1)', waze: 'data:text/html,x' }, phase });
    assert.match(p.maps_url, /^https:\/\/www\.google\.com\/maps\/search\//);
    assert.match(p.waze_url, /^https:\/\/waze\.com\/ul\?q=/);
    assert.equal(resolveHotelPlace({ accommodation: {}, phase }), null);
    assert.equal(resolveHotelPlace({ accommodation: null, booking: null, phase }), null);
  });
});

// ── Classic (site/app.js): what it does with what the server resolved ────────
describe('Classic site: the hotel card, the anchors and the bookings tab open the resolved links', () => {
  const MAPS = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${HOTEL}, Colmar`)}`;
  const WAZE = `https://waze.com/ul?q=${encodeURIComponent(`${HOTEL}, Colmar`)}&navigate=yes`;
  const cfg = { phases: [{ id: 'colmar', title: { he: 'קולמר', en: 'Colmar' }, tabLabel: 'COLMAR', dates: { start: IN, end: OUT },
    accommodation: { type: 'hotel', name: HOTEL, confirmation: 'VD-1', location_url: MAPS, waze: WAZE } }] };

  test('renderPhaseHotelCard: Google Maps from location_url, Waze from waze — the links /api/config serves', () => {
    const googleMapsUrl = (q) => (q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null);
    const { document, ctx } = createRenderContext('<div id="hotel-colmar"></div>', cfg, 'en', { googleMapsUrl, bkConfUrls: () => null, bkEsc: (x) => String(x ?? '') });
    ctx.renderPhaseHotelCard(cfg.phases[0]);
    const hrefs = [...document.querySelectorAll('#hotel-colmar a.btn')].map(a => [a.textContent.trim(), a.getAttribute('href')]);
    assert.deepEqual(hrefs, [['🗺️ Google Maps', MAPS], ['🔵 Waze', WAZE]]);
  });

  test('accommodationAnchors (Home overview) carries the same link as the card', () => {
    const googleMapsUrl = (q) => (q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null);
    const { ctx } = createRenderContext('', cfg, 'en', { googleMapsUrl, bkConfUrls: () => null, bkEsc: (x) => String(x ?? '') });
    assert.equal(ctx.accommodationAnchors(cfg)[0].location_url, MAPS);
  });

  test('the Bookings tab badges: a hotel booking opens its place (📍) and Waze (🔵) even with no stored location_url', () => {
    // bookingRefBadges sits outside the render block; its source is run as is.
    const src = readFileSync(join(REPO, 'site', 'app.js'), 'utf8');
    const grab = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };
    const run = new Function(`${['bkEsc', 'bkSafeUrl', 'bkConfUrls', 'bookingRefBadges'].map(grab).join('\n')}\nreturn bookingRefBadges;`)();
    const html = run({ id: 1, type: 'hotel', name: HOTEL, location_url: null, place: { maps_url: MAPS, waze_url: WAZE } });
    assert.ok(html.includes(`href="${MAPS.replace(/&/g, '&amp;')}"`) || html.includes(`href="${MAPS}"`), html);
    assert.ok(html.includes('title="Waze"') && html.includes('waze.com/ul?q='), html);
    assert.ok(!run({ id: 2, type: 'flight', name: 'LY1', location_url: null }).includes('href='), 'a booking with no place shows no location badge');
    // An old stored link that is not http(s) must not hide the resolved one.
    const stale = run({ id: 3, type: 'hotel', name: HOTEL, location_url: 'ftp://old.example/x', place: { maps_url: MAPS, waze_url: WAZE } });
    assert.ok(stale.includes('google.com/maps/search') && !stale.includes('ftp://'), stale);
  });
});
