/**
 * Unit tests for `harnessAdapterSpawnPath` (./harness-containment.conformance.ts).
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
import { describe, it, expect } from 'bun:test';
import type { HarnessAdapter, HarnessInvocation, HarnessResult, BinaryProbe } from './harness-adapter';
import { HARNESS_TIMEOUT_CLASS, harnessAdapterSpawnPath } from './harness-containment.conformance';

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
    const code = await spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000 });
    expect(code).toBe(HARNESS_TIMEOUT_CLASS);
  });

  it('rethrows a plain error with no code unchanged', async () => {
    const boom = new Error('boom');
    const adapter = makeFake('fake-adapter', async () => {
      throw boom;
    });
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    await expect(
      spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000 }),
    ).rejects.toBe(boom);
  });

  it('rethrows a throw whose code is a different failure class', async () => {
    const adapter = makeFake('fake-adapter', async () => {
      throw Object.assign(new Error('nonzero exit'), { code: 'harness-exit-nonzero' });
    });
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    await expect(
      spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'harness-exit-nonzero' });
  });

  it('returns undefined when the invocation resolves', async () => {
    const adapter = makeFake('fake-adapter', async () => RESULT);
    const spawnPath = harnessAdapterSpawnPath('fake-adapter', () => adapter);
    const code = await spawnPath({ projectRoot: '/tmp/unused', fixture: '/bin/true', timeoutMs: 1000 });
    expect(code).toBeUndefined();
  });
});
