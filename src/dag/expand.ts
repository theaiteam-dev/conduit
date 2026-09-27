/**
 * Dynamic fan-out / fan-in + dependency-wave validation (WI-302, SPEC §9, FR-5).
 *
 * When a parent fans out, the Architect (a transform station) PROPOSES a set of
 * child cards.  This module deterministically enforces the kernel invariants on
 * that proposal:
 *
 *   1. Cycle detection via findCycleNodes (REUSED from WI-292 dag-utils) — a
 *      cyclic depends_on graph is rejected before any child is committed.
 *   2. Disjoint-ownership invariant (rev-1 H4) — concurrently-eligible children
 *      must not share owned_paths; conflicts are rejected or serialised.
 *   3. Categorisation into ready (all deps terminal) vs waiting (emergent waves).
 *   4. Fan-in policy: all | quorum(k ratio) | best_effort.
 *
 * NOTE: the cards table (WI-290) has no depends_on column, so the depends_on
 * graph lives in ExpansionResult.children (in-process wave state) and is NOT
 * persisted.  commitFanOut only writes parent_id + owned_paths via insertCard.
 */

import { writeFileSync, unlinkSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Status, Lane } from '../types/kernel';
import type { ConduitDB } from '../persistence/db';
import { DEFAULT_RUN_ID } from '../persistence/db';
import { findCycleNodes } from '../flow/dag-utils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A child card as proposed by the Architect transform. */
export interface ProposedChild {
  id: string;
  depends_on: string[];
  owned_paths: string[];
  seed?: unknown;
}

/** The Architect's full decomposition proposal. */
export interface ArchitectProposal {
  children: ProposedChild[];
}

/** A child card after kernel validation (may carry extra forced depends_on). */
export interface ValidatedChild {
  id: string;
  depends_on: string[];
  owned_paths: string[];
}

/** What to do when two concurrent children claim the same owned_path. */
export interface ExpandOptions {
  onPathConflict: 'reject' | 'serialize';
}

export type ExpansionError =
  | { code: 'dependency_cycle'; cycle: string[] }
  | { code: 'overlapping_owned_paths'; stations: [string, string]; path: string }
  | { code: 'unknown_dependency'; child: string; dependency: string }
  | { code: 'seed_path_out_of_bounds'; child: string; path: string }
  /**
   * A proposed child id is already a card in this run under another parent
   * (issue #36). Card ids are unique per run, and a keyed run's later pass may
   * propose the ids an earlier pass used; rejecting holds the parent instead
   * of letting the insert throw out of the tick.
   */
  | { code: 'child_id_collision'; child: string; owner: string | null };

