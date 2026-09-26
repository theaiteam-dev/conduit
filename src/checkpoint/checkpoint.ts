/**
 * Checkpoint binding stamp + effectful-station outbox (WI-298).
 *
 * SPEC §5, FR-8/9, SPEC §16 step 4 — checkpoint soundness guarantees:
 *
 *   - On ACK_DONE a station output is stored under (flow, card, station, attempt)
 *     with a binding stamp = SHA-256(modelId ‖ promptTemplateVersion ‖
 *     inputArtifactHashes ‖ flowVersion).  On resume a matching stamp means
 *     "skip, no re-bill"; a mismatch means "re-execute".
 *   - Stamp invalidation cascades along artifact-dependency edges (pure BFS;
 *     independent stations are spared).
 *   - For effectful=true stations: write a PENDING outbox row before the
 *     side-effect, mark it COMMITTED on success.  On resume a pending row is
 *     NEVER blind-retried — reconcile against the external system or escalate
 *     to hold.
 *
 * Design note: this module operates on a raw `bun:sqlite` Database (the state
 * DB) rather than ConduitDB.  ConduitDB exposes no station_outputs/outbox
 * accessor and station_outputs lacks binding_stamp/flow columns, so the
 * checkpoint layer owns its own `checkpoints` table and ensures the `outbox`
 * table via CREATE TABLE IF NOT EXISTS (coexisting with WI-290 at runtime).
 */

import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { StationOutput } from '../types/kernel';
import { DEFAULT_RUN_ID } from '../persistence/db';
import { defaultRunId } from '../run/run-id';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The four inputs that together identify a unique station configuration (SPEC §5). */
export interface BindingStampInputs {
  /** Model identifier, e.g. 'gpt-4o'. */
  modelId: string;
  /** Version of the prompt template used by this station. */
  promptTemplateVersion: string;
  /** Resolved content-hashes of every input artifact consumed by this station. */
  inputArtifactHashes: string[];
  /** Flow schema version pinned at run start. */
  flowVersion: number;
  /**
   * Resolved harness adapter name for a `kind: harness` station (WI-572,
   * FR-6/OQ-5) — folded into the stamp ONLY WHEN PRESENT, so a transform or
   * deterministic station's stamp is byte-identical to the pre-WI-572
   * four-input canonical. A harness station's binary version is deliberately
   * EXCLUDED (the operator owns harness upgrades) — this carries the adapter
   * NAME only, never a version string.
   */
  adapterName?: string;
}

/** Composite primary key that locates a checkpoint row. */
export interface CheckpointKey {
  run?: string;
  flow: string;
  card: string;
  station: string;
  attempt: number;
}

/** What is stored at a checkpoint — the station output envelope + its stamp. */
export interface CheckpointRecord {
  output: StationOutput<unknown>;
  stamp: string;
}

/** Artifact-dependency graph used by cascadeInvalidation. */
export interface FlowGraph {
  stations: Array<{ id: string; inputs: string[]; outputs: string[] }>;
}

/** A recorded outbox intent for an effectful station. */
export interface OutboxIntent {
  run?: string;
  flow: string;
  card: string;
  station: string;
  attempt: number;
  idempotencyKey: string;
  intent: Record<string, unknown>;
}

/** Lifecycle state of an outbox entry. */
export type OutboxStatus = 'none' | 'pending' | 'committed';

/**
 * Optional external verifier for a pending outbox intent.
 * Returns the confirmed outcome of the side-effect — or 'unknown' when
 * the external system cannot be queried deterministically.
 */
export type Reconciler = (intent: Record<string, unknown>) => 'landed' | 'not_landed' | 'unknown';

/** Decision made by decideResume for a single station on resume. */
export type ResumeDecision =
  | { action: 'reuse'; output: StationOutput<unknown> }
  | { action: 'reexecute'; reason: 'no_checkpoint' | 'stamp_mismatch' };

