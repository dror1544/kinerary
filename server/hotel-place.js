'use strict';
// A hotel is ONE place, wherever the site shows it.
//
// The same stay used to live in four shapes that never met: the booking (name,
// dates, confirmation, a location_url nobody had to fill in), the stop's
// accommodation (a COPY of the name made when the booking was linked), the
// check-in and check-out plan items (a copy of the booking's link, null when
// the booking had none), and the day's "Tonight" line (read off the stop). A
// hotel the companion added without a map link therefore had a Google Maps
// link on one screen, a search for the check-in's own wording on another, and
// no Waze link anywhere (live finding, 2026-10-15).
//
// This module is the single answer to "where is this hotel, and how do I get
// there?". Every route that serves a hotel — /api/config, /api/bookings, the
// active itinerary, /api/today, Classic's plan — resolves it HERE, at serve
// time, so the screens cannot disagree.
//
// PRECEDENCE, per field: what an organizer typed on the stop > what the booking
// carries > a search link derived from the name. The derived link is never
// stored: a stored copy is how the four shapes drifted apart.
//
// NO INVENTED COORDINATES. With only a name, the link is a Google Maps / Waze
// SEARCH for "<name>, <address or the stop's town>". Coordinates exist only
// when a link somebody supplied carries them (…/@lat,lng… or ?ll=lat,lng), and
// then Waze is pointed at them. Nothing here calls an external service.

const MAPS_SEARCH = 'https://www.google.com/maps/search/?api=1&query=';
const WAZE = 'https://waze.com/ul';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A link worth putting in an href: http(s) only. A stored `javascript:` or
// `data:` link is dropped here, so no route serves one back.
function httpUrl(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : null;
}

