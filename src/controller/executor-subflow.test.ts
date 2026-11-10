/**
 * Executor tests for `kind: subflow` stations (the original multi-flow engine work — flow-as-station
 * composition), driven through the REAL runExecutor with an injected
 * SubflowSeam (the production seam spawns a `conduit run` subprocess; tests
 * inject fakes, mirroring the worker-pool spawn seam pattern).
 *
 * Pinned guarantees (prd/drafts/multi-flow-engine.md, slice D):
 *   - success: child done + declared outputs present → the calling station
 *     completes and the card advances along the happy path;
 *   - identity: the child run id is deriveSubflowRunId(parent, station,
 *     attemptIndex) — deterministic per attempt, fresh per retry;
 *   - budget: the seam receives the parent's REMAINING budget as the child's
 *     ceiling, and the child's reported spend folds into the parent's run
 *     budget (the consumption andon can trip on child spend);
 *   - failure: child scrap/halt/error fails the attempt NAMED; cap exhaustion
 *     scraps the card with the child's reason (never a silent advance);
 *   - contract: child done WITHOUT the station's declared outputs is a named
 *     attempt failure (subflow-output-missing);
 *   - config failure: no seam wired → hold (never a silent skip);
 *   - lineage: every attempt journals a `<station>.subflow` span carrying the
 *     child run id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { deriveSubflowRunId } from '../run/run-id';
import { runExecutor, type SubflowInvocation, type SubflowOutcome, type SubflowSeam } from './executor';

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let dir: string;
let db: ConduitDB;
let ioLines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-subflow-'));
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  ioLines = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const io = { out: (l: string) => ioLines.push(l), err: (l: string) => ioLines.push(l) };

/** Parent flow with one subflow station calling ./child/flow.yaml. */
function setupFlow(maxTokens = 100_000): FlowConfig {
  mkdirSync(join(dir, 'child'), { recursive: true });
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, 'work', 'in.json'), JSON.stringify({ photo: 'a.jpg' }));
  writeFileSync(
    join(dir, 'child', 'flow.yaml'),
    `
flow: child
project_root: ..
flow_version: 1
terminal_lanes: [done, scrap, hold]
security:
  bash: { allow: ["true"] }
stations:
  - id: edit
    worker: { kind: deterministic, command: "true" }
    inputs: [work/in.json]
    outputs: [work/out.json]
    next: done
`,
  );
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: parent
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: call-child
    worker:
      kind: subflow
      flow: ./child/flow.yaml
    inputs: [work/in.json]
    outputs: [work/out.json]
    next: done
