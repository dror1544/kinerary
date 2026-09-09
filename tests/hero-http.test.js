import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
let token;
before(async () => { await startTestServer({ HOST: '127.0.0.1', PORT: 3196 }); token = await loginAsAlice(); });
after(stopTestServer);

test('uploaded hero URLs require authentication and return image bytes to an authorized loader', async () => {
  // Actual PNG bytes, generated in-memory; no binary artifact committed.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPg62/7DwAD9QIjIm2vNAAAAABJRU5ErkJggg==', 'base64');
  const body = new FormData(); body.set('hero', new Blob([bytes], { type: 'image/png' }), 'hero.png');
  const upload = await api('/api/ui-settings/hero', { method: 'POST', token, body });
  assert.equal(upload.status, 200);
  const { hero } = await upload.json();
  assert.match(hero.url, /^\/api\/ui\/hero\//);
  const anonymous = await api(hero.url);
  assert.equal(anonymous.status, 401, 'a bare CSS url() cannot load this private image');
  assert.deepEqual(await anonymous.json(), { error: 'unauthorized' });
  const authorized = await api(hero.url, { token });
  assert.equal(authorized.status, 200);
  assert.match(authorized.headers.get('content-type'), /^image\/png/);
  assert.deepEqual(Buffer.from(await authorized.arrayBuffer()), bytes);
  assert.equal((await api('/api/ui/hero/missing.png', { token })).status, 404);
});
