import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { startTestServer, stopTestServer, api, loginAsAlice } from './helpers/server.js';
import { PORTS } from './helpers/ports.js';
let owner, member;
before(async () => {
  await startTestServer({ PORT: PORTS.companionConversation, HERMES_API_KEY: 'conversation-test-agent' });
  owner = await loginAsAlice();
  member = (await (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: '1234' } })).json()).token;
});
after(() => stopTestServer());
const agent = (path, body) => api(path, { ...(body ? { method: 'POST', body } : {}), apiKey: 'conversation-test-agent' });
test('shared questions persist, agent replies clear inbox, member cannot impersonate bot', async () => {
  assert.equal((await api('/api/companion/conversation')).status, 401);
  assert.equal((await (await api('/api/companion/conversation', { token: member })).json()).inbox_active, false);
  const sent = await api('/api/companion/conversation', { token: member, method: 'POST', body: { text: 'Can we have a slower morning?', author: 'companion', kind: 'reply' } });
  assert.equal(sent.status, 201);
  const question = await sent.json(); assert.equal(question.author, 'bob'); assert.equal(question.kind, 'question');
  for (const token of [member, owner]) {
    assert.equal((await api('/api/agent/companion/inbox', { token })).status, 403);
    assert.equal((await api('/api/agent/companion/messages', { token, method: 'POST', body: { text: 'fake', kind: 'reply', reply_to: question.id } })).status, 403);
  }
  assert.equal((await (await agent('/api/agent/companion/inbox')).json()).messages.length, 1);
  const reply = await agent('/api/agent/companion/messages', { text: 'Yes, shall we move breakfast?', kind: 'reply', reply_to: question.id });
  assert.equal(reply.status, 201);
  assert.equal((await agent('/api/agent/companion/messages', { text: 'duplicate', kind: 'reply', reply_to: question.id })).status, 200);
  assert.equal((await (await agent('/api/agent/companion/inbox')).json()).messages.length, 0);
  const feed = await (await api('/api/companion/conversation', { token: member })).json();
  assert.equal(feed.inbox_active, true);
  assert.equal(feed.messages.length, 2); assert.equal(feed.messages[0].answered, 1);
  assert.equal((await agent('/api/agent/companion/messages', { text: 'wrong trip', kind: 'reply', reply_to: 'foreign' })).status, 404);
});
test('connection secrets stay organizer-only and group feed is explicitly published', async () => {
  const binding_command = '/group abcdefghijklmnopqrstuvwxyz';
  assert.equal((await agent('/api/agent/companion/connection', { group_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await agent('/api/agent/companion/connection', { group_url: 'https://t.me/+example', bot_username: 'trip_bot', binding_command, binding_expires_at: new Date(Date.now() + 60000).toISOString() })).status, 200);
  assert.equal((await api('/api/companion/connection', { token: member })).status, 403);
  assert.equal((await api('/api/companion/connection')).status, 401);
  assert.equal((await (await api('/api/companion/connection', { token: owner })).json()).binding_command, binding_command);
  assert.equal((await agent('/api/agent/companion/messages', { kind: 'group_update', text: 'Meet at 9.' })).status, 201);
  const feed = await (await api('/api/companion/conversation', { token: member })).json();
  assert.equal(feed.latest_update.text, 'Meet at 9.'); assert.ok(!JSON.stringify(feed).includes('abcdefghijklmnopqrstuvwxyz'));
  assert.equal((await agent('/api/agent/companion/connection', {})).status, 200);
  assert.equal((await (await api('/api/companion/connection', { token: owner })).json()).binding_command, null);
});
test('rejects empty or oversized messages and bounds pending work', async () => {
  for (const text of ['', '   ', 'a'.repeat(2001)]) assert.equal((await api('/api/companion/conversation', { token: member, method: 'POST', body: { text } })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await api('/api/companion/conversation', { token: member, method: 'POST', body: { text: `Idea ${i}` } })).status, 201);
  assert.equal((await api('/api/companion/conversation', { token: member, method: 'POST', body: { text: 'more' } })).status, 429);
});
