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
  await startTestServer({ HOST: '127.0.0.1', PORT: await freePort() }, { features: { chat_photos_to_album: true, trip_moments_capture: true } });
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
  assert.ok(!aliceSees.includes(draft.id), 'a draft a member wrote on the site stays theirs alone: an organizer does not get it');
  assert.ok(aliceSees.includes(aliceDraft.id) && aliceSees.includes(pub.id));
});

test('F2: an organizer and the agent see chat and connector drafts only; a site draft stays its author\'s; a third member sees none', async () => {
  const siteDraft = await (await moment({ caption: 'Bob site draft' }, { token: bob })).json();
  const connectorDraft = await (await moment({ caption: 'Bob connector draft', source: 'connector' }, { token: bob })).json();
  const aliceDraft = await (await moment({ caption: 'Alice draft' }, { token: alice })).json();
  const chatDraft = await (await moment({ caption: 'Chat draft for bob', author: 'bob', source: 'chat' }, AGENT)).json();
  const ids = async (extra) => (await moments(extra)).map((m) => m.id);
  const organizer = await ids({ token: alice });
  assert.ok(organizer.includes(connectorDraft.id) && organizer.includes(chatDraft.id), 'organizer: connector and chat drafts');
  assert.ok(!organizer.includes(siteDraft.id), 'organizer: NOT a member\'s site draft');
  assert.ok(organizer.includes(aliceDraft.id), 'organizer: their own');
  const agent = await ids(AGENT);
  assert.ok(agent.includes(connectorDraft.id) && agent.includes(chatDraft.id), 'agent key: connector and chat drafts');
  assert.ok(!agent.includes(siteDraft.id), 'agent key: NOT a member\'s site draft');
  const bobSees = await ids({ token: bob });
  assert.ok([siteDraft.id, connectorDraft.id, chatDraft.id].every((id) => bobSees.includes(id)), 'bob sees his own drafts, including the one written in his name');
  assert.ok(!bobSees.includes(aliceDraft.id), 'a member never sees another member\'s draft');
  const eveSees = await ids({ token: eve });
  assert.ok(![siteDraft.id, connectorDraft.id, chatDraft.id, aliceDraft.id].some((id) => eveSees.includes(id)), 'a third member sees none of the drafts');
  assert.equal((await api(`/api/moments/${connectorDraft.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: alice })).status, 200, 'the organizer publishes it');
  assert.ok((await ids({ token: eve })).includes(connectorDraft.id), 'and then everyone sees it');
});

test('F1: what the companion wrote (source chat) is published only by an organizer or the agent; its author cannot publish it or edit it once out', async () => {
  const chat = await (await moment({ caption: 'Chat says', body: 'quotes Dad', author: 'bob', source: 'chat' }, AGENT)).json();
  assert.equal(chat.visibility, 'draft');
  const publishByAuthor = await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: bob });
  assert.equal(publishByAuthor.status, 403);
  assert.deepEqual(await publishByAuthor.json(), { error: 'organizer_review_required' });
  assert.equal((await moments({ token: bob })).find((m) => m.id === chat.id).visibility, 'draft', 'still a draft');
  assert.equal((await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { caption: 'Bob tidies his draft' }, token: bob })).status, 200, 'its author may still edit the draft');
  const out = await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: alice });
  assert.equal(out.status, 200, 'an organizer publishes it');
  const edit = await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { caption: 'Bob rewrites it live' }, token: bob });
  assert.equal(edit.status, 403, 'its author cannot change it once published');
  const unpublish = await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { visibility: 'draft' }, token: bob });
  assert.equal(unpublish.status, 403);
  assert.equal((await moments({ token: eve })).find((m) => m.id === chat.id).caption, 'Bob tidies his draft', 'what the family reads is what the organizer approved');
  assert.equal((await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { caption: 'Organizer fixes a word' }, token: alice })).status, 200, 'an organizer may edit it');
  assert.equal((await api(`/api/moments/${chat.id}`, { method: 'PATCH', body: { body: 'agent fix' }, ...AGENT })).status, 200, 'the agent may edit it');
  assert.equal((await api(`/api/moments/${chat.id}`, { method: 'DELETE', token: bob })).status, 200, 'its author may still take it down');
});

test('R4: the agent key obeys moment_capture_mode — organizer_draft: it cannot publish a chat moment (POST or PATCH); ask_in_chat and publish: it may; organizers never limited', async () => {
  const setMode = async (mode) => assert.equal((await patch({ moment_capture_mode: mode })).status, 200);
  const agentPost = (body) => api('/api/moments', { method: 'POST', body: { caption: 'R4', author: 'bob', source: 'chat', ...body }, ...AGENT });
  try {
    await setMode('organizer_draft');
    const refused = await agentPost({ visibility: 'published' });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'organizer_review_required' });
    const draft = await (await agentPost({})).json();
    assert.equal(draft.visibility, 'draft', 'a draft is exactly what organizer_draft asks of it');
    const refusedPatch = await api(`/api/moments/${draft.id}`, { method: 'PATCH', body: { visibility: 'published' }, ...AGENT });
    assert.equal(refusedPatch.status, 403);
    assert.deepEqual(await refusedPatch.json(), { error: 'organizer_review_required' });
    assert.equal((await api(`/api/moments/${draft.id}`, { method: 'PATCH', body: { caption: 'agent still edits the draft' }, ...AGENT })).status, 200);
    assert.equal((await moments(AGENT)).find((m) => m.id === draft.id).visibility, 'draft', 'nothing was published');
    const byOrganizer = await api(`/api/moments/${draft.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: alice });
    assert.equal(byOrganizer.status, 200, 'an organizer is never limited by the mode');
    const orgPost = await moment({ caption: 'organizer in organizer_draft mode', visibility: 'published' }, { token: alice });
    assert.equal(orgPost.status, 201);
    for (const mode of ['ask_in_chat', 'publish']) {
      await setMode(mode);
      const direct = await agentPost({ visibility: 'published', caption: `agent ${mode}` });
      assert.equal(direct.status, 201, `${mode}: the agent may publish directly`);
      assert.equal((await direct.json()).visibility, 'published');
      const d = await (await agentPost({})).json();
      const out = await api(`/api/moments/${d.id}`, { method: 'PATCH', body: { visibility: 'published' }, ...AGENT });
      assert.equal(out.status, 200, `${mode}: the agent may publish a draft (ask_in_chat: after the chat said yes)`);
    }
    // A damaged setting is the strictest mode: the agent cannot publish.
    await setMode('organizer_draft');
    assert.equal((await agentPost({ visibility: 'published' })).status, 403);
  } finally { await setMode('ask_in_chat'); }
});

test('F1: anything the agent key creates is source chat — it cannot relabel itself site or connector (400, nothing stored)', async () => {
  const n = (await moments(AGENT)).length;
  for (const source of ['site', 'connector', 'telegram', 5]) {
    const res = await api('/api/moments', { method: 'POST', body: { caption: 'relabel', author: 'bob', source }, ...AGENT });
    assert.equal(res.status, 400, String(source));
    assert.match((await res.json()).error, /source/);
  }
  assert.equal((await moments(AGENT)).length, n);
  const ok = await (await api('/api/moments', { method: 'POST', body: { caption: 'explicit chat', author: 'bob', source: 'chat' }, ...AGENT })).json();
  assert.equal(ok.source, 'chat');
  const bare = await (await api('/api/moments', { method: 'POST', body: { caption: 'no source, attributed to bob', author: 'bob' }, ...AGENT })).json();
  assert.equal(bare.source, 'chat', 'attributed to a member, still a chat moment: bob cannot publish it');
  assert.equal((await api(`/api/moments/${bare.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: bob })).status, 403);
});

test('F1 (R4, keyed on the caller): in organizer_draft mode the agent key is refused ANY publish, whatever the stored source', async () => {
  const setMode = async (mode) => assert.equal((await patch({ moment_capture_mode: mode })).status, 200);
  try {
    // Moments the agent did not create, of every source a member can have.
    const siteDraft = await (await moment({ caption: 'bob site draft' }, { token: bob })).json();
    const connectorDraft = await (await moment({ caption: 'bob connector draft', source: 'connector' }, { token: bob })).json();
    await setMode('organizer_draft');
    for (const m of [siteDraft, connectorDraft]) {
      const r = await api(`/api/moments/${m.id}`, { method: 'PATCH', body: { visibility: 'published' }, ...AGENT });
      assert.equal(r.status, 403, m.source);
      assert.deepEqual(await r.json(), { error: 'organizer_review_required' });
    }
    // Draft, then PATCH — the reviewer's variant: the draft is the agent's own.
    const own = await (await api('/api/moments', { method: 'POST', body: { caption: 'draft first', author: 'bob' }, ...AGENT })).json();
    assert.equal((await api(`/api/moments/${own.id}`, { method: 'PATCH', body: { visibility: 'published' }, ...AGENT })).status, 403);
    // Direct publish, with and without relabelling.
    for (const body of [{ visibility: 'published' }, { visibility: 'published', source: 'chat' }, { visibility: 'published', source: 'site' }, { visibility: 'published', source: 'connector' }]) {
      const r = await api('/api/moments', { method: 'POST', body: { caption: 'direct', author: 'bob', ...body }, ...AGENT });
      assert.ok([400, 403].includes(r.status), JSON.stringify(body));
    }
    const all = await moments({ token: alice });
    assert.ok(all.filter((m) => [siteDraft.id, connectorDraft.id, own.id].includes(m.id)).every((m) => m.visibility === 'draft'), 'nothing was published');
    // An organizer is not limited; ask_in_chat lets the agent publish again.
    assert.equal((await api(`/api/moments/${connectorDraft.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: alice })).status, 200);
    await setMode('ask_in_chat');
    assert.equal((await api(`/api/moments/${siteDraft.id}`, { method: 'PATCH', body: { visibility: 'published' }, ...AGENT })).status, 200);
  } finally { await setMode('ask_in_chat'); }
});

