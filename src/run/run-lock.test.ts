/**
 * Tests for the per-run advisory lease lock (the original run-lock and busy-retry work, part 1).
 *
 * acquireRunLease enforces: at most one process may drive a given run_id at
 * a time. Covers fresh acquire, re-entrant same-pid acquire, refusal against
 * a live different holder, reclaim of a dead holder's stale lease, and
 * release semantics (own-lease-only, no-op for a non-holder).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { acquireRunLease, releaseRunLease, peekRunLeaseHolder, isLeaseHolderAlive } from './run-lock';

let dir: string;
let db: ConduitDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-run-lock-'));
  db = openConduitDB({
    stateDbPath: join(dir, 'state.sqlite'),
    journalDbPath: join(dir, 'journal.sqlite'),
  });
  db.insertRun({
    run_id: 'run-a',
    flow: 'flow.yaml',
    input_fingerprint: 'fp',
    status: 'running',
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireRunLease', () => {
  it('fresh acquire: unheld run is acquired and stamped', () => {
    const result = acquireRunLease(db, 'run-a', 111, 1_000);
    expect(result).toEqual({ acquired: true });

    const holder = peekRunLeaseHolder(db, 'run-a');
    expect(holder).toMatchObject({ holderPid: 111, acquiredAt: 1_000 });
  });

  it('re-entrant acquire: same pid re-acquiring its own held lease succeeds and refreshes the timestamp', () => {
    const first = acquireRunLease(db, 'run-a', 111, 1_000);
    expect(first.acquired).toBe(true);

    const second = acquireRunLease(db, 'run-a', 111, 2_000);
    expect(second.acquired).toBe(true);

    const holder = peekRunLeaseHolder(db, 'run-a');
    expect(holder).toMatchObject({ holderPid: 111, acquiredAt: 2_000 });
  });

  it('refuses when a different holder is alive', () => {
    const first = acquireRunLease(db, 'run-a', 111, 1_000);
    expect(first.acquired).toBe(true);

    const second = acquireRunLease(db, 'run-a', 222, 2_000, { isPidAlive: () => true });
    expect(second).toEqual({ acquired: false, holderPid: 111, acquiredAt: 1_000 });

    // Refused acquire must not have mutated the row.
    const holder = peekRunLeaseHolder(db, 'run-a');
    expect(holder).toMatchObject({ holderPid: 111, acquiredAt: 1_000 });
  });

  it('reclaims when the recorded holder is dead', () => {
    const first = acquireRunLease(db, 'run-a', 111, 1_000, { isPidAlive: () => true });
    expect(first.acquired).toBe(true);

    const second = acquireRunLease(db, 'run-a', 222, 2_000, { isPidAlive: () => false });
    expect(second).toEqual({ acquired: true });

    const holder = peekRunLeaseHolder(db, 'run-a');
    expect(holder).toMatchObject({ holderPid: 222, acquiredAt: 2_000 });
  });

  it('a run with no runs row is treated as a free acquire (nothing to protect)', () => {
    const result = acquireRunLease(db, 'unregistered-run', 111, 1_000);
    expect(result).toEqual({ acquired: true });
  });
});

describe('releaseRunLease', () => {
  it('clears only its own lease', () => {
    acquireRunLease(db, 'run-a', 111, 1_000);
    releaseRunLease(db, 'run-a', 111);

    expect(peekRunLeaseHolder(db, 'run-a')).toBeNull();
  });

  it('is a no-op when called by a non-holder', () => {
    acquireRunLease(db, 'run-a', 111, 1_000, { isPidAlive: () => true });
    releaseRunLease(db, 'run-a', 999);

    // The live holder (111) must remain untouched.
    expect(peekRunLeaseHolder(db, 'run-a')).toMatchObject({ holderPid: 111, acquiredAt: 1_000 });
  });

  it('returns true on a normal, uncontended release (regression: wrapping in withBusyRetry must not change the happy path)', () => {
    acquireRunLease(db, 'run-a', 111, 1_000);
    expect(releaseRunLease(db, 'run-a', 111)).toBe(true);
    expect(peekRunLeaseHolder(db, 'run-a')).toBeNull();
  });

  it('swallows a non-busy write failure and returns false instead of throwing (fault injection: unit level)', () => {
    acquireRunLease(db, 'run-a', 111, 1_000);

    // Force a failure unrelated to busy-contention, to prove the catch is not
    // busy-specific: drop the table the release UPDATE targets.
    db.getStateDb().exec('DROP TABLE runs');

    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    let released: boolean;
    try {
      released = releaseRunLease(db, 'run-a', 111);
    } finally {
      console.error = originalConsoleError;
    }

    expect(released).toBe(false);
    expect(logged.length).toBe(1);
    expect(String(logged[0]?.[0])).toContain('run-a');
    expect(String(logged[0]?.[0])).toContain('111');
  });
});

// ---------------------------------------------------------------------------
// acquireRunLease / releaseRunLease — real SQLITE_BUSY contention
// (the original run-lock and busy-retry work part 2 follow-up: both lease writes now go through
// withBusyRetry, same as the claim-path transactions in src/dispatch/claim.ts)
// ---------------------------------------------------------------------------

/**
 * Rationale for the cross-process shape (mirrors
 * src/dispatch/claim-busy-retry.test.ts): withBusyRetry's Bun.sleepSync
 * backoff blocks the calling thread entirely, so nothing in-process can
 * release a held write reservation while the caller under test is mid-retry.
 * A separate OS process holding `BEGIN IMMEDIATE` is the only way to produce
 * genuine, deterministic contention while the caller under test keeps
 * retrying.
 *
 * The contending connection is a raw bun:sqlite Database (not openConduitDB's,
 * which hardcodes busy_timeout=5000 in db.ts) wrapped in a minimal stub
 * exposing only getStateDb(), which is all run-lock.ts's exported functions
 * read off a ConduitDB. A short busy_timeout on this connection means SQLite
 * itself gives up quickly per attempt, so withBusyRetry's own retry loop —
 * not SQLite's internal wait — is what bridges the contention window.
 */
