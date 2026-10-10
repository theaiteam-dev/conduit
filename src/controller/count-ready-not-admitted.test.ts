/**
 * Issue #30, ADR-0012: `ready_waiting` on an overlapped harness span counts the
 * dispatchable cards that are not members of the call's batch. Driven directly,
 * because in a real batch the members have usually been claimed off `ready` by
 * the time the count runs, so the member exclusion is not observable there.
 */
import { describe, it, expect } from 'bun:test';
import { openConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { countReadyNotAdmitted } from './executor';

function seed(): ReturnType<typeof openConduitDB> {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  for (const id of ['c1', 'c2', 'c3', 'c4']) {
    db.insertCard({
      run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'walk', status: 'ready',
      attempt: 0, wave: 0, owned_paths: [`evidence/${id}`], rework_count: 0,
    });
  }
  return db;
}

describe('countReadyNotAdmitted', () => {
  it('counts ready cards that are not batch members', () => {
    const db = seed();
    expect(countReadyNotAdmitted(db.getStateDb(), DEFAULT_RUN_ID, new Set(['c1', 'c2']), 1000)).toBe(2);
    expect(countReadyNotAdmitted(db.getStateDb(), DEFAULT_RUN_ID, new Set(), 1000)).toBe(4);
  });

  it('leaves out a card gated behind a future release_at, and a card that is not ready', () => {
    const db = seed();
    db.getStateDb().prepare("UPDATE cards SET release_at = 2000 WHERE id = 'c3'").run();
    db.getStateDb().prepare("UPDATE cards SET status = 'working' WHERE id = 'c4'").run();
    expect(countReadyNotAdmitted(db.getStateDb(), DEFAULT_RUN_ID, new Set(['c1']), 1000)).toBe(1);
    expect(countReadyNotAdmitted(db.getStateDb(), DEFAULT_RUN_ID, new Set(['c1']), 2000)).toBe(2);
  });
});
