/**
 * Unit tests for the controller-driven executor's internal logic (WI-356).
 *
 * These exercise `runExecutor`'s control logic in ISOLATION: an in-memory DB, a
 * stub ModelAdapter (no real LLM, no network), and minimal flows loaded by the
 * real loader. They drive the executor through the REAL planTick / transition
 * matrix / atomic-claim path and assert on observable side effects. The full
 * controller-driven end-to-end integration test (real artifacts on disk, full
 * dogfood flow) is a separate item (WI-358).
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/controller/executor.ts
 * ---------------------------------------------------------------------------
 *
 *   import type { RunEngineArgs } from '../cli/main';
 *   //   RunEngineArgs = { db: ConduitDB; flow: FlowConfig; now: () => number;
 *   //                     adapter: ModelAdapter; io: CliIO }
 *   export function runExecutor(args: RunEngineArgs): Promise<void>;
 *
 * `runExecutor` returns void; everything observable is a side effect:
 *   - card lane/status in the state DB (db.getCard)
 *   - token/cost spans in the journal (db.getStationUsage)
 *   - checkpoint rows in the `checkpoints` table (binding_stamp per station)
 *   - halt / escalation reasons surfaced through args.io
 *
 * Assumptions (raise a precise TEST BUG if a seam differs):
 *   A1. The entry card is discovered from the DB by planTick (seeded status='ready').
 *   A2. renderPrompt resolves inputs against the process CWD (tests chdir into a
 *       temp dir; flow project_root is '.').
 *   A3. Per-station WIP caps come from flow.stations[].wip.
 *   A4. The executor checkpoints each completed station into `checkpoints` keyed by
 *       station id; the binding stamp incorporates the station's prompt_version.
 *   A5. The adapter is the ONLY model surface; invoked solely by station workers
 *       (transform) and the gate critic — never by the routing/control loop.
 *   A6. Consumption andon + liveness watchdog halt the run and surface a reason via
 *       io; a contradictory card state escalates rather than advancing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

// ---------------------------------------------------------------------------
// Stub ModelAdapter — records calls; branches on req.model so the SAME adapter
// serves the transform worker (gpt-4o-mini) and the gate critic (gpt-4o), as the
// real wiring does (runGateCheck uses the injected adapter).
// ---------------------------------------------------------------------------

const WORKER_MODEL = 'gpt-4o-mini';
const CRITIC_MODEL = 'gpt-4o';

function makeStubAdapter(opts: { gateRejectsBeforePass?: number } = {}): {
  adapter: ModelAdapter;
  calls: ModelCall[];
} {
  let gateRejectsLeft = opts.gateRejectsBeforePass ?? 0;
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        if (gateRejectsLeft > 0) {
          gateRejectsLeft--;
          return {
            text: JSON.stringify({ verdict: 'reject', findings: ['needs work'], return_to: 'ideate' }),
            inputTokens: 8,
            outputTokens: 4,
            costUsd: 0.002,
          };
        }
        return {
          text: JSON.stringify({ verdict: 'pass', findings: [] }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      }
      return {
        text: JSON.stringify({ idea: 'a shoppable widget idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

function callsTo(calls: ModelCall[], model: string): number {
  return calls.filter((c) => c.model === model).length;
}

/**
 * Stub adapter whose critic ALWAYS rejects, returning DISTINCT findings on each
 * call (finding-1, finding-2, ...). Distinct findings keep the no_progress guard
 * (guard #3, which compares the immediately-prior findings hash) from firing, so
 * the card is driven purely by the rework-cap guard (guard #1) and the flow's
 * cap_policy. Use this when the test wants to reach the rework cap.
 */
function makeAlwaysRejectDistinctAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  let rejectN = 0;
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        rejectN++;
        return {
          text: JSON.stringify({ verdict: 'reject', findings: [`finding-${rejectN}`], return_to: 'ideate' }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      }
      return {
        text: JSON.stringify({ idea: 'a shoppable widget idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

/**
 * Stub adapter whose critic ALWAYS rejects with the SAME findings every call.
 * Identical findings across attempts trip the no_progress guard (guard #3) on
 * the second reject — used to prove no_progress scraps even under
 * proceed_with_findings.
 */
function makeAlwaysRejectSameFindingsAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === CRITIC_MODEL) {
        return {
          text: JSON.stringify({ verdict: 'reject', findings: ['unchanged finding'], return_to: 'ideate' }),
          inputTokens: 8,
          outputTokens: 4,
          costUsd: 0.002,
        };
      }
      return {
        text: JSON.stringify({ idea: 'a shoppable widget idea' }),
        inputTokens: 12,
        outputTokens: 6,
        costUsd: 0.003,
      };
    },
  };
  return { adapter, calls };
}

/** The terminal reason(s) recorded in the card_log for a scrapped card. */
function terminalReasons(db: ConduitDB, cardId: string): string[] {
  return db
    .getCardLog(cardId)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return {
    io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) },
    lines,
  };
}

// ---------------------------------------------------------------------------
// Flow fixtures
// ---------------------------------------------------------------------------

interface FlowOpts {
  promptVersion?: string;
  maxTokens?: number;
  wallClockMinutes?: number;
}

/**
 * A transform + gate flow (no deterministic station). The transform input
 * context.json is pre-written so renderPrompt has its artifact. The on-disk
 * deterministic-station + artifact-delivery path is WI-358's e2e scope.
 */
function setupTransformFlow(dir: string, opts: FlowOpts = {}): FlowConfig {
  const promptVersion = opts.promptVersion ?? '1';
  const maxTokens = opts.maxTokens ?? 100000;
  const wallClockMinutes = opts.wallClockMinutes ?? 10;

  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: executor-unit
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: ${wallClockMinutes}, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "${promptVersion}"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, model: ${CRITIC_MODEL}, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: ideate
      rework_cap: 2
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * A transform + gate flow parameterised on cap_policy and rework_cap, used to
 * exercise the FSM-owned cap decision (proceed_with_findings advances at cap vs
 * scrap at cap). Same on-disk shape as setupTransformFlow (context.json input,
 * idea.json output, ideate→done with a self gate back-edge ideate→ideate).
 */
function setupCapPolicyFlow(
  dir: string,
  opts: { capPolicy: 'scrap' | 'proceed_with_findings'; reworkCap: number },
): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: executor-cap-policy
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 99 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: ${opts.capPolicy}, on_dep_scrap: scrap }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, model: ${CRITIC_MODEL}, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: ideate
      rework_cap: ${opts.reworkCap}
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`cap-policy fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * Deterministic-only 3-station flow whose YAML insertion order is [a, b, c] but
 * whose `next` declares a -> c -> b -> done. Reaching `done` proves routing by
 * declared topology (happyPathNext), not insertion order (FR-2). Stations run
 * `true` (allowlisted, no artifacts) — pure dispatch + routing.
 */
function setupTopologyFlow(dir: string): FlowConfig {
  const flowYaml = `
