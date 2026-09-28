/**
 * Per-call tool gate wiring in the executor (issue #21).
 *
 * A harness adapter that sets `canGatePerCall` receives a gate on every invoke,
 * maker and critic. A throw carrying HARNESS_GATE_HOLD_CODE moves the card to
 * the `hold` lane without spending an execution attempt, and the spend the call
 * recovered is folded into the run budget. Budget assertions read the
 * accumulator through the consumption andon (a second card that must not
 * dispatch), never the journal.
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
  createHarnessRegistry, type HarnessAdapter, type HarnessInvocation, type HarnessRegistry, type UsageReport,
} from '../worker/harness-adapter';
import { HARNESS_GATE_HOLD_CODE } from '../worker/harness-gate';

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness station');
  },
};

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

interface Fake {
  adapter: HarnessAdapter;
  calls: HarnessInvocation[];
}

/**
 * A maker. `hold` makes every invoke throw the gate hold code with `usage`
 * attached; otherwise it writes result.json and reports `usage`.
 */
function makeMaker(opts: { canGatePerCall?: boolean; hold?: UsageReport | 'no-usage'; usage?: UsageReport } = {}): Fake {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'fake-harness',
    reportsUsage: true,
    canRestrictTools: true,
    ...(opts.canGatePerCall !== undefined ? { canGatePerCall: opts.canGatePerCall } : {}),
    async probeBinary() {
      return { present: true };
    },
    async invoke(call) {
      calls.push(call);
      if (opts.hold !== undefined) {
        throw Object.assign(new Error('agent-sdk: the tool gate held the card on AskUserQuestion (needs_human)'), {
          code: HARNESS_GATE_HOLD_CODE,
          ...(opts.hold !== 'no-usage' ? { usage: opts.hold } : {}),
        });
      }
      writeFileSync(join(process.cwd(), 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
      return { outputs: [], usage: opts.usage ?? { tokens: 0, cost: 0 } };
    },
  };
  return { adapter, calls };
}

/** A critic that throws the hold code, or writes a pass verdict. */
function makeCritic(opts: { canGatePerCall?: boolean; hold?: UsageReport } = {}): Fake {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'claude-critic',
    reportsUsage: true,
    canRestrictTools: true,
    ...(opts.canGatePerCall !== undefined ? { canGatePerCall: opts.canGatePerCall } : {}),
    async probeBinary() {
      return { present: true };
    },
    async invoke(call) {
      calls.push(call);
      if (opts.hold !== undefined) {
        throw Object.assign(new Error('agent-sdk: the tool gate held the card on AskUserQuestion (needs_human)'), {
          code: HARNESS_GATE_HOLD_CODE,
          usage: opts.hold,
        });
      }
      writeFileSync(join(process.cwd(), 'verdict.json'), JSON.stringify({ verdict: 'pass', findings: [] }), 'utf-8');
      return { outputs: [], usage: { tokens: 0, cost: 0 } };
    },
  };
  return { adapter, calls };
}

function writeFlow(dir: string, registry: HarnessRegistry, opts: { critic?: boolean; maxTokens?: number } = {}): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{result.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');
  const check = opts.critic
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
flow: harness-gate-hold
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${opts.maxTokens ?? 100000} }
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
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done${check}
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, id: string): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
  });
}

const getCard = (db: ConduitDB, id = 'entry') => db.getCard(DEFAULT_RUN_ID, id);

let originalCwd: string;
let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-gate-hold-'));
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  if (db) db.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

async function run(flow: FlowConfig, registry: HarnessRegistry): Promise<string[]> {
  const err: string[] = [];
  await runExecutor({
    db: db!, flow, now: () => 1000, adapter: throwingModel,
    io: { out: () => {}, err: (l: string) => err.push(l) }, harnessRegistry: registry,
  } as RunEngineArgs);
  return err;
}

