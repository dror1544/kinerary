// The URL and credential belong to this runtime's deployment, never the caller.
// No endpoint accepts a profile, chat ID, URL, command, or raw job definition.
function registerCompanionControl({ app, authRequired, organizerOrAgentRequired, fetchImpl, baseUrl = process.env.COMPANION_CONTROL_URL, token = process.env.COMPANION_CONTROL_TOKEN }) {
  const read = async (body) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/tasks`, {
      method: body ? 'POST' : 'GET', timeout: 8000,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { const error = new Error('companion_unavailable'); error.status = response.status === 404 ? 404 : response.status === 409 ? 409 : 503; throw error; }
    const state = await response.json();
    if (!Array.isArray(state.tasks) || typeof state.scheduler_running !== 'boolean') throw new Error('invalid_companion_response');
    // Only explicit product fields cross into the browser. Never spread jobs.
    return { available: true, scheduler_running: state.scheduler_running, tasks: state.tasks.map(task => ({
      id: task.id, label: { he: task.label?.he, en: task.label?.en }, audience: task.audience,
      enabled: task.enabled === true, schedule: task.schedule, timezone: task.timezone, next_run: task.next_run,
    })) };
  };
  app.get('/api/companion/tasks', organizerOrAgentRequired, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!baseUrl || !token) return res.json({ available: false, scheduler_running: false, tasks: [] });
    try { res.json(await read()); } catch { res.status(503).json({ error: 'companion_unavailable' }); }
  });
  app.post('/api/companion/tasks/:id', organizerOrAgentRequired, async (req, res) => {
    if (!['pause', 'resume', 'run'].includes(req.body?.action) || typeof req.params.id !== 'string' || req.params.id.length > 200) return res.status(400).json({ error: 'invalid_task_action' });
    if (!baseUrl || !token) return res.status(503).json({ error: 'companion_unavailable' });
    try { res.json(await read({ id: req.params.id, action: req.body.action })); }
    catch (error) { res.status(error.status || 503).json({ error: error.status === 409 ? 'task_change_refused' : 'companion_unavailable' }); }
  });
}
module.exports = { registerCompanionControl };
