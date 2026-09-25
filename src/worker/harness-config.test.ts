/**
 * CONDUIT_HARNESS_* engine-config parser (WI-586).
 *
 * These tests define the contract for the NEW pure module
 * `src/worker/harness-config.ts`: `parseHarnessConfig(env)` turns the
 * `CONDUIT_HARNESS_*` engine-config environment variables (the existing
 * env-only convention — no config file, ADR-0003 secrets-via-env) into a typed
 * list of harness adapter config DEFINITIONS, or a single NAMED error when the
 * configuration is malformed. It is the config-time foundation the registry
 * (WI-576), doctor, and every entry point build on.
 *
 * SCOPE BOUNDARY (Context, FR-1): this parser is PURE and reads only the
 * passed-in env record — it does NOT decide whether an adapter name is one the
 * engine actually ships (`claude-headless`/`codex-exec`). That factory-map
 * check lives in the registry item, where the concrete adapters are known. A
 * def with an unknown name is a well-formed def here; the registry rejects it
 * later. Env allowlists come ONLY from here, never flow.yaml (FR-6, NFR-1).
 *
 * The result uses the same `{ ok: true; ... } | { ok: false; error }`
 * discriminated-union shape as the sibling registry's ResolveResult
 * (harness-adapter.ts), so callers branch on one convention across the surface.
 *
 * Covered ACs / FRs:
 *   AC1 — adapter list + required env allowlist -> two defs, command/model undefined
 *   AC2 — optional _COMMAND / _MODEL populate when present, undefined when absent
 *   AC3 — per-adapter prefix derived by uppercase + hyphen->underscore; a
 *         derived-prefix COLLISION between two configured names errors, naming BOTH
 *   AC4 — no CONDUIT_HARNESS_* configuration -> empty def list (today's behavior)
 *   AC5 — an adapter with NO _ENV allowlist var errors naming the adapter AND the
 *         missing variable (FR-6, required); an EMPTY-STRING _ENV is a legal
 *         empty allowlist (doctor warns later), not an error
 */

import { describe, it, expect } from 'bun:test';
import {
  parseHarnessConfig,
  type HarnessConfigResult,
  type HarnessAdapterConfigDef,
} from './harness-config';

// ---------------------------------------------------------------------------
// Narrowing helpers — assert the discriminant, then hand back the payload so
// each test reads structurally instead of re-checking `result.ok` inline.
// ---------------------------------------------------------------------------

function expectOk(result: HarnessConfigResult): readonly HarnessAdapterConfigDef[] {
  if (!result.ok) {
    throw new Error(`expected ok result, got error: ${result.error}`);
  }
  return result.defs;
}

function expectErr(result: HarnessConfigResult): string {
  if (result.ok) {
    throw new Error(`expected error result, got ${result.defs.length} def(s)`);
  }
  return result.error;
}

/** The canonical two-adapter, minimally-valid configuration (AC1). */
function twoAdapterEnv(): Record<string, string | undefined> {
  return {
    CONDUIT_HARNESS_ADAPTERS: 'claude-headless,codex-exec',
    CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
    CONDUIT_HARNESS_CODEX_EXEC_ENV: 'HOME,PATH',
  };
}

