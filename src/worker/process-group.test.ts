/**
 * Tests for the live station group registry (./process-group.ts).
 *
 * Both runners spawn detached, so a Ctrl-C at the terminal reaches only the
 * kernel. These tests prove that a kernel which receives SIGINT or SIGTERM, or
 * calls process.exit() mid-station, still takes the station's process group
 * with it, and that the handlers exist only while a group is live.
 *
 * The end-to-end tests spawn ./containment-signal-runner.ts as a real kernel
 * stand-in and signal that process by its own pid. Cleanup kills recorded
 * single pids only, never a group.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINATING_SIGNALS, trackProcessGroup, untrackProcessGroup } from './process-group';
import { expectGrandchildReaped, killRecordedGrandchild, recordedPid } from './harness-containment.conformance';

const RUNNER_SCRIPT = join(import.meta.dir, 'containment-signal-runner.ts');
const READY_BUDGET_MS = 10_000;
const EXIT_BUDGET_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function listenerCounts(): number[] {
  return [...TERMINATING_SIGNALS.map((s) => process.listenerCount(s)), process.listenerCount('exit')];
}

describe('process-group registry: handlers exist only while a group is live', () => {
  // A pid far above any real one: tracking never signals it, and the test
  // untracks before anything could.
  const FAKE_PID = 2_147_000_000;

  it('installs the signal and exit handlers on the first tracked group and removes them when the last is untracked', () => {
    const baseline = listenerCounts();

    trackProcessGroup(FAKE_PID);
    trackProcessGroup(FAKE_PID + 1);
    expect(listenerCounts()).toEqual(baseline.map((n) => n + 1));

    untrackProcessGroup(FAKE_PID);
    expect(listenerCounts()).toEqual(baseline.map((n) => n + 1));

    untrackProcessGroup(FAKE_PID + 1);
    expect(listenerCounts()).toEqual(baseline);
  });

  it('kills live groups and leaves termination to another listener when one exists', async () => {
    // A real detached group, so the kill is observable. Its pid is its group id.
    const sleeper = Bun.spawn(['sleep', '30'], { detached: true, stdout: 'ignore', stderr: 'ignore' });
    const baseline = listenerCounts();
    let calls = 0;
    const other = () => {
      calls += 1;
    };
    process.on('SIGINT', other);
    try {
      trackProcessGroup(sleeper.pid);
      process.emit('SIGINT', 'SIGINT');

      await sleeper.exited;
      expect(sleeper.signalCode).toBe('SIGKILL');
      // Our handler removed itself. A re-raise would have reached `other` a
      // second time, asynchronously, so give it the chance to show up.
      await sleep(200);
      expect(calls).toBe(1);
      expect(process.listenerCount('SIGINT')).toBe(baseline[0]! + 1);
      expect(process.listenerCount('exit')).toBe(baseline[3]!);
    } finally {
      process.off('SIGINT', other);
      untrackProcessGroup(sleeper.pid);
      try {
        process.kill(sleeper.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
});

describe('process-group registry: the kernel takes live station groups with it', () => {
  let projectRoot: string;
  let kernel: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-signal-')));
    kernel = undefined;
  });

  afterEach(() => {
    if (kernel !== undefined) {
      try {
        process.kill(kernel.pid, 'SIGKILL');
      } catch {
        /* already gone: the expected case */
      }
    }
    killRecordedGrandchild(projectRoot);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Spawn the stand-in kernel and wait until its station's grandchild is running. */
  async function startKernel(runner: 'deterministic' | 'harness', mode?: 'exit'): Promise<void> {
    kernel = Bun.spawn(['bun', RUNNER_SCRIPT, runner, projectRoot, ...(mode ? [mode] : [])], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const deadline = Date.now() + READY_BUDGET_MS;
    while (recordedPid(projectRoot) === undefined && Date.now() < deadline) {
      await sleep(20);
    }
    expect(recordedPid(projectRoot)).toBeDefined();
  }

  async function waitForKernelExit(): Promise<void> {
    const exited = await Promise.race([kernel!.exited.then(() => true), sleep(EXIT_BUDGET_MS).then(() => false)]);
    expect(exited).toBe(true);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`deterministic: ${signal} to the kernel kills the station's grandchild and keeps the default outcome`, async () => {
      await startKernel('deterministic');
      process.kill(kernel!.pid, signal);
      await waitForKernelExit();

      // The re-raised signal terminated the kernel, as it would with no handler.
      expect(kernel!.signalCode).toBe(signal);
      expect(await new Response(kernel!.stdout).text()).not.toContain('station returned');
      await expectGrandchildReaped(projectRoot);
    }, TEST_TIMEOUT_MS);
  }

  it('harness: SIGINT to the kernel kills the station grandchild and keeps the default outcome', async () => {
    await startKernel('harness');
    process.kill(kernel!.pid, 'SIGINT');
    await waitForKernelExit();

    expect(kernel!.signalCode).toBe('SIGINT');
    await expectGrandchildReaped(projectRoot);
  }, TEST_TIMEOUT_MS);

  it('deterministic: process.exit() mid-station kills the station grandchild', async () => {
    await startKernel('deterministic', 'exit');
    await waitForKernelExit();

    expect(kernel!.exitCode).toBe(0);
    await expectGrandchildReaped(projectRoot);
  }, TEST_TIMEOUT_MS);
});
