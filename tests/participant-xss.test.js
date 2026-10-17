/**
 * participant-xss.test.js — a participant's name/name_en/color must render
 * inert on every classic-client surface that shows a participant: the RSVP
 * chip (text + title), the rating chip (text + title), the photo-reaction
 * tooltip, and the pg-avatar / vc-avatar inline style.
 *
 * #213: `name`/`name_en` are settable with no validation via
 * POST /api/agent/participants (organizer or agent key) and are then read
 * back by the classic client through uname() into these renderers.
 * `escapeHtml` used to leave quotes alone, so an attribute context (a
 * `title="..."` or a `style="background:...">` set from `color`) let a
 * planted `"` close the attribute early and turn the rest of the string
 * into a live handler. `color` is now also validated by the API itself
 * (tests/agent-participants.test.js, "rejects a color that is not a hex
 * value") — these tests are the render-side half of the same fix: even a
 * config written before that check existed, or edited by hand, must not be
 * able to break out of the attribute.
 *
 * Extracts the real source from site/app.js (not a reimplementation), same
 * technique as tests/booking-xss.test.js: escapeHtml()/safeParticipantColor()
 * plus every render function named in the issue are pulled straight out of
 * the file and exercised with a synthetic participant shaped exactly like
 * what POST /api/agent/participants + GET /api/config/roster / the comments,
 * RSVPs and photo-reactions endpoints hand back — { username, user: { name,
 * name_en, color } } — so the test fails the moment any call site stops
 * escaping, rather than the moment someone reimplements the bug away.
 *
 * Two functions (renderVenueCommentThread, renderPhotoCommentThread) write
 * straight to `element.innerHTML` instead of returning a string. happy-dom's
 * own `.innerHTML` getter re-serializes text nodes without re-escaping `<`/
 * `>`, so reading the *escaped* payload back out through a real DOM prints
 * what looks like a live tag even though no `<img>` element was ever
 * created — confirmed by `querySelector('img')` returning null against
 * exactly this payload. `fakeDocument()` below hands those two functions a
 * plain object instead of a real DOM, so the assertions see the literal
 * string that was assigned to `.innerHTML`, with no serializer in between.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { createRenderContext, RENDER_TARGETS_HTML } from './helpers/dom.js';

const HERE   = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'site', 'app.js');

// The exact planted participant from the issue's proof: a name that closes
// a text node and opens an <img onerror>, and a color that closes a
// style="..." attribute and adds a live onmouseover handler.
const HOSTILE_NAME    = `"><img src=x onerror=alert(1)>`;
const HOSTILE_COLOR   = `red;" onmouseover="alert(3)`;
const LIVE_IMG_MARKER = '<img src=x onerror=alert(1)>'; // a real (unescaped) <img> tag from the payload
const LIVE_STYLE_BREAKOUT = '" onmouseover="alert(3)';   // the color breaking out of style="..."

function extractSource() {
  const src = readFileSync(APP_JS, 'utf8');
  // uname() — every renderer below reads name/name_en through it.
  const unameStart = src.indexOf('function uname(username, userObj)');
  if (unameStart === -1) throw new Error('Could not locate uname() in app.js');
  const unameEnd = src.indexOf('\n}\n', unameStart) + 3;
  const unameSrc = src.slice(unameStart, unameEnd);

  // buildRatingChips, escapeHtml, safeParticipantColor, renderVenueCommentThread,
  // renderRsvpCard, buildPhotoCard, togglePhotoReaction, renderPhotoCommentThread
  // all live in this one contiguous region.
  const start = src.indexOf('let allRatings = {};');
  const end   = src.indexOf('async function submitPhotoComment');
  if (start === -1 || end === -1) throw new Error('Could not locate participant-render region in app.js');
  let region = src.slice(start, end);
  // These caches are `let`/`const` at module top level, which in a vm-run
  // SCRIPT (not module) creates a lexical binding that is invisible as a
  // property on the sandbox object — only `var` (and function declarations,
  // which already work below) attach to the global object the tests can
  // reach through `ctx`. Rewritten to `var` only for the caches this test
  // needs to seed from outside; the functions under test are otherwise
  // untouched.
  region = region
    .replace('let allRatings = {};', 'var allRatings = {};')
    .replace('const venueCommentsCache = {};', 'var venueCommentsCache = {};')
    .replace('const rsvpCache = {};', 'var rsvpCache = {};')
    .replace(/const photoCommentsCache = \{\};.*$/m, 'var photoCommentsCache = {};');
  return unameSrc + '\n' + region;
}

/** A `document` stand-in that hands back plain capturing objects instead of
 * real DOM nodes — see the file header for why. */
