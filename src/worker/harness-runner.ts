/**
 * Harness process runner (WI-561).
 *
 * The blast-radius floor at the process boundary (NFR-Security-6) and the
 * FR-7 timeout mechanism for `kind: harness` stations: spawns the harness CLI
 * as a child bounded by a wall-clock timeout, kills the WHOLE process GROUP
 * (not a lone pid) on expiry, and confines the child's cwd to inside the
 * project root.
 *
 * Bun.spawn's native `timeout`/`killSignal` kills only the immediate child: a
 * grandchild the harness backgrounds (a common agent-CLI pattern) reparents to
 * init and survives. This runner instead spawns the child DETACHED (`setsid()`,
 * so the child's pid becomes its own process-group id) and sends SIGKILL to the
 * negative pid, which is the whole group, grandchildren included
 * (`killProcessGroup` in ./process-group.ts, shared with runDeterministic):
 * on timeout, AND again once the harness leader has exited on its own (#17):
 * a backgrounded grandchild that inherited the stdout/stderr pipes would
 * otherwise keep them open and stall the drains until the timeout fires.
 *
 * Do NOT apply a command allowlist here — the harness binary comes from
 * trusted engine config (WI-560); the `tools` allowlist is enforced
 * elsewhere. Do NOT touch ./harness.ts (unrelated worker-pool subprocess
 * harness — naming collision only).
 *
 * Issue #31 adds an optional second timer: an idle bound, reset by every
 * stdout line, that kills the process group when the child goes silent well
 * under the wall-clock bound. This is the only thing that can actually catch
 * a hung harness call — a mid-call liveness stamp on the executor side
 * (issue #33) has no observable effect, because the executor's liveness
 * watchdog runs only between ticks and a harness station awaits one
 * `invoke()` call for the whole tick.
 */

import { resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { killProcessGroup, trackProcessGroup, untrackProcessGroup } from './process-group';

/** The command + argv to spawn (no shell — array form, per the Law-lite pattern). */
export interface HarnessCommand {
  command: string;
  args: string[];
}

export interface HarnessRunnerConfig {
  /** Absolute path the child's cwd must resolve inside. */
  projectRoot: string;
  /** Child working directory. Defaults to projectRoot; rejected if outside it. */
  cwd?: string;
  /** Wall-clock bound in milliseconds; must be > 0. */
  timeoutMs: number;
  /**
   * Names of environment variables the child is allowed to see (NFR-Security-2).
   * Sourced from engine configuration, never from flow.yaml. Defaults to `[]`
   * (fail-closed: no allowlist means a fully scrubbed child env).
   */
  envAllowlist?: string[];
  /**
   * The kernel environment to resolve `envAllowlist` names against. Injected
   * for testability; defaults to `process.env`.
   */
  sourceEnv?: Record<string, string | undefined>;
  /**
   * Variables the adapter constructs itself rather than forwards from the
   * kernel env (issue #29: claude-headless's run-scoped CLAUDE_CONFIG_DIR).
   * Applied after the allowlist, so a value here wins over an allowlisted one
   * of the same name. Never sourced from flow.yaml.
   */
  injectedEnv?: Readonly<Record<string, string>>;
  /**
   * Keep only the stdout lines this predicate accepts, discarding the rest AS
   * THEY ARRIVE rather than buffering the whole stream.
   *
   * For a line-delimited protocol this is the difference between holding a few
   * kilobytes and holding the entire agent transcript: a `stream-json` run that
   * merely read two files measured 57KB of stream against a 2KB result event,
   * and that ratio grows with every tool call across an 8-to-17-minute station.
   *
   * ONLY for newline-delimited output — a stream with no newlines accumulates
   * in the carry buffer exactly as an unfiltered read would.
   */
  stdoutLineFilter?: (line: string) => boolean;
  /**
   * Observe every complete stdout line as it arrives, independently of the
   * retention filter. This lets callers refresh liveness without retaining the
   * harness transcript in memory.
   */
  onStdoutLine?: (line: string) => void;
  /**
   * Idle bound in milliseconds (issue #31). Reset by every complete stdout
   * line; when no line arrives for this long the process group is killed,
   * independently of `timeoutMs`. The mid-call liveness stamp added in #33
   * (`onStdoutLine` feeding the executor's watchdog) has no observable effect
   * on its own: the executor's liveness check runs only between ticks, and a
   * harness station awaits one `invoke()` call for the whole tick, so nothing
   * ever reads the mid-call stamp before it is overwritten. This is the actual
   * bound — the runner is the only place that watches the child while it runs.
   * Undefined leaves every code path below unchanged: only the wall-clock
   * timer bounds a silent child, exactly as before this field existed.
   */
  idleTimeoutMs?: number;
}

/**
 * Drain a newline-delimited stream, observing each complete line as it
 * arrives (`onLine`) and returning the text the caller wants retained.
 *
 * `keep` selects which lines survive into the returned string, filtered AS
 * THEY ARRIVE rather than buffered whole — the memory-saving mode a
 * `stdoutLineFilter` uses. When `keep` is undefined every byte is retained
 * verbatim: the returned string is exactly what `new Response(stream).text()`
 * would produce, not a reconstruction from split lines, so a trailing newline
 * is preserved. This mode exists so a caller with no filter (an idle timeout
 * with no `stdoutLineFilter`) can still observe line boundaries through
 * `onLine`, without changing what the stream retains.
 *
 * Decoding is incremental (`{ stream: true }`) so a multi-byte character split
 * across two chunks is not mangled, and in filtered mode only the current
 * partial line plus the kept lines are ever held.
 */
async function readKeptLines(
  stream: ReadableStream<Uint8Array>,
  keep: ((line: string) => boolean) | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const kept: string[] = [];
  let full = '';
  let carry = '';

  for await (const chunk of stream) {
    const decoded = decoder.decode(chunk, { stream: true });
    if (keep === undefined) full += decoded;
    carry += decoded;
    let newline = carry.indexOf('\n');
    while (newline !== -1) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      onLine?.(line);
      if (keep !== undefined && keep(line)) kept.push(line);
      newline = carry.indexOf('\n');
    }
  }
  // Flush the decoder, then the final unterminated line (a stream need not end
  // with a newline, and on a crash it very often does not).
  const flushed = decoder.decode();
  if (keep === undefined) full += flushed;
  carry += flushed;
  if (carry.length > 0) {
    onLine?.(carry);
    if (keep !== undefined && keep(carry)) kept.push(carry);
  }

  return keep === undefined ? full : kept.join('\n');
}

export interface HarnessSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Measured wall-clock duration in milliseconds. */
  durationMs: number;
  /** True iff the process was killed for exceeding timeoutMs (not a normal exit). */
  timedOut: boolean;
  /**
   * True iff the IDLE timer killed the process (issue #31): no stdout line
   * arrived for `idleTimeoutMs`, distinct from a wall-clock kill. Recorded
   * directly from which timer fired, not derived from duration the way
   * `timedOut` is — an idle kill can land at any point in the run, so it has
   * no fixed relationship to `timeoutMs` a duration threshold could check.
   * Always false when `idleTimeoutMs` was not configured.
   */
  idledOut: boolean;
}

/** SIGKILL's conventional shell exit code (128 + 9), used when Bun reports no exit code. */
const SIGKILL_EXIT = 137;

/**
 * Builds the harness child env from an explicit allowlist (NFR-Security-2):
 * only the named variables, resolved from `sourceEnv`, reach the child — never
 * a wholesale copy of `sourceEnv`. An allowlisted name that is unset/absent in
 * `sourceEnv` is OMITTED, never injected as an empty string.
 */
