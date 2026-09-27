/**
 * Tests for cgroup v2 containment (./cgroup-containment.ts, issue #77).
 *
 * The conformance suite proves a setsid grandchild dies on every spawn path
 * of a host with cgroup containment. These tests cover the rest: each reason
 * detection falls back to the process-group kill, that the fallback still
 * kills what stays in the group and does not claim more, the one-time
 * warning, the spawn wrapper, and cgroup cleanup.
 *
 * Tests that need a writable cgroup v2 hierarchy skip on a host without one,
 * unless CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1 (CI), where they run and fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CGROUP_JOIN_FAILED_EXIT,
  containmentWarning,
  createContainmentResolver,
  describeContainment,
  detectContainment,
  prepareContainedCommand,
  removeCgroup,
  type Containment,
} from './cgroup-containment';
import { runHarnessProcess } from './harness-runner';
import { runDeterministic } from './deterministic';
import {
  CONTAINMENT_FIXTURE,
  expectBackgroundedGrandchildReaped,
  hostContainment,
  killRecordedGrandchild,
  recordedSetsidPid,
  requiresSetsidContainment,
} from './harness-containment.conformance';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasSetsid = Bun.which('setsid', { PATH: '/usr/local/bin:/usr/bin:/bin' }) !== null;
const itWithCgroup = requiresSetsidContainment ? it : it.skip;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The cgroups this process created under the host parent (none should outlive a call). */
function ownCgroups(): string[] {
  if (hostContainment.mechanism !== 'cgroup') return [];
  return readdirSync(hostContainment.parent).filter((name) => name.startsWith(`conduit-${process.pid}-`));
}

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-cgroup-')));
});

