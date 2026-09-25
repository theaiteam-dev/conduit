/**
 * Harness child-env allowlist (WI-562).
 *
 * Enforces the secrets-by-allowlist-only containment rule (NFR-Security-2): the
 * harness child process environment is built from an EXPLICIT allowlist of
 * variable NAMES (declared in engine config), resolved against the kernel
 * environment — never by inheriting process.env wholesale. This keeps the
 * exfiltratable surface to the harness's own auth token.
 *
 * The runner (WI-561) previously either passed a caller-built `env` map or, with
 * none, let Bun.spawn inherit the FULL parent env (the insecure default). WI-562
 * replaces that with:
 *
 *   - a pure, exported `buildHarnessChildEnv(envAllowlist, sourceEnv)` that
 *     resolves ONLY the allowlisted names present in `sourceEnv` (an unset name
 *     is OMITTED, never injected as an empty string) — table-testable against an
 *     injected env map with NO real process (AC1/AC2/AC4);
 *   - runHarnessProcess taking `envAllowlist?: string[]` (names from engine
 *     config, NOT flow.yaml — AC3) and `sourceEnv?: Record<string,string|undefined>`
 *     (the kernel env, injected for tests; defaults to process.env), and ALWAYS
 *     passing the built env to Bun.spawn so the child never inherits wholesale.
 *
 * The WI-561 pinned `env` placeholder field is superseded by these two fields.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHarnessProcess,
  buildHarnessChildEnv,
  type HarnessRunnerConfig,
} from './harness-runner';

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC4 — the pure env builder, table-tested with an injected env map
// and NO real process.
// ---------------------------------------------------------------------------

describe('buildHarnessChildEnv — allowlist-only env construction (AC1, AC2, AC4)', () => {
  it('resolves EXACTLY the allowlisted names present in the source env and nothing else (AC1)', () => {
    const source = {
      CONDUIT_HARNESS_TOKEN: 'sk-secret',
      HOME: '/home/agent',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      PATH: '/usr/bin',
    };

    const childEnv = buildHarnessChildEnv(['CONDUIT_HARNESS_TOKEN', 'PATH'], source);

    // Exactly the two allowlisted names, resolved to their source values.
    expect(childEnv).toEqual({ CONDUIT_HARNESS_TOKEN: 'sk-secret', PATH: '/usr/bin' });
    // And nothing else — the key set is precisely the allowlist ∩ present.
    expect(Object.keys(childEnv).sort()).toEqual(['CONDUIT_HARNESS_TOKEN', 'PATH']);
  });

  it('excludes a source var that is not on the allowlist (no wholesale inheritance) (AC2)', () => {
    const source = { ALLOWED: 'ok', AWS_SECRET_ACCESS_KEY: 'must-not-leak' };

    const childEnv = buildHarnessChildEnv(['ALLOWED'], source);

    expect(childEnv.ALLOWED).toBe('ok');
    // The non-allowlisted secret is absent — not present with any value.
    expect('AWS_SECRET_ACCESS_KEY' in childEnv).toBe(false);
  });

  it.each([
    ['its value is undefined', { CONDUIT_HARNESS_TOKEN: undefined as string | undefined }],
    ['the key is absent entirely', {} as Record<string, string | undefined>],
  ])('omits an allowlisted name whose source entry is %s — no empty-string injection (AC4)', (_label, source) => {
    const childEnv = buildHarnessChildEnv(['CONDUIT_HARNESS_TOKEN'], source);

    // Omitted entirely — NOT present as '' (an empty-string injection would let a
    // downstream `${TOKEN:-default}` misfire and hide a genuinely-unset secret).
    expect('CONDUIT_HARNESS_TOKEN' in childEnv).toBe(false);
    expect(childEnv.CONDUIT_HARNESS_TOKEN).toBeUndefined();
    expect(childEnv).toEqual({});
  });

  it('returns an empty env for an empty allowlist (fail-closed default)', () => {
    expect(buildHarnessChildEnv([], { CONDUIT_HARNESS_TOKEN: 'sk', PATH: '/usr/bin' })).toEqual({});
  });

  it('resolves a mix of set and unset allowlisted names, keeping only the set ones', () => {
    const source = { A: '1', C: '3' }; // B is unset
    expect(buildHarnessChildEnv(['A', 'B', 'C'], source)).toEqual({ A: '1', C: '3' });
  });
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — the runner CONSUMES the builder: the constructed env actually
// reaches the spawned child, and the parent's process.env is not inherited.
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-harness-env-')));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function config(over: Partial<HarnessRunnerConfig> = {}): HarnessRunnerConfig {
  return { projectRoot, timeoutMs: 5_000, ...over };
}

// The child prints the two vars so we can assert exactly which reached it.
const PRINT_ENV = 'printf "A=%s;D=%s" "${WI562_ALLOWED:-<unset>}" "${WI562_DENIED:-<unset>}"';

describe('runHarnessProcess — the built child env reaches the process (AC1, AC2)', () => {
  it('passes an allowlisted var from the injected source env, and only that one', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', PRINT_ENV] },
      config({
        envAllowlist: ['WI562_ALLOWED'],
        // Both are in the injected source env; only WI562_ALLOWED is allowlisted.
        sourceEnv: { WI562_ALLOWED: 'yes', WI562_DENIED: 'secret' },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('A=yes;D=<unset>');
  });

  it('does NOT inherit a non-allowlisted var from the real process.env (default source, no wholesale inheritance)', async () => {
    const prevAllowed = process.env.WI562_ALLOWED;
    const prevDenied = process.env.WI562_DENIED;
    process.env.WI562_ALLOWED = 'yes';
    process.env.WI562_DENIED = 'leaked-secret';
    try {
      // No sourceEnv → defaults to process.env. Only WI562_ALLOWED is allowlisted.
      const result = await runHarnessProcess(
        { command: 'sh', args: ['-c', PRINT_ENV] },
        config({ envAllowlist: ['WI562_ALLOWED'] }),
      );

      expect(result.exitCode).toBe(0);
      // The allowlisted var passes through; the ambient process.env secret does not.
      expect(result.stdout).toBe('A=yes;D=<unset>');
    } finally {
      if (prevAllowed === undefined) delete process.env.WI562_ALLOWED;
      else process.env.WI562_ALLOWED = prevAllowed;
      if (prevDenied === undefined) delete process.env.WI562_DENIED;
      else process.env.WI562_DENIED = prevDenied;
    }
  });

  it('spawns with a fully scrubbed env when no allowlist is given (child sees neither var)', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', PRINT_ENV] },
      config({ sourceEnv: { WI562_ALLOWED: 'yes', WI562_DENIED: 'secret' } }),
    );

    // No envAllowlist → nothing passes through (fail-closed), yet the child still
    // runs (Bun resolves `sh` via the parent PATH; `printf` is a shell builtin).
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('A=<unset>;D=<unset>');
  });
});

// ---------------------------------------------------------------------------
// Issue #29: kernel-constructed variables. An adapter that builds part of the
// child's surface itself (claude-headless's run-scoped CLAUDE_CONFIG_DIR) sets
// them through `injectedEnv`, which is applied AFTER the allowlist and wins
// over an allowlisted value of the same name.
// ---------------------------------------------------------------------------

describe('runHarnessProcess: injectedEnv (issue #29)', () => {
  it('sets an injected var the allowlist does not name', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', PRINT_ENV] },
      config({ envAllowlist: [], sourceEnv: {}, injectedEnv: { WI562_ALLOWED: 'constructed' } }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('A=constructed;D=<unset>');
  });

  it('overrides an allowlisted value of the same name, so the kernel-constructed value is the one the child sees', async () => {
    const result = await runHarnessProcess(
      { command: 'sh', args: ['-c', PRINT_ENV] },
      config({
        envAllowlist: ['WI562_ALLOWED'],
        sourceEnv: { WI562_ALLOWED: 'ambient' },
        injectedEnv: { WI562_ALLOWED: 'constructed' },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('A=constructed;D=<unset>');
  });
});
