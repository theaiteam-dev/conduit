/**
 * Fan-out owned_paths confinement (issues #73 and #124, SPEC §7 path ownership,
 * §9 dynamic expansion).
 *
 * A child's owned_paths come from the plan station's proposal, which is model
 * output. commitFanOut resolves every entry against the run's project root, not
 * the kernel's cwd, and rejects the whole proposal with
 * `owned_path_out_of_bounds` when an entry resolves outside the root: an
 * absolute path elsewhere, a `..` escape, or a symlink that points out.
 * Nothing is written and no card is inserted on a rejection.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { commitFanOut, resolveSeedDir, validateExpansion } from './expand';
import type { ArchitectProposal, ExpansionResult } from './expand';

let db: ConduitDB;
/** Holds the project root and, beside it, a directory outside the root. */
let sandbox: string;
let projectRoot: string;
let outside: string;
/** A third directory the test chdirs into, so cwd differs from projectRoot. */
let elsewhere: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  sandbox = mkdtempSync(join(tmpdir(), 'conduit-fanout-confine-'));
  projectRoot = join(sandbox, 'project');
  outside = join(sandbox, 'outside');
  elsewhere = join(sandbox, 'elsewhere');
  mkdirSync(projectRoot);
  mkdirSync(outside);
  mkdirSync(elsewhere);
  process.chdir(elsewhere);
  db.insertCard(parentCard('epic'));
});

afterEach(() => {
  process.chdir(originalCwd);
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
});

function parentCard(id: string): Card {
  return {
    run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'intake', status: 'awaiting_children',
    attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
  };
}

function commit(proposal: ArchitectProposal): ExpansionResult {
  return commitFanOut(db, DEFAULT_RUN_ID, 'epic', proposal, { onPathConflict: 'reject', projectRoot });
}

function expectOutOfBounds(r: ExpansionResult, child: string, path: string): void {
  expect(r).toEqual({ ok: false, error: { code: 'owned_path_out_of_bounds', child, path } });
}

describe('commitFanOut resolves owned_paths against the project root (issue #124)', () => {
  it('seeds a relative owned dir under the project root when cwd is elsewhere', () => {
    mkdirSync(join(projectRoot, 'evidence', 'c1'), { recursive: true });
    // The same relative dir does NOT exist under cwd, which is what the old
    // cwd-relative existsSync tripped on.
    expect(existsSync(join(elsewhere, 'evidence', 'c1'))).toBe(false);

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['evidence/c1'], seed: { n: 1 } }] });

    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(projectRoot, 'evidence', 'c1', 'seed.json'), 'utf8'))).toEqual({ n: 1 });
    expect(existsSync(join(elsewhere, 'evidence', 'c1', 'seed.json'))).toBe(false);
    // The card keeps the path as proposed; readers resolve it against the root.
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.owned_paths).toEqual(['evidence/c1']);
  });

  it('does not seed into a cwd-relative dir that is missing under the project root', () => {
    mkdirSync(join(elsewhere, 'evidence', 'c1'), { recursive: true });

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['evidence/c1'], seed: { n: 1 } }] });

    expect(r).toEqual({ ok: false, error: { code: 'seed_path_out_of_bounds', child: 'c1', path: 'evidence/c1' } });
    expect(existsSync(join(elsewhere, 'evidence', 'c1', 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('accepts an absolute owned dir inside the project root', () => {
    const dir = join(projectRoot, 'abs');
    mkdirSync(dir);

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: [dir], seed: { n: 2 } }] });

    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'seed.json'))).toBe(true);
  });

  it('accepts unseeded relative owned paths that do not exist yet', () => {
    const r = commit({
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['out/c1.json'] },
        { id: 'c2', depends_on: [], owned_paths: ['out/c2.json'] },
      ],
    });

    expect(r.ok).toBe(true);
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.owned_paths).toEqual(['out/c2.json']);
  });

  it('accepts a symlink inside the project root that points inside it', () => {
    mkdirSync(join(projectRoot, 'real'));
    symlinkSync(join(projectRoot, 'real'), join(projectRoot, 'alias'));

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['alias'], seed: { n: 3 } }] });

    expect(r.ok).toBe(true);
    expect(existsSync(join(projectRoot, 'real', 'seed.json'))).toBe(true);
  });
});

