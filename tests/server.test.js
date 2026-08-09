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
    const res = await api('/api/config', { token });
    assert.equal(res.status, 200);
  });

  test('response is valid JSON with required keys', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    for (const key of ['meta', 'participants', 'phases', 'tasks']) {
      assert.ok(key in data, `missing key: ${key}`);
    }
  });

  test('has correct participant count from fixture (3)', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    assert.equal(data.participants.length, 3);
  });

  test('strips pin from accommodation objects', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    for (const phase of data.phases) {
      assert.ok(!('pin' in (phase.accommodation ?? {})),
        `phase ${phase.id} accommodation still has pin field`);
    }
  });

  test('strips pin from bookings.hotels entries', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    for (const hotel of (data.bookings?.hotels ?? [])) {
      assert.ok(!('pin' in hotel), `hotel "${hotel.name}" still has pin field`);
    }
  });

  test('strips pin from participants', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    for (const p of data.participants) {
      assert.ok(!('pin' in p), `participant ${p.username} still has pin field`);
    }
  });

  test('stats array is present', async () => {
    const res = await api('/api/config', { token });
    const { stats } = await res.json();
    assert.ok(Array.isArray(stats) && stats.length === 2, 'expected 2 stats from fixture');
  });

  test('organizer-only needs (default for allergy/medical) are stripped from the public read path', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const bob = data.participants.find(p => p.username === 'bob');
    // bob's fixture has 2 needs: a critical allergy (no explicit visibility,
    // defaults to organizer-only) and a dietary preference (defaults group).
    // Only the group-visible one should survive /api/config.
    assert.equal(bob.needs.length, 1, 'expected bob\'s organizer-only allergy to be stripped');
    assert.equal(bob.needs[0].type, 'dietary');
    assert.ok(!bob.needs.some(n => n.type === 'allergy'), 'organizer-only allergy leaked through /api/config');
  });

  test('unrecognized severity is normalized to critical, fail-safe not fail-quiet', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const eve = data.participants.find(p => p.username === 'eve');
    // "crticial" on an otherwise-fine dietary need — dietary defaults to
    // group, so the need is still served, but the typo'd severity must not
    // pass through as-is or read as non-critical.
    const typo = eve.needs.find(n => n.text?.en === 'Gluten free');
    assert.ok(typo, 'expected the group-visible dietary need to still be served');
    assert.equal(typo.severity, 'critical', 'unrecognized severity should fail safe to critical, not pass through as-is');
  });

  test('explicit visibility:"group" overrides the organizer default for medical/allergy', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const eve = data.participants.find(p => p.username === 'eve');
    const medical = eve.needs.find(n => n.type === 'medical');
    assert.ok(medical, 'expected eve\'s explicitly group-visible medical need to survive /api/config');
    assert.ok(medical.text?.he && medical.text?.en, 'medical need missing bilingual text');
  });

  test('an unrecognized need TYPE fails safe to organizer-only, not published to the group', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const eve = data.participants.find(p => p.username === 'eve');
    // The regression this guards: defaultVisibility() used to check
    // `type === 'medical' || type === 'allergy'` and fall through to 'group'
    // for anything else — so "medicl", or "Medical" with the wrong case,
    // published a medical need to an endpoint served with no auth at all.
    // Every other unknown value in the schema fails safe; this one didn't.
    assert.ok(!eve.needs.some(n => n.type === 'unrecognized-type'),
      'a need with an unrecognized type must not fall through as group-visible');
  });

  test('unrecognized visibility value fails safe to organizer-only (hidden), not visible', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const eve = data.participants.find(p => p.username === 'eve');
    assert.ok(!eve.needs.some(n => n.type === 'dietary' && n.visibility === 'porcupine'),
      'a garbage visibility value should be treated as organizer-only and stripped, not fall through as visible');
  });

  test('a participant whose needs are ALL organizer-only has the key dropped, not left as []', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const eve = data.participants.find(p => p.username === 'eve');
    // eve keeps one group-visible medical need, so she still has the key —
    // this asserts the shape rule via bob/alice below. The disclosure being
    // guarded: `needs: []` distinguishes "had needs, all hidden" from "no
    // needs at all", which tells an unauthenticated reader exactly who has
    // something to hide.
    assert.ok(Array.isArray(eve.needs) && eve.needs.length > 0);
    for (const p of data.participants) {
      assert.ok(!('needs' in p) || p.needs.length > 0,
        `${p.username} was served an empty needs array, which itself signals hidden needs`);
    }
  });

  test('alice has no needs field, matching the fixture', async () => {
    const res = await api('/api/config', { token });
    const data = await res.json();
    const alice = data.participants.find(p => p.username === 'alice');
    assert.ok(!('needs' in alice), 'alice should have no needs field, matching the fixture');
  });
});

