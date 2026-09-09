import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const { createTripEvents } = require('../server/trip-events');

test('committed resource revisions cover every write and roll back atomically', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE bookings (id INTEGER PRIMARY KEY, name TEXT)');
  const events = createTripEvents(db, { tables: { bookings: 'bookings' } });
  assert.deepEqual(events.snapshot(), { bookings: 0 });
  db.prepare('INSERT INTO bookings VALUES (?, ?)').run(1, 'private confirmation');
  assert.deepEqual(events.snapshot(), { bookings: 1 });
  assert.throws(() => db.transaction(() => {
    db.exec("UPDATE bookings SET name = 'rolled back'");
    throw new Error('rollback');
  })());
  assert.deepEqual(events.snapshot(), { bookings: 1 });
  db.exec("UPDATE bookings SET name = 'background enrichment'");
  db.exec('DELETE FROM bookings');
  assert.deepEqual(events.snapshot(), { bookings: 3 });
  assert.ok(!JSON.stringify(events.snapshot()).includes('confirmation'));
  const otherDb = new Database(':memory:');
  otherDb.exec('CREATE TABLE bookings (id INTEGER PRIMARY KEY, name TEXT)');
  const other = createTripEvents(otherDb, { tables: { bookings: 'bookings' } });
  assert.deepEqual(other.snapshot(), { bookings: 0 });
  events.close(); other.close(); db.close(); otherDb.close();
});
