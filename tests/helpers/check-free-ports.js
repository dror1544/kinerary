/**
 * Run once before the suite (npm `pretest`): is any port the tests bind
 * already held? A leaked server from an earlier or other-worktree run is
 * named here, in the first second, instead of as nine EADDRINUSE failures
 * half an hour in. See helpers/port-guard.js.
 */
import { PORTS } from './ports.js';
import { findBusyPorts, describeBusyPorts } from './port-guard.js';

const busy = await findBusyPorts(PORTS);
if (busy.length > 0) {
  console.error(describeBusyPorts(busy));
  process.exit(1);
}
