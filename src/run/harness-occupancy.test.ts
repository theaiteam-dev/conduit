/**
 * Issue #30: a finished run reports, from its own journal, how much wall clock
 * each harness station held the serial dispatch path and how many card-seconds
 * other ready cards spent waiting behind it.
 *
 * Three layers:
 *   1. the executor writes `ready_waiting` on every harness span (real
 *      runExecutor, three cards queued at one harness station);
 *   2. getHarnessOccupancy aggregates a journal fixture into the figures;
 *   3. `conduit run status` prints them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from '../controller/executor';
import { main, type CliDeps, type RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import { createHarnessRegistry, type HarnessAdapter } from '../worker/harness-adapter';
import { getHarnessOccupancy, formatHarnessOccupancy } from './harness-occupancy';

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

let db: ConduitDB;
let dir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-occupancy-'));
  process.chdir(dir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function insertRun(runId: string): void {
  db.insertRun({ run_id: runId, flow: 'f.yaml', input_fingerprint: 'x', status: 'complete', outcome: 'complete' });
}

/** Pin runs.created_at so the run wall clock is exactly `seconds`. */
function setWallClock(runId: string, seconds: number): void {
  const { lastSpanAt } = db.getHarnessTimingsForRun(runId);
  db.getStateDb()
    .prepare('UPDATE runs SET created_at = $t WHERE run_id = $r')
    .run({ $t: (lastSpanAt ?? 0) - seconds, $r: runId });
}

function span(
  runId: string,
  station: string,
  role: 'maker' | 'critic',
  durationMs: number,
  readyWaiting?: number,
): void {
  db.appendJournalSpan({
    runId,
    cardId: 'c1',
    station,
    attempt: 0,
    name: role === 'maker' ? `${station}.harness` : `${station}.harness-critic`,
    adapter: 'fake-harness',
    durationMs,
    usageUnknown: true,
    attributes: readyWaiting === undefined ? { outcome: 'success' } : { outcome: 'success', ready_waiting: readyWaiting },
  });
}

describe('issue #30: the executor records ready_waiting on harness spans', () => {
  it('samples the other dispatchable cards when each serial harness call starts', async () => {
    const harness: HarnessAdapter = {
      name: 'fake-harness',
      reportsUsage: true,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke() {
        writeFileSync(join(process.cwd(), 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
        return { outputs: [], usage: { tokens: 10, cost: 0 } };
      },
    };
    const registry = createHarnessRegistry([harness]);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
    writeFileSync(join(dir, 'task.json'), '{"task":"x"}');
    writeFileSync(
      join(dir, 'flow.yaml'),
      `
flow: harness-occupancy
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: fake-harness
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done
`,
    );
    const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
    if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);

    for (const id of ['a', 'b', 'c']) {
      db.insertCard({
        run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'coder', status: 'ready',
        attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
      });
    }

    await runExecutor({
      db,
      flow: loaded.flow,
      now: () => 1000,
      adapter: throwingModel,
      io: { out: () => {}, err: () => {} },
      harnessRegistry: registry,
    } as RunEngineArgs);

    for (const id of ['a', 'b', 'c']) expect(db.getCard(DEFAULT_RUN_ID, id)?.lane).toBe('done');

    // Three cards at one harness station run one at a time: the first call
    // starts with two others ready, the second with one, the last with none.
    const { spans } = db.getHarnessTimingsForRun(DEFAULT_RUN_ID);
    expect(spans.map((s) => s.role)).toEqual(['maker', 'maker', 'maker']);
    expect(spans.map((s) => s.readyWaiting)).toEqual([2, 1, 0]);
    for (const s of spans) expect(typeof s.durationMs).toBe('number');
  });
});

describe('issue #30: ready_waiting is sampled when each harness call starts', () => {
  it('counts a card whose release_at passes during a maker retry backoff', async () => {
    // Card 'a' fails its first attempt and retries; the backoff sleep between
    // attempts advances the injected clock past card 'b's release_at. The
    // second attempt's ready_waiting must see 'b' as dispatchable even though
    // the tick's currentNow (sampled once, before either attempt) does not.
    let calls = 0;
    let clock = 1000;
    const harness: HarnessAdapter = {
      name: 'fake-harness',
      reportsUsage: true,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke() {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error('boom'), { code: 'harness-nonzero-exit' });
        }
        writeFileSync(join(process.cwd(), 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
        return { outputs: [], usage: { tokens: 10, cost: 0 } };
      },
    };
    const registry = createHarnessRegistry([harness]);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
    writeFileSync(join(dir, 'task.json'), '{"task":"x"}');
    writeFileSync(
      join(dir, 'flow.yaml'),
      `
flow: harness-occupancy-boundary
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: fake-harness
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done
`,
    );
    const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
    if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);

    db.insertCard({
      run_id: DEFAULT_RUN_ID, id: 'a', parent_id: null, lane: 'coder', status: 'ready',
      attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
    });
    db.insertCard({
      run_id: DEFAULT_RUN_ID, id: 'b', parent_id: null, lane: 'coder', status: 'ready',
      attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
    });
    // Gated at tick start (release_at 1001 > currentNow 1000): planTick will
    // not dispatch 'b' this tick, but the retry backoff below advances the
    // clock to 1001 before 'a's second attempt samples ready_waiting.
    db.getStateDb()
      .prepare('UPDATE cards SET release_at = $r WHERE run_id = $run AND id = $id')
      .run({ $r: 1001, $run: DEFAULT_RUN_ID, $id: 'b' });

    await runExecutor({
      db,
      flow: loaded.flow,
      now: () => clock,
      // Advances the clock instead of paying the real backoff delay: models
      // the wall-clock time a retry's sleep actually consumes.
      sleep: async (ms: number) => {
        clock += ms / 1000;
      },
      adapter: throwingModel,
      io: { out: () => {}, err: () => {} },
      harnessRegistry: registry,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'a')?.lane).toBe('done');

    const { spans } = db.getHarnessTimingsForRun(DEFAULT_RUN_ID);
    const aSpans = spans.filter((_s, i) => i < 2); // 'a's two attempts land first
    expect(aSpans.map((s) => s.readyWaiting)).toEqual([0, 1]);
  });
});

