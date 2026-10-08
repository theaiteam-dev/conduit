/**
 * Unit tests for the overlap integrity rule's parts (issue #30, ADR-0012):
 * the recorded windows, the owned-path disjointness check, and the
 * classification of one member's touched set. The executor-level behaviour is
 * in executor-harness-overlap.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OVERLAP_ATTRIBUTED_SAMPLE_CAP,
  OverlapWindows,
  canonicalOwnedPaths,
  classifyOverlapTouched,
  isOverlapHarnessStation,
  ownedPathSetsIntersect,
} from './harness-overlap';
import type { StationConfig } from '../types/kernel';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-overlap-unit-')));
  for (const c of ['a', 'b', 'c']) mkdirSync(join(root, 'evidence', c), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(rel: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
  return abs;
}

describe('OverlapWindows', () => {
  it('closeOpenFor ends a card\'s still-open windows, so they stop intersecting later ones', () => {
    const w = new OverlapWindows();
    const a = w.open('a', []);
    w.close(a); // normal path
    const leaked = w.open('leaked', []);
    w.closeOpenFor('leaked'); // finally-path after an error between open and close
    const later = w.open('later', []);
    w.close(later);
    expect(w.intersecting(later).map((s) => s.cardId)).toEqual([]);
    // Idempotent: the first end wins.
    w.closeOpenFor('leaked');
    w.close(leaked);
    expect(w.intersecting(later).map((s) => s.cardId)).toEqual([]);
  });

  it('a window never closed intersects every later one', () => {
    const w = new OverlapWindows();
    w.open('leaked', []);
    const later = w.open('later', []);
    w.close(later);
    expect(w.intersecting(later).map((s) => s.cardId)).toEqual(['leaked']);
  });

  it('reports the members whose windows intersected, and not one that closed before this one opened', () => {
    const w = new OverlapWindows();
    const early = w.open('early', ['/e']);
    w.close(early);
    const a = w.open('a', ['/a']);
    const b = w.open('b', ['/b']);
    w.close(a);
    const late = w.open('late', ['/l']);
    w.close(b);
    w.close(late);

    expect(w.intersecting(a).map((s) => s.cardId)).toEqual(['b']);
    expect(w.intersecting(b).map((s) => s.cardId)).toEqual(['a', 'late']);
    expect(w.intersecting(late).map((s) => s.cardId)).toEqual(['b']);
    expect(w.intersecting(early)).toEqual([]);
  });

  it("never lists a card as its own sibling, and lists a retried sibling once", () => {
    const w = new OverlapWindows();
    const a = w.open('a', ['/a']);
    const b1 = w.open('b', ['/b']);
    w.close(b1);
    const b2 = w.open('b', ['/b']);
    const a2 = w.open('a', ['/a']);
    w.close(a2);
    w.close(b2);
    w.close(a);
    expect(w.intersecting(a)).toEqual([{ cardId: 'b', ownedCanonical: ['/b'] }]);
  });

  it('treats a window left open as intersecting every later window', () => {
    const w = new OverlapWindows();
    w.open('stuck', ['/s']);
    const a = w.open('a', ['/a']);
    w.close(a);
    expect(w.intersecting(a).map((s) => s.cardId)).toEqual(['stuck']);
  });
});

describe('ownedPathSetsIntersect', () => {
  it('detects equal, nested and disjoint sets', () => {
    expect(ownedPathSetsIntersect(['/p/a'], ['/p/a'])).toBe(true);
    expect(ownedPathSetsIntersect(['/p/a'], ['/p/a/sub'])).toBe(true);
    expect(ownedPathSetsIntersect(['/p/a/sub'], ['/p/a'])).toBe(true);
    expect(ownedPathSetsIntersect(['/p/a'], ['/p/ab'])).toBe(false);
    expect(ownedPathSetsIntersect(['/p/a', '/p/x'], ['/p/b', '/p/x/y'])).toBe(true);
  });

  it('compares canonical paths, so a symlinked dir is the dir it points at', () => {
    symlinkSync(join(root, 'evidence', 'a'), join(root, 'alias'));
    const viaLink = canonicalOwnedPaths(root, ['alias']);
    const direct = canonicalOwnedPaths(root, ['evidence/a']);
    expect(ownedPathSetsIntersect(viaLink, direct)).toBe(true);
  });
});

describe('classifyOverlapTouched', () => {
  const own = () => canonicalOwnedPaths(root, ['evidence/a']);
  const siblings = () => [
    { cardId: 'b', ownedCanonical: canonicalOwnedPaths(root, ['evidence/b']) },
    { cardId: 'c', ownedCanonical: canonicalOwnedPaths(root, ['evidence/c']) },
  ];

  it("keeps the member's own paths for the serial check and attributes siblings' paths", () => {
    const mine = touch('evidence/a/result.json');
    const b1 = touch('evidence/b/result.json');
    const b2 = touch('evidence/b/notes.txt');
    const c1 = touch('evidence/c/result.json');
    const out = classifyOverlapTouched(root, own(), [mine, b1, b2, c1], siblings());
    expect(out.remaining).toEqual([mine]);
    expect(out.attributed).toEqual([
      { card: 'b', paths: 2, sample: ['evidence/b/result.json', 'evidence/b/notes.txt'] },
      { card: 'c', paths: 1, sample: ['evidence/c/result.json'] },
    ]);
  });

  it('caps the journaled sample per sibling but keeps the full count', () => {
    const many = Array.from({ length: OVERLAP_ATTRIBUTED_SAMPLE_CAP + 5 }, (_, i) => touch(`evidence/b/f${i}.txt`));
    const out = classifyOverlapTouched(root, own(), many, siblings());
    expect(out.attributed).toHaveLength(1);
    expect(out.attributed[0]?.paths).toBe(OVERLAP_ATTRIBUTED_SAMPLE_CAP + 5);
    expect(out.attributed[0]?.sample).toEqual(
      many.slice(0, OVERLAP_ATTRIBUTED_SAMPLE_CAP).map((p) => p.slice(root.length + 1)),
    );
    expect(OVERLAP_ATTRIBUTED_SAMPLE_CAP).toBe(20);
  });

  it('keeps a path no intersecting member owns, so the serial check fails it', () => {
    const rogue = touch('rogue.txt');
    const other = touch('evidence/d/result.json');
    const out = classifyOverlapTouched(root, own(), [rogue, other], siblings());
    expect(out.remaining).toEqual([rogue, other]);
    expect(out.attributed).toEqual([]);
  });

  it("does not attribute a path inside a member's dir that is not an intersecting member", () => {
    const b1 = touch('evidence/b/result.json');
    const out = classifyOverlapTouched(root, own(), [b1], []);
    expect(out.remaining).toEqual([b1]);
  });

  it("attributes a path a sibling removed after the snapshot, through its parent dir", () => {
    // A sibling wrote then deleted a temp file in its own dir between this
    // member's post-invoke snapshot and the classification. The integrity
    // check resolves a missing leaf through its parent (resolveOwnedPath), so
    // classification must too, or the member holds on a sibling's own file.
    const gone = join(root, 'evidence', 'b', 'vanished.txt');
    const out = classifyOverlapTouched(root, own(), [gone], siblings());
    expect(out.remaining).toEqual([]);
    expect(out.attributed).toEqual([{ card: 'b', paths: 1, sample: ['evidence/b/vanished.txt'] }]);
  });

  it('keeps a missing path that no intersecting member owns (fail closed)', () => {
    const gone = join(root, 'outside', 'vanished.txt');
    const out = classifyOverlapTouched(root, own(), [gone], siblings());
    expect(out.remaining).toEqual([gone]);
  });

  it("keeps a symlink in a sibling's dir that points outside every owned path", () => {
    touch('outside/target.txt');
    const link = join(root, 'evidence', 'b', 'escape');
    symlinkSync(join(root, 'outside', 'target.txt'), link);
    const out = classifyOverlapTouched(root, own(), [link], siblings());
    expect(out.remaining).toEqual([link]);
  });
});

describe('isOverlapHarnessStation', () => {
  const base: StationConfig = {
    kind: 'harness', effectful: false, wip: 3, inputs: [], outputs: ['r.json'], overlap: true,
  };
  it('holds for an eligible station in a flow that enforces owned paths', () => {
    expect(isOverlapHarnessStation(base, true)).toBe(true);
  });
  it('fails each static condition', () => {
    expect(isOverlapHarnessStation(base, false)).toBe(false);
    expect(isOverlapHarnessStation({ ...base, overlap: undefined }, true)).toBe(false);
    expect(isOverlapHarnessStation({ ...base, kind: 'transform' }, true)).toBe(false);
    expect(isOverlapHarnessStation({ ...base, effectful: true }, true)).toBe(false);
    expect(isOverlapHarnessStation({ ...base, fan_out: 2 }, true)).toBe(false);
    expect(isOverlapHarnessStation({ ...base, deliver: { files: ['r.json'] } }, true)).toBe(false);
    expect(
      isOverlapHarnessStation({ ...base, gateCheck: {} as NonNullable<StationConfig['gateCheck']> }, true),
    ).toBe(false);
  });
});
