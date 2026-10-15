/**
 * Per-child seed materialization in commitFanOut (WI-464, resolves the original CLI adapter-validation work).
 *
 * The correctness unlock for fan-out: instead of N stochastic variants of one
 * shared input, each ProposedChild may carry a DISTINCT `seed` (a JSON-
 * serializable params blob). commitFanOut writes that seed to the child's owned
 * directory as seed.json, atomically with the child's insertCard — inside the
 * SAME stateDb.transaction().
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/dag/expand.ts
 * ---------------------------------------------------------------------------
 *
 *   export interface ProposedChild {
 *     id: string;
 *     depends_on: string[];
 *     owned_paths: string[];
 *     seed?: unknown;            // NEW (WI-464) — optional, default-off
 *   }
 *
 *   // commitFanOut, when a child carries a seed, writes
 *   //   <firstEntryOf(child.owned_paths)>/seed.json
 *   // treating that first entry as a DIRECTORY, with the file written INSIDE it
 *   // (NOT by treating the owned_path itself as the seed file). The content is
 *   // JSON.stringify(seed, null, 2). The write happens inside the SAME
 *   // stateDb.transaction() as the insertCard calls (all-or-nothing).
 *   //
 *   // A child whose seed.json would resolve OUTSIDE its declared owned_paths is
 *   // rejected (nothing written, nothing inserted) rather than silently writing
 *   // out of bounds.
 *
 * Design note: these tests resolve owned_paths as ABSOLUTE paths under a fresh
 * temp dir, so the seed location is deterministic and self-contained — matching
 * the integrity hook's convention that owned_paths may be absolute (src/worker/
 * integrity.ts toAbsolute). Children without a seed exercise the default-off
 * path and must commit exactly as before (parity with expand.test.ts AC1).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { commitFanOut } from './expand';
import type { ArchitectProposal, ExpansionResult } from './expand';

let db: ConduitDB;
let root: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  root = mkdtempSync(join(tmpdir(), 'conduit-seed-'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function parentCard(id: string): Card {
  return { run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'intake', status: 'awaiting_children',
    attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
  };
}

function expectOk(r: ExpansionResult): Extract<ExpansionResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok expansion, got error: ${JSON.stringify(r.error)}`);
  return r;
}

function expectErr(r: ExpansionResult): Extract<ExpansionResult, { ok: false }> {
  if (r.ok) throw new Error('expected expansion error, but validation succeeded');
  return r;
}

/** Make a child-owned directory under the temp root and return its absolute path. */
function ownedDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the seed.json the contract writes inside an owned dir. */
function seedFileIn(dir: string): string {
  return join(dir, 'seed.json');
}

// ===========================================================================
// AC1 — `seed` is optional; proposals with no seed validate and commit
//        unchanged (default-off). No seed.json is written.
// ===========================================================================

describe('default-off: proposals without a seed commit unchanged (AC1)', () => {
  it('commits every child and writes NO seed.json when no child carries a seed', () => {
    db.insertCard(parentCard('epic'));
    const dirA = ownedDir('a');
    const dirB = ownedDir('b');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [dirA] },
        { id: 'c2', depends_on: ['c1'], owned_paths: [dirB] },
      ],
    };

    const result = expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // Children persisted exactly as the pre-seed contract (parity with expand.test.ts AC1).
    expect(result.children.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.parent_id).toBe('epic');
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.status).toBe('waiting');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.parent_id).toBe('epic');

    // No seed → no file materialized in either owned dir.
    expect(existsSync(seedFileIn(dirA))).toBe(false);
    expect(existsSync(seedFileIn(dirB))).toBe(false);
  });

  it('commits a mixed proposal where only SOME children carry a seed', () => {
    db.insertCard(parentCard('epic'));
    const dirSeeded = ownedDir('seeded');
    const dirBare = ownedDir('bare');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'seeded', depends_on: [], owned_paths: [dirSeeded], seed: { variant: 'A' } },
        { id: 'bare', depends_on: [], owned_paths: [dirBare] },
      ],
    };

    expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // Seeded child gets a seed.json; the bare child gets none.
    expect(existsSync(seedFileIn(dirSeeded))).toBe(true);
    expect(existsSync(seedFileIn(dirBare))).toBe(false);
    expect(JSON.parse(readFileSync(seedFileIn(dirSeeded), 'utf-8'))).toEqual({ variant: 'A' });
  });
});

// ===========================================================================
// AC2 — each child with a distinct seed gets a seed.json containing ITS seed.
// ===========================================================================

