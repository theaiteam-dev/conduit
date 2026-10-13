/**
 * Mandatory owned-paths integrity gate for harness stations (WI-568, FR-9).
 *
 * Boundary integrity is the load-bearing containment control for this
 * weaker-than-Law kind. Unlike the transform path (whose integrity check is
 * gated by flow.defaults.enforce_owned_paths), a kind:harness station runs the
 * owned-paths integrity check UNCONDITIONALLY — it is NOT disableable. A harness
 * whose declared output resolves OUTSIDE the card's owned_paths (a plain write
 * outside, or a symlink that launders an escape) hard-pauses the card to `hold`,
 * naming the offending path, and never advances. Path-resolution ambiguity fails
 * closed. Reuses src/worker/integrity.ts checkIntegrity AS-IS (via the executor's
 * runOwnedPathsIntegrity), the same symlink-canonical resolveOwnedPath/isContainedIn
 * the transform/deterministic paths use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
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

const SECONDS = (n: number) => () => n;

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness maker');
  },
};

const io = { out: (_l: string) => {}, err: (_l: string) => {} };

// ---------------------------------------------------------------------------
// A fake harness that writes its declared output 'work/result.json' either as a
// plain file or as a symlink escaping to a directory OUTSIDE the project root.
// ---------------------------------------------------------------------------

const OUTPUT_REL = 'work/result.json';

function makeHarness(
  opts: {
    writeMode?: 'plain' | 'symlink-escape';
    escapeDir?: string;
    rogueRel?: string;
    // When set, delete this existing file (relative to the project root).
    deleteRel?: string;
    // Controls the DECLARED output's validity (plain writeMode only). 'valid'
    // writes schema-conformant JSON; 'invalid' writes unparseable text; 'missing'
    // writes no declared output at all. Lets a test pair a rogue write with a
    // FAILING output so the integrity gate must fire before the output-validity
    // branches (Finding 6).
    outputMode?: 'valid' | 'invalid' | 'missing';
  } = {},
): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const writeMode = opts.writeMode ?? 'plain';
  const outputMode = opts.outputMode ?? 'valid';
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
      const outAbs = join(process.cwd(), OUTPUT_REL);
      mkdirSync(dirname(outAbs), { recursive: true });
      if (writeMode === 'symlink-escape') {
        // A valid JSON file OUTSIDE the project root; the declared output is a
        // symlink to it — canonical resolution must catch the escape.
        const target = join(opts.escapeDir!, 'target.json');
        mkdirSync(opts.escapeDir!, { recursive: true });
        writeFileSync(target, JSON.stringify({ summary: 'ok' }), 'utf-8');
        symlinkSync(target, outAbs);
      } else if (outputMode === 'missing') {
        // Writes no declared output — the missing-declared-output failure class.
      } else if (outputMode === 'invalid') {
        writeFileSync(outAbs, 'this is not json <<<', 'utf-8');
      } else {
        writeFileSync(outAbs, JSON.stringify({ summary: 'ok' }), 'utf-8');
      }
      // A harness CLI has raw Read/Write/Bash bounded only by projectRoot — it can
      // write UNDECLARED files anywhere. When set, drop one such rogue file.
      if (opts.rogueRel !== undefined) {
        const rogueAbs = join(process.cwd(), opts.rogueRel);
        mkdirSync(dirname(rogueAbs), { recursive: true });
        writeFileSync(rogueAbs, 'rogue content the card never declared', 'utf-8');
      }
      if (opts.deleteRel !== undefined) rmSync(join(process.cwd(), opts.deleteRel));
      return { outputs: [], usage: { tokens: 10, cost: 0.01 } };
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Flow fixture — one `coder` harness station producing work/result.json.
// enforceOwnedPaths is set explicitly (default false) to prove the harness gate
// is INDEPENDENT of the transform opt-in flag.
// ---------------------------------------------------------------------------

function writeHarnessFlow(dir: string, registry: HarnessRegistry, opts: { enforceOwnedPaths?: boolean } = {}): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'TASK: {{task.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');

  const enforceLine = opts.enforceOwnedPaths === undefined
    ? ''
    : `\ndefaults: { enforce_owned_paths: ${opts.enforceOwnedPaths} }`;

  const flowYaml = `
flow: harness-integrity
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]${enforceLine}
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
    outputs: [work/result.json]
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, ownedPaths: string[]): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ownedPaths, rework_count: 0,
  });
}

const getCard = (db: ConduitDB) => db.getCard(DEFAULT_RUN_ID, 'entry');

const coderCheckpoint = (db: ConduitDB) =>
  readCheckpoint(db.getStateDb(), { run: DEFAULT_RUN_ID, flow: '1', card: 'entry', station: 'coder', attempt: 0 });

function terminalReasons(db: ConduitDB): string[] {
  return db.getCardLog('entry')
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason);
}

let originalCwd: string;
let dir: string;
let escapeDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-integrity-'));
  escapeDir = mkdtempSync(join(tmpdir(), 'conduit-harness-escape-'));
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  if (db) { db.close(); db = null; }
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(escapeDir, { recursive: true, force: true });
});

async function run(flow: FlowConfig, registry: HarnessRegistry): Promise<void> {
  await runExecutor({ db: db!, flow, now: SECONDS(1000), adapter: throwingModel, io, harnessRegistry: registry } as RunEngineArgs);
}

// ---------------------------------------------------------------------------
// AC1 + AC2 — a write outside owned_paths hard-pauses to hold, UNCONDITIONALLY
// (even with enforce_owned_paths explicitly false), naming the path.
// ---------------------------------------------------------------------------

describe('WI-568 AC1/AC2 — a harness write outside owned_paths hard-pauses to hold', () => {
  it('holds (does not advance) on an escaping write even when enforce_owned_paths is false', async () => {
    db = openDb();
    const { adapter } = makeHarness({ writeMode: 'plain' });
    const registry = createHarnessRegistry([adapter]);
    // The gate is MANDATORY for harness — explicitly disabling the transform flag
    // must NOT disable it.
    const flow = writeHarnessFlow(dir, registry, { enforceOwnedPaths: false });
    // The card owns only task.json — work/result.json is OUTSIDE owned_paths.
    seedCard(db, ['task.json']);

    await run(flow, registry);

    // Hard-paused to hold, NOT advanced, NOT scrapped.
    expect(getCard(db)?.lane).toBe('hold');
    expect(getCard(db)?.lane).not.toBe('done');
    // The hold reason names the integrity violation and the offending path.
    const reasons = terminalReasons(db).join(' | ');
    expect(reasons).toMatch(/integrity/i);
    expect(reasons).toMatch(/owned_paths/i);
    expect(reasons).toContain('work/result.json');
    // A breached attempt is not skip-replayed on resume.
    expect(coderCheckpoint(db)).toBeNull();
  });

  it('holds on an escaping write when the flow declares no defaults block at all (mandatory)', async () => {
    db = openDb();
    const { adapter } = makeHarness({ writeMode: 'plain' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry); // no defaults block → gate still runs
    seedCard(db, ['task.json']);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('hold');
    expect(coderCheckpoint(db)).toBeNull();
  });

  it('releases the active_workers slot when the card holds (review #2 — no WIP-slot leak)', async () => {
    // Before the fix, escalateToHold froze the card but left its active_workers
    // row behind; reconcile only reclaims status='working' cards, so the held
    // card permanently consumed a WIP slot — at wip:1 a sibling card could
    // never claim the station, and the stale row kept the liveness watchdog
    // from tripping (activeWorkerCount > 0), hanging the run until the
    // wall-clock andon.
    db = openDb();
    const { adapter } = makeHarness({ writeMode: 'plain' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    seedCard(db, ['task.json']);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('hold');
    const slots = db.getStateDb()
      .prepare('SELECT COUNT(*) AS n FROM active_workers WHERE run_id = $runId')
      .get({ $runId: DEFAULT_RUN_ID }) as { n: number };
    expect(slots.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 (regression) — a valid DECLARED output does not launder an UNDECLARED
// rogue write outside owned_paths. The gate must diff the FULL touched-set, not
// just the declared output names — a harness CLI writes with raw Read/Write/Bash
// bounded only by projectRoot, so an undeclared escape must still hard-pause.
// ---------------------------------------------------------------------------

describe('WI-568 AC2 — an undeclared rogue write outside owned_paths hard-pauses to hold', () => {
  it('holds even when the declared output is valid and within owned_paths but a rogue file escapes', async () => {
    db = openDb();
    // The declared output work/result.json is written correctly AND within owned;
    // a rogue undeclared file is also written at the project root, outside owned.
    const { adapter } = makeHarness({ writeMode: 'plain', rogueRel: 'rogue.txt' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    // The card owns task.json + the work dir (so the declared output passes) but
    // NOT the project root — rogue.txt at the root is an undeclared escape.
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    // The valid declared output must NOT launder the rogue write into a pass.
    expect(getCard(db)?.lane).toBe('hold');
    expect(getCard(db)?.lane).not.toBe('done');
    const reasons = terminalReasons(db).join(' | ');
    expect(reasons).toMatch(/integrity/i);
    expect(reasons).toContain('rogue.txt');
    expect(coderCheckpoint(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finding 6 (RetroLearning row 6) — the integrity gate must fire on EVERY
// resolved attempt, BEFORE the output-validity branches. A harness that both
// escapes owned_paths AND returns malformed/missing output must hard-pause to
// hold on the breach, never scrap on cap-exhaustion with the breach undetected.
// ---------------------------------------------------------------------------

describe('Finding 6 — an escaping write is caught even when the same attempt returns invalid output', () => {
  it('holds on the rogue write (never scraps on invalid-output) when output is UNPARSEABLE', async () => {
    db = openDb();
    // Declared output is written but UNPARSEABLE, and a rogue file escapes owned.
    // Old order (output-validity first) scrapped on 'harness-output-unparseable'
    // and folded the rogue write into the next attempt's baseline — never held.
    const { adapter, calls } = makeHarness({ outputMode: 'invalid', rogueRel: 'rogue.txt' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    // Owns task.json + the work dir (declared output is contained) but NOT the
    // project root — rogue.txt at the root is the escaping write.
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    // Hard-paused to hold on the containment breach — NOT scrapped on the
    // invalid-output class, NOT advanced.
    expect(getCard(db)?.lane).toBe('hold');
    expect(getCard(db)?.lane).not.toBe('scrap');
    const reasons = terminalReasons(db).join(' | ');
    expect(reasons).toMatch(/integrity/i);
    expect(reasons).toContain('rogue.txt');
    // Caught on the FIRST attempt — the breach never survives to a retry.
    expect(calls).toHaveLength(1);
    expect(coderCheckpoint(db)).toBeNull();
  });

  it('holds on the rogue write (never scraps on missing-output) when the declared output is MISSING', async () => {
    db = openDb();
    const { adapter, calls } = makeHarness({ outputMode: 'missing', rogueRel: 'rogue.txt' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('hold');
    expect(getCard(db)?.lane).not.toBe('scrap');
    const reasons = terminalReasons(db).join(' | ');
    expect(reasons).toMatch(/integrity/i);
    expect(reasons).toContain('rogue.txt');
    expect(calls).toHaveLength(1);
    expect(coderCheckpoint(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finding 7 (RetroLearning row 7) — an EMPTY owned_paths set must NOT silently
// disable the "unconditional" harness gate. For a harness nothing is a legal
// write target, so ANY file the harness touches is a containment breach.
// ---------------------------------------------------------------------------

describe('Finding 7 — empty owned_paths is fail-closed for a harness (never a silent pass)', () => {
  it('holds (does not advance) when a harness with empty owned_paths touches any file', async () => {
    db = openDb();
    const { adapter } = makeHarness({ writeMode: 'plain' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    // Empty owned_paths: the shared runOwnedPathsIntegrity treats this as opt-out
    // and returns null, but the harness call site must fail closed — the harness
    // writes work/result.json, which is not a legal target of an empty owned set.
    seedCard(db, []);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('hold');
    expect(getCard(db)?.lane).not.toBe('done');
    expect(terminalReasons(db).join(' | ')).toMatch(/integrity/i);
    expect(coderCheckpoint(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 — a write entirely within owned_paths passes the gate and advances.
// ---------------------------------------------------------------------------

describe('WI-568 AC3 — a harness write within owned_paths advances normally', () => {
  it('advances the card to done when the declared output is within owned_paths', async () => {
    db = openDb();
    const { adapter } = makeHarness({ writeMode: 'plain' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    // The card owns the `work` directory, so work/result.json is contained.
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('done');
    // A clean attempt writes its checkpoint.
    expect(coderCheckpoint(db)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4 — an ambiguous/symlinked resolution fails closed to hold (the declared
// output is a symlink that escapes the owned directory).
// ---------------------------------------------------------------------------

describe('WI-568 AC4 — symlink-laundered escape fails closed to hold', () => {
  it('holds when the declared output is a symlink resolving outside owned_paths', async () => {
    db = openDb();
    const { adapter } = makeHarness({ writeMode: 'symlink-escape', escapeDir });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    // The card legitimately owns `work`, but the output symlink resolves OUT of it
    // — canonical resolution must catch the escape (never launder it into a pass).
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('hold');
    expect(getCard(db)?.lane).not.toBe('done');
    expect(terminalReasons(db).join(' | ')).toMatch(/integrity/i);
    expect(coderCheckpoint(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A delete is a write (SPEC §7). The tree diff used to walk only the
// after-snapshot, so a call whose only out-of-bounds action was an rm reached
// done. It is now checked against owned_paths like any other write.
// ---------------------------------------------------------------------------

describe('a harness delete is checked against owned_paths', () => {
  it('holds when the call deletes a file outside owned_paths', async () => {
    db = openDb();
    writeFileSync(join(dir, 'shared.txt'), 'not this card\'s file');
    const { adapter } = makeHarness({ writeMode: 'plain', deleteRel: 'shared.txt' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    expect(existsSync(join(dir, 'shared.txt'))).toBe(false);
    expect(getCard(db)?.lane).toBe('hold');
    const reasons = terminalReasons(db).join(' | ');
    expect(reasons).toMatch(/integrity/i);
    expect(reasons).toContain('path_escape');
    expect(reasons).toContain('shared.txt');
    expect(coderCheckpoint(db)).toBeNull();
  });

  it('holds when a card with no owned_paths deletes any file', async () => {
    db = openDb();
    writeFileSync(join(dir, 'shared.txt'), 'x');
    // outputMode 'missing' so the delete is the call's only change.
    const { adapter } = makeHarness({ writeMode: 'plain', outputMode: 'missing', deleteRel: 'shared.txt' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    seedCard(db, []);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('hold');
    expect(terminalReasons(db).join(' | ')).toContain('shared.txt');
  });

  it('advances when the call deletes a file inside owned_paths', async () => {
    db = openDb();
    mkdirSync(join(dir, 'work'), { recursive: true });
    writeFileSync(join(dir, 'work', 'scratch.txt'), 'old');
    const { adapter } = makeHarness({ writeMode: 'plain', deleteRel: 'work/scratch.txt' });
    const registry = createHarnessRegistry([adapter]);
    const flow = writeHarnessFlow(dir, registry);
    seedCard(db, ['task.json', 'work']);

    await run(flow, registry);

    expect(getCard(db)?.lane).toBe('done');
  });
});
