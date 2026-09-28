/**
 * Tests for the run registry module (WI-476).
 *
 * run-registry.ts layers idempotent addressing on top of the raw insertRun/getRun
 * accessors provided by WI-474. It computes a deterministic fingerprint from the
 * flow body and serialized inputs, then enforces three outcomes:
 *
 *   registerRun(runId, flow, inputFingerprint)
 *     → { kind: 'created', run }      — fresh id, new record persisted
 *     → { kind: 'existing', run }     — known id, exact-match re-submit, no mutation
 *     → { kind: 'conflict', recorded } — known id, flow or fingerprint differs, fail-closed
 *
 *   computeFingerprint(flow, inputs)
 *     → sha256(canonicalJSON({ flow: <normalizedFlowText>, input: <serializedInputs> }))
 *     → deterministic: same inputs → same hash; any one-byte change → different hash
 *
 * The module delegates id validation to validateRunId (WI-475) — an invalid id
 * never reaches the registry table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, DEFAULT_RUN_ID, type ConduitDB } from '../persistence/db';
import { registerRun, computeFingerprint, type RegisterRunResult } from './run-registry';
import { acquireRunLease, peekRunLeaseHolder } from './run-lock';

let dir: string;
let stateDbPath: string;
let journalDbPath: string;
let db: ConduitDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-registry-'));
  stateDbPath = join(dir, 'state.sqlite');
  journalDbPath = join(dir, 'journal.sqlite');
  db = openConduitDB({ stateDbPath, journalDbPath });
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-1: registerRun on a fresh id — persists record and returns 'created'.
// ---------------------------------------------------------------------------

describe('registerRun — fresh id creates a record (AC-1)', () => {
  it('returns kind=created for a brand-new run id', () => {
    const result = registerRun(db, 'run-new-1', 'studio', 'fp-abc123');
    expect(result.kind).toBe('created');
  });

  it('persists the run so getRun returns it after registerRun', () => {
    registerRun(db, 'run-persist', 'autocut', 'fp-xyz');
    const record = db.getRun('run-persist');
    expect(record).not.toBeNull();
    expect(record!.run_id).toBe('run-persist');
    expect(record!.flow).toBe('autocut');
    expect(record!.input_fingerprint).toBe('fp-xyz');
  });

  it('persists the project root when one is supplied', () => {
    registerRun(db, 'run-project-root', 'autocut', 'fp-root', '/projects/wendy/podcast');
    const record = db.getRun('run-project-root');
    expect(record).not.toBeNull();
    expect(record!.project_root).toBe('/projects/wendy/podcast');
  });

  it('includes the persisted run record in the created result', () => {
    const result = registerRun(db, 'run-with-record', 'studio', 'fp-abc');
    expect(result.kind).toBe('created');
    expect((result as Extract<RegisterRunResult, { kind: 'created' }>).run.run_id).toBe('run-with-record');
    expect((result as Extract<RegisterRunResult, { kind: 'created' }>).run.flow).toBe('studio');
    expect((result as Extract<RegisterRunResult, { kind: 'created' }>).run.input_fingerprint).toBe('fp-abc');
  });

  it('persists status=running on creation', () => {
    registerRun(db, 'run-status', 'studio', 'fp-1');
    const record = db.getRun('run-status');
    expect(record!.status).toBe('running');
  });

  it('creates distinct records for distinct run ids', () => {
    const r1 = registerRun(db, 'run-A', 'studio', 'fp-A');
    const r2 = registerRun(db, 'run-B', 'studio', 'fp-B');
    expect(r1.kind).toBe('created');
    expect(r2.kind).toBe('created');
    expect(db.getRun('run-A')).not.toBeNull();
    expect(db.getRun('run-B')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2: idempotent re-submit — same id, same flow, same fingerprint → 'existing'.
// ---------------------------------------------------------------------------

describe('registerRun — idempotent re-submit returns existing (AC-2)', () => {
  it('returns kind=existing when same id, flow, and fingerprint are re-submitted', () => {
    registerRun(db, 'run-idem', 'studio', 'fp-same');
    const result = registerRun(db, 'run-idem', 'studio', 'fp-same');
    expect(result.kind).toBe('existing');
  });

  it('returns kind=existing when the same project root is re-submitted', () => {
    registerRun(db, 'run-idem-root', 'studio', 'fp-same', '/projects/a');
    const result = registerRun(db, 'run-idem-root', 'studio', 'fp-same', '/projects/a');
    expect(result.kind).toBe('existing');
  });

  it('does not create a second row on idempotent re-submit', () => {
    registerRun(db, 'run-nodup', 'studio', 'fp-abc');
    registerRun(db, 'run-nodup', 'studio', 'fp-abc');
    // getRun returns the one record, not an array — verifying no duplicate exists
    const record = db.getRun('run-nodup');
    expect(record).not.toBeNull();
    expect(record!.run_id).toBe('run-nodup');
  });

  it('includes the original run record in the existing result', () => {
    registerRun(db, 'run-existing', 'autocut', 'fp-orig');
    const result = registerRun(db, 'run-existing', 'autocut', 'fp-orig');
    expect(result.kind).toBe('existing');
    const existing = result as Extract<RegisterRunResult, { kind: 'existing' }>;
    expect(existing.run.run_id).toBe('run-existing');
    expect(existing.run.flow).toBe('autocut');
    expect(existing.run.input_fingerprint).toBe('fp-orig');
  });

  it('returns existing after three identical submits — not just the second', () => {
    registerRun(db, 'run-multi', 'studio', 'fp-x');
    registerRun(db, 'run-multi', 'studio', 'fp-x');
    const third = registerRun(db, 'run-multi', 'studio', 'fp-x');
    expect(third.kind).toBe('existing');
  });
});

// ---------------------------------------------------------------------------
// Registration takes the run lease in the same insert (issue #83 review): a
// launch killed between registering and acquiring the lease used to leave a
// 'running' row with no holder, which read as running forever.
// ---------------------------------------------------------------------------

describe('registerRun — optional lease holder written with the row', () => {
  const HOLDER = { pid: 4242, acquiredAt: 1_000, startTime: 5_000 };

  it('writes the holder pid, acquired-at and start time in the created row', () => {
    const result = registerRun(db, 'run-held', 'studio', 'fp', undefined, HOLDER);
    expect(result.kind).toBe('created');
    expect(peekRunLeaseHolder(db, 'run-held')).toEqual({ holderPid: 4242, acquiredAt: 1_000, holderStartTime: 5_000 });
  });

  it('writes a NULL start time when the caller could not read one', () => {
    registerRun(db, 'run-held', 'studio', 'fp', undefined, { ...HOLDER, startTime: null });
    expect(peekRunLeaseHolder(db, 'run-held')).toEqual({ holderPid: 4242, acquiredAt: 1_000, holderStartTime: null });
  });

  it('writes no holder when none is given', () => {
    registerRun(db, 'run-free', 'studio', 'fp');
    expect(peekRunLeaseHolder(db, 'run-free')).toBeNull();
  });

  it('leaves an existing row and its holder untouched', () => {
    registerRun(db, 'run-held', 'studio', 'fp', undefined, HOLDER);
    const again = registerRun(db, 'run-held', 'studio', 'fp', undefined, { pid: 9, acquiredAt: 2_000, startTime: 1 });
    expect(again.kind).toBe('existing');
    expect(peekRunLeaseHolder(db, 'run-held')).toEqual({ holderPid: 4242, acquiredAt: 1_000, holderStartTime: 5_000 });
  });

  it('leaves a conflicting row and its holder untouched', () => {
    registerRun(db, 'run-held', 'studio', 'fp', undefined, HOLDER);
    const clash = registerRun(db, 'run-held', 'studio', 'fp-other', undefined, { pid: 9, acquiredAt: 2_000, startTime: 1 });
    expect(clash.kind).toBe('conflict');
    expect(peekRunLeaseHolder(db, 'run-held')).toEqual({ holderPid: 4242, acquiredAt: 1_000, holderStartTime: 5_000 });
  });

  it('the registering pid can then acquire its own lease (re-entrant)', () => {
    registerRun(db, 'run-held', 'studio', 'fp', undefined, HOLDER);
    const lease = acquireRunLease(db, 'run-held', 4242, 2_000, { isPidAlive: () => true, processStartTime: () => 5_000 });
    expect(lease).toEqual({ acquired: true });
    expect(peekRunLeaseHolder(db, 'run-held')).toEqual({ holderPid: 4242, acquiredAt: 2_000, holderStartTime: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// AC-3: conflict detection — same id, different flow or fingerprint → 'conflict'.
// ---------------------------------------------------------------------------

describe('registerRun — conflict on mismatched fingerprint (AC-3)', () => {
  it('returns kind=conflict when the same run id is re-submitted with a different fingerprint', () => {
    registerRun(db, 'run-cfp', 'studio', 'fp-original');
    const result = registerRun(db, 'run-cfp', 'studio', 'fp-DIFFERENT');
    expect(result.kind).toBe('conflict');
  });

  it('returns kind=conflict when re-submitted with a different flow', () => {
    registerRun(db, 'run-cflow', 'studio', 'fp-same');
    const result = registerRun(db, 'run-cflow', 'autocut', 'fp-same');
    expect(result.kind).toBe('conflict');
  });

  it('returns kind=conflict when both flow and fingerprint differ', () => {
    registerRun(db, 'run-cboth', 'studio', 'fp-A');
    const result = registerRun(db, 'run-cboth', 'autocut', 'fp-B');
    expect(result.kind).toBe('conflict');
  });

  it('does NOT overwrite or mutate the recorded run on conflict', () => {
    registerRun(db, 'run-nomut', 'studio', 'fp-original');
    registerRun(db, 'run-nomut', 'studio', 'fp-tampered');

    const record = db.getRun('run-nomut');
    expect(record!.flow).toBe('studio');
    expect(record!.input_fingerprint).toBe('fp-original');
  });

  it('includes the original recorded run in the conflict result', () => {
    registerRun(db, 'run-crecord', 'studio', 'fp-original');
    const result = registerRun(db, 'run-crecord', 'autocut', 'fp-different');
    expect(result.kind).toBe('conflict');
    const conflict = result as Extract<RegisterRunResult, { kind: 'conflict' }>;
    expect(conflict.recorded.run_id).toBe('run-crecord');
    expect(conflict.recorded.flow).toBe('studio');
    expect(conflict.recorded.input_fingerprint).toBe('fp-original');
  });

  it('a single changed byte in the fingerprint triggers conflict, not existing', () => {
    registerRun(db, 'run-byte', 'studio', 'aabbccdd');
    const result = registerRun(db, 'run-byte', 'studio', 'aabbccdD');
    expect(result.kind).toBe('conflict');
  });

  it('returns kind=conflict when only the project root differs', () => {
    registerRun(db, 'run-croot', 'studio', 'fp-same', '/projects/a');
    const result = registerRun(db, 'run-croot', 'studio', 'fp-same', '/projects/b');
    expect(result.kind).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// AC-4: getRun returns the recorded run or null.
// ---------------------------------------------------------------------------

describe('getRun — raw accessor passthrough (AC-4)', () => {
  it('returns null for a run id that was never registered', () => {
    expect(db.getRun('no-such-run')).toBeNull();
  });

  it('returns the recorded run after a successful registerRun', () => {
    registerRun(db, 'run-found', 'studio', 'fp-123');
    const record = db.getRun('run-found');
    expect(record).not.toBeNull();
    expect(record!.run_id).toBe('run-found');
  });

  it('returns null for a different run id even after registering one', () => {
    registerRun(db, 'run-only-this', 'studio', 'fp-x');
    expect(db.getRun('run-not-this')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-5: invalid run id is rejected before reaching the registry.
// ---------------------------------------------------------------------------

describe('registerRun — invalid run id rejected before DB (AC-5)', () => {
  it.each([
    ['empty string', ''],
    ['path traversal', '../bad'],
    ['forward slash', 'a/b'],
    ['whitespace', 'a b'],
    ['SQL injection payload', "x'); DROP TABLE runs;--"],
    ['over-length (129 chars)', 'a'.repeat(129)],
    ['null byte', 'a\x00b'],
  ])('throws for invalid id: %s', (_label, id) => {
    expect(() => registerRun(db, id, 'studio', 'fp-abc')).toThrow();
  });

  it('does NOT persist any record when registerRun throws on an invalid id', () => {
    try {
      registerRun(db, '../bad', 'studio', 'fp-abc');
    } catch {
      // expected
    }
    // No run was inserted; the DB table remains empty for this id
    const raw = db.getStateDb();
    const rows = raw.query('SELECT * FROM runs').all();
    expect(rows).toHaveLength(0);
  });

  it('accepts a valid id at the boundary length (128 chars)', () => {
    const validId = 'a'.repeat(128);
    const result = registerRun(db, validId, 'studio', 'fp-abc');
    expect(result.kind).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// computeFingerprint — deterministic sha256 hash (AC-2 fingerprint contract).
// ---------------------------------------------------------------------------

describe('computeFingerprint — deterministic sha256(canonicalJSON) (fingerprint AC)', () => {
  it('returns the same hash for identical flow and inputs', () => {
    const inputs = { jobId: '42', assets: ['a.mp4', 'b.mp4'] };
    const h1 = computeFingerprint('flow-body-v1', inputs);
    const h2 = computeFingerprint('flow-body-v1', inputs);
    expect(h1).toBe(h2);
  });

  it('returns a different hash when the flow body changes by one byte', () => {
    const inputs = { jobId: '42' };
    const h1 = computeFingerprint('flow-body', inputs);
    const h2 = computeFingerprint('flow-bodY', inputs);
    expect(h1).not.toBe(h2);
  });

  it('returns a different hash when a single input value changes', () => {
    const h1 = computeFingerprint('same-flow', { jobId: '1' });
    const h2 = computeFingerprint('same-flow', { jobId: '2' });
    expect(h1).not.toBe(h2);
  });

  it('returns a different hash when an input key is added', () => {
    const h1 = computeFingerprint('same-flow', { a: 1 });
    const h2 = computeFingerprint('same-flow', { a: 1, b: 2 });
    expect(h1).not.toBe(h2);
  });

  it('returns a different hash when an input key is removed', () => {
    const h1 = computeFingerprint('same-flow', { a: 1, b: 2 });
    const h2 = computeFingerprint('same-flow', { a: 1 });
    expect(h1).not.toBe(h2);
  });

  it('is not affected by JSON key ordering (canonical serialization)', () => {
    const h1 = computeFingerprint('same-flow', { a: 1, b: 2 });
    const h2 = computeFingerprint('same-flow', { b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('returns a non-empty hex string', () => {
    const h = computeFingerprint('flow', {});
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('returns a sha256-length string (64 hex chars)', () => {
    const h = computeFingerprint('flow', { x: 1 });
    expect(h).toHaveLength(64);
  });

  it('is stable across calls with empty inputs', () => {
    const h1 = computeFingerprint('my-flow', {});
    const h2 = computeFingerprint('my-flow', {});
    expect(h1).toBe(h2);
  });

  it('differs when flow is the same but inputs are empty vs non-empty', () => {
    const h1 = computeFingerprint('flow', {});
    const h2 = computeFingerprint('flow', { x: 1 });
    expect(h1).not.toBe(h2);
  });

  it('returns a different hash when the project root changes', () => {
    const h1 = computeFingerprint('same-flow', { jobId: '1' }, '/projects/a');
    const h2 = computeFingerprint('same-flow', { jobId: '1' }, '/projects/b');
    expect(h1).not.toBe(h2);
  });

  it('returns the same hash for identical project root values', () => {
    const h1 = computeFingerprint('same-flow', { jobId: '1' }, '/projects/a');
    const h2 = computeFingerprint('same-flow', { jobId: '1' }, '/projects/a');
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: computeFingerprint → registerRun round-trip.
// ---------------------------------------------------------------------------

describe('computeFingerprint + registerRun — end-to-end round-trip', () => {
  it('registering with a computed fingerprint is idempotent on re-submit', () => {
    const flow = 'studio-v1-yaml-body';
    const inputs = { jobId: 'job-42', assets: ['clip1.mp4'] };
    const fp = computeFingerprint(flow, inputs);

    const r1 = registerRun(db, 'run-e2e-1', flow, fp);
    const r2 = registerRun(db, 'run-e2e-1', flow, fp);
    expect(r1.kind).toBe('created');
    expect(r2.kind).toBe('existing');
  });

  it('a one-byte flow change produces a conflict, not existing', () => {
    const inputs = { jobId: 'job-42' };
    const fp1 = computeFingerprint('flow-v1', inputs);
    const fp2 = computeFingerprint('flow-v2', inputs);

    registerRun(db, 'run-e2e-2', 'flow-v1', fp1);
    const result = registerRun(db, 'run-e2e-2', 'flow-v2', fp2);
    expect(result.kind).toBe('conflict');
  });

  it('a one-byte input change produces a conflict, not existing', () => {
    const flow = 'same-flow';
    const fp1 = computeFingerprint(flow, { jobId: 'job-1' });
    const fp2 = computeFingerprint(flow, { jobId: 'job-2' });

    registerRun(db, 'run-e2e-3', flow, fp1);
    const result = registerRun(db, 'run-e2e-3', flow, fp2);
    expect(result.kind).toBe('conflict');
  });
});
