/**
 * Issue #125 (ADR-0014): the run and wave token budgets count cache reads at
 * `budgets.token_weights.cache_read` (default 0.1), for harness and transform
 * spend alike.
 *
 * The scenario is the issue's: shakedown run sd-cf spent 0.67M uncached input
 * and 6.35M cache reads against a 6M `max_tokens`, and the andon fired before
 * the fan-in ran. Scaled down 1000x here: each harness call bills 600 uncached
 * input, 70 output and 6,350 cache reads (7,020 raw tokens) against a 6,000
 * budget. Counting cache reads at 0.1, a call is 1,305 budget tokens and both
 * cards finish. A call of the same raw size with no cache breakdown counts
 * 7,020 and trips the andon on the first card.
 *
 * Every assertion reads the accumulator through a budget that trips or does
 * not (a second card that must not dispatch, a subtree scrapped), never the
 * journal. See CLAUDE.md, "A green suite does not mean a budget is wired".
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
import type { ModelAdapter, ModelResponse } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type KnownUsage,
} from '../worker/harness-adapter';

const MAX_TOKENS = 6_000;

/** 600 uncached + 70 output + 6,350 cache reads = 7,020 raw; 1,305 at cache_read 0.1. */
const CACHE_HEAVY: KnownUsage = {
  tokens: 7_020,
  cost: 0.05,
  breakdown: { inputTokens: 600, outputTokens: 70, cacheReadInputTokens: 6_350, cacheCreationInputTokens: 0 },
};
/** The same raw size, reported with no breakdown. */
const NO_BREAKDOWN: KnownUsage = { tokens: 7_020, cost: 0.05 };

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness station');
  },
};

