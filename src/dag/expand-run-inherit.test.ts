/**
 * Tests for fan-out run_id inheritance (WI-478).
 *
 * When commitFanOut seeds child cards, each child must carry its parent's run_id —
 * not the DEFAULT_RUN_ID sentinel. This is the foundational isolation guarantee:
 * children are scoped to the same run as their parent, so two runs of the same
 * flow can each fan out children named 'p01' without a primary-key collision.
 *
 * AC-1: commitFanOut stamps every child with parent.run_id (not DEFAULT_RUN_ID)
 * AC-2: two runs fan-out same-named children — no PK collision, each child
 *        carries its own run's id
 * AC-3: child's run_id is persisted at insert time (read from its own row, not
 *        by walking parent_id ancestry — parent row can be absent)
 * AC-4: back-compat regression — fan-out under DEFAULT_RUN_ID still works
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Card } from '../types/kernel';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import { commitFanOut } from './expand';
import type { ArchitectProposal } from './expand';

/**
 * The project root commitFanOut confines owned_paths to; these proposals use
 * relative paths. A fresh dir per test, so nothing left in the shared temp
 * root can change how a path canonicalizes.
 */
let FANOUT_PROJECT_ROOT: string;

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  FANOUT_PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'conduit-fanout-'));
});

afterEach(() => {
  db.close();
  rmSync(FANOUT_PROJECT_ROOT, { recursive: true, force: true });
});

function makeParent(id: string, runId: string): Card {
  return {
    run_id: runId,
    id,
    parent_id: null,
    lane: 'intake',
    status: 'awaiting_children',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  };
}

const simpleProposal: ArchitectProposal = {
  children: [
    { id: 'p01', depends_on: [], owned_paths: ['out/p01.json'] },
    { id: 'p02', depends_on: [], owned_paths: ['out/p02.json'] },
  ],
};

// ---------------------------------------------------------------------------
// AC-1: commitFanOut stamps children with parent.run_id, not DEFAULT_RUN_ID.
// ---------------------------------------------------------------------------

