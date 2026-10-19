/**
 * Run once before the suite (npm `pretest`): are the dependencies installed,
 * and is any port the tests bind already held? A leaked server from an earlier
 * or other-worktree run is named here, in the first second, instead of as nine
 * EADDRINUSE failures half an hour in. See helpers/port-guard.js.
 *
 * Dependencies first: in a worktree that never had `npm ci`, the tests do not
 * fail, they are cancelled (helpers/required-deps.js). `argv[2]` overrides the
 * repository root, for tests/port-guard.test.js only.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingDeps, describeMissingDeps } from './required-deps.js';

const root = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const missingDeps = findMissingDeps(root);
if (missingDeps.length > 0) {
  console.error(describeMissingDeps(missingDeps));
  process.exit(1);
}

// Imported only now: ports.js is cheap, but nothing below should run in a tree
// that cannot run the suite anyway.
const { PORTS } = await import('./ports.js');
const { findBusyPorts, describeBusyPorts } = await import('./port-guard.js');

const busy = await findBusyPorts(PORTS);
if (busy.length > 0) {
  console.error(describeBusyPorts(busy));
  process.exit(1);
}
