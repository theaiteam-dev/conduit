/**
 * Gate critic sees the child's card-scoped inputs (issue #112).
 *
 * A QC gate on a child_entry station judges THAT child's work — so its critic
 * needs the same shard the maker read. Before this item, runGateRework called
 * renderPrompt with no card scope at all, so a critic whose criticInputScope
 * referenced a card-scoped input (the per-child `patch.txt`, or even the
 * long-reserved `seed.json`) THREW at render, and the executor escalated the
 * card to hold. That is the regression a naive input_scope implementation ships
 * with: the maker path works, the critic path fails on the same flow.
 *
 * `ownedPaths` + `ownedDirInputs` are REQUIRED on GateReworkInput /
 * HarnessGateConfig rather than optional-with-default, mirroring the issue #110
 * `runId` seam: a critic that silently renders the project-root artifact instead
 * of the child's shard is exactly the mis-attribution the required field
 * prevents, so an omitted scope is a compile error, not a wrong judgment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { HarnessAdapter, HarnessResult, MountedInput } from '../worker/harness-adapter';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runGateRework, type GateReworkInput } from './gate-rework';

const CRITIC_MODEL = 'gpt-4o';

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, cardId: string, ownedPaths: string[]): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: cardId,
    parent_id: null,
    lane: 'review_shard',
    status: 'working',
    attempt: 0,
    wave: 0,
    owned_paths: ownedPaths,
    rework_count: 0,
  });
}

/** A critic adapter that records the prompt it was handed and always passes. */
function recordingCriticAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return {
    calls,
    adapter: {
      async call(req: ModelCall): Promise<ModelResponse> {
        calls.push(req);
        return {
          text: JSON.stringify({ verdict: 'pass', findings: [] }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      },
    },
  };
}

/** A harness critic that records its mounted inputs and writes a passing verdict. */
function recordingHarnessCritic(projectRoot: string): {
  adapter: HarnessAdapter;
  mounts: MountedInput[][];
} {
  const mounts: MountedInput[][] = [];
  return {
    mounts,
    adapter: {
      name: 'fake-critic',
      reportsUsage: false,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke(call): Promise<HarnessResult> {
        mounts.push([...call.inputs]);
        writeFileSync(
          join(projectRoot, 'verdict.json'),
          JSON.stringify({ verdict: 'pass', findings: [] }),
          'utf-8',
        );
        return { outputs: [], usage: { unknown: true } };
      },
    },
  };
}

let projectRoot: string;
let ownedDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'conduit-gate-input-scope-'));
  // The whole-diff decoy every sibling would otherwise share.
  writeFileSync(join(projectRoot, 'patch.txt'), 'DECOY_WHOLE_DIFF', 'utf-8');
  writeFileSync(join(projectRoot, 'style-guide.md'), 'HOUSE_STYLE', 'utf-8');
  ownedDir = join(projectRoot, 'child-a');
  mkdirSync(ownedDir, { recursive: true });
  writeFileSync(join(ownedDir, 'patch.txt'), 'MY_SHARD', 'utf-8');
  writeFileSync(join(ownedDir, 'seed.json'), '{"shard":1}', 'utf-8');
  db = openDb();
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Build a GateReworkInput for a critic whose template is written to critic.md. */
function buildInput(opts: {
  adapter: ModelAdapter;
  criticTemplate: string;
  criticInputScope: string[];
  ownedPaths: string[];
  ownedDirInputs: string[];
  criticHarness?: string;
  harnessRegistry?: GateReworkInput['harnessRegistry'];
}): GateReworkInput {
  writeFileSync(join(projectRoot, 'critic.md'), opts.criticTemplate, 'utf-8');
  return {
    db: db!,
    runId: DEFAULT_RUN_ID,
    cardId: 'card-a',
    workerStationId: 'review_shard',
    attempt: 0,
    maxExecutionAttempts: 4,
    reworkCount: 0,
    gateConfig: {
      criticModel: CRITIC_MODEL,
      criticPromptFile: join(projectRoot, 'critic.md'),
      criticPromptVersion: '1',
      onReject: 'review_shard',
      reworkCap: 3,
      criticInputScope: opts.criticInputScope,
      ...(opts.criticHarness !== undefined
        ? { criticHarness: opts.criticHarness, criticTools: ['Read'] }
        : {}),
    },
    adapter: opts.adapter,
    harnessRegistry: opts.harnessRegistry,
    projectRoot,
    ownedPaths: opts.ownedPaths,
    ownedDirInputs: opts.ownedDirInputs,
    validBackEdges: [{ from: 'review_shard', to: 'review_shard' }],
  };
}

