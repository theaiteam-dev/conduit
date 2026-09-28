/**
 * Keyed ingress runs: one run per external subject, one pass per event (issue #36).
 *
 * A webhook binding that declares `run_key` maps every delivery about one
 * subject (a pull request, a ticket) onto ONE run id
 * (deriveKeyedIngressRunId). Delivery dedup is unchanged: ingress_events still
 * collapses retries of one delivery by event id. What changes is what an
 * accepted event does next, decided here for the hot accept path, the re-drive
 * sweeps, and the pending drain alike:
 *
 *   - no run yet, or a launch     → launch pass 1 (`conduit run --run-id`).
 *     that failed before seeding
 *   - a pass is in flight         → fold the event into the run's PENDING pass
 *     (a launch or resume holds    ('coalesced'). Six events during one pass
 *     one of the run's slots, a    produce ONE trailing pass, not six. The
 *     live process holds the run   latest is its top-level input, and all six
 *     lease, an older event for    are listed in its `events` field
 *     the run is still queued, the (stampKeyedPass).
 *     run is parked, or it holds
 *     a card for a human)
 *   - previous pass concluded     → launch the next pass with
 *     (every card in done or       `conduit run --append-pass`, unless the
 *     scrap)                       binding's max_passes is reached
 *                                  ('pass_limit').
 *   - run stopped with unfinished → do not launch ('run_not_appendable').
 *     cards, or crashed mid-pass
 *
 * The channel hears ONCE per run (ingress_keyed_runs.blocked_alerted), not
 * once per event, about a pass_limit or run_not_appendable refusal and about
 * events waiting on a held run; the flag is cleared when a pass launches, so a
 * run that is fixed and blocks again is reported again. Every refusal is still
 * logged.
 *
 * Which events each pass consumed is recorded by the kernel, in the
 * transaction that seeds the pass's entry card (run_pass_events, written from
 * the `--pass-event` arguments). The router checks it before launching, so an
 * event whose pass exists is never launched a second time, even when the
 * listener lost that pass's exit or restarted mid-launch ('already_applied').
 *
 * When a pass's child exits, the run's pending event (if any) is launched as
 * exactly one more pass. The periodic sweep drains pending events too, which
 * is what carries them across a listener restart and past a parked-run resume
 * or a HITL resume that the listener did not launch as a pass.
 *
 * Passes draw from the listener's run-slot pool like any launch and never
 * bypass it. The slot id is per RUN (`keyed-run:<runId>`), so two launches for
 * one run can never overlap in this process; the run lease covers everything
 * else. A child that exits EXIT_RUN_LEASE_CONFLICT lost to another driver of
 * the same run, so its event becomes pending rather than failed.
 *
 * Payload values never reach SQL or a shell: every query binds parameters and
 * the spawn seam takes an argv array.
 */
import type { ConduitDB, IngressEventRecord, KeyedRunRecord } from '../persistence/db';
import { isLeaseHolderAlive, peekRunLeaseHolder } from '../run/run-lock';
import { isFailedLaunch } from '../run/run-state';
import {
  checkRunAppendable,
  nextPassNumber,
  EXIT_PASS_REFUSED,
  EXIT_RUN_LEASE_CONFLICT,
} from '../run/run-passes';
import { resolveAlertChannel, type RedriveAlerting } from './alert-channel';
import { stampKeyedPass, type PassEventInput } from './envelope';
import { inspectParkedRun, recordPark } from './parked';
import { keyedRunSlotId, type RunSlots } from './run-slots';
import type { SpawnExit, SpawnFailedAlert, SpawnSeam } from './spawn';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KeyedRunDeps {
  db: ConduitDB;
  /** The listener's launch seam; a pass N > 1 is launched with `appendPass`. */
  spawn: SpawnSeam;
  alerts: RedriveAlerting;
  slots: RunSlots;
  /** Attempt cap shared with the re-drive sweep: a failed row under it is still queued. */
  redriveCap: number;
  /** Listener clock, unix MILLISECONDS. */
  now: () => number;
  /** Is a recorded lease holder's pid alive? Defaults to the real pid probe. */
  isPidAlive?: (pid: number) => boolean;
  /**
   * A process's start time, compared with the one the lease recorded so a
   * reused pid is not taken for the holder. Defaults to reading /proc.
   */
  processStartTime?: (pid: number) => number | undefined;
  /**
   * Event ids whose launch is in progress in this process (between the slot
   * acquire and the row's mark). The re-drive sweep skips them; one set is
   * shared by every caller the listener wires.
   */
  launching: Set<string>;
}

