/**
 * Behavior tests for the executor's effectful-station outbox discipline
 * (Change 1 / SPEC §5 exactly-once) and io.err escalation parity (Change 2).
 *
 * These drive the REAL `runExecutor` against an in-memory state DB + journal,
 * a stub ModelAdapter (no network), and minimal flows loaded by the REAL loader.
 * They assert on observable side effects only:
 *   - card lane/status in the state DB (db.getCard)
 *   - outbox rows in the `outbox` table (idempotency_key / delivered_at)
 *   - checkpoint rows in the `checkpoints` table
 *   - spawn side effects (a marker file appended once per command spawn)
 *   - escalation lines emitted on io.err
 *
 * The outbox API under test lives in ../checkpoint/checkpoint.ts. The executor
 * constructs the idempotency key as `${flow.version}:${cardId}:${stationId}:${card.attempt}`.
 * For a freshly-seeded card (attempt=0) under flow_version=1, that key is
 * `1:<cardId>:<stationId>:0`. Tests pre-seed outbox/checkpoint rows under that
 * exact key to simulate a prior run.
 *
 * Spawn detection (deterministic stations): the effectful command is an
 * executable shell script written to disk that APPENDS one line to a counter
 * file each time it runs. Counting the lines = counting the spawns. This is a
 * direct observable: zero lines ⇒ the command never spawned. (The Law-lite
 * allowlist forbids shell metacharacters in command/args, so the command is the
 * script's absolute path — all safe chars — and takes no arguments.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig, Card, StationOutput } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import {
  ensureCheckpointSchema,
  getIntentStatus,
  writePendingIntent,
  commitIntent,
  writeCheckpoint,
  readCheckpoint,
  computeBindingStamp,
  computePromptContentAwarePromptTemplateVersion,
} from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

const WORKER_MODEL = 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Stub ModelAdapter — records every call so we can assert "called / not called".
// ---------------------------------------------------------------------------

function makeStubAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
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

function makeIO(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}

// ---------------------------------------------------------------------------
// Spawn-counting deterministic command — a script that appends to a marker file.
// ---------------------------------------------------------------------------

/**
 * Write an executable script at `<dir>/spawn.sh` that appends one line to
 * `<dir>/spawn-count.log` every time it runs, then exits 0. Returns the absolute
 * path to the script (used as the station `command`) and a `spawnCount()` reader.
 */
function makeSpawnCounter(dir: string): { scriptPath: string; spawnCount: () => number } {
  const scriptPath = join(dir, 'spawn.sh');
  const countLog = join(dir, 'spawn-count.log');
  // POSIX sh: append a single byte to the counter file. No args, exits 0.
  writeFileSync(scriptPath, `#!/bin/sh\nprintf 'x\\n' >> "${countLog}"\n`, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return {
    scriptPath,
    spawnCount: () => (existsSync(countLog) ? readFileSync(countLog, 'utf-8').split('\n').filter(Boolean).length : 0),
  };
}

// ---------------------------------------------------------------------------
// Flow fixtures
// ---------------------------------------------------------------------------

/**
 * A single deterministic station `emit` → done, optionally effectful. The
 * `command` is the spawn-counting script's absolute path (no args).
 */
function setupDeterministicFlow(
  dir: string,
  opts: { effectful: boolean; command: string },
): FlowConfig {
  const flowYaml = `
flow: eff-det
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
    allow: ["${opts.command}"]
stations:
  - id: emit
    effectful: ${opts.effectful}
    worker: { kind: deterministic, command: "${opts.command}" }
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`det fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/**
 * A single transform station `ideate` → done (no gate), optionally effectful.
 * context.json is the lone input; idea.json the lone output.
 */
function setupTransformFlow(dir: string, opts: { effectful: boolean }): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  const flowYaml = `
flow: eff-transform
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
    effectful: ${opts.effectful}
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
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`transform fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
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

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

/** The idempotency key the executor builds for a card at attempt 0 under flow_version=1. */
function idemKey(cardId: string, stationId: string, attempt = 0): string {
  return `1:${cardId}:${stationId}:${attempt}`;
}

function outboxRow(db: ConduitDB, idempotencyKey: string): { delivered_at: number | null } | undefined {
  return db
    .getStateDb()
    .prepare('SELECT delivered_at FROM outbox WHERE idempotency_key = $k')
    .get({ $k: idempotencyKey }) as { delivered_at: number | null } | undefined;
}

const SECONDS = (n: number) => () => n;

// ---------------------------------------------------------------------------
// Lifecycle — each test in its own temp project dir (chdir for renderPrompt /
// project-root-relative reads).
// ---------------------------------------------------------------------------

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-eff-'));
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

// ===========================================================================
// Effectful DETERMINISTIC station
// ===========================================================================

describe('effectful deterministic station — outbox fire/commit on first run', () => {
  it('Test 1: first run fires the command, commits the intent, and advances the card', async () => {
    const { scriptPath, spawnCount } = makeSpawnCounter(projectDir);
    const flow = setupDeterministicFlow(projectDir, { effectful: true, command: scriptPath });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'emit' });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Command spawned exactly once (the side effect landed).
    expect(spawnCount()).toBe(1);

    // Outbox row exists AND is committed (delivered_at set).
    const row = outboxRow(db, idemKey('entry', 'emit'));
    expect(row).toBeDefined();
    expect(row!.delivered_at).not.toBeNull();
    expect(getIntentStatus(db.getStateDb(), idemKey('entry', 'emit'))).toBe('committed');

    // Card advanced to the terminal lane.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
  });
});

