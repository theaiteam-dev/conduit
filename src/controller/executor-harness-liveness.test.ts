/**
 * Harness liveness watchdog — a long attempt must not false-trip (WI-567 / FR-8).
 *
 * Amy's probe of WI-567 found a false-stall bug: a harness dispatch whose single
 * attempt takes longer than budgets.liveness.no_progress_minutes causes the NEXT
 * tick's checkLiveness to falsely trip and HALT the run, even with real pending
 * downstream work never dispatched.
 *
 * Root cause: executor.ts stamps `lastLaneChangeAt = currentNow` for a harness
 * dispatch, but `currentNow` is sampled ONCE at the top of the tick — BEFORE the
 * dispatch's `await` resolves. Transform/agentic stations are protected because
 * trackingAdapter.call() stamps `lastAdapterActivityAt` with a FRESH now() the
 * instant the model call completes, and checkLiveness takes
 * max(lastLaneChangeAt, lastAdapterActivityAt) (watchdog.ts:210). The harness
 * path has no equivalent fresh-now stamp, so a long harness attempt looks like a
 * stall on the following tick.
 *
 * These tests mirror Amy's repro: a controllable clock that the fake harness
 * invoke() advances PAST the no-progress window before resolving. The fix is to
 * stamp a fresh now() into the liveness activity variable at EVERY harness invoke
 * resolution (success, paid-failure, and thrown/timeout).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessRegistry,
} from '../worker/harness-adapter';

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

/**
 * A fake harness whose invoke() advances the shared clock by `advanceBy`
 * simulated seconds before resolving — simulating a long-but-progressing attempt.
 * Writes both possible declared outputs so single- and two-station flows validate.
 */
