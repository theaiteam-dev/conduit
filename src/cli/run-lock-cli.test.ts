/**
 * CLI-level tests for the per-run advisory lease lock (the original run-lock and busy-retry work, part 1).
 *
 * Covers the acquire/release wiring in cmdRun and cmdResume:
 *   1. conduit run against a run whose lease is held by a live process (this
 *      test process's own pid, guaranteed alive) refuses with exit 1 and
 *      does not invoke the engine.
 *   2. conduit resume against a run whose lease is held by a certainly-dead
 *      pid reclaims it, invokes the engine, and takes over the lease.
 *   3. A normal run acquires the lease for the duration of the engine call
 *      and releases it (holder_pid back to NULL) after exit.
 *
 * Uses the same injected-seam entry point as run-namespacing.test.ts:
 *   main(argv, deps) → exit code
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import { computeFingerprint } from '../run/run-registry';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

// ---------------------------------------------------------------------------
// IO capture + stub adapter
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;
let flowRoot: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-run-lock-cli-'));
  writeFileSync(join(flowRoot, 'p.md'), 'Write something.\n', 'utf-8');
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFlow(name = 'minimal'): string {
  const yaml = `flow: ${name}
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
defaults:
  cap_policy: scrap
  on_dep_scrap: scrap
stations:
  - id: only
    worker:
      kind: transform
      role: writer
      model: test-model
      prompt_file: p.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: text, type: string, required: true }
    inputs: [in.json]
    outputs: [out.json]
    next: done
`;
  const flowPath = join(flowRoot, `${name}.yaml`);
  writeFileSync(flowPath, yaml, 'utf-8');
  return flowPath;
}

interface CapturedRun {
  called: boolean;
}

function makeDeps(over: { runEngine?: (args: RunEngineArgs) => Promise<void>; capture?: CapturedRun } = {}): CliDeps {
  const capture = over.capture;
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async () => {
      if (capture) capture.called = true;
    }),
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
  };
}

/** Directly set a run row's lease holder via raw SQL (simulating another process). */
function setHolder(runId: string, holderPid: number, acquiredAt = 1_000): void {
  db.getStateDb()
    .prepare('UPDATE runs SET holder_pid = $pid, lease_acquired_at = $at WHERE run_id = $run_id')
    .run({ $pid: holderPid, $at: acquiredAt, $run_id: runId });
}

function getHolder(runId: string): { holder_pid: number | null; lease_acquired_at: number | null } | null {
  const row = db
    .getStateDb()
    .prepare('SELECT holder_pid, lease_acquired_at FROM runs WHERE run_id = $run_id')
    .get({ $run_id: runId }) as { holder_pid: number | null; lease_acquired_at: number | null } | undefined;
  return row ?? null;
}

/** A pid that has already exited — reliably dead, but was a real valid pid. */
function deadPid(): number {
  const proc = Bun.spawnSync(['true']);
  return proc.pid;
}

/**
 * Spawn a genuinely separate, still-running process to stand in for "another
 * live conduit process". Using this test's own process.pid would NOT exercise
 * the refusal path — acquireRunLease treats same-pid as re-entrant (allowed),
 * since `main()` runs in-process here. A distinct, actually-alive child pid is
 * required to hit the "different live holder" branch. Caller must call kill().
 */
function spawnAliveHolder(): { pid: number; kill: () => void } {
  const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  return { pid: proc.pid, kill: () => proc.kill() };
}

// ===========================================================================
// Scenario 1 — conduit run refuses when a live process holds the run's lease
// ===========================================================================

describe('conduit run — lease held by a live process (scenario 1)', () => {
  it('exits 1 with a clear message and never invokes the engine', async () => {
    const flowPath = writeFlow();
    const capture: CapturedRun = { called: false };

    // Register the run directly (bypassing `conduit run`'s own registration),
    // with the SAME flow path + fingerprint the CLI call below will compute,
    // so registerRun reports 'existing' rather than re-creating it.
    const resolvedFlowPath = resolve(flowPath);
    const fingerprint = computeFingerprint(resolvedFlowPath, { inline: '{}' }, flowRoot);
    db.insertRun({
      run_id: 'held-run',
      flow: resolvedFlowPath,
      project_root: flowRoot,
      input_fingerprint: fingerprint,
      status: 'running',
    });
    const holder = spawnAliveHolder();
    try {
      setHolder('held-run', holder.pid);

      const code = await main(
        ['run', flowPath, '--run-id', 'held-run', '--input-inline', '{}'],
        makeDeps({ capture }),
      );

      expect(code).toBe(1);
      expect(capture.called).toBe(false);
      expect(io.errors.some((e) => e.includes('held-run') && e.includes(String(holder.pid)))).toBe(true);

      // The live holder's lease must be untouched by the refused attempt.
      expect(getHolder('held-run')?.holder_pid).toBe(holder.pid);
    } finally {
      holder.kill();
    }
  });
});

/** An entry card left mid-flow, so a halted run reads as an ordinary halt rather than a failed launch. */
function insertUnfinishedCard(runId: string): void {
  db.insertCard({
    run_id: runId, id: `entry-${runId}`, parent_id: null, lane: 'work', status: 'ready',
    attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
  });
}

// ===========================================================================
// Scenario 2 — conduit resume reclaims a lease held by a certainly-dead pid
// ===========================================================================

