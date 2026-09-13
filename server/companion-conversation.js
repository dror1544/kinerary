const { randomUUID } = require('crypto');

// This database belongs to one trip. Shared messages are intentionally visible
// to every authenticated member; private Telegram conversations are never imported.
function registerCompanionConversation({ app, db, authRequired, organizerOrAgentRequired }) {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_conversation (
    id TEXT PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL,
    kind TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS companion_inbox_status (
    id INTEGER PRIMARY KEY CHECK(id = 1), checked_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS companion_connection (
    id INTEGER PRIMARY KEY CHECK(id = 1), group_url TEXT, bot_username TEXT,
    binding_command TEXT, binding_expires_at TEXT, checked_at TEXT NOT NULL
  );`);
  const agentOnly = (req, res, next) => req.user.isAgent ? next() : res.status(403).json({ error: 'agent_required' });
  const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
  const insert = (author, text, kind, replyTo = null) => {
    const row = { id: randomUUID(), author, text: text.trim(), kind, reply_to: replyTo, created_at: new Date().toISOString() };
    db.prepare('INSERT INTO companion_conversation VALUES (@id,@author,@text,@kind,@reply_to,@created_at)').run(row);
    return row;
  };
  app.get('/api/companion/conversation', authRequired, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const connection = db.prepare('SELECT group_url, checked_at FROM companion_connection WHERE id=1').get() || null;
    const inboxCheck = db.prepare('SELECT checked_at FROM companion_inbox_status WHERE id=1').get();
    res.json({ connection, inbox_active: !!inboxCheck && Date.now() - Date.parse(inboxCheck.checked_at) < 10 * 60 * 1000,
      latest_update: db.prepare("SELECT * FROM companion_conversation WHERE kind='group_update' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() || null,
      messages: db.prepare("SELECT m.*, EXISTS(SELECT 1 FROM companion_conversation r WHERE r.reply_to=m.id) AS answered FROM companion_conversation m WHERE kind!='group_update' ORDER BY created_at DESC, rowid DESC LIMIT 50").all().reverse(),
    });
  });
  app.post('/api/companion/conversation', authRequired, (req, res) => {
    if (!validText(req.body?.text)) return res.status(400).json({ error: 'invalid_message' });
    // Bound outstanding work per member; retries cannot flood an offline bot.
    const pending = db.prepare("SELECT count(*) AS n FROM companion_conversation m WHERE author=? AND kind='question' AND NOT EXISTS(SELECT 1 FROM companion_conversation r WHERE r.reply_to=m.id)").get(req.user.username).n;
    if (pending >= 5) return res.status(429).json({ error: 'too_many_pending_messages' });
    res.status(201).json(insert(req.user.username, req.body.text, 'question'));
  });
  app.get('/api/agent/companion/inbox', authRequired, agentOnly, (_req, res) => {
    db.prepare('INSERT OR REPLACE INTO companion_inbox_status VALUES (1,?)').run(new Date().toISOString());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ messages: db.prepare("SELECT * FROM companion_conversation m WHERE kind='question' AND NOT EXISTS(SELECT 1 FROM companion_conversation r WHERE r.reply_to=m.id) ORDER BY created_at, rowid LIMIT 50").all() });
  });
  app.post('/api/agent/companion/messages', authRequired, agentOnly, (req, res) => {
    const { text, kind, reply_to: replyTo } = req.body || {};
    if (!validText(text) || !['reply', 'group_update'].includes(kind)) return res.status(400).json({ error: 'invalid_message' });
    if (kind === 'reply') {
      if (typeof replyTo !== 'string' || !db.prepare("SELECT id FROM companion_conversation WHERE id=? AND kind='question'").get(replyTo)) return res.status(404).json({ error: 'question_not_found' });
      const existing = db.prepare("SELECT * FROM companion_conversation WHERE reply_to=?").get(replyTo);
      if (existing) return res.json(existing);
    }
    res.status(201).json(insert('companion', text, kind, kind === 'reply' ? replyTo : null));
  });
  app.get('/api/companion/connection', organizerOrAgentRequired, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const row = db.prepare('SELECT * FROM companion_connection WHERE id=1').get();
    res.json({ organizer_bot_username: 'Kinerary_bot', binding_command: row && Date.parse(row.binding_expires_at) > Date.now() ? row.binding_command : null });
  });
  app.post('/api/agent/companion/connection', authRequired, agentOnly, (req, res) => {
    const { group_url = null, bot_username = null, binding_command = null, binding_expires_at = null } = req.body || {};
    if ((group_url !== null && (typeof group_url !== 'string' || !/^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]+|[A-Za-z0-9_]+)$/.test(group_url))) ||
        (bot_username !== null && (typeof bot_username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(bot_username))) ||
        (binding_command !== null && (typeof binding_command !== 'string' || !/^\/group KIN-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(binding_command) || typeof binding_expires_at !== 'string' || !(Date.parse(binding_expires_at) > Date.now())))) return res.status(400).json({ error: 'invalid_connection' });
    db.prepare('INSERT OR REPLACE INTO companion_connection VALUES (1,?,?,?,?,?)').run(group_url, bot_username, binding_command, binding_expires_at, new Date().toISOString());
    res.json({ ok: true });
  });
}
module.exports = { registerCompanionConversation };
