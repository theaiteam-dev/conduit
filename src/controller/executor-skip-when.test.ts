/**
 * skip_when wired into runExecutor (issue #32).
 *
 * A station that declares `skip_when` is evaluated by the controller each time
 * a card becomes ready there, before planTick dispatches it:
 *
 *   - match      → the FSM's SKIP event moves the card to the station's `next`
 *                  (or to done when the station is last). The station's worker
 *                  is never invoked, no checkpoint row is written for it, and
 *                  neither `attempt` nor `rework_count` changes. The card_log
 *                  records an entered_lane row (reasonClass 'skip') and a
 *                  'skip' row naming the predicate and the value read.
 *   - no match   → the card is dispatched as usual.
 *   - unreadable → the card is held (status held, lane unchanged) with a
 *                  terminal card_log reason; the station does not run.
 *
 * These tests drive the REAL runExecutor. The skippable station is a transform
 * whose prompt renders {{seed.json}}, so every adapter call records which card
 * it ran for.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const MODEL = 'gpt-4o-mini';
const PARENT_ID = 'root';

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-skip-when-exec-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

function openFreshDb(): ConduitDB {
  const database = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(database.getStateDb());
  return database;
}

function loadOk(dir: string): FlowConfig {
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(database: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  database.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? [],
    rework_count: over.rework_count ?? 0,
  });
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, lines };
}

async function run(flow: FlowConfig, adapter: ModelAdapter): Promise<string[]> {
  const { io, lines } = makeIO();
  await runExecutor({ db: db!, flow, now: () => 1000, adapter, io } as RunEngineArgs);
  return lines;
}

function checkpointCount(cardId: string, station: string): number {
  const row = db!
    .getStateDb()
    .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE card = $c AND station = $s')
    .get({ $c: cardId, $s: station }) as { n: number };
  return row.n;
}

function card(cardId: string): Card {
  const c = db!.getCard(DEFAULT_RUN_ID, cardId);
  if (!c) throw new Error(`card '${cardId}' missing`);
  return c;
}

function response(payload: unknown): ModelResponse {
  return { text: JSON.stringify(payload), inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
}

/** Make an owned directory for a child card; write its seed.json when given. */
function ownedDir(name: string, seed?: unknown): string {
  const dir = join(projectDir, 'work', name);
  mkdirSync(dir, { recursive: true });
  if (seed !== undefined) writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed), 'utf-8');
  return dir;
}

// ---------------------------------------------------------------------------
// Fan-out fixture: plan fans out children that enter at write_tests, which
// skips when the child's seed says no_test_needed == true. implement runs for
// every child. assemble is the fan-in station (policy: all).
// ---------------------------------------------------------------------------

function setupFanOutFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'plan.md'), 'Propose the children.');
  writeFileSync(join(dir, 'prompts', 'tests.md'), 'Write tests for {{seed.json}}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: skip-when-fanout
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: plan
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/plan.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: children, type: object, required: true }
    outputs: [children.json]
    fan_out: 3
    child_entry: write_tests
    child_terminal: done
    resume_at: assemble
    next: assemble
  - id: write_tests
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/tests.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: ok, type: boolean, required: true }
    inputs: [seed.json]
    outputs: [tests.json]
    output_scope: owned_dir
    wip: 3
    skip_when: { source: seed, field: no_test_needed, equals: true }
    next: implement
  - id: implement
    worker: { kind: deterministic, command: "true" }
    wip: 3
    next: done
  - id: assemble
    worker: { kind: deterministic, command: "true" }
    fan_in: { policy: all }
    next: done
