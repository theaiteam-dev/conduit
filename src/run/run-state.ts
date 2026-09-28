import type { ConduitDB, RunRecord } from '../persistence/db';
import type { Status } from '../types/kernel';
import { isLeaseHolderAlive, peekRunLeaseHolder, type LeaseLiveness } from './run-lock';

export type RunStateResult =
  | { status: 'not_found' }
  | { status: 'running' }
  | { status: 'held'; heldCards: Array<{ cardId: string; reason: string }> }
  /**
   * Halted with nothing wrong: every unfinished card is parked behind a
   * provider reset (issue #7), confirmed against the cards at read time.
   * `releaseAt` is the soonest gate, in the run clock's epoch seconds; `flow`
   * is the recorded flow path, so the resume command can be printed verbatim.
   */
  | { status: 'parked'; releaseAt: number; flow: string }
  /**
   * The run left `unfinished` cards outside a terminal lane and no live process
   * holds the run lease, so nothing is driving it: the engine recorded a halt
   * (andon, liveness stall), or the driver died without recording one (issue
   * #83). `flow` is for the resume command.
   */
  | { status: 'halted'; unfinished: number; flow: string }
  /**
   * A launch that failed before seeding any card (issue #83, `isFailedLaunch`):
   * the run has no cards and nothing drives it. Nothing ran, so there is
   * nothing to resume; the same `conduit run` command retries it. `flow` is
   * the recorded flow path.
   */
  | { status: 'launch_failed'; flow: string }
  | { status: 'terminal'; outcome: string };

const TERMINAL_STATUSES = new Set(['complete', 'scrapped', 'held']);

/**
 * Is this run a launch that failed before seeding any card (issue #83)?
 *
 * The run has no cards, and either it is recorded halted or it still reads
 * 'running' with a recorded lease holder that is no longer alive. The first
 * is a launch that failed and recorded it: `conduit run` records a launch that
 * fails after registering as halted rather than deleting the row, so the
 * failure stays visible to `run status`. The second is a launch killed before
 * it could record anything (SIGKILL, the OOM killer): registration writes the
 * holder with the row, so its dead pid is left behind. A halted row with no
 * cards comes from no other path, because every exit that drove the engine
 * with no card of its own records the run done. A 'running' row with no holder
 * is not counted: without a holder nothing says whether a launch is still
 * seeding it.
 *
 * The single predicate behind `registerRun`'s retry, `getRunState`'s
 * `launch_failed`, the append-pass refusal, the resume refusal and the
 * ingress router's pass-1 relaunch. `liveness` probes the holder; tests inject it.
 */
export function isFailedLaunch(db: ConduitDB, run: RunRecord | null, liveness: LeaseLiveness = {}): boolean {
  if (run === null) return false;
  if (run.status !== 'halted') {
    if (run.status !== 'running') return false;
    const holder = peekRunLeaseHolder(db, run.run_id);
    if (holder === null || isLeaseHolderAlive(holder, liveness)) return false;
  }
  const { n } = db
    .getStateDb()
    .prepare('SELECT COUNT(*) AS n FROM cards WHERE run_id = $r')
    .get({ $r: run.run_id }) as { n: number };
  return n === 0;
}

/** The soonest gate among a run's parked cards, when the run halted as parked. */
export interface ParkedRelease {
  releaseAt: number;
}

/**
 * Statuses that mean "blocked on another card": a dependent waiting on its
 * deps, a fan-out parent waiting on its children. Scheduling, not failure — if
 * the card they wait on is parked, so, transitively, are they.
 */
const WAITING_ON_OTHER_CARDS: ReadonlySet<Status> = new Set<Status>(['waiting', 'awaiting_children']);

/**
 * Is this run stopped ONLY because its cards are waiting on a provider reset?
 *
 * The single predicate behind `runs.outcome = 'parked'` (issue #7). A run
 * qualifies when at least one unfinished card is `ready` behind a `release_at`
 * still in the future THAT THE CARD_LOG ATTRIBUTES TO A PROVIDER CAP, and every
 * other unfinished card is either scheduled the same way or waiting on other
 * cards. A gate the card_log does not attribute to a cap — the fan-out
 * cache-warming stagger stamps the same column — is scheduling, not a park, and
 * a run holding only those reads as a plain halt. Anything else — a scrap, a hold, work in
 * flight, a gate already in the past with the card still not dispatched — is a
 * failure or a stall, and must keep reading as a plain halt so the operator
 * looks at it rather than merely waiting. Waiting cards with NO parked card
 * anywhere are a stall too: a wait on nothing scheduled never ends.
 *
 * `now` is in the run clock's frame (epoch seconds in production), the same
 * frame `release_at` was stamped in.
 */
