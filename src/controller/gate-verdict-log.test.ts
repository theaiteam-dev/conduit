/**
 * Tests for gate_verdict card_log entries on every gate check (WI-382).
 *
 * WI-382 has two halves:
 *
 *  1. Widen GateReworkDecision (src/controller/gate-rework.ts) so ALL three
 *     branches carry the critic's verdict, findings, returnTo, and attempt — the
 *     findings are no longer discarded inside gate-rework:
 *       pass   → { action:'pass',   verdict:'pass',   findings:[],          returnTo:null,   attempt }
 *       rework → { action:'rework', verdict:'reject', findings:[…],         returnTo:<lane>, attempt }
 *       scrap  → { action:'scrap',  verdict:'reject', findings:[…], reason, returnTo:null,   attempt }
 *
 *  2. The executor's gate block appends a gate_verdict card_log entry for every
 *     gate check — verdict, findings, returnTo, attempt — BEFORE the state-db
 *     commit that applies the decision, idempotent on (card_id, station, attempt,
 *     kind='gate_verdict') (same append-before-commit strategy as WI-381).
 *
 * Level 1 (unit) drives runGateRework directly and asserts the widened decision.
 * Level 2 (integration) drives the REAL runExecutor and reads gate_verdict
 * entries via the WI-378 accessor.
 *
 * The card_log API and the widened decision are declared locally so this file
 * typechecks while WI-378/WI-382 land; at runtime the new fields are absent until
 * implemented, so these assertions are RED for the right reason.
 *
 * NOTE on idempotency-key collisions: card.attempt stays 0 across reworks (only
 * rework_count increments), so multiple gate checks at the same station share the
 * (card,station,attempt,'gate_verdict') key — the first survives, later ones
 * dedup. These tests assert on the SURVIVING entry and never depend on a collided
 * one (mirrors WI-381).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card, StationGateConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, type StoredCardLogEntry, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';
import { runGateRework } from './gate-rework';

// ---------------------------------------------------------------------------
// Locally-declared contract: the WI-382 WIDENED GateReworkDecision. The
// card_log types (StoredCardLogEntry) are the REAL WI-378 exports, imported
// above. GateReworkDecision is still narrow until WI-382 lands, so the widened
// view is declared here and the returned decision is cast to it.
// ---------------------------------------------------------------------------

interface WidenedGateDecision {
  action: 'pass' | 'rework' | 'scrap';
  verdict: 'pass' | 'reject';
  findings: string[];
  returnTo: string | null;
  attempt: number;
  reason?: string;
}

type GateVerdictEntry = Extract<StoredCardLogEntry, { kind: 'gate_verdict' }>;

function cardLog(db: ConduitDB, cardId: string): StoredCardLogEntry[] {
  return db.getCardLog(cardId);
}
function gateVerdicts(db: ConduitDB, cardId: string): GateVerdictEntry[] {
  return cardLog(db, cardId).filter((e): e is GateVerdictEntry => e.kind === 'gate_verdict');
}

// ---------------------------------------------------------------------------
// Adapters.
// ---------------------------------------------------------------------------

const WORKER_MODEL = 'gpt-4o-mini';
const CRITIC_MODEL = 'gpt-4o';

/** A critic-only adapter returning one fixed verdict (for runGateRework unit tests). */
function criticAdapter(verdict: 'pass' | 'reject', findings: string[], returnTo?: string): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      return {
        text: JSON.stringify({ verdict, findings, ...(returnTo ? { return_to: returnTo } : {}) }),
        inputTokens: 8,
        outputTokens: 4,
        costUsd: 0.002,
      };
    },
  };
}