export type ExpansionResult =
  | { ok: true; children: ValidatedChild[]; forcedEdges: Array<{ from: string; to: string }> }
  | { ok: false; error: ExpansionError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the set of all transitive dependencies of a node in an acyclic graph.
 * Precondition: the graph is known to be acyclic (cycle detection was run first).
 */
function computeTransitiveDeps(
  nodeId: string,
  depsMap: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visited = new Set<string>();
  const stack = [...(depsMap.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (!visited.has(dep)) {
      visited.add(dep);
      for (const transitive of (depsMap.get(dep) ?? [])) {
        stack.push(transitive);
      }
    }
  }
  return visited;
}

// ---------------------------------------------------------------------------
// validateExpansion — pure deterministic validation
// ---------------------------------------------------------------------------

/**
 * Validate an Architect proposal: cycle detection then disjoint-ownership.
 *
 * - Cycle detection REUSES findCycleNodes from src/flow/dag-utils (WI-292).
 * - Path conflict resolution is controlled by opts.onPathConflict:
 *     'reject'    → return error naming both stations and the shared path.
 *     'serialize' → inject a forced depends_on edge so the two are no longer
 *                   concurrent; the forced edge is recorded in forcedEdges.
 *
 * Children already ordered by depends_on (one depends on the other, directly or
 * transitively) are NOT flagged — they are already serialised.
 */
export function validateExpansion(
  proposal: ArchitectProposal,
  opts: ExpandOptions,
): ExpansionResult {
  const { children } = proposal;
  const childIds = children.map((c) => c.id);

  // ── 0. Dangling-dependency check (config is validated, not trusted) ───────
  // The Architect proposal is untrusted: a hallucinated dep id would otherwise
  // sail past cycle detection (findCycleNodes deliberately ignores unknown
  // ids) and park the card in `waiting` forever. Every depends_on entry MUST
  // reference a known child in this proposal.
  const childIdSet = new Set(childIds);
  for (const child of children) {
    for (const dep of child.depends_on) {
      if (!childIdSet.has(dep)) {
        return {
          ok: false,
          error: { code: 'unknown_dependency', child: child.id, dependency: dep },
        };
      }
    }
  }

  // ── 1. Cycle detection (REUSE findCycleNodes from WI-292) ─────────────────
  const depsMap = new Map<string, readonly string[]>(
    children.map((c) => [c.id, c.depends_on]),
  );

  const cycleNodes = findCycleNodes(childIds, depsMap);
  if (cycleNodes.size > 0) {
    return { ok: false, error: { code: 'dependency_cycle', cycle: Array.from(cycleNodes) } };
  }

  // ── 2. Disjoint-ownership invariant ───────────────────────────────────────
  // Build a mutable transitive-deps map so serialization updates propagate.
  const transitiveDeps = new Map<string, Set<string>>(
    children.map((c) => [c.id, computeTransitiveDeps(c.id, depsMap)]),
  );

  // Additional deps injected by forced serialization edges.
  const additionalDeps = new Map<string, string[]>();
  const forcedEdges: Array<{ from: string; to: string }> = [];

  for (let i = 0; i < children.length; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const a = children[i]!;
      const b = children[j]!;

      // Skip if already serialised (one is a transitive dep of the other).
      const aDepB = transitiveDeps.get(a.id)?.has(b.id) ?? false;
      const bDepA = transitiveDeps.get(b.id)?.has(a.id) ?? false;
      if (aDepB || bDepA) continue;

      // Check for shared owned paths between concurrent children.
      const aPathSet = new Set(a.owned_paths);
      const sharedPath = b.owned_paths.find((p) => aPathSet.has(p));
      if (sharedPath === undefined) continue;

      if (opts.onPathConflict === 'reject') {
        return {
          ok: false,
          error: { code: 'overlapping_owned_paths', stations: [a.id, b.id], path: sharedPath },
        };
      }

      // serialize: force b → a (b now depends on a, so they are no longer concurrent).
      const edge = { from: b.id, to: a.id };
      forcedEdges.push(edge);

      if (!additionalDeps.has(b.id)) additionalDeps.set(b.id, []);
      additionalDeps.get(b.id)!.push(a.id);

      // Update transitive deps so subsequent pair checks see the new ordering.
      const bTrans = transitiveDeps.get(b.id)!;
      bTrans.add(a.id);
      const aTrans = transitiveDeps.get(a.id)!;
      for (const dep of aTrans) bTrans.add(dep);
    }
  }

  // Build validated children, merging any forced deps.
  const validatedChildren: ValidatedChild[] = children.map((c) => ({
    id: c.id,
    depends_on: [...c.depends_on, ...(additionalDeps.get(c.id) ?? [])],
    owned_paths: c.owned_paths,
  }));

  return { ok: true, children: validatedChildren, forcedEdges };
}

// ---------------------------------------------------------------------------
// commitFanOut — validate then persist
// ---------------------------------------------------------------------------

/**
 * Validate the Architect's proposal and, if valid, insert all child cards into
 * the DB with parent_id set and status='waiting'.
 *
 * Commits NOTHING when validation fails — the caller sees the validation error
 * and no partial state is written.
 *
 * Atomicity: all insertCard calls are wrapped in ONE SQLite transaction. A
 * mid-loop crash (or any error during insertion) rolls back every insert that
 * already executed within that transaction — no partial children survive.
 *
 * Idempotency: if any children already exist for this parent (a prior fan-out
 * partially or fully committed them before a crash), insertion is skipped
 * entirely. Callers must not rely on a UNIQUE-constraint throw to detect
 * duplicates; this guard makes re-dispatch safe without a UNIQUE violation.
 */
// Overload 1 (new, 5-arg): explicit parentRunId for multi-run isolation.
export function commitFanOut(db: ConduitDB, parentRunId: string, parentId: string, proposal: ArchitectProposal, opts: ExpandOptions): ExpansionResult;
// Overload 2 (legacy, 4-arg): omitted parentRunId defaults to DEFAULT_RUN_ID.
export function commitFanOut(db: ConduitDB, parentId: string, proposal: ArchitectProposal, opts: ExpandOptions): ExpansionResult;
export function commitFanOut(
  db: ConduitDB,
  runIdOrParentId: string,
  parentIdOrProposal: string | ArchitectProposal,
  proposalOrOpts: ArchitectProposal | ExpandOptions,
  opts?: ExpandOptions,
): ExpansionResult {
  let parentRunId: string;
  let parentId: string;
  let proposal: ArchitectProposal;
  let expandOpts: ExpandOptions;

  if (opts !== undefined) {
    // 5-arg form: (db, parentRunId, parentId, proposal, opts)
    parentRunId = runIdOrParentId;
    parentId = parentIdOrProposal as string;
    proposal = proposalOrOpts as ArchitectProposal;
    expandOpts = opts;
  } else {
    // 4-arg form: (db, parentId, proposal, opts) — legacy callers
    parentRunId = DEFAULT_RUN_ID;
    parentId = runIdOrParentId;
    proposal = parentIdOrProposal as ArchitectProposal;
    expandOpts = proposalOrOpts as ExpandOptions;
  }
  const result = validateExpansion(proposal, expandOpts);
  if (!result.ok) return result;

  const stateDb = db.getStateDb();

  // Idempotency guard: if any children for this parent already exist in this run,
  // a prior fan-out committed them. Scoped to run_id so two runs with the same
  // parent card id each get their own children without false idempotency hits.
  const existingCount = (
    stateDb
      .prepare('SELECT COUNT(*) AS n FROM cards WHERE run_id = $parentRunId AND parent_id = $parentId')
      .get({ $parentRunId: parentRunId, $parentId: parentId }) as { n: number }
  ).n;
  if (existingCount > 0) return result;

  // Child ids are unique per run, not per parent (issue #36). A proposal that
  // reuses an id owned by another card would throw on insert; report it as a
  // rejected proposal instead, so the caller holds the parent.
  const findCard = stateDb.prepare(
    'SELECT parent_id FROM cards WHERE run_id = $parentRunId AND id = $id',
  );
  for (const child of proposal.children) {
    const owner = findCard.get({ $parentRunId: parentRunId, $id: child.id }) as { parent_id: string | null } | null;
    if (owner !== null) {
      return { ok: false, error: { code: 'child_id_collision', child: child.id, owner: owner.parent_id } };
    }
  }

  // Build a map from child id → seed file path for each seeded child.
  // Validate out-of-bounds seed paths before touching the filesystem or DB:
  //   1. A seeded child with empty owned_paths has no directory to write into.
  //   2. The raw owned_paths[0] entry must exist and be a directory — check
  //      existence BEFORE calling realpathSync (which throws on missing paths).
  //   3. realpathSync resolves symlinks so a symlink escaping the sandbox is
  //      caught at write time by the integrity gate rather than silently allowed.
  const seedPaths = new Map<string, string>();
  for (const child of proposal.children) {
    // null is treated as "no seed" — only undefined and null are skipped.
    if (child.seed === undefined || child.seed === null) continue;
    if (child.owned_paths.length === 0) {
      return {
        ok: false,
        error: { code: 'seed_path_out_of_bounds', child: child.id, path: '' },
      };
    }
    const rawDir = child.owned_paths[0]!;
    // The entry must exist AND be a directory — a non-existent path indicates
    // traversal outside the sandbox; a file entry would cause ENOTDIR on write.
    if (!existsSync(rawDir)) {
      return {
        ok: false,
        error: { code: 'seed_path_out_of_bounds', child: child.id, path: rawDir },
      };
    }
    if (!statSync(rawDir).isDirectory()) {
      return {
        ok: false,
        error: { code: 'seed_path_out_of_bounds', child: child.id, path: rawDir },
      };
    }
    const firstDir = realpathSync(rawDir); // symlink-resolved
    const seedPath = join(firstDir, 'seed.json');
    seedPaths.set(child.id, seedPath);
  }

  // Write seed files to disk BEFORE opening the transaction so the SQLite
  // write lock is not held across disk I/O.  Track every path written so
  // they can be cleaned up if the subsequent transaction throws.
  const writtenSeeds: string[] = [];
  for (const child of result.children) {
    const seedPath = seedPaths.get(child.id);
    if (seedPath !== undefined) {
      const originalChild = proposal.children.find((c) => c.id === child.id)!;
      writeFileSync(seedPath, JSON.stringify(originalChild.seed, null, 2));
      writtenSeeds.push(seedPath);
    }
  }

  // Atomic all-or-nothing: wrap all insertCard calls in ONE transaction so any
  // mid-loop failure (exception, spy injection, process kill) rolls back every
  // row that was already inserted — no partial child set can survive.
  try {
    stateDb.transaction(() => {
      for (const child of result.children) {
        db.insertCard({
          run_id: parentRunId,
          id: child.id,
          parent_id: parentId,
          lane: 'intake' as Lane,
          status: 'waiting' as Status,
          attempt: 0,
          wave: 0,
          owned_paths: child.owned_paths,
          rework_count: 0,
        });
      }
    })();
  } catch (err) {
    // Transaction rolled back all DB inserts. Clean up any seed files written
    // before the transaction so the filesystem matches the DB state.
    // Use try/catch per file instead of existsSync to close the TOCTOU race.
    for (const p of writtenSeeds) {
      try { unlinkSync(p); } catch { /* ENOENT is fine — file already gone */ }
    }
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// categorize — emergent wave readiness
// ---------------------------------------------------------------------------

/**
 * Categorise children into ready (all deps in a terminal lane) vs waiting.
 *
 * A child with no depends_on is immediately ready.  A child with deps is ready
 * only when EVERY dep's current lane (as reported by laneOf) is in terminalLanes.
 * Waves emerge naturally — the tick planner calls this on each tick to discover
 * newly-unblocked children.
 */
export function categorize(
  children: ValidatedChild[],
  laneOf: (id: string) => string | null,
  terminalLanes: readonly string[],
): { ready: string[]; waiting: string[] } {
  const terminalSet = new Set(terminalLanes);
  const ready: string[] = [];
  const waiting: string[] = [];

  for (const child of children) {
    if (child.depends_on.length === 0) {
      ready.push(child.id);
      continue;
    }

    const allDepsTerminal = child.depends_on.every((depId) => {
      const lane = laneOf(depId);
      return lane !== null && terminalSet.has(lane);
    });

    if (allDepsTerminal) {
      ready.push(child.id);
    } else {
      waiting.push(child.id);
    }
  }

  return { ready, waiting };
}

// ---------------------------------------------------------------------------
// evaluateFanIn — fan-in policy evaluation
// ---------------------------------------------------------------------------

/** Fan-in policy variants. */
export type FanInPolicy =
  | { kind: 'all' }
  | { kind: 'quorum'; k: number }   // k is the minimum number of surviving children (count, integer ≥ 1)
  | { kind: 'best_effort' };

/** Snapshot of children and their terminal outcomes. */
export interface FanInState {
  childIds: string[];
  terminalOutcomes: Array<{ id: string; lane: string }>;
}

export type FanInDecision =
  | { action: 'proceed'; dropped: string[] }
  | { action: 'hold_parent'; reason: 'child_scrapped' | 'quorum_unmet' }
  | { action: 'wait' };

/**
 * Evaluate the fan-in policy against the current child completion state.
 *
 * - all:         all children must reach a terminal lane; any scrap → hold_parent.
 * - quorum(k):   at least k children (a COUNT, not a ratio) must be survivors
 *                (non-scrap terminals): proceeds iff survivorCount >= k.
 *                Proceeds without deadlock when a child can never complete — it
 *                is recorded as dropped.
 * - best_effort: proceed with whatever survivors exist; scrapped = dropped.
 *
 * Empty children (total === 0) is a defined no-op: every policy returns
 * `proceed` with no dropped children, matching the `all` policy's behaviour.
 */
export function evaluateFanIn(policy: FanInPolicy, state: FanInState): FanInDecision {
  const { childIds, terminalOutcomes } = state;
  const total = childIds.length;

  // Guard: no children → nothing to wait on. Every policy proceeds with an
  // empty drop set (consistent with `all`), and avoids a divide-by-zero in
  // the quorum branch below.
  if (total === 0) {
    return { action: 'proceed', dropped: [] };
  }

  const survivorIds = new Set(
    terminalOutcomes.filter((o) => o.lane !== 'scrap').map((o) => o.id),
  );
  const survivorCount = survivorIds.size;
  const terminalCount = terminalOutcomes.length;
  const inFlight = total - terminalCount;

  switch (policy.kind) {
    case 'all': {
      if (terminalCount < total) return { action: 'wait' };
      if (terminalOutcomes.some((o) => o.lane === 'scrap')) {
        return { action: 'hold_parent', reason: 'child_scrapped' };
      }
      return { action: 'proceed', dropped: [] };
    }

    case 'quorum': {
      const k = policy.k; // a COUNT: minimum number of surviving children required.

      // Quorum already met — proceed; non-survivors (incl. never-completed) are dropped.
      if (survivorCount >= k) {
        const dropped = childIds.filter((id) => !survivorIds.has(id));
        return { action: 'proceed', dropped };
      }

      // Quorum not yet met — can it still be reached?
      if (survivorCount + inFlight >= k) {
        return { action: 'wait' };
      }

      // Quorum is impossible to reach.
      return { action: 'hold_parent', reason: 'quorum_unmet' };
    }

    case 'best_effort': {
      // Always proceed; non-survivors are dropped.
      const dropped = childIds.filter((id) => !survivorIds.has(id));
      return { action: 'proceed', dropped };
    }
  }
}
