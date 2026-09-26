/**
 * Deterministic station runtime + Law-lite enforcement hook (WI-297, SPEC §4/§7, NFR-3).
 *
 * A deterministic station spawns ONE allowlisted command (NO shell — array form
 * only), captures stdout, stderr, and the exit code.
 *
 * The Law-lite positive allowlist is the enforcement hook (NFR-3: every enforcement
 * hook ships with unit tests).  The hook refuses BEFORE spawning any command that:
 *   (a) is not on the positive allowlist, or
 *   (b) contains a shell metacharacter in the command name or any argument.
 *
 * Denylist-based approaches are insufficient on an untrusted substrate — only a
 * positive allowlist guarantees the blast radius stays bounded.
 *
 * Containment (issues #10, #17): the command runs as its own process group, and
 * the runner SIGKILLs that group on timeout and again after the command exits,
 * so nothing the station started outlives it, whatever the exit reason.
 */

import { killProcessGroup, trackProcessGroup, untrackProcessGroup } from './process-group';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The command + argument list to spawn (no shell). */
export interface DeterministicCommand {
  command: string;
  args: string[];
}

/** The positive allowlist config for the Law-lite hook. */
export interface LawLiteConfig {
  allowlist: readonly string[];
  cwd?: string;
  /**
   * Optional wall-clock timeout in MILLISECONDS (pre-launch punch-list #8).
   * When set (> 0), the spawned command's process group is killed (SIGKILL) if
   * it exceeds the deadline and runDeterministic returns a timeout failure
   * rather than hanging.
   * Absent / undefined → unbounded (today's behaviour). The executor converts a
   * station's `timeout_seconds` to ms and threads it here.
   */
  timeoutMs?: number;
  /**
   * Extra environment variables to inject into the spawned command, layered
   * OVER the inherited process env (they take precedence on key collision).
   * The executor uses this to surface per-card execution context a deterministic
   * station cannot otherwise learn — CONDUIT_REWORK_COUNT / CONDUIT_ATTEMPT —
   * so downstream flows can implement rework-aware behaviour (e.g. flag-a-human
   * at the rework cap, or salt a no-progress regeneration).
   *
   * Absent / undefined → the command inherits the parent process env unchanged,
   * byte-for-byte today's behaviour (no env option passed to the spawn at all).
   */
  env?: Record<string, string>;
}

export type LawLiteVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'not_allowlisted' | 'shell_metacharacter' };