describe('parseHarnessConfig', () => {
  // -------------------------------------------------------------------------
  // AC4 — an unconfigured deployment behaves exactly as today: no defs.
  // -------------------------------------------------------------------------
  describe('unconfigured deployment (AC4)', () => {
    it('returns an empty def list when the env record is completely empty', () => {
      const defs = expectOk(parseHarnessConfig({}));
      expect(defs).toEqual([]);
    });

    it('returns an empty def list when no CONDUIT_HARNESS_* vars are set, even amid other CONDUIT_* config', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_API_KEY: 'sk-test',
          CONDUIT_BASE_URL: 'https://example.test',
          HOME: '/home/op',
          PATH: '/usr/bin',
        }),
      );
      expect(defs).toEqual([]);
    });

    it('treats an empty CONDUIT_HARNESS_ADAPTERS string as unconfigured (empty def list)', () => {
      const defs = expectOk(parseHarnessConfig({ CONDUIT_HARNESS_ADAPTERS: '' }));
      expect(defs).toEqual([]);
    });

    it('ignores stray per-adapter vars when no adapter is listed in CONDUIT_HARNESS_ADAPTERS', () => {
      // A leftover _ENV with no matching entry in the ADAPTERS list must not
      // conjure a def — the ADAPTERS list is the sole source of which adapters exist.
      const defs = expectOk(
        parseHarnessConfig({ CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH' }),
      );
      expect(defs).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // AC1 — adapter list + required env allowlist.
  // -------------------------------------------------------------------------
  describe('adapter list with required env allowlist (AC1)', () => {
    it('returns two defs with name + envAllowlist, command and model undefined', () => {
      const defs = expectOk(parseHarnessConfig(twoAdapterEnv()));
      expect(defs).toEqual([
        { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] },
        { name: 'codex-exec', envAllowlist: ['HOME', 'PATH'] },
      ]);
      // `undefined` optionals are asserted structurally too: toEqual above
      // treats a missing key and an explicit-undefined key alike, so pin them.
      expect(defs[0]!.command).toBeUndefined();
      expect(defs[0]!.model).toBeUndefined();
      expect(defs[1]!.command).toBeUndefined();
      expect(defs[1]!.model).toBeUndefined();
    });

    it('preserves the def order declared in CONDUIT_HARNESS_ADAPTERS (deterministic output)', () => {
      const env = twoAdapterEnv();
      env.CONDUIT_HARNESS_ADAPTERS = 'codex-exec,claude-headless';
      const defs = expectOk(parseHarnessConfig(env));
      expect(defs.map((d) => d.name)).toEqual(['codex-exec', 'claude-headless']);
    });

    it('parses a single configured adapter', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH,ANTHROPIC_API_KEY',
        }),
      );
      expect(defs).toEqual([
        { name: 'claude-headless', envAllowlist: ['HOME', 'PATH', 'ANTHROPIC_API_KEY'] },
      ]);
    });

    it('parses a single-element env allowlist', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME',
        }),
      );
      expect(defs[0]!.envAllowlist).toEqual(['HOME']);
    });
  });

  // -------------------------------------------------------------------------
  // AC5 / FR-6 — the env allowlist is REQUIRED; empty-string is legal-empty.
  // -------------------------------------------------------------------------
  describe('env allowlist is required (AC5, FR-6)', () => {
    it('errors, naming the adapter AND the missing variable, when the _ENV var is absent', () => {
      const error = expectErr(
        parseHarnessConfig({ CONDUIT_HARNESS_ADAPTERS: 'claude-headless' }),
      );
      expect(error).toContain('claude-headless');
      expect(error).toContain('CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV');
    });

    it('errors on the specific offending adapter when one of several lacks its _ENV var', () => {
      const error = expectErr(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless,codex-exec',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
          // codex-exec's _ENV is missing.
        }),
      );
      expect(error).toContain('codex-exec');
      expect(error).toContain('CONDUIT_HARNESS_CODEX_EXEC_ENV');
    });

    it('treats an empty-string _ENV as a legal empty allowlist (not an error)', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: '',
        }),
      );
      expect(defs).toEqual([{ name: 'claude-headless', envAllowlist: [] }]);
    });

    it('drops empty tokens inside an allowlist so a trailing/doubled comma yields no empty entries', () => {
      // Consistent with the empty-string -> [] rule above: the allowlist is
      // split on commas and empty tokens are discarded (never an empty '' name).
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,,PATH,',
        }),
      );
      expect(defs[0]!.envAllowlist).toEqual(['HOME', 'PATH']);
    });
  });

  // -------------------------------------------------------------------------
  // AC2 — optional _COMMAND and _MODEL overrides.
  // -------------------------------------------------------------------------
  describe('optional command and model overrides (AC2)', () => {
    it('populates command from _COMMAND while model stays undefined when _MODEL is absent', () => {
      const env = twoAdapterEnv();
      env.CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND = '/opt/bin/claude';
      const defs = expectOk(parseHarnessConfig(env));
      const claude = defs.find((d) => d.name === 'claude-headless')!;
      expect(claude.command).toBe('/opt/bin/claude');
      expect(claude.model).toBeUndefined();
    });

    it('populates model from _MODEL while command stays undefined when _COMMAND is absent', () => {
      const env = twoAdapterEnv();
      env.CONDUIT_HARNESS_CODEX_EXEC_MODEL = 'gpt-5-codex';
      const defs = expectOk(parseHarnessConfig(env));
      const codex = defs.find((d) => d.name === 'codex-exec')!;
      expect(codex.model).toBe('gpt-5-codex');
      expect(codex.command).toBeUndefined();
    });

    it('populates both command and model when both vars are present', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND: 'claude',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL: 'claude-opus-4-8',
        }),
      );
      expect(defs[0]).toEqual({
        name: 'claude-headless',
        envAllowlist: ['HOME', 'PATH'],
        command: 'claude',
        model: 'claude-opus-4-8',
      });
    });

    it('scopes _COMMAND/_MODEL to their own adapter — no leak across adapters', () => {
      const env = twoAdapterEnv();
      env.CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND = '/opt/bin/claude';
      env.CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL = 'claude-opus-4-8';
      const defs = expectOk(parseHarnessConfig(env));
      const codex = defs.find((d) => d.name === 'codex-exec')!;
      expect(codex.command).toBeUndefined();
      expect(codex.model).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC3 — per-adapter prefix derivation + collision detection.
  // -------------------------------------------------------------------------
  describe('per-adapter variable prefix derivation (AC3)', () => {
    it('derives the per-adapter prefix by uppercasing and mapping hyphens to underscores', () => {
      // A multi-hyphen name proves the derivation rule end-to-end: every
      // per-adapter var (ENV/COMMAND/MODEL) is read from the derived prefix.
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'my-cool-agent',
          CONDUIT_HARNESS_MY_COOL_AGENT_ENV: 'HOME,PATH',
          CONDUIT_HARNESS_MY_COOL_AGENT_COMMAND: '/usr/local/bin/cool',
          CONDUIT_HARNESS_MY_COOL_AGENT_MODEL: 'cool-1',
        }),
      );
      expect(defs).toEqual([
        {
          name: 'my-cool-agent',
          envAllowlist: ['HOME', 'PATH'],
          command: '/usr/local/bin/cool',
          model: 'cool-1',
        },
      ]);
    });

    it('errors, naming BOTH colliding adapters, when two names derive the same prefix', () => {
      // 'claude-headless' and 'claude_headless' both map to the prefix
      // CONDUIT_HARNESS_CLAUDE_HEADLESS_ — ambiguous, so parse must reject. The
      // _ENV var is supplied so this isolates the COLLISION from the missing-env
      // error (AC5); the collision must win regardless.
      const error = expectErr(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless,claude_headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
        }),
      );
      expect(error).toContain('claude-headless');
      expect(error).toContain('claude_headless');
    });

    it('detects a collision that arises only from case differences in the names', () => {
      // 'Codex-Exec' and 'codex-exec' both derive CONDUIT_HARNESS_CODEX_EXEC_.
      const error = expectErr(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'Codex-Exec,codex-exec',
          CONDUIT_HARNESS_CODEX_EXEC_ENV: 'HOME,PATH',
        }),
      );
      expect(error).toContain('Codex-Exec');
      expect(error).toContain('codex-exec');
    });
  });

  // -------------------------------------------------------------------------
  // Defensive CSV hygiene — surrounding whitespace in the comma lists is
  // trimmed, consistent with the empty-token dropping the ACs already require.
  // Real operators write `CONDUIT_HARNESS_ADAPTERS=claude-headless, codex-exec`.
  // -------------------------------------------------------------------------
  describe('whitespace hygiene in comma lists', () => {
    it('trims surrounding whitespace around adapter names', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: ' claude-headless , codex-exec ',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME',
          CONDUIT_HARNESS_CODEX_EXEC_ENV: 'HOME',
        }),
      );
      expect(defs.map((d) => d.name)).toEqual(['claude-headless', 'codex-exec']);
    });

    it('trims surrounding whitespace around env allowlist entries', () => {
      const defs = expectOk(
        parseHarnessConfig({
          CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
          CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME, PATH , ANTHROPIC_API_KEY',
        }),
      );
      expect(defs[0]!.envAllowlist).toEqual(['HOME', 'PATH', 'ANTHROPIC_API_KEY']);
    });
  });
});

