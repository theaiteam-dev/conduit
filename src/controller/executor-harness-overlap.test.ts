/**
 * Overlapping ungated harness calls under `--concurrency` (issue #30 step 3,
 * ADR-0012, SPEC §7 "Overlapping harness calls").
 *
 * These tests drive the REAL loader and runExecutor. Only the harness adapter
 * is a fake. It can hold every call at a barrier that opens only once a given
 * number of calls have started, which proves the calls overlapped: on the
 * serial path the second call could not start until the first returned, and
 * the barrier would time out instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** A barrier that opens when `n` callers have arrived, or after `timeoutMs`. */
function makeBarrier(n: number, timeoutMs = 3_000): { arrive: () => Promise<boolean> } {
  let count = 0;
  let open!: (byCount: boolean) => void;
  const opened = new Promise<boolean>((r) => {
    open = r;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    arrive() {
      count++;
      if (timer === null) timer = setTimeout(() => open(false), timeoutMs);
      if (count >= n) {
        clearTimeout(timer);
        open(true);
      }
      return opened;
    },
  };
}

function checkFromPrompt(prompt: string): string {
  const m = /"check":\s*"([^"]+)"/.exec(prompt);
  if (!m) throw new Error(`no check id in prompt: ${prompt}`);
  return m[1]!;
}

type Step = 'valid' | { throw: string; resetAtMs?: number; tokens?: number };

interface WalkerOpts {
  canGatePerCall?: boolean;
  /** Calls that must have started before any proceeds. 1 = no wait. */
  startBarrier?: number;
  /** Calls that must have written before any returns. Absent = no wait. */
  writeBarrier?: number;
  /** What the nth call (1-based) for a check does. Default 'valid'. */
  step?: (check: string, n: number) => Step;
  /** Extra writes a call makes before the write barrier (paths relative to the project root). */
  extraWrites?: (check: string) => string[];
  tokens?: (check: string) => number;
}

interface CallRecord {
  check: string;
  startedAt: number;
  endedAt: number;
  releasedByBarrier: boolean;
}

function makeWalker(root: () => string, opts: WalkerOpts = {}) {
  const calls: HarnessInvocation[] = [];
  const records: CallRecord[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const perCheck = new Map<string, number>();
  const start = makeBarrier(opts.startBarrier ?? 1);
  const written = opts.writeBarrier !== undefined ? makeBarrier(opts.writeBarrier) : undefined;
  const adapter: HarnessAdapter = {
    name: 'fake-walker',
    reportsUsage: true,
    canRestrictTools: true,
    ...(opts.canGatePerCall !== false ? { canGatePerCall: true } : {}),
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      const check = checkFromPrompt(call.prompt);
      const n = (perCheck.get(check) ?? 0) + 1;
      perCheck.set(check, n);
      const startedAt = Date.now();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const releasedByBarrier = await start.arrive();
        const step = opts.step?.(check, n) ?? 'valid';
        if (step !== 'valid') {
          records.push({ check, startedAt, endedAt: Date.now(), releasedByBarrier });
          throw Object.assign(new Error(`fake ${step.throw}`), {
            code: step.throw,
            ...(step.resetAtMs !== undefined ? { resetAtMs: step.resetAtMs } : {}),
            ...(step.tokens !== undefined ? { usage: { tokens: step.tokens, cost: 0 } } : {}),
          });
        }
        for (const out of call.declaredOutputs ?? []) {
          writeFileSync(out.path, JSON.stringify({ verdict: `pass-${check}` }), 'utf-8');
        }
        for (const rel of opts.extraWrites?.(check) ?? []) {
          const abs = join(root(), rel);
          mkdirSync(join(abs, '..'), { recursive: true });
          writeFileSync(abs, `written by ${check}`, 'utf-8');
        }
        if (written !== undefined) await written.arrive();
        // Hold the call open briefly so a serial run could not fake an overlap.
        await new Promise((r) => setTimeout(r, 20));
        records.push({ check, startedAt, endedAt: Date.now(), releasedByBarrier });
        return {
          outputs: (call.declaredOutputs ?? []).map((o) => ({ name: o.name, path: o.path })),
          usage: { tokens: opts.tokens?.(check) ?? 10, cost: 0.01 },
        };
      } finally {
        inFlight--;
      }
    },
  };
  return { adapter, calls, records, maxInFlight: () => maxInFlight };
}

interface FlowOpts {
  overlap?: boolean | string;
  enforce?: boolean;
  wip?: number;
  /** Add a second, serial harness station after walk. */
  settle?: boolean;
  maxTokens?: number;
  perWave?: string;
  extra?: string;
}

