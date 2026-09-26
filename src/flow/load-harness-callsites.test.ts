/**
 * Registry-aware loadFlow() wiring at every real call site (WI-576).
 *
 * WI-563 implemented fail-closed load-time validation for `kind: harness`
 * stations (UNKNOWN_HARNESS_ADAPTER, HARNESS_TOOLS_UNEXPRESSIBLE, binary probe),
 * but that logic is gated behind an OPTIONAL `harnessRegistry` argument to
 * loadFlow(). Amy's probe of WI-563 found that every real entry point calls
 * loadFlow(path) with NO registry, so a malformed harness station passes load
 * entirely and would only surface at first dispatch — exactly the failure mode
 * FR-10 / NFR-Security-3 forbid.
 *
 * This is an INTEGRATION WIRING test: it drives each real call site end-to-end
 * (through the exported `main()`, `runWorkerProcess()`, and the production
 * `buildProductionDeps().startListener` closure) and asserts a malformed harness
 * flow is rejected AT LOAD/STARTUP. A call site that forgets to thread the
 * registry lets the malformed flow load, and its test fails. Each malformed flow
 * is otherwise fully valid — the ONLY thing that can reject it is the
 * registry-gated harness check, so these tests have teeth (they cannot pass by
 * accident on unrelated validation).
 *
 * Registry note: the CLI commands take the registry the caller injects via
 * CliDeps.harnessRegistry (WI-560), so those tests can exercise BOTH the
 * unknown-adapter and tools-unexpressible paths with a fake registry. The worker
 * pool and ingress listener build the registry internally from engine config
 * (which is empty until a real adapter is registered), so those two exercise the
 * unknown-adapter path against that real (empty) registry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  main,
  buildProductionDeps,
  buildReadOnlyProductionDeps,
  type CliDeps,
  type CliIO,
  type PrereqProbe,
  type RunEngineArgs,
} from '../cli/main';
import { runWorkerProcess, type WorkerProcessIO } from '../worker/worker-entry';
import { parseWorkerMessage, type WorkerMessage } from '../worker/ipc-protocol';
import {
  createHarnessRegistry,
  buildHarnessDefinitionRegistry,
  makeFakeHarnessAdapter,
  type HarnessRegistry,
  type HarnessInvocation,
} from '../worker/harness-adapter';
import type { HarnessAdapterConfigDef } from '../worker/harness-config';
import type { HarnessCommand, HarnessRunnerConfig, HarnessSpawnResult } from '../worker/harness-runner';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import type { ModelAdapter } from '../worker/adapter';

// ---------------------------------------------------------------------------
// Fixtures — three flows written to disk once. Each malformed harness flow is
// otherwise valid; only the registry-gated harness check can reject it.
// ---------------------------------------------------------------------------

let rootDir: string;
let unknownAdapterFlow: string; // harness adapter name absent from the registry
let toolsUnexpressibleFlow: string; // tools allowlist a non-narrowing adapter can't express
let controlFlow: string; // valid, zero harness stations (AC5)
// WI-588 fixtures — valid claude-headless flows used to prove the CONFIG-BUILT
// registry resolves a configured adapter (vs. the empty registry rejecting it).
let claudeFlow: string; // harness: claude-headless, no project_root -> projectRoot = flow dir
let claudeFlowWithRoot: string; // harness: claude-headless, project_root: sub -> resolved under flow dir
let overrideRootDir: string; // an existing dir for the --project-root override precedence case

/**
 * A valid harness station whose only defect is the injected `harnessLine`.
 * `topLevelExtra` injects extra top-level flow keys (e.g. `project_root: sub`);
 * omitted by every legacy caller, so their output is byte-identical.
 */
function harnessYaml(harnessLine: string, topLevelExtra = ''): string {
  return `
flow: callsite-harness
flow_version: 1
${topLevelExtra}terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      model: sonnet
      ${harnessLine}
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: [task.md]
    outputs: [result.md]
    next: done
`;
}

