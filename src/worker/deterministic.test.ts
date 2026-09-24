/**
 * Tests for the deterministic worker runtime + Law-lite (WI-297, SPEC §4/§7).
 *
 * A deterministic station spawns ONE allowlisted command (no shell), captures
 * stdout and the exit code. The Law-lite enforcement hook (NFR-3: every
 * enforcement hook ships with unit tests) refuses BEFORE execution any command
 * that is (a) not on the positive allowlist, or (b) carries any character
 * outside the conservative safe set (a POSITIVE character allowlist). That
 * includes control characters (newline, tab, carriage return), globs, quotes,
 * braces, parens, and the classic shell operators (pipes, redirects, ;,
 * backticks, $()). Denylists are insufficient against a cheap model on an
 * untrusted substrate — this is a positive allowlist on both axes.
 *
 * Contract this file pins for src/worker/deterministic.ts:
 *
 *   interface DeterministicCommand { command: string; args: string[] }
 *   interface LawLiteConfig { allowlist: readonly string[] }
 *   type LawLiteVerdict =
 *     | { allowed: true }
 *     | { allowed: false; reason: 'not_allowlisted' | 'shell_metacharacter' }
 *   function checkCommandAllowed(cmd: DeterministicCommand, config: LawLiteConfig): LawLiteVerdict  // pure
 *
 *   interface DeterministicResult { ok: boolean; exitCode: number; stdout: string; stderr: string }
 *   function runDeterministic(cmd, config): Promise<DeterministicResult>
 *     // MUST call checkCommandAllowed first and THROW (refuse) before spawning if denied.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCommandAllowed,
  runDeterministic,
  type DeterministicCommand,
  type LawLiteConfig,
} from './deterministic';
import { describeContainmentConformance } from './harness-containment.conformance';

const ALLOW: LawLiteConfig = { allowlist: ['bun'] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-det-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — spawn an allowlisted command; capture stdout and the exit code.
// ---------------------------------------------------------------------------

describe('runDeterministic — execution (AC1)', () => {
  it('spawns an allowlisted command and captures stdout with exit 0', async () => {
    const result = await runDeterministic({ command: 'bun', args: ['--version'] }, ALLOW);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/); // the bun version string
  });

  it('captures a non-zero exit code as a failure', async () => {
    const result = await runDeterministic(
      { command: 'bun', args: ['run', '__no_such_script_xyz__'] },
      ALLOW,
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Law-lite: refuse non-allowlisted / shell-metacharacter commands.
//        checkCommandAllowed is the pure, unit-tested enforcement hook (NFR-3).
// ---------------------------------------------------------------------------

describe('checkCommandAllowed — Law-lite hook (AC2)', () => {
  it('allows an allowlisted command with clean args', () => {
    expect(checkCommandAllowed({ command: 'bun', args: ['--version'] }, ALLOW)).toEqual({
      allowed: true,
    });
  });

  it('allows args using the full safe set (paths, flags, key=value, @, commas, +)', () => {
    expect(
      checkCommandAllowed(
        { command: 'bun', args: ['run', './src/a-b_c.ts', '--out=dist/x.js', 'a@b.com,1.2.3+build'] },
        ALLOW,
      ),
    ).toEqual({ allowed: true });
  });

  it('allows an empty-string arg (zero-length token has no unsafe character)', () => {
    expect(checkCommandAllowed({ command: 'bun', args: [''] }, ALLOW)).toEqual({ allowed: true });
  });

  it('refuses a command that is not on the allowlist', () => {
    const verdict = checkCommandAllowed({ command: 'rm', args: ['-rf', '/'] }, ALLOW);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('not_allowlisted');
  });

  it.each([
    [';', ['a;rm']],
    ['pipe', ['a|b']],
    ['ampersand', ['a&&b']],
    ['backtick', ['`id`']],
    ['command-subst', ['$(whoami)']],
    ['var-subst', ['${HOME}']],
    ['redirect-out', ['a>b']],
    ['redirect-in', ['a<b']],
    // Control characters and whitespace — a denylist regex misses these and is
    // the exact escape the positive allowlist closes (e.g. "a\nrm -rf /").
    ['newline', ['a\nrm -rf /']],
    ['tab', ['a\tb']],
    ['carriage-return', ['a\rb']],
    ['space', ['a b']],
    // Glob, brace, quote, and paren characters — never legitimate unquoted args.
    ['glob-star', ['*']],
    ['glob-question', ['a?']],
    ['glob-bracket', ['a[b]']],
    ['brace', ['{a,b}']],
    ['single-quote', ["a'b"]],
    ['double-quote', ['a"b']],
    ['paren-open', ['a(b']],
    ['paren-close', ['a)b']],
  ])('refuses an allowlisted command carrying a %s metacharacter in args', (_label, args) => {
    const verdict = checkCommandAllowed({ command: 'bun', args }, ALLOW);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('shell_metacharacter');
  });

  it('refuses shell metacharacters embedded in the command itself', () => {
    const verdict = checkCommandAllowed({ command: 'bun;rm', args: [] }, ALLOW);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('shell_metacharacter');
  });

  it('reports shell_metacharacter (NOT not_allowlisted) when a command is BOTH — no allowlist oracle leak', () => {
    // 'rm;evil' is neither on the allowlist NOR clean. The metacharacter guard
    // must take precedence so the verdict never reveals allowlist membership.
    const verdict = checkCommandAllowed({ command: 'rm;evil', args: [] }, ALLOW);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('shell_metacharacter');
  });
});

// ---------------------------------------------------------------------------
// Pre-launch punch-list #8 — per-station timeout_seconds for deterministic
// workers. A hung command is an *active* worker, so the liveness watchdog never
// trips; an unbounded spawn is a real deadlock. When a timeout is configured the
// command MUST be killed and the function MUST return a structured timeout
// failure (ok: false, timedOut: true) so the executor's normal failure path
// (cap_policy → rework/scrap) applies — it must NOT throw and must NOT hang.
// ---------------------------------------------------------------------------

describe('runDeterministic — timeout enforcement (punch-list #8)', () => {
  it('kills a command that exceeds its timeout and returns a timeout failure within the window', async () => {
    const start = Date.now();
    const result = await runDeterministic(
      { command: 'sleep', args: ['2'] },
      { allowlist: ['sleep'], timeoutMs: 200 },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // Returned at ~the timeout window, NOT after the full 2s sleep.
    expect(elapsed).toBeLessThan(1500);
  });

  it('returns the normal successful result when the command finishes under the timeout', async () => {
    const result = await runDeterministic(
      { command: 'bun', args: ['--version'] },
      { allowlist: ['bun'], timeoutMs: 5000 },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalsy();
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('behaves exactly as today when no timeout is configured (unbounded)', async () => {
    const result = await runDeterministic({ command: 'bun', args: ['--version'] }, ALLOW);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalsy();
  });

  // Code-review fix #1 — a SIGKILL that is NOT from our timeout (here: the child
  // kills itself well before the deadline) must NOT be mislabeled `timedOut`.
  // The elapsed-time guard keeps the timeout diagnostic honest. The self-kill
  // lives in a SCRIPT FILE (not argv) so the Law-lite metacharacter scan — which
  // only inspects argv — admits it; the path is plain safe-charset.
  it('does NOT report timedOut for a SIGKILL that landed well before the deadline', async () => {
    const script = join(dir, 'selfkill.sh');
    writeFileSync(script, '#!/usr/bin/env bash\nkill -9 $$\n');
    chmodSync(script, 0o755);

    const start = Date.now();
    const result = await runDeterministic(
      { command: 'bash', args: [script] },
      { allowlist: ['bash'], timeoutMs: 10_000 },
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000); // died immediately, not at the deadline
    expect(result.ok).toBe(false); // still a failure (signal-terminated)
    expect(result.timedOut).toBeFalsy(); // ...but NOT attributed to the timeout
    // And the misleading "exceeded its timeout" line must not be appended.
    expect(result.stderr).not.toMatch(/exceeded its timeout/i);
  });
});

describe('runDeterministic — refuses before execution (AC2)', () => {
  it('refuses a non-allowlisted command and never spawns it', async () => {
    const marker = join(dir, 'marker.txt');
    // 'touch' is NOT allowlisted; if the Law-lite guard fails, touch would create
    // the marker. We assert it throws AND the marker was never created.
    await expect(
      runDeterministic({ command: 'touch', args: [marker] }, ALLOW),
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false); // proves: refused BEFORE execution
  });

  it('refuses a command carrying shell metacharacters', async () => {
    const badCmd: DeterministicCommand = { command: 'bun', args: ['-e', 'x>y'] };
    await expect(runDeterministic(badCmd, ALLOW)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Market-flow parity PATCH 2 — optional per-spawn env injection. The executor
// uses this to surface CONDUIT_REWORK_COUNT / CONDUIT_ATTEMPT to deterministic
// stations. Injected vars must reach the child AND must layer OVER (not replace)
// the inherited process env; when no env is supplied the spawn is byte-for-byte
// today's plain inheritance.
// ---------------------------------------------------------------------------

describe('runDeterministic — env injection', () => {
  it('passes injected env vars through to the spawned command', async () => {
    const script = join(dir, 'echo-env.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "%s" "$CONDUIT_REWORK_COUNT"\n');
    chmodSync(script, 0o755);

    const result = await runDeterministic(
      { command: 'sh', args: [script] },
      { allowlist: ['sh'], env: { CONDUIT_REWORK_COUNT: '7' } },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('7');
  });

  it('layers injected vars OVER the inherited process env (does not strip it)', async () => {
    process.env.CONDUIT_DET_UNIT_PROBE = 'from-parent';
    try {
      const script = join(dir, 'echo-both.sh');
      writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$CONDUIT_DET_UNIT_PROBE" "$CONDUIT_ATTEMPT"\n');
      chmodSync(script, 0o755);

      const result = await runDeterministic(
        { command: 'sh', args: [script] },
        { allowlist: ['sh'], env: { CONDUIT_ATTEMPT: '4' } },
      );

      // Inherited var survives, injected var is present.
      expect(result.stdout).toBe('from-parent|4');
    } finally {
      delete process.env.CONDUIT_DET_UNIT_PROBE;
    }
  });

  it('behaves exactly as today when no env is supplied (plain inheritance of the startup env)', async () => {
    // With no env option the spawn inherits the process env exactly as before —
    // PATH (a guaranteed startup var) reaches the child unchanged.
    const script = join(dir, 'echo-path.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "%s" "$PATH"\n');
    chmodSync(script, 0o755);

    const result = await runDeterministic({ command: 'sh', args: [script] }, { allowlist: ['sh'] });

    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toBe(process.env.PATH ?? '');
  });
});

// ---------------------------------------------------------------------------
// Containment conformance (issue #27). runDeterministic is the other spawn
// path, and it does not reap descendants yet: Bun.spawn's native timeout kills
// only the immediate child, so the fixture's grandchild survives (#10 for the
// timeout, #17 for a normal exit). The reaping test is registered with
// `test.failing` until that is fixed. It goes red once the grandchild dies,
// and the fix should then drop `knownLeak`.
// ---------------------------------------------------------------------------

describeContainmentConformance(
  'deterministic',
  async ({ projectRoot, fixture, timeoutMs }) => {
    const result = await runDeterministic(
      { command: fixture, args: [] },
      { allowlist: [fixture], cwd: projectRoot, timeoutMs },
    );
    return result.timedOut === true ? 'timedOut' : undefined;
  },
  { timeoutClass: 'timedOut', knownLeak: '#10 and #17' },
);