flow: executor-topo
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
  - id: a
    worker: { kind: deterministic, command: "true" }
    next: c
  - id: b
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: c
    worker: { kind: deterministic, command: "true" }
    next: b
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`topology fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? ['context.json', 'idea.json'],
    rework_count: over.rework_count ?? 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function checkpointStamps(db: ConduitDB, station: string): string[] {
  return (
    db
      .getStateDb()
      .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
      .all({ $s: station }) as Array<{ binding_stamp: string }>
  ).map((r) => r.binding_stamp);
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle — each test in its own temp project dir (chdir for renderPrompt).
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-executor-'));
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

// ---------------------------------------------------------------------------
// Dispatch loop — planTick actions drive station execution.
// ---------------------------------------------------------------------------

describe('runExecutor — dispatch loop drives station execution', () => {
  it('dispatches and runs deterministic stations, routing to a terminal (done)', async () => {
    const flow = setupTopologyFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    // A card that reaches a terminal lane must carry the terminal status — not
    // be left 'waiting' (SPEC §3). Regression guard for the deterministic
    // terminal-advance path (dead-ternary bug at executor.ts:394).
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
  });

  it('runs the transform station via the injected adapter and reaches done (terminal: done)', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
    expect(callsTo(calls, WORKER_MODEL)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Routing — forward by happyPathNext (declared topology, not insertion order).
// ---------------------------------------------------------------------------

describe('runExecutor — routes by declared topology, not insertion order (FR-2)', () => {
  it('follows next a→c→b→done even though insertion order is [a, b, c]', async () => {
    const flow = setupTopologyFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'a', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Insertion order would route a→b; declared topology routes a→c→b→done.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Gate-rework routing — pass routes forward; reject routes to the back-edge,
// bounded by the rework guards; cap exhaustion scraps.
// ---------------------------------------------------------------------------

describe('runExecutor — gate-rework routing (bounded)', () => {
  it('routes a gate reject back to the declared on_reject station and re-runs it', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 1 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    // Back-edge re-ran ideate: initial + one rework = 2 worker calls.
    expect(callsTo(calls, WORKER_MODEL)).toBe(2);
  });

  it('scraps the card (terminal: scrap) once the durable rework cap is exhausted', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 99 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    expect(card?.rework_count ?? 0).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// FSM-owned routing + cap_policy — at the rework cap the FSM (not the executor)
// decides: capPolicy=scrap → scrap with reason 'rework_cap'; capPolicy=
// proceed_with_findings → the card ADVANCES FORWARD toward done. The no_progress
// hard-stop is NOT overridden by proceed_with_findings. An illegal/contradictory
// FSM transition escalates the card to 'held', never a silent advance.
// ---------------------------------------------------------------------------

describe('runExecutor — FSM-owned cap_policy routing', () => {
  it('proceed_with_findings advances the card forward to done at the rework cap (not scrap)', async () => {
    // rework_cap=1, always-reject critic with DISTINCT findings (no no_progress).
    // attempt 0: reject, under cap → rework (rework_count→1).
    // attempt 1: reject, AT cap + proceed_with_findings → FSM advances forward.
    const flow = setupCapPolicyFlow(projectDir, { capPolicy: 'proceed_with_findings', reworkCap: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeAlwaysRejectDistinctAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
  });

  it('cap_policy=scrap scraps the card with terminal reason rework_cap at the cap', async () => {
    // Same scenario, capPolicy=scrap. At the cap the card must scrap with the
    // 'rework_cap' terminal reason — NOT advance forward.
    const flow = setupCapPolicyFlow(projectDir, { capPolicy: 'scrap', reworkCap: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeAlwaysRejectDistinctAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    expect(terminalReasons(db, 'entry')).toContain('rework_cap');
  });

  it('under-cap reject routes back to the on_reject lane, bumps rework_count, then passes to done', async () => {
    // reject-then-pass critic with rework_cap=2: one reject (under cap) routes
    // back to ideate and bumps rework_count to 1, then the re-run passes → done.
    const flow = setupCapPolicyFlow(projectDir, { capPolicy: 'scrap', reworkCap: 2 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 1 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('done');
    expect(card?.status).toBe('complete');
    // Exactly one under-cap rework cycle was consumed.
    expect(card?.rework_count).toBe(1);
    // The back-edge re-ran the worker: initial + one rework = 2 worker calls.
    expect(callsTo(calls, WORKER_MODEL)).toBe(2);
  });

  it('no_progress still scraps under proceed_with_findings (the hard-stop guard is not overridden)', async () => {
    // proceed_with_findings + IDENTICAL findings every reject. The second reject
    // trips guard #3 (no_progress) BEFORE the cap is reached. proceed_with_findings
    // must NOT rescue it — the card scraps with reason 'no_progress', not 'done'.
    const flow = setupCapPolicyFlow(projectDir, { capPolicy: 'proceed_with_findings', reworkCap: 5 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeAlwaysRejectSameFindingsAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    expect(terminalReasons(db, 'entry')).toContain('no_progress');
  });

  it('escalates a card to held (not a silent advance) when the FSM has no legal forward transition', async () => {
    // A station with NO `next` (so happyPathNext has no entry for it) makes
    // INTEGRITY_PASS illegal at the FSM. The executor must escalate the card to
    // 'held' and surface an error — never silently advance it to done.
    const flowYaml = `
