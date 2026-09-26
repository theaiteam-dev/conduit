/**
 * Tests for the (lane, status) transition FSM (WI-293) — the centerpiece (SPEC §3).
 *
 * A PURE function: given a card's current (lane, status) + counters and a kernel
 * event, it returns the single legal next state, or rejects an illegal transition.
 * No DB, no LLM. The per-flow routing (lane graph, caps, policies) is injected via
 * TransitionContext; the universal status FSM is kernel-owned.
 *
 * Contract this file pins for src/statemachine/transitions.ts:
 *
 *   interface FsmState { lane: Lane; status: Status; executionAttempt: number; reworkCount: number }
 *   type KernelEvent =
 *     | { type: 'CLAIM' } | { type: 'START_WORK' } | { type: 'MARK_DONE' }
 *     | { type: 'INTEGRITY_PASS' } | { type: 'INTEGRITY_FAIL' }
 *     | { type: 'QC_REJECT'; returnTo: Lane }
 *     | { type: 'NEEDS_JUDGMENT' } | { type: 'DEP_SCRAP' }
 *     | { type: 'FAN_OUT' } | { type: 'FAN_IN_MET' } | { type: 'WORKER_CRASH' }
 *   interface TransitionContext {
 *     happyPathNext: Record<string, string | null>;   // work lane → next lane (null = last)
 *     terminalLanes: readonly string[];
 *     reworkCap: number;            // QC rework cycles allowed (under cap iff reworkCount < reworkCap)
 *     maxExecutionAttempts: number;
 *     capPolicy: 'scrap' | 'proceed_with_findings';
 *     onDepScrap: 'scrap' | 'hold';
 *     validBackEdges: ReadonlyArray<{ from: string; to: string }>;   // validated on_reject edges
 *   }
 *   type TransitionResult = { ok: true; next: FsmState } | { ok: false; error: 'illegal_transition' }
 *   function transition(state: FsmState, event: KernelEvent, ctx: TransitionContext): TransitionResult
 *
 * The Summary Hook (integrity) is modeled as INTEGRITY_PASS/FAIL out of
 * done_pending_ack; the QC critic verdict is QC_REJECT (pass routes via
 * INTEGRITY_PASS / forward). MARK_DONE mid-flow yields status='waiting' — the
 * DB-less FSM cannot know deps are met, so the planner promotes waiting→ready.
 */
import { describe, it, expect } from 'bun:test';
import {
  transition,
  type FsmState,
  type KernelEvent,
  type TransitionContext,
} from './transitions';

function mkState(overrides: Partial<FsmState> = {}): FsmState {
  return {
    lane: 'plan',
    status: 'ready',
    executionAttempt: 0,
    reworkCount: 0,
    ...overrides,
  };
}

function mkCtx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    happyPathNext: { plan: 'draft', draft: 'publish', publish: 'assemble', assemble: null },
    terminalLanes: ['done', 'scrap', 'hold'],
    reworkCap: 2,
    maxExecutionAttempts: 4,
    capPolicy: 'scrap',
    onDepScrap: 'hold',
    validBackEdges: [
      { from: 'select', to: 'draft' },
      { from: 'plan', to: 'plan' },
    ],
    ...overrides,
  };
}

/** Narrow to the legal-transition branch, failing the test otherwise. */
function next(state: FsmState, event: KernelEvent, ctx = mkCtx()): FsmState {
  const result = transition(state, event, ctx);
  if (!result.ok) {
    throw new Error(`expected legal transition, got: ${JSON.stringify(result)}`);
  }
  return result.next;
}

// ---------------------------------------------------------------------------
// AC1 — claim legality.
// ---------------------------------------------------------------------------

