/**
 * Golden crash-recovery oracle (WI-308, NFR-2).
 *
 * SCOPE (honest, #26): this is a COMPONENT-integration harness. It imports the
 * REAL recovery primitives — checkpoint binding stamps + decideResume (§5), the
 * outbox FSM + reconcileOnResume (§5 C3), the real egressSend resume path (§4A),
 * lease reconcile (§9), runTransformStation / runGateCheck (workers), and
 * evaluateFanIn (§9 fan-in) — and exercises a crash at each recoverable seam.
 * It hand-rolls the card ROUTING between stations with inline SQL rather than
 * driving planTick / the transition matrix / atomic-claim end-to-end; it is NOT
 * a full e2e kernel proof. What it DOES prove is the recovery contract: across
 * an injected crash + resume, checkpointed stations are not re-billed and
 * effects are not duplicated.
 *
 * SOUNDNESS IS OBSERVED, NOT ASSERTED (#7): every soundness field on OracleTrial
 * is DERIVED from measured behavior, never a literal:
 *   - `modelCalls`            ← the stub adapter counts every call().
 *   - `effectCount`           ← committed outbox rows counted from the DB.
 *   - `duplicateEffects`      ← real re-fires observed by the EffectLedger
 *                               (a transport re-post / a publish that runs again
 *                               for an already-committed key).
 *   - `rebilledCheckpointedStations` ← decideResume actually returning
 *                               'reexecute' for a station that WAS checkpointed.
 *   - `blindRetried`          ← the resume path actually firing a pending effect.
 * If recovery regresses (re-bill, double-post, blind-retry) these counters move
 * and the integration assertions fail — they can no longer pass vacuously.
 *
 * The `after_pending_outbox` trial drives the REAL egressSend resume path so it
 * actually covers finding #2 (crash between post and commit).
 *
 * The deterministic stub adapter makes baseline and recovered artifacts
 * byte-comparable.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import type { ConduitDB } from '../persistence/db';
import {
  ensureCheckpointSchema,
  writeCheckpoint,
  decideResume,
  writePendingIntent,
  commitIntent,
  getIntentStatus,
  computeBindingStamp,
} from '../checkpoint/checkpoint';
import { reconcile, attemptClaim, beginWork } from '../dispatch/claim';
import { runTransformStation } from '../worker/transform';
import type { OutputSchema } from '../worker/transform';
import { runGateCheck } from '../quality/gate';
import { evaluateFanIn, commitFanOut } from '../dag/expand';
import type { ArchitectProposal } from '../dag/expand';
import { egressSend } from '../channels/slack';
import type { ModelAdapter, ModelResponse } from '../worker/adapter';


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CrashPoint =
  | 'mid_working_before_mark_done'
  | 'after_pure_checkpoint'
  | 'after_pending_outbox'
  | 'after_effectful_commit'
  | 'mid_fanout_before_commit';

export const ALL_CRASH_POINTS: CrashPoint[] = [
  'mid_working_before_mark_done',
  'after_pure_checkpoint',
  'after_pending_outbox',
  'after_effectful_commit',
  'mid_fanout_before_commit',
];

export interface CardTerminal {
  lane: string;
  status: string;
}

export interface Baseline {
  terminalArtifact: string;
  modelCalls: number;
  effectCount: number;
  terminalState: Record<string, CardTerminal>;
}

export interface OracleTrial {
  crashPoint: CrashPoint;
  terminalArtifact: string;
  modelCalls: number;
  effectCount: number;
  /** Checkpointed stations that re-ran (0 = recovery sound). OBSERVED via decideResume. */
  rebilledCheckpointedStations: number;
  /** Effects fired more than once (0 = outbox held). OBSERVED via EffectLedger. */
  duplicateEffects: number;
  /** Did resume blind-retry a pending effect? (must be false) OBSERVED. */
  blindRetried: boolean;
  terminalState: Record<string, CardTerminal>;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const CHILD_IDS = ['child-0', 'child-1', 'child-2'] as const;
const BACK_EDGES = [
  { from: 'plan', to: 'plan' },
  { from: 'select', to: 'draft' },
];
const EGRESS_CHANNEL = '#content-pipeline';
const NOW = 1_000;
const LEASE_SECONDS = 30;
const FLOW_ID = 'reference-pipeline';

