/**
 * (lane, status) transition FSM — the centerpiece of the Conduit kernel (SPEC §3, WI-293).
 *
 * PURE function: given a card's current FsmState and a KernelEvent, returns the
 * single legal next FsmState or rejects the transition as illegal.  No DB, no
 * LLM, no I/O.  Per-flow routing (lane graph, caps, policies) is injected via
 * TransitionContext; the universal status FSM is kernel-owned.
 *
 * Key modeling decisions (faithful to SPEC §3):
 *   - MARK_DONE → done_pending_ack (the Summary Hook fires before lane advance).
 *   - INTEGRITY_PASS advances lane; mid-flow yields status='waiting' so the tick
 *     planner can promote to 'ready' once deps are confirmed.
 *   - INTEGRITY_FAIL attributes the retry to executionAttempt (NOT reworkCount).
 *   - QC_REJECT attributes rework to reworkCount (NOT executionAttempt).
 *   - held vs hold: NEEDS_JUDGMENT freezes the card in-place (lane unchanged);
 *     DEP_SCRAP changes lane to the 'hold' terminal.
 *   - SKIP (issue #32) passes a ready card to happyPathNext without running the
 *     station; no counter moves.
 *   - Every (from, event) pair not in the matrix returns {ok:false} — no guessing.
 *   - Returns a NEW FsmState; the input is never mutated.
 */

import type { Lane, Status } from '../types/kernel';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The mutable card sub-state tracked by the FSM (a projection of the DB row). */
export interface FsmState {
  lane: Lane;
  status: Status;
  /** How many times the worker has been (re-)dispatched at this lane. */
  executionAttempt: number;
  /** How many QC-reject rework cycles have been consumed for this card. */
  reworkCount: number;
  /**
   * Why the card was scrapped, set ONLY on the transition into the scrap
   * terminal. Mirrors SPEC §6 Guard-2 reasons: 'integrity'/'model-incompatible'
   * for execution-attempt-cap exhaustion, 'rework_cap'/'no_progress' for QC.
   * Absent on every non-scrap state.
   */
  scrapReason?:
    | 'rework_cap'
    | 'no_progress'
    | 'integrity'
    | 'model-incompatible';
}

/** Every discrete event the kernel can fire at a card. */
export type KernelEvent =
  | { type: 'CLAIM' }
  | { type: 'START_WORK' }
  | { type: 'MARK_DONE' }
  | { type: 'INTEGRITY_PASS' }
  | { type: 'INTEGRITY_FAIL' }
  | { type: 'QC_REJECT'; returnTo: Lane }
  | { type: 'NEEDS_JUDGMENT' }
  | { type: 'DEP_SCRAP' }
  | { type: 'FAN_OUT' }
  | { type: 'FAN_IN_MET' }
  | { type: 'WORKER_CRASH' }
  | { type: 'RATE_LIMITED' }
  | { type: 'REHYDRATE' }
  | { type: 'SKIP' };

/**
 * Per-flow routing context derived from a validated FlowConfig (WI-292).
 * Injected by the tick planner — transitions.ts itself never loads flows.
 */
export interface TransitionContext {
  /** Maps each work lane to its successor lane, or null if it is the last station. */
  happyPathNext: Record<string, string | null>;
  terminalLanes: readonly string[];
  /** QC rework cycles allowed — under cap iff reworkCount < reworkCap. */
  reworkCap: number;
  maxExecutionAttempts: number;
  capPolicy: 'scrap' | 'proceed_with_findings';
  onDepScrap: 'scrap' | 'hold';
  /** Validated on_reject back-edges from WI-292 flow loader. */
  validBackEdges: ReadonlyArray<{ from: string; to: string }>;
}

