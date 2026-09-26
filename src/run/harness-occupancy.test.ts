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
      { station: 'research', makerCalls: 2, criticCalls: 1, busyMs: 60_000, waitedCardMs: 70_000, unsampledCalls: 0 },
      { station: 'write', makerCalls: 1, criticCalls: 0, busyMs: 15_000, waitedCardMs: 0, unsampledCalls: 1 },
    ]);

    expect(formatHarnessOccupancy(report!)).toEqual([
      'harness occupancy (serial under any --concurrency; run wall clock 100.0s):',
      '  research: 2 maker + 1 critic call(s), busy 60.0s (60.0% of wall clock), other ready cards waited 70.0 card-s',
      '  write: 1 maker + 0 critic call(s), busy 15.0s (15.0% of wall clock), other ready cards waited 0.0 card-s, 1 call(s) not sampled',
      '  total: busy 75.0s (75.0% of wall clock)',
    ]);
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
      'harness occupancy (serial under any --concurrency; run wall clock 80.0s):',
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
