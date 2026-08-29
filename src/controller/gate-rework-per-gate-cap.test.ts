/**
 * Regression tests for issue #1 — `rework_cap` is declared PER GATE, so the
 * counter guard #1 compares it against must be scoped per gate too.
 *
 * The bug: `cards.rework_count` is a single lifetime counter, incremented on
 * every rework anywhere in the flow and never reset, but guard #1 compared it
 * against the CURRENT gate's `rework_cap`. Reworks spent at an early gate
 * therefore consumed every later gate's budget — a gate declaring
 * `rework_cap: 3` behaved as 2, 1, or 0 depending on unrelated upstream
 * history, and under the default `cap_policy: scrap` a gate whose budget was
 * already spent upstream scrapped the card on its FIRST reject.
 *
 * These drive the REAL `runExecutor` (not the pure guard in isolation) through
 * a two-gate flow, because the bug lived in what the executor PASSED to the
 * guard — `gate-rework.ts` and `transitions.ts` both did the right thing with
 * the number they were handed. A test against the pure functions alone would
 * have stayed green through the entire bug.
 *
 * Each test is decisive: with the fix the card reaches `done`; with the bug it
 * lands in `scrap` with terminal reason `rework_cap`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';
import { countGateReworks } from '../quality/rework';

// ---------------------------------------------------------------------------
// Fixture — two GATED transform stations in series: research -> draft -> done.
//
// Each gate has its OWN declared rework_cap, which is the whole point: SPEC §4's
// own example gives one flow's two gates different caps, and those numbers only
// mean anything if each gate has its own budget.
// ---------------------------------------------------------------------------

const RESEARCH_WORKER = 'worker-research';
const RESEARCH_CRITIC = 'critic-research';
const DRAFT_WORKER = 'worker-draft';
const DRAFT_CRITIC = 'critic-draft';

function setupTwoGateFlow(
  dir: string,
  opts: { researchCap: number; draftCap: number },
): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'research.md'), 'Research from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'research-check.md'), 'Check {{research.json}}');
  writeFileSync(join(dir, 'prompts', 'draft.md'), 'Draft from {{research.json}}');
  writeFileSync(join(dir, 'prompts', 'draft-check.md'), 'Check {{draft.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: per-gate-rework-cap
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 99 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: scrap }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: transform
      model: ${RESEARCH_WORKER}
      prompt_file: prompts/research.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: notes, type: string, required: true }
    inputs: [context.json]
    outputs: [research.json]
    next: draft
    check:
      kind: gate
      critic: { role: critic, model: ${RESEARCH_CRITIC}, prompt_file: prompts/research-check.md, prompt_version: "1" }
      on_reject: research
      rework_cap: ${opts.researchCap}
  - id: draft
    worker:
      kind: transform
      model: ${DRAFT_WORKER}
      prompt_file: prompts/draft.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: body, type: string, required: true }
    inputs: [research.json]
    outputs: [draft.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, model: ${DRAFT_CRITIC}, prompt_file: prompts/draft-check.md, prompt_version: "1" }
      on_reject: draft
      rework_cap: ${opts.draftCap}
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`two-gate fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * Adapter driving each gate independently: `researchRejects` / `draftRejects`
 * rejections (with DISTINCT findings each time, so guard #3's no-progress
 * hard-stop never fires and the card is bounded purely by guard #1), then pass.
 */
