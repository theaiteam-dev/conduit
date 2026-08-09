/**
 * Harness maker mounts card-scoped inputs from the owned dir (issue #112).
 *
 * A harness station does not inline its declared inputs into the prompt — it
 * MOUNTS them (name + path) so the agent CLI can open them itself. Those mount
 * paths were built with a hard-coded `join(projectRoot, name)`, so a card-scoped
 * input would be QUOTED in the prompt from the child's owned dir while the very
 * same name MOUNTED to the shared project-root file — two different files under
 * one name, in one invocation. This drives the real executor with a recording
 * harness adapter to pin that both sides now agree.
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
  type HarnessResult,
  type HarnessRegistry,
} from '../worker/harness-adapter';

const SECONDS = (n: number) => () => n;

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function makeIO(): { io: { out: (l: string) => void; err: (l: string) => void } } {
  return { io: { out: () => {}, err: () => {} } };
}

/** A ModelAdapter that MUST NOT be called — a harness maker never touches it. */
function makeThrowingModel(): ModelAdapter {
  return {
    async call() {
      throw new Error('ModelAdapter.call must not be used by a harness maker');
    },
  };
}

/** Records each invocation and writes the declared output, like a real harness. */
function makeRecordingHarness(): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'fake-harness',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      calls.push(call);
      const abs = join(process.cwd(), 'result.json');
      writeFileSync(abs, JSON.stringify({ summary: 'reviewed the shard' }), 'utf-8');
      return { outputs: [{ name: 'result.json', path: abs }], usage: { tokens: 120, cost: 0.02 } };
    },
  };
  return { adapter, calls };
}

/**
 * A harness reviewer whose per-child shard (`patch.txt`) is card-scoped and
 * whose house style (`style-guide.md`) stays at project root.
 */
