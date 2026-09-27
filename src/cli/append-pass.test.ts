/**
 * `conduit run --append-pass` (issue #36): start the next pass of a finished run.
 *
 * A keyed ingress run takes each event about its subject as a new pass. The
 * ordinary `conduit run --run-id X` cannot do that: it fingerprints the input,
 * so a second input is a run-id conflict, and `conduit resume` takes no new
 * input and has nothing to do once every card is terminal. `--append-pass`:
 *
 *   - requires an existing run with the same flow path and project root
 *     (else exit 1); the input fingerprint is NOT compared, and
 *     runs.input_fingerprint keeps the FIRST pass's value;
 *   - requires the run to have finished successfully; a running, parked,
 *     halted, or card-holding run is refused with EXIT_PASS_REFUSED (3);
 *   - takes the run lease like any driving run; a live holder is
 *     EXIT_RUN_LEASE_CONFLICT (75);
 *   - rewrites the entry seed (the pre-staged-overwrite guard does not apply)
 *     and seeds `entry-<runId>-p<N>`, N from the cards table;
 *   - marks the run running and drives it through the same engine path;
 *   - caps the pass's token budget at what the run has left, since the run
 *     budget is a ceiling over every pass (refused when none is left).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { ModelAdapter, ModelCall } from '../worker/adapter';
import { runExecutor } from '../controller/executor';
import { EXIT_PASS_REFUSED, EXIT_RUN_LEASE_CONFLICT } from '../run/run-passes';
import { main, type CliDeps, type CliIO, type RunEngineArgs } from './main';

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;
let flowRoot: string;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
  flowRoot = mkdtempSync(join(tmpdir(), 'conduit-append-pass-'));
  writeFileSync(join(flowRoot, 'p.md'), 'Echo: {{in.json}}\n', 'utf-8');
});

afterEach(() => {
  db.close();
  rmSync(flowRoot, { recursive: true, force: true });
});

const RUN = 'igk-pr-loop-abc';

function writeFlow(maxTokens = 100_000): string {
  const yaml = `flow: pr-loop
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${maxTokens} }
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
  const flowPath = join(flowRoot, 'flow.yaml');
  writeFileSync(flowPath, yaml, 'utf-8');
  return flowPath;
}

/** An engine double that completes every ready card and records what it was given. */
function completingEngine(): { runEngine: (args: RunEngineArgs) => Promise<void>; calls: RunEngineArgs[] } {
  const calls: RunEngineArgs[] = [];
  return {
    calls,
    runEngine: async (args) => {
      calls.push(args);
      args.db
        .getStateDb()
        .prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE run_id = $r AND status = 'ready'")
        .run({ $r: args.runId ?? "" });
    },
  };
}

function makeDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: { async call() { return { text: '{"text":"x"}', inputTokens: 1, outputTokens: 1, costUsd: 0 }; } },
    runEngine: async () => {},
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) }],
    ...over,
  };
}

function cardIds(runId = RUN): string[] {
  return (db.getStateDb().prepare('SELECT id FROM cards WHERE run_id = $r ORDER BY id').all({ $r: runId }) as Array<{ id: string }>).map((r) => r.id);
}

async function runPass1(flowPath: string, deps: CliDeps): Promise<number> {
  return main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":1}'], deps);
}

async function appendPass(flowPath: string, deps: CliDeps, input = '{"n":2}'): Promise<number> {
  return main(['run', flowPath, '--run-id', RUN, '--input-inline', input, '--append-pass'], deps);
}