// ── agent block ───────────────────────────────────────────────────────────────
describe('GET /api/config — agent persona', () => {
  test('public persona fields are served', async () => {
    const res = await api('/api/config', { token });
    const { agent } = await res.json();
    assert.ok(agent, 'expected the agent block to be served');
    assert.equal(agent.name, 'ויקטור');
    assert.equal(agent.gender, 'male', 'grammatical gender must survive — Hebrew needs it to conjugate');
    assert.equal(agent.organizer, 'alice');
  });

  test('unrecognized tone falls back to warm rather than passing through', async () => {
    const res = await api('/api/config', { token });
    const { agent } = await res.json();
    assert.equal(agent.tone, 'warm', 'fixture tone is "porcupine" and should normalize, not leak a junk value to the bot');
  });

  test('organizer-only standing instructions are stripped from the public read path', async () => {
    const res = await api('/api/config', { token });
    const { agent } = await res.json();
    const texts = (agent.standing_instructions || []).map(i => i.text?.en);
    assert.equal(texts.length, 1, `expected only the group-visible instruction, got ${JSON.stringify(texts)}`);
    assert.equal(texts[0], 'Rental car — mention parking');
  });

  test('an instruction with NO visibility defaults to organizer-only (unlike needs)', async () => {
    const res = await api('/api/config', { token });
    const body = await res.text();
    assert.ok(!body.includes('defaults to organizer'),
      'an instruction with no explicit visibility must default to hidden — every standing instruction is sensitive by default');
  });

  test('a typo\'d visibility fails safe to organizer-only', async () => {
    const res = await api('/api/config', { token });
    const body = await res.text();
    assert.ok(!body.includes('Typo\'d visibility'),
      'a garbage visibility value must resolve restrictive, not fall through as visible');
  });

  test('no organizer-only instruction text appears anywhere in the payload', async () => {
    // Belt-and-braces against the whole serialized response, not just the
    // agent block — catches a future refactor that copies the raw config
    // somewhere else in the payload (a versions snapshot, a debug echo).
    const res = await api('/api/config', { token });
    const body = await res.text();
    for (const secret of ['Sensitive topic to avoid', 'נושא רגיש']) {
      assert.ok(!body.includes(secret), `organizer-only instruction text "${secret}" leaked into /api/config`);
    }
  });
});