/** Decision made by reconcileOnResume for a pending effectful station. */
export type OutboxReconcile =
  | { action: 'fire' }
  | { action: 'skip' }
  | { action: 'escalate_hold'; intent: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Internal row shapes (SQLite results)
// ---------------------------------------------------------------------------

interface CheckpointRow {
  binding_stamp: string;
  output_json: string;
}

interface OutboxRow {
  payload_json: string;
  delivered_at: number | null;
}

// ---------------------------------------------------------------------------
// computeBindingStamp — SPEC §5 hash of the four configuration inputs.
// ---------------------------------------------------------------------------

/**
 * Compute the binding stamp for a station configuration.
 *
 * The stamp is SHA-256(canonical JSON of [modelId, promptTemplateVersion,
 * sorted(inputArtifactHashes), flowVersion]) encoded as a lowercase hex string.
 *
 * Canonical JSON uses a fixed-position array (never an object) so the hash
 * is invariant to any future property-order ambiguity.
 *
 * `inputArtifactHashes` is semantically a SET of resolved input artifacts, not
 * an ordered list — the binding identity does not depend on the order the
 * upstream artifacts were enumerated. It is sorted before hashing so that a
 * reordering of the same inputs yields an identical stamp (no spurious
 * `stamp_mismatch`, no needless re-bill, no false downstream cascade). #16.
 */
export function computeBindingStamp(inputs: BindingStampInputs): string {
  const canonical = JSON.stringify([
    inputs.modelId,
    inputs.promptTemplateVersion,
    [...inputs.inputArtifactHashes].sort(),
    inputs.flowVersion,
    // WI-572: adapterName is appended ONLY WHEN PRESENT, so the canonical
    // array stays byte-identical to the pre-WI-572 four-input form for every
    // transform/deterministic station (no adapterName) — folding it in
    // unconditionally (even as undefined/null) would mass-invalidate every
    // existing non-harness checkpoint on the next resume.
    ...(inputs.adapterName !== undefined ? [inputs.adapterName] : []),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Combine a `worker.uses` station's declared prompt_version with the ordered
 * content hashes of its injected skills into a single promptTemplateVersion
 * stamp input (Skill Ingest PRD FR-4 / WI-557). The hash COMBINES with
 * prompt_version rather than replacing it, so a prompt_version bump still
 * moves the stamp even when no skill changed.
 *
 * Unlike `inputArtifactHashes` in computeBindingStamp, `skillContentHashes` is
 * NOT sorted — worker.uses composition is order-sensitive (skill_1 content,
 * then skill_2, ... then the local prompt), so swapping two skills' declared
 * order changes the actual injected content and must change the stamp too.
 */
export function computeSkillAwarePromptTemplateVersion(
  promptVersion: string,
  skillContentHashes: readonly string[],
): string {
  const canonical = JSON.stringify([promptVersion, skillContentHashes]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Combine a harness station's promptTemplateVersion with the named agent it
 * runs (issue #28): the agent name and the SHA-256 of its definition file.
 * The same combining discipline as computeSkillAwarePromptTemplateVersion: an
 * agent carries a system prompt, a tool allowlist and a model preference, so
 * it is part of the prompt, and editing its body invalidates the checkpoint
 * and cascades exactly as editing a skill body does. The name is folded as
 * well as the hash so that two agents with identical files still stamp apart.
 *
 * Only called for a station that runs an agent. A station without one keeps
 * its bare promptTemplateVersion, so no existing stamp moves.
 */
export function computeAgentAwarePromptTemplateVersion(
  promptTemplateVersion: string,
  agentName: string,
  definitionSha256: string,
): string {
  const canonical = JSON.stringify([promptTemplateVersion, 'agent', agentName, definitionSha256]);
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// ensureCheckpointSchema — idempotent DDL init.
// ---------------------------------------------------------------------------

/**
 * Create the `checkpoints` table and ensure the `outbox` table exists.
 *
 * Both use CREATE TABLE IF NOT EXISTS so this is safe to call on a fresh
 * in-memory DB (tests) and on the shared state DB where WI-290 may have
 * already created `outbox` with identical columns.
 *
 * v5→v6 migration: if the existing `checkpoints` table lacks a `run_id`
 * column (the old 4-column PK schema), we recreate it with the new schema
 * and backfill legacy rows using DEFAULT_RUN_ID ('default'). This mirrors
 * the exact RECREATE-AND-COPY pattern used by db.ts for its v6 table
 * recreates (cards_v6, active_workers_v6, outbox_v6, etc.).
 *
 * The migration is idempotent: on a freshly-created or already-migrated DB
 * the `run_id` column is already present and the guard short-circuits.
 *
 * Note: the `outbox` table is separately migrated by db.ts's outbox_v6
 * recreate; we do NOT migrate it here.
 */
export function ensureCheckpointSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      run_id        TEXT NOT NULL DEFAULT 'default',
      flow          TEXT NOT NULL,
      card          TEXT NOT NULL,
      station       TEXT NOT NULL,
      attempt       INTEGER NOT NULL,
      binding_stamp TEXT NOT NULL,
      output_json   TEXT NOT NULL,
      PRIMARY KEY (run_id, flow, card, station, attempt)
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id           TEXT NOT NULL DEFAULT '${DEFAULT_RUN_ID}',
      idempotency_key  TEXT NOT NULL,
      payload_json     TEXT NOT NULL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      delivered_at     INTEGER,
      UNIQUE (run_id, idempotency_key)
    );
  `);

  // v5→v6 migration guard: detect old schema (missing run_id) and recreate.
  const tableExists = (name: string): boolean => {
    const row = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    return row !== undefined && row !== null;
  };
  const colExists = (table: string, col: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === col);
  };

  if (tableExists('checkpoints') && !colExists('checkpoints', 'run_id')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints_v6 (
        run_id        TEXT NOT NULL DEFAULT '${DEFAULT_RUN_ID}',
        flow          TEXT NOT NULL,
        card          TEXT NOT NULL,
        station       TEXT NOT NULL,
        attempt       INTEGER NOT NULL,
        binding_stamp TEXT NOT NULL,
        output_json   TEXT NOT NULL,
        PRIMARY KEY (run_id, flow, card, station, attempt)
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO checkpoints_v6 (run_id, flow, card, station, attempt, binding_stamp, output_json)
      SELECT '${DEFAULT_RUN_ID}', flow, card, station, attempt, binding_stamp, output_json
      FROM checkpoints
    `);
    db.exec('DROP TABLE checkpoints');
    db.exec('ALTER TABLE checkpoints_v6 RENAME TO checkpoints');
  }
}

// ---------------------------------------------------------------------------
// Checkpoint CRUD
// ---------------------------------------------------------------------------

/**
 * Persist a checkpoint for a completed station execution.
 *
 * Uses INSERT OR REPLACE so repeated writes for the same key are idempotent
 * (safe to call again if the kernel re-checkpoints after a rework).
 */
export function writeCheckpoint(db: Database, key: CheckpointKey, record: CheckpointRecord): void {
  const runId = key.run ?? defaultRunId();
  db.prepare(
    `INSERT OR REPLACE INTO checkpoints
       (run_id, flow, card, station, attempt, binding_stamp, output_json)
     VALUES ($run_id, $flow, $card, $station, $attempt, $stamp, $output)`,
  ).run({
    $run_id: runId,
    $flow: key.flow,
    $card: key.card,
    $station: key.station,
    $attempt: key.attempt,
    $stamp: record.stamp,
    $output: JSON.stringify(record.output),
  });
}

/** Return the stored checkpoint for a key, or null if none exists. */
export function readCheckpoint(db: Database, key: CheckpointKey): CheckpointRecord | null {
  const runId = key.run ?? defaultRunId();
  const row = db
    .prepare(
      `SELECT binding_stamp, output_json
       FROM checkpoints
       WHERE run_id = $run_id AND flow = $flow AND card = $card AND station = $station AND attempt = $attempt`,
    )
    .get({
      $run_id: runId,
      $flow: key.flow,
      $card: key.card,
      $station: key.station,
      $attempt: key.attempt,
    }) as CheckpointRow | undefined;

  if (!row) return null;

  return {
    stamp: row.binding_stamp,
    output: JSON.parse(row.output_json) as StationOutput<unknown>,
  };
}

/**
 * Remove a checkpoint, forcing re-execution on the next resume.
 *
 * Called by the kernel when a stamp mismatch is detected and after
 * cascadeInvalidation identifies downstream stations that must re-run.
 */
export function invalidateCheckpoint(db: Database, key: CheckpointKey): void {
  const runId = key.run ?? defaultRunId();
  db.prepare(
    `DELETE FROM checkpoints
     WHERE run_id = $run_id AND flow = $flow AND card = $card AND station = $station AND attempt = $attempt`,
  ).run({
    $run_id: runId,
    $flow: key.flow,
    $card: key.card,
    $station: key.station,
    $attempt: key.attempt,
  });
}

// ---------------------------------------------------------------------------
// decideResume — whether to reuse a checkpoint or re-execute.
// ---------------------------------------------------------------------------

/**
 * Decide whether to skip or re-execute a station on resume.
 *
 * Returns `reuse` only when a checkpoint exists AND its stored stamp equals
 * `currentStamp`.  Any other case requires re-execution:
 *   - `no_checkpoint` — the station never completed (or was invalidated)
 *   - `stamp_mismatch` — config changed since the checkpoint was written
 */
export function decideResume(
  db: Database,
  key: CheckpointKey,
  currentStamp: string,
): ResumeDecision {
  const record = readCheckpoint(db, key);

  if (!record) {
    return { action: 'reexecute', reason: 'no_checkpoint' };
  }

  if (record.stamp !== currentStamp) {
    return { action: 'reexecute', reason: 'stamp_mismatch' };
  }

  return { action: 'reuse', output: record.output };
}

// ---------------------------------------------------------------------------
// cascadeInvalidation — pure BFS over artifact-dependency edges.
// ---------------------------------------------------------------------------

/**
 * Compute the full set of stations to invalidate given a set of seed
 * stations whose stamps are no longer valid.
 *
 * The result is pure (no DB access) — it operates only on the flow graph.
 * A station is included when it transitively consumes any output produced
 * by a station in the invalidated set.  Stations whose inputs do not
 * touch any dirty artifact are left out entirely.
 *
 * The caller is responsible for calling invalidateCheckpoint on each
 * returned station id.
 */
export function cascadeInvalidation(graph: FlowGraph, seeds: string[]): string[] {
  // Map: artifact name → station ids that consume it as an input.
  const consumers = new Map<string, string[]>();
  // Map: station id → artifact names it produces.
  const stationOutputs = new Map<string, string[]>();

  for (const s of graph.stations) {
    stationOutputs.set(s.id, s.outputs);
    for (const input of s.inputs) {
      const list = consumers.get(input);
      if (list) {
        list.push(s.id);
      } else {
        consumers.set(input, [s.id]);
      }
    }
  }

  // BFS: propagate dirtiness along artifact edges.
  const invalidated = new Set<string>(seeds);
  const queue: string[] = [...seeds];

  while (queue.length > 0) {
    const stationId = queue.shift()!;
    for (const artifact of stationOutputs.get(stationId) ?? []) {
      for (const consumerId of consumers.get(artifact) ?? []) {
        if (!invalidated.has(consumerId)) {
          invalidated.add(consumerId);
          queue.push(consumerId);
        }
      }
    }
  }

  return Array.from(invalidated);
}

// ---------------------------------------------------------------------------
// Outbox intent lifecycle (effectful stations — SPEC §5 rev-1 C3)
// ---------------------------------------------------------------------------

/**
 * Record a PENDING outbox intent before executing the side-effect.
 *
 * The full OutboxIntent is serialised into payload_json so reconcileOnResume
 * can recover the `intent` field without additional context.
 *
 * @throws if idempotency_key already exists (SQLite UNIQUE constraint) — the
 *   caller must not attempt to write the same intent twice.
 */
export function writePendingIntent(db: Database, intent: OutboxIntent): void {
  const runId = intent.run ?? defaultRunId();
  db.prepare(
    `INSERT INTO outbox (run_id, idempotency_key, payload_json, created_at)
     VALUES ($run_id, $key, $payload, unixepoch())`,
  ).run({
    $run_id: runId,
    $key: intent.idempotencyKey,
    $payload: JSON.stringify(intent),
  });
}

/**
 * Mark an outbox intent as committed — the side-effect successfully landed.
 *
 * Sets delivered_at to the current epoch-seconds timestamp.
 */
export function commitIntent(db: Database, idempotencyKey: string, run?: string): void {
  const runId = run ?? defaultRunId();
  const result = db
    .prepare(
      `UPDATE outbox SET delivered_at = unixepoch()
       WHERE run_id = $run_id AND idempotency_key = $key`,
    )
    .run({ $run_id: runId, $key: idempotencyKey });

  if (result.changes === 0) {
    throw new Error(
      `commitIntent: no outbox row found for run '${runId}' idempotency_key '${idempotencyKey}'`,
    );
  }
}

/**
 * Abandon a PENDING outbox intent whose side effect did NOT land.
 *
 * Used when an effectful station terminates without the effect succeeding — e.g.
 * the model call is classified non-retryable (model-incompatible / vision-
 * unsupported) and the card is scrapped. Without this, the PENDING row written
 * before the call is left dangling: a later operator-forced replay of that
 * attempt would hit reconcileOnResume → escalate_hold for an effect that never
 * occurred.
 *
 * Deletes the row ONLY while it is still pending (delivered_at IS NULL). A
 * committed intent is never removed, so a real landed effect can never be
 * silently un-recorded by a mis-timed discard.
 *
 * @returns true if a pending row was removed, false if no pending row existed
 *   (already committed, or never written).
 */
export function discardIntent(db: Database, idempotencyKey: string, run?: string): boolean {
  const runId = run ?? defaultRunId();
  const result = db
    .prepare(
      `DELETE FROM outbox WHERE run_id = $run_id AND idempotency_key = $key AND delivered_at IS NULL`,
    )
    .run({ $run_id: runId, $key: idempotencyKey });
  return result.changes > 0;
}

/**
 * Return the lifecycle state of an outbox entry.
 *
 * - 'none'      — no row for this key (never attempted)
 * - 'pending'   — row exists, delivered_at IS NULL (may or may not have fired)
 * - 'committed' — row exists, delivered_at IS NOT NULL (confirmed landed)
 */
export function getIntentStatus(db: Database, idempotencyKey: string, run?: string): OutboxStatus {
  const runId = run ?? defaultRunId();
  const row = db
    .prepare(
      `SELECT delivered_at FROM outbox WHERE run_id = $run_id AND idempotency_key = $key`,
    )
    .get({ $run_id: runId, $key: idempotencyKey }) as { delivered_at: number | null } | undefined;

  if (!row) return 'none';
  return row.delivered_at === null ? 'pending' : 'committed';
}

/**
 * Return the persisted `intent` payload for a PENDING (uncommitted) outbox
 * row, or null when no such row exists (status 'none' or 'committed').
 *
 * Exposes the same stored intent object reconcileOnResume itself passes to a
 * synchronous Reconciler — without touching reconcileOnResume's own contract.
 * Used by callers (e.g. egressSendFile's WI-602 files.info reconciler) that
 * need to AWAIT an async reconciler inline, which the synchronous
 * reconcileOnResume cannot do.
 */
export function getPendingIntentPayload(
  db: Database,
  idempotencyKey: string,
  run?: string,
): Record<string, unknown> | null {
  const runId = run ?? defaultRunId();
  const row = db
    .prepare(
      `SELECT payload_json, delivered_at FROM outbox WHERE run_id = $run_id AND idempotency_key = $key`,
    )
    .get({ $run_id: runId, $key: idempotencyKey }) as OutboxRow | undefined;

  if (!row || row.delivered_at !== null) return null;

  const storedIntent = JSON.parse(row.payload_json) as OutboxIntent;
  return storedIntent.intent;
}

// ---------------------------------------------------------------------------
// reconcileOnResume — fail-closed: NEVER blind-retry a pending effect.
// ---------------------------------------------------------------------------

/**
 * Decide what to do with an effectful station's outbox entry on resume.
 *
 * The three-state FSM (SPEC §5 rev-1 C3):
 *
 *   none      → fire    (safe first execution — no prior attempt)
 *   committed → skip    (effect landed; do not re-fire under any circumstances)
 *   pending   → depends on the optional reconciler:
 *     no reconciler            → escalate_hold  (can't determine outcome; hold)
 *     reconciler → 'landed'    → skip           (confirmed; treat as committed)
 *     reconciler → 'not_landed'→ fire           (confirmed miss; safe to retry)
 *     reconciler → 'unknown'   → escalate_hold  (ambiguous; hold)
 *
 * The 'pending' path NEVER auto-commits and NEVER fires without reconciler
 * confirmation.  The database row is left unchanged so the next resume call
 * sees the same pending state and can try again with a different reconciler.
 */
export function reconcileOnResume(
  db: Database,
  idempotencyKey: string,
  reconciler?: Reconciler,
  run?: string,
): OutboxReconcile {
  const runId = run ?? defaultRunId();
  const row = db
    .prepare(
      `SELECT payload_json, delivered_at FROM outbox WHERE run_id = $run_id AND idempotency_key = $key`,
    )
    .get({ $run_id: runId, $key: idempotencyKey }) as OutboxRow | undefined;

  // No prior record → safe to execute the effect for the first time.
  if (!row) {
    return { action: 'fire' };
  }

  // Committed → effect already landed; never re-fire.
  if (row.delivered_at !== null) {
    return { action: 'skip' };
  }

  // Pending → the effect may or may not have happened.
  const storedIntent = JSON.parse(row.payload_json) as OutboxIntent;
  const intent = storedIntent.intent;

  if (!reconciler) {
    // No way to determine outcome without a reconciler — escalate to hold.
    // Crucially: we do NOT commit, do NOT fire, leave status 'pending'.
    return { action: 'escalate_hold', intent };
  }

  const verdict = reconciler(intent);
  switch (verdict) {
    case 'landed':
      // Reconciler confirmed the effect landed — safe to skip.
      return { action: 'skip' };
    case 'not_landed':
      // Reconciler confirmed the effect did not happen — safe to fire.
      return { action: 'fire' };
    case 'unknown':
      // Reconciler cannot determine the outcome — escalate to hold.
      return { action: 'escalate_hold', intent };
  }
}