afterEach(() => {
  killRecordedGrandchild(scratch);
  try {
    chmodSync(scratch, 0o755);
  } catch {
    /* removed already */
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('detectContainment: each reason to fall back to the process-group kill', () => {
  it('falls back when /proc/self/cgroup has no unified (cgroup v2) entry', async () => {
    const result = await detectContainment({ procSelfCgroup: '12:pids:/user.slice\n1:name=systemd:/user.slice\n' });
    expect(result).toEqual({
      mechanism: 'process-group',
      reason: 'no cgroup v2 hierarchy (/proc/self/cgroup has no unified entry)',
    });
  });

  it('falls back when the mount point is not a cgroup v2 filesystem', async () => {
    const result = await detectContainment({ cgroupMount: scratch, procSelfCgroup: '0::/\n' });
    expect(result).toEqual({ mechanism: 'process-group', reason: `${scratch} is not a cgroup v2 filesystem` });
  });

  it('falls back when the mount point does not exist', async () => {
    const missing = join(scratch, 'absent');
    const result = await detectContainment({ cgroupMount: missing, procSelfCgroup: '0::/\n' });
    expect(result.mechanism).toBe('process-group');
    expect((result as { reason: string }).reason).toBe(`cannot stat ${missing} (ENOENT)`);
  });

  itWithCgroup("falls back when the kernel's cgroup is not visible under the mount", async () => {
    const result = await detectContainment({ procSelfCgroup: '0::/conduit-no-such-cgroup\n' });
    expect(result).toEqual({
      mechanism: 'process-group',
      reason: "the kernel's cgroup /sys/fs/cgroup/conduit-no-such-cgroup is not visible under /sys/fs/cgroup",
    });
  });

  // A real cgroup, made read-only: the unwritable-cgroup case on a real
  // cgroup v2 mount, the same failure a read-only /sys/fs/cgroup in a default
  // Docker container produces (EROFS there). Pointing /proc/self/cgroup at it
  // makes detection try to create its probe there. Root ignores the mode.
  (requiresSetsidContainment && !isRoot ? it : it.skip)(
    'falls back when the cgroup it would create under is not writable',
    async () => {
      if (hostContainment.mechanism !== 'cgroup') throw new Error('unreachable');
      const locked = join(hostContainment.parent, `conduit-${process.pid}-locked`);
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        const selfPath = readFileSync('/proc/self/cgroup', 'utf-8')
          .split('\n')
          .find((l) => l.startsWith('0::'))!
          .slice(3);
        const rel = `${selfPath === '/' ? '' : selfPath}/conduit-${process.pid}-locked`;
        const result = await detectContainment({ procSelfCgroup: `0::${rel}\n` });
        expect(result).toEqual({
          mechanism: 'process-group',
          reason: `cannot create a cgroup under ${locked} (EACCES)`,
        });
      } finally {
        chmodSync(locked, 0o755);
        await removeCgroup(locked, 1_000);
      }
    },
  );

  itWithCgroup('chooses cgroup containment on a host with a writable cgroup v2 subtree, and leaves no probe behind', async () => {
    const result = await detectContainment();
    expect(result.mechanism).toBe('cgroup');
    expect(ownCgroups()).toEqual([]);
  });
});

describe('the process-group fallback, decided by detection', () => {
  (hasSetsid ? it : it.skip)(
    'kills the grandchild that stayed in the group and does not reach the one that called setsid',
    async () => {
      // A real fallback decision, not a hand-built one.
      const fallback = await detectContainment({ cgroupMount: scratch, procSelfCgroup: '0::/\n' });
      expect(fallback.mechanism).toBe('process-group');

      const result = await runHarnessProcess(
        { command: CONTAINMENT_FIXTURE, args: [] },
        { projectRoot: scratch, timeoutMs: 1_000, containment: fallback },
      );
      expect(result.timedOut).toBe(true);
      await expectBackgroundedGrandchildReaped(scratch);

      // The weaker claim, pinned: this is the escape the fallback warns about.
      const escaped = recordedSetsidPid(scratch);
      expect(escaped).toBeDefined();
      expect(isAlive(escaped!)).toBe(true);
    },
    20_000,
  );
});

describe('createContainmentResolver', () => {
  const fallback: Containment = { mechanism: 'process-group', reason: 'test host' };
  const cgroup: Containment = { mechanism: 'cgroup', parent: '/sys/fs/cgroup/test' };

  it('detects once and warns exactly once on a fallback host', async () => {
    let detections = 0;
    const warnings: string[] = [];
    const resolve = createContainmentResolver(
      async () => {
        detections += 1;
        return fallback;
      },
      (m) => warnings.push(m),
    );

    expect(await resolve()).toEqual(fallback);
    expect(await resolve()).toEqual(fallback);
    expect(detections).toBe(1);
    expect(warnings).toEqual([containmentWarning(fallback)!]);
    expect(warnings[0]).toContain('test host');
    expect(warnings[0]).toContain('can outlive its invocation');
  });

  it('never warns when cgroup containment is in use', async () => {
    const warnings: string[] = [];
    const resolve = createContainmentResolver(async () => cgroup, (m) => warnings.push(m));
    await resolve();
    await resolve();
    expect(warnings).toEqual([]);
    expect(containmentWarning(cgroup)).toBeUndefined();
  });

  it('describes both mechanisms for conduit doctor', () => {
    expect(describeContainment(cgroup)).toBe('cgroup v2, one cgroup per invocation under /sys/fs/cgroup/test');
    expect(describeContainment(fallback)).toContain('process group only (test host)');
  });
});

describe('prepareContainedCommand', () => {
  it('returns the argv unchanged under process-group containment', () => {
    const prepared = prepareContainedCommand({ mechanism: 'process-group', reason: 'x' }, ['sleep', '1'], {});
    expect(prepared).toEqual({ argv: ['sleep', '1'], cgroup: undefined });
  });

  it('throws ENOENT for a missing command before creating a cgroup', () => {
    const containment: Containment = { mechanism: 'cgroup', parent: scratch };
    expect(() => prepareContainedCommand(containment, ['conduit-no-such-binary'], { env: { PATH: '/usr/bin:/bin' } })).toThrow(
      'Executable not found in $PATH: "conduit-no-such-binary"',
    );
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('resolves the command against the child env PATH, as Bun.spawn would', () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    const containment: Containment = { mechanism: 'cgroup', parent: scratch };
    // Not on the child's PATH: not found, even though the kernel's PATH has it.
    expect(() => prepareContainedCommand(containment, ['sleep'], { env: { PATH: bin } })).toThrow('Executable not found');
    // An env with no PATH resolves against /usr/bin:/bin, Bun's own default.
    const prepared = prepareContainedCommand(containment, ['sleep', '1'], { env: {} });
    expect(prepared.argv.slice(-2)).toEqual([Bun.which('sleep', { PATH: '/usr/bin:/bin' })!, '1']);
  });

  (isRoot ? it.skip : it)(
    'fails the invocation, without running the command, when the child cannot join its cgroup',
    async () => {
      // A plain directory stands in for the parent; making the created cgroup
      // read-only makes the wrapper's write to cgroup.procs fail.
      const containment: Containment = { mechanism: 'cgroup', parent: scratch };
      const marker = join(scratch, 'ran');
      const prepared = prepareContainedCommand(containment, ['touch', marker], {});
      chmodSync(prepared.cgroup!, 0o555);

      const proc = Bun.spawn(prepared.argv, { stdout: 'pipe', stderr: 'pipe' });
      expect(await proc.exited).toBe(CGROUP_JOIN_FAILED_EXIT);
      expect(await new Response(proc.stderr).text()).toContain('could not join containment cgroup');
      expect(existsSync(marker)).toBe(false);
      chmodSync(prepared.cgroup!, 0o755);
    },
  );
});

describe('cgroup cleanup', () => {
  itWithCgroup('both runners remove their invocation cgroup before returning, on exit and on timeout', async () => {
    await runHarnessProcess({ command: 'sh', args: ['-c', 'exit 0'] }, { projectRoot: scratch, timeoutMs: 5_000 });
    await runHarnessProcess({ command: 'sleep', args: ['5'] }, { projectRoot: scratch, timeoutMs: 200, envAllowlist: ['PATH'] });
    await runDeterministic({ command: 'true', args: [] }, { allowlist: ['true'], cwd: scratch, timeoutMs: 5_000 });
    await runDeterministic({ command: 'sleep', args: ['5'] }, { allowlist: ['sleep'], cwd: scratch, timeoutMs: 200 });
    expect(ownCgroups()).toEqual([]);
  });

  itWithCgroup('detection kills and removes a cgroup a dead kernel left behind', async () => {
    if (hostContainment.mechanism !== 'cgroup') throw new Error('unreachable');
    // A pid that is certainly not running: a process that has exited.
    const dead = Bun.spawn(['true']);
    await dead.exited;
    const stale = join(hostContainment.parent, `conduit-${dead.pid}-1`);
    mkdirSync(stale);
    const orphan = Bun.spawn(['/bin/sh', '-c', 'echo $$ > "$0" && exec sleep 30', join(stale, 'cgroup.procs')], {
      detached: true,
    });
    try {
      const deadline = Date.now() + 3_000;
      while (!readFileSync(join(stale, 'cgroup.procs'), 'utf-8').trim() && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      await detectContainment();

      await orphan.exited;
      expect(orphan.signalCode).toBe('SIGKILL');
      expect(existsSync(stale)).toBe(false);
    } finally {
      try {
        process.kill(orphan.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await removeCgroup(stale, 1_000);
    }
  });
});

describe('CI requires cgroup containment', () => {
  // CI sets the variable so a runner image that loses the mechanism fails here
  // with the reason, instead of skipping every setsid assertion.
  (process.env.CONDUIT_REQUIRE_CGROUP_CONTAINMENT === '1' ? it : it.skip)(
    'the host provides cgroup containment',
    () => {
      expect(hostContainment.mechanism === 'cgroup' ? 'cgroup' : hostContainment.reason).toBe('cgroup');
    },
  );
});
