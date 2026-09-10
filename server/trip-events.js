// One runtime owns one trip DB. Revisions are updated IN the writer's SQLite
// transaction, so MCP/API/background writers cannot forget to notify and a
// rollback cannot emit an event. No trip content or row identifiers go on wire.
const TABLES = {
  bookings: 'bookings', budget_items: 'budget', photos: 'photos',
  photo_reactions: 'photo-reactions', photo_comments: 'photo-comments',
  venue_comments: 'comments', ratings: 'ratings',
  phase_plan_items: 'itinerary', phase_plan_days: 'itinerary',
  itinerary_plan_items: 'itinerary', itinerary_plan_days: 'itinerary',
  trip_itinerary_state: 'itinerary', trip_moments: 'moments',
  trip_ui_settings: 'ui',
};

function createTripEvents(db, { tables = TABLES, pollMs = 250 } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS trip_resource_revisions (resource TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0)');
  db.transaction(() => {
    for (const [table, resource] of Object.entries(tables)) {
      // Identifiers come only from the fixed map above (or a test fixture).
      if (!/^[a-z_]+$/.test(table) || !/^[a-z-]+$/.test(resource)) throw new Error('Invalid event resource');
      db.prepare('INSERT OR IGNORE INTO trip_resource_revisions(resource) VALUES (?)').run(resource);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS trip_change_${table}_${operation}
          AFTER ${operation} ON ${table} BEGIN
          UPDATE trip_resource_revisions SET revision = revision + 1 WHERE resource = '${resource}'; END`);
      }
    }
  })();
  const read = db.prepare('SELECT resource, revision FROM trip_resource_revisions');
  const snapshot = () => Object.fromEntries(read.all().map(row => [row.resource, row.revision]));
  const clients = new Set();
  let timer;
  let previous = snapshot();
  let lastHeartbeat = Date.now();
  function write(res, text) {
    // Bound memory for stalled clients. Reconnection sends a complete snapshot.
    if (res.destroyed || res.writableLength > 64 * 1024) { res.destroy(); return; }
    res.write(text);
  }
  function tick() {
    const current = snapshot();
    const revisions = Object.fromEntries(Object.entries(current).filter(([key, value]) => previous[key] !== value));
    previous = current;
    if (Object.keys(revisions).length) {
      for (const res of clients) write(res, `event: change\ndata: ${JSON.stringify({ revisions })}\n\n`);
    }
    if (Date.now() - lastHeartbeat >= 20_000) {
      lastHeartbeat = Date.now();
      for (const res of clients) write(res, ': heartbeat\n\n');
    }
  }
  function stream(req, res, expiresAt = Date.now() + 3600_000) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    if (!clients.size) {
      previous = snapshot();
      timer = setInterval(tick, pollMs);
      timer.unref();
    }
    clients.add(res);
    write(res, `event: ready\ndata: ${JSON.stringify({ revisions: snapshot() })}\n\n`);
    const expiry = setTimeout(() => res.end(), Math.max(0, Math.min(expiresAt - Date.now(), 3600_000)));
    expiry.unref();
    res.on('close', () => {
      clearTimeout(expiry);
      clients.delete(res);
      if (!clients.size) { clearInterval(timer); timer = undefined; }
    });
  }
  return { snapshot, stream, close() {
    clearInterval(timer);
    for (const res of clients) res.end();
  } };
}
module.exports = { createTripEvents };
