import { createHash } from 'node:crypto';
import { validateRunId } from './run-id';
import type { ConduitDB, RunRecord } from '../persistence/db';
import { withBusyRetry } from '../persistence/busy-retry';
import { isLeaseHolderAlive, peekRunLeaseHolder, type LeaseLiveness, type RunLeaseClaim } from './run-lock';
import { isFailedLaunch } from './run-state';

export type RegisterRunResult =
  /**
   * The row is this launch's to drive. `retried` is true when it was a failed
   * launch (`isFailedLaunch`) re-registered in place rather than a new row.
   */
  | { kind: 'created'; run: RunRecord; retried: boolean }
  | { kind: 'existing'; run: RunRecord }
  | { kind: 'conflict'; recorded: RunRecord };

/**
 * Record a run, or report the row already recorded under `runId`.
 *
 * `holder`, when given, takes the run lease in the same insert that creates
 * the row (issue #83). A launch that died between a bare insert and its later
 * `acquireRunLease` left a 'running' row with no holder, and nothing could
 * tell that row from one whose driver was about to take the lease, so it read
 * as running forever. With the holder written alongside, a dead launch leaves
 * a dead holder, which `getRunState` reports as halted. The existing and
 * conflict paths leave the recorded row and its holder untouched.
 *
 * A failed launch (`isFailedLaunch`: no cards, and halted or left 'running'
 * by a dead holder) is retried in place: the row
 * is rewritten as a fresh registration would write it (status 'running', no
 * outcome, this call's flow, fingerprint, project root and holder) and the
 * result is 'created' with `retried: true`. Nothing ran under the old
 * fingerprint, so a different one (a corrected input) is a retry, not a
 * conflict. When a different live process holds the lease on that row, the
 * result is 'existing', which the CLI reports as a lease conflict. The read,
 * the check and the write share one `BEGIN IMMEDIATE` transaction, so two
 * retries of one run cannot both take it. `liveness` probes the recorded
 * holder; tests inject it. `created_at` keeps the first launch's time.
 */
export function registerRun(
  db: ConduitDB,
  runId: string,
  flow: string,
  inputFingerprint: string,
  projectRoot?: string,
  holder?: RunLeaseClaim,
  liveness: LeaseLiveness = {},
): RegisterRunResult {
  validateRunId(runId);

  const normalizedProjectRoot = projectRoot ?? null;
  const stateDb = db.getStateDb();
  return withBusyRetry(() =>
    stateDb
      .transaction((): RegisterRunResult => {
        const recorded = db.getRun(runId);
        if (recorded === null) {
          db.insertRun({
            run_id: runId,
            flow,
            project_root: normalizedProjectRoot,
            input_fingerprint: inputFingerprint,
            status: 'running',
            ...(holder !== undefined && {
              holder_pid: holder.pid,
              lease_acquired_at: holder.acquiredAt,
              holder_start_time: holder.startTime,
            }),
          });
          return { kind: 'created', run: db.getRun(runId)!, retried: false };
        }

        if (isFailedLaunch(db, recorded, liveness)) {
          const current = peekRunLeaseHolder(db, runId);
          if (current !== null && current.holderPid !== holder?.pid && isLeaseHolderAlive(current, liveness)) {
            return { kind: 'existing', run: recorded };
          }
          stateDb
            .prepare(
              `UPDATE runs SET flow = $flow, project_root = $project_root, input_fingerprint = $fingerprint,
                 status = 'running', outcome = NULL,
                 holder_pid = $pid, lease_acquired_at = $acquired_at, holder_start_time = $start_time
               WHERE run_id = $run_id`,
            )
            .run({
              $flow: flow,
              $project_root: normalizedProjectRoot,
              $fingerprint: inputFingerprint,
              $pid: holder?.pid ?? null,
              $acquired_at: holder?.acquiredAt ?? null,
              $start_time: holder?.startTime ?? null,
              $run_id: runId,
            });
          return { kind: 'created', run: db.getRun(runId)!, retried: true };
        }

        if (
          recorded.flow === flow &&
          recorded.input_fingerprint === inputFingerprint &&
          (recorded.project_root ?? null) === normalizedProjectRoot
        ) {
          return { kind: 'existing', run: recorded };
        }

        return { kind: 'conflict', recorded };
      })
      .immediate(),
  );
}

function canonicalSort(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    sorted[key] =
      val !== null && typeof val === 'object' && !Array.isArray(val)
        ? canonicalSort(val as Record<string, unknown>)
        : val;
  }
  return sorted;
}

export function computeFingerprint(
  flow: string,
  inputs: Record<string, unknown>,
  projectRoot?: string,
): string {
  const payload = JSON.stringify({
    flow,
    input: canonicalSort(inputs),
    ...(projectRoot !== undefined ? { project_root: projectRoot } : {}),
  });
  return createHash('sha256').update(payload).digest('hex');
}
