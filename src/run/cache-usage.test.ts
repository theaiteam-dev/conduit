/**
 * Issue #156: `conduit run status` reports per-station cache reads and their
 * share of input, and `conduit journal inspect` prints the split on each span
 * that has one.
 *
 * share = cache reads / (uncached input + cache reads + cache creation),
 * summed over a station's spans that carry a split. A span whose cache
 * columns are NULL (an older journal, or an adapter with no split) adds no
 * figure: a station with only such spans prints "no cache figure", never 0%.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, type ConduitDB, type JournalSpanInput } from '../persistence/db';
import { main, type CliDeps } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import { getCacheUsage, formatCacheUsage, formatSpanCacheSplit } from './cache-usage';

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('not called');
  },
};

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

function insertRun(runId: string): void {
  db.insertRun({ run_id: runId, flow: 'f.yaml', input_fingerprint: 'x', status: 'complete', outcome: 'complete' });
}

function usageSpan(runId: string, station: string, name: string, usage: JournalSpanInput['usage'], cardId = 'c1'): void {
  db.appendJournalSpan({ runId, cardId, station, attempt: 0, name, usage, attributes: {} });
}

/** The three span kinds the acceptance names, in one run. */
function seedMixedRun(runId: string): void {
  insertRun(runId);
  // Harness span with a full split (Claude reports cache creation too).
  usageSpan(runId, 'research', 'research.harness', {
    model: 'claude', inputTokens: 100, outputTokens: 50, costUsd: 0.1,
    cacheReadInputTokens: 700, cacheCreationInputTokens: 200,
  });
  // Transform span with a cache-read split and no cache-creation figure.
  usageSpan(runId, 'draft', 'draft.transform', {
    model: 'gpt', inputTokens: 400, outputTokens: 30, costUsd: 0.01, cacheReadInputTokens: 600,
  });
  // Transform span with NULL cache columns.
  usageSpan(runId, 'polish', 'polish.transform', { model: 'gpt', inputTokens: 500, outputTokens: 20, costUsd: 0.01 });
}

describe('getCacheUsage', () => {
  it('sums cache reads and input per station over spans with a split', () => {
    seedMixedRun('r');
    const report = getCacheUsage(db, 'r')!;
    expect(report.stations).toEqual([
      { station: 'draft', calls: 1, splitCalls: 1, uncachedInputTokens: 400, cacheReadInputTokens: 600, cacheCreationInputTokens: null },
      { station: 'polish', calls: 1, splitCalls: 0, uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: null },
      { station: 'research', calls: 1, splitCalls: 1, uncachedInputTokens: 100, cacheReadInputTokens: 700, cacheCreationInputTokens: 200 },
    ]);
  });

  it('leaves a span without a split out of its station\'s figure', () => {
    insertRun('r');
    usageSpan('r', 'draft', 'draft.transform', { model: 'gpt', inputTokens: 40, outputTokens: 3, costUsd: 0, cacheReadInputTokens: 60 });
    usageSpan('r', 'draft', 'draft.transform', { model: 'gpt', inputTokens: 1000, outputTokens: 3, costUsd: 0 });
    const report = getCacheUsage(db, 'r')!;
    expect(report.stations).toEqual([
      { station: 'draft', calls: 2, splitCalls: 1, uncachedInputTokens: 40, cacheReadInputTokens: 60, cacheCreationInputTokens: null },
    ]);
  });

  it('returns null for a run with no usage spans', () => {
    insertRun('r');
    db.appendJournalSpan({ runId: 'r', cardId: 'c1', station: 's', attempt: 0, name: 's.harness', usageUnknown: true, attributes: {} });
    expect(getCacheUsage(db, 'r')).toBeNull();
  });
});