describe('conduit run --append-pass: happy path', () => {
  it('seeds entry-<run>-p2, rewrites the seed, drives the engine, and records the run done', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    expect(await runPass1(flowPath, deps)).toBe(0);
    const fingerprint = db.getRun(RUN)!.input_fingerprint;

    expect(await appendPass(flowPath, deps)).toBe(0);

    expect(cardIds()).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`]);
    expect(db.getCard(RUN, `entry-${RUN}-p2`)!.lane).toBe('done');
    expect(readFileSync(join(flowRoot, 'in.json'), 'utf-8')).toBe('{"n":2}');
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[1]!.runId).toBe(RUN);
    const run = db.getRun(RUN)!;
    expect(run.status).toBe('done');
    expect(run.outcome).toBe('complete');
    // The founding input keeps the fingerprint; passes do not rewrite it.
    expect(run.input_fingerprint).toBe(fingerprint);
  });

  it('numbers passes from the cards table', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    await runPass1(flowPath, deps);
    expect(await appendPass(flowPath, deps, '{"n":2}')).toBe(0);
    expect(await appendPass(flowPath, deps, '{"n":3}')).toBe(0);
    expect(cardIds()).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`, `entry-${RUN}-p3`]);
  });

  it('gives the pass card the same owned paths as the first entry card', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    await runPass1(flowPath, deps);
    await appendPass(flowPath, deps);
    expect(db.getCard(RUN, `entry-${RUN}-p2`)!.owned_paths).toEqual(db.getCard(RUN, `entry-${RUN}`)!.owned_paths);
  });

  it('exits 1 when the pass card does not reach done, recording the run halted', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    await runPass1(flowPath, deps);
    const scrapping = async (args: RunEngineArgs) => {
      args.db.getStateDb().prepare("UPDATE cards SET lane = 'scrap', status = 'scrapped' WHERE run_id = $r AND status = 'ready'").run({ $r: args.runId ?? "" });
    };
    expect(await appendPass(flowPath, makeDeps({ runEngine: scrapping }))).toBe(1);
    expect(db.getRun(RUN)!.status).toBe('halted');
  });
});

