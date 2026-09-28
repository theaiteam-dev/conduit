/**
 * cgroup v2 containment for station and harness processes (issue #77).
 *
 * A process-group kill (./process-group.ts) reaches only descendants that stay
 * in the group. Claude Code's Bash tool runs every command in a new session,
 * so those commands escape it. A new session or group does not move a process
 * out of its cgroup: every descendant stays in the cgroup it was born in unless
 * it writes itself into another, and writing `1` to `cgroup.kill` (Linux 5.14+)
 * SIGKILLs all of them. Descendants run as the kernel's user, who can write the
 * parent cgroup, so a command that deliberately moves itself there escapes; see
 * docs/harness-containment.md.
 *
 * Mechanism, per spawn:
 *
 *   1. Create `conduit-<kernel pid>-<start time>-<n>` under the kernel's own
 *      cgroup, where the start time is the kernel's, from /proc. No
 *      controllers are enabled, so the cgroup v2 "no internal processes" rule
 *      does not apply and the kernel may stay in the parent.
 *   2. Spawn the command through `/bin/sh -c 'echo $$ > cgroup.procs && exec'`.
 *      The shell moves itself into the new cgroup and then execs the command,
 *      keeping its pid, so the command is inside the cgroup before it runs a
 *      single instruction. Moving the child after spawn would race with its
 *      first fork.
 *   3. On every path the runners kill the process group today, also write
 *      `cgroup.kill`, then remove the directory once it is empty.
 *
 * Detection runs once per process: it creates a probe cgroup, moves a real
 * process into it, kills it through `cgroup.kill`, and removes it. When any
 * step fails (no cgroup v2, a read-only /sys/fs/cgroup as in a default Docker
 * container, a kernel without `cgroup.kill`, a cgroup the kernel's user may
 * not write), the runners fall back to the process-group kill alone and warn
 * once on stderr. `conduit doctor` reports which mechanism is in use.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** statfs f_type of a cgroup v2 filesystem. */
const CGROUP2_SUPER_MAGIC = 0x63677270;

/** The default cgroup v2 mount point. */
const DEFAULT_CGROUP_MOUNT = '/sys/fs/cgroup';

/**
 * Prefix of every cgroup the kernel creates; the kernel pid and start time
 * follow it.
 */
const CGROUP_PREFIX = 'conduit-';

/** Upper bound on waiting for a killed cgroup to empty before removing it. */
const REMOVE_BUDGET_MS = 5_000;

/** Upper bound on the detection probe's own waits. */
const PROBE_BUDGET_MS = 3_000;

/**
 * Exit status of the spawn wrapper when the child could not join its cgroup.
 * The command never runs; the runner sees a failed invocation with the
 * wrapper's message on stderr.
 */
export const CGROUP_JOIN_FAILED_EXIT = 125;

/**
 * The shell wrapper. `$0` is the cgroup.procs path and `"$@"` the command.
 * `$$` is the shell's pid, which `exec` hands to the command unchanged.
 */
const WRAPPER_SCRIPT =
  `echo $$ > "$0" || { echo "conduit: could not join containment cgroup $0" >&2; exit ${CGROUP_JOIN_FAILED_EXIT}; }; ` +
  'exec "$@"';

/** The shell the wrapper runs under. Absolute, because the child env may carry no PATH. */
const WRAPPER_SHELL = '/bin/sh';

export type Containment =
  | {
      mechanism: 'cgroup';
      /** Absolute path of the cgroup each invocation's own cgroup is created under. */
      parent: string;
    }
  | {
      mechanism: 'process-group';
      /** Why cgroup containment is unavailable on this host. */
      reason: string;
    };

export interface DetectContainmentOptions {
  /** The cgroup v2 mount point. Defaults to /sys/fs/cgroup. */
  cgroupMount?: string;
  /** Contents of /proc/self/cgroup. Defaults to reading it. */
  procSelfCgroup?: string;
}

function errorText(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * The start time of process `pid`, in clock ticks since boot: field 22 of
 * /proc/<pid>/stat. Unlike a pid, the kernel does not hand the pair
 * (pid, start time) to another process. Undefined when the process is not
 * running or /proc cannot be read.
 */
export function processStartTime(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return undefined;
  }
  // Field 2 is the command name in parentheses and may itself contain spaces
  // and parentheses, so count fields from the last `)`: field 3 follows it.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const value = Number(fields[22 - 3]);
  return Number.isSafeInteger(value) ? value : undefined;
}

let ownerTagMemo: string | undefined;

/**
 * `<pid>-<start time>` of this kernel, the owner part of every cgroup name it
 * creates. Throws when /proc/self/stat cannot be read; detection checks that
 * first and falls back to the process-group kill.
 */