// ── /api/agent/brief ──────────────────────────────────────────────────────────
describe('GET /api/agent/brief', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await api('/api/agent/brief');
    assert.equal(res.status, 401);
  });

  test('rejects an authed NON-organizer — this is the whole point of the endpoint', async () => {
    // bob is a legitimate family member with a valid token. The fixture's
    // organizer is alice. authRequired would have let bob straight in, which
    // is why this route uses a stricter middleware.
    const login = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
    assert.equal(login.status, 200, 'expected bob to be able to log in at all');
    const bobToken = (await login.json()).token;
    const res = await api('/api/agent/brief', { token: bobToken });
    assert.equal(res.status, 403);
  });

  test('serves the agent service account (X-API-Key)', async () => {
    const res = await api('/api/agent/brief', { apiKey: 'test-hermes-key' });
    assert.equal(res.status, 200);
    const brief = await res.json();
    assert.equal(brief.persona?.name, 'ויקטור');
    assert.equal(brief.persona?.gender, 'male');
    assert.equal(brief.persona?.tone, 'warm', 'junk tone should normalize here too');
    assert.deepEqual(brief.organizers, ['alice'], 'legacy single-organizer string should normalize to a one-element list');
  });

  test('includes the organizer-only material that /api/config strips', async () => {
    const res = await api('/api/agent/brief', { apiKey: 'test-hermes-key' });
    const brief = await res.json();

    const texts = brief.standing_instructions.map(i => i.text?.en);
    assert.equal(brief.standing_instructions.length, 4, 'all four instructions, not just the group-visible one');
    assert.ok(texts.includes('Sensitive topic to avoid'), 'the organizer-only instruction must be readable here');

    // bob's peanut allergy is the case that motivated this: stored, stripped
    // from every read path, and therefore visible to nobody until now.
    const allergy = brief.needs.find(n => n.username === 'bob' && n.type === 'allergy');
    assert.ok(allergy, 'expected bob\'s organizer-only allergy in the brief');
    assert.equal(allergy.visibility, 'organizer');
    assert.equal(allergy.severity, 'critical');
  });

  test('every item carries a resolved visibility, so the bot knows what it may say aloud', async () => {
    const res = await api('/api/agent/brief', { apiKey: 'test-hermes-key' });
    const brief = await res.json();
    for (const i of brief.standing_instructions) {
      assert.ok(['group', 'organizer'].includes(i.visibility), `instruction ${i.index} has no resolved visibility`);
    }
    for (const n of brief.needs) {
      assert.ok(['group', 'organizer'].includes(n.visibility), `need for ${n.username} has no resolved visibility`);
    }
    assert.ok(brief.disclosure_policy?.organizer, 'the payload should state the disclosure rule, not assume the reader knows it');
  });
});

