import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { makeProcessNonDumpable, protectProcessEnvironment } from './non-dumpable';

// A bun process holding a secret in its env, optionally made non-dumpable, starts a child
// with an empty env (as a harness child is started) that reads the parent's
// /proc/<pid>/environ. Prints what the child could read.
const FIXTURE = `
import { makeProcessNonDumpable } from ${JSON.stringify(join(import.meta.dir, 'non-dumpable.ts'))};
if (process.env.FIXTURE_MODE === 'protect') {
  const r = makeProcessNonDumpable();
  if (!r.ok) { console.log('SETUP-FAILED ' + r.reason); process.exit(0); }
}
const child = Bun.spawnSync(['/bin/sh', '-c', 'cat /proc/$PPID/environ 2>/dev/null | tr "\\\\0" "\\\\n" | grep -c KERNEL_ONLY_SECRET'], { env: { PATH: '/usr/bin:/bin' } });
console.log('READ ' + child.stdout.toString().trim());
`;

function runFixture(mode: 'protect' | 'plain'): string {
  const r = Bun.spawnSync([process.execPath, '-e', FIXTURE], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', KERNEL_ONLY_SECRET: 's3cret', FIXTURE_MODE: mode },
  });
  return r.stdout.toString().trim();
}

const isLinux = process.platform === 'linux';
// Root holds CAP_SYS_PTRACE, which reads a non-dumpable process's environ anyway.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('makeProcessNonDumpable', () => {
  it.skipIf(!isLinux || isRoot)('a child with an empty env reads a plain parent\'s environ (the GHSA-r69q-grh3-2r38 read)', () => {
    expect(runFixture('plain')).toBe('READ 1');
  });

  it.skipIf(!isLinux || isRoot)('the child cannot read the environ of a parent that made itself non-dumpable', () => {
    expect(runFixture('protect')).toBe('READ 0');
  });

  it('is a no-op that reports why on a platform other than Linux', () => {
    expect(makeProcessNonDumpable('darwin')).toEqual({ ok: false, reason: 'not Linux (darwin)' });
  });

  it.skipIf(!isLinux)('protectProcessEnvironment writes no warning when the call succeeds', () => {
    // In a child, so the test runner itself stays dumpable.
    const r = Bun.spawnSync([process.execPath, '-e', `
      import { protectProcessEnvironment } from ${JSON.stringify(join(import.meta.dir, 'non-dumpable.ts'))};
      protectProcessEnvironment();
    `]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe('');
  });
});
