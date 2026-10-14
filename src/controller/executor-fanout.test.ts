/**
 * Planner-driven fan-out wired into runExecutor (WI-396).
 *
 * PRD FR2/FR3/FR4, SPEC §9. When a fan-out station's worker output proposes a
 * set of child cards, runExecutor must:
 *   1. parse the worker output into an ArchitectProposal,
 *   2. validate it fail-closed via the EXISTING dag/expand.ts primitives
 *      (validateExpansion + commitFanOut: acyclic deps + disjoint ownership),
 *   3. seed the valid children into their distinct path namespaces, routed to the
 *      topology-declared child_entry station (WI-393), and
 *   4. route the PARENT through the FSM's FAN_OUT event into awaiting_children —
 *      NOT by inferring the parent's next lane from station order.
 * A non-conforming / cyclic / overlapping proposal is rejected AS A WHOLE: no
 * child cards are seeded and the parent is held/escalated.
 *
 * These are INTEGRATION tests pointed at the REAL runExecutor (CLAUDE.md: prefer
 * wiring the existing library module over reimplementation, and point integration
 * tests at the real executor path). Only the ModelAdapter (the LLM boundary) is a
 * stub — it returns the Architect's proposal as the fan-out station's output. The
 * fan-out primitives (commitFanOut/validateExpansion), the transition() FSM, and
 * the planTick dispatch loop all run for real.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/controller/executor.ts (the fan-out wiring)
 * ---------------------------------------------------------------------------
 * A station is a FAN-OUT station when it declares `fan_out` + the WI-393 topology
 * (`child_entry` / `child_terminal` / `resume_at`). When such a station finishes
 * its transform work, runExecutor:
 *   - reads the station output payload as ArchitectProposal { children: ProposedChild[] };
 *   - on a structurally non-conforming payload → escalates the parent to held,
 *     seeds NO children (malformed);
 *   - calls commitFanOut(db, parentId, proposal, { onPathConflict: 'reject' }); a
 *     dependency_cycle or overlapping_owned_paths error → parent held, NO children;
 *   - on success → seeds N children (each owning the proposed disjoint owned_paths),
 *     routes each child to `child_entry`, and transitions the PARENT via FAN_OUT to
 *     status='awaiting_children' (lane unchanged).
 *
 * Observable signals these tests rely on (raise a precise TEST BUG if a seam differs):
 *   - children: `SELECT ... FROM cards WHERE parent_id = <parent>` (commitFanOut sets parent_id)
 *   - a child "entered child_entry": its card_log has an entered_lane span departing
 *     FROM the child_entry lane (it ran that station)
 *   - parent reached awaiting_children: db.getCard(DEFAULT_RUN_ID, parent).status === 'awaiting_children'
 *     (only reachable via FAN_OUT from done_pending_ack — INTEGRITY_PASS would instead
 *     route the parent to its happyPathNext successor with status 'waiting'/'complete')
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { basename, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const PLANNER_MODEL = 'gpt-4o-mini';
const FANOUT_STATION = 'plan';
const CHILD_ENTRY = 'cwork';
const PARENT_ID = 'root';

// ---------------------------------------------------------------------------
// Fixture: a fan-out flow. `plan` (transform) fans out to children that enter at
// `cwork`; the parent's declared station-order successor / resume_at is `merge`
// (a DIFFERENT station than child_entry) so a routing that infers the next lane
// from station order is observably distinguishable from FAN_OUT routing.
// ---------------------------------------------------------------------------
function setupFanOutFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'plan.md'), 'Propose the child decomposition.');

  const flowYaml = `
flow: executor-fanout
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
    fan_out: 2
    child_entry: cwork
    child_terminal: done
    resume_at: merge
    next: merge
  - id: cwork
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: merge
    worker: { kind: deterministic, command: "true" }
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fan-out fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** Stub adapter: the fan-out station's worker returns `proposal` as its output. */
function makeProposalAdapter(proposal: unknown): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      // Only the fan-out transform station calls the model in this flow.
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
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-fanout-'));
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

