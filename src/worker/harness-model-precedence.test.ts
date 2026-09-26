/**
 * Station model precedence over adapter _MODEL, with stamp/invocation
 * consistency (WI-589).
 *
 * Two standing facts this item reconciles:
 *   - A harness adapter pushes `--model` to the CLI from its CONFIG default
 *     (createClaudeHarnessAdapter/createCodexHarnessAdapter `config.model`, from
 *     the CONDUIT_HARNESS_<NAME>_MODEL engine-config override).
 *   - The resume binding stamp's modelId is computed from the STATION's model.
 * Today these two sources diverge: the stamp folds the station model but the CLI
 * only ever sees the adapter default. WI-589 makes ONE effective model —
 * `station.model ?? adapter default` — flow to BOTH the CLI and the stamp.
 *
 * ── CONTRACT (Sosa critical #2; model is per-STATION, not per-run) ──
 *   HarnessInvocation gains an optional `model` field (per-CALL, since with
 *   WI-587's per-run binding the model cannot ride the per-run bound config).
 *   The executor computes `effectiveModel = station.model ?? <adapter default>`
 *   at dispatch, threads it into HarnessInvocation.model, and feeds the SAME
 *   value into the binding stamp's modelId. Both adapters' invoke() push
 *   `--model` from `call.model ?? config.model`.
 *
 * ── ONE SURFACE DECISION FLAGGED FOR B.A. (how the executor reads the default) ──
 *   The executor already holds the resolved bound adapter at the stamp site
 *   (executor.ts uses `harnessAdapter.name` there). To compute `station.model ??
 *   adapter default` it needs the adapter's configured default model, so these
 *   tests expect the bound adapter to EXPOSE it as `readonly model?: string` on
 *   HarnessAdapter (the executor reads `harnessAdapter.model`; the two factories
 *   surface their `config.model`). If B.A. prefers reading the default from the
 *   config-time definition instead, the executor-level tests below change
 *   mechanically — ping murdock.
 *
 * Covered ACs (FR-10):
 *   AC1 — station model wins over the adapter _MODEL default (at the CLI).
 *   AC2 — the adapter default applies when the station declares no model.
 *   AC3 — neither set -> no `--model` flag.
 *   AC4 — the effective model reaching the CLI equals the one in the stamp, in
 *         all three cases (proven end-to-end via resume skip/re-invoke).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createClaudeHarnessAdapter } from './harness-adapter-claude';
import { createCodexHarnessAdapter } from './harness-adapter-codex';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessResult,
  type HarnessRegistry,
  type ProducedOutput,
} from './harness-adapter';
import type { HarnessCommand, HarnessRunnerConfig, HarnessSpawnResult } from './harness-runner';
import { runExecutor } from '../controller/executor';
import { loadFlow } from '../flow/load';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from './adapter';

// HarnessInvocation.model and HarnessAdapter.model are what THIS item adds; type
// through intersections so the file compiles against the pre-impl shapes, and
// B.A.'s edits (adding the fields) keep it compiling.
type ModeledInvocation = HarnessInvocation & { model?: string };
type ModeledAdapter = HarnessAdapter & { model?: string };

// ===========================================================================
// Part A — adapter-level: invoke() pushes `--model` from call.model ?? config.model.
// Driven against the real factories through an injected runner seam (no live
// process), asserting the exact `--model` the adapter built.
// ===========================================================================

const RECORDED_CLAUDE_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const RECORDED_CODEX_SUCCESS = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });

function makeRun(stdout: string): {
  run: (cmd: HarnessCommand, config: HarnessRunnerConfig) => Promise<HarnessSpawnResult>;
  calls: Array<{ cmd: HarnessCommand; config: HarnessRunnerConfig }>;
} {
  const calls: Array<{ cmd: HarnessCommand; config: HarnessRunnerConfig }> = [];
  const run = async (cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
    calls.push({ cmd, config });
    return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, idledOut: false };
  };
  return { run, calls };
}

function invocation(over: Partial<ModeledInvocation> = {}): ModeledInvocation {
  return { prompt: 'do the task', inputs: [], tools: ['Read'], timeoutMs: 1_000, ...over };
}

/** The value following `--model` in the built args, or undefined if absent. */
function modelFlag(args: string[]): string | undefined {
  const i = args.indexOf('--model');
  return i >= 0 ? args[i + 1] : undefined;
}

