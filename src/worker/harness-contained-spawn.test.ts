import { describe, it, expect } from 'bun:test';
import { containedSpawn } from './harness-contained-spawn';
import { killContained } from './process-group';

const ROOT = process.cwd();
const containment = { mechanism: 'process-group', reason: 'unit test' } as const;

describe('containedSpawn close()', () => {
  const trackedHandlers = (): number => process.listeners('SIGTERM').length;

  it('keeps the group tracked when the process outlives the exit wait, and untracks it once it has exited', async () => {
    const before = trackedHandlers();
    let real = false;
    const proc = containedSpawn(containment, 'test', {
      exitWaitMs: 50,
      kill: (pid, cgroup) => {
        if (real) killContained(pid, cgroup);
      },
    })({ command: 'sleep', args: ['30'], cwd: ROOT, env: { PATH: '/usr/bin:/bin' } }, { onLine() {}, onStderr() {}, onExit() {} });
    try {
      await proc.close();
      // The kill was a no-op, so the process is still alive: the kernel's signal handlers must still know it.
      expect(trackedHandlers()).toBeGreaterThan(before);
    } finally {
      real = true;
      await proc.close();
    }
    expect(trackedHandlers()).toBe(before);
  });
});