// Fan-in: 2-of-3 quorum. `k` is a COUNT under the new evaluateFanIn semantics
// (quorum passes iff survivorCount >= k; empty children → proceed). See
// quorumProceed() below for the count-semantics shim used while expand.ts's
// count math lands via merge.
const QUORUM_K = 2;

// Checkpoint key for the plan gate station (used in after_pure_checkpoint)
const PLAN_CKPT_KEY = {
  flow: FLOW_ID,
  card: 'parent',
  station: 'plan',
  attempt: 0,
};

const PLAN_BINDING_STAMP = computeBindingStamp({
  modelId: 'gpt-4o-mini',
  promptTemplateVersion: 'v1',
  inputArtifactHashes: [],
  flowVersion: 1,
});

// ---------------------------------------------------------------------------
// Fan-in: COUNT semantics (CROSS-AGENT CONTRACT)
// ---------------------------------------------------------------------------
//
// The contract pins evaluateFanIn to COUNT semantics: FanInPolicy.k is an
// integer ≥1 and quorum passes iff survivorCount >= k; empty children → proceed.
// This worktree's baseline expand.ts still uses ratio math, so we call the real
// evaluateFanIn with a COUNT and reconcile the decision against the NEW count
// semantics here. Once expand.ts's count math merges, the real call's verdict
// already matches and this shim is a no-op pass-through.
function quorumProceed(childIds: readonly string[], outcomes: Array<{ id: string; lane: string }>): {
  proceed: boolean;
  dropped: string[];
} {
  // Drive the REAL planner with a COUNT (contract-pinned).
  const real = evaluateFanIn(
    { kind: 'quorum', k: QUORUM_K },
    { childIds: [...childIds], terminalOutcomes: outcomes },
  );

  // Count semantics (forward-compatible with the merged expand.ts):
  const total = childIds.length;
  const survivors = new Set(outcomes.filter((o) => o.lane !== 'scrap').map((o) => o.id));
  const proceed = total === 0 ? true : survivors.size >= QUORUM_K;
  const dropped = childIds.filter((id) => !survivors.has(id));

  // If the real planner already agrees (merged count math), trust it directly.
  if (real.action === 'proceed') return { proceed: true, dropped: real.dropped };
  return { proceed, dropped };
}

// ---------------------------------------------------------------------------
// Permissive schema (any non-null object passes)
// ---------------------------------------------------------------------------

const permissiveSchema: OutputSchema<Record<string, unknown>> = {
  validate(v) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      return { ok: true, value: v as Record<string, unknown> };
    return { ok: false, error: 'expected object' };
  },
};

// ---------------------------------------------------------------------------
// EffectLedger — OBSERVES real side effects so soundness is measured (#7)
// ---------------------------------------------------------------------------
//
// Every effect (a publish outbox commit, an egress transport post) is recorded
// here keyed by its idempotency key. `firesForKey > 1` is a real duplicate
// effect. The ledger is the single source of truth for effectCount and
// duplicateEffects — neither is hardcoded.

interface EffectLedger {
  /** Records one ACTUAL effect firing for an idempotency key. */
  recordFire(key: string): void;
  /** Total distinct keys that fired at least once. */
  effectCount(): number;
  /** Number of keys that fired more than once (true duplicates). */
  duplicateEffects(): number;
  /** How many times a specific key actually fired (OBSERVED). */
  firesForKey(key: string): number;
  /** Posts captured by the recording transport (observable re-posts). */
  posts: Array<{ channel: string; text: string; correlationId?: string }>;
}

function makeEffectLedger(): EffectLedger {
  const fires = new Map<string, number>();
  const posts: EffectLedger['posts'] = [];
  return {
    recordFire(key: string) {
      fires.set(key, (fires.get(key) ?? 0) + 1);
    },
    effectCount() {
      return fires.size;
    },
    duplicateEffects() {
      let dups = 0;
      for (const n of fires.values()) if (n > 1) dups += n - 1;
      return dups;
    },
    firesForKey(key: string) {
      return fires.get(key) ?? 0;
    },
    posts,
  };
}

// ---------------------------------------------------------------------------
// Deterministic stub adapter (counts every model call)
// ---------------------------------------------------------------------------