function fakeDocument() {
  const els = {};
  return {
    getElementById(id) {
      if (!els[id]) els[id] = { id, _html: '', textContent: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; } };
      return els[id];
    },
  };
}

function makeContext(doc) {
  const ctx = vm.createContext({
    window: { USERS_CACHE: {} },
    document: doc || fakeDocument(),
    currentLang: 'he',
    currentUser: null,
    T: { he: { rating_me: 'אני', ph_comments: 'תגובות' }, en: { rating_me: 'Me', ph_comments: 'comments' } },
    console,
  });
  vm.runInContext(extractSource(), ctx, { filename: 'app.js (participant-render region)' });
  return ctx;
}

describe('escapeHtml() — quotes', () => {
  test('escapes both quote characters, not just <>&', () => {
    const ctx = makeContext();
    const out = ctx.escapeHtml(`"><script>'`);
    assert.ok(!out.includes('"'), 'double quote must be escaped');
    assert.ok(!out.includes("'"), 'single quote must be escaped');
    assert.ok(!out.includes('<script>'), 'angle brackets must still be escaped');
  });
});

describe('safeParticipantColor() — render-side validation', () => {
  test('passes through a well-formed hex color', () => {
    const ctx = makeContext();
    assert.equal(ctx.safeParticipantColor('#22C55E'), '#22C55E');
  });
  test('falls back to a neutral default for a hostile color', () => {
    const ctx = makeContext();
    assert.equal(ctx.safeParticipantColor(HOSTILE_COLOR), '#888');
  });
});

describe('buildRatingChips() — a hostile participant renders inert', () => {
  test('name is escaped in both the title attribute and the visible text; color falls back', () => {
    const ctx = makeContext();
    ctx.window.USERS_CACHE = { mallory: { name: HOSTILE_NAME, color: HOSTILE_COLOR } };
    ctx.allRatings = { 'venue-1': { mallory: 5 } };
    const html = ctx.buildRatingChips('venue-1');
    assert.ok(!html.includes(LIVE_IMG_MARKER), 'the planted <img> must not appear as a live tag');
    assert.ok(!html.includes(LIVE_STYLE_BREAKOUT), 'the color must not break out of style="..."');
    assert.ok(html.includes('background:#888'), 'a hostile color must fall back to the neutral default');
  });
});

describe('renderRsvpCard() — a hostile participant renders inert', () => {
  test('name is escaped in the chip title and its visible text; color falls back', () => {
    const ctx = makeContext();
    ctx.rsvpCache['act1'] = [
      { username: 'mallory', status: 'yes', user: { name: HOSTILE_NAME, color: HOSTILE_COLOR } },
    ];
    const html = ctx.renderRsvpCard({ id: 'act1', title: 'Dinner', date: '2026-10-01', price: '$0' });
    assert.ok(!html.includes(LIVE_IMG_MARKER), 'the planted <img> must not appear as a live tag');
    assert.ok(!html.includes(LIVE_STYLE_BREAKOUT), 'the color must not break out of style="..."');
    assert.ok(html.includes('background:#888'), 'a hostile color must fall back to the neutral default');
  });
});

describe('renderVenueCommentThread() — vc-avatar inline style', () => {
  test('a hostile color cannot break out of the avatar\'s style attribute; the planted <img> is not live', () => {
    const doc = fakeDocument();
    const ctx = makeContext(doc);
    ctx.venueCommentsCache['v1'] = [
      { username: 'mallory', body: 'hi', created_at: '2026-01-01T00:00:00Z', user: { name: HOSTILE_NAME, color: HOSTILE_COLOR } },
    ];
    ctx.renderVenueCommentThread('v1');
    const html = doc.getElementById('vc-thread-v1').innerHTML;
    assert.ok(!html.includes(LIVE_IMG_MARKER), 'the planted <img> must not appear as a live tag');
    assert.ok(!html.includes(LIVE_STYLE_BREAKOUT), 'the color must not break out of style="..."');
    assert.ok(html.includes('background:#888'), 'a hostile color must fall back to the neutral default');
  });
});

