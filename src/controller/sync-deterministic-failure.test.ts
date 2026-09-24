/**
 * WI-686 — a pure deterministic station that exits nonzero at the DEFAULT
 * concurrency=1 (the synchronous in-process path) must route through the FSM to
 * a NAMED terminal scrap, exactly like the pooled path — never a silent,
 * non-terminating busy-retry.
 *
 * BUG (surfaced by WI-681's black-box probe, the original silent deterministic-failure work class): executor.ts's
 * pure-deterministic `else` branch on `result.ok` does releaseSlot()+return
 * false with NO FSM routing, so the tick re-dispatches the same card forever
 * (attempt stays 0, empty card_log, no scrap, no output). The pooled path
 * handles the same failure correctly via the MARK_DONE 'scrap' outcome.
 *
 * PARITY IS DIRECT SCRAP, NOT RETRY-TO-CAP: worker-entry.ts:92-98 documents the
 * intended semantics — a deterministic command is a pure function of its inputs,
 * so re-running reproduces the identical failure; a rework/retry back-edge is
 * futile, and the fail-closed terminal outcome is an immediate `scrap` (a single
 * execution). This test pins that pooled-parity behavior on the synchronous
 * path. (The item's "retries up to the attempt cap" phrasing predates this
 * observation — see the handoff note; the shipped pooled path scraps after one
 * execution regardless of max_execution_attempts.)
 *
 * BOUNDING: a real advancing clock plus a tight liveness budget makes the BUGGY
 * build TERMINATE (the no-progress watchdog halts it, leaving the card
 * un-scrapped) instead of hanging — so this test fails fast (red) pre-fix rather
 * than wedging the suite. The fixed build scraps well before the watchdog.
 *
 * The second describe covers containment on the same path (#17): a station
 * whose command backgrounds a grandchild and exits 0 must not leave that
 * grandchild running once the card has advanced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import {
  CONTAINMENT_FIXTURE,
  containmentFixtureExitArgs,
  expectGrandchildReaped,
  killRecordedGrandchild,
} from '../worker/harness-containment.conformance';

const io = { out: (_l: string) => {}, err: (_l: string) => {} };

// A deterministic station never calls the model; a touch here is a real defect.
const throwingModel: ModelAdapter = {
  call: async () => {
    throw new Error('deterministic station must not call the model adapter');
  },
};

const MAX_ATTEMPTS = 2;

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

/**
 * One deterministic station whose command records a single execution then exits
 * nonzero on every run. The recorded byte count is the execution counter.
 */
function writeFailingFlow(dir: string): FlowConfig {
  writeFileSync(join(dir, 'fail.sh'), "printf 'x' >> executions.log\nexit 1\n");
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: sync-deterministic-failure
project_root: .
flow_version: 1
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
budgets:
  per_card: { max_execution_attempts: ${MAX_ATTEMPTS} }
  liveness: { no_progress_minutes: 0.05 }
stations:
  - id: boom
    next: done
    worker:
      kind: deterministic
      role: boomer
      command: sh
      args: ["fail.sh"]
    wip: 1
    inputs: []
    outputs: []
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedBoomCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'boom',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

let originalCwd: string;
let projectDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-sync-det-fail-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  killRecordedGrandchild(projectDir);
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

/** Bytes written to executions.log === number of times the command actually ran. */
function executionCount(): number {
  const p = join(projectDir, 'executions.log');
  return existsSync(p) ? readFileSync(p, 'utf-8').length : 0;
}

describe('WI-686 — synchronous-path deterministic failure routes to scrap', () => {
  it('scraps at concurrency=1 with a named reason and a bounded execution count (pooled parity)', async () => {
    db = openDb();
    const flow = writeFailingFlow(projectDir);
    seedBoomCard(db);

    // concurrency defaults to 1 and no spawn seam is wired → the synchronous
    // in-process deterministic path (the buggy path).
    await runExecutor({
      db,
      flow,
      now: () => Math.floor(Date.now() / 1000),
      adapter: throwingModel,
      io,
    } as RunEngineArgs);

    // ── Terminal scrap on a public surface — not stuck mid-lane, not held. ──
    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');

    // ── FSM-routing parity with the pooled path (countDeterministicFailure is
    //    shared by both): an entered_lane → scrap transition plus a terminal
    //    entry NAMING the failed station and exit code. ──
    const cardLog = db.getCardLog('entry');
    expect(cardLog.some((e) => e.kind === 'entered_lane' && e.destLane === 'scrap')).toBe(true);
    const terminalReasons = cardLog
      .filter((e) => e.kind === 'terminal')
      .map((e) => (e as { reason: string }).reason);
    expect(terminalReasons.some((r) => r.includes("deterministic station 'boom' failed (exit 1)"))).toBe(true);

    // ── Bounded, not an infinite busy-retry: count-and-retry runs the failing
    //    command once per attempt up to the cap, then scraps named. The buggy
    //    build re-dispatched without bumping the attempt, executing it hundreds
    //    of times until the watchdog halted — this bound catches that.
    const runs = executionCount();
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });
});

describe('#17: synchronous-path deterministic station reaps its descendants on exit 0', () => {
  it('advances the card to done and leaves no backgrounded grandchild running', async () => {
    db = openDb();
    // The containment fixture backgrounds a grandchild that touches a sentinel,
    // waits for its first touch, then exits 0. It writes into its cwd, which
    // the executor sets to the project root.
    const args = [CONTAINMENT_FIXTURE, ...containmentFixtureExitArgs(0)].map((a) => JSON.stringify(a));
    writeFileSync(
      join(projectDir, 'flow.yaml'),
      `
flow: sync-deterministic-reap
project_root: .
flow_version: 1
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
budgets:
  per_card: { max_execution_attempts: 1 }
stations:
  - id: boom
    next: done
    worker:
      kind: deterministic
      role: spawner
      command: sh
      args: [${args.join(', ')}]
    wip: 1
    inputs: []
    outputs: []
`,
    );
    const loaded = loadFlow(join(projectDir, 'flow.yaml'));
    if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
    seedBoomCard(db);

    await runExecutor({
      db,
      flow: loaded.flow,
      now: () => Math.floor(Date.now() / 1000),
      adapter: throwingModel,
      io,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    await expectGrandchildReaped(projectDir);
  }, 20_000);
});