export function buildHarnessChildEnv(
  envAllowlist: readonly string[],
  sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const name of envAllowlist) {
    const value = sourceEnv[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }
  return childEnv;
}

/**
 * Resolve the child's cwd and confine it inside projectRoot. Throws BEFORE
 * spawning if the resolved path is not projectRoot itself or a descendant.
 */
function resolveConfinedCwd(projectRoot: string, cwd: string | undefined): string {
  const root = resolve(projectRoot);
  // WI-591: a missing root (e.g. a deleted git worktree) must fail NAMING the
  // root itself — without this check, Bun.spawn's cwd failure surfaces as a
  // misleading ENOENT on the harness BINARY, not the actually-missing project
  // root, sending the operator chasing the wrong cause.
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(
      `harness runner: project root '${root}' does not exist — cannot confine the harness cwd`,
    );
  }
  const target = resolve(cwd ?? projectRoot);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `harness runner: cwd '${target}' resolves outside the project root '${root}'`,
    );
  }
  return target;
}

/**
 * Spawn `cmd` bounded by `config.timeoutMs`, and, when `config.idleTimeoutMs`
 * is set, by a second independent idle bound (issue #31). SIGKILLs the whole
 * process group (setsid-detached child) after the leader exits, on EVERY exit
 * path, not only on timeout (#17): a harness that finishes on its own but left
 * a grandchild backgrounded is reaped just the same, before the output drains
 * are awaited, so that grandchild cannot stall the runner until timeoutMs by
 * holding the inherited stdout/stderr pipes open. Only a genuine wall-clock
 * timeout resolves with `timedOut: true`; only a genuine idle kill resolves
 * with `idledOut: true`; a post-exit kill never marks a normal exit as either.
 */
