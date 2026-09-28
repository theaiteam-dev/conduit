/**
 * Issue #71: the executor journals harness events.
 *
 * Drives the REAL runExecutor with fake harness adapters that emit events on
 * `HarnessInvocation.onEvent` the way the claude adapter does (through
 * createHarnessEventEmitter). What must hold:
 *   - the maker's and the gate critic's invoke() each receive an onEvent sink;
 *   - each invoke() gets its own invocation id, stamped on its event rows and
 *     on the harness span (`<station>.harness` / `<station>.harness-critic`)
 *     that reports on it, so rows join to their span;
 *   - a rate-limit park re-invokes under the SAME attempt with a NEW id;
 *   - deltas never reach the journal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessRegistry,
} from '../worker/harness-adapter';
import { createHarnessEventEmitter } from '../worker/harness-events';

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

const io = { out: (_l: string) => {}, err: (_l: string) => {} };

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used here');
  },
};

/** Emit one call's worth of events, deltas included, as the claude adapter would. */
function emitCall(call: HarnessInvocation, toolPath: string): void {
  if (call.onEvent === undefined) return;
  const emit = createHarnessEventEmitter(call.onEvent);
  emit({ type: 'lifecycle', phase: 'start' });
  emit({ type: 'reasoning-delta', id: 'r', delta: 'SECRET-REASONING' });
  emit({ type: 'tool-input-start', toolCallId: 't1', toolName: 'Write' });
  emit({ type: 'tool-input-available', toolCallId: 't1', toolName: 'Write', input: { file_path: toolPath, content: 'SECRET-BODY' } });
  emit({ type: 'tool-output-available', toolCallId: 't1', output: 'SECRET-OUTPUT', isError: false });
  emit({ type: 'text-delta', id: 'x', delta: 'SECRET-TEXT' });
  emit({ type: 'usage', tokens: 10, breakdown: { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
  emit({ type: 'lifecycle', phase: 'end', exitCode: 0 });
}

type MakerStep = 'ok' | 'rate-limited';

function makeMaker(steps: MakerStep[]): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  let i = 0;
  const adapter: HarnessAdapter = {
    name: 'fake-harness',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call) {
      calls.push(call);
      const step = steps[Math.min(i++, steps.length - 1)]!;
      emitCall(call, 'result.json');
      if (step === 'rate-limited') {
        throw Object.assign(new Error('fake: provider rate limit'), { code: 'harness-rate-limited' });
      }
      writeFileSync(join(process.cwd(), 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
      return { outputs: [], usage: { tokens: 10, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

function makeCritic(): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'claude-critic',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call) {
      calls.push(call);
      emitCall(call, 'verdict.json');
      writeFileSync(join(process.cwd(), 'verdict.json'), JSON.stringify({ verdict: 'pass', findings: [] }), 'utf-8');
      return { outputs: [], usage: { tokens: 8, cost: 0.008 } };
    },
  };
  return { adapter, calls };
}

function writeFlow(dir: string, registry: HarnessRegistry, opts: { gated?: boolean } = {}): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{result.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build the widget"}');
  const gate = opts.gated
    ? `
    check:
      kind: gate
      critic: { role: critic, harness: claude-critic, tools: [Read, Write], prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: coder
      rework_cap: 2`
    : '';
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: harness-events
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 3 }
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
    inputs: [task.json]
    outputs: [result.json]
    next: done${gate}
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json', 'verdict.json'], rework_count: 0,
  });
}

let originalCwd: string;
let projectDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-harness-events-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

async function run(flow: FlowConfig, registry: HarnessRegistry, startSeconds = 1000): Promise<void> {
  let clock = startSeconds;
  await runExecutor({
    db: db!, flow, now: () => clock, sleep: async (ms: number) => { clock += Math.max(1, Math.ceil(ms / 1000)); },
    adapter: throwingModel, io, harnessRegistry: registry,
  } as unknown as RunEngineArgs);
}

const harnessSpans = (d: ConduitDB) =>
  d.getJournalSpansForRun(DEFAULT_RUN_ID, 'entry').filter((s) => s.name === 'coder.harness' || s.name === 'coder.harness-critic');

describe('issue #71: the maker path journals its events', () => {
  it('passes onEvent, writes only durable kinds, and stamps the span\'s invocation id on every row', async () => {
    db = openDb();
    const { adapter, calls } = makeMaker(['ok']);
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(projectDir, registry);
    seedCard(db);

    await run(flow, registry);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(typeof calls[0]!.onEvent).toBe('function');

    const [span] = harnessSpans(db);
    expect(span!.invocationId).toEqual(expect.any(String));

    const rows = db.getHarnessEventsForRun(DEFAULT_RUN_ID, 'entry');
    expect(rows.map((r) => r.kind)).toEqual([
      'lifecycle', 'tool-input-available', 'tool-output-available', 'usage', 'lifecycle',
    ]);
    expect(rows.every((r) => r.invocationId === span!.invocationId && r.attempt === span!.attempt)).toBe(true);
    expect(rows.every((r) => r.station === 'coder')).toBe(true);
    expect(rows[1]!.path).toBe('result.json');
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('gives a rate-limit park and its re-invoke distinct invocation ids under the same attempt', async () => {
    db = openDb();
    const { adapter, calls } = makeMaker(['rate-limited', 'ok']);
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(projectDir, registry);
    seedCard(db);

    await run(flow, registry);

    expect(calls).toHaveLength(2);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');

    const spans = harnessSpans(db);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.attributes.outcome).toBe('harness-rate-limited');
    expect(spans[0]!.attempt).toBe(spans[1]!.attempt);
    expect(spans[0]!.invocationId).not.toBe(spans[1]!.invocationId);

    const rows = db.getHarnessEventsForRun(DEFAULT_RUN_ID, 'entry');
    const starts = rows.filter((r) => r.kind === 'lifecycle' && r.phase === 'start');
    expect(starts.map((r) => r.invocationId)).toEqual(spans.map((s) => s.invocationId!));
    expect(starts.map((r) => r.seq)).toEqual([0, 0]);
  });
});

describe('issue #71: the gate critic journals its events', () => {
  it('gives the critic its own invocation id, on its rows and on the harness-critic span', async () => {
    db = openDb();
    const maker = makeMaker(['ok']);
    const critic = makeCritic();
    const registry = createHarnessRegistry([maker.adapter, critic.adapter]);
    const flow = writeFlow(projectDir, registry, { gated: true });
    seedCard(db);

    await run(flow, registry);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(typeof critic.calls[0]!.onEvent).toBe('function');

    const spans = harnessSpans(db);
    const makerSpan = spans.find((s) => s.name === 'coder.harness')!;
    const criticSpan = spans.find((s) => s.name === 'coder.harness-critic')!;
    expect(criticSpan.invocationId).toEqual(expect.any(String));
    expect(criticSpan.invocationId).not.toBe(makerSpan.invocationId);
    // The critic runs under the maker's attempt: only the invocation id tells them apart.
    expect(criticSpan.attempt).toBe(makerSpan.attempt);

    const rows = db.getHarnessEventsForRun(DEFAULT_RUN_ID, 'entry');
    const byInvocation = new Map<string, string[]>();
    for (const r of rows) byInvocation.set(r.invocationId, [...(byInvocation.get(r.invocationId) ?? []), r.path ?? '']);
    expect([...byInvocation.keys()]).toEqual([makerSpan.invocationId!, criticSpan.invocationId!]);
    expect(byInvocation.get(criticSpan.invocationId!)).toContain('verdict.json');
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });
});

describe('issue #71: event rows take their time from the executor\'s injected clock', () => {
  it('stamps at_ms from now() (seconds) for the maker and the critic, not the wall clock', async () => {
    db = openDb();
    const maker = makeMaker(['ok']);
    const critic = makeCritic();
    const registry = createHarnessRegistry([maker.adapter, critic.adapter]);
    const flow = writeFlow(projectDir, registry, { gated: true });
    seedCard(db);

    // No retry or park in this run, so the virtual clock never advances.
    await run(flow, registry, 4242);

    const rows = db.getHarnessEventsForRun(DEFAULT_RUN_ID, 'entry');
    expect(new Set(rows.map((r) => r.invocationId)).size).toBe(2);
    expect(rows.map((r) => r.atMs)).toEqual(rows.map(() => 4_242_000));
  });
});