describe('commitFanOut confines owned_paths to the project root (issue #73)', () => {
  it('rejects a `..` escape and writes nothing', () => {
    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['../outside'], seed: { evil: true } }] });

    expectOutOfBounds(r, 'c1', '../outside');
    expect(existsSync(join(outside, 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('rejects a `..` escape that re-enters through a lexical detour', () => {
    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['sub/../../outside'], seed: { evil: true } }] });

    expectOutOfBounds(r, 'c1', 'sub/../../outside');
    expect(existsSync(join(outside, 'seed.json'))).toBe(false);
  });

  it('rejects an absolute path outside the project root, though the directory exists', () => {
    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: [outside], seed: { evil: true } }] });

    expectOutOfBounds(r, 'c1', outside);
    expect(existsSync(join(outside, 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('rejects a symlink inside the root that points outside it', () => {
    symlinkSync(outside, join(projectRoot, 'escape'));

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['escape'], seed: { evil: true } }] });

    expectOutOfBounds(r, 'c1', 'escape');
    expect(existsSync(join(outside, 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('rejects a not-yet-existing path below a symlink that points outside', () => {
    symlinkSync(outside, join(projectRoot, 'escape'));

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['escape/later/out.json'] }] });

    expectOutOfBounds(r, 'c1', 'escape/later/out.json');
  });

  it('rejects an escaping entry on an unseeded child, since the card would own it', () => {
    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: [join(outside, 'x.json')] }] });

    expectOutOfBounds(r, 'c1', join(outside, 'x.json'));
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('rejects an escaping entry after the first', () => {
    mkdirSync(join(projectRoot, 'ok'));

    const r = commit({ children: [{ id: 'c1', depends_on: [], owned_paths: ['ok', '../outside/x'], seed: { n: 1 } }] });

    expectOutOfBounds(r, 'c1', '../outside/x');
    expect(existsSync(join(projectRoot, 'ok', 'seed.json'))).toBe(false);
  });

  it('rejects the whole proposal when one sibling escapes: no seed, no card for the valid one', () => {
    mkdirSync(join(projectRoot, 'good'));

    const r = commit({
      children: [
        { id: 'good', depends_on: [], owned_paths: ['good'], seed: { ok: true } },
        { id: 'bad', depends_on: [], owned_paths: [outside], seed: { evil: true } },
      ],
    });

    expectOutOfBounds(r, 'bad', outside);
    expect(existsSync(join(projectRoot, 'good', 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'good')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'bad')).toBeNull();
  });

  it('rejects a non-string entry instead of throwing', () => {
    const proposal = { children: [{ id: 'c1', depends_on: [], owned_paths: [42] }] } as unknown as ArchitectProposal;

    expectOutOfBounds(commit(proposal), 'c1', '42');
  });

  it('compares against the canonical root, so a root reached through a symlink still confines', () => {
    const linkedRoot = join(sandbox, 'project-link');
    symlinkSync(projectRoot, linkedRoot);
    mkdirSync(join(projectRoot, 'in'));

    const inside = commitFanOut(db, DEFAULT_RUN_ID, 'epic', {
      children: [{ id: 'c1', depends_on: [], owned_paths: ['in'], seed: { n: 1 } }],
    }, { onPathConflict: 'reject', projectRoot: linkedRoot });
    expect(inside.ok).toBe(true);
    expect(existsSync(join(realpathSync(projectRoot), 'in', 'seed.json'))).toBe(true);

    db.insertCard(parentCard('epic2'));
    const escaped = commitFanOut(db, DEFAULT_RUN_ID, 'epic2', {
      children: [{ id: 'c2', depends_on: [], owned_paths: [outside] }],
    }, { onPathConflict: 'reject', projectRoot: linkedRoot });
    expectOutOfBounds(escaped, 'c2', outside);
  });
});

// ===========================================================================
// Disjoint ownership on canonical paths (SPEC §9). Two concurrent children
// that own the same directory, or one inside the other, overlap however the
// proposal spells the paths.
// ===========================================================================

