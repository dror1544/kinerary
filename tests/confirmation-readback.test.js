import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { readConfirmationPdf } = require('./trip-mcp/confirmation-readback');
const response = (chunks, type = 'application/pdf', status = 200, length = null) => ({
  status, ok: status === 200, headers: { get: k => k === 'content-type' ? type : k === 'content-length' ? length : null },
  body: Readable.from(chunks),
});
it('readback bounds streaming bytes without Content-Length and refuses declared oversize', async () => {
  for (const r of [response([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024)]), response([], 'application/pdf', 200, '5242881')]) {
    await assert.rejects(readConfirmationPdf(async () => r), /5 MiB/);
    assert.ok(r.body.destroyed);
  }
});
it('readback refuses redirects, unsuccessful responses, unsupported type and signature', async () => {
  for (const [r, error] of [[response([], 'application/pdf', 302), /redirect/i], [response([], 'application/pdf', 404), /unavailable/i],
    [response(['%PDF-1.4'], 'text/html'), /PDF/], [response(['bad bytes']), /signature/i]]) {
    await assert.rejects(readConfirmationPdf(async () => r), error);
  }
});
it('readback deadline covers both response headers and a stalled body and aborts', async () => {
  let signal;
  await assert.rejects(readConfirmationPdf(async s => { signal = s; return new Promise(() => {}); }, { deadlineMs: 25 }), /10 seconds/);
  assert.equal(signal.aborted, true);
  const r = response((async function* () { yield Buffer.from('%PDF-'); await new Promise(() => {}); })());
  await assert.rejects(readConfirmationPdf(async s => { signal = s; return r; }, { deadlineMs: 25 }), /10 seconds/);
  assert.equal(signal.aborted, true);
  assert.ok(r.body.destroyed);
});
it('readback hashes exact PDF bytes', async () => {
  const bytes = Buffer.from('%PDF-1.4\nsynthetic original\n');
  const result = await readConfirmationPdf(async () => response([bytes.subarray(0, 3), bytes.subarray(3)]));
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.byte_count, bytes.length);
  assert.equal(result.sha256, require('crypto').createHash('sha256').update(bytes).digest('hex'));
});
it('real MCP HTTP enforces readonly grants, demotion, removal and revocation', async () => {
  const app = require('express')();
  app.use(require('express').json());
  const jwt = require('jsonwebtoken');
  const db = new (require('better-sqlite3'))(':memory:');
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(r => listener.once('listening', r));
  const port = listener.address().port, origin = `http://127.0.0.1:${port}`;
  let organizer = true, participant = true;
  const authRequired = (req, res, next) => {
    try { req.user = jwt.verify(req.headers.authorization.replace(/^Bearer /, ''), 'synthetic-secret'); next(); }
    catch { res.status(401).end(); }
  };
  app.get('/api/bookings', authRequired, (req, res) => {
    assert.equal(req.user.username, 'alice');
    res.json([{ id: 1, conf_file: 'אישור הזמנה מקורי.pdf' }]);
  });
  app.get('/api/bookings/confirmation/:filename', authRequired, (req, res) => {
    assert.equal(req.params.filename, 'אישור הזמנה מקורי.pdf');
    res.type('application/pdf').send(Buffer.from('%PDF-1.4 synthetic'));
  });
  require('./trip-mcp').registerTripMcp({ app, db, env: { TRIP_MCP_ENABLED: '1', PUBLIC_ORIGIN: origin }, jwt,
    jwtSecret: 'synthetic-secret', jwtSecretIsDefault: false, validManagedPayload: () => true,
    organizers: () => organizer ? ['alice'] : [], userExists: () => participant,
    getPublicConfig: () => ({ meta: { title: 'Synthetic' }, agent: { organizers: ['alice'] } }),
    authRequired, listenPort: port, listenHost: '127.0.0.1' });
  const store = require('./trip-mcp/oauth').createOAuthStore(db);
  const client = store.registerClient({ redirectUris: ['http://127.0.0.1/cb'], authMethod: 'none' });
  const grant = scope => store.startGrant({ clientId: client.clientId, username: 'alice', scope });
  let id = 0;
  const call = token => fetch(origin + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({
      jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'get_booking_confirmation', arguments: { booking_id: 1 } },
    }) });
  const denied = async token => { const r = await (await call(token)).json(); assert.ok(r.error || r.result?.isError); };
  try {
    const write = grant('trip');
    const unicode = (await (await call(write.tokens.access_token)).json()).result;
    assert.deepEqual(Buffer.from(unicode.content.find(c => c.type === 'resource').resource.blob, 'base64'), Buffer.from('%PDF-1.4 synthetic'));
    await denied(grant('trip:read').tokens.access_token);
    organizer = false;
    await denied(write.tokens.access_token);
    organizer = true;
    await denied(write.tokens.access_token);
    const removed = grant('trip');
    participant = false;
    assert.equal((await call(removed.tokens.access_token)).status, 401);
    participant = true;
    const revoked = grant('trip');
    store.revokeGrant(revoked.grantId);
    assert.equal((await call(revoked.tokens.access_token)).status, 401);
  } finally {
    listener.closeAllConnections();
    await new Promise(r => listener.close(r));
    db.close();
  }
});

it('readback accepts the exact byte limit and hides network and stream failure details', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  bytes.write('%PDF-');
  assert.equal((await readConfirmationPdf(async () => response([bytes]))).byte_count, bytes.length);
  for (const fetchResponse of [async () => { throw new Error('Bearer credential http://localhost:1234/private/path'); },
    async () => response((async function* () { yield Buffer.from('%PDF-'); throw new Error('Bearer credential /private/path'); })())]) {
    await assert.rejects(readConfirmationPdf(fetchResponse), err => {
      assert.match(err.message, /retrieval failed.*authenticated trip site/);
      assert.doesNotMatch(err.message, /Bearer|credential|localhost|private/);
      return true;
    });
  }
});
it('booking lookup failures expose no backend addresses, credentials or paths', async () => {
  let callback;
  require('./trip-mcp/tools').registerTools({ registerTool(name, _schema, run) {
    if (name === 'get_booking_confirmation') callback = run;
  } }, { get: async () => { throw new Error('http://localhost:1234 Bearer private-credential /private/server/path'); } }, { write: true });
  await assert.rejects(callback({ booking_id: 1 }), err => {
    assert.match(err.message, /Booking confirmation lookup failed.*authenticated trip site/);
    assert.doesNotMatch(err.message, /localhost|Bearer|credential|private/);
    return true;
  });
});