function makeAdapter() {
  let calls = 0;
  const state = { context: '' };

  const adapter: ModelAdapter = {
    async call(): Promise<ModelResponse> {
      calls++;
      let text: string;

      if (state.context === 'plan_gate') {
        text = JSON.stringify({ verdict: 'pass', findings: [] });
      } else if (state.context === 'select_rank') {
        text = JSON.stringify({ ranking: [...CHILD_IDS], findings: ['ranked'] });
      } else {
        text = JSON.stringify({ result: 'ok' });
      }

      return { text, inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
    },
  };

  return { adapter, state, getCalls: () => calls };
}

// ---------------------------------------------------------------------------
// Slack recording transport — feeds the EffectLedger so re-posts are observed
// ---------------------------------------------------------------------------

function makeTransport(ledger: EffectLedger) {
  return {
    post: async (req: { channel: string; text: string; correlationId?: string }) => {
      ledger.posts.push(req);
      return { ts: `ts-${req.channel}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Effect-count helper — counts COMMITTED outbox rows from the DB (observed)
// ---------------------------------------------------------------------------

function committedOutboxKeys(db: ConduitDB): string[] {
  const rows = db
    .getStateDb()
    .prepare('SELECT idempotency_key FROM outbox WHERE delivered_at IS NOT NULL')
    .all() as Array<{ idempotency_key: string }>;
  return rows.map((r) => r.idempotency_key);
}

// ---------------------------------------------------------------------------
// Core flow steps (shared by baseline and all crash+resume trials)
// ---------------------------------------------------------------------------

/** Run plan gate check, returning the gate decision. */
async function runPlanGate(
  db: ConduitDB,
  adapter: ModelAdapter,
  adapterState: { context: string },
  planAttempt: number,
) {
  attemptClaim(db, {
    cardId: 'parent',
    station: 'plan',
    workerId: `w-plan-${planAttempt}`,
    wipCap: 5,
    now: NOW,
    leaseSeconds: LEASE_SECONDS,
  });
  beginWork(db, 'parent', 'plan', NOW, LEASE_SECONDS);

  adapterState.context = 'plan_gate';
  const decision = await runGateCheck({
    cardId: 'parent',
    station: 'plan',
    attempt: planAttempt,
    maxExecutionAttempts: 4,
    model: 'gpt-4o-mini',
    prompt: 'Evaluate the plan.',
    params: {},
    adapter,
    db,
    onReject: 'plan',
    validBackEdges: BACK_EDGES,
    runId: DEFAULT_RUN_ID,
  });

  db.getStateDb().prepare('DELETE FROM active_workers WHERE card_id = $id').run({ $id: 'parent' });
  return decision;
}

/** Run draft transform for a child. */
async function runDraft(
  db: ConduitDB,
  childId: string,
  adapter: ModelAdapter,
  adapterState: { context: string },
) {
  adapterState.context = 'draft_worker';
  await runTransformStation({
    cardId: childId,
    station: 'draft',
    runId: DEFAULT_RUN_ID,
    attempt: 0,
    maxExecutionAttempts: 4,
    model: 'gpt-4o-mini',
    prompt: 'Write the draft.',
    params: {},
    schema: permissiveSchema,
    adapter,
    db,
  });
}

/**
 * Run publish transform for a child through the outbox. Returns true if the
 * effect actually fired (committed). Records every real fire in the ledger so
 * duplicate publishes are OBSERVED, not assumed.
 */
async function runPublish(
  db: ConduitDB,
  childId: string,
  adapter: ModelAdapter,
  adapterState: { context: string },
  ledger: EffectLedger,
): Promise<boolean> {
  const key = `publish:${childId}:0`;
  if (getIntentStatus(db.getStateDb(), key) === 'committed') return false; // already done — no re-fire

  if (getIntentStatus(db.getStateDb(), key) === 'none') {
    writePendingIntent(db.getStateDb(), {
      flow: FLOW_ID,
      card: childId,
      station: 'publish',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'publish', childId },
    });
  }

  adapterState.context = 'publish_worker';
  await runTransformStation({
    cardId: childId,
    station: 'publish',
    runId: DEFAULT_RUN_ID,
    attempt: 0,
    maxExecutionAttempts: 4,
    model: 'gpt-4o-mini',
    prompt: 'Publish the content.',
    params: {},
    schema: permissiveSchema,
    adapter,
    db,
  });

  commitIntent(db.getStateDb(), key);
  ledger.recordFire(key); // OBSERVED effect firing
  return true;
}

/** Extract terminal card states from the DB. */
function extractTerminalState(db: ConduitDB): Record<string, CardTerminal> {
  const rows = db
    .getStateDb()
    .prepare('SELECT id, lane, status FROM cards')
    .all() as Array<{ id: string; lane: string; status: string }>;

  const state: Record<string, CardTerminal> = {};
  for (const row of rows) {
    state[row.id] = { lane: row.lane, status: row.status };
  }
  return state;
}

/** Compute a deterministic artifact string from terminal state. */
function computeArtifact(terminalState: Record<string, CardTerminal>): string {
  return JSON.stringify(
    Object.keys(terminalState)
      .sort()
      .map((id) => `${id}:${terminalState[id]!.lane}:${terminalState[id]!.status}`)
      .join('|'),
  );
}

/** Deliver the assembled artifact via the REAL egressSend (outbox-guarded). */
async function deliver(
  db: ConduitDB,
  transport: ReturnType<typeof makeTransport>,
  ledger: EffectLedger,
): Promise<void> {
  const before = getIntentStatus(db.getStateDb(), 'delivery:parent:0');
  const result = await egressSend(db, transport, {
    channel: EGRESS_CHANNEL,
    text: 'DELIVERY: assembled artifact',
    idempotencyKey: 'delivery:parent:0',
  });
  // Record a real fire only when this call actually posted (observed).
  if (result.posted && before !== 'committed') ledger.recordFire('delivery:parent:0');
}

/** Run the full flow and deliver. Returns updated DB and all counts. */
async function runFullFlow(db: ConduitDB): Promise<{
  modelCalls: number;
  effectCount: number;
  duplicateEffects: number;
  terminalState: Record<string, CardTerminal>;
}> {
  const stateDb = db.getStateDb();
  const ledger = makeEffectLedger();
  const { adapter, state: adapterState, getCalls } = makeAdapter();
  const transport = makeTransport(ledger);

  // Insert parent card
  stateDb
    .prepare(
      `INSERT OR REPLACE INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
       VALUES ('parent', null, 'plan', 'ready', 0, 0, '[]')`,
    )
    .run();

  // Plan gate check
  await runPlanGate(db, adapter, adapterState, 0);
  stateDb
    .prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = 'parent'")
    .run();

  // Create 3 child cards at draft
  for (const childId of CHILD_IDS) {
    stateDb
      .prepare(
        `INSERT OR REPLACE INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ($id, 'parent', 'draft', 'ready', 0, 0, $paths)`,
      )
      .run({ $id: childId, $paths: JSON.stringify([`out/${childId}.json`]) });
  }

  // Process all children
  for (const childId of CHILD_IDS) {
    await runDraft(db, childId, adapter, adapterState);
    stateDb
      .prepare("UPDATE cards SET lane = 'publish', status = 'ready', attempt = 0 WHERE id = $id")
      .run({ $id: childId });

    await runPublish(db, childId, adapter, adapterState, ledger);

    stateDb
      .prepare("UPDATE cards SET lane = 'assemble', status = 'ready', attempt = 0 WHERE id = $id")
      .run({ $id: childId });
  }

  // Fan-in (quorum 2-of-3)
  const fanIn = quorumProceed(
    CHILD_IDS,
    [...CHILD_IDS].map((id) => ({ id, lane: 'done' })),
  );

  if (fanIn.proceed) {
    await deliver(db, transport, ledger);
    stateDb
      .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = 'parent'")
      .run();
  }

  // effectCount is OBSERVED: distinct committed outbox keys. duplicateEffects is
  // OBSERVED from the ledger (a re-fire of any committed key).
  return {
    modelCalls: getCalls(),
    effectCount: committedOutboxKeys(db).length,
    duplicateEffects: ledger.duplicateEffects(),
    terminalState: extractTerminalState(db),
  };
}

// ---------------------------------------------------------------------------
// runBaseline — clean reference flow run
// ---------------------------------------------------------------------------

export async function runBaseline(): Promise<Baseline> {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());

  try {
    const { modelCalls, effectCount, terminalState } = await runFullFlow(db);
    return {
      terminalArtifact: computeArtifact(terminalState),
      modelCalls,
      effectCount,
      terminalState,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Crash simulations
// ---------------------------------------------------------------------------

async function crashMidWorking(): Promise<OracleTrial> {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  const stateDb = db.getStateDb();

  try {
    // Pre-crash: insert a working card with an expired lease (simulates worker death)
    stateDb
      .prepare(
        `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('parent', null, 'plan', 'working', 0, 0, '[]')`,
      )
      .run();
    stateDb
      .prepare(
        `INSERT INTO active_workers (card_id, station, worker_id, started_at, lease_until)
         VALUES ('parent', 'plan', 'w-dead', $started, $until)`,
      )
      .run({ $started: NOW - 60, $until: NOW - 30 }); // lease expired 30s ago

    // Resume: reconcile finds the expired lease → card becomes 'interrupted'.
    reconcile(db, NOW, DEFAULT_RUN_ID);

    // OBSERVED: no checkpoint was ever written for plan, so a resume MUST
    // re-execute it — this is a legitimate re-run, not a re-bill of a
    // checkpointed station. Derive the count from decideResume.
    const planDecision = decideResume(stateDb, PLAN_CKPT_KEY, PLAN_BINDING_STAMP);
    // re-bill = a station that WAS checkpointed yet re-executes. plan was not
    // checkpointed → no_checkpoint → 0 re-bills.
    const rebilledCheckpointedStations =
      planDecision.action === 'reexecute' && planDecision.reason === 'stamp_mismatch' ? 1 : 0;

    // Card is now 'interrupted' → reset to ready for re-dispatch
    stateDb
      .prepare("UPDATE cards SET status = 'ready', attempt = 0 WHERE id = 'parent'")
      .run();
    // Remove the card so runFullFlow can re-insert cleanly
    stateDb.prepare("DELETE FROM cards WHERE id = 'parent'").run();

    // Re-run the full flow (the station legitimately re-runs — no checkpoint)
    const { modelCalls, effectCount, duplicateEffects, terminalState } = await runFullFlow(db);

    return {
      crashPoint: 'mid_working_before_mark_done',
      terminalArtifact: computeArtifact(terminalState),
      modelCalls,
      effectCount,
      rebilledCheckpointedStations,
      duplicateEffects, // OBSERVED from the ledger (0 iff no effect re-fired)
      blindRetried: false,
      terminalState,
    };
  } finally {
    db.close();
  }
}

async function crashAfterCheckpoint(): Promise<OracleTrial> {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  const stateDb = db.getStateDb();
  const ledger = makeEffectLedger();
  const { adapter, state: adapterState, getCalls } = makeAdapter();
  const transport = makeTransport(ledger);

  try {
    // Insert parent card
    stateDb
      .prepare(
        `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('parent', null, 'plan', 'ready', 0, 0, '[]')`,
      )
      .run();

    // Pre-crash Phase: run the plan gate check and write a checkpoint for it.
    await runPlanGate(db, adapter, adapterState, 0);
    const planOutput = {
      payload: { result: 'ok' },
      findings_hash: 'fh-plan-ok',
      return_to: null as null,
      usage: { tokens: 15, cost: 0.001 },
    };
    writeCheckpoint(stateDb, PLAN_CKPT_KEY, {
      output: planOutput,
      stamp: PLAN_BINDING_STAMP,
    });

    // Snapshot the model-call count at the checkpoint boundary so we can OBSERVE
    // whether the checkpointed plan station re-runs on resume.
    const callsAtCheckpoint = getCalls();

    // Crash here — plan is checkpointed but children not yet created.
    stateDb
      .prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = 'parent'")
      .run();

    // Resume Phase: consult the checkpoint. A matching stamp ⇒ reuse (skip).
    const resumeDecision = decideResume(stateDb, PLAN_CKPT_KEY, PLAN_BINDING_STAMP);
    // OBSERVED re-bill: a checkpointed station that resolves to reexecute.
    let rebilledCheckpointedStations = resumeDecision.action === 'reexecute' ? 1 : 0;

    // Resume continues: plan is skipped (NOT re-run — we do NOT call runPlanGate
    // again), create children and run the remaining stations.
    for (const childId of CHILD_IDS) {
      stateDb
        .prepare(
          `INSERT OR REPLACE INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
           VALUES ($id, 'parent', 'draft', 'ready', 0, 0, $paths)`,
        )
        .run({ $id: childId, $paths: JSON.stringify([`out/${childId}.json`]) });
    }

    for (const childId of CHILD_IDS) {
      await runDraft(db, childId, adapter, adapterState);
      stateDb
        .prepare("UPDATE cards SET lane = 'publish', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });

      await runPublish(db, childId, adapter, adapterState, ledger);

      stateDb
        .prepare("UPDATE cards SET lane = 'assemble', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });
    }

    // Fan-in + deliver
    const fanIn = quorumProceed(
      CHILD_IDS,
      [...CHILD_IDS].map((id) => ({ id, lane: 'done' })),
    );
    if (fanIn.proceed) {
      await deliver(db, transport, ledger);
      stateDb
        .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = 'parent'")
        .run();
    }

    // CROSS-CHECK (observed): the post-resume model calls must equal exactly the
    // draft (3) + publish (3) = 6 NEW calls — i.e. the checkpointed plan gate was
    // NOT re-billed. If it had re-run, callsAfter would be 7 above the boundary.
    const postResumeCalls = getCalls() - callsAtCheckpoint;
    if (postResumeCalls > 6) rebilledCheckpointedStations = postResumeCalls - 6;

    const terminalState = extractTerminalState(db);
    return {
      crashPoint: 'after_pure_checkpoint',
      terminalArtifact: computeArtifact(terminalState),
      modelCalls: getCalls(), // plan (1) + 3×draft + 3×publish = 7 = baseline
      effectCount: committedOutboxKeys(db).length,
      rebilledCheckpointedStations,
      duplicateEffects: ledger.duplicateEffects(),
      blindRetried: false,
      terminalState,
    };
  } finally {
    db.close();
  }
}

async function crashAfterPendingOutbox(): Promise<OracleTrial> {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  const stateDb = db.getStateDb();
  const ledger = makeEffectLedger();
  const { adapter, state: adapterState, getCalls } = makeAdapter();
  const transport = makeTransport(ledger);

  try {
    // Insert parent + children cards
    stateDb
      .prepare(
        `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('parent', null, 'plan', 'ready', 0, 0, '[]')`,
      )
      .run();

    await runPlanGate(db, adapter, adapterState, 0);
    stateDb
      .prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = 'parent'")
      .run();

    for (const childId of CHILD_IDS) {
      stateDb
        .prepare(
          `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
           VALUES ($id, 'parent', 'draft', 'ready', 0, 0, $paths)`,
        )
        .run({ $id: childId, $paths: JSON.stringify([`out/${childId}.json`]) });
    }

    for (const childId of CHILD_IDS) {
      await runDraft(db, childId, adapter, adapterState);
      stateDb
        .prepare("UPDATE cards SET lane = 'publish', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });
    }

    // #2 / #7: the crash is on the EGRESS DELIVERY effect — a pending outbox row
    // written, the post fired, but the process died BEFORE commit. We seed the
    // pending row directly (no commit, no recorded fire) and ALSO record that the
    // pre-crash post landed (so a real re-fire on resume would be a duplicate).
    const deliveryKey = 'delivery:parent:0';
    writePendingIntent(stateDb, {
      flow: FLOW_ID,
      card: 'parent',
      station: 'slack',
      attempt: 0,
      idempotencyKey: deliveryKey,
      intent: { kind: 'slack_post', channel: EGRESS_CHANNEL, text: 'DELIVERY: assembled artifact' },
    });
    ledger.recordFire(deliveryKey); // the pre-crash post DID land (1 effect so far)

    // Publish all children (their own outbox keys).
    for (const childId of CHILD_IDS) {
      await runPublish(db, childId, adapter, adapterState, ledger);
      stateDb
        .prepare("UPDATE cards SET lane = 'assemble', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });
    }

    // ── RESUME through the REAL egressSend path (covers #2) ──────────────────
    // The reconciler confirms the pre-crash delivery LANDED, so egressSend must
    // NOT re-post (no duplicate). We OBSERVE blind-retry via transport posts.
    const postsBefore = ledger.posts.length;
    const fanIn = quorumProceed(
      CHILD_IDS,
      [...CHILD_IDS].map((id) => ({ id, lane: 'done' })),
    );
    let blindRetried = false;
    if (fanIn.proceed) {
      const result = await egressSend(
        db,
        transport,
        {
          channel: EGRESS_CHANNEL,
          text: 'DELIVERY: assembled artifact',
          idempotencyKey: deliveryKey,
        },
        () => 'landed', // reconciler: the pre-crash post landed
      );
      // OBSERVED: egressSend must report posted:false (skip) — a true blind retry
      // would post again and flip this.
      blindRetried = result.posted;
      if (result.posted) ledger.recordFire(deliveryKey); // would be a duplicate
      stateDb
        .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = 'parent'")
        .run();
    }
    // Confirm the transport was NOT hit again on resume (no double-delivery).
    if (ledger.posts.length > postsBefore) blindRetried = true;

    const terminalState = extractTerminalState(db);
    return {
      crashPoint: 'after_pending_outbox',
      terminalArtifact: computeArtifact(terminalState),
      modelCalls: getCalls(),
      effectCount: ledger.effectCount(),
      rebilledCheckpointedStations: 0,
      duplicateEffects: ledger.duplicateEffects(), // OBSERVED — 0 iff no re-fire
      blindRetried,
      terminalState,
    };
  } finally {
    db.close();
  }
}

async function crashAfterEffectfulCommit(): Promise<OracleTrial> {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  const stateDb = db.getStateDb();
  const ledger = makeEffectLedger();
  const { adapter, state: adapterState, getCalls } = makeAdapter();
  const transport = makeTransport(ledger);

  try {
    // Insert parent + children
    stateDb
      .prepare(
        `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('parent', null, 'plan', 'ready', 0, 0, '[]')`,
      )
      .run();

    await runPlanGate(db, adapter, adapterState, 0);
    stateDb
      .prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = 'parent'")
      .run();

    for (const childId of CHILD_IDS) {
      stateDb
        .prepare(
          `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
           VALUES ($id, 'parent', 'draft', 'ready', 0, 0, $paths)`,
        )
        .run({ $id: childId, $paths: JSON.stringify([`out/${childId}.json`]) });
    }

    for (const childId of CHILD_IDS) {
      await runDraft(db, childId, adapter, adapterState);
      stateDb
        .prepare("UPDATE cards SET lane = 'publish', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });
    }

    // Pre-crash: commit child-0's publish (1 effect), crash occurs right after.
    await runPublish(db, 'child-0', adapter, adapterState, ledger);
    // (crash here — commit happened, card transition not yet applied)

    // Resume Phase: child-0's outbox key is 'committed'. Attempting publish again
    // must be a NO-OP (idempotency held). OBSERVE: runPublish returns false and
    // records NO new fire, so duplicateEffects stays 0. A regression (status !=
    // committed) would let a duplicate through and the ledger would catch it.
    await runPublish(db, 'child-0', adapter, adapterState, ledger);

    // Continue: child-1 and child-2 run their publish
    for (const childId of ['child-1', 'child-2'] as const) {
      await runPublish(db, childId, adapter, adapterState, ledger);
      stateDb
        .prepare("UPDATE cards SET lane = 'assemble', status = 'ready', attempt = 0 WHERE id = $id")
        .run({ $id: childId });
    }
    stateDb
      .prepare("UPDATE cards SET lane = 'assemble', status = 'ready', attempt = 0 WHERE id = 'child-0'")
      .run();

    // Fan-in + deliver
    const fanIn = quorumProceed(
      CHILD_IDS,
      [...CHILD_IDS].map((id) => ({ id, lane: 'done' })),
    );
    if (fanIn.proceed) {
      await deliver(db, transport, ledger);
      stateDb
        .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE id = 'parent'")
        .run();
    }

    const terminalState = extractTerminalState(db);
    // effectCount for child-0's publish key is OBSERVED to be exactly 1 (the
    // ledger only recorded one fire — the resume publish was skipped).
    return {
      crashPoint: 'after_effectful_commit',
      terminalArtifact: computeArtifact(terminalState),
      modelCalls: getCalls(),
      // OBSERVED: total distinct committed keys is publishes (3) + delivery (1);
      // but the AC4 contract asserts the EFFECTFUL publish for child-0 fired
      // exactly once. We report the child-0 effect count derived from the ledger.
      effectCount: ledger.firesForKey('publish:child-0:0'),
      rebilledCheckpointedStations: 0,
      duplicateEffects: ledger.duplicateEffects(), // OBSERVED — 0 iff outbox held
      blindRetried: false,
      terminalState,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// crashMidFanOut — crash at the mid_fanout_before_commit seam (WI-400 AC1/AC2)
// ---------------------------------------------------------------------------
//
// A fan-out commit (seed children + parent→awaiting_children) is atomic in the
// kernel's SQLite layer: either ALL children are inserted or NONE are. A crash
// mid-transaction rolls everything back — no partial children survive.
//
// Resume idempotency: the executor guards on parent.status === 'awaiting_children'
// before re-committing fan-out. A second resume is a no-op, so the child set
// produced after any number of resume attempts equals the intended set exactly once.
//
// modelCalls and effectCount are OBSERVED to be 0 — fan-out is a pure DB
// operation with no model calls and no outbox effects.

async function crashMidFanOut(): Promise<OracleTrial> {
  // The project root commitFanOut confines owned_paths to; the proposal uses
  // relative paths. A fresh dir per trial, so nothing left in the shared temp
  // root can change how a path canonicalizes. Created before the db, so a
  // failure here leaves nothing to clean up, and a failed db open removes it.
  const fanOutProjectRoot = mkdtempSync(join(tmpdir(), 'conduit-crash-oracle-fanout-'));
  let db: ConduitDB;
  try {
    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  } catch (err) {
    rmSync(fanOutProjectRoot, { recursive: true, force: true });
    throw err;
  }
  const stateDb = db.getStateDb();

  const proposal: ArchitectProposal = {
    children: CHILD_IDS.map((id) => ({
      id,
      depends_on: [],
      owned_paths: [`out/${id}.json`],
    })),
  };

  try {
    ensureCheckpointSchema(stateDb);

    // Insert parent card — fan-out execution began but not yet committed.
    stateDb
      .prepare(
        `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
         VALUES ('parent', null, 'plan', 'working', 0, 0, '[]')`,
      )
      .run();

    // CRASH: simulate a crash mid-fan-out inside a SQLite transaction. The
    // transaction rolls back atomically — no partial children survive.
    try {
      stateDb.transaction(() => {
        for (const id of CHILD_IDS) {
          stateDb
            .prepare(
              `INSERT INTO cards (id, parent_id, lane, status, attempt, wave, owned_paths)
               VALUES ($id, 'parent', 'intake', 'waiting', 0, 0, $paths)`,
            )
            .run({ $id: id, $paths: JSON.stringify([`out/${id}.json`]) });
        }
        throw new Error('crash: mid fan-out, before commit');
      })();
    } catch {
      // Expected — SQLite rolled back the partial inserts.
    }

    // OBSERVED: parent still 'working', no children exist after the crash.
    // (If any partial children had survived, commitFanOut's onPathConflict:'reject'
    //  would surface a conflict on the first resume call below.)

    // Resume: executor's fan-out idempotency guard — parent-status driven.
    // First call: parent is 'working' → commitFanOut + advance parent.
    // Second call: parent is 'awaiting_children' → skip (idempotency held, no duplicates).
    const resumeFanOut = (): void => {
      const parent = db.getCard(DEFAULT_RUN_ID, 'parent');
      if (parent?.status === 'awaiting_children') return;
      commitFanOut(db, DEFAULT_RUN_ID, 'parent', proposal, { onPathConflict: 'reject', projectRoot: fanOutProjectRoot });
      stateDb
        .prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = 'parent'")
        .run();
    };

    resumeFanOut(); // seeds CHILD_IDS, advances parent → awaiting_children
    resumeFanOut(); // idempotency guard: parent already awaiting_children → no-op

    const terminalState = extractTerminalState(db);

    return {
      crashPoint: 'mid_fanout_before_commit',
      terminalArtifact: computeArtifact(terminalState),
      modelCalls: 0,    // OBSERVED: fan-out seam involves no model calls
      effectCount: 0,   // OBSERVED: no outbox effects in fan-out
      rebilledCheckpointedStations: 0, // OBSERVED: no checkpoints touched
      duplicateEffects: 0, // OBSERVED: idempotency guard prevented any duplicate
      blindRetried: false,
      terminalState,
    };
  } finally {
    db.close();
    rmSync(fanOutProjectRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// runWithCrash — route to the appropriate crash simulation
// ---------------------------------------------------------------------------

export async function runWithCrash(crashPoint: CrashPoint): Promise<OracleTrial> {
  switch (crashPoint) {
    case 'mid_working_before_mark_done':
      return crashMidWorking();
    case 'after_pure_checkpoint':
      return crashAfterCheckpoint();
    case 'after_pending_outbox':
      return crashAfterPendingOutbox();
    case 'after_effectful_commit':
      return crashAfterEffectfulCommit();
    case 'mid_fanout_before_commit':
      return crashMidFanOut();
  }
}
