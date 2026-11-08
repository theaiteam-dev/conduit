/**
 * Issue #125: the `conduit run status` budget-tokens line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { formatBudgetTokens } from './budget-usage';

let dir: string;
let db: ConduitDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-budget-usage-'));
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function registerRun(budgets: string): void {
  const flowPath = join(dir, 'flow.yaml');
  writeFileSync(flowPath, `flow: f\nflow_version: 1\n${budgets}\nstations: []\n`);
  db.insertRun({ run_id: 'r', flow: flowPath, input_fingerprint: 'x', status: 'done' });
}

function span(usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }): void {
  db.appendJournalSpan({
    runId: 'r', cardId: 'c', station: 'walk', attempt: 0, name: 'walk.harness',
    usage: { model: 'm', costUsd: 0, ...usage },
  });
}

describe('formatBudgetTokens', () => {
  it('prints the budget figure, the run max_tokens, the raw figure and the weights', () => {
    registerRun('budgets:\n  run: { max_tokens: 6000000 }');
    span({ inputTokens: 670_000, outputTokens: 0, cacheReadInputTokens: 6_350_000, cacheCreationInputTokens: 0 });

    expect(formatBudgetTokens(db, 'r')).toBe(
      'budget tokens: 1305000 of run max_tokens 6000000 (raw 7020000; cache read x0.1, cache creation x1)',
    );
  });

  it("uses the flow's declared weights", () => {
    registerRun('budgets:\n  token_weights: { cache_read: 0.25, cache_creation: 1.25 }');
    span({ inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100 });

    expect(formatBudgetTokens(db, 'r')).toBe('budget tokens: 475 (raw 1200; cache read x0.25, cache creation x1.25)');
  });

  it('prints nothing when the budget figure equals the raw figure', () => {
    registerRun('budgets:\n  run: { max_tokens: 100 }');
    span({ inputTokens: 40, outputTokens: 10 });

    expect(formatBudgetTokens(db, 'r')).toBeNull();
  });

  it('prints nothing for a run with no usage, an unknown run, or an unreadable or invalid flow', () => {
    registerRun('');
    expect(formatBudgetTokens(db, 'r')).toBeNull();
    expect(formatBudgetTokens(db, 'missing')).toBeNull();

    span({ inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 100 });
    writeFileSync(join(dir, 'flow.yaml'), 'budgets:\n  token_weights: { cache_read: 5 }\n');
    expect(formatBudgetTokens(db, 'r')).toBeNull();
    rmSync(join(dir, 'flow.yaml'));
    expect(formatBudgetTokens(db, 'r')).toBeNull();
  });
});
