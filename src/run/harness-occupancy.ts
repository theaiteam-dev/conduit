/**
 * Issue #30: how much of a finished run's wall clock each harness station
 * occupied, read from the run's own journal.
 *
 * A `kind: harness` station runs on the serial in-process dispatch path under
 * any `--concurrency K`: the tick loop awaits the call and dispatches nothing
 * else until it returns. So a harness call's duration is time in which no
 * other card could start, and each harness span records how many other cards
 * were dispatchable when the call started (`ready_waiting`, see
 * `countReadyWaiting` in controller/executor.ts).
 *
 * The figures, per station:
 *   busy          = SUM(duration_ms) over its `.harness` and `.harness-critic` spans
 *   share         = busy / run wall clock
 *   waited        = SUM(duration_ms * ready_waiting), in card-seconds
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
  /** Sum of recorded durations over maker and critic spans. */
  busyMs: number;
  /** Sum of duration * ready_waiting over spans that recorded both. */
  waitedCardMs: number;
  /** Spans with no duration or no ready_waiting sample (older journals). */
  unsampledCalls: number;
}

export interface HarnessOccupancy {
  /** runs.created_at to the newest journal row, in ms; null when unknown. */
  wallClockMs: number | null;
  stations: HarnessStationOccupancy[];
}

/** Aggregate a run's harness spans per station. Null when the run has none. */
export function getHarnessOccupancy(db: ConduitDB, runId: string): HarnessOccupancy | null {
  const { spans, lastSpanAt } = db.getHarnessTimingsForRun(runId);
  if (spans.length === 0) return null;

  const byStation = new Map<string, HarnessStationOccupancy>();
  for (const span of spans) {
    let entry = byStation.get(span.station);
    if (entry === undefined) {
      entry = { station: span.station, makerCalls: 0, criticCalls: 0, busyMs: 0, waitedCardMs: 0, unsampledCalls: 0 };
      byStation.set(span.station, entry);
    }
    if (span.role === 'maker') entry.makerCalls++;
    else entry.criticCalls++;
    if (span.durationMs !== null) entry.busyMs += span.durationMs;
    if (span.durationMs !== null && span.readyWaiting !== null) {
      entry.waitedCardMs += span.durationMs * span.readyWaiting;
    } else {
      entry.unsampledCalls++;
    }
  }

  const run = db.getRun(runId);
  const wallClockMs =
    run !== null && lastSpanAt !== null ? Math.max(0, lastSpanAt - run.created_at) * 1000 : null;

  const stations = [...byStation.values()].sort((a, b) => a.station.localeCompare(b.station));
  return { wallClockMs, stations };
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
  const lines = [`harness occupancy (serial under any --concurrency; run wall clock ${wall}):`];
  let totalBusy = 0;
  for (const s of report.stations) {
    totalBusy += s.busyMs;
    const unsampled = s.unsampledCalls > 0 ? `, ${s.unsampledCalls} call(s) not sampled` : '';
    lines.push(
      `  ${s.station}: ${s.makerCalls} maker + ${s.criticCalls} critic call(s), ` +
        `busy ${seconds(s.busyMs)} (${share(s.busyMs, report.wallClockMs)} of wall clock), ` +
        `other ready cards waited ${(s.waitedCardMs / 1000).toFixed(1)} card-s${unsampled}`,
    );
  }
  lines.push(`  total: busy ${seconds(totalBusy)} (${share(totalBusy, report.wallClockMs)} of wall clock)`);
  return lines;
}