describe('buildPhotoCard() — pg-avatar inline style and reaction tooltip', () => {
  test('a hostile color cannot break out of the avatar style, and the reaction tooltip escapes names', () => {
    const ctx = makeContext();
    const photo = { id: 'p1', username: 'mallory', uploadedAt: '2026-01-01T00:00:00Z', user: { name: HOSTILE_NAME, color: HOSTILE_COLOR } };
    const html = ctx.buildPhotoCard(photo, { '❤️': ['mallory'] });
    assert.ok(!html.includes(LIVE_IMG_MARKER), 'the planted <img> must not appear as a live tag (the photo\'s own real <img> is expected)');
    assert.ok(!html.includes(LIVE_STYLE_BREAKOUT), 'the avatar color must not break out of style="..."');
    assert.ok(html.includes('background:#888'), 'a hostile color must fall back to the neutral default');
    assert.ok(!html.includes('title="' + HOSTILE_NAME), 'the reaction tooltip must not carry the raw, unescaped name');
  });
});

describe('renderPhotoCommentThread() — vc-avatar inline style (photo comments)', () => {
  test('a hostile color cannot break out of the avatar\'s style attribute; the planted <img> is not live', () => {
    const doc = fakeDocument();
    const ctx = makeContext(doc);
    ctx.photoCommentsCache['p1'] = [
      { username: 'mallory', body: 'hi', created_at: '2026-01-01T00:00:00Z', user: { name: HOSTILE_NAME, color: HOSTILE_COLOR } },
    ];
    ctx.renderPhotoCommentThread('p1');
    const html = doc.getElementById('pg-thread-p1').innerHTML;
    assert.ok(!html.includes(LIVE_IMG_MARKER), 'the planted <img> must not appear as a live tag');
    assert.ok(!html.includes(LIVE_STYLE_BREAKOUT), 'the color must not break out of style="..."');
    assert.ok(html.includes('background:#888'), 'a hostile color must fall back to the neutral default');
  });
});

describe('renderFamilies() — the Home "Families" list', () => {
  // renderFamilies() lives inside RENDER_FUNS_BEGIN/END (site/app.js) and
  // reads name/name_en straight off trip.config.json's participants[] —
  // exactly what POST /api/agent/participants writes, with no name
  // validation at the API — into `<span class="lang-he">${...}</span>`
  // with no escaping at all until this fix. Uses the real extraction
  // helper (tests/helpers/dom.js), same as tests/render.test.js's own
  // renderFamilies() coverage, so this exercises the actual shipped
  // function through a real DOM rather than a hand-picked slice of it.
  const cfg = {
    families: [{ id: 'family-a', name: { he: 'א', en: 'A' }, letter: 'A', description: { he: '', en: '' }, members: ['mallory'] }],
    participants: [{ username: 'mallory', name: HOSTILE_NAME, name_en: HOSTILE_NAME, age: 35, family: 'family-a', color: HOSTILE_COLOR }],
  };

  test('a hostile participant name renders as text, never as a live element', () => {
    const { document, ctx } = createRenderContext(RENDER_TARGETS_HTML, cfg);
    ctx.renderFamilies(cfg);
    const section = document.getElementById('families-section');
    assert.equal(section.querySelector('img'), null, 'the planted <img> must not become a live element');
    const strong = section.querySelector('strong');
    assert.ok(strong, 'an adult (age >= 25) should render inside <strong>');
    assert.ok(strong.textContent.includes(HOSTILE_NAME), 'the hostile string should appear as literal text');
  });
});

describe('a normal name and color still render visibly (escaping is not over-aggressive)', () => {
  test('buildRatingChips with an ordinary participant', () => {
    const ctx = makeContext();
    ctx.window.USERS_CACHE = { dana: { name: 'דנה', color: '#22C55E' } };
    ctx.allRatings = { 'venue-1': { dana: 4 } };
    const html = ctx.buildRatingChips('venue-1');
    assert.ok(html.includes('background:#22C55E'));
    assert.ok(html.includes('דנה'));
  });

  test('renderRsvpCard with an ordinary participant', () => {
    const ctx = makeContext();
    ctx.rsvpCache['act1'] = [{ username: 'dana', status: 'yes', user: { name: 'דנה', color: '#22C55E' } }];
    const html = ctx.renderRsvpCard({ id: 'act1', title: 'Dinner', date: '2026-10-01', price: '$0' });
    assert.ok(html.includes('background:#22C55E'));
    assert.ok(html.includes('דנה'));
  });
});
