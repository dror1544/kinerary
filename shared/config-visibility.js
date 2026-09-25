// What GET /api/config and GET /api/config/versions/:version may serve out of
// trip.config.json — as an ALLOW-list (issue #172). Imported by server.js
// (CommonJS require) and the test suite (ESM import), same arrangement as
// needs-schema.js and agent-schema.js.
//
// Both routes are authRequired, which admits every family member — kids and
// one-off guests included — and the agent key. So being signed in is not a
// reason to see a field; being on this list is. A field nobody named here is
// not served, whoever wrote it and whatever it looks like. The old sanitizer
// did the reverse (copy everything, delete PINs and a few more), and every
// field added after it was written went straight to every phone.
//
// HOW THIS LIST WAS BUILT, so the next person can check it rather than trust
// it (2026-09-25): the union of
//   * every field a producer writes — transform_intake() + enrich_config() over
//     the worker's whole unittest suite, and tests/helpers/provisioned-config.py;
//   * every field in a config that exists — trips/japan-2025, tests/fixtures,
//     and the hand-authored and provisioned configs the deployment keeps;
//   * every field a reader reads — site/app.js, site/trivia.html, trip-web's
//     configSchema/parity-schema.ts (zod strips anything else), mcp/mcp.js.
// That union is the status quo: every field below was already served before
// this file existed. The list narrows nothing that was known; it stops the
// unknown. Deliberately withheld fields are marked `withheld` so the report
// can tell "kept back on purpose" from "nobody put it on the list".
//
// ADDING A FIELD: a producer that starts writing a new key fails
// tests/config-allow-list.test.js ("provisioner fields missing from the
// allow-list") and logs `config: ... not on the served allow-list` at boot.
// Add it here only after deciding a signed-in child should be able to read
// it; an organizer-only field belongs in GET /api/agent/brief instead.

const allow = require('./allow-list');
const { normalizeSeverity, normalizeVisibility } = require('./needs-schema');
const { projectAgent } = require('./agent-schema');

const { scalar, text, withheld, oneOf, object, list, map, byType, custom, OMIT } = allow;

