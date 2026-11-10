/**
 * Issue #125 (ADR-0014): the run and wave token budgets count each call's
 * cache classes at the weights of the adapter that billed it
 * (worker/adapter-cache-weights.ts), unless the flow's `budgets.token_weights`
 * sets a class, which then applies to every adapter.
 *
 * The scenario is the issue's: shakedown run sd-cf spent 0.67M uncached input
 * and 6.35M cache reads against a 6M `max_tokens`, and the andon fired before
 * the fan-in ran. Scaled down 1000x here: each harness call bills 600 uncached
 * input, 70 output and 6,350 cache reads (7,020 raw tokens) against a 6,000
 * budget. Behind `claude-headless` (cache reads 0.1) a call is 1,305 budget
 * tokens and both cards finish. The same call behind `codex-app-server`
 * (0.5) is 3,845, and behind an unknown adapter, or with no breakdown, 7,020.
 *
 * Every assertion reads the accumulator through a budget that trips or does
 * not (a card that must not dispatch, a subtree scrapped, an andon at an exact
 * figure), never the journal. See CLAUDE.md, "A green suite does not mean a
 * budget is wired".
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
import { remainingRunTokens } from '../run/run-passes';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter, ModelResponse } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type KnownUsage,
} from '../worker/harness-adapter';

const MAX_TOKENS = 6_000;

/** 600 uncached + 70 output + 6,350 cache reads = 7,020 raw. */
const CACHE_HEAVY: KnownUsage = {
  tokens: 7_020,
  cost: 0.05,
  breakdown: { inputTokens: 600, outputTokens: 70, cacheReadInputTokens: 6_350, cacheCreationInputTokens: 0 },
};
/** CACHE_HEAVY's budget figure behind each adapter. */
const CLAUDE_FIGURE = 1_305; // 670 + 0.1 * 6,350
const CODEX_FIGURE = 3_845; // 670 + 0.5 * 6,350
/** The same raw size, reported with no breakdown. */
const NO_BREAKDOWN: KnownUsage = { tokens: 7_020, cost: 0.05 };

const ANDON = ['andon: run halted — tokens budget exceeded'];

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness station');
  },
};

let originalCwd: string;
let dir: string;
let db: ConduitDB;

function freshDb(): void {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-cache-budget-'));
  process.chdir(dir);
  freshDb();
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function seedCard(id: string, lane: string, parentId: string | null = null, ownedPaths: string[] = []): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id, parent_id: parentId, lane, status: 'ready',
    attempt: 0, wave: 0, owned_paths: ownedPaths, rework_count: 0,
  });
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

const andonLines = (lines: string[]): string[] => lines.filter((l) => l.startsWith('andon:'));

/** Budget tokens left after a run, read from the journal as --append-pass and resume read them. */
const journalRemaining = (maxTokens: number, override?: FlowConfig['budgets']): number =>
  remainingRunTokens(db, DEFAULT_RUN_ID, maxTokens, override?.token_weights);

// ---------------------------------------------------------------------------
// Harness fakes and flows
// ---------------------------------------------------------------------------

/** A harness adapter under a real adapter name, so the executor looks up that adapter's weights. */
function makeHarness(
  mode: { returns: KnownUsage } | { throwsWith: KnownUsage },
  opts: { name?: string; output?: string } = {},
): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const output = opts.output ?? 'result.json';
  const adapter: HarnessAdapter = {
    name: opts.name ?? 'claude-headless',
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
      writeFileSync(join(process.cwd(), output), JSON.stringify({ summary: 'ok' }), 'utf-8');
      return { outputs: [], usage: mode.returns };
    },
  };
  return { adapter, calls };
}

const harnessWorker = (adapter: string, prompt: string): string => `
    worker:
      kind: harness
      harness: ${adapter}
      prompt_file: prompts/${prompt}.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }`;

function writePrompts(...names: string[]): void {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  for (const n of names) writeFileSync(join(dir, 'prompts', `${n}.md`), `TASK ${n}: {{task.json}}`);
  writeFileSync(join(dir, 'task.json'), '{"task":"walk"}');
}

function load(yaml: string, adapters: HarnessAdapter[]): FlowConfig {
  writeFileSync(join(dir, 'flow.yaml'), yaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: createHarnessRegistry(adapters) });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function harnessFlow(adapter: HarnessAdapter, budgetsExtra = '', maxTokens = MAX_TOKENS): FlowConfig {
  writePrompts('walk');
  return load(
    `
flow: cache-budget
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
${budgetsExtra}
terminal_lanes: [done, scrap, hold]
stations:
  - id: walk${harnessWorker(adapter.name, 'walk')}
    inputs: [task.json]
    outputs: [result.json]
    next: done
`,
    [adapter],
  );
}

