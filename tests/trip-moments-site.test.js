/**
 * trip-moments-site.test.js — the site half of "trip photos and moments"
 * (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part A: AC-1, AC-2 request half, AC-3, AC-4 site half, AC-7).
 *
 * Over the real running server: the two organizer settings (group_photo_autosave, moment_capture_mode), moments with several
 * photos and a source, the agent key's `author`, and the photo upload's `uploaded_for` / `source`. Every refusal is
 * asserted as a refusal: a member cannot name an author or upload as someone else, and nothing is half-written.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, stopTestServer, loginAsAlice, api, testTripDir } from './helpers/server.js';
import { freePort } from './helpers/port-guard.js';

const AGENT = { apiKey: 'test-hermes-key' };
const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let alice, bob, eve;
before(async () => {
  await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() });
  alice = await loginAsAlice();
  bob = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
  eve = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'eve', password: '1234' } })).json()).token;
});
after(stopTestServer);

const settings = async (extra = { token: alice }) => (await api('/api/settings', extra)).json();
const patch = (body, extra = { token: alice }) => api('/api/settings', { method: 'PATCH', body, ...extra });
const moment = (body, extra = { token: bob }) => api('/api/moments', { method: 'POST', body, ...extra });
const moments = async (extra = { token: bob }) => (await api('/api/moments', extra)).json();
async function upload(fields, extra = { token: bob }, name = 'beach.jpg') {
  const form = new FormData();
  form.append('photo', new Blob([PIXEL], { type: 'image/jpeg' }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return api('/api/photos/upload', { method: 'POST', body: form, ...extra });
}
const uploadsDir = () => join(testTripDir(), '..', 'uploads');

test('AC-1: a new trip reads group_photo_autosave true and moment_capture_mode ask_in_chat', async () => {
  const body = await settings();
  assert.equal(body.group_photo_autosave, true);
  assert.equal(body.moment_capture_mode, 'ask_in_chat');
  assert.equal(body.group_change_line, true, 'the other settings are untouched');
});

test('AC-1: an organizer changes both; a body with only one leaves the other, and the timezone, alone', async () => {
  assert.equal((await patch({ timezone: 'Europe/Paris' })).status, 200);
  const off = await patch({ group_photo_autosave: false });
  assert.equal(off.status, 200);
  const a = await off.json();
  assert.equal(a.group_photo_autosave, false);
  assert.equal(a.moment_capture_mode, 'ask_in_chat');
  assert.equal(a.timezone, 'Europe/Paris');
  const pub = await patch({ moment_capture_mode: 'publish' });
  assert.equal((await pub.json()).moment_capture_mode, 'publish');
  const both = await (await patch({ group_photo_autosave: true, moment_capture_mode: 'organizer_draft' })).json();
  assert.equal(both.group_photo_autosave, true);
  assert.equal(both.moment_capture_mode, 'organizer_draft');
  assert.deepEqual(await settings({ token: bob }), both, 'a member reads what the organizer set');
  assert.equal((await patch({ moment_capture_mode: 'ask_in_chat' })).status, 200);
});

test('AC-1: a member\'s PATCH of either is 403 and changes nothing', async () => {
  const before = await settings();
  for (const body of [{ group_photo_autosave: false }, { moment_capture_mode: 'publish' }]) {
    const res = await patch(body, { token: bob });
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'organizer_only' });
  }
  assert.deepEqual(await settings(), before);
});

test('AC-2: an unknown moment_capture_mode in a request is 400 and nothing is written', async () => {
  const before = await settings();
  for (const value of ['Publish', 'public', '', 'ask', null, 1, true, [], {}]) {
    const res = await patch({ moment_capture_mode: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.match((await res.json()).error, /moment_capture_mode/);
  }
  for (const value of ['false', 0, 1, null, 'yes']) {
    const res = await patch({ group_photo_autosave: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.match((await res.json()).error, /group_photo_autosave/);
  }
  assert.deepEqual(await settings(), before);
  const half = await patch({ moment_capture_mode: 'nope', group_photo_autosave: false });
  assert.equal(half.status, 400);
  assert.deepEqual(await settings(), before, 'a bad value beside a good one refuses the whole write');
});

test('AC-3: a moment with several photos returns photo_ids in order, photo_id is the first, source is kept', async () => {
  const res = await moment({ caption: 'Beach day', body: 'sand everywhere', photo_ids: ['p3', 'p1', 'p2'], source: 'connector' });
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.deepEqual(made.photo_ids, ['p3', 'p1', 'p2']);
  assert.equal(made.photo_id, 'p3', 'old readers still see the first photo');
  assert.equal(made.source, 'connector');
  assert.equal(made.author, 'bob');
  assert.equal(made.visibility, 'draft');
  const mine = (await moments()).find((m) => m.id === made.id);
  assert.deepEqual(mine.photo_ids, ['p3', 'p1', 'p2']);
  assert.equal(mine.photo_id, 'p3');
});

test('AC-3: a moment from before this change (photo_id only, no source) reads as one photo from the site', async () => {
  const old = await (await moment({ caption: 'Old style', photo_id: 'only-one' })).json();
  assert.deepEqual(old.photo_ids, ['only-one']);
  assert.equal(old.photo_id, 'only-one');
  assert.equal(old.source, 'site');
  const none = await (await moment({ caption: 'No photo' })).json();
  assert.deepEqual(none.photo_ids, []);
  assert.equal(none.photo_id, null);
});

test('AC-3: a member sees only published moments and their own drafts, unchanged', async () => {
  const draft = await (await moment({ caption: 'Bob private draft', photo_ids: ['a'] }, { token: bob })).json();
  const pub = await (await moment({ caption: 'Alice published', visibility: 'published', photo_ids: ['b'] }, { token: alice })).json();
  const aliceDraft = await (await moment({ caption: 'Alice private draft' }, { token: alice })).json();
  const bobSees = (await moments({ token: bob })).map((m) => m.id);
  assert.ok(bobSees.includes(draft.id) && bobSees.includes(pub.id));
  assert.ok(!bobSees.includes(aliceDraft.id), 'another member\'s draft is not served');
  const aliceSees = (await moments({ token: alice })).map((m) => m.id);
  assert.ok(aliceSees.includes(draft.id), 'an organizer sees a member\'s draft (so an organizer can publish it)');
  assert.ok(aliceSees.includes(aliceDraft.id) && aliceSees.includes(pub.id));
});

test('drafts: an organizer and the agent key see every moment; another member sees only published ones and their own', async () => {
  const bobDraft = await (await moment({ caption: 'Bob draft for organizers' }, { token: bob })).json();
  const aliceDraft = await (await moment({ caption: 'Alice draft only for alice and organizers' }, { token: alice })).json();
  const chatDraft = await (await moment({ caption: 'Chat draft for bob', author: 'bob', source: 'chat' }, AGENT)).json();
  const ids = async (extra) => (await moments(extra)).map((m) => m.id);
  const organizer = await ids({ token: alice });
  assert.ok([bobDraft.id, aliceDraft.id, chatDraft.id].every((id) => organizer.includes(id)), 'organizer: all drafts');
  const agent = await ids(AGENT);
  assert.ok([bobDraft.id, aliceDraft.id, chatDraft.id].every((id) => agent.includes(id)), 'agent key: all drafts');
  const bobSees = await ids({ token: bob });
  assert.ok(bobSees.includes(bobDraft.id) && bobSees.includes(chatDraft.id), 'bob sees his own drafts, including the one written in his name');
  assert.ok(!bobSees.includes(aliceDraft.id), 'a member never sees another member\'s draft');
  const eveSees = await ids({ token: eve });
  assert.ok(![bobDraft.id, aliceDraft.id, chatDraft.id].some((id) => eveSees.includes(id)), 'a third member sees none of the drafts');
  assert.equal((await api(`/api/moments/${bobDraft.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: alice })).status, 200, 'the organizer publishes it');
  assert.ok((await ids({ token: eve })).includes(bobDraft.id), 'and then everyone sees it');
});

test('photo_ids and source are bounded: a bad shape is 400 and stores nothing', async () => {
  const count = async () => (await moments()).length;
  const n = await count();
  for (const body of [
    { caption: 'x', photo_ids: 'p1' },
    { caption: 'x', photo_ids: [1, 2] },
    { caption: 'x', photo_ids: [''] },
    { caption: 'x', photo_ids: ['a b'] },
    { caption: 'x', photo_ids: Array.from({ length: 21 }, (_, i) => `p${i}`) },
    { caption: 'x', source: 'telegram' },
    { caption: 'x', source: 5 },
  ]) {
    const res = await moment(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(await count(), n);
  assert.equal((await moment({ caption: 'x', photo_ids: Array.from({ length: 20 }, (_, i) => `p${i}`) })).status, 201, '20 is the limit, and allowed');
});

test('AC-4 (site half): the agent key creates a moment for a participant, in the visibility it asks for, with a source', async () => {
  const res = await moment({ caption: 'From the chat', body: 'Dad lost the bet', photo_ids: ['c1', 'c2'], author: 'bob', source: 'chat', visibility: 'published' }, AGENT);
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.equal(made.author, 'bob');
  assert.equal(made.source, 'chat');
  assert.equal(made.visibility, 'published');
  assert.deepEqual(made.photo_ids, ['c1', 'c2']);
  const draft = await (await moment({ caption: 'Draft for bob', author: 'bob', source: 'chat' }, AGENT)).json();
  assert.equal(draft.visibility, 'draft');
  assert.ok((await moments({ token: bob })).some((m) => m.id === draft.id), 'the participant sees the draft written in their name');
  assert.ok(!(await moments({ token: eve })).some((m) => m.id === draft.id), 'another member does not see it');
  assert.ok((await moments({ token: alice })).some((m) => m.id === draft.id), 'an organizer does');
  const noAuthor = await (await moment({ caption: 'No author' }, AGENT)).json();
  assert.equal(noAuthor.author, 'hermes', 'with no author the agent is the author, as before');
});

test('AC-4: an author that is not a participant is 400 and nothing is stored', async () => {
  const n = (await moments(AGENT)).length;
  for (const author of ['nobody', '', 'hermes-2', 5, ['bob']]) {
    const res = await moment({ caption: 'x', author }, AGENT);
    assert.equal(res.status, 400, JSON.stringify(author));
  }
  assert.equal((await moments(AGENT)).length, n);
});

test('AC-4: a member cannot name an author — 403, not a silent ignore — and nothing is stored', async () => {
  const n = (await moments({ token: bob })).length;
  const res = await moment({ caption: 'as alice', author: 'alice' }, { token: bob });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'author_agent_only' });
  assert.equal((await moments({ token: bob })).length, n);
  const self = await moment({ caption: 'as myself', author: 'bob' }, { token: bob });
  assert.equal(self.status, 403, 'even naming yourself is refused: the field is the agent key\'s');
});

test('AC-4: the agent key updates and deletes any moment, and a member only their own', async () => {
  const mine = await (await moment({ caption: 'Bob mine', photo_ids: ['m1'] }, { token: bob })).json();
  const alices = await (await moment({ caption: 'Alice mine' }, { token: alice })).json();
  const upd = await api(`/api/moments/${mine.id}`, { method: 'PATCH', body: { caption: 'Renamed', photo_ids: ['m2', 'm1'], visibility: 'published' }, ...AGENT });
  assert.equal(upd.status, 200);
  const updated = await upd.json();
  assert.equal(updated.caption, 'Renamed');
  assert.deepEqual(updated.photo_ids, ['m2', 'm1']);
  assert.equal(updated.photo_id, 'm2');
  assert.equal(updated.visibility, 'published');
  const refused = await api(`/api/moments/${alices.id}`, { method: 'PATCH', body: { caption: 'hijack' }, token: bob });
  assert.equal(refused.status, 403);
  assert.equal((await api(`/api/moments/${alices.id}`, { method: 'DELETE', token: bob })).status, 403);
  assert.equal((await moments({ token: alice })).find((m) => m.id === alices.id).caption, 'Alice mine');
  assert.equal((await api(`/api/moments/${mine.id}`, { method: 'DELETE', ...AGENT })).status, 200);
  assert.ok(!(await moments({ token: bob })).some((m) => m.id === mine.id));
});

test('AC-7: an upload through the agent key with uploaded_for and source lists the participant as the author', async () => {
  const res = await upload({ phase: 'general', caption: 'Sunset', uploaded_for: 'bob', source: 'chat' }, AGENT);
  assert.equal(res.status, 200);
  const { photo } = await res.json();
  assert.equal(photo.username, 'bob');
  assert.equal(photo.user.username, 'bob');
  assert.equal(photo.source, 'chat');
  const listed = (await (await api('/api/photos', { token: alice })).json()).find((p) => p.id === photo.id);
  assert.equal(listed.username, 'bob', 'the album shows the participant, not the bot');
  assert.equal(listed.user.username, 'bob');
  assert.equal(listed.source, 'chat');
  assert.equal((await api(`/api/photos/${photo.id}`, { method: 'DELETE', token: bob })).status, 200, 'the participant owns it, so they may delete it');
});

test('AC-7: with no uploaded_for the agent is still the author, and source defaults to site', async () => {
  const { photo } = await (await upload({ phase: 'general' }, AGENT)).json();
  assert.equal(photo.username, 'hermes');
  const listed = (await (await api('/api/photos', { token: alice })).json()).find((p) => p.id === photo.id);
  assert.equal(listed.source, 'site');
  await api(`/api/photos/${photo.id}`, { method: 'DELETE', ...AGENT });
});

test('AC-7: a member cannot upload as someone else (403) and no file is left on disk', async () => {
  const files = () => readdirSync(uploadsDir()).length;
  const n = files();
  const res = await upload({ uploaded_for: 'alice', source: 'chat' }, { token: bob });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'uploaded_for_agent_only' });
  assert.equal(files(), n, 'the refused upload left nothing behind');
  assert.ok(!(await (await api('/api/photos', { token: alice })).json()).some((p) => p.originalName === 'beach.jpg' && p.username === 'alice'));
});

test('AC-7: an unknown participant, or an unknown source, is 400 and leaves no file', async () => {
  const files = () => readdirSync(uploadsDir()).length;
  const n = files();
  assert.equal((await upload({ uploaded_for: 'nobody' }, AGENT)).status, 400);
  assert.equal((await upload({ uploaded_for: 'bob', source: 'telegram' }, AGENT)).status, 400);
  assert.equal((await upload({ source: 'telegram' }, { token: bob })).status, 400);
  assert.equal(files(), n);
});

test('a member upload records its own source and is attributed to the member', async () => {
  const { photo } = await (await upload({ source: 'connector', caption: 'via the link' }, { token: bob })).json();
  assert.equal(photo.username, 'bob');
  assert.equal(photo.source, 'connector');
  await api(`/api/photos/${photo.id}`, { method: 'DELETE', token: bob });
});

test('concurrent uploads each get their own photo id (a burst from the relay cannot collide), and the ids still work as strings', async () => {
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => upload({ caption: `burst ${i}`, uploaded_for: 'bob', source: 'chat' }, AGENT, `burst-${i}.jpg`)));
  assert.deepEqual(answers.map((r) => r.status), Array(12).fill(200), 'no upload failed on a key collision');
  const ids = (await Promise.all(answers.map((r) => r.json()))).map((b) => b.photo.id);
  assert.equal(new Set(ids).size, 12, 'twelve distinct ids');
  for (const id of ids) assert.match(id, /^\d+-[0-9a-f]{8}$/);
  const listed = await (await api('/api/photos', { token: alice })).json();
  assert.equal(ids.filter((id) => listed.some((p) => p.id === id)).length, 12, 'every one is in the album');
  const m = await (await moment({ caption: 'Burst moment', photo_ids: ids.slice(0, 3), author: 'bob', source: 'chat' }, AGENT)).json();
  assert.deepEqual(m.photo_ids, ids.slice(0, 3), 'moments accept the new ids');
  assert.equal((await api(`/api/photos/${ids[0]}`, { method: 'DELETE', token: bob })).status, 200, 'and the participant can delete by that id');
});

test('a removed participant keeps their history but nothing new is written in their name (author and uploaded_for)', async () => {
  const kept = await (await moment({ caption: 'Eve before', author: 'eve' }, AGENT)).json();
  assert.equal(kept.author, 'eve', 'eve is a participant until removed');
  const gone = await api('/api/agent/participants/eve', { method: 'DELETE', ...AGENT });
  assert.equal(gone.status, 200);
  const files = () => readdirSync(uploadsDir()).length;
  const n = files();
  const asAuthor = await moment({ caption: 'Eve after', author: 'eve' }, AGENT);
  assert.equal(asAuthor.status, 400);
  assert.equal((await upload({ uploaded_for: 'eve', source: 'chat' }, AGENT)).status, 400);
  assert.equal(files(), n, 'the refused upload left no file');
  assert.ok(!(await moments(AGENT)).some((m) => m.caption === 'Eve after'));
});
