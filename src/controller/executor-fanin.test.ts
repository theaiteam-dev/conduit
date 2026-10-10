/**
 * Quorum fan-in wired into runExecutor (WI-397).
 *
 * PRD FR5. WI-396 seeds children from a fan-out station and parks the parent at
 * status='awaiting_children' (lane unchanged) via the FAN_OUT event. WI-397
 * wires the OTHER half: when the children reach terminal outcomes, runExecutor
 * applies the declared quorum(k) fan-in policy via the EXISTING dag/expand.ts
 * `evaluateFanIn`, and either:
 *   - resumes the parent at its topology-declared post-fan-in station (resume_at)
 *     carrying the surviving (non-scrap) children, OR
 *   - holds the parent (quorum can never be met) — never deadlocking on a child
 *     that can never complete.
 *
 * These are INTEGRATION tests pointed at the REAL runExecutor (CLAUDE.md: prefer
 * wiring the existing library over reimplementation; point integration tests at
 * the real executor path). The fan-in evaluation seam is `pollAwaitingChildren`
 * (the named WI-396 extension point that WI-397 fills in).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/controller/executor.ts (the fan-in wiring)
 * ---------------------------------------------------------------------------
 * For each parent at status='awaiting_children' (parked at its fan-out station
 * `parent.lane`), runExecutor:
 *   - reads resume_at from the fan-out station's WI-393 topology
 *     (flow.stations[parent.lane].resume_at);
 *   - reads the fan-in POLICY from the RESUME_AT station's `fan_in` config
 *     (flow.stations[resume_at].fan_in) — exactly as the reference flow declares
 *     `fan_in: { policy: quorum, k: 2 }` on its merge station `assemble`;
 *   - groups the parent's children by parent_id and reads each child's terminal
 *     outcome from its lane (lane ∈ terminal_lanes → terminal; lane === 'scrap'
 *     → a resolved, NON-survivor terminal; any other lane → still in flight);
 *   - fires fan-in ONLY when EVERY child is terminal. While any child is still
 *     non-terminal (waiting/working/held at a work lane) the parent STAYS in
 *     awaiting_children — even if the survivor count already meets the quorum;
 *   - on evaluateFanIn → 'proceed': moves the parent to resume_at with
 *     status='ready' (so the next planTick dispatches it), carrying the
 *     survivors and dropping scrapped/never-completed children;
 *   - on evaluateFanIn → 'hold_parent': the parent is held (NOT left spinning in
 *     awaiting_children — that would deadlock).
 * The resume lane is ALWAYS resume_at from the parsed topology, NEVER the
 * fan-out station's station-order successor (`next`).
 *
 * Out of scope (AC6): WI-397 must NOT wire checkWaveBudget — per-subtree wave
 * budget is a deferred Wave-1 dependency. No test here exercises it; reviewers
 * confirm `checkWaveBudget` is not called from the fan-in path.
 *
 * Observable signals (raise a precise TEST BUG if a seam differs):
 *   - parent resumed at resume_at: its card_log has an entered_lane span
 *     departing FROM the resume_at lane (it ran that station).
 *   - parent never took station order: NO entered_lane span departs FROM `next`.
 *   - parent held: db.getCard(DEFAULT_RUN_ID, parent).status === 'held'.
 *   - parent still waiting on children: db.getCard(DEFAULT_RUN_ID, parent).status === 'awaiting_children'.
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

const PLANNER_MODEL = 'gpt-4o-mini';
const FANOUT_STATION = 'plan';
const CHILD_ENTRY = 'cwork';
const RESUME_AT = 'assemble'; // post-fan-in station; carries fan_in: quorum k:2
const STATION_ORDER_NEXT = 'merge'; // DECOY: plan.next, distinct from resume_at
const PARENT_ID = 'root';
const QUORUM_K = 2;

// ---------------------------------------------------------------------------
// Fixture: a fan-out flow whose fan-out station `plan` resumes (post fan-in) at
// `assemble` — a DIFFERENT station from its station-order successor `merge`. The
// fan-in policy (quorum k=2) lives on the resume_at station `assemble`, mirroring
// the reference flow. Children enter at `cwork`.
// ---------------------------------------------------------------------------
function setupFanInFlow(dir: string, fanIn = `{ policy: quorum, k: ${QUORUM_K} }`): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'plan.md'), 'Propose the child decomposition.');

  const flowYaml = `
flow: executor-fanin
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: plan
    worker:
      kind: transform
      model: ${PLANNER_MODEL}
      prompt_file: prompts/plan.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: children, type: object, required: true }
    inputs: []
    outputs: [children.json]
    fan_out: 3
    child_entry: cwork
    child_terminal: done
    resume_at: assemble
    next: merge
  - id: cwork
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: merge
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: assemble
    worker: { kind: deterministic, command: "true" }
    fan_in: ${fanIn}
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) {
    throw new Error(`fan-in fixture invalid: ${JSON.stringify(loaded.errors)}`);
  }
  return loaded.flow;
}

/** Stub adapter: the fan-out transform station returns `proposal` as its output. */
function makeProposalAdapter(proposal: unknown): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      void req;
      return {
        text: JSON.stringify(proposal),
        inputTokens: 10,
        outputTokens: 6,
        costUsd: 0.002,
      };
    },
  };
}