describe('effectful deterministic station — committed intent on resume does NOT re-fire', () => {
  it('Test 2: a pre-seeded committed outbox row skips the spawn but still advances the card', async () => {
    const { scriptPath, spawnCount } = makeSpawnCounter(projectDir);
    const flow = setupDeterministicFlow(projectDir, { effectful: true, command: scriptPath });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'emit' });

    // Simulate a prior run that already fired + committed this exact intent.
    const key = idemKey('entry', 'emit');
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'emit',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'deterministic', station: 'emit' },
    });
    commitIntent(db.getStateDb(), key);

    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // The command must NOT spawn again — zero marker lines.
    expect(spawnCount()).toBe(0);

    // Card still advances (skip ≠ stall).
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
  });
});

describe('effectful deterministic station — pending intent on resume escalates to hold', () => {
  it('Test 3: a pre-seeded pending outbox row holds the card, emits io.err, and never spawns', async () => {
    const { scriptPath, spawnCount } = makeSpawnCounter(projectDir);
    const flow = setupDeterministicFlow(projectDir, { effectful: true, command: scriptPath });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'emit' });

    // Simulate a crash mid-effect: PENDING intent, never committed.
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'emit',
      attempt: 0,
      idempotencyKey: idemKey('entry', 'emit'),
      intent: { kind: 'deterministic', station: 'emit' },
    });

    const { adapter } = makeStubAdapter();
    const { io, err } = makeIO();
    // Constant clock: the card must dispatch and escalate on the first loop
    // iteration. An advancing clock would trip the liveness watchdog at the top
    // of the loop BEFORE the card is ever dispatched (no-progress window elapses
    // on iteration 1) — masking the in-station escalation under test.
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Card is frozen in 'held' (never blind-retry a pending effect).
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('emit');

    // The command must NOT have spawned.
    expect(spawnCount()).toBe(0);

    // io.err carries the escalation line naming the card (Change 2 parity).
    const errText = err.join(' ');
    expect(errText).toMatch(/escalation:/);
    expect(errText).toMatch(/entry/);
  });
});

