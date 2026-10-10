/**
 * Landlock write confinement for overlapped harness calls (issue #122,
 * ADR-0013, SPEC §7 "Overlapping harness calls").
 *
 * Under overlap, the integrity diff attributes a touched path inside a
 * sibling's owned paths to that sibling (ADR-0012), so a Bash write by one
 * member into another member's dir went undetected. Each overlapped call now
 * runs its harness process tree under Landlock, an unprivileged Linux
 * security module: a write outside the call's writable set fails at the
 * syscall with EACCES, before anything changes on disk.
 *
 * The confinement is applied by `llexec` (native/llexec/llexec.c), a small
 * static helper that builds the ruleset, restricts itself, and execs the
 * command. The ruleset is inherited by every descendant and cannot be removed,
 * so a command that calls setsid() or double-forks stays confined.
 * `prepareContainedCommand` (./cgroup-containment.ts) chains it after the
 * cgroup wrapper, so the two compose: the shell joins the invocation's cgroup,
 * execs llexec, and llexec execs the command.
 *
 * The writable set of one call is:
 *   - the card's owned paths, canonical, from the executor;
 *   - a per-call temp dir the adapter creates and points TMPDIR at;
 *   - the adapter's run-scoped config dirs (CLAUDE_CONFIG_DIR, CODEX_HOME,
 *     the opencode HOME and XDG root);
 *   - /dev.
 * Reads and executes are not handled by the ruleset, so they stay allowed
 * everywhere.
 *
 * Detection runs once per process, like `resolveContainment`: it locates the
 * helper, asks it for the kernel's Landlock ABI, and then proves the mechanism
 * with a real write test (a write inside the writable path must succeed and a
 * write outside it must be refused). When any step fails, overlap candidates
 * run on the serial path instead, with the reason journaled as
 * `overlap_fallback`. `conduit doctor` reports which applies.
 */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Exit status of llexec for every failure before it execs the command. Kept in step with llexec.c. */
export const LLEXEC_FAILED_EXIT = 121;

/** Env var naming the helper explicitly. */
export const LLEXEC_ENV = 'CONDUIT_LLEXEC';

/** Where scripts/build-llexec.sh puts the helper in a source checkout. */
export const REPO_LLEXEC_PATH = resolve(import.meta.dir, '../../native/llexec/build/llexec');

/** Always writable for a confined call: terminals, /dev/null, /dev/shm. */
export const DEV_DIR = '/dev';

/**
 * The lowest Landlock ABI overlap accepts: ABI 3 (Linux 6.2) is the first that
 * checks truncate(2). Below it a confined process can truncate a file outside
 * its writable set, which changes a sibling's file contents, so the probe
 * reports confinement unavailable. llexec itself stays ABI-generic.
 */
export const MIN_OVERLAP_LANDLOCK_ABI = 3;

/** Upper bound on each of the probe's commands. */
const PROBE_BUDGET_MS = 5_000;

export type WriteConfinement =
  | {
      available: true;
      /** Absolute path of the llexec helper. */
      helper: string;
      /** Highest Landlock ABI the kernel reports. */
      abi: number;
    }
  | {
      available: false;
      /** Why overlapped harness calls cannot be confined on this host. */
      reason: string;
    };

/**
 * What a spawn needs to confine one command: the helper and the full writable
 * set, every entry absolute and existing.
 */
export interface SpawnWriteConfinement {
  helper: string;
  writable: readonly string[];
}