`,
  );
  const result = loadFlow(join(dir, 'flow.yaml'));
  if (!result.ok) throw new Error(`fixture flow failed to load: ${JSON.stringify(result.errors)}`);
  return result.flow;
}

function seedEntryCard(): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'card-1',
    parent_id: null,
    lane: 'call-child',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  } as Card);
}

/** A seam that records invocations and answers from a scripted queue. */
function makeSeam(
  respond: (invocation: SubflowInvocation, callIndex: number) => SubflowOutcome,
): { seam: SubflowSeam; invocations: SubflowInvocation[] } {
  const invocations: SubflowInvocation[] = [];
  const seam: SubflowSeam = async (invocation) => {
    const outcome = respond(invocation, invocations.length);
    invocations.push(invocation);
    return outcome;
  };
  return { seam, invocations };
}

function subflowSpans() {
  return db
    .getJournalSpansForRun(DEFAULT_RUN_ID, 'card-1')
    .filter((s) => s.name === 'call-child.subflow');
}

describe('subflow success path', () => {
  it('runs the child via the seam, advances the card, and journals lineage', async () => {
    const flow = setupFlow();
    seedEntryCard();
    const { seam, invocations } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', tokens: 42, costUsd: 0.01 };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).toBe('done');
    expect(invocations).toHaveLength(1);

    const inv = invocations[0]!;
    expect(inv.flowPath).toBe(join(dir, 'child/flow.yaml'));
    expect(inv.runId).toBe(deriveSubflowRunId(DEFAULT_RUN_ID, 'call-child', 0));
    expect(inv.seedPath).toBe(join(dir, 'work/in.json'));
    expect(inv.parentRunId).toBe(DEFAULT_RUN_ID);
    expect(inv.parentStation).toBe('call-child');
    // Parent's remaining budget rides along as the child's ceiling.
    expect(inv.budgetMaxTokens).toBe(100_000);
    expect(inv.budgetWallClockSeconds).toBeLessThanOrEqual(600);

    const spans = subflowSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['child_run_id']).toBe(inv.runId);
    expect(spans[0]!.attributes['outcome']).toBe('success');
  });
});

describe('the original per-run usage-attribution work — subflow spend attributed to the owning parent run', () => {
  it("folds the child's spend under the PARENT run, not DEFAULT_RUN_ID", async () => {
    const REAL_RUN = 'run-subflow-attrib';
    const flow = setupFlow();
    // Seed + run under a NON-default run id (mirrors seedEntryCard, run-scoped).
    db.insertCard({
      run_id: REAL_RUN, id: 'card-1', parent_id: null, lane: 'call-child',
      status: 'ready', attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    } as Card);
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', tokens: 42, costUsd: 0.01 };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam, runId: REAL_RUN });

    expect(db.getCard(REAL_RUN, 'card-1')?.lane).toBe('done');
    // The folded subflow spend lands under the parent run...
    expect(db.getRunUsageTotals(REAL_RUN)).toEqual({ tokens: 42, costUsd: 0.01 });
    // ...and NOT under the global default sweep (the exact per-run usage-attribution work mis-attribution).
    expect(db.getRunUsageTotals(DEFAULT_RUN_ID)).toEqual({ tokens: 0, costUsd: 0 });
  });
});

describe('subflow failure semantics', () => {
  it('a scrapped child fails the attempt named; cap exhaustion scraps with the child reason', async () => {
    const flow = setupFlow();
    seedEntryCard();
    const { seam, invocations } = makeSeam(() => ({
      outcome: 'scrap',
      reason: 'child qc rejected everything',
    }));

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    const card = db.getCard(DEFAULT_RUN_ID, 'card-1');
    expect(card?.lane).toBe('scrap');
    // per_card.max_execution_attempts = 3 → three child invocations, then scrap.
    expect(invocations).toHaveLength(3);

    const reasons = db
      .getCardLog('card-1')
      .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
      .map((e) => e.reason);
    expect(reasons.join(' ')).toContain('subflow-scrap: child qc rejected everything');
  });

  it('each retry derives a FRESH child run id (a scrapped child is never resumed)', async () => {
    const flow = setupFlow();
    seedEntryCard();
    const { seam, invocations } = makeSeam(() => ({ outcome: 'error', reason: 'boom' }));

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    const runIds = invocations.map((i) => i.runId);
    expect(new Set(runIds).size).toBe(3);
    expect(runIds[0]).toBe(deriveSubflowRunId(DEFAULT_RUN_ID, 'call-child', 0));
    expect(runIds[1]).toBe(deriveSubflowRunId(DEFAULT_RUN_ID, 'call-child', 1));
  });

  it('child done WITHOUT the declared outputs is a named failure (contract breach)', async () => {
    const flow = setupFlow();
    seedEntryCard();
    // Child claims success but never writes work/out.json.
    const { seam, invocations } = makeSeam(() => ({ outcome: 'done' }));

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).toBe('scrap');
    expect(invocations).toHaveLength(3);
    const reasons = db
      .getCardLog('card-1')
      .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
      .map((e) => e.reason);
    expect(reasons.join(' ')).toContain('subflow-output-missing: work/out.json');
  });

  it('a throwing seam is a named attempt failure, not an unhandled rejection', async () => {
    const flow = setupFlow();
    seedEntryCard();
    const seam: SubflowSeam = async () => {
      throw new Error('spawn exploded');
    };

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).toBe('scrap');
    const reasons = db
      .getCardLog('card-1')
      .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
      .map((e) => e.reason);
    expect(reasons.join(' ')).toContain('subflow runner threw: spawn exploded');
  });

  it('no seam wired → the card hard-pauses to hold (config failure, never a silent skip)', async () => {
    const flow = setupFlow();
    seedEntryCard();

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io });

    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).toBe('hold');
    expect(ioLines.join('\n')).toContain('no subflow runner is configured');
  });
});

describe('subflow budget attribution (one ceiling per user intent)', () => {
  it("the child's reported spend folds into the parent's run budget and can trip the andon", async () => {
    // Parent run budget 40 tokens; the child reports 42 — the gateless
    // consumption-andon check after the fold must trip, halting the run
    // BEFORE the card advances to done.
    const flow = setupFlow(40);
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', tokens: 42, costUsd: 0.01 };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).not.toBe('done');
    expect(ioLines.join('\n')).toContain('andon');
    // The spend itself is on the books: the journal span carries the usage.
    const spans = subflowSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
  });

  it('passes the parent REMAINING budget to each child, not the full declared budget', async () => {
    // Parent with two sequential subflow stations: the first child spends 100
    // of the parent's 1000-token budget, so the SECOND child's ceiling must be
    // 900 — the fold from child 1 lowers what child 2 is allowed to burn.
    setupFlow();
    writeFileSync(
      join(dir, 'flow.yaml'),
      `