describe('pure deterministic station — outbox is never touched', () => {
  it('Test 4: an effectful=false deterministic station advances with NO outbox row', async () => {
    const { scriptPath, spawnCount } = makeSpawnCounter(projectDir);
    const flow = setupDeterministicFlow(projectDir, { effectful: false, command: scriptPath });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'emit' });
    const { adapter } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Pure station still runs its command and advances.
    expect(spawnCount()).toBe(1);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');

    // No outbox row was written for a pure station.
    const count = (
      db.getStateDb().prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});

// ===========================================================================
// Effectful TRANSFORM station
// ===========================================================================

describe('effectful transform station — outbox fire/commit on first run', () => {
  it('Test 5: first run calls the model once, writes a checkpoint, commits, and advances', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: true });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });
    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Model adapter called exactly once (the billed side effect).
    expect(callsTo(calls, WORKER_MODEL)).toBe(1);

    // Outbox committed.
    const row = outboxRow(db, idemKey('entry', 'ideate'));
    expect(row).toBeDefined();
    expect(row!.delivered_at).not.toBeNull();

    // Checkpoint written for (flow, card, station, attempt).
    const checkpoint = readCheckpoint(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'ideate',
      attempt: 0,
    });
    expect(checkpoint).not.toBeNull();

    // Card advanced; output artifact present on disk.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
    expect(existsSync(join(projectDir, 'idea.json'))).toBe(true);
  });
});

describe('effectful transform station — committed intent on resume does NOT re-bill', () => {
  it('Test 6: committed outbox + matching checkpoint skips the model call and advances', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: true });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });

    // Pre-seed the prior run's checkpoint with the committed payload. The stamp
    // value is irrelevant on the committed-skip path (the executor reuses the
    // committed checkpoint output regardless of stamp), so any non-empty stamp works.
    const priorOutput: StationOutput<{ idea: string }> = {
      payload: { idea: 'committed prior idea' },
      findings_hash: 'hash',
      return_to: null,
      usage: { tokens: 18, cost: 0.003 },
    };
    writeCheckpoint(
      db.getStateDb(),
      { flow: '1', card: 'entry', station: 'ideate', attempt: 0 },
      { stamp: 'prior-stamp', output: priorOutput },
    );

    // Pre-seed the committed outbox intent for the same key.
    const key = idemKey('entry', 'ideate');
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'ideate',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'transform', station: 'ideate', outputs: ['idea.json'] },
    });
    commitIntent(db.getStateDb(), key);

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // The model must NOT be re-billed.
    expect(callsTo(calls, WORKER_MODEL)).toBe(0);

    // Card advances; the reused (committed) artifact is written to disk.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('complete');
    expect(existsSync(join(projectDir, 'idea.json'))).toBe(true);
    const written = JSON.parse(readFileSync(join(projectDir, 'idea.json'), 'utf-8'));
    expect(written).toEqual({ idea: 'committed prior idea' });
  });
});

describe('effectful transform station — pending intent on resume escalates to hold', () => {
  it('Test 7: a pending outbox row holds the card, emits io.err, and never calls the model', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: true });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });

    // PENDING intent, never committed (crash mid-bill).
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'ideate',
      attempt: 0,
      idempotencyKey: idemKey('entry', 'ideate'),
      intent: { kind: 'transform', station: 'ideate', outputs: ['idea.json'] },
    });

    const { adapter, calls } = makeStubAdapter();
    const { io, err } = makeIO();
    // Constant clock: the card must dispatch and escalate before any liveness
    // check trips (an advancing clock fires the watchdog at the top of the loop
    // before the card is dispatched — see Test 3).
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Held, model NOT called.
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('ideate');
    expect(callsTo(calls, WORKER_MODEL)).toBe(0);

    const errText = err.join(' ');
    expect(errText).toMatch(/escalation:/);
    expect(errText).toMatch(/entry/);
  });
});

describe('effectful transform station — committed intent but MISSING checkpoint escalates to hold', () => {
  it('Test 8: committed outbox with no checkpoint is an invariant violation → held + io.err', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: true });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });

    // Committed outbox row but NO checkpoint — data inconsistency.
    const key = idemKey('entry', 'ideate');
    writePendingIntent(db.getStateDb(), {
      flow: '1',
      card: 'entry',
      station: 'ideate',
      attempt: 0,
      idempotencyKey: key,
      intent: { kind: 'transform', station: 'ideate', outputs: ['idea.json'] },
    });
    commitIntent(db.getStateDb(), key);
    // Deliberately do NOT write a checkpoint.

    const { adapter, calls } = makeStubAdapter();
    const { io, err } = makeIO();
    // Constant clock: the card must dispatch and escalate before any liveness
    // check trips (an advancing clock fires the watchdog at the top of the loop
    // before the card is dispatched — see Test 3).
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Held; model NOT called (it must not silently re-bill to "recover").
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('ideate');
    expect(callsTo(calls, WORKER_MODEL)).toBe(0);

    // io.err names the invariant violation and the card.
    const errText = err.join(' ');
    expect(errText).toMatch(/escalation:/);
    expect(errText).toMatch(/entry/);
    expect(errText).toMatch(/no checkpoint|committed/i);
  });
});