flow: executor-illegal-transition
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: scrap }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true"]
stations:
  - id: solo
    worker: { kind: deterministic, command: "true" }
  - id: other
    worker: { kind: deterministic, command: "true" }
    next: done
`;
    writeFileSync(join(projectDir, 'flow.yaml'), flowYaml);
    const loaded = loadFlow(join(projectDir, 'flow.yaml'));
    if (!loaded.ok) throw new Error(`illegal-transition fixture invalid: ${JSON.stringify(loaded.errors)}`);
    const flow = loaded.flow;

    db = openDb();
    seedCard(db, { id: 'entry', lane: 'solo', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.status).toBe('held');
    // Must NOT have silently advanced: lane unchanged, never reaches a terminal.
    expect(card?.lane).toBe('solo');
    expect(card?.lane).not.toBe('done');
    // The escalation reason is recorded as a terminal card_log entry naming the
    // illegal transition — the durable, observable record of WHY the card was held.
    // (NOTE: the in-station escalateToHold path records the reason here but does
    // NOT surface it via io.err — see FINDING in the test summary. The card_log
    // is the surface that IS produced, and a silent advance would leave no such
    // entry, so this assertion is the correct regression guard.)
    expect(terminalReasons(db, 'entry')).toContainEqual(
      expect.stringContaining('illegal_transition'),
    );
  });
});

// ---------------------------------------------------------------------------
// Journal — every model call records a real per-call token/cost span.
// ---------------------------------------------------------------------------

describe('runExecutor — records token/cost spans for model calls', () => {
  it('records a journal usage span for the transform station call', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getStationUsage('entry', 'ideate', 0)).not.toBeNull();
    expect(db.getJournalSpans('entry').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL — computeBindingStamp receives prompt_version from StationConfig.
// ---------------------------------------------------------------------------

describe('runExecutor — prompt_version flows into the checkpoint binding stamp (FR-5)', () => {
  async function runAndGetIdeateStamp(promptVersion: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-stamp-'));
    const cwd = process.cwd();
    process.chdir(dir);
    const localDb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(localDb.getStateDb());
    try {
      const flow = setupTransformFlow(dir, { promptVersion });
      seedCard(localDb, { id: 'entry', lane: 'ideate' });
      const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
      const { io } = makeIO();
      await runExecutor({ db: localDb, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);
      const stamps = checkpointStamps(localDb, 'ideate');
      expect(stamps.length).toBeGreaterThan(0);
      return stamps[0]!;
    } finally {
      localDb.close();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('produces a different binding stamp when only prompt_version changes', async () => {
    // Two runs identical except for prompt_version → the only differing input to
    // computeBindingStamp is promptTemplateVersion, so the stamps must differ.
    const stampV1 = await runAndGetIdeateStamp('1');
    const stampV2 = await runAndGetIdeateStamp('2');
    expect(stampV1).not.toBe(stampV2);
  });
});

// ---------------------------------------------------------------------------
// Andon + watchdog halts; contradictory-state escalation (terminal: hold).
// ---------------------------------------------------------------------------

describe('runExecutor — andon + liveness halts and contradictory escalation (FR-11)', () => {
  it('halts when the token consumption andon trips and surfaces the reason', async () => {
    // max_tokens=1: the first model call (18 tokens) trips the andon.
    const flow = setupTransformFlow(projectDir, { maxTokens: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io, lines } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).not.toBe('done');
    expect(lines.join(' ')).toMatch(/token|budget|andon/i);
  });

  it('halts when a station-level trip is on the WALL-CLOCK budget (not tokens) and still prints exactly one andon line (issue #83)', async () => {
    // wall_clock_minutes=1 (60s). The clock advances 100s per call: runStartedAt
    // is the first call (t=100), and the dispatching tick's currentNow is the
    // second (t=200) — elapsed=100s already clears the 60s budget before the
    // maker's model call even runs, so the STATION's own post-call andon check
    // (executeTransformStation, not the gate) is what trips, not the tick-level
    // check that follows the action batch. max_tokens stays at the generous
    // default so tokens never trips first — this pins the wall_clock path,
    // which the token test above does not cover.
    const flow = setupTransformFlow(projectDir, { wallClockMinutes: 1 });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io, lines } = makeIO();
    let t = 0;
    const now = () => (t += 100);

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).not.toBe('done');
    // haltOnStationAndon takes no reason and never prints (issue #83); only the
    // tick-level consumption check re-evaluates the same currentNow/tokensSpent
    // and prints the halt line — exactly once, with the wall_clock wording.
    expect(lines.filter((l) => l.startsWith('andon:'))).toEqual(['andon: run halted — wall_clock budget exceeded']);
  });

  it('halts on a liveness stall (no progress + no active worker) and surfaces the reason', async () => {
    // A card whose lane is not a station in the flow can never be dispatched
    // (cap=0, fail-closed) and is not terminal → no progress forever.
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'stuck', lane: 'no_such_station', status: 'ready', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io, lines } = makeIO();
    let t = 1000;
    const now = () => (t += 10_000); // advancing clock so the no-progress window elapses

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'stuck')?.lane).not.toBe('done');
    expect(lines.join(' ')).toMatch(/progress|liveness|stall|watchdog|deadlock/i);
  });

  it('escalates a contradictory card state instead of advancing past it', async () => {
    // A card 'claimed' with NO active_workers row is the canonical orphaned state
    // planTick flags. The executor must escalate it — never silently advance.
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'orphan', lane: 'ideate', status: 'claimed', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io, lines } = makeIO();
    let t = 1000;
    const now = () => (t += 10_000);

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'orphan')?.lane).not.toBe('done');
    expect(lines.join(' ')).toMatch(/escalat|hold|judgment|orphan|contradict|no.*worker/i);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL — no LLM enters the control loop.
// ---------------------------------------------------------------------------

describe('runExecutor — no LLM in the control loop (NFR-3)', () => {
  it('invokes the adapter only for station model calls (worker + critic), never for routing', async () => {
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate' });
    const { adapter, calls } = makeStubAdapter({ gateRejectsBeforePass: 0 });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    // Exactly one ideate (worker) call and one gate (critic) call — no extra
    // model calls from the routing/dispatch loop.
    expect(callsTo(calls, WORKER_MODEL)).toBe(1);
    expect(callsTo(calls, CRITIC_MODEL)).toBe(1);
    expect(calls).toHaveLength(2);
  });
});


// ---------------------------------------------------------------------------
// Fix 1 — output-path guard works correctly when project root is a symlink
// (regression: parent-doesn't-exist branch was comparing lexical target against
//  realpath'd root, causing false "escapes project root" for legitimate writes)
// ---------------------------------------------------------------------------

describe('runExecutor — output-path guard allows writes into new subdirs under a symlinked project root', () => {
  it('guard allows (no throw) a not-yet-created subdir under a symlinked project root', async () => {
    // When the project root is reached via a symlink AND the output parent dir
    // does not yet exist, realpathSync(parentDir) throws ENOENT and the guard
    // falls back to the lexical path. Before the fix the guard compared the
    // lexical target against the realpath'd root — prefixes never matched →
    // false "escapes project root". After the fix the lexical root is used on
    // the fallback path, so the guard passes correctly.
    //
    // We verify the guard does NOT throw "escapes project root"; the subsequent
    // writeFileSync may throw ENOENT (the dir hasn't been created yet) and we
    // assert on that instead.
    const realDir = mkdtempSync(join(tmpdir(), 'conduit-real-'));
    const symlinkRoot = join(tmpdir(), `conduit-sym-${Date.now()}`);
    symlinkSync(realDir, symlinkRoot);

    try {
      mkdirSync(join(realDir, 'prompts'), { recursive: true });
      writeFileSync(join(realDir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
      writeFileSync(join(realDir, 'context.json'), JSON.stringify({ ctx: 'data' }));
      // NOTE: subdir is intentionally NOT pre-created to exercise the fallback path.

      const flowYaml = `