export async function runHarnessProcess(
  cmd: HarnessCommand,
  config: HarnessRunnerConfig,
): Promise<HarnessSpawnResult> {
  const resolvedCwd = resolveConfinedCwd(config.projectRoot, config.cwd);
  const childEnv = {
    ...buildHarnessChildEnv(config.envAllowlist ?? [], config.sourceEnv ?? process.env),
    ...config.injectedEnv,
  };

  const startedAt = Date.now();
  const proc = Bun.spawn([cmd.command, ...cmd.args], {
    cwd: resolvedCwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // setsid(): the child becomes its own session/process-group leader, so
    // `-proc.pid` addresses the whole group (grandchildren included) below.
    detached: true,
    // Never inherit the parent env wholesale: only the allowlisted names plus
    // what the adapter constructed.
    env: childEnv,
  });
  // The detached group no longer receives the terminal's Ctrl-C, so register
  // it for the kernel's signal and exit handlers (./process-group.ts).
  trackProcessGroup(proc.pid);

  const timer = setTimeout(() => {
    killProcessGroup(proc.pid);
  }, config.timeoutMs);

  // Idle timer (issue #31): independent of `timer` above, reset by every
  // complete stdout LINE rather than every chunk. A chunk boundary is an
  // artifact of the pipe buffer size, not of the child's behavior, so
  // resetting on partial chunks would let a child dodge the idle check by
  // trickling bytes of one buffered write without ever completing a line. A
  // line is also the unit `stdoutLineFilter`/`onStdoutLine` already observe,
  // so "idle" means the same thing here as it does to those callers.
  //
  // `idledOutFired` is set directly inside the timer callback rather than
  // derived from duration the way `timedOut` is below: an idle kill can land
  // at any point in the run, so there is no fixed fraction of `timeoutMs` (or
  // of anything else) to compare against. It is still gated on
  // `proc.signalCode` once the process has actually exited, for the same
  // reason `timedOut` is: a flag set inside a timer callback can still fire
  // after the process already exited naturally at almost the same instant,
  // and only `signalCode` proves the kill actually happened.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idledOutFired = false;
  const resetIdleTimer = (): void => {
    if (config.idleTimeoutMs === undefined) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idledOutFired = true;
      killProcessGroup(proc.pid);
    }, config.idleTimeoutMs);
  };
  // Arm the clock from the moment the child starts: a child that never writes
  // anything at all must still be caught, not only one that goes silent after
  // an initial line.
  resetIdleTimer();

  // Every observed line both resets the idle timer (when configured) and
  // forwards to the caller's own onStdoutLine, if any.
  const observeLine =
    config.idleTimeoutMs !== undefined
      ? (line: string) => {
          resetIdleTimer();
          config.onStdoutLine?.(line);
        }
      : config.onStdoutLine;

  // Start draining now so a harness that writes more than a pipe buffer is not
  // blocked on a full pipe while we wait for it to exit. When idleTimeoutMs is
  // set but neither stdoutLineFilter nor onStdoutLine is, `observeLine` is
  // still defined (it must reset the idle timer), so the stream is still read
  // incrementally rather than buffered in one Response.text() call — the
  // `keep: undefined` mode of readKeptLines below retains exactly the same
  // bytes that call would have, just observed one line at a time.
  const stdoutText =
    config.stdoutLineFilter !== undefined
      ? readKeptLines(proc.stdout as ReadableStream<Uint8Array>, config.stdoutLineFilter, observeLine)
      : observeLine !== undefined
        ? readKeptLines(proc.stdout as ReadableStream<Uint8Array>, undefined, observeLine)
        : new Response(proc.stdout).text();
  const stderrText = new Response(proc.stderr as ReadableStream).text();
  // Attach a handler now: a throwing `stdoutLineFilter` rejects its drain while
  // proc.exited is still pending, which would otherwise be an unhandled
  // rejection. `await drains` below rethrows it after the group kill.
  const drains = Promise.all([stdoutText, stderrText]);
  drains.catch(() => {});

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    // #17: the harness has exited, but a descendant it backgrounded may still
    // be running and holding the pipes. Kill the group BEFORE awaiting the
    // drains below so they settle. Bytes already written stay readable, so no
    // output is lost. The leader has already exited, so this does not change
    // its exit status or signalCode. While any member is alive the group id
    // cannot be reused, so the signal reaches only this harness's descendants;
    // an empty group is ESRCH.
    killProcessGroup(proc.pid);
    untrackProcessGroup(proc.pid);
  }

  const [stdout, stderr] = await drains;

  const durationMs = Date.now() - startedAt;

  // Which timer actually killed the process (issue #31), gated on
  // proc.signalCode for the same reason timedOut is below: a flag set inside a
  // setTimeout callback can still fire after the process already exited
  // naturally at nearly the same instant, and only signalCode, read AFTER
  // proc.exited resolves, proves a SIGKILL actually happened.
  const idledOut = idledOutFired && proc.signalCode === 'SIGKILL';

  // Distinguish OUR timeout-kill from a normal exit. A shared flag set independently
  // inside the setTimeout callback would race: when the child exits naturally
  // right around the deadline, the timer can still fire and attempt a kill —
  // harmless (it fails silently on an already-exited pid) but a flag set there
  // would wrongly mark a genuinely successful run as timed out. Deriving
  // `timedOut` from proc.signalCode AFTER the process has actually exited
  // avoids that race: an already-exited process never carries a SIGKILL
  // signalCode, no matter how the timer callback and the exit event interleave.
  //
  // `!idledOut` keeps the two mutually exclusive even under a misconfigured
  // idleTimeoutMs close to timeoutMs (the loader rejects that combination for
  // a station, but this function takes no config validation on trust): an
  // idle kill is never also reported as a wall-clock timeout.
  const timedOut = !idledOut && proc.signalCode === 'SIGKILL' && durationMs >= config.timeoutMs * 0.9;

  return {
    exitCode: typeof exitCode === 'number' ? exitCode : SIGKILL_EXIT,
    stdout,
    stderr,
    durationMs,
    timedOut,
    idledOut,
  };
}
