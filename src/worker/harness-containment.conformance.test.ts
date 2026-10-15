/**
 * Unit tests for `harnessAdapterSpawnPath` and the grandchild readiness helpers
 * (./harness-containment.conformance.ts).
 *
 * The conformance suite itself only registers `describe`/`it` blocks, so it
 * cannot be driven directly. This file tests the extracted spawn-path builder
 * in isolation with fake `HarnessAdapter` objects, without going through
 * `describeContainmentConformance` or spawning the fixture binary.
 *
 * This file does not call `describeHarnessContainmentConformance` itself:
 * `harness-containment-registry.test.ts` counts top-level calls in every
 * `*.test.ts` file and would otherwise count this file as covering an adapter
 * under a fake name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessInvocation, HarnessResult, BinaryProbe } from './harness-adapter';
import {
  HARNESS_TIMEOUT_CLASS,
  grandchildrenRunning,
  harnessAdapterSpawnPath,
  requiresSetsidContainment,
  waitForGrandchildrenRunning,
} from './harness-containment.conformance';
import { PID_FILE, SENTINEL_FILE, SETSID_PID_FILE, SETSID_SENTINEL_FILE } from './containment-fixture-files';

/** A minimal fake adapter whose `invoke` either resolves or rejects as scripted. */
function makeFake(name: string, run: (call: HarnessInvocation) => Promise<HarnessResult>): HarnessAdapter {
  return {
    name,
    reportsUsage: false,
    canRestrictTools: false,
    async probeBinary(): Promise<BinaryProbe> {
      return { present: true };
    },
    invoke: run,
  };
}

const RESULT: HarnessResult = { outputs: [], usage: { unknown: true } };

describe('harnessAdapterSpawnPath', () => {
  it('returns the code when the adapter rejects with the timeout class', async () => {
    const adapter = makeFake('fake-adapter', async () => {
      throw Object.assign(new Error('timed out'), { code: HARNESS_TIMEOUT_CLASS });
    });
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    const code = await spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000, fixtureArgs: [] });
    expect(code).toBe(HARNESS_TIMEOUT_CLASS);
  });

  it('rethrows a plain error with no code unchanged', async () => {
    const boom = new Error('boom');
    const adapter = makeFake('fake-adapter', async () => {
      throw boom;
    });
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    await expect(
      spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000, fixtureArgs: [] }),
    ).rejects.toBe(boom);
  });

  it('rethrows a throw whose code is a different failure class', async () => {
    const adapter = makeFake('fake-adapter', async () => {
      throw Object.assign(new Error('nonzero exit'), { code: 'harness-exit-nonzero' });
    });
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    await expect(
      spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000, fixtureArgs: [] }),
    ).rejects.toMatchObject({ code: 'harness-exit-nonzero' });
  });

  it('returns undefined when the invocation resolves', async () => {
    const adapter = makeFake('fake-adapter', async () => RESULT);
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    const code = await spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000, fixtureArgs: [] });
    expect(code).toBeUndefined();
  });
});

describe('grandchild readiness (issue #143)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-readiness-')));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // Only the files matter: the helpers never signal the recorded pid.
  function write(...files: string[]): void {
    for (const file of files) writeFileSync(join(projectRoot, file), `${process.pid}\n`);
  }

  it('is not ready with nothing written', () => {
    expect(grandchildrenRunning(projectRoot)).toBe(false);
  });

  it('is not ready when every pid is recorded but no sentinel exists yet', () => {
    write(PID_FILE, SETSID_PID_FILE);
    expect(grandchildrenRunning(projectRoot)).toBe(false);
  });

  it('is not ready when a sentinel exists without its pid', () => {
    write(SENTINEL_FILE, SETSID_SENTINEL_FILE);
    expect(grandchildrenRunning(projectRoot)).toBe(false);
  });

  it('is ready once every grandchild has recorded its pid and created its sentinel', () => {
    write(PID_FILE, SENTINEL_FILE, SETSID_PID_FILE, SETSID_SENTINEL_FILE);
    expect(grandchildrenRunning(projectRoot)).toBe(true);
  });

  it('requires the setsid grandchild exactly where the reap assertion does', () => {
    write(PID_FILE, SENTINEL_FILE);
    expect(grandchildrenRunning(projectRoot)).toBe(!requiresSetsidContainment);
  });

  it('waits for a sentinel that appears after its pid file', async () => {
    write(PID_FILE, SETSID_PID_FILE);
    setTimeout(() => write(SENTINEL_FILE, SETSID_SENTINEL_FILE), 100);
    await waitForGrandchildrenRunning(projectRoot, 5_000);
    expect(grandchildrenRunning(projectRoot)).toBe(true);
  });

  it('fails naming the missing sentinel when the budget runs out', async () => {
    write(PID_FILE, SETSID_PID_FILE);
    await expect(waitForGrandchildrenRunning(projectRoot, 100)).rejects.toThrow(
      'backgrounded grandchild: sentinel was never created',
    );
  });

  it('fails naming the missing pid when the budget runs out', async () => {
    await expect(waitForGrandchildrenRunning(projectRoot, 100)).rejects.toThrow(
      'backgrounded grandchild: no pid recorded',
    );
  });
});
