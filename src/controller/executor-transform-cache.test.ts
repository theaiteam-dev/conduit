/**
 * Issue #156: a transform call's cache-read split reaches the span columns and
 * leaves the run budget where it was.
 *
 * The adapter reports `inputTokens` as UNCACHED input and the cache reads in
 * `cacheReadInputTokens` (issue #5 convention). The run token budget must
 * count all three classes, so a call that reported `prompt_tokens: 14` as one
 * figure and a call that reports it as 4 uncached + 10 cache reads spend the
 * same 20 tokens. The budget assertions here trip or clear the andon on that
 * exact total, which reads the accumulator, not the journal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const MODEL = 'cache-model';

/** 4 uncached + 10 cache reads + 6 output = 20 tokens per call. */
const SPLIT_RESPONSE: ModelResponse = {
  text: JSON.stringify({ idea: 'an idea' }),
  inputTokens: 4,
  cacheReadInputTokens: 10,
  outputTokens: 6,
  costUsd: 0.001,
};

function adapterReturning(response: ModelResponse): ModelAdapter {
  return { call: async () => ({ ...response }) };
}

function setupFlow(dir: string, maxTokens: number): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: transform-cache
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: null,
    lane: over.lane,
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['context.json', 'idea.json'],
    rework_count: 0,
  });
}

function transformSpans(db: ConduitDB) {
  return db
    .getSpanTokenUsageForRun(DEFAULT_RUN_ID)
    .filter((s) => s.name === 'ideate.transform')
    .map((s) => ({
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cache_read_input_tokens: s.cacheReadInputTokens,
      cache_creation_input_tokens: s.cacheCreationInputTokens,
    }));
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-transform-cache-'));
  process.chdir(projectDir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

describe('transform cache-read split (issue #156)', () => {
  it('counts cache reads in the run token budget: a 20-token call trips max_tokens 20', async () => {
    const flow = setupFlow(projectDir, 20);
    seedCard(db!, { id: 'entry', lane: 'ideate' });
    const { io, lines } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter: adapterReturning(SPLIT_RESPONSE), io } as RunEngineArgs);

    expect(lines.filter((l) => l.startsWith('andon:'))).toEqual(['andon: run halted — tokens budget exceeded']);
  });

  it('does not count the cache reads twice: the same call clears max_tokens 21', async () => {
    const flow = setupFlow(projectDir, 21);
    seedCard(db!, { id: 'entry', lane: 'ideate' });
    const { io, lines } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter: adapterReturning(SPLIT_RESPONSE), io } as RunEngineArgs);

    expect(lines.filter((l) => l.startsWith('andon:'))).toEqual([]);
    expect(db!.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
  });

  it('a split call and an unsplit call of the same size spend the same budget', async () => {
    // The unsplit call reports all 14 prompt tokens as input, as the adapter
    // did before #156. It trips at 20 and clears at 21, like the split call.
    const unsplit: ModelResponse = { text: SPLIT_RESPONSE.text, inputTokens: 14, outputTokens: 6, costUsd: 0.001 };
    const flow = setupFlow(projectDir, 20);
    seedCard(db!, { id: 'entry', lane: 'ideate' });
    const { io, lines } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter: adapterReturning(unsplit), io } as RunEngineArgs);

    expect(lines.filter((l) => l.startsWith('andon:'))).toEqual(['andon: run halted — tokens budget exceeded']);
  });

  it('writes the split to the transform span: uncached input, cache reads, no cache-creation figure', async () => {
    const flow = setupFlow(projectDir, 1000);
    seedCard(db!, { id: 'entry', lane: 'ideate' });
    const { io } = makeIO();

    await runExecutor({ db: db!, flow, now: () => 1000, adapter: adapterReturning(SPLIT_RESPONSE), io } as RunEngineArgs);

    expect(transformSpans(db!)).toEqual([
      { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 10, cache_creation_input_tokens: null },
    ]);
    expect(db!.getRunUsageTotals(DEFAULT_RUN_ID).tokens).toBe(20);
  });

  it('leaves both cache columns NULL when the adapter reports no split', async () => {
    const flow = setupFlow(projectDir, 1000);
    seedCard(db!, { id: 'entry', lane: 'ideate' });
    const { io } = makeIO();
    const unsplit: ModelResponse = { text: SPLIT_RESPONSE.text, inputTokens: 14, outputTokens: 6, costUsd: 0.001 };

    await runExecutor({ db: db!, flow, now: () => 1000, adapter: adapterReturning(unsplit), io } as RunEngineArgs);

    expect(transformSpans(db!)).toEqual([
      { input_tokens: 14, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    ]);
  });
});