describe('formatCacheUsage', () => {
  it('prints a figure for split stations and "no cache figure" for the rest', () => {
    seedMixedRun('r');
    expect(formatCacheUsage(getCacheUsage(db, 'r')!)).toEqual([
      'cache reads (share of input = cache reads / (uncached input + cache reads + cache creation)):',
      '  draft: cache read 600 of 1000 input tokens (60.0%), 1 call(s)',
      '  polish: no cache figure, 1 call(s)',
      '  research: cache read 700 of 1000 input tokens (70.0%), cache creation 200, 1 call(s)',
    ]);
  });

  it('names the calls left out of a station\'s figure', () => {
    insertRun('r');
    usageSpan('r', 'draft', 'draft.transform', { model: 'gpt', inputTokens: 40, outputTokens: 3, costUsd: 0, cacheReadInputTokens: 60 });
    usageSpan('r', 'draft', 'draft.transform', { model: 'gpt', inputTokens: 1000, outputTokens: 3, costUsd: 0 });
    expect(formatCacheUsage(getCacheUsage(db, 'r')!)).toEqual([
      'cache reads (share of input = cache reads / (uncached input + cache reads + cache creation)):',
      '  draft: cache read 60 of 100 input tokens (60.0%), 2 call(s), 1 with no cache figure',
    ]);
  });

  it('prints n/a for the share when a split reports zero input', () => {
    insertRun('r');
    usageSpan('r', 'draft', 'draft.transform', { model: 'gpt', inputTokens: 0, outputTokens: 3, costUsd: 0, cacheReadInputTokens: 0 });
    expect(formatCacheUsage(getCacheUsage(db, 'r')!)[1]).toBe('  draft: cache read 0 of 0 input tokens (n/a), 1 call(s)');
  });
});

describe('formatSpanCacheSplit', () => {
  it('formats a span with a split, and returns null for one without', () => {
    expect(formatSpanCacheSplit({ inputTokens: 400, cacheReadInputTokens: 600, cacheCreationInputTokens: null }))
      .toBe('cache read 600 of 1000 input tokens (60.0%)');
    expect(formatSpanCacheSplit({ inputTokens: 100, cacheReadInputTokens: 700, cacheCreationInputTokens: 200 }))
      .toBe('cache read 700 of 1000 input tokens (70.0%), cache creation 200');
    expect(formatSpanCacheSplit({ inputTokens: 500, cacheReadInputTokens: null, cacheCreationInputTokens: null })).toBeNull();
    expect(formatSpanCacheSplit({ inputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null })).toBeNull();
  });
});

describe('issue #156: run status and journal inspect print cache figures', () => {
  function deps(lines: string[]): CliDeps {
    return {
      io: { out: (l: string) => lines.push(l), err: () => {} },
      now: () => 1_000,
      db,
      adapter: throwingModel,
      runEngine: async () => {},
      prereqs: [],
    };
  }

  it('run status covers a harness span, a transform span with a split, and a span with NULL cache columns', async () => {
    seedMixedRun('job-c');
    const lines: string[] = [];
    expect(await main(['run', 'status', '--run', 'job-c'], deps(lines))).toBe(0);
    expect(lines[0]).toBe('run job-c: terminal (outcome=complete)');
    // The harness span also gets the issue #30 occupancy section, which comes first.
    const cacheAt = lines.findIndex((l) => l.startsWith('cache reads'));
    expect(lines[1]).toStartWith('harness occupancy');
    expect(cacheAt).toBeGreaterThan(1);
    expect(lines.slice(cacheAt)).toEqual([
      'cache reads (share of input = cache reads / (uncached input + cache reads + cache creation)):',
      '  draft: cache read 600 of 1000 input tokens (60.0%), 1 call(s)',
      '  polish: no cache figure, 1 call(s)',
      '  research: cache read 700 of 1000 input tokens (70.0%), cache creation 200, 1 call(s)',
    ]);
  });

  it('journal inspect appends the split to each span that has one', async () => {
    seedMixedRun('job-c');
    const lines: string[] = [];
    expect(await main(['journal', 'inspect', 'c1', '--run', 'job-c'], deps(lines))).toBe(0);
    expect(lines).toEqual([
      '[c1] research@0 research.harness cache read 700 of 1000 input tokens (70.0%), cache creation 200',
      '[c1] draft@0 draft.transform cache read 600 of 1000 input tokens (60.0%)',
      '[c1] polish@0 polish.transform',
    ]);
  });
});