export function getRunParkedRelease(db: ConduitDB, runId: string, now: number): ParkedRelease | null {
  const unfinished = db
    .getStateDb()
    .prepare("SELECT status, release_at FROM cards WHERE run_id = $r AND lane != 'done'")
    .all({ $r: runId }) as Array<{ status: Status; release_at: number | null }>;

  for (const card of unfinished) {
    if (WAITING_ON_OTHER_CARDS.has(card.status)) continue;
    if (card.status !== 'ready' || card.release_at === null || card.release_at <= now) return null;
  }
  // Every unfinished card is scheduled rather than stuck. That alone does NOT
  // make the run parked: a gate is only a PROVIDER cap when the card_log says
  // so, and the fan-out stagger stamps the same column. Asking for the soonest
  // rate-limit gate answers both questions at once — it is null when no card is
  // capped, which is the stall/stagger case, and it is the gate to resume on
  // otherwise. A run gated only by a stagger therefore reads as a plain halt,
  // so the operator still gets the stuck-card summary for whatever stopped it.
  const releaseAt = soonestRateLimitGate(db, runId, now);
  return releaseAt === null ? null : { releaseAt };
}

/**
 * Why a card is gated, which `cards.release_at` cannot say on its own: the
 * fan-out cache-warming stagger stamps that column exactly as the rate-limit
 * park does. Only the card_log records the reason — `parkCardUntil` writes its
 * move with `reasonClass: 'rate_limited'` — so the card's latest `entered_lane`
 * entry is the authority, and an older park further back does not count.
 */
function isRateLimitGated(db: ConduitDB, runId: string, cardId: string): boolean {
  const log = db.getCardLogForRun(runId, cardId);
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!;
    if (entry.kind !== 'entered_lane') continue;
    return entry.reasonClass === 'rate_limited';
  }
  return false;
}

/**
 * The soonest `release_at` among a run's cards parked by a PROVIDER CAP, or
 * null when none is.
 *
 * The single implementation behind both readers: the executor's andon halt line
 * and `getRunParkedRelease` above. They were two predicates that disagreed —
 * the CLI read ANY `release_at` as a cap, so a run the andon halted while a
 * fan-out stagger gated its siblings was recorded `outcome='parked'` and
 * reported to the operator as "parked behind a provider rate limit", while the
 * executor's line on the same halt correctly said only that the budget was
 * exceeded. `outcome='parked'` is what puts a run on the ingress listener's
 * unattended resume path, so the distinction decides more than wording.
 */
export function soonestRateLimitGate(db: ConduitDB, runId: string, now: number): number | null {
  const gated = db
    .getStateDb()
    .prepare(
      `SELECT id, release_at FROM cards
       WHERE run_id = $r AND status = 'ready' AND release_at IS NOT NULL AND release_at > $now
       ORDER BY release_at`,
    )
    .all({ $r: runId, $now: now }) as Array<{ id: string; release_at: number }>;
  for (const { id, release_at } of gated) {
    if (isRateLimitGated(db, runId, id)) return release_at;
  }
  return null;
}

/**
 * The gate time as ISO-8601 UTC. `releaseAt` is epoch seconds in production;
 * an injected test clock renders as a 1970 timestamp, which is still exact.
 */
export function formatReleaseAt(releaseAt: number): string {
  return new Date(releaseAt * 1000).toISOString();
}

/**
 * What an operator needs when a run parks: when the provider lets it continue,
 * and the exact command that continues it. Shared by the run/resume exit paths
 * and `run status`, so the wording cannot drift between them. Callers prefix
 * the run id in their own house style.
 */
export function formatParkedRun(runId: string, flow: string, releaseAt: number): string {
  return (
    `parked behind a provider rate limit until ${formatReleaseAt(releaseAt)} — nothing was scrapped; ` +
    `resume with: ${resumeCommand(runId, flow)}`
  );
}

/** The `run status` line for a halt that left cards unfinished (issue #83). */
export function formatHaltedRun(runId: string, flow: string, unfinished: number): string {
  return `halted with ${unfinished} unfinished card${unfinished === 1 ? '' : 's'}; resume with: ${resumeCommand(runId, flow)}`;
}