describe('claude-headless adapter: --model from call.model ?? config.model (AC1/AC2/AC3)', () => {
  async function builtArgs(configModel: string | undefined, callModel: string | undefined): Promise<string[]> {
    const { run, calls } = makeRun(RECORDED_CLAUDE_SUCCESS);
    const adapter = createClaudeHarnessAdapter({ projectRoot: '/p', envAllowlist: ['HOME'], model: configModel, run });
    await adapter.invoke(invocation({ model: callModel }));
    return calls[0]!.cmd.args;
  }

  it('AC1: the station model (call.model) wins over the adapter default (config.model)', async () => {
    expect(modelFlag(await builtArgs('adapter-default', 'station-model'))).toBe('station-model');
  });

  it('AC2: uses the adapter default when call.model is absent', async () => {
    expect(modelFlag(await builtArgs('adapter-default', undefined))).toBe('adapter-default');
  });

  it('uses call.model when the adapter default is absent', async () => {
    expect(modelFlag(await builtArgs(undefined, 'station-model'))).toBe('station-model');
  });

  it('AC3: pushes no --model when neither is set', async () => {
    expect(await builtArgs(undefined, undefined)).not.toContain('--model');
  });
});

describe('codex-exec adapter: --model from call.model ?? config.model (AC1/AC2/AC3)', () => {
  async function builtArgs(configModel: string | undefined, callModel: string | undefined): Promise<string[]> {
    const { run, calls } = makeRun(RECORDED_CODEX_SUCCESS);
    const adapter = createCodexHarnessAdapter({ projectRoot: '/p', envAllowlist: ['HOME'], model: configModel, run });
    await adapter.invoke(invocation({ model: callModel }));
    return calls[0]!.cmd.args;
  }

  it('AC1: the station model (call.model) wins over the adapter default (config.model)', async () => {
    expect(modelFlag(await builtArgs('adapter-default', 'station-model'))).toBe('station-model');
  });

  it('AC2: uses the adapter default when call.model is absent', async () => {
    expect(modelFlag(await builtArgs('adapter-default', undefined))).toBe('adapter-default');
  });

  it('uses call.model when the adapter default is absent', async () => {
    expect(modelFlag(await builtArgs(undefined, 'station-model'))).toBe('station-model');
  });

  it('AC3: pushes no --model when neither is set', async () => {
    expect(await builtArgs(undefined, undefined)).not.toContain('--model');
  });
});

// ===========================================================================
// Part B & C — executor-level: the effective model (station ?? adapter default)
// is threaded into HarnessInvocation.model AND governs the binding stamp, so the
// CLI and the stamp always agree.
// ===========================================================================

const SECONDS = (n: number) => () => n;
const io = { out: () => {}, err: () => {} };

function makeThrowingModel(): ModelAdapter {
  return {
    async call() {
      throw new Error('ModelAdapter must not be called by a harness maker');
    },
  };
}

/**
 * A recording harness fake exposing a configured default `model` (what the
 * executor reads to compute `station.model ?? adapter default`) and capturing
 * each invocation so the threaded `call.model` can be asserted. Writes the
 * declared output so the station completes and its checkpoint is written.
 */
