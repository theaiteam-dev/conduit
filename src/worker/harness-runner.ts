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
}

/**
 * Drain a newline-delimited stream, retaining only the lines `keep` accepts.
 *
 * Decoding is incremental (`{ stream: true }`) so a multi-byte character split
 * across two chunks is not mangled, and only the current partial line plus the
 * kept lines are ever held.
 */
async function readKeptLines(
  stream: ReadableStream<Uint8Array>,
  keep: (line: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  const kept: string[] = [];
  let carry = '';

  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    let newline = carry.indexOf('\n');
    while (newline !== -1) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      if (keep(line)) kept.push(line);
      newline = carry.indexOf('\n');
    }
  }
  // Flush the decoder, then the final unterminated line (a stream need not end
  // with a newline, and on a crash it very often does not).
  carry += decoder.decode();
  if (carry.length > 0 && keep(carry)) kept.push(carry);

  return kept.join('\n');
}

export interface HarnessSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Measured wall-clock duration in milliseconds. */
  durationMs: number;
  /** True iff the process was killed for exceeding timeoutMs (not a normal exit). */
  timedOut: boolean;
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
 * Spawn `cmd` bounded by `config.timeoutMs`. SIGKILLs the whole process group
 * (setsid-detached child) after the leader exits, on EVERY exit path, not only
 * on timeout (#17): a harness that finishes on its own but left a grandchild
 * backgrounded is reaped just the same, before the output drains are awaited,
 * so that grandchild cannot stall the runner until timeoutMs by holding the
 * inherited stdout/stderr pipes open. Only a genuine timeout resolves with
 * `timedOut: true`; a post-exit kill never marks a normal exit as one.
 */
export async function runHarnessProcess(
  cmd: HarnessCommand,
  config: HarnessRunnerConfig,
): Promise<HarnessSpawnResult> {
  const resolvedCwd = resolveConfinedCwd(config.projectRoot, config.cwd);
  const childEnv = buildHarnessChildEnv(config.envAllowlist ?? [], config.sourceEnv ?? process.env);

  const startedAt = Date.now();
  const proc = Bun.spawn([cmd.command, ...cmd.args], {
    cwd: resolvedCwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // setsid(): the child becomes its own session/process-group leader, so
    // `-proc.pid` addresses the whole group (grandchildren included) below.
    detached: true,
    // Never inherit the parent env wholesale — only the allowlisted names.
    env: childEnv,
  });
  // The detached group no longer receives the terminal's Ctrl-C, so register
  // it for the kernel's signal and exit handlers (./process-group.ts).
  trackProcessGroup(proc.pid);

  const timer = setTimeout(() => {
    killProcessGroup(proc.pid);
  }, config.timeoutMs);

  // Start draining now so a harness that writes more than a pipe buffer is not
  // blocked on a full pipe while we wait for it to exit.
  const stdoutText =
    config.stdoutLineFilter !== undefined
      ? readKeptLines(proc.stdout as ReadableStream<Uint8Array>, config.stdoutLineFilter)
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

  // Distinguish OUR timeout-kill from a normal exit. A shared flag set independently
  // inside the setTimeout callback would race: when the child exits naturally
  // right around the deadline, the timer can still fire and attempt a kill —
  // harmless (it fails silently on an already-exited pid) but a flag set there
  // would wrongly mark a genuinely successful run as timed out. Deriving
  // `timedOut` from proc.signalCode AFTER the process has actually exited
  // avoids that race: an already-exited process never carries a SIGKILL
  // signalCode, no matter how the timer callback and the exit event interleave.
  const timedOut = proc.signalCode === 'SIGKILL' && durationMs >= config.timeoutMs * 0.9;

  return {
    exitCode: typeof exitCode === 'number' ? exitCode : SIGKILL_EXIT,
    stdout,
    stderr,
    durationMs,
    timedOut,
  };
}