/** What routing one keyed event did. */
export type KeyedRouteOutcome =
  /** A pass was launched from this event. */
  | { outcome: 'accepted'; runId: string; pass: number }
  /** No free run slot: the row stays re-drivable and the sweep launches it. */
  | { outcome: 'queued'; runId: string }
  /** Folded into the run's pending pass. */
  | { outcome: 'coalesced'; runId: string }
  | { outcome: 'pass_limit'; runId: string }
  | { outcome: 'run_not_appendable'; runId: string }
  | { outcome: 'spawn_failed'; runId: string }
  /** The sweep left the row alone: its launch is already in progress. */
  | { outcome: 'deferred'; runId: string }
  /** A pass already consumed this event (run_pass_events): nothing to launch. */
  | { outcome: 'already_applied'; runId: string; pass: number };

/** One keyed event as the router needs it. */
export interface KeyedEvent {
  eventId: string;
  runId: string;
  flowId: string;
  flowPath: string;
  /** Unstamped substrate JSON, as stored on the ingress_events row. */
  substrateJson: string;
  /** ingress_log source for this event's entries. */
  source: string;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

type Decision =
  | { kind: 'launch'; pass: number }
  | { kind: 'in_flight'; why: string }
  | { kind: 'parked' }
  | { kind: 'held'; detail: string }
  | { kind: 'pass_limit'; detail: string }
  | { kind: 'not_appendable'; detail: string };

/**
 * Is a pass of runId running or about to run? A slot held for its launch, a
 * resume (HITL or parked) in flight here, a live lease holder anywhere, or an
 * older ingress row for the run that a sweep will still launch.
 */
function passInFlight(deps: KeyedRunDeps, runId: string, beforeEventId: string | null): string | null {
  const { slots, db } = deps;
  if (slots.inFlight(keyedRunSlotId(runId))) return 'a pass launch for this run is in flight';
  if (slots.inFlight(`hitl-resume:${runId}`) || slots.inFlight(`parked-resume:${runId}`)) {
    return 'a resume of this run is in flight';
  }
  const holder = peekRunLeaseHolder(db, runId);
  if (holder !== null && isLeaseHolderAlive(holder, deps)) {
    return `process ${holder.holderPid} holds the run lease`;
  }
  if (db.countQueuedIngressForRun(runId, deps.redriveCap, beforeEventId) > 0) {
    return 'an earlier event for this run is still queued';
  }
  return null;
}

function decide(deps: KeyedRunDeps, keyed: KeyedRunRecord, beforeEventId: string | null): Decision {
  const { db } = deps;
  const why = passInFlight(deps, keyed.run_id, beforeEventId);
  if (why !== null) return { kind: 'in_flight', why };

  const run = db.getRun(keyed.run_id);
  // A launch that failed before seeding (issue #83) left a halted row with no
  // cards. Pass 1 never ran, so it is launched again as pass 1: a plain
  // `conduit run --run-id` retries that row in place.
  if (run === null || isFailedLaunch(db, run)) return { kind: 'launch', pass: 1 };
  if (run.status === 'halted' && run.outcome === 'parked') return { kind: 'parked' };

  const appendable = checkRunAppendable(db, keyed.run_id, Math.floor(deps.now() / 1000));
  if (!appendable.ok) {
    // A held card waits for a human, whose reply resumes the run: events keep
    // for the pass after it, rather than being refused and dropped.
    if (appendable.state === 'held') return { kind: 'held', detail: appendable.detail };
    return { kind: 'not_appendable', detail: appendable.detail };
  }

  const pass = nextPassNumber(db, keyed.run_id);
  if (keyed.max_passes !== null && pass > keyed.max_passes) {
    return { kind: 'pass_limit', detail: `the run has had its ${keyed.max_passes} pass(es) (max_passes)` };
  }
  return { kind: 'launch', pass };
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

/**
 * Fold an event into its run's pending pass. The pending slot keeps the
 * LATEST event (by received_at), whose substrate is the trailing pass's
 * top-level input. An older folded event stays 'coalesced' and rides the same
 * pass in its `events` list (coveredEvents).
 */
function coalesce(deps: KeyedRunDeps, keyed: KeyedRunRecord, event: KeyedEvent, why: string): KeyedRouteOutcome {
  const { db } = deps;
  db.markIngressCoalesced(event.eventId);
  const current = keyed.pending_event_id !== null ? db.getIngressEvent(keyed.pending_event_id) : null;
  const incoming = db.getIngressEvent(event.eventId);
  const newer =
    current === null ||
    incoming === null ||
    incoming.received_at > current.received_at ||
    (incoming.received_at === current.received_at && incoming.event_id >= current.event_id);
  if (newer) db.setKeyedRunPending(keyed.run_id, event.eventId);
  db.appendIngressLog({
    source: event.source,
    eventId: event.eventId,
    outcome: 'coalesced',
    reason: `${why}: folded into the next pass of run '${keyed.run_id}'`,
  });
  return { outcome: 'coalesced', runId: keyed.run_id };
}

/**
 * Settle an event that a pass already consumed. The kernel records the events
 * a pass covers in the transaction that seeds it, so a row here means the
 * pass exists even when the listener never saw its launch finish (a lost exit,
 * a crash between spawn and mark). Launching the event again would run it
 * twice, so the row is marked spawned and left alone.
 */
function settleApplied(
  deps: KeyedRunDeps,
  event: KeyedEvent,
  applied: { run_id: string; pass: number },
): KeyedRouteOutcome {
  deps.db.markIngressSpawned(event.eventId);
  deps.db.appendIngressLog({
    source: event.source,
    eventId: event.eventId,
    outcome: 'already_applied',
    reason: `pass ${applied.pass} of run '${applied.run_id}' already consumed this event`,
  });
  return { outcome: 'already_applied', runId: applied.run_id, pass: applied.pass };
}

/**
 * The events a pass launched from `event` covers: every event folded into the
 * run that no pass has consumed yet, up to and including `event`, oldest
 * first. The launching event is always last.
 *
 * A folded row with no substrate_json (a hand-edited or corrupt row) cannot
 * be covered: rather than silently vanishing from `covered` with only its
 * 'coalesced' log row as a trace, it is refused here, the same outcome the
 * drain path gives a malformed pending row. Refusing it (not just logging)
 * takes it out of 'coalesced', so it is never logged twice.
 */
function coveredEvents(deps: KeyedRunDeps, runId: string, event: KeyedEvent): PassEventInput[] {
  const { db } = deps;
  const folded: PassEventInput[] = [];
  for (const row of db.listUnappliedCoalesced(runId, event.eventId)) {
    if (row.event_id === event.eventId) continue;
    if (row.substrate_json === null) {
      db.appendIngressLog({
        source: event.source,
        eventId: row.event_id,
        outcome: 'rejected_malformed',
        reason: `folded event '${row.event_id}' for keyed run '${runId}' is missing substrate_json; dropped from this pass's coverage`,
      });
      db.markIngressRefused(row.event_id);
      continue;
    }
    folded.push({ eventId: row.event_id, receivedAt: row.received_at, substrateJson: row.substrate_json });
  }
  const own = db.getIngressEvent(event.eventId);
  return [
    ...folded,
    { eventId: event.eventId, receivedAt: own?.received_at ?? deps.now(), substrateJson: event.substrateJson },
  ];
}

/** Best-effort alert that never rejects on its caller. */
async function fireAlert(alerts: RedriveAlerting, notice: SpawnFailedAlert): Promise<void> {
  try {
    await alerts.alert(notice);
  } catch {
    // The ingress_log entry written by the caller is the durable record.
  }
}

/** Tell the channel about a blocked run, once per run until a pass launches. */
function alertBlockedOnce(deps: KeyedRunDeps, keyed: KeyedRunRecord, eventId: string, reason: string): void {
  if (keyed.blocked_alerted) return;
  deps.db.setKeyedRunBlockedAlerted(keyed.run_id, true);
  void fireAlert(deps.alerts, {
    flowId: keyed.flow_id,
    channel: resolveAlertChannel(deps.alerts, keyed.flow_id),
    eventId,
    reason,
  });
}

/**
 * Fold an event for a run that holds a card for a human, and tell the channel
 * once that events are waiting on it.
 */
function coalesceHeld(deps: KeyedRunDeps, keyed: KeyedRunRecord, event: KeyedEvent, detail: string): KeyedRouteOutcome {
  const outcome = coalesce(deps, keyed, event, `the run is held (${detail})`);
  alertBlockedOnce(
    deps,
    keyed,
    event.eventId,
    `held: run '${keyed.run_id}' is waiting on a human and events for it are waiting too; ` +
      `the latest becomes its next pass once the run is resumed. Later events are logged, not alerted.`,
  );
  return outcome;
}

/** Refuse an event: mark it, log it, and tell the channel once per run. */
function refuse(
  deps: KeyedRunDeps,
  keyed: KeyedRunRecord,
  event: KeyedEvent,
  outcome: 'pass_limit' | 'run_not_appendable',
  detail: string,
): KeyedRouteOutcome {
  const { db } = deps;
  db.markIngressRefused(event.eventId);
  const reason = `run '${keyed.run_id}' takes no new pass: ${detail}`;
  db.appendIngressLog({ source: event.source, eventId: event.eventId, outcome, reason });
  alertBlockedOnce(deps, keyed, event.eventId, `${outcome}: ${reason}. Later events for this run are logged, not alerted.`);
  return { outcome, runId: keyed.run_id };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

type LaunchMode = 'hot' | 'sweep' | 'drain';

/**
 * Launch one pass from `event`. The slot is acquired synchronously with the
 * decision that preceded it (no await between), so no other caller in this
 * process can launch the same run in between. A 'full' pool changes nothing:
 * the caller leaves the event where it was.
 */
async function launchPass(
  deps: KeyedRunDeps,
  keyed: KeyedRunRecord,
  event: KeyedEvent,
  pass: number,
  mode: LaunchMode,
): Promise<KeyedRouteOutcome | { outcome: 'full' }> {
  const { db, slots, alerts } = deps;
  const slotId = keyedRunSlotId(keyed.run_id);
  const acquisition = slots.tryAcquire(slotId);
  if (acquisition === 'full') return { outcome: 'full' };
  if (acquisition === 'duplicate') return coalesce(deps, keyed, event, 'a pass launch for this run is in flight');

  deps.launching.add(event.eventId);
  let slotHandedOff = false;
  try {
    const covered = coveredEvents(deps, keyed.run_id, event);
    // The pending event rides this pass when it is older than the launching
    // one, so it must not also become a pass of its own. Cleared only once
    // the spawn is known to have succeeded (below): a failed launch leaves
    // the pointer intact so the next sweep can still drain it, rather than
    // orphaning a folded event that no pass ever consumed.
    const pendingRidesThisPass =
      keyed.pending_event_id !== null && covered.some((e) => e.eventId === keyed.pending_event_id);
    db.incrementSpawnAttempts(event.eventId);

    let result: { ok: boolean; error?: string; exited?: Promise<SpawnExit> };
    try {
      result = await deps.spawn({
        flowPath: event.flowPath,
        inputInline: stampKeyedPass(event.substrateJson, keyed.run_key, pass, covered),
        runId: keyed.run_id,
        ...(pass > 1 && { appendPass: true }),
        passEvents: covered.map((e) => e.eventId),
      });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      if (pendingRidesThisPass) db.setKeyedRunPending(keyed.run_id, null);
      db.markIngressSpawned(event.eventId);
      db.setKeyedRunBlockedAlerted(keyed.run_id, false);
      db.appendIngressLog({
        source: event.source,
        eventId: event.eventId,
        outcome: mode === 'sweep' ? 'redriven' : 'accepted',
        reason: `pass ${pass} of keyed run '${keyed.run_id}', covering ${covered.length} event(s)`,
      });
      if (result.exited !== undefined) {
        slotHandedOff = true;
        void watchPassExit(deps, keyed, event, result.exited);
      }
      return { outcome: 'accepted', runId: keyed.run_id, pass };
    }

    const reason = result.error ?? 'spawn failed';
    db.markIngressFailed(event.eventId);
    void fireAlert(alerts, {
      flowId: keyed.flow_id,
      channel: resolveAlertChannel(alerts, keyed.flow_id),
      eventId: event.eventId,
      reason,
    });
    db.appendIngressLog({ source: event.source, eventId: event.eventId, outcome: 'spawn_failed', reason });
    return { outcome: 'spawn_failed', runId: keyed.run_id };
  } finally {
    deps.launching.delete(event.eventId);
    if (!slotHandedOff) slots.release(slotId);
  }
}

/**
 * Supervise a launched pass off the request path, then drain the run's
 * pending event. Never rejects: it runs detached.
 *
 *   - exit 0                      the row stays 'spawned'.
 *   - EXIT_RUN_LEASE_CONFLICT     another process drives the run: the event
 *                                 becomes pending, not failed.
 *   - EXIT_PASS_REFUSED           the kernel found the run not appendable
 *                                 after all (its state or budget changed):
 *                                 refused, alerted once.
 *   - parked                      recorded like any parked launch; the parked
 *                                 sweep resumes the run.
 *   - the pass concluded badly    every card is in done or scrap: the pass ran
 *                                 and failed, which is not a launch failure.
 *                                 The row stays 'spawned' (so the sweep does
 *                                 not re-drive it as a fresh pass), the log
 *                                 says 'pass_failed', and the channel is
 *                                 alerted; the run takes its next pass.
 *   - anything else               failed, alerted, logged 'spawn_failed',
 *                                 exactly as an unkeyed launch.
 */
async function watchPassExit(
  deps: KeyedRunDeps,
  keyed: KeyedRunRecord,
  event: KeyedEvent,
  exited: Promise<SpawnExit>,
): Promise<void> {
  const { db, alerts, slots } = deps;
  try {
    let code: number | null = null;
    let reason: string | null = null;
    try {
      code = (await exited).code;
      if (code !== 0) reason = `conduit run exited with code ${code}`;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    if (reason !== null) {
      const fresh = db.getKeyedRun(keyed.run_id) ?? keyed;
      if (code === EXIT_RUN_LEASE_CONFLICT) {
        coalesce(deps, fresh, event, 'another process holds the run lease');
      } else if (code === EXIT_PASS_REFUSED) {
        refuse(deps, fresh, event, 'run_not_appendable', 'the kernel refused the pass (see the run state)');
      } else {
        const parked = inspectParkedRun(db, keyed.run_id, Math.floor(deps.now() / 1000));
        if (parked !== null) {
          await recordPark(db, alerts.alert, {
            source: event.source,
            eventId: event.eventId,
            flowId: keyed.flow_id,
            channel: resolveAlertChannel(alerts, keyed.flow_id),
            runId: keyed.run_id,
            releaseAt: parked.releaseAt,
          });
        } else if (checkRunAppendable(db, keyed.run_id, Math.floor(deps.now() / 1000)).ok) {
          const failure = `pass of run '${keyed.run_id}' concluded unsuccessfully (${reason}); the run takes its next pass as usual`;
          db.appendIngressLog({ source: event.source, eventId: event.eventId, outcome: 'pass_failed', reason: failure });
          void fireAlert(alerts, {
            flowId: keyed.flow_id,
            channel: resolveAlertChannel(alerts, keyed.flow_id),
            eventId: event.eventId,
            reason: `pass_failed: ${failure}`,
          });
        } else {
          db.markIngressFailed(event.eventId);
          void fireAlert(alerts, {
            flowId: keyed.flow_id,
            channel: resolveAlertChannel(alerts, keyed.flow_id),
            eventId: event.eventId,
            reason,
          });
          db.appendIngressLog({ source: event.source, eventId: event.eventId, outcome: 'spawn_failed', reason });
        }
      }
    }
  } catch {
    // Persistence failure in a detached watcher: nothing left to report to.
  } finally {
    slots.release(keyedRunSlotId(keyed.run_id));
  }
  // The slot is free: launch the pass that accumulated while this one ran.
  try {
    await drainKeyedRun(deps, keyed.run_id);
  } catch {
    // Same discipline as above; the periodic sweep drains again.
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Route one accepted keyed event (hot path) or one re-drivable keyed row
 * (sweep). The row must be 'accepted' or 'failed'; the keyed-run row must
 * exist (the accept path creates it in the same transaction as the accept).
 */
export async function routeKeyedEvent(
  deps: KeyedRunDeps,
  event: KeyedEvent,
  mode: 'hot' | 'sweep',
): Promise<KeyedRouteOutcome> {
  const { db } = deps;
  if (deps.launching.has(event.eventId)) return { outcome: 'deferred', runId: event.runId };

  const applied = db.getPassForEvent(event.eventId);
  if (applied !== null) return settleApplied(deps, event, applied);

  const keyed = db.getKeyedRun(event.runId);
  if (keyed === null) {
    // Unreachable through the accept path; a hand-edited or corrupt DB. The
    // run key is unknown, so no pass can be stamped: refuse loudly.
    db.markIngressRefused(event.eventId);
    db.appendIngressLog({
      source: event.source,
      eventId: event.eventId,
      outcome: 'run_not_appendable',
      reason: `no keyed-run state for run '${event.runId}'`,
    });
    return { outcome: 'run_not_appendable', runId: event.runId };
  }

  const decision = decide(deps, keyed, event.eventId);
  switch (decision.kind) {
    case 'in_flight':
      return coalesce(deps, keyed, event, decision.why);
    case 'parked':
      return coalesce(deps, keyed, event, 'the run is parked and resumes on its own');
    case 'held':
      return coalesceHeld(deps, keyed, event, decision.detail);
    case 'pass_limit':
      return refuse(deps, keyed, event, 'pass_limit', decision.detail);
    case 'not_appendable':
      return refuse(deps, keyed, event, 'run_not_appendable', decision.detail);
    case 'launch': {
      const launched = await launchPass(deps, keyed, event, decision.pass, mode);
      if (launched.outcome !== 'full') return launched;
      if (mode === 'hot') {
        db.appendIngressLog({
          source: event.source,
          eventId: event.eventId,
          outcome: 'queued',
          reason: 'all run slots busy: will spawn when a slot frees',
        });
      }
      return { outcome: 'queued', runId: keyed.run_id };
    }
  }
}

/** ingress_log source for drained passes. */
const DRAIN_SOURCE = 'keyed-pending';

/**
 * Launch runId's pending event as its next pass, if the run can take one now.
 * A run still in flight or parked keeps its pending event for later; a run
 * that cannot take a pass refuses it. Returns what it did, or null when there
 * was nothing to do.
 */
export async function drainKeyedRun(deps: KeyedRunDeps, runId: string): Promise<KeyedRouteOutcome | null> {
  const { db } = deps;
  const keyed = db.getKeyedRun(runId);
  if (keyed === null || keyed.pending_event_id === null) return null;

  const pendingEventId = keyed.pending_event_id;
  const row: IngressEventRecord | null = db.getIngressEvent(pendingEventId);
  if (row === null || row.substrate_json === null || row.flow_path === null) {
    const missing =
      row === null
        ? 'its ingress_events row'
        : [row.substrate_json === null ? 'substrate_json' : null, row.flow_path === null ? 'flow_path' : null]
            .filter((field): field is string => field !== null)
            .join(' and ');
    db.appendIngressLog({
      source: DRAIN_SOURCE,
      eventId: pendingEventId,
      outcome: 'rejected_malformed',
      reason: `pending event '${pendingEventId}' for keyed run '${runId}' is missing ${missing}; dropped rather than launched as a pass`,
    });
    // A row that exists but is malformed stays 'coalesced' otherwise, so
    // listUnappliedCoalesced would hand it back to coveredEvents on the next
    // pass launch for this run (a second rejected_malformed log for a null
    // substrate_json, or a silent fold-in for a null flow_path).
    if (row !== null) db.markIngressRefused(pendingEventId);
    db.setKeyedRunPending(runId, null);
    return null;
  }
  const event: KeyedEvent = {
    eventId: row.event_id,
    runId,
    flowId: keyed.flow_id,
    flowPath: row.flow_path,
    substrateJson: row.substrate_json,
    source: DRAIN_SOURCE,
  };
  // Defensive: if a pass already consumed the pending event, launching it
  // again would run it twice, so the pending slot is simply empty.
  const applied = db.getPassForEvent(row.event_id);
  if (applied !== null) {
    // settleApplied writes the durable log row before the pending pointer is
    // cleared, for the same reason as the malformed branch above: a throw
    // from appendIngressLog must not leave the event dropped with no record.
    const outcome = settleApplied(deps, event, applied);
    db.setKeyedRunPending(runId, null);
    return outcome;
  }

  const decision = decide(deps, keyed, null);
  switch (decision.kind) {
    case 'in_flight':
    case 'parked':
    case 'held':
      return null;
    case 'pass_limit': {
      // refuse() writes the durable mark and log before the pending pointer
      // is cleared, so a throw from it leaves the pointer intact rather than
      // dropping the event with no pending pointer, no refused mark and no log.
      const outcome = refuse(deps, keyed, event, 'pass_limit', decision.detail);
      db.setKeyedRunPending(runId, null);
      return outcome;
    }
    case 'not_appendable': {
      const outcome = refuse(deps, keyed, event, 'run_not_appendable', decision.detail);
      db.setKeyedRunPending(runId, null);
      return outcome;
    }
    case 'launch': {
      const launched = await launchPass(deps, keyed, event, decision.pass, 'drain');
      return launched.outcome === 'full' ? null : launched;
    }
  }
}

/** Drain every keyed run with a pending event. Never rejects. */
export async function drainKeyedRuns(deps: KeyedRunDeps): Promise<void> {
  for (const keyed of deps.db.listKeyedRunsWithPending()) {
    try {
      await drainKeyedRun(deps, keyed.run_id);
    } catch {
      // One run's persistence error must not strand the rest; the next sweep retries.
    }
  }
}
