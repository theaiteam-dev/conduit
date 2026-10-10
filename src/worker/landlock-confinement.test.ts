/**
 * Landlock write confinement (issue #122, ADR-0013): locating the helper, the
 * once-per-process probe, the argv the spawn runs, and the writable set.
 *
 * The probe and argv tests inject their dependencies, so they run on any host.
 * The tests at the end run the real helper against the real kernel. They need
 * Linux with Landlock and the helper built (scripts/build-llexec.sh); on any
 * other host they are registered as skipped tests that name the reason, and
 * CONDUIT_REQUIRE_LANDLOCK=1 (set in CI) makes them fail instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEV_DIR,
  LLEXEC_ENV,
  LLEXEC_FAILED_EXIT,
  MIN_OVERLAP_LANDLOCK_ABI,
  buildConfinedArgv,
  callTempDirEnv,
  confinedWritableSet,
  createCallTempDir,
  createWriteConfinementResolver,
  describeWriteConfinement,
  detectWriteConfinement,
  locateLlexec,
  removeCallTempDir,
  requireSpawnConfinement,
  resolveWriteConfinement,
  type ProbeRunResult,
  type WriteConfinement,
} from './landlock-confinement';
import { prepareContainedCommand, removeCgroup, killCgroup, resolveContainment, type Containment } from './cgroup-containment';
import { writeConfinementRequired } from './containment-fixture-files';

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-landlock-')));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function executable(path: string): string {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('locateLlexec', () => {
  it('uses CONDUIT_LLEXEC when it names an executable file', () => {
    const helper = executable(join(scratch, 'llexec'));
    expect(locateLlexec({ [LLEXEC_ENV]: helper }, join(scratch, 'absent'))).toEqual({ path: helper });
  });

  it('refuses a relative CONDUIT_LLEXEC rather than resolving it against the cwd', () => {
    const result = locateLlexec({ [LLEXEC_ENV]: 'bin/llexec' }, join(scratch, 'absent'));
    expect('error' in result && result.error).toContain('is not an absolute path');
  });

  it('refuses a CONDUIT_LLEXEC that is not executable, without falling through to another copy', () => {
    const notExec = join(scratch, 'llexec');
    writeFileSync(notExec, 'x');
    const repo = executable(join(scratch, 'repo-llexec'));
    const result = locateLlexec({ [LLEXEC_ENV]: notExec }, repo);
    expect('error' in result && result.error).toContain('is not an executable file');
  });

  it('uses the source-checkout build when CONDUIT_LLEXEC is unset', () => {
    const repo = executable(join(scratch, 'repo-llexec'));
    expect(locateLlexec({ PATH: '' }, repo)).toEqual({ path: repo });
  });

  it('falls back to llexec on PATH', () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    const onPath = executable(join(bin, 'llexec'));
    expect(locateLlexec({ PATH: bin }, join(scratch, 'absent'))).toEqual({ path: onPath });
  });

  it('names every way to provide the helper when none is found', () => {
    const result = locateLlexec({ PATH: join(scratch, 'empty') }, join(scratch, 'absent'));
    expect('error' in result && result.error).toContain('the llexec helper was not found');
  });
});

/**
 * A stand-in for running the helper. `--abi` answers `abi`; the write test
 * performs the two writes itself according to `writes`, as the real helper
 * would let the shell do.
 */
