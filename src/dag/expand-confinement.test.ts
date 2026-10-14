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
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { commitFanOut } from './expand';
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