describe('pure transform station — outbox untouched; checkpoint skip-on-resume intact', () => {
  it('Test 9a: an effectful=false transform calls the model and writes NO outbox row', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: false });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });
    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(callsTo(calls, WORKER_MODEL)).toBe(1);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');

    const count = (
      db.getStateDb().prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it('Test 9b: a matching-stamp checkpoint skips the model call (pure skip-on-resume)', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: false });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });

    // Pre-seed a checkpoint whose stamp MATCHES what the executor will compute.
    // The executor folds: modelId, prompt_version with the prompt file's content
    // hash (issue #131), input artifact hashes, flowVersion.
    // No feedback (rework_count=0), single input context.json.
    const ctxHash = createHash('sha256')
      .update(readFileSync(join(projectDir, 'context.json')))
      .digest('hex');
    const promptHash = createHash('sha256')
      .update(readFileSync(join(projectDir, 'prompts', 'ideate.md'), 'utf-8'))
      .digest('hex');
    const matchingStamp = computeBindingStamp({
      modelId: WORKER_MODEL,
      promptTemplateVersion: computePromptContentAwarePromptTemplateVersion('1', promptHash),
      inputArtifactHashes: [ctxHash],
      flowVersion: 1,
    });
    const priorOutput: StationOutput<{ idea: string }> = {
      payload: { idea: 'cached idea' },
      findings_hash: 'hash',
      return_to: null,
      usage: { tokens: 18, cost: 0.003 },
    };
    writeCheckpoint(
      db.getStateDb(),
      { flow: '1', card: 'entry', station: 'ideate', attempt: 0 },
      { stamp: matchingStamp, output: priorOutput },
    );

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Matching stamp ⇒ model is skipped and the cached output is reused.
    expect(callsTo(calls, WORKER_MODEL)).toBe(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const written = JSON.parse(readFileSync(join(projectDir, 'idea.json'), 'utf-8'));
    expect(written).toEqual({ idea: 'cached idea' });
  });

  it('Test 9c: a mismatched-stamp checkpoint re-runs the model (pure skip-on-resume)', async () => {
    const flow = setupTransformFlow(projectDir, { effectful: false });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'ideate', owned_paths: ['context.json', 'idea.json'] });

    // Pre-seed a checkpoint with a STALE stamp — must NOT be reused.
    const priorOutput: StationOutput<{ idea: string }> = {
      payload: { idea: 'stale idea' },
      findings_hash: 'hash',
      return_to: null,
      usage: { tokens: 18, cost: 0.003 },
    };
    writeCheckpoint(
      db.getStateDb(),
      { flow: '1', card: 'entry', station: 'ideate', attempt: 0 },
      { stamp: 'stale-stamp-does-not-match', output: priorOutput },
    );

    const { adapter, calls } = makeStubAdapter();
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    // Mismatched stamp ⇒ the model IS called and produces fresh output.
    expect(callsTo(calls, WORKER_MODEL)).toBe(1);
    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const written = JSON.parse(readFileSync(join(projectDir, 'idea.json'), 'utf-8'));
    expect(written).toEqual({ idea: 'a shoppable widget idea' });
  });
});

// ===========================================================================
// io.err surfacing on FSM illegal_transition (Change 2)
//
// Rig a card whose lane has NO happyPathNext successor so INTEGRITY_PASS is
// illegal at the FSM → escalateToHold fires. Assert the escalation reaches
// io.err with the "escalation: card <id> held — <reason>" shape, matching the
// top-of-loop plan.escalations path. This is the parity Change 2 adds.
// ===========================================================================