describe('conduit run --append-pass: the real engine does not replay pass 1', () => {
  it('runs the station again for pass 2 on its own input, with its own checkpoint', async () => {
    const flowPath = writeFlow();
    const prompts: string[] = [];
    const adapter: ModelAdapter = {
      async call(req: ModelCall) {
        prompts.push(req.prompt.trim());
        return { text: JSON.stringify({ text: req.prompt.trim() }), inputTokens: 10, outputTokens: 5, costUsd: 0 };
      },
    };
    const deps = makeDeps({ adapter, runEngine: runExecutor });

    expect(await runPass1(flowPath, deps)).toBe(0);
    expect(await appendPass(flowPath, deps)).toBe(0);

    expect(prompts).toEqual(['Echo: {"n":1}', 'Echo: {"n":2}']);
    // Checkpoints are keyed (run, flow, card, station, attempt): the pass card
    // gets its own, with its own binding stamp over its own input hash, and
    // pass 1's checkpoint is left exactly as it was.
    const checkpoints = db
      .getStateDb()
      .prepare('SELECT card, binding_stamp, output_json FROM checkpoints WHERE run_id = $r ORDER BY card')
      .all({ $r: RUN }) as Array<{ card: string; binding_stamp: string; output_json: string }>;
    expect(checkpoints.map((c) => c.card)).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`]);
    expect(checkpoints[0]!.output_json).toContain('{\\"n\\":1}');
    expect(checkpoints[1]!.output_json).toContain('{\\"n\\":2}');
    expect(checkpoints[0]!.binding_stamp).not.toBe(checkpoints[1]!.binding_stamp);
    expect(db.getCard(RUN, `entry-${RUN}`)!.lane).toBe('done');
    expect(db.getCard(RUN, `entry-${RUN}-p2`)!.lane).toBe('done');
  });
});

describe('conduit run --append-pass: the run token budget is a ceiling over every pass', () => {
  it('caps the pass at the tokens the run has left', async () => {
    const flowPath = writeFlow(1_000);
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await runPass1(flowPath, deps);
    db.appendJournalSpan({
      runId: RUN, cardId: `entry-${RUN}`, station: 'only', attempt: 0, name: 'only.transform',
      usage: { model: 'm', inputTokens: 600, outputTokens: 100, costUsd: 0 },
    });

    expect(await appendPass(flowPath, deps)).toBe(0);
    expect(engine.calls[1]!.budgetMaxTokens).toBe(300);
  });

  it('keeps a tighter caller ceiling', async () => {
    const flowPath = writeFlow(1_000);
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await runPass1(flowPath, deps);
    expect(
      await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}', '--append-pass', '--budget-tokens', '50'], deps),
    ).toBe(0);
    expect(engine.calls[1]!.budgetMaxTokens).toBe(50);
  });

  it('refuses the pass when the run has no tokens left, seeding nothing', async () => {
    const flowPath = writeFlow(1_000);
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await runPass1(flowPath, deps);
    db.appendJournalSpan({
      runId: RUN, cardId: `entry-${RUN}`, station: 'only', attempt: 0, name: 'only.transform',
      usage: { model: 'm', inputTokens: 1_000, outputTokens: 0, costUsd: 0 },
    });

    expect(await appendPass(flowPath, deps)).toBe(EXIT_PASS_REFUSED);
    expect(cardIds()).toEqual([`entry-${RUN}`]);
    expect(engine.calls).toHaveLength(1);
    expect(io.errors.join('\n')).toContain('token budget');
  });
});

describe('conduit run --append-pass: refusals', () => {
  async function finishedRun(): Promise<{ flowPath: string; engine: ReturnType<typeof completingEngine> }> {
    const flowPath = writeFlow();
    const engine = completingEngine();
    await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));
    return { flowPath, engine };
  }

  function expectNothingSeeded(engine: ReturnType<typeof completingEngine>): void {
    expect(cardIds()).toEqual([`entry-${RUN}`]);
    expect(engine.calls).toHaveLength(1);
    expect(readFileSync(join(flowRoot, 'in.json'), 'utf-8')).toBe('{"n":1}');
  }

  it('requires --run-id', async () => {
    const flowPath = writeFlow();
    expect(await main(['run', flowPath, '--input-inline', '{}', '--append-pass'], makeDeps())).toBe(1);
    expect(io.errors.join('\n')).toContain('--append-pass requires --run-id');
  });

  it('refuses the default run, whose entry card is outside the pass naming scheme', async () => {
    const flowPath = writeFlow();
    expect(await main(['run', flowPath, '--run-id', 'default', '--input-inline', '{}', '--append-pass'], makeDeps())).toBe(1);
    expect(io.errors.join('\n')).toContain('not the default run');
  });

  it('requires an input', async () => {
    const { flowPath, engine } = await finishedRun();
    expect(await main(['run', flowPath, '--run-id', RUN, '--append-pass'], makeDeps({ runEngine: engine.runEngine }))).toBe(1);
    expect(io.errors.join('\n')).toContain('--append-pass requires --input or --input-inline');
    expectNothingSeeded(engine);
  });

  it('refuses a run that does not exist with exit 1', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(1);
    expect(io.errors.join('\n')).toContain('does not exist');
    expect(engine.calls).toHaveLength(0);
    expect(db.getRun(RUN)).toBeNull();
  });

  it('refuses a run recorded against a different flow path with exit 1', async () => {
    const { engine } = await finishedRun();
    const otherFlow = join(flowRoot, 'other.yaml');
    writeFileSync(otherFlow, readFileSync(join(flowRoot, 'flow.yaml')));
    expect(await appendPass(otherFlow, makeDeps({ runEngine: engine.runEngine }))).toBe(1);
    expect(io.errors.join('\n')).toContain('different flow');
    expectNothingSeeded(engine);
  });

  it('refuses a run recorded against a different project root with exit 1', async () => {
    const { flowPath, engine } = await finishedRun();
    const otherRoot = mkdtempSync(join(tmpdir(), 'conduit-append-other-'));
    try {
      expect(
        await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{}', '--append-pass', '--project-root', otherRoot], makeDeps({ runEngine: engine.runEngine })),
      ).toBe(1);
      expect(io.errors.join('\n')).toContain('different project root');
      expectNothingSeeded(engine);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('refuses a halted run with EXIT_PASS_REFUSED', async () => {
    const { flowPath, engine } = await finishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(EXIT_PASS_REFUSED);
    expect(io.errors.join('\n')).toContain('not complete');
    expectNothingSeeded(engine);
    expect(db.getRun(RUN)!.status).toBe('halted');
  });

  it('refuses a run holding a card with EXIT_PASS_REFUSED', async () => {
    const { flowPath, engine } = await finishedRun();
    db.getStateDb().prepare("UPDATE cards SET lane = 'hold', status = 'held' WHERE run_id = $r").run({ $r: RUN });
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(EXIT_PASS_REFUSED);
    expect(io.errors.join('\n')).toContain('holding');
    expect(cardIds()).toEqual([`entry-${RUN}`]);
  });

  it('refuses a parked run with EXIT_PASS_REFUSED', async () => {
    const { flowPath, engine } = await finishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'parked' WHERE run_id = $r").run({ $r: RUN });
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(EXIT_PASS_REFUSED);
    expect(io.errors.join('\n')).toContain('parked');
    expectNothingSeeded(engine);
  });

  it('refuses a run whose driver died mid-pass with EXIT_PASS_REFUSED', async () => {
    const { flowPath, engine } = await finishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'running', outcome = NULL, holder_pid = 999999999 WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb().prepare("UPDATE cards SET lane = 'only', status = 'working' WHERE run_id = $r").run({ $r: RUN });
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(EXIT_PASS_REFUSED);
    expect(io.errors.join('\n')).toContain('conduit resume');
  });

  it('exits EXIT_RUN_LEASE_CONFLICT while another live process holds the run lease', async () => {
    const { flowPath, engine } = await finishedRun();
    // The test runner's parent is alive and is not this process.
    db.getStateDb().prepare('UPDATE runs SET holder_pid = $p, lease_acquired_at = 1 WHERE run_id = $r').run({ $p: process.ppid, $r: RUN });
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(EXIT_RUN_LEASE_CONFLICT);
    expect(io.errors.join('\n')).toContain('another conduit process');
    expectNothingSeeded(engine);
  });

  it('releases the lease after a refusal', async () => {
    const { flowPath, engine } = await finishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
    await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }));
    expect(db.getRun(RUN)!.holder_pid ?? null).toBeNull();
  });
});

describe('conduit run --append-pass: the pre-staged-overwrite guard', () => {
  it('lets append-pass replace the previous pass seed', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    await runPass1(flowPath, deps);
    expect(await appendPass(flowPath, deps, '{"n":"new"}')).toBe(0);
    expect(readFileSync(join(flowRoot, 'in.json'), 'utf-8')).toBe('{"n":"new"}');
  });

  it('still refuses a non-file at the seed path', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await runPass1(flowPath, deps);
    rmSync(join(flowRoot, 'in.json'));
    mkdirSync(join(flowRoot, 'in.json'));
    expect(await appendPass(flowPath, deps)).toBe(1);
    expect(cardIds()).toEqual([`entry-${RUN}`]);
  });

  it('still protects the normal path: a fresh run over a differing pre-staged seed is refused', async () => {
    const flowPath = writeFlow();
    writeFileSync(join(flowRoot, 'in.json'), '{"staged":true}');
    const engine = completingEngine();
    expect(await main(['run', flowPath, '--run-id', 'fresh', '--input-inline', '{"n":1}'], makeDeps({ runEngine: engine.runEngine }))).toBe(1);
    expect(io.errors.join('\n')).toContain('refusing to overwrite pre-staged entry input');
    expect(engine.calls).toHaveLength(0);
  });

  it('a plain second run with new input is still a run-id conflict', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    await runPass1(flowPath, deps);
    rmSync(join(flowRoot, 'in.json'));
    expect(await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}'], deps)).toBe(1);
    expect(io.errors.join('\n')).toContain('run-id conflict');
  });
});