describe('claim (AC1)', () => {
  it('ready + CLAIM → claimed (lane unchanged)', () => {
    const out = next(mkState({ lane: 'plan', status: 'ready' }), { type: 'CLAIM' });
    expect(out.status).toBe('claimed');
    expect(out.lane).toBe('plan');
  });

  it('working + CLAIM → illegal', () => {
    const result = transition(mkState({ status: 'working' }), { type: 'CLAIM' }, mkCtx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('illegal_transition');
  });

  it('claimed + START_WORK → working', () => {
    const out = next(mkState({ status: 'claimed' }), { type: 'START_WORK' });
    expect(out.status).toBe('working');
  });
});

// ---------------------------------------------------------------------------
// AC2 — MARK_DONE / pass mid-flow and at the last station.
// ---------------------------------------------------------------------------

describe('MARK_DONE and integrity pass (AC2)', () => {
  it('working + MARK_DONE → done_pending_ack (awaits the Summary Hook)', () => {
    const out = next(mkState({ lane: 'draft', status: 'working' }), { type: 'MARK_DONE' });
    expect(out.status).toBe('done_pending_ack');
    expect(out.lane).toBe('draft');
  });

  it('pass mid-flow advances to the next station with status=waiting', () => {
    const out = next(mkState({ lane: 'draft', status: 'done_pending_ack' }), {
      type: 'INTEGRITY_PASS',
    });
    expect(out.lane).toBe('publish'); // happyPathNext['draft']
    expect(out.status).toBe('waiting');
  });

  it('pass at the last station → lane=done, status=complete', () => {
    const out = next(mkState({ lane: 'assemble', status: 'done_pending_ack' }), {
      type: 'INTEGRITY_PASS',
    });
    expect(out.lane).toBe('done');
    expect(out.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// AC3 — integrity (Summary Hook) failure → working, EXECUTION-ATTEMPT counter.
// ---------------------------------------------------------------------------

describe('integrity failure attribution (AC3)', () => {
  it('returns to working and increments executionAttempt, NOT reworkCount', () => {
    const out = next(
      mkState({ lane: 'draft', status: 'done_pending_ack', executionAttempt: 1, reworkCount: 0 }),
      { type: 'INTEGRITY_FAIL' },
    );
    expect(out.status).toBe('working');
    expect(out.lane).toBe('draft'); // stays at the same station
    expect(out.executionAttempt).toBe(2); // execution-attempt counter ++
    expect(out.reworkCount).toBe(0); // rework counter untouched
  });

  // Finding #6: Guard-2 (execution-attempt cap) MUST be enforced by the FSM —
  // a station that keeps failing the Summary Hook must eventually SCRAP, not
  // loop forever. The FSM is the sole authority for the durable counter + scrap.
  it('scraps once the next execution attempt would reach maxExecutionAttempts', () => {
    // maxExecutionAttempts = 4 (from mkCtx). At executionAttempt=3, the next
    // attempt (→4) reaches the cap → scrap with reason 'integrity'.
    const out = next(
      mkState({ lane: 'draft', status: 'done_pending_ack', executionAttempt: 3, reworkCount: 0 }),
      { type: 'INTEGRITY_FAIL' },
    );
    expect(out.lane).toBe('scrap');
    expect(out.status).toBe('scrapped');
    expect(out.scrapReason).toBe('integrity');
  });

  it('repeated INTEGRITY_FAIL eventually scraps at maxExecutionAttempts (no infinite loop)', () => {
    // Drive the whole Guard-2 loop end-to-end at the FSM level, the missing test
    // that let the dead-field finding (#6) slip. With max=4: attempts 0→1→2→3
    // stay working; the 4th fail scraps.
    const ctx = mkCtx({ maxExecutionAttempts: 4 });
    let state = mkState({ lane: 'draft', status: 'done_pending_ack', executionAttempt: 0 });

    // executionAttempt 0→1, 1→2, 2→3: still working.
    for (let i = 0; i < 3; i++) {
      const r = transition(state, { type: 'INTEGRITY_FAIL' }, ctx);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.next.status).toBe('working');
      // Put the card back in done_pending_ack to model the next MARK_DONE→fail.
      state = { ...r.next, status: 'done_pending_ack' };
      expect(state.executionAttempt).toBe(i + 1);
    }

    // executionAttempt=3, the next fail (→4) reaches the cap → scrap.
    const last = transition(state, { type: 'INTEGRITY_FAIL' }, ctx);
    expect(last.ok).toBe(true);
    if (!last.ok) throw new Error('unreachable');
    expect(last.next.lane).toBe('scrap');
    expect(last.next.status).toBe('scrapped');
    expect(last.next.scrapReason).toBe('integrity');
  });
});

// ---------------------------------------------------------------------------
// AC4 — QC reject under cap / at cap, and back-edge validation.
// ---------------------------------------------------------------------------

describe('QC reject routing (AC4)', () => {
  it('under cap → on_reject lane, reworkCount++ (executionAttempt untouched), status=waiting', () => {
    const out = next(
      mkState({ lane: 'select', status: 'done_pending_ack', reworkCount: 0, executionAttempt: 2 }),
      { type: 'QC_REJECT', returnTo: 'draft' },
    );
    expect(out.lane).toBe('draft'); // earliest-flagged-station back-edge
    expect(out.status).toBe('waiting');
    expect(out.reworkCount).toBe(1); // rework counter ++
    expect(out.executionAttempt).toBe(2); // execution-attempt counter untouched
  });

  it('at cap with cap_policy=scrap → lane=scrap, status=scrapped', () => {
    const out = next(
      mkState({ lane: 'select', status: 'done_pending_ack', reworkCount: 2 }), // reworkCap = 2
      { type: 'QC_REJECT', returnTo: 'draft' },
      mkCtx({ capPolicy: 'scrap' }),
    );
    expect(out.lane).toBe('scrap');
    expect(out.status).toBe('scrapped');
  });

  it('rejects a QC_REJECT whose returnTo is not a validated back-edge', () => {
    // No 'select → publish' back-edge exists — the verdict is not trusted.
    const result = transition(
      mkState({ lane: 'select', status: 'done_pending_ack', reworkCount: 0 }),
      { type: 'QC_REJECT', returnTo: 'publish' },
      mkCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('illegal_transition');
  });
});

// ---------------------------------------------------------------------------
// AC5 — needsJudgment (held, lane unchanged) vs dep-scrap (lane=hold).
//        Encodes the held-vs-hold distinction.
// ---------------------------------------------------------------------------

describe('held vs hold (AC5)', () => {
  it('NEEDS_JUDGMENT → status=held WITHOUT changing lane (pause-in-place)', () => {
    const out = next(mkState({ lane: 'draft', status: 'working' }), { type: 'NEEDS_JUDGMENT' });
    expect(out.status).toBe('held');
    expect(out.lane).toBe('draft'); // lane unchanged — this is held, not hold
  });

  it('DEP_SCRAP escalation (on_dep_scrap=hold) → lane=hold (a LANE change)', () => {
    const out = next(mkState({ lane: 'draft', status: 'waiting' }), { type: 'DEP_SCRAP' });
    expect(out.lane).toBe('hold'); // moved to the kernel terminal lane
    expect(out.status).toBe('held');
  });

  it('DEP_SCRAP with on_dep_scrap=scrap → lane=scrap', () => {
    const out = next(mkState({ lane: 'draft', status: 'waiting' }), { type: 'DEP_SCRAP' }, mkCtx({ onDepScrap: 'scrap' }));
    expect(out.lane).toBe('scrap');
    expect(out.status).toBe('scrapped');
  });
});

// ---------------------------------------------------------------------------
// AC6 — fan-out (awaiting_children) and fan-in met (assembler → ready).
// ---------------------------------------------------------------------------

describe('fan-out / fan-in (AC6)', () => {
  it('FAN_OUT → status=awaiting_children (parent waits, lane unchanged)', () => {
    const out = next(mkState({ lane: 'plan', status: 'done_pending_ack' }), { type: 'FAN_OUT' });
    expect(out.status).toBe('awaiting_children');
    expect(out.lane).toBe('plan');
  });

  it('FAN_IN_MET → assembler status=ready', () => {
    const out = next(mkState({ lane: 'assemble', status: 'awaiting_children' }), {
      type: 'FAN_IN_MET',
    });
    expect(out.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// AC7 — any (from, event) not in the matrix is an illegal-transition error,
//        never a guessed state.
// ---------------------------------------------------------------------------

describe('illegal transitions (AC7)', () => {
  it.each([
    ['ready', { type: 'MARK_DONE' } as KernelEvent],
    ['waiting', { type: 'START_WORK' } as KernelEvent],
    ['waiting', { type: 'MARK_DONE' } as KernelEvent],
    ['complete', { type: 'CLAIM' } as KernelEvent], // terminal
    ['scrapped', { type: 'CLAIM' } as KernelEvent], // terminal
    ['claimed', { type: 'MARK_DONE' } as KernelEvent],
    ['ready', { type: 'INTEGRITY_PASS' } as KernelEvent],
  ])('%s + %o → illegal_transition', (status, event) => {
    const result = transition(mkState({ status: status as FsmState['status'] }), event, mkCtx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('illegal_transition');
  });
});

// ---------------------------------------------------------------------------
// Worker crash mid-working → interrupted (SPEC §3 edge table).
// ---------------------------------------------------------------------------

describe('worker crash', () => {
  it('working + WORKER_CRASH → interrupted (lane unchanged)', () => {
    const out = next(mkState({ lane: 'draft', status: 'working' }), { type: 'WORKER_CRASH' });
    expect(out.status).toBe('interrupted');
    expect(out.lane).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// Issue #3 — a provider rate limit returns the card to ready, spending nothing.
// ---------------------------------------------------------------------------

describe('provider rate limit', () => {
  it('working + RATE_LIMITED → ready (lane unchanged, re-dispatchable)', () => {
    const out = next(mkState({ lane: 'draft', status: 'working' }), { type: 'RATE_LIMITED' });
    expect(out.status).toBe('ready');
    expect(out.lane).toBe('draft');
  });

  it('consumes NEITHER the execution attempt NOR the rework counter', () => {
    // This is the whole point. The work never ran and nothing was billed, so
    // charging the card for it is what let a session cap burn a whole budget in
    // three seconds and scrap already-paid-for work.
    const before = mkState({ lane: 'draft', status: 'working' });
    const out = next(before, { type: 'RATE_LIMITED' });
    expect(out.executionAttempt).toBe(before.executionAttempt);
    expect(out.reworkCount).toBe(before.reworkCount);
  });

  it('never scraps — a cap is an operating condition, not a failure', () => {
    const out = next(mkState({ lane: 'draft', status: 'working' }), { type: 'RATE_LIMITED' });
    expect(out.lane).not.toBe('scrap');
    expect(out.scrapReason).toBeUndefined();
  });

  it('is ILLEGAL from any status other than working', () => {
    for (const status of ['ready', 'claimed', 'done_pending_ack', 'held'] as const) {
      const result = transition(mkState({ lane: 'draft', status }), { type: 'RATE_LIMITED' }, mkCtx());
      expect(result.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #32: SKIP. A station's `skip_when` predicate matched, so the card
// passes to the station's declared `next` without the station running.
// ---------------------------------------------------------------------------

describe('skip (issue #32)', () => {
  it('ready + SKIP → happyPathNext[lane], status waiting', () => {
    const out = next(mkState({ lane: 'draft', status: 'ready' }), { type: 'SKIP' });
    expect(out.lane).toBe('publish');
    expect(out.status).toBe('waiting');
  });

  it('SKIP from the last station → (done, complete), mirroring INTEGRITY_PASS', () => {
    const out = next(mkState({ lane: 'assemble', status: 'ready' }), { type: 'SKIP' });
    expect(out.lane).toBe('done');
    expect(out.status).toBe('complete');
  });

  it('touches neither the execution attempt nor the rework counter', () => {
    const before = mkState({ lane: 'draft', status: 'ready', executionAttempt: 2, reworkCount: 1 });
    const out = next(before, { type: 'SKIP' });
    expect(out.executionAttempt).toBe(2);
    expect(out.reworkCount).toBe(1);
    expect(out.scrapReason).toBeUndefined();
  });

  it('is ILLEGAL on a lane with no happy-path entry', () => {
    const result = transition(mkState({ lane: 'nowhere', status: 'ready' }), { type: 'SKIP' }, mkCtx());
    expect(result.ok).toBe(false);
  });

  it('is ILLEGAL from every status other than ready', () => {
    const others = [
      'waiting',
      'claimed',
      'working',
      'done_pending_ack',
      'interrupted',
      'held',
      'awaiting_children',
      'complete',
      'scrapped',
    ] as const;
    for (const status of others) {
      const result = transition(mkState({ lane: 'draft', status }), { type: 'SKIP' }, mkCtx());
      expect(result.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding #8 — recovery OUT of interrupted (SPEC §15 reconcile). Without this
// an interrupted card is stranded — no legal `from` leaves the state.
// ---------------------------------------------------------------------------

describe('re-hydrate from interrupted', () => {
  it('interrupted + REHYDRATE → ready (lane unchanged, re-dispatchable)', () => {
    const out = next(mkState({ lane: 'draft', status: 'interrupted' }), { type: 'REHYDRATE' });
    expect(out.status).toBe('ready'); // back to a runnable status
    expect(out.lane).toBe('draft'); // resumes at the same station
  });

  it('a crashed card can crash then re-hydrate back to runnable (full reconcile path)', () => {
    const crashed = next(mkState({ lane: 'draft', status: 'working' }), { type: 'WORKER_CRASH' });
    expect(crashed.status).toBe('interrupted');
    const recovered = next(crashed, { type: 'REHYDRATE' });
    expect(recovered.status).toBe('ready');
    expect(recovered.lane).toBe('draft');
  });

  it('REHYDRATE is illegal from any non-interrupted status', () => {
    for (const status of ['ready', 'working', 'done_pending_ack', 'complete'] as const) {
      const result = transition(mkState({ status }), { type: 'REHYDRATE' }, mkCtx());
      expect(result.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Purity — the function must not mutate its input (no DB, no side effects).
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('does not mutate the input state', () => {
    const state = mkState({ lane: 'draft', status: 'done_pending_ack', executionAttempt: 1 });
    const snapshot = structuredClone(state);
    transition(state, { type: 'INTEGRITY_FAIL' }, mkCtx());
    expect(state).toEqual(snapshot); // input untouched; a new state object is returned
  });
});