/** Adapter for pre-seeded tests: no model call is expected (parent is past fan-out). */
function noopAdapter(): ModelAdapter {
  return {
    async call(): Promise<ModelResponse> {
      throw new Error('unexpected model call in a pre-seeded fan-in test');
    },
  };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines };
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle — each test in its own temp project dir (chdir for artifact I/O).
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-fanin-'));
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openFreshDb(): ConduitDB {
  const database = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(database.getStateDb());
  return database;
}

/** Insert the fan-out parent already parked at the fan-out station, awaiting children. */
function seedParentAwaitingChildren(database: ConduitDB): void {
  database.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: PARENT_ID,
    parent_id: null,
    lane: FANOUT_STATION,
    status: 'awaiting_children',
    attempt: 0,
    wave: 0,
    owned_paths: ['children.json'],
    rework_count: 0,
  });
}

/** Insert a child card under the parent at a chosen (lane, status). */
function seedChild(
  database: ConduitDB,
  id: string,
  lane: string,
  status: Card['status'],
  ownedPaths: string[],
): void {
  database.insertCard({
    run_id: DEFAULT_RUN_ID,
    id,
    parent_id: PARENT_ID,
    lane,
    status,
    attempt: 0,
    wave: 0,
    owned_paths: ownedPaths,
    rework_count: 0,
  });
}

/** Drive runExecutor over the fan-in flow with whatever cards are already seeded. */
async function run(adapter: ModelAdapter, fanIn?: string): Promise<void> {
  const flow = setupFanInFlow(projectDir, fanIn);
  const { io } = makeIO();
  await runExecutor({
    db: db!,
    flow,
    now: SECONDS(1000),
    adapter,
    io,
  } as RunEngineArgs);
}

/** Child cards seeded under the parent (commitFanOut sets parent_id). */
function childIds(database: ConduitDB, parentId: string): string[] {
  return (
    database
      .getStateDb()
      .prepare('SELECT id FROM cards WHERE parent_id = $p ORDER BY id')
      .all({ $p: parentId }) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** True iff the card's card_log shows it departing FROM `lane` (i.e. it ran that station). */
function departedFromLane(database: ConduitDB, cardId: string, lane: string): boolean {
  return database
    .getCardLog(cardId)
    .some((e) => e.kind === 'entered_lane' && e.sourceLane === lane);
}

const validTwoChildProposal = {
  children: [
    { id: 'c1', depends_on: [] as string[], owned_paths: ['out/c1.json'] },
    { id: 'c2', depends_on: [] as string[], owned_paths: ['out/c2.json'] },
  ],
};

// ===========================================================================
// AC1 + AC5 (end-to-end) — when enough children succeed, the parent resumes at
//   the topology resume_at station, NOT at the fan-out station's station-order
//   successor. Drives the full WI-396 fan-out → WI-397 fan-in chain through the
//   real runExecutor.
// ===========================================================================

describe('runExecutor fan-in — parent resumes at resume_at when quorum is met (AC1, AC5)', () => {
  it('fans out, runs the children, and resumes the parent at resume_at (assemble), never at next (merge)', async () => {
    db = openFreshDb();
    // Seed the parent at the fan-out station, ready to run its transform.
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: PARENT_ID,
      parent_id: null,
      lane: FANOUT_STATION,
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: ['children.json'],
      rework_count: 0,
    });

    await run(makeProposalAdapter(validTwoChildProposal));

    // Both children were seeded and reached the success terminal (cwork → done).
    expect(childIds(db, PARENT_ID)).toEqual(['c1', 'c2']);

    // The parent resumed at the topology resume_at station (`assemble`)…
    expect(departedFromLane(db, PARENT_ID, RESUME_AT)).toBe(true);
    // …and NEVER took the fan-out station's station-order successor (`merge`).
    expect(departedFromLane(db, PARENT_ID, STATION_ORDER_NEXT)).toBe(false);

    // Fan-in fired: the parent left awaiting_children and was not held.
    const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
    expect(parent?.status).not.toBe('awaiting_children');
    expect(parent?.status).not.toBe('held');
  });
});

// ===========================================================================
// AC1 + AC3 (quorum met despite a scrap) — a scrapped child is a RESOLVED
//   terminal outcome (dropped, non-blocking). With 2 survivors + 1 scrap and
//   k=2, fan-in proceeds and the parent resumes at resume_at.
// ===========================================================================

