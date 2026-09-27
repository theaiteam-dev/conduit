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
 *   - requires the run's previous pass to have concluded (every card in done
 *     or scrap, none held; a scrapped pass counts); a running, parked,
 *     card-holding, or unfinished run is refused with EXIT_PASS_REFUSED (3);
 *   - takes the run lease like any driving run; a live holder is
 *     EXIT_RUN_LEASE_CONFLICT (75);
 *   - rewrites the entry seed (the pre-staged-overwrite guard does not apply)
 *     and seeds `entry-<runId>-p<N>`, N from the cards table;
 *   - marks the run running and drives it through the same engine path;
 *   - caps the pass's token budget at what the run has left, since the run
 *     budget is a ceiling over every pass (refused when none is left);
 *   - records the ingress events named by `--pass-event` with the pass's
 *     entry card, and exits 0 without seeding when one was already consumed.
 *
 * `conduit resume` of a run with more than one pass applies the same budget
 * ceiling, and refuses when nothing is left.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
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

  it('appends a pass to a run whose previous pass scrapped', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));
    const scrapping = async (args: RunEngineArgs) => {
      args.db.getStateDb().prepare("UPDATE cards SET lane = 'scrap', status = 'scrapped' WHERE run_id = $r AND status = 'ready'").run({ $r: args.runId ?? '' });
    };
    expect(await appendPass(flowPath, makeDeps({ runEngine: scrapping }), '{"n":2}')).toBe(1);
    expect(db.getRun(RUN)!.status).toBe('halted');

    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }), '{"n":3}')).toBe(0);
    expect(cardIds()).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`, `entry-${RUN}-p3`]);
    expect(db.getCard(RUN, `entry-${RUN}-p2`)!.lane).toBe('scrap');
    expect(db.getCard(RUN, `entry-${RUN}-p3`)!.lane).toBe('done');
    expect(db.getRun(RUN)!.status).toBe('done');
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

describe('conduit run --pass-event: the kernel records which events a pass consumed', () => {
  it('records pass 1 events with the entry card', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    expect(
      await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":1}', '--pass-event', 'ev-1'], deps),
    ).toBe(0);
    expect(db.getPassForEvent('ev-1')).toEqual({ run_id: RUN, pass: 1 });
  });

  it('records every event an appended pass covers against that pass', async () => {
    const flowPath = writeFlow();
    const deps = makeDeps({ runEngine: completingEngine().runEngine });
    await runPass1(flowPath, deps);
    expect(
      await main(
        ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}', '--append-pass', '--pass-event', 'ev-2', '--pass-event', 'ev-3'],
        deps,
      ),
    ).toBe(0);
    expect(db.getPassForEvent('ev-2')).toEqual({ run_id: RUN, pass: 2 });
    expect(db.getPassForEvent('ev-3')).toEqual({ run_id: RUN, pass: 2 });
  });

  it('treats a repeat launch of a consumed event as done: exit 0, nothing seeded or driven, lease released', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await runPass1(flowPath, deps);
    const pass2 = ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}', '--append-pass', '--pass-event', 'ev-2'];
    expect(await main(pass2, deps)).toBe(0);

    expect(await main(pass2, deps)).toBe(0);

    expect(cardIds()).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`]);
    expect(engine.calls).toHaveLength(2);
    expect(io.lines.join('\n')).toContain('already consumed by pass 2');
    // The lease was released: a pass for a new event still goes through.
    expect(
      await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":3}', '--append-pass', '--pass-event', 'ev-3'], deps),
    ).toBe(0);
    expect(cardIds()).toContain(`entry-${RUN}-p3`);
  });

  it('requires a named run', async () => {
    const flowPath = writeFlow();
    expect(await main(['run', flowPath, '--input-inline', '{"n":1}', '--pass-event', 'ev-1'], makeDeps())).toBe(1);
    expect(io.errors.join('\n')).toContain('--pass-event requires --run-id');
  });

  describe('a mixed set of consumed and new events', () => {
    it('refuses --append-pass rather than silently dropping the new event, and releases the lease', async () => {
      const flowPath = writeFlow();
      const engine = completingEngine();
      const deps = makeDeps({ runEngine: engine.runEngine });
      await runPass1(flowPath, deps);
      expect(
        await main(
          ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}', '--append-pass', '--pass-event', 'ev-2', '--pass-event', 'ev-3'],
          deps,
        ),
      ).toBe(0);
      // ev-2 and ev-3 are now consumed by pass 2. A third launch names one
      // consumed event (ev-3) alongside one new one (ev-4): ambiguous.
      const mixed = [
        'run', flowPath, '--run-id', RUN, '--input-inline', '{"n":3}', '--append-pass',
        '--pass-event', 'ev-3', '--pass-event', 'ev-4',
      ];

      expect(await main(mixed, deps)).toBe(EXIT_PASS_REFUSED);

      const errors = io.errors.join('\n');
      expect(errors).toContain('ev-3');
      expect(errors).toContain('pass 2');
      // Nothing was seeded for the refused launch, and ev-4 was never recorded.
      expect(cardIds()).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`]);
      expect(db.getPassForEvent('ev-4')).toBeNull();
      // The lease was released: a corrected retry still goes through.
      expect(
        await main(
          ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":3}', '--append-pass', '--pass-event', 'ev-4'],
          deps,
        ),
      ).toBe(0);
      expect(db.getPassForEvent('ev-4')).toEqual({ run_id: RUN, pass: 3 });
    });

    it('refuses a fresh run (pass 1) whose --pass-event ids mix a consumed event with a new one', async () => {
      const flowPath = writeFlow();
      const deps = makeDeps({ runEngine: completingEngine().runEngine });
      // ev-1 is consumed by RUN's pass 1.
      await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":1}', '--pass-event', 'ev-1'], deps);

      const otherRun = 'igk-pr-loop-other';
      expect(
        await main(
          ['run', flowPath, '--run-id', otherRun, '--input-inline', '{"n":1}', '--pass-event', 'ev-1', '--pass-event', 'ev-9'],
          deps,
        ),
      ).toBe(EXIT_PASS_REFUSED);

      const errors = io.errors.join('\n');
      expect(errors).toContain('ev-1');
      expect(errors).toContain('pass 1');
      // No run was ever registered for the refused launch, and ev-9 stays unrecorded.
      expect(db.getRun(otherRun)).toBeNull();
      expect(db.getPassForEvent('ev-9')).toBeNull();
    });

    it('treats a fresh run (pass 1) whose only --pass-event id is fully consumed as a no-op, exit 0', async () => {
      const flowPath = writeFlow();
      const deps = makeDeps({ runEngine: completingEngine().runEngine });
      await main(['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":1}', '--pass-event', 'ev-1'], deps);

      const otherRun = 'igk-pr-loop-other2';
      expect(
        await main(['run', flowPath, '--run-id', otherRun, '--input-inline', '{"n":1}', '--pass-event', 'ev-1'], deps),
      ).toBe(0);

      expect(io.lines.join('\n')).toContain('already consumed by pass 1');
      expect(db.getRun(otherRun)).toBeNull();
    });
  });

  describe('a concurrent launch consumes an event between the pre-check and the seed', () => {
    /**
     * Wrap `db` so `getPassForEvent` answers `null` the first time it is
     * asked about `raceEventId` — as if no pass had consumed it yet — and
     * the real answer on every call after. A real row for that event,
     * inserted directly below (simulating a concurrent launch that already
     * won the race), sits behind a pre-check that still sees it as free: the
     * launch under test proceeds past `decidePassEventAdmission` and only
     * discovers the collision when its own seed transaction's
     * `recordPassEvents` hits the table's PRIMARY KEY.
     */
    function racedGetPassForEvent(base: ConduitDB, raceEventId: string): ConduitDB {
      let sawRaceEventOnce = false;
      return new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === 'getPassForEvent') {
            return (eventId: string) => {
              if (eventId === raceEventId && !sawRaceEventOnce) {
                sawRaceEventOnce = true;
                return null;
              }
              return target.getPassForEvent(eventId);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as ConduitDB;
    }

    it('refuses a fresh run (pass 1) with EXIT_PASS_REFUSED, a legible message, and no run row', async () => {
      const flowPath = writeFlow();
      const raced = racedGetPassForEvent(db, 'ev-race');
      // A concurrent launch already recorded this event against a different
      // run's pass, landing after this launch's own pre-check ran.
      db.recordPassEvents('other-run', 1, ['ev-race']);

      const deps = makeDeps({ db: raced, runEngine: completingEngine().runEngine });
      const exitCode = await main(
        ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":1}', '--pass-event', 'ev-race'],
        deps,
      );

      expect(exitCode).toBe(EXIT_PASS_REFUSED);
      const errors = io.errors.join('\n');
      expect(errors).toContain('ev-race');
      expect(errors).toContain('pass 1');
      expect(errors).toContain('other-run');
      // No entry card was left behind by the rolled-back seed transaction...
      expect(cardIds(RUN)).toEqual([]);
      // ...and, like the pre-check refusal path (above), no run row either:
      // this invocation's own registerRun call is undone on this refusal.
      expect(db.getRun(RUN)).toBeNull();
    });

    it('leaves no seed file behind on a pass-1 race refusal of a fresh run with none pre-staged', async () => {
      const flowPath = writeFlow();
      const raced = racedGetPassForEvent(db, 'ev-race');
      db.recordPassEvents('other-run', 1, ['ev-race']);

      const deps = makeDeps({ db: raced, runEngine: completingEngine().runEngine });
      const exitCode = await main(
        ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":1}', '--pass-event', 'ev-race'],
        deps,
      );

      expect(exitCode).toBe(EXIT_PASS_REFUSED);
      // The seed transaction rolled back with the card — the write to
      // in.json that happened before it must be undone too, not left behind
      // as an orphaned file for a run that no longer exists.
      expect(existsSync(join(flowRoot, 'in.json'))).toBe(false);
    });

    it('refuses --append-pass with EXIT_PASS_REFUSED, a legible message, no new pass card, and releases the lease', async () => {
      const flowPath = writeFlow();
      const engine = completingEngine();
      await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));

      const raced = racedGetPassForEvent(db, 'ev-race');
      db.recordPassEvents('other-run', 1, ['ev-race']);

      const deps = makeDeps({ db: raced, runEngine: engine.runEngine });
      const exitCode = await main(
        ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}', '--append-pass', '--pass-event', 'ev-race'],
        deps,
      );

      expect(exitCode).toBe(EXIT_PASS_REFUSED);
      const errors = io.errors.join('\n');
      expect(errors).toContain('ev-race');
      expect(errors).toContain('pass 1');
      expect(errors).toContain('other-run');
      // No pass-2 card was left behind by the rolled-back seed transaction,
      // and the run itself (which pre-existed this invocation) is untouched.
      expect(cardIds()).toEqual([`entry-${RUN}`]);
      expect(db.getRun(RUN)).not.toBeNull();
      // The lease admitAppendPass took was released on this refusal.
      expect(db.getRun(RUN)!.holder_pid ?? null).toBeNull();
    });

    it("leaves the previous pass's seed file byte-identical on an append-pass race refusal", async () => {
      const flowPath = writeFlow();
      const engine = completingEngine();
      await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));
      const seedPath = join(flowRoot, 'in.json');
      expect(readFileSync(seedPath, 'utf-8')).toBe('{"n":1}');

      const raced = racedGetPassForEvent(db, 'ev-race');
      db.recordPassEvents('other-run', 1, ['ev-race']);

      const deps = makeDeps({ db: raced, runEngine: engine.runEngine });
      const exitCode = await main(
        ['run', flowPath, '--run-id', RUN, '--input-inline', '{"n":2}', '--append-pass', '--pass-event', 'ev-race'],
        deps,
      );

      expect(exitCode).toBe(EXIT_PASS_REFUSED);
      // The refused pass's own seed write, done before the rolled-back
      // transaction, must not stick: the file must still hold what pass 1
      // (the last pass that actually committed) consumed.
      expect(readFileSync(seedPath, 'utf-8')).toBe('{"n":1}');
    });
  });
});

describe('conduit resume: a run that has taken passes spends from one budget', () => {
  /** Leave pass 2 unfinished, as a crashed or halted driver would. */
  async function haltedPass2(flowPath: string, deps: CliDeps): Promise<void> {
    await runPass1(flowPath, deps);
    await appendPass(flowPath, deps);
    db.getStateDb()
      .prepare("UPDATE cards SET lane = 'only', status = 'ready' WHERE run_id = $r AND id = $id")
      .run({ $r: RUN, $id: `entry-${RUN}-p2` });
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
  }

  function spend(tokens: number): void {
    db.appendJournalSpan({
      runId: RUN, cardId: `entry-${RUN}`, station: 'only', attempt: 0, name: 'only.transform',
      usage: { model: 'm', inputTokens: tokens, outputTokens: 0, costUsd: 0 },
    });
  }

  it('caps the resume at what every earlier invocation left', async () => {
    const flowPath = writeFlow(1_000);
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await haltedPass2(flowPath, deps);
    spend(700);

    expect(await main(['resume', '--run', RUN, flowPath], deps)).toBe(0);

    expect(engine.calls).toHaveLength(3);
    expect(engine.calls[2]!.budgetMaxTokens).toBe(300);
  });

  it('leaves a single-pass run with its per-invocation budget', async () => {
    const flowPath = writeFlow(1_000);
    const engine = completingEngine();
    const deps = makeDeps({ runEngine: engine.runEngine });
    await runPass1(flowPath, deps);
    db.getStateDb().prepare("UPDATE cards SET lane = 'only', status = 'ready' WHERE run_id = $r").run({ $r: RUN });
    spend(700);

    expect(await main(['resume', '--run', RUN, flowPath], deps)).toBe(0);

    expect(engine.calls[1]!.budgetMaxTokens).toBeUndefined();
  });

  it('refuses to resume, without calling the model, when earlier passes spent the whole budget', async () => {
    const flowPath = writeFlow(1_000);
    let calls = 0;
    const adapter: ModelAdapter = {
      async call() {
        calls++;
        return { text: '{"text":"x"}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    const deps = makeDeps({ adapter, runEngine: runExecutor });
    await haltedPass2(flowPath, deps);
    // Pass 2's station has to run again: without its checkpoint, resume
    // cannot skip it.
    db.getStateDb().prepare('DELETE FROM checkpoints WHERE run_id = $r AND card = $c').run({ $r: RUN, $c: `entry-${RUN}-p2` });
    const callsBefore = calls;
    spend(1_000);

    expect(await main(['resume', '--run', RUN, flowPath], deps)).toBe(1);

    expect(calls).toBe(callsBefore);
    expect(db.getCard(RUN, `entry-${RUN}-p2`)!.lane).toBe('only');
    expect(io.errors.join('\n')).toContain('spent the run token budget');
    expect(db.getRun(RUN)!.holder_pid ?? null).toBeNull();
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

  it('refuses a run the andon halted with an unfinished card, with EXIT_PASS_REFUSED', async () => {
    const { flowPath, engine } = await finishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb().prepare("UPDATE cards SET lane = 'only', status = 'ready' WHERE run_id = $r").run({ $r: RUN });
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }))).toBe(EXIT_PASS_REFUSED);
    expect(io.errors.join('\n')).toContain('unfinished');
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

describe('conduit run --append-pass: lease release on a post-admission throw', () => {
  /** Wrap `db` so `methodName` throws, delegating everything else unchanged. */
  function throwingDb(base: ConduitDB, methodName: keyof ConduitDB, err: Error): ConduitDB {
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === methodName) return () => { throw err; };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ConduitDB;
  }

  it('releases the run lease when the post-admission card-seeding transaction throws', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));

    const boom = new Error('boom: insertCard failed');
    const deps = makeDeps({ db: throwingDb(db, 'insertCard', boom), runEngine: engine.runEngine });

    await expect(appendPass(flowPath, deps, '{"n":2}')).rejects.toThrow('boom: insertCard failed');

    // The lease was released despite the throw: nothing but the real db was
    // touched, so this reads the live holder_pid column. The failed insertCard
    // rolled back inside its own transaction, so no p2 card exists either.
    expect(db.getRun(RUN)!.holder_pid ?? null).toBeNull();
    expect(cardIds()).toEqual([`entry-${RUN}`]);

    // A second append-pass (through the real, non-throwing db) is not a lease
    // conflict, and gets pass number 2 since the failed attempt seeded nothing.
    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }), '{"n":3}')).toBe(0);
    expect(cardIds()).toEqual([`entry-${RUN}`, `entry-${RUN}-p2`]);
  });

  it("restores the previous pass's seed file when the seed transaction throws", async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));
    const seedPath = join(flowRoot, 'in.json');
    expect(readFileSync(seedPath, 'utf-8')).toBe('{"n":1}');

    const boom = new Error('boom: insertCard failed');
    const deps = makeDeps({ db: throwingDb(db, 'insertCard', boom), runEngine: engine.runEngine });

    await expect(appendPass(flowPath, deps, '{"n":2}')).rejects.toThrow('boom: insertCard failed');

    // insertCard threw before the transaction committed, but the seed write
    // to in.json happens before the transaction — it must be undone too, or
    // a later resume/retry reads pass 2's input as if it were pass 1's.
    expect(readFileSync(seedPath, 'utf-8')).toBe('{"n":1}');
  });
});

describe('conduit run --append-pass: refusal ordering', () => {
  it('leaves a pre-staged entry input file untouched when admission refuses the pass', async () => {
    const flowPath = writeFlow();
    const engine = completingEngine();
    await runPass1(flowPath, makeDeps({ runEngine: engine.runEngine }));
    // Halt the run mid-pass so admitAppendPass refuses with EXIT_PASS_REFUSED
    // (checkRunAppendable sees an unfinished card).
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb().prepare("UPDATE cards SET lane = 'only', status = 'ready' WHERE run_id = $r").run({ $r: RUN });

    // Stage a distinct file at the entry input path — the seed write happens
    // in the "Card seeding" block, AFTER admitAppendPass runs, so a refused
    // invocation must never reach it.
    const stagedContent = '{"staged":"do-not-touch"}';
    writeFileSync(join(flowRoot, 'in.json'), stagedContent);

    expect(await appendPass(flowPath, makeDeps({ runEngine: engine.runEngine }), '{"n":"new-pass-input"}')).toBe(
      EXIT_PASS_REFUSED,
    );

    expect(readFileSync(join(flowRoot, 'in.json'), 'utf-8')).toBe(stagedContent);
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
