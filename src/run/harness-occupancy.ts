/**
 * Issue #30: how much of a finished run's wall clock each harness station
 * occupied, read from the run's own journal.
 *
 * A `kind: harness` station runs on the serial in-process dispatch path under
 * any `--concurrency K` unless it declares `overlap: true` (ADR-0012): the
 * tick loop awaits the call and dispatches nothing else until it returns. An
 * overlapped call runs in a batch of up to `min(K - in-flight, wip)` calls,
 * where in-flight counts the workers already running when the batch is
 * admitted, and the loop waits for the whole batch. Each harness span records how many other
 * cards were dispatchable when the call started and were not running with it
 * (`ready_waiting`, see `countReadyWaiting` and `countReadyNotAdmitted` in
 * controller/executor.ts). A span of an overlapped call also records
 * `concurrent: true` and the call's start (`started_at_ms`).
 *
 * The figures, per station:
 *   busy          = the union of its `.harness` and `.harness-critic` call
 *                   intervals: overlapped calls are merged, and every other
 *                   span adds its duration (a serial call overlaps nothing)
 *   share         = busy / run wall clock
 *   waited        = card-seconds other ready cards waited: duration *
 *                   ready_waiting for a serial span; for overlapped spans, at
 *                   each moment the largest ready_waiting among the calls
 *                   running then, so one waiting card is not counted once per
 *                   member of the batch
 * The total busy figure is the union across stations.
 *
 * Run wall clock is `runs.created_at` to the newest journal row's
 * `created_at`. Both are whole epoch seconds, and for a resumed run the span
 * includes the time the run was stopped between processes.
 */
import type { ConduitDB } from '../persistence/db';

export interface HarnessStationOccupancy {
  station: string;
  makerCalls: number;
  criticCalls: number;
  /** Calls whose span records `concurrent: true` (issue #30, ADR-0012). */
  overlappedCalls: number;
  /** Union of call intervals over maker and critic spans. */
  busyMs: number;
  /** Card-ms other ready cards waited; see the module comment. */
  waitedCardMs: number;
  /** Spans with no duration or no ready_waiting sample (older journals). */
  unsampledCalls: number;
}

export interface HarnessOccupancy {
  /** runs.created_at to the newest journal row, in ms; null when unknown. */
  wallClockMs: number | null;
  stations: HarnessStationOccupancy[];
  /** Union of every station's call intervals. */
  totalBusyMs: number;
}

/** A call with a known start: [start, end) in epoch ms, and its ready_waiting sample. */
interface Interval {
  start: number;
  end: number;
  readyWaiting: number | null;
}