flow: executor-symlink-fix
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [subdir/idea.json]
    next: done
`;
      writeFileSync(join(realDir, 'flow.yaml'), flowYaml);

      const cwd = process.cwd();
      process.chdir(symlinkRoot);
      const localDb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
      ensureCheckpointSchema(localDb.getStateDb());
      try {
        const loaded = loadFlow(join(realDir, 'flow.yaml'));
        if (!loaded.ok) throw new Error(`flow invalid: ${JSON.stringify(loaded.errors)}`);
        const flow = loaded.flow;

        localDb.insertCard({
          run_id: DEFAULT_RUN_ID,
          id: 'sym-card',
          parent_id: null,
          lane: 'ideate',
          status: 'ready',
          attempt: 0,
          wave: 0,
          owned_paths: ['context.json', 'subdir/idea.json'],
          rework_count: 0,
        });

        const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
        const { io } = makeIO();

        // The guard should NOT throw "escapes project root". The only permissible
        // throw is ENOENT from writeFileSync (the subdir doesn't exist yet).
        let thrownError: Error | null = null;
        try {
          await runExecutor({
            db: localDb,
            flow,
            now: SECONDS(1000),
            adapter,
            io,
            projectRoot: symlinkRoot,
          } as RunEngineArgs);
        } catch (e) {
          thrownError = e as Error;
        }

        // Guard regression: must NOT have thrown "escapes project root".
        expect(thrownError?.message ?? '').not.toMatch(/escapes project root|resolves outside the project root/i);
        // The only acceptable throw is ENOENT (subdir not yet created).
        if (thrownError !== null) {
          expect((thrownError as NodeJS.ErrnoException).code).toBe('ENOENT');
        }
      } finally {
        localDb.close();
        process.chdir(cwd);
      }
    } finally {
      rmSync(realDir, { recursive: true, force: true });
      rmSync(symlinkRoot, { force: true });
    }
  });

  it('still rejects a path that truly escapes via ../ even under a symlinked root', async () => {
    // The real dir + symlink setup.
    const realDir = mkdtempSync(join(tmpdir(), 'conduit-real2-'));
    const symlinkRoot = join(tmpdir(), `conduit-sym2-${Date.now()}`);
    symlinkSync(realDir, symlinkRoot);

    try {
      mkdirSync(join(realDir, 'prompts'), { recursive: true });
      writeFileSync(join(realDir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
      writeFileSync(join(realDir, 'context.json'), JSON.stringify({ ctx: 'data' }));

      // Output path traverses ABOVE the project root.
      const flowYaml = `
