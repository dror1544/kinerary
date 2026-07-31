/**
 * config.test.js — validates trip.config.json structure and pure helper functions.
 * No server, no DOM needed. Runs with: node --test config.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NEED_TYPES, NEED_SEVERITIES, VISIBILITIES } from '../shared/needs-schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg  = JSON.parse(readFileSync(join(HERE, 'fixtures', 'trip.config.json'), 'utf8'));

// ── Pure helper functions (duplicated from app.js for isolated testing) ───────
function _bi(obj, lang) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[lang] || obj.he || '';
}
function _biSpan(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return `<span class="lang-he">${obj.he || ''}</span><span class="lang-en">${obj.en || ''}</span>`;
}

// ── _bi() helper ──────────────────────────────────────────────────────────────
describe('_bi() bilingual extractor', () => {
  test('returns he string for { he, en } object', () => {
    assert.equal(_bi({ he: 'שלום', en: 'Hello' }, 'he'), 'שלום');
  });
  test('returns en string for { he, en } object', () => {
    assert.equal(_bi({ he: 'שלום', en: 'Hello' }, 'en'), 'Hello');
  });
  test('falls back to .he when lang key missing', () => {
    assert.equal(_bi({ he: 'שלום' }, 'en'), 'שלום');
  });
  test('passthrough for plain string', () => {
    assert.equal(_bi('plain string', 'he'), 'plain string');
  });
  test('returns empty string for null', () => {
    assert.equal(_bi(null, 'he'), '');
  });
  test('returns empty string for undefined', () => {
    assert.equal(_bi(undefined, 'he'), '');
  });
});

// ── _biSpan() helper ─────────────────────────────────────────────────────────
describe('_biSpan() bilingual span builder', () => {
  test('wraps both languages in spans', () => {
    const html = _biSpan({ he: 'שלום', en: 'Hello' });
    assert.ok(html.includes('<span class="lang-he">שלום</span>'), 'missing he span');
    assert.ok(html.includes('<span class="lang-en">Hello</span>'), 'missing en span');
  });
  test('passthrough for plain string', () => {
    assert.equal(_biSpan('plain'), 'plain');
  });
  test('returns empty string for null', () => {
    assert.equal(_biSpan(null), '');
  });
  test('handles missing he gracefully', () => {
    const html = _biSpan({ en: 'Hello' });
    assert.ok(html.includes('lang-he'), 'missing he span');
    assert.ok(html.includes('Hello'), 'missing en content');
  });
});

// ── trip.config.json schema ───────────────────────────────────────────────────
// Validated against the portable test fixture, not any specific deployed trip
// (there is no hardcoded path to a real trip's config here on purpose — this
// suite must pass the same way in every clone, with no trip data present).
describe('trip.config.json schema', () => {
  test('has required top-level keys', () => {
    for (const key of ['meta', 'participants', 'families', 'phases', 'tasks', 'bookings']) {
      assert.ok(key in cfg, `missing key: ${key}`);
    }
  });
  test('meta has title and departure', () => {
    assert.ok(cfg.meta.title, 'meta.title missing');
    assert.ok(cfg.meta.departure, 'meta.departure missing');
  });
  test('participants are all valid', () => {
    assert.ok(cfg.participants.length > 0, 'no participants');
    for (const p of cfg.participants) {
      assert.ok(p.username, `participant missing username: ${JSON.stringify(p)}`);
      assert.ok(p.name, `participant missing name: ${p.username}`);
      assert.ok(p.name_en, `participant missing name_en: ${p.username}`);
      assert.ok(typeof p.age === 'number', `participant age not a number: ${p.username}`);
      assert.ok(p.family, `participant missing family: ${p.username}`);
    }
  });
  test('bob\'s needs are well-formed', () => {
    // Scoped to bob (not "all participants with needs"), since eve's
    // fixture deliberately includes a malformed entry — see the
    // "malformed needs" test below.
    const bob = cfg.participants.find(p => p.username === 'bob');
    assert.ok(bob?.needs?.length, 'expected bob to have needs in the fixture');
    for (const n of bob.needs) {
      assert.ok(NEED_TYPES.includes(n.type), `bob has need with invalid type: ${n.type}`);
      assert.ok(NEED_SEVERITIES.includes(n.severity), `bob has need with invalid severity: ${n.severity}`);
      assert.ok(n.text?.he && n.text?.en, `bob has need missing bilingual text`);
    }
  });
  test('participants without needs are unaffected (field is optional)', () => {
    const withoutNeeds = cfg.participants.filter(p => !('needs' in p));
    assert.ok(withoutNeeds.length > 0, 'fixture should also exercise a participant with no needs field at all');
  });
  test('eve\'s needs exercise a visibility override, a malformed entry, and a garbage visibility value', () => {
    const eve = cfg.participants.find(p => p.username === 'eve');
    assert.ok(eve?.needs?.length === 3, 'expected eve to have exactly 3 needs in the fixture');

    const [override, malformed, garbageVisibility] = eve.needs;
    assert.equal(override.visibility, 'group', 'expected an explicit visibility override on eve\'s medical need');
    assert.equal(override.type, 'medical', 'expected the override to be on a type that defaults to organizer-only');

    assert.ok(!NEED_TYPES.includes(malformed.type), 'expected an intentionally-invalid type for the malformed-needs test');
    assert.ok(!NEED_SEVERITIES.includes(malformed.severity), 'expected an intentionally-invalid severity for the malformed-needs test');
    assert.ok(!malformed.text?.he, 'expected the malformed entry to be missing Hebrew text');

    assert.ok(!VISIBILITIES.includes(garbageVisibility.visibility), 'expected an intentionally-invalid visibility for the fail-safe test');
    assert.ok(NEED_TYPES.includes(garbageVisibility.type) && NEED_SEVERITIES.includes(garbageVisibility.severity),
      'the garbage-visibility entry should otherwise be well-formed, to isolate the visibility fail-safe');
  });
  test('families reference only known participant usernames', () => {
    const knownUsernames = new Set(cfg.participants.map(p => p.username));
    for (const fam of cfg.families) {
      for (const member of (fam.members || [])) {
        assert.ok(knownUsernames.has(member), `unknown member "${member}" in family ${fam.id}`);
      }
    }
  });
  test('phases have required fields', () => {
    assert.ok(cfg.phases.length > 0, 'no phases');
    for (const ph of cfg.phases) {
      assert.ok(ph.id, `phase missing id`);
      assert.ok(ph.tabLabel, `phase ${ph.id} missing tabLabel`);
      assert.ok(ph.accommodation, `phase ${ph.id} missing accommodation`);
    }
  });
  test('colorado phase has short_id "co"', () => {
    const co = cfg.phases.find(p => p.id === 'colorado');
    assert.equal(co?.short_id, 'co');
  });
  test('accommodation objects do NOT expose pin at the config level (API strips it)', () => {
    // Pins exist in config (that's fine) but /api/config must strip them.
    // Here we just verify the fixture has a pin field so stripping is meaningful.
    const ny = cfg.phases.find(p => p.id === 'ny');
    assert.equal(ny.accommodation.pin, '9999', 'accommodation pin is present (for stripping test)');
  });
  test('stats have number and description', () => {
    assert.ok(cfg.stats?.length > 0, 'no stats');
    for (const s of cfg.stats) {
      assert.ok(s.number, 'stat missing number');
      assert.ok(s.description?.he && s.description?.en, `stat ${s.number} missing bilingual description`);
    }
  });
  test('tasks have required fields', () => {
    for (const t of cfg.tasks) {
      assert.ok(t.id, 'task missing id');
      assert.ok(t.text?.he && t.text?.en, `task ${t.id} missing bilingual text`);
    }
  });
  test('bookings.hotels is an array', () => {
    assert.ok(Array.isArray(cfg.bookings?.hotels), 'bookings.hotels not an array');
  });
  test('bookings.cars is an array', () => {
    assert.ok(Array.isArray(cfg.bookings?.cars), 'bookings.cars not an array');
  });
  test('has 3 participants', () => {
    assert.equal(cfg.participants.length, 3);
  });
  test('has 2 phases', () => {
    assert.equal(cfg.phases.length, 2);
  });
});
