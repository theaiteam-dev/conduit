/**
 * Run passes (issue #36).
 *
 * An ingress binding that declares `run_key` maps every event about one
 * external subject (a pull request, a ticket) onto ONE run, and each event
 * after the first becomes the next PASS of that run: a fresh entry card seeded
 * into the finished run by `conduit run --append-pass`. The run's cards,
 * journal, and checkpoints then hold the subject's whole history.
 *
 * Pass 1 is the run's ordinary entry card, `entry-<runId>`. Pass N > 1 is
 * `entry-<runId>-p<N>`. The next N is derived from the cards table, never from
 * a counter in memory, so the kernel and the ingress listener, which share the
 * state DB, cannot disagree about it.
 *
 * Checkpoints, outbox keys, journal spans, and rework counters are all keyed
 * per card, so a new pass card never replays or collides with an earlier pass's
 * state.
 */
import type { ConduitDB } from '../persistence/db';
import { getRunState } from './run-state';

/**
 * Exit code of `conduit run --append-pass` when the run exists but is not in a
 * state that can take a pass (running, parked, halted, holding cards, or out
 * of token budget). Distinct from the generic 1 so the listener can tell a
 * refusal from a failure.
 */
export const EXIT_PASS_REFUSED = 3;

/**
 * Exit code of `conduit run --append-pass` when another live process holds
 * the run lease (EX_TEMPFAIL). The listener turns this into a pending pass
 * rather than a failure: the holder is driving the run and will finish.
 */
export const EXIT_RUN_LEASE_CONFLICT = 75;

/** The entry-card id of pass `pass` of `runId`. */
export function passEntryCardId(runId: string, pass: number): string {
  return pass <= 1 ? `entry-${runId}` : `entry-${runId}-p${pass}`;
}

/**
 * The number the next pass of `runId` would get: one more than the highest
 * pass entry card present, or 1 when the run has none. Only root cards count,
 * and ids are matched in code rather than with LIKE, since a run id may carry
 * `_`, which LIKE reads as a wildcard.
 */
export function nextPassNumber(db: ConduitDB, runId: string): number {
  const rows = db
    .getStateDb()
    .prepare('SELECT id FROM cards WHERE run_id = $run_id AND parent_id IS NULL')
    .all({ $run_id: runId }) as Array<{ id: string }>;
  const first = `entry-${runId}`;
  const prefix = `${first}-p`;
  let highest = 0;
  for (const { id } of rows) {
    if (id === first) {
      highest = Math.max(highest, 1);
    } else if (id.startsWith(prefix)) {
      const suffix = id.slice(prefix.length);
      if (/^[1-9][0-9]*$/.test(suffix)) highest = Math.max(highest, Number(suffix));
    }
  }
  return highest + 1;
}

/** Why a run cannot take a pass. */
export type RunNotAppendableState = 'not_found' | 'running' | 'parked' | 'held' | 'halted';

export type RunAppendableResult =
  | { ok: true }
  | { ok: false; state: RunNotAppendableState; detail: string };

/**
 * May a new pass be appended to `runId`? Only a run that finished
 * successfully: runs.status 'done', with every card terminal and none held.
 * `nowSeconds` is the run clock, used to confirm a recorded park.
 */
export function checkRunAppendable(db: ConduitDB, runId: string, nowSeconds: number): RunAppendableResult {
  const run = db.getRun(runId);
  if (run === null) return { ok: false, state: 'not_found', detail: 'the run does not exist' };

  if (run.status === 'halted' && run.outcome === 'parked') {
    return {
      ok: false,
      state: 'parked',
      detail: 'the run is parked behind a provider rate limit; it resumes on its own, not by a new pass',
    };
  }

  const state = getRunState(db, runId, nowSeconds);
  if (state.status === 'held') {
    return { ok: false, state: 'held', detail: `the run is holding ${state.heldCards.length} card(s) for a human` };
  }
  if (state.status === 'running' || run.status === 'running') {
    return {
      ok: false,
      state: 'running',
      detail: 'the run has not finished (resume it with conduit resume if its driver crashed)',
    };
  }
  if (run.status !== 'done') {
    return { ok: false, state: 'halted', detail: `the run ended ${run.outcome ?? run.status}, not complete` };
  }
  return { ok: true };
}
