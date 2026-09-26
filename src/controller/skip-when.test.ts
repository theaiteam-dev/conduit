/**
 * Evaluation of a station's `skip_when` predicate (issue #32).
 *
 * evaluateSkipWhen reads the predicate's value from card state and returns one
 * of three decisions:
 *
 *   - skip: the value equals `equals` (strict, no coercion);
 *   - run:  the value has the same type as `equals` but differs;
 *   - hold: the value cannot be read or compared. A missing seed file,
 *     unparseable JSON, a non-object document, an absent field, a missing
 *     upstream checkpoint, or a type mismatch all hold, because choosing skip
 *     or run on unreadable state is a guess (SPEC Principle: escalate
 *     ambiguity; never guess).
 *
 * The `output` source reads the latest checkpoint the named transform wrote
 * for the same card, so a rework that re-ran the transform is honoured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCheckpointSchema, writeCheckpoint } from '../checkpoint/checkpoint';
import type { SkipWhenConfig } from '../types/kernel';
import { evaluateSkipWhen, describeSkipWhen, type SkipEvalContext } from './skip-when';

const SEED_PRED: SkipWhenConfig = { source: 'seed', field: 'no_test_needed', equals: true };
const OUTPUT_PRED: SkipWhenConfig = { source: 'output', station: 'classify', field: 'needs_tests', equals: false };

let dir: string;
let stateDb: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-skip-when-eval-'));
  stateDb = new Database(':memory:');
  ensureCheckpointSchema(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<SkipEvalContext['card']> = {}): SkipEvalContext {
  return {
    stateDb,
    runId: 'run-1',
    flowVersion: '1',
    card: { id: 'c1', owned_paths: [dir], ...overrides },
  };
}

function writeSeed(content: string): void {
  writeFileSync(join(dir, 'seed.json'), content, 'utf-8');
}

function writeClassifyCheckpoint(attempt: number, payload: unknown, card = 'c1'): void {
  writeCheckpoint(
    stateDb,
    { run: 'run-1', flow: '1', card, station: 'classify', attempt },
    {
      stamp: `stamp-${attempt}`,
      output: { payload, findings_hash: '', return_to: null } as never,
    },
  );
}

describe('source: seed', () => {
  it('skips when the field equals the scalar', () => {
    writeSeed(JSON.stringify({ no_test_needed: true }));
    expect(evaluateSkipWhen(SEED_PRED, ctx())).toEqual({ action: 'skip', value: true });
  });

  it('runs when the field has the same type but a different value', () => {
    writeSeed(JSON.stringify({ no_test_needed: false }));
    expect(evaluateSkipWhen(SEED_PRED, ctx())).toEqual({ action: 'run', value: false });
  });

  it('compares strings and numbers strictly', () => {
    const strPred: SkipWhenConfig = { source: 'seed', field: 'kind', equals: 'docs' };
    writeSeed(JSON.stringify({ kind: 'docs' }));
    expect(evaluateSkipWhen(strPred, ctx()).action).toBe('skip');
    writeSeed(JSON.stringify({ kind: 'code' }));
    expect(evaluateSkipWhen(strPred, ctx()).action).toBe('run');

    const numPred: SkipWhenConfig = { source: 'seed', field: 'tier', equals: 0 };
    writeSeed(JSON.stringify({ tier: 0 }));
    expect(evaluateSkipWhen(numPred, ctx()).action).toBe('skip');
    writeSeed(JSON.stringify({ tier: 2 }));
    expect(evaluateSkipWhen(numPred, ctx()).action).toBe('run');
  });

  it('holds when the card has no owned_paths', () => {
    const decision = evaluateSkipWhen(SEED_PRED, ctx({ owned_paths: [] }));
    expect(decision.action).toBe('hold');
  });

  it('holds when seed.json is missing', () => {
    const decision = evaluateSkipWhen(SEED_PRED, ctx());
    expect(decision.action).toBe('hold');
    if (decision.action === 'hold') expect(decision.reason).toContain('seed.json');
  });

  it('holds when seed.json is not valid JSON', () => {
    writeSeed('{ not json');
    expect(evaluateSkipWhen(SEED_PRED, ctx()).action).toBe('hold');
  });

  it('holds when seed.json is not an object', () => {
    writeSeed(JSON.stringify([true]));
    expect(evaluateSkipWhen(SEED_PRED, ctx()).action).toBe('hold');
  });

  it('holds when the field is absent', () => {
    writeSeed(JSON.stringify({ other: true }));
    const decision = evaluateSkipWhen(SEED_PRED, ctx());
    expect(decision.action).toBe('hold');
    if (decision.action === 'hold') expect(decision.reason).toContain('no_test_needed');
  });

  it('holds on a type mismatch instead of coercing ("true" is not true)', () => {
    writeSeed(JSON.stringify({ no_test_needed: 'true' }));
    const decision = evaluateSkipWhen(SEED_PRED, ctx());
    expect(decision.action).toBe('hold');
    if (decision.action === 'hold') expect(decision.reason).toContain('string');
  });

  it('holds when the field is null or an object', () => {
    writeSeed(JSON.stringify({ no_test_needed: null }));
    expect(evaluateSkipWhen(SEED_PRED, ctx()).action).toBe('hold');
    writeSeed(JSON.stringify({ no_test_needed: { v: true } }));
    expect(evaluateSkipWhen(SEED_PRED, ctx()).action).toBe('hold');
  });

  it('does not read inherited properties as fields', () => {
    const pred: SkipWhenConfig = { source: 'seed', field: 'constructor', equals: 'x' };
    writeSeed(JSON.stringify({}));
    expect(evaluateSkipWhen(pred, ctx()).action).toBe('hold');
  });
});

describe('source: output', () => {
  it('skips when the upstream transform payload field equals the scalar', () => {
    writeClassifyCheckpoint(0, { needs_tests: false });
    expect(evaluateSkipWhen(OUTPUT_PRED, ctx())).toEqual({ action: 'skip', value: false });
  });

  it('runs when the payload field differs', () => {
    writeClassifyCheckpoint(0, { needs_tests: true });
    expect(evaluateSkipWhen(OUTPUT_PRED, ctx())).toEqual({ action: 'run', value: true });
  });

  it('reads the latest attempt the transform checkpointed', () => {
    writeClassifyCheckpoint(0, { needs_tests: true });
    writeClassifyCheckpoint(2, { needs_tests: false });
    expect(evaluateSkipWhen(OUTPUT_PRED, ctx()).action).toBe('skip');
  });

  it('holds when the transform has no checkpoint for this card', () => {
    writeClassifyCheckpoint(0, { needs_tests: false }, 'other-card');
    const decision = evaluateSkipWhen(OUTPUT_PRED, ctx());
    expect(decision.action).toBe('hold');
    if (decision.action === 'hold') expect(decision.reason).toContain('classify');
  });

  it('ignores checkpoints from another run or flow version', () => {
    writeCheckpoint(
      stateDb,
      { run: 'run-2', flow: '1', card: 'c1', station: 'classify', attempt: 0 },
      { stamp: 's', output: { payload: { needs_tests: false } } as never },
    );
    writeCheckpoint(
      stateDb,
      { run: 'run-1', flow: '2', card: 'c1', station: 'classify', attempt: 0 },
      { stamp: 's', output: { payload: { needs_tests: false } } as never },
    );
    expect(evaluateSkipWhen(OUTPUT_PRED, ctx()).action).toBe('hold');
  });

  it('holds when the payload lacks the field or has the wrong type', () => {
    writeClassifyCheckpoint(0, { notes: 'x' });
    expect(evaluateSkipWhen(OUTPUT_PRED, ctx()).action).toBe('hold');
    writeClassifyCheckpoint(1, { needs_tests: 0 });
    expect(evaluateSkipWhen(OUTPUT_PRED, ctx()).action).toBe('hold');
  });

  it('holds instead of throwing when the checkpoint output_json is corrupt', () => {
    // Bypass writeCheckpoint (which always stores valid JSON) to simulate a
    // truncated/corrupt row, e.g. from a crash mid-write. readLatestCheckpoint
    // still throws on JSON.parse (it has its own contract, matching
    // readCheckpoint); evaluateSkipWhen must not let that throw escape the
    // tick — the documented contract is that an unreadable predicate holds.
    stateDb
      .prepare(
        `INSERT INTO checkpoints (run_id, flow, card, station, attempt, binding_stamp, output_json)
         VALUES ($run_id, $flow, $card, $station, $attempt, $stamp, $output)`,
      )
      .run({
        $run_id: 'run-1',
        $flow: '1',
        $card: 'c1',
        $station: 'classify',
        $attempt: 0,
        $stamp: 'stamp-0',
        $output: '{ not valid json',
      });

    const decision = evaluateSkipWhen(OUTPUT_PRED, ctx());
    expect(decision.action).toBe('hold');
    if (decision.action === 'hold') {
      expect(decision.reason).toContain('classify');
      expect(decision.reason).toContain('c1');
    }
  });
});

describe('describeSkipWhen', () => {
  it('renders the predicate for the card_log', () => {
    expect(describeSkipWhen(SEED_PRED)).toBe('seed.no_test_needed == true');
    expect(describeSkipWhen(OUTPUT_PRED)).toBe('output(classify).needs_tests == false');
    expect(describeSkipWhen({ source: 'seed', field: 'kind', equals: 'docs' })).toBe('seed.kind == "docs"');
  });
});
