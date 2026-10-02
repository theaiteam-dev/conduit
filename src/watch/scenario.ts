/**
 * A small fixed run for the War Room's projection and component tests: a
 * fan-out parent with four children, one working with a rework bounce, one
 * held, one scrapped, one done. Tests only.
 */

import { emptyContext } from './context';
import type { CardSnapshot, StateSnapshot, WatchEvent } from './events';
import type { WatchContext } from './projection';

export const SCENARIO_NOW = 1_002_820;
export const SCENARIO_RUN = 'run-demo';

export const scenarioContext: WatchContext = {
  ...emptyContext(),
  stations: ['decompose', 'implement', 'review', 'deliver'],
  stationKinds: { decompose: 'transform', implement: 'harness', review: 'transform', deliver: 'deterministic' },
  wallClockSec: 8640,
  maxTokens: 2_000_000,
  livenessSec: 600,
  reworkCaps: { review: 3 },
  maxAttempts: 4,
  flowLoaded: true,
};

const snap = (id: string, over: Partial<CardSnapshot>): CardSnapshot => ({
  id,
  parentId: null,
  lane: 'implement',
  status: 'ready',
  attempt: 1,
  wave: 0,
  reworkCount: 0,
  ownedPaths: [],
  releaseAt: null,
  workerStartedAt: null,
  ...over,
});

export const scenarioSnapshot: StateSnapshot = {
  run: { runId: SCENARIO_RUN, flow: '/flows/demo.yaml', status: 'running', outcome: null, createdAt: 1_000_000 },
  cards: [
    snap('PRD-014', { lane: 'decompose', status: 'awaiting_children' }),
    snap('WI-201', { parentId: 'PRD-014', lane: 'done', status: 'complete' }),
    snap('WI-204', { parentId: 'PRD-014', lane: 'implement', status: 'working', attempt: 3, workerStartedAt: 1_001_920 }),
    snap('WI-207', { parentId: 'PRD-014', lane: 'scrap', status: 'scrapped' }),
    snap('WI-209', { parentId: 'PRD-014', lane: 'hold', status: 'held' }),
  ],
};

let ids = { card_log: 0, journal: 0, harness: 0 };
const lane = (cardId: string, station: string, dest: string, reasonClass = 'forward'): WatchEvent => ({
  source: 'card_log', id: ++ids.card_log, cardId, station, attempt: 1, kind: 'entered_lane',
  sourceLane: station, destLane: dest, reasonClass,
});
const span = (cardId: string, station: string, name: string, at: number, tokens: number, cost: number, attributes = {}): WatchEvent => ({
  source: 'journal', id: ++ids.journal, cardId, station, attempt: 1, name, createdAt: at, tokens, costUsd: cost,
  usageUnknown: false, durationMs: 1000, attributes,
});

function build(): WatchEvent[] {
  ids = { card_log: 0, journal: 0, harness: 0 };
  return [
    lane('PRD-014', 'intake', 'decompose'),
    span('PRD-014', 'decompose', 'decompose.transform', 1_000_100, 12_000, 0.4),
    lane('WI-201', 'intake', 'implement'),
    lane('WI-201', 'implement', 'review'),
    lane('WI-201', 'review', 'deliver'),
    lane('WI-201', 'deliver', 'done'),
    span('WI-201', 'implement', 'implement.harness', 1_000_900, 210_000, 2.1),
    lane('WI-204', 'intake', 'implement'),
    lane('WI-204', 'implement', 'review'),
    { source: 'card_log', id: ++ids.card_log, cardId: 'WI-204', station: 'review', attempt: 1, kind: 'gate_verdict',
      verdict: 'reject', findings: ['range end is exclusive'], returnTo: 'implement' },
    lane('WI-204', 'review', 'implement', 'rework'),
    lane('WI-204', 'implement', 'review'),
    lane('WI-204', 'review', 'implement', 'rework'),
    span('WI-204', 'implement', 'implement.harness', 1_002_700, 639_800, 6.2),
    { source: 'harness', id: ++ids.harness, cardId: 'WI-204', station: 'implement', attempt: 3, kind: 'tool-input-available',
      invocationId: 'inv-1', atMs: 1_002_810_000, toolName: 'Bash', path: null, exitCode: null, isError: null, phase: null,
      rateLimitWindows: null },
    { source: 'harness', id: ++ids.harness, cardId: 'WI-204', station: 'implement', attempt: 3, kind: 'rate-limit',
      invocationId: 'inv-1', atMs: 1_002_800_000, toolName: null, path: null, exitCode: null, isError: null, phase: null,
      rateLimitWindows: [{ name: 'five_hour', utilization: 0.86, resetsAtMs: null }] },
    lane('WI-207', 'intake', 'implement'),
    lane('WI-207', 'implement', 'review'),
    lane('WI-207', 'review', 'scrap', 'scrap'),
    { source: 'card_log', id: ++ids.card_log, cardId: 'WI-207', station: 'review', attempt: 1, kind: 'terminal', reason: 'no_progress' },
    lane('WI-209', 'intake', 'implement'),
    lane('WI-209', 'implement', 'hold', 'hold'),
    span('WI-209', 'implement', 'hitl.held_at', 1_001_000, 0, 0, { held_at: 1_001_000 }),
  ];
}

export const scenarioEvents: readonly WatchEvent[] = build();
