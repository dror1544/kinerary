/**
 * video-layout-css.test.js — what only the stylesheet can promise (video Release 1A/1B;
 * docs/specs/sprint-9/x-video-r1-site-look.md: AC-1's isolation, AC-11, AC-19).
 *
 * trip-web's own tests run in jsdom, which loads no CSS, so the three claims that live in
 * styles.css are checked here, on the source file the build ships:
 *
 *   isolation  every rule the video layout adds hangs off `.video-layout` (a root class set
 *              only while the switch is on) or a class only that layout renders, so with the
 *              switch off nothing can match and the current layout is untouched (AC-1);
 *   mirroring  the new block uses logical properties (inline-start/end), never physical
 *              left/right, so right-to-left mirrors it with no per-language rules (AC-11);
 *   contrast   badge text meets 4.5:1 against its background, and white-on-coral — the
 *              combination decision 9 rules out — really does fall below it (AC-19).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'trip-web', 'src', 'styles.css'), 'utf8');
const MARK = 'The video layout (Release 1A/1B)';
const start = CSS.indexOf(MARK);
// From the end of the banner comment that names the block.
const BLOCK = CSS.slice(CSS.indexOf('*/', start) + 2);

// Classes only the video layout renders (components in App.tsx / recent-change.tsx that mount behind the switch).
const VIDEO_ONLY = /\.(video-layout|video-hero|video-hero-photo|video-hero-wash|video-hero-copy|skyline-motif|day-card|day-card-panel|day-card-head|day-card-starts|day-rows?|day-row-[a-z]+|next-marker|booked-tick|moved-from|go-chip|detail-toggle|item-go-bar|item-detail|provenance-note|change-[a-z-]+|updated-for-everyone|plan-video|plan-strip|plan-strip-group|plan-strip-days|plan-day|plan-day-label|date-col|day-date-col|is-fresh|is-updated|is-added|more-button)\b/;

function rules(css) {
  // Top-level and one level of @media: selector text and body. Enough for this file's flat rules.
  const out = [];
  const re = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(bare))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

describe('the video layout block exists and is isolated (AC-1)', () => {
  test('the block is present, after every pre-existing rule', () => {
    assert.ok(start > 0, 'the video layout block marker is missing from styles.css');
    assert.ok(BLOCK.length > 3000);
  });

  test('every selector in it is scoped to the video layout', () => {
    const loose = [];
    for (const { selector } of rules(BLOCK)) {
      for (const part of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (/^(from|to|\d+%)$/.test(part)) continue; // keyframe steps
        if (!VIDEO_ONLY.test(part) && !part.startsWith('[dir="rtl"] .day-row')) loose.push(part);
      }
    }
    assert.deepEqual(loose, [], 'a rule in the video block can match the current layout');
  });

  test('nothing above the block mentions a video-layout class (the current layout\'s rules are untouched)', () => {
    const before = CSS.slice(0, start);
    assert.doesNotMatch(before, /\.video-layout|\.go-chip|\.day-card|\.change-badge|\.plan-strip/);
  });
});

describe('mirroring (AC-11)', () => {
  test('no physical left/right in the new block, except the one rule that names [dir="rtl"]', () => {
    const physical = BLOCK.split('\n').filter((line) =>
      /(^|[\s;{])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|float:\s*(left|right))\s*[:\s]/.test(line) && !line.includes('[dir="rtl"]'));
    assert.deepEqual(physical, []);
  });
});

describe('contrast (AC-19)', () => {
  const hex = (body, property) => body.match(new RegExp(`(?:^|[\\s;])${property}:\\s*[^;#]*?(#[0-9a-fA-F]{6})`))?.[1];
  const luminance = (color) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const body = (selector) => rules(BLOCK).find((r) => r.selector === selector)?.body ?? '';

  test('Updated: ink text on its coral tint', () => {
    const rule = body('.change-badge.updated');
    assert.ok(ratio(hex(rule, 'color'), hex(rule, 'background')) >= 4.5, `${hex(rule, 'color')} on ${hex(rule, 'background')}`);
  });

  test('New: ink text on the page, with a coral outline', () => {
    const rule = body('.change-badge.new');
    assert.ok(ratio(hex(rule, 'color'), '#ffffff') >= 4.5);
    assert.match(rule, /border:[^;]*#f26b3a/i);
    assert.match(rule, /background:\s*transparent/);
  });

  test('the struck-through old time and the Go chip are readable too', () => {
    assert.ok(ratio(hex(body('.change-time-old'), 'color'), '#ffffff') >= 4.5);
    const chipBg = CSS.match(/--go-chip-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    assert.ok(chipBg && ratio('#ffffff', chipBg) >= 4.5, `white on ${chipBg}`);
  });

  test('white on coral — what decision 9 rules out — really is below 4.5:1', () => {
    assert.ok(ratio('#ffffff', '#f26b3a') < 4.5);
  });
});
