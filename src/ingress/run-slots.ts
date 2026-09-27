/**
 * Run-slot gate — listener-level run backpressure (the original listener-backpressure work).
 *
 * One gate per listener process bounds how many `conduit run` children are in
 * flight at once, across ALL flows and BOTH launch paths (the hot accept-spawn
 * path and the re-drive sweep). N simultaneous ingress events against a serial
 * model endpoint previously spawned N concurrent runs — every transform queued
 * behind every other, hit its station timeout, and ground the burst into
 * redrive-cap exhaustion. With the gate, events beyond the cap stay in
 * ingress_events as 'accepted' (crash-safe — the re-drive sweep already knows
 * how to relaunch them) and spawn as slots free.
 *
 * A slot is held from LAUNCH until the child process EXITS (the original acknowledgement-on-accept work) — not
 * until the webhook responds, which now happens as soon as the child is live.
 * Capacity therefore still counts concurrent runs.
 *
 * The gate also tracks WHICH event ids are in flight, independent of capacity,
 * so a live run is never re-driven underneath itself: a row whose launch is in
 * flight (a re-driven 'failed' row, or a queued row the sweep is launching)
 * would otherwise burn spawn_attempts on run-lease conflicts. Sweeps skip
 * in-flight ids, and a hot-path re-accept of an in-flight 'failed' row is
 * suppressed as a duplicate instead of double-spawning.
 *
 * Deliberately NOT persisted: in-flight state is a property of this process's
 * live children. On crash the children die with the listener; rows still
 * 'accepted'/'failed' are what boot re-drive recovers from (a row already
 * marked 'spawned' belongs to the run's own resume machinery — see spawn.ts).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SlotAcquisition =
  /** A slot was taken and the event id registered — caller must release(). */
  | 'acquired'
  /** This event id is ALREADY in flight — suppress the launch, do not release. */
  | 'duplicate'
  /** Capacity is exhausted — leave the row 'accepted' for the re-drive sweep. */
  | 'full';

export interface RunSlots {
  /** Configured capacity — Infinity when no max_concurrent_runs is set. */
  readonly capacity: number;
  /**
   * Atomically (synchronously — no await between check and take) claim a slot
   * for eventId. Exactly one 'acquired' per id until the matching release().
   */
  tryAcquire(eventId: string): SlotAcquisition;
  /**
   * Free eventId's slot. Idempotent — releasing an id that is not in flight is
   * a no-op (never releases someone else's slot). Fires onRelease AFTER the
   * slot is freed so the kicked sweep observes the freed capacity.
   */
  release(eventId: string): void;
  /** Is a launch for eventId currently in flight in this process? */
  inFlight(eventId: string): boolean;
  /** Number of runs currently in flight. */
  inFlightCount(): number;
}

/** Slot registration for a keyed run's pass launches (issue #36). */
export function keyedRunSlotId(runId: string): string {
  return `keyed-run:${runId}`;
}

export interface RunSlotsOptions {
  /**
   * Maximum concurrent runs. Omitted/undefined → Infinity (no capacity limit;
   * the gate still dedups in-flight ids). Must be a positive integer otherwise.
   */
  capacity?: number;
  /**
   * Fired after every release — the listener wires this to the re-drive
   * sweep's kick() so queued events launch as soon as a slot frees instead of
   * waiting out the periodic interval.
   */
  onRelease?: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createRunSlots(options: RunSlotsOptions = {}): RunSlots {
  const capacity = options.capacity ?? Infinity;
  if (capacity !== Infinity && (!Number.isInteger(capacity) || capacity < 1)) {
    throw new Error(`run-slot capacity must be a positive integer, got ${capacity}`);
  }
  const onRelease = options.onRelease ?? (() => {});
  const inFlightIds = new Set<string>();

  return {
    capacity,
    tryAcquire(eventId: string): SlotAcquisition {
      if (inFlightIds.has(eventId)) return 'duplicate';
      if (inFlightIds.size >= capacity) return 'full';
      inFlightIds.add(eventId);
      return 'acquired';
    },
    release(eventId: string): void {
      if (!inFlightIds.delete(eventId)) return;
      onRelease();
    },
    inFlight(eventId: string): boolean {
      return inFlightIds.has(eventId);
    },
    inFlightCount(): number {
      return inFlightIds.size;
    },
  };
}
