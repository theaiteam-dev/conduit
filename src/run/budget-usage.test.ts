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

function span(
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
  adapter = 'claude-headless',
): void {
  db.appendJournalSpan({
    runId: 'r', cardId: 'c', station: 'walk', attempt: 0, name: 'walk.harness', adapter,
    usage: { model: 'm', costUsd: 0, ...usage },
  });
}

describe('formatBudgetTokens', () => {
  it('prints the budget figure, the run max_tokens and the raw figure, weighted per adapter', () => {
    registerRun('budgets:\n  run: { max_tokens: 6000000 }');
    // claude-headless: 670,000 + 0.1 * 6,350,000 = 1,305,000.
    span({ inputTokens: 670_000, outputTokens: 0, cacheReadInputTokens: 6_350_000, cacheCreationInputTokens: 0 });
    // codex-app-server: 100,000 + 0.5 * 1,000,000 = 600,000.
    span({ inputTokens: 100_000, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0 }, 'codex-app-server');

    expect(formatBudgetTokens(db, 'r')).toBe(
      'budget tokens: 1905000 of run max_tokens 6000000 (raw 8120000; cache weights per adapter)',
    );
  });

  it("names the classes the flow's token_weights sets", () => {
    registerRun('budgets:\n  token_weights: { cache_read: 0.25, cache_creation: 1.25 }');
    span({ inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100 });
    expect(formatBudgetTokens(db, 'r')).toBe('budget tokens: 475 (raw 1200; flow sets cache read x0.25, cache creation x1.25)');

    writeFileSync(join(dir, 'flow.yaml'), 'flow: f\nflow_version: 1\nbudgets:\n  token_weights: { cache_read: 0.25 }\nstations: []\n');
    // Creation falls back to claude-headless's 2: 100 + 250 + 200 = 550.
    expect(formatBudgetTokens(db, 'r')).toBe('budget tokens: 550 (raw 1200; cache weights per adapter, flow sets cache read x0.25)');
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
    expect(formatBudgetTokens(db, 'r')).not.toBeNull();
    writeFileSync(join(dir, 'flow.yaml'), 'budgets:\n  token_weights: { cache_read: 5 }\n');
    expect(formatBudgetTokens(db, 'r')).toBeNull();
    rmSync(join(dir, 'flow.yaml'));
    expect(formatBudgetTokens(db, 'r')).toBeNull();
  });
});