// ── /api/config/warnings ────────────────────────────────────────────────────────
describe('GET /api/config/warnings', () => {
  test('requires auth', async () => {
    const res = await api('/api/config/warnings');
    assert.equal(res.status, 401);
  });

  test('reports eve\'s malformed need instead of only logging it', async () => {
    const res = await api('/api/config/warnings', { token });
    assert.equal(res.status, 200);
    const warnings = await res.json();
    const eveWarnings = warnings.filter(w => w.username === 'eve');
    // eve's 4 fixture needs contribute 5 issues between them:
    //   [1] malformed entry      → unknown type, unknown severity, missing text (3)
    //   [2] garbage visibility   → unknown visibility (1)
    //   [3] bad-severity entry   → unknown severity (1)
    // The medical override is clean and contributes none.
    assert.equal(eveWarnings.length, 5, `expected 5 warnings for eve, got ${JSON.stringify(eveWarnings)}`);
    assert.ok(eveWarnings.some(w => /unknown type/.test(w.issue)));
    assert.ok(eveWarnings.some(w => /unknown severity/.test(w.issue)));
    assert.ok(eveWarnings.some(w => /unknown visibility/.test(w.issue)));
    assert.ok(eveWarnings.some(w => /missing bilingual text/.test(w.issue)));
  });

  test('the offending VALUE is withheld from the API even though the log keeps it', async () => {
    const res = await api('/api/config/warnings', { token });
    const body = await res.text();
    // "medicl" identifies the category as well as "medical" does, and this
    // endpoint is authRequired but not organizer-scoped — so the raw value
    // must not appear, only the fact that something was unrecognized.
    for (const raw of ['unrecognized-type', 'crticial', 'porcupine']) {
      assert.ok(!body.includes(raw), `raw config value "${raw}" leaked into /api/config/warnings`);
    }
    assert.ok(body.includes('value withheld'), 'expected the redaction marker so the organizer knows where to look');
  });

  test('warning objects never carry the need\'s type, so category (e.g. medical) can\'t leak through this side door', async () => {
    const res = await api('/api/config/warnings', { token });
    const warnings = await res.json();
    assert.ok(warnings.length > 0, 'expected at least one warning to check');
    assert.ok(!warnings.some(w => 'type' in w), 'a warning object still carries a type field');
  });

  test('alice has no warnings (no needs at all)', async () => {
    const res = await api('/api/config/warnings', { token });
    const warnings = await res.json();
    assert.ok(!warnings.some(w => w.username === 'alice'));
  });

  test('reports the agent block\'s malformed fields', async () => {
    const res = await api('/api/config/warnings', { token });
    const warnings = await res.json();
    const agentWarnings = warnings.filter(w => w.scope === 'agent');
    assert.ok(agentWarnings.some(w => /unknown tone/.test(w.issue)), 'expected a tone warning');
    assert.ok(agentWarnings.some(w => /unknown proactive key/.test(w.issue)), 'expected an unknown proactive key warning');
    assert.ok(agentWarnings.some(w => /unknown visibility/.test(w.issue)), 'expected a standing_instructions visibility warning');
  });

  test('agent warnings never carry the instruction text itself', async () => {
    const res = await api('/api/config/warnings', { token });
    const body = await res.text();
    for (const secret of ['Sensitive topic to avoid', 'נושא רגיש', 'Typo\'d visibility']) {
      assert.ok(!body.includes(secret),
        `instruction text "${secret}" leaked through /api/config/warnings — this endpoint is authRequired but not organizer-scoped`);
    }
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

// ── POST /api/auth/avatar/upload ────────────────────────────────────────────
describe('POST /api/auth/avatar/upload', () => {
  function avatarForm(username) {
    const form = new FormData();
    form.append('avatar', new Blob([Buffer.from([0])], { type: 'image/png' }), 'a.png');
    if (username !== undefined) form.append('username', username);
    return form;
  }

  test('agent key + username writes that participant\'s avatar', async () => {
    const res = await api('/api/auth/avatar/upload', {
      method: 'POST', apiKey: 'test-hermes-key', body: avatarForm('bob'),
    });
    assert.equal(res.status, 200);
    const { avatar_file } = await res.json();
    assert.ok(avatar_file.startsWith('Bob'), `expected bob's avatar, got ${avatar_file}`);
  });

  test('family-member JWT + someone else\'s username does NOT reassign it', async () => {
    // alice's own token, asking to set bob's avatar. If this ever passed
    // through to bob, the response would report "Bob..." instead of "Alice...".
    const res = await api('/api/auth/avatar/upload', {
      method: 'POST', token, body: avatarForm('bob'),
    });
    assert.equal(res.status, 200);
    const { avatar_file } = await res.json();
    assert.ok(avatar_file.startsWith('Alice'), `username field must be ignored on the JWT path, got ${avatar_file}`);
    assert.ok(!avatar_file.startsWith('Bob'), 'a JWT-authed request must never reassign another participant\'s avatar');
  });

  test('agent key + unknown username returns 400', async () => {
    const res = await api('/api/auth/avatar/upload', {
      method: 'POST', apiKey: 'test-hermes-key', body: avatarForm('nonexistent-user'),
    });
    assert.equal(res.status, 400);
  });

  test('a family member can still upload their own avatar, unaffected by the agent path', async () => {
    const res = await api('/api/auth/avatar/upload', {
      method: 'POST', token, body: avatarForm(),
    });
    assert.equal(res.status, 200);
    const { avatar_file } = await res.json();
    assert.ok(avatar_file.startsWith('Alice'));
  });
});

// ── DELETE /api/auth/avatar ───────────────────────────────────────────────────
describe('DELETE /api/auth/avatar', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await api('/api/auth/avatar', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

  test('clears avatar_file back to default', async () => {
    await api('/api/auth/avatar', { method: 'PUT', token, body: { avatar_file: 'Alice2.png' } });
    const before = await (await api('/api/auth/me', { token })).json();
    assert.equal(before.avatar_file, 'Alice2.png');

    const res = await api('/api/auth/avatar', { method: 'DELETE', token });
    assert.equal(res.status, 200);

    const after = await (await api('/api/auth/me', { token })).json();
    assert.equal(after.avatar_file, null);
  });
});

// ── Google Sign-In ────────────────────────────────────────────────────────────
// The test server never sets GOOGLE_CLIENT_ID, so link/login correctly report
// "not configured" here — this is the deployment default (password-only)
// and exercises the guard clauses. Verifying real Google ID tokens requires
// a signed token from Google itself, so that path is left to manual/staging
// verification rather than faked out in a unit test.
describe('Google Sign-In (not configured in test env)', () => {
  test('PUT /api/auth/google-link returns 503 when Google Sign-In is not configured', async () => {
    const res = await api('/api/auth/google-link', { method: 'PUT', token, body: { idToken: 'x' } });
    assert.equal(res.status, 503);
    const { error } = await res.json();
    assert.equal(error, 'google_not_configured');
  });

  test('POST /api/auth/google-login returns 503 when Google Sign-In is not configured', async () => {
    const res = await api('/api/auth/google-login', { method: 'POST', body: { idToken: 'x' } });
    assert.equal(res.status, 503);
    const { error } = await res.json();
    assert.equal(error, 'google_not_configured');
  });

  test('DELETE /api/auth/google-link requires auth but never needs Google configured (idempotent unlink)', async () => {
    const unauth = await api('/api/auth/google-link', { method: 'DELETE' });
    assert.equal(unauth.status, 401);

    const res = await api('/api/auth/google-link', { method: 'DELETE', token });
    assert.equal(res.status, 200);

    const me = await (await api('/api/auth/me', { token })).json();
    assert.equal(me.google_sub, null);
    assert.equal(me.google_email, null);
  });
});

// ── GET /api/health ────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  test('reports telegramBotUsername: null when Telegram is not configured', async () => {
    const res = await api('/api/health');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.telegramBotUsername, null);
  });

  test('reports telegramGroupBound: false when TELEGRAM_CHAT_ID is not set', async () => {
    const res = await api('/api/health');
    const data = await res.json();
    assert.equal(data.telegramGroupBound, false);
  });
});

