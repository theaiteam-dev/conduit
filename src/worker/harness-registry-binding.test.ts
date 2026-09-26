/**
 * Two-phase harness registry: config-time definitions + per-run projectRoot
 * binding (WI-587).
 *
 * These tests define the contract for the reworked `buildHarnessDefinitionRegistry` in
 * src/worker/harness-adapter.ts. Today it returns an empty registry; this item
 * splits adapter resolution into the two phases the values naturally live in:
 *
 *   CONFIG-TIME (no projectRoot) — identity, capability flags, binary probe,
 *     env allowlist, and command are all resolvable BEFORE a run exists, so
 *     load-validation and `doctor` can introspect an adapter with no per-run
 *     value in hand.
 *   RUN-TIME — the run's resolved projectRoot is bound at dispatch to yield a
 *     containment-confined, INVOCABLE adapter (the existing HarnessAdapter).
 *
 * ── CONTRACT SHAPE (the recommended shape in the item; restated by the lead) ──
 *   buildHarnessDefinitionRegistry(configDefs, deps?) returns a config-time registry:
 *     - resolve(name): { ok: true; adapter: HarnessAdapterDefinition }
 *                      | { ok: false; error: string }
 *     - list(): readonly string[]
 *   HarnessAdapterDefinition exposes, with NO projectRoot supplied:
 *     - name, reportsUsage, canRestrictTools  (static identity + caps)
 *     - envAllowlist, command                 (config introspection, for doctor)
 *     - probeBinary(): Promise<BinaryProbe>   (root-independent PATH probe)
 *     - bind(projectRoot): HarnessAdapter     (-> the EXISTING HarnessAdapter,
 *                                              with a working invoke() confined
 *                                              to projectRoot)
 *
 * ── TEST SEAM (why buildHarnessDefinitionRegistry takes a 2nd `deps` argument) ──
 *   The bound adapter's invoke() spawns a real agent CLI through the WI-561
 *   process runner. To verify the two load-bearing containment guarantees
 *   (AC3 cwd confinement, AC4 env-allowlist provenance) WITHOUT a live binary,
 *   the registry forwards an injected `run` seam (default: runHarnessProcess)
 *   to every adapter it constructs — exactly the `run?`/`probe?` seams the two
 *   factories already accept (harness-adapter-claude.ts:30, -codex.ts:51).
 *   Production calls buildHarnessDefinitionRegistry(defs) and gets the real runner.
 *
 * ── ADDITIVE-ONLY (Sosa critical #1) ──
 *   This item must NOT change the existing HarnessRegistry / HarnessAdapter /
 *   createHarnessRegistry surface that executor.ts, quality/gate.ts,
 *   controller/gate-rework.ts, flow/load.ts, and cli/explain-renderer.ts consume
 *   (resolve() -> HarnessAdapter{name, reportsUsage, canRestrictTools,
 *   probeBinary(), invoke()}). bind(projectRoot) yields exactly that
 *   HarnessAdapter, so those five consumers stay untouched. These tests
 *   therefore assert the NEW config-time surface + bind, never a rewrite of the
 *   old one.
 *
 * Covered ACs / FRs:
 *   AC1 / FR-3 — resolve exposes name+caps+probeBinary+envAllowlist+command with
 *                NO projectRoot; claude=canRestrictTools:true, codex=false.
 *   AC2 / FR-2 — a config def naming an unshipped adapter FAILS construction
 *                (throws), naming the adapter + hinting config-driven registration.
 *   AC3 / FR-4 — bind(projectRoot) yields an invocable adapter whose invoke
 *                confines the runner to that root; two binds -> two adapters,
 *                each confined to its own root, no root captured at build time.
 *   AC4 / FR-6 — the env allowlist reaching the runner is SOLELY the config def's
 *                (no baseline HOME/PATH injected by the engine).
 *   AC5        — an empty registry resolves every name to the fail-closed
 *                UNKNOWN_HARNESS_ADAPTER error, the message hinting registration
 *                is configuration-driven via CONDUIT_HARNESS_* (behavior
 *                unchanged; do NOT assert byte-identical message text).
 */

import { describe, it, expect } from 'bun:test';
import { buildHarnessDefinitionRegistry, type HarnessAdapterDefinition } from './harness-adapter';
import type { HarnessAdapterConfigDef } from './harness-config';
import type { HarnessCommand, HarnessRunnerConfig, HarnessSpawnResult } from './harness-runner';
import type { HarnessInvocation } from './harness-adapter';

