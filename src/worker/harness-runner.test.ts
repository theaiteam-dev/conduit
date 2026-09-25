/**
 * Harness process runner (WI-561).
 *
 * The runner is the blast-radius floor at the process boundary (NFR-Security-6)
 * and the FR-7 timeout mechanism: it spawns a harness CLI as a child, bounds it
 * by a wall-clock timeout, kills the WHOLE process TREE (process group, not a
 * lone pid) on expiry, and forces the child's cwd to live inside the project
 * root. These are REAL-subprocess behavioral tests — they spawn `sh`, observe
 * exit codes / streams / timing, and (critically) prove a grandchild is reaped.
 *
 * ACs covered:
 *   1. completes-before-timeout → exit code + stdout/stderr + measured duration.
 *   2. exceeds-timeout → distinct timedOut result (NOT a normal non-zero exit) +
 *      elapsed duration.
 *   3. a child that spawns a grandchild is FULLY reaped on timeout — the recorded
 *      grandchild pid is dead afterward (process-GROUP kill, not child.kill).
 *   4. cwd is set inside the project root; a cwd resolving OUTSIDE it is rejected.
 *   5. (#17) a grandchild backgrounded by a harness that exits on its own (0 or
 *      nonzero, well before the timeout) is reaped too, and does not stall the
 *      output drains: the runner returns promptly with the output written
 *      before the exit, not at timeoutMs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHarnessProcess,
  type HarnessRunnerConfig,
} from './harness-runner';
import { describeContainmentConformance } from './harness-containment.conformance';

// ---------------------------------------------------------------------------
// Fixtures: an isolated project root per test + tracked pids for cleanup so a
// WRONG (single-child.kill) implementation cannot leak a 30s `sleep` orphan.
// ---------------------------------------------------------------------------

let projectRoot: string;
let outsideDir: string;
const spawnedGrandchildPids: number[] = [];

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-harness-root-')));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-harness-outside-')));
});

afterEach(() => {
  // Defensive reaping: if the runner failed to group-kill, don't leak orphans.
  for (const pid of spawnedGrandchildPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone — the expected case */
    }
  }
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

/** True while `pid` is alive (signal 0 probes existence without delivering a signal). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone or the budget elapses; returns whether it died. */
async function waitForPidGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

function config(over: Partial<HarnessRunnerConfig> = {}): HarnessRunnerConfig {
  return { projectRoot, timeoutMs: 5_000, ...over };
}

// ---------------------------------------------------------------------------
// AC1 — completes before the timeout.
// ---------------------------------------------------------------------------

