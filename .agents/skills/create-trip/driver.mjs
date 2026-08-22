#!/usr/bin/env node
/**
 * driver.mjs — agent-facing generator + verifier for the create-trip skill.
 *
 * Usage:
 *   node driver.mjs generate <answers.json> [--force]
 *     Reads a structured answers file (see answers.example.json) and writes
 *     trips/<slug>/trip.config.json + trips/<slug>/trivia_questions.json.
 *     Fills every field the real renderers/tests require, applying the same
 *     defaults scripts/new-trip.js uses — with two fixes that script gets
 *     wrong (see SKILL.md Gotchas): stats use `description` not `label`, and
 *     accommodation.name is a bilingual {he,en} object, not a plain string.
 *
 *   node driver.mjs verify <slug>
 *     Boots the real server/server.js against trips/<slug>, hits /api/health
 *     and /api/config over HTTP, then feeds the fetched config into the real
 *     site/app.js render functions (via happy-dom, reusing tests/helpers/dom.js)
 *     and asserts the DOM comes out right. No browser needed. Tears itself down.
 *
 * Both commands exit 0 on success, 1 on failure, with a human-readable report.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { normalizeOrganizers } from '../../../shared/agent-schema.js';

const SELF = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SELF);
const ROOT = path.resolve(__dirname, '..', '..', '..'); // repo root, 3 levels up from .claude/skills/create-trip/

// ── shared helpers ──────────────────────────────────────────────────────────

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function bi(he, en) {
  return { he: he ?? '', en: en ?? he ?? '' };
}

function die(msg) {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

// ── generate ─────────────────────────────────────────────────────────────────

function buildConfig(answers) {
  const errors = [];
  const meta = answers.meta || {};
  if (!meta.title) errors.push('meta.title is required');
  if (!meta.departure) errors.push('meta.departure is required (ISO datetime, e.g. 2027-04-10T08:00:00+03:00)');

  const participants = (answers.participants || []).map(p => ({ ...p }));
  if (participants.length === 0) errors.push('participants[] must have at least one person');
  participants.forEach(p => {
    if (!p.username) errors.push(`participant missing username: ${JSON.stringify(p)}`);
    if (!p.name) errors.push(`participant ${p.username || '?'} missing name`);
    if (!p.name_en) errors.push(`participant ${p.username || '?'} missing name_en`);
    if (typeof p.age !== 'number') errors.push(`participant ${p.username || '?'} missing numeric age`);
    if (!p.family) errors.push(`participant ${p.username || '?'} missing family`);
    if (!p.color) p.color = '#3B82F6';
  });

  const usernames = new Set(participants.map(p => p.username));
  const dupUsernames = participants.map(p => p.username).filter((u, i, a) => a.indexOf(u) !== i);
  if (dupUsernames.length) errors.push(`duplicate usernames: ${[...new Set(dupUsernames)].join(', ')}`);

  const phasesIn = answers.phases || [];
  if (phasesIn.length === 0) errors.push('phases[] must have at least one destination');
  const phaseIds = phasesIn.map(p => p.id);
  const dupPhaseIds = phaseIds.filter((id, i, a) => a.indexOf(id) !== i);
  if (dupPhaseIds.length) errors.push(`duplicate phase ids: ${[...new Set(dupPhaseIds)].join(', ')}`);

  // families: use given, else auto-derive one per distinct participant.family
  let families = answers.families;
  if (!families || !families.length) {
    const ids = [...new Set(participants.map(p => p.family))];
    families = ids.map((id, i) => ({
      id,
      letter: id?.[0]?.toUpperCase() || String.fromCharCode(65 + i),
      name_he: id, name_en: id,
      phases: 'all',
      description_he: '', description_en: '',
    }));
  }
  families.forEach(f => {
    (f.members || participants.filter(p => p.family === f.id).map(p => p.username)).forEach(m => {
      if (!usernames.has(m)) errors.push(`family "${f.id}" references unknown participant "${m}"`);
    });
  });

  phasesIn.forEach(p => {
    if (!p.id) errors.push('phase missing id');
    if (!p.accommodation) errors.push(`phase "${p.id}" missing accommodation`);
  });

  if (errors.length) {
    console.error('\nValidation failed:');
    errors.forEach(e => console.error(`  • ${e}`));
    process.exit(1);
  }

  const slug = slugify(meta.title);
  const brand = meta.brand || slug.toUpperCase().slice(0, 8);
  const defaultLang = meta.defaultLang || 'he';
  const totalDays = meta.returnDate
    ? Math.round((new Date(meta.returnDate) - new Date(String(meta.departure).slice(0, 10))) / 86400000)
    : null;

  families = families.map(f => ({
    id: f.id,
    letter: f.letter || f.id?.[0]?.toUpperCase() || '?',
    name: bi(f.name_he ?? f.name?.he, f.name_en ?? f.name?.en),
    members: f.members || participants.filter(p => p.family === f.id).map(p => p.username),
    phases: f.phases || 'all',
    description: bi(f.description_he ?? f.description?.he, f.description_en ?? f.description?.en),
  }));

  const participantsOut = participants.map(p => ({
    username: p.username, name: p.name, name_en: p.name_en, age: p.age,
    family: p.family, color: p.color,
    familyName: families.find(f => f.id === p.family)?.name || bi(p.family, p.family),
  }));

  const phases = phasesIn.map(p => {
    const acc = p.accommodation || {};
    const hero = p.hero || {};
    const map = p.mapStop || {};
    const titleHe = p.title_he ?? p.title?.he ?? p.tabLabel ?? p.id;
    const titleEn = p.title_en ?? p.title?.en ?? p.tabLabel ?? p.id;
    const display = p.display || (p.start && p.end ? `${p.start} — ${p.end}` : '');
    return {
      id: p.id,
      tabLabel: p.tabLabel || String(titleEn).toUpperCase(),
      title: bi(titleHe, titleEn),
      emoji: p.emoji || '📍',
      dates: { start: p.start || '', end: p.end || '', display },
      hero: {
        photo: hero.photo || '',
        title: p.tabLabel || String(titleEn).toUpperCase(),
        label: bi(hero.label_he ?? `— ${titleHe}`, hero.label_en ?? `— ${titleEn}`),
        sub: bi(hero.sub_he, hero.sub_en),
        blurb: bi(hero.blurb_he, hero.blurb_en),
        meta: display,
        cta: bi('צפה בפרטים', 'View details'),
      },
      // {he,en} object — renderPhaseHotelCard() reads it via _bi(acc.name, lang), which also
      // accepts a plain string (same text both languages). Use the bilingual form so a
      // translated hotel/venue name can differ per language when one is given.
      accommodation: {
        name: bi(acc.name_he ?? acc.name, acc.name_en ?? acc.name),
        address: acc.address || '',
        confirmation: acc.confirmation || null,
        weatherKey: acc.weatherKey || p.id,
      },
      mapStop: {
        lat: map.lat ?? 0, lng: map.lng ?? 0, emoji: p.emoji || '📍',
        name: bi(titleHe, titleEn), dates: `${p.start || ''}–${p.end || ''}`,
        hotel: acc.name_he ?? acc.name ?? '', conf: acc.confirmation || '–',
      },
      participants: p.participants || participantsOut.map(pp => pp.username),
      venues: p.venues || [],
      rsvp_activities: p.rsvp_activities || [],
      packing: p.packing || [],
      days: p.days || [],
    };
  });

  const config = {
    meta: {
      title: meta.title, brand, logo: 'Logo.png', defaultLang,
      departure: meta.departure, returnDate: meta.returnDate || null,
      totalDays: Number.isNaN(totalDays) ? null : totalDays,
      // Trip-wide hero photos (home tab + map tab) — separate from each phase's
      // own hero.photo below. Omitted rather than defaulted to a phase photo:
      // app.js falls back to its own generic default when these are absent,
      // which beats silently reusing one destination's image for the whole trip.
      ...(answers.meta?.homePhoto ? { homePhoto: answers.meta.homePhoto } : {}),
      ...(answers.meta?.mapPhoto ? { mapPhoto: answers.meta.mapPhoto } : {}),
    },
    theme: { palette: meta.palette || 'blue', font: 'heebo', rtlDefault: defaultLang === 'he' },
    stats: [
      { number: String(participants.length), description: bi(`נפשות, ${families.length} משפחות.`, `people, ${families.length} families.`) },
      { number: String(totalDays ?? '?'), description: bi('ימים על הכביש.', 'days on the road.') },
      { number: String(phases.length), description: bi('יעדים.', 'destinations.') },
    ],
    participants: participantsOut,
    families,
    phases,
    map: {
      center: answers.map?.center || [20, 0],
      zoom: answers.map?.zoom || 3,
      stops: phases.filter(p => p.mapStop?.lat).map(p => ({ ...p.mapStop })),
    },
    packing_general: answers.packing_general || [
      [{ he: 'מסמכים', en: 'Documents' }, { he: 'דרכון', en: 'Passport' }],
      [{ he: 'מסמכים', en: 'Documents' }, { he: 'ביטוח נסיעות', en: 'Travel insurance' }],
      [{ he: 'אלקטרוניקה', en: 'Electronics' }, { he: 'מטען + כבלים', en: 'Charger + cables' }],
    ],
    tasks: answers.tasks || [],
    bookings: {
      flights: answers.bookings?.flights || [],
      hotels: answers.bookings?.hotels || [],
      cars: answers.bookings?.cars || [],
      pending_attractions: answers.bookings?.pending_attractions || [],
    },
    budget: {
      scope_note: bi(answers.budget?.scope_note_he, answers.budget?.scope_note_en),
      party_size: answers.budget?.party_size || participants.length,
      phases: phases.map(p => p.id),
      phase_labels: Object.fromEntries(phases.map(p => [p.id, p.title])),
      seed_items: answers.budget?.seed_items || [],
    },
    trivia: {
      total_questions: answers.trivia?.total_questions ?? Math.min(participants.length * 2, 40),
      participants: answers.trivia?.participants || participantsOut.map(p => p.username),
    },
  };

  // travel_info is passed through as-is (not defaulted) — omitted entirely if
  // the interview didn't collect it, same reasoning as alerts below: renderInfo()
  // hides each Info-tab block when its data is empty, so there's nothing to lose
  // by leaving this out rather than writing empty placeholder structures.
  if (answers.travel_info) config.travel_info = answers.travel_info;

  // agent — the per-trip personalization for the bot that escorts the trip.
  // Passed through rather than defaulted: a trip with no escort agent should
  // have no `agent` key at all, not an empty persona the bot might adopt.
  // Validated here rather than only at boot, because a typo'd organizer
  // username means the bot never enters ORGANIZER MODE for anyone — it would
  // silently treat the whole family as a group audience, which is the failure
  // mode the two-mode model exists to prevent.
  if (answers.agent) {
    const a = answers.agent;
    if (!a.name) die('agent.name is required when an agent block is present — the family needs something to call the bot');
    for (const org of normalizeOrganizers(a)) {
      if (!participantsOut.some(p => p.username === org)) {
        die(`agent.organizer(s) "${org}" is not one of the participant usernames (${participantsOut.map(p => p.username).join(', ')})`);
      }
    }
    for (const [i, ins] of (a.standing_instructions || []).entries()) {
      if (!ins.text?.he && !ins.text?.en) die(`agent.standing_instructions[${i}] has no text`);
    }
    config.agent = a;
  }

  // alerts is intentionally omitted unless real content is given — renderAlerts()
  // treats any truthy alerts.booked/pending as "show the bubble", so an empty
  // placeholder object still renders a hollow checkmark chip.
  if (answers.alerts?.booked_he || answers.alerts?.pending_he) {
    config.alerts = {
      booked: bi(answers.alerts?.booked_he, answers.alerts?.booked_en),
      pending: bi(answers.alerts?.pending_he, answers.alerts?.pending_en),
    };
  }

  return { slug, config, trivia_questions: answers.trivia?.questions || [] };
}

function cmdGenerate(argv) {
  const file = argv[0];
  const force = argv.includes('--force');
  if (!file) die('usage: node driver.mjs generate <answers.json> [--force]');
  if (!fs.existsSync(file)) die(`answers file not found: ${file}`);

  let answers;
  try { answers = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { die(`answers file is not valid JSON: ${e.message}`); }

  const { slug, config, trivia_questions } = buildConfig(answers);
  const outDir = path.join(ROOT, 'trips', slug);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !force) {
    die(`trips/${slug}/ already exists and is non-empty. Pass --force to overwrite, or pick a different trip title.`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'trip.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'trivia_questions.json'), JSON.stringify(trivia_questions, null, 2) + '\n', 'utf8');

  console.log(`
✅  Trip scaffolded: trips/${slug}/
    trip.config.json        (${config.participants.length} participants, ${config.families.length} families, ${config.phases.length} phases)
    trivia_questions.json   (${trivia_questions.length} questions)

Next:
  node ${path.relative(ROOT, SELF)} verify ${slug}
`);
  return slug;
}

// ── verify ───────────────────────────────────────────────────────────────────

function bootServer(tripDirAbs, port) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'create-trip-verify-'));
  const serverJs = path.join(ROOT, 'server', 'server.js');
  const proc = spawn('node', [serverJs], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      TRIP_DIR: tripDirAbs,
      DATA_DIR: dataDir,
      PORT: String(port),
      JWT_SECRET: 'create-trip-verify',
      IMMICH_URL: '',
      IMMICH_API_KEY: '',
      HERMES_API_KEY: '',
    },
  });

  const ready = new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error('server did not print ready line within 10s')); } }, 10_000);
    proc.stdout.on('data', chunk => {
      if (!done && chunk.toString().includes('Trip server running on')) { done = true; clearTimeout(to); resolve(); }
    });
    proc.stderr.on('data', chunk => { if (!done) process.stderr.write(`[server] ${chunk}`); });
    proc.on('error', e => { if (!done) { done = true; reject(e); } });
    proc.on('exit', code => { if (!done) { done = true; reject(new Error(`server exited early with code ${code}`)); } });
  });

  return {
    ready,
    baseUrl: `http://localhost:${port}`,
    stop() {
      proc.kill('SIGTERM');
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function targetsHtmlFor(cfg) {
  const hotelDivs = (cfg.phases || []).map(p => `<div id="hotel-${p.id}"></div>`).join('\n');
  const schedDivs = (cfg.phases || []).map(p => `<div id="sched-${p.id}"></div>`).join('\n');
  return `
    <div id="stat-strip"></div>
    <div id="home-alerts"></div>
    <div id="families-section"></div>
    <div id="tasks-table-wrap"></div>
    ${hotelDivs}
    ${schedDivs}
    <div id="photo-uploads"></div>
    <div id="info-block-emrg"><div class="grid2" id="info-countries"></div></div>
    <div id="info-block-health"><ul id="info-health"></ul></div>
    <div id="info-block-hosp"><ul id="info-hospitals"></ul></div>
    <div id="info-block-money"><ul id="info-money"></ul></div>
    <div id="info-block-comm"><ul id="info-communication"></ul></div>
    <div id="info-block-age"><ul id="info-age-notes"></ul></div>
  `;
}

async function cmdVerify(argv) {
  const slug = argv[0];
  if (!slug) die('usage: node driver.mjs verify <slug>');
  const tripDir = path.join(ROOT, 'trips', slug);
  if (!fs.existsSync(path.join(tripDir, 'trip.config.json'))) die(`trips/${slug}/trip.config.json not found`);

  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`); };

  console.log(`\nBooting real server against trips/${slug}/ ...`);
  const server = bootServer(tripDir, 3098);
  let cfg;
  try {
    await server.ready;
    check('server started', true);

    const health = await fetch(`${server.baseUrl}/api/health`).then(r => r.json());
    check('GET /api/health returns ok', health.ok === true);

    cfg = await fetch(`${server.baseUrl}/api/config`).then(r => r.json());
    check('GET /api/config returns meta.title', !!cfg.meta?.title, cfg.meta?.title);
    check('GET /api/config returns participants', (cfg.participants?.length || 0) > 0, `${cfg.participants?.length || 0} participants`);
    check('GET /api/config returns phases', (cfg.phases?.length || 0) > 0, `${cfg.phases?.length || 0} phases`);

    const leakedPins = (cfg.phases || []).some(p => p.accommodation?.pin) || (cfg.participants || []).some(p => p.pin);
    check('accommodation/participant PINs stripped from API response', !leakedPins);
  } finally {
    server.stop();
  }

  console.log(`\nRendering real site/app.js functions against the fetched config (happy-dom, no browser) ...`);
  const { createRenderContext } = await import(path.join(ROOT, 'tests', 'helpers', 'dom.js'));
  const { document, ctx } = createRenderContext(targetsHtmlFor(cfg), cfg, cfg.meta?.defaultLang || 'he');

  ctx.renderStats(cfg);
  check('renderStats() fills #stat-strip', document.getElementById('stat-strip').children.length === (cfg.stats || []).length);

  ctx.renderFamilies(cfg);
  const famCount = document.getElementById('families-section').querySelectorAll('.fam').length;
  check('renderFamilies() renders one .fam per family', famCount === (cfg.families || []).length, `${famCount} rendered`);

  ctx.renderTasks(cfg);
  const taskRows = document.getElementById('tasks-table-wrap').querySelectorAll('tr[data-tid]').length;
  check('renderTasks() renders one row per task', (cfg.tasks || []).length === 0 || taskRows === cfg.tasks.length, `${taskRows} rendered`);

  let hotelsOk = true;
  for (const p of cfg.phases || []) {
    // A phase legitimately has accommodation.name absent when it's a multi-stop
    // phase deferring to a separate hotels[] array instead (accommodation carries
    // just an explanatory `note`, e.g. "5 hotels — see below").
    // renderPhaseHotelCard() intentionally renders those with a blank name — only
    // assert the name shows up when the config actually claims to have one.
    const accName = p.accommodation?.name;
    if (accName == null) continue;
    ctx.renderPhaseHotelCard(p);
    const html = document.getElementById(`hotel-${p.id}`)?.innerHTML || '';
    // accommodation.name may be a plain string (_bi() passes it through unchanged
    // for both languages) or a {he,en} object — both are valid, check both shapes.
    const nameShown = typeof accName === 'string'
      ? html.includes(accName)
      : (accName.he && html.includes(accName.he)) || (accName.en && html.includes(accName.en));
    if (!nameShown) hotelsOk = false;
  }
  check('renderPhaseHotelCard() shows accommodation name for every phase that has one', hotelsOk);

  let daysOk = true;
  for (const p of cfg.phases || []) {
    if (!p.days?.length) continue;
    ctx.renderDays(p);
    const blocks = document.getElementById(`sched-${p.id}`)?.querySelectorAll('.day-block').length || 0;
    if (blocks !== p.days.length) daysOk = false;
  }
  check('renderDays() renders one day-block per phase.days[] entry', daysOk);

  if (cfg.travel_info) {
    ctx.renderInfo(cfg);
    const countryNames = Object.keys(cfg.travel_info.countries || {});
    if (countryNames.length) {
      const html = document.getElementById('info-countries')?.innerHTML || '';
      const allShown = countryNames.every(name => html.includes(name));
      check('renderInfo() shows every travel_info country', allShown);
    }
    const listFields = [
      ['health', 'info-health'], ['hospitals', 'info-hospitals'],
      ['money', 'info-money'], ['communication', 'info-communication'], ['age_notes', 'info-age-notes'],
    ];
    for (const [field, elId] of listFields) {
      const items = cfg.travel_info[field];
      if (!items?.length) continue;
      const count = document.getElementById(elId)?.querySelectorAll('li').length || 0;
      check(`renderInfo() renders every travel_info.${field} item`, count === items.length, `${count}/${items.length}`);
    }
  }

  // meta.homePhoto/mapPhoto drive HERO.home.photo/HERO.mapview.photo in site/app.js,
  // but HERO and applyBrandFromConfig() live outside the RENDER_FUNS_BEGIN/END block
  // createRenderContext() extracts, so they aren't on `ctx` above. Pull them in
  // directly, reusing the same vm context (and its happy-dom `document`) rather
  // than building a second sandbox. Best-effort: only runs if the trip sets either
  // field, and degrades to a skip (not a hard failure) if app.js's shape changes
  // enough that the extraction regexes stop matching.
  if (cfg.meta?.homePhoto || cfg.meta?.mapPhoto) {
    try {
      const appJsSrc = fs.readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');
      const heroSrc = appJsSrc.match(/let HERO = \{[\s\S]*?\n\};/)?.[0];
      const fnSrc = appJsSrc.match(/function applyBrandFromConfig\([\s\S]*?\n\}/)?.[0];
      if (!heroSrc || !fnSrc) throw new Error('could not locate HERO/applyBrandFromConfig in site/app.js (shape changed?)');
      ctx.fetch = () => Promise.resolve({ ok: false }); // logo HEAD check — stubbed, not under test here
      vm.runInContext(`${heroSrc}\n${fnSrc}\nthis.HERO = HERO; this.applyBrandFromConfig = applyBrandFromConfig;`, ctx);
      ctx.applyBrandFromConfig(cfg);
      if (cfg.meta.homePhoto) check('meta.homePhoto applied to HERO.home.photo', ctx.HERO.home.photo === cfg.meta.homePhoto);
      if (cfg.meta.mapPhoto) check('meta.mapPhoto applied to HERO.mapview.photo', ctx.HERO.mapview.photo === cfg.meta.mapPhoto);
    } catch (e) {
      console.log(`  ⚠ skipped homePhoto/mapPhoto check — ${e.message}`);
    }
  }

  const failed = checks.filter(c => !c.ok);
  console.log(failed.length ? `\n❌  ${failed.length}/${checks.length} checks failed.\n` : `\n✅  All ${checks.length} checks passed. trips/${slug}/ renders correctly with real app code.\n`);
  process.exit(failed.length ? 1 : 0);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
if (cmd === 'generate') cmdGenerate(rest);
else if (cmd === 'verify') await cmdVerify(rest);
else die('usage:\n  node driver.mjs generate <answers.json> [--force]\n  node driver.mjs verify <slug>');