function flowYaml(opts: FlowOpts = {}): string {
  const overlap = opts.overlap === undefined ? true : opts.overlap;
  return `
flow: harness-overlap
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 600, max_tokens: ${opts.maxTokens ?? 1_000_000} }
  per_card: { max_execution_attempts: 3 }
  liveness: { no_progress_minutes: 600 }
${opts.perWave !== undefined ? `  per_wave: ${opts.perWave}\n` : ''}${
    opts.enforce === false ? '' : 'defaults:\n  enforce_owned_paths: true\n'
  }terminal_lanes: [done, scrap, hold]
stations:
  - id: walk
    wip: ${opts.wip ?? 3}
${overlap === null ? '' : `    overlap: ${String(overlap)}\n`}    worker:
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
    outputs: [result.json]
    output_scope: owned_dir
    next: ${opts.settle ? 'settle' : 'done'}
${opts.extra ?? ''}${
    opts.settle
      ? `  - id: settle
    worker:
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
    outputs: [settle.json]
    output_scope: owned_dir
    next: done
`
      : ''
  }`;
}

function writeFlow(yaml: string, registry: HarnessRegistry | undefined): ReturnType<typeof loadFlow> {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'walk.md'), 'Walk check: {{seed.json}}');
  writeFileSync(join(dir, 'flow.yaml'), yaml);
  return loadFlow(join(dir, 'flow.yaml'), registry !== undefined ? { harnessRegistry: registry } : {});
}

function loadOk(opts: FlowOpts, registry: HarnessRegistry | undefined): FlowConfig {
  const loaded = writeFlow(flowYaml(opts), registry);
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedChild(check: string, owned: string[] = [`evidence/${check}`], parentId: string | null = null): void {
  if (owned[0] !== undefined) {
    mkdirSync(join(dir, owned[0]), { recursive: true });
    writeFileSync(join(dir, owned[0], 'seed.json'), JSON.stringify({ check }), 'utf-8');
  }
  db.insertCard({
    run_id: DEFAULT_RUN_ID, id: check, parent_id: parentId, lane: 'walk', status: 'ready',
    attempt: 0, wave: 0, owned_paths: owned, rework_count: 0,
  });
}

function virtualClock(startSeconds = 1000) {
  let clock = startSeconds;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += Math.max(1, Math.ceil(ms / 1000));
    },
  };
}

async function run(
  flow: FlowConfig,
  registry: HarnessRegistry,
  concurrency: number,
  errLines: string[] = [],
): Promise<void> {
  const clock = virtualClock();
  await runExecutor({
    db, flow, now: clock.now, sleep: clock.sleep, adapter: throwingModel,
    io: { out: () => {}, err: (l: string) => errLines.push(l) },
    harnessRegistry: registry, concurrency,
  } as unknown as RunEngineArgs);
}

function spans(card: string, station = 'walk') {
  return db.getJournalSpansForRun(DEFAULT_RUN_ID, card).filter((s) => s.name === `${station}.harness`);
}

function lane(card: string): string | undefined {
  return db.getCard(DEFAULT_RUN_ID, card)?.lane;
}

function holdReasons(card: string): string {
  return db
    .getCardLog(card)
    .map((e) => JSON.stringify(e))
    .join('\n');
}

let originalCwd: string;
let dir: string;
let db: ConduitDB;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-harness-overlap-'));
  process.chdir(dir);
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The calls overlap, and each card collects its own output.
// ---------------------------------------------------------------------------