test('F2: the agent key cannot change moment_capture_mode or group_photo_autosave (403, nothing half-written); it keeps the other settings it changes today', async () => {
  const before = await settings();
  for (const body of [{ moment_capture_mode: 'publish' }, { group_photo_autosave: false }, { group_change_line: false, moment_capture_mode: 'publish' }, { timezone: 'Asia/Tokyo', group_photo_autosave: false }]) {
    const r = await patch(body, AGENT);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.deepEqual(await r.json(), { error: 'organizer_only_setting' });
  }
  assert.deepEqual(await settings(), before, 'nothing changed, not even the allowed half of a mixed body');
  assert.equal((await patch({ timezone: 'Asia/Tokyo' }, AGENT)).status, 200, 'set_trip_timezone still works');
  assert.equal((await patch({ group_change_line: false }, AGENT)).status, 200, 'set_group_change_line still works');
  assert.equal((await patch({ group_change_line: true, timezone: before.timezone || 'Asia/Jerusalem' }, AGENT)).status, 200);
  assert.equal((await patch({ moment_capture_mode: 'organizer_draft', group_photo_autosave: false })).status, 200, 'an organizer still can');
  assert.equal((await patch({ moment_capture_mode: 'ask_in_chat', group_photo_autosave: true })).status, 200);
});