describe('distinct per-child seeds are materialized (AC2)', () => {
  it('writes each child its own seed.json with that child\'s exact seed content', () => {
    db.insertCard(parentCard('epic'));
    const dir1 = ownedDir('child1');
    const dir2 = ownedDir('child2');
    const dir3 = ownedDir('child3');

    const seed1 = { angle: 'controversy', hook: 'stop scrolling' };
    const seed2 = { angle: 'tutorial', hook: 'in 3 steps' };
    const seed3 = { angle: 'duet', hook: 'react to this' };

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [dir1], seed: seed1 },
        { id: 'c2', depends_on: [], owned_paths: [dir2], seed: seed2 },
        { id: 'c3', depends_on: [], owned_paths: [dir3], seed: seed3 },
      ],
    };

    expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // Each child's seed is materialized in ITS OWN dir — distinct, not shared.
    expect(JSON.parse(readFileSync(seedFileIn(dir1), 'utf-8'))).toEqual(seed1);
    expect(JSON.parse(readFileSync(seedFileIn(dir2), 'utf-8'))).toEqual(seed2);
    expect(JSON.parse(readFileSync(seedFileIn(dir3), 'utf-8'))).toEqual(seed3);
  });

  it('materializes a primitive seed value (not just objects)', () => {
    db.insertCard(parentCard('epic'));
    const dir1 = ownedDir('p1');
    const dir2 = ownedDir('p2');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [dir1], seed: 'variant-7' },
        { id: 'c2', depends_on: [], owned_paths: [dir2], seed: 42 },
      ],
    };

    expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    expect(JSON.parse(readFileSync(seedFileIn(dir1), 'utf-8'))).toBe('variant-7');
    expect(JSON.parse(readFileSync(seedFileIn(dir2), 'utf-8'))).toBe(42);
  });
});

// ===========================================================================
// AC3 — seed is written at <first-owned-paths-entry>/seed.json, treating the
//        FIRST entry as a DIRECTORY (file inside it), pretty-printed with 2
//        spaces. NOT written by treating the owned_path itself as the file.
// ===========================================================================

describe('seed materialized at <firstOwnedDir>/seed.json (AC3)', () => {
  it('writes seed.json INSIDE the first owned_paths entry, not at the entry itself', () => {
    db.insertCard(parentCard('epic'));
    const firstDir = ownedDir('first');
    const secondDir = ownedDir('second');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [firstDir, secondDir], seed: { k: 'v' } },
      ],
    };

    expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // The seed file is the directory's CHILD named seed.json...
    expect(existsSync(join(firstDir, 'seed.json'))).toBe(true);
    // ...the owned_path entry is still a directory, not clobbered into a file.
    expect(existsSync(firstDir)).toBe(true);
    // ...and the SECOND owned path is never used for the seed.
    expect(existsSync(join(secondDir, 'seed.json'))).toBe(false);
  });

  it('serializes the seed with JSON.stringify(seed, null, 2) (2-space pretty print)', () => {
    db.insertCard(parentCard('epic'));
    const dir = ownedDir('pretty');
    const seed = { angle: 'controversy', tags: ['a', 'b'] };

    const proposal: ArchitectProposal = {
      children: [{ id: 'c1', depends_on: [], owned_paths: [dir], seed }],
    };

    expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    const raw = readFileSync(seedFileIn(dir), 'utf-8');
    expect(raw).toBe(JSON.stringify(seed, null, 2));
    // Pretty-printed, not minified.
    expect(raw).toContain('\n');
  });
});

// ===========================================================================
// AC4 — atomic: seed write is inside the SAME transaction as insertCard. A
//        mid-loop insert failure leaves NO child rows AND NO seed.json.
// ===========================================================================

describe('atomicity: seed write shares the insert transaction (AC4)', () => {
  it('rolls back BOTH child rows and seed.json when an insert throws mid-loop', () => {
    db.insertCard(parentCard('epic'));
    const dir1 = ownedDir('atom1');
    const dir2 = ownedDir('atom2');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [dir1], seed: { n: 1 } },
        { id: 'c2', depends_on: [], owned_paths: [dir2], seed: { n: 2 } },
      ],
    };

    // Inject a crash on the SECOND child insert. With a shared transaction, the
    // first child's row AND its seed.json must both roll back.
    const realInsert = db.insertCard.bind(db);
    let inserts = 0;
    const spy = spyOn(db, 'insertCard').mockImplementation((card) => {
      inserts += 1;
      if (inserts === 2) throw new Error('crash: mid fan-out seed materialization');
      return realInsert(card);
    });

    expect(() => commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root })).toThrow(
      /mid fan-out/,
    );
    spy.mockRestore();

    // No partial child rows survived.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')).toBeNull();

    // No partial seed.json survived — the first child's seed must NOT be on disk,
    // because the transaction that would have committed it was rolled back.
    expect(existsSync(seedFileIn(dir1))).toBe(false);
    expect(existsSync(seedFileIn(dir2))).toBe(false);
  });
});