// ── participants[].needs: visibility-filtered, severity-normalized ──────────
// Unchanged rule, now expressed on the allow-list: a need that resolves to
// organizer-only is WITHHELD; a served one carries only these four keys.
const NEED = object({ type: scalar, severity: scalar, visibility: scalar, text });
const needs = custom((value, report, path) => {
  if (!Array.isArray(value)) { report.dropped.push(path); return OMIT; }
  const out = [];
  value.forEach((raw, i) => {
    const at = `${path}[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { report.dropped.push(at); return; }
    // Every property read ONCE, and the decision and the served value both
    // come from that one read. Reading `visibility` to filter and again to
    // serve lets anything that answers differently twice (a getter; not
    // reachable from JSON.parse, but free to close) be decided "group" and
    // served as something else.
    const n = allow.snapshot(raw);
    if (normalizeVisibility(n.visibility, n.type) === 'organizer') { report.withheld.push(at); return; }
    const v = allow.project(n, NEED, report, at);
    if (v === OMIT) return;
    // Fail safe, not fail quiet: a typo'd severity reads as the most severe.
    v.severity = normalizeSeverity(n.severity);
    out.push(v);
  });
  // An empty array is itself a disclosure: a participant with no `needs` key
  // looks different from one whose needs were all filtered out, which tells a
  // reader exactly who has something hidden.
  return out.length ? out : OMIT;
});

const agent = custom((value, report, path) => {
  const v = projectAgent(value, report, path);
  if (v === undefined) { report.dropped.push(path); return OMIT; }
  return v;
});

// ── shared shapes ────────────────────────────────────────────────────────────
// A map pin. `map.stops[]` and `phases[].mapStop` are the same object; the
// classic site's popup reads name/dates/hotel/conf/emoji, weather reads
// weatherKey + lat/lng.
const MAP_STOP = object({
  lat: scalar, lng: scalar, name: text, emoji: scalar,
  dates: scalar, hotel: scalar, conf: scalar, weatherKey: scalar,
});

// renderPhaseHotelCard() (site/app.js) and accommodationAnchors(): the hotel
// card the family opens on arrival. `pin` is withheld as it always was — a
// door code is not trip UI data.
// `hotel`, `title` and `url` are the name/link fallbacks the itinerary import
// reads (dayContextForPhase in server/living-journey.js).
const ACCOMMODATION_FIELDS = {
  name: text, name_en: scalar, type: scalar, address: scalar, phone: scalar,
  confirmation: scalar, pin: withheld, cost: scalar, guests: scalar, rooms: scalar,
  dates: text, notes: list(object({ style: scalar, text })), description: text, note: text,
  mapsUrl: scalar, maps: scalar, waze: scalar, location_url: scalar,
  weatherKey: scalar, pdf: scalar, hotel: text, title: text, url: scalar,
};
// Legacy multi-hotel phases: the classic weather panel also reads lat/lng and
// a bilingual `location`; the itinerary import picks the night's hotel by its
// date range under any of three spellings.
const HOTEL = object({
  ...ACCOMMODATION_FIELDS, lat: scalar, lng: scalar, location: text,
  date_from: scalar, date_to: scalar, check_in: scalar, check_out: scalar, from: scalar, to: scalar,
});

// An Info-tab line: bilingual prose, plus the provenance enrichment stamps on
// it. `origin` is a closed set at the producer (_INFO_ORIGINS in
// enrichment.py, after #156 put `hermes:<profile>` on the wire) and closed here
// too; a value outside it is dropped, and reported.
const INFO_LINE = byType({
  scalar,
  object: object({
    he: scalar, en: scalar,
    source: oneOf(['api', 'model']),
    origin: oneOf(['countries.dev', 'emergency-numbers', 'model', 'api']),
  }),
});

const PACKING = list(list(text));

// A day of the original plan. The item's `type`, `confirmation_state`,
// `duration_minutes` and `tickets` are read by the itinerary import
// (rowsFromConfig in server/living-journey.js), which projects each item
// through this node before it reads a value.
const DAY_ITEM = object({
  time: scalar, text, maps: scalar, waze: scalar, url: scalar, tickets: scalar,
  type: scalar, confirmation_state: scalar, duration_minutes: scalar,
});
const DAY = object({ date: scalar, label: text, items: list(DAY_ITEM) });

// No `pickup`: phases[].pickup has no producer, no renderer and no known
// shape. The itinerary import used to copy it WHOLE into every day it built;
// with no shape to allow, the allow-list's answer is not to serve it.
const PHASE = object({
  id: scalar, short_id: scalar, tabLabel: scalar, emoji: scalar, title: text,
  start: scalar, end: scalar, unplanned: scalar, note: text,
  participants: list(scalar),
  dates: object({ start: scalar, end: scalar, display: scalar }),
  hero: object({
    photo: scalar, title: scalar, label: text, sub: text, blurb: text, cta: text,
    meta: scalar, badge: text, countdown: scalar,
    photoCredit: object({ title: scalar, source: scalar, license: scalar }),
  }),
  accommodation: object(ACCOMMODATION_FIELDS),
  hotels: list(HOTEL),
  mapStop: MAP_STOP,
  mapStops: list(MAP_STOP),
  venues: list(object({
    id: scalar, item_uid: scalar, name: text, name_he: scalar, area: scalar,
    url: scalar, url_source: scalar, maps: scalar, waze: scalar, tickets: scalar,
  })),
  rsvp_activities: list(object({
    id: scalar, item_uid: scalar, title: text, name: text, desc: text,
    price: text, date: scalar, url: scalar,
  })),
  packing: PACKING,
  days: list(DAY),
});

// Hand-authored configs' booking summary. No renderer reads it today (the
// Bookings tab reads /api/bookings); it is on the list because it was already
// served and the companion reads get_config whole. See the handover for #172.
const BOOKINGS = object({
  flights: list(object({
    flight: scalar, route: scalar, date: scalar, passengers: text,
    conf: scalar, confirmation: scalar, cost: scalar, notes: scalar,
  })),
  hotels: list(object({
    name: text, dates: text, phase: scalar, confirmation: scalar, pin: withheld,
    cost: scalar, cancelled: scalar, notes: scalar,
  })),
  cars: list(object({
    name: scalar, dates: text, phase: scalar, supplier: scalar, vehicle: scalar,
    pickup: scalar, return: scalar, confirmation: scalar, cost: scalar, notes: scalar,
  })),
  pending_attractions: list(object({ name: scalar, date: scalar, url: scalar, notes: scalar })),
});

const TRIP_CONFIG_PUBLIC = object({
  meta: object({
    title: scalar, title_en: scalar, brand: scalar, logo: scalar, logoAlt: scalar,
    admin: scalar, destination: scalar, defaultLang: scalar,
    departure: scalar, returnDate: scalar, totalDays: scalar,
    homeCurrency: scalar, home_country: scalar, homePhoto: scalar, mapPhoto: scalar,
    photoCredits: list(object({ phase: scalar, title: scalar, source: scalar, license: scalar })),
  }),
  theme: object({ palette: scalar, font: scalar, rtlDefault: scalar }),
  stats: list(object({ number: scalar, description: text })),
  alerts: object({ booked: text, pending: text }),
  participants: list(object({
    username: scalar, name: scalar, name_en: scalar, age: scalar,
    family: scalar, familyName: text, color: scalar,
    needs,
    // Server-side authentication material, never trip UI data.
    telegram_id: withheld,
    pin: withheld,
  })),
  families: list(object({
    id: scalar, letter: scalar, name: text, description: text, note: text,
    members: list(scalar),
    // "all", or a list of phase ids.
    phases: byType({ scalar, list: list(scalar) }),
  })),
  phases: list(PHASE),
  map: object({ center: list(scalar), zoom: scalar, stops: list(MAP_STOP) }),
  tasks: list(object({ id: scalar, text, owner: text, deadline: scalar })),
  packing_general: PACKING,
  bookings: BOOKINGS,
  budget: object({
    party_size: scalar, currency: scalar,
    phases: list(scalar),
    phase_labels: map(text),
    scope_note: text,
    seed_items: list(object({
      phase: scalar, category: scalar, description: scalar,
      amount: scalar, is_estimate: scalar, seed_key: scalar,
    })),
  }),
  trivia: object({ participants: list(scalar), total_questions: scalar }),
  travel_info: object({
    countries: map(object({
      capital: scalar, flag: scalar, callingCode: scalar,
      currency: object({ code: scalar, name: scalar, symbol: scalar }),
      emergency: object({ general: scalar, police: scalar, ambulance: scalar, fire: scalar, unified112: scalar }),
    })),
    emergency_contacts: list(object({ name: text, phone: scalar })),
    health: list(INFO_LINE),
    money: list(INFO_LINE),
    communication: list(INFO_LINE),
    hospitals: list(object({ area: text, name: scalar })),
    age_notes: list(object({ who: text, note: text })),
  }),
  agent,
});

// The projection and its report: { value, dropped: [path], withheld: [path] }.
function projectConfig(cfg) {
  const report = allow.newReport();
  const value = allow.project(cfg && typeof cfg === 'object' ? cfg : {}, TRIP_CONFIG_PUBLIC, report, '');
  return { value: value === OMIT ? {} : value, dropped: report.dropped, withheld: report.withheld };
}

// What a signed-in reader is served.
function publicConfig(cfg) {
  return projectConfig(cfg).value;
}

// One piece of the config, projected through the same node /api/config uses —
// for server code that builds a member-visible value out of part of the config
// (the itinerary import) and must not read anything /api/config would not
// serve. Returns undefined when nothing of it may be served.
const NODES = Object.freeze({ phase: PHASE, day: DAY, dayItem: DAY_ITEM });
function publicPart(kind, value) {
  const node = NODES[kind];
  if (!node) throw new Error(`config-visibility: unknown part "${kind}"`);
  const v = allow.project(value, node, allow.newReport(), kind);
  return v === OMIT ? undefined : v;
}

module.exports = { TRIP_CONFIG_PUBLIC, projectConfig, publicConfig, publicPart };