describe('validateExpansion compares owned paths canonically (SPEC §9)', () => {
  function pair(a: string, b: string): ArchitectProposal {
    return {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [a] },
        { id: 'c2', depends_on: [], owned_paths: [b] },
      ],
    };
  }

  function reject(p: ArchitectProposal): ExpansionResult {
    return validateExpansion(p, { onPathConflict: 'reject', projectRoot });
  }

  it('rejects a relative and an absolute spelling of the same dir, naming the proposed entry', () => {
    mkdirSync(join(projectRoot, 'evidence', 'c1'), { recursive: true });
    const abs = join(projectRoot, 'evidence', 'c1');

    expect(reject(pair('evidence/c1', abs))).toEqual({
      ok: false,
      error: { code: 'overlapping_owned_paths', stations: ['c1', 'c2'], path: abs },
    });
  });

  it('rejects `./a` against `a`', () => {
    const r = reject(pair('./a', 'a'));
    expect(!r.ok && r.error.code).toBe('overlapping_owned_paths');
  });

  it('rejects a parent against a nested child, `a` vs `a/b`, in either order', () => {
    expect(reject(pair('a', 'a/b'))).toEqual({
      ok: false,
      error: { code: 'overlapping_owned_paths', stations: ['c1', 'c2'], path: 'a/b' },
    });
    expect(reject(pair('a/b', 'a')).ok).toBe(false);
  });

  it('serializes a parent and a nested child under onPathConflict: serialize', () => {
    const r = validateExpansion(pair('a', 'a/b'), { onPathConflict: 'serialize', projectRoot });
    expect(r.ok && r.forcedEdges).toEqual([{ from: 'c2', to: 'c1' }]);
    expect(r.ok && r.children.find((c) => c.id === 'c2')?.depends_on).toEqual(['c1']);
  });

  it('rejects two different symlinks to the same dir', () => {
    mkdirSync(join(projectRoot, 'real'));
    symlinkSync(join(projectRoot, 'real'), join(projectRoot, 'one'));
    symlinkSync(join(projectRoot, 'real'), join(projectRoot, 'two'));

    const r = reject(pair('one', 'two'));
    expect(!r.ok && r.error.code).toBe('overlapping_owned_paths');
  });

  it('accepts disjoint siblings `a/x` and `a/y`', () => {
    expect(reject(pair('a/x', 'a/y')).ok).toBe(true);
  });

  it('commitFanOut rejects the relative/absolute overlap and seeds nothing', () => {
    mkdirSync(join(projectRoot, 'evidence', 'c1'), { recursive: true });

    const r = commit({
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['evidence/c1'], seed: { n: 1 } },
        { id: 'c2', depends_on: [], owned_paths: [join(projectRoot, 'evidence', 'c1')], seed: { n: 2 } },
      ],
    });

    expect(!r.ok && r.error.code).toBe('overlapping_owned_paths');
    expect(existsSync(join(projectRoot, 'evidence', 'c1', 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });
});

describe('resolveSeedDir re-checks the seed dir realpath against the project root', () => {
  // validateExpansion confines every entry first, but a symlink can be
  // re-pointed between that check and commitFanOut's realpathSync. These call
  // resolveSeedDir directly with an entry validation never saw.
  it('returns the realpath for a dir inside the root', () => {
    mkdirSync(join(projectRoot, 'evidence', 'c1'), { recursive: true });
    expect(resolveSeedDir(projectRoot, 'evidence/c1')).toEqual({
      ok: true,
      dir: realpathSync(join(projectRoot, 'evidence', 'c1')),
    });
  });

  it('rejects a symlink inside the root that points outside it', () => {
    symlinkSync(outside, join(projectRoot, 'escape'));
    expect(resolveSeedDir(projectRoot, 'escape')).toEqual({ ok: false, code: 'owned_path_out_of_bounds' });
  });

  it('reports a dangling symlink as seed_path_out_of_bounds instead of throwing', () => {
    symlinkSync(join(projectRoot, 'gone'), join(projectRoot, 'dangling'));
    expect(resolveSeedDir(projectRoot, 'dangling')).toEqual({ ok: false, code: 'seed_path_out_of_bounds' });
  });

  it('reports a dir removed before realpathSync as seed_path_out_of_bounds instead of throwing', () => {
    mkdirSync(join(projectRoot, 'racy'));
    const spy = spyOn(fs, 'realpathSync').mockImplementation((() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    }) as unknown as typeof fs.realpathSync);
    try {
      expect(resolveSeedDir(projectRoot, 'racy')).toEqual({ ok: false, code: 'seed_path_out_of_bounds' });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a missing dir and a file as seed_path_out_of_bounds', () => {
    expect(resolveSeedDir(projectRoot, 'missing')).toEqual({ ok: false, code: 'seed_path_out_of_bounds' });
    writeFileSync(join(projectRoot, 'file'), 'x');
    expect(resolveSeedDir(projectRoot, 'file')).toEqual({ ok: false, code: 'seed_path_out_of_bounds' });
  });
});