// ===========================================================================
// AC5 — idempotency guard preserved: when children already exist for the
//        parent, commitFanOut returns WITHOUT rewriting seed files or
//        re-inserting.
// ===========================================================================

describe('idempotency: existing children short-circuit without rewriting seeds (AC5)', () => {
  it('does NOT rewrite an existing seed.json when the parent already has children', () => {
    db.insertCard(parentCard('epic'));
    const dir = ownedDir('idem');

    // A prior fan-out already committed the child and wrote its seed.
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'c1', parent_id: 'epic', lane: 'intake', status: 'waiting',
      attempt: 0, wave: 0, owned_paths: [dir], rework_count: 0,
    });
    const priorContent = JSON.stringify({ from: 'first-run' }, null, 2);
    writeFileSync(seedFileIn(dir), priorContent);

    // Re-dispatch with a DIFFERENT seed value — the guard must short-circuit.
    const proposal: ArchitectProposal = {
      children: [{ id: 'c1', depends_on: [], owned_paths: [dir], seed: { from: 'second-run' } }],
    };

    const result = expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // Returns the validated result...
    expect(result.children.map((c) => c.id)).toEqual(['c1']);
    // ...but the on-disk seed is UNTOUCHED (not overwritten with the new value).
    expect(readFileSync(seedFileIn(dir), 'utf-8')).toBe(priorContent);
  });

  it('does NOT write a seed.json at all when children already exist but none was previously written', () => {
    db.insertCard(parentCard('epic'));
    const dir = ownedDir('idem2');

    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'c1', parent_id: 'epic', lane: 'intake', status: 'waiting',
      attempt: 0, wave: 0, owned_paths: [dir], rework_count: 0,
    });

    const proposal: ArchitectProposal = {
      children: [{ id: 'c1', depends_on: [], owned_paths: [dir], seed: { from: 'second-run' } }],
    };

    expectOk(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // The idempotency short-circuit means the seed is never materialized on re-run.
    expect(existsSync(seedFileIn(dir))).toBe(false);
  });
});

// ===========================================================================
// AC6 — a child whose seed path would land OUTSIDE its declared owned_paths is
//        rejected rather than silently writing out of bounds. Nothing is
//        written, nothing is inserted.
// ===========================================================================

describe('out-of-bounds seed path is rejected (AC6)', () => {
  it('rejects a child whose first owned_paths entry escapes via .. traversal — writes nothing, inserts nothing', () => {
    db.insertCard(parentCard('epic'));
    const safeDir = ownedDir('safe');
    // First entry uses ../ to climb above the owned area; seed.json would land
    // outside the declared owned_paths.
    const escaping = join(safeDir, '..', '..', 'escape-target');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [escaping], seed: { evil: true } },
      ],
    };

    expectErr(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // No child row committed.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
    // No seed.json written at the escaped location.
    expect(existsSync(join(safeDir, '..', '..', 'escape-target', 'seed.json'))).toBe(false);
  });

  it('rejects a seeded child with an EMPTY owned_paths array (no directory to write into)', () => {
    db.insertCard(parentCard('epic'));

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [], seed: { x: 1 } },
      ],
    };

    expectErr(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('rejects a seeded child whose first owned_paths entry is a FILE (not a dir)', () => {
    db.insertCard(parentCard('epic'));
    // The first owned_paths entry points at an existing regular file, so there is
    // no directory to write seed.json into — statSync(entry).isDirectory() is false.
    const notADir = join(root, 'notadir.txt');
    writeFileSync(notADir, 'i am a file, not a directory\n');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [notADir], seed: { x: 1 } },
      ],
    };

    expectErr(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // No child row committed …
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
    // … and the file is untouched (no seed.json appended/overwritten on top of it).
    expect(readFileSync(notADir, 'utf8')).toBe('i am a file, not a directory\n');
  });

  it('rolls back ALL children when ONE child has an out-of-bounds seed path (all-or-nothing)', () => {
    db.insertCard(parentCard('epic'));
    const okDir = ownedDir('ok');
    const safeDir = ownedDir('safe2');
    const escaping = join(safeDir, '..', '..', 'escape-target2');

    const proposal: ArchitectProposal = {
      children: [
        { id: 'good', depends_on: [], owned_paths: [okDir], seed: { ok: true } },
        { id: 'bad', depends_on: [], owned_paths: [escaping], seed: { evil: true } },
      ],
    };

    expectErr(commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot: root }));

    // Neither child survives, and the good child's seed must not have leaked to disk.
    expect(db.getCard(DEFAULT_RUN_ID, 'good')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'bad')).toBeNull();
    expect(existsSync(seedFileIn(okDir))).toBe(false);
  });
});