describe('issue #30: getHarnessOccupancy', () => {
  it('returns null for a run with no harness spans', () => {
    insertRun('r0');
    db.appendJournalSpan({ runId: 'r0', cardId: 'c1', station: 'only', attempt: 0, name: 'only.transform' });
    expect(getHarnessOccupancy(db, 'r0')).toBeNull();
  });

  it('sums busy time and waited card-time per station against the run wall clock', () => {
    insertRun('r1');
    span('r1', 'research', 'maker', 30_000, 2); // 60 card-s waited
    span('r1', 'research', 'critic', 10_000, 1); // 10 card-s waited
    span('r1', 'research', 'maker', 20_000, 0);
    span('r1', 'write', 'maker', 15_000); // pre-#30 span: no ready_waiting
    // A non-harness span in the same run counts toward wall clock only.
    db.appendJournalSpan({ runId: 'r1', cardId: 'c1', station: 'research', attempt: 0, name: 'research.transform' });
    // Another run's harness span must not leak in.
    insertRun('other');
    span('other', 'research', 'maker', 99_000, 9);
    setWallClock('r1', 100);

    const report = getHarnessOccupancy(db, 'r1');
    expect(report).not.toBeNull();
    expect(report!.wallClockMs).toBe(100_000);
    expect(report!.stations).toEqual([
      { station: 'research', makerCalls: 2, criticCalls: 1, overlappedCalls: 0, busyMs: 60_000, waitedCardMs: 70_000, unsampledCalls: 0 },
      { station: 'write', makerCalls: 1, criticCalls: 0, overlappedCalls: 0, busyMs: 15_000, waitedCardMs: 0, unsampledCalls: 1 },
    ]);

    expect(formatHarnessOccupancy(report!)).toEqual([
      'harness occupancy (run wall clock 100.0s):',
      '  research: 2 maker + 1 critic call(s), busy 60.0s (60.0% of wall clock), other ready cards waited 70.0 card-s',
      '  write: 1 maker + 0 critic call(s), busy 15.0s (15.0% of wall clock), other ready cards waited 0.0 card-s, 1 call(s) not sampled',
      '  total: busy 75.0s (75.0% of wall clock)',
    ]);
  });
});