// ---------------------------------------------------------------------------
// Issues #28 / #29: named agent default, per-run plugin dirs, and config-dir
// isolation. All three are engine config, parsed here, never from flow.yaml.
// ---------------------------------------------------------------------------
describe('parseHarnessConfig: _AGENT, _PLUGIN_DIRS, _ISOLATE_CONFIG (issues #28, #29)', () => {
  function claudeEnv(extra: Record<string, string>): Record<string, string | undefined> {
    return {
      CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
      CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
      ...extra,
    };
  }

  it('leaves agent, pluginDirs and isolateConfig absent when none of the vars is set', () => {
    const [def] = expectOk(parseHarnessConfig(claudeEnv({})));
    expect('agent' in def!).toBe(false);
    expect('pluginDirs' in def!).toBe(false);
    expect('isolateConfig' in def!).toBe(false);
  });

  it('populates agent from _AGENT as the adapter default', () => {
    const [def] = expectOk(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_AGENT: 'ai-team:murdock' })));
    expect(def!.agent).toBe('ai-team:murdock');
  });

  it('trims _AGENT before storing it', () => {
    const [def] = expectOk(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_AGENT: ' plug:agent ' })));
    expect(def!.agent).toBe('plug:agent');
  });

  it('rejects an empty _AGENT, naming the variable, rather than storing "" and silently holding every station', () => {
    const error = expectErr(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_AGENT: '' })));
    expect(error).toContain('CONDUIT_HARNESS_CLAUDE_HEADLESS_AGENT');
    expect(error).toContain('empty');
  });

  it('rejects a whitespace-only _AGENT the same way', () => {
    const error = expectErr(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_AGENT: '   ' })));
    expect(error).toContain('CONDUIT_HARNESS_CLAUDE_HEADLESS_AGENT');
    expect(error).toContain('empty');
  });

  it('splits _PLUGIN_DIRS as CSV into one entry per path, trimming whitespace and dropping empty tokens', () => {
    const [def] = expectOk(
      parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS: ' /opt/plugins/a ,,/opt/plugins/b ' })),
    );
    expect(def!.pluginDirs).toEqual(['/opt/plugins/a', '/opt/plugins/b']);
  });

  it('treats an empty _PLUGIN_DIRS as absent (no plugin dirs, no flag)', () => {
    const [def] = expectOk(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS: '' })));
    expect('pluginDirs' in def!).toBe(false);
  });

  it('rejects a relative _PLUGIN_DIRS entry, naming the variable and the entry', () => {
    const error = expectErr(
      parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS: '/opt/plugins/a,plugins/b' })),
    );
    expect(error).toContain('CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS');
    expect(error).toContain('plugins/b');
    expect(error).toContain('absolute');
  });

  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ])('parses _ISOLATE_CONFIG=%s as %s', (raw, expected) => {
    const [def] = expectOk(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG: raw })));
    expect(def!.isolateConfig).toBe(expected);
  });

  it('rejects an unrecognised _ISOLATE_CONFIG value rather than guessing, naming the variable', () => {
    const error = expectErr(parseHarnessConfig(claudeEnv({ CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG: 'yes' })));
    expect(error).toContain('CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG');
    expect(error).toContain('yes');
  });
});