function ownerTag(): string {
  if (ownerTagMemo !== undefined) return ownerTagMemo;
  const startTime = processStartTime(process.pid);
  if (startTime === undefined) throw new Error('cannot read the start time of this process from /proc/self/stat');
  ownerTagMemo = `${process.pid}-${startTime}`;
  return ownerTagMemo;
}

/** Whether the cgroup at `dir` still holds any process, itself or below. */
function isPopulated(dir: string): boolean {
  try {
    return /^populated 1$/m.test(readFileSync(join(dir, 'cgroup.events'), 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Cgroup dirs `killCgroup` has already warned about a non-ENOENT write
 * failure for. An entry is dropped once its cgroup is gone, so the set holds
 * only cgroups that still exist.
 */
const warnedKillFailures = new Set<string>();

/**
 * SIGKILL every process in the cgroup at `dir`, descendants included. ENOENT
 * is silent: an already-removed cgroup, or one that was never populated, has
 * nothing left to kill. Any other error (EACCES, EPERM, EIO, a read-only
 * filesystem) means the write did NOT happen, so containment for this
 * invocation silently fell back to the escapable process-group kill; that is
 * worth a warning. Warn at most once per `dir`, because `removeCgroup` calls
 * this every 10ms in its retry loop and a per-call warning would spam.
 * Synchronous, so the kernel's exit handler can call it, and it never throws.
 */
export function killCgroup(
  dir: string,
  warn: (message: string) => void = (message) => process.stderr.write(message + '\n'),
): void {
  try {
    writeFileSync(join(dir, 'cgroup.kill'), '1');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return;
    if (warnedKillFailures.has(dir)) return;
    warnedKillFailures.add(dir);
    try {
      warn(
        `conduit: warning: could not kill containment cgroup ${dir} (${errorText(err)}). ` +
          'Containment for this invocation fell back to the process-group kill.',
      );
    } catch {
      /* a broken warn sink must not make killCgroup throw */
    }
  }
}

/**
 * Remove the cgroup at `dir` once it is empty. `cgroup.kill` delivers SIGKILL
 * but the processes take a moment to exit, and a populated cgroup cannot be
 * removed. Kills again on each retry in case something was mid-fork. Gives up
 * silently after REMOVE_BUDGET_MS; the next kernel's sweep removes the
 * leftover. Never rejects: every error is either the goal (ENOENT) or retried
 * until the deadline, so callers may await it in a catch or finally without
 * masking the error or result they are handling.
 */
export async function removeCgroup(dir: string, budgetMs: number = REMOVE_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      rmdirSync(dir);
      warnedKillFailures.delete(dir);
      return;
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        warnedKillFailures.delete(dir);
        return;
      }
      if (Date.now() >= deadline) return;
    }
    if (isPopulated(dir)) killCgroup(dir);
    await sleep(10);
  }
}

/**
 * Synchronous `removeCgroup` for the kernel's signal and exit handlers, which
 * cannot await. Blocks for at most `budgetMs` in total across `dirs`, which
 * is normally a few milliseconds: SIGKILLed processes exit promptly. Kills
 * again on each retry, as `removeCgroup` does. What is still populated at the
 * deadline is left for the next kernel's sweep.
 */
export function removeCgroupsSync(dirs: readonly string[], budgetMs: number = 250): void {
  const deadline = Date.now() + budgetMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let pending = [...dirs];
  while (pending.length > 0) {
    pending = pending.filter((dir) => {
      try {
        rmdirSync(dir);
        warnedKillFailures.delete(dir);
        return false;
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          warnedKillFailures.delete(dir);
          return false;
        }
        if (isPopulated(dir)) killCgroup(dir);
        return true;
      }
    });
    if (pending.length === 0 || Date.now() >= deadline) return;
    Atomics.wait(pause, 0, 0, 5);
  }
}

/** The kernel's own cgroup path from /proc/self/cgroup's unified (`0::`) line. */
function unifiedCgroupPath(procSelfCgroup: string): string | undefined {
  for (const line of procSelfCgroup.split('\n')) {
    if (line.startsWith('0::')) return line.slice(3).trim();
  }
  return undefined;
}

/**
 * Whether the kernel that created the cgroup named `name` is gone. The name
 * carries the owner's pid and start time, so a pid that another process has
 * since been given does not keep the cgroup alive. A name with no start time
 * (`conduit-<pid>-<n>`, from a kernel built before issue #81) falls back to
 * whether the pid is running, as does an owner whose start time cannot be
 * read. Undefined for a name the kernel did not create.
 */
