/**
 * Harness attempt caps + distinct named failure states (WI-566).
 *
 * Layered on the WI-565 harness execution path (executor.ts executeHarnessStation):
 * every distinct harness failure mode is COUNTED against max_execution_attempts,
 * bounded-retried, and on exhaustion SCRAPS with a reason that NAMES its class —
 * never a silent advance, and (the behavior change from WI-565) never a hold.
 *
 * Failure classes + their distinct named scrap reasons:
 *   - non-zero exit         → 'harness-nonzero-exit'   (adapter throw, err.code)
 *   - timeout               → 'harness-timeout'        (adapter throw, err.code)
 *   - missing decl. output  → 'harness-output-missing'    (executor-detected)
 *   - unparseable output    → 'harness-output-unparseable'(executor-detected)
 *   - schema-invalid output → 'harness-output-invalid'    (executor-detected,
 *                             distinct from a transform 'model-incompatible' scrap)
 *
 * Mirrors the transform bounded-retry loop (transform.ts runTransformStation:
 * `while callsMade < maxExecutionAttempts`) and its scrap surfaced via
 * advanceCard(...'scrap','scrapped',...,reason) → card_log kind:'terminal'.
 *
 * Adapter-throw classification follows the established precedent: the transform
 * worker branches on `err.code === 'vision-unsupported'` (transform.ts), the
 * openai adapter SETS that code. Likewise the claude adapter must tag its throws
 * (err.code 'harness-timeout' / 'harness-nonzero-exit') so the executor can name
 * the class — see the handoff. This test injects a fake adapter that sets those
 * codes, exercising the executor's classification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, readCheckpoint } from '../checkpoint/checkpoint';
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

// ---------------------------------------------------------------------------
// Shared executor-test recipe.
// ---------------------------------------------------------------------------

const SECONDS = (n: number) => () => n;

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

const io = { out: (_l: string) => {}, err: (_l: string) => {} };

/** A ModelAdapter that must never be touched by a harness maker under no gate. */
const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

// ---------------------------------------------------------------------------
// Scriptable fake harness adapter. Each invoke consumes the next behavior (the
// last one repeats), so a persistent failure retries to the cap and a
// fail-then-recover sequence advances.
// ---------------------------------------------------------------------------

type Behavior =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'unparseable' }
  | { kind: 'invalid' }
  | { kind: 'throw'; code?: string; message: string };