/** Total length of the union of `intervals`. */
function unionMs(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const { start, end } of sorted) {
    if (Number.isNaN(curEnd) || start > curEnd) {
      if (!Number.isNaN(curEnd)) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (!Number.isNaN(curEnd)) total += curEnd - curStart;
  return total;
}

/**
 * Card-ms waited over `intervals`: at each moment, the largest ready_waiting
 * among the sampled intervals running then, integrated over time.
 *
 * A sweep over the interval boundaries, O(n log n). An interval is [start,
 * end), so at a shared timestamp the ends are applied before the starts. The
 * active samples are kept as a value -> count multiset with the current
 * maximum cached; the maximum is recomputed only when its last holder ends,
 * and the number of distinct values is small.
 */
function waitedOverlappedMs(intervals: readonly Interval[]): number {
  const events: { at: number; delta: 1 | -1; value: number }[] = [];
  for (const i of intervals) {
    // A zero-length interval covers no time. Its end would sort before its
    // start and leave it active for the rest of the sweep.
    if (i.readyWaiting === null || i.end <= i.start) continue;
    events.push({ at: i.start, delta: 1, value: i.readyWaiting });
    events.push({ at: i.end, delta: -1, value: i.readyWaiting });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const active = new Map<number, number>();
  let most = 0;
  let total = 0;
  for (let k = 0; k < events.length; k++) {
    const { at, delta, value } = events[k]!;
    const count = (active.get(value) ?? 0) + delta;
    if (count > 0) active.set(value, count);
    else active.delete(value);
    if (delta === 1) {
      if (value > most) most = value;
    } else if (count === 0 && value === most) {
      most = 0;
      for (const v of active.keys()) if (v > most) most = v;
    }
    const next = events[k + 1];
    if (next !== undefined) total += (next.at - at) * most;
  }
  return total;
}

/** Aggregate a run's harness spans per station. Null when the run has none. */
export function getHarnessOccupancy(db: ConduitDB, runId: string): HarnessOccupancy | null {
  const { spans, lastSpanAt } = db.getHarnessTimingsForRun(runId);
  if (spans.length === 0) return null;

  const byStation = new Map<string, HarnessStationOccupancy>();
  const intervalsByStation = new Map<string, Interval[]>();
  let serialTotalMs = 0;
  for (const span of spans) {
    let entry = byStation.get(span.station);
    if (entry === undefined) {
      entry = {
        station: span.station, makerCalls: 0, criticCalls: 0, overlappedCalls: 0,
        busyMs: 0, waitedCardMs: 0, unsampledCalls: 0,
      };
      byStation.set(span.station, entry);
      intervalsByStation.set(span.station, []);
    }
    if (span.role === 'maker') entry.makerCalls++;
    else entry.criticCalls++;
    if (span.concurrent) entry.overlappedCalls++;
    if (span.durationMs === null || span.readyWaiting === null) entry.unsampledCalls++;
    if (span.durationMs === null) continue;
    if (span.startedAtMs !== null) {
      intervalsByStation.get(span.station)!.push({
        start: span.startedAtMs,
        end: span.startedAtMs + span.durationMs,
        readyWaiting: span.readyWaiting,
      });
    } else {
      // A span without a recorded start is a serial call (or one from a
      // journal older than ADR-0012), which overlapped no other harness call.
      entry.busyMs += span.durationMs;
      serialTotalMs += span.durationMs;
      if (span.readyWaiting !== null) entry.waitedCardMs += span.durationMs * span.readyWaiting;
    }
  }

  const allIntervals: Interval[] = [];
  for (const [station, intervals] of intervalsByStation) {
    const entry = byStation.get(station)!;
    entry.busyMs += unionMs(intervals);
    entry.waitedCardMs += waitedOverlappedMs(intervals);
    allIntervals.push(...intervals);
  }

  const run = db.getRun(runId);
  const wallClockMs =
    run !== null && lastSpanAt !== null ? Math.max(0, lastSpanAt - run.created_at) * 1000 : null;

  const stations = [...byStation.values()].sort((a, b) => a.station.localeCompare(b.station));
  return { wallClockMs, stations, totalBusyMs: serialTotalMs + unionMs(allIntervals) };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function share(busyMs: number, wallClockMs: number | null): string {
  if (wallClockMs === null || wallClockMs === 0) return 'n/a';
  return `${((busyMs / wallClockMs) * 100).toFixed(1)}%`;
}

/** Render the occupancy report as lines for `conduit run status`. */
export function formatHarnessOccupancy(report: HarnessOccupancy): string[] {
  const wall = report.wallClockMs === null ? 'unknown' : seconds(report.wallClockMs);
  const lines = [`harness occupancy (run wall clock ${wall}):`];
  for (const s of report.stations) {
    const overlapped = s.overlappedCalls > 0 ? `, ${s.overlappedCalls} overlapped` : '';
    const unsampled = s.unsampledCalls > 0 ? `, ${s.unsampledCalls} call(s) not sampled` : '';
    lines.push(
      `  ${s.station}: ${s.makerCalls} maker + ${s.criticCalls} critic call(s)${overlapped}, ` +
        `busy ${seconds(s.busyMs)} (${share(s.busyMs, report.wallClockMs)} of wall clock), ` +
        `other ready cards waited ${(s.waitedCardMs / 1000).toFixed(1)} card-s${unsampled}`,
    );
  }
  lines.push(`  total: busy ${seconds(report.totalBusyMs)} (${share(report.totalBusyMs, report.wallClockMs)} of wall clock)`);
  return lines;
}