`,
  );
  return loadOk(dir);
}

/**
 * Adapter for the fan-out fixture: returns `proposal` for plan and records
 * the seed text each write_tests call rendered.
 */
function fanOutAdapter(proposal: unknown, testCalls: string[]): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      if (req.prompt.startsWith('Write tests for')) {
        testCalls.push(req.prompt);
        return response({ ok: true });
      }
      return response(proposal);
    },
  };
}

describe('runExecutor skip_when: fan-out children', () => {
  it('skips write_tests for children whose seed matches and runs it for the rest', async () => {
    db = openFreshDb();
    const proposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [ownedDir('c1')], seed: { name: 'c1', no_test_needed: true } },
        { id: 'c2', depends_on: [], owned_paths: [ownedDir('c2')], seed: { name: 'c2', no_test_needed: false } },
        { id: 'c3', depends_on: [], owned_paths: [ownedDir('c3')], seed: { name: 'c3', no_test_needed: true } },
      ],
    };
    seedCard(db, { id: PARENT_ID, lane: 'plan', owned_paths: ['children.json'] });

    const testCalls: string[] = [];
    await run(setupFanOutFlow(projectDir), fanOutAdapter(proposal, testCalls));

    // write_tests ran once, for c2 only.
    expect(testCalls).toHaveLength(1);
    expect(testCalls[0]).toContain('"c2"');

    // No checkpoint for a skipped station; the one that ran has one.
    expect(checkpointCount('c1', 'write_tests')).toBe(0);
    expect(checkpointCount('c3', 'write_tests')).toBe(0);
    expect(checkpointCount('c2', 'write_tests')).toBe(1);

    // Every child reached done; skipped children spent no attempt or rework.
    for (const id of ['c1', 'c2', 'c3']) {
      expect(card(id).lane).toBe('done');
      expect(card(id).status).toBe('complete');
    }
    for (const id of ['c1', 'c3']) {
      expect(card(id).attempt).toBe(0);
      expect(card(id).rework_count).toBe(0);
    }

    // The skip is visible in the card_log: the lane move and the predicate.
    const log = db.getCardLogForRun(DEFAULT_RUN_ID, 'c1');
    const moved = log.find((e) => e.kind === 'entered_lane' && e.sourceLane === 'write_tests');
    expect(moved).toMatchObject({ destLane: 'implement', reasonClass: 'skip' });
    const skipRow = log.find((e) => e.kind === 'skip');
    expect(skipRow).toBeDefined();
    if (skipRow?.kind === 'skip') {
      expect(skipRow.station).toBe('write_tests');
      expect(skipRow.reason).toContain('seed.no_test_needed == true');
      expect(skipRow.reason).toContain('read true');
    }

    // Skipped children count toward fan-in: the parent resumed at assemble.
    const parentLog = db.getCardLogForRun(DEFAULT_RUN_ID, PARENT_ID);
    expect(parentLog.some((e) => e.kind === 'entered_lane' && e.sourceLane === 'assemble')).toBe(true);
    expect(card(PARENT_ID).lane).toBe('done');
  });

  it('holds a child whose seed lacks the field instead of choosing skip or run', async () => {
    db = openFreshDb();
    const proposal = {
      children: [
        { id: 'c1', depends_on: [], owned_paths: [ownedDir('c1')], seed: { name: 'c1', no_test_needed: true } },
        { id: 'c2', depends_on: [], owned_paths: [ownedDir('c2')], seed: { name: 'c2' } },
        { id: 'c3', depends_on: [], owned_paths: [ownedDir('c3')], seed: { name: 'c3', no_test_needed: 'yes' } },
      ],
    };
    seedCard(db, { id: PARENT_ID, lane: 'plan', owned_paths: ['children.json'] });

    const testCalls: string[] = [];
    await run(setupFanOutFlow(projectDir), fanOutAdapter(proposal, testCalls));

    // Neither unreadable child ran the station.
    expect(testCalls).toHaveLength(0);

    for (const id of ['c2', 'c3']) {
      expect(card(id).lane).toBe('write_tests');
      expect(card(id).status).toBe('held');
      expect(checkpointCount(id, 'write_tests')).toBe(0);
    }
    const reasonFor = (id: string): string => {
      const t = db!.getCardLogForRun(DEFAULT_RUN_ID, id).find((e) => e.kind === 'terminal');
      return t?.kind === 'terminal' ? t.reason : '';
    };
    expect(reasonFor('c2')).toContain("no field 'no_test_needed'");
    expect(reasonFor('c3')).toContain('string');

    // The matching child still skipped and finished.
    expect(card('c1').lane).toBe('done');

    // fan_in: all waits on the held children, so the parent has not resumed.
    expect(card(PARENT_ID).status).toBe('awaiting_children');
  });
});

// ---------------------------------------------------------------------------
// Output-source fixture: classify (transform) -> write_tests -> done. The skip
// reads classify's payload for the same card. write_tests is the last station,
// so a skip lands the card in done.
// ---------------------------------------------------------------------------

function setupOutputFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'classify.md'), 'Classify the item.');
  writeFileSync(join(dir, 'prompts', 'tests.md'), 'Write tests.');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: skip-when-output
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: classify
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/classify.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: needs_tests, type: boolean, required: true }
    outputs: [classification.json]
    next: write_tests
  - id: write_tests
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/tests.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: ok, type: boolean, required: true }
    outputs: [tests.json]
    skip_when: { source: output, station: classify, field: needs_tests, equals: false }
    next: done
`,
  );
  return loadOk(dir);
}