async function runHarness(adapter: HarnessAdapter, budgetsExtra = '', maxTokens = MAX_TOKENS): Promise<string[]> {
  const flow = harnessFlow(adapter, budgetsExtra, maxTokens);
  seedCard('walker-1', 'walk', null, ['task.json', 'result.json']);
  seedCard('walker-2', 'walk', null, ['task.json', 'result.json']);
  const { io, lines } = makeIO();
  await runExecutor({
    db, flow, now: () => 1000, adapter: throwingModel, io,
    harnessRegistry: createHarnessRegistry([adapter]),
  } as RunEngineArgs);
  return lines;
}

describe('issue #125: harness cache reads count at the billing adapter\'s weight', () => {
  it('the issue scenario: two cache-heavy claude-headless walkers finish under a budget their raw tokens exceed', async () => {
    const { adapter, calls } = makeHarness({ returns: CACHE_HEAVY });

    const lines = await runHarness(adapter);

    // 2 x 1,305 = 2,610 budget tokens against 6,000; raw would be 14,040.
    expect(andonLines(lines)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(db.getCard(DEFAULT_RUN_ID, 'walker-1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'walker-2')?.lane).toBe('done');
  });

  it('behind codex-app-server the same calls count 3,845 each and trip on the second card', async () => {
    const { adapter, calls } = makeHarness({ returns: CACHE_HEAVY }, { name: 'codex-app-server' });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(2);
    expect(journalRemaining(10_000)).toBe(10_000 - 2 * CODEX_FIGURE);
  });

  it('behind an adapter with no declared weights the same call counts at 1 and trips on the first card', async () => {
    const { adapter, calls } = makeHarness({ returns: CACHE_HEAVY }, { name: 'fake-harness' });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(1);
  });

  it('a call of the same raw size with no cache breakdown counts at weight 1 and trips on the first card', async () => {
    const { adapter, calls } = makeHarness({ returns: NO_BREAKDOWN });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(1);
  });

  it('a flow cache_read: 1 overrides the adapter default, so the cache-heavy run trips as it did before', async () => {
    const { adapter, calls } = makeHarness({ returns: CACHE_HEAVY });

    const lines = await runHarness(adapter, '  token_weights: { cache_read: 1 }');

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(1);
  });

  const WITH_CREATION: KnownUsage = {
    tokens: 9_520,
    cost: 0.05,
    breakdown: { inputTokens: 600, outputTokens: 70, cacheReadInputTokens: 6_350, cacheCreationInputTokens: 2_500 },
  };

  it("claude-headless's cache_creation default of 2 puts one call with 2,500 cache-creation tokens over 6,000", async () => {
    // 1,305 + 2 * 2,500 = 6,305.
    const { adapter, calls } = makeHarness({ returns: WITH_CREATION });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(1);
  });

  it('a flow cache_creation: 1 overrides it, and only the second call trips', async () => {
    // 1,305 + 2,500 = 3,805 per call.
    const { adapter, calls } = makeHarness({ returns: WITH_CREATION });

    const lines = await runHarness(adapter, '  token_weights: { cache_creation: 1 }');

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(2);
  });

  it('a total the breakdown does not account for counts at weight 1', async () => {
    // Classes sum to 7,020; the reported total is 12,020, so 5,000 more count
    // at 1: 1,305 + 5,000 = 6,305 > 6,000.
    const { adapter, calls } = makeHarness({ returns: { ...CACHE_HEAVY, tokens: 12_020 } });

    const lines = await runHarness(adapter);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(1);
  });

  // Classes sum to 7,020 of a reported 12,020: 1,305 + 5,000 = 6,305 budget
  // tokens per call, 12,610 for the two walkers.
  const UNDER_COVERED: KnownUsage = { ...CACHE_HEAVY, tokens: 12_020 };

  it('in memory, two under-covered calls count exactly 12,610: a 12,610 budget trips, 12,611 does not', async () => {
    const tripped = await runHarness(makeHarness({ returns: UNDER_COVERED }).adapter, '', 12_610);
    expect(andonLines(tripped)).toEqual(ANDON);

    db.close();
    freshDb();
    const clear = await runHarness(makeHarness({ returns: UNDER_COVERED }).adapter, '', 12_611);
    expect(andonLines(clear)).toEqual([]);
  });

  it('a pass or resume remaining budget counts the same 12,610 the executor did', async () => {
    // The journal-derived budget (remainingRunTokens, used by --append-pass and
    // by resume of a run with passes) must not lose the 5,000 per call the
    // breakdown does not cover.
    const lines = await runHarness(makeHarness({ returns: UNDER_COVERED }).adapter, '', 100_000);
    expect(andonLines(lines)).toEqual([]);

    expect(journalRemaining(100_000)).toBe(100_000 - 12_610);
    // The raw journal total stays the adapter's reported total.
    expect(db.getRunUsageTotals(DEFAULT_RUN_ID).tokens).toBe(2 * 12_020);
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

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mixed flow: Claude harness, codex harness, transform
// ---------------------------------------------------------------------------

/** 100 uncached + 10 output + 900 cache reads = 1,010 raw. */
const SPLIT: ModelResponse = {
  text: JSON.stringify({ summary: 'x', idea: 'x' }), inputTokens: 100, cacheReadInputTokens: 900, outputTokens: 10, costUsd: 0,
};

function counting(response: ModelResponse): { adapter: ModelAdapter; calls: () => number } {
  let n = 0;
  return { adapter: { call: async () => (n++, { ...response }) }, calls: () => n };
}

describe('issue #125: a mixed flow weights each call for its own adapter', () => {
  function mixedFlow(maxTokens: number, budgetsExtra = ''): { flow: FlowConfig; adapters: HarnessAdapter[] } {
    writePrompts('walk', 'audit', 'sum');
    const walk = makeHarness({ returns: CACHE_HEAVY }, { name: 'claude-headless', output: 'walk.json' }).adapter;
    const audit = makeHarness({ returns: CACHE_HEAVY }, { name: 'codex-app-server', output: 'audit.json' }).adapter;
    const flow = load(
      `
flow: mixed-cache-budget
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
${budgetsExtra}
terminal_lanes: [done, scrap, hold]
stations:
  - id: walk${harnessWorker('claude-headless', 'walk')}
    inputs: [task.json]
    outputs: [walk.json]
    next: audit
  - id: audit${harnessWorker('codex-app-server', 'audit')}
    inputs: [task.json]
    outputs: [audit.json]
    next: sum
  - id: sum
    worker:
      kind: transform
      model: cache-model
      prompt_file: prompts/sum.md
      prompt_version: "1"
      output_schema: { fields: [{ name: summary, type: string, required: true }] }
    inputs: [task.json]
    outputs: [sum.json]
    next: done
`,
      [walk, audit],
    );
    return { flow, adapters: [walk, audit] };
  }

  async function runMixed(maxTokens: number, budgetsExtra = ''): Promise<string[]> {
    const { flow, adapters } = mixedFlow(maxTokens, budgetsExtra);
    seedCard('entry', 'walk', null, ['task.json', 'walk.json', 'audit.json', 'sum.json']);
    const { io, lines } = makeIO();
    await runExecutor({
      db, flow, now: () => 1000, adapter: counting(SPLIT).adapter, io,
      harnessRegistry: createHarnessRegistry(adapters),
    } as RunEngineArgs);
    return lines;
  }

  // claude 1,305 + codex 3,845 + transform (no discount) 1,010 = 6,160.
  const MIXED_FIGURE = CLAUDE_FIGURE + CODEX_FIGURE + 1_010;

  it('counts exactly 6,160: a 6,160 budget trips after the last call, 6,161 does not', async () => {
    expect(andonLines(await runMixed(MIXED_FIGURE))).toEqual(ANDON);

    db.close();
    freshDb();
    const lines = await runMixed(MIXED_FIGURE + 1);
    expect(andonLines(lines)).toEqual([]);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
  });

  it('a pass or resume remaining budget equals the in-memory count for the mixed run', async () => {
    await runMixed(100_000);
    expect(journalRemaining(100_000)).toBe(100_000 - MIXED_FIGURE);
  });

  it("a flow cache_read overrides every adapter's default: 0.1 everywhere counts 2,810", async () => {
    // claude 1,305 + codex 1,305 + transform 100 + 10 + 90 = 2,810.
    const extra = '  token_weights: { cache_read: 0.1 }';
    expect(andonLines(await runMixed(2_810, extra))).toEqual(ANDON);

    db.close();
    freshDb();
    expect(andonLines(await runMixed(2_811, extra))).toEqual([]);
    expect(remainingRunTokens(db, DEFAULT_RUN_ID, 2_811, { cache_read: 0.1 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gate critic on a different adapter than its maker
// ---------------------------------------------------------------------------

describe('issue #125: a harness gate critic is weighted for its own adapter', () => {
  function makePassingCritic(name: string): HarnessAdapter {
    return {
      name,
      reportsUsage: true,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke() {
        writeFileSync(join(process.cwd(), 'verdict.json'), JSON.stringify({ verdict: 'pass', findings: [] }), 'utf-8');
        return { outputs: [], usage: CACHE_HEAVY };
      },
    };
  }

  async function runGated(maxTokens: number): Promise<string[]> {
    writePrompts('walk', 'verify');
    const maker = makeHarness({ returns: CACHE_HEAVY }, { name: 'claude-headless' }).adapter;
    const critic = makePassingCritic('codex-app-server');
    const flow = load(
      `
flow: gated-cache-budget
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: walk${harnessWorker('claude-headless', 'walk')}
    inputs: [task.json]
    outputs: [result.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, harness: codex-app-server, tools: [Read, Write], prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: walk
      rework_cap: 1
`,
      [maker, critic],
    );
    seedCard('entry', 'walk', null, ['task.json', 'result.json']);
    const { io, lines } = makeIO();
    await runExecutor({
      db, flow, now: () => 1000, adapter: throwingModel, io,
      harnessRegistry: createHarnessRegistry([maker, critic]),
    } as RunEngineArgs);
    return lines;
  }

  // Maker (claude) 1,305 + critic (codex) 3,845 = 5,150. With the maker's
  // weights the critic would count 1,305 (2,610 in all); with none, 7,020.
  it('counts maker 1,305 plus critic 3,845: a 5,150 budget trips, 5,151 does not', async () => {
    expect(andonLines(await runGated(5_150))).toEqual(ANDON);

    db.close();
    freshDb();
    const lines = await runGated(5_151);
    expect(andonLines(lines)).toEqual([]);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(journalRemaining(5_151)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Transform and wave budget
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

/** The same 1,000 prompt tokens with no split reported. */
const UNSPLIT: ModelResponse = { text: SPLIT.text, inputTokens: 1_000, outputTokens: 10, costUsd: 0 };

describe('issue #125: transform cache reads', () => {
  it('count at 1 by default, since the gateway may route to any provider: one split call trips 1,010', async () => {
    const flow = transformFlow('  run: { wall_clock_minutes: 10, max_tokens: 1010 }');
    seedCard('entry', 'burn1');
    const { adapter, calls } = counting(SPLIT);
    const { io, lines } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls()).toBe(1);
  });

  const DISCOUNTED = '  run: { wall_clock_minutes: 10, max_tokens: 500 }\n  token_weights: { cache_read: 0.1 }';

  it('with a flow cache_read 0.1, two split calls (400 budget tokens) clear 500', async () => {
    const flow = transformFlow(DISCOUNTED);
    seedCard('entry', 'burn1');
    const { adapter, calls } = counting(SPLIT);
    const { io, lines } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual([]);
    expect(calls()).toBe(2);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
  });

  it('an unsplit call of the same size counts at 1 whatever the flow sets, and trips after the first station', async () => {
    const flow = transformFlow(DISCOUNTED);
    seedCard('entry', 'burn1');
    const { adapter, calls } = counting(UNSPLIT);
    const { io, lines } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual(ANDON);
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

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(andonLines(lines)).toEqual(ANDON);
    expect(calls()).toBe(2);
  });
});

describe('issue #125: the per-wave budget uses the same weights', () => {
  const terminalReasons = (cardId: string): string[] =>
    db
      .getCardLog(cardId)
      .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
      .map((e) => e.reason);

  it('a cache-heavy subtree under its weighted wave cap is not scrapped', async () => {
    // With cache_read 0.1 one split call is 200 budget tokens (1,010 raw); cap 300.
    const flow = transformFlow('  per_wave: { max_tokens: 300 }\n  token_weights: { cache_read: 0.1 }');
    seedCard('a1', 'burn1', 'epicA');
    const { adapter } = counting(SPLIT);
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    // burn1 (200) leaves the subtree under 300, burn2 takes it to 400 and the
    // card is already done when the next wave check runs.
    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('done');
    expect(terminalReasons('a1')).not.toContain('wave_budget');
  });

  it("the same subtree at the transform adapter's default weight is scrapped after its first station", async () => {
    const flow = transformFlow('  per_wave: { max_tokens: 300 }');
    seedCard('a1', 'burn1', 'epicA');
    const { adapter, calls } = counting(SPLIT);
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'a1')?.lane).toBe('scrap');
    expect(terminalReasons('a1')).toContain('wave_budget');
    expect(calls()).toBe(1);
  });
});
