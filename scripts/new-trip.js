#!/usr/bin/env node
/**
 * new-trip.js — interactive CLI to scaffold a new trip config
 *
 * Usage:
 *   node scripts/new-trip.js
 *
 * Output:
 *   trips/<slug>/trip.config.json
 *   trips/<slug>/trivia_questions.json
 */

const readline = require('readline/promises');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function slug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function ask(prompt, defaultVal) {
  const hint = defaultVal !== undefined ? ` [${defaultVal}]` : '';
  const answer = await rl.question(`${prompt}${hint}: `);
  return answer.trim() || defaultVal || '';
}

async function askList(prompt) {
  const raw = await rl.question(`${prompt} (comma-separated): `);
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function collectParticipants() {
  const countStr = await ask('Number of participants');
  const count = parseInt(countStr) || 1;
  const participants = [];
  for (let i = 0; i < count; i++) {
    console.log(`\n  Participant ${i + 1}:`);
    const username = await ask('    Username (no spaces, lowercase)');
    const name = await ask('    Name (primary language)');
    const name_en = await ask('    Name in English', username);
    const age = parseInt(await ask('    Age', '30')) || 30;
    const family = await ask('    Family group ID (e.g. "smith")');
    const color = await ask('    Color (hex)', '#3B82F6');
    participants.push({ username, name, name_en, age, family, color });
  }
  return participants;
}

async function collectFamilies(participants) {
  const familyIds = [...new Set(participants.map(p => p.family))];
  console.log(`\nDetected family groups: ${familyIds.join(', ')}`);
  const families = [];
  for (const id of familyIds) {
    console.log(`\n  Family: ${id}`);
    const name_he = await ask('    Name (primary language)', id);
    const name_en = await ask('    Name in English', id);
    const letter = await ask('    Letter label (A/B/C/D)', id[0].toUpperCase());
    const phases = await ask('    Phases (comma-separated ids, or "all")', 'all');
    const desc_he = await ask('    Description (primary language)', '');
    const desc_en = await ask('    Description in English', desc_he);
    families.push({
      id,
      letter,
      name: { he: name_he, en: name_en },
      members: participants.filter(p => p.family === id).map(p => p.username),
      phases: phases === 'all' ? 'all' : phases.split(',').map(s => s.trim()),
      description: { he: desc_he, en: desc_en },
    });
  }
  return families;
}

async function collectPhase(index) {
  console.log(`\n  Phase ${index + 1}:`);
  const id = await ask('    Phase ID (e.g. "tokyo", "paris")');
  const tabLabel = await ask('    Tab label (ALL CAPS)', id.toUpperCase());
  const title_he = await ask('    Title (primary language)', tabLabel);
  const title_en = await ask('    Title in English', tabLabel);
  const emoji = await ask('    Emoji', '📍');
  const start = await ask('    Start date (YYYY-MM-DD)');
  const end = await ask('    End date (YYYY-MM-DD)');
  const display = await ask('    Date display string', `${start} — ${end}`);

  console.log('    Accommodation:');
  const accName = await ask('      Hotel/place name');
  const accAddress = await ask('      Address');
  const accConf = await ask('      Confirmation code', '–');
  const accWxKey = await ask('      Weather key (short id, e.g. "nyc")', id);

  console.log('    Hero image:');
  const heroPhoto = await ask('      Unsplash URL or image URL');
  const heroLabel_he = await ask('      Hero label (primary language)', `— ${title_he}`);
  const heroLabel_en = await ask('      Hero label in English', `— ${title_en}`);
  const heroSub_he = await ask('      Hero subtitle (primary)', '');
  const heroSub_en = await ask('      Hero subtitle in English', heroSub_he);

  console.log('    Map pin:');
  const lat = parseFloat(await ask('      Latitude')) || 0;
  const lng = parseFloat(await ask('      Longitude')) || 0;

  const participantList = await askList('    Participant usernames for this phase');

  return {
    id,
    tabLabel,
    title: { he: title_he, en: title_en },
    emoji,
    dates: { start, end, display },
    hero: {
      photo: heroPhoto,
      title: tabLabel,
      label: { he: heroLabel_he, en: heroLabel_en },
      sub: { he: heroSub_he, en: heroSub_en },
      blurb: { he: '', en: '' },
      meta: display,
      cta: { he: 'צפה בפרטים', en: 'View details' },
      countdown: false,
    },
    accommodation: {
      name: accName,
      address: accAddress,
      confirmation: accConf !== '–' ? accConf : null,
      weatherKey: accWxKey,
    },
    mapStop: { lat, lng, emoji, name: { he: title_he, en: title_en }, dates: `${start}–${end}`, hotel: accName, conf: accConf },
    participants: participantList,
    venues: [],
    rsvp_activities: [],
    packing: [],
  };
}

async function main() {
  console.log('\n🌍  new-trip.js — Trip Framework Scaffold\n');

  const tripName = await ask('Trip name (e.g. "Japan 2027")');
  const tripSlug = slug(tripName);
  const brand = await ask('Brand/family name (e.g. "SMITH")', tripSlug.toUpperCase().slice(0, 8));
  const defaultLang = await ask('Default language [he/en]', 'he');
  const departure = await ask('Departure datetime (ISO, e.g. 2027-03-15T10:00:00+03:00)');
  const returnDate = await ask('Return date (YYYY-MM-DD)');

  const participants = await collectParticipants();
  const families = await collectFamilies(participants);

  const phaseCountStr = await ask('\nNumber of trip phases/destinations');
  const phaseCount = parseInt(phaseCountStr) || 1;
  const phases = [];
  for (let i = 0; i < phaseCount; i++) {
    phases.push(await collectPhase(i));
  }

  const totalDays = Math.round(
    (new Date(returnDate) - new Date(departure.slice(0, 10))) / 86400000
  );

  const config = {
    meta: {
      title: tripName,
      brand,
      logo: 'Logo.png',
      defaultLang,
      departure,
      returnDate,
      totalDays: isNaN(totalDays) ? null : totalDays,
    },
    theme: { palette: 'blue', font: 'heebo', rtlDefault: defaultLang === 'he' },
    stats: [
      { number: String(participants.length), description: { he: `נפשות, ${families.length} משפחות.`, en: `people, ${families.length} families.` } },
      { number: String(totalDays || '?'), description: { he: 'ימים על הכביש.', en: 'days on the road.' } },
      { number: String(phaseCount), description: { he: 'יעדים.', en: 'destinations.' } },
    ],
    participants: participants.map(p => ({
      ...p,
      familyName: families.find(f => f.id === p.family)?.name || { he: p.family, en: p.family },
    })),
    families,
    alerts: {
      booked: { he: '✅ ', en: '✅ ' },
      pending: { he: '⚠️ ', en: '⚠️ ' },
    },
    phases,
    map: {
      center: [20, 0],
      zoom: 3,
      stops: phases.filter(p => p.mapStop?.lat).map(p => ({ ...p.mapStop })),
    },
    packing_general: [
      [{ he: 'מסמכים', en: 'Documents' }, { he: 'דרכון', en: 'Passport' }],
      [{ he: 'מסמכים', en: 'Documents' }, { he: 'ביטוח נסיעות', en: 'Travel insurance' }],
      [{ he: 'אלקטרוניקה', en: 'Electronics' }, { he: 'מטען + כבלים', en: 'Charger + cables' }],
      [{ he: 'בריאות', en: 'Health' }, { he: 'תרופות קבועות', en: 'Regular medications' }],
    ],
    tasks: [],
    bookings: { flights: [], pending_attractions: [] },
    budget: {
      scope_note: { he: '', en: '' },
      party_size: participants.length,
      phases: phases.map(p => p.id),
      phase_labels: Object.fromEntries(phases.map(p => [p.id, p.title])),
      seed_items: [],
    },
    trivia: {
      total_questions: Math.min(participants.length * 2, 40),
      participants: participants.map(p => p.username),
    },
  };

  // Write output
  const outDir = path.join(__dirname, '..', 'trips', tripSlug);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, 'trip.config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );

  fs.writeFileSync(
    path.join(outDir, 'trivia_questions.json'),
    JSON.stringify([], null, 2),
    'utf8'
  );

  rl.close();

  console.log(`
✅  Trip scaffolded at: trips/${tripSlug}/

Next steps:
  1. Fill in trips/${tripSlug}/trip.config.json:
     - Add day-by-day itinerary: phases[].days[]
     - Add venues/POIs: phases[].venues[]
     - Add budget items: budget.seed_items[]
     - Add tasks: tasks[]
  2. Add trivia questions to trips/${tripSlug}/trivia_questions.json
  3. Add participant avatars to trips/${tripSlug}/avatars/<username>.png
  4. Copy Logo.png to trips/${tripSlug}/Logo.png
  5. Run the server directly:
     TRIP_DIR=./trips/${tripSlug} node server/server.js
  6. Or with Docker (run from the framework root):
     TRIP_DIR_HOST=./trips/${tripSlug} docker compose up -d
`);
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });
