/**
 * snapshotTreeAsync (issue #30, ADR-0012) is the overlapped harness call's
 * version of snapshotTree. It must record exactly what snapshotTree records,
 * since the integrity check diffs one against the other's semantics, and it
 * must give the event loop a turn during a long walk, so a sibling call's
 * stdout handling and idle timer are not held up for the whole snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotTree, snapshotTreeAsync } from './executor';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conduit-snapshot-async-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('snapshotTreeAsync', () => {
  it('records the same signatures as snapshotTree: files, nested dirs and symlinks', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'top.txt'), 'top');
    writeFileSync(join(root, 'a', 'mid.txt'), 'mid');
    writeFileSync(join(root, 'a', 'b', 'deep.json'), '{}');
    symlinkSync(join(root, 'top.txt'), join(root, 'a', 'link'));
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));

    const sync = snapshotTree(root);
    const async = await snapshotTreeAsync(root);
    expect([...async.entries()].sort()).toEqual([...sync.entries()].sort());
    expect(sync.size).toBe(5);
  });

  it('yields to the event loop during the walk', async () => {
    for (let f = 0; f < 50; f++) writeFileSync(join(root, `f${f}`), String(f));
    let timerRanBeforeEnd = false;
    let done = false;
    setTimeout(() => {
      timerRanBeforeEnd = !done;
    }, 0);
    // A zero slice yields after every entry, so the timer gets its turn mid-walk.
    const snap = await snapshotTreeAsync(root, 0);
    done = true;
    expect(snap.size).toBe(50);
    expect(timerRanBeforeEnd).toBe(true);
  });

  it('does not yield on the serial snapshotTree (the timer runs only after it returns)', () => {
    for (let f = 0; f < 50; f++) writeFileSync(join(root, `f${f}`), String(f));
    let ran = false;
    setTimeout(() => {
      ran = true;
    }, 0);
    snapshotTree(root);
    expect(ran).toBe(false);
  });
});