// ── GET /api/config/roster ──────────────────────────────────────────────────────
// Deliberately public — the pre-auth login picker needs a "who's on this
// trip" list before any session exists, but it must carry only the four
// fields the picker actually renders, never anything from the full,
// authenticated /api/config (itinerary, budget, needs, PII).
describe('GET /api/config/roster', () => {
  test('is reachable without a token', async () => {
    const res = await api('/api/config/roster');
    assert.equal(res.status, 200);
  });

  test('includes every participant with only username/name/name_en/color', async () => {
    const res = await api('/api/config/roster');
    const { participants } = await res.json();
    const usernames = participants.map(p => p.username);
    assert.ok(usernames.includes('alice'));
    assert.ok(usernames.includes('bob'));
    assert.ok(usernames.includes('eve'));
    for (const p of participants) {
      assert.deepEqual(Object.keys(p).sort(), ['color', 'name', 'name_en', 'username']);
    }
  });

  test('never exposes age, family, needs, pin, or telegram_id', async () => {
    const res = await api('/api/config/roster');
    const { participants } = await res.json();
    const serialized = JSON.stringify(participants);
    for (const forbidden of ['age', 'family', 'needs', 'pin', 'telegram_id']) {
      assert.ok(!serialized.includes(forbidden), `roster leaked a "${forbidden}" field`);
    }
  });
});

// ── Config-driven generalization: phases derive from config ───────────────────
describe('config-driven phase structure', () => {
  test('phase count matches fixture config', async () => {
    const res = await api('/api/config', { token });
    const { phases } = await res.json();
    // fixture has 2 phases: ny + colorado
    assert.equal(phases.length, 2);
  });

  test('colorado phase has short_id "co" in config', async () => {
    const res = await api('/api/config', { token });
    const { phases } = await res.json();
    const co = phases.find(p => p.id === 'colorado');
    assert.equal(co?.short_id, 'co');
  });

  test('no participant pin fields exposed via /api/config', async () => {
    const res = await api('/api/config', { token });
    const { participants } = await res.json();
    for (const p of participants) {
      assert.ok(!p.pin, `participant ${p.username} has a pin exposed`);
    }
  });
});