describe('WI-478 AC-1: children inherit parent run_id at creation', () => {
  it('each child card carries its parent run_id after commitFanOut', () => {
    const parentRunId = 'run-abc-123';
    db.insertCard(makeParent('epic-A', parentRunId));

    const result = commitFanOut(db, parentRunId, 'epic-A', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });
    expect(result.ok).toBe(true);

    for (const child of simpleProposal.children) {
      const row = db.getCard(parentRunId, child.id);
      expect(row).not.toBeNull();
      expect(row!.run_id).toBe(parentRunId);
    }
  });

  it('children do NOT carry DEFAULT_RUN_ID when parent is in a non-default run', () => {
    const parentRunId = 'run-custom-xyz';
    db.insertCard(makeParent('epic-B', parentRunId));

    commitFanOut(db, parentRunId, 'epic-B', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    for (const child of simpleProposal.children) {
      const row = db.getCard(parentRunId, child.id);
      expect(row!.run_id).not.toBe(DEFAULT_RUN_ID);
      expect(row!.run_id).toBe(parentRunId);
    }
  });

  it('all children in a fan-out share the same run_id as their parent', () => {
    const parentRunId = 'run-multi-child';
    const proposal: ArchitectProposal = {
      children: [
        { id: 'child-1', depends_on: [], owned_paths: ['out/child-1.json'] },
        { id: 'child-2', depends_on: ['child-1'], owned_paths: ['out/child-2.json'] },
        { id: 'child-3', depends_on: ['child-1'], owned_paths: ['out/child-3.json'] },
      ],
    };
    db.insertCard(makeParent('epic-C', parentRunId));

    commitFanOut(db, parentRunId, 'epic-C', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    for (const child of proposal.children) {
      expect(db.getCard(parentRunId, child.id)!.run_id).toBe(parentRunId);
    }
  });

  it('child parent_id is still the parent card id (run_id inheritance does not break parent_id)', () => {
    const parentRunId = 'run-parent-id-check';
    db.insertCard(makeParent('epic-D', parentRunId));

    commitFanOut(db, parentRunId, 'epic-D', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    for (const child of simpleProposal.children) {
      const row = db.getCard(parentRunId, child.id);
      expect(row!.parent_id).toBe('epic-D');
      expect(row!.run_id).toBe(parentRunId);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: two runs fan-out same-named children — no collision.
// ---------------------------------------------------------------------------

describe('WI-478 AC-2: same-named children in two runs coexist without collision', () => {
  it('run A and run B can both fan-out a child named p01 without PK error', () => {
    const runA = 'run-A';
    const runB = 'run-B';

    db.insertCard(makeParent('epic', runA));
    db.insertCard(makeParent('epic', runB));

    const proposal: ArchitectProposal = {
      children: [{ id: 'p01', depends_on: [], owned_paths: ['out/p01.json'] }],
    };

    expect(() => commitFanOut(db, runA, 'epic', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT })).not.toThrow();
    expect(() => commitFanOut(db, runB, 'epic', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT })).not.toThrow();
  });

  it("run A's p01 and run B's p01 are distinct rows carrying their respective run_ids", () => {
    const runA = 'run-A';
    const runB = 'run-B';

    db.insertCard(makeParent('epic', runA));
    db.insertCard(makeParent('epic', runB));

    const proposal: ArchitectProposal = {
      children: [{ id: 'p01', depends_on: [], owned_paths: ['out/p01.json'] }],
    };

    commitFanOut(db, runA, 'epic', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });
    commitFanOut(db, runB, 'epic', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    const rowA = db.getCard(runA, 'p01');
    const rowB = db.getCard(runB, 'p01');

    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    expect(rowA!.run_id).toBe(runA);
    expect(rowB!.run_id).toBe(runB);
    // They are distinct rows — different run_ids
    expect(rowA!.run_id).not.toBe(rowB!.run_id);
  });

  it('multiple children with the same ids across two runs all coexist as distinct rows', () => {
    const runA = 'run-X';
    const runB = 'run-Y';

    db.insertCard(makeParent('parent', runA));
    db.insertCard(makeParent('parent', runB));

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] },
        { id: 'c2', depends_on: ['c1'], owned_paths: ['out/c2.json'] },
      ],
    };

    commitFanOut(db, runA, 'parent', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });
    commitFanOut(db, runB, 'parent', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    for (const child of proposal.children) {
      expect(db.getCard(runA, child.id)!.run_id).toBe(runA);
      expect(db.getCard(runB, child.id)!.run_id).toBe(runB);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: run_id is read from the child's own persisted row (not by ancestry walk).
// ---------------------------------------------------------------------------

describe('WI-478 AC-3: child run_id is persisted on its own row (not derived from parent)', () => {
  it("child's run_id is accessible via getCard(runId, childId) without a parent row present", () => {
    const parentRunId = 'run-direct';
    db.insertCard(makeParent('epic-E', parentRunId));

    commitFanOut(db, parentRunId, 'epic-E', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    // Delete the parent row from the DB directly, simulating parent row removal.
    const stateDb = db.getStateDb();
    stateDb.prepare("DELETE FROM cards WHERE id = 'epic-E' AND run_id = $run_id")
      .run({ $run_id: parentRunId });

    // Parent is gone — but child's run_id is still on its own row.
    const child = db.getCard(parentRunId, 'p01');
    expect(child).not.toBeNull();
    expect(child!.run_id).toBe(parentRunId);
  });

  it('child run_id is present on the raw DB row (not a computed/derived field)', () => {
    const parentRunId = 'run-raw';
    db.insertCard(makeParent('epic-F', parentRunId));

    commitFanOut(db, parentRunId, 'epic-F', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    // Verify via raw stateDb query — not via the getCard accessor.
    const stateDb = db.getStateDb();
    const rawRow = stateDb
      .prepare("SELECT run_id FROM cards WHERE id = 'p01' AND run_id = $run_id")
      .get({ $run_id: parentRunId }) as { run_id: string } | undefined;

    expect(rawRow).not.toBeUndefined();
    expect(rawRow!.run_id).toBe(parentRunId);
  });
});

// ---------------------------------------------------------------------------
// AC-4: back-compat regression — fan-out under DEFAULT_RUN_ID still works.
// ---------------------------------------------------------------------------

describe('WI-478 AC-4: back-compat — fan-out under DEFAULT_RUN_ID unchanged', () => {
  it('children of a parent in DEFAULT_RUN_ID are stamped with DEFAULT_RUN_ID', () => {
    db.insertCard(makeParent('epic-default', DEFAULT_RUN_ID));

    commitFanOut(db, DEFAULT_RUN_ID, 'epic-default', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    for (const child of simpleProposal.children) {
      const row = db.getCard(DEFAULT_RUN_ID, child.id);
      expect(row).not.toBeNull();
      expect(row!.run_id).toBe(DEFAULT_RUN_ID);
    }
  });

  it('existing single-run fan-out test: idempotent re-call returns existing children without error', () => {
    db.insertCard(makeParent('epic-idem', DEFAULT_RUN_ID));

    const r1 = commitFanOut(db, DEFAULT_RUN_ID, 'epic-idem', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });
    const r2 = commitFanOut(db, DEFAULT_RUN_ID, 'epic-idem', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Only one row per child exists — no duplicates from the idempotent re-call.
    for (const child of simpleProposal.children) {
      expect(db.getCard(DEFAULT_RUN_ID, child.id)).not.toBeNull();
    }
  });

  it('children status and lane are correct after DEFAULT_RUN_ID fan-out', () => {
    db.insertCard(makeParent('epic-status', DEFAULT_RUN_ID));

    commitFanOut(db, DEFAULT_RUN_ID, 'epic-status', simpleProposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });

    for (const child of simpleProposal.children) {
      const row = db.getCard(DEFAULT_RUN_ID, child.id);
      expect(row!.status).toBe('waiting');
      expect(row!.lane).toBe('intake');
    }
  });
});
