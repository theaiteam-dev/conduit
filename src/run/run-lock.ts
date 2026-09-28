/**
 * Per-run advisory lease lock (the original run-lock and busy-retry work, part 1).
 *
 * Run namespacing (schema v6/v7) made multiple concurrent `conduit run`
 * processes with DIFFERENT `--run-id`s on one shared DB a supported feature.
 * The invariant this module enforces is narrower: at most one process may
 * DRIVE a given run_id at a time. Two processes driving the same run_id would
 * double-dispatch and corrupt executor-loop assumptions (liveness stamps,
 * pool slots, watchdog).
 *
 * This is a single-host advisory lock, not a distributed one — the holder is
 * identified by OS pid and process start time, stored on the run's own row in
 * the `runs` table (columns `holder_pid` / `lease_acquired_at`, schema v8, and
 * `holder_start_time`, schema v12). Acquisition and
 * release run inside a single `BEGIN IMMEDIATE` transaction on the state DB,
 * mirroring the linearization idiom in src/dispatch/claim.ts.
 *
 * Both writes are wrapped in `withBusyRetry` (src/persistence/busy-retry.ts,
 * the original run-lock and busy-retry work part 2), same as the claim-path transactions, so sustained
 * cross-process contention on the state DB is absorbed with backoff instead
 * of throwing raw SQLITE_BUSY. The two calls are NOT symmetric on exhaustion,
 * though: `acquireRunLease` throws (it runs before any engine work starts, so
 * an informative crash is fine and correct), while `releaseRunLease` never
 * throws (see its doc comment — it always runs from a caller's `finally`,
 * where a thrown error would mask the engine's real result).
 *
 * Holder liveness is process identity, not bare pid existence (issue #83).
 * After a host reboot or pid-space wraparound an unrelated process can be
 * given a dead holder's pid, and a signal-0 probe alone would report that
 * process as the holder: `run status` would say `running` forever and
 * `acquireRunLease` would refuse to reclaim. So a lease records the holder's
 * start time (`processStartTime`, field 22 of /proc/<pid>/stat, the same
 * identity the stale-cgroup sweep uses), and `isLeaseHolderAlive` treats a
 * live pid with a different start time as a dead holder. Every caller that
 * decides whether a lease holder is live goes through that one function.
 *
 * REMAINING LIMITATION: where the start time cannot be read (no /proc, as on
 * macOS, or a `hidepid` mount hiding another user's process), and for a lease
 * recorded before schema v12, the check falls back to the pid probe and the
 * old pid-reuse window applies. It fails closed: a holder is never declared
 * dead without proof.
 */

import type { ConduitDB } from '../persistence/db';
import { withBusyRetry } from '../persistence/busy-retry';
import { processStartTime as defaultProcessStartTime } from '../worker/cgroup-containment';

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

/**
 * Default liveness check: signal 0 probes for existence without killing.
 * ESRCH (no such process) → dead. EPERM (exists, owned by another user) or
 * any other unexpected errno → treat as alive — never steal a lease we
 * cannot prove is dead (fail closed).
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== 'ESRCH';
  }
}

// ---------------------------------------------------------------------------
// isLeaseHolderAlive
// ---------------------------------------------------------------------------

/** How a lease holder's liveness is probed. Both default to the real host; tests inject them. */
export interface LeaseLiveness {
  isPidAlive?: (pid: number) => boolean;
  /** A process's start time, or undefined when it cannot be read. */
  processStartTime?: (pid: number) => number | undefined;
}

/** A run's recorded lease holder, as `peekRunLeaseHolder` returns it. */
export interface RunLeaseHolder {
  holderPid: number;
  acquiredAt: number;
  /** The holder's start time when the lease was taken; null when unreadable then, or recorded before v12. */
  holderStartTime: number | null;
}

/**
 * Is the process that took this lease still running?
 *
 * Dead when its pid is dead. Dead too when the pid is alive but its start time
 * differs from the one the lease recorded: the kernel gave the pid to another
 * process. When either start time is unknown (a pre-v12 lease, or a current
 * one that cannot be read) the pid probe decides alone, so a live holder is
 * never declared dead on missing evidence.
 */
export function isLeaseHolderAlive(
  holder: Pick<RunLeaseHolder, 'holderPid' | 'holderStartTime'>,
  liveness: LeaseLiveness = {},
): boolean {
  const isPidAlive = liveness.isPidAlive ?? defaultIsPidAlive;
  if (!isPidAlive(holder.holderPid)) return false;
  if (holder.holderStartTime === null) return true;
  const current = (liveness.processStartTime ?? defaultProcessStartTime)(holder.holderPid);
  return current === undefined || current === holder.holderStartTime;
}

/**
 * What a process writes to take a run lease: its pid, the time, and its start
 * time (null when unreadable). `registerRun` writes the same claim with a new
 * row, so the two paths record the holder identically.
 */
export interface RunLeaseClaim {
  pid: number;
  acquiredAt: number;
  startTime: number | null;
}

/** The claim `pid` makes on a run lease at `now`. */
export function leaseClaimFor(
  pid: number,
  now: number,
  processStartTime: (pid: number) => number | undefined = defaultProcessStartTime,
): RunLeaseClaim {
  return { pid, acquiredAt: now, startTime: processStartTime(pid) ?? null };
}

// ---------------------------------------------------------------------------
// acquireRunLease / releaseRunLease
// ---------------------------------------------------------------------------