describe('overlap: true under --concurrency (ADR-0012)', () => {
  it('runs sibling harness calls at the same time, each collecting its own card-scoped output', async () => {
    const walker = makeWalker(() => dir, { startBarrier: 3 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) {
      expect(lane(c)).toBe('done');
      expect(JSON.parse(readFileSync(join(dir, 'evidence', c, 'result.json'), 'utf-8')).verdict).toBe(`pass-${c}`);
    }
    // The barrier opened because all three had started, not because it timed out.
    expect(walker.records.map((r) => r.releasedByBarrier)).toEqual([true, true, true]);
    expect(walker.maxInFlight()).toBe(3);
    // Every call started before any of them ended.
    const lastStart = Math.max(...walker.records.map((r) => r.startedAt));
    const firstEnd = Math.min(...walker.records.map((r) => r.endedAt));
    expect(lastStart).toBeLessThanOrEqual(firstEnd);

    for (const c of ['c1', 'c2', 'c3']) {
      const [s] = spans(c);
      expect(s?.attributes?.outcome).toBe('success');
      expect(s?.attributes?.concurrent).toBe(true);
      expect(typeof s?.attributes?.started_at_ms).toBe('number');
      // Ready cards not admitted to the batch: none.
      expect(s?.attributes?.ready_waiting).toBe(0);
    }
  });

  it('caps the batch at K: with --concurrency 2, at most two calls run at once', async () => {
    const walker = makeWalker(() => dir, { startBarrier: 2 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 2);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    expect(walker.maxInFlight()).toBe(2);
    // The card that did not fit waited, and its span counts it as such.
    const waiting = ['c1', 'c2'].map((c) => spans(c)[0]?.attributes?.ready_waiting);
    expect(waiting).toEqual([1, 1]);
  });

  it("caps the batch at the station's wip", async () => {
    const walker = makeWalker(() => dir, { startBarrier: 2 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({ wip: 2 }, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 4);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    expect(walker.maxInFlight()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Serial unless every condition holds.
// ---------------------------------------------------------------------------

describe('harness stations stay serial without overlap', () => {
  it('runs one call at a time when the station does not declare overlap', async () => {
    const walker = makeWalker(() => dir);
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({ overlap: null as unknown as boolean }, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    expect(walker.maxInFlight()).toBe(1);
    for (const c of ['c1', 'c2', 'c3']) {
      const attrs = spans(c)[0]?.attributes ?? {};
      expect(attrs.concurrent).toBeUndefined();
      expect(attrs.started_at_ms).toBeUndefined();
      expect(attrs.overlap_fallback).toBeUndefined();
    }
  });

  it('runs one call at a time at --concurrency 1, even with overlap: true', async () => {
    const walker = makeWalker(() => dir);
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 1);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    expect(walker.maxInFlight()).toBe(1);
    for (const c of ['c1', 'c2', 'c3']) expect(spans(c)[0]?.attributes?.concurrent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Static conditions: rejected at load.
// ---------------------------------------------------------------------------

describe('overlap: load-time validation', () => {
  function errorsFor(yaml: string, registry?: HarnessRegistry): string[] {
    const loaded = writeFlow(yaml, registry);
    return loaded.ok ? [] : loaded.errors.filter((e) => e.code === 'INVALID_OVERLAP').map((e) => e.message);
  }
  const gating = () => createHarnessRegistry([makeWalker(() => dir).adapter]);

  it('accepts an eligible station', () => {
    expect(errorsFor(flowYaml({}), gating())).toEqual([]);
  });

  it('rejects a value that is not a boolean', () => {
    expect(errorsFor(flowYaml({ overlap: '"yes"' }), gating())[0]).toMatch(/is not true or false/);
  });

  it('rejects overlap on a station that is not kind: harness', () => {
    const yaml = flowYaml({
      extra: `  - id: other
    overlap: true
    worker: { kind: deterministic, command: "true" }
    next: done
`,
    });
    expect(errorsFor(yaml, gating()).join('\n')).toMatch(/'other' sets overlap but is kind=deterministic/);
  });

  it('rejects a gated station', () => {
    const yaml = flowYaml({}).replace(
      '    next: done\n',
      `    next: done
    check:
      kind: gate
      critic: { role: critic, model: m, prompt_file: prompts/walk.md, prompt_version: "1" }
      on_reject: walk
      rework_cap: 1
`,
    );
    expect(errorsFor(yaml, gating()).join('\n')).toMatch(/declares a check: block/);
  });

  it('rejects an effectful station', () => {
    const yaml = flowYaml({}).replace('    overlap: true\n', '    overlap: true\n    effectful: true\n');
    expect(errorsFor(yaml, gating()).join('\n')).toMatch(/is effectful/);
  });

  it('rejects a fan-out station', () => {
    const yaml = flowYaml({}).replace('    overlap: true\n', '    overlap: true\n    fan_out: 2\n');
    expect(errorsFor(yaml, gating()).join('\n')).toMatch(/is a fan-out station/);
  });

  it('rejects a station with a deliver: block', () => {
    const yaml = flowYaml({}).replace('    overlap: true\n', '    overlap: true\n    deliver: { files: [result.json] }\n');
    expect(errorsFor(yaml, gating()).join('\n')).toMatch(/declares a deliver: block/);
  });

  it('rejects a flow without defaults.enforce_owned_paths: true', () => {
    expect(errorsFor(flowYaml({ enforce: false }), gating()).join('\n')).toMatch(/enforce_owned_paths/);
  });

  it('rejects an adapter that cannot gate per call when the registry is known at load', () => {
    const registry = createHarnessRegistry([makeWalker(() => dir, { canGatePerCall: false }).adapter]);
    expect(errorsFor(flowYaml({}), registry).join('\n')).toMatch(/cannot gate each tool call/);
  });

  it('skips the adapter condition when no registry is injected at load', () => {
    expect(errorsFor(flowYaml({}))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic conditions: fall back to the serial path.
// ---------------------------------------------------------------------------

describe('overlap: dispatch fallbacks to the serial path', () => {
  it('runs serially, journaling why, when the adapter cannot gate per call at dispatch', async () => {
    const walker = makeWalker(() => dir, { canGatePerCall: false });
    const registry = createHarnessRegistry([walker.adapter]);
    // Loaded without a registry, so only the dispatch check can catch it.
    const flow = loadOk({}, undefined);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);
    const errLines: string[] = [];

    await run(flow, registry, 3, errLines);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    expect(walker.maxInFlight()).toBe(1);
    for (const c of ['c1', 'c2', 'c3']) {
      const attrs = spans(c)[0]?.attributes ?? {};
      expect(attrs.concurrent).toBeUndefined();
      expect(attrs.overlap_fallback).toBe("adapter 'fake-walker' cannot gate each tool call");
    }
    // Told once per station, not once per card.
    expect(errLines.filter((l) => l.includes('cannot gate each tool call'))).toHaveLength(1);
  });

  it('keeps a card with no owned_paths out of the batch; the serial rule then holds it', async () => {
    const walker = makeWalker(() => dir, { startBarrier: 2 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    seedChild('c1');
    seedChild('c2');
    seedChild('c3', []);

    await run(flow, registry, 3);

    expect(lane('c1')).toBe('done');
    expect(lane('c2')).toBe('done');
    expect(walker.records.filter((r) => r.check !== 'c3').map((r) => r.releasedByBarrier)).toEqual([true, true]);
    expect(walker.calls.some((c) => c.prompt.includes('"c3"'))).toBe(false);
    expect(lane('c3')).toBe('hold');
  });

  it('runs a card whose owned_paths overlap an admitted member after the batch, on the serial path', async () => {
    const walker = makeWalker(() => dir, { startBarrier: 2 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    seedChild('c1');
    seedChild('c2');
    seedChild('c3', ['evidence/c1/sub']);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    const rec = (c: string) => walker.records.find((r) => r.check === c)!;
    expect(rec('c1').releasedByBarrier).toBe(true);
    expect(rec('c2').releasedByBarrier).toBe(true);
    // c3 started only after both batch members had returned.
    expect(rec('c3').startedAt).toBeGreaterThanOrEqual(Math.max(rec('c1').endedAt, rec('c2').endedAt));
    const attrs = spans('c3')[0]?.attributes ?? {};
    expect(attrs.concurrent).toBeUndefined();
    expect(attrs.overlap_fallback).toBe("owned_paths overlap those of card 'c1' in the same batch");
  });
});

// ---------------------------------------------------------------------------
// The overlap integrity rule.
// ---------------------------------------------------------------------------

describe('overlap integrity rule', () => {
  it("attributes each sibling's write in its own dir to that sibling, and journals it on the span", async () => {
    const walker = makeWalker(() => dir, { startBarrier: 3, writeBarrier: 3 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    // Every member wrote before any returned, so each diff held both siblings' result.json.
    expect(spans('c1')[0]?.attributes?.overlap_attributed).toEqual([
      { card: 'c2', paths: 1 },
      { card: 'c3', paths: 1 },
    ]);
    expect(spans('c2')[0]?.attributes?.overlap_attributed).toEqual([
      { card: 'c1', paths: 1 },
      { card: 'c3', paths: 1 },
    ]);
  });

  it('holds every member whose diff contains a write outside all members\' owned paths', async () => {
    const walker = makeWalker(() => dir, {
      startBarrier: 3,
      writeBarrier: 3,
      extraWrites: (check) => (check === 'c2' ? ['rogue.txt'] : []),
    });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) {
      expect(lane(c)).toBe('hold');
      const s = spans(c)[0];
      expect(String(s?.attributes?.outcome)).toContain('integrity_violation');
      expect(String(s?.attributes?.outcome)).toContain('rogue.txt');
      expect(s?.attributes?.concurrent).toBe(true);
      expect(holdReasons(c)).toContain('integrity violation');
    }
  });

  it("does not detect one member's write into a sibling's owned dir (the gap SPEC §7 states)", async () => {
    const walker = makeWalker(() => dir, {
      startBarrier: 3,
      writeBarrier: 3,
      extraWrites: (check) => (check === 'c1' ? ['evidence/c2/planted.txt'] : []),
    });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    expect(spans('c1')[0]?.attributes?.overlap_attributed).toEqual([
      { card: 'c2', paths: 2 },
      { card: 'c3', paths: 1 },
    ]);
  });

  it("holds the same write on the serial path, whose rule is unchanged", async () => {
    const walker = makeWalker(() => dir, {
      extraWrites: (check) => (check === 'c1' ? ['evidence/c2/planted.txt'] : []),
    });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2']) seedChild(c);

    await run(flow, registry, 1);

    expect(lane('c1')).toBe('hold');
    const s = spans('c1')[0];
    expect(String(s?.attributes?.outcome)).toContain('integrity_violation');
    expect(String(s?.attributes?.outcome)).toContain('planted.txt');
    expect(s?.attributes?.overlap_attributed).toBeUndefined();
    expect(lane('c2')).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Budgets: spend reaches the accumulators, per card.
// ---------------------------------------------------------------------------

describe('overlap: token attribution', () => {
  it("credits each overlapped call's tokens to its own card: the wave budget scraps only the costly subtree", async () => {
    const walker = makeWalker(() => dir, {
      startBarrier: 2,
      tokens: (check) => (check === 'a1' ? 1_000 : 10),
    });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({ settle: true, perWave: '{ max_tokens: 500 }' }, registry);
    seedChild('a1', undefined, 'PA');
    seedChild('b1', undefined, 'PB');

    await run(flow, registry, 2);

    expect(walker.records.filter((r) => r.releasedByBarrier).length).toBeGreaterThanOrEqual(2);
    // a1's 1000 tokens put PA over its wave cap, so a1 is scrapped before settle.
    expect(lane('a1')).toBe('scrap');
    expect(db.getCardLog('a1').some((e) => e.kind === 'terminal' && e.reason === 'wave_budget')).toBe(true);
    // b1's subtree spent 20 and finishes. Had a1's spend been credited to b1,
    // or to no card, this would not hold.
    expect(lane('b1')).toBe('done');
  });

  it('folds every overlapped call into the run total: the run budget trips after the batch', async () => {
    const walker = makeWalker(() => dir, { startBarrier: 3, tokens: () => 10 });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({ settle: true, maxTokens: 25 }, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);
    const errLines: string[] = [];

    await run(flow, registry, 3, errLines);

    // 3 x 10 = 30 > 25. Each member checked the andon after its own call, so
    // the batch overshoots by up to K calls (SPEC §8 soft ceiling), and no
    // card reached settle.
    expect(walker.calls).toHaveLength(3);
    expect(errLines.join('\n')).toMatch(/andon/i);
    for (const c of ['c1', 'c2', 'c3']) expect(spans(c, 'settle')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parks and retries stay per card.
// ---------------------------------------------------------------------------

describe('overlap: rate-limit parks and retries inside a batch', () => {
  it('parks only the rate-limited member; it runs again later without spending an attempt', async () => {
    const walker = makeWalker(() => dir, {
      startBarrier: 3,
      step: (check, n) => (check === 'c2' && n === 1 ? { throw: 'harness-rate-limited', tokens: 5 } : 'valid'),
    });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    const c2 = spans('c2');
    expect(c2.map((s) => s.attributes?.outcome)).toEqual(['harness-rate-limited', 'success']);
    expect(c2[0]?.attributes?.concurrent).toBe(true);
    expect(typeof c2[0]?.attributes?.rate_limit_release_at).toBe('number');
    // A park is not an execution attempt.
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.attempt).toBe(0);
    expect(walker.calls).toHaveLength(4);
  });

  it('retries a failed member inside the batch while its siblings finish', async () => {
    const walker = makeWalker(() => dir, {
      startBarrier: 3,
      step: (check, n) => (check === 'c2' && n === 1 ? { throw: 'harness-nonzero-exit' } : 'valid'),
    });
    const registry = createHarnessRegistry([walker.adapter]);
    const flow = loadOk({}, registry);
    for (const c of ['c1', 'c2', 'c3']) seedChild(c);

    await run(flow, registry, 3);

    for (const c of ['c1', 'c2', 'c3']) expect(lane(c)).toBe('done');
    const c2 = spans('c2');
    expect(c2.map((s) => s.attributes?.outcome)).toEqual(['harness-nonzero-exit', 'success']);
    expect(c2.every((s) => s.attributes?.concurrent === true)).toBe(true);
    // The retry is the same batch member: both spans share the card's attempt base.
    expect(c2.map((s) => s.attempt)).toEqual([0, 1]);
  });
});
