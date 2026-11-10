/**
 * Transform MARK_DONE integrity gate with absolute touched paths (issue #98).
 *
 * executeTransformStation hands runOwnedPathsIntegrity the ABSOLUTE paths
 * resolveDeclaredOutputs wrote (it used to hand it project-root-relative
 * names). These tests pin, through the real loader and runExecutor, that the
 * integrity check resolves those absolute entries in place rather than
 * re-joining them under projectRoot:
 *
 *   - output_scope: owned_dir + enforce_owned_paths: the write lands inside
 *     owned_paths[0], the card advances (no false violation).
 *   - project_root scope + owned_paths elsewhere: the write lands outside
 *     owned_paths and the card holds (no false pass).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const MODEL = 'gpt-4o-mini';
const STATION = 'draft';

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-transform-scope-integrity-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

function buildFlow(scope: 'owned_dir' | null): FlowConfig {
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  writeFileSync(join(projectDir, 'prompts', 'draft.md'), 'Draft something.');
  writeFileSync(
    join(projectDir, 'flow.yaml'),
    `
flow: transform-scope-integrity
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold, enforce_owned_paths: true }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ${STATION}
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/draft.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: ok, type: boolean, required: true }
    outputs: [draft.json]
${scope !== null ? `    output_scope: ${scope}\n` : ''}    next: done
`,
  );
  const loaded = loadFlow(join(projectDir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function adapter(): ModelAdapter {
  return {
    async call(_c: ModelCall): Promise<ModelResponse> {
      return { text: JSON.stringify({ ok: true }), inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
    },
  } as ModelAdapter;
}

async function runCard(flow: FlowConfig, ownedPaths: string[]): Promise<string[]> {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'c1', parent_id: null, lane: STATION, status: 'ready',
    attempt: 0, wave: 0, owned_paths: ownedPaths, rework_count: 0,
  });
  const errLines: string[] = [];
  const io = { out: () => {}, err: (line: string) => { errLines.push(line); } };
  await runExecutor({ db, flow, now: () => 1000, adapter: adapter(), io } as RunEngineArgs);
  return errLines;
}

describe('transform integrity gate with absolute touched paths (issue #98)', () => {
  it('output_scope: owned_dir under enforce_owned_paths advances the card and writes inside the owned dir', async () => {
    const flow = buildFlow('owned_dir');
    mkdirSync(join(projectDir, 'cards', 'c1'), { recursive: true });

    await runCard(flow, ['cards/c1']);

    const c = db!.getCard(DEFAULT_RUN_ID, 'c1')!;
    expect(c.lane).toBe('done');
    expect(c.status).not.toBe('held');
    expect(existsSync(join(projectDir, 'cards', 'c1', 'draft.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'draft.json'))).toBe(false);
  });

  it('project_root scope with owned_paths elsewhere holds the card on an out-of-bounds write', async () => {
    const flow = buildFlow(null);
    mkdirSync(join(projectDir, 'cards', 'c1'), { recursive: true });

    const errLines = await runCard(flow, ['cards/c1']);

    const c = db!.getCard(DEFAULT_RUN_ID, 'c1')!;
    expect(c.lane).not.toBe('done');
    expect(c.status).toBe('held');
    // The hold comes from the integrity gate, naming the absolute output path.
    const hold = errLines.find((l) => l.includes('integrity violation (owned_paths)'));
    expect(hold).toBeDefined();
    expect(hold).toContain(`path_escape:${join(projectDir, 'draft.json')}`);
  });
});