function fakeRun(opts: {
  abi?: ProbeRunResult;
  writes?: { allowed: boolean; denied: boolean };
  writeExit?: number;
  writeStderr?: string;
  /** The confined run truncates the existing file outside the writable path. */
  truncates?: boolean;
  /** The confined run hardlinks that file into the writable path. */
  links?: boolean;
  /** The unconfined control run cannot write, as in a full or read-only scratch. */
  controlFails?: boolean;
}): { run: (argv: string[], cwd: string) => Promise<ProbeRunResult>; argvs: string[][] } {
  const argvs: string[][] = [];
  return {
    argvs,
    run: async (argv) => {
      argvs.push(argv);
      if (argv[1] === '--abi') return opts.abi ?? { exitCode: 0, stdout: '4\n', stderr: '' };
      const [allowed, denied] = argv.slice(-2) as [string, string];
      if (argv[0] === '/bin/sh') {
        // The control: no helper, so everything the command tries succeeds.
        if (opts.controlFails) return { exitCode: 0, stdout: '', stderr: '' };
        writeFileSync(join(allowed, 'probe'), 'ok');
        writeFileSync(join(denied, 'probe'), 'no');
        writeFileSync(join(denied, 'existing'), '');
        linkSync(join(denied, 'existing'), join(allowed, 'link'));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      const sep = argv.indexOf('--');
      expect(argv.slice(1, sep)).toEqual([allowed]);
      const writes = opts.writes ?? { allowed: true, denied: false };
      if (writes.allowed) writeFileSync(join(allowed, 'probe'), 'ok');
      if (writes.denied) writeFileSync(join(denied, 'probe'), 'no');
      if (opts.truncates) writeFileSync(join(denied, 'existing'), '');
      if (opts.links) linkSync(join(denied, 'existing'), join(allowed, 'link'));
      return { exitCode: opts.writeExit ?? 0, stdout: '', stderr: opts.writeStderr ?? '' };
    },
  };
}

describe('detectWriteConfinement: each reason it is unavailable, with the dependencies injected', () => {
  let helper: string;
  beforeEach(() => {
    helper = executable(join(scratch, 'llexec'));
  });
  const deps = (run: (argv: string[], cwd: string) => Promise<ProbeRunResult>) => ({
    platform: 'linux',
    env: { [LLEXEC_ENV]: helper },
    run,
    tmpRoot: scratch,
  });

  it('is unavailable off Linux', async () => {
    expect(await detectWriteConfinement({ platform: 'darwin' })).toEqual({
      available: false,
      reason: 'Landlock is Linux-only (platform darwin)',
    });
  });

  it('is unavailable when the helper cannot be found', async () => {
    const result = await detectWriteConfinement({
      platform: 'linux',
      env: { PATH: join(scratch, 'empty') },
      repoHelperPath: join(scratch, 'absent'),
    });
    expect(result.available).toBe(false);
    expect(!result.available && result.reason).toContain('the llexec helper was not found');
  });

  it('is unavailable when the kernel reports no Landlock ABI, quoting the helper', async () => {
    const { run } = fakeRun({
      abi: { exitCode: LLEXEC_FAILED_EXIT, stdout: '', stderr: 'llexec: Landlock is supported but disabled at boot\n' },
    });
    const result = await detectWriteConfinement(deps(run));
    expect(result).toEqual({
      available: false,
      reason: `${helper} --abi failed (llexec: Landlock is supported but disabled at boot)`,
    });
  });

  it('is unavailable on Landlock ABI 2, naming the kernel minimum, before any write test runs', async () => {
    const { run, argvs } = fakeRun({ abi: { exitCode: 0, stdout: '2\n', stderr: '' } });
    const result = await detectWriteConfinement(deps(run));
    expect(result).toEqual({
      available: false,
      reason:
        'the kernel reports Landlock ABI 2, and overlap needs ABI 3 (Linux 6.2 or later), the first that checks truncate(2)',
    });
    expect(argvs).toHaveLength(1);
  });

  it(`is available on Landlock ABI ${MIN_OVERLAP_LANDLOCK_ABI}, the minimum`, async () => {
    const { run } = fakeRun({ abi: { exitCode: 0, stdout: '3\n', stderr: '' } });
    expect(await detectWriteConfinement(deps(run))).toEqual({ available: true, helper, abi: 3 });
  });

  it('is unavailable when the helper cannot apply the ruleset', async () => {
    const { run } = fakeRun({
      writes: { allowed: false, denied: false },
      writeExit: LLEXEC_FAILED_EXIT,
      writeStderr: 'llexec: cannot create a Landlock ruleset: Operation not permitted\n',
    });
    const result = await detectWriteConfinement(deps(run));
    expect(!result.available && result.reason).toBe(
      'the helper could not apply a Landlock ruleset (llexec: cannot create a Landlock ruleset: Operation not permitted)',
    );
  });

  it('is unavailable when a write inside the writable path did not happen', async () => {
    const { run } = fakeRun({ writes: { allowed: false, denied: false }, writeExit: 2, writeStderr: 'sh: cannot create\n' });
    const result = await detectWriteConfinement(deps(run));
    expect(!result.available && result.reason).toBe('a confined write inside the writable path failed (sh: cannot create)');
  });

  it('is unavailable when the write outside the writable path was not refused', async () => {
    const { run } = fakeRun({ writes: { allowed: true, denied: true } });
    const result = await detectWriteConfinement(deps(run));
    expect(!result.available && result.reason).toBe('Landlock did not refuse a write outside the writable path');
  });

  it('is unavailable when the confined command truncated an existing file outside the writable path', async () => {
    const { run } = fakeRun({ truncates: true });
    const result = await detectWriteConfinement(deps(run));
    expect(!result.available && result.reason).toBe(
      'Landlock did not refuse truncating an existing file outside the writable path',
    );
  });

  it('is unavailable when the confined command hardlinked a file from outside into the writable path', async () => {
    const { run } = fakeRun({ links: true });
    const result = await detectWriteConfinement(deps(run));
    expect(!result.available && result.reason).toBe(
      'Landlock did not refuse hardlinking a file from outside the writable path into it',
    );
  });

  it('is unavailable, without a confined run, when the unconfined control cannot write', async () => {
    const { run, argvs } = fakeRun({ controlFails: true });
    const result = await detectWriteConfinement(deps(run));
    expect(!result.available && result.reason).toBe(
      'the probe could not write its scratch dir unconfined (write inside, write outside, truncate, link failed)',
    );
    expect(argvs.some((a) => a[0] === helper && a.includes('/bin/sh'))).toBe(false);
  });

  it('is available, with the helper and ABI, only after the write test passes, and removes its scratch dir', async () => {
    const { run, argvs } = fakeRun({});
    expect(await detectWriteConfinement(deps(run))).toEqual({ available: true, helper, abi: 4 });
    expect(argvs.map((a) => a[0])).toEqual([helper, '/bin/sh', helper]);
    // The write test ran a real command under the helper, not a version check alone.
    expect(argvs[2]).toContain('/bin/sh');
    const leftovers = new Bun.Glob('conduit-landlock-probe-*').scanSync({ cwd: scratch, onlyFiles: false });
    expect([...leftovers]).toEqual([]);
  });

  it('is unavailable, not thrown, when the runner throws', async () => {
    const result = await detectWriteConfinement(deps(async () => {
      throw new Error('spawn failed');
    }));
    expect(!result.available && result.reason).toBe('the write-confinement probe failed (spawn failed)');
  });
});

describe('createWriteConfinementResolver', () => {
  it('runs detection once and returns the same answer to every caller', async () => {
    let calls = 0;
    const answer: WriteConfinement = { available: false, reason: 'test' };
    const resolve = createWriteConfinementResolver(async () => {
      calls++;
      return answer;
    });
    expect(await resolve()).toBe(answer);
    expect(await resolve()).toBe(answer);
    expect(calls).toBe(1);
  });

  it('describes both outcomes for conduit doctor', () => {
    expect(describeWriteConfinement({ available: true, helper: '/usr/local/bin/llexec', abi: 3 })).toBe(
      'Landlock ABI 3 via /usr/local/bin/llexec; overlapped harness calls run write-confined',
    );
    expect(describeWriteConfinement({ available: false, reason: 'no helper' })).toStartWith(
      'unavailable (no helper); cards of overlap: true stations run one at a time',
    );
  });
});

describe('buildConfinedArgv and confinedWritableSet', () => {
  it('puts every writable path before `--` and the command after it', () => {
    expect(buildConfinedArgv('/opt/llexec', ['/p/cards/a', '/dev'], ['/usr/bin/claude', '-p', '--', 'x'])).toEqual([
      '/opt/llexec', '/p/cards/a', '/dev', '--', '/usr/bin/claude', '-p', '--', 'x',
    ]);
  });

  it('refuses a relative writable path, which the helper could read as an option or as `--`', () => {
    expect(() => buildConfinedArgv('/opt/llexec', ['--'], ['/bin/true'])).toThrow("writable path '--' is not absolute");
    expect(() => buildConfinedArgv('/opt/llexec', ['cards/a'], ['/bin/true'])).toThrow('is not absolute');
  });

  it('refuses a relative helper and an empty command', () => {
    expect(() => buildConfinedArgv('llexec', [], ['/bin/true'])).toThrow('is not an absolute path');
    expect(() => buildConfinedArgv('/opt/llexec', [], [])).toThrow('empty argv');
  });

  it('grants the owned paths, then the adapter dirs, then /dev, once each', () => {
    expect(confinedWritableSet(['/p/cards/a', '/p/cards/a2'], ['/tmp/call', '/tmp/cfg', '/p/cards/a'])).toEqual([
      '/p/cards/a', '/p/cards/a2', '/tmp/call', '/tmp/cfg', DEV_DIR,
    ]);
    expect(confinedWritableSet([], [])).toEqual([DEV_DIR]);
  });

  it('refuses a relative path from either source', () => {
    expect(() => confinedWritableSet(['cards/a'], [])).toThrow('is not absolute');
    expect(() => confinedWritableSet([], ['tmp'])).toThrow('is not absolute');
  });
});

describe('requireSpawnConfinement: a call that asked for confinement never runs unconfined', () => {
  const granted = { helper: '/opt/llexec', writable: ['/p/cards/a'] };
  const tmp = { root: '/t/call', cache: '/t/call/cache', state: '/t/call/state' };

  it('builds the full writable set from the granted paths, the temp dir and the run-scoped dirs', () => {
    expect(requireSpawnConfinement(granted, tmp, ['/t/cfg'])).toEqual({
      helper: '/opt/llexec',
      writable: ['/p/cards/a', '/t/call', '/t/cfg', DEV_DIR],
    });
  });

  it('throws when the per-call temp dir is missing', () => {
    expect(() => requireSpawnConfinement(granted, undefined, ['/t/cfg'])).toThrow('refusing to run unconfined');
  });

  it('throws when a run-scoped dir is missing', () => {
    expect(() => requireSpawnConfinement(granted, tmp, [undefined])).toThrow('refusing to run unconfined');
  });
});

describe('createCallTempDir', () => {
  it('creates a temp dir with cache and state inside it, and removes it', () => {
    const dir = createCallTempDir();
    try {
      expect(existsSync(dir.cache)).toBe(true);
      expect(existsSync(dir.state)).toBe(true);
      expect(dir.cache.startsWith(dir.root)).toBe(true);
    } finally {
      removeCallTempDir(dir);
    }
    expect(existsSync(dir.root)).toBe(false);
  });

  it('points TMPDIR and zsh\'s TMPPREFIX into the dir, and the XDG cache and state dirs only when asked', () => {
    const dir = { root: '/t/call', cache: '/t/call/cache', state: '/t/call/state' };
    expect(callTempDirEnv(dir, { xdg: false })).toEqual({ TMPDIR: '/t/call', TMPPREFIX: '/t/call/zsh' });
    expect(callTempDirEnv(dir, { xdg: true })).toEqual({
      TMPDIR: '/t/call', TMPPREFIX: '/t/call/zsh', XDG_CACHE_HOME: '/t/call/cache', XDG_STATE_HOME: '/t/call/state',
    });
  });

  it('does not remove a dir it did not create', () => {
    const other = join(scratch, 'other');
    mkdirSync(other);
    removeCallTempDir({ root: other, cache: other, state: other });
    expect(existsSync(other)).toBe(true);
  });
});

describe('prepareContainedCommand with write confinement', () => {
  const confinement = { helper: '/opt/llexec', writable: ['/p/cards/a', '/dev'] };

  it('runs the resolved command under the helper with process-group containment', () => {
    const prepared = prepareContainedCommand(
      { mechanism: 'process-group', reason: 'x' },
      ['sleep', '1'],
      { env: { PATH: '/usr/bin:/bin' } },
      confinement,
    );
    expect(prepared.cgroup).toBeUndefined();
    expect(prepared.argv.slice(0, 4)).toEqual(['/opt/llexec', '/p/cards/a', '/dev', '--']);
    expect(prepared.argv[4]).toMatch(/\/sleep$/);
    expect(prepared.argv[5]).toBe('1');
  });

  it('chains the helper after the cgroup wrapper, so the cgroup join comes first', () => {
    const containment: Containment = { mechanism: 'cgroup', parent: scratch };
    const prepared = prepareContainedCommand(containment, ['sleep', '1'], { env: { PATH: '/usr/bin:/bin' } }, confinement);
    expect(prepared.argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(prepared.argv[3]).toBe(join(prepared.cgroup!, 'cgroup.procs'));
    expect(prepared.argv.slice(4, 8)).toEqual(['/opt/llexec', '/p/cards/a', '/dev', '--']);
    expect(prepared.argv[8]).toMatch(/\/sleep$/);
  });

  it('leaves argv unchanged without confinement under process-group containment', () => {
    const prepared = prepareContainedCommand({ mechanism: 'process-group', reason: 'x' }, ['sleep', '1'], {});
    expect(prepared.argv).toEqual(['sleep', '1']);
  });
});

// ---------------------------------------------------------------------------
// The real helper against the real kernel.
// ---------------------------------------------------------------------------

const hostConfinement = await resolveWriteConfinement();
const confinementRequired = writeConfinementRequired();
const itWithLandlock = hostConfinement.available || confinementRequired ? it : it.skip;

describe('the real helper (issue #122)', () => {
  if (!hostConfinement.available && !confinementRequired) {
    it.skip(`refuses writes outside the writable set (host has no write confinement: ${hostConfinement.reason})`, () => {});
  }

  itWithLandlock('the probe finds the helper and a Landlock ABI on this host', () => {
    expect(hostConfinement).toMatchObject({ available: true });
    expect(hostConfinement.available && hostConfinement.abi).toBeGreaterThanOrEqual(1);
  });

  itWithLandlock(
    'refuses a write into a sibling dir, through a symlink, from a setsid child and to a shared file, and allows the own dir',
    async () => {
      if (!hostConfinement.available) throw new Error(`write confinement unavailable: ${hostConfinement.reason}`);
      const own = join(scratch, 'cards', 'a');
      const sibling = join(scratch, 'cards', 'b');
      mkdirSync(own, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(scratch, 'shared.txt'), 'shared\n');
      symlinkSync(sibling, join(own, 'link'));
      const containment = await resolveContainment();
      const script = [
        'echo mine > cards/a/out.txt',
        'cp cards/a/out.txt cards/b/stolen.txt 2>/dev/null',
        'echo via-link > cards/a/link/linked.txt 2>/dev/null',
        'echo x >> shared.txt 2>/dev/null',
        'mv cards/a/out.txt cards/b/moved.txt 2>/dev/null',
        'setsid -f sh -c "echo s > cards/b/setsid.txt 2>/dev/null; echo done > cards/a/setsid.done"',
        'for i in 1 2 3 4 5 6 7 8 9 10; do [ -f cards/a/setsid.done ] && break; sleep 0.1; done',
      ].join('; ');
      const prepared = prepareContainedCommand(
        containment,
        ['/bin/sh', '-c', script],
        { cwd: scratch, env: { PATH: '/usr/bin:/bin' } },
        { helper: hostConfinement.helper, writable: confinedWritableSet([own], []) },
      );
      try {
        const proc = Bun.spawn(prepared.argv, { cwd: scratch, env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        expect(readFileSync(join(own, 'out.txt'), 'utf-8')).toBe('mine\n');
        expect(existsSync(join(own, 'setsid.done'))).toBe(true);
        expect(existsSync(join(sibling, 'stolen.txt'))).toBe(false);
        expect(existsSync(join(sibling, 'linked.txt'))).toBe(false);
        expect(existsSync(join(sibling, 'moved.txt'))).toBe(false);
        expect(existsSync(join(sibling, 'setsid.txt'))).toBe(false);
        expect(readFileSync(join(scratch, 'shared.txt'), 'utf-8')).toBe('shared\n');
      } finally {
        if (prepared.cgroup !== undefined) {
          killCgroup(prepared.cgroup);
          await removeCgroup(prepared.cgroup, 1_000);
        }
      }
    },
    20_000,
  );

  itWithLandlock('never runs the command when a writable path does not exist', async () => {
    if (!hostConfinement.available) throw new Error(`write confinement unavailable: ${hostConfinement.reason}`);
    const marker = join(scratch, 'ran');
    const proc = Bun.spawn(
      buildConfinedArgv(hostConfinement.helper, [join(scratch, 'missing')], ['/bin/sh', '-c', `echo > ${marker}`]),
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(LLEXEC_FAILED_EXIT);
    expect(stderr).toContain('llexec: cannot open writable path');
    expect(existsSync(marker)).toBe(false);
  });

  itWithLandlock('grants a writable file only the file rights: writing it works, creating a file beside it does not', async () => {
    if (!hostConfinement.available) throw new Error(`write confinement unavailable: ${hostConfinement.reason}`);
    const file = join(scratch, 'owned.txt');
    writeFileSync(file, 'old\n');
    const proc = Bun.spawn(
      buildConfinedArgv(hostConfinement.helper, [file], ['/bin/sh', '-c', 'echo new > owned.txt; echo x > beside.txt 2>/dev/null; exit 0']),
      { cwd: scratch, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await proc.exited).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe('new\n');
    expect(existsSync(join(scratch, 'beside.txt'))).toBe(false);
  });
});
