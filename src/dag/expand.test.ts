/**
 * Tests for dynamic fan-out / fan-in + dependency-wave validation (WI-302).
 *
 * SPEC §9 (dynamic DAG + waving), SPEC §6 (fan-in policy), FR-5. The Architect
 * (a transform, WI-296) PROPOSES a decomposition; the kernel validation here is
 * DETERMINISTIC:
 *
 *   - DFS cycle detection over depends_on — REUSING findCycleNodes from WI-292
 *     (src/flow/dag-utils.ts); a cyclic proposal is rejected before any child
 *     is committed.
 *   - Categorisation into ready (all deps in a terminal lane) vs waiting; waves
 *     emerge as deps reach terminal lanes.
 *   - Disjoint-ownership invariant (rev-1 H4): concurrently-eligible children
 *     with overlapping owned_paths are rejected OR serialised via a forced
 *     depends_on edge.
 *   - Fan-in policy all | quorum(k as ratio 0.0–1.0) | best_effort against the
 *     children that reached terminal lanes; proceeds without deadlock when a
 *     child can never complete (the liveness watchdog is the backstop).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/dag/expand.ts
 * ---------------------------------------------------------------------------
 *
 *   export interface ProposedChild { id: string; depends_on: string[]; owned_paths: string[] }
 *   export interface ArchitectProposal { children: ProposedChild[] }
 *   export interface ValidatedChild { id: string; depends_on: string[]; owned_paths: string[] }
 *   export interface ExpandOptions { onPathConflict: 'reject' | 'serialize' }
 *
 *   export type ExpansionError =
 *     | { code: 'dependency_cycle'; cycle: string[] }
 *     | { code: 'overlapping_owned_paths'; stations: [string, string]; path: string };
 *   export type ExpansionResult =
 *     | { ok: true; children: ValidatedChild[]; forcedEdges: Array<{ from: string; to: string }> }
 *     | { ok: false; error: ExpansionError };
 *
 *   // PURE deterministic validation (cycle + disjoint-ownership). REUSE findCycleNodes.
 *   export function validateExpansion(proposal: ArchitectProposal, opts: ExpandOptions): ExpansionResult;
 *
 *   // Validate then persist child cards via ConduitDB (parent_id set, status 'waiting').
 *   // Commits NOTHING when validation fails.
 *   export function commitFanOut(
 *     db: ConduitDB, parentId: string, proposal: ArchitectProposal, opts: ExpandOptions,
 *   ): ExpansionResult;
 *
 *   // PURE categorisation. laneOf(depId) → the dep's current lane (or null if unknown).
 *   export function categorize(
 *     children: ValidatedChild[], laneOf: (id: string) => string | null, terminalLanes: readonly string[],
 *   ): { ready: string[]; waiting: string[] };
 *
 *   // PURE fan-in policy evaluation.
 *   export type FanInPolicy = { kind: 'all' } | { kind: 'quorum'; k: number } | { kind: 'best_effort' };
 *   export interface FanInState { childIds: string[]; terminalOutcomes: Array<{ id: string; lane: string }> }
 *   export type FanInDecision =
 *     | { action: 'proceed'; dropped: string[] }
 *     | { action: 'hold_parent'; reason: 'child_scrapped' | 'quorum_unmet' }
 *     | { action: 'wait' };
 *   export function evaluateFanIn(policy: FanInPolicy, state: FanInState): FanInDecision;
 *
 * NOTE (flagged): the cards table (WI-290) has no depends_on column, so the
 * depends_on graph lives in ExpansionResult.children (in-process wave state),
 * while commitFanOut persists parent_id + owned_paths via ConduitDB.insertCard.
 * REUSE findCycleNodes — do NOT reimplement a separate DFS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import {
  transition,
  type FsmState,
  type TransitionContext,
} from '../statemachine/transitions';
import {
  validateExpansion,
  commitFanOut,
  categorize,
  evaluateFanIn,
} from './expand';
import type {
  ArchitectProposal,
  ExpansionResult,
  FanInPolicy,
} from './expand';

const TERMINAL = ['done', 'scrap', 'hold'] as const;

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

function parentCard(id: string): Card {
  return { run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'intake', status: 'awaiting_children', attempt: 0, wave: 0, owned_paths: [], rework_count: 0 };
}

function expectOk(r: ExpansionResult): Extract<ExpansionResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok expansion, got error: ${JSON.stringify(r.error)}`);
  return r;
}

function expectErr(r: ExpansionResult): Extract<ExpansionResult, { ok: false }> {
  if (r.ok) throw new Error('expected expansion error, but validation succeeded');
  return r;
}

// ===========================================================================
// AC1 — fan-out creates N child cards with parent_id + depends_on edges
// ===========================================================================

describe('commitFanOut (AC1)', () => {
  const proposal: ArchitectProposal = {
    children: [
      { id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] },
      { id: 'c2', depends_on: ['c1'], owned_paths: ['out/c2.json'] },
      { id: 'c3', depends_on: ['c1'], owned_paths: ['out/c3.json'] },
    ],
  };

  it('persists N child cards with parent_id set and surfaces their depends_on edges', () => {
    db.insertCard(parentCard('epic'));

    const result = expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject' }));

    // The returned child set carries the proposed depends_on edges.
    expect(result.children.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(result.children.find((c) => c.id === 'c2')?.depends_on).toEqual(['c1']);

    // Each child is persisted with parent_id and its owned paths.
    for (const proposed of proposal.children) {
      const card = db.getCard(DEFAULT_RUN_ID, proposed.id);
      expect(card?.parent_id).toBe('epic');
      expect(card?.owned_paths).toEqual(proposed.owned_paths);
      expect(card?.status).toBe('waiting');
    }
  });
});

// ===========================================================================
// Child ids are unique within a run (issue #36: a keyed run takes several
// passes, and a later pass's fan-out may propose the ids an earlier one used)
// ===========================================================================

describe('commitFanOut child-id collision', () => {
  it('rejects a proposal reusing a child id another parent already owns, inserting nothing', () => {
    db.insertCard(parentCard('entry-pass1'));
    expectOk(
      commitFanOut(db, DEFAULT_RUN_ID, 'entry-pass1', {
        children: [{ id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] }],
      }, { onPathConflict: 'reject' }),
    );
    db.insertCard(parentCard('entry-pass2'));

    const err = expectErr(
      commitFanOut(db, DEFAULT_RUN_ID, 'entry-pass2', {
        children: [
          { id: 'c0', depends_on: [], owned_paths: ['out/c0.json'] },
          { id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] },
        ],
      }, { onPathConflict: 'reject' }),
    );

    expect(err.error).toEqual({ code: 'child_id_collision', child: 'c1', owner: 'entry-pass1' });
    expect(db.getCard(DEFAULT_RUN_ID, 'c0')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')!.parent_id).toBe('entry-pass1');
  });

  it('rejects a child id equal to an existing root card', () => {
    db.insertCard(parentCard('entry-pass1'));
    db.insertCard(parentCard('entry-pass2'));
    const err = expectErr(
      commitFanOut(db, DEFAULT_RUN_ID, 'entry-pass2', {
        children: [{ id: 'entry-pass1', depends_on: [], owned_paths: ['out/x.json'] }],
      }, { onPathConflict: 'reject' }),
    );
    expect(err.error.code).toBe('child_id_collision');
  });

  it('allows the same child id in a different run', () => {
    db.insertCard({ ...parentCard('p'), run_id: 'run-a' });
    db.insertCard({ ...parentCard('p'), run_id: 'run-b' });
    const proposal = { children: [{ id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] }] };
    expectOk(commitFanOut(db, 'run-a', 'p', proposal, { onPathConflict: 'reject' }));
    expectOk(commitFanOut(db, 'run-b', 'p', proposal, { onPathConflict: 'reject' }));
  });

  // PR #76 review (D) — two children in the SAME proposal sharing an id both
  // pass the per-row "does this id already own a card?" check (neither is in
  // `cards` yet), so without a dedicated check the insert throws out of the
  // tick instead of being rejected as a validation error.
  it('rejects a proposal with two children sharing an id, inserting nothing', () => {
    db.insertCard(parentCard('epic'));

    const err = expectErr(
      validateExpansion(
        {
          children: [
            { id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] },
            { id: 'c1', depends_on: [], owned_paths: ['out/c1-dup.json'] },
          ],
        },
        { onPathConflict: 'reject' },
      ),
    );
    expect(err.error).toEqual({ code: 'child_id_collision', child: 'c1', owner: null });
  });

  it('rejects via commitFanOut too, inserting no children for the self-colliding proposal', () => {
    db.insertCard(parentCard('epic'));

    const err = expectErr(
      commitFanOut(db, DEFAULT_RUN_ID, 'epic', {
        children: [
          { id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] },
          { id: 'c1', depends_on: [], owned_paths: ['out/c1-dup.json'] },
        ],
      }, { onPathConflict: 'reject' }),
    );

    expect(err.error).toEqual({ code: 'child_id_collision', child: 'c1', owner: null });
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });
});

// ===========================================================================
// AC2 — cyclic proposal rejected by DFS before any child is committed
// ===========================================================================

describe('cycle detection (AC2)', () => {
  const cyclic: ArchitectProposal = {
    children: [
      { id: 'a', depends_on: ['b'], owned_paths: ['out/a'] },
      { id: 'b', depends_on: ['a'], owned_paths: ['out/b'] },
    ],
  };

  it('rejects a proposal whose depends_on contains a cycle, naming the cycle', () => {
    const err = expectErr(validateExpansion(cyclic, { onPathConflict: 'reject' })).error;
    expect(err.code).toBe('dependency_cycle');
    if (err.code !== 'dependency_cycle') throw new Error('unreachable');
    expect(new Set(err.cycle)).toEqual(new Set(['a', 'b']));
  });

  it('commits NO child cards when the proposal is cyclic', () => {
    db.insertCard(parentCard('epic'));
    expectErr(commitFanOut(db, DEFAULT_RUN_ID, 'epic', cyclic, { onPathConflict: 'reject' }));

    expect(db.getCard(DEFAULT_RUN_ID, 'a')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'b')).toBeNull();
  });
});

// ===========================================================================
// #13 — dangling depends_on references are rejected (not silently deadlocked)
// ===========================================================================

describe('dangling depends_on detection (#13)', () => {
  it('rejects a child whose depends_on references an unknown id, naming both', () => {
    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['out/c1'] },
        { id: 'c2', depends_on: ['ghost'], owned_paths: ['out/c2'] },
      ],
    };
    const err = expectErr(validateExpansion(proposal, { onPathConflict: 'reject' })).error;
    expect(err.code).toBe('unknown_dependency');
    if (err.code !== 'unknown_dependency') throw new Error('unreachable');
    expect(err.child).toBe('c2');
    expect(err.dependency).toBe('ghost');
  });

  it('commits NO child cards when a depends_on is dangling', () => {
    db.insertCard(parentCard('epic'));
    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: ['ghost'], owned_paths: ['out/c1'] },
      ],
    };
    expectErr(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject' }));
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('accepts a proposal where every depends_on references a known child', () => {
    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['out/c1'] },
        { id: 'c2', depends_on: ['c1'], owned_paths: ['out/c2'] },
      ],
    };
    expect(validateExpansion(proposal, { onPathConflict: 'reject' }).ok).toBe(true);
  });
});

// ===========================================================================
// AC3 — categorisation: ready vs waiting; emergent waves
// ===========================================================================

describe('categorize — emergent waves (AC3)', () => {
  const children = [
    { id: 'c1', depends_on: [], owned_paths: ['out/c1'] },
    { id: 'c2', depends_on: ['c1'], owned_paths: ['out/c2'] },
  ];

  it('marks a child with no deps ready and a child with an unfinished dep waiting', () => {
    const laneOf = (id: string): string | null => (id === 'c1' ? 'render' : null); // c1 still working
    const { ready, waiting } = categorize(children, laneOf, TERMINAL);
    expect(ready).toEqual(['c1']); // no deps → ready
    expect(waiting).toEqual(['c2']); // dep c1 not yet terminal
  });

  it('unblocks the waiting child once its dependency reaches a terminal lane (emergent wave)', () => {
    const laneOf = (id: string): string | null => (id === 'c1' ? 'done' : null); // c1 now terminal
    const { ready, waiting } = categorize(children, laneOf, TERMINAL);
    expect(new Set(ready)).toEqual(new Set(['c1', 'c2']));
    expect(waiting).toEqual([]);
  });
});

// ===========================================================================
// AC4 — disjoint-ownership invariant (reject OR force serialization edge)
// ===========================================================================

describe('disjoint-ownership invariant (AC4)', () => {
  // c1 and c2 are concurrently eligible (no dependency between them) and both
  // own the same path → a conflict.
  const conflicting: ArchitectProposal = {
    children: [
      { id: 'c1', depends_on: [], owned_paths: ['shared/output.json'] },
      { id: 'c2', depends_on: [], owned_paths: ['shared/output.json'] },
    ],
  };

  it('rejects overlapping owned_paths when onPathConflict=reject, naming the two stations and the path', () => {
    const err = expectErr(validateExpansion(conflicting, { onPathConflict: 'reject' })).error;
    expect(err.code).toBe('overlapping_owned_paths');
    if (err.code !== 'overlapping_owned_paths') throw new Error('unreachable');
    expect(new Set(err.stations)).toEqual(new Set(['c1', 'c2']));
    expect(err.path).toBe('shared/output.json');
  });

  it('forces a depends_on serialization edge when onPathConflict=serialize', () => {
    const result = expectOk(validateExpansion(conflicting, { onPathConflict: 'serialize' }));
    // A forced edge now orders the two children so they are no longer concurrent.
    expect(result.forcedEdges).toHaveLength(1);
    const edge = result.forcedEdges[0];
    expect(new Set([edge.from, edge.to])).toEqual(new Set(['c1', 'c2']));
    // The serialised child carries the new depends_on edge.
    const dependant = result.children.find((c) => c.id === edge.from);
    expect(dependant?.depends_on).toContain(edge.to);
  });

  it('does NOT flag an overlap when the two children are already ordered by depends_on', () => {
    const ordered: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['shared/output.json'] },
        { id: 'c2', depends_on: ['c1'], owned_paths: ['shared/output.json'] }, // serialised already
      ],
    };
    // Not concurrently eligible → no conflict.
    expect(validateExpansion(ordered, { onPathConflict: 'reject' }).ok).toBe(true);
  });
});

// ===========================================================================
// AC5 / AC6 — fan-in policy evaluation
// ===========================================================================

describe('evaluateFanIn — policy=all (AC5)', () => {
  it('holds the parent when any child scrapped (all children terminal)', () => {
    const state = { childIds: ['a', 'b'], terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'scrap' }] };
    expect(evaluateFanIn({ kind: 'all' }, state)).toEqual({ action: 'hold_parent', reason: 'child_scrapped' });
  });

  it('proceeds when all children reached a non-scrap terminal lane', () => {
    const state = { childIds: ['a', 'b'], terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'done' }] };
    expect(evaluateFanIn({ kind: 'all' }, state)).toEqual({ action: 'proceed', dropped: [] });
  });

  it('waits while not all children are terminal yet', () => {
    const state = { childIds: ['a', 'b'], terminalOutcomes: [{ id: 'a', lane: 'done' }] };
    expect(evaluateFanIn({ kind: 'all' }, state)).toEqual({ action: 'wait' });
  });
});

describe('evaluateFanIn — policy=quorum(k count) (AC5, AC6)', () => {
  const quorum: FanInPolicy = { kind: 'quorum', k: 2 }; // 2-of-3 (matches reference fixture, COUNT)

  it('proceeds when survivorCount >= k (k is a COUNT, not a ratio)', () => {
    // k=2 of 3 survivors → proceed. (A ratio interpretation would treat k=2 as
    // 200% and never be satisfiable — finding #4.)
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'done' }, { id: 'c', lane: 'done' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'proceed', dropped: [] });
  });

  it('holds the parent (quorum_unmet) when only 1 of the required 2 survives', () => {
    // k=2, a single survivor and the rest terminal → quorum impossible.
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'scrap' }, { id: 'c', lane: 'scrap' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'hold_parent', reason: 'quorum_unmet' });
  });

  it('holds the parent (quorum_unmet) when k=2 but only 1 child survives total', () => {
    const state = {
      childIds: ['only'],
      terminalOutcomes: [{ id: 'only', lane: 'done' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'hold_parent', reason: 'quorum_unmet' });
  });

  it('proceeds and records dropped children when ≥k reached a non-scrap terminal lane', () => {
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'done' }, { id: 'c', lane: 'scrap' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'proceed', dropped: ['c'] });
  });

  it('proceeds WITHOUT deadlock when a child can never complete (it is recorded as dropped) (AC6)', () => {
    // c never reaches a terminal lane — but a + b already satisfy quorum.
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'done' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'proceed', dropped: ['c'] });
  });

  it('waits when quorum is not yet met but still reachable by in-flight children', () => {
    // 1 done, 1 scrapped, 1 still in-flight → could still reach 2/3.
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'scrap' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'wait' });
  });

  it('holds the parent when quorum is impossible to reach', () => {
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'scrap' }, { id: 'c', lane: 'scrap' }],
    };
    expect(evaluateFanIn(quorum, state)).toEqual({ action: 'hold_parent', reason: 'quorum_unmet' });
  });
});

describe('evaluateFanIn — policy=best_effort', () => {
  it('proceeds with the survivors and records the scrapped children as dropped', () => {
    const state = {
      childIds: ['a', 'b', 'c'],
      terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'done' }, { id: 'c', lane: 'scrap' }],
    };
    expect(evaluateFanIn({ kind: 'best_effort' }, state)).toEqual({ action: 'proceed', dropped: ['c'] });
  });
});

// ===========================================================================
// #5 — empty children is a defined no-op (no NaN, consistent across policies)
// ===========================================================================

describe('evaluateFanIn — empty children (#5)', () => {
  const empty = { childIds: [], terminalOutcomes: [] };

  it('proceeds with no dropped children under quorum (no divide-by-zero)', () => {
    expect(evaluateFanIn({ kind: 'quorum', k: 2 }, empty)).toEqual({ action: 'proceed', dropped: [] });
  });

  it('proceeds with no dropped children under all (matching quorum)', () => {
    expect(evaluateFanIn({ kind: 'all' }, empty)).toEqual({ action: 'proceed', dropped: [] });
  });

  it('proceeds with no dropped children under best_effort', () => {
    expect(evaluateFanIn({ kind: 'best_effort' }, empty)).toEqual({ action: 'proceed', dropped: [] });
  });
});

// ===========================================================================
// FSM integration (WI-293) — a fan-in "proceed" promotes the awaiting parent.
// ===========================================================================

describe('fan-in proceed ↔ FSM FAN_IN_MET (AC5)', () => {
  const ctx: TransitionContext = {
    happyPathNext: { assemble: null },
    terminalLanes: ['done', 'scrap', 'hold'],
    reworkCap: 3,
    maxExecutionAttempts: 5,
    capPolicy: 'scrap',
    onDepScrap: 'hold',
    validBackEdges: [],
  };

  it('a proceed decision corresponds to FAN_IN_MET promoting awaiting_children → ready', () => {
    const decision = evaluateFanIn(
      { kind: 'quorum', k: 2 },
      { childIds: ['a', 'b', 'c'], terminalOutcomes: [{ id: 'a', lane: 'done' }, { id: 'b', lane: 'done' }] },
    );
    expect(decision.action).toBe('proceed');

    const parent: FsmState = { lane: 'assemble', status: 'awaiting_children', executionAttempt: 0, reworkCount: 0 };
    const result = transition(parent, { type: 'FAN_IN_MET' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected legal transition');
    expect(result.next.status).toBe('ready');
  });
});
