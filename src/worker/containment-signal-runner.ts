/**
 * Stand-in kernel for the signal containment tests (./process-group.test.ts).
 *
 *   bun containment-signal-runner.ts <deterministic|harness> <projectRoot> [exit]
 *
 * Runs the containment fixture (./containment-fixture.sh) through the named
 * runner with a timeout far longer than any test, so only the kernel's own
 * signal or exit handling can end the station. Prints `ready` once the
 * fixture has recorded every grandchild it will ever record: the plain one
 * always, and the setsid one too wherever this host requires cgroup
 * containment (the same `requiresSetsidContainment` the conformance suite
 * uses), since that is exactly what `expectGrandchildReaped` will demand
 * back in the test. Printing `ready` (and, with `exit`, calling
 * process.exit(0)) any earlier risks the setsid grandchild never having been
 * spawned at all — the fixture kills the whole cgroup on exit, so a runner
 * that exits before the fixture reaches its `setsid -f` line leaves that pid
 * file empty forever, not merely reaped late (issue #77 flake).
 *
 * This file is not a test file. Bun only runs it when a test spawns it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runDeterministic } from './deterministic';
import { runHarnessProcess } from './harness-runner';
import { requiresSetsidContainment } from './harness-containment.conformance';

const [runner, projectRoot, mode] = process.argv.slice(2);
if ((runner !== 'deterministic' && runner !== 'harness') || projectRoot === undefined) {
  console.error('usage: containment-signal-runner.ts <deterministic|harness> <projectRoot> [exit]');
  process.exit(2);
}

const fixture = join(import.meta.dir, 'containment-fixture.sh');
const timeoutMs = 600_000;

function grandchildrenRecorded(): boolean {
  if (!existsSync(join(projectRoot, 'containment.pid'))) return false;
  if (requiresSetsidContainment && !existsSync(join(projectRoot, 'containment.setsid.pid'))) return false;
  return true;
}

const poll = setInterval(() => {
  if (!grandchildrenRecorded()) return;
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
