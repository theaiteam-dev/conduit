/**
 * Tests for the no-progress rework guard (SPEC §6 guard #3, Must Fix #3).
 *
 * Guard: if the critic's findings hash matches the immediately-prior attempt's
 * gate_verdict findings hash → same defect, no progress → scrap immediately
 * with reason 'no_progress', even when reworkCount < reworkCap.
 *
 * Prior verdicts are read from the card_log (journal DB) via db.getCardLog(),
 * filtered to gate_verdict entries for the same station with attempt <
 * input.attempt. The entry with the highest attempt is the immediately-prior one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB  } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runGateRework, type GateReworkInput } from './gate-rework';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, cardId: string, reworkCount: number): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: cardId,
    parent_id: null,
    lane: 'ideate',
    status: 'working',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: reworkCount,
  });
}

/** Seed a prior gate_verdict entry at the given attempt for the given station. */
function seedPriorVerdict(
  db: ConduitDB,
  cardId: string,
  station: string,
  attempt: number,
  findings: string[],
): void {
  db.appendCardLog({
    runId: DEFAULT_RUN_ID,
    cardId,
    station,
    attempt,
    kind: 'gate_verdict',
    verdict: 'reject',
    findings,
    returnTo: station,
  });
}

const CRITIC_MODEL = 'gpt-4o';

/** A critic adapter that always returns a reject verdict with the given findings. */
function criticAdapter(findings: string[], returnTo = 'ideate'): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      return {
        text: JSON.stringify({ verdict: 'reject', findings, return_to: returnTo }),
        inputTokens: 8,
        outputTokens: 4,
        costUsd: 0.002,
      };
    },
  };
}

function makeGateConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-noprog-'));
  writeFileSync(join(dir, 'critic.md'), 'Judge the work.');
  return dir;
}

function buildInput(opts: {
  db: ConduitDB;
  cardId: string;
  dir: string;
  adapter: ModelAdapter;
  attempt: number;
  reworkCount: number;
  reworkCap?: number;
}): GateReworkInput {
  return {
    db: opts.db,
    runId: DEFAULT_RUN_ID,
    cardId: opts.cardId,
    workerStationId: 'ideate',
    attempt: opts.attempt,
    maxExecutionAttempts: 4,
    gateReworkCount: opts.reworkCount,
    gateConfig: {
      criticModel: CRITIC_MODEL,
      criticPromptFile: join(opts.dir, 'critic.md'),
      criticPromptVersion: '1',
      onReject: 'ideate',
      reworkCap: opts.reworkCap ?? 3,
      criticInputScope: [],
    },
    adapter: opts.adapter,
    projectRoot: opts.dir,
    validBackEdges: [{ from: 'ideate', to: 'ideate' }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runGateRework — no-progress guard (SPEC §6 guard #3)', () => {
  let dir: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    dir = makeGateConfigDir();
    db = openDb();
  });

  afterEach(() => {
    db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('scraps with reason no_progress when findings hash matches the immediately-prior verdict, even when reworkCount < reworkCap', async () => {
    const cardId = 'card-repeat';
    seedCard(db!, cardId, 1);
    // Prior verdict at attempt 0 has the same findings we are about to return.
    seedPriorVerdict(db!, cardId, 'ideate', 0, ['same defect']);

    const decision = await runGateRework(
      buildInput({
        db: db!,
        cardId,
        dir,
        adapter: criticAdapter(['same defect']),
        attempt: 1,   // current attempt; prior is at attempt 0
        reworkCount: 1,
        reworkCap: 3, // cap not yet reached
      }),
    );

    expect(decision.action).toBe('scrap');
    if (decision.action === 'scrap') {
      expect(decision.reason).toBe('no_progress');
      expect(decision.verdict).toBe('reject');
      expect(decision.findings).toEqual(['same defect']);
      expect(decision.returnTo).toBeNull();
    }
  });

  it('reworks (does not scrap) when findings differ from the prior attempt and reworkCount < reworkCap', async () => {
    const cardId = 'card-progress';
    seedCard(db!, cardId, 1);
    // Prior verdict had different findings.
    seedPriorVerdict(db!, cardId, 'ideate', 0, ['old defect']);

    const decision = await runGateRework(
      buildInput({
        db: db!,
        cardId,
        dir,
        adapter: criticAdapter(['new defect — different from old']),
        attempt: 1,
        reworkCount: 1,
        reworkCap: 3,
      }),
    );

    expect(decision.action).toBe('rework');
    if (decision.action === 'rework') {
      expect(decision.verdict).toBe('reject');
      expect(decision.findings).toEqual(['new defect — different from old']);
      expect(decision.returnTo).toBe('ideate');
    }
  });

  it('reworks on the first attempt (no prior verdict) — no_progress never fires without history', async () => {
    const cardId = 'card-first';
    seedCard(db!, cardId, 0);
    // No prior gate_verdict entries at all.

    const decision = await runGateRework(
      buildInput({
        db: db!,
        cardId,
        dir,
        adapter: criticAdapter(['some finding']),
        attempt: 0,
        reworkCount: 0,
        reworkCap: 3,
      }),
    );

    expect(decision.action).toBe('rework');
    if (decision.action === 'rework') {
      expect(decision.verdict).toBe('reject');
      expect(decision.findings).toEqual(['some finding']);
    }
  });

  it('treats findings in a different order as the same hash — still scraps with no_progress', async () => {
    const cardId = 'card-reorder';
    seedCard(db!, cardId, 1);
    // Prior verdict with findings in one order.
    seedPriorVerdict(db!, cardId, 'ideate', 0, ['beta', 'alpha', 'gamma']);

    // Current critic returns SAME findings in a DIFFERENT order.
    const decision = await runGateRework(
      buildInput({
        db: db!,
        cardId,
        dir,
        adapter: criticAdapter(['alpha', 'gamma', 'beta']),
        attempt: 1,
        reworkCount: 1,
        reworkCap: 3,
      }),
    );

    expect(decision.action).toBe('scrap');
    if (decision.action === 'scrap') {
      expect(decision.reason).toBe('no_progress');
    }
  });

  it('rework_cap still fires when findings keep changing but count reaches the cap', async () => {
    const cardId = 'card-cap';
    seedCard(db!, cardId, 3);
    // Prior verdict with a different finding — so no_progress does NOT fire first.
    seedPriorVerdict(db!, cardId, 'ideate', 2, ['prior finding']);

    // Current findings differ from prior, so no_progress won't trigger.
    // reworkCount (3) >= reworkCap (3) → rework_cap fires.
    const decision = await runGateRework(
      buildInput({
        db: db!,
        cardId,
        dir,
        adapter: criticAdapter(['entirely new finding']),
        attempt: 3,
        reworkCount: 3,
        reworkCap: 3,
      }),
    );

    expect(decision.action).toBe('scrap');
    if (decision.action === 'scrap') {
      expect(decision.reason).toBe('rework_cap');
    }
  });
});