/**
 * The `run status` line for a launch that failed before seeding (issue #83).
 * The command cannot be printed: the input it was given is not recorded.
 */
export function formatLaunchFailedRun(): string {
  return 'launch failed before any card was seeded; re-run the same conduit run command to retry';
}

function resumeCommand(runId: string, flow: string): string {
  return `conduit resume ${shellQuote(flow)} --run ${shellQuote(runId)}`;
}

/**
 * Quote an argument for the copy-pasteable command above. `runs.flow` is always
 * an absolute resolved path, so a project under `/home/me/My Flows/` produced a
 * command that silently resolved to the wrong argv. Single quotes with the
 * standard `'\''` escape: everything inside is literal to the shell.
 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `now` is in the run clock's frame (epoch seconds), used only to confirm a
 * recorded park against the cards; the default is the production clock.
 * `liveness` probes the run lease holder (`isLeaseHolderAlive`); tests inject it.
 */
export function getRunState(
  db: ConduitDB,
  runId: string,
  now: number = Math.floor(Date.now() / 1000),
  liveness: LeaseLiveness = {},
): RunStateResult {
  const run = db.getRun(runId);
  if (!run) return { status: 'not_found' };

  const stateDb = db.getStateDb();
  const cards = stateDb
    .prepare('SELECT id, status, lane FROM cards WHERE run_id = $r')
    .all({ $r: runId }) as Array<{ id: string; status: string; lane: string }>;

  const heldCards = cards.filter((c) => c.status === 'held');
  if (heldCards.length > 0) {
    return {
      status: 'held',
      heldCards: heldCards.map((c) => {
        // O(held) queries — db.ts exposes no "latest log entry" accessor, so we
        // fetch the full per-card log and scan backwards for the last terminal
        // entry (iterate from the end, break on first match — no full reverse).
        // Acceptable at current scale (held cards are rare and small in number).
        const entries = db.getCardLogForRun(runId, c.id);
        let reason = '';
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]!;
          if (entry.kind === 'terminal') {
            reason = entry.reason ?? '';
            break;
          }
        }
        return { cardId: c.id, reason };
      }),
    };
  }

  // The row alone cannot say whether anything drives the run: resume takes the
  // lease but leaves a halted row as it is until it exits, and a driver killed
  // by SIGKILL or the OOM killer leaves the row 'running' with its dead pid as
  // holder. The lease holder tells them apart, judged by pid and start time so
  // a pid the kernel has since given to another process does not count.
  // `conduit run` takes the lease in the same insert that registers the run,
  // so a launch that dies at any point after registering leaves a dead holder.
  // A 'running' row with no holder is therefore a row written before that
  // (a pre-v12 launch), or by a caller that registers without a holder; with
  // no evidence either way it reads running while it has unfinished cards, and
  // terminal once it has none, as below.
  // It is read before the parked check: a resume that takes a parked run's lease
  // before the gate opens leaves the card `ready` behind the same future
  // release_at, and that run is being driven, so it reads running.
  const holder = peekRunLeaseHolder(db, runId);
  const driven = holder !== null && isLeaseHolderAlive(holder, liveness);

  // A parked run's cards are all `ready` or waiting on each other, which would
  // otherwise read as running. The runs row says a park was observed at exit —
  // but it stays stamped until the NEXT exit, so a resume in flight (cards
  // working, or a live holder still waiting on the same gate) or a gate that
  // has since passed must not still read as parked: confirm against the cards
  // with the same predicate that stamped the row, and only once no live
  // process is driving it.
  if (!driven && run.status === 'halted' && run.outcome === 'parked') {
    const parked = getRunParkedRelease(db, runId, now);
    if (parked !== null) return { status: 'parked', releaseAt: parked.releaseAt, flow: run.flow };
  }

  // A failed launch has no cards, so it would otherwise read as terminal. A
  // live holder is a launch, retry or resume under way, which reads running.
  // It is checked first because isFailedLaunch does not look at the holder of
  // a halted row.
  if (cards.length === 0) {
    if (driven) return { status: 'running' };
    if (isFailedLaunch(db, run, liveness)) return { status: 'launch_failed', flow: run.flow };
  }

  const unfinished = cards.filter((c) => !TERMINAL_STATUSES.has(c.status)).length;
  if (unfinished === 0) return { status: 'terminal', outcome: run.outcome ?? 'unknown' };

  if (!driven && (run.status === 'halted' || holder !== null)) {
    return { status: 'halted', unfinished, flow: run.flow };
  }
  return { status: 'running' };
}