function makeTwoGateAdapter(opts: { researchRejects: number; draftRejects: number }): {
  adapter: ModelAdapter;
  calls: ModelCall[];
} {
  let researchLeft = opts.researchRejects;
  let draftLeft = opts.draftRejects;
  let n = 0;
  const calls: ModelCall[] = [];

  const reject = (returnTo: string): ModelResponse => {
    n += 1;
    return {
      text: JSON.stringify({ verdict: 'reject', findings: [`finding-${n}`], return_to: returnTo }),
      inputTokens: 8,
      outputTokens: 4,
      costUsd: 0.002,
    };
  };
  const pass = (): ModelResponse => ({
    text: JSON.stringify({ verdict: 'pass', findings: [] }),
    inputTokens: 8,
    outputTokens: 4,
    costUsd: 0.002,
  });

  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === RESEARCH_CRITIC) {
        if (researchLeft > 0) { researchLeft -= 1; return reject('research'); }
        return pass();
      }
      if (req.model === DRAFT_CRITIC) {
        if (draftLeft > 0) { draftLeft -= 1; return reject('draft'); }
        return pass();
      }
      if (req.model === DRAFT_WORKER) {
        return { text: JSON.stringify({ body: 'a draft' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
      }
      return { text: JSON.stringify({ notes: 'some notes' }), inputTokens: 12, outputTokens: 6, costUsd: 0.003 };
    },
  };
  return { adapter, calls };
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
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
    owned_paths: over.owned_paths ?? ['context.json', 'research.json', 'draft.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function makeIO(): { io: RunEngineArgs['io']; errs: string[] } {
  const errs: string[] = [];
  const io = { out: () => {}, err: (m: string) => errs.push(m) } as RunEngineArgs['io'];
  return { io, errs };
}

function terminalReasons(db: ConduitDB, cardId: string): string[] {
  return db
    .getCardLogForRun(DEFAULT_RUN_ID, cardId)
    .filter((e) => e.kind === 'terminal')
    .map((e) => (e.kind === 'terminal' ? e.reason : ''));
}

/** Reworks the card_log attributes to a given gate — the fixed guard-#1 counter. */
function reworksAt(db: ConduitDB, cardId: string, station: string): number {
  return countGateReworks(db.getCardLogForRun(DEFAULT_RUN_ID, cardId), station);
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle — temp project dir; the executor resolves artifacts against CWD.
// ---------------------------------------------------------------------------

let projectDir: string;
let prevCwd: string;
let db: ConduitDB | null = null;

beforeEach(() => {
  prevCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-per-gate-cap-'));
  process.chdir(projectDir);
});

afterEach(() => {
  db?.close();
  db = null;
  process.chdir(prevCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('guard #1 rework cap is scoped per (card, gate) — issue #1', () => {
  it('gives a downstream gate its FULL declared budget after an upstream gate reworked', async () => {
    // research spends 1 of its 2, then passes. draft then needs 2 of its 2.
    // Fixed:  draft's counter starts at 0 -> both rejects are under cap -> done.
    // Buggy:  the lifetime counter is already 1, so draft's SECOND reject sees
    //         2 >= 2 and scraps -- draft got 1 of its declared 2.
    const flow = setupTwoGateFlow(projectDir, { researchCap: 2, draftCap: 2 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'research' });
    const { adapter } = makeTwoGateAdapter({ researchRejects: 1, draftRejects: 2 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');

    // Each gate spent exactly its own reworks, attributed to its own station.
    expect(reworksAt(db, 'entry', 'research')).toBe(1);
    expect(reworksAt(db, 'entry', 'draft')).toBe(2);
    // The lifetime scalar is untouched by this fix: still the sum across gates.
    expect(card?.rework_count).toBe(3);
  });

  it('does not scrap a downstream gate on its FIRST reject when upstream exhausted the lifetime counter', async () => {
    // The destructive case. research spends 2; draft declares a cap of 1 and
    // needs exactly 1.
    // Fixed:  draft's counter starts at 0 -> 0 < 1 -> rework, then pass -> done.
    // Buggy:  draft's first reject sees 2 >= 1 -> immediate scrap. The card is
    //         destroyed without ever getting the single cycle it was promised.
    const flow = setupTwoGateFlow(projectDir, { researchCap: 2, draftCap: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'research' });
    const { adapter } = makeTwoGateAdapter({ researchRejects: 2, draftRejects: 1 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(terminalReasons(db, 'entry')).not.toContain('rework_cap');
    expect(reworksAt(db, 'entry', 'draft')).toBe(1);
  });

  it('still scraps at a gate\'s OWN cap — per-gate scoping loosens nothing', async () => {
    // The guard must not be weakened into uselessness: draft declares 1 and its
    // critic never relents, so it scraps with 'rework_cap' after exactly one
    // rework AT DRAFT, regardless of what research spent.
    const flow = setupTwoGateFlow(projectDir, { researchCap: 2, draftCap: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'research' });
    const { adapter } = makeTwoGateAdapter({ researchRejects: 1, draftRejects: 99 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    expect(terminalReasons(db, 'entry')).toContain('rework_cap');
    expect(reworksAt(db, 'entry', 'draft')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The counter itself.
// ---------------------------------------------------------------------------

describe('countGateReworks', () => {
  const entry = (kind: string, station: string, reasonClass?: string) =>
    ({ kind, station, ...(reasonClass !== undefined ? { reasonClass } : {}) });

  it('counts only rework departures from the named gate', () => {
    const log = [
      entry('entered_lane', 'research', 'rework'),
      entry('entered_lane', 'research', 'forward'),
      entry('entered_lane', 'draft', 'rework'),
      entry('entered_lane', 'draft', 'rework'),
    ];
    expect(countGateReworks(log, 'research')).toBe(1);
    expect(countGateReworks(log, 'draft')).toBe(2);
  });

  it('ignores gate_verdict and terminal rows, and unknown stations', () => {
    const log = [
      entry('gate_verdict', 'draft'),
      entry('terminal', 'draft'),
      entry('entered_lane', 'draft', 'scrap'),
      entry('entered_lane', 'draft', 'hold'),
    ];
    expect(countGateReworks(log, 'draft')).toBe(0);
    expect(countGateReworks(log, 'nonexistent')).toBe(0);
  });

  it('returns 0 for an empty log', () => {
    expect(countGateReworks([], 'draft')).toBe(0);
  });
});