describe('harness runner: completes before timeout (AC1)', () => {
  it('returns exit code 0, captured stdout/stderr, and a measured wall-clock duration', async () => {
    const result = await runHarnessProcess(
      // Emit to both streams, take a measurable ~200ms, then exit 0.
      { command: 'sh', args: ['-c', 'printf out; printf err 1>&2; sleep 0.2; exit 0'] },
      config({ timeoutMs: 5_000 }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.timedOut).toBe(false);
    // Duration is REAL: the ~200ms sleep is reflected, and it is well under the timeout.
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('reports a NON-ZERO exit as an ordinary failure, distinct from a timeout (AC2 negative)', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', 'exit 3'] },
      config({ timeoutMs: 5_000 }),
    );

    // A plain non-zero exit is NOT a timeout — the discriminator is `timedOut`.
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — exceeds the wall-clock timeout.
// ---------------------------------------------------------------------------

describe('harness runner: exceeds timeout (AC2)', () => {
  it('terminates on timeout, flags timedOut, and returns the elapsed (not the full sleep) duration', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', 'sleep 30'] },
      config({ timeoutMs: 400 }),
    );

    // Distinct timed-out result — NOT reported as a normal non-zero exit.
    expect(result.timedOut).toBe(true);
    // Elapsed is bounded by the timeout, proving it did not wait the full 30s.
    expect(result.durationMs).toBeGreaterThanOrEqual(350);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a grandchild is fully reaped on timeout (process-GROUP kill).
// ---------------------------------------------------------------------------

describe('harness runner: process-group reaping (AC3)', () => {
  it('reaps a grandchild subprocess on timeout — no orphan survives a single child.kill', async () => {
    const pidFile = join(projectRoot, 'grandchild.pid');

    // The child shell backgrounds a `sleep 30` GRANDCHILD, records the grandchild
    // pid ($!), then blocks in `wait`. Both outlive the 500ms timeout. A lone
    // child.kill would leave the backgrounded `sleep` reparented to init and
    // ALIVE; only a process-GROUP kill reaps it.
    const result = await runHarnessProcess(
      {
        command: 'sh',
        args: ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`],
      },
      config({ timeoutMs: 500 }),
    );

    expect(result.timedOut).toBe(true);

    // The grandchild recorded its pid before blocking; read it back.
    expect(existsSync(pidFile)).toBe(true);
    const grandchildPid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(grandchildPid).toBeGreaterThan(1);
    spawnedGrandchildPids.push(grandchildPid); // afterEach cleans up if this fails

    // AC3: after group-kill the grandchild must be gone. A single child.kill
    // implementation leaves it alive for the full 30s and fails here.
    const died = await waitForPidGone(grandchildPid, 3_000);
    expect(died).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — cwd is confined to the project root.
// ---------------------------------------------------------------------------

describe('harness runner: cwd confined to project root (AC4)', () => {
  it('runs the child in a cwd inside the project root', async () => {
    const subdir = join(projectRoot, 'work');
    mkdirSync(subdir);

    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', 'pwd -P'] },
      config({ cwd: subdir }),
    );

    expect(result.exitCode).toBe(0);
    // The child actually executed in the requested subdir of the project root.
    expect(result.stdout.trim()).toBe(realpathSync(subdir));
  });

  it('defaults the cwd to the project root when none is supplied', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', 'pwd -P'] },
      config(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(projectRoot);
  });

  it.each([
    ['a sibling directory', () => outsideDir],
    ['a parent-escaping traversal', () => join(projectRoot, '..')],
    ['an unrelated absolute path', () => '/etc'],
  ])('rejects a cwd outside the project root: %s', async (_label, resolveCwd) => {
    await expect(
      runHarnessProcess(
        { command: 'sh', args: ['-c', 'pwd'] },
        config({ cwd: resolveCwd() }),
      ),
    ).rejects.toThrow(/project root|outside/i);
  });
});

// ---------------------------------------------------------------------------
// AC2 regression — the timeout/natural-exit BOUNDARY race (Amy repro).
//
// A child that finishes just under the deadline can cause the timeout timer to
// still fire (its SIGKILL to the group being a harmless no-op on the already
// exited process). A `timedOut` derived from a mutable flag set INSIDE that
// timer callback then races the exit and wrongly reports timedOut:true ALONGSIDE
// a real exit code 0 (~5% of runs — Amy measured 16/300 at the boundary). The
// correct derivation reads proc.signalCode AFTER proc.exited resolves: a
// naturally exited process never carries a SIGKILL signalCode, no matter how the
// timer and exit interleave. This stress test hammers that boundary so the flag
// race cannot slip back in as a regression.
// ---------------------------------------------------------------------------

describe('harness runner: timeout/natural-exit boundary race (AC2 regression)', () => {
  it('never reports a naturally-completed run as timed out across 300 boundary iterations', async () => {
    const ITERATIONS = 300;
    const timeoutMs = 50;
    // Sleep ~90% of the timeout: the child reliably exits 0, but sits close
    // enough to the deadline that the timeout timer routinely fires — the exact
    // interleaving that surfaced the flag-race bug.
    const sleepSeconds = ((timeoutMs * 0.9) / 1000).toFixed(3); // '0.045'

    // Collect every violation so a failure names how often and how it broke,
    // rather than aborting on the first (a 1/300 flake vs a systemic regression
    // read very differently).
    const falseTimeouts: Array<{ iter: number; exitCode: number; durationMs: number }> = [];
    const nonZeroExits: Array<{ iter: number; exitCode: number; timedOut: boolean }> = [];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const result = await runHarnessProcess(
        { command: 'sh', args: ['-c', `sleep ${sleepSeconds}; exit 0`] },
        config({ timeoutMs }),
      );
      // The bug signature: a run that exited 0 but was flagged timedOut.
      if (result.timedOut) {
        falseTimeouts.push({ iter, exitCode: result.exitCode, durationMs: result.durationMs });
      }
      if (result.exitCode !== 0) {
        nonZeroExits.push({ iter, exitCode: result.exitCode, timedOut: result.timedOut });
      }
    }

    // Every iteration completed naturally (exit 0) — the child only ever sleeps
    // then `exit 0`, so a non-zero code would mean the timer SIGKILLed a live
    // process, which must not happen when it finishes under the deadline.
    expect(nonZeroExits).toEqual([]);
    // And not one of those natural completions was mislabeled as a timeout.
    expect(falseTimeouts).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// stdoutLineFilter — keep the events we read, discard the transcript.
// ---------------------------------------------------------------------------

describe('harness runner: stdout line filter', () => {
  const keepResult = (line: string) => line.includes('"type":"result"');

  it('retains only matching lines and drops the rest', async () => {
    const result = await runHarnessProcess(
      {
        command: 'sh',
        args: ['-c', 'printf \'{"type":"assistant"}\\n{"type":"result","ok":1}\\n{"type":"tool"}\\n\''],
      },
      config({ timeoutMs: 5_000, stdoutLineFilter: keepResult }),
    );

    expect(result.stdout).toBe('{"type":"result","ok":1}');
  });

  it('notifies progress for every line, including lines discarded by the filter', async () => {
    const lines: string[] = [];
    const result = await runHarnessProcess(
      {
        command: 'sh',
        args: ['-c', 'printf \'{"type":"assistant"}\\n{"type":"result","ok":1}\\n{"type":"tool"}\\n\''],
      },
      config({
        timeoutMs: 5_000,
        stdoutLineFilter: keepResult,
        onStdoutLine: (line) => lines.push(line),
      }),
    );

    expect(lines).toEqual(['{"type":"assistant"}', '{"type":"result","ok":1}', '{"type":"tool"}']);
    expect(result.stdout).toBe('{"type":"result","ok":1}');
  });

  it('keeps a final line with no trailing newline — a crashed stream rarely has one', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', 'printf \'{"type":"noise"}\\n{"type":"result","ok":2}\''] },
      config({ timeoutMs: 5_000, stdoutLineFilter: keepResult }),
    );

    expect(result.stdout).toBe('{"type":"result","ok":2}');
  });

  it('notifies progress for a final line with no trailing newline', async () => {
    const lines: string[] = [];
    await runHarnessProcess(
      { command: 'sh', args: ['-c', 'printf \'partial\''] },
      config({ timeoutMs: 5_000, onStdoutLine: (line) => lines.push(line) }),
    );

    expect(lines).toEqual(['partial']);
  });

  it('does not hold the discarded bulk — the point of filtering at all', async () => {
    // A stream-json run that merely read two files measured 57KB against a 2KB
    // result event, and that ratio grows with every tool call across a station
    // that can run 8-17 minutes. Here ~2MB of transcript is thrown away while
    // the one line we need survives intact.
    const result = await runHarnessProcess(
      {
        command: 'sh',
        args: [
          '-c',
          'i=0; while [ $i -lt 2000 ]; do printf \'{"type":"assistant","text":"%01000d"}\\n\' $i; i=$((i+1)); done; printf \'{"type":"result","ok":3}\\n\'',
        ],
      },
      config({ timeoutMs: 20_000, stdoutLineFilter: keepResult }),
    );

    expect(result.stdout).toBe('{"type":"result","ok":3}');
    expect(result.stdout.length).toBeLessThan(200);
  });

  it('reassembles a line split across chunk boundaries', async () => {
    // Large lines arrive in several reads; a naive per-chunk split would lose
    // or corrupt the event straddling the boundary.
    // Built inside the child: a 200KB literal in argv exceeds the exec limit.
    const result = await runHarnessProcess(
      {
        command: 'sh',
        args: [
          '-c',
          'printf \'{"type":"result","pad":"\'; head -c 200000 /dev/zero | tr \'\\0\' \'x\'; printf \'"}\\n\'',
        ],
      },
      config({ timeoutMs: 20_000, stdoutLineFilter: keepResult }),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ type: 'result' });
  });

  it('buffers everything when no filter is given (unchanged default)', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', 'printf \'a\\nb\\n\''] },
      config({ timeoutMs: 5_000 }),
    );

    expect(result.stdout).toBe('a\nb\n');
  });
});

// ---------------------------------------------------------------------------
// Containment conformance (issue #17, mirroring runDeterministic). The runner
// spawns the harness as its own process group and must SIGKILL the group after
// the leader exits, not only on timeout, so the fixture's grandchild dies on
// every exit path.
// ---------------------------------------------------------------------------

/** Test-local label for `result.timedOut === true`. HarnessSpawnResult carries a boolean. */
const HARNESS_RUNNER_TIMEOUT_LABEL = 'timedOut';

describeContainmentConformance(
  'harness-runner',
  async ({ projectRoot, fixture, timeoutMs, fixtureArgs }) => {
    const result = await runHarnessProcess(
      { command: fixture, args: fixtureArgs },
      { projectRoot, timeoutMs },
    );
    return result.timedOut === true ? HARNESS_RUNNER_TIMEOUT_LABEL : undefined;
  },
  { timeoutClass: HARNESS_RUNNER_TIMEOUT_LABEL, reapsOnExit: true },
);

// ---------------------------------------------------------------------------
// #17: a descendant that keeps the inherited stdout/stderr pipes open. The
// conformance fixture above sends its grandchild's stdio to /dev/null, so it
// proves reaping but not the drain stall; this script does not redirect, so a
// surviving grandchild would keep `Promise.all`'s drains pending until
// timeoutMs. The post-exit group kill must close the pipes so the runner
// returns promptly, and output written before the exit must still be captured.
// ---------------------------------------------------------------------------

describe('runHarnessProcess: descendants holding the output pipes (#17)', () => {
  /** Grandchild pids a test recorded; afterEach SIGKILLs any that survived. */
  const recorded: number[] = [];

  afterEach(() => {
    // Single pids only, never a group: a leaked grandchild of an undetached
    // spawn shares the test runner's process group.
    for (const pid of recorded.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone: the expected case */
      }
    }
  });

  /**
   * A script that writes to stdout and stderr, backgrounds a `sleep 30` that
   * inherits both pipes, records its pid, then exits with `tail`.
   */
  function pipeHoldingScript(tail: string): string {
    const script = join(projectRoot, 'hold.sh');
    writeFileSync(
      script,
      ['echo before-out', 'echo before-err >&2', 'sleep 30 &', 'echo "$!" > grandchild.pid', tail, ''].join('\n'),
    );
    return script;
  }

  function grandchildPid(): number {
    const pid = Number(readFileSync(join(projectRoot, 'grandchild.pid'), 'utf-8').trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    recorded.push(pid);
    return pid;
  }

  for (const [label, code] of [
    ['exits 0', 0],
    ['exits nonzero', 4],
  ] as const) {
    it(`returns promptly with the output written before it ${label}, and the grandchild is gone`, async () => {
      const script = pipeHoldingScript(`exit ${code}`);
      const start = Date.now();
      // A generous timeout the fix must beat by a wide margin: without the
      // post-exit group kill, the drains wait out the full 30s sleep instead.
      const result = await runHarnessProcess({ command: 'sh', args: [script] }, config({ timeoutMs: 60_000 }));
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10_000);
      expect(result.exitCode).toBe(code);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe('before-out\n');
      expect(result.stderr).toBe('before-err\n');
      expect(await waitForPidGone(grandchildPid(), 3_000)).toBe(true);
    }, 40_000);
  }
});

// ---------------------------------------------------------------------------
// A `stdoutLineFilter` that throws before `proc.exited` resolves. The filter
// runs inside `readKeptLines`'s `for await` loop as lines arrive, so a filter
// that throws on an early line rejects the stdout drain promise while the
// child is still running (the `sleep` below keeps `proc.exited` pending).
// Before the fix, that promise had no handler attached until after the
// process-group kill, so the rejection could go unhandled in the gap; bun:test
// treats an unhandled rejection as a failure independent of what this function
// returns.
// ---------------------------------------------------------------------------

describe('runHarnessProcess: a throwing stdoutLineFilter does not produce an unhandled rejection', () => {
  it('rejects with the filter error, and the drain rejection is never unhandled', async () => {
    const filterError = new Error('stdoutLineFilter boom');
    const throwingFilter = (): boolean => {
      throw filterError;
    };

    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await expect(
        runHarnessProcess(
          // Prints a line immediately (the filter throws on it), then keeps the
          // process alive briefly so proc.exited has not resolved yet when the
          // filter throws.
          { command: 'sh', args: ['-c', 'echo x; sleep 1'] },
          config({ timeoutMs: 5_000, stdoutLineFilter: throwingFilter }),
        ),
      ).rejects.toBe(filterError);

      // Let the event loop settle so a rejection that only becomes unhandled
      // after this test's assertions (e.g. once the group kill finally runs)
      // has had a chance to fire the listener above.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(unhandled).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