function makeScriptedHarness(
  behaviors: Behavior | Behavior[],
  opts: { name?: string; outputName?: string } = {},
): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const name = opts.name ?? 'fake-harness';
  const outputName = opts.outputName ?? 'result.json';
  const seq = Array.isArray(behaviors) ? behaviors : [behaviors];
  const calls: HarnessInvocation[] = [];
  let i = 0;
  const adapter: HarnessAdapter = {
    name,
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      const b = seq[Math.min(i, seq.length - 1)]!;
      i++;
      // process.cwd() === the project root (each test chdirs into its temp dir and
      // the flow declares project_root: .), so this is where the executor collects
      // declared outputs: join(projectRoot, outputName).
      const abs = join(process.cwd(), outputName);
      switch (b.kind) {
        case 'throw':
          throw Object.assign(new Error(b.message), b.code ? { code: b.code } : {});
        case 'missing':
          break; // writes nothing — the missing declared-output case
        case 'unparseable':
          writeFileSync(abs, 'this is not json <<<', 'utf-8');
          break;
        case 'invalid':
          writeFileSync(abs, JSON.stringify({ notSummary: 'x' }), 'utf-8');
          break;
        case 'ok':
          writeFileSync(abs, JSON.stringify({ summary: 'ok' }), 'utf-8');
          break;
      }
      return { outputs: [], usage: { tokens: 10, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Flow fixture — one `coder` harness station, configurable attempt cap.
// ---------------------------------------------------------------------------

function writeHarnessFlow(
  dir: string,
  registry: HarnessRegistry,
  opts: { maxAttempts?: number } = {},
): FlowConfig {
  const maxAttempts = opts.maxAttempts ?? 2;
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build the widget"}');

  const flowYaml = `
flow: harness-failures
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: ${maxAttempts} }
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
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCoderCard(db: ConduitDB): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'entry',
    parent_id: null,
    lane: 'coder',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ['task.json', 'result.json'],
    rework_count: 0,
  });
}

const getCard = (db: ConduitDB) => db.getCard(DEFAULT_RUN_ID, 'entry');

const coderCheckpoint = (db: ConduitDB) =>
  readCheckpoint(db.getStateDb(), {
    run: DEFAULT_RUN_ID, flow: '1', card: 'entry', station: 'coder', attempt: 0,
  });

/** The scrap/hold reasons recorded on the card's terminal card_log entries. */
function terminalReasons(db: ConduitDB): string[] {
  return db
    .getCardLog('entry')
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

// ---------------------------------------------------------------------------
// Lifecycle — each test runs inside its own temp project dir (project_root: .).
// ---------------------------------------------------------------------------

let originalCwd: string;
let projectDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-harness-fail-'));
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

async function run(flow: FlowConfig, registry: HarnessRegistry, at = 1000): Promise<void> {
  await runExecutor({
    db: db!, flow, now: SECONDS(at), adapter: throwingModel, io, harnessRegistry: registry,
  } as RunEngineArgs);
}

// ---------------------------------------------------------------------------
// AC1–AC4 — each distinct failure class retries to the cap then scraps with a
// distinct named reason; never advances, never holds.
// ---------------------------------------------------------------------------

const FAILURE_CASES: Array<[string, Behavior, RegExp]> = [
  ['non-zero exit', { kind: 'throw', code: 'harness-nonzero-exit', message: 'claude-headless: exited with code 1: boom' }, /harness-nonzero-exit/i],
  ['timeout', { kind: 'throw', code: 'harness-timeout', message: 'claude-headless: invocation exceeded its timeout and was killed' }, /harness-timeout/i],
  // Issue #31: an idle kill is retried and scrapped exactly like a wall-clock
  // timeout — same attempt-cap accounting, same terminal-scrap path — never a
  // park. A park would leave the card ready behind cards.release_at, never
  // reaching lane:'scrap', so this case failing to scrap would itself prove a
  // wrongly-triggered park.
  ['idle timeout', { kind: 'throw', code: 'harness-idle-timeout', message: 'claude-headless: invocation produced no output for longer than the idle timeout and was killed' }, /harness-idle-timeout/i],
  ['missing declared output', { kind: 'missing' }, /harness-output-missing/i],
  ['unparseable output', { kind: 'unparseable' }, /harness-output-unparseable/i],
  ['schema-invalid output', { kind: 'invalid' }, /harness-output-invalid/i],
];

describe('WI-566 — a persistent harness failure scraps with a distinct named reason (AC1–AC4)', () => {
  it.each(FAILURE_CASES)(
    'scraps (never advances, never holds) after the attempt cap: %s',
    async (_label, behavior, reasonPattern) => {
      db = openDb();
      const { adapter, calls } = makeScriptedHarness(behavior);
      const registry = createHarnessRegistry([adapter]);
      const flow = writeHarnessFlow(projectDir, registry, { maxAttempts: 2 });
      seedCoderCard(db);

      await run(flow, registry);

      const card = getCard(db);
      // Scrapped — NOT a silent advance to done, and NOT a hold (the WI-565 interim).
      expect(card?.lane).toBe('scrap');
      expect(card?.status).toBe('scrapped');
      // Retried up to the attempt cap before scrapping.
      expect(calls).toHaveLength(2);
      // The scrap reason NAMES this failure class.
      expect(terminalReasons(db).some((r) => reasonPattern.test(r))).toBe(true);
      // A failed attempt is not skip-replayed on resume.
      expect(coderCheckpoint(db)).toBeNull();
    },
  );

  it('names the exhausting failure class in the scrap reason, distinct from a transform model-incompatible scrap', async () => {
    db = openDb();
    const { adapter } = makeScriptedHarness({ kind: 'invalid' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { maxAttempts: 2 });
    seedCoderCard(db);

    await run(flow, registry);

    const reasons = terminalReasons(db);
    // A harness output-contract violation is its OWN class, never conflated with
    // the transform maker's 'model-incompatible' scrap.
    expect(reasons.some((r) => /harness-output-invalid/i.test(r))).toBe(true);
    expect(reasons).not.toContain('model-incompatible');
  });
});

// ---------------------------------------------------------------------------
// AC1/AC3 — the retry is BOUNDED but real: a failure that recovers within the
// cap advances instead of scrapping.
// ---------------------------------------------------------------------------

describe('WI-566 — bounded retry actually retries and can recover', () => {
  it('retries after a first-attempt failure and advances when the second attempt succeeds', async () => {
    db = openDb();
    // Attempt 1 writes schema-invalid output; attempt 2 writes a valid output.
    const { adapter, calls } = makeScriptedHarness([{ kind: 'invalid' }, { kind: 'ok' }]);
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { maxAttempts: 2 });
    seedCoderCard(db);

    await run(flow, registry);

    // Invoked twice (retry), and the recovered attempt advanced the card.
    expect(calls).toHaveLength(2);
    expect(getCard(db)?.lane).toBe('done');
    // The successful attempt wrote a checkpoint.
    expect(coderCheckpoint(db)).not.toBeNull();
  });

  it('retries after an idle-timeout attempt and advances when the second attempt succeeds (issue #31)', async () => {
    db = openDb();
    const { adapter, calls } = makeScriptedHarness([
      { kind: 'throw', code: 'harness-idle-timeout', message: 'claude-headless: invocation produced no output for longer than the idle timeout and was killed' },
      { kind: 'ok' },
    ]);
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { maxAttempts: 2 });
    seedCoderCard(db);

    await run(flow, registry);

    // Spent an execution attempt and retried — not a park, which would never
    // reach a second invocation without a release_at gate elapsing.
    expect(calls).toHaveLength(2);
    expect(getCard(db)?.lane).toBe('done');
    expect(coderCheckpoint(db)).not.toBeNull();
  });

  it('honors a larger attempt cap — retries up to max_execution_attempts before scrapping', async () => {
    db = openDb();
    const { adapter, calls } = makeScriptedHarness({ kind: 'unparseable' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { maxAttempts: 3 });
    seedCoderCard(db);

    await run(flow, registry);

    // Three invocations for a cap of three, then scrap — the count tracks the cap.
    expect(calls).toHaveLength(3);
    expect(getCard(db)?.lane).toBe('scrap');
    expect(terminalReasons(db).some((r) => /harness-output-unparseable/i.test(r))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loud-beats-silent — even an UNTAGGED adapter throw scraps (never advances,
// never a silent zero-outcome), so an unrecognized failure can't slip through.
// ---------------------------------------------------------------------------

describe('WI-566 — an untagged invocation failure still fails loud', () => {
  it('scraps on an adapter throw carrying no error code (generic invocation failure)', async () => {
    db = openDb();
    const { adapter } = makeScriptedHarness({ kind: 'throw', message: 'claude-headless: something unexpected' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(projectDir, registry, { maxAttempts: 2 });
    seedCoderCard(db);

    await run(flow, registry);

    const card = getCard(db);
    expect(card?.lane).toBe('scrap');
    expect(card?.status).toBe('scrapped');
    // A named terminal reason is recorded — never a silent advance.
    expect(getCard(db)?.lane).not.toBe('done');
    expect(terminalReasons(db).length).toBeGreaterThan(0);
  });
});
