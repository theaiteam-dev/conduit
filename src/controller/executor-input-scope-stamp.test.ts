/**
 * Executor binding-stamp wiring for declared card-scoped inputs (issue #51).
 *
 * `input_scope.owned_dir` lets a fan-out child READ its own copy of a declared
 * input from `<owned_paths[0]>/<name>`. The binding stamp (SPEC §5 skip-on-resume)
 * must hash those inputs from the SAME card-scoped location renderPrompt reads
 * them from — the WI-468 BUG-1 lesson, generalized. Otherwise:
 *
 *   - sibling children reviewing different shards would get IDENTICAL stamps, and
 *   - a child whose shard changes between runs would skip-replay the stale
 *     checkpoint, serving a review of the OLD diff as if it were current.
 *
 * These tests drive the REAL executor (in-memory DB, stub adapter, loader-built
 * flow) and are deliberately behavioral: they never recompute a stamp by hand.
 * They observe the consequence of a correct stamp — whether the adapter is
 * re-invoked when the per-child file changes, and whether two siblings both
 * execute rather than one skip-replaying the other's checkpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';

/** Stub adapter: records every call so we can observe re-execution vs skip-replay. */
function makeStubAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return {
        text: JSON.stringify({ idea: 'an idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? [],
    rework_count: over.rework_count ?? 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function loadOk(dir: string): FlowConfig {
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

const SECONDS = (n: number) => () => n;

/**
 * A child_entry station whose per-child shard (`patch.txt`) is card-scoped via
 * input_scope, alongside a project-root input (`style-guide.md`) that is not.
 *
 * `template` selects which inputs the prompt actually REFERENCES — the stamp
 * hashes every DECLARED input regardless, which is what the missing-input test
 * below exercises.
 */
function setupShardStationFlow(dir: string, template = 'Review: {{patch.txt}}'): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'child.md'), template);
  writeFileSync(join(dir, 'style-guide.md'), 'HOUSE_STYLE');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: input-scope-stamp
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: child_entry
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/child.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [patch.txt, style-guide.md]
    input_scope:
      owned_dir: [patch.txt]
    outputs: [out.json]
    next: done
`,
  );
  return loadOk(dir);
}

/** Make an owned dir for a child and write its shard. Returns the absolute dir. */
function makeOwnedDir(parent: string, name: string, files: Record<string, string> = {}): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(dir, file), contents, 'utf-8');
  }
  return dir;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-input-scope-stamp-'));
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

describe('binding stamp — declared card-scoped inputs (issue #51)', () => {
  it('re-executes (does NOT skip-replay) when the child card-scoped input changes between runs', async () => {
    // A correct stamp hashes patch.txt from the card's owned dir. When the shard
    // changes, the recomputed stamp differs from the checkpointed one, so the
    // station re-runs. Hashing projectRoot/patch.txt instead → ENOENT → '' → a
    // stamp blind to the shard, and the second run skip-replays a stale review.
    const flow = setupShardStationFlow(projectDir);
    db = openDb();
    const stateDb = db.getStateDb();

    const ownedDir = makeOwnedDir(projectDir, 'child-c', { 'patch.txt': 'DIFF-V1' });
    seedCard(db, { id: 'c', lane: 'child_entry', owned_paths: [ownedDir] });

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(calls.length).toBe(1);

    // The child's shard changes on disk (the parent re-sharded the diff).
    writeFileSync(join(ownedDir, 'patch.txt'), 'DIFF-V2', 'utf-8');

    stateDb.prepare("UPDATE cards SET lane = 'child_entry', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    // Re-executed: a second model call, rendering the NEW shard.
    expect(calls.length).toBe(2);
    expect(calls[1]!.prompt).toBe('Review: DIFF-V2');
  });

  it('two sibling children with different shards both execute (distinct stamps)', async () => {
    const flow = setupShardStationFlow(projectDir);
    db = openDb();

    const dirA = makeOwnedDir(projectDir, 'child-a', { 'patch.txt': 'DIFF-A' });
    const dirB = makeOwnedDir(projectDir, 'child-b', { 'patch.txt': 'DIFF-B' });
    seedCard(db, { id: 'a', lane: 'child_entry', owned_paths: [dirA] });
    seedCard(db, { id: 'b', lane: 'child_entry', owned_paths: [dirB] });

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'a')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'b')?.lane).toBe('done');
    // Both executed — neither reused the other's checkpoint.
    expect(calls.length).toBe(2);
    // Each rendered its OWN shard (per-child resolution, not a shared input).
    const prompts = calls.map((c) => c.prompt).sort();
    expect(prompts).toEqual(['Review: DIFF-A', 'Review: DIFF-B']);
  });

  it('a MISSING card-scoped input hashes as \'\' in the stamp without throwing', async () => {
    // The stamp hashes every DECLARED input; render reads only REFERENCED ones.
    // Here patch.txt is declared + card-scoped but never referenced, and absent
    // from the owned dir. The stamp's read must swallow the error and hash '' —
    // the station still runs. (Render's fail-closed throw applies only to an
    // input the template actually references; see render-input-scope.test.ts.)
    const flow = setupShardStationFlow(projectDir, 'Guide: {{style-guide.md}}');
    db = openDb();

    const ownedDirNoShard = makeOwnedDir(projectDir, 'child-c'); // no patch.txt
    seedCard(db, { id: 'c', lane: 'child_entry', owned_paths: [ownedDirNoShard] });

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toBe('Guide: HOUSE_STYLE');
  });

  it('a project-root input is still hashed from projectRoot (unlisted names unaffected)', async () => {
    // Changing the shared style-guide.md must also invalidate — proving the
    // card-scoped carve-out did not swallow the project-root path.
    const flow = setupShardStationFlow(projectDir, 'Guide: {{style-guide.md}} Patch: {{patch.txt}}');
    db = openDb();
    const stateDb = db.getStateDb();

    const ownedDir = makeOwnedDir(projectDir, 'child-c', { 'patch.txt': 'DIFF-V1' });
    seedCard(db, { id: 'c', lane: 'child_entry', owned_paths: [ownedDir] });

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toBe('Guide: HOUSE_STYLE Patch: DIFF-V1');

    writeFileSync(join(projectDir, 'style-guide.md'), 'NEW_HOUSE_STYLE', 'utf-8');
    stateDb.prepare("UPDATE cards SET lane = 'child_entry', status = 'ready' WHERE id = 'c'").run();
    await runExecutor({ db, flow, now: SECONDS(2000), adapter, io } as RunEngineArgs);

    expect(calls.length).toBe(2);
    expect(calls[1]!.prompt).toBe('Guide: NEW_HOUSE_STYLE Patch: DIFF-V1');
  });
});