/** What the spawned command produced. */
export interface DeterministicResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True iff the command was killed because it exceeded the configured
   * `timeoutMs` (pre-launch punch-list #8). Absent/false on a normal exit.
   * A timeout is a failure (`ok: false`) that flows down the executor's normal
   * failure path (cap_policy → rework/scrap) — never thrown.
   */
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// Law-lite enforcement hook (pure, synchronous — NFR-3 tested hook)
// ---------------------------------------------------------------------------

/**
 * Positive character-class allowlist (poka-yoke — same philosophy as the
 * executable allowlist). A token is safe ONLY if every character is inside this
 * conservative safe set; anything outside it is treated as a shell metacharacter
 * and refused.
 *
 * Safe set: ASCII letters, digits, and  _ . / : = @ , + -
 *
 * Deliberately EXCLUDED (and therefore always rejected): control characters
 * (\n \r \t and the rest), whitespace, glob characters (* ? [ ]), brace
 * expansion ({ }), quotes (' "), parentheses ( ), and the shell operators
 * $ ` ; | & < > # ~ \ !.
 *
 * The empty string is safe (a zero-length token has no unsafe character).
 */
const SAFE_ARG_RE = /^[A-Za-z0-9_./:=@,+-]*$/;

function containsShellMetacharacter(s: string): boolean {
  // Any token containing a character outside the safe set is rejected.
  return !SAFE_ARG_RE.test(s);
}

/**
 * Pure enforcement hook: decide whether a command may be spawned.
 *
 * Checks in this order:
 *   1. Shell metacharacters in the command name or any argument → 'shell_metacharacter'.
 *      (Checked first so an attacker cannot learn the allowlist via error-oracle.)
 *   2. Command name not on the positive allowlist → 'not_allowlisted'.
 *   3. Both checks pass → allowed.
 */
export function checkCommandAllowed(
  cmd: DeterministicCommand,
  config: LawLiteConfig,
): LawLiteVerdict {
  // Guard 1 — metacharacter check (command name + every arg).
  const tokensToScan = [cmd.command, ...cmd.args];
  for (const token of tokensToScan) {
    if (containsShellMetacharacter(token)) {
      return { allowed: false, reason: 'shell_metacharacter' };
    }
  }

  // Guard 2 — positive allowlist check.
  if (!(config.allowlist as readonly string[]).includes(cmd.command)) {
    return { allowed: false, reason: 'not_allowlisted' };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// deterministicCardEnv — per-card execution context for the spawned command
// ---------------------------------------------------------------------------

/**
 * Build the per-card env a deterministic station is spawned with (market-flow
 * parity PATCH 2). A deterministic station has no worker IPC and no stdin
 * payload, so — unlike transform/harness workers — it cannot otherwise learn how
 * many times its card has been reworked or which attempt this is:
 *   - CONDUIT_REWORK_COUNT: times this card has been sent back for rework (a
 *     verdict/gate station can flag a human once this reaches the rework cap).
 *   - CONDUIT_ATTEMPT: the current execution attempt (salt a regeneration so a
 *     stuck no-progress card produces a different artifact next time).
 *
 * SINGLE source of truth for these var names so the synchronous in-process path
 * (executor.executeDeterministicStation) and the out-of-process pool path
 * (worker-entry) inject an identical env — otherwise a plain pure deterministic
 * station, which is pool-eligible, would silently see these vars only at
 * concurrency=1 and get empty strings under `--concurrency K>1`.
 */
export function deterministicCardEnv(reworkCount: number, attempt: number): Record<string, string> {
  return {
    CONDUIT_REWORK_COUNT: String(reworkCount),
    CONDUIT_ATTEMPT: String(attempt),
  };
}

// ---------------------------------------------------------------------------
// runDeterministic — spawn + capture (async)
// ---------------------------------------------------------------------------

/**
 * Run a deterministic command and return its captured output.
 *
 * Calls checkCommandAllowed FIRST.  If the verdict is denied, throws before
 * any process is spawned — the marker-file test verifies this invariant.
 *
 * Uses Bun.spawn with an array (no shell) so no metacharacter expansion can
 * occur at the OS level even if the guard were somehow bypassed.
 *
 * The command is spawned detached (its own process group). The group is
 * SIGKILLed when the timeout fires and again once the command has exited, so
 * a descendant it backgrounded neither keeps running nor holds the output
 * pipes open past the return.
 */
export async function runDeterministic(
  cmd: DeterministicCommand,
  config: LawLiteConfig,
): Promise<DeterministicResult> {
  const verdict = checkCommandAllowed(cmd, config);
  if (!verdict.allowed) {
    throw new Error(
      `Law-lite: command refused (${verdict.reason}): ${JSON.stringify(cmd.command)}`,
    );
  }

  // Punch-list #8: an optional wall-clock timeout. A timeout <= 0 or absent
  // means unbounded.
  const hasTimeout = typeof config.timeoutMs === 'number' && config.timeoutMs > 0;

  // Env injection: when extra vars are supplied, spawn with an explicit env that
  // is the inherited process env with the injected vars layered on top. Bun.spawn
  // REPLACES the environment when `env` is given, so we must spread process.env
  // first or the command would lose PATH and everything else. When no vars are
  // injected we pass no `env` at all, preserving today's plain inheritance
  // byte-for-byte.
  const hasEnv = config.env !== undefined && Object.keys(config.env).length > 0;

  const proc = Bun.spawn([cmd.command, ...cmd.args], {
    stdout: 'pipe',
    stderr: 'pipe',
    // setsid(): the child becomes its own session/process-group leader, so
    // `-proc.pid` addresses the whole group (grandchildren included) below.
    detached: true,
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(hasEnv ? { env: { ...process.env, ...config.env } } : {}),
  });
  // The detached group no longer receives the terminal's Ctrl-C, so register
  // it for the kernel's signal and exit handlers until the final kill below.
  trackProcessGroup(proc.pid);

  // Our own timer instead of Bun.spawn's native `timeout`, which kills only the
  // immediate child (#10). Killing the group also closes the pipes any
  // descendant inherited, so the drains below settle at the deadline.
  let timerFired = false;
  const timer = hasTimeout
    ? setTimeout(() => {
        timerFired = true;
        killProcessGroup(proc.pid);
      }, config.timeoutMs)
    : undefined;

  // Start draining now so a command that writes more than a pipe buffer is not
  // blocked on a full pipe while we wait for it to exit.
  const stdoutText = new Response(proc.stdout).text();
  const stderrText = new Response(proc.stderr as ReadableStream).text();
  // Attach a handler now: a drain that rejects while we await proc.exited
  // would otherwise be an unhandled rejection. `await drains` below rethrows it.
  const drains = Promise.all([stdoutText, stderrText]);
  drains.catch(() => {});

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
    // #17: the command has exited, but a descendant it backgrounded may still
    // be running and holding the pipes. Kill the group BEFORE awaiting the
    // drains so they settle. Bytes already written stay readable, so no output
    // is lost. The leader has already exited, so this does not change its exit
    // status. While any member is alive the group id cannot be reused, so the
    // signal reaches only this command's descendants; an empty group is ESRCH.
    killProcessGroup(proc.pid);
    untrackProcessGroup(proc.pid);
  }

  const [stdout, stderr] = await drains;

  // Distinguish OUR timeout-kill from a normal exit or an unrelated SIGKILL
  // (OOM-killer, a child that self-kills). Both must hold: our timer fired, and
  // the leader died of SIGKILL. The timer can fire in the gap between a natural
  // exit and the clearTimeout above; the leader then exited on its own, carries
  // no SIGKILL signalCode, and is not reported as timed out. The post-exit
  // group kill never reaches the leader, so it cannot mark a normal exit either.
  // Either way an unsuccessful exit is a failure (ok:false) on the same path;
  // only the `timedOut` label + message are gated on this check.
  const timedOut = timerFired && proc.signalCode === 'SIGKILL';

  if (timedOut) {
    // On a SIGKILL, `await proc.exited` resolves to 137 (128 + SIGKILL), even
    // though the `proc.exitCode` getter reads null. We use the resolved value;
    // SIGKILL_EXIT is a defensive fallback for that getter/promise skew.
    const SIGKILL_EXIT = 137;
    return {
      ok: false,
      exitCode: typeof exitCode === 'number' && exitCode !== 0 ? exitCode : SIGKILL_EXIT,
      stdout,
      stderr:
        stderr +
        (stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n') +
        `Law-lite: deterministic command '${cmd.command}' exceeded its timeout of ${config.timeoutMs}ms and was killed (SIGKILL).`,
      timedOut: true,
    };
  }

  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
  };
}
