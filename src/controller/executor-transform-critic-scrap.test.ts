/**
 * Issue #42 AC4: the named reason a transform gate critic scraps under is the
 * reason the card log records for the scrap, through the real runExecutor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'maker-model';
const CRITIC_MODEL = 'critic-model';

function adapterWithCriticText(criticText: string, criticFinish?: string): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      if (req.model === CRITIC_MODEL) {
        return { text: criticText, inputTokens: 8, outputTokens: 4, costUsd: 0, ...(criticFinish ? { finishReason: criticFinish } : {}) };
      }
      return { text: JSON.stringify({ idea: 'an idea' }), inputTokens: 12, outputTokens: 6, costUsd: 0 };
    },
  };
}

function setupFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: transform-critic-scrap
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, model: ${CRITIC_MODEL}, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: ideate
      rework_cap: 2
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-critic-scrap-'));
  process.chdir(projectDir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

async function runWithCritic(criticText: string, criticFinish?: string): Promise<string[]> {
  const flow = setupFlow(projectDir);
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'ideate',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['context.json', 'idea.json'],
    rework_count: 0,
  });
  const io = { out: () => {}, err: () => {} };
  await runExecutor({
    db, flow, projectRoot: projectDir, now: () => 1000, adapter: adapterWithCriticText(criticText, criticFinish), io,
  } as unknown as RunEngineArgs);
  expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('scrap');
  return db
    .getCardLog('entry')
    .flatMap((e) => (e.kind === 'terminal' ? [e.reason] : []));
}

describe('runExecutor: a transform critic scrap records its named reason (issue #42)', () => {
  it('records critic-verdict-invalid with the validator error for {"accept": true}', async () => {
    const reasons = await runWithCritic('{"accept":true}');

    expect(reasons).toEqual(['critic-verdict-invalid: verdict must be "pass" or "reject"']);
  });

  it('records critic-output-truncated for a critic that ran out of max_tokens', async () => {
    const reasons = await runWithCritic('{"verdict":"pa', 'length');

    expect(reasons).toEqual(['critic-output-truncated']);
  });
});
