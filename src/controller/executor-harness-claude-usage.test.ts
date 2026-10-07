/**
 * Claude harness token counts reach the run budget at their cumulative figure
 * (issue #108).
 *
 * A Claude Code session with a background subagent emits two `result`
 * messages. The last one's `usage` covers only the turns since the first and
 * leaves out the side-task model; its `modelUsage` covers the whole session.
 * Both Claude adapters keep the last result, so the figure that reaches
 * `foldHarnessUsage` is right only if it is read from `modelUsage`.
 *
 * The fixture's figures (fixtures/harness/claude-background-subagent.ndjson):
 *   - last result's `usage`:            18,025 tokens
 *   - both results' `usage` summed:     50,500 tokens
 *   - first result's `modelUsage`:      33,484 tokens
 *   - last result's `modelUsage`:       71,856 tokens (the session total)
 * The 60,000-token budget below trips only on the last figure, so each wrong
 * reading leaves the second card free to dispatch.
 *
 * Per CLAUDE.md "A green suite does not mean a budget is wired", the assertion
 * reads the accumulator through the consumption andon (a second card that must
 * not dispatch), never the journal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import { createHarnessRegistry, type HarnessAdapter, type HarnessRegistry } from '../worker/harness-adapter';
import { createClaudeHarnessAdapter } from '../worker/harness-adapter-claude';
import { createAgentSdkHarnessAdapter, type AgentSdkQueryFn } from '../worker/harness-adapter-agent-sdk';
import type { HarnessSpawnResult } from '../worker/harness-runner';

const STREAM = readFileSync(
  join(import.meta.dir, '..', '..', 'fixtures', 'harness', 'claude-background-subagent.ndjson'),
  'utf-8',
);
const MAX_TOKENS = 60_000;

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
  dir = mkdtempSync(join(tmpdir(), 'conduit-claude-usage-'));
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  if (db) db.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): ConduitDB {
  const opened = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(opened.getStateDb());
  return opened;
}

function writeFlow(registry: HarnessRegistry, harness: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: claude-usage
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${MAX_TOKENS} }
  per_card: { max_execution_attempts: 3 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: ${harness}
      model: haiku
      prompt_file: prompts/coder.md
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
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(id: string): void {
  db!.insertCard({
    run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
  });
}

async function runTwoCards(adapter: HarnessAdapter): Promise<string> {
  db = openDb();
  const registry = createHarnessRegistry([adapter]);
  const flow = writeFlow(registry, adapter.name);
  seedCard('entry');
  seedCard('entry2');
  const err: string[] = [];
  await runExecutor({
    db, flow, now: () => 1000, adapter: throwingModel,
    io: { out: () => {}, err: (l: string) => err.push(l) }, harnessRegistry: registry,
  } as RunEngineArgs);
  return err.join('\n');
}

function writeResult(): void {
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
}

/**
 * The first card's call succeeded and its spend tripped the token andon, so
 * the second card never dispatched. If the fold had used the last result's
 * `usage` (18,025 tokens), entry2 would have run too.
 */
function expectBudgetStoppedSecondCard(err: string, calls: number): void {
  expect(err).toMatch(/andon/i);
  expect(err).toMatch(/token/i);
  expect(calls).toBe(1);
  const spans = db!.getJournalSpansForRun(DEFAULT_RUN_ID, 'entry').filter((sp) => sp.name === 'coder.harness');
  expect(spans.map((sp) => sp.attributes.outcome)).toEqual(['success']);
  expect(db!.getJournalSpansForRun(DEFAULT_RUN_ID, 'entry2')).toEqual([]);
}

describe('issue #108: a two-result Claude stream folds its cumulative modelUsage into the run budget', () => {
  it('claude-headless: the session total trips a budget the last usage alone would not', async () => {
    let invocations = 0;
    const adapter = createClaudeHarnessAdapter({
      projectRoot: dir,
      envAllowlist: [],
      probe: async () => ({ present: true }),
      run: async (): Promise<HarnessSpawnResult> => {
        invocations += 1;
        writeResult();
        return { exitCode: 0, stdout: STREAM, stderr: '', durationMs: 10, timedOut: false, idledOut: false };
      },
    });

    const err = await runTwoCards(adapter);

    expectBudgetStoppedSecondCard(err, invocations);
  });

  it('agent-sdk: the session total trips a budget the last usage alone would not', async () => {
    let queries = 0;
    const messages = STREAM.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const query: AgentSdkQueryFn = () => {
      queries += 1;
      return {
        async *[Symbol.asyncIterator]() {
          writeResult();
          for (const m of messages) yield m as never;
        },
      };
    };
    const adapter = createAgentSdkHarnessAdapter({
      projectRoot: dir, envAllowlist: [], command: '/bin/sh', sourceEnv: {}, query,
      containment: { mechanism: 'process-group', reason: 'unit test' },
    });

    const err = await runTwoCards(adapter);

    expectBudgetStoppedSecondCard(err, queries);
  });
});