/** A fully valid transform (non-harness) flow — the AC5 control. */
function controlYaml(): string {
  return `
flow: callsite-control
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: drafter
    worker:
      kind: transform
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: [task.md]
    outputs: [result.md]
    next: done
`;
}

function writeFlow(name: string, yaml: string): string {
  const dir = join(rootDir, name);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'flow.yaml'), yaml, 'utf-8');
  // No template refs → no UNDECLARED_PROMPT_INPUT; the flow is otherwise valid.
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'Implement the task described in the inputs.', 'utf-8');
  return join(dir, 'flow.yaml');
}

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'conduit-callsites-'));
  unknownAdapterFlow = writeFlow('unknown', harnessYaml('harness: ghost-headless'));
  toolsUnexpressibleFlow = writeFlow('tools', harnessYaml('harness: claude-headless'));
  controlFlow = writeFlow('control', controlYaml());
  // WI-588: valid claude-headless flows. The real claude adapter can restrict
  // tools (canRestrictTools=true), so [Read,Write,Bash] is EXPRESSIBLE — the
  // only reason these could fail load is an empty (unconfigured) registry.
  claudeFlow = writeFlow('claudeok', harnessYaml('harness: claude-headless'));
  claudeFlowWithRoot = writeFlow('clauderoot', harnessYaml('harness: claude-headless', 'project_root: sub\n'));
  mkdirSync(join(rootDir, 'clauderoot', 'sub'), { recursive: true });
  overrideRootDir = join(rootDir, 'override-root');
  mkdirSync(overrideRootDir, { recursive: true });
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI deps — a registry that KNOWS `claude-headless` but cannot narrow its
// tools. `ghost-headless` is unknown → UNKNOWN_HARNESS_ADAPTER; `claude-headless`
// + a tools allowlist + no waiver → HARNESS_TOOLS_UNEXPRESSIBLE.
// ---------------------------------------------------------------------------

const cliRegistry: HarnessRegistry = createHarnessRegistry([
  makeFakeHarnessAdapter({ name: 'claude-headless', canRestrictTools: false, binaryPresent: true }).adapter,
]);

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };
}

let db: ConduitDB;

// WI-588 env isolation: the existing (WI-576) tests assume an UNCONFIGURED
// engine (empty CONDUIT_HARNESS_* -> empty registry). The new config-driven
// tests below set CONDUIT_HARNESS_* vars; snapshot every such key before each
// test and restore it after, so a configured test can never leak into an
// empty-env one regardless of execution order.
function snapshotHarnessEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CONDUIT_HARNESS_')) snap[key] = process.env[key];
  }
  return snap;
}

function clearHarnessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CONDUIT_HARNESS_')) delete process.env[key];
  }
}

let harnessEnvSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  harnessEnvSnapshot = snapshotHarnessEnv();
  clearHarnessEnv();
});

afterEach(() => {
  db.close();
  clearHarnessEnv();
  for (const [key, value] of Object.entries(harnessEnvSnapshot)) {
    if (value !== undefined) process.env[key] = value;
  }
});

/** Run `fn` with CONDUIT_HARNESS_* set to `overlay` (plus :memory: DB env). */
function withHarnessEnv<T>(overlay: Record<string, string>, fn: () => T): T {
  const prevState = process.env.CONDUIT_STATE_DB;
  const prevJournal = process.env.CONDUIT_JOURNAL_DB;
  process.env.CONDUIT_STATE_DB = ':memory:';
  process.env.CONDUIT_JOURNAL_DB = ':memory:';
  clearHarnessEnv();
  for (const [key, value] of Object.entries(overlay)) process.env[key] = value;
  try {
    return fn();
  } finally {
    clearHarnessEnv();
    if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
    else process.env.CONDUIT_STATE_DB = prevState;
    if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
    else process.env.CONDUIT_JOURNAL_DB = prevJournal;
  }
}

function makeDeps(io: CliIO): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async (_args: RunEngineArgs) => {},
    // All-ok prereqs so cmdRun's pre-flight gate passes and reaches loadFlow.
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) } as PrereqProbe],
    harnessRegistry: cliRegistry,
  };
}