/** Result of running one probe command. */
export interface ProbeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface DetectWriteConfinementDeps {
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Env used to find the helper. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Path of a helper built in the source checkout. Defaults to REPO_LLEXEC_PATH. */
  repoHelperPath?: string;
  /** Run a command to completion, bounded. Defaults to a real Bun.spawn. */
  run?: (argv: string[], cwd: string) => Promise<ProbeRunResult>;
  /** Where the write test makes its scratch dir. Defaults to the OS temp dir. */
  tmpRoot?: string;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate llexec: `CONDUIT_LLEXEC` when set (it must be an absolute path to an
 * executable file; a bad value is an error, never a fall-through to another
 * copy), else the copy scripts/build-llexec.sh builds in a source checkout,
 * else `llexec` on PATH (the engine image installs it in /usr/local/bin).
 */
export function locateLlexec(
  env: Record<string, string | undefined>,
  repoHelperPath: string = REPO_LLEXEC_PATH,
): { path: string } | { error: string } {
  const explicit = env[LLEXEC_ENV];
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolute(explicit)) return { error: `${LLEXEC_ENV}='${explicit}' is not an absolute path` };
    if (!isExecutableFile(explicit)) return { error: `${LLEXEC_ENV}='${explicit}' is not an executable file` };
    return { path: explicit };
  }
  if (isExecutableFile(repoHelperPath)) return { path: repoHelperPath };
  const onPath = Bun.which('llexec', { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin' });
  if (onPath !== null) return { path: onPath };
  return {
    error:
      `the llexec helper was not found (set ${LLEXEC_ENV}, run scripts/build-llexec.sh in a source ` +
      'checkout, or install it on PATH; the engine image ships it)',
  };
}

async function defaultRun(argv: string[], cwd: string): Promise<ProbeRunResult> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { PATH: '/usr/bin:/bin' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_BUDGET_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: proc.exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The first line of `text`, trimmed, for a reason string. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Decide whether overlapped harness calls can be write-confined on this host.
 * Returns `available` only after a real write test through the helper: a file
 * created inside the writable path exists afterwards, and a file the same
 * command tried to create outside it does not.
 */
export async function detectWriteConfinement(deps: DetectWriteConfinementDeps = {}): Promise<WriteConfinement> {
  const unavailable = (reason: string): WriteConfinement => ({ available: false, reason });
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return unavailable(`Landlock is Linux-only (platform ${platform})`);

  const located = locateLlexec(deps.env ?? process.env, deps.repoHelperPath);
  if ('error' in located) return unavailable(located.error);
  const helper = located.path;
  const run = deps.run ?? defaultRun;

  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'conduit-landlock-probe-'));
    const abiRun = await run([helper, '--abi'], scratch);
    const abi = Number(abiRun.stdout.trim());
    if (abiRun.exitCode !== 0 || !Number.isInteger(abi) || abi < 1) {
      const detail = firstLine(abiRun.stderr) || `exit ${abiRun.exitCode ?? 'signal'}`;
      return unavailable(`${helper} --abi failed (${detail})`);
    }
    if (abi < MIN_OVERLAP_LANDLOCK_ABI) {
      return unavailable(
        `the kernel reports Landlock ABI ${abi}, and overlap needs ABI ${MIN_OVERLAP_LANDLOCK_ABI} ` +
          '(Linux 6.2 or later), the first that checks truncate(2)',
      );
    }

    const allowed = join(scratch, 'allowed');
    const denied = join(scratch, 'denied');
    mkdirSync(allowed);
    mkdirSync(denied);
    const writeRun = await run(
      [helper, allowed, '--', '/bin/sh', '-c', 'echo ok > "$1/probe"; echo no > "$2/probe" 2>/dev/null; exit 0', 'sh', allowed, denied],
      scratch,
    );
    if (writeRun.exitCode === LLEXEC_FAILED_EXIT) {
      return unavailable(`the helper could not apply a Landlock ruleset (${firstLine(writeRun.stderr)})`);
    }
    if (!existsSync(join(allowed, 'probe'))) {
      const detail = firstLine(writeRun.stderr) || `exit ${writeRun.exitCode ?? 'signal'}`;
      return unavailable(`a confined write inside the writable path failed (${detail})`);
    }
    if (existsSync(join(denied, 'probe'))) {
      return unavailable('Landlock did not refuse a write outside the writable path');
    }
    return { available: true, helper, abi };
  } catch (err) {
    return unavailable(`the write-confinement probe failed (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

/** A one-line description of `confinement` for `conduit doctor`. */
export function describeWriteConfinement(confinement: WriteConfinement): string {
  return confinement.available
    ? `Landlock ABI ${confinement.abi} via ${confinement.helper}; overlapped harness calls run write-confined`
    : `unavailable (${confinement.reason}); cards of overlap: true stations run one at a time, see ` +
        'docs/harness-containment.md';
}

/** Build a memoized resolver: detection runs on the first call only. */
export function createWriteConfinementResolver(
  detect: () => Promise<WriteConfinement> = () => detectWriteConfinement(),
): () => Promise<WriteConfinement> {
  let pending: Promise<WriteConfinement> | undefined;
  return () => {
    pending ??= detect();
    return pending;
  };
}

/** The process-wide resolver the executor and `conduit doctor` use when none is injected. */
export const resolveWriteConfinement = createWriteConfinementResolver();

/**
 * The argv that runs `argv` under llexec with `writable` as its writable set.
 * Every writable entry must be absolute, so none can be read as `--` or as an
 * option.
 */
export function buildConfinedArgv(helper: string, writable: readonly string[], argv: readonly string[]): string[] {
  if (!isAbsolute(helper)) throw new Error(`llexec helper '${helper}' is not an absolute path`);
  if (argv.length === 0) throw new Error('buildConfinedArgv: empty argv');
  for (const path of writable) {
    if (!isAbsolute(path)) throw new Error(`writable path '${path}' is not absolute`);
  }
  return [helper, ...writable, '--', ...argv];
}

/**
 * The full writable set for one confined call: the paths the executor granted
 * (the card's canonical owned paths), then the adapter's own dirs (its per-call
 * temp dir and run-scoped config dirs), then /dev. Duplicates are dropped and
 * order is kept. Every entry must be absolute.
 */
export function confinedWritableSet(granted: readonly string[], adapterDirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of [...granted, ...adapterDirs, DEV_DIR]) {
    if (!isAbsolute(path)) throw new Error(`writable path '${path}' is not absolute`);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * The spawn confinement for a call the executor asked to confine: the granted
 * paths plus the adapter's per-call temp dir and run-scoped dirs. Throws,
 * before anything is spawned, when any of those is missing, so a call that
 * asked for confinement can never run unconfined.
 */
export function requireSpawnConfinement(
  granted: { helper: string; writable: readonly string[] },
  callTmp: CallTempDir | undefined,
  adapterDirs: ReadonlyArray<string | undefined>,
): SpawnWriteConfinement {
  if (callTmp === undefined) {
    throw new Error('write confinement was requested but the per-call temp dir was not created; refusing to run unconfined');
  }
  const dirs: string[] = [];
  for (const dir of adapterDirs) {
    if (dir === undefined) {
      throw new Error('write confinement was requested but a run-scoped dir was not created; refusing to run unconfined');
    }
    dirs.push(dir);
  }
  return { helper: granted.helper, writable: confinedWritableSet(granted.writable, [callTmp.root, ...dirs]) };
}

/** Temp dirs createCallTempDir made and removeCallTempDir has not yet removed. */
const createdTempDirs = new Set<string>();

/**
 * A per-call temp dir for a confined call. The adapter points TMPDIR at it,
 * and the XDG cache and state dirs at `cache` and `state` inside it where the
 * CLI would otherwise write them under the operator's HOME.
 */
export interface CallTempDir {
  root: string;
  cache: string;
  state: string;
}

/**
 * The env a confined call's child gets for its temp dir: TMPDIR, and
 * TMPPREFIX for zsh, which ignores TMPDIR and writes here-document files
 * under /tmp/zsh by default (seen from Claude Code's Bash tool). With `xdg`,
 * also the XDG cache and state dirs, for an adapter that does not already
 * point them at a run-scoped dir.
 */
export function callTempDirEnv(dir: CallTempDir, options: { xdg: boolean }): Record<string, string> {
  return {
    TMPDIR: dir.root,
    TMPPREFIX: join(dir.root, 'zsh'),
    ...(options.xdg ? { XDG_CACHE_HOME: dir.cache, XDG_STATE_HOME: dir.state } : {}),
  };
}

/** Create a fresh per-call temp dir under the OS temp dir. */
export function createCallTempDir(): CallTempDir {
  const root = mkdtempSync(join(tmpdir(), 'conduit-call-tmp-'));
  try {
    const cache = join(root, 'cache');
    const state = join(root, 'state');
    mkdirSync(cache);
    mkdirSync(state);
    createdTempDirs.add(root);
    return { root, cache, state };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Remove a dir made by createCallTempDir. Ignores a dir this module did not create. */
export function removeCallTempDir(dir: CallTempDir): void {
  if (!createdTempDirs.has(dir.root)) return;
  rmSync(dir.root, { recursive: true, force: true });
  createdTempDirs.delete(dir.root);
}