flow: parent
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 1000 }
  per_card: { max_execution_attempts: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: call-child
    worker:
      kind: subflow
      flow: ./child/flow.yaml
    inputs: [work/in.json]
    outputs: [work/out.json]
    next: call-child-2
  - id: call-child-2
    worker:
      kind: subflow
      flow: ./child/flow.yaml
    inputs: [work/out.json]
    outputs: [work/out2.json]
    next: done
`,
    );
    const result = loadFlow(join(dir, 'flow.yaml'));
    if (!result.ok) throw new Error(`fixture failed: ${JSON.stringify(result.errors)}`);
    seedEntryCard();

    const { seam, invocations } = makeSeam((invocation) => {
      const output = invocation.parentStation === 'call-child' ? 'out.json' : 'out2.json';
      writeFileSync(join(dir, 'work', output), JSON.stringify({ ok: true }));
      return { outcome: 'done', tokens: invocation.parentStation === 'call-child' ? 100 : 1 };
    });

    await runExecutor({ db, flow: result.flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).toBe('done');
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.budgetMaxTokens).toBe(1000);
    expect(invocations[1]!.budgetMaxTokens).toBe(900);
  });

  // Issue #125: a child reports its spend per adapter, and the parent weights
  // each share for its own adapter. claude-headless: 100 + 0.1 * 8,000 = 900;
  // codex-exec: 0.5 * 180 = 90. 8,280 raw tokens count as 990 against 1,000.
  const CACHE_HEAVY_CHILD = {
    tokens: 8_280,
    byAdapter: [
      { adapter: 'claude-headless', breakdown: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 8_000, cacheCreationInputTokens: 0 } },
      { adapter: 'codex-exec', breakdown: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 180, cacheCreationInputTokens: 0 } },
    ],
  };

  it("an unknown adapter's share counts at 1: the same child with its codex share unnamed trips 1,000", async () => {
    // 900 + 180 = 1,080.
    const flow = setupFlow(1000);
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return {
        outcome: 'done',
        tokens: CACHE_HEAVY_CHILD.tokens,
        byAdapter: [CACHE_HEAVY_CHILD.byAdapter[0]!, { ...CACHE_HEAVY_CHILD.byAdapter[1]!, adapter: null }],
      };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(ioLines.join('\n')).toContain('andon');
  });

  it("the parent flow's token_weights overrides the child's adapter defaults", async () => {
    // cache_read 1 for both shares: 100 + 8,000 + 180 = 8,280 > 1,000.
    const flow = setupFlow(1000);
    const path = join(dir, 'flow.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('  per_card:', '  token_weights: { cache_read: 1 }\n  per_card:'));
    const reloaded = loadFlow(path);
    if (!reloaded.ok) throw new Error(JSON.stringify(reloaded.errors));
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', ...CACHE_HEAVY_CHILD };
    });

    await runExecutor({ db, flow: reloaded.flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(flow.budgets?.token_weights).toBeUndefined();
    expect(ioLines.join('\n')).toContain('andon');
  });

  it("weights a child's cache reads: a cache-heavy child under the weighted budget does not trip it", async () => {
    const flow = setupFlow(1000);
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', ...CACHE_HEAVY_CHILD };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(ioLines.join('\n')).not.toContain('andon');
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).toBe('done');
    // The span keeps the child's summed raw split.
    const [span] = db.getSpanTokenUsageForRun(DEFAULT_RUN_ID).filter((sp) => sp.name === 'call-child.subflow');
    expect(span?.inputTokens).toBe(100);
    expect(span?.cacheReadInputTokens).toBe(8_180);
  });

  it('a child of the same raw size with no per-adapter split counts at weight 1 and trips the budget', async () => {
    const flow = setupFlow(1000);
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', tokens: 8_280 };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(ioLines.join('\n')).toContain('andon');
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).not.toBe('done');
  });

  it('a cache-heavy child just over the weighted budget still trips it', async () => {
    const flow = setupFlow(989);
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', ...CACHE_HEAVY_CHILD };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    expect(ioLines.join('\n')).toContain('andon');
    expect(db.getCard(DEFAULT_RUN_ID, 'card-1')?.lane).not.toBe('done');
  });

  // A share with a NaN or negative class is unusable (ADR-0014, "missing data
  // never lowers the count"): the roll-up then counts the child's raw total
  // at weight 1, as if it reported no shares. A NaN share would otherwise make
  // tokensSpent NaN, and a negative one would subtract from the run's spend.
  for (const [label, bad] of [
    ['NaN', { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: Number.NaN, cacheCreationInputTokens: 0 }],
    ['negative', { inputTokens: -8_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }],
  ] as const) {
    it(`a child share with a ${label} class drops the shares and counts the raw total at 1`, async () => {
      // Raw 8,280 at weight 1 trips 2,000. Folding the shares instead counts
      // NaN, or 900 - 8,000 + an 8,180 remainder = 1,080, and trips nothing.
      const flow = setupFlow(2000);
      seedEntryCard();
      const { seam } = makeSeam(() => {
        writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
        return {
          outcome: 'done',
          tokens: CACHE_HEAVY_CHILD.tokens,
          byAdapter: [CACHE_HEAVY_CHILD.byAdapter[0]!, { adapter: 'codex-exec', breakdown: { ...bad } }],
        };
      });

      await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

      expect(ioLines.join('\n')).toContain('andon');
      // The span records the raw total with no split, like a child with no shares.
      const [span] = db.getSpanTokenUsageForRun(DEFAULT_RUN_ID).filter((sp) => sp.name === 'call-child.subflow');
      expect(span?.inputTokens).toBe(8_280);
      expect(span?.cacheReadInputTokens).toBeNull();
    });
  }

  it("records no cache split on the roll-up span when a child share has none", async () => {
    // A share whose spans recorded no cache columns may hold cached tokens in
    // its input, so the roll-up span must say "no cache figure", not 0%.
    const flow = setupFlow(100_000);
    seedEntryCard();
    const { seam } = makeSeam(() => {
      writeFileSync(join(dir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return {
        outcome: 'done',
        tokens: 500,
        byAdapter: [{
          adapter: 'codex-exec',
          breakdown: { inputTokens: 500, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          cacheSplit: false,
        }],
      };
    });

    await runExecutor({ db, flow, now: () => 1000, adapter: stubAdapter, io, runSubflow: seam });

    const [span] = db.getSpanTokenUsageForRun(DEFAULT_RUN_ID).filter((sp) => sp.name === 'call-child.subflow');
    expect(span?.inputTokens).toBe(500);
    expect(span?.cacheReadInputTokens).toBeNull();
    expect(span?.cacheCreationInputTokens).toBeNull();
  });
});