function outputAdapter(needsTests: boolean, calls: string[]): ModelAdapter {
  return {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req.prompt);
      return req.prompt.startsWith('Classify') ? response({ needs_tests: needsTests }) : response({ ok: true });
    },
  };
}

describe('runExecutor skip_when: upstream transform output', () => {
  it('skips the last station when the upstream payload matches, landing the card in done', async () => {
    db = openFreshDb();
    seedCard(db, { id: 'item', lane: 'classify' });
    const calls: string[] = [];
    await run(setupOutputFlow(projectDir), outputAdapter(false, calls));

    expect(calls).toEqual(['Classify the item.']);
    expect(checkpointCount('item', 'classify')).toBe(1);
    expect(checkpointCount('item', 'write_tests')).toBe(0);
    expect(card('item').lane).toBe('done');
    expect(card('item').status).toBe('complete');
    expect(card('item').attempt).toBe(0);
    expect(card('item').rework_count).toBe(0);

    const skipRow = db.getCardLogForRun(DEFAULT_RUN_ID, 'item').find((e) => e.kind === 'skip');
    expect(skipRow?.kind === 'skip' ? skipRow.reason : '').toContain('output(classify).needs_tests == false');
  });

  it('runs the station when the upstream payload does not match', async () => {
    db = openFreshDb();
    seedCard(db, { id: 'item', lane: 'classify' });
    const calls: string[] = [];
    await run(setupOutputFlow(projectDir), outputAdapter(true, calls));

    expect(calls).toEqual(['Classify the item.', 'Write tests.']);
    expect(checkpointCount('item', 'write_tests')).toBe(1);
    expect(card('item').lane).toBe('done');
    expect(db.getCardLogForRun(DEFAULT_RUN_ID, 'item').some((e) => e.kind === 'skip')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Race regression: a concurrent writer can change a card's status
// between applySkipWhen's top-of-function SELECT and the guarded UPDATE that
// commits a SKIP. The fix takes the state-db write lock (BEGIN IMMEDIATE) and
// re-reads status inside it before journaling anything.
// ---------------------------------------------------------------------------

describe('runExecutor skip_when: concurrent status change', () => {
  it('does not journal a skip when the card is no longer ready by the time the write lock is taken', async () => {
    db = openFreshDb();
    seedCard(db, { id: 'item', lane: 'classify' });
    const calls: string[] = [];

    // outputAdapter(false, ...) makes classify's payload match write_tests's
    // skip_when, so the card is a skip candidate once it reaches write_tests.
    const database = db;
    const originalGetCard = database.getCard.bind(database);
    let intercepted = false;
    const getCardSpy = spyOn(database, 'getCard').mockImplementation((runId: string, id: string) => {
      const found = originalGetCard(runId, id);
      // This is the exact read applySkipWhen does for its skip candidate: the
      // card is at write_tests and still 'ready'. Fire once, simulating
      // another writer (e.g. a second process sharing the state DB) claiming
      // the card in the window between that read and applySkipWhen's commit —
      // both the status flip and the active_workers row a real claim would
      // also write, so the only thing under test is applySkipWhen's own
      // guard, not an unrelated "claimed with no worker" contradiction.
      if (!intercepted && found && found.lane === 'write_tests' && found.status === 'ready') {
        intercepted = true;
        database
          .getStateDb()
          .prepare("UPDATE cards SET status = 'claimed' WHERE run_id = $runId AND id = $id")
          .run({ $runId: DEFAULT_RUN_ID, $id: id });
        database
          .getStateDb()
          .prepare(
            "INSERT INTO active_workers (run_id, card_id, station, worker_id, started_at, lease_until) " +
              "VALUES ($runId, $id, 'write_tests', 'other-writer', 0, 999999999)",
          )
          .run({ $runId: DEFAULT_RUN_ID, $id: id });
      }
      return found;
    });

    // The card is now genuinely claimed by "someone else": planTick has
    // nothing left to do for it and the run halts on the stall diagnostic
    // (`stuckCount > 0`) the very next tick — no need to wait out the
    // liveness threshold, so the default frozen clock is fine here.
    try {
      await run(setupOutputFlow(projectDir), outputAdapter(false, calls));
    } finally {
      getCardSpy.mockRestore();
    }

    expect(intercepted).toBe(true);

    // Neither card_log row for the never-happened move was written.
    const log = db.getCardLogForRun(DEFAULT_RUN_ID, 'item');
    expect(log.some((e) => e.kind === 'skip')).toBe(false);
    expect(log.some((e) => e.kind === 'entered_lane' && e.sourceLane === 'write_tests')).toBe(false);

    // The card is exactly where the simulated concurrent writer left it — the
    // guarded UPDATE inside applySkipWhen must not have touched it.
    expect(card('item').lane).toBe('write_tests');
    expect(card('item').status).toBe('claimed');
  });
});

// ---------------------------------------------------------------------------
// Memoized 'run' decisions: a card whose predicate evaluates to
// 'run' but that a wip cap keeps waiting must not have its seed.json (or
// upstream checkpoint) re-read on every later tick.
// ---------------------------------------------------------------------------

function setupMemoFlow(dir: string): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'tests.md'), 'Write tests for {{seed.json}}');
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: skip-when-memo
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: write_tests
    worker:
      kind: transform
      model: ${MODEL}
      prompt_file: prompts/tests.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: ok, type: boolean, required: true }
    inputs: [seed.json]
    outputs: [tests.json]
    output_scope: owned_dir
    wip: 1
    skip_when: { source: seed, field: no_test_needed, equals: true }
    next: done
`,
  );
  return loadOk(dir);
}

describe('runExecutor skip_when: memoized run decisions', () => {
  it('evaluates a run decision once, not on every tick a wip cap keeps it waiting', async () => {
    db = openFreshDb();
    const seedDirs: Record<string, string> = {
      c1: ownedDir('c1', { name: 'c1', no_test_needed: false }),
      c2: ownedDir('c2', { name: 'c2', no_test_needed: false }),
    };
    seedCard(db, { id: 'c1', lane: 'write_tests', owned_paths: [seedDirs.c1!] });
    seedCard(db, { id: 'c2', lane: 'write_tests', owned_paths: [seedDirs.c2!] });

    // wip: 1 forces one of these two ready cards to wait behind the other.
    // Whichever dispatches first, mutate the OTHER's seed.json — while it
    // still sits 'ready' — to a value that skip_when would now match. If the
    // waiting card's 'run' decision were re-evaluated on the tick it finally
    // gets its turn, it would skip instead of running.
    const calls: string[] = [];
    let mutated = false;
    const adapter: ModelAdapter = {
      async call(req: ModelCall): Promise<ModelResponse> {
        calls.push(req.prompt);
        if (!mutated) {
          mutated = true;
          const loser = req.prompt.includes('"c1"') ? 'c2' : 'c1';
          writeFileSync(join(seedDirs[loser]!, 'seed.json'), JSON.stringify({ name: loser, no_test_needed: true }), 'utf-8');
        }
        return response({ ok: true });
      },
    };

    await run(setupMemoFlow(projectDir), adapter);

    // Both cards ran the station — neither's memoized 'run' decision was
    // reconsidered after the mutation.
    expect(calls.some((p) => p.includes('"c1"'))).toBe(true);
    expect(calls.some((p) => p.includes('"c2"'))).toBe(true);
    expect(checkpointCount('c1', 'write_tests')).toBe(1);
    expect(checkpointCount('c2', 'write_tests')).toBe(1);
    for (const id of ['c1', 'c2']) {
      expect(db.getCardLogForRun(DEFAULT_RUN_ID, id).some((e) => e.kind === 'skip')).toBe(false);
      expect(card(id).lane).toBe('done');
      expect(card(id).status).toBe('complete');
    }
  });
});