function isOwnerGone(name: string): boolean | undefined {
  const match = /^conduit-(\d+)-(?:(\d+)-[^-]+|[^-]+)$/.exec(name);
  if (match === null) return undefined;
  const owner = Number(match[1]);
  if (owner === process.pid) return false;
  if (match[2] === undefined) return !isPidAlive(owner);
  const startTime = processStartTime(owner);
  // An unreadable stat for a pid that still answers kill(0) is another user's
  // process under a `hidepid` /proc mount. Keep its cgroup: killing a live
  // kernel's invocation is worse than leaving an orphan for a later sweep.
  if (startTime === undefined) return !isPidAlive(owner);
  return startTime !== Number(match[2]);
}

/**
 * Kill and remove cgroups a previous kernel left behind: `conduit-*` under
 * `parent` whose owner is no longer running (see `isOwnerGone`). A kernel that
 * was SIGKILLed ran no exit handler, so anything its stations started is still
 * in there.
 */
async function sweepStaleCgroups(parent: string): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  const stale: string[] = [];
  for (const name of entries) {
    if (isOwnerGone(name) !== true) continue;
    const dir = join(parent, name);
    killCgroup(dir);
    stale.push(dir);
  }
  await Promise.all(stale.map((dir) => removeCgroup(dir, 1_000)));
}

/**
 * Decide the containment mechanism for this host. Returns `cgroup` only after
 * proving the whole mechanism end to end with a real probe process: create a
 * child cgroup, move the probe into it through the same wrapper the runners
 * use, confirm the move from /proc, kill it through `cgroup.kill`, and remove
 * the cgroup. Any failure returns `process-group` with the reason.
 */
export async function detectContainment(options: DetectContainmentOptions = {}): Promise<Containment> {
  const fallback = (reason: string): Containment => ({ mechanism: 'process-group', reason });

  if (process.platform !== 'linux') return fallback(`cgroups are Linux-only (platform ${process.platform})`);

  const mount = options.cgroupMount ?? DEFAULT_CGROUP_MOUNT;
  let procSelfCgroup = options.procSelfCgroup;
  if (procSelfCgroup === undefined) {
    try {
      procSelfCgroup = readFileSync('/proc/self/cgroup', 'utf-8');
    } catch (err) {
      return fallback(`cannot read /proc/self/cgroup (${errorText(err)})`);
    }
  }
  const selfPath = unifiedCgroupPath(procSelfCgroup);
  if (selfPath === undefined) return fallback('no cgroup v2 hierarchy (/proc/self/cgroup has no unified entry)');

  try {
    if (statfsSync(mount).type !== CGROUP2_SUPER_MAGIC) return fallback(`${mount} is not a cgroup v2 filesystem`);
  } catch (err) {
    return fallback(`cannot stat ${mount} (${errorText(err)})`);
  }

  // In a private cgroup namespace (a container) the kernel's own cgroup is `/`.
  const parent = selfPath === '/' ? mount : join(mount, selfPath);
  if (!existsSync(join(parent, 'cgroup.procs'))) {
    return fallback(`the kernel's cgroup ${parent} is not visible under ${mount}`);
  }
  if (!existsSync(join(parent, 'cgroup.kill'))) {
    return fallback(`${parent} has no cgroup.kill (requires Linux 5.14 or later)`);
  }

  let owner: string;
  try {
    owner = ownerTag();
  } catch (err) {
    return fallback(errorText(err));
  }

  await sweepStaleCgroups(parent);

  const probe = join(parent, `${CGROUP_PREFIX}${owner}-probe`);
  try {
    mkdirSync(probe);
  } catch (err) {
    return fallback(`cannot create a cgroup under ${parent} (${errorText(err)})`);
  }

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    if (!existsSync(join(probe, 'cgroup.kill'))) {
      return fallback(`${probe} was created but is not a cgroup`);
    }
    const sleepPath = Bun.which('sleep', { PATH: '/usr/bin:/bin' });
    if (sleepPath === null) return fallback('cannot find sleep to probe the cgroup');
    proc = Bun.spawn([WRAPPER_SHELL, '-c', WRAPPER_SCRIPT, join(probe, 'cgroup.procs'), sleepPath, '30'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });

    // Wait until /proc shows the probe inside the new cgroup, or it exits.
    const expected = `0::${selfPath === '/' ? '' : selfPath}/${CGROUP_PREFIX}${owner}-probe`;
    const deadline = Date.now() + PROBE_BUDGET_MS;
    let joined = false;
    while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
      try {
        if (readFileSync(`/proc/${proc.pid}/cgroup`, 'utf-8').includes(expected)) {
          joined = true;
          break;
        }
      } catch {
        /* not visible yet */
      }
      await sleep(5);
    }
    if (!joined) {
      const stderr = proc.exitCode !== null ? (await new Response(proc.stderr as ReadableStream).text()).trim() : '';
      return fallback(`cannot move a process into a cgroup under ${parent}${stderr ? ` (${stderr})` : ''}`);
    }

    killCgroup(probe);
    const killed = await Promise.race([proc.exited.then(() => true), sleep(PROBE_BUDGET_MS).then(() => false)]);
    if (!killed || proc.signalCode !== 'SIGKILL') {
      return fallback(`writing cgroup.kill under ${parent} did not kill the probe process`);
    }
    return { mechanism: 'cgroup', parent };
  } finally {
    if (proc !== undefined && proc.exitCode === null && proc.signalCode === null) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    killCgroup(probe);
    await removeCgroup(probe, 1_000);
  }
}