// A bilingual config text ({he, en}) or a plain string, as one string.
function textOf(value, prefer = 'en') {
  if (typeof value === 'string') return value.trim();
  if (isObj(value)) {
    const order = prefer === 'en' ? ['en', 'he'] : ['he', 'en'];
    for (const key of order) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

function validCoordinates(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Same rule as trip-web's coordinatesFromLocationUrl: /@lat,lng in the path, or
// ll= / q= / query= holding exactly "lat,lng". Returns the TEXT of the pair as
// written (so the Waze link repeats the source's digits, not a re-rounded
// float), or null.
function coordinatesFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const num = '(-?\\d+(?:\\.\\d+)?)';
    const fromPath = u.pathname.match(new RegExp(`@${num},${num}`));
    const param = (u.searchParams.get('ll') || u.searchParams.get('q') || u.searchParams.get('query') || '')
      .match(new RegExp(`^\\s*${num}\\s*,\\s*${num}\\s*$`));
    const pair = fromPath?.slice(1) || param?.slice(1);
    if (!pair) return null;
    const [lat, lng] = pair;
    return validCoordinates(Number(lat), Number(lng)) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

// The stop keeps its booking link when an organizer later PATCHes a different
// hotel into it. The booking's link and name then belong to the OLD hotel, so
// the booking speaks for the stop only while the stop's hotel still carries the
// booking's name (in either language), or carries no name at all.
function sameHotel(accommodation, booking) {
  const acc = isObj(accommodation) ? accommodation : {};
  const names = [acc.name_en, textOf(acc.name, 'en'), textOf(acc.name, 'he')]
    .filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().toLowerCase());
  const bookingName = typeof booking?.name === 'string' ? booking.name.trim().toLowerCase() : '';
  return !names.length || names.includes(bookingName);
}

// The one resolver. `booking` is the hotel booking row (or null), `accommodation`
// the stop's accommodation (or null — a booking filed under a stop but not
// linked to it), `phase` the stop, for its town. Null when there is nothing to
// find a place by: no name and no address.
function resolveHotelPlace({ booking = null, accommodation = null, phase = null } = {}) {
  const acc = isObj(accommodation) ? accommodation : {};
  const bk = isObj(booking) && sameHotel(acc, booking) ? booking : {};
  const name = textOf(acc.name_en) || textOf(acc.name) || textOf(bk.name);
  const address = typeof acc.address === 'string' ? acc.address.trim() : '';
  const town = textOf(phase?.mapStop?.name) || textOf(phase?.title);
  const where = address || town;
  // A town alone is not a hotel: without a name or an address, nothing to find.
  if (!name && !address) return null;
  const query = [name, where].filter(Boolean).join(', ');

  const explicitMaps = httpUrl(acc.location_url) || httpUrl(acc.mapsUrl) || httpUrl(acc.maps) || httpUrl(bk.location_url);
  const maps_url = explicitMaps || `${MAPS_SEARCH}${encodeURIComponent(query)}`;
  const coordinates = coordinatesFromUrl(maps_url);
  const explicitWaze = httpUrl(acc.waze);
  const waze_url = explicitWaze
    || (coordinates ? `${WAZE}?ll=${encodeURIComponent(`${coordinates.lat},${coordinates.lng}`)}&navigate=yes` : `${WAZE}?q=${encodeURIComponent(query)}&navigate=yes`);
  return {
    // The name as the stop stores it (it may be bilingual), else the booking's.
    name: acc.name ?? acc.name_en ?? bk.name ?? null,
    query, maps_url, waze_url, coordinates,
    // True when the link was built from the name, not supplied by anyone.
    derived: { maps: !explicitMaps, waze: !explicitWaze },
  };
}

// The hotel resolver bound to one trip: it knows the effective config, which
// stop a booking was linked to, and how to read a booking.
//   getConfig()       → the effective (raw-shaped) config
//   sources()         → Map<phaseId, { booking_id }> — the stops whose
//                       accommodation the stop layer wrote or linked to a booking
//   bookingById(id)   → an APPROVED booking row, or null (a draft is not served)
function createHotelPlaces({ getConfig, sources, bookingById }) {
  const phases = () => (getConfig()?.phases || []);
  const phaseById = (id) => phases().find((p) => p?.id === id) || null;

  // The stop this booking is linked to, if any.
  function linkedStop(bookingId) {
    for (const [phaseId, source] of sources()) {
      if (source.booking_id != null && Number(source.booking_id) === Number(bookingId)) return phaseById(phaseId);
    }
    return null;
  }

  // A booking's place. `phaseId` is the stop the caller found it under (an
  // item's phase) when the booking is not linked to one.
  function forBooking(booking, phaseId = null) {
    if (!isObj(booking) || booking.type !== 'hotel') return null;
    const linked = linkedStop(booking.id);
    const phase = linked || phaseById(booking.phase) || (phaseId ? phaseById(phaseId) : null);
    // A stop whose hotel was replaced after the link no longer speaks for it.
    const accommodation = linked && sameHotel(linked.accommodation, booking) ? linked.accommodation : null;
    return resolveHotelPlace({ booking, accommodation, phase });
  }

  // The config with the hotel of every stop the stop layer touched resolved.
  // Anything else (a hotel the file itself carries) is served as the file has
  // it. Returns the same object when nothing changes.
  function hydrateConfig(config) {
    const src = sources();
    if (!src.size || !Array.isArray(config?.phases)) return config;
    let changed = false;
    const list = config.phases.map((phase) => {
      const source = src.get(phase?.id);
      if (!source || !isObj(phase.accommodation)) return phase;
      const booking = source.booking_id != null ? bookingById(source.booking_id) : null;
      const place = resolveHotelPlace({ booking, accommodation: phase.accommodation, phase });
      if (!place) return phase;
      changed = true;
      const acc = { ...phase.accommodation, location_url: place.maps_url, waze: place.waze_url };
      if (!textOf(acc.name) && !textOf(acc.name_en) && booking?.name) acc.name = booking.name;
      return { ...phase, accommodation: acc };
    });
    return changed ? { ...config, phases: list } : config;
  }

  // A plan item that belongs to a hotel booking, with the hotel's links filled
  // where the item has none. `booking` is the approved booking row the item is
  // attached to (or null). An item that carries a location of its own keeps it,
  // and gets no Waze link from the hotel: that link would point somewhere else.
  function decorateItem(item, booking) {
    if (!item || !booking || booking.type !== 'hotel') return item;
    const place = forBooking(booking, item.phase_id);
    if (!place) return item;
    // A location on the item is the hotel's own when it is the copy of the
    // booking's link made when the check-in/out were created (the stop's link
    // may have been edited since), or is already the resolved one.
    const own = httpUrl(item.location_url);
    if (own && own !== httpUrl(booking.location_url) && own !== place.maps_url) return item;
    return {
      ...item,
      location_url: place.maps_url,
      waze_url: httpUrl(item.waze_url) || place.waze_url,
      // So an editor does not save a derived link back as if somebody typed it.
      ...(!own && place.derived.maps ? { location_derived: true } : {}),
    };
  }

  // The booking as served: hotel bookings gain `place`; the raw location_url is
  // untouched (the edit form must show what is stored).
  function decorateBooking(booking) {
    if (!isObj(booking) || booking.type !== 'hotel') return booking;
    const place = forBooking(booking);
    return place ? { ...booking, place: { name: booking.name, maps_url: place.maps_url, waze_url: place.waze_url, derived: place.derived.maps } } : booking;
  }

  return { forBooking, hydrateConfig, decorateItem, decorateBooking };
}

module.exports = { resolveHotelPlace, createHotelPlaces, coordinatesFromUrl, httpUrl };
