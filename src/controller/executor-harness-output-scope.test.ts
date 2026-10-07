/**
 * Card-scoped declared outputs for harness stations (issue #98).
 *
 * Fan-out children share one station definition. Before this change a harness
 * station's declared outputs always resolved under projectRoot, so sibling
 * children (Shakedown walkers, A(i)-Team item workers) would write one shared
 * `result.json` and each would collect whatever the last writer left there.
 * `output_scope: owned_dir` moves the outputs into the card's `owned_paths[0]`.
 *
 * These tests drive the REAL loader and runExecutor. Only the harness adapter
 * (and, where a downstream transform or critic runs, the model adapter) is a
 * fake. The fake maker learns where to write from the PROMPT the kernel sends,
 * which is how a real agent learns it, and the tests check that
 * `HarnessInvocation.declaredOutputs` names the same paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, getIntentStatus, readCheckpoint } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter, ModelCall } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessRegistry,
} from '../worker/harness-adapter';

const SECONDS = (n: number) => () => n;
const io = { out: (_l: string) => {}, err: (_l: string) => {} };
const noSleep = async (_ms: number): Promise<void> => {};

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

/** The check id a child's seed names, read back out of the rendered prompt. */
function checkFromPrompt(prompt: string): string {
  const m = /"check":\s*"([^"]+)"/.exec(prompt);
  if (!m) throw new Error(`no check id in prompt: ${prompt}`);
  return m[1]!;
}

/** The path the kernel told the agent to write `name` to, read from the prompt. */
function outputPathFromPrompt(prompt: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^- ${escaped}: (.+)$`, 'm').exec(prompt);
  return m?.[1];
}

type MakerBehaviour = (call: HarnessInvocation, nthCallForCheck: number) => 'valid' | 'invalid' | 'none';

/**
 * A fake harness maker. For each invoke it writes `result.json` at the path
 * the prompt names (falling back to `declaredOutputs` for an unscoped station),
 * with bytes unique to the child, unless `behaviour` says otherwise.
 */
function makeWalker(behaviour: MakerBehaviour = () => 'valid'): {
  adapter: HarnessAdapter;
  calls: HarnessInvocation[];
  sawAtInvoke: Array<{ check: string; existed: boolean }>;
} {
  const calls: HarnessInvocation[] = [];
  const sawAtInvoke: Array<{ check: string; existed: boolean }> = [];
  const perCheck = new Map<string, number>();
  const adapter: HarnessAdapter = {
    name: 'fake-walker',
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      const check = checkFromPrompt(call.prompt);
      const n = (perCheck.get(check) ?? 0) + 1;
      perCheck.set(check, n);
      const target =
        outputPathFromPrompt(call.prompt, 'result.json') ??
        call.declaredOutputs?.find((o) => o.name === 'result.json')?.path;
      if (target === undefined) throw new Error('walker was not told where to write result.json');
      sawAtInvoke.push({ check, existed: existsSync(target) });
      const mode = behaviour(call, n);
      if (mode === 'valid') {
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, JSON.stringify({ verdict: `pass-${check}`, attempt: n }), 'utf-8');
      } else if (mode === 'invalid') {
        writeFileSync(target, 'not json at all', 'utf-8');
      }
      return { outputs: [{ name: 'result.json', path: target }], usage: { tokens: 10, cost: 0.01 } };
    },
  };
  return { adapter, calls, sawAtInvoke };
}

/** Records every model call; answers critics with pass and summaries with text. */
function makeModel(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return {
    calls,
    adapter: {
      async call(req: ModelCall) {
        calls.push(req);
        if (req.model === 'critic-model') {
          return { text: JSON.stringify({ verdict: 'pass', findings: [] }), inputTokens: 1, outputTokens: 1, costUsd: 0 };
        }
        return { text: JSON.stringify({ summary: 'ok' }), inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    },
  };
}

interface FlowOpts {
  scope?: 'owned_dir' | 'project_root' | null;
  /** Add a downstream transform that reads result.json from the card dir. */
  downstream?: boolean;
  /** Gate the walker with a transform critic that quotes result.json. */
  critic?: boolean;
  /** Gate the walker with a harness (agentic) critic instead. */
  harnessCritic?: boolean;
  effectful?: boolean;
  outputs?: string;
  maxAttempts?: number;
}

function writeFlow(dir: string, registry: HarnessRegistry, opts: FlowOpts = {}): FlowConfig {
  const scope = opts.scope === undefined ? 'owned_dir' : opts.scope;
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'walk.md'), 'Walk check: {{seed.json}}');
  writeFileSync(join(dir, 'prompts', 'summarize.md'), 'Summarize: {{result.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Verify: {{result.json}}');
  const next = opts.downstream ? 'summarize' : 'done';
  const yaml = `
flow: harness-output-scope
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: ${opts.maxAttempts ?? 2} }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: walk
${opts.effectful ? '    effectful: true\n' : ''}    worker:
      kind: harness
      harness: fake-walker
      model: sonnet
      prompt_file: prompts/walk.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: verdict, type: string, required: true }
    inputs: [seed.json]
    outputs: ${opts.outputs ?? '[result.json]'}