function writeShardHarnessFlow(
  dir: string,
  registry: HarnessRegistry,
  opts: { promptBody?: string } = {},
): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  // Default template QUOTES the shard. A caller can pass a body that references
  // no artifact — the mount-only shape a harness station is free to use, and the
  // one render's fail-closed guard cannot see.
  writeFileSync(join(dir, 'prompts', 'review.md'), opts.promptBody ?? 'Review: {{patch.txt}}');
  writeFileSync(join(dir, 'patch.txt'), 'DECOY_WHOLE_DIFF');
  writeFileSync(join(dir, 'style-guide.md'), 'HOUSE_STYLE');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: harness-input-scope
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: review_shard
    worker:
      kind: harness
      harness: fake-harness
      model: sonnet
      prompt_file: prompts/review.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [patch.txt, style-guide.md]
    input_scope:
      owned_dir: [patch.txt]
    outputs: [result.json]
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-harness-input-scope-'));
  process.chdir(projectDir);
  db = openDb();
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe('harness maker — card-scoped input mounts (issue #112)', () => {
  it('mounts a card-scoped input from the owned dir and an unlisted one from projectRoot', async () => {
    const { adapter: harness, calls } = makeRecordingHarness();
    const registry = createHarnessRegistry([harness]);
    const flow = writeShardHarnessFlow(projectDir, registry);

    const ownedDir = join(projectDir, 'child-a');
    mkdirSync(ownedDir, { recursive: true });
    writeFileSync(join(ownedDir, 'patch.txt'), 'MY_SHARD', 'utf-8');

    db!.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'entry',
      parent_id: null,
      lane: 'review_shard',
      status: 'ready',
      attempt: 0,
      wave: 0,
      // owned_paths[0] is the child dir (the card scope); 'result.json' is owned
      // as well so the harness's own declared write clears the integrity gate.
      owned_paths: [ownedDir, 'result.json'],
      rework_count: 0,
    });

    await runExecutor({
      db: db!, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io: makeIO().io,
      harnessRegistry: registry,
    } as RunEngineArgs);

    expect(db!.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(calls.length).toBe(1);

    const byName = new Map(calls[0]!.inputs.map((m) => [m.name, m.path]));
    expect(byName.get('patch.txt')).toBe(join(ownedDir, 'patch.txt'));
    expect(byName.get('style-guide.md')).toBe(join(projectDir, 'style-guide.md'));
  });

  it('mounts the same file the prompt quotes (mount and render agree)', async () => {
    // The failure this rules out: prompt renders MY_SHARD from the owned dir
    // while the mount points at the project-root decoy of the same name.
    const { adapter: harness, calls } = makeRecordingHarness();
    const registry = createHarnessRegistry([harness]);
    const flow = writeShardHarnessFlow(projectDir, registry);

    const ownedDir = join(projectDir, 'child-a');
    mkdirSync(ownedDir, { recursive: true });
    writeFileSync(join(ownedDir, 'patch.txt'), 'MY_SHARD', 'utf-8');

    db!.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'entry',
      parent_id: null,
      lane: 'review_shard',
      status: 'ready',
      attempt: 0,
      wave: 0,
      // owned_paths[0] is the child dir (the card scope); 'result.json' is owned
      // as well so the harness's own declared write clears the integrity gate.
      owned_paths: [ownedDir, 'result.json'],
      rework_count: 0,
    });

    await runExecutor({
      db: db!, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io: makeIO().io,
      harnessRegistry: registry,
    } as RunEngineArgs);

    expect(calls[0]!.prompt).toBe('Review: MY_SHARD');
    const mounted = calls[0]!.inputs.find((m) => m.name === 'patch.txt')!.path;
    expect(mounted).toBe(join(ownedDir, 'patch.txt'));
    expect(mounted).not.toBe(join(projectDir, 'patch.txt'));
  });

  it('FAILS CLOSED on a card with no owned dir instead of mounting the project-root decoy', async () => {
    // PR #114 review finding. renderPrompt's fail-closed guard only fires for
    // names the TEMPLATE references — and a harness station does not have to
    // reference what it mounts. This prompt names no artifact at all, so render
    // passes cleanly and the mount was the only thing standing between an
    // unscoped card and DECOY_WHOLE_DIFF being handed over under the name of a
    // shard. resolveInputPath now throws for every caller, not just render.
    const { adapter: harness, calls } = makeRecordingHarness();
    const registry = createHarnessRegistry([harness]);
    const flow = writeShardHarnessFlow(projectDir, registry, { promptBody: 'Review the mounted shard.' });

    db!.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'entry',
      parent_id: null,
      lane: 'review_shard',
      status: 'ready',
      attempt: 0,
      wave: 0,
      // No owned dir — the card has no per-child copy of patch.txt to read.
      owned_paths: [],
      rework_count: 0,
    });

    await expect(
      runExecutor({
        db: db!, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io: makeIO().io,
        harnessRegistry: registry,
      } as RunEngineArgs),
    ).rejects.toThrow(/Card-scoped input "patch\.txt" cannot be resolved/);

    // The agent was never handed the shared artifact under the card-scoped
    // name — the whole point of the fix.
    expect(calls.length).toBe(0);
    expect(db!.getCard(DEFAULT_RUN_ID, 'entry')?.lane).not.toBe('done');
  });

  it('fails the same way whether the unresolvable scope is caught by render or by the mount', async () => {
    // Shape check: the mount's new throw is not a novel failure mode. The
    // template-quoting variant of the very same flow already fail-closed out of
    // runExecutor via render's guard, so both halves of the fix escalate
    // identically — what changed is only that the mount-only shape stopped
    // silently succeeding.
    const { adapter: harness, calls } = makeRecordingHarness();
    const registry = createHarnessRegistry([harness]);
    const flow = writeShardHarnessFlow(projectDir, registry); // default: quotes {{patch.txt}}

    db!.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'entry',
      parent_id: null,
      lane: 'review_shard',
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });

    await expect(
      runExecutor({
        db: db!, flow, now: SECONDS(1000), adapter: makeThrowingModel(), io: makeIO().io,
        harnessRegistry: registry,
      } as RunEngineArgs),
    ).rejects.toThrow(/no owned_paths scope was supplied for this card/);

    expect(calls.length).toBe(0);
  });
});
