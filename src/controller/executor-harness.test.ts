/**
 * Harness station execution — executor dispatch, rendering, output validation (WI-565).
 *
 * THE KEYSTONE. Wires `kind: harness` into the executor's station dispatch so it
 * behaves like a transform whose single model call is replaced by a bounded
 * harness-adapter invocation. Drives the real `runExecutor` end to end with a
 * test-fake HarnessAdapter (no real process), asserting the six ACs:
 *
 *   AC1  executeStation dispatches kind: harness to a new path that resolves the
 *        adapter BY NAME from the run-context harnessRegistry and invokes it with
 *        the rendered prompt + mounted declared inputs (today `agentic` releases
 *        the slot unsupported at executor.ts ~1138 — harness replaces that arm).
 *   AC2  on rework, the gate {{feedback}} is threaded into the harness prompt
 *        exactly as the transform path threads it (prompt-threaded, no new machinery).
 *   AC3  declared outputs are validated present + schema-conformant via coercive
 *        parsing before advance; a parse miss / missing declared output is a HARD
 *        non-advance (W4 seam) — NEVER a silent advance WI-566 must undo.
 *   AC4  a successful attempt routes through the existing runGateCheckOrAdvance
 *        path (advance, or through a gate) identically to a transform.
 *   AC5  the checkpoint binding-stamp call site runs with adapter identity in its
 *        inputs, so a completed attempt whose stamp is unchanged is SKIPPED on
 *        resume and NOT re-billed.
 *   AC6  end-to-end with the test-fake: inputs rendered, outputs collected, schema
 *        validation applied, checkpoint (binding-stamp) written.
 *
 * ── Contract decisions this test pins (see the handoff for the full rationale) ──
 *
 * 1. The harness path is a HYBRID of the two existing paths:
 *    - it INVOKES like a transform (resolve adapter, one bounded call), but
 *    - it COLLECTS OUTPUTS FROM DISK like a deterministic station — the harness
 *      wrote its declared output files during invoke; the executor reads them,
 *      coercive-parses (transform.ts coerciveParse), and validates against
 *      buildOutputSchema (schema.ts). "validated present" == the declared output
 *      file exists on disk at the path flow/resolve-output.ts resolves.
 *
 * 2. W4 HARD NON-ADVANCE == escalateToHold (lane 'hold'). This mirrors the
 *    deterministic path's existing `deterministic-output-missing → escalateToHold`
 *    (executor.ts ~1443) and the project's fail-closed principle ("escalate
 *    ambiguity; never guess → hard-pause to hold"). The bounded retry-then-scrap
 *    semantics are WI-566's job, layered on top; THIS item must not scrap.
 *
 * 3. The harness adapter is resolved from RunEngineArgs.harnessRegistry (injected
 *    by WI-560 in main.ts, threaded runExecutor → executeStation → the new harness
 *    path). The ModelAdapter is NOT used by a harness MAKER — a harness maker
 *    under NO gate never touches ctx.adapter (asserted below).
 *
 * 4. Binding-stamp: this item wires adapter identity into the binding-stamp INPUTS
 *    at the existing checkpoint call site; WI-572 owns the computeBindingStamp
 *    hashing change and the adapter-identity-changes-the-hash test. THIS test's
 *    observable is only: a checkpoint IS written after a successful harness attempt
 *    and an unchanged re-run is skipped (not re-billed).
 *
 * DEPENDENCY NOTE: loading a harness flow needs WI-563 (loadFlow's optional
 * { harnessRegistry } arg + buildStationConfig populating station.harness/.tools).
 * These tests call loadFlow(path, { harnessRegistry }) and rely on station.harness
 * being on the frozen config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, readCheckpoint } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter, ModelCall } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessResult,
  type HarnessRegistry,
  type ProducedOutput,
  type UsageReport,
} from '../worker/harness-adapter';

// ---------------------------------------------------------------------------
// Fixed clock + in-memory DB + io capture (the shared executor-test recipe).
// ---------------------------------------------------------------------------

const SECONDS = (n: number) => () => n;

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function makeIO(): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** A ModelAdapter that MUST NOT be called — a harness maker never touches it. */
function makeThrowingModel(): ModelAdapter {
  return {
    async call() {
      throw new Error('ModelAdapter.call must not be used by a harness maker');
    },
  };
}