describe('conduit resume — lease held by a dead process (scenario 2)', () => {
  it('proceeds, invokes the engine, and takes over the lease', async () => {
    const flowPath = writeFlow();
    const capture: CapturedRun = { called: false };
    const stalePid = deadPid();

    db.insertRun({ run_id: 'resumable-run', flow: flowPath, input_fingerprint: 'fp', status: 'halted' });
    // A halted run with no card is a failed launch, which resume refuses;
    // this one halted with its entry card unfinished.
    insertUnfinishedCard('resumable-run');
    setHolder('resumable-run', stalePid);

    const code = await main(
      ['resume', flowPath, '--run', 'resumable-run'],
      makeDeps({ capture }),
    );

    expect(code).toBe(0);
    expect(capture.called).toBe(true);

    // Lease was taken over and released (this process's pid is not the stale
    // holder's, and cmdResume releases it in its finally after the engine call).
    expect(getHolder('resumable-run')?.holder_pid).toBeNull();
  });
});

// ===========================================================================
// Scenario 3 — a normal run acquires the lease and releases it on exit
// ===========================================================================

describe('conduit run — normal lifecycle acquires and releases the lease (scenario 3)', () => {
  it('holder_pid is NULL again after the run exits', async () => {
    const flowPath = writeFlow();

    await main(
      ['run', flowPath, '--run-id', 'normal-run', '--input-inline', '{}'],
      makeDeps({
        runEngine: async () => {
          // Mark the entry card done so cmdRun reports a clean completion.
          db.getStateDb()
            .prepare("UPDATE cards SET lane = 'done' WHERE run_id = 'normal-run'")
            .run();
        },
      }),
    );

    const holder = getHolder('normal-run');
    expect(holder?.holder_pid).toBeNull();
    expect(holder?.lease_acquired_at).toBeNull();
  });
});

// ===========================================================================
// Scenario 4 — bare `conduit resume` sweep skips a lease-held run instead of
// aborting the whole sweep (review finding on the pre-public run-lock sweep review).
// ===========================================================================

describe('conduit resume — bare sweep with a mix of held and free runs (scenario 4)', () => {
  it('skips the held run with a warning, still resumes the free run, and exits 0', async () => {
    const flowPath = writeFlow();
    const resolvedFlowPath = resolve(flowPath);
    const fingerprint = computeFingerprint(resolvedFlowPath, { inline: '{}' }, flowRoot);

    db.insertRun({
      run_id: 'held-sweep-run',
      flow: resolvedFlowPath,
      project_root: flowRoot,
      input_fingerprint: fingerprint,
      status: 'halted',
    });
    db.insertRun({
      run_id: 'free-sweep-run',
      flow: resolvedFlowPath,
      project_root: flowRoot,
      input_fingerprint: fingerprint,
      status: 'halted',
    });

    insertUnfinishedCard('held-sweep-run');
    insertUnfinishedCard('free-sweep-run');

    const holder = spawnAliveHolder();
    try {
      setHolder('held-sweep-run', holder.pid);

      const invokedRunIds: string[] = [];
      const code = await main(
        ['resume', flowPath],
        makeDeps({
          runEngine: async (args) => {
            invokedRunIds.push(args.runId ?? '');
          },
        }),
      );

      expect(code).toBe(0);

      // The free run's engine was invoked; the held run's was not.
      expect(invokedRunIds).toContain('free-sweep-run');
      expect(invokedRunIds).not.toContain('held-sweep-run');

      // A warning names the skipped run and its holder pid — not the fail-fast
      // "error:" wording used for an explicit --run conflict.
      const skipMsg = io.errors.find(
        (e) => e.includes('held-sweep-run') && e.includes(String(holder.pid)),
      );
      expect(skipMsg).toBeDefined();
      expect(skipMsg).toMatch(/^warning:/);

      // The live holder's lease is untouched by the sweep.
      expect(getHolder('held-sweep-run')?.holder_pid).toBe(holder.pid);
    } finally {
      holder.kill();
    }
  });

  it('an explicit --run against a lease-held run still fails fast with exit 1', async () => {
    const flowPath = writeFlow();
    const resolvedFlowPath = resolve(flowPath);
    const fingerprint = computeFingerprint(resolvedFlowPath, { inline: '{}' }, flowRoot);

    db.insertRun({
      run_id: 'held-explicit-run',
      flow: resolvedFlowPath,
      project_root: flowRoot,
      input_fingerprint: fingerprint,
      status: 'halted',
    });
    insertUnfinishedCard('held-explicit-run');

    const holder = spawnAliveHolder();
    try {
      setHolder('held-explicit-run', holder.pid);

      const capture: CapturedRun = { called: false };
      const code = await main(
        ['resume', flowPath, '--run', 'held-explicit-run'],
        makeDeps({ capture, runEngine: async () => { capture.called = true; } }),
      );

      expect(code).toBe(1);
      expect(capture.called).toBe(false);
      const errMsg = io.errors.find(
        (e) => e.includes('held-explicit-run') && e.includes(String(holder.pid)),
      );
      expect(errMsg).toBeDefined();
      expect(errMsg).toMatch(/^error:/);

      expect(getHolder('held-explicit-run')?.holder_pid).toBe(holder.pid);
    } finally {
      holder.kill();
    }
  });
});
