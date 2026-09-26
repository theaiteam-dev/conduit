/**
 * Tests for checkpoint binding stamp + effectful-station outbox (WI-298).
 *
 * SPEC §5, FR-8/9, SPEC §16 step 4 — recovery soundness:
 *
 *   - On ACK_DONE a station output is checkpointed keyed by
 *     (flow, card, station, attempt) with a binding stamp =
 *     hash(model_id, prompt_template_version, resolved_input_artifact_hashes,
 *          flow_version).
 *   - On resume a completed station is SKIPPED only if its stamp matches the
 *     current config (no re-execution, no re-bill).
 *   - A stamp MISMATCH invalidates the checkpoint and CASCADES downstream to
 *     any station whose resolved input artifact hashes changed.
 *   - An effectful=true station writes a PENDING outbox intent (with an
 *     idempotency_key) BEFORE the side effect and marks it committed on
 *     success; on resume a pending row is NEVER blind-retried — the kernel
 *     reconciles against the recorded intent or escalates to hold (SPEC §5 C3).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/checkpoint/checkpoint.ts
 * ---------------------------------------------------------------------------
 *
 *   // The four binding-stamp inputs (SPEC §5).
 *   export interface BindingStampInputs {
 *     modelId: string;
 *     promptTemplateVersion: string;
 *     inputArtifactHashes: string[];   // resolved_input_artifact_hashes
 *     flowVersion: number;
 *   }
 *   export function computeBindingStamp(inputs: BindingStampInputs): string;
 *
 *   export interface CheckpointKey { flow: string; card: string; station: string; attempt: number }
 *   export interface CheckpointRecord { output: StationOutput<unknown>; stamp: string }
 *
 *   // Idempotent schema init — creates the `checkpoints` table and ensures the
 *   // `outbox` table (CREATE TABLE IF NOT EXISTS, compatible with WI-290).
 *   // NOTE (flagged to Hannibal/B.A.): WI-290's ConduitDB exposes no accessor
 *   // for station_outputs/outbox and station_outputs has no binding_stamp/flow
 *   // column, so the checkpoint module owns its own `checkpoints` table and
 *   // operates on a raw bun:sqlite Database (the state DB), reusing the outbox
 *   // columns (idempotency_key UNIQUE, payload_json, delivered_at).
 *   export function ensureCheckpointSchema(db: Database): void;
 *
 *   export function writeCheckpoint(db: Database, key: CheckpointKey, record: CheckpointRecord): void;
 *   export function readCheckpoint(db: Database, key: CheckpointKey): CheckpointRecord | null;
 *   export function invalidateCheckpoint(db: Database, key: CheckpointKey): void;
 *
 *   export type ResumeDecision =
 *     | { action: 'reuse'; output: StationOutput<unknown> }                       // stamp matched → skip, no re-bill
 *     | { action: 'reexecute'; reason: 'no_checkpoint' | 'stamp_mismatch' };
 *   export function decideResume(db: Database, key: CheckpointKey, currentStamp: string): ResumeDecision;
 *
 *   // Pure artifact-dependency reachability (SPEC §9 DFS): given the stations
 *   // whose stamps are invalid (seeds), returns every station to invalidate —
 *   // any station transitively consuming a (re-executed) upstream output.
 *   export interface FlowGraph { stations: Array<{ id: string; inputs: string[]; outputs: string[] }> }
 *   export function cascadeInvalidation(graph: FlowGraph, seeds: string[]): string[];
 *
 *   // Outbox intent for effectful stations.
 *   export interface OutboxIntent {
 *     flow: string; card: string; station: string; attempt: number;
 *     idempotencyKey: string;
 *     intent: Record<string, unknown>;
 *   }
 *   export type OutboxStatus = 'none' | 'pending' | 'committed';
 *   export function writePendingIntent(db: Database, intent: OutboxIntent): void; // delivered_at NULL
 *   export function commitIntent(db: Database, idempotencyKey: string): void;     // sets delivered_at
 *   export function getIntentStatus(db: Database, idempotencyKey: string): OutboxStatus;
 *
 *   // Resume reconciliation — NEVER blind-retries a pending effect.
 *   export type Reconciler = (intent: Record<string, unknown>) => 'landed' | 'not_landed' | 'unknown';
 *   export type OutboxReconcile =
 *     | { action: 'fire' }                                  // safe to execute the effect
 *     | { action: 'skip' }                                  // effect already landed — do not re-fire
 *     | { action: 'escalate_hold'; intent: Record<string, unknown> };  // ambiguous → hold, never blind-retry
 *   export function reconcileOnResume(
 *     db: Database, idempotencyKey: string, reconciler?: Reconciler,
 *   ): OutboxReconcile;
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { StationOutput } from '../types/kernel';
import {
  computeBindingStamp,
  ensureCheckpointSchema,
  writeCheckpoint,
  readCheckpoint,
  readLatestCheckpoint,
  invalidateCheckpoint,
  decideResume,
  cascadeInvalidation,
  writePendingIntent,
  commitIntent,
  discardIntent,
  getIntentStatus,
  reconcileOnResume,
} from './checkpoint';
import type {
  BindingStampInputs,
  CheckpointKey,
  FlowGraph,
  OutboxIntent,
} from './checkpoint';
import { defaultRunId } from '../run/run-id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  ensureCheckpointSchema(db);
});

afterEach(() => {
  db.close();
});

const STAMP_INPUTS: BindingStampInputs = {
  modelId: 'gpt-4o',
  promptTemplateVersion: 'v3',
  inputArtifactHashes: ['hashA', 'hashB'],
  flowVersion: 7,
};

function sampleOutput(payload: unknown = { foo: 'ok' }): StationOutput<unknown> {
  return { payload, findings_hash: 'fh-1', return_to: null, usage: { tokens: 15, cost: 0.0012 } };
}

const KEY: CheckpointKey = { flow: 'ref', card: 'card-1', station: 'render', attempt: 0 };

// ===========================================================================
// Binding stamp (SPEC §5) — deterministic + sensitive to each input.
// ===========================================================================

describe('computeBindingStamp', () => {
  it('is deterministic for identical inputs', () => {
    expect(computeBindingStamp(STAMP_INPUTS)).toBe(computeBindingStamp(STAMP_INPUTS));
  });

  it('returns a non-empty stamp', () => {
    expect(computeBindingStamp(STAMP_INPUTS).length).toBeGreaterThan(0);
  });

  it.each([
    ['modelId', { ...STAMP_INPUTS, modelId: 'gemini-2.5-pro' }],
    ['promptTemplateVersion', { ...STAMP_INPUTS, promptTemplateVersion: 'v4' }],
    ['flowVersion', { ...STAMP_INPUTS, flowVersion: 8 }],
    ['inputArtifactHashes', { ...STAMP_INPUTS, inputArtifactHashes: ['hashA', 'CHANGED'] }],
  ])('changes when %s changes', (_label, changed) => {
    expect(computeBindingStamp(changed)).not.toBe(computeBindingStamp(STAMP_INPUTS));
  });

  // #16: inputArtifactHashes is a SET, not an ordered list. Reordering the same
  // resolved inputs must NOT change the stamp — otherwise an upstream enumeration
  // reorder triggers a false stamp_mismatch (needless re-bill + spurious cascade).
  it('is invariant to the order of inputArtifactHashes (set semantics)', () => {
    const forward = { ...STAMP_INPUTS, inputArtifactHashes: ['hashA', 'hashB', 'hashC'] };
    const reordered = { ...STAMP_INPUTS, inputArtifactHashes: ['hashC', 'hashA', 'hashB'] };
    expect(computeBindingStamp(reordered)).toBe(computeBindingStamp(forward));
  });

  it('still distinguishes a genuinely different set of input hashes', () => {
    const base = { ...STAMP_INPUTS, inputArtifactHashes: ['hashA', 'hashB'] };
    const different = { ...STAMP_INPUTS, inputArtifactHashes: ['hashA', 'hashB', 'hashC'] };
    expect(computeBindingStamp(different)).not.toBe(computeBindingStamp(base));
  });
});

// ===========================================================================
// AC1 — checkpoint stored keyed by (flow, card, station, attempt) + stamp
// ===========================================================================

describe('writeCheckpoint / readCheckpoint (AC1)', () => {
  it('stores and returns the output and stamp keyed by (flow, card, station, attempt)', () => {
    const stamp = computeBindingStamp(STAMP_INPUTS);
    const output = sampleOutput();
    writeCheckpoint(db, KEY, { output, stamp });

    expect(readCheckpoint(db, KEY)).toEqual({ output, stamp });
  });

  it('does not collide across different attempts of the same station', () => {
    const a0 = computeBindingStamp(STAMP_INPUTS);
    const a1 = computeBindingStamp({ ...STAMP_INPUTS, inputArtifactHashes: ['x'] });
    writeCheckpoint(db, { ...KEY, attempt: 0 }, { output: sampleOutput({ a: 0 }), stamp: a0 });
    writeCheckpoint(db, { ...KEY, attempt: 1 }, { output: sampleOutput({ a: 1 }), stamp: a1 });

    expect(readCheckpoint(db, { ...KEY, attempt: 0 })?.output.payload).toEqual({ a: 0 });
    expect(readCheckpoint(db, { ...KEY, attempt: 1 })?.output.payload).toEqual({ a: 1 });
  });

  it('returns null when no checkpoint exists for the key', () => {
    expect(readCheckpoint(db, KEY)).toBeNull();
  });

  it('overwrites in place on a repeated write to the same key (INSERT OR REPLACE — one row, new stamp)', () => {
    // Amy gap #4: a re-checkpoint after rework must REPLACE, not accumulate rows.
    writeCheckpoint(db, KEY, { output: sampleOutput({ v: 1 }), stamp: 'stamp-old' });
    writeCheckpoint(db, KEY, { output: sampleOutput({ v: 2 }), stamp: 'stamp-new' });

    // Exactly one row remains for the key...
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM checkpoints
         WHERE flow = $flow AND card = $card AND station = $station AND attempt = $attempt`,
      )
      .get({
        $flow: KEY.flow,
        $card: KEY.card,
        $station: KEY.station,
        $attempt: KEY.attempt,
      }) as { n: number };
    expect(n).toBe(1);

    // ...holding the latest stamp + output.
    expect(readCheckpoint(db, KEY)).toEqual({ output: sampleOutput({ v: 2 }), stamp: 'stamp-new' });
  });
});

// ===========================================================================
// readLatestCheckpoint (issue #32 skip_when, reviewer follow-up) — pins that
// invalidation can never surface through the "highest attempt" reader.
//
// readLatestCheckpoint does no stamp check of its own (see its doc comment).
// These tests pin the two facts that make that safe: invalidateCheckpoint
// DELETEs the row rather than marking it stale, and a card's attempt number
// for a given station only ever increases, so the highest surviving attempt
// is never a payload that was invalidated out from under it.
// ===========================================================================

describe('readLatestCheckpoint — invalidation cannot leak through (reviewer follow-up)', () => {
  it('returns null, not the invalidated payload, once the latest attempt is invalidated', () => {
    const stamp = computeBindingStamp(STAMP_INPUTS);
    writeCheckpoint(db, { ...KEY, attempt: 0 }, { output: sampleOutput({ v: 0 }), stamp });
    invalidateCheckpoint(db, { ...KEY, attempt: 0 });

    expect(readLatestCheckpoint(db, KEY)).toBeNull();
  });

  it('falls back to an older, still-valid attempt when only the newest is invalidated', () => {
    // attempt 0 completed normally; attempt 1 (a later rework pass) is the
    // one whose stamp went stale and was invalidated. Nothing deletes
    // attempt 0 — it was never the row identified as invalid.
    const stamp = computeBindingStamp(STAMP_INPUTS);
    writeCheckpoint(db, { ...KEY, attempt: 0 }, { output: sampleOutput({ v: 0 }), stamp });
    writeCheckpoint(db, { ...KEY, attempt: 1 }, { output: sampleOutput({ v: 1 }), stamp });
    invalidateCheckpoint(db, { ...KEY, attempt: 1 });

    // Conclusion (see readLatestCheckpoint's doc comment): this is not a
    // staleness bug. Returning attempt 0's payload here is indistinguishable
    // from a skip_when predicate being evaluated BEFORE attempt 1 ever ran —
    // a state the reader already has to tolerate (SPEC §4: an unreadable/
    // not-yet-produced value holds, a readable one is honoured). The FSM
    // never lets a downstream card become ready to read this station's
    // output until this station's current attempt has completed and
    // checkpointed, so a skip_when evaluation can never observe the gap
    // between "attempt 1 invalidated" and "attempt 2 written" in the first
    // place — this test pins the reader's behaviour in that gap anyway.
    expect(readLatestCheckpoint(db, KEY)?.output.payload).toEqual({ v: 0 });
  });

  it('picks up the fresh checkpoint once the invalidated attempt is re-executed', () => {
    const stampOld = computeBindingStamp(STAMP_INPUTS);
    writeCheckpoint(db, { ...KEY, attempt: 0 }, { output: sampleOutput({ v: 'stale' }), stamp: stampOld });
    invalidateCheckpoint(db, { ...KEY, attempt: 0 });

    // Re-execution never reuses a deleted attempt number — the kernel's
    // attempt counter for a card only increases — so the fresh run lands at
    // attempt 1, strictly higher than the invalidated (and now-absent) 0.
    const stampNew = computeBindingStamp({ ...STAMP_INPUTS, modelId: 'gemini-2.5-pro' });
    writeCheckpoint(db, { ...KEY, attempt: 1 }, { output: sampleOutput({ v: 'fresh' }), stamp: stampNew });

    expect(readLatestCheckpoint(db, KEY)?.output.payload).toEqual({ v: 'fresh' });
  });
});

// ===========================================================================
// AC2 / AC6 — resume: matching stamp reuses (no re-exec); mismatch re-executes
// ===========================================================================

describe('decideResume (AC2, AC6)', () => {
  it('reuses the checkpoint (no re-execution) when the stamp matches current config (AC2)', () => {
    const stamp = computeBindingStamp(STAMP_INPUTS);
    const output = sampleOutput();
    writeCheckpoint(db, KEY, { output, stamp });

    expect(decideResume(db, KEY, stamp)).toEqual({ action: 'reuse', output });
  });

  it('re-executes on a stamp mismatch (e.g. changed model_id) (AC6)', () => {
    const stored = computeBindingStamp(STAMP_INPUTS);
    writeCheckpoint(db, KEY, { output: sampleOutput(), stamp: stored });

    const currentStamp = computeBindingStamp({ ...STAMP_INPUTS, modelId: 'gemini-2.5-pro' });
    expect(decideResume(db, KEY, currentStamp)).toEqual({
      action: 'reexecute',
      reason: 'stamp_mismatch',
    });
  });

  it('re-executes when there is no checkpoint to reuse', () => {
    expect(decideResume(db, KEY, computeBindingStamp(STAMP_INPUTS))).toEqual({
      action: 'reexecute',
      reason: 'no_checkpoint',
    });
  });

  it('re-executes after the checkpoint is invalidated', () => {
    const stamp = computeBindingStamp(STAMP_INPUTS);
    writeCheckpoint(db, KEY, { output: sampleOutput(), stamp });
    invalidateCheckpoint(db, KEY);

    expect(decideResume(db, KEY, stamp).action).toBe('reexecute');
  });
});

// ===========================================================================
// AC3 — cascade invalidation along artifact-dependency edges
// ===========================================================================

describe('cascadeInvalidation (AC3)', () => {
  // draft → {gate, render} → assemble ; sideline is independent.
  const graph: FlowGraph = {
    stations: [
      { id: 'draft', inputs: [], outputs: ['artA'] },
      { id: 'gate', inputs: ['artA'], outputs: ['artGate'] },
      { id: 'render', inputs: ['artA'], outputs: ['artR'] },
      { id: 'assemble', inputs: ['artR', 'artGate'], outputs: ['artFinal'] },
      { id: 'sideline', inputs: ['artX'], outputs: ['artY'] },
    ],
  };

  it('invalidates every station transitively downstream of the seed', () => {
    const invalidated = new Set(cascadeInvalidation(graph, ['draft']));
    expect(invalidated).toEqual(new Set(['draft', 'gate', 'render', 'assemble']));
  });

  it('does NOT invalidate a station whose inputs did not change', () => {
    const invalidated = cascadeInvalidation(graph, ['draft']);
    expect(invalidated).not.toContain('sideline');
  });

  // Amy gap #3: cyclic artifact graphs must terminate. Each of these would
  // infinite-loop (hang → timeout) if the BFS visited-guard were removed.
  const cycleCases: Array<{ label: string; graph: FlowGraph; seeds: string[]; expected: string[] }> = [
    {
      label: 'direct A<->B cycle',
      graph: {
        stations: [
          { id: 'A', inputs: ['artB'], outputs: ['artA'] },
          { id: 'B', inputs: ['artA'], outputs: ['artB'] },
        ],
      },
      seeds: ['A'],
      expected: ['A', 'B'],
    },
    {
      label: 'three-station A->B->C->A cycle',
      graph: {
        stations: [
          { id: 'A', inputs: ['artC'], outputs: ['artA'] },
          { id: 'B', inputs: ['artA'], outputs: ['artB'] },
          { id: 'C', inputs: ['artB'], outputs: ['artC'] },
        ],
      },
      seeds: ['A'],
      expected: ['A', 'B', 'C'],
    },
    {
      label: 'self-loop',
      graph: { stations: [{ id: 'S', inputs: ['artS'], outputs: ['artS'] }] },
      seeds: ['S'],
      expected: ['S'],
    },
  ];

  for (const { label, graph: cyclicGraph, seeds, expected } of cycleCases) {
    it(`terminates and resolves the full set on a ${label}`, () => {
      expect(new Set(cascadeInvalidation(cyclicGraph, seeds))).toEqual(new Set(expected));
    });
  }

  it('cascades a stamp mismatch to downstream checkpoints, sparing independent stations', () => {
    // Checkpoint every station with a matching stamp.
    const stamps: Record<string, string> = {};
    for (const s of graph.stations) {
      stamps[s.id] = computeBindingStamp({ ...STAMP_INPUTS, inputArtifactHashes: [s.id] });
      writeCheckpoint(
        db,
        { flow: 'ref', card: 'card-1', station: s.id, attempt: 0 },
        { output: sampleOutput({ s: s.id }), stamp: stamps[s.id] },
      );
    }

    // draft's stamp no longer matches (model_id changed upstream).
    const draftKey: CheckpointKey = { flow: 'ref', card: 'card-1', station: 'draft', attempt: 0 };
    const draftNow = computeBindingStamp({
      ...STAMP_INPUTS,
      inputArtifactHashes: ['draft'],
      modelId: 'gemini-2.5-pro',
    });
    expect(decideResume(db, draftKey, draftNow)).toEqual({ action: 'reexecute', reason: 'stamp_mismatch' });

    // Kernel cascades: invalidate every affected downstream checkpoint.
    for (const id of cascadeInvalidation(graph, ['draft'])) {
      invalidateCheckpoint(db, { flow: 'ref', card: 'card-1', station: id, attempt: 0 });
    }

    // Downstream stations must re-execute...
    for (const id of ['draft', 'gate', 'render', 'assemble']) {
      const key: CheckpointKey = { flow: 'ref', card: 'card-1', station: id, attempt: 0 };
      expect(decideResume(db, key, stamps[id]).action).toBe('reexecute');
    }
    // ...but the independent station still reuses its checkpoint (no re-bill).
    const sideKey: CheckpointKey = { flow: 'ref', card: 'card-1', station: 'sideline', attempt: 0 };
    expect(decideResume(db, sideKey, stamps['sideline']).action).toBe('reuse');
  });
});

// ===========================================================================
// AC4 — effectful station: pending intent BEFORE side effect, committed after
// ===========================================================================

describe('outbox intent lifecycle (AC4)', () => {
  const intent: OutboxIntent = {
    flow: 'ref',
    card: 'card-1',
    station: 'render',
    attempt: 0,
    idempotencyKey: 'ref:card-1:render:0',
    intent: { kind: 'image-gen', prompt_hash: 'ph1' },
  };

  it('writes a pending intent before the side effect, then marks it committed on success', () => {
    expect(getIntentStatus(db, intent.idempotencyKey)).toBe('none');

    writePendingIntent(db, intent);
    expect(getIntentStatus(db, intent.idempotencyKey)).toBe('pending');

    commitIntent(db, intent.idempotencyKey);
    expect(getIntentStatus(db, intent.idempotencyKey)).toBe('committed');
  });

  it('rejects a duplicate idempotency_key (no double intent for the same effect)', () => {
    writePendingIntent(db, intent);
    expect(() => writePendingIntent(db, intent)).toThrow();
  });

  it('throws when committing a non-existent idempotency_key (no silent no-op)', () => {
    // Amy gap #2 (REAL behavior gap): committing a key that was never written
    // as pending is a programming error — it must signal loudly, not silently
    // UPDATE zero rows. B.A. must make commitIntent throw when no row matches.
    expect(() => commitIntent(db, 'ref:card-1:render:NOPE')).toThrow();
    // And it must not have phantom-created any committed row for that key.
    expect(getIntentStatus(db, 'ref:card-1:render:NOPE')).toBe('none');
  });

  // Code-review fix #1 — discardIntent abandons a PENDING intent whose effect
  // never landed (non-retryable scrap), so a future replay does not escalate.
  it('discards a pending intent so a replay reconciles to fire, not escalate_hold', () => {
    writePendingIntent(db, intent);
    expect(getIntentStatus(db, intent.idempotencyKey)).toBe('pending');
    // A leftover pending intent would make reconcileOnResume escalate_hold.
    expect(reconcileOnResume(db, intent.idempotencyKey).action).toBe('escalate_hold');

    expect(discardIntent(db, intent.idempotencyKey)).toBe(true);
    expect(getIntentStatus(db, intent.idempotencyKey)).toBe('none');
    // After discard the key is clean again — no dangling pending.
    expect(reconcileOnResume(db, intent.idempotencyKey).action).toBe('fire');
  });

  it('never removes a COMMITTED intent (a landed effect cannot be un-recorded)', () => {
    writePendingIntent(db, intent);
    commitIntent(db, intent.idempotencyKey);
    expect(discardIntent(db, intent.idempotencyKey)).toBe(false);
    expect(getIntentStatus(db, intent.idempotencyKey)).toBe('committed');
  });

  it('is a no-op returning false when no row exists', () => {
    expect(discardIntent(db, 'ref:card-1:render:NEVER')).toBe(false);
    expect(getIntentStatus(db, 'ref:card-1:render:NEVER')).toBe('none');
  });
});

// ===========================================================================
// AC5 — resume reconciliation NEVER blind-retries a pending effect (SPEC §5 C3)
// ===========================================================================

describe('reconcileOnResume (AC5)', () => {
  const key = 'ref:card-1:render:0';
  const baseIntent: OutboxIntent = {
    flow: 'ref',
    card: 'card-1',
    station: 'render',
    attempt: 0,
    idempotencyKey: key,
    intent: { kind: 'publish', target: '#campaigns' },
  };

  it('fires when no intent was ever recorded (safe first execution)', () => {
    expect(reconcileOnResume(db, key)).toEqual({ action: 'fire' });
  });

  it('skips a committed intent — the effect already landed, never re-fire', () => {
    writePendingIntent(db, baseIntent);
    commitIntent(db, key);
    expect(reconcileOnResume(db, key)).toEqual({ action: 'skip' });
  });

  it('escalates a PENDING intent to hold when no reconciler is available — never blind-retries', () => {
    writePendingIntent(db, baseIntent);

    const decision = reconcileOnResume(db, key);
    expect(decision).toEqual({ action: 'escalate_hold', intent: baseIntent.intent });
    // The effect must NOT have been re-fired or auto-committed.
    expect(getIntentStatus(db, key)).toBe('pending');
  });

  it.each([
    ['landed', 'landed', 'skip'],
    ['not_landed', 'not_landed', 'fire'],
    ['unknown', 'unknown', 'escalate_hold'],
  ] as const)(
    'reconciles a pending intent the reconciler reports as %s → %s',
    (_label, verdict, expectedAction) => {
      writePendingIntent(db, baseIntent);
      const decision = reconcileOnResume(db, key, () => verdict);
      expect(decision.action).toBe(expectedAction);
    },
  );

  it('never returns "fire" for a pending intent unless the reconciler confirms it did not land', () => {
    writePendingIntent(db, baseIntent);
    // No reconciler → must escalate, must NOT fire.
    expect(reconcileOnResume(db, key).action).not.toBe('fire');
  });

  it('a "landed" reconcile returns skip WITHOUT persisting a commit, so a later reconciler-less resume escalates', () => {
    // Amy gap #1: pin the full "landed" path — reconcileOnResume does NOT
    // auto-commit, so the row stays pending and the decision is not durable.
    writePendingIntent(db, baseIntent);

    // First resume: reconciler confirms the effect landed → skip.
    expect(reconcileOnResume(db, key, () => 'landed')).toEqual({ action: 'skip' });
    // ...but the row is NOT auto-committed — it remains pending.
    expect(getIntentStatus(db, key)).toBe('pending');

    // A second resume with the same reconciler still resolves to skip.
    expect(reconcileOnResume(db, key, () => 'landed')).toEqual({ action: 'skip' });

    // A later resume WITHOUT a reconciler can no longer confirm the outcome,
    // so it escalates to hold rather than blind-firing the effect.
    expect(reconcileOnResume(db, key)).toEqual({
      action: 'escalate_hold',
      intent: baseIntent.intent,
    });
  });
});

// ===========================================================================
// WI-477 — checkpoint + outbox isolation per run
// ---------------------------------------------------------------------------
// Two runs of the same flow keep fully independent checkpoints AND outbox
// intents — neither the station output store nor the effectful outbox leaks or
// collides across runs.
//
// Contract this block pins for src/checkpoint/checkpoint.ts (the run dimension
// B.A. must add; the run-qualified UNIQUE constraints come from WI-474):
//
//   // CheckpointKey gains an optional `run` field; OutboxIntent gains an
//   // optional `run` field. Both default to defaultRunId() ("default") so
//   // existing single-run callers round-trip byte-for-byte (back-compat AC).
//   export interface CheckpointKey {
//     flow: string; card: string; station: string; attempt: number;
//     run?: string;                       // defaults to defaultRunId()
//   }
//   export interface OutboxIntent {
//     flow: string; card: string; station: string; attempt: number;
//     idempotencyKey: string; intent: Record<string, unknown>;
//     run?: string;                       // defaults to defaultRunId()
//   }
//
//   // The outbox lookup functions gain an optional trailing `run` arg that
//   // scopes the row lookup (default defaultRunId()). With it omitted they
//   // operate under the default run, so every existing call still works.
//   export function commitIntent(db, idempotencyKey, run?): void;
//   export function discardIntent(db, idempotencyKey, run?): boolean;
//   export function getIntentStatus(db, idempotencyKey, run?): OutboxStatus;
//   export function reconcileOnResume(db, idempotencyKey, reconciler?, run?): OutboxReconcile;
//
//   // station_outputs rows are keyed by (run_id, flow, card, station, attempt);
//   // outbox rows are keyed by (run_id, idempotency_key). The same
//   // card/station/attempt or the same idempotency_key under two different runs
//   // are DISTINCT rows that never collide and never read each other's data.
// ===========================================================================

describe('WI-477 — checkpoint isolation per run', () => {
  const RUN_A = 'run-A';
  const RUN_B = 'run-B';
  // Same card/station/attempt under both runs — the dimension that must isolate.
  const keyA: CheckpointKey = { run: RUN_A, flow: 'ref', card: 'card-1', station: 'render', attempt: 0 };
  const keyB: CheckpointKey = { run: RUN_B, flow: 'ref', card: 'card-1', station: 'render', attempt: 0 };
  const stamp = computeBindingStamp(STAMP_INPUTS);

  // AC1 — readCheckpoint for run B never returns run A's record.
  it('readCheckpoint for a different run returns null, not the other run\'s output', () => {
    const outputA = sampleOutput({ owner: 'A' });
    writeCheckpoint(db, keyA, { output: outputA, stamp });

    expect(readCheckpoint(db, keyA)).toEqual({ output: outputA, stamp });
    expect(readCheckpoint(db, keyB)).toBeNull();
  });

  // AC2 — write for run B at the same key inserts a DISTINCT row (no UNIQUE
  // collision) and leaves run A's checkpoint unchanged.
  it('writeCheckpoint for run B at the same key inserts a distinct row and leaves run A unchanged', () => {
    const outputA = sampleOutput({ owner: 'A' });
    const outputB = sampleOutput({ owner: 'B' });
    writeCheckpoint(db, keyA, { output: outputA, stamp });

    // Must NOT throw a UNIQUE collision against run A's row.
    writeCheckpoint(db, keyB, { output: outputB, stamp });

    expect(readCheckpoint(db, keyA)).toEqual({ output: outputA, stamp });
    expect(readCheckpoint(db, keyB)).toEqual({ output: outputB, stamp });
  });

  // AC2 (cont.) — invalidateCheckpoint scoped to run A removes only run A's row.
  it('invalidateCheckpoint scoped to run A removes only run A\'s checkpoint, never run B\'s', () => {
    const outputA = sampleOutput({ owner: 'A' });
    const outputB = sampleOutput({ owner: 'B' });
    writeCheckpoint(db, keyA, { output: outputA, stamp });
    writeCheckpoint(db, keyB, { output: outputB, stamp });

    invalidateCheckpoint(db, keyA);

    expect(readCheckpoint(db, keyA)).toBeNull();
    expect(readCheckpoint(db, keyB)).toEqual({ output: outputB, stamp });
  });

  // AC3 — decideResume for run B with no run-B checkpoint re-executes (no_checkpoint)
  // even when run A has a stamp-matching checkpoint at the same key.
  it('decideResume for run B returns reexecute:no_checkpoint even when run A has a stamp-matching checkpoint', () => {
    writeCheckpoint(db, keyA, { output: sampleOutput({ owner: 'A' }), stamp });

    // Sanity: run A reuses its own matching checkpoint.
    expect(decideResume(db, keyA, stamp)).toEqual({ action: 'reuse', output: sampleOutput({ owner: 'A' }) });

    // Run B has no checkpoint of its own — it must re-execute, NOT borrow run A's.
    expect(decideResume(db, keyB, stamp)).toEqual({ action: 'reexecute', reason: 'no_checkpoint' });
  });
});

describe('WI-477 — outbox isolation per run', () => {
  const RUN_A = 'run-A';
  const RUN_B = 'run-B';
  const KEY = 'ref:card-1:render:0'; // SAME idempotency key under both runs.
  const intentA: OutboxIntent = {
    run: RUN_A,
    flow: 'ref',
    card: 'card-1',
    station: 'render',
    attempt: 0,
    idempotencyKey: KEY,
    intent: { kind: 'publish', target: '#a' },
  };
  const intentB: OutboxIntent = {
    run: RUN_B,
    flow: 'ref',
    card: 'card-1',
    station: 'render',
    attempt: 0,
    idempotencyKey: KEY,
    intent: { kind: 'publish', target: '#b' },
  };

  // AC4 — both runs write the SAME idempotency key with no UNIQUE collision.
  it('writePendingIntent for run A and run B with the same idempotency key both succeed (no collision)', () => {
    writePendingIntent(db, intentA);
    // Must NOT throw a UNIQUE collision against run A's row.
    writePendingIntent(db, intentB);

    expect(getIntentStatus(db, KEY, RUN_A)).toBe('pending');
    expect(getIntentStatus(db, KEY, RUN_B)).toBe('pending');
  });

  // AC4 (cont.) — commitIntent scoped to run A marks only run A's intent committed.
  it('commitIntent scoped to run A commits only run A\'s intent; run B stays pending', () => {
    writePendingIntent(db, intentA);
    writePendingIntent(db, intentB);

    commitIntent(db, KEY, RUN_A);

    expect(getIntentStatus(db, KEY, RUN_A)).toBe('committed');
    expect(getIntentStatus(db, KEY, RUN_B)).toBe('pending');
  });

  // AC5 — reconcileOnResume scoped to run A only sees run A's pending intents;
  // run B's intent at the same key is never reconciled or escalated by run A.
  it('reconcileOnResume scoped to run A escalates run A\'s pending intent and leaves run B\'s untouched', () => {
    writePendingIntent(db, intentA);
    writePendingIntent(db, intentB);

    const decision = reconcileOnResume(db, KEY, undefined, RUN_A);
    expect(decision).toEqual({ action: 'escalate_hold', intent: intentA.intent });

    // Run B's intent at the same key is unaffected — still pending, not escalated/committed.
    expect(getIntentStatus(db, KEY, RUN_B)).toBe('pending');
  });

  it('reconcileOnResume for run B reports run B\'s own intent (never run A\'s payload) at the same key', () => {
    writePendingIntent(db, intentA);
    writePendingIntent(db, intentB);

    const decision = reconcileOnResume(db, KEY, undefined, RUN_B);
    expect(decision).toEqual({ action: 'escalate_hold', intent: intentB.intent });
  });

  // AC5 (cont.) — getIntentStatus(run A, key) is unaffected by run B's intent at the same key.
  it('getIntentStatus for run A is unaffected by run B committing the same idempotency key', () => {
    writePendingIntent(db, intentA);
    writePendingIntent(db, intentB);

    // Run B commits; run A must stay exactly as it was.
    commitIntent(db, KEY, RUN_B);

    expect(getIntentStatus(db, KEY, RUN_A)).toBe('pending');
    expect(getIntentStatus(db, KEY, RUN_B)).toBe('committed');
  });

  it('discardIntent scoped to run A removes only run A\'s pending intent; run B\'s row survives', () => {
    writePendingIntent(db, intentA);
    writePendingIntent(db, intentB);

    expect(discardIntent(db, KEY, RUN_A)).toBe(true);

    expect(getIntentStatus(db, KEY, RUN_A)).toBe('none');
    expect(getIntentStatus(db, KEY, RUN_B)).toBe('pending');
  });
});

// ===========================================================================
// WI-477 — back-compat regression: single-run checkpoint AND outbox intent
// both round-trip unchanged under the DEFAULT run id.
// ===========================================================================

describe('WI-477 — default-run back-compat', () => {
  // A key/intent with NO run field — exactly what existing single-run callers
  // pass. These must behave identically to the same key/intent written with an
  // explicit run = defaultRunId().
  it('a checkpoint written with no run round-trips and is readable under the explicit default run id', () => {
    const noRunKey: CheckpointKey = { flow: 'ref', card: 'card-1', station: 'render', attempt: 0 };
    const explicitDefaultKey: CheckpointKey = { ...noRunKey, run: defaultRunId() };
    const output = sampleOutput({ legacy: true });
    const stamp = computeBindingStamp(STAMP_INPUTS);

    writeCheckpoint(db, noRunKey, { output, stamp });

    // Implicit-default read returns the record unchanged.
    expect(readCheckpoint(db, noRunKey)).toEqual({ output, stamp });
    // ...and it is the SAME row as the explicit default run (no separate bucket).
    expect(readCheckpoint(db, explicitDefaultKey)).toEqual({ output, stamp });
  });

  it('an outbox intent written with no run round-trips its full lifecycle under the default run id', () => {
    const noRunIntent: OutboxIntent = {
      flow: 'ref',
      card: 'card-1',
      station: 'render',
      attempt: 0,
      idempotencyKey: 'ref:card-1:render:0',
      intent: { kind: 'publish', target: '#legacy' },
    };

    expect(getIntentStatus(db, noRunIntent.idempotencyKey)).toBe('none');

    writePendingIntent(db, noRunIntent);
    // Readable both implicitly (no run arg) and via the explicit default run id.
    expect(getIntentStatus(db, noRunIntent.idempotencyKey)).toBe('pending');
    expect(getIntentStatus(db, noRunIntent.idempotencyKey, defaultRunId())).toBe('pending');

    commitIntent(db, noRunIntent.idempotencyKey);
    expect(getIntentStatus(db, noRunIntent.idempotencyKey)).toBe('committed');
    expect(reconcileOnResume(db, noRunIntent.idempotencyKey)).toEqual({ action: 'skip' });
  });
});
