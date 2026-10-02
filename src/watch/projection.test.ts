import { describe, expect, test } from 'bun:test';
import { emptyContext } from './context';
import { deriveView, emptyFold, foldEvents, formatDuration, replay, type DeriveInput } from './projection';
import { SCENARIO_NOW, SCENARIO_RUN, scenarioContext, scenarioEvents, scenarioSnapshot } from './scenario';
import { formatGapReport, JOURNAL_SCHEMA_GAPS } from './schema-gaps';

const live: DeriveInput = {
  runId: SCENARIO_RUN,
  mode: 'live',
  context: scenarioContext,
  snapshot: scenarioSnapshot,
  nowSec: SCENARIO_NOW,
};
const fold = foldEvents(emptyFold(), scenarioEvents);

describe('deriveView, live', () => {
  const view = deriveView(fold, live);
  const row = (id: string) => view.rows.find((r) => r.id === id)!;

  test('state comes from the state DB', () => {
    expect(view.rows.map((r) => [r.id, r.state])).toEqual([
      ['PRD-014', 'awaiting'],
      ['WI-201', 'done'],
      ['WI-204', 'working'],
      ['WI-207', 'scrap'],
      ['WI-209', 'held'],
    ]);
    expect(view.tallies).toEqual({ working: 1, waiting: 0, held: 1, done: 1, scrap: 1 });
  });

  test('rework is counted per gate and read against that gate\'s cap', () => {
    expect(row('WI-204')).toMatchObject({ reworks: 2, reworkCap: 3, attempt: 3, maxAttempts: 4 });
    expect(row('WI-204').visits.map((v) => v.rework)).toEqual([false, false, true, false, true]);
  });

  test('a ready card behind a future release_at reads parked', () => {
    const snapshot = {
      ...scenarioSnapshot,
      cards: [{ ...scenarioSnapshot.cards[2]!, status: 'ready', releaseAt: SCENARIO_NOW + 60 }],
    };
    expect(deriveView(fold, { ...live, snapshot }).rows.find((r) => r.id === 'WI-204')!.state).toBe('parked');
  });

  test('a stopped run reports elapsed as a lower bound and logs the gap', () => {
    const snapshot = { ...scenarioSnapshot, run: { ...scenarioSnapshot.run!, status: 'halted' } };
    const v = deriveView(fold, { ...live, snapshot });
    expect(v.elapsedIsLowerBound).toBe(true);
    expect(v.elapsedSec).toBe(2810);
    expect(v.gaps).toContain('run-end-time');
  });

  test('no budget in the flow renders the spend without a fraction', () => {
    const v = deriveView(fold, { ...live, context: { ...scenarioContext, maxTokens: null } });
    expect(v.tokens).toEqual({ fraction: null, text: '861.8k no budget' });
  });
});

describe('deriveView, replay', () => {
  test('state is lane-derived and the clock is the newest folded timestamp', () => {
    const view = replay(scenarioEvents, scenarioEvents.length, { ...live });
    expect(view.mode).toBe('replay');
    expect(view.rows.find((r) => r.id === 'WI-204')!.state).toBe('lane');
    expect(view.rows.find((r) => r.id === 'WI-201')!.state).toBe('done');
    // Newest timestamp folded is the tool call at 1_002_810 s.
    expect(view.elapsedSec).toBe(2810);
    expect(view.gaps).toEqual(expect.arrayContaining(['cross-table-order', 'status-history']));
  });

  test('position 0 is an empty run, and positions beyond the end clamp', () => {
    expect(replay(scenarioEvents, 0, live).eventCount).toBe(0);
    expect(replay(scenarioEvents, 10_000, live)).toEqual(replay(scenarioEvents, scenarioEvents.length, live));
  });

  test('a run with no flow and no state DB still renders', () => {
    const view = replay(scenarioEvents, scenarioEvents.length, { runId: 'r', context: emptyContext(), snapshot: null, nowSec: 0 });
    expect(view.stations).toEqual(['decompose', 'implement', 'review', 'deliver']);
    expect(view.wall.text).toBe('not recorded');
    expect(view.gaps).toContain('flow-at-run');
  });
});

describe('schema gaps', () => {
  test('every gap a view can name is catalogued', () => {
    const ids = new Set(JOURNAL_SCHEMA_GAPS.map((g) => g.id));
    for (const gap of deriveView(fold, live).gaps) expect(ids.has(gap)).toBe(true);
  });

  test('the exit report lists the gaps hit, once each', () => {
    const lines = formatGapReport('run-x', ['plan-quota', 'kernel-heartbeat', 'plan-quota']);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('run-x');
    expect(formatGapReport('run-x', [])).toEqual([]);
  });
});

test('formatDuration', () => {
  expect(formatDuration(0)).toBe('00:00');
  expect(formatDuration(2820)).toBe('47:00');
  expect(formatDuration(6740)).toBe('1:52:20');
});