/** A ModelAdapter standing in as a PASSING gate critic (verdict: pass). */
function makePassingCritic(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall) {
      calls.push(req);
      return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 5, outputTokens: 5, costUsd: 0.001 };
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Test-fake HarnessAdapter: records each invocation and (like a real harness)
// WRITES its declared output file to disk, then returns the produced-output ref.
// `content: null` writes nothing — the missing-output W4 case.
// ---------------------------------------------------------------------------

function makeRecordingHarness(
  opts: { name?: string; outputName?: string; content?: string | null; usage?: UsageReport } = {},
): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const {
    name = 'fake-harness',
    outputName = 'result.json',
    content = JSON.stringify({ summary: 'implemented the widget' }),
    usage = { tokens: 120, cost: 0.02 },
  } = opts;
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name,
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      calls.push(call);
      const outputs: ProducedOutput[] = [];
      if (content !== null) {
        // process.cwd() === the project root (each test chdirs into its temp dir,
        // and the flow declares project_root: .), so this lands where the executor
        // reads declared outputs: join(projectRoot, outputName).
        const abs = join(process.cwd(), outputName);
        writeFileSync(abs, content, 'utf-8');
        outputs.push({ name: outputName, path: abs });
      }
      return { outputs, usage };
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Flow fixture — one `coder` harness station with next: done. Optional gate /
// feedback wiring mirrors the transform rework fixture (rework-feedback.test.ts).
// ---------------------------------------------------------------------------