/**
 * The one-time warning for a host that falls back to process-group
 * containment. Undefined when cgroup containment is in use.
 */
export function containmentWarning(containment: Containment): string | undefined {
  if (containment.mechanism === 'cgroup') return undefined;
  return (
    `conduit: warning: process containment is the process-group kill only: ${containment.reason}. ` +
    `A command a station or harness starts in a new session (Claude Code's Bash tool does this for ` +
    `every command) can outlive its invocation. See docs/harness-containment.md.`
  );
}

/** A one-line description of `containment` for `conduit doctor`. */
export function describeContainment(containment: Containment): string {
  return containment.mechanism === 'cgroup'
    ? `cgroup v2, one cgroup per invocation under ${containment.parent}`
    : `process group only (${containment.reason}); a command started in a new session can outlive its ` +
        `invocation, see docs/harness-containment.md`;
}

/**
 * Build a memoized resolver: detection runs on the first call, and a fallback
 * warns exactly once through `warn`.
 */
export function createContainmentResolver(
  detect: () => Promise<Containment> = () => detectContainment(),
  warn: (message: string) => void = (message) => process.stderr.write(message + '\n'),
): () => Promise<Containment> {
  let pending: Promise<Containment> | undefined;
  return () => {
    pending ??= detect().then((containment) => {
      const warning = containmentWarning(containment);
      if (warning !== undefined) warn(warning);
      return containment;
    });
    return pending;
  };
}

/** The process-wide resolver both runners use when no containment is injected. */
export const resolveContainment = createContainmentResolver();

let cgroupSequence = 0;

/** What a runner spawns, and the cgroup to kill and remove afterwards, if any. */
export interface ContainedCommand {
  argv: string[];
  cgroup: string | undefined;
}

/**
 * Where Bun.spawn would look a bare command name up: the child env's PATH when
 * an env is given (Bun falls back to /usr/bin:/bin when it has none), the
 * kernel's PATH otherwise.
 */
function lookupPath(env: Record<string, string | undefined> | undefined): string {
  if (env === undefined) return process.env.PATH ?? '/usr/bin:/bin';
  return env.PATH !== undefined && env.PATH !== '' ? env.PATH : '/usr/bin:/bin';
}

/**
 * Prepare `argv` for a contained spawn. Under process-group containment it is
 * returned unchanged. Under cgroup containment this creates the invocation's
 * cgroup and wraps the command so the child joins it before it runs.
 *
 * The command is resolved to an absolute path here, against the same PATH
 * Bun.spawn would use, because the wrapper shell would otherwise resolve it
 * against its own default PATH. A command that is not found throws the same
 * ENOENT Bun.spawn throws, before anything is created.
 */
export function prepareContainedCommand(
  containment: Containment,
  argv: readonly string[],
  spawnOptions: { cwd?: string; env?: Record<string, string | undefined> },
): ContainedCommand {
  if (containment.mechanism === 'process-group') return { argv: [...argv], cgroup: undefined };

  const [command, ...args] = argv;
  if (command === undefined) throw new Error('prepareContainedCommand: empty argv');
  const resolved = Bun.which(command, {
    PATH: lookupPath(spawnOptions.env),
    ...(spawnOptions.cwd !== undefined ? { cwd: spawnOptions.cwd } : {}),
  });
  if (resolved === null) {
    // Bun.which returns null for a path that exists but is not executable too,
    // where Bun.spawn throws EACCES. Keep that distinction for the operator.
    if (command.includes('/') && existsSync(resolve(spawnOptions.cwd ?? process.cwd(), command))) {
      throw Object.assign(new Error(`Permission denied: "${command}" is not executable`), { code: 'EACCES' });
    }
    throw Object.assign(new Error(`Executable not found in $PATH: "${command}"`), { code: 'ENOENT' });
  }

  cgroupSequence += 1;
  const cgroup = join(containment.parent, `${CGROUP_PREFIX}${ownerTag()}-${cgroupSequence}`);
  try {
    mkdirSync(cgroup);
  } catch (err) {
    throw new Error(`conduit: cannot create containment cgroup ${cgroup} (${errorText(err)})`);
  }
  return {
    argv: [WRAPPER_SHELL, '-c', WRAPPER_SCRIPT, join(cgroup, 'cgroup.procs'), resolved, ...args],
    cgroup,
  };
}