/** A span of an overlapped call (ADR-0012): `concurrent` plus its start. */
function overlappedSpan(
  runId: string,
  station: string,
  cardId: string,
  startedAtMs: number,
  durationMs: number,
  readyWaiting?: number,
): void {
  db.appendJournalSpan({
    runId,
    cardId,
    station,
    attempt: 0,
    name: `${station}.harness`,
    adapter: 'fake-harness',
    durationMs,
    usageUnknown: true,
    attributes: {
      outcome: 'success',
      concurrent: true,
      started_at_ms: startedAtMs,
      ...(readyWaiting === undefined ? {} : { ready_waiting: readyWaiting }),
    },
  });
}

describe('issue #30, ADR-0012: occupancy with overlapped calls', () => {
  it('reports busy time as the union of overlapping call intervals, per station and in total', () => {
    insertRun('ov');
    const t0 = 1_700_000_000_000;
    // walk: three calls, two overlapping [0,30s) and [10s,40s), one alone [100s,120s).
    overlappedSpan('ov', 'walk', 'w1', t0, 30_000, 1);
    overlappedSpan('ov', 'walk', 'w2', t0 + 10_000, 30_000, 1);
    overlappedSpan('ov', 'walk', 'w3', t0 + 100_000, 20_000, 0);
    // A serial span on another station adds its duration.
    span('ov', 'summarize', 'maker', 5_000, 2);
    setWallClock('ov', 200);

    const report = getHarnessOccupancy(db, 'ov')!;
    expect(report.stations).toEqual([
      // 5 s * 2 waiting cards
      { station: 'summarize', makerCalls: 1, criticCalls: 0, overlappedCalls: 0, busyMs: 5_000, waitedCardMs: 10_000, unsampledCalls: 0 },
      // busy: [0,40s) + [100s,120s) = 60 s, not the 80 s the durations sum to.
      // waited: one card for the 40 s the first two ran, counted once, not twice.
      { station: 'walk', makerCalls: 3, criticCalls: 0, overlappedCalls: 3, busyMs: 60_000, waitedCardMs: 40_000, unsampledCalls: 0 },
    ]);
    expect(report.totalBusyMs).toBe(65_000);
    expect(formatHarnessOccupancy(report)).toEqual([
      'harness occupancy (run wall clock 200.0s):',
      '  summarize: 1 maker + 0 critic call(s), busy 5.0s (2.5% of wall clock), other ready cards waited 10.0 card-s',
      '  walk: 3 maker + 0 critic call(s), 3 overlapped, busy 60.0s (30.0% of wall clock), other ready cards waited 40.0 card-s',
      '  total: busy 65.0s (32.5% of wall clock)',
    ]);
  });

  it('charges each moment the largest ready_waiting among the overlapping calls', () => {
    insertRun('mx');
    const t0 = 1_700_000_000_000;
    // A [0,40s) waiting 1, B [10s,40s) waiting 3: 1 for 10 s, then 3 for 30 s.
    // Min, first, last or a sum of the samples would each give a different figure.
    overlappedSpan('mx', 'walk', 'm1', t0, 40_000, 1);
    overlappedSpan('mx', 'walk', 'm2', t0 + 10_000, 30_000, 3);
    setWallClock('mx', 100);
    const report = getHarnessOccupancy(db, 'mx')!;
    expect(report.stations[0]!.waitedCardMs).toBe(100_000);
    expect(report.stations[0]!.busyMs).toBe(40_000);
  });

  it('ends an interval before starting one at the same instant when charging waited time', () => {
    insertRun('tie');
    const t0 = 1_700_000_000_000;
    // A [0,10s) waiting 5 and B [10s,20s) waiting 2 touch at 10 s, where A has
    // ended: 5 x 10 s + 2 x 10 s, not 5 x 20 s.
    overlappedSpan('tie', 'walk', 't1', t0, 10_000, 5);
    overlappedSpan('tie', 'walk', 't2', t0 + 10_000, 10_000, 2);
    setWallClock('tie', 100);
    const report = getHarnessOccupancy(db, 'tie')!;
    expect(report.stations[0]!.waitedCardMs).toBe(70_000);
    expect(report.stations[0]!.busyMs).toBe(20_000);
  });

  it('charges nothing for a zero-length call, before or after it', () => {
    insertRun('zero');
    const t0 = 1_700_000_000_000;
    // Z is [10s,10s) waiting 9; A [0,30s) waiting 1. Z covers no time, so the
    // waited figure is A's alone: 1 x 30 s.
    overlappedSpan('zero', 'walk', 'z1', t0 + 10_000, 0, 9);
    overlappedSpan('zero', 'walk', 'z2', t0, 30_000, 1);
    setWallClock('zero', 100);
    const report = getHarnessOccupancy(db, 'zero')!;
    expect(report.stations[0]!.waitedCardMs).toBe(30_000);
    expect(report.stations[0]!.busyMs).toBe(30_000);
  });

  it('takes the union across stations for the total when calls of two stations overlap', () => {
    insertRun('two');
    const t0 = 1_700_000_000_000;
    overlappedSpan('two', 'a', 'a1', t0, 20_000);
    overlappedSpan('two', 'b', 'b1', t0 + 5_000, 20_000);
    setWallClock('two', 100);
    const report = getHarnessOccupancy(db, 'two')!;
    expect(report.stations.map((s) => s.busyMs)).toEqual([20_000, 20_000]);
    expect(report.totalBusyMs).toBe(25_000);
    // No ready_waiting sample on either: reported as unsampled, not as zero waiting.
    expect(report.stations.map((s) => s.unsampledCalls)).toEqual([1, 1]);
  });

  it('counts an overlapped span without ready_waiting in busy time but not in waited card-time', () => {
    insertRun('uns');
    const t0 = 1_700_000_000_000;
    // A [0,20s) sampled, waiting 2. B [10s,40s) unsampled, extends past A.
    overlappedSpan('uns', 'walk', 'u1', t0, 20_000, 2);
    overlappedSpan('uns', 'walk', 'u2', t0 + 10_000, 30_000);
    setWallClock('uns', 100);
    const report = getHarnessOccupancy(db, 'uns')!;
    // busy: the union [0,40s) includes B's tail, which A alone would not cover.
    expect(report.stations[0]!.busyMs).toBe(40_000);
    expect(report.totalBusyMs).toBe(40_000);
    // waited: only A's sample counts, 2 cards for A's 20 s. B adds nothing, not even 0 samples averaged in.
    expect(report.stations[0]!.waitedCardMs).toBe(40_000);
    expect(report.stations[0]!.unsampledCalls).toBe(1);
    expect(report.stations[0]!.overlappedCalls).toBe(2);
  });

  it('still reports a journal written before ADR-0012 (no started_at_ms or concurrent)', () => {
    insertRun('old');
    span('old', 'research', 'maker', 30_000, 1);
    span('old', 'research', 'maker', 30_000, 1);
    setWallClock('old', 100);
    const report = getHarnessOccupancy(db, 'old')!;
    expect(report.stations[0]).toMatchObject({ busyMs: 60_000, waitedCardMs: 60_000, overlappedCalls: 0 });
    expect(report.totalBusyMs).toBe(60_000);
  });
});