let originalCwd: string;
let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-cache-budget-'));
  process.chdir(dir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function seedCard(id: string, lane: string, parentId: string | null = null, ownedPaths: string[] = []): void {
  db!.insertCard({
    run_id: DEFAULT_RUN_ID, id, parent_id: parentId, lane, status: 'ready',
    attempt: 0, wave: 0, owned_paths: ownedPaths, rework_count: 0,
  });
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

const andonLines = (lines: string[]): string[] => lines.filter((l) => l.startsWith('andon:'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness(
  mode: { returns: KnownUsage } | { throwsWith: KnownUsage },
): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'fake-harness',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      if ('throwsWith' in mode) {
        throw Object.assign(new Error('fake-harness: exited with code 1'), {
          code: 'harness-nonzero-exit',
          usage: mode.throwsWith,
        });
      }
      writeFileSync(join(process.cwd(), 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
      return { outputs: [], usage: mode.returns };
    },
  };
  return { adapter, calls };
}

function harnessFlow(adapter: HarnessAdapter, budgetsExtra = ''): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'walk.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"walk"}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: cache-budget
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${MAX_TOKENS} }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
${budgetsExtra}
terminal_lanes: [done, scrap, hold]
stations:
  - id: walk
    worker:
      kind: harness
      harness: fake-harness
      prompt_file: prompts/walk.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done
`,
  );
  const registry = createHarnessRegistry([adapter]);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

async function runHarness(adapter: HarnessAdapter, budgetsExtra = ''): Promise<string[]> {
  const flow = harnessFlow(adapter, budgetsExtra);
  seedCard('walker-1', 'walk', null, ['task.json', 'result.json']);
  seedCard('walker-2', 'walk', null, ['task.json', 'result.json']);
  const { io, lines } = makeIO();
  await runExecutor({
    db: db!, flow, now: () => 1000, adapter: throwingModel, io,
    harnessRegistry: createHarnessRegistry([adapter]),
  } as RunEngineArgs);
  return lines;
}

describe('issue #125: harness cache reads count at the cache_read weight', () => {
  it('the issue scenario: two cache-heavy walkers finish under a budget their raw tokens exceed', async () => {
    const { adapter, calls } = makeHarness({ returns: CACHE_HEAVY });

    const lines = await runHarness(adapter);

    // 2 x 1,305 = 2,610 budget tokens against 6,000; raw would be 14,040.
    expect(andonLines(lines)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(db!.getCard(DEFAULT_RUN_ID, 'walker-1')?.lane).toBe('done');
    expect(db!.getCard(DEFAULT_RUN_ID, 'walker-2')?.lane).toBe('done');
  });

  it('a call of the same raw size with no cache breakdown counts at weight 1 and trips on the first card', async () => {
    const { adapter, calls } = makeHarness({ returns: NO_BREAKDOWN });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls).toHaveLength(1);
  });

  it('cache_read: 1 restores the raw count, so the cache-heavy run trips as it did before', async () => {
    const { adapter, calls } = makeHarness({ returns: CACHE_HEAVY });

    const lines = await runHarness(adapter, '  token_weights: { cache_read: 1 }');

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls).toHaveLength(1);
  });

  it('cache_creation weight applies: 2,500 cache-creation tokens at 2 put one call over 6,000', async () => {
    // 600 + 70 + 0.1 * 6,350 + 2 * 2,500 = 6,305.
    const usage: KnownUsage = {
      tokens: 9_520,
      cost: 0.05,
      breakdown: { inputTokens: 600, outputTokens: 70, cacheReadInputTokens: 6_350, cacheCreationInputTokens: 2_500 },
    };
    const { adapter, calls } = makeHarness({ returns: usage });

    const lines = await runHarness(adapter, '  token_weights: { cache_creation: 2 }');

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls).toHaveLength(1);
  });

  it('a total the breakdown does not account for counts at weight 1', async () => {
    // Classes sum to 7,020; the reported total is 12,020, so 5,000 more count
    // at 1: 1,305 + 5,000 = 6,305 > 6,000.
    const { adapter, calls } = makeHarness({ returns: { ...CACHE_HEAVY, tokens: 12_020 } });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls).toHaveLength(1);
  });

  it('a billed throw folds at the same weights: two cache-heavy throws stay under budget', async () => {
    const { adapter, calls } = makeHarness({ throwsWith: CACHE_HEAVY });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('a billed throw with no breakdown counts at weight 1 and trips on the first card', async () => {
    const { adapter, calls } = makeHarness({ throwsWith: NO_BREAKDOWN });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function transformFlow(budgets: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'p.md'), 'Work from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  const station = (id: string, next: string): string => `
  - id: ${id}
    worker:
      kind: transform
      model: cache-model
      prompt_file: prompts/p.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [context.json]
    outputs: [${id}.json]
    next: ${next}`;
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: transform-cache-budget
project_root: .
flow_version: 1
budgets:
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
${budgets}
terminal_lanes: [done, scrap, hold]
stations:${station('burn1', 'burn2')}${station('burn2', 'done')}
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** 100 uncached + 10 output + 900 cache reads = 1,010 raw; 200 at cache_read 0.1. */
const SPLIT: ModelResponse = {
  text: JSON.stringify({ idea: 'x' }), inputTokens: 100, cacheReadInputTokens: 900, outputTokens: 10, costUsd: 0,
};
/** The same 1,000 prompt tokens with no split reported. */
const UNSPLIT: ModelResponse = { text: SPLIT.text, inputTokens: 1_000, outputTokens: 10, costUsd: 0 };

function counting(response: ModelResponse): { adapter: ModelAdapter; calls: () => number } {
  let n = 0;
  return { adapter: { call: async () => (n++, { ...response }) }, calls: () => n };
}

describe('issue #125: transform cache reads count at the cache_read weight', () => {
  const RUN_BUDGET = '  run: { wall_clock_minutes: 10, max_tokens: 500 }';

  it('two split calls (400 budget tokens) clear a 500 run budget their raw 2,020 tokens exceed', async () => {
    const flow = transformFlow(RUN_BUDGET);
    seedCard('entry', 'burn1');
    const { adapter, calls } = counting(SPLIT);
    const { io, lines } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual([]);
    expect(calls()).toBe(2);
    expect(db!.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
  });

  it('an unsplit call of the same size counts at weight 1 and trips after the first station', async () => {
    const flow = transformFlow(RUN_BUDGET);
    seedCard('entry', 'burn1');
    const { adapter, calls } = counting(UNSPLIT);
    const { io, lines } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls()).toBe(1);
  });

  it('cache_read: 0 counts only uncached input and output', async () => {
    // 110 per call; a 219 budget clears one call and trips on the second.
    const flow = transformFlow(
      '  run: { wall_clock_minutes: 10, max_tokens: 219 }\n  token_weights: { cache_read: 0 }',
    );
    seedCard('entry', 'burn1');
    const { adapter, calls } = counting(SPLIT);
    const { io, lines } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual(['andon: run halted — tokens budget exceeded']);
    expect(calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Wave budget
// ---------------------------------------------------------------------------

describe('issue #125: the per-wave budget uses the same weights', () => {
  const terminalReasons = (cardId: string): string[] =>
    db!
      .getCardLog(cardId)
      .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
      .map((e) => e.reason);

  it('a cache-heavy subtree under its weighted wave cap is not scrapped', async () => {
    // One split call is 200 budget tokens (1,010 raw); cap 300.
    const flow = transformFlow('  per_wave: { max_tokens: 300 }');
    seedCard('a1', 'burn1', 'epicA');
    const { adapter } = counting(SPLIT);
    const { io } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    // burn1 (200) leaves the subtree under 300, burn2 takes it to 400 and the
    // card is already done when the next wave check runs.
    expect(db!.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('done');
    expect(terminalReasons('a1')).not.toContain('wave_budget');
  });

  it('the same subtree at cache_read 1 is scrapped after its first station', async () => {
    const flow = transformFlow('  per_wave: { max_tokens: 300 }\n  token_weights: { cache_read: 1 }');
    seedCard('a1', 'burn1', 'epicA');
    const { adapter, calls } = counting(SPLIT);
    const { io } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(db!.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('scrap');
    expect(terminalReasons('a1')).toContain('wave_budget');
    expect(calls()).toBe(1);
  });
});