describe('runExecutor fan-in — scrapped child is terminal; quorum still met proceeds (AC1, AC3)', () => {
  it('resumes the parent at resume_at when survivors meet k even though one child scrapped', async () => {
    db = openFreshDb();
    seedParentAwaitingChildren(db);
    seedChild(db, 'c1', 'done', 'complete', ['out/c1.json']); // survivor
    seedChild(db, 'c2', 'done', 'complete', ['out/c2.json']); // survivor
    seedChild(db, 'c3', 'scrap', 'scrapped', ['out/c3.json']); // resolved, dropped

    await run(noopAdapter());

    const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
    // survivors = 2 >= k(2): proceed. The scrapped child does not block fan-in.
    expect(departedFromLane(db, PARENT_ID, RESUME_AT)).toBe(true);
    expect(departedFromLane(db, PARENT_ID, STATION_ORDER_NEXT)).toBe(false);
    expect(parent?.status).not.toBe('awaiting_children');
    expect(parent?.status).not.toBe('held');
  });
});

// ===========================================================================
// AC2 + AC3 — when fewer than k children survive but ALL children are terminal
//   (some scrapped), the parent is HELD rather than deadlocked. A scrap is a
//   resolved terminal outcome, so fan-in evaluates instead of waiting forever.
// ===========================================================================

describe('runExecutor fan-in — quorum impossible holds the parent, never deadlocks (AC2, AC3)', () => {
  it('holds the parent when survivors < k and every child is terminal (2 scrapped, 1 survivor, k=2)', async () => {
    db = openFreshDb();
    seedParentAwaitingChildren(db);
    seedChild(db, 'c1', 'scrap', 'scrapped', ['out/c1.json']);
    seedChild(db, 'c2', 'scrap', 'scrapped', ['out/c2.json']);
    seedChild(db, 'c3', 'done', 'complete', ['out/c3.json']); // only 1 survivor

    await run(noopAdapter());

    const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
    // survivors = 1 < k(2), all children terminal → hold_parent (quorum_unmet).
    expect(parent?.status).toBe('held');
    // It must NOT have resumed at resume_at (quorum could not be met)…
    expect(departedFromLane(db, PARENT_ID, RESUME_AT)).toBe(false);
    // …and must NOT be left deadlocked in awaiting_children.
    expect(parent?.status).not.toBe('awaiting_children');
  });
});

// ===========================================================================
// AC4 — fan-in does NOT fire while any child is still non-terminal, EVEN IF the
//   survivor count already meets the quorum. The parent stays awaiting_children
//   until every child reaches a terminal outcome.
// ===========================================================================

describe('runExecutor fan-in — does not fire while a child is still non-terminal (AC4)', () => {
  it('keeps the parent in awaiting_children when a child is in flight, despite quorum being numerically met', async () => {
    db = openFreshDb();
    seedParentAwaitingChildren(db);
    seedChild(db, 'c1', 'done', 'complete', ['out/c1.json']); // survivor
    seedChild(db, 'c2', 'done', 'complete', ['out/c2.json']); // survivor (2 >= k already)
    // c3 is still at a WORK lane (non-terminal) — held in flight, not yet resolved.
    seedChild(db, 'c3', CHILD_ENTRY, 'held', ['out/c3.json']);

    await run(noopAdapter());

    const parent = db.getCard(DEFAULT_RUN_ID, PARENT_ID);
    // Even though survivors (2) already meet k(2), c3 is non-terminal → wait.
    expect(parent?.status).toBe('awaiting_children');
    // The parent must NOT have resumed at resume_at while a child is in flight.
    expect(departedFromLane(db, PARENT_ID, RESUME_AT)).toBe(false);
  });
});

// ===========================================================================
// A child in the `hold` lane is escalated to a human, not finished. The `all`
// policy used to count it as a survivor, so the parent merged and reached done
// while the child sat in hold (an integrity breach holds a harness card there).
// ===========================================================================

describe('runExecutor fan-in — a child in the hold lane is not a survivor', () => {
  function terminalReasons(id: string): string[] {
    return db!.getCardLog(id)
      .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
      .map((e) => e.reason);
  }

  it('holds the parent under policy all (fan-in child_held)', async () => {
    db = openFreshDb();
    seedParentAwaitingChildren(db);
    seedChild(db, 'c1', 'done', 'complete', ['out/c1.json']);
    seedChild(db, 'c2', 'done', 'complete', ['out/c2.json']);
    seedChild(db, 'c3', 'hold', 'held', ['out/c3.json']);

    await run(noopAdapter(), '{ policy: all }');

    expect(db.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
    expect(departedFromLane(db, PARENT_ID, RESUME_AT)).toBe(false);
    expect(terminalReasons(PARENT_ID)).toContain('fan-in child_held');
  });

  it('counts it against the quorum', async () => {
    db = openFreshDb();
    seedParentAwaitingChildren(db);
    seedChild(db, 'c1', 'done', 'complete', ['out/c1.json']);
    seedChild(db, 'c2', 'hold', 'held', ['out/c2.json']);
    seedChild(db, 'c3', 'scrap', 'scrapped', ['out/c3.json']);

    await run(noopAdapter());

    // survivors = 1 < k(2).
    expect(db.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
    expect(terminalReasons(PARENT_ID)).toContain('fan-in quorum_unmet');
  });
});