describe('runGateRework — critic renders card-scoped inputs (issue #112)', () => {
  it('RENDERS a critic that references a card-scoped input (the naive-implementation regression)', async () => {
    seedCard(db!, 'card-a', [ownedDir]);
    const { adapter, calls } = recordingCriticAdapter();

    // Without the card scope threaded through, renderPrompt throws here and the
    // executor escalates the card to hold.
    const decision = await runGateRework(
      buildInput({
        adapter,
        criticTemplate: 'Judge this shard:\n{{patch.txt}}',
        criticInputScope: ['patch.txt'],
        ownedPaths: [ownedDir],
        ownedDirInputs: ['patch.txt'],
      }),
    );

    expect(decision.action).toBe('pass');
    expect(calls.length).toBe(1);
    // The critic judged the CHILD's shard, not the project-root whole diff.
    expect(calls[0]!.prompt).toBe('Judge this shard:\nMY_SHARD');
  });

  it('renders the reserved seed.json for a critic on a child-entry station', async () => {
    // seed.json has been card-scoped since WI-468, yet the critic path passed no
    // ownedPaths at all — so a seed-referencing critic threw even before #112.
    seedCard(db!, 'card-a', [ownedDir]);
    const { adapter, calls } = recordingCriticAdapter();

    const decision = await runGateRework(
      buildInput({
        adapter,
        criticTemplate: 'Seed: {{seed.json}}',
        criticInputScope: ['seed.json'],
        ownedPaths: [ownedDir],
        ownedDirInputs: [],
      }),
    );

    expect(decision.action).toBe('pass');
    expect(calls[0]!.prompt).toBe('Seed: {"shard":1}');
  });

  it('leaves an unlisted critic input resolving from projectRoot', async () => {
    seedCard(db!, 'card-a', [ownedDir]);
    const { adapter, calls } = recordingCriticAdapter();

    const decision = await runGateRework(
      buildInput({
        adapter,
        criticTemplate: 'Guide: {{style-guide.md}} Patch: {{patch.txt}}',
        criticInputScope: ['style-guide.md', 'patch.txt'],
        ownedPaths: [ownedDir],
        ownedDirInputs: ['patch.txt'],
      }),
    );

    expect(decision.action).toBe('pass');
    expect(calls[0]!.prompt).toBe('Guide: HOUSE_STYLE Patch: MY_SHARD');
  });

  it('mounts a card-scoped input from the owned dir for a HARNESS critic', async () => {
    seedCard(db!, 'card-a', [ownedDir]);
    const { adapter: modelAdapter } = recordingCriticAdapter();
    const { adapter: harness, mounts } = recordingHarnessCritic(projectRoot);

    const decision = await runGateRework(
      buildInput({
        adapter: modelAdapter,
        criticTemplate: 'Judge: {{patch.txt}}',
        criticInputScope: ['style-guide.md', 'patch.txt'],
        ownedPaths: [ownedDir],
        ownedDirInputs: ['patch.txt'],
        criticHarness: 'fake-critic',
        harnessRegistry: {
          resolve: () => ({ ok: true, adapter: harness }),
          list: () => ['fake-critic'],
        },
      }),
    );

    expect(decision.action).toBe('pass');
    expect(mounts.length).toBe(1);
    const byName = new Map(mounts[0]!.map((m) => [m.name, m.path]));
    // The card-scoped input mounts from the owned dir; the unlisted one does not.
    expect(byName.get('patch.txt')).toBe(join(ownedDir, 'patch.txt'));
    expect(byName.get('style-guide.md')).toBe(join(projectRoot, 'style-guide.md'));
  });
});