${scope !== null ? `    output_scope: ${scope}\n` : ''}    next: ${next}
${
  opts.harnessCritic
    ? `    check:
      kind: gate
      critic: { role: critic, harness: fake-critic, tools: [Read, Write], prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: walk
      rework_cap: 2
`
    : ''
}${
  opts.critic
    ? `    check:
      kind: gate
      critic: { role: critic, model: critic-model, prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: walk
      rework_cap: 2
`
    : ''
}${
  opts.downstream
    ? `  - id: summarize
    worker:
      kind: transform
      model: summary-model
      prompt_file: prompts/summarize.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [result.json]
    input_scope:
      owned_dir: [result.json]
    outputs: [summary.json]
    output_scope: owned_dir
    next: done
`
    : ''
}`;
  writeFileSync(join(dir, 'flow.yaml'), yaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** Seed a child card whose owned dir holds its own seed.json. */
function seedChild(db: ConduitDB, dir: string, check: string, opts: { ownedPaths?: string[]; makeDir?: boolean } = {}) {
  const owned = opts.ownedPaths ?? [`evidence/${check}`];
  if (opts.makeDir !== false && owned[0] !== undefined && !owned[0].startsWith('/')) {
    mkdirSync(join(dir, owned[0]), { recursive: true });
    writeFileSync(join(dir, owned[0], 'seed.json'), JSON.stringify({ check }), 'utf-8');
  }
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: check, parent_id: null, lane: 'walk', status: 'ready',
    attempt: 0, wave: 0, owned_paths: owned, rework_count: 0,
  });
}

async function run(db: ConduitDB, flow: FlowConfig, registry: HarnessRegistry, model: ModelAdapter, at = 1000) {
  await runExecutor({
    db, flow, now: SECONDS(at), adapter: model, io, harnessRegistry: registry, sleep: noSleep,
  } as RunEngineArgs);
}

function checkpointPayload(db: ConduitDB, card: string, station = 'walk'): unknown {
  return readCheckpoint(db.getStateDb(), { run: DEFAULT_RUN_ID, flow: '1', card, station, attempt: 0 })?.output.payload;
}

function terminalReasons(db: ConduitDB, card: string): string {
  return db.getCardLog(card)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason)
    .join(' | ');
}

function harnessSpans(db: ConduitDB, card: string) {
  return db.getJournalSpansForRun(DEFAULT_RUN_ID, card).filter((s) => s.name === "walk.harness");
}

function resetToWalk(db: ConduitDB): void {
  db.getStateDb().prepare("UPDATE cards SET lane = 'walk', status = 'ready'").run();
}

let originalCwd: string;
let dir: string;
let db: ConduitDB;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-output-scope-'));
  process.chdir(dir);
  db = openDb();
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('harness output_scope: owned_dir — sibling children (issue #98)', () => {
  it('each sibling writes and collects its own result under its own owned dir', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');

    await run(db, flow, registry, makeModel().adapter);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    expect(walker.calls.length).toBe(2);

    // Different bytes in different dirs, and nothing at the old shared path.
    const c1Bytes = readFileSync(join(dir, 'evidence', 'c1', 'result.json'), 'utf-8');
    const c2Bytes = readFileSync(join(dir, 'evidence', 'c2', 'result.json'), 'utf-8');
    expect(JSON.parse(c1Bytes).verdict).toBe('pass-c1');
    expect(JSON.parse(c2Bytes).verdict).toBe('pass-c2');
    expect(existsSync(join(dir, 'result.json'))).toBe(false);

    // Each checkpoint collected its own child's payload.
    expect((checkpointPayload(db, 'c1') as { verdict: string }).verdict).toBe('pass-c1');
    expect((checkpointPayload(db, 'c2') as { verdict: string }).verdict).toBe('pass-c2');

    // The artifact hash on each success span is the hash of that child's file.
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const hashOf = (card: string) =>
      (harnessSpans(db, card).find((s) => s.attributes?.outcome === 'success')?.attributes?.artifact_hashes as
        | Record<string, string>
        | undefined)?.['result.json'];
    expect(hashOf('c1')).toBe(sha(c1Bytes));
    expect(hashOf('c2')).toBe(sha(c2Bytes));
  });

  it('tells the harness where to write: in the prompt and on declaredOutputs', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');

    await run(db, flow, registry, makeModel().adapter);

    const call = walker.calls[0]!;
    const expected = join(dir, 'evidence', 'c1', 'result.json');
    expect(outputPathFromPrompt(call.prompt, 'result.json')).toBe(expected);
    expect(call.declaredOutputs).toEqual([{ name: 'result.json', path: expected }]);
  });

  it('a downstream station reads each child result through input_scope.owned_dir', async () => {
    const walker = makeWalker();
    const model = makeModel();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry, { downstream: true });
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');

    await run(db, flow, registry, model.adapter);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    const summaryPrompts = model.calls.filter((c) => c.model === 'summary-model').map((c) => c.prompt);
    expect(summaryPrompts.length).toBe(2);
    expect(summaryPrompts.filter((p) => p.includes('pass-c1')).length).toBe(1);
    expect(summaryPrompts.filter((p) => p.includes('pass-c2')).length).toBe(1);
    expect(existsSync(join(dir, 'evidence', 'c1', 'summary.json'))).toBe(true);
    expect(existsSync(join(dir, 'evidence', 'c2', 'summary.json'))).toBe(true);
  });

  it("the gate critic reads the child's own output, not a project-root file", async () => {
    const walker = makeWalker();
    const model = makeModel();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry, { critic: true });
    // A decoy at the old shared path: a critic reading project root would quote it.
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ verdict: 'DECOY' }));
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');

    await run(db, flow, registry, model.adapter);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    const criticPrompts = model.calls.filter((c) => c.model === 'critic-model').map((c) => c.prompt);
    expect(criticPrompts.length).toBe(2);
    expect(criticPrompts.some((p) => p.includes('DECOY'))).toBe(false);
    expect(criticPrompts.filter((p) => p.includes('pass-c1')).length).toBe(1);
    expect(criticPrompts.filter((p) => p.includes('pass-c2')).length).toBe(1);
  });
});

describe('harness output_scope: owned_dir — agentic critic mounts (issue #98)', () => {
  it("mounts the child's own output for a harness critic", async () => {
    const walker = makeWalker();
    const criticCalls: HarnessInvocation[] = [];
    const critic: HarnessAdapter = {
      name: 'fake-critic',
      reportsUsage: true,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke(call: HarnessInvocation) {
        criticCalls.push(call);
        writeFileSync(join(process.cwd(), 'verdict.json'), JSON.stringify({ verdict: 'pass', findings: [] }));
        return { outputs: [], usage: { tokens: 1, cost: 0 } };
      },
    };
    const registry = createHarnessRegistry([walker.adapter, critic]);
    const flow = writeFlow(dir, registry, { harnessCritic: true });
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');

    await run(db, flow, registry, makeModel().adapter);

    expect(criticCalls.length).toBe(2);
    const mounted = criticCalls.map((c) => c.inputs.find((m) => m.name === 'result.json')?.path).sort();
    expect(mounted).toEqual([
      join(dir, 'evidence', 'c1', 'result.json'),
      join(dir, 'evidence', 'c2', 'result.json'),
    ]);
    // The critic prompt quotes the same file it mounts.
    expect(criticCalls.filter((c) => c.prompt.includes('pass-c1')).length).toBe(1);
  });
});

describe('harness output_scope: owned_dir — freshness and retry (issue #98)', () => {
  it('does not accept a stale result left in the owned dir when the harness writes nothing', async () => {
    const walker = makeWalker(() => 'none');
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');
    writeFileSync(join(dir, 'evidence', 'c1', 'result.json'), JSON.stringify({ verdict: 'STALE' }));

    await run(db, flow, registry, makeModel().adapter);

    // The stale file was removed before the invoke, so the harness saw no file.
    expect(walker.sawAtInvoke.every((s) => !s.existed)).toBe(true);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('scrap');
    expect(terminalReasons(db, 'c1')).toMatch(/harness-output-missing: result\.json/);
    expect(checkpointPayload(db, 'c1')).toBeUndefined();
  });

  it("does not accept a sibling's result or a project-root file of the same name", async () => {
    const walker = makeWalker((call) => (checkFromPrompt(call.prompt) === 'c2' ? 'none' : 'valid'));
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ verdict: 'ROOT' }));
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');

    await run(db, flow, registry, makeModel().adapter);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('scrap');
    expect(terminalReasons(db, 'c2')).toMatch(/harness-output-missing/);
  });

  it("removes a failed attempt's output before the retry, so the retry must write its own", async () => {
    // Attempt 1 writes unparseable bytes; attempt 2 writes nothing. Without the
    // removal, attempt 2 would re-read attempt 1's file and fail as unparseable.
    const walker = makeWalker((_c, n) => (n === 1 ? 'invalid' : 'none'));
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');

    await run(db, flow, registry, makeModel().adapter);

    expect(walker.calls.length).toBe(2);
    expect(walker.sawAtInvoke.map((s) => s.existed)).toEqual([false, false]);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('scrap');
    const outcomes = harnessSpans(db, 'c1').map((s) => String(s.attributes?.outcome));
    expect(outcomes[0]).toMatch(/harness-output-unparseable/);
    expect(outcomes[1]).toMatch(/harness-output-missing/);
  });

  it('a retry that writes a valid result succeeds with that attempt’s bytes', async () => {
    const walker = makeWalker((_c, n) => (n === 1 ? 'invalid' : 'valid'));
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');

    await run(db, flow, registry, makeModel().adapter);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(checkpointPayload(db, 'c1')).toEqual({ verdict: 'pass-c1', attempt: 2 });
  });
});

describe('harness output_scope: owned_dir — invalid owned dirs fail closed (issue #98)', () => {
  async function expectHeldUninvoked(walker: ReturnType<typeof makeWalker>, pattern: RegExp) {
    expect(walker.calls.length).toBe(0);
    const card = db.getCard(DEFAULT_RUN_ID, 'c1');
    expect(card?.lane).toBe('hold');
    expect(card?.status).toBe('held');
    expect(terminalReasons(db, 'c1')).toMatch(/could not resolve its declared outputs/);
    expect(terminalReasons(db, 'c1')).toMatch(pattern);
  }

  it('holds a card with no owned_paths without invoking the harness', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    // A prompt with no seed placeholder, so render succeeds and the output check is what fires.
    const flow = writeFlow(dir, registry);
    writeFileSync(join(dir, 'prompts', 'walk.md'), 'Walk.');
    seedChild(db, dir, 'c1', { ownedPaths: [] });

    await run(db, flow, registry, makeModel().adapter);
    await expectHeldUninvoked(walker, /has no owned_paths/);
  });

  it('holds a card whose owned dir does not exist', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    writeFileSync(join(dir, 'prompts', 'walk.md'), 'Walk.');
    seedChild(db, dir, 'c1', { ownedPaths: ['evidence/missing'], makeDir: false });

    await run(db, flow, registry, makeModel().adapter);
    await expectHeldUninvoked(walker, /existing directory/);
  });

  it('holds a card whose owned dir is outside the project root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'conduit-outside-'));
    try {
      writeFileSync(join(outside, 'seed.json'), JSON.stringify({ check: 'c1' }));
      const walker = makeWalker();
      const registry = createHarnessRegistry([walker.adapter]);
      const flow = writeFlow(dir, registry);
      seedChild(db, dir, 'c1', { ownedPaths: [outside], makeDir: false });

      await run(db, flow, registry, makeModel().adapter);
      await expectHeldUninvoked(walker, /inside the project root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('holds a card whose declared output escapes its owned dir through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'conduit-outside-'));
    try {
      const walker = makeWalker();
      const registry = createHarnessRegistry([walker.adapter]);
      const flow = writeFlow(dir, registry, { outputs: '[evidence/result.json]' });
      seedChild(db, dir, 'c1');
      symlinkSync(outside, join(dir, 'evidence', 'c1', 'evidence'));

      await run(db, flow, registry, makeModel().adapter);
      await expectHeldUninvoked(walker, /resolves outside the owned directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('discards the pending outbox intent of an effectful station it holds before invoking', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry, { effectful: true });
    seedChild(db, dir, 'c1', { ownedPaths: ['evidence/missing'], makeDir: false });
    writeFileSync(join(dir, 'prompts', 'walk.md'), 'Walk.');

    await run(db, flow, registry, makeModel().adapter);

    expect(walker.calls.length).toBe(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('hold');
    expect(getIntentStatus(db.getStateDb(), '1:c1:walk:0')).toBe('none');
  });
});

describe('harness output_scope: owned_dir — resume (issue #98)', () => {
  it('skips every child on resume when nothing changed', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');
    await run(db, flow, registry, makeModel().adapter);
    expect(walker.calls.length).toBe(2);

    resetToWalk(db);
    await run(db, flow, registry, makeModel().adapter, 2000);

    expect(walker.calls.length).toBe(2);
    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    expect((checkpointPayload(db, 'c1') as { verdict: string }).verdict).toBe('pass-c1');
    expect((checkpointPayload(db, 'c2') as { verdict: string }).verdict).toBe('pass-c2');
  });

  it("re-runs only the child whose input changed", async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry);
    seedChild(db, dir, 'c1');
    seedChild(db, dir, 'c2');
    await run(db, flow, registry, makeModel().adapter);
    expect(walker.calls.length).toBe(2);

    writeFileSync(join(dir, 'evidence', 'c2', 'seed.json'), JSON.stringify({ check: 'c2', retry: true }));
    resetToWalk(db);
    await run(db, flow, registry, makeModel().adapter, 2000);

    expect(walker.calls.length).toBe(3);
    expect(checkFromPrompt(walker.calls[2]!.prompt)).toBe('c2');
    // c1's file and checkpoint are untouched; c2's were rewritten by the new call.
    expect(JSON.parse(readFileSync(join(dir, 'evidence', 'c1', 'result.json'), 'utf-8'))).toEqual({
      verdict: 'pass-c1', attempt: 1,
    });
    expect(checkpointPayload(db, 'c2')).toEqual({ verdict: 'pass-c2', attempt: 2 });
  });
});

describe('harness output_scope default — project root unchanged (issue #98)', () => {
  it('collects from projectRoot, adds nothing to the prompt, and leaves a prior file in place', async () => {
    const walker = makeWalker();
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = writeFlow(dir, registry, { scope: null });
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ verdict: 'PRIOR' }));
    seedChild(db, dir, 'c1', { ownedPaths: ['evidence/c1', 'result.json'] });

    await run(db, flow, registry, makeModel().adapter);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    const call = walker.calls[0]!;
    expect(call.prompt).toBe('Walk check: {"check":"c1"}');
    expect(call.declaredOutputs).toEqual([{ name: 'result.json', path: join(dir, 'result.json') }]);
    // Freshness removal applies to card-scoped outputs only.
    expect(walker.sawAtInvoke[0]!.existed).toBe(true);
    expect((checkpointPayload(db, 'c1') as { verdict: string }).verdict).toBe('pass-c1');
  });
});
