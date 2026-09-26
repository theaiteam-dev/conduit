/**
 * Stand-in kernel for the signal containment tests (./process-group.test.ts).
 *
 *   bun containment-signal-runner.ts <deterministic|harness> <projectRoot> [exit]
 *
 * Runs the containment fixture (./containment-fixture.sh) through the named
 * runner with a timeout far longer than any test, so only the kernel's own
 * signal or exit handling can end the station. Prints `ready` once the fixture
 * has recorded its grandchild's pid, by which point the runner has registered
 * the group. With `exit`, it then calls process.exit(0) mid-station.
 *
 * This file is not a test file. Bun only runs it when a test spawns it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runDeterministic } from './deterministic';
import { runHarnessProcess } from './harness-runner';

const [runner, projectRoot, mode] = process.argv.slice(2);
if ((runner !== 'deterministic' && runner !== 'harness') || projectRoot === undefined) {
  console.error('usage: containment-signal-runner.ts <deterministic|harness> <projectRoot> [exit]');
  process.exit(2);
}

const fixture = join(import.meta.dir, 'containment-fixture.sh');
const timeoutMs = 600_000;

const poll = setInterval(() => {
  if (!existsSync(join(projectRoot, 'containment.pid'))) return;
  clearInterval(poll);
  console.log('ready');
  if (mode === 'exit') process.exit(0);
}, 20);

if (runner === 'deterministic') {
  await runDeterministic({ command: fixture, args: [] }, { allowlist: [fixture], cwd: projectRoot, timeoutMs });
} else {
  await runHarnessProcess({ command: fixture, args: [] }, { projectRoot, timeoutMs });
}
// A fixture that never recorded its pid leaves the poll running, which would
// keep this process alive after the station returned.
clearInterval(poll);
console.log('station returned');
