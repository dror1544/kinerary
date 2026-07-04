#!/usr/bin/env node
/**
 * obsidian-to-config.js — parse numbered Obsidian trip docs into trip.config.json skeleton
 *
 * Usage:
 *   node scripts/obsidian-to-config.js <obsidian-dir> [output-dir]
 *
 * Expected Obsidian file naming convention:
 *   00_*.md  — master / overview (provides trip title, dates)
 *   01_*.md  — participants overview (family groups, member lists)
 *   02_*.md … 05_*.md — per-destination itineraries
 *   06_*.md  — bookings / confirmations table
 *   07_*.md  — useful info / packing
 *   08_*.md  — tasks
 *
 * Produces:
 *   <output-dir>/trip.config.json  (skeleton, requires manual review)
 */

const fs   = require('fs');
const path = require('path');

const obsidianDir = process.argv[2];
const outputDir   = process.argv[3] || '.';

if (!obsidianDir) {
  console.error('Usage: node scripts/obsidian-to-config.js <obsidian-dir> [output-dir]');
  process.exit(1);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function readMd(dir, prefix) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.md'));
  if (!files.length) return '';
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
}

function readAllMd(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// Parse markdown table rows → array of objects keyed by header
function parseMdTable(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  if (lines.length < 2) return [];
  const headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(2)) { // skip separator row
    const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length === 0) continue;
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    rows.push(row);
  }
  return rows;
}