/** The FSM answer: the legal next state, or an illegal-transition error. */
export type TransitionResult =
  | { ok: true; next: FsmState }
  | { ok: false; error: 'illegal_transition' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ILLEGAL: TransitionResult = { ok: false, error: 'illegal_transition' };

/** Return a new FsmState by merging partial overrides — input is never mutated. */
function advance(state: FsmState, patch: Partial<FsmState>): TransitionResult {
  return { ok: true, next: { ...state, ...patch } };
}

/** True when the status belongs to a terminal lane (the card is done). */
function isTerminalStatus(status: Status): boolean {
  return status === 'complete' || status === 'scrapped';
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Compute the single legal next (lane, status) for a kernel event, or return
 * an illegal-transition error when no matching rule exists.
 *
 * The function is pure: it creates a new FsmState object and never mutates the
 * `state` parameter.
 */
export function transition(
  state: FsmState,
  event: KernelEvent,
  ctx: TransitionContext,
): TransitionResult {
  switch (event.type) {
    // ── Standard dispatch path ───────────────────────────────────────────────

    case 'CLAIM':
      if (state.status !== 'ready') return ILLEGAL;
      return advance(state, { status: 'claimed' });

    case 'START_WORK':
      if (state.status !== 'claimed') return ILLEGAL;
      return advance(state, { status: 'working' });

    case 'MARK_DONE':
      if (state.status !== 'working') return ILLEGAL;
      return advance(state, { status: 'done_pending_ack' });

    // ── Summary Hook (integrity check) ───────────────────────────────────────

    case 'INTEGRITY_PASS': {
      if (state.status !== 'done_pending_ack') return ILLEGAL;
      const nextLane = ctx.happyPathNext[state.lane];
      // Unknown lane in the happy-path map → reject.
      if (nextLane === undefined) return ILLEGAL;
      // null means this is the last station — card is done.
      if (nextLane === null) {
        return advance(state, { lane: 'done', status: 'complete' });
      }
      // Mid-flow: advance lane; yield 'waiting' so the tick planner promotes
      // to 'ready' once downstream dependencies are confirmed.
      return advance(state, { lane: nextLane, status: 'waiting' });
    }

    case 'INTEGRITY_FAIL': {
      // The Summary Hook found a problem — the worker must redo the work.
      // Attributes the retry to executionAttempt (NOT reworkCount).
      //
      // GUARD-2 AUTHORITY (SPEC §6.2): the FSM is the SOLE owner of the durable
      // execution-attempt counter AND the scrap decision. Mirrors the QC_REJECT
      // at-cap logic below: if incrementing would reach the cap, scrap with an
      // 'integrity' reason instead of looping forever. decideExecutionRetry in
      // rework.ts is a pure PREDICTION of this decision — it owns no counter.
      if (state.status !== 'done_pending_ack') return ILLEGAL;
      if (state.executionAttempt + 1 >= ctx.maxExecutionAttempts) {
        return advance(state, {
          lane: 'scrap',
          status: 'scrapped',
          executionAttempt: state.executionAttempt + 1,
          scrapReason: 'integrity',
        });
      }
      return advance(state, {
        status: 'working',
        executionAttempt: state.executionAttempt + 1,
      });
    }

    // ── QC critic verdict (back-edge routing) ────────────────────────────────

    case 'QC_REJECT': {
      if (state.status !== 'done_pending_ack') return ILLEGAL;

      // Validate the back-edge: the returnTo target must be a pre-approved
      // on_reject edge from the flow loader (WI-292).  An unknown target is
      // illegal — the kernel never trusts an unvalidated lane reference.
      const isValidEdge = ctx.validBackEdges.some(
        (e) => e.from === state.lane && e.to === event.returnTo,
      );
      if (!isValidEdge) return ILLEGAL;

      // At rework cap — apply the configured cap policy.
      if (state.reworkCount >= ctx.reworkCap) {
        if (ctx.capPolicy === 'scrap') {
          return advance(state, {
            lane: 'scrap',
            status: 'scrapped',
            scrapReason: 'rework_cap',
          });
        }
        // proceed_with_findings: treat like INTEGRITY_PASS (advance forward).
        const nextLane = ctx.happyPathNext[state.lane];
        if (nextLane === null || nextLane === undefined) {
          return advance(state, { lane: 'done', status: 'complete' });
        }
        return advance(state, { lane: nextLane, status: 'waiting' });
      }

      // Under cap: route to the on_reject lane and increment the rework counter.
      // executionAttempt is LEFT UNCHANGED — this is a QC rework, not an
      // execution retry.
      return advance(state, {
        lane: event.returnTo,
        status: 'waiting',
        reworkCount: state.reworkCount + 1,
      });
    }

    // ── Human / system escalation ─────────────────────────────────────────────

    case 'NEEDS_JUDGMENT':
      // Pause-in-place: the card needs a human decision before it can proceed.
      // Lane is UNCHANGED — this is 'held' (status), not 'hold' (lane).
      if (isTerminalStatus(state.status)) return ILLEGAL;
      return advance(state, { status: 'held' });

    case 'DEP_SCRAP':
      // A dependency was scrapped; escalate the waiting parent card.
      if (isTerminalStatus(state.status)) return ILLEGAL;
      if (ctx.onDepScrap === 'hold') {
        // Route to the 'hold' terminal lane (lane CHANGES — contrast with NEEDS_JUDGMENT).
        return advance(state, { lane: 'hold', status: 'held' });
      }
      return advance(state, { lane: 'scrap', status: 'scrapped' });

    // ── Fan-out / fan-in ─────────────────────────────────────────────────────

    case 'FAN_OUT':
      if (state.status !== 'done_pending_ack') return ILLEGAL;
      return advance(state, { status: 'awaiting_children' });

    case 'FAN_IN_MET':
      if (state.status !== 'awaiting_children') return ILLEGAL;
      return advance(state, { status: 'ready' });

    // ── Worker crash ─────────────────────────────────────────────────────────

    case 'WORKER_CRASH':
      if (state.status !== 'working') return ILLEGAL;
      return advance(state, { status: 'interrupted' });

    // ── Provider rate limit (issue #3) ───────────────────────────────────────

    case 'RATE_LIMITED':
      // A provider cap is NOT a failed attempt: the work never ran, nothing was
      // billed, and retrying before the cap resets cannot succeed. So the card
      // goes straight back to 'ready' at the SAME lane with NO counter touched —
      // neither the rework count nor the execution attempt. Spending an attempt
      // here is what let a session cap burn a card's whole budget in three
      // seconds and scrap work that had already been paid for.
      //
      // WHEN it may run again is not this FSM's business: the caller stamps
      // cards.release_at, and the existing release gate (planTick) keeps the
      // card undispatchable until then. This mirrors WORKER_CRASH + REHYDRATE
      // in effect, but is deliberately its own event — a rate limit is an
      // expected operating condition, not a crash, and conflating them would
      // make the two indistinguishable in the card log.
      if (state.status !== 'working') return ILLEGAL;
      return advance(state, { status: 'ready' });

    // ── Reconcile / re-hydrate (SPEC §15 step 1) ─────────────────────────────

    case 'REHYDRATE':
      // The lease-based reconcile (SPEC §11/§15) found a card stuck in
      // 'interrupted' after a worker crash. The stale slot is reclaimed and the
      // card returns to 'ready' so the next tick re-dispatches it (the lane is
      // unchanged — work resumes at the same station). This is the ONLY legal
      // way out of 'interrupted'; without it an interrupted card is stranded.
      // Effectful stations additionally check the outbox before re-billing (§5),
      // but that lives in the reconcile layer, not this pure FSM.
      if (state.status !== 'interrupted') return ILLEGAL;
      return advance(state, { status: 'ready' });

    // ── skip_when pass-through (issue #32) ───────────────────────────────────

    case 'SKIP': {
      // The station's skip_when predicate matched, so the card moves to the
      // station's declared `next` without the station running. Only a 'ready'
      // card can skip: the controller evaluates the predicate when the card
      // becomes dispatchable, before any claim. The destination mirrors
      // INTEGRITY_PASS, but neither executionAttempt nor reworkCount moves: no
      // work ran, so nothing was attempted and nothing was reworked.
      if (state.status !== 'ready') return ILLEGAL;
      const nextLane = ctx.happyPathNext[state.lane];
      if (nextLane === undefined) return ILLEGAL;
      if (nextLane === null) {
        return advance(state, { lane: 'done', status: 'complete' });
      }
      return advance(state, { lane: nextLane, status: 'waiting' });
    }

    default:
      // TypeScript exhaustiveness guard — unreachable at runtime.
      return ILLEGAL;
  }
}