// ---------------------------------------------------------------------------
// Recorded harness payloads — no live network, no real process.
// ---------------------------------------------------------------------------

/** A minimal `claude -p --output-format json` success envelope. */
const RECORDED_CLAUDE_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 100, output_tokens: 50 },
});

/** A minimal codex `exec --json` JSONL stream carrying one usage event. */
const RECORDED_CODEX_SUCCESS = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 100, output_tokens: 50 },
});

// ---------------------------------------------------------------------------
// Injected runner seam — records the (cmd, config) each bound adapter built and
// returns a scripted spawn result. Mirrors makeRun in harness-adapter-claude.test.ts.
// ---------------------------------------------------------------------------

interface RunnerCall {
  cmd: HarnessCommand;
  config: HarnessRunnerConfig;
}

function makeRun(spawn: Partial<HarnessSpawnResult> & { stdout: string }): {
  run: (cmd: HarnessCommand, config: HarnessRunnerConfig) => Promise<HarnessSpawnResult>;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const run = async (cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
    calls.push({ cmd, config });
    return { exitCode: 0, stderr: '', durationMs: 1, timedOut: false, idledOut: false, ...spawn };
  };
  return { run, calls };
}

function invocation(over: Partial<HarnessInvocation> = {}): HarnessInvocation {
  // Bash included so the default list is also expressible by codex's capability
  // envelopes (the original per-list tool-expression work: write-capable exec must be granted explicitly).
  return { prompt: 'do the work', inputs: [], tools: ['Read', 'Write', 'Bash'], timeoutMs: 120_000, ...over };
}

