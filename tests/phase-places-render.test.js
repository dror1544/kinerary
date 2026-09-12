/**
 * phase-places-render.test.js — a phase that has places but no schedule.
 *
 * An interview-built trip arrives with the places each leg is planned around
 * and no dated days: nothing yet turns `venues[]` into `days[]`. Reported live
 * on 2026-09-12 — the trip config listed Tokyo Skytree and TeamLab Planets on
 * the Tokyo phase, and the phase page showed nothing at all; the places
 * surfaced only in the ratings block, which reads as a rating widget rather
 * than as the plan.
 *
 * `renderDays` now falls back to them, and only when there is nothing else:
 * once a plan or a config schedule exists, that IS the schedule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderContext } from './helpers/dom.js';

const PHASE = {
  id: 'tokyo',
  tabLabel: 'TOKYO',
  title: { he: 'טוקיו', en: 'Tokyo' },
  dates: { start: '2026-09-19', end: '2026-09-23' },
  venues: [
    { id: 'tokyo-skytree', name: { he: 'טוקיו סקייטרי', en: 'Tokyo Skytree' }, maps: 'https://maps.example/skytree', waze: 'https://waze.example/skytree', url: 'https://skytree.example' },
    { id: 'teamlab', name: { he: 'טימלאב פלנטס', en: 'TeamLab Planets' }, maps: 'https://maps.example/teamlab' },
    { id: 'junk', name: { he: 'משהו', en: 'Something' }, maps: 'javascript:alert(1)' },
  ],
};

function render(phase, extra = {}) {
  const { document, ctx } = createRenderContext(
    '<div id="sched-tokyo"></div>',
    { phases: [phase] },
    'en',
    { isOrganizer: false, PHASE_PLAN: {}, PHASE_PLAN_DAYS: {}, ...extra },
  );
  ctx.renderDays(phase);
  return document.getElementById('sched-tokyo');
}

describe('a phase with places and no days', () => {
  test('lists the places instead of rendering nothing', () => {
    const el = render(PHASE);
    const text = el.textContent;
    assert.match(text, /Tokyo Skytree/);
    assert.match(text, /TeamLab Planets/);
    assert.match(text, /Planned places/, 'and says the day-by-day is still open');
  });

  test('carries each place\'s links, and drops one that is not a real URL', () => {
    const el = render(PHASE);
    const hrefs = [...el.querySelectorAll('a')].map(a => a.getAttribute('href'));
    assert.ok(hrefs.includes('https://maps.example/skytree'));
    assert.ok(hrefs.includes('https://waze.example/skytree'));
    assert.ok(hrefs.includes('https://skytree.example'));
    assert.ok(!hrefs.some(href => href?.startsWith('javascript:')), 'a junk link never reaches an href');
  });

  test('says nothing extra once the phase HAS a schedule — that would be a duplicate', () => {
    const withDays = {
      ...PHASE,
      days: [{ label: { he: 'יום 1', en: 'Day 1' }, items: [{ text: { he: 'מגדל', en: 'The tower' } }] }],
    };
    const el = render(withDays);
    assert.match(el.textContent, /The tower/);
    assert.ok(!el.textContent.includes('Planned places'), 'the schedule is the schedule');
  });

  test('a phase with neither renders nothing, rather than an empty heading', () => {
    const el = render({ id: 'tokyo', title: { en: 'Tokyo' } });
    assert.equal(el.innerHTML.trim(), '');
  });
});
