/**
 * The run context for the War Room projection: what the flow file says about
 * station order, budgets and caps (issue #89).
 *
 * None of this is in the journal. `runs.flow` records the flow path, so the
 * file is read as it is now, which may differ from the version the run started
 * with (schema gap `flow-at-run`). A flow that cannot be read gives an empty
 * context and every budget renders "not recorded".
 */

import type { FlowConfig } from '../types/kernel';
import { loadFlow } from '../flow/load';
import type { WatchContext } from './projection';

export function emptyContext(): WatchContext {
  return {
    stations: [],
    stationKinds: {},
    wallClockSec: null,
    maxTokens: null,
    livenessSec: null,
    reworkCaps: {},
    maxAttempts: null,
    flowLoaded: false,
  };
}

/** Build the context from a loaded flow. Station order is the YAML order. */
export function contextFromFlow(flow: FlowConfig): WatchContext {
  const stations = Object.keys(flow.stations);
  const stationKinds: Record<string, string> = {};
  const reworkCaps: Record<string, number> = {};
  for (const id of stations) {
    const station = flow.stations[id]!;
    stationKinds[id] = station.kind;
    if (station.gateCheck !== undefined) reworkCaps[id] = station.gateCheck.reworkCap;
  }
  const minutes = (m: number | undefined): number | null => (typeof m === 'number' && m > 0 ? m * 60 : null);
  const budgets = flow.budgets ?? {};
  return {
    stations,
    stationKinds,
    wallClockSec: minutes(budgets.run?.wall_clock_minutes),
    maxTokens: typeof budgets.run?.max_tokens === 'number' ? budgets.run.max_tokens : null,
    livenessSec: minutes(budgets.liveness?.no_progress_minutes),
    reworkCaps,
    maxAttempts: budgets.per_card?.max_execution_attempts ?? null,
    flowLoaded: true,
  };
}

/** Read the flow at `flowPath`; an unreadable or invalid flow gives the empty context. */
export function loadWatchContext(flowPath: string | null): WatchContext {
  if (flowPath === null || flowPath === '') return emptyContext();
  try {
    const result = loadFlow(flowPath);
    return result.ok ? contextFromFlow(result.flow) : emptyContext();
  } catch {
    return emptyContext();
  }
}