// ── Phase plan items ─────────────────────────────────────────────────────────
// alice = organizer (fixture: agent.organizer = "alice")
// bob   = family member only
describe('Phase plan items', () => {
  let bobToken;
  before(async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
    bobToken = (await r.json()).token;
  });

  test('GET /api/phases/ny/plan — 401 without auth', async () => {
    const res = await api('/api/phases/ny/plan');
    assert.equal(res.status, 401);
  });

  test('GET /api/phases/ny/plan — 200 empty array for family member', async () => {
    const res = await api('/api/phases/ny/plan', { token: bobToken });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data) && data.length === 0);
  });

  test('GET /api/phases/invalid/plan — 400 unknown phase', async () => {
    const res = await api('/api/phases/invalid/plan', { token });
    assert.equal(res.status, 400);
  });

  test('POST /api/phases/ny/plan — family member gets 403', async () => {
    const res = await api('/api/phases/ny/plan', {
      method: 'POST', token: bobToken,
      body: { text_he: 'פעילות', date: '2027-03-11', time: '09:00' },
    });
    assert.equal(res.status, 403);
  });

  test('POST /api/phases/ny/plan — organizer creates item, 201', async () => {
    const res = await api('/api/phases/ny/plan', {
      method: 'POST', token,
      body: { text_he: 'סיור בעיר', text_en: 'City tour', date: '2027-03-11', time: '10:00', status: 'confirmed' },
    });
    assert.equal(res.status, 201);
    const item = await res.json();
    assert.equal(item.text_he, 'סיור בעיר');
    assert.equal(item.status, 'confirmed');
    assert.equal(item.phase_id, 'ny');
  });

  test('GET /api/phases/ny/plan — item persists and is returned', async () => {
    const res = await api('/api/phases/ny/plan', { token: bobToken });
    const items = await res.json();
    assert.ok(items.length >= 1);
    assert.ok(items.some(i => i.text_he === 'סיור בעיר'));
  });

  test('PATCH /api/phases/ny/plan/:id — organizer updates item', async () => {
    const listRes = await api('/api/phases/ny/plan', { token });
    const items = await listRes.json();
    const id = items.find(i => i.text_he === 'סיור בעיר').id;
    const res = await api(`/api/phases/ny/plan/${id}`, {
      method: 'PATCH', token,
      body: { location_url: 'https://maps.google.com/?q=NYC', status: 'confirmed' },
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.location_url, 'https://maps.google.com/?q=NYC');
  });

  test('POST /api/phase-plan/import-from-bookings — creates item from long-notes booking', async () => {
    // create a booking with long notes first
    const bkRes = await api('/api/bookings', {
      method: 'POST', token,
      body: { phase: 'ny', type: 'other', name: 'תוכנית יום 1', notes: 'א'.repeat(90) },
    });
    assert.equal(bkRes.status, 200);

    const migRes = await api('/api/phase-plan/import-from-bookings', { method: 'POST', token });
    assert.equal(migRes.status, 200);
    const { created, skipped } = await migRes.json();
    assert.ok(Array.isArray(created) && created.length >= 1);
    assert.ok(created.some(i => i.status === 'needs_review'));
  });

  test('POST /api/phase-plan/import-from-bookings — idempotent on second call', async () => {
    const res1 = await api('/api/phase-plan/import-from-bookings', { method: 'POST', token });
    const { created: c1, skipped: s1 } = await res1.json();

    const res2 = await api('/api/phase-plan/import-from-bookings', { method: 'POST', token });
    const { created: c2, skipped: s2 } = await res2.json();

    assert.equal(c2.length, 0, 're-running should create nothing new');
    assert.ok(s2.length >= s1.length + c1.length - 1, 'previously-created items should be skipped');
  });

  test('DELETE /api/phases/ny/plan/:id — organizer removes item, 204', async () => {
    const listRes = await api('/api/phases/ny/plan', { token });
    const items = await listRes.json();
    const id = items.find(i => i.text_he === 'סיור בעיר').id;
    const res = await api(`/api/phases/ny/plan/${id}`, { method: 'DELETE', token });
    assert.equal(res.status, 204);
    const listAfter = await api('/api/phases/ny/plan', { token });
    const after = await listAfter.json();
    assert.ok(!after.some(i => i.id === id), 'item should be gone after delete');
  });
});

// ── GET /api/auth/me — is_organizer field ─────────────────────────────────────
describe('GET /api/auth/me — is_organizer', () => {
  test('organizer (alice) gets is_organizer: true', async () => {
    const res = await api('/api/auth/me', { token });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.is_organizer, true);
  });

  test('family member (bob) gets is_organizer: false', async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } });
    const { token: bt } = await r.json();
    const res = await api('/api/auth/me', { token: bt });
    const me = await res.json();
    assert.equal(me.is_organizer, false);
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