function writeHarnessFlow(
  dir: string,
  registry: HarnessRegistry,
  opts: { gate?: boolean; feedback?: boolean; maxTokens?: number } = {},
): FlowConfig {
  const withGate = opts.gate === true || opts.feedback === true;
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(
    join(dir, 'prompts', 'coder.md'),
    opts.feedback ? 'TASK: {{task.json}}\n[[FB]]{{feedback}}[[/FB]]\nEND' : 'TASK: {{task.json}}',
  );
  writeFileSync(join(dir, 'task.json'), '{"task":"build the widget"}');
  if (withGate) writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{result.json}}');

  const inputsLine = opts.feedback ? '[task.json, feedback]' : '[task.json]';
  const gateBlock = withGate
    ? `
    check:
      kind: gate
      critic: { role: critic, model: critic-model, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: coder
      rework_cap: 2`
    : '';

  const flowYaml = `
flow: harness-exec
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${opts.maxTokens ?? 100000} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: fake-harness
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: ${inputsLine}
    outputs: [result.json]
    next: done${gateBlock}
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCoderCard(db: ConduitDB, reworkCount = 0): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'coder',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['task.json', 'result.json'],
    rework_count: reworkCount,
  });
}

function getCard(db: ConduitDB) {
  return db.getCard(DEFAULT_RUN_ID, 'entry');
}

function coderCheckpoint(db: ConduitDB) {
  return readCheckpoint(db.getStateDb(), {
    run: DEFAULT_RUN_ID,
    flow: '1',
    card: 'entry',
    station: 'coder',
    attempt: 0,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: each test runs inside its own temp project dir (project_root: .).
// ---------------------------------------------------------------------------

let originalCwd: string;
let projectDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-harness-exec-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 + AC6 — dispatch, resolve by name, invoke with rendered prompt + inputs,
//             collect + schema-validate outputs, advance; checkpoint written.
// ---------------------------------------------------------------------------

describe('WI-565 AC1/AC6 — harness dispatch, invocation, output collection', () => {
  it('resolves the adapter by name and invokes it once with the rendered prompt + mounted inputs', async () => {
    db = openDb();
    const { adapter, calls } = makeRecordingHarness();
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry);
    seedCoderCard(db);
    const { io } = makeIO();

    await runExecutor({
      db, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry,
    } as RunEngineArgs);

    // Invoked exactly once — the harness replaces the single transform model call.
    expect(calls).toHaveLength(1);
    const invocation = calls[0]!;
    // Inputs rendered: the declared input's content is interpolated into the prompt.
    expect(invocation.prompt).toContain('build the widget');
    // Declared inputs are mounted (name + path), not inlined bytes.
    expect(invocation.inputs.map((i) => i.name)).toContain('task.json');
    // The declared tools allowlist is passed through to the adapter.
    expect(invocation.tools).toEqual(['Read', 'Write', 'Bash']);
  });

  it('collects the declared output, schema-validates it, and advances the card to done', async () => {
    db = openDb();
    const { adapter } = makeRecordingHarness({ content: JSON.stringify({ summary: 'ok' }) });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry);
    seedCoderCard(db);
    const { io } = makeIO();

    await runExecutor({
      db, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry,
    } as RunEngineArgs);

    // Routed through runGateCheckOrAdvance (no gate) → advanced to the terminal lane.
    expect(getCard(db)?.lane).toBe('done');
    // The declared output the harness produced is on disk.
    expect(existsSync(join(projectDir, 'result.json'))).toBe(true);
    // AC6: the binding-stamp call site ran — a checkpoint was written.
    expect(coderCheckpoint(db)).not.toBeNull();
  });

  it('a harness MAKER under no gate never touches the ModelAdapter', async () => {
    db = openDb();
    const { adapter } = makeRecordingHarness();
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry);
    seedCoderCard(db);
    const { io } = makeIO();

    // makeThrowingModel().call throws if reached; a clean run proves the harness
    // path is self-contained (the adapter is the harness, not the model surface).
    await expect(
      runExecutor({
        db, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry,
      } as RunEngineArgs),
    ).resolves.toBeUndefined();
    expect(getCard(db)?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// AC2 — {{feedback}} threaded into the harness prompt on rework, exactly as the
//       transform path threads it.
// ---------------------------------------------------------------------------

describe('WI-565 AC2 — feedback threading on rework', () => {
  it('renders prior gate reject findings into the harness prompt via {{feedback}}', async () => {
    db = openDb();
    const { adapter, calls } = makeRecordingHarness({ content: JSON.stringify({ summary: 'reworked' }) });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { feedback: true });

    // Seed a reworked card + a prior gate_verdict reject whose findings must reach
    // the harness prompt (mirrors rework-feedback.test.ts's transform seeding).
    seedCoderCard(db, 1);
    db.appendCardLog({
      runId: DEFAULT_RUN_ID, cardId: 'entry', station: 'coder', attempt: 0,
      kind: 'gate_verdict', verdict: 'reject', findings: ['tighten the error handling'], returnTo: 'coder',
    });

    const critic = makePassingCritic();
    const { io } = makeIO();

    await runExecutor({
      db, flow, now: SECONDS(1000), adapter: critic.adapter, io, harnessRegistry: registry,
    } as RunEngineArgs);

    expect(calls).toHaveLength(1);
    // The reject finding was threaded into the harness prompt between the markers.
    const fb = calls[0]!.prompt.match(/\[\[FB\]\]([\s\S]*?)\[\[\/FB\]\]/);
    expect(fb).not.toBeNull();
    expect(fb![1]).toContain('tighten the error handling');
  });
});

// ---------------------------------------------------------------------------
// AC3 (W4 seam) — output-validation failure handling.
//
// WI-565 shipped this as a HARD non-advance to `hold`. WI-566 SUPERSEDES that:
// a missing / unparseable / schema-invalid declared output now counts against
// max_execution_attempts, bounded-retries, and on exhaustion SCRAPS with a
// distinct named reason (never hold, never silent advance). That behavior — and
// the invoke-throw (non-zero exit / timeout) classes — is covered in full by
// src/controller/executor-harness-failures.test.ts (WI-566). The interim
// hold-on-miss tests were removed here to avoid asserting behavior WI-566 undid.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC4 — a successful attempt routes through the existing gate path identically
//       to a transform (harness maker under a passing gate advances).
// ---------------------------------------------------------------------------

describe('WI-565 AC4 — routes through runGateCheckOrAdvance (harness maker under a gate)', () => {
  it('runs the gate critic over the harness output and advances on a pass verdict', async () => {
    db = openDb();
    const { adapter } = makeRecordingHarness({ content: JSON.stringify({ summary: 'gated ok' }) });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { gate: true });
    seedCoderCard(db);
    const critic = makePassingCritic();
    const { io } = makeIO();

    await runExecutor({
      db, flow, now: SECONDS(1000), adapter: critic.adapter, io, harnessRegistry: registry,
    } as RunEngineArgs);

    // The gate critic ran (the harness output routed through the SAME gate path a
    // transform maker uses) and its pass verdict advanced the card.
    expect(critic.calls.length).toBeGreaterThanOrEqual(1);
    expect(getCard(db)?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// AC5 — a completed harness attempt whose binding stamp is unchanged is skipped
//       on resume and NOT re-billed (no second invoke).
// ---------------------------------------------------------------------------

describe('WI-565 AC5 — skip-on-resume does not re-invoke (not re-billed)', () => {
  it('does not re-invoke the harness when a matching checkpoint already exists', async () => {
    db = openDb();
    const { adapter, calls } = makeRecordingHarness({ content: JSON.stringify({ summary: 'once' }) });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry);
    seedCoderCard(db);
    const { io } = makeIO();

    // First run: invoke once, write the checkpoint, advance to done.
    await runExecutor({
      db, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry,
    } as RunEngineArgs);
    expect(calls).toHaveLength(1);
    expect(coderCheckpoint(db)).not.toBeNull();

    // Simulate a resume: put the SAME card back at the station (same attempt), so
    // the binding stamp still matches (identical inputs + adapter identity).
    db.getStateDb()
      .prepare("UPDATE cards SET lane = 'coder', status = 'ready' WHERE id = 'entry' AND run_id = 'default'")
      .run();

    // Second run: the matching checkpoint stamp must skip the invocation entirely.
    await runExecutor({
      db, flow, now: SECONDS(2000), adapter: makeThrowingModel(), io, harnessRegistry: registry,
    } as RunEngineArgs);

    // Still exactly one invocation — the completed attempt was skipped, not re-billed.
    expect(calls).toHaveLength(1);
    expect(getCard(db)?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Finding 9 (RetroLearning row 9) — a GATELESS harness maker must be
// consumption-andon-checked BEFORE advancing, mirroring the transform maker's
// post-call andon check. Without it, a budget-busting harness call advances
// straight to done and the andon only trips one tick late.
// ---------------------------------------------------------------------------

describe('Finding 9 — a gateless harness maker is consumption-andon-checked before advancing', () => {
  it('halts on a budget-busting call and does NOT advance to done (no gate attached)', async () => {
    db = openDb();
    // A gateless harness whose single call reports usage FAR over the run budget.
    const { adapter } = makeRecordingHarness({
      content: JSON.stringify({ summary: 'ok' }),
      usage: { tokens: 5000, cost: 0.5 },
    });
    const registry = createHarnessRegistry([adapter]);
    // max_tokens far below the reported usage — the folded harness spend must trip
    // the consumption andon on this very dispatch.
    const flow = writeHarnessFlow(projectDir, registry, { maxTokens: 10 });
    seedCoderCard(db);
    const { io, err } = makeIO();

    await runExecutor({
      db, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io, harnessRegistry: registry,
    } as RunEngineArgs);

    // The budget-busting call halts BEFORE the card advances — not one tick late.
    expect(getCard(db)?.lane).not.toBe('done');
    // The andon reason is surfaced (never a silent halt).
    expect(err.join(' ')).toMatch(/token|budget|andon/i);
  });
});