describe('issue #21: the executor hands a gate to an adapter that gates per call', () => {
  it('passes a gate on a maker invoke when the adapter sets canGatePerCall', async () => {
    db = openDb();
    const { adapter, calls } = makeMaker({ canGatePerCall: true });
    const registry = createHarnessRegistry([adapter]);
    seedCard(db, 'entry');
    await run(writeFlow(dir, registry), registry);
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]!.gate).toBe('function');
    expect(getCard(db)?.lane).toBe('done');
  });

  it('never passes a gate to an adapter that does not gate', async () => {
    db = openDb();
    const { adapter, calls } = makeMaker();
    const registry = createHarnessRegistry([adapter]);
    seedCard(db, 'entry');
    await run(writeFlow(dir, registry), registry);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.gate).toBeUndefined();
  });

  it('never passes a gate to an adapter that sets canGatePerCall false', async () => {
    db = openDb();
    const { adapter, calls } = makeMaker({ canGatePerCall: false });
    const registry = createHarnessRegistry([adapter]);
    seedCard(db, 'entry');
    await run(writeFlow(dir, registry), registry);
    expect(calls[0]!.gate).toBeUndefined();
  });

  it('passes a gate on a critic invoke, and none to a critic that does not gate', async () => {
    db = openDb();
    const maker = makeMaker();
    const gating = makeCritic({ canGatePerCall: true });
    const registry = createHarnessRegistry([maker.adapter, gating.adapter]);
    seedCard(db, 'entry');
    await run(writeFlow(dir, registry, { critic: true }), registry);
    expect(gating.calls).toHaveLength(1);
    expect(typeof gating.calls[0]!.gate).toBe('function');
    rmSync(join(dir, 'verdict.json'), { force: true });

    const db2 = openDb();
    db.close();
    db = db2;
    const plain = makeCritic();
    const registry2 = createHarnessRegistry([makeMaker().adapter, plain.adapter]);
    seedCard(db, 'entry');
    await run(writeFlow(dir, registry2, { critic: true }), registry2);
    expect(plain.calls).toHaveLength(1);
    expect(plain.calls[0]!.gate).toBeUndefined();
  });
});

describe('issue #21: a gate hold moves the card to hold', () => {
  it('holds a maker card without spending an execution attempt or retrying', async () => {
    db = openDb();
    const { adapter, calls } = makeMaker({ canGatePerCall: true, hold: 'no-usage' });
    const registry = createHarnessRegistry([adapter]);
    seedCard(db, 'entry');
    const flow = writeFlow(dir, registry);
    await run(flow, registry);

    // max_execution_attempts is 3; one call means the hold was not treated as a failed attempt.
    expect(calls).toHaveLength(1);
    const card = getCard(db)!;
    expect(card.lane).toBe('hold');
    expect(card.status).toBe('held');
    expect(card.attempt).toBe(0);
    const reasons = db.getCardLog('entry').filter((e) => e.kind === 'terminal').map((e) => (e as { reason: string }).reason);
    expect(reasons.join('\n')).toContain('harness tool gate held station');
    expect(reasons.join('\n')).toContain('needs_human');
    // No scrap: the card is waiting for a human, not written off.
    expect(db.getCardLog('entry').some((e) => e.kind === 'entered_lane' && (e as { destLane?: string }).destLane === 'scrap')).toBe(false);
  });

  it("folds a maker hold's recovered usage into tokensSpent (the andon halts before a second card)", async () => {
    db = openDb();
    const { adapter, calls } = makeMaker({ canGatePerCall: true, hold: { tokens: 100, cost: 0.1 } });
    const registry = createHarnessRegistry([adapter]);
    seedCard(db, 'entry');
    seedCard(db, 'entry2');
    const err = await run(writeFlow(dir, registry, { maxTokens: 50 }), registry);
    expect(err.join('\n')).toMatch(/andon/i);
    expect(err.join('\n')).toMatch(/token/i);
    // If the usage were not folded, entry2 would dispatch and be held too.
    expect(calls).toHaveLength(1);
    expect(getCard(db, 'entry')?.lane).toBe('hold');
    expect(getCard(db, 'entry2')?.lane).toBe('coder');
  });

  it('holds a card whose critic was held, writes no verdict row, and folds the critic usage', async () => {
    db = openDb();
    const maker = makeMaker();
    const critic = makeCritic({ canGatePerCall: true, hold: { tokens: 100, cost: 0.1 } });
    const registry = createHarnessRegistry([maker.adapter, critic.adapter]);
    seedCard(db, 'entry');
    seedCard(db, 'entry2');
    const err = await run(writeFlow(dir, registry, { critic: true, maxTokens: 50 }), registry);

    expect(getCard(db, 'entry')?.lane).toBe('hold');
    expect(getCard(db, 'entry')?.status).toBe('held');
    expect(db.getCardLog('entry').some((e) => e.kind === 'gate_verdict')).toBe(false);
    const reasons = db.getCardLog('entry').filter((e) => e.kind === 'terminal').map((e) => (e as { reason: string }).reason);
    expect(reasons.join('\n')).toContain('held the critic');
    // The critic's 100 tokens tripped the 50-token budget: the second card never got its turn.
    expect(err.join('\n')).toMatch(/andon/i);
    expect(critic.calls).toHaveLength(1);
    expect(maker.calls).toHaveLength(1);
    expect(getCard(db, 'entry2')?.lane).toBe('coder');
  });
});