flow: executor-symlink-escape
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [../escape.json]
    next: done
`;
      writeFileSync(join(realDir, 'flow.yaml'), flowYaml);

      const cwd = process.cwd();
      process.chdir(symlinkRoot);
      const localDb = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
      ensureCheckpointSchema(localDb.getStateDb());
      try {
        const loaded = loadFlow(join(realDir, 'flow.yaml'));
        if (!loaded.ok) throw new Error(`flow invalid: ${JSON.stringify(loaded.errors)}`);
        const flow = loaded.flow;

        localDb.insertCard({
          run_id: DEFAULT_RUN_ID,
          id: 'escape-card',
          parent_id: null,
          lane: 'ideate',
          status: 'ready',
          attempt: 0,
          wave: 0,
          owned_paths: ['context.json', '../escape.json'],
          rework_count: 0,
        });

        const { adapter } = makeStubAdapter({ gateRejectsBeforePass: 0 });
        const { io, lines } = makeIO();

        // Must throw (or surface the error) — ../escape.json escapes the root.
        await expect(
          runExecutor({
            db: localDb,
            flow,
            now: SECONDS(1000),
            adapter,
            io,
            projectRoot: symlinkRoot,
          } as RunEngineArgs),
        ).rejects.toThrow(/escapes project root|resolves outside the project root/i);
      } finally {
        localDb.close();
        process.chdir(cwd);
      }
    } finally {
      rmSync(realDir, { recursive: true, force: true });
      rmSync(symlinkRoot, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — terminal-check stall detection: distinguish genuine stalls from
// intentional holds (a pre-public review comment).
//
// When planTick has no actions and non-terminal cards remain:
//   • Cards in status='held' are intentionally paused; the run exits cleanly
//     without emitting a spurious stall diagnostic.
//   • Any other non-terminal card with no available action is a genuine stall;
//     io.err must surface a loud diagnostic (card count + inspect hint) before
//     the loop exits. Never silently halt.
// ---------------------------------------------------------------------------

describe('runExecutor — terminal-check stall diagnostic (a pre-public review fix)', () => {
  it('emits a stall diagnostic and exits (no hang) when a non-held card is stuck with no available action', async () => {
    // Seed a card in status='done_pending_ack' on a real work lane (ideate).
    // The promote step only advances 'waiting'|'interrupted' → 'ready', so
    // done_pending_ack is never promoted and planTick never dispatches it.
    // The card is non-terminal, non-held → genuine stall.
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'stalled-card',
      parent_id: null,
      lane: 'ideate',
      status: 'done_pending_ack',
      attempt: 0,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });
    const { adapter } = makeStubAdapter();
    const { io, lines } = makeIO();

    // Must exit without hanging (genuine stall detected).
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Run must exit (above await returns) — no hang.
    // io.err must carry a stall/halt diagnostic — never silent.
    const combined = lines.join(' ');
    expect(combined).toMatch(/stall|stuck|halt/i);
    // The diagnostic should mention the card count or an inspect hint.
    expect(combined).toMatch(/conduit journal inspect|card\(s\)|1 card/i);
    // The card stays non-terminal (not silently advanced).
    expect(db.getCard(DEFAULT_RUN_ID, 'stalled-card')?.lane).toBe('ideate');
  });

  it('exits cleanly without a spurious stall diagnostic when only held cards remain', async () => {
    // Seed a single card in status='held' on a work lane. The escalation loop
    // already surfaced this card; the terminal-check must NOT re-flag it as a stall.
    const flow = setupTransformFlow(projectDir);
    db = openDb();
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'held-only',
      parent_id: null,
      lane: 'ideate',
      status: 'held',
      attempt: 0,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });
    const { adapter } = makeStubAdapter();
    const { io, lines } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Must exit (no hang).
    // Must NOT emit a stall diagnostic — held cards are intentional pauses.
    const combined = lines.join(' ');
    expect(combined).not.toMatch(/stall.*card|card.*stuck|run is halting/i);
    // The held card itself is unchanged.
    expect(db.getCard(DEFAULT_RUN_ID, 'held-only')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'held-only')?.lane).toBe('ideate');
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — liveness watchdog computes blocking cause from DB state instead of
// always reporting 'unknown' (all three flags were hardcoded false).
// ---------------------------------------------------------------------------

describe('runExecutor — liveness watchdog reports hold_awaiting_human cause when a card is held', () => {
  it('surfaces hold_awaiting_human reason (not unknown) when a held card is present and the run stalls', async () => {
    // Seed two cards:
    //   1. A card with status='held' — simulates an escalated card awaiting human.
    //   2. A ready card on no_such_station (so it can never dispatch) — keeps
    //      non-terminal count > 0 and guarantees a liveness stall.
    const flow = setupTransformFlow(projectDir);
    db = openDb();

    // Card 1: held (escalated).
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'held-card',
      parent_id: null,
      lane: 'ideate',
      status: 'held',
      attempt: 0,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });

    // Card 2: ready on an unknown station — will never dispatch, causing a stall.
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'stuck-card',
      parent_id: null,
      lane: 'no_such_station',
      status: 'ready',
      attempt: 0,
      wave: 0,
      owned_paths: [],
      rework_count: 0,
    });

    const { adapter } = makeStubAdapter();
    const { io, lines } = makeIO();
    let t = 1000;
    const now = () => (t += 10_000); // advancing clock so the no-progress window elapses

    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);

    // The watchdog must trip and surface the HOLD cause — not 'unknown'.
    expect(lines.join(' ')).toMatch(/hold|human|hitl|held/i);
    // Ensure the generic 'unknown' catch-all is NOT the message when a hold is present.
    expect(lines.join(' ')).not.toMatch(/cause is unknown/i);
  });
});

// ---------------------------------------------------------------------------
// Pre-launch punch-list #8 — a deterministic station whose command exceeds its
// configured timeout_seconds is KILLED and flows down the normal failure path
// (the run terminates via the liveness watchdog) rather than hanging forever on
// an *active* worker. This is the deadlock the timeout closes: a stuck command
// is an active worker, so the liveness watchdog ("no progress + NO active
// worker") would never trip while it ran. With the timeout the command dies,
// the slot is released (active=0), and the watchdog can finally stall the run.
// ---------------------------------------------------------------------------

describe('runExecutor — deterministic timeout flows down the failure path (#8)', () => {
  function setupSleepTimeoutFlow(dir: string): FlowConfig {
    const flowYaml = `