export type AcquireRunLeaseResult =
  | { acquired: true }
  | { acquired: false; holderPid: number; acquiredAt: number };

interface RunHolderRow {
  holder_pid: number | null;
  lease_acquired_at: number | null;
  holder_start_time: number | null;
}

const SELECT_HOLDER = 'SELECT holder_pid, lease_acquired_at, holder_start_time FROM runs WHERE run_id = $run_id';

function toHolder(row: RunHolderRow | undefined): RunLeaseHolder | null {
  if (!row || row.holder_pid === null) return null;
  return {
    holderPid: row.holder_pid,
    acquiredAt: row.lease_acquired_at ?? 0,
    holderStartTime: row.holder_start_time ?? null,
  };
}

/**
 * Attempt to become the driving process for `runId`.
 *
 * Acquires when: no row is holding the lease (holder_pid IS NULL), the
 * current holder IS this same pid (re-entrant — refreshes lease_acquired_at),
 * or the current holder is no longer alive by `isLeaseHolderAlive` (stale —
 * the previous driver crashed without releasing, or its pid now belongs to
 * another process). Refuses only when a DIFFERENT, live holder has the
 * lease — a live holder's lease is never silently stolen. The caller's start
 * time is recorded with the lease.
 *
 * A run_id with no `runs` row at all (not yet registered, or a legacy DB
 * predating run registration) has nothing to protect — treated as a free
 * acquire; the UPDATE below is then a safe no-op (matches zero rows).
 *
 * Wrapped in `withBusyRetry` (the original run-lock and busy-retry work part 2): under sustained contention
 * from concurrent `conduit run` processes sharing this DB, a writer that
 * cannot acquire the BEGIN IMMEDIATE reservation within busy_timeout throws
 * SQLITE_BUSY. Retrying with backoff lets transient contention wait instead
 * of aborting the acquire outright. On exhaustion this still throws — no
 * engine work has started yet, so an informative crash here is correct.
 */
export function acquireRunLease(
  db: ConduitDB,
  runId: string,
  pid: number,
  now: number,
  liveness: LeaseLiveness = {},
): AcquireRunLeaseResult {
  const stateDb = db.getStateDb();
  const claim = leaseClaimFor(pid, now, liveness.processStartTime);

  return withBusyRetry(() =>
    stateDb
      .transaction((): AcquireRunLeaseResult => {
        const holder = toHolder(stateDb.prepare(SELECT_HOLDER).get({ $run_id: runId }) as RunHolderRow | undefined);

        if (holder !== null && holder.holderPid !== pid && isLeaseHolderAlive(holder, liveness)) {
          return { acquired: false, holderPid: holder.holderPid, acquiredAt: holder.acquiredAt };
        }

        stateDb
          .prepare(
            `UPDATE runs SET holder_pid = $pid, lease_acquired_at = $now, holder_start_time = $start_time
             WHERE run_id = $run_id`,
          )
          .run({ $pid: claim.pid, $now: claim.acquiredAt, $start_time: claim.startTime, $run_id: runId });

        return { acquired: true };
      })
      .immediate(),
  );
}

/**
 * Release the lease held by `pid` on `runId`. A no-op when `pid` is not the
 * current holder (never clears someone else's lease) and when the run has no
 * row at all.
 *
 * The write is wrapped in `withBusyRetry` (the original run-lock and busy-retry work part 2) so transient
 * contention is absorbed the same as `acquireRunLease`. Unlike acquire,
 * though, a release failure must NEVER propagate: every caller invokes this
 * from a `finally` block after the engine has already run (see
 * src/cli/main.ts), and a thrown error here would replace/mask the engine's
 * real error or result rather than add to it. So any error surviving
 * busy-retry — exhaustion or otherwise — is caught, reported to stderr, and
 * swallowed; the function reports success via its boolean return instead of
 * by not-throwing. A swallowed failure leaves `holder_pid` stuck, but this
 * self-heals: the next `acquireRunLease` against this run_id finds the
 * recorded holder dead (the process that failed to release is the same one
 * that is now exiting) and reclaims the stale lease.
 */
export function releaseRunLease(db: ConduitDB, runId: string, pid: number): boolean {
  const stateDb = db.getStateDb();

  try {
    withBusyRetry(() =>
      stateDb
        .prepare(
          `UPDATE runs SET holder_pid = NULL, lease_acquired_at = NULL, holder_start_time = NULL
           WHERE run_id = $run_id AND holder_pid = $pid`,
        )
        .run({ $run_id: runId, $pid: pid }),
    );
    return true;
  } catch (err) {
    console.error(
      `releaseRunLease: failed to release lease for run '${runId}' (pid ${pid}) — ` +
        `leaving holder_pid set; it will self-heal once this pid is found dead: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// peekRunLeaseHolder — read-only inspection, never claims the lease
// ---------------------------------------------------------------------------

/**
 * Report the current holder of `runId`'s lease without acquiring it.
 *
 * Used by callers that are NOT about to drive the engine (e.g. an idempotent
 * `conduit run` re-submit that only prints run state) but still want to warn
 * the operator that a live process currently owns this run, rather than
 * silently racing it. Returns null when unheld (no row, or holder_pid IS NULL).
 * Whether the returned holder is still running is `isLeaseHolderAlive`'s call.
 */
export function peekRunLeaseHolder(db: ConduitDB, runId: string): RunLeaseHolder | null {
  return toHolder(db.getStateDb().prepare(SELECT_HOLDER).get({ $run_id: runId }) as RunHolderRow | undefined);
}