test('F1: a moment the agent writes with no source is a chat moment, and the agent may publish it directly', async () => {
  const made = await (await moment({ caption: 'Agent default source', author: 'bob', visibility: 'published' }, AGENT)).json();
  assert.equal(made.source, 'chat');
  assert.equal(made.visibility, 'published');
  assert.equal((await api(`/api/moments/${made.id}`, { method: 'PATCH', body: { caption: 'x' }, token: bob })).status, 403);
});

test('F1: a member\'s own moment (site or connector) stays theirs to publish and to edit afterwards, as the site always allowed', async () => {
  for (const source of [undefined, 'site', 'connector']) {
    const own = await (await moment({ caption: `Mine ${source}`, ...(source ? { source } : {}) }, { token: bob })).json();
    assert.equal((await api(`/api/moments/${own.id}`, { method: 'PATCH', body: { visibility: 'published' }, token: bob })).status, 200, String(source));
    assert.equal((await api(`/api/moments/${own.id}`, { method: 'PATCH', body: { caption: 'Edited after publishing' }, token: bob })).status, 200, String(source));
  }
  const direct = await moment({ caption: 'Published at once', visibility: 'published' }, { token: bob });
  assert.equal(direct.status, 201);
});

test('F4: a member cannot claim source chat on a moment (400, nothing stored), even to publish; the agent can', async () => {
  const n = (await moments({ token: bob })).length;
  for (const body of [{ caption: 'x', source: 'chat' }, { caption: 'x', source: 'chat', visibility: 'published' }]) {
    const res = await moment(body, { token: bob });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, /source/);
  }
  assert.equal((await moments({ token: bob })).length, n);
  assert.equal((await moment({ caption: 'ok', source: 'connector' }, { token: bob })).status, 201);
  assert.equal((await moment({ caption: 'ok', source: 'site' }, { token: bob })).status, 201);
  assert.equal((await moment({ caption: 'from chat', source: 'chat' }, AGENT)).status, 201);
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
  const res = await upload({ uploaded_for: 'alice', source: 'connector' }, { token: bob });
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

test('F4: a member cannot upload with source chat (400, no file left); site and connector are fine; the agent may use chat', async () => {
  const files = () => readdirSync(uploadsDir()).length;
  const n = files();
  const res = await upload({ source: 'chat' }, { token: bob });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_source' });
  assert.equal(files(), n);
  for (const source of ['site', 'connector']) assert.equal((await upload({ source }, { token: bob })).status, 200, source);
  assert.equal((await upload({ source: 'chat' }, AGENT)).status, 200);
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