describe('commitFanOut rejects two seeded children that share a seed dir', () => {
  // commitFanOut writes every child's seed.json before any child runs, so two
  // seeded children whose owned_paths[0] is one directory would leave the
  // second seed in place of the first. depends_on ordering does not help: the
  // disjointness check skips ordered pairs, and the writes happen up front.
  beforeEach(() => {
    mkdirSync(join(projectRoot, 'a', 'b'), { recursive: true });
  });

  it.each([
    ['the same spelling', 'a', 'a'],
    ['`./a` and `a`', './a', 'a'],
    ['a relative and an absolute spelling', 'a', '<abs>'],
  ])('rejects %s on children ordered by depends_on', (_label, first, second) => {
    const spell = (p: string): string => (p === '<abs>' ? join(projectRoot, 'a') : p);
    const r = commit({
      children: [
        { id: 'c1', depends_on: [], owned_paths: [spell(first)], seed: { n: 1 } },
        { id: 'c2', depends_on: ['c1'], owned_paths: [spell(second)], seed: { n: 2 } },
      ],
    });

    expect(r).toEqual({
      ok: false,
      error: { code: 'seed_path_conflict', children: ['c1', 'c2'], path: spell(second) },
    });
    expect(existsSync(join(projectRoot, 'a', 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')).toBeNull();
  });

  it.each([
    ['ordered by depends_on', ['c1']],
    ['concurrent, so serialize adds the edge', []],
  ])('rejects a shared seed dir under onPathConflict: serialize, %s', (_label, c2Deps) => {
    const r = commitFanOut(
      db,
      DEFAULT_RUN_ID,
      'epic',
      {
        children: [
          { id: 'c1', depends_on: [], owned_paths: ['a'], seed: { n: 1 } },
          { id: 'c2', depends_on: c2Deps as string[], owned_paths: ['./a'], seed: { n: 2 } },
        ],
      },
      { onPathConflict: 'serialize', projectRoot },
    );

    expect(r).toEqual({ ok: false, error: { code: 'seed_path_conflict', children: ['c1', 'c2'], path: './a' } });
    expect(existsSync(join(projectRoot, 'a', 'seed.json'))).toBe(false);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')).toBeNull();
  });

  it('accepts a shared dir when only one of the two children is seeded', () => {
    const r = commit({
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['a'], seed: { n: 1 } },
        { id: 'c2', depends_on: ['c1'], owned_paths: ['a'] },
      ],
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(projectRoot, 'a', 'seed.json'), 'utf8'))).toEqual({ n: 1 });
  });

  it('accepts nested seed dirs, which hold separate seed.json files', () => {
    const r = commit({
      children: [
        { id: 'c1', depends_on: [], owned_paths: ['a'], seed: { n: 1 } },
        { id: 'c2', depends_on: ['c1'], owned_paths: ['a/b'], seed: { n: 2 } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(projectRoot, 'a', 'seed.json'), 'utf8'))).toEqual({ n: 1 });
    expect(JSON.parse(readFileSync(join(projectRoot, 'a', 'b', 'seed.json'), 'utf8'))).toEqual({ n: 2 });
  });
});