/** Worker + gate adapter for the executor integration tests. */
function makeStubAdapter(opts: { gateRejectsBeforePass?: number } = {}): { adapter: ModelAdapter } {
  let gateRejectsLeft = opts.gateRejectsBeforePass ?? 0;
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      if (req.model === CRITIC_MODEL) {
        if (gateRejectsLeft > 0) {
          gateRejectsLeft--;
          return {
            text: JSON.stringify({ verdict: 'reject', findings: ['needs work'], return_to: 'ideate' }),
            inputTokens: 8,
            outputTokens: 4,
            costUsd: 0.002,
          };
        }
        return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 8, outputTokens: 4, costUsd: 0.002 };
      }
      return { text: JSON.stringify({ idea: 'a shoppable widget idea' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void } } {
  return { io: { out: () => {}, err: () => {} } };
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function gateConfigFor(dir: string, reworkCap = 2): StationGateConfig {
  // A critic prompt with no {{placeholders}} → renderPrompt returns it verbatim,
  // no artifact disk reads needed.
  writeFileSync(join(dir, 'critic.md'), 'Judge the work.');
  return {
    criticModel: CRITIC_MODEL,
    criticPromptFile: join(dir, 'critic.md'),
    criticPromptVersion: '1',
    onReject: 'ideate',
    reworkCap,
    criticInputScope: [],
  };
}

function setupTransformFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: gate-verdict-log
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
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
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
    owned_paths: over.owned_paths ?? ['context.json', 'idea.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

// ===========================================================================
// LEVEL 1 — runGateRework returns a WIDENED decision carrying the verdict
// payload on every branch (gate-rework.ts; findings no longer discarded).
// ===========================================================================

describe('runGateRework — widened decision carries verdict/findings/returnTo/attempt (WI-382)', () => {
  let dir: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-gate-unit-'));
    db = openDb();
  });
  afterEach(() => {
    db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function decide(opts: {
    verdict: 'pass' | 'reject';
    findings: string[];
    returnTo?: string;
    reworkCount: number;
    attempt: number;
  }): Promise<WidenedGateDecision> {
    seedCard(db!, { id: 'c1', lane: 'ideate', status: 'working', owned_paths: [], rework_count: opts.reworkCount });
    const decision = await runGateRework({
      db: db!,
      runId: DEFAULT_RUN_ID,
      cardId: 'c1',
      workerStationId: 'ideate',
      attempt: opts.attempt,
      maxExecutionAttempts: 4,
      gateReworkCount: opts.reworkCount,
      gateConfig: gateConfigFor(dir),
      adapter: criticAdapter(opts.verdict, opts.findings, opts.returnTo),
      projectRoot: dir,
      validBackEdges: [{ from: 'ideate', to: 'ideate' }],
    });
    return decision as unknown as WidenedGateDecision;
  }

  it('pass branch carries verdict=pass, empty findings, returnTo=null, and the attempt', async () => {
    const d = await decide({ verdict: 'pass', findings: [], reworkCount: 0, attempt: 3 });
    expect(d.action).toBe('pass');
    expect(d.verdict).toBe('pass');
    expect(d.findings).toEqual([]);
    expect(d.returnTo).toBeNull();
    expect(d.attempt).toBe(3);
  });

  it('rework branch carries verdict=reject, the critic findings, returnTo lane, and the attempt', async () => {
    const d = await decide({
      verdict: 'reject',
      findings: ['needs work', 'fix the hook'],
      returnTo: 'ideate',
      reworkCount: 0,
      attempt: 3,
    });
    expect(d.action).toBe('rework');
    expect(d.verdict).toBe('reject');
    expect(d.findings).toEqual(['needs work', 'fix the hook']);
    expect(d.returnTo).toBe('ideate');
    expect(d.attempt).toBe(3);
  });

  it('scrap branch (rework cap) carries the rejecting verdict + findings + attempt (returnTo null)', async () => {
    // reworkCount == reworkCap → the reject is scrapped, but the findings that
    // caused it must survive on the decision for triage logging.
    const d = await decide({
      verdict: 'reject',
      findings: ['needs work', 'fix the hook'],
      returnTo: 'ideate',
      reworkCount: 2,
      attempt: 3,
    });
    expect(d.action).toBe('scrap');
    expect(d.reason).toBe('rework_cap');
    expect(d.verdict).toBe('reject');
    expect(d.findings).toEqual(['needs work', 'fix the hook']);
    expect(d.returnTo).toBeNull();
    expect(d.attempt).toBe(3);
  });
});

// ===========================================================================
// LEVEL 2 — the executor appends a gate_verdict card_log entry on every gate
// check (verdict, findings, returnTo, attempt), before the state-db commit.
// ===========================================================================

describe('runExecutor — appends gate_verdict card_log entries (WI-382)', () => {
  let projectDir: string;
  let originalCwd: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'conduit-gate-exec-'));
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

  it('records a verdict=pass gate_verdict (empty findings, returnTo=null, current attempt) on a gate pass (FR-3)', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const verdicts = gateVerdicts(db, 'entry');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.verdict).toBe('pass');
    expect(verdicts[0]!.findings).toEqual([]);
    expect(verdicts[0]!.returnTo).toBeNull();
    expect(verdicts[0]!.attempt).toBe(0);
  });

  it('records a verdict=reject gate_verdict (findings, returnTo=back-edge, attempt) on a gate reject (FR-3)', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    // One reject then pass; the reject's gate_verdict is the surviving entry at
    // (entry, ideate, 0, gate_verdict).
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 1 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const reject = gateVerdicts(db, 'entry').find((v) => v.verdict === 'reject');
    expect(reject).toBeDefined();
    expect(reject!.findings).toEqual(['needs work']);
    expect(reject!.returnTo).toBe('ideate');
    expect(reject!.attempt).toBe(0);
  });

  it('records the rejecting gate_verdict (with findings) BEFORE the terminal entry on a rework-cap scrap (FR-3/FR-4)', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    // Always rejects → exhausts the rework cap → scrap.
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 99 });

    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('scrap');

    const log = cardLog(db, 'entry');
    const gvIndex = log.findIndex((e) => e.kind === 'gate_verdict' && e.verdict === 'reject');
    const termIndex = log.findIndex((e) => e.kind === 'terminal');

    // A rejecting gate_verdict carrying findings exists, and it precedes the
    // terminal entry so triage can read why the card scrapped.
    expect(gvIndex).toBeGreaterThanOrEqual(0);
    expect(termIndex).toBeGreaterThanOrEqual(0);
    expect(gvIndex).toBeLessThan(termIndex);
    const gv = log[gvIndex] as GateVerdictEntry;
    expect(gv.findings.length).toBeGreaterThan(0);
  });

  it('is idempotent: replaying the same gate check appends no duplicate gate_verdict (FR-7)', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'rep', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });

    // First pass: ideate → gate pass → done. One gate_verdict recorded.
    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'rep')?.lane).toBe('done');
    expect(gateVerdicts(db, 'rep')).toHaveLength(1);

    // Simulate a crash between the pre-commit gate_verdict append and the state
    // commit: roll the card back to its pre-gate state while the gate_verdict
    // entry persists on the journal DB.
    db.getStateDb().prepare("UPDATE cards SET lane = 'ideate', status = 'ready' WHERE id = 'rep'").run();
    db.getStateDb().prepare('DELETE FROM active_workers WHERE card_id = $id').run({ $id: 'rep' });

    // Resume: the gate check re-runs and re-appends the SAME (card,station,attempt,
    // 'gate_verdict'). The UNIQUE constraint must dedup it.
    await runExecutor({ db, flow, projectRoot: projectDir, now: SECONDS(1000), adapter, io: makeIO().io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'rep')?.lane).toBe('done');
    expect(gateVerdicts(db, 'rep')).toHaveLength(1);
  });
});