function makeRecordingHarness(name: string, model?: string): { adapter: ModeledAdapter; calls: ModeledInvocation[] } {
  const calls: ModeledInvocation[] = [];
  const adapter: ModeledAdapter = {
    name,
    model,
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      calls.push(call as ModeledInvocation);
      const abs = join(process.cwd(), 'result.json');
      writeFileSync(abs, JSON.stringify({ summary: `by ${name}` }), 'utf-8');
      const outputs: ProducedOutput[] = [{ name: 'result.json', path: abs }];
      return { outputs, usage: { tokens: 100, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

/** `stationModelLine` is either '' (no station model) or '      model: X\n'. */
function writeHarnessFlow(dir: string, harnessName: string, stationModelLine: string, registry: HarnessRegistry) {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: harness-model-exec
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: ${harnessName}
${stationModelLine}      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCoderCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'coder',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['task.json', 'result.json'],
    rework_count: 0,
  });
}

function resetCardToStation(db: ConduitDB): void {
  db.getStateDb()
    .prepare("UPDATE cards SET lane = 'coder', status = 'ready' WHERE id = 'entry' AND run_id = 'default'")
    .run();
}

describe('executor threads the effective model into the invocation + stamp (AC1–AC4)', () => {
  let originalCwd: string;
  let projectDir: string;
  let cdb: ConduitDB | null;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'conduit-harness-model-'));
    process.chdir(projectDir);
    cdb = null;
  });
  afterEach(() => {
    if (cdb) {
      cdb.close();
      cdb = null;
    }
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  function run(flow: ReturnType<typeof writeHarnessFlow>, registry: HarnessRegistry, nowSec: number) {
    return runExecutor({
      db: cdb!,
      flow,
      now: SECONDS(nowSec),
      adapter: makeThrowingModel(),
      io,
      harnessRegistry: registry,
    } as RunEngineArgs);
  }

  // ---- Part B: effective model reaches the invocation (AC1/AC2/AC3) ----

  it('AC1: passes the station model when the station declares one (station wins over adapter default)', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const rec = makeRecordingHarness('fake', 'adapter-default');
    const registry = createHarnessRegistry([rec.adapter]);
    const flow = writeHarnessFlow(projectDir, 'fake', '      model: station-model\n', registry);
    seedCoderCard(cdb);

    await run(flow, registry, 1000);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.model).toBe('station-model');
  });

  it('AC2: passes the adapter default when the station declares no model', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const rec = makeRecordingHarness('fake', 'adapter-default');
    const registry = createHarnessRegistry([rec.adapter]);
    const flow = writeHarnessFlow(projectDir, 'fake', '', registry);
    seedCoderCard(cdb);

    await run(flow, registry, 1000);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.model).toBe('adapter-default');
  });

  it('AC3: passes no model when neither the station nor the adapter sets one', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const rec = makeRecordingHarness('fake', undefined);
    const registry = createHarnessRegistry([rec.adapter]);
    const flow = writeHarnessFlow(projectDir, 'fake', '', registry);
    seedCoderCard(cdb);

    await run(flow, registry, 1000);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.model).toBeUndefined();
  });

  // ---- Part C: the stamp is keyed on the SAME effective model (AC4) ----

  it('AC4 (station-set): the stamp is keyed on the station model the CLI used — resume with the same model skips', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const rec = makeRecordingHarness('fake', 'adapter-default');
    const registry = createHarnessRegistry([rec.adapter]);
    const flow = writeHarnessFlow(projectDir, 'fake', '      model: station-model\n', registry);
    seedCoderCard(cdb);

    await run(flow, registry, 1000);
    expect(rec.calls).toHaveLength(1);

    resetCardToStation(cdb);
    await run(flow, registry, 2000);
    // Effective model unchanged ('station-model') -> stamp matches -> skipped.
    expect(rec.calls).toHaveLength(1);
  });

  it('AC4 (station-silent, THE GAP): changing ONLY the adapter default model invalidates the stamp -> re-invoke', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const y = makeRecordingHarness('fake', 'model-y');
    const registryY = createHarnessRegistry([y.adapter]);
    const flowY = writeHarnessFlow(projectDir, 'fake', '', registryY);
    seedCoderCard(cdb);

    await run(flowY, registryY, 1000);
    expect(y.calls).toHaveLength(1);

    // Resume the SAME (silent) station, but the adapter's default model changed.
    // The station model line is byte-identical (absent); only the effective
    // model (adapter default) moved from 'model-y' to 'model-w'. Before this
    // item the stamp folds only the (empty) station model, so both runs stamp ''
    // and the resume WRONGLY skips; folding the adapter default closes that gap.
    const w = makeRecordingHarness('fake', 'model-w');
    const registryW = createHarnessRegistry([w.adapter]);
    const flowW = writeHarnessFlow(projectDir, 'fake', '', registryW);
    resetCardToStation(cdb);

    await run(flowW, registryW, 2000);
    expect(w.calls).toHaveLength(1);
  });

  it('AC4 (station-silent control): an UNCHANGED adapter default is reused on resume (skip, no re-bill)', async () => {
    cdb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    const y1 = makeRecordingHarness('fake', 'model-y');
    const registry1 = createHarnessRegistry([y1.adapter]);
    const flow1 = writeHarnessFlow(projectDir, 'fake', '', registry1);
    seedCoderCard(cdb);

    await run(flow1, registry1, 1000);
    expect(y1.calls).toHaveLength(1);

    const y2 = makeRecordingHarness('fake', 'model-y');
    const registry2 = createHarnessRegistry([y2.adapter]);
    const flow2 = writeHarnessFlow(projectDir, 'fake', '', registry2);
    resetCardToStation(cdb);

    await run(flow2, registry2, 2000);
    // Same effective model ('model-y') -> stamp matches -> skipped.
    expect(y2.calls).toHaveLength(0);
  });
});