describe('issue #30: conduit run status prints harness occupancy', () => {
  function deps(lines: string[]): CliDeps {
    return {
      io: { out: (l: string) => lines.push(l), err: () => {} },
      now: () => 1_000,
      db,
      adapter: throwingModel,
      runEngine: async () => {},
      prereqs: [],
    };
  }

  it('appends the occupancy lines after the state line', async () => {
    insertRun('job-h');
    span('job-h', 'research', 'maker', 40_000, 1);
    setWallClock('job-h', 80);
    const lines: string[] = [];
    expect(await main(['run', 'status', '--run', 'job-h'], deps(lines))).toBe(0);
    expect(lines[0]).toBe('run job-h: terminal (outcome=complete)');
    expect(lines.slice(1)).toEqual([
      'harness occupancy (run wall clock 80.0s):',
      '  research: 1 maker + 0 critic call(s), busy 40.0s (50.0% of wall clock), other ready cards waited 40.0 card-s',
      '  total: busy 40.0s (50.0% of wall clock)',
    ]);
  });

  it('prints only the state line for a run without harness spans', async () => {
    insertRun('job-t');
    const lines: string[] = [];
    expect(await main(['run', 'status', '--run', 'job-t'], deps(lines))).toBe(0);
    expect(lines).toEqual(['run job-t: terminal (outcome=complete)']);
  });
});