/** The five CLI commands that load a flow, each reachable via main(argv, deps). */
const CLI_COMMANDS: Array<[string, (flow: string) => string[]]> = [
  ['run', (f) => ['run', f]],
  ['resume', (f) => ['resume', f]],
  ['explain', (f) => ['explain', f]],
  ['doctor', (f) => ['doctor', f]],
  ['build', (f) => ['build', f]],
];

// ---------------------------------------------------------------------------
// AC1 + AC3 — unknown adapter rejected at load by EVERY CLI call site.
// ---------------------------------------------------------------------------

describe('unknown harness adapter is rejected at load by every CLI call site (AC1, AC3)', () => {
  it.each(CLI_COMMANDS)(
    'conduit %s fails closed with UNKNOWN_HARNESS_ADAPTER (not at first dispatch)',
    async (_name, argv) => {
      const io = makeIO();
      const code = await main(argv(unknownAdapterFlow), makeDeps(io));

      expect(code).toBe(1);
      // The registry-gated harness validation actually ran at this call site.
      expect(io.errors.some((l) => l.includes('UNKNOWN_HARNESS_ADAPTER'))).toBe(true);
      // ...naming the offending adapter so the failure is diagnosable.
      expect(io.errors.some((l) => l.includes('ghost-headless'))).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// AC2 + AC3 — unexpressible tools allowlist rejected at load by EVERY CLI site.
// ---------------------------------------------------------------------------

describe('unexpressible harness tools allowlist is rejected at load by every CLI call site (AC2, AC3)', () => {
  it.each(CLI_COMMANDS)(
    'conduit %s fails closed with HARNESS_TOOLS_UNEXPRESSIBLE',
    async (_name, argv) => {
      const io = makeIO();
      const code = await main(argv(toolsUnexpressibleFlow), makeDeps(io));

      expect(code).toBe(1);
      expect(io.errors.some((l) => l.includes('HARNESS_TOOLS_UNEXPRESSIBLE'))).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// AC5 — a zero-harness flow still loads exactly as before, registry threaded.
// ---------------------------------------------------------------------------

describe('a non-harness flow loads unchanged when the registry is threaded (AC5)', () => {
  it('conduit explain on a valid non-harness flow succeeds with no validation error', async () => {
    const io = makeIO();
    const code = await main(['explain', controlFlow], makeDeps(io));

    // Threading the registry must NOT introduce a spurious rejection for a flow
    // with no harness stations.
    expect(io.errors.filter((l) => l.includes('validation error'))).toEqual([]);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the worker pool entry point loads through the registry-aware path.
// ---------------------------------------------------------------------------

/** A controllable WorkerProcessIO capturing err lines (no real subprocess). */
function makeWorkerIO(): { io: WorkerProcessIO; errs: string[]; sent: WorkerMessage[] } {
  let handler: ((raw: unknown) => void) | null = null;
  const sent: WorkerMessage[] = [];
  const errs: string[] = [];
  const io: WorkerProcessIO = {
    onMessage: (h) => {
      handler = h;
    },
    send: (raw) => {
      const parsed = parseWorkerMessage(raw);
      if (parsed.ok) sent.push(parsed.message);
    },
    err: (line) => errs.push(line),
    timers: { setInterval: () => 0, clearInterval: () => {} },
    exit: () => {},
  };
  // `handler` is retained for parity with the real IO shape; not exercised here.
  void handler;
  return { io, errs, sent };
}

describe('the worker pool entry point rejects a malformed harness flow at load (AC4)', () => {
  it('runWorkerProcess fails closed on an unknown harness adapter', () => {
    const w = makeWorkerIO();
    runWorkerProcess(
      { flowPath: unknownAdapterFlow, projectRoot: dirname(unknownAdapterFlow) },
      w.io,
    );

    // Wired registry → the harness station fails load → the worker reports the
    // failure rather than proceeding to run any station.
    expect(w.errs.some((l) => l.includes('failed to load flow'))).toBe(true);
    expect(w.errs.some((l) => l.includes('ghost-headless'))).toBe(true);
  });

  it('runWorkerProcess still loads a valid non-harness flow (no behavior change)', () => {
    const w = makeWorkerIO();
    runWorkerProcess({ flowPath: controlFlow, projectRoot: dirname(controlFlow) }, w.io);

    expect(w.errs.some((l) => l.includes('failed to load flow'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the ingress listener loads flows through the registry-aware path.
//
// Drives the REAL production wiring: buildProductionDeps().startListener is the
// closure that constructs the listener's loadFlow seam. If that seam is not
// registry-aware, the malformed flow loads and boot fails (if at all) for an
// unrelated reason — never FLOW_LOAD_FAILED naming the harness adapter.
// ---------------------------------------------------------------------------

describe('the ingress listener loads flows through the registry-aware path (AC4)', () => {
  it('buildProductionDeps().startListener rejects a malformed harness flow at boot', async () => {
    const prevState = process.env.CONDUIT_STATE_DB;
    const prevJournal = process.env.CONDUIT_JOURNAL_DB;
    process.env.CONDUIT_STATE_DB = ':memory:';
    process.env.CONDUIT_JOURNAL_DB = ':memory:';
    try {
      const deps = buildProductionDeps();
      const result = await deps.startListener!({ allowlist: { badflow: unknownAdapterFlow } });

      // Boot must fail at flow load (Phase 1), naming the unknown harness adapter.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => e.code === 'FLOW_LOAD_FAILED' && e.message.includes('ghost-headless'),
          ),
        ).toBe(true);
      }
    } finally {
      if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
      else process.env.CONDUIT_STATE_DB = prevState;
      if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
      else process.env.CONDUIT_JOURNAL_DB = prevJournal;
    }
  });
});

// ===========================================================================
// WI-588 — the config-built registry wired into every entry point + per-run
// projectRoot binding.
//
// WI-587 landed the two-phase surface as buildHarnessDefinitionRegistry(defs,
// deps?): resolve(name) -> definition (caps/envAllowlist/command/probeBinary),
// and definition.bind(projectRoot) -> the standard HarnessRegistry with a
// working invoke(). WI-588 replaced the empty buildHarnessRegistry() seam (since
// removed) at every production entry point with a registry built from
// parseHarnessConfig (CONDUIT_HARNESS_*), binding each run's resolved
// projectRoot at dispatch.
//
// ── ONE CONTRACT DECISION FLAGGED FOR B.A./HANNIBAL (binding seam) ──
// The item notes: "If binding location is ambiguous, raise as a Sosa question."
// These tests encode the LEAST-disruptive, additive binding seam: a NEW OPTIONAL
// CliDeps field `bindHarnessRegistry?: (projectRoot) => HarnessRegistry`.
// cmdRun/cmdResume resolve the run's projectRoot, then (when present) call
// deps.bindHarnessRegistry(projectRoot) and pass its result to runEngine as the
// invocable registry; when ABSENT they fall back to deps.harnessRegistry
// unchanged (so every legacy CliDeps test keeps working with zero edits, and
// executor.ts stays untouched). If B.A. prefers a different seam (e.g. making
// CliDeps.harnessRegistry the definition-registry and binding it in place), this
// is a mechanical adjustment — ping murdock.
// ===========================================================================

const CLAUDE_ENV = {
  CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
  CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
};

/** Async sibling of withHarnessEnv (awaits before restoring env). */
async function withHarnessEnvAsync<T>(overlay: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prevState = process.env.CONDUIT_STATE_DB;
  const prevJournal = process.env.CONDUIT_JOURNAL_DB;
  process.env.CONDUIT_STATE_DB = ':memory:';
  process.env.CONDUIT_JOURNAL_DB = ':memory:';
  clearHarnessEnv();
  for (const [key, value] of Object.entries(overlay)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    clearHarnessEnv();
    if (prevState === undefined) delete process.env.CONDUIT_STATE_DB;
    else process.env.CONDUIT_STATE_DB = prevState;
    if (prevJournal === undefined) delete process.env.CONDUIT_JOURNAL_DB;
    else process.env.CONDUIT_JOURNAL_DB = prevJournal;
  }
}

// ---------------------------------------------------------------------------
// AC1 — buildProductionDeps builds the registry from CONDUIT_HARNESS_* config;
// an unconfigured engine yields an empty registry (zero behavior change).
// ---------------------------------------------------------------------------

describe('buildProductionDeps builds the harness registry from CONDUIT_HARNESS_* config (AC1)', () => {
  it('yields an EMPTY registry with no CONDUIT_HARNESS_* set — resolve fail-closes', () => {
    withHarnessEnv({}, () => {
      const deps = buildProductionDeps();
      expect(deps.harnessRegistry!.resolve('claude-headless').ok).toBe(false);
    });
  });

  it('registers claude-headless when CONDUIT_HARNESS_* configures it', () => {
    withHarnessEnv(CLAUDE_ENV, () => {
      const deps = buildProductionDeps();
      const resolved = deps.harnessRegistry!.resolve('claude-headless');
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.adapter.name).toBe('claude-headless');
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 / FR-8 — invalid config fails at ENGINE BOOT (buildProductionDeps),
// naming the offending element — never deferred to first dispatch.
// ---------------------------------------------------------------------------

describe('invalid CONDUIT_HARNESS_* config fails at engine boot, never at first dispatch (AC3, FR-8)', () => {
  it('throws at buildProductionDeps naming an unknown (unshipped) adapter', () => {
    withHarnessEnv(
      { CONDUIT_HARNESS_ADAPTERS: 'mystery-adapter', CONDUIT_HARNESS_MYSTERY_ADAPTER_ENV: 'HOME' },
      () => {
        expect(() => buildProductionDeps()).toThrow(/mystery-adapter/);
      },
    );
  });

  it('throws at buildProductionDeps when a listed adapter has no _ENV allowlist var, naming the adapter', () => {
    withHarnessEnv({ CONDUIT_HARNESS_ADAPTERS: 'claude-headless' }, () => {
      expect(() => buildProductionDeps()).toThrow(/claude-headless/);
    });
  });

  it('throws at buildProductionDeps on a derived-prefix collision, naming both colliding adapters', () => {
    withHarnessEnv(
      {
        CONDUIT_HARNESS_ADAPTERS: 'claude-headless,claude_headless',
        CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME',
      },
      () => {
        let message = '';
        try {
          buildProductionDeps();
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain('claude-headless');
        expect(message).toContain('claude_headless');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — every entry point resolves against the ONE config-built registry.
//
// The five CLI commands all read deps.harnessRegistry, which buildProductionDeps
// now builds from config (AC1 above) — and the WI-576 fail-closed tests above
// already prove each CLI command threads that registry into loadFlow. The two
// INTERNAL builders (worker-entry, ingress listener) construct their own
// registry from process.env, so they are proven here by a negative->positive
// flip: a claude-headless flow is rejected as UNKNOWN when unconfigured and
// resolves when CONDUIT_HARNESS_* configures it.
// ---------------------------------------------------------------------------

describe('the config-built registry is wired into the internal-builder entry points (AC2)', () => {
  it('worker-entry builds its registry from config — claude-headless loads only when configured', () => {
    const emptyEnv = makeWorkerIO();
    withHarnessEnv({}, () => {
      runWorkerProcess({ flowPath: claudeFlow, projectRoot: dirname(claudeFlow) }, emptyEnv.io);
    });
    // Unconfigured: empty registry -> claude-headless unknown -> load fails naming it.
    expect(
      emptyEnv.errs.some((l) => l.includes('failed to load flow') && l.includes('claude-headless')),
    ).toBe(true);

    const configured = makeWorkerIO();
    withHarnessEnv(CLAUDE_ENV, () => {
      runWorkerProcess({ flowPath: claudeFlow, projectRoot: dirname(claudeFlow) }, configured.io);
    });
    // Configured: registry resolves claude-headless (canRestrictTools=true, tools
    // expressible) -> the flow loads, so no load failure is reported.
    expect(configured.errs.some((l) => l.includes('failed to load flow'))).toBe(false);
  });

  it('the ingress listener builds its loadFlow registry from config — claude-headless resolves only when configured', async () => {
    const emptyResult = await withHarnessEnvAsync({}, async () =>
      buildProductionDeps().startListener!({ allowlist: { badflow: claudeFlow } }),
    );
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) {
      expect(
        emptyResult.errors.some(
          (e) => e.code === 'FLOW_LOAD_FAILED' && e.message.includes('claude-headless'),
        ),
      ).toBe(true);
    }

    const configuredResult = await withHarnessEnvAsync(CLAUDE_ENV, async () =>
      buildProductionDeps().startListener!({ allowlist: { goodflow: claudeFlow } }),
    );
    // Configured: the flow now LOADS — boot must not fail with FLOW_LOAD_FAILED
    // naming claude-headless (it resolved against the config-built registry).
    const failedOnClaude =
      !configuredResult.ok &&
      configuredResult.errors.some(
        (e) => e.code === 'FLOW_LOAD_FAILED' && e.message.includes('claude-headless'),
      );
    expect(failedOnClaude).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the run path resolves the run's projectRoot (CLI --project-root ??
// flow.project_root ?? flow dir) and binds it to produce the invocable registry
// passed to runEngine, demonstrated end-to-end with a fake adapter.
// ---------------------------------------------------------------------------

const RECORDED_CLAUDE_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1 },
});

interface RunnerCall {
  cmd: HarnessCommand;
  config: HarnessRunnerConfig;
}

function makeRun(): {
  run: (cmd: HarnessCommand, config: HarnessRunnerConfig) => Promise<HarnessSpawnResult>;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const run = async (cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
    calls.push({ cmd, config });
    return { exitCode: 0, stdout: RECORDED_CLAUDE_SUCCESS, stderr: '', durationMs: 1, timedOut: false, idledOut: false };
  };
  return { run, calls };
}

// NEW optional CliDeps seam this item introduces (see the header note). Typed as
// an intersection so this test compiles against the intended contract; B.A. adds
// the field to CliDeps and calls it from cmdRun/cmdResume.
type DepsWithBind = CliDeps & { bindHarnessRegistry?: (projectRoot: string) => HarnessRegistry };

interface Captured {
  args?: RunEngineArgs;
}

/** Deps whose runEngine records its RunEngineArgs; harnessRegistry resolves a
 *  present claude-headless so load passes and the run reaches runEngine. */
function makeRunDeps(io: CliIO, capture: Captured, over: Partial<DepsWithBind> = {}): DepsWithBind {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async (args: RunEngineArgs) => {
      capture.args = args;
    },
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) } as PrereqProbe],
    harnessRegistry: createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'claude-headless', canRestrictTools: true, binaryPresent: true }).adapter,
    ]),
    ...over,
  };
}

describe('the run path resolves and passes the run projectRoot to runEngine (AC4)', () => {
  // A no-op runEngine leaves the seeded card short of 'done', so cmdRun returns
  // exit 1 (halted) — like the concurrency-cap tests, we assert on the CAPTURED
  // RunEngineArgs, not the exit code.
  it('defaults projectRoot to the flow directory when neither flag nor flow.project_root is set', async () => {
    const capture: Captured = {};
    await main(['run', claudeFlow, '--input-inline', '{}'], makeRunDeps(makeIO(), capture));
    expect(capture.args).toBeDefined();
    expect(capture.args?.projectRoot).toBe(dirname(claudeFlow));
  });

  it('uses flow.project_root (resolved under the flow dir) when set and no flag is given', async () => {
    const capture: Captured = {};
    await main(['run', claudeFlowWithRoot, '--input-inline', '{}'], makeRunDeps(makeIO(), capture));
    expect(capture.args).toBeDefined();
    expect(capture.args?.projectRoot).toBe(join(dirname(claudeFlowWithRoot), 'sub'));
  });

  it('lets the CLI --project-root flag win over flow.project_root and the flow dir', async () => {
    const capture: Captured = {};
    await main(
      ['run', claudeFlowWithRoot, '--project-root', overrideRootDir, '--input-inline', '{}'],
      makeRunDeps(makeIO(), capture),
    );
    expect(capture.args).toBeDefined();
    expect(capture.args?.projectRoot).toBe(overrideRootDir);
  });
});

describe('the run path binds the resolved projectRoot to the invocable registry (AC4)', () => {
  it('binds via deps.bindHarnessRegistry and passes a registry whose invoke is confined to that root', async () => {
    const fake = makeRun();
    const defnRegistry = buildHarnessDefinitionRegistry(
      [{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] } as HarnessAdapterConfigDef],
      { run: fake.run, probe: async () => ({ present: true }) },
    );
    let boundRoot: string | undefined;
    const bindHarnessRegistry = (projectRoot: string): HarnessRegistry => {
      boundRoot = projectRoot;
      const resolved = defnRegistry.resolve('claude-headless');
      if (!resolved.ok) throw new Error('fake definition registry should resolve claude-headless');
      return createHarnessRegistry([resolved.adapter.bind(projectRoot)]);
    };

    const capture: Captured = {};
    await main(
      ['run', claudeFlow, '--project-root', overrideRootDir, '--input-inline', '{}'],
      makeRunDeps(makeIO(), capture, { bindHarnessRegistry }),
    );
    expect(capture.args).toBeDefined();

    // cmdRun bound the RESOLVED projectRoot (the --project-root override here)...
    expect(boundRoot).toBe(overrideRootDir);

    // ...and threaded the BOUND registry into runEngine, whose adapter's invoke
    // confines the runner to that same projectRoot (FR-4 single-run baseline).
    const threaded = capture.args?.harnessRegistry;
    expect(threaded).toBeDefined();
    const bound = threaded!.resolve('claude-headless');
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      await bound.adapter.invoke({ prompt: 'x', inputs: [], tools: ['Read'], timeoutMs: 1_000 } as HarnessInvocation);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.config.projectRoot).toBe(overrideRootDir);
    }
  });
});

// ---------------------------------------------------------------------------
// WI-588 rejection fix (Amy FLAG) — the REAL `explain` deps builder is
// registry-aware.
//
// `explain` is the one CLI command the production entry point serves from
// buildReadOnlyProductionDeps() (the `process.argv[2] === 'explain'` branch in
// main.ts), NOT buildProductionDeps(). Every other test above hand-injects a
// registry into a manually-built CliDeps via makeDeps(), so none of them
// exercised the REAL explain deps builder — the exact path where the registry
// wiring was missing (a malformed harness flow passed explain with exit 0,
// silent skip). This drives buildReadOnlyProductionDeps() directly (overriding
// ONLY io, to capture stderr — the harnessRegistry under test stays the real
// one it built) and proves it now fails closed.
// ---------------------------------------------------------------------------

describe('the real explain deps builder (buildReadOnlyProductionDeps) is registry-aware (WI-588 rejection fix)', () => {
  it('rejects an unknown harness adapter at load via the production explain deps, not a hand-injected registry', async () => {
    const io = makeIO();
    const code = await withHarnessEnvAsync({}, async () =>
      // buildReadOnlyProductionDeps() parses CONDUIT_HARNESS_* (empty here ->
      // empty registry) and wires harnessRegistry itself; we replace ONLY its
      // stdout/stderr io so the assertion can read the error lines.
      main(['explain', unknownAdapterFlow], { ...buildReadOnlyProductionDeps(), io }),
    );

    expect(code).toBe(1);
    expect(io.errors.some((l) => l.includes('UNKNOWN_HARNESS_ADAPTER'))).toBe(true);
    expect(io.errors.some((l) => l.includes('ghost-headless'))).toBe(true);
  });
});
