/**
 * server.test.js — HTTP integration tests for the trip server API.
 * Spins up a real server against test fixtures. Requires node:test + built-in fetch.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';

let token;

before(async () => {
  await startTestServer();
  token = await loginAsAlice();
});

after(() => stopTestServer());

// ── /api/config ───────────────────────────────────────────────────────────────
describe('GET /api/config', () => {
  test('returns 200', async () => {
    const res = await api('/api/config');
    assert.equal(res.status, 200);
  });

  test('response is valid JSON with required keys', async () => {
    const res = await api('/api/config');
    const data = await res.json();
    for (const key of ['meta', 'participants', 'phases', 'tasks']) {
      assert.ok(key in data, `missing key: ${key}`);
    }
  });

  test('has correct participant count from fixture (2)', async () => {
    const res = await api('/api/config');
    const data = await res.json();
    assert.equal(data.participants.length, 2);
  });

  test('strips pin from accommodation objects', async () => {
    const res = await api('/api/config');
    const data = await res.json();
    for (const phase of data.phases) {
      assert.ok(!('pin' in (phase.accommodation ?? {})),
        `phase ${phase.id} accommodation still has pin field`);
    }
  });

  test('strips pin from bookings.hotels entries', async () => {
    const res = await api('/api/config');
    const data = await res.json();
    for (const hotel of (data.bookings?.hotels ?? [])) {
      assert.ok(!('pin' in hotel), `hotel "${hotel.name}" still has pin field`);
    }
  });

  test('strips pin from participants', async () => {
    const res = await api('/api/config');
    const data = await res.json();
    for (const p of data.participants) {
      assert.ok(!('pin' in p), `participant ${p.username} still has pin field`);
    }
  });

  test('stats array is present', async () => {
    const res = await api('/api/config');
    const { stats } = await res.json();
    assert.ok(Array.isArray(stats) && stats.length === 2, 'expected 2 stats from fixture');
  });
});

// ── /api/auth/login ───────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  test('valid credentials return 200 and a token', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: '1234' },
    });
    assert.equal(res.status, 200);
    const { token: t } = await res.json();
    assert.ok(t && typeof t === 'string', 'expected a token string');
  });

  test('wrong password returns 401', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'wrongpassword' },
    });
    assert.equal(res.status, 401);
  });

  test('unknown username returns 401', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'nobody', password: '1234' },
    });
    assert.equal(res.status, 401);
  });
});

// ── /api/bookings — auth gate ─────────────────────────────────────────────────
describe('GET /api/bookings — auth', () => {
  test('returns 401 without a token', async () => {
    const res = await api('/api/bookings');
    assert.equal(res.status, 401);
  });

  test('returns 401 with a garbage token', async () => {
    const res = await api('/api/bookings', { token: 'garbage.token.here' });
    assert.equal(res.status, 401);
  });

  test('returns 200 with a valid token', async () => {
    const res = await api('/api/bookings', { token });
    assert.equal(res.status, 200);
  });
});

// ── /api/bookings — CRUD ──────────────────────────────────────────────────────
describe('/api/bookings CRUD', () => {
  test('GET returns the seeded booking from bookings.json', async () => {
    const res = await api('/api/bookings', { token });
    const rows = await res.json();
    assert.ok(Array.isArray(rows), 'expected an array');
    const seed = rows.find(b => b.seed_key === 'test-seed-hotel-nyc');
    assert.ok(seed, 'seed booking not found in response');
  });

  test('POST creates a new booking', async () => {
    const res = await api('/api/bookings', {
      method: 'POST',
      token,
      body: {
        phase: 'ny',
        type: 'attraction',
        name: 'Statue of Liberty Tour',
        date_from: '2027-03-12',
        date_to: null,
        passengers: null,
        confirmation: 'SOL-001',
        pin: null,
        notes: 'Created by test',
        cost: 75,
      },
    });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    assert.ok(Number.isInteger(id) && id > 0, 'expected a positive integer id');
  });

  test('GET after POST includes the new booking', async () => {
    const res = await api('/api/bookings', { token });
    const rows = await res.json();
    const created = rows.find(b => b.name === 'Statue of Liberty Tour');
    assert.ok(created, 'newly created booking not found');
    assert.equal(created.cost, 75);
  });

  test('PATCH updates a non-seed booking', async () => {
    // Get the id of the attraction we just created
    const all = await (await api('/api/bookings', { token })).json();
    const booking = all.find(b => b.name === 'Statue of Liberty Tour');
    assert.ok(booking, 'booking to patch not found');

    const res = await api(`/api/bookings/${booking.id}`, {
      method: 'PATCH',
      token,
      body: { cost: 99, notes: 'Updated by test' },
    });
    assert.equal(res.status, 200);

    // Verify the update
    const updated = await (await api('/api/bookings', { token })).json();
    const patched = updated.find(b => b.id === booking.id);
    assert.equal(patched?.cost, 99);
  });

  test('DELETE removes a non-seed booking', async () => {
    const all = await (await api('/api/bookings', { token })).json();
    const booking = all.find(b => b.name === 'Statue of Liberty Tour');
    assert.ok(booking, 'booking to delete not found');

    const res = await api(`/api/bookings/${booking.id}`, { method: 'DELETE', token });
    assert.equal(res.status, 200);

    // Verify it's gone
    const after = await (await api('/api/bookings', { token })).json();
    assert.ok(!after.find(b => b.id === booking.id), 'deleted booking still present');
  });

  test('DELETE a seed booking returns 403', async () => {
    const all = await (await api('/api/bookings', { token })).json();
    const seed = all.find(b => b.seed_key === 'test-seed-hotel-nyc');
    assert.ok(seed, 'seed booking not found');

    const res = await api(`/api/bookings/${seed.id}`, { method: 'DELETE', token });
    assert.equal(res.status, 403);
  });
});

// ── /api/auth/me ──────────────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  test('returns the logged-in user', async () => {
    const res = await api('/api/auth/me', { token });
    assert.equal(res.status, 200);
    const user = await res.json();
    assert.equal(user.username, 'alice');
  });
});

// ── Config-driven generalization: phases derive from config ───────────────────
describe('config-driven phase structure', () => {
  test('phase count matches fixture config', async () => {
    const res = await api('/api/config');
    const { phases } = await res.json();
    // fixture has 2 phases: ny + colorado
    assert.equal(phases.length, 2);
  });

  test('colorado phase has short_id "co" in config', async () => {
    const res = await api('/api/config');
    const { phases } = await res.json();
    const co = phases.find(p => p.id === 'colorado');
    assert.equal(co?.short_id, 'co');
  });

  test('no participant pin fields exposed via /api/config', async () => {
    const res = await api('/api/config');
    const { participants } = await res.json();
    for (const p of participants) {
      assert.ok(!p.pin, `participant ${p.username} has a pin exposed`);
    }
  });
});

// ── /api/auth/password ───────────────────────────────────────────────────────
// Placed last: changes alice's password, so any earlier test logging in with
// the original password must not run after this one.
describe('PUT /api/auth/password', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await api('/api/auth/password', { method: 'PUT', body: { password: 'newpass123' } });
    assert.equal(res.status, 401);
  });

  test('rejects a password shorter than 4 characters', async () => {
    const res = await api('/api/auth/password', { method: 'PUT', body: { password: 'abc' }, token });
    assert.equal(res.status, 400);
  });

  test('changes the password; old password stops working, new one logs in', async () => {
    const change = await api('/api/auth/password', { method: 'PUT', body: { password: 'newpass123' }, token });
    assert.equal(change.status, 200);

    const oldLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'alice', password: '1234' } });
    assert.equal(oldLogin.status, 401);

    const newLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'newpass123' } });
    assert.equal(newLogin.status, 200);
  });
});
