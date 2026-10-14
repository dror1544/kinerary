/**
 * port-guard.js — name whoever holds a test port, before a test trips over it.
 *
 * The suite's servers bind fixed ports (helpers/ports.js). A server that
 * outlived its test run — parent gone, usually from another worktree's
 * aborted preflight — keeps its port for good, and the next run's tests then
 * die with EADDRINUSE: nine of them in one file, 30 minutes into a
 * preflight, none of them naming the process responsible.
 *
 * Two defences, both here:
 *   - assertPortFree(): the server and MCP helpers call it before spawning,
 *     so one test fails in a second with the holder's pid, command and
 *     working directory, and the command that clears it.
 *   - findBusyPorts()/describeBusyPorts(): check-free-ports.js runs it once
 *     before the whole run (npm `pretest`), so the leak is named before any
 *     test starts.
 * And freePort() lets a test that does not need a known port take whatever is
 * free instead, which cannot collide with a leak at all.
 *
 * A held port is looked up with lsof (macOS and most Linux), which also
 * names the holder. Where lsof is missing, a bind probe still detects the
 * port in use; the message then says it could not name the holder.
 */
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { PORTS } from './ports.js';

const sh = (bin, args) => {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';          // not installed, or nothing matched (lsof exits 1)
  }
};

/** pids listening on the TCP port, per lsof; [] if none or lsof is absent. */
function listenerPids(port) {
  const out = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  return [...new Set(out.split('\n').filter(l => l.startsWith('p')).map(l => Number(l.slice(1))))]
    .filter(Number.isInteger);
}

/** `{ pid, command, cwd }` for a process, best effort. */
function processInfo(pid) {
  const command = sh('ps', ['-o', 'command=', '-p', String(pid)]).trim() || '(command unknown)';
  const cwdOut = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const cwd = (cwdOut.split('\n').find(l => l.startsWith('n')) || '').slice(1) || null;
  return { pid, command, cwd };
}

/** Can this process bind the port, on the given host (default: wildcard)? */
function canBind(port, host) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** Everything known about who holds the port, or null if it is free. */
async function inspectPort(port) {
  const pids = listenerPids(port);
  if (pids.length > 0) return { port, holders: pids.map(processInfo) };
  if (!(await canBind(port)) || !(await canBind(port, '127.0.0.1'))) return { port, holders: [] };
  return null;
}

function holderText({ port, holders }) {
  if (holders.length === 0) {
    return [`  port ${port} is in use, but the holder could not be named (is lsof installed?).`];
  }
  return holders.flatMap(h => [
    `  port ${port} is held by pid ${h.pid}: ${h.command}`,
    ...(h.cwd ? [`    working directory: ${h.cwd}`] : []),
  ]);
}

const remedy = pids => pids.length > 0
  ? `  Remedy: it is a leaked test server (or something else of yours). Stop it with: kill ${pids.join(' ')}`
  : '  Remedy: find the process with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and stop it.';

/**
 * Resolve if the port is free; otherwise reject with the holder named.
 *
 * `waitMs` is a grace window, not a retry loop for real conflicts: a file
 * that stops one server and starts the next on the same port (describe after
 * describe) has the old process still shutting down for a moment. A holder
 * that is still there after it is a leak.
 */
export async function assertPortFree(port, { name, waitMs = 3000 } = {}) {
  name ??= Object.entries(PORTS).find(([, p]) => p === Number(port))?.[0];
  const deadline = Date.now() + waitMs;
  let found;
  for (;;) {
    found = await inspectPort(Number(port));
    if (!found || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!found) return;
  throw new Error([
    `Test port ${port}${name ? ` (${name})` : ''} is already in use, so the server a test is about to start would die with EADDRINUSE.`,
    ...holderText(found),
    remedy(found.holders.map(h => h.pid)),
  ].join('\n'));
}

/** The entries of a { name: port } table that something already holds. */
export async function findBusyPorts(table) {
  const busy = [];
  for (const [name, port] of Object.entries(table)) {
    const found = await inspectPort(Number(port));
    if (found) busy.push({ name, ...found });
  }
  return busy;
}

export function describeBusyPorts(busy) {
  const pids = [...new Set(busy.flatMap(b => b.holders.map(h => h.pid)))];
  return [
    `${busy.length} test port(s) are already in use before the run started:`,
    ...busy.flatMap(b => [`  ${b.name}:`, ...holderText(b).map(l => `  ${l}`)]),
    remedy(pids),
  ].join('\n');
}

/**
 * A port nobody holds right now, for a server that does not need a known one.
 * Bound on the wildcard address like the servers are, then released: there is
 * a window before the caller binds it, milliseconds wide.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