/** A deterministic station `solo` with NO `next` (illegal forward transition). */
function setupNoSuccessorDeterministicFlow(dir: string, command: string): FlowConfig {
  const flowYaml = `
flow: no-successor-det
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
    allow: ["${command}"]
stations:
  - id: solo
    worker: { kind: deterministic, command: "${command}" }
  - id: other
    worker: { kind: deterministic, command: "${command}" }
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`no-successor det fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** A transform station `solo` with NO `next` and NO gate (illegal forward transition). */
function setupNoSuccessorTransformFlow(dir: string, opts: { gate: boolean }): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'ideate.md'), 'Make an idea from {{context.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check {{idea.json}} against {{context.json}}');
  writeFileSync(join(dir, 'context.json'), JSON.stringify({ ctx: 'data' }));

  // A self-referential back-edge (solo→solo) makes the gate's on_reject valid
  // while leaving the forward INTEGRITY_PASS illegal (no `next` on solo). The
  // critic PASSES, so the pass branch fires INTEGRITY_PASS, which is illegal → hold.
  const gateBlock = opts.gate
    ? `
    check:
      kind: gate
      critic: { role: critic, model: gpt-4o, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: solo
      rework_cap: 2`
    : '';

  // A SECOND station 'other' declares `next: done`. This forces the loader to
  // build flow.happyPathNext from declared edges (hasNextDeclarations=true), so
  // 'solo' — which has NO `next` — is absent from happyPathNext and INTEGRITY_PASS
  // is illegal for it. Without this, a lone station with no `next` falls back to
  // insertion-order routing (solo→null→done), masking the illegal transition.
  // The card seeds on 'solo' and is held before 'other' ever runs.
  const flowYaml = `
flow: no-successor-transform
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: solo
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]${gateBlock}
  - id: other
    worker:
      kind: transform
      model: ${WORKER_MODEL}
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [other.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`no-successor transform fixture invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** A gate-critic stub that always PASSES (so the gate-pass branch fires INTEGRITY_PASS). */
function makePassingGateAdapter(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      if (req.model === 'gpt-4o') {
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

describe('io.err parity on in-station FSM illegal_transition escalation (Change 2)', () => {
  it('Test 10: deterministic illegal_transition emits on io.err', async () => {
    const { scriptPath } = makeSpawnCounter(projectDir);
    const flow = setupNoSuccessorDeterministicFlow(projectDir, scriptPath);
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'solo' });
    const { adapter } = makeStubAdapter();
    const { io, err } = makeIO();
    // Constant clock: the card must dispatch and escalate before any liveness
    // check trips (an advancing clock fires the watchdog at the top of the loop
    // before the card is dispatched — see Test 3).
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');
    const errText = err.join(' ');
    expect(errText).toMatch(/escalation: card entry held —/);
    expect(errText).toMatch(/illegal_transition/i);
  });

  it('Test 11: transform gate-pass illegal_transition emits on io.err', async () => {
    const flow = setupNoSuccessorTransformFlow(projectDir, { gate: true });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'solo', owned_paths: ['context.json', 'idea.json'] });
    const { adapter } = makePassingGateAdapter();
    const { io, err } = makeIO();
    // Constant clock: the card must dispatch and escalate before any liveness
    // check trips (an advancing clock fires the watchdog at the top of the loop
    // before the card is dispatched — see Test 3).
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');
    const errText = err.join(' ');
    expect(errText).toMatch(/escalation: card entry held —/);
    expect(errText).toMatch(/illegal_transition/i);
  });

  it('Test 12: transform no-gate illegal_transition emits on io.err', async () => {
    const flow = setupNoSuccessorTransformFlow(projectDir, { gate: false });
    db = openDb();
    seedCard(db, { id: 'entry', lane: 'solo', owned_paths: ['context.json', 'idea.json'] });
    const { adapter } = makeStubAdapter();
    const { io, err } = makeIO();
    // Constant clock: the card must dispatch and escalate before any liveness
    // check trips (an advancing clock fires the watchdog at the top of the loop
    // before the card is dispatched — see Test 3).
    await runExecutor({ db, flow, now: SECONDS(1000), adapter, io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.status).toBe('held');
    const errText = err.join(' ');
    expect(errText).toMatch(/escalation: card entry held —/);
    expect(errText).toMatch(/illegal_transition/i);
  });
});
