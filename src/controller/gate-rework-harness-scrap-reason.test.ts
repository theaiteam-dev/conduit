/**
 * a pre-public engine review consumer smoke-test review (@queso, finding 1): runGateRework's
 * 'scrapped' branch used to hardcode reason: 'model-incompatible' regardless
 * of what the underlying gate check actually reported — so even after
 * gate.ts (runHarnessGateCheck) started naming its failure classes distinctly
 * (harness-critic-invoke-failed / verdict-missing / verdict-unparseable /
 * verdict-invalid / reject-without-findings), this module discarded that
 * classification on the way to the card_log's terminal reason. This file
 * pins that runGateRework now PROPAGATES the gate check's own reason instead
 * of collapsing it.
 *
 * Companion to gate-rework-no-progress.test.ts (same module, different guard).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessResult,
} from '../worker/harness-adapter';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runGateRework, type GateReworkInput } from './gate-rework';

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, cardId: string): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: cardId,
    parent_id: null,
    lane: 'ideate',
    status: 'working',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

function harnessAdapter(
  onInvoke: (call: HarnessInvocation) => Promise<HarnessResult> | HarnessResult,
): HarnessAdapter {
  return {
    name: 'fake-critic',
    reportsUsage: false,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call) {
      return onInvoke(call);
    },
  };
}

// Never called — this suite exercises the harness-critic branch exclusively.
const UNUSED_MODEL_ADAPTER: ModelAdapter = {
  async call() {
    throw new Error('model adapter must not be called for a harness critic');
  },
};

describe('runGateRework — propagates the gate check\'s own scrap reason (a pre-public engine review, @queso finding 1)', () => {
  let dir: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-gate-rework-scrap-'));
    writeFileSync(join(dir, 'critic.md'), 'Judge the work.');
    db = openDb();
  });

  afterEach(() => {
    db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function buildInput(critic: HarnessAdapter): GateReworkInput {
    return {
      db: db!,
      runId: DEFAULT_RUN_ID,
      cardId: 'card-1',
      workerStationId: 'ideate',
      attempt: 0,
      maxExecutionAttempts: 4,
      gateReworkCount: 0,
      gateConfig: {
        criticModel: 'unused',
        criticPromptFile: join(dir, 'critic.md'),
        criticPromptVersion: '1',
        onReject: 'ideate',
        reworkCap: 3,
        criticInputScope: [],
        criticHarness: 'fake-critic',
        criticTools: ['Read'],
      },
      adapter: UNUSED_MODEL_ADAPTER,
      harnessRegistry: createHarnessRegistry([critic]),
      projectRoot: dir,
      validBackEdges: [{ from: 'ideate', to: 'ideate' }],
    };
  }

  it('propagates harness-critic-invoke-failed — never the hardcoded model-incompatible label', async () => {
    seedCard(db!, 'card-1');
    const critic = harnessAdapter(() => {
      throw new Error('agent CLI crashed');
    });

    const decision = await runGateRework(buildInput(critic));

    expect(decision.action).toBe('scrap');
    if (decision.action === 'scrap') {
      expect(decision.reason).toMatch(/^harness-critic-invoke-failed:/);
      expect(decision.reason).not.toBe('model-incompatible');
    }
  });

  it('propagates harness-critic-verdict-missing when the critic never writes a verdict', async () => {
    seedCard(db!, 'card-1');
    const critic = harnessAdapter(() => ({ outputs: [], usage: { unknown: true } }));

    const decision = await runGateRework(buildInput(critic));

    expect(decision.action).toBe('scrap');
    if (decision.action === 'scrap') {
      expect(decision.reason).toMatch(/^harness-critic-verdict-missing:/);
    }
  });

  it('propagates harness-critic-reject-without-findings for a findings-less reject verdict', async () => {
    seedCard(db!, 'card-1');
    const critic = harnessAdapter(() => {
      writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ verdict: 'reject', findings: [] }), 'utf-8');
      return { outputs: [], usage: { unknown: true } };
    });

    const decision = await runGateRework(buildInput(critic));

    expect(decision.action).toBe('scrap');
    if (decision.action === 'scrap') {
      expect(decision.reason).toMatch(/^harness-critic-reject-without-findings:/);
    }
  });
});