function makeSlowHarness(
  clock: { t: number },
  advanceBy: number,
  opts: { throwTimeout?: boolean; usageTokens?: number; emitProgress?: boolean } = {},
): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'fake-harness',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      if (opts.emitProgress === true) {
        // Simulate a chatty child: each callback represents a line arriving
        // while the attempt is still in flight.
        const step = advanceBy / 4;
        for (let i = 0; i < 4; i += 1) {
          clock.t += step;
          call.onProgress?.();
        }
      } else {
        clock.t += advanceBy; // the attempt consumed real wall-clock time
      }
      if (opts.throwTimeout === true) {
        // The runner's wall-clock timeout killed the process group; the adapter
        // surfaces it as a distinct timed-out failure — EVEN THOUGH the attempt
        // was kept live for the liveness watchdog.
        throw Object.assign(new Error('claude-headless: invocation exceeded its timeout and was killed'), {
          code: 'harness-timeout',
        });
      }
      for (const outputName of ['result.json', 'review.json']) {
        writeFileSync(join(process.cwd(), outputName), JSON.stringify({ summary: 'ok' }), 'utf-8');
      }
      return { outputs: [], usage: { tokens: opts.usageTokens ?? 10, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

/** no_progress_minutes: 1 (60s). The attempt advances 120s — past the window. */
const NO_PROGRESS_MINUTES = 1;
const ADVANCE_SECONDS = 120;

function writeFlow(dir: string, registry: HarnessRegistry, opts: { twoStation?: boolean; maxTokens?: number }): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'Build the widget.');
  writeFileSync(join(dir, 'prompts', 'reviewer.md'), 'Review the widget.');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');

  const schema = `output_schema:
        fields:
          - { name: summary, type: string, required: true }`;

  const reviewerStation = opts.twoStation
    ? `
  - id: reviewer
    worker:
      kind: harness
      harness: fake-harness
      model: sonnet
      prompt_file: prompts/reviewer.md
      prompt_version: "1"
      tools: [Read]
      ${schema}
    inputs: [result.json]
    outputs: [review.json]
    next: done`
    : '';

  const coderNext = opts.twoStation ? 'reviewer' : 'done';

  const flowYaml = `
flow: harness-liveness
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 60, max_tokens: ${opts.maxTokens ?? 100000} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: ${NO_PROGRESS_MINUTES} }
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
      ${schema}
    inputs: [task.json]
    outputs: [result.json]
    next: ${coderNext}${reviewerStation}
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, id = 'entry'): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id, parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json', 'review.json'], rework_count: 0,
  });
}

const getCard = (db: ConduitDB, id = 'entry') => db.getCard(DEFAULT_RUN_ID, id);

function terminalReasons(db: ConduitDB, id = 'entry'): string[] {
  return db.getCardLog(id)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

let originalCwd: string;
let dir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-liveness-'));
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  if (db) { db.close(); db = null; }
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function makeIO(): { io: { out: (l: string) => void; err: (l: string) => void }; err: string[] } {
  const err: string[] = [];
  return { io: { out: () => {}, err: (l) => err.push(l) }, err };
}

// ---------------------------------------------------------------------------
// Single station — a long attempt must not log a spurious liveness stall.
// ---------------------------------------------------------------------------

describe('WI-567 / FR-8 — a long harness attempt does not false-trip the liveness watchdog', () => {
  it('does not log a liveness stall when a single harness attempt outlasts the no-progress window', async () => {
    db = openDb();
    const clock = { t: 1000 };
    const { adapter, calls } = makeSlowHarness(clock, ADVANCE_SECONDS);
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(dir, registry, {});
    seedCard(db);
    const { io, err } = makeIO();

    await runExecutor({ db, flow, now: () => clock.t, adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);

    // The card completed…
    expect(calls).toHaveLength(1);
    expect(getCard(db)?.lane).toBe('done');
    // …and the watchdog did NOT falsely report a stall for the long-but-progressing attempt.
    expect(err.join('\n')).not.toMatch(/liveness stall/i);
  });

  it('passes a progress callback to a chatty in-flight harness attempt', async () => {
    db = openDb();
    const clock = { t: 1000 };
    const { adapter, calls } = makeSlowHarness(clock, ADVANCE_SECONDS, { emitProgress: true });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(dir, registry, {});
    seedCard(db);
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => clock.t, adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);

    expect(typeof calls[0]?.onProgress).toBe('function');
    expect(getCard(db)?.lane).toBe('done');
  });

  // -------------------------------------------------------------------------
  // Two chained stations — the false trip must not ABANDON downstream work.
  // -------------------------------------------------------------------------

  it('dispatches the downstream station after a long upstream harness attempt (no abandoned work)', async () => {
    db = openDb();
    const clock = { t: 1000 };
    const { adapter, calls } = makeSlowHarness(clock, ADVANCE_SECONDS);
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(dir, registry, { twoStation: true });
    seedCard(db);
    const { io, err } = makeIO();

    await runExecutor({ db, flow, now: () => clock.t, adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);

    // Both stations ran — the reviewer's now-ready card was NOT abandoned by a
    // false stall halting the run after the coder's long attempt.
    expect(calls).toHaveLength(2);
    expect(getCard(db)?.lane).toBe('done');
    expect(err.join('\n')).not.toMatch(/liveness stall/i);
  });
});

// ---------------------------------------------------------------------------
// WI-569 — liveness freshness coexists with the wall-clock timeout and the
// consumption andon (the two andons stay distinct).
// ---------------------------------------------------------------------------

describe('WI-569 — liveness freshness does not exempt a harness attempt from its timeout (AC2)', () => {
  it('still terminates a long, timed-out attempt via its own timeout — not a false liveness stall', async () => {
    db = openDb();
    const clock = { t: 1000 };
    // Each attempt runs long (advances the clock past the no-progress window) AND
    // times out. Liveness freshness must not keep it alive past its own timeout.
    const { adapter, calls } = makeSlowHarness(clock, ADVANCE_SECONDS, { throwTimeout: true });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(dir, registry, {});
    seedCard(db);
    const { io, err } = makeIO();

    await runExecutor({ db, flow, now: () => clock.t, adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);

    // The timeout terminated the attempt(s) → bounded retry → scrap with the
    // distinct timed-out reason (WI-566), NOT an unbounded live hang.
    expect(getCard(db)?.lane).toBe('scrap');
    expect(terminalReasons(db).join(' | ')).toMatch(/harness-timeout/i);
    // And the watchdog did not false-stall — the timeout, not the watchdog, ended it.
    expect(err.join('\n')).not.toMatch(/liveness stall/i);
  });
});

describe('WI-569 — harness usage still trips the consumption andon while the attempt is live (AC3)', () => {
  it('halts on the consumption andon (tokens) even though the long attempt is treated as live', async () => {
    db = openDb();
    const clock = { t: 1000 };
    // Long (advances past the no-progress window) AND burns 100 tokens per attempt;
    // the run budget is 50. The CONSUMPTION andon (tokens) must trip — distinct
    // from the liveness watchdog, which must NOT fire.
    const { adapter } = makeSlowHarness(clock, ADVANCE_SECONDS, { usageTokens: 100 });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeFlow(dir, registry, { maxTokens: 50 });
    seedCard(db, 'entry');
    seedCard(db, 'entry2');
    const { io, err } = makeIO();

    await runExecutor({ db, flow, now: () => clock.t, adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);

    const doneCount = [getCard(db, 'entry'), getCard(db, 'entry2')].filter((c) => c?.lane === 'done').length;
    // No card completed: the consumption andon (fed by the live attempt's usage)
    // trips and — with the gateless-maker andon check (Finding 9, mirroring the
    // transform path's check-before-advance) — halts the run before the busting
    // card advances. The point stands: the CONSUMPTION andon fired (below), the
    // liveness watchdog did NOT — the two andons stayed distinct.
    expect(doneCount).toBe(0);
    const errText = err.join('\n');
    expect(errText).toMatch(/andon/i);
    expect(errText).toMatch(/token/i);
    expect(errText).not.toMatch(/liveness stall/i);
  });
});

function openDb(): ConduitDB {
  const database = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(database.getStateDb());
  return database;
}