describe('acquireRunLease / releaseRunLease — real SQLITE_BUSY contention (the original run-lock and busy-retry work part 2 follow-up)', () => {
  function stubConduitDb(raw: Database): ConduitDB {
    return { getStateDb: () => raw } as unknown as ConduitDB;
  }

  function spawnHolder(stateDbPath: string, sentinelPath: string, holdMs: number) {
    const holderSrc = `
import { writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
const db = new Database(process.env.STATE);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
writeFileSync(process.env.SENTINEL, 'locked');
Bun.sleepSync(${holdMs});
db.exec('COMMIT');
db.close();
`;
    const holderPath = join(dir, `holder-${holdMs}-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(holderPath, holderSrc);
    return Bun.spawn(['bun', holderPath], {
      env: { ...process.env, STATE: stateDbPath, SENTINEL: sentinelPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  function waitForSentinel(sentinelPath: string) {
    const deadline = Date.now() + 5000;
    while (!existsSync(sentinelPath)) {
      if (Date.now() > deadline) {
        throw new Error('holder process never signalled its lock sentinel');
      }
    }
  }

  it(
    'acquireRunLease retries through a held write reservation from a concurrent process and eventually acquires',
    async () => {
      const stateDbPath = join(dir, 'state.sqlite');
      const sentinelPath = join(dir, `sentinel-acquire-${Date.now()}`);
      const HOLD_MS = 150;

      const holder = spawnHolder(stateDbPath, sentinelPath, HOLD_MS);
      try {
        waitForSentinel(sentinelPath);

        // Short busy_timeout: SQLite gives up almost immediately per attempt,
        // so withBusyRetry's own backoff loop is what bridges HOLD_MS, not
        // SQLite's internal wait.
        const clientRaw = new Database(stateDbPath);
        clientRaw.exec('PRAGMA busy_timeout = 50');
        const clientDb = stubConduitDb(clientRaw);

        const start = Date.now();
        const result = acquireRunLease(clientDb, 'run-a', 222, 2_000);
        const elapsedMs = Date.now() - start;

        expect(result).toEqual({ acquired: true });
        // Sanity: this could only have succeeded by outlasting the holder's
        // reservation, which is held for HOLD_MS.
        expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS - 20); // small clock-skew tolerance

        clientRaw.close();

        expect(peekRunLeaseHolder(db, 'run-a')).toMatchObject({ holderPid: 222, acquiredAt: 2_000 });
      } finally {
        await holder.exited;
      }
    },
    15_000,
  );

  it(
    'releaseRunLease retries through contention and, once it exhausts, swallows the error and returns false instead of throwing',
    async () => {
      // Establish a real lease first so there is something for the release
      // attempt to (fail to) clear.
      acquireRunLease(db, 'run-a', 111, 1_000);

      const stateDbPath = join(dir, 'state.sqlite');
      const sentinelPath = join(dir, `sentinel-release-${Date.now()}`);
      // Comfortably longer than withBusyRetry's worst-case exhaustion window
      // at busy_timeout=50ms (5 attempts * ~50ms + ~4 backoff sleeps up to
      // ~400ms each ≈ well under 1.5s), so the retry loop reliably exhausts
      // while the holder is still holding the reservation.
      const HOLD_MS = 2_000;

      const holder = spawnHolder(stateDbPath, sentinelPath, HOLD_MS);
      const logged: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };

      try {
        waitForSentinel(sentinelPath);

        const clientRaw = new Database(stateDbPath);
        clientRaw.exec('PRAGMA busy_timeout = 50');
        const clientDb = stubConduitDb(clientRaw);

        const start = Date.now();
        const released = releaseRunLease(clientDb, 'run-a', 111);
        const elapsedMs = Date.now() - start;

        expect(released).toBe(false);
        // Exhaustion must happen well before the holder's HOLD_MS elapses —
        // otherwise this test isn't actually exercising the exhaustion path.
        expect(elapsedMs).toBeLessThan(HOLD_MS);
        expect(logged.length).toBeGreaterThan(0);
        expect(String(logged[0]?.[0])).toContain('run-a');

        clientRaw.close();

        // The release never landed — the original holder (111) is still recorded.
        expect(peekRunLeaseHolder(db, 'run-a')).toMatchObject({ holderPid: 111, acquiredAt: 1_000 });
      } finally {
        console.error = originalConsoleError;
        await holder.exited;
      }
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Process identity (issue #83 review): a pid alone does not identify the
// holder, because the kernel hands a dead holder's pid to the next process.
// The lease records the holder's start time, and a holder whose pid answers
// but whose start time differs is a different process.
// ---------------------------------------------------------------------------

describe('lease holder identity: pid plus start time', () => {
  /** A process table where every pid is alive and has the given start time. */
  const table = (startTimes: Record<number, number | undefined>) => ({
    isPidAlive: (pid: number) => pid in startTimes,
    processStartTime: (pid: number) => startTimes[pid],
  });

  it('acquire records the caller start time, and peek returns it', () => {
    acquireRunLease(db, 'run-a', 111, 1_000, table({ 111: 5_000 }));
    expect(peekRunLeaseHolder(db, 'run-a')).toEqual({ holderPid: 111, acquiredAt: 1_000, holderStartTime: 5_000 });
  });

  it('acquire records NULL when the caller start time cannot be read', () => {
    acquireRunLease(db, 'run-a', 111, 1_000, { isPidAlive: () => true, processStartTime: () => undefined });
    expect(peekRunLeaseHolder(db, 'run-a')).toEqual({ holderPid: 111, acquiredAt: 1_000, holderStartTime: null });
  });

  it('reclaims a lease whose holder pid is alive but now belongs to a different process (pid reuse)', () => {
    acquireRunLease(db, 'run-a', 111, 1_000, table({ 111: 5_000 }));
    // pid 111 is alive again, but it started later: a new process got the pid.
    const second = acquireRunLease(db, 'run-a', 222, 2_000, table({ 111: 9_999, 222: 7_000 }));
    expect(second).toEqual({ acquired: true });
    expect(peekRunLeaseHolder(db, 'run-a')).toEqual({ holderPid: 222, acquiredAt: 2_000, holderStartTime: 7_000 });
  });

  it('refuses when the holder pid is alive with the same start time', () => {
    acquireRunLease(db, 'run-a', 111, 1_000, table({ 111: 5_000 }));
    const second = acquireRunLease(db, 'run-a', 222, 2_000, table({ 111: 5_000, 222: 7_000 }));
    expect(second).toEqual({ acquired: false, holderPid: 111, acquiredAt: 1_000 });
  });

  describe('isLeaseHolderAlive', () => {
    it('is dead when the pid is dead, whatever the start times say', () => {
      expect(isLeaseHolderAlive({ holderPid: 111, holderStartTime: 5_000 }, table({}))).toBe(false);
    });

    it('is alive when the pid is alive and the start time matches', () => {
      expect(isLeaseHolderAlive({ holderPid: 111, holderStartTime: 5_000 }, table({ 111: 5_000 }))).toBe(true);
    });

    it('is dead when the pid is alive but the start time differs', () => {
      expect(isLeaseHolderAlive({ holderPid: 111, holderStartTime: 5_000 }, table({ 111: 6_000 }))).toBe(false);
    });

    it('falls back to the pid probe for a legacy lease with no recorded start time', () => {
      expect(isLeaseHolderAlive({ holderPid: 111, holderStartTime: null }, table({ 111: 6_000 }))).toBe(true);
      expect(isLeaseHolderAlive({ holderPid: 111, holderStartTime: null }, table({}))).toBe(false);
    });

    it('treats a live pid whose current start time is unreadable as alive (fail closed)', () => {
      expect(isLeaseHolderAlive({ holderPid: 111, holderStartTime: 5_000 }, table({ 111: undefined }))).toBe(true);
    });

    it('with no injected dependencies, recognises this process as alive and a changed start time as dead', () => {
      const own = peekOwnStartTime();
      if (own === null) return; // no /proc on this host: nothing to compare
      expect(isLeaseHolderAlive({ holderPid: process.pid, holderStartTime: own })).toBe(true);
      expect(isLeaseHolderAlive({ holderPid: process.pid, holderStartTime: own + 1 })).toBe(false);
    });
  });

  /** This process's start time as a real acquire records it. */
  function peekOwnStartTime(): number | null {
    acquireRunLease(db, 'run-a', process.pid, 1_000);
    return peekRunLeaseHolder(db, 'run-a')!.holderStartTime;
  }
});
