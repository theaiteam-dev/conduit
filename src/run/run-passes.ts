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
import { isFailedLaunch } from './run-state';

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

/**
 * Tokens left under a run ceiling of `maxTokens` once every earlier
 * invocation of runId is counted (issue #36). The run budget of a run that
 * takes passes is one ceiling across all of them, so both `--append-pass` and
 * `conduit resume` of such a run cap the invocation at this figure. May be
 * zero or negative; callers clamp.
 */
export function remainingRunTokens(db: ConduitDB, runId: string, maxTokens: number): number {
  return maxTokens - db.getRunUsageTotals(runId).tokens;
}

/** Has runId taken a pass beyond its first (issue #36)? */
export function hasLaterPasses(db: ConduitDB, runId: string): boolean {
  return nextPassNumber(db, runId) > 2;
}

/** Why a run cannot take a pass. */
export type RunNotAppendableState = 'not_found' | 'running' | 'parked' | 'held' | 'unfinished' | 'launch_failed';

export type RunAppendableResult =
  | { ok: true }
  | { ok: false; state: RunNotAppendableState; detail: string };

/** Lanes a card can rest in once its work has concluded, well or badly. */
const CONCLUDED_LANES: ReadonlySet<string> = new Set(['done', 'scrap']);

/**
 * May a new pass be appended to `runId`? Only a run whose previous pass
 * CONCLUDED: not parked, not recorded running, and every card in the done or
 * scrap lane with none held. A pass that scrapped counts as concluded: for an
 * unattended loop a scrapped pass is an ordinary bad outcome, and `conduit
 * resume` cannot bring a scrapped card to done, so refusing would block the
 * subject for good. A run the andon halted with unfinished cards, or one whose
 * driver died, is refused: it still has work that a resume can finish.
 *
 * The running check runs BEFORE the held check: a run still recorded
 * 'running' is reported 'running' even if one of its cards is held, since the
 * CLI only records 'done'/'halted' once the engine returns, so 'running' with
 * no live lease holder means the driver died while the card was held, not
 * that a resume is in flight. Reporting that case as 'held' would tell a
 * caller (the ingress listener) to wait for a resume that will never come.
 *
 * The run lease is the caller's to check: the CLI takes it before asking, and
 * the listener treats a live holder as a pass in flight. `nowSeconds` is the
 * run clock; it is kept for callers that confirm a park against it.
 */
export function checkRunAppendable(db: ConduitDB, runId: string, _nowSeconds: number): RunAppendableResult {
  const run = db.getRun(runId);
  if (run === null) return { ok: false, state: 'not_found', detail: 'the run does not exist' };

  if (run.status === 'halted' && run.outcome === 'parked') {
    return {
      ok: false,
      state: 'parked',
      detail: 'the run is parked behind a provider rate limit; it resumes on its own, not by a new pass',
    };
  }

  if (run.status === 'running') {
    return {
      ok: false,
      state: 'running',
      detail: 'the run has not finished (resume it with conduit resume if its driver crashed)',
    };
  }

  // A launch that failed before seeding (issue #83) has no pass to follow:
  // the launch itself is what needs retrying, and a plain `conduit run` does it.
  if (isFailedLaunch(db, run)) {
    return {
      ok: false,
      state: 'launch_failed',
      detail:
        'its launch failed before any card was seeded; retry it with the same conduit run command, ' +
        'without --append-pass',
    };
  }

  const cards = db
    .getStateDb()
    .prepare('SELECT lane, status FROM cards WHERE run_id = $run_id')
    .all({ $run_id: runId }) as Array<{ lane: string; status: string }>;

  const held = cards.filter((c) => c.status === 'held' || c.lane === 'hold').length;
  if (held > 0) {
    return { ok: false, state: 'held', detail: `the run is holding ${held} card(s) for a human` };
  }
  const unfinished = cards.filter((c) => !CONCLUDED_LANES.has(c.lane)).length;
  if (cards.length === 0 || unfinished > 0) {
    return {
      ok: false,
      state: 'unfinished',
      detail:
        cards.length === 0
          ? 'the run has no cards'
          : `the run stopped with ${unfinished} unfinished card(s); resume it with conduit resume`,
    };
  }
  return { ok: true };
}