// Extract value from line like "**Key:** value" or "- Key: value"
function extractField(text, key) {
  const re = new RegExp(`(?:\\*\\*${key}[:\\*]+\\*?\\*?|[-•]\\s*${key}:)\\s*(.+)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// Extract all "- [ ] text — owner — deadline" task lines
function parseTasks(text) {
  const tasks = [];
  const re = /[-*]\s*\[[ x]\]\s*(.+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const parts = raw.split('—').map(s => s.trim());
    tasks.push({
      id: parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      text: { he: parts[0], en: parts[0] },
      owner: { he: parts[1] || '', en: parts[1] || '' },
      deadline: parts[2] || 'ongoing',
    });
  }
  return tasks;
}

// Extract dates like "15/7" → "<year>-07-15" (naive, assumes current year context —
// defaults to whatever year it's actually run in, not a fixed year that goes stale)
function parseDate(str, yearHint = String(new Date().getFullYear())) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return str;
  return `${yearHint}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

// Extract confirmation codes that look like "1234.567.890" or "ABCDEF"
function extractConfirmations(text) {
  const codes = [];
  const numRe  = /\b(\d{4}\.\d{3}\.\d{3})\b/g;
  const alphaRe = /\b([A-Z]{5,8})\b/g;
  let m;
  while ((m = numRe.exec(text))  !== null) codes.push(m[1]);
  while ((m = alphaRe.exec(text)) !== null) codes.push(m[1]);
  return [...new Set(codes)];
}

// ── PARSE FILES ───────────────────────────────────────────────────────────────

const allFiles = readAllMd(obsidianDir);
const byPrefix = {};
allFiles.forEach(({ file, content }) => {
  const prefix = file.slice(0, 2);
  byPrefix[prefix] = byPrefix[prefix] || [];
  byPrefix[prefix].push({ file, content });
});

function get(prefix) { return (byPrefix[prefix] || []).map(f => f.content).join('\n'); }

const master      = get('00');
const overview    = get('01');
const bookingsMd  = get('06');
const usefulInfo  = get('07');
const tasksMd     = get('08');
const destFiles   = allFiles.filter(f => /^0[2-5]/.test(f.file));

// ── META ──────────────────────────────────────────────────────────────────────

const titleMatch = (master + overview).match(/^#\s+(.+)/m);
const tripTitle  = titleMatch ? titleMatch[1].replace(/[#*]/g, '').trim() : 'My Trip';

// Try to extract departure from master doc
const depMatch = (master + overview).match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
const rawDep   = depMatch ? depMatch[1] : null;

// ── PARTICIPANTS ──────────────────────────────────────────────────────────────

const participants = [];
const families     = [];

// Look for markdown tables with name/age columns in 01 file
const participantTables = parseMdTable(overview);
const FAMILY_COLORS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#06B6D4'];
let colorIdx = 0;
const familyColorMap = {};

if (participantTables.length) {
  participantTables.forEach(row => {
    // Accept rows that have at least a name-like field
    const name = row['שם'] || row['Name'] || row['name'] || Object.values(row)[0] || '';
    const age  = parseInt(row['גיל'] || row['Age'] || row['age'] || '') || null;
    const fam  = row['משפחה'] || row['Family'] || row['family'] || 'group1';
    if (!name || name.includes('---')) return;
    if (!familyColorMap[fam]) {
      familyColorMap[fam] = FAMILY_COLORS[colorIdx++ % FAMILY_COLORS.length];
    }
    const username = name.toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '').slice(0, 10);
    participants.push({
      username,
      name,
      name_en: name,
      age,
      family: fam.toLowerCase().replace(/\s+/g, '_'),
      familyName: { he: fam, en: fam },
      color: familyColorMap[fam],
    });
  });
}

// Build families from participant data
const familyIds = [...new Set(participants.map(p => p.family))];
familyIds.forEach((id, i) => {
  const members = participants.filter(p => p.family === id);
  const rawName = Object.keys(familyColorMap).find(k => k.toLowerCase().replace(/\s+/g, '_') === id) || id;
  families.push({
    id,
    letter: String.fromCharCode(65 + i),
    name: { he: rawName, en: rawName },
    members: members.map(p => p.username),
    phases: 'all',
    description: { he: `${members.length} נפשות`, en: `${members.length} people` },
  });
});

// ── PHASES (per destination file) ────────────────────────────────────────────

const phases = destFiles.map(({ file, content }) => {
  // Extract title from first H1 or H2
  const titleM = content.match(/^#{1,2}\s+(.+)/m);
  const rawTitle = titleM ? titleM[1].replace(/[#*🗽🏔️⭐🌉]/g, '').trim() : file.replace(/^\d+_/, '').replace('.md', '');

  // Extract date range
  const dateM = content.match(/(\d{1,2}[\/\-]\d{1,2})\s*[–—-]\s*(\d{1,2}[\/\-]\d{1,2})/);
  const startRaw = dateM ? dateM[1] : null;
  const endRaw   = dateM ? dateM[2] : null;

  // Extract hotel/accommodation from bold fields or tables
  const hotelM = content.match(/(?:מלון|hotel|Hotel|accommodation)[:\s*]+([^\n|]+)/i);
  const accName = hotelM ? hotelM[1].replace(/\*+/g, '').trim() : '';

  // Extract confirmation codes
  const confs = extractConfirmations(content);
  const conf  = confs[0] || null;

  // Extract address-like lines
  const addressM = content.match(/\d+\s+[A-Za-z][\w\s]+(?:St|Ave|Blvd|Hwy|Road|Dr|Lane)[^\n]*/);

  // Build phase ID from title
  const id = rawTitle.toLowerCase()
    .replace(/[^\w\s]/g, '').replace(/\s+/g, '_').slice(0, 20);

  // Extract packing list items
  const packItems = [];
  const packRe = /[-•*]\s+([^\n]+(?:pack|bring|wear|item|כובע|נעל|בגד|תרופ|מטען|מטרייה)[^\n]*)/ig;
  let pm;
  while ((pm = packRe.exec(content)) !== null) {
    packItems.push([
      { he: 'כללי', en: 'General' },
      { he: pm[1].trim(), en: pm[1].trim() },
    ]);
  }

  // Extract venues from "TripAdvisor" links or bold attraction names
  const venueRe = /\*\*([^*]+(?:Park|Museum|Bridge|Castle|Beach|Falls|Center|Square|Theatre|Market|Observatory)[^*]*)\*\*/gi;
  const venues = [];
  let vm;
  while ((vm = venueRe.exec(content)) !== null) {
    const vname = vm[1].trim();
    venues.push({
      id: `${id}-${vname.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`,
      name: vname,
      url: '',
    });
  }

  return {
    id,
    tabLabel: rawTitle.toUpperCase().slice(0, 20),
    title: { he: rawTitle, en: rawTitle },
    emoji: '📍',
    dates: {
      start: parseDate(startRaw) || '',
      end:   parseDate(endRaw)   || '',
      display: startRaw && endRaw ? `${startRaw} — ${endRaw}` : '',
    },
    hero: {
      photo: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=2400&q=80',
      title: rawTitle.toUpperCase(),
      label: { he: `— ${rawTitle}`, en: `— ${rawTitle}` },
      sub:   { he: '', en: '' },
      blurb: { he: '', en: '' },
      meta:  startRaw && endRaw ? `${startRaw} — ${endRaw}` : '',
      cta:   { he: 'צפה בפרטים', en: 'View details' },
      countdown: false,
    },
    accommodation: {
      name: accName,
      address: addressM ? addressM[0].trim() : '',
      confirmation: conf,
      weatherKey: id.slice(0, 10),
    },
    mapStop: { lat: 0, lng: 0, emoji: '📍', name: { he: rawTitle, en: rawTitle }, dates: startRaw || '', hotel: accName, conf: conf || '–' },
    participants: participants.map(p => p.username),
    venues: venues.slice(0, 6),
    rsvp_activities: [],
    packing: packItems.slice(0, 10),
    _source_file: file,
  };
});

// ── TASKS ─────────────────────────────────────────────────────────────────────

const tasks = parseTasks(tasksMd + '\n' + master);

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

const flightRows  = parseMdTable(bookingsMd).filter(r => {
  const vals = Object.values(r).join(' ').toLowerCase();
  return vals.includes('flight') || vals.includes('טיסה') || vals.includes('el al') || vals.includes('united') || vals.includes('american');
});

const flights = flightRows.map(r => ({
  flight: Object.values(r)[0] || '',
  date:   Object.values(r)[1] || '',
  passengers: { he: Object.values(r)[2] || '', en: Object.values(r)[2] || '' },
  confirmation: extractConfirmations(Object.values(r).join(' '))[0] || null,
  cost: null,
  pdf: null,
}));

// ── PACKING GENERAL ───────────────────────────────────────────────────────────

const generalPackRe = /[-•*]\s+([^\n]+)/g;
const packingGeneral = [];
let gm;
const usefulText = usefulInfo;
while ((gm = generalPackRe.exec(usefulText)) !== null && packingGeneral.length < 20) {
  const item = gm[1].trim();
  if (item.length > 3 && item.length < 80 && !item.startsWith('#')) {
    packingGeneral.push([{ he: 'כללי', en: 'General' }, { he: item, en: item }]);
  }
}

// ── ASSEMBLE CONFIG ───────────────────────────────────────────────────────────

const config = {
  _note: 'Auto-generated by obsidian-to-config.js — review and fill in missing fields before use',
  meta: {
    title: tripTitle,
    brand: tripTitle.split(/\s+/).pop().toUpperCase().slice(0, 8),
    logo: 'Logo.png',
    defaultLang: 'he',
    departure: rawDep ? `${parseDate(rawDep)}T06:00:00+03:00` : 'FILL_IN',
    returnDate: 'FILL_IN',
    totalDays: null,
  },
  theme: { palette: 'blue', font: 'heebo', rtlDefault: true },
  stats: [
    { number: String(participants.length || 'N'), label: { he: `נפשות, ${families.length} משפחות.`, en: `people, ${families.length} families.` } },
    { number: '?', label: { he: 'ימים על הכביש.', en: 'days on the road.' } },
    { number: String(phases.length), label: { he: 'יעדים.', en: 'destinations.' } },
  ],
  participants: participants.length ? participants : [{ username: 'FILL_IN', name: 'FILL_IN', name_en: 'FILL_IN', age: 0, family: 'group1', color: '#3B82F6' }],
  families: families.length ? families : [],
  alerts: {
    booked: { he: '✅ FILL_IN', en: '✅ FILL_IN' },
    pending: { he: '⚠️ FILL_IN', en: '⚠️ FILL_IN' },
  },
  phases,
  map: {
    center: [20, 0],
    zoom: 3,
    stops: phases.filter(p => p.mapStop?.lat !== 0).map(p => p.mapStop),
  },
  packing_general: packingGeneral.length ? packingGeneral : [
    [{ he: 'מסמכים', en: 'Documents' }, { he: 'דרכון', en: 'Passport' }],
  ],
  tasks,
  bookings: { flights, pending_attractions: [] },
  budget: {
    scope_note: { he: 'FILL_IN', en: 'FILL_IN' },
    party_size: participants.length,
    phases: phases.map(p => p.id),
    phase_labels: Object.fromEntries(phases.map(p => [p.id, p.title])),
    seed_items: [],
  },
  trivia: {
    total_questions: Math.min(Math.max(participants.length * 2, 10), 40),
    participants: participants.map(p => p.username),
  },
};

// Write output
fs.mkdirSync(outputDir, { recursive: true });
const outFile = path.join(outputDir, 'trip.config.json');
fs.writeFileSync(outFile, JSON.stringify(config, null, 2), 'utf8');

console.log(`
✅  Parsed ${allFiles.length} Obsidian files
    → ${outFile}

Summary:
  Participants found : ${participants.length}
  Families found     : ${families.length}
  Phases found       : ${phases.length} (${phases.map(p => p.id).join(', ')})
  Tasks found        : ${tasks.length}
  Flights found      : ${flights.length}

⚠️  Manual review required:
  - Set meta.departure, meta.returnDate, meta.totalDays
  - Set map.stops lat/lng for each phase
  - Set phases[].hero.photo (Unsplash URLs)
  - Verify participant names and family assignments
  - Add budget.seed_items[]
  - Add phases[].rsvp_activities[] for optional bookings
  - Add trivia questions to trivia_questions.json
`);