function claudeDef(over: Partial<HarnessAdapterConfigDef> = {}): HarnessAdapterConfigDef {
  return { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'], ...over };
}

function codexDef(over: Partial<HarnessAdapterConfigDef> = {}): HarnessAdapterConfigDef {
  return { name: 'codex-exec', envAllowlist: ['HOME', 'PATH'], ...over };
}

type DefinitionResult =
  | { ok: true; adapter: HarnessAdapterDefinition }
  | { ok: false; error: string };

function expectOk(result: DefinitionResult): HarnessAdapterDefinition {
  if (!result.ok) {
    throw new Error(`expected ok resolve, got error: ${result.error}`);
  }
  return result.adapter;
}

function expectErr(result: DefinitionResult): string {
  if (result.ok) {
    throw new Error(`expected fail-closed resolve, got adapter '${result.adapter.name}'`);
  }
  return result.error;
}

describe('buildHarnessDefinitionRegistry — two-phase config + binding', () => {
  // -------------------------------------------------------------------------
  // AC1 / FR-3 — config-time resolution with NO projectRoot.
  // -------------------------------------------------------------------------
  describe('config-time resolution exposes identity, caps, probe, allowlist, command (AC1)', () => {
    it('resolves claude-headless with its caps + configured allowlist, command undefined, no projectRoot', () => {
      const registry = buildHarnessDefinitionRegistry([claudeDef()], { run: makeRun({ stdout: RECORDED_CLAUDE_SUCCESS }).run });
      const def = expectOk(registry.resolve('claude-headless'));
      expect(def.name).toBe('claude-headless');
      expect(def.reportsUsage).toBe(true);
      expect(def.canRestrictTools).toBe(true);
      expect(def.envAllowlist).toEqual(['HOME', 'PATH']);
      expect(def.command).toBeUndefined();
      expect(typeof def.bind).toBe('function');
    });

    it('resolves codex-exec with canRestrictTools=false (it gates via sandbox, not per-tool)', () => {
      const registry = buildHarnessDefinitionRegistry([codexDef()], { run: makeRun({ stdout: RECORDED_CODEX_SUCCESS }).run });
      const def = expectOk(registry.resolve('codex-exec'));
      expect(def.name).toBe('codex-exec');
      expect(def.reportsUsage).toBe(true);
      expect(def.canRestrictTools).toBe(false);
      expect(def.envAllowlist).toEqual(['HOME', 'PATH']);
    });

    it('registers every configured adapter and lists them', () => {
      const registry = buildHarnessDefinitionRegistry([claudeDef(), codexDef()], {
        run: makeRun({ stdout: RECORDED_CLAUDE_SUCCESS }).run,
      });
      expect([...registry.list()].sort()).toEqual(['claude-headless', 'codex-exec']);
      expect(registry.resolve('claude-headless').ok).toBe(true);
      expect(registry.resolve('codex-exec').ok).toBe(true);
    });

    it('exposes the configured command override on the definition (for doctor introspection)', () => {
      const registry = buildHarnessDefinitionRegistry([claudeDef({ command: '/opt/bin/claude' })], {
        run: makeRun({ stdout: RECORDED_CLAUDE_SUCCESS }).run,
      });
      expect(expectOk(registry.resolve('claude-headless')).command).toBe('/opt/bin/claude');
    });

    it('resolves probeBinary through the injected probe seam with no projectRoot', async () => {
      const registry = buildHarnessDefinitionRegistry([claudeDef()], {
        run: makeRun({ stdout: RECORDED_CLAUDE_SUCCESS }).run,
        probe: async () => ({ present: true, detail: '/usr/local/bin/claude' }),
      });
      const probe = await expectOk(registry.resolve('claude-headless')).probeBinary();
      expect(probe.present).toBe(true);
      expect(probe.detail).toBe('/usr/local/bin/claude');
    });

    it('fail-closes a shippable-but-unconfigured name — resolution is driven by config defs, not the shipped set', () => {
      // codex-exec IS a shipped adapter, but this deployment only configured
      // claude-headless, so resolving codex-exec must fail closed.
      const registry = buildHarnessDefinitionRegistry([claudeDef()], { run: makeRun({ stdout: RECORDED_CLAUDE_SUCCESS }).run });
      const error = expectErr(registry.resolve('codex-exec'));
      expect(error).toContain('codex-exec');
    });
  });

  // -------------------------------------------------------------------------
  // AC2 / FR-2 — a config def naming an unshipped adapter FAILS construction.
  // -------------------------------------------------------------------------
  describe('unshipped adapter name fails construction, fail-closed (AC2)', () => {
    it('throws naming the unknown adapter and hinting registration is configuration-driven', () => {
      let message = '';
      expect(() => {
        try {
          buildHarnessDefinitionRegistry([{ name: 'mystery-adapter', envAllowlist: ['HOME'] }]);
        } catch (err) {
          message = (err as Error).message;
          throw err;
        }
      }).toThrow();
      expect(message).toContain('mystery-adapter');
      // Hint that registration is configuration-driven — matched loosely so the
      // exact wording can evolve (do not pin byte-identical text).
      expect(message).toMatch(/configur/i);
    });

    it('rejects the whole construction when one of several defs names an unshipped adapter', () => {
      expect(() => buildHarnessDefinitionRegistry([claudeDef(), { name: 'bogus', envAllowlist: ['HOME'] }])).toThrow(/bogus/);
    });
  });

  // -------------------------------------------------------------------------
  // AC3 / FR-4 — bind(projectRoot) yields an invocable, root-confined adapter.
  // -------------------------------------------------------------------------
  describe('binding a projectRoot yields an invocable, confined adapter (AC3)', () => {
    it('bind returns the existing HarnessAdapter surface (name, caps, probeBinary, invoke)', () => {
      const registry = buildHarnessDefinitionRegistry([claudeDef()], { run: makeRun({ stdout: RECORDED_CLAUDE_SUCCESS }).run });
      const adapter = expectOk(registry.resolve('claude-headless')).bind('/work/project');
      expect(adapter.name).toBe('claude-headless');
      expect(adapter.reportsUsage).toBe(true);
      expect(adapter.canRestrictTools).toBe(true);
      expect(typeof adapter.probeBinary).toBe('function');
      expect(typeof adapter.invoke).toBe('function');
    });

    it('confines the runner cwd to the bound projectRoot on invoke', async () => {
      const { run, calls } = makeRun({ stdout: RECORDED_CLAUDE_SUCCESS });
      const registry = buildHarnessDefinitionRegistry([claudeDef()], { run });
      const adapter = expectOk(registry.resolve('claude-headless')).bind('/work/project');
      await adapter.invoke(invocation());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.config.projectRoot).toBe('/work/project');
    });

    it('binds the same resolved definition to two roots -> two adapters, each confined to its own root', async () => {
      // Proves no projectRoot is captured at build time and shared: the single
      // definition yields independently-confined adapters per bind.
      const { run, calls } = makeRun({ stdout: RECORDED_CLAUDE_SUCCESS });
      const registry = buildHarnessDefinitionRegistry([claudeDef()], { run });
      const def = expectOk(registry.resolve('claude-headless'));
      const adapterA = def.bind('/work/alpha');
      const adapterB = def.bind('/work/beta');
      expect(adapterA).not.toBe(adapterB);
      await adapterA.invoke(invocation());
      await adapterB.invoke(invocation());
      expect(calls[0]!.config.projectRoot).toBe('/work/alpha');
      expect(calls[1]!.config.projectRoot).toBe('/work/beta');
    });

    it('threads a configured model override through to the bound codex adapter invocation', async () => {
      const { run, calls } = makeRun({ stdout: RECORDED_CODEX_SUCCESS });
      const registry = buildHarnessDefinitionRegistry([codexDef({ model: 'gpt-5-codex' })], { run });
      const adapter = expectOk(registry.resolve('codex-exec')).bind('/work/project');
      await adapter.invoke(invocation());
      const args = calls[0]!.cmd.args;
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    });

    it('binds and confines a codex adapter, spawning `codex exec`', async () => {
      const { run, calls } = makeRun({ stdout: RECORDED_CODEX_SUCCESS });
      const registry = buildHarnessDefinitionRegistry([codexDef()], { run });
      const adapter = expectOk(registry.resolve('codex-exec')).bind('/work/codexroot');
      await adapter.invoke(invocation());
      expect(calls[0]!.cmd.command).toBe('codex');
      expect(calls[0]!.cmd.args).toContain('exec');
      expect(calls[0]!.config.projectRoot).toBe('/work/codexroot');
    });
  });

  // -------------------------------------------------------------------------
  // AC4 / FR-6 — the env allowlist reaching the runner is SOLELY the config def's.
  // -------------------------------------------------------------------------
  describe('env allowlist reaching the runner comes solely from the config def (AC4)', () => {
    it('passes the config def allowlist through to the runner verbatim', async () => {
      const { run, calls } = makeRun({ stdout: RECORDED_CLAUDE_SUCCESS });
      const registry = buildHarnessDefinitionRegistry(
        [claudeDef({ envAllowlist: ['HOME', 'PATH', 'ANTHROPIC_API_KEY'] })],
        { run },
      );
      await expectOk(registry.resolve('claude-headless')).bind('/work/project').invoke(invocation());
      expect(calls[0]!.config.envAllowlist).toEqual(['HOME', 'PATH', 'ANTHROPIC_API_KEY']);
    });

    it('injects NO baseline — a def omitting HOME/PATH yields a runner allowlist with exactly the listed vars', async () => {
      const { run, calls } = makeRun({ stdout: RECORDED_CLAUDE_SUCCESS });
      const registry = buildHarnessDefinitionRegistry([claudeDef({ envAllowlist: ['ANTHROPIC_API_KEY'] })], { run });
      await expectOk(registry.resolve('claude-headless')).bind('/work/project').invoke(invocation());
      // The engine must not sneak HOME/PATH in — what the operator listed is all
      // the child sees (preserving the WI-562 explicit-only contract).
      expect(calls[0]!.config.envAllowlist).toEqual(['ANTHROPIC_API_KEY']);
    });

    it('passes an empty (legal) allowlist through as empty, not a baseline', async () => {
      const { run, calls } = makeRun({ stdout: RECORDED_CLAUDE_SUCCESS });
      const registry = buildHarnessDefinitionRegistry([claudeDef({ envAllowlist: [] })], { run });
      await expectOk(registry.resolve('claude-headless')).bind('/work/project').invoke(invocation());
      expect(calls[0]!.config.envAllowlist).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // AC5 — an empty registry stays fail-closed (behavior unchanged; message
  // gains a configuration-driven hint — not byte-identical to today).
  // -------------------------------------------------------------------------
  describe('empty registry is fail-closed with a configuration hint (AC5)', () => {
    it('lists nothing when no config defs are supplied', () => {
      expect([...buildHarnessDefinitionRegistry([]).list()]).toEqual([]);
    });

    it('resolves a shipped adapter name to a fail-closed error naming it and hinting CONDUIT_HARNESS_*', () => {
      const registry = buildHarnessDefinitionRegistry([]);
      const error = expectErr(registry.resolve('claude-headless'));
      expect(error).toContain('claude-headless');
      // The behavior (fail-closed) is unchanged; the message merely gains a hint
      // that registration is configuration-driven — matched loosely, not pinned.
      expect(error).toMatch(/CONDUIT_HARNESS/i);
    });

    it('resolves any unknown name to a fail-closed error naming the request', () => {
      const registry = buildHarnessDefinitionRegistry([]);
      const error = expectErr(registry.resolve('whatever'));
      expect(error).toContain('whatever');
    });
  });
});