flow: executor-sleep-timeout
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
    allow: ["sleep"]
stations:
  - id: hang
    worker:
      kind: deterministic
      command: "sleep"
      args: ["10"]
      timeout_seconds: 1
    next: done
`;
    writeFileSync(join(dir, 'flow.yaml'), flowYaml);
    const loaded = loadFlow(join(dir, 'flow.yaml'));
    if (!loaded.ok) throw new Error(`sleep-timeout fixture invalid: ${JSON.stringify(loaded.errors)}`);
    return loaded.flow;
  }

  it('kills the over-budget command and the run terminates instead of hanging', async () => {
    const flow = setupSleepTimeoutFlow(projectDir);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'hang', owned_paths: [] });
    const { adapter } = makeStubAdapter();
    const { io, lines } = makeIO();
    // Advancing clock so the no-progress window elapses once the timed-out
    // command releases its slot (active workers = 0). Without the per-station
    // timeout the `sleep 10` would keep the worker active and the watchdog could
    // never trip — the run would block for the full sleep on every dispatch.
    let t = 1000;
    const now = () => (t += 10_000);

    const wall = Date.now();
    await runExecutor({ db, flow, now, adapter, io } as RunEngineArgs);
    const elapsed = Date.now() - wall;

    // The command was killed at ~1s, not after the full 10s sleep. Generous
    // upper bound keeps the test robust on slow CI while still proving the kill.
    expect(elapsed).toBeLessThan(6000);
    // The card never advanced to done — the timeout is a failure, not a success.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).not.toBe('done');
    // The run halted via the liveness/stall path (it did NOT silently complete).
    expect(lines.join(' ')).toMatch(/stall|liveness|no progress/i);
  });
});
