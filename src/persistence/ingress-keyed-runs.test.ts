/**
 * Tests for the keyed-run ingress state + the v10→v11 schema migration (issue #36).
 *
 * A binding that declares `run_key` maps many deliveries onto ONE run. The
 * listener needs per-run state that survives its own restart: which subject
 * the run is keyed on, the binding's pass ceiling, whether a later event is
 * waiting for the next pass (and which one), and whether the channel has
 * already been told the run cannot take more passes. That state lives in
 * `ingress_keyed_runs`, keyed by run id (the run id already hashes the flow id).
 *
 * Two new ingress_events spawn states: 'coalesced' (the event was folded into
 * the run's pending pass) and 'refused' (the keyed router declined it). Neither
 * is re-drivable. New ingress_log outcomes: filtered, rejected_run_key,
 * coalesced, pass_limit, run_not_appendable, pass_failed, already_applied.
 *
 * `run_pass_events` records which pass consumed each event. The kernel writes
 * it with the pass's entry card; the listener reads it so it never launches an
 * event twice and so a pass lists every event folded into it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, SCHEMA_VERSION, type ConduitDB } from './db';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let opened: ConduitDB[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-keyed-runs-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  opened = [];
});

afterEach(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function open(): ConduitDB {
  const db = openConduitDB({ stateDbPath, journalDbPath });
  opened.push(db);
  return db;
}

const KEYED = {
  runId: 'igk-pr-loop-0123456789abcdef0123456789abcdef',
  flowId: 'pr-loop',
  flowPath: '/flows/pr-loop/flow.yaml',
  runKey: ['12345', '7'],
  maxPasses: 10,
};

describe('ingress_keyed_runs', () => {
  it('stamps SCHEMA_VERSION 11 on a fresh DB', () => {
    expect(SCHEMA_VERSION).toBe(11);
  });

  it('returns null for an unknown run', () => {
    expect(open().getKeyedRun('igk-nope')).toBeNull();
  });

  it('upserts a keyed run and reads it back with no pending event', () => {
    const db = open();
    db.upsertKeyedRun(KEYED);
    expect(db.getKeyedRun(KEYED.runId)).toEqual({
      run_id: KEYED.runId,
      flow_id: 'pr-loop',
      flow_path: '/flows/pr-loop/flow.yaml',
      run_key: ['12345', '7'],
      max_passes: 10,
      pending_event_id: null,
      blocked_alerted: false,
    });
  });

  it('a later upsert refreshes flow path and max_passes but keeps pending state and the key', () => {
    const db = open();
    db.upsertKeyedRun(KEYED);
    db.setKeyedRunPending(KEYED.runId, 'ev-2');
    db.setKeyedRunBlockedAlerted(KEYED.runId, true);
    db.upsertKeyedRun({ ...KEYED, flowPath: '/moved/flow.yaml', maxPasses: null, runKey: ['other'] });
    const rec = db.getKeyedRun(KEYED.runId)!;
    expect(rec.flow_path).toBe('/moved/flow.yaml');
    expect(rec.max_passes).toBeNull();
    expect(rec.run_key).toEqual(['12345', '7']);
    expect(rec.pending_event_id).toBe('ev-2');
    expect(rec.blocked_alerted).toBe(true);
  });

  it('sets and clears the pending event, and lists runs with one pending', () => {
    const db = open();
    db.upsertKeyedRun(KEYED);
    db.upsertKeyedRun({ ...KEYED, runId: 'igk-other' });
    db.setKeyedRunPending(KEYED.runId, 'ev-9');
    expect(db.listKeyedRunsWithPending().map((r) => r.run_id)).toEqual([KEYED.runId]);
    db.setKeyedRunPending(KEYED.runId, null);
    expect(db.listKeyedRunsWithPending()).toEqual([]);
  });

  it('binds hostile values as parameters rather than interpolating them', () => {
    const db = open();
    const hostile = `x'); DROP TABLE ingress_keyed_runs; --`;
    db.upsertKeyedRun({ ...KEYED, runKey: [hostile] });
    db.setKeyedRunPending(KEYED.runId, hostile);
    const rec = db.getKeyedRun(KEYED.runId)!;
    expect(rec.run_key).toEqual([hostile]);
    expect(rec.pending_event_id).toBe(hostile);
  });
});

describe('coalesced and refused spawn states', () => {
  it('marks an event coalesced or refused, and neither is re-drivable', () => {
    const db = open();
    db.acceptIngressEvent('ev-a', 1000);
    db.acceptIngressEvent('ev-b', 1001);
    db.markIngressCoalesced('ev-a');
    db.markIngressRefused('ev-b');
    expect(db.getIngressEvent('ev-a')!.spawn_state).toBe('coalesced');
    expect(db.getIngressEvent('ev-b')!.spawn_state).toBe('refused');
    expect(db.listRedrivable(5)).toEqual([]);
  });

  it('a redelivery of a coalesced or refused event is a duplicate, not a re-accept', () => {
    const db = open();
    db.acceptIngressEvent('ev-a', 1000);
    db.markIngressCoalesced('ev-a');
    expect(db.acceptIngressEvent('ev-a', 2000).accepted).toBe(false);
    db.acceptIngressEvent('ev-b', 1000);
    db.markIngressRefused('ev-b');
    expect(db.acceptIngressEvent('ev-b', 2000).accepted).toBe(false);
  });
});

describe('queued ingress rows for a run', () => {
  it('counts accepted rows and failed rows under the cap, only those ordered before the named event', () => {
    const db = open();
    const attr = (ev: string) => ({ flowId: 'f', flowPath: '/f.yaml', runId: KEYED.runId, substrateJson: `{"e":"${ev}"}` });
    db.acceptIngressEvent('ev-accepted', 1000, attr('ev-accepted'));
    db.acceptIngressEvent('ev-failed', 1001, attr('ev-failed'));
    db.incrementSpawnAttempts('ev-failed');
    db.markIngressFailed('ev-failed');
    db.acceptIngressEvent('ev-exhausted', 1002, attr('ev-exhausted'));
    for (let i = 0; i < 3; i++) db.incrementSpawnAttempts('ev-exhausted');
    db.markIngressFailed('ev-exhausted');
    db.acceptIngressEvent('ev-spawned', 1003, attr('ev-spawned'));
    db.markIngressSpawned('ev-spawned');

    expect(db.countQueuedIngressForRun(KEYED.runId, 3, null)).toBe(2);
    expect(db.countQueuedIngressForRun(KEYED.runId, 3, 'ev-accepted')).toBe(0);
    expect(db.countQueuedIngressForRun(KEYED.runId, 3, 'ev-failed')).toBe(1);
    expect(db.countQueuedIngressForRun(KEYED.runId, 3, 'ev-spawned')).toBe(2);
    expect(db.countQueuedIngressForRun('igk-other', 3, null)).toBe(0);
  });
});

describe('run_pass_events', () => {
  const attr = (ev: string) => ({ flowId: 'f', flowPath: '/f.yaml', runId: KEYED.runId, substrateJson: `{"e":"${ev}"}` });

  it('records which pass consumed each event, and refuses to record an event twice', () => {
    const db = open();
    expect(db.getPassForEvent('ev-1')).toBeNull();
    db.recordPassEvents(KEYED.runId, 2, ['ev-1', 'ev-2']);
    expect(db.getPassForEvent('ev-1')).toEqual({ run_id: KEYED.runId, pass: 2 });
    expect(db.getPassForEvent('ev-2')).toEqual({ run_id: KEYED.runId, pass: 2 });
    expect(() => db.recordPassEvents(KEYED.runId, 3, ['ev-2'])).toThrow();
  });

  // the insert loop is not atomic on its own —
  // a duplicate later in the list must not leave an earlier insert recorded,
  // since callers rely on "a row here means the pass exists".
  it('rolls back the whole call when one event in the list is already recorded', () => {
    const db = open();
    db.recordPassEvents(KEYED.runId, 2, ['already-recorded']);
    expect(() => db.recordPassEvents(KEYED.runId, 3, ['new-a', 'already-recorded'])).toThrow();
    expect(db.getPassForEvent('new-a')).toBeNull();
  });

  it('lists coalesced events no pass consumed, oldest first, up to and including the named event', () => {
    const db = open();
    for (const [ev, at] of [['ev-a', 1000], ['ev-b', 1001], ['ev-c', 1002], ['ev-d', 1003], ['ev-e', 1004]] as const) {
      db.acceptIngressEvent(ev, at, attr(ev));
      db.markIngressCoalesced(ev);
    }
    db.recordPassEvents(KEYED.runId, 2, ['ev-a']); // consumed
    db.markIngressRefused('ev-c'); // no longer coalesced
    db.acceptIngressEvent('ev-other', 1001, { ...attr('ev-other'), runId: 'igk-other' });
    db.markIngressCoalesced('ev-other');

    expect(db.listUnappliedCoalesced(KEYED.runId, 'ev-d').map((r) => r.event_id)).toEqual(['ev-b', 'ev-d']);
    expect(db.listUnappliedCoalesced(KEYED.runId, 'ev-e').map((r) => r.event_id)).toEqual(['ev-b', 'ev-d', 'ev-e']);
    expect(db.listUnappliedCoalesced(KEYED.runId, 'ev-missing')).toEqual([]);
  });
});

describe('new ingress_log outcomes', () => {
  it.each(['filtered', 'rejected_run_key', 'coalesced', 'pass_limit', 'run_not_appendable', 'pass_failed', 'already_applied'] as const)(
    'accepts %s',
    (outcome) => {
      const db = open();
      db.appendIngressLog({ source: 'pr-loop', eventId: 'ev-1', outcome });
      expect(db.getIngressLog({ outcome })).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// v10→v11 migration
// ---------------------------------------------------------------------------

function buildV10StateDb(): void {
  // A fresh DB is the v10 shape minus the new table; build one with the
  // current code, drop the table, and stamp 10.
  const db = openConduitDB({ stateDbPath, journalDbPath });
  db.acceptIngressEvent('pre-v11-event', 999);
  db.close();
  const raw = new Database(stateDbPath);
  raw.exec('DROP TABLE IF EXISTS ingress_keyed_runs');
  raw.exec('DROP TABLE IF EXISTS run_pass_events');
  raw.exec('PRAGMA user_version = 10');
  raw.close();
}

describe('v10→v11 migration', () => {
  it('creates ingress_keyed_runs and run_pass_events, keeps existing rows, and stamps the version', () => {
    buildV10StateDb();
    const db = open();
    expect(db.getIngressEvent('pre-v11-event')!.spawn_state).toBe('accepted');
    db.upsertKeyedRun(KEYED);
    expect(db.getKeyedRun(KEYED.runId)!.flow_id).toBe('pr-loop');
    db.recordPassEvents(KEYED.runId, 1, ['pre-v11-event']);
    expect(db.getPassForEvent('pre-v11-event')).toEqual({ run_id: KEYED.runId, pass: 1 });
    db.close();
    const check = new Database(stateDbPath, { readonly: true });
    try {
      const { user_version } = check.query('PRAGMA user_version').get() as { user_version: number };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }
  });

  it('re-opening a migrated DB is idempotent', () => {
    buildV10StateDb();
    open().close();
    const db = open();
    db.upsertKeyedRun(KEYED);
    expect(db.getKeyedRun(KEYED.runId)).not.toBeNull();
  });
});