/** Drive the real runExecutor over the fan-out flow with the given proposal. */
async function runFanOut(proposal: unknown, extra: { projectRoot?: string } = {}): Promise<{ lines: string[] }> {
  const flow = setupFanOutFlow(projectDir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
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
  const { io, lines } = makeIO();
  await runExecutor({
    db,
    flow,
    now: SECONDS(1000),
    adapter: makeProposalAdapter(proposal),
    io,
    ...extra,
  } as RunEngineArgs);
  return { lines };
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

const validProposal = {
  children: [
    { id: 'c1', depends_on: [] as string[], owned_paths: ['out/c1.json'] },
    { id: 'c2', depends_on: [] as string[], owned_paths: ['out/c2.json'] },
  ],
};

// ===========================================================================
// AC1 — N valid children are seeded at the child-entry station
// ===========================================================================

describe('runExecutor fan-out — seeds N children at child_entry (AC1)', () => {
  it('seeds one child card per proposed child, all routed into the child_entry station', async () => {
    await runFanOut(validProposal);

    const kids = childIds(db!, PARENT_ID);
    expect(kids).toEqual(['c1', 'c2']); // exactly the N=2 proposed children, parent_id set

    // Each child entered the topology-declared child_entry station (it ran `cwork`).
    for (const kid of kids) {
      expect(departedFromLane(db!, kid, CHILD_ENTRY)).toBe(true);
    }
  });
});

// ===========================================================================
// AC2 — a non-conforming proposal is rejected as malformed (parent held, none seeded)
// ===========================================================================

describe('runExecutor fan-out — malformed proposal rejected (AC2)', () => {
  it.each([
    ['children is not an array', { children: { nope: true } }],
    ['a child is not an object', { children: [42] }],
  ])('escalates the parent and seeds no children when %s', async (_label, badProposal) => {
    await runFanOut(badProposal);

    // No children seeded — the whole proposal was rejected.
    expect(childIds(db!, PARENT_ID)).toEqual([]);
    // Parent escalated (held), not advanced.
    expect(db!.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
  });
});

// ===========================================================================
// AC3 — a dependency cycle among proposed children is rejected as a whole
// ===========================================================================

describe('runExecutor fan-out — dependency cycle rejected (AC3)', () => {
  it('seeds no children and holds the parent when the proposal contains a dependency cycle', async () => {
    await runFanOut({
      children: [
        { id: 'c1', depends_on: ['c2'], owned_paths: ['out/c1.json'] },
        { id: 'c2', depends_on: ['c1'], owned_paths: ['out/c2.json'] },
      ],
    });

    expect(childIds(db!, PARENT_ID)).toEqual([]); // no partial expansion
    expect(db!.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
  });
});

// ===========================================================================
// AC4 — overlapping owned paths are rejected as a whole (onPathConflict: reject)
// ===========================================================================

describe('runExecutor fan-out — overlapping owned paths rejected (AC4)', () => {
  it('seeds no children and holds the parent when two proposed children claim the same path', async () => {
    await runFanOut({
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['out/shared.json'] },
        { id: 'c2', depends_on: [], owned_paths: ['out/shared.json'] },
      ],
    });

    // Reject (not serialize): a shared path means the whole proposal is refused.
    expect(childIds(db!, PARENT_ID)).toEqual([]);
    expect(db!.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
  });
});

// ===========================================================================
// AC5 — each seeded child owns a disjoint path namespace (inspect owned_paths)
// ===========================================================================

describe('runExecutor fan-out — children own disjoint path namespaces (AC5)', () => {
  it('seeds each child with the proposed owned_paths, disjoint from every sibling', async () => {
    await runFanOut(validProposal);

    const kids = childIds(db!, PARENT_ID);
    expect(kids).toEqual(['c1', 'c2']);

    // The proposed namespaces were preserved verbatim on the seeded cards.
    expect(db!.getCard(DEFAULT_RUN_ID, 'c1')?.owned_paths).toEqual(['out/c1.json']);
    expect(db!.getCard(DEFAULT_RUN_ID, 'c2')?.owned_paths).toEqual(['out/c2.json']);

    // No path is owned by more than one sibling (concurrent children never share a path).
    const ownedByEach = kids.map((id) => db!.getCard(DEFAULT_RUN_ID, id)?.owned_paths ?? []);
    for (let i = 0; i < ownedByEach.length; i++) {
      for (let j = i + 1; j < ownedByEach.length; j++) {
        const left = new Set(ownedByEach[i]);
        for (const p of ownedByEach[j]!) {
          expect(left.has(p)).toBe(false);
        }
      }
    }
  });
});

// ===========================================================================
// AC6 — the parent is routed through transition()'s FAN_OUT event, NOT by
//        inferring the next lane from station order; children route to
//        child_entry, not to the fan-out station's declared successor.
// ===========================================================================

describe('runExecutor fan-out — routed via FAN_OUT, not station order (AC6)', () => {
  it('transitions the parent to awaiting_children (FAN_OUT), never to its station-order successor', async () => {
    await runFanOut(validProposal);

    const parent = db!.getCard(DEFAULT_RUN_ID, PARENT_ID);
    // FAN_OUT: done_pending_ack → awaiting_children, lane UNCHANGED (still the fan-out station).
    expect(parent?.status).toBe('awaiting_children');
    expect(parent?.lane).toBe(FANOUT_STATION);
    // It did NOT take the INTEGRITY_PASS / station-order path to its `next` (merge) or 'done'.
    expect(parent?.lane).not.toBe('merge');
    expect(parent?.lane).not.toBe('done');
    expect(parent?.status).not.toBe('complete');
  });

  it('routes children to the topology child_entry, not to the fan-out station\'s next (merge)', async () => {
    await runFanOut(validProposal);

    const kids = childIds(db!, PARENT_ID);
    expect(kids).toEqual(['c1', 'c2']); // guard: children must exist (no vacuous pass)
    for (const kid of kids) {
      // Each child ran child_entry ('cwork')…
      expect(departedFromLane(db!, kid, CHILD_ENTRY)).toBe(true);
      // …and never the fan-out station's station-order successor ('merge').
      expect(departedFromLane(db!, kid, 'merge')).toBe(false);
    }
  });
});

// ===========================================================================
// AC6 (gate + fan-out) — a station that declares BOTH a `check` gate AND
//        `fan_out` must STILL route the parent through FAN_OUT after the gate
//        passes. The gate's pass branch must not short-circuit to the parent's
//        station-order successor (`merge`) and skip the fan-out entirely.
//
// Why this case exists: the reference flow's `plan` station declares both a
// gate `check` AND `fan_out: 3` — gate-then-fan-out is a SUPPORTED shape, not a
// config error. So the fix is NOT "reject fan_out + check at load" (that would
// reject the reference flow); the gate `pass` path in runExecutor must detect a
// fan-out station and route via FAN_OUT (→ awaiting_children, lane unchanged)
// instead of INTEGRITY_PASS (→ station-order successor).
//
// Probe (amy-1) showed: gate_verdict(pass) → parent advanced plan→merge→done,
// status=complete, ZERO children. AC6 requires FAN_OUT → awaiting_children.
// ===========================================================================

const CRITIC_MODEL = 'gpt-4o';

/**
 * A fan-out flow whose `plan` station ALSO has a gate `check` (mirrors the
 * reference flow's plan). The critic uses a DISTINCT model id so the stub
 * adapter can tell the transform worker call apart from the gate-critic call.
 */
function setupGatedFanOutFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'plan.md'), 'Propose the child decomposition.');
  writeFileSync(join(dir, 'prompts', 'plan-critic.md'), 'Judge the decomposition; reply pass or reject.');

  const flowYaml = `
flow: executor-fanout-gated
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
    check:
      kind: gate
      critic:
        role: plan-critic
        model: ${CRITIC_MODEL}
        prompt_file: prompts/plan-critic.md
        prompt_version: "1"
      on_reject: plan
      rework_cap: 3
    fan_out: 2
    child_entry: cwork
    child_terminal: done
    resume_at: merge
    next: merge
  - id: cwork
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: merge
    worker: { kind: deterministic, command: "true" }
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) {
    throw new Error(`gated fan-out fixture invalid: ${JSON.stringify(loaded.errors)}`);
  }
  return loaded.flow;
}

/**
 * Stub adapter for the gated flow: the gate-critic call (model=CRITIC_MODEL)
 * returns a PASS verdict; every other call (the transform worker) returns the
 * proposal. A passing gate is the precise trigger for the bypass bug.
 */
function makeGatedProposalAdapter(proposal: unknown): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      const text =
        req.model === CRITIC_MODEL
          ? JSON.stringify({ verdict: 'pass', findings: [] })
          : JSON.stringify(proposal);
      return { text, inputTokens: 10, outputTokens: 6, costUsd: 0.002 };
    },
  };
}

/** Drive the real runExecutor over the GATED fan-out flow with the given proposal. */
async function runGatedFanOut(proposal: unknown): Promise<void> {
  const flow = setupGatedFanOutFlow(projectDir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
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
  const { io } = makeIO();
  await runExecutor({
    db,
    flow,
    now: SECONDS(1000),
    adapter: makeGatedProposalAdapter(proposal),
    io,
  } as RunEngineArgs);
}

/** True iff the parent's card_log records a passing gate_verdict (the gate ran and passed). */
function gatePassed(database: ConduitDB, cardId: string): boolean {
  return database
    .getCardLog(cardId)
    .some((e) => e.kind === 'gate_verdict' && e.verdict === 'pass');
}

describe('runExecutor fan-out — gate pass still routes via FAN_OUT, not station order (AC6, gated)', () => {
  it('transitions the parent to awaiting_children even after the gate passes (no bypass to merge)', async () => {
    await runGatedFanOut(validProposal);

    const parent = db!.getCard(DEFAULT_RUN_ID, PARENT_ID);

    // The gate actually ran and PASSED — so this exercises the gate+fan_out path,
    // not the plain no-gate fan-out path (guards against a vacuous test).
    expect(gatePassed(db!, PARENT_ID)).toBe(true);

    // FAN_OUT semantics must STILL win: done_pending_ack → awaiting_children,
    // lane unchanged. The gate-pass branch must NOT have advanced via
    // INTEGRITY_PASS to the station-order successor.
    expect(parent?.status).toBe('awaiting_children');
    expect(parent?.lane).toBe(FANOUT_STATION);
    expect(parent?.lane).not.toBe('merge');
    expect(parent?.lane).not.toBe('done');
    expect(parent?.status).not.toBe('complete');
  });

  it('still seeds the N children at child_entry after a passing gate', async () => {
    await runGatedFanOut(validProposal);

    const kids = childIds(db!, PARENT_ID);
    // The whole point: a passing gate must not swallow the fan-out — children
    // are still seeded and routed to child_entry, never to the station-order
    // successor (merge).
    expect(kids).toEqual(['c1', 'c2']);
    for (const kid of kids) {
      expect(departedFromLane(db!, kid, CHILD_ENTRY)).toBe(true);
      expect(departedFromLane(db!, kid, 'merge')).toBe(false);
    }
  });
});

// ===========================================================================
// Issues #73 and #124 — owned_paths resolve against the run's project root,
// not the kernel's cwd, and must stay inside it.
// ===========================================================================

describe('runExecutor fan-out — owned_paths resolve against and stay inside the project root (#73, #124)', () => {
  let elsewhere: string;

  beforeEach(() => {
    elsewhere = mkdtempSync(join(tmpdir(), 'conduit-fanout-cwd-'));
  });

  afterEach(() => {
    rmSync(elsewhere, { recursive: true, force: true });
  });

  /** The terminal reason the parent was held with. */
  function holdReason(): string | undefined {
    return db!
      .getCardLog(PARENT_ID)
      .filter((e) => e.kind === 'terminal')
      .map((e) => e.reason ?? '')
      .at(-1);
  }

  it('seeds relative child dirs under the project root when the kernel runs from another cwd', async () => {
    mkdirSync(join(projectDir, 'evidence', 'c1'), { recursive: true });
    mkdirSync(join(projectDir, 'evidence', 'c2'), { recursive: true });
    const flowRoot = projectDir;
    process.chdir(elsewhere);
    try {
      await runFanOut(
        {
          children: [
            { id: 'c1', depends_on: [], owned_paths: ['evidence/c1'], seed: { n: 1 } },
            { id: 'c2', depends_on: [], owned_paths: ['evidence/c2'], seed: { n: 2 } },
          ],
        },
        { projectRoot: flowRoot },
      );
    } finally {
      // Back to the per-test project dir before this describe's afterEach
      // removes `elsewhere`; the file-level afterEach then restores originalCwd.
      process.chdir(projectDir);
    }

    expect(childIds(db!, PARENT_ID)).toEqual(['c1', 'c2']);
    expect(JSON.parse(readFileSync(join(flowRoot, 'evidence', 'c2', 'seed.json'), 'utf8'))).toEqual({ n: 2 });
    expect(existsSync(join(elsewhere, 'evidence'))).toBe(false);
  });

  it.each([
    ['a `..` escape', (outside: string) => join('..', basename(outside))],
    ['an absolute path outside the root', (outside: string) => outside],
  ])('holds the parent, seeds nothing and names the path for %s', async (_label, pathFor) => {
    const target = pathFor(elsewhere);

    // An explicit project root, so the `..` spelling escapes projectDir
    // whatever the cwd is (the executor defaults projectRoot to resolve('.')).
    await runFanOut(
      { children: [{ id: 'c1', depends_on: [], owned_paths: [target], seed: { evil: true } }] },
      { projectRoot: projectDir },
    );

    expect(childIds(db!, PARENT_ID)).toEqual([]);
    expect(db!.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
    expect(holdReason()).toBe(
      `fan-out station 'plan' proposal rejected: owned_path_out_of_bounds (child 'c1', path '${target}')`,
    );
    expect(existsSync(join(elsewhere, 'seed.json'))).toBe(false);
  });

  it('holds the parent and names the child and path when a seeded child has no owned dir', async () => {
    await runFanOut(
      { children: [{ id: 'c1', depends_on: [], owned_paths: ['evidence/missing'], seed: { n: 1 } }] },
      { projectRoot: projectDir },
    );

    expect(childIds(db!, PARENT_ID)).toEqual([]);
    expect(db!.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
    expect(holdReason()).toBe(
      `fan-out station 'plan' proposal rejected: seed_path_out_of_bounds (child 'c1', path 'evidence/missing')`,
    );
  });

  it('holds the parent and names both children when two seeded children share a seed dir', async () => {
    mkdirSync(join(projectDir, 'evidence', 'shared'), { recursive: true });

    await runFanOut(
      {
        children: [
          { id: 'c1', depends_on: [], owned_paths: ['evidence/shared'], seed: { n: 1 } },
          { id: 'c2', depends_on: ['c1'], owned_paths: ['./evidence/shared'], seed: { n: 2 } },
        ],
      },
      { projectRoot: projectDir },
    );

    expect(childIds(db!, PARENT_ID)).toEqual([]);
    expect(db!.getCard(DEFAULT_RUN_ID, PARENT_ID)?.status).toBe('held');
    expect(holdReason()).toBe(
      `fan-out station 'plan' proposal rejected: seed_path_conflict (children 'c1' and 'c2', path './evidence/shared')`,
    );
    expect(existsSync(join(projectDir, 'evidence', 'shared', 'seed.json'))).toBe(false);
  });

  it('holds the parent for a symlink inside the root that points outside it', async () => {
    symlinkSync(elsewhere, join(projectDir, 'escape'));

    await runFanOut(
      { children: [{ id: 'c1', depends_on: [], owned_paths: ['escape'], seed: { evil: true } }] },
      { projectRoot: projectDir },
    );

    expect(childIds(db!, PARENT_ID)).toEqual([]);
    expect(holdReason()).toContain('owned_path_out_of_bounds');
    expect(existsSync(join(elsewhere, 'seed.json'))).toBe(false);
  });
});
